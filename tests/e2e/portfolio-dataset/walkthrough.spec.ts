import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

// The populated existing screens, read-only, against the isolated dataset stack (playwright.portfolio-dataset.config.ts).
// Every expected value comes from .local/portfolio-dataset/manifest.json, which the dataset command computed from its
// plan; nothing here creates or changes a record.

interface Metric {
  recordedEntries: number;
  total: number | null;
}
interface Nutrition {
  loggedEntries: number;
  metrics: Record<'carbohydrateG' | 'energyKcal' | 'fatG' | 'proteinG', Metric>;
}
interface Manifest {
  expected: {
    activityComparison: { change: { count: number; countPercent: number | null }; current: { count: number }; previous: { count: number } };
    finishedRun: { distanceM: string; observedDurationS: string; runId: string };
    nutritionTrends: { dates: Record<'missing' | 'partial' | 'recordedZeros' | 'titleOnly', Nutrition & { localDate: string }>; range: Nutrition & { daysWithEntries: number } };
    today: { manualActivities: Record<string, number>; meals: Nutrition; recordedRuns: number };
    weeklyReview: { checkInDays: number; meals: Nutrition & { daysWithEntries: number }; week: { end: string; start: string } };
  };
  gaps: { meals: string[]; unlogged: string[] };
  parameters: { anchorDate: string; timeZone: string };
  ranges: { current: { startDate: string }; previous: { endDate: string; startDate: string } };
}

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', '..', '.local', 'portfolio-dataset', 'manifest.json'), 'utf8')) as Manifest;
const anchor = manifest.parameters.anchorDate;
const screenshots = resolve(import.meta.dirname, '..', '..', '..', '.local', 'portfolio-dataset', 'screenshots');
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Application view' });
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonthYear = (date: string) => `${String(Number(date.slice(8, 10)))} ${months[Number(date.slice(5, 7)) - 1]!} ${date.slice(0, 4)}`;

const addDays = (date: string, days: number) => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
const dateInZone = (zone: string, instantMs: number) => {
  const parts = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', timeZone: zone, year: 'numeric' }).formatToParts(new Date(instantMs));
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
};

