import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.js';
import { addDays, INSIGHT_ZONE, mondayWeeksAgo } from './support/insight-weeks.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// The deterministic Weekly review on the Check-in tab, against an API with weekly insight generation explicitly off
// (WEEKLY_INSIGHTS_PROVIDER=off, the product default): the review is the primary view, it follows saves and deletions,
// and the optional AI section's disabled state does not affect it. Weeks come from the real clock in the browser zone.
test.use({ locale: 'en-GB', timezoneId: INSIGHT_ZONE });

const settled = { timeout: 30_000 };

async function checkIn(page: Page, date: string, values: { hours?: string; minutes?: string; mood?: string }): Promise<void> {
  const form = page.getByRole('form', { name: 'Daily check-in' });
  await form.getByLabel('Date').fill(date);
  await expect(form.getByText(/^(Nothing recorded|Showing what you recorded) for /u)).toBeVisible();
  if (values.hours !== undefined) {
    await form.getByLabel('Hours').fill(values.hours);
    await form.getByLabel('Minutes').fill(values.minutes ?? '0');
  }
  if (values.mood !== undefined) await form.getByLabel('Mood').selectOption(values.mood);
  await form.getByRole('button', { name: 'Save check-in' }).click();
  await expect(form.getByText('Check-in saved.')).toBeVisible();
}

