import type { DataQuestionAnswer, DataQuestionPlan } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { activityTrendsFixture } from './activity-trends-fixtures.js';
import { AskMyDataView, type AskMyDataHandlers } from './AskMyDataSection.js';
import type { AskSnapshot, AskState } from './data-question-controller.js';
import { noMeals, overviewFixture } from './daily-overview-fixtures.js';
import { mealsFixture, movementFixture, reviewFixture } from './weekly-review-fixtures.js';

// The "Ask my data" section (ADR-0094) rendered from snapshots: what it shows in each state, with fixed wording only.

const version = 'data-question-1' as const;
const noop = () => undefined;
const handlers: AskMyDataHandlers = {
  ask: noop,
  cancel: noop,
  chooseSource: noop,
  dismiss: noop,
  execute: noop,
  interpret: noop,
  openSource: noop,
  refresh: noop,
  retry: noop,
  textChange: noop,
};
const provenance = { answerVersion: version, computedAt: '2026-11-08T10:00:00.000Z', persisted: false as const, serviceVersion: 'x' };

const render = (state: AskState, capability: AskSnapshot['capability'] = 'available', text = '') =>
  renderToStaticMarkup(<AskMyDataView handlers={handlers} snapshot={{ capability, context: { selectedDate: '2026-11-05', timeZone: 'Europe/Warsaw' }, state }} text={text} />);

const dayPlan: DataQuestionPlan = { operation: 'day_overview', period: { localDate: '2026-11-05', symbol: 'selected_date' }, timeZone: 'Europe/Warsaw', version };