async function signIn(page: Page, who: 'Demo coach' | 'Demo runner'): Promise<void> {
  await page.goto('/');
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: who }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test('the populated primary screens: Today, weekly review, nutrition and activity Trends, a finished run, and the coach sees none of it', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  // Every failed private-API answer, except the app's designed "nothing recorded" answers: the Check-in screen asks for
  // TODAY's check-in and movement (404 by design; the dataset ends yesterday), and the optional AI insight panel asks
  // for a stored insight (AI is off and none exists).
  const expectedNotFound = /^404 \/api\/orgs\/[^/]+\/(?:daily-metrics\/\d{4}-\d{2}-\d{2}|daily-movement\/\d{4}-\d{2}-\d{2}|insights\/weekly)$/u;
  const apiFailures: string[] = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    const answer = `${String(response.status())} ${path}`;
    if (path.startsWith('/api/orgs/') && response.status() >= 400 && !expectedNotFound.test(answer)) apiFailures.push(answer);
  });
  await signIn(page, 'Demo runner');

  // Today on the anchor date.
  await navigation(page).getByRole('button', { name: 'Today', exact: true }).click();
  const today = page.getByRole('region', { exact: true, name: 'Today' });
  await today.getByLabel('Date').fill(anchor);
  const checkIn = today.getByRole('region', { exact: true, name: 'Check-in' });
  await expect(checkIn).not.toContainText('Nothing is recorded');
  await expect(today.getByRole('region', { exact: true, name: 'Steps and active energy' })).not.toContainText(/No (steps|movement)/u);
  await expect(today.getByRole('region', { exact: true, name: 'GPS runs' })).toBeVisible();
  await expect(today.getByRole('region', { exact: true, name: 'Manual activities' })).toBeVisible();
  await expect(today).toContainText(`${String(manifest.expected.today.meals.loggedEntries)}`);
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'today.png') });

  // The weekly review of the last complete week.
  await navigation(page).getByRole('button', { name: 'Check-in' }).click();
  const review = page.getByRole('region', { name: 'Weekly review' });
  await review.getByLabel('Week').selectOption(manifest.expected.weeklyReview.week.start);
  await expect(review.getByText('Computed by the app')).toBeVisible();
  await expect(review).toContainText(String(manifest.expected.weeklyReview.meals.loggedEntries));
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'weekly-review.png') });

  // Nutrition Trends ending on the anchor: coverage, a missing date, partial values.
  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  const trends = page.getByRole('region', { exact: true, name: 'Trends' });
  await expect(page.locator('[data-trends-state]')).toHaveAttribute('data-trends-state', 'ready');
  await trends.getByLabel('End date').fill(anchor);
  await expect(page.locator('[data-trends-state]')).toHaveAttribute('data-trends-state', 'ready');
  const series = trends.locator('.trends-card').first();
  const figure = (label: string) => series.locator('.trends-figures > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd');
  const row = (localDate: string) => trends.getByRole('region', { exact: true, name: 'Every date' }).locator(`tr[data-date="${localDate}"]`);
  const nutrition = manifest.expected.nutritionTrends;
  await trends.getByRole('radio', { exact: true, name: 'Fat' }).check();
  await expect(series.getByRole('heading', { level: 2 })).toHaveText('Fat recorded (g)');
  await expect(figure('Entries with a value')).toHaveText(`${String(nutrition.range.metrics.fatG.recordedEntries)} of ${String(nutrition.range.loggedEntries)} logged entries`);
  await expect(figure('Days with logged entries')).toHaveText(`${String(nutrition.range.daysWithEntries)} of 28 days`);
  await expect(row(nutrition.dates.missing.localDate)).toContainText('No entry logged');
  const partial = nutrition.dates.partial;
  await expect(row(partial.localDate)).toContainText(`Partial: ${String(partial.metrics.fatG.recordedEntries)} of ${String(partial.loggedEntries)} entries with fat`);
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'trends-nutrition.png') });

  // The activity comparison: manual runs against the previous 28 dates, a defined change.
  const activity = trends.getByRole('region', { exact: true, name: 'Activity' });
  await activity.getByLabel('Source').selectOption('manual');
  await activity.getByLabel('Activity type').selectOption('run');
  await expect(activity.locator('[data-activity-trends-state]')).toHaveAttribute('data-activity-trends-state', 'ready');
  const comparison = activity.locator('[data-activity-comparison]');
  await expect(comparison.getByRole('heading', { level: 3 })).toHaveText('Compared with the previous 28 days');
  await expect(comparison).toContainText(`Previous period${dayMonthYear(manifest.ranges.previous.startDate)} – ${dayMonthYear(manifest.ranges.previous.endDate)} (28 dates)`);
  const change = manifest.expected.activityComparison.change;
  const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '-' : ''}${String(Math.abs(value))}`;
  await expect(comparison.locator('tr[data-comparison-measure="count"]')).toContainText(
    `${signed(change.count)} (${change.countPercent === null ? '' : `${change.countPercent > 0 ? '+' : ''}${change.countPercent.toFixed(1)}%`})`,
  );
  for (const measure of ['count', 'duration', 'distance']) {
    await expect(comparison.locator(`tr[data-comparison-measure="${measure}"] [data-change-status]`)).toHaveAttribute('data-change-status', 'available');
  }
  await comparison.scrollIntoViewIfNeeded();
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'trends-activity-comparison.png') });

  // The finished run of the anchor date, with its current published summary.
  await navigation(page).getByRole('button', { name: 'Archive' }).click();
  const myRuns = page.getByRole('region', { name: 'My runs', exact: true });
  await myRuns.getByRole('button', { name: 'Apply filters' }).click();
  const cards = myRuns.getByRole('list', { name: 'My runs' }).locator(':scope > li');
  await expect(cards.first()).toBeVisible();
  await cards.first().getByRole('button', { name: /View details/ }).click();
  const details = page.getByRole('region', { name: 'Run details', exact: true });
  const run = manifest.expected.finishedRun;
  const kilometres = `${(Number(run.distanceM) / 1_000).toFixed(2)} km`;
  const seconds = Math.round(Number(run.observedDurationS));
  const duration = `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
  await expect(details.getByRole('definition').filter({ hasText: kilometres })).toBeVisible();
  await expect(details.getByText(duration, { exact: true })).toBeVisible();
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'run-details.png') });

  expect(apiFailures).toEqual([]);
  // HTTP failures are judged above by path; the browser's generic "Failed to load resource" line repeats them (and the
  // signed-out session check's 401). Anything else logged as an error fails the walkthrough.
  expect(consoleErrors.filter((text) => !text.startsWith('Failed to load resource: the server responded with a status of'))).toEqual([]);

  // The coach shares the organization but sees none of the runner's owner-only records.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'Demo coach');
  await navigation(page).getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('region', { exact: true, name: 'Today' }).getByLabel('Date').fill(anchor);
  await expect(page.getByRole('region', { exact: true, name: 'Today' }).getByText(/^Nothing is recorded for /u)).toBeVisible();
});