test('with AI generation off, the weekly review is shown, follows a save and loses deleted data', async ({ demoScenario, environment, page }) => {
  test.skip(mondayWeeksAgo(1) !== mondayWeeksAgo(1, Date.now() + 300_000), 'Too close to the start of a week in Warsaw');
  const week = mondayWeeksAgo(1);
  const insightRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/insights/weekly') && request.method() === 'POST') insightRequests.push(request.url());
  });

  await page.goto(environment.reviewWebOrigin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await expectOrganizationSelected(page, demoScenario.orgId);
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Check-in' }).click();
  const review = page.getByRole('region', { name: 'Weekly review' });
  const ai = page.getByRole('region', { name: 'AI insight (optional)' });
  const statements = review.getByRole('list', { name: 'What your records show' });

  // Four days with values; sleep duration on three of them (one of 9 h 13 min), mood only on the fourth.
  await checkIn(page, week, { hours: '7' });
  await checkIn(page, addDays(week, 1), { hours: '6', minutes: '30' });
  await checkIn(page, addDays(week, 2), { hours: '9', minutes: '13' });
  await checkIn(page, addDays(week, 4), { mood: '3' });

  await review.getByLabel('Week').selectOption(week);
  await expect(statements).toContainText('Check-ins with values on 4 of 7 days of the week.', settled);
  await expect(statements).toContainText('Sleep duration was recorded on 3 of 4 days with check-in values.');
  await expect(review).not.toContainText(/every check-in day/u);
  await expect(review.getByText('Computed by the app')).toBeVisible();
  await expect(review).toContainText(`Days are read in ${INSIGHT_ZONE}, the time zone of your check-ins this week.`);
  await expect(review.getByRole('list', { name: 'Numbers from your data' })).toContainText('Longest sleep: 553 min');
  await expect(review.getByRole('region', { name: 'Coverage' })).toContainText('Sleep duration3 of 4 days with values');

  // The optional AI section follows the week, has no insight, and generation is off; the review stays as it is.
  await expect(ai.getByText(/^No insight for /u)).toBeVisible(settled);
  expect(insightRequests).toEqual([]);
  await ai.getByRole('button', { name: 'Generate insight' }).click();
  await expect(ai.getByText('Insight generation is turned off on this server. Stored insights are still shown.')).toBeVisible(settled);
  await expect(statements).toContainText('Sleep duration was recorded on 3 of 4 days with check-in values.');

  // A save in the shown week refreshes the review.
  await checkIn(page, addDays(week, 5), { hours: '8' });
  await expect(statements).toContainText('Sleep duration was recorded on 4 of 5 days with check-in values.', settled);

  // Deleting the 9 h 13 min day: the next review no longer contains it.
  const form = page.getByRole('form', { name: 'Daily check-in' });
  await form.getByLabel('Date').fill(addDays(week, 2));
  await expect(form.getByText(/^Showing what you recorded for /u)).toBeVisible();
  await form.getByRole('button', { name: /^Delete the check-in of /u }).click();
  await page.getByRole('region', { name: /^Delete the check-in of .+\?$/u }).getByRole('button', { name: 'Confirm delete' }).click();
  await expect(statements).toContainText('Sleep duration was recorded on 3 of 4 days with check-in values.', settled);
  await expect(review).not.toContainText('553 min');
  await expect(review).not.toContainText('9 h 13 min');
  await expect(review.getByRole('list', { name: 'Numbers from your data' })).toContainText('Longest sleep: 480 min');

  // Narrow screens: nothing of the review is wider than the page (a wide font, as on Linux CI, makes overflow show).
  await page.addStyleTag({ content: 'body, body * { font-family: Verdana, sans-serif !important; }' });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

async function saveMovement(page: Page, date: string, values: { energy?: string; steps?: string }, saved: 'saved' | 'updated'): Promise<void> {
  const form = page.getByRole('form', { name: 'Daily movement' });
  await form.getByLabel('Date').fill(date);
  await expect(form.getByText(/^(No movement recorded|Showing what you entered) for /u)).toBeVisible();
  await form.getByLabel('Steps (optional)').fill(values.steps ?? '');
  await form.getByLabel('Active energy (kcal)').fill(values.energy ?? '');
  await form.getByRole('button', { name: 'Save movement' }).click();
  await expect(form.getByText(saved === 'saved' ? 'Movement saved.' : 'Movement updated.')).toBeVisible();
}

test('with AI generation off, the weekly review shows manual movement and follows its save, edit and delete in the selected week', async ({
  demoScenario,
  environment,
  page,
}) => {
  test.skip(mondayWeeksAgo(1) !== mondayWeeksAgo(1, Date.now() + 300_000), 'Too close to the start of a week in Warsaw');
  const week = mondayWeeksAgo(1);
  const insightRequests: string[] = [];
  const reviewReads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/insights/weekly')) insightRequests.push(`${request.method()} ${url.search}`);
    if (url.pathname.endsWith('/weekly-review')) reviewReads.push(url.searchParams.get('weekStart') ?? '');
  });

  await page.goto(environment.reviewWebOrigin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await expectOrganizationSelected(page, demoScenario.orgId);
  await page.getByRole('navigation', { name: 'Application view' }).getByRole('button', { name: 'Check-in' }).click();
  const review = page.getByRole('region', { name: 'Weekly review' });
  const statements = review.getByRole('list', { name: 'What your records show' });
  const movement = review.getByRole('region', { name: 'Steps and active energy' });
  const days = movement.getByRole('list', { name: 'Movement by day' }).locator(':scope > li');

  // Last week, with nothing recorded yet.
  await review.getByLabel('Week').selectOption(week);
  await expect(review.getByText(/^Nothing is recorded for /u)).toBeVisible(settled);
  await expect(movement).toContainText('Days with movement0 of 7');
  await expect(days).toHaveCount(7);
  await expect(movement.getByText('No movement recorded')).toHaveCount(7);
  // The AI section has read the selected week once (no insight, generation off); later changes must not ask it again.
  await expect(page.getByRole('region', { name: 'AI insight (optional)' }).getByText(/^No insight for /u)).toBeVisible(settled);
  const insightRequestsBefore = insightRequests.length;
  const readsBefore = reviewReads.length;

  // The required regression: Monday steps 0, Tuesday 8042 steps and 412.5 kcal, Wednesday 250 kcal only.
  await saveMovement(page, week, { steps: '0' }, 'saved');
  // A week with only a recorded zero is not empty.
  await expect(movement).toContainText('Steps, recorded total0 steps on 1 of 7 days', settled);
  await expect(review.getByText(/^Nothing is recorded for /u)).toHaveCount(0);
  await saveMovement(page, addDays(week, 1), { energy: '412,5', steps: '8042' }, 'saved');
  await saveMovement(page, addDays(week, 2), { energy: '250' }, 'saved');
  await expect(movement).toContainText('Days with movement3 of 7', settled);
  await expect(movement).toContainText('Steps, recorded total8,042 steps on 2 of 7 days');
  await expect(movement).toContainText('Active energy, recorded total662.5 kcal on 2 of 7 days');
  await expect(statements).toContainText('Steps were recorded on 2 of 7 days, 8,042 steps in total on those days; the other 5 days are unknown.');
  await expect(statements).toContainText('Active energy was recorded on 2 of 7 days, 662.5 kcal in total on those days; the other 5 days are unknown.');
  await expect(statements).toContainText('No check-ins were recorded this week.');
  await expect(days.nth(0)).toContainText('Steps0 steps');
  await expect(days.nth(0)).toContainText('Active energyNot recorded');
  await expect(days.nth(0)).toContainText('SourceManually entered');
  await expect(days.nth(2)).toContainText('StepsNot recorded');
  await expect(days.nth(3)).toContainText('No movement recorded');
  await expect(movement.getByText('Manually entered', { exact: true }).first()).toBeVisible();

  // Edit Tuesday's energy: the total follows, the selected week does not change.
  await saveMovement(page, addDays(week, 1), { energy: '100', steps: '8042' }, 'updated');
  await expect(movement).toContainText('Active energy, recorded total350 kcal on 2 of 7 days', settled);
  await expect(review.getByLabel('Week')).toHaveValue(week);

  // Delete Wednesday: the next review no longer has it.
  const form = page.getByRole('form', { name: 'Daily movement' });
  await form.getByLabel('Date').fill(addDays(week, 2));
  await expect(form.getByText(/^Showing what you entered for /u)).toBeVisible();
  await form.getByRole('button', { name: /^Delete the movement of / }).click();
  await form.getByRole('region', { name: /^Delete the movement of .+\?$/u }).getByRole('button', { name: 'Confirm delete' }).click();
  await expect(form.getByText('Movement deleted.')).toBeVisible();
  await expect(movement).toContainText('Days with movement2 of 7', settled);
  await expect(movement).toContainText('Active energy, recorded total100 kcal on 1 of 7 days');
  await expect(days.nth(2)).toContainText('No movement recorded');
  await expect(review).not.toContainText('250 kcal');
  await expect(review.getByLabel('Week')).toHaveValue(week);

  // Every refresh read the selected week; movement changes never asked the AI section for anything.
  expect(reviewReads.length).toBeGreaterThan(readsBefore);
  expect(reviewReads.slice(readsBefore).every((weekStart) => weekStart === week)).toBe(true);
  expect(insightRequests.slice(insightRequestsBefore)).toEqual([]);
  expect(insightRequests.some((entry) => entry.startsWith('POST'))).toBe(false);

  // Narrow screens: the movement block fits the page.
  await page.addStyleTag({ content: 'body, body * { font-family: Verdana, sans-serif !important; }' });
  await page.setViewportSize({ width: 375, height: 812 });
  await movement.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

// Recorded nutrition (ADR-0093): meals are logged on the Meal log screen; the Weekly review on the Check-in tab reads the
// week afresh whenever it is opened, on Retry, and after signing in again.
async function addMeal(page: Page, date: string, entry: { energy?: string; fat?: string; protein?: string; title: string }): Promise<void> {
  const mealLog = page.getByRole('region', { exact: true, name: 'Meal log' });
  const form = mealLog.locator('form.meal-form');
  await mealLog.getByLabel('Date').fill(date);
  await expect(mealLog.locator('[data-meal-list-state]')).toHaveAttribute('data-meal-list-state', 'ready');
  await form.getByLabel('Meal type').selectOption({ label: 'Lunch' });
  await form.getByLabel('Title').fill(entry.title);
  await form.getByLabel('Food energy (kcal)').fill(entry.energy ?? '');
  await form.getByLabel('Protein (g)').fill(entry.protein ?? '');
  await form.getByLabel('Carbohydrate (g)').fill('');
  await form.getByLabel('Fat (g)').fill(entry.fat ?? '');
  await form.getByRole('button', { name: 'Add entry' }).click();
  await expect(form.getByText('Entry saved.')).toBeVisible();
}

test('with AI generation off, the weekly review shows recorded nutrition from the Meal log and reads it afresh after navigation, Retry and a new session', async ({
  demoScenario,
  environment,
  page,
}) => {
  test.skip(mondayWeeksAgo(1) !== mondayWeeksAgo(1, Date.now() + 600_000), 'Too close to the start of a week in Warsaw');
  const week = mondayWeeksAgo(1);
  const insightPosts: string[] = [];
  const reviewReads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/insights/weekly') && request.method() === 'POST') insightPosts.push(url.pathname);
    if (url.pathname.endsWith('/weekly-review')) reviewReads.push(url.searchParams.get('weekStart') ?? '');
  });
  const navigation = page.getByRole('navigation', { name: 'Application view' });
  const signIn = async () => {
    await expectSignedOut(page);
    await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
    await expectSignedIn(page, demoScenario.runnerUserId);
    await expectOrganizationSelected(page, demoScenario.orgId);
  };
  const review = page.getByRole('region', { name: 'Weekly review' });
  const nutrition = review.getByRole('region', { name: 'Recorded nutrition' });
  const days = nutrition.getByRole('list', { name: 'Recorded nutrition by day' }).locator(':scope > li');
  const statements = review.getByRole('list', { name: 'What your records show' });
  /** Opens the Check-in tab (a new review section) on the given week and waits for its answer. */
  const openReview = async () => {
    await navigation.getByRole('button', { name: 'Check-in' }).click();
    await review.getByLabel('Week').selectOption(week);
    await expect(review.locator('[data-review-state]')).toHaveAttribute('data-review-state', 'ready', settled);
  };

  await page.goto(environment.reviewWebOrigin);
  await signIn();

  // 1. A single title-only entry: the week is not empty, and every value is unknown.
  await navigation.getByRole('button', { name: 'Meal log' }).click();
  await addMeal(page, week, { title: 'Apple' });
  await openReview();
  await expect(review.getByText(/^Nothing is recorded for /u)).toHaveCount(0);
  await expect(nutrition).toContainText('Logged entries1 entry on 1 of 7 days');
  await expect(nutrition).toContainText('Food energy, recorded totalNot recorded for the only entry');
  await expect(statements).toContainText('1 meal entry was logged on 1 of 7 days; each counts on the date it was logged for.');
  await expect(statements).toContainText('No check-ins were recorded this week.');

  // 2. Partial values and a recorded zero on two days; the new section reads the week again.
  await navigation.getByRole('button', { name: 'Meal log' }).click();
  await addMeal(page, week, { energy: '350.5', fat: '0', protein: '12', title: 'Porridge' });
  await addMeal(page, addDays(week, 2), { energy: '410.6', title: 'Soup' });
  const readsBeforeReturn = reviewReads.length;
  await openReview();
  expect(reviewReads.length).toBeGreaterThan(readsBeforeReturn);
  await expect(nutrition).toContainText('Logged entries3 entries on 2 of 7 days', settled);
  await expect(nutrition).toContainText('Food energy, recorded total761.1 kcal for 2 of 3 entries, on 2 of 7 days');
  await expect(nutrition).toContainText('Protein, recorded total12 g for 1 of 3 entries, on 1 of 7 days');
  await expect(nutrition).toContainText('Carbohydrate, recorded totalNot recorded for any of the 3 entries');
  await expect(nutrition).toContainText('Fat, recorded total0 g for 1 of 3 entries, on 1 of 7 days');
  await expect(nutrition).toContainText('it does not mean every meal or snack was logged');
  await expect(days).toHaveCount(7);
  await expect(days.nth(0)).toContainText('Entries2');
  await expect(days.nth(0)).toContainText('Food energy350.5 kcal (1 of 2 entries)');
  await expect(days.nth(1)).toContainText('No entries logged');
  await expect(days.nth(2)).toContainText('Food energy410.6 kcal (1 of 1 entry)');
  await expect(statements).toContainText(
    'Food energy was recorded for 2 of 3 logged entries, on 2 of 7 days: 761.1 kcal in total for those entries; 1 other entry is unknown.',
  );
  // Food energy is its own block, apart from movement's active energy.
  await expect(review.getByRole('region', { name: 'Steps and active energy' })).not.toContainText('Food energy');
  await expect(nutrition).not.toContainText(/balance|target|average|deficit|surplus/iu);

  // 3. Edit and delete in the Meal log; coming back reads the week afresh.
  await navigation.getByRole('button', { name: 'Meal log' }).click();
  const mealLog = page.getByRole('region', { exact: true, name: 'Meal log' });
  const form = mealLog.locator('form.meal-form');
  const cards = mealLog.locator('.run-cards > li');
  await mealLog.getByLabel('Date').fill(addDays(week, 2));
  await expect(mealLog.locator('[data-meal-list-state]')).toHaveAttribute('data-meal-list-state', 'ready');
  await cards.filter({ hasText: 'Soup' }).getByRole('button', { name: /^Edit / }).click();
  await form.getByLabel('Food energy (kcal)').fill('410.4');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(mealLog.getByText('Your changes to "Soup" were saved.')).toBeVisible();
  await mealLog.getByLabel('Date').fill(week);
  await expect(mealLog.locator('[data-meal-list-state]')).toHaveAttribute('data-meal-list-state', 'ready');
  const apple = cards.filter({ hasText: 'Apple' });
  await apple.getByRole('button', { name: /^Delete / }).click();
  await apple.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(mealLog.getByText('The entry was deleted.')).toBeVisible();
  await openReview();
  await expect(nutrition).toContainText('Logged entries2 entries on 2 of 7 days', settled);
  await expect(nutrition).toContainText('Food energy, recorded total760.9 kcal for all 2 entries, on 2 of 7 days');
  await expect(days.nth(0)).toContainText('Entries1');
  await expect(review).not.toContainText('761.1');
  await expect(review).not.toContainText('410.6');

  // 4. A failed read shows no old numbers; Retry reads again.
  let failNext = true;
  await page.route('**/api/orgs/*/weekly-review*', async (route) => {
    if (!failNext) return route.continue();
    failNext = false;
    return route.fulfill({
      body: JSON.stringify({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is unavailable', requestId: '00000000-0000-4000-8000-0000000000e2' } }),
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      status: 503,
    });
  });
  await review.getByRole('button', { name: 'Refresh' }).click();
  await expect(review.getByRole('alert')).toContainText('The database is unavailable', settled);
  await expect(review).not.toContainText('760.9');
  await review.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
  await expect(nutrition).toContainText('Food energy, recorded total760.9 kcal for all 2 entries, on 2 of 7 days', settled);
  await page.unroute('**/api/orgs/*/weekly-review*');

  // 5. Narrow screens: the nutrition block fits the page (a wide font, as on Linux CI, makes overflow show).
  await page.addStyleTag({ content: 'body, body * { font-family: Verdana, sans-serif !important; }' });
  await page.setViewportSize({ width: 375, height: 812 });
  await nutrition.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await nutrition.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);

  // 6. Signing out disposes the section; a new session reads the week afresh and shows the same stored data.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(review).toHaveCount(0);
  const readsBeforeSignIn = reviewReads.length;
  await signIn();
  await openReview();
  expect(reviewReads.length).toBeGreaterThan(readsBeforeSignIn);
  await expect(nutrition).toContainText('Logged entries2 entries on 2 of 7 days', settled);
  expect(reviewReads.every((weekStart) => weekStart === week || weekStart === mondayWeeksAgo(0))).toBe(true);

  // No AI insight was requested at any point: meals are not AI input.
  expect(insightPosts).toEqual([]);
});
