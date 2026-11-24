import type { Page, Route } from '@playwright/test';

import { authedApi, signIn } from '../support/api.js';
import { readDurableRunnerState, readDurableWriterLease } from '../support/browser-storage.js';
import type { E2eEnvironment } from '../support/environment.js';
import { expect, test } from '../support/fixtures.js';
import { addDays, dateIn, INSIGHT_ZONE } from '../support/insight-weeks.js';
import { expectUniqueAndGapFree } from '../support/points.js';
import { builtFiles, productionBuild } from '../support/production-build.js';
import { RunnerPage } from '../support/runner-page.js';
import { expectOrganizationChosen, expectSignedIn, organizationRegion } from '../support/session.js';

// Release step 4 (ADR-0098), against the PRODUCTION build served by `vite preview`: the requests a browser makes for the
// initial bundle and the one deferred chunk of the secondary views, and what the page does while that chunk loads, fails
// or never arrives. Fixture-based: every record belongs to the suite's own scenario in the _test database.
test.use({ locale: 'en-GB', timezoneId: INSIGHT_ZONE });

const settled = { timeout: 30_000 };
const files = builtFiles();
const production = (environment: E2eEnvironment): E2eEnvironment => ({ ...environment, webOrigin: productionBuild.webOrigin });
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Application view' });
const viewButton = (page: Page, name: string) => navigation(page).getByRole('button', { exact: true, name });
const todayScreen = (page: Page) => page.getByRole('region', { exact: true, name: 'Today' });
const runStatus = (page: Page) => page.getByRole('region', { exact: true, name: 'Run status' });
const loadingStatus = (page: Page, what: string) => page.getByRole('status').filter({ hasText: `Opening ${what}…` });
const failureAlert = (page: Page, what: string) => page.getByRole('alert').filter({ hasText: `${what} could not be opened` });
const tryAgain = (page: Page) => page.getByRole('button', { exact: true, name: 'Try again' });

/** Every request for a built file (path under /assets, with any query), in order. */
function assetRequests(page: Page): string[] {
  const requested: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === productionBuild.webOrigin && url.pathname.startsWith('/assets/')) requested.push(`${url.pathname.slice(1)}${url.search}`);
  });
  return requested;
}

const isFile = (request: string, file: string) => request === file || request.startsWith(`${file}?`);

/**
 * Controls the secondary views' chunk: requests wait while held, then are served or aborted (a network failure), and
 * later requests follow the current mode at once.
 */
async function chunkGate(page: Page, mode: 'abort' | 'hold' | 'serve') {
  let current = mode;
  const waiting: Array<() => void> = [];
  const state = { aborted: 0, requests: 0, served: 0 };
  const settle = async (route: Route) => {
    if (current === 'serve') {
      state.served += 1;
      await route.continue().catch(() => undefined);
    } else {
      state.aborted += 1;
      await route.abort('failed').catch(() => undefined);
    }
  };
  await page.route((url) => url.pathname === `/${files.secondaryViews}`, async (route) => {
    state.requests += 1;
    if (current === 'hold') await new Promise<void>((resolve) => { waiting.push(resolve); });
    await settle(route);
  });
  const set = (next: 'abort' | 'hold' | 'serve') => {
    current = next;
    if (next !== 'hold') for (const resolve of waiting.splice(0)) resolve();
  };
  return { abort: () => set('abort'), hold: () => set('hold'), serve: () => set('serve'), state };
}

async function expectView(page: Page, name: string): Promise<void> {
  await expect(viewButton(page, name)).toHaveAttribute('aria-current', 'page');
}

async function openSignedIn(page: Page, userId: string): Promise<void> {
  await page.goto('/');
  await expectSignedIn(page, userId);
  await expectView(page, 'Today');
}

