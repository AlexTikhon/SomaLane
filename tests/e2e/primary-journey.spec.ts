import type { Page, Request } from '@playwright/test';

import { authedApi, signIn } from './support/api.js';
import type { AuthedApi } from './support/api.js';
import { readDurableRunnerState, readDurableWriterLease } from './support/browser-storage.js';
import { expect, test } from './support/fixtures.js';
import { addDays, dateIn, INSIGHT_ZONE, mondayWeeksAgo } from './support/insight-weeks.js';
import { expectUniqueAndGapFree } from './support/points.js';
import { RunnerPage } from './support/runner-page.js';
import { expectOrganizationChosen, expectOrganizationSelected, expectSignedIn, expectSignedOut, organizationRegion } from './support/session.js';

// Release step 3: the primary journey (daily records → Today → Weekly review → Trends → records), its date and scope
// policy, and the guarantee that recording is independent of the visible view. Fixture-based: every record is created
// in the suite's own scenario in the _test database and removed with it. Weeks follow the real clock in Warsaw.
test.use({ locale: 'en-GB', timezoneId: INSIGHT_ZONE });

const settled = { timeout: 30_000 };
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Application view' });
const viewButton = (page: Page, name: string) => navigation(page).getByRole('button', { exact: true, name });
const todayScreen = (page: Page) => page.getByRole('region', { exact: true, name: 'Today' });
const reviewScreen = (page: Page) => page.getByRole('region', { exact: true, name: 'Weekly review' });
const trendsScreen = (page: Page) => page.getByRole('region', { exact: true, name: 'Trends' });
const runStatus = (page: Page) => page.getByRole('region', { exact: true, name: 'Run status' });

async function expectView(page: Page, name: string, heading = name): Promise<void> {
  await expect(viewButton(page, name)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
}

async function demoSignIn(page: Page, who: 'Demo coach' | 'Demo runner'): Promise<void> {
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: who }).click();
}

