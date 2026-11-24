import type { Locator, Page } from '@playwright/test';

import { expect, test } from './support/fixtures.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';
import { expectTrendsRowActionsOnOneLine } from './support/trends-layout.js';

// Nutrition Trends v2 (ADR-0096): the demo runner logs the required fixture through the Meal log (date A: three entries,
// one title-only; date B: one entry; date C: nothing), reads each nutrition series on Trends with its coverage, zero and
// missing states, opens date A's Meal log from a Trends row, edits and deletes entries there, returns to the original
// range and series and sees the recomputed values. The Meal log → Today path stays as it was, the way back never
// survives sign-out or ordinary navigation, and the screens stay usable at 375 px. The demo people and their organization
// are created in the _test database by the demoScenario fixture, whose cleanup removes the organization's meals.

const timeZone = 'Europe/Warsaw';
test.use({ locale: 'en-GB', timezoneId: timeZone });

function dateIn(zone: string, instantMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', timeZone: zone, year: 'numeric' }).formatToParts(
    new Date(instantMs),
  );
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Application view' });
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function signInDemoRunner(page: Page, origin: string, runnerUserId: string, orgId: string): Promise<void> {
  await page.goto(origin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, runnerUserId);
  await expectOrganizationSelected(page, orgId);
}

interface Entry {
  carbohydrate?: string;
  energy?: string;
  fat?: string;
  protein?: string;
  title: string;
}

function mealLogScreen(page: Page) {
  const screen = page.getByRole('region', { exact: true, name: 'Meal log' });
  return { cards: screen.locator('.run-cards > li'), form: screen.locator('form.meal-form'), screen };
}

async function addEntries(page: Page, localDate: string, entries: readonly Entry[]): Promise<void> {
  const log = mealLogScreen(page);
  await log.screen.getByLabel('Date').fill(localDate);
  await expect(log.screen.locator('[data-meal-list-state]')).toHaveAttribute('data-meal-list-state', 'ready');
  for (const [index, entry] of entries.entries()) {
    await log.form.getByLabel('Title').fill(entry.title);
    await log.form.getByLabel('Food energy (kcal)').fill(entry.energy ?? '');
    await log.form.getByLabel('Protein (g)').fill(entry.protein ?? '');
    await log.form.getByLabel('Carbohydrate (g)').fill(entry.carbohydrate ?? '');
    await log.form.getByLabel('Fat (g)').fill(entry.fat ?? '');
    await log.form.getByRole('button', { name: 'Add entry' }).click();
    await expect(log.cards).toHaveCount(index + 1);
  }
}

function trendsScreen(page: Page) {
  const screen = page.getByRole('region', { exact: true, name: 'Trends' });
  const series = screen.locator('.trends-card').first();
  return {
    chart: screen.locator('.trends-chart svg'),
    figure: (label: string) => series.locator('.trends-figures > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd'),
    row: (localDate: string) => screen.getByRole('region', { exact: true, name: 'Every date' }).locator(`tr[data-date="${localDate}"]`),
    screen,
    series,
    state: screen.locator('[data-trends-state]'),
  };
}

