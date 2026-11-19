import type { Locator, Page, Route } from '@playwright/test';

import { expect, test } from './support/fixtures.js';
import { expectOrganizationSelected, expectSignedIn, expectSignedOut } from './support/session.js';

// "Ask my data" on Today (ADR-0094) in Chromium. The demo origin's API runs the deterministic FAKE interpreter (no model
// is ever configured in the suite); the review origin's API has interpretation off, the product default. These tests prove
// the routes, the screen and its guards; they say nothing about the quality of any real model. The demoScenario fixture
// creates the demo people and organization and removes their records afterwards.

const timeZone = 'Europe/Warsaw';
test.use({ locale: 'en-GB', timezoneId: timeZone });

const INTERPRETATIONS = '**/api/orgs/*/data-questions/interpretations';

function dateIn(zone: string, instantMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', timeZone: zone, year: 'numeric' }).formatToParts(new Date(instantMs));
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Application view' });
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function signIn(page: Page, origin: string, runnerUserId: string, orgId: string): Promise<void> {
  await page.goto(origin);
  await expectSignedOut(page);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, runnerUserId);
  await expectOrganizationSelected(page, orgId);
}

async function openAsk(page: Page): Promise<{ ask: Locator; screen: Locator; state: Locator }> {
  await navigation(page).getByRole('button', { exact: true, name: 'Today' }).click();
  const screen = page.getByRole('region', { exact: true, name: 'Today' });
  await expect(screen.locator('[data-overview-state]')).toHaveAttribute('data-overview-state', 'ready');
  const ask = screen.getByRole('region', { exact: true, name: 'Ask my data' });
  return { ask, screen, state: screen.locator('[data-ask-state]') };
}

function stableToday(): string {
  const today = dateIn(timeZone, Date.now());
  test.skip(dateIn(timeZone, Date.now() + 600_000) !== today, 'Too close to midnight in Warsaw for a stable "today"');
  return today;
}

test('1. a predefined question works with interpretation off, and the section fits a 390 px screen', async ({ demoScenario, environment, page }) => {
  const today = stableToday();
  await page.setViewportSize({ height: 844, width: 390 });
  await signIn(page, environment.reviewWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  const { ask, state } = await openAsk(page);
  await expect(ask.getByText('Typed questions are not available here right now; the questions below work without them.')).toBeVisible();
  await expect(ask.getByLabel('Ask in your own words (English or Russian)')).toHaveCount(0);

  let interpretations = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/data-questions/interpretations')) interpretations += 1;
  });
  await ask.getByRole('button', { name: 'What did I record for the selected day?' }).click();
  await expect(state).toHaveAttribute('data-ask-state', 'ready');
  const answer = ask.getByRole('region', { name: 'Answer' });
  await expect(answer.getByText(`(the selected date), time zone ${timeZone}`)).toBeVisible();
  await expect(answer.getByText('No movement recorded for this day.')).toBeVisible();
  await expect(answer.getByText(/^Computed .* by the app from your own records; not stored./u)).toBeVisible();
  expect(interpretations).toBe(0);
  expect(today.length).toBe(10);
  expect(await fitsWidth(page)).toBe(true);

  // Refresh recomputes; New question clears.
  await answer.getByRole('button', { name: 'Refresh answer' }).click();
  await expect(state).toHaveAttribute('data-ask-state', 'ready');
  await answer.getByRole('button', { name: 'New question' }).click();
  await expect(state).toHaveAttribute('data-ask-state', 'idle');
});

test('2. fake interpretation: the plan is reviewed first, then executed once into a sourced answer', async ({ demoScenario, environment, page }) => {
  stableToday();
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  const { ask, state } = await openAsk(page);
  const counts = { answers: 0, interpretations: 0 };
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/data-questions/answers')) counts.answers += 1;
    if (request.url().endsWith('/data-questions/interpretations')) counts.interpretations += 1;
  });

  const input = ask.getByLabel('Ask in your own words (English or Russian)');
  await input.fill('Show my recorded nutrition for this week');
  await input.press('Enter');
  await expect(state).toHaveAttribute('data-ask-state', 'proposal');
  const review = ask.getByRole('region', { name: 'Review the question before reading' });
  await expect(review.getByText('Nothing has been read yet.')).toBeVisible();
  await expect(review.getByText('The weekly review: recorded nutrition')).toBeVisible();
  await expect(review.getByText(/\(this week, Monday to Sunday\), time zone Europe\/Warsaw/u)).toBeVisible();
  expect(counts).toEqual({ answers: 0, interpretations: 1 });

  await review.getByRole('button', { name: 'Get answer' }).dblclick();
  await expect(state).toHaveAttribute('data-ask-state', 'ready');
  expect(counts.answers).toBe(1);
  const answer = ask.getByRole('region', { name: 'Answer' });
  await expect(answer.getByText('No meals were logged in this week.')).toBeVisible();

  // The source action opens the existing weekly review on the same week.
  await answer.getByRole('button', { name: 'Open the weekly review' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Weekly review' })).toBeFocused();
});