describe('Ask my data: idle', () => {
  it('offers the predefined questions with interpretation available, off or unavailable', () => {
    for (const capability of ['available', 'off', 'unavailable', 'checking'] as const) {
      const html = render({ kind: 'idle' }, capability);
      expect(html).toContain('What did I record for the selected day?');
      expect(html).toContain('Compare my manually entered running with the previous 28 days.');
      expect(html).toContain('data-ask-state="idle"');
    }
    expect(render({ kind: 'idle' }, 'available')).toContain('Ask in your own words (English or Russian)');
    expect(render({ kind: 'idle' }, 'off')).not.toContain('Ask in your own words');
    expect(render({ kind: 'idle' }, 'off')).toContain('the questions below work without them');
    // No implementation detail reaches the screen.
    expect(render({ kind: 'idle' }, 'available')).not.toMatch(/ollama|qwen|fake|provider/iu);
  });

  it('disables every way to ask while a request is in flight', () => {
    const html = render({ kind: 'interpreting' }, 'available', 'What did I record?');
    expect(html).toContain('Interpreting your question…');
    expect(html).toContain('>Cancel<');
    expect(html.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(7);
  });
});

describe('Ask my data: the plan before anything is read', () => {
  it('states the subject, the explicit dates, the zone and the source', () => {
    const week: DataQuestionPlan = {
      focus: 'nutrition',
      operation: 'weekly_review',
      period: { symbol: 'previous_week', weekEnd: '2026-11-08', weekStart: '2026-11-02' },
      timeZone: 'Europe/Warsaw',
      version,
    };
    const html = render({ kind: 'proposal', plan: week });
    expect(html).toContain('Nothing has been read yet.');
    expect(html).toContain('The weekly review: recorded nutrition');
    expect(html).toContain('Mon, 2 Nov 2026 – Sun, 8 Nov 2026 (last week, Monday to Sunday), time zone Europe/Warsaw');
    expect(html).toContain('Get answer');
    const comparison: DataQuestionPlan = {
      compare: 'previous_period',
      operation: 'activity_comparison',
      period: { endDate: '2026-11-05', previousEndDate: '2026-10-08', previousStartDate: '2026-09-11', startDate: '2026-10-09', symbol: 'selected_date' },
      source: 'gpx',
      timeZone: 'Europe/Warsaw',
      type: 'ride',
      version,
    };
    const compared = render({ kind: 'proposal', plan: comparison });
    expect(compared).toContain('Thu, 8 Oct 2026, time zone Europe/Warsaw');
    expect(compared).toContain('GPX imports only, never combined with another source');
  });
});

describe('Ask my data: answers', () => {
  it('a day answer keeps missing apart from a recorded zero, and food energy apart from active energy', () => {
    const answer: DataQuestionAnswer = {
      operation: 'day_overview',
      plan: dayPlan,
      provenance: { ...provenance, service: 'daily_overview' },
      result: overviewFixture({
        meals: { ...noMeals, count: 2, energyKcal: { recordedEntries: 1, total: 0 } },
        movement: { activeEnergyKcal: null, recorded: true, source: 'manual', steps: 0, timeZone: 'Europe/Warsaw' },
      }),
      version,
    };
    const html = render({ answer, kind: 'ready', refreshing: false });
    expect(html).toContain('data-ask-state="ready"');
    expect(html).toContain('<dt>Steps</dt><dd>0 steps</dd>');
    expect(html).toContain('<dt>Active energy</dt><dd>Not recorded</dd>');
    expect(html).toContain('not combined with active energy');
    expect(html).toContain('Show Thu, 5 Nov 2026 on Today');
    expect(html).toContain('not stored');
    expect(html).not.toMatch(/balance|deficit|surplus|should|recommend/iu);
  });

  it('a weekly nutrition answer shows totals with coverage and the incomplete-logging caveat', () => {
    const review = reviewFixture({ meals: mealsFixture([{ energyKcal: 500, offset: 0 }, { offset: 0 }, { energyKcal: 0, offset: 2 }]) });
    const answer: DataQuestionAnswer = {
      operation: 'weekly_review',
      plan: { focus: 'nutrition', operation: 'weekly_review', period: { symbol: 'selected_week', weekEnd: '2026-11-08', weekStart: '2026-11-02' }, timeZone: 'Europe/Warsaw', version },
      provenance: { ...provenance, service: 'weekly_review' },
      result: { focus: 'nutrition', meals: review.meals, statements: [], week: review.week },
      version,
    };
    const html = render({ answer, kind: 'ready', refreshing: false });
    expect(html).toContain('500 kcal for 2 of 3 entries');
    expect(html).toContain('it does not mean every meal or snack was logged');
    expect(html).toContain('Open the weekly review');
  });

  it('a weekly movement answer says unrecorded days are unknown', () => {
    const review = reviewFixture({ movement: movementFixture([{ activeEnergyKcal: null, offset: 0, steps: 4200 }]) });
    const answer: DataQuestionAnswer = {
      operation: 'weekly_review',
      plan: { focus: 'movement', operation: 'weekly_review', period: { symbol: 'previous_week', weekEnd: '2026-11-08', weekStart: '2026-11-02' }, timeZone: 'Europe/Warsaw', version },
      provenance: { ...provenance, service: 'weekly_review' },
      result: { focus: 'movement', movement: review.movement, statements: [], week: review.week },
      version,
    };
    const html = render({ answer, kind: 'ready', refreshing: false });
    expect(html).toContain('on 1 of 7 days');
    expect(html).toContain('A day without a value is unknown, not zero.');
  });

  it('a comparison answer keeps the existing suppression reasons and the source label', () => {
    const trends = activityTrendsFixture({ endDate: '2026-11-08', source: 'manual', today: '2026-11-08', type: 'run' });
    if (trends.comparison === undefined || trends.source !== 'manual') throw new Error('fixture without comparison');
    const answer: DataQuestionAnswer = {
      operation: 'activity_comparison',
      plan: {
        compare: 'previous_period',
        operation: 'activity_comparison',
        period: { endDate: '2026-11-08', previousEndDate: '2026-10-11', previousStartDate: '2026-09-14', startDate: '2026-10-12', symbol: 'today' },
        source: 'manual',
        timeZone: 'Europe/Warsaw',
        type: 'run',
        version,
      },
      provenance: { ...provenance, service: 'activity_trends' },
      result: { applied: { ...trends.applied, compare: 'previous_period' }, comparison: trends.comparison, range: trends.range, source: 'manual', summary: trends.summary },
      version,
    };
    const html = render({ answer, kind: 'ready', refreshing: false });
    expect(html).toContain('This period includes today, so it can still change.');
    expect(html).toContain('Not compared');
    expect(html).toContain('Open in Trends');
  });
});

describe('Ask my data: clarifications, refusals and errors', () => {
  it('offers only the sources that record the type, and never a combination', () => {
    const html = render({ kind: 'clarify', reason: 'activity_source_missing', sourceChoice: { operation: 'activity_comparison', period: 'selected_date', type: 'walk' } });
    expect(html).toContain('never combined');
    expect(html).toContain('aria-label="Choose one source"');
    expect(html).not.toContain('Recorded runs</button>');
    const run = render({ kind: 'clarify', reason: 'activity_source_missing', sourceChoice: { operation: 'activity_comparison', period: 'selected_date', type: 'run' } });
    expect(run.match(/<button type="button">(Manual entries|GPX imports|TCX imports|Recorded runs)<\/button>/gu)).toHaveLength(4);
  });

  it('words each refusal with fixed text', () => {
    expect(render({ kind: 'unsupported', reason: 'medical_or_coaching' })).toContain('coaching advice are not offered');
    expect(render({ kind: 'unsupported', reason: 'other_person' })).toContain('Only your own records');
  });

  it('shows Retry only for a retryable error, and never an old answer beside an error', () => {
    expect(render({ accessDenied: false, kind: 'error', message: 'Failed.', retryable: true })).toContain('>Retry<');
    const denied = render({ accessDenied: true, kind: 'error', message: 'You no longer have access to this organization.', retryable: false });
    expect(denied).not.toContain('>Retry<');
    expect(denied).not.toContain('aria-label="Answer"');
  });
});