async function showTodayOn(page: Page, localDate: string): Promise<void> {
  await todayScreen(page).getByLabel('Date').fill(localDate);
  await expect(todayScreen(page).locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready', settled);
  await expect(todayScreen(page).getByLabel('Date')).toHaveValue(localDate);
}

async function saveSleepCheckIn(page: Page, localDate: string, hours: string): Promise<void> {
  const form = page.getByRole('form', { name: 'Daily check-in' });
  await expect(form.getByLabel('Date')).toHaveValue(localDate);
  await expect(form.getByText(/^(Nothing recorded|Showing what you recorded) for /u)).toBeVisible();
  await form.getByLabel('Hours').fill(hours);
  await form.getByLabel('Minutes').fill('0');
  await form.getByRole('button', { name: 'Save check-in' }).click();
  await expect(form.getByText('Check-in saved.')).toBeVisible();
}

const reviewTrendsAction = (page: Page) => reviewScreen(page).getByRole('button', { name: /^Open 28-day trends ending on / });
const reviewStatements = (page: Page) => reviewScreen(page).getByRole('list', { name: 'What your records show' });

test('a fresh page opens Today, and records → Today → Weekly review → Trends → records follows the date policy', async ({ demoScenario, environment, page }) => {
  test.skip(mondayWeeksAgo(0) !== mondayWeeksAgo(0, Date.now() + 600_000), 'Too close to the start of a week in Warsaw');
  const today = dateIn(INSIGHT_ZONE, Date.now());
  const lastWeek = mondayWeeksAgo(1);
  const thisWeek = mondayWeeksAgo(0);
  const day = addDays(lastWeek, 2);
  const sunday = addDays(lastWeek, 6);

  await page.goto(environment.reviewWebOrigin);
  await expectSignedOut(page);
  await demoSignIn(page, 'Demo runner');
  await expectSignedIn(page, demoScenario.runnerUserId);
  await expectOrganizationSelected(page, demoScenario.orgId);
  // A fresh signed-in page (a reload with the session already there) opens Today too.
  await expectView(page, 'Today');
  await page.reload();
  await expectSignedIn(page);
  await expectView(page, 'Today');
  await expect(todayScreen(page).getByLabel('Date')).toHaveValue(today);

  // Daily records: Today's own action opens the existing editor on Today's date, and Today shows the saved record.
  await showTodayOn(page, day);
  await todayScreen(page).getByRole('region', { exact: true, name: 'Check-in' }).getByRole('button', { name: /^Add check-in for / }).click();
  await expectView(page, 'Check-in');
  await saveSleepCheckIn(page, day, '7');
  await viewButton(page, 'Today').click();
  await expect(todayScreen(page).getByLabel('Date')).toHaveValue(day);
  await expect(todayScreen(page).getByRole('region', { exact: true, name: 'Check-in' }).getByText('No check-in for this day.')).toHaveCount(0, settled);

  // Today → Weekly review: the week containing the selected date, read without any editor form on the page.
  await todayScreen(page).getByRole('button', { name: /^Weekly review of / }).click();
  await expect(viewButton(page, 'Weekly review')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 1, name: 'Weekly review' })).toBeFocused();
  await expect(reviewScreen(page).getByLabel('Week')).toHaveValue(lastWeek);
  await expect(reviewStatements(page)).toContainText('Check-ins with values on 1 of 7 days of the week.', settled);
  await expect(page.getByRole('form', { name: 'Daily check-in' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'AI insight (optional)' })).toHaveCount(0);

  // Weekly review → Trends: a completed week ends the range on its Sunday.
  await reviewTrendsAction(page).click();
  await expectView(page, 'Trends');
  await expect(trendsScreen(page).getByLabel('End date')).toHaveValue(sunday);
  await expect(trendsScreen(page).locator('[data-trends-state]')).toHaveAttribute('data-trends-state', 'ready', settled);

  // Trends → the original records: the date's row opens Today on it.
  await trendsScreen(page).getByRole('radio', { name: 'Sleep' }).check();
  const row = trendsScreen(page).getByRole('region', { exact: true, name: 'Every date' }).locator(`tr[data-date="${day}"]`);
  await expect(row).not.toHaveClass(/trends-table__missing/u);
  await row.getByRole('button', { name: /^Open Today on / }).click();
  await expectView(page, 'Today');
  await expect(todayScreen(page).getByLabel('Date')).toHaveValue(day);

  // Ordinary navigation keeps the selections: the review reopens on the kept week, Trends on the kept range and series.
  await viewButton(page, 'Weekly review').click();
  await expect(reviewScreen(page).getByLabel('Week')).toHaveValue(lastWeek);
  await expect(page.getByRole('heading', { level: 1, name: 'Weekly review' })).not.toBeFocused();
  await viewButton(page, 'Trends').click();
  await expect(trendsScreen(page).getByLabel('End date')).toHaveValue(sunday);
  await expect(trendsScreen(page).getByRole('radio', { name: 'Sleep' })).toBeChecked();

  // The current week: the range ends today, never on its future Sunday.
  await viewButton(page, 'Weekly review').click();
  await reviewScreen(page).getByLabel('Week').selectOption(thisWeek);
  await expect(reviewTrendsAction(page)).toBeVisible();
  await expect(reviewScreen(page).getByText('This week is still in progress, so the range ends today.')).toBeVisible();
  await reviewTrendsAction(page).click();
  await expect(trendsScreen(page).getByLabel('End date')).toHaveValue(today);
  await viewButton(page, 'Weekly review').click();
  await expect(reviewScreen(page).getByLabel('Week')).toHaveValue(thisWeek);

  // Signing out forgets every selection: the same person signing in again gets the defaults, not the kept ones.
  await reviewScreen(page).getByLabel('Week').selectOption(lastWeek);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  await demoSignIn(page, 'Demo runner');
  await expectSignedIn(page, demoScenario.runnerUserId);
  await viewButton(page, 'Weekly review').click();
  await expect(reviewScreen(page).getByLabel('Week')).toHaveValue(thisWeek);
  await viewButton(page, 'Today').click();
  await expect(todayScreen(page).getByLabel('Date')).toHaveValue(today);
  await viewButton(page, 'Trends').click();
  await expect(trendsScreen(page).getByLabel('End date')).toHaveValue(today);
});