test('3. an ambiguous source asks for an explicit choice, which becomes a plan to review', async ({ demoScenario, environment, page }) => {
  stableToday();
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  const { ask, state } = await openAsk(page);
  await ask.getByLabel('Ask in your own words (English or Russian)').fill('Compare my running with the previous 28 days');
  await ask.getByRole('button', { name: 'Interpret question' }).click();
  await expect(state).toHaveAttribute('data-ask-state', 'clarify');
  await expect(ask.getByText(/never combined, so choose one/u)).toBeVisible();
  const choices = ask.getByRole('group', { name: 'Choose one source' });
  await expect(choices.getByRole('button')).toHaveText(['Manual entries', 'GPX imports', 'TCX imports', 'Recorded runs']);
  await choices.getByRole('button', { name: 'GPX imports' }).click();
  await expect(state).toHaveAttribute('data-ask-state', 'proposal');
  await expect(ask.getByText(/^Comparison: /u)).toBeVisible();
  await expect(ask.getByText(/GPX imports only, never combined with another source/u)).toBeVisible();
  await ask.getByRole('button', { name: 'Get answer' }).click();
  await expect(state).toHaveAttribute('data-ask-state', 'ready');
  await expect(ask.getByText(/This period includes today, so it can still change/u)).toBeVisible();
  await ask.getByRole('button', { name: 'Open in Trends' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trends' })).toBeVisible();
});

test('4. missing and partial data: unknown stays unknown and coverage says what a total covers', async ({ demoScenario, environment, page }) => {
  stableToday();
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  // Two meals for today through the existing Meal log form: one with food energy, one title-only.
  await navigation(page).getByRole('button', { name: 'Meal log' }).click();
  const mealLog = page.getByRole('region', { exact: true, name: 'Meal log' });
  await expect(mealLog.locator('[data-meal-list-state]')).toHaveAttribute('data-meal-list-state', 'ready');
  const form = mealLog.locator('form.meal-form');
  await form.getByLabel('Title').fill('Soup');
  await form.getByLabel('Food energy (kcal)').fill('300');
  await form.getByRole('button', { name: 'Add entry' }).click();
  await expect(form.getByText('Entry saved.')).toBeVisible();
  await form.getByLabel('Title').fill('Tea');
  await form.getByRole('button', { name: 'Add entry' }).click();
  await expect(mealLog.getByText('Tea', { exact: true })).toBeVisible();

  const { ask, state } = await openAsk(page);
  await ask.getByRole('button', { name: 'What did I record for the selected day?' }).click();
  await expect(state).toHaveAttribute('data-ask-state', 'ready');
  const answer = ask.getByRole('region', { name: 'Answer' });
  await expect(answer.getByText('2 entries logged for this day.')).toBeVisible();
  await expect(answer.getByText(/Recorded for 1 of 2 logged entries/u)).toBeVisible();
  await expect(answer.getByText('Not recorded for any of the 2 logged entries.').first()).toBeVisible();
  await expect(answer.getByText('No movement recorded for this day.')).toBeVisible();
  await expect(answer).not.toContainText(/balance|deficit|should|recommend/iu);
});

test('5. a pending interpretation is dropped on a date change and on sign-out; nothing reaches the next session', async ({ demoScenario, environment, page }) => {
  const today = stableToday();
  await signIn(page, environment.demoWebOrigin, demoScenario.runnerUserId, demoScenario.orgId);
  const opened = await openAsk(page);
  const { screen } = opened;
  let { ask, state } = opened;

  const held: Route[] = [];
  await page.route(INTERPRETATIONS, (route) => {
    held.push(route);
  });
  const releaseAll = async () => {
    for (const route of held.splice(0)) await route.continue().catch(() => undefined);
  };

  // A date change while the question is being interpreted: back to idle, the late answer is ignored.
  await ask.getByLabel('Ask in your own words (English or Russian)').fill('What did I record today?');
  await ask.getByRole('button', { name: 'Interpret question' }).click();
  await expect(state).toHaveAttribute('data-ask-state', 'interpreting');
  await expect(ask.getByRole('button', { name: 'What did I record for the selected day?' })).toBeDisabled();
  await screen.getByLabel('Date').fill(daysBefore(today, 1));
  await expect(state).toHaveAttribute('data-ask-state', 'idle');
  await releaseAll();
  await page.waitForTimeout(300);
  await expect(state).toHaveAttribute('data-ask-state', 'idle');

  // Cancel, then a retry works.
  await ask.getByRole('button', { name: 'Interpret question' }).click();
  await expect(state).toHaveAttribute('data-ask-state', 'interpreting');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(state).toHaveAttribute('data-ask-state', 'idle');
  await releaseAll();

  // Sign-out while pending: the next session starts empty and never shows the late proposal.
  await ask.getByRole('button', { name: 'Interpret question' }).click();
  await expect(state).toHaveAttribute('data-ask-state', 'interpreting');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expectSignedOut(page);
  await releaseAll();
  await page.unroute(INTERPRETATIONS);
  await page.getByRole('region', { name: 'Local demo sign-in' }).getByRole('button', { name: 'Demo runner' }).click();
  await expectSignedIn(page, demoScenario.runnerUserId);
  ({ ask, state } = await openAsk(page));
  await expect(state).toHaveAttribute('data-ask-state', 'idle');
  await expect(ask.getByLabel('Ask in your own words (English or Russian)')).toHaveValue('');
  await expect(ask.getByRole('region', { name: 'Review the question before reading' })).toHaveCount(0);
});