test('a cold Today load fetches only the initial files; the secondary views arrive as one chunk when the first of them opens', async ({
  context,
  environment,
  page,
  scenario,
}) => {
  const requested = assetRequests(page);
  await signIn(context, production(environment), scenario.runnerUserId);
  await openSignedIn(page, scenario.runnerUserId);
  await expect(todayScreen(page).locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready', settled);

  // The primary journey and Runner are part of the first page: opening them fetches no code.
  await viewButton(page, 'Weekly review').click();
  await expect(page.getByRole('region', { exact: true, name: 'Weekly review' }).locator('[data-review-state]')).toHaveAttribute('data-review-state', 'ready', settled);
  await viewButton(page, 'Trends').click();
  await expect(page.getByRole('region', { exact: true, name: 'Trends' })).toBeVisible();
  await viewButton(page, 'Runner').click();
  await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();
  expect([...new Set(requested)].sort()).toEqual([...files.initial].sort());
  expect(requested.filter((request) => isFile(request, files.secondaryViews))).toEqual([]);

  // The first secondary view fetches the chunk once; every other one, and Runner again, fetch nothing more.
  await viewButton(page, 'Check-in').click();
  await expect(page.locator('#checkin-title')).toBeVisible();
  for (const [view, heading] of [['Meal log', '#meal-log-title'], ['Activity', '#activity-title'], ['Coach', '#coach-title'], ['Archive', '#archive-title']] as const) {
    await viewButton(page, view).click();
    await expect(page.locator(heading)).toBeVisible();
  }
  await viewButton(page, 'Runner').click();
  await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible();
  expect(requested.filter((request) => isFile(request, files.secondaryViews))).toEqual([files.secondaryViews]);
  // This build has no Mapbox token (the measured build reads no .env), so no map is created and neither the Mapbox
  // runtime nor its stylesheet is ever requested; the map path is covered by the development-server map specs.
  expect(requested.filter((request) => isFile(request, files.mapboxRuntime) || isFile(request, files.mapboxStylesheet))).toEqual([]);
  expect([...new Set(requested)].sort()).toEqual([...files.initial, files.secondaryViews].sort());
});

test('loading and failure stay in the view’s area, and Try again fetches the chunk again and opens the view on the date Today chose @cross-browser', async ({
  browserName,
  context,
  environment,
  page,
  scenario,
}) => {
  const requested = assetRequests(page);
  const gate = await chunkGate(page, 'hold');
  const day = addDays(dateIn(INSIGHT_ZONE, Date.now()), -3);
  await signIn(context, production(environment), scenario.runnerUserId);
  await openSignedIn(page, scenario.runnerUserId);
  await todayScreen(page).getByLabel('Date').fill(day);
  await expect(todayScreen(page).locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready', settled);

  // Today's meal action opens the Meal log on Today's date; while its code is held back only the view area says so.
  await todayScreen(page).getByRole('button', { name: /^Add a meal for / }).click();
  await expectView(page, 'Meal log');
  await expect(loadingStatus(page, 'the meal log')).toBeVisible();
  await expect(page.locator('[data-deferred-view="loading"]')).toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => gate.state.requests).toBe(1);

  // The network fails: an alert in the view's area, nothing else changes, and nothing navigates or reloads.
  gate.abort();
  await expect(failureAlert(page, 'The meal log')).toBeVisible();
  await expectView(page, 'Meal log');
  await expect(navigation(page).getByRole('button')).toHaveCount(9);
  await expect(page.getByRole('heading', { level: 1, name: 'Meal log' })).toHaveCount(0);

  // Try again while the network still fails: a real new request for the chunk, and the failure again.
  const beforeRetry = gate.state.requests;
  await tryAgain(page).click();
  await expect.poll(() => gate.state.requests).toBeGreaterThan(beforeRetry);
  await expect(failureAlert(page, 'The meal log')).toBeVisible();

  // The network is back: Try again loads the chunk and the Meal log opens on the date Today chose.
  gate.serve();
  const beforeRecovery = gate.state.requests;
  await tryAgain(page).click();
  const mealLog = page.getByRole('region', { exact: true, name: 'Meal log' });
  await expect(mealLog.getByLabel('Date')).toHaveValue(day, settled);
  expect(gate.state.requests).toBeGreaterThan(beforeRecovery);
  expect(gate.state.served).toBeGreaterThanOrEqual(1);
  const chunkRequests = requested.filter((request) => isFile(request, files.secondaryViews));
  // Chromium keeps a failed module failed for the page, so its retries use a new URL; Firefox fetches the same URL again.
  if (browserName === 'chromium') expect(chunkRequests.slice(1).every((request) => /[?&]retry=\d+$/u.test(request))).toBe(true);
  if (browserName === 'firefox') expect(chunkRequests.slice(1)).toContain(files.secondaryViews);
  // WebKit's import error names no URL, so the new-URL fallback is never taken; it fetches the same URL again instead,
  // and every retry (the one that failed and the one that loaded) is a request for exactly that file.
  if (browserName === 'webkit') {
    expect(chunkRequests.length).toBeGreaterThanOrEqual(3);
    expect(chunkRequests.every((request) => request === files.secondaryViews)).toBe(true);
  }

  // Navigation and the kept date are intact, and another secondary view now opens with no further request.
  await viewButton(page, 'Today').click();
  await expect(todayScreen(page).getByLabel('Date')).toHaveValue(day);
  const loaded = gate.state.requests;
  await viewButton(page, 'Check-in').click();
  await expect(page.locator('#checkin-title')).toBeVisible();
  expect(gate.state.requests).toBe(loaded);
});

test('leaving a view while its code loads, or changing organization, never navigates; the code arrives for the scope shown', async ({
  context,
  environment,
  organizations,
  page,
  scenario,
}) => {
  const orgA = scenario.orgId;
  const orgB = await organizations.memberOf(scenario.runnerUserId);
  const gate = await chunkGate(page, 'hold');
  const day = addDays(dateIn(INSIGHT_ZONE, Date.now()), -2);
  await signIn(context, production(environment), scenario.runnerUserId);
  await openSignedIn(page, scenario.runnerUserId);
  const picker = organizationRegion(page).getByRole('combobox', { name: 'Organization' });
  await picker.selectOption(orgA);
  await expectOrganizationChosen(page, orgA);
  await todayScreen(page).getByLabel('Date').fill(day);
  await expect(todayScreen(page).locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready', settled);

  // Activity is opened and left for Today before its code arrives; the arrival changes nothing on screen.
  await viewButton(page, 'Activity').click();
  await expect(loadingStatus(page, 'the activity log')).toBeVisible();
  await expect.poll(() => gate.state.requests).toBe(1);
  await viewButton(page, 'Today').click();
  await expectView(page, 'Today');
  const arrived = page.waitForEvent('requestfinished', (request) => new URL(request.url()).pathname === `/${files.secondaryViews}`);
  gate.serve();
  await arrived;
  await expect(todayScreen(page).getByLabel('Date')).toHaveValue(day);
  await page.waitForTimeout(500);
  await expectView(page, 'Today');
  await expect(page.locator('#activity-title')).toHaveCount(0);
  // The code was kept: the next opening shows Activity at once, without another request.
  await viewButton(page, 'Activity').click();
  await expect(page.locator('#activity-title')).toBeVisible();
  expect(gate.state.requests).toBe(1);

  // A new page, so the chunk is not loaded yet. Check-in is opened in organization A, then B is chosen while the code is
  // held back: when it arrives, the screen reads organization B only.
  gate.hold();
  await page.reload();
  await expectSignedIn(page, scenario.runnerUserId);
  await picker.selectOption(orgA);
  await expectOrganizationChosen(page, orgA);
  await viewButton(page, 'Check-in').click();
  await expect(loadingStatus(page, 'the daily check-in')).toBeVisible();
  await expect.poll(() => gate.state.requests).toBe(2);
  await picker.selectOption(orgB);
  await expectOrganizationChosen(page, orgB);
  await expectView(page, 'Check-in');
  const organizationReads: string[] = [];
  page.on('request', (request) => {
    const match = /\/api\/orgs\/([^/]+)\//u.exec(new URL(request.url()).pathname);
    if (match?.[1] !== undefined) organizationReads.push(decodeURIComponent(match[1]));
  });
  gate.serve();
  await expect(page.locator('#checkin-title')).toBeVisible(settled);
  await expect(page.getByRole('form', { name: 'Daily check-in' })).toBeVisible();
  await expect.poll(() => organizationReads.length, settled).toBeGreaterThan(0);
  expect(new Set(organizationReads)).toEqual(new Set([orgB]));
});

test('recording and upload continue, and a reload on Today restores the run, while the secondary views cannot load', async ({
  browser,
  context,
  environment,
  page,
  scenario,
}) => {
  const { orgId, runnerUserId } = scenario;
  const gate = await chunkGate(page, 'abort');
  await signIn(context, production(environment), runnerUserId);
  const observer = await browser.newContext();
  try {
    await signIn(observer, production(environment), runnerUserId);
    const api = await authedApi(observer, production(environment));
    const runner = new RunnerPage(page);
    await openSignedIn(page, runnerUserId);
    await runner.showView();
    await runner.useSimulator();
    await runner.start();
    await expect(runner.card('Recording').value).toHaveText('recording');
    const runId = await runner.runId(api, orgId);
    expect((await readDurableWriterLease(page, runnerUserId))?.releasedAt).toBeNull();

    // Coach cannot load; the page says so in Coach's area, and the run goes on: the status names it, and every point of
    // the six-point simulator reaches the server while the failed view is shown.
    await viewButton(page, 'Coach').click();
    await expect(failureAlert(page, 'The coach stream')).toBeVisible();
    await expect(runStatus(page)).toContainText(`Run #${runId.slice(0, 8)}.`);
    await expect.poll(async () => (await api.getAllPoints(orgId, runId)).length, settled).toBe(6);
    expectUniqueAndGapFree(await api.getAllPoints(orgId, runId));
    await expectView(page, 'Coach');
    await expect(failureAlert(page, 'The coach stream')).toBeVisible();

    // A reload with the chunk still unavailable opens Today and restores the same run, writer and queue.
    await page.reload();
    await expectSignedIn(page, runnerUserId);
    await expectView(page, 'Today');
    await expect(runStatus(page)).toContainText(`Run #${runId.slice(0, 8)}.`, settled);
    expect((await readDurableRunnerState(page, runnerUserId)).activeRunId).toBe(runId);
    await expect.poll(async () => (await readDurableWriterLease(page, runnerUserId))?.releasedAt, settled).toBeNull();
    expect(Date.parse((await readDurableWriterLease(page, runnerUserId))?.expiresAt ?? '')).toBeGreaterThan(Date.now());
    expect(await api.listRunIds(orgId)).toEqual([runId]);

    // Runner shows the same run with this tab as the writer; it finishes and everything is uploaded.
    await runStatus(page).getByRole('button', { name: 'Go to Runner' }).click();
    await expect(page.getByText(/^#[0-9a-f]{8}$/)).toHaveText(`#${runId.slice(0, 8)}`);
    await expect(runner.card('Writer').value).toHaveText('owned', settled);
    await runner.finish();
    await expect(runner.card('Recording').value).toHaveText('finished');
    await runner.waitForEmptyBuffer();
    expect((await api.getRun(orgId, runId)).status).toBe('finished');
    expectUniqueAndGapFree(await api.getAllPoints(orgId, runId));
    // The chunk was asked for and never served; nothing of the run depended on it.
    expect(gate.state.requests).toBeGreaterThanOrEqual(1);
    expect(gate.state.served).toBe(0);
  } finally {
    await observer.close();
  }
});