// Release step 3: the primary journey on the dataset, read-only, with every selection and expectation from the manifest.
// Today on the last day of the manifest's review week → that week's review → Trends ending on the date the policy names
// → the records behind a Trends row (the Meal log and Today), and back.
test('the primary journey: a fresh page opens Today, then Today → Weekly review → Trends → the original records', async ({ page }) => {
  const apiFailures: string[] = [];
  const expectedNotFound = /^404 \/api\/orgs\/[^/]+\/(?:daily-metrics\/\d{4}-\d{2}-\d{2}|daily-movement\/\d{4}-\d{2}-\d{2}|insights\/weekly)$/u;
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    const answer = `${String(response.status())} ${path}`;
    if (path.startsWith('/api/orgs/') && response.status() >= 400 && !expectedNotFound.test(answer)) apiFailures.push(answer);
  });
  const { week } = manifest.expected.weeklyReview;
  const zone = manifest.parameters.timeZone;
  // The documented policy: Sunday for a completed week, today while the week is in progress.
  const todayInZone = dateInZone(zone, Date.now());
  const trendsEnd = week.end < todayInZone ? week.end : todayInZone;
  // A date of the week with logged meals and records (not a meal gap and not an unlogged date).
  const recordDate = [0, 1, 2, 3, 4, 5, 6]
    .map((offset) => addDays(week.start, offset))
    .filter((date) => !manifest.gaps.meals.includes(date) && !manifest.gaps.unlogged.includes(date))
    .at(-1)!;

  await signIn(page, 'Demo runner');
  // A fresh signed-in page opens Today.
  await expect(navigation(page).getByRole('button', { name: 'Today', exact: true })).toHaveAttribute('aria-current', 'page');
  const today = page.getByRole('region', { exact: true, name: 'Today' });
  await today.getByLabel('Date').fill(week.end);
  await expect(today.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  await expect(today.getByText(/^Nothing is recorded for /u)).toHaveCount(0);

  // Today → Weekly review: the week containing the date, on its own view.
  await today.getByRole('button', { name: /^Weekly review of / }).click();
  await expect(navigation(page).getByRole('button', { name: 'Weekly review', exact: true })).toHaveAttribute('aria-current', 'page');
  const review = page.getByRole('region', { exact: true, name: 'Weekly review' });
  await expect(page.getByRole('heading', { level: 1, name: 'Weekly review' })).toBeFocused();
  await expect(review.getByLabel('Week')).toHaveValue(week.start);
  await expect(review.locator('[data-review-state]')).toHaveAttribute('data-review-state', 'ready');
  const coverage = review.getByRole('region', { name: 'Coverage' });
  await expect(coverage.locator('div').filter({ has: page.getByText('Days with check-in values', { exact: true }) }).locator('dd'))
    .toHaveText(`${String(manifest.expected.weeklyReview.checkInDays)} of 7`);
  const meals = review.getByRole('region', { name: 'Recorded nutrition' });
  const loggedEntries = manifest.expected.weeklyReview.meals.loggedEntries;
  await expect(meals.locator('.review-movement__totals > div').filter({ has: page.getByText('Logged entries', { exact: true }) }).locator('dd'))
    .toHaveText(new RegExp(`^${String(loggedEntries)} entries `, 'u'));
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'journey-weekly-review.png') });

  // Weekly review → Trends, ending on the date the policy names.
  await review.getByRole('button', { name: /^Open 28-day trends ending on / }).click();
  const trends = page.getByRole('region', { exact: true, name: 'Trends' });
  await expect(trends.getByLabel('End date')).toHaveValue(trendsEnd);
  await expect(page.locator('[data-trends-state]')).toHaveAttribute('data-trends-state', 'ready');
  await trends.getByRole('radio', { exact: true, name: 'Protein' }).check();
  const rows = trends.getByRole('region', { exact: true, name: 'Every date' }).locator('tbody tr');
  await expect(rows).toHaveCount(28);
  await expect(rows.first()).toHaveAttribute('data-date', trendsEnd);
  await expect(rows.last()).toHaveAttribute('data-date', addDays(trendsEnd, -27));
  await page.screenshot({ fullPage: true, path: resolve(screenshots, 'journey-trends.png') });

  // Trends → the original records: the date's meals, and back to the same range and series.
  const row = trends.locator(`tr[data-date="${recordDate}"]`);
  await row.getByRole('button', { name: /^Open Meal log on / }).click();
  const mealLog = page.getByRole('region', { exact: true, name: 'Meal log' });
  await expect(mealLog.getByLabel('Date')).toHaveValue(recordDate);
  await expect(mealLog.getByRole('button', { name: 'Back to Trends' })).toBeVisible();
  await mealLog.getByRole('button', { name: 'Back to Trends' }).click();
  await expect(trends.getByLabel('End date')).toHaveValue(trendsEnd);
  await expect(trends.getByRole('radio', { exact: true, name: 'Protein' })).toBeChecked();
  // ... and the whole day on Today.
  await trends.locator(`tr[data-date="${recordDate}"]`).getByRole('button', { name: /^Open Today on / }).click();
  await expect(today.getByLabel('Date')).toHaveValue(recordDate);
  await expect(today.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  await expect(today.getByRole('region', { exact: true, name: 'Meals' }).getByRole('button', { name: /^Open meal log for / })).toBeVisible();

  // A direct opening of the Weekly review keeps the week chosen above.
  await navigation(page).getByRole('button', { name: 'Weekly review', exact: true }).click();
  await expect(review.getByLabel('Week')).toHaveValue(week.start);
  expect(apiFailures).toEqual([]);
});