test('another organization, identity or a late answer never brings back another scope’s selections', async ({
  context,
  environment,
  organizations,
  page,
  scenario,
}) => {
  test.skip(mondayWeeksAgo(0) !== mondayWeeksAgo(0, Date.now() + 600_000), 'Too close to the start of a week in Warsaw');
  const today = dateIn(INSIGHT_ZONE, Date.now());
  const lastWeek = mondayWeeksAgo(1);
  const thisWeek = mondayWeeksAgo(0);
  const day = addDays(lastWeek, 3);
  const orgA = scenario.orgId;
  const orgB = await organizations.memberOf(scenario.runnerUserId);
  await signIn(context, environment, scenario.runnerUserId);
  await page.goto('/');
  await expectSignedIn(page, scenario.runnerUserId);
  const picker = organizationRegion(page).getByRole('combobox', { name: 'Organization' });
  await picker.selectOption(orgA);
  await expectOrganizationChosen(page, orgA);

  // In organization A: a record, Today on its date, and the review of its week.
  await expectView(page, 'Today');
  await showTodayOn(page, day);
  await todayScreen(page).getByRole('region', { exact: true, name: 'Check-in' }).getByRole('button', { name: /^Add check-in for / }).click();
  await saveSleepCheckIn(page, day, '8');
  await viewButton(page, 'Today').click();
  await todayScreen(page).getByRole('button', { name: /^Weekly review of / }).click();
  await expect(reviewScreen(page).getByLabel('Week')).toHaveValue(lastWeek);
  await expect(reviewStatements(page)).toContainText('Check-ins with values on 1 of 7 days of the week.', settled);
  await reviewTrendsAction(page).click();
  await expect(trendsScreen(page).getByLabel('End date')).toHaveValue(addDays(lastWeek, 6));

  // A's next review read is held back; the person switches to B while it is in flight.
  let releaseHeld: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let heldRequest: Request | null = null;
  const heldReads = new RegExp(`/api/orgs/${orgA}/weekly-review[?]`, 'u');
  await page.route(heldReads, async (route) => {
    heldRequest = route.request();
    await held;
    await route.continue().catch(() => undefined);
  });
  await viewButton(page, 'Weekly review').click();
  await expect(reviewScreen(page).locator('[data-review-state]')).toHaveAttribute('data-review-state', 'loading');
  await expect.poll(() => heldRequest !== null).toBe(true);
  const heldOutcome = new Promise<string>((resolve) => {
    page.on('requestfailed', (request) => { if (request === heldRequest) resolve('aborted'); });
    page.on('requestfinished', (request) => { if (request === heldRequest) resolve('finished'); });
  });
  await picker.selectOption(orgB);
  await expectOrganizationChosen(page, orgB);

  // B shows its own default week and none of A's data; the late answer for A, released now, changes nothing.
  await expect(viewButton(page, 'Weekly review')).toHaveAttribute('aria-current', 'page');
  await expect(reviewScreen(page).getByLabel('Week')).toHaveValue(thisWeek);
  await expect(reviewScreen(page).locator('[data-review-state]')).toHaveAttribute('data-review-state', 'ready', settled);
  releaseHeld();
  // The screen that asked was disposed with its scope, which aborts its read; either way nothing of it may show.
  const outcome = await Promise.race([heldOutcome, new Promise<string>((resolve) => { setTimeout(() => resolve('pending'), 10_000); })]);
  expect(['aborted', 'finished']).toContain(outcome);
  await expect(reviewScreen(page).getByLabel('Week')).toHaveValue(thisWeek);
  await expect(reviewScreen(page)).not.toContainText('Check-ins with values on 1 of 7 days');
  await viewButton(page, 'Today').click();
  await expect(todayScreen(page).getByLabel('Date')).toHaveValue(today);
  await viewButton(page, 'Trends').click();
  await expect(trendsScreen(page).getByLabel('End date')).toHaveValue(today);
  await page.unroute(heldReads);

  // Another identity in A (after the explicit sign-out that is the only way to change person) gets A's defaults only.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  await signIn(context, environment, scenario.coachUserId);
  await page.getByRole('button', { name: 'Retry session' }).click();
  await expectSignedIn(page, scenario.coachUserId);
  await expectOrganizationSelected(page, orgA);
  await viewButton(page, 'Today').click();
  await expect(todayScreen(page).getByLabel('Date')).toHaveValue(today);
  await expect(todayScreen(page).getByRole('region', { exact: true, name: 'Check-in' })).toContainText('No check-in for this day.', settled);
  await viewButton(page, 'Weekly review').click();
  await expect(reviewScreen(page).getByLabel('Week')).toHaveValue(thisWeek);
  await viewButton(page, 'Trends').click();
  await expect(trendsScreen(page).getByLabel('End date')).toHaveValue(today);
});

