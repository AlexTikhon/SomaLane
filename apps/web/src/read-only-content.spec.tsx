import type { MealView } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { overviewFixture, noteOnlyCheckIn } from './daily-overview-fixtures.js';
import { nutritionTrends, NUTRITION_A } from './daily-trends-fixtures.js';
import { mealEntryLabel, MealEntryValues } from './MealEntryValues.js';
import { OverviewContent } from './TodayOverviewContent.js';
import { TrendsContent } from './TrendsContent.js';

// The pure content blocks extracted for the public read-only showcase (ADR-0099): the application renders them with
// its actions exactly as before; without actions (or with the read-only meal action) they offer no editing control.

const noop = () => undefined;
// A day with a check-in that has a value and a note, and a movement day.
const recordedDay = () =>
  overviewFixture({
    checkIn: { ...noteOnlyCheckIn, mood: 4 },
    movement: { activeEnergyKcal: 412.5, recorded: true, source: 'manual', steps: null, timeZone: 'Europe/Warsaw' },
  });
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gsu)].map((match) => match[1]);

describe('Today’s overview content', () => {
  it('keeps every editor, history and navigation action when the application passes onAction', () => {
    const html = renderToStaticMarkup(<OverviewContent onAction={noop} overview={recordedDay()} />);
    expect(buttons(html)).toEqual(expect.arrayContaining(['Edit check-in', 'Edit movement', 'Add a meal', 'Open Activities', 'Open Runner']));
  });

  it('renders the same figures with no control at all when read-only', () => {
    const overview = recordedDay();
    const withActions = renderToStaticMarkup(<OverviewContent onAction={noop} overview={overview} />);
    const readOnly = renderToStaticMarkup(<OverviewContent overview={overview} />);
    expect(buttons(readOnly)).toEqual([]);
    expect(readOnly).toContain('aria-label="Check-in values"');
    expect(readOnly.replace(/<p class="today-note">A note[^<]*<\/p>/u, '')).toBe(
      withActions.replace(/<button\b[^>]*>.*?<\/button>/gsu, '').replace(/<div class="run-card__actions"><\/div>/gu, '').replace(/<p class="today-note">A note[^<]*<\/p>/u, ''),
    );
  });

  it('does not tell a read-only reader to open the check-in for its note', () => {
    const readOnly = renderToStaticMarkup(<OverviewContent overview={recordedDay()} />);
    expect(readOnly).toContain('<p class="today-note">A note is saved with this check-in.</p>');
    expect(readOnly).not.toContain('open the check-in');
    const noteOnly = renderToStaticMarkup(<OverviewContent overview={overviewFixture({ checkIn: noteOnlyCheckIn })} />);
    expect(noteOnly).toContain('it has no sleep, mood, soreness or weight values.</p>');
    expect(noteOnly).not.toContain('Open the check-in to read it');
  });
});

describe('Trends content', () => {
  it('names the Meal log editor by default and a read-only list for the showcase', () => {
    const trends = nutritionTrends();
    const editor = renderToStaticMarkup(<TrendsContent metric="fatG" onOpenDay={noop} onOpenMealLog={noop} timeZone="Europe/Warsaw" trends={trends} />);
    expect(editor).toContain('aria-label="Open Meal log on Mon, 2 Nov 2026"');
    expect(editor).toContain('Meal log lists that date’s entries to edit or delete');
    const readOnly = renderToStaticMarkup(<TrendsContent mealAction={{ aria: (dateLabel) => `Open the logged meals of ${dateLabel}`, note: 'Meals lists entries, read-only.', text: 'Meals' }} metric="fatG" onOpenDay={noop} onOpenMealLog={noop} timeZone="Europe/Warsaw" trends={trends} />);
    expect(readOnly).toContain('aria-label="Open the logged meals of Mon, 2 Nov 2026"');
    expect(readOnly).not.toMatch(/edit or delete|Meal log/u);
    expect(readOnly).toContain(`data-date="${NUTRITION_A}"`);
  });
});

describe('a meal entry’s values', () => {
  const view: MealView = {
    carbohydrateG: null,
    createdAt: '2026-11-21T23:00:00.000Z',
    energyKcal: 0,
    fatG: 0,
    localDate: '2026-11-21',
    mealId: '3f0c1d52-7a9b-8c1e-9d2f-0a1b2c3d4e5f',
    mealType: 'snack',
    proteinG: 0,
    source: 'manual',
    timeZone: 'Europe/Warsaw',
    title: 'Black coffee',
    updatedAt: '2026-11-21T23:00:00.000Z',
  };

  it('shows a recorded 0 as 0 and an unknown value as not recorded, with no control', () => {
    const html = renderToStaticMarkup(<MealEntryValues view={view} />);
    expect(mealEntryLabel(view)).toBe('snack "Black coffee"');
    expect(html).toContain('aria-label="Values of snack &quot;Black coffee&quot;"');
    expect(html).toContain('today-rows__missing');
    expect(html).toContain('Not recorded');
    expect(buttons(html)).toEqual([]);
  });
});