test('Nutrition Trends: each nutrient with coverage, zero and missing states; a Meal log drill-down whose edits show on return', async ({
  demoScenario,
  environment,
  page,
}) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 900_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  const A = daysBefore(today, 3);
  const B = daysBefore(today, 2);
  const C = daysBefore(today, 1);
  await signInDemoRunner(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);

  // The required fixture, through the Meal log.
  await navigation(page).getByRole('button', { name: 'Meal log' }).click();
  await addEntries(page, A, [
    { energy: '100.1', fat: '0', protein: '10.1', title: 'Entry one' },
    { carbohydrate: '20.2', protein: '0', title: 'Entry two' },
    { title: 'Entry three' },
  ]);
  await addEntries(page, B, [{ carbohydrate: '0', energy: '0', fat: '5.3', title: 'Entry four' }]);

  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  const trends = trendsScreen(page);
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  await expect(trends.screen.getByLabel('End date')).toHaveValue(today);

  // Every nutrition series: name and unit, total, day and entry coverage, days with entries.
  const expected = [
    { days: '2 of 28 days', name: 'Food energy', title: 'Food energy recorded (kcal)', total: '100.1 kcal' },
    { days: '1 of 28 days', name: 'Protein', title: 'Protein recorded (g)', total: '10.1 g' },
    { days: '2 of 28 days', name: 'Carbohydrate', title: 'Carbohydrate recorded (g)', total: '20.2 g' },
    { days: '2 of 28 days', name: 'Fat', title: 'Fat recorded (g)', total: '5.3 g' },
  ];
  for (const metric of expected) {
    await trends.screen.getByRole('radio', { exact: true, name: metric.name }).check();
    await expect(trends.series.getByRole('heading', { level: 2 })).toHaveText(metric.title);
    await expect(trends.figure('Recorded total')).toHaveText(metric.total);
    await expect(trends.figure('Days with a value')).toHaveText(metric.days);
    await expect(trends.figure('Entries with a value')).toHaveText('2 of 4 logged entries');
    await expect(trends.figure('Days with logged entries')).toHaveText('2 of 28 days');
    await expect(trends.series.getByText(/it is not a complete food diary/u)).toBeVisible();
    await expect(trends.row(C)).toContainText('No entry logged');
    await expect(trends.row(C).getByRole('button', { name: /^Open Meal log on / })).toBeVisible();
  }
  // Open and Meal log on every row, each label on one line at desktop width (release step 9, finding 1).
  expect(await expectTrendsRowActionsOnOneLine(trends.screen.getByRole('region', { exact: true, name: 'Every date' }))).toBe(56);
  // Fat on A is a recorded zero covering 1 of 3 entries: a dot on the baseline, labelled partial.
  await expect(trends.row(A)).toContainText('0 g');
  await expect(trends.row(A)).toContainText('Partial: 1 of 3 entries with fat');
  await expect(trends.chart.locator(`circle[data-date="${A}"]`)).toHaveCount(1);
  await expect(trends.chart.locator(`circle[data-date="${A}"] title`)).toHaveText(/^Fat, .+: 0 g$/u);
  await expect(trends.chart.locator('polyline')).toHaveCount(1); // A and B are neighbours with a value each
  // Protein on B: logged, not recorded — a gap, not a zero.
  await trends.screen.getByRole('radio', { exact: true, name: 'Protein' }).check();
  await expect(trends.row(B)).toContainText('Not recorded');
  await expect(trends.row(B)).toContainText('1 entry logged, no protein recorded');
  await expect(trends.chart.locator(`[data-missing-date="${B}"]`)).toHaveCount(1);
  await expect(trends.chart.locator('circle')).toHaveCount(1);
  await expect(trends.screen).not.toContainText(/Entry (one|two|three|four)/u);
  await expect(trends.screen.locator('.trends-content')).not.toContainText(/balance|deficit|surplus|recommend|predict|target|goal|estimate/iu);

  // A range ending yesterday, Protein selected; open date A's Meal log from its row.
  await trends.screen.getByLabel('End date').fill(C);
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  await expect(trends.row(today)).toHaveCount(0);
  await trends.row(A).getByRole('button', { name: /^Open Meal log on / }).click();
  const log = mealLogScreen(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Meal log' })).toBeVisible();
  await expect(log.screen.getByLabel('Date')).toHaveValue(A);
  await expect(log.cards).toHaveCount(3);
  await expect(log.screen.getByRole('button', { name: 'Back to Trends' })).toBeVisible();
  await expect(log.screen.getByRole('button', { name: 'Back to Today' })).toBeVisible();

  // Edit entry two's protein (0 → 5.5) and delete entry one.
  await log.cards.filter({ hasText: 'Entry two' }).getByRole('button', { name: /^Edit / }).click();
  await expect(log.form.getByLabel('Protein (g)')).toHaveValue('0');
  await log.form.getByLabel('Protein (g)').fill('5.5');
  await log.form.getByRole('button', { name: 'Save changes' }).click();
  await expect(log.screen.getByText('Your changes to "Entry two" were saved.')).toBeVisible();
  const first = log.cards.filter({ hasText: 'Entry one' });
  await first.getByRole('button', { name: /^Delete / }).click();
  await first.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(log.screen.getByText('The entry was deleted.')).toBeVisible();
  await expect(log.cards).toHaveCount(2);

  // Back to Trends: the original range end and series, read again.
  await log.screen.getByRole('button', { name: 'Back to Trends' }).click();
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  await expect(trends.screen.getByLabel('End date')).toHaveValue(C);
  await expect(trends.screen.getByRole('radio', { exact: true, name: 'Protein' })).toBeChecked();
  await expect(trends.figure('Recorded total')).toHaveText('5.5 g');
  await expect(trends.figure('Entries with a value')).toHaveText('1 of 3 logged entries');
  await expect(trends.row(A)).toContainText('5.5 g');
  await expect(trends.row(A)).toContainText('Partial: 1 of 2 entries with protein');
  await trends.screen.getByRole('radio', { exact: true, name: 'Fat' }).check();
  await expect(trends.figure('Recorded total')).toHaveText('5.3 g');
  await expect(trends.figure('Days with a value')).toHaveText('1 of 28 days');
  await expect(trends.row(A)).toContainText('2 entries logged, no fat recorded');
  await trends.screen.getByRole('radio', { exact: true, name: 'Food energy' }).check();
  await expect(trends.figure('Recorded total')).toHaveText('0 kcal'); // only B's recorded zero remains

  // The way back does not survive ordinary navigation: the Meal log opened from the navigation has none.
  await navigation(page).getByRole('button', { name: 'Meal log' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Meal log' })).toBeVisible();
  await expect(log.screen.getByRole('button', { name: 'Back to Trends' })).toHaveCount(0);

  // Open Today from a Trends row still works, and the Meal log → Today path is unchanged.
  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  await trends.row(A).getByRole('button', { name: /^Open Today on / }).click();
  const todayScreen = page.getByRole('region', { exact: true, name: 'Today' });
  await expect(todayScreen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  await expect(todayScreen.getByLabel('Date')).toHaveValue(A);
  await todayScreen.getByRole('button', { name: /^Open meal log for / }).click();
  await expect(log.screen.getByLabel('Date')).toHaveValue(A);
  await expect(log.screen.getByRole('button', { name: 'Back to Trends' })).toHaveCount(0);
  await log.screen.getByRole('button', { name: 'Back to Today' }).click();
  await expect(todayScreen.getByLabel('Date')).toHaveValue(A);

  // The way back does not survive sign-out: open the Meal log from Trends, sign out and in again.
  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  await trends.row(B).getByRole('button', { name: /^Open Meal log on / }).click();
  await expect(log.screen.getByRole('button', { name: 'Back to Trends' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  await expect(page.getByRole('heading', { level: 1, name: 'Meal log' })).toBeVisible();
  await expect(log.screen.getByRole('button', { name: 'Back to Trends' })).toHaveCount(0);
});

test('Nutrition Trends at 375 px: figures, row actions and the Meal log round trip fit without horizontal scrolling', async ({
  demoScenario,
  environment,
  page,
}) => {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 600_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  const yesterday = daysBefore(today, 1);
  await page.setViewportSize({ width: 375, height: 812 });
  await signInDemoRunner(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  // Linux CI fonts are wider than Windows ones: measure with a wide font.
  await page.addStyleTag({ content: 'body, body * { font-family: Verdana, sans-serif !important; }' });
  const inside = async (locator: Locator, name: string) => {
    const box = await locator.boundingBox();
    expect(box, name).not.toBeNull();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 375, name).toBe(true);
  };

  await navigation(page).getByRole('button', { name: 'Meal log' }).click();
  await addEntries(page, yesterday, [
    { carbohydrate: '1999.9', energy: '19999.9', protein: '1234.5', title: 'Large values' },
    { protein: '0', title: 'Zero protein' },
    { title: 'Title only' },
  ]);

  await navigation(page).getByRole('button', { name: 'Trends', exact: true }).click();
  const trends = trendsScreen(page);
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  for (const name of ['Food energy', 'Protein', 'Carbohydrate', 'Fat']) await inside(trends.screen.getByRole('radio', { exact: true, name }), name);
  await trends.screen.getByRole('radio', { exact: true, name: 'Protein' }).check();
  await expect(trends.figure('Recorded total')).toHaveText('1,234.5 g');
  await expect(trends.figure('Entries with a value')).toHaveText('2 of 3 logged entries');
  await expect(trends.row(yesterday)).toContainText('Partial: 2 of 3 entries with protein');
  expect(await fits(page)).toBe(true);
  for (const label of ['Recorded total', 'Days with a value', 'Entries with a value', 'Days with logged entries']) await inside(trends.figure(label), label);
  await inside(trends.row(yesterday).getByRole('button', { name: /^Open Today on / }), 'Open');
  await inside(trends.row(yesterday).getByRole('button', { name: /^Open Meal log on / }), 'Meal log');
  await inside(trends.row(yesterday).locator('.trends-table__detail'), 'coverage detail');
  expect(await expectTrendsRowActionsOnOneLine(trends.screen.getByRole('region', { exact: true, name: 'Every date' }))).toBe(56);
  await trends.screen.getByRole('radio', { exact: true, name: 'Food energy' }).check();
  await expect(trends.figure('Recorded total')).toHaveText('19,999.9 kcal');
  expect(await fits(page)).toBe(true);
  await trends.screen.getByRole('radio', { exact: true, name: 'Fat' }).check();
  await expect(trends.row(yesterday)).toContainText('3 entries logged, no fat recorded');
  expect(await fits(page)).toBe(true);

  await trends.row(yesterday).getByRole('button', { name: /^Open Meal log on / }).click();
  const log = mealLogScreen(page);
  await expect(log.screen.getByLabel('Date')).toHaveValue(yesterday);
  expect(await fits(page)).toBe(true);
  await inside(log.screen.getByRole('button', { name: 'Back to Trends' }), 'Back to Trends');
  await inside(log.screen.getByRole('button', { name: 'Back to Today' }), 'Back to Today');
  await log.screen.getByRole('button', { name: 'Back to Trends' }).click();
  await expect(trends.state).toHaveAttribute('data-trends-state', 'ready');
  await expect(trends.screen.getByRole('radio', { exact: true, name: 'Fat' })).toBeChecked();
  expect(await fits(page)).toBe(true);
});