async function serverPoints(api: AuthedApi, orgId: string, runId: string) {
  return await api.getAllPoints(orgId, runId);
}

test('capture keeps producing and uploading points for the same run while Today and the Weekly review are shown, and a reload away from Runner restores it', async ({
  browser,
  context,
  demoScenario,
  environment,
  page,
}) => {
  const { orgId, runnerUserId } = demoScenario;
  await signIn(context, environment, runnerUserId);
  // A second context for the same runner reads the server without touching the page.
  const observer = await browser.newContext();
  try {
    await signIn(observer, environment, runnerUserId);
    const api = await authedApi(observer, environment);
    const runner = new RunnerPage(page);

    // The demo simulator (about two minutes of points) so capture is still running while other views are shown.
    await page.goto(environment.demoWebOrigin);
    await expectSignedIn(page, runnerUserId);
    await expectView(page, 'Today');
    await expect(runStatus(page)).toHaveCount(0);
    await runner.showView();
    await runner.useSimulator();
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');
    await expect(runner.card('Capture').value).toHaveText('capturing', settled);
    const runId = await runner.runId(api, orgId);
    const leaseAtStart = await readDurableWriterLease(page, runnerUserId);
    expect(leaseAtStart?.releasedAt).toBeNull();

    // Today is shown: the compact status says it is recording and offers the way back; points keep arriving at the
    // server for the same run, from the same capture segment.
    await viewButton(page, 'Today').click();
    await expectView(page, 'Today');
    await expect(runStatus(page)).toContainText('Recording.');
    await expect(runStatus(page).getByRole('status')).toContainText('Points are saved on this device and uploaded.');
    await expect(runStatus(page)).toContainText(`Run #${runId.slice(0, 8)}.`);
    const onToday = (await serverPoints(api, orgId, runId)).length;
    await expect.poll(async () => (await serverPoints(api, orgId, runId)).length, settled).toBeGreaterThanOrEqual(onToday + 3);
    await expectView(page, 'Today');

    // The Weekly review is shown: the same.
    await viewButton(page, 'Weekly review').click();
    await expect(viewButton(page, 'Weekly review')).toHaveAttribute('aria-current', 'page');
    await expect(runStatus(page)).toContainText('Recording.');
    const onReview = (await serverPoints(api, orgId, runId)).length;
    await expect.poll(async () => (await serverPoints(api, orgId, runId)).length, settled).toBeGreaterThanOrEqual(onReview + 3);

    // Navigation started nothing new: one run, one capture segment, the same writer epoch, nothing queued.
    const beforeReload = await serverPoints(api, orgId, runId);
    expectUniqueAndGapFree(beforeReload);
    expect(new Set(beforeReload.map((point) => point.segmentId)).size).toBe(1);
    expect(await api.listRunIds(orgId)).toEqual([runId]);
    expect((await readDurableWriterLease(page, runnerUserId))?.fencingToken).toBe(leaseAtStart?.fencingToken);
    expect((await readDurableRunnerState(page, runnerUserId)).pendingCommandIds).toEqual([]);

    // A reload away from Runner opens Today, restores the same run and takes recording ownership back on its own.
    await page.reload();
    await expectSignedIn(page, runnerUserId);
    await expectView(page, 'Today');
    await expect(runStatus(page)).toContainText('Recording.', settled);
    await expect.poll(async () => (await serverPoints(api, orgId, runId)).length, settled).toBeGreaterThanOrEqual(beforeReload.length + 3);
    const lease = await readDurableWriterLease(page, runnerUserId);
    expect(lease?.releasedAt).toBeNull();
    expect(Date.parse(lease?.expiresAt ?? '')).toBeGreaterThan(Date.now());
    expect(await api.listRunIds(orgId)).toEqual([runId]);
    expect((await readDurableRunnerState(page, runnerUserId)).activeRunId).toBe(runId);
    const afterReload = await serverPoints(api, orgId, runId);
    expectUniqueAndGapFree(afterReload);
    expect(afterReload.length).toBeGreaterThan(beforeReload.length);

    // The status leads back to Runner, which shows the same run, recording, with this tab as the writer.
    await runStatus(page).getByRole('button', { name: 'Go to Runner' }).click();
    await expect(viewButton(page, 'Runner')).toHaveAttribute('aria-current', 'page');
    await expect(runStatus(page)).toHaveCount(0);
    await expect(page.getByText(/^#[0-9a-f]{8}$/)).toHaveText(`#${runId.slice(0, 8)}`);
    await expect(runner.card('Writer').value).toHaveText('owned');
    await expect(runner.card('Recording').value).toHaveText('recording');
    await expect(runner.card('Capture').value).toHaveText('capturing');

    // Paused away from Runner says so and does not claim to record; Finish then settles and the status goes away.
    await page.getByRole('button', { exact: true, name: 'Pause' }).click();
    await expect(runner.card('Recording').value).toHaveText('paused');
    await viewButton(page, 'Trends').click();
    await expect(runStatus(page)).toContainText('Paused.');
    await expect(runStatus(page)).not.toContainText('Recording.');
    await runStatus(page).getByRole('button', { name: 'Go to Runner' }).click();
    await runner.finish();
    await expect(runner.card('Recording').value).toHaveText('finished');
    await runner.waitForEmptyBuffer();
    await viewButton(page, 'Today').click();
    await expect(runStatus(page)).toHaveCount(0);
    expect((await api.getRun(orgId, runId)).status).toBe('finished');
  } finally {
    await observer.close();
  }
});

test('the navigation fits 375 px and works with the keyboard', async ({ context, environment, page, scenario }) => {
  await page.setViewportSize({ height: 812, width: 375 });
  await signIn(context, environment, scenario.runnerUserId);
  await page.goto('/');
  await expectSignedIn(page, scenario.runnerUserId);
  await expectView(page, 'Today');

  // No horizontal scrolling, and every view's button is visible inside the viewport with a usable height.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const names = ['Today', 'Weekly review', 'Trends', 'Check-in', 'Meal log', 'Activity', 'Runner', 'Coach', 'Archive'];
  for (const name of names) {
    const box = await viewButton(page, name).boundingBox();
    expect(box, name).not.toBeNull();
    expect(box!.x, name).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, name).toBeLessThanOrEqual(375);
    expect(box!.height, name).toBeGreaterThanOrEqual(32);
  }
  // The groups are named for assistive technology.
  await expect(navigation(page).getByRole('group', { name: 'Your days and weeks' })).toBeVisible();
  await expect(navigation(page).getByRole('group', { name: 'Records' })).toBeVisible();
  await expect(navigation(page).getByRole('group', { name: 'Runs' })).toBeVisible();

  // Keyboard: Tab moves through the views in their visual order, and Enter opens one.
  await viewButton(page, 'Today').focus();
  await page.keyboard.press('Tab');
  await expect(viewButton(page, 'Weekly review')).toBeFocused();
  await page.keyboard.press('Enter');
  await expectView(page, 'Weekly review');
  await expect(reviewScreen(page).locator('[data-review-state]')).toHaveAttribute('data-review-state', 'ready', settled);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await viewButton(page, 'Weekly review').focus();
  await page.keyboard.press('Tab');
  await expect(viewButton(page, 'Trends')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(viewButton(page, 'Check-in')).toBeFocused();
  await page.keyboard.press('Enter');
  await expectView(page, 'Check-in');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
