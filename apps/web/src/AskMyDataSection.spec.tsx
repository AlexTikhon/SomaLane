import type { DataQuestionAnswer, DataQuestionPlan } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { activityTrendsFixture } from './activity-trends-fixtures.js';
import { AskMyDataView, type AskMyDataHandlers } from './AskMyDataSection.js';
import type { AskSnapshot, AskState } from './data-question-controller.js';
import { EMPTY_GUIDED_DRAFT, type GuidedDraft } from './data-question-guided.js';
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
  fromClarification: noop,
  interpret: noop,
  newQuestion: noop,
  openSource: noop,
  refresh: noop,
  retry: noop,
  review: noop,
  setMode: noop,
  textChange: noop,
  updateDraft: noop,
};
const provenance = { answerVersion: version, computedAt: '2026-11-08T10:00:00.000Z', persisted: false as const, serviceVersion: 'x' };

const render = (state: AskState, capability: AskSnapshot['capability'] = 'available', text = '', extra: Partial<AskSnapshot> = {}) =>
  renderToStaticMarkup(
    <AskMyDataView
      handlers={handlers}
      snapshot={{ capability, context: { selectedDate: '2026-11-05', timeZone: 'Europe/Warsaw' }, draft: EMPTY_GUIDED_DRAFT, guidedFocus: null, mode: 'guided', state, text, ...extra }}
    />,
  );
const typed = { mode: 'typed' as const };
const guided = (draft: Partial<GuidedDraft>) => ({ draft: { ...EMPTY_GUIDED_DRAFT, ...draft } });

const dayPlan: DataQuestionPlan = { operation: 'day_overview', period: { localDate: '2026-11-05', symbol: 'selected_date' }, timeZone: 'Europe/Warsaw', version };

describe('Ask my data: idle', () => {
  it('offers the predefined questions with interpretation available, off or unavailable', () => {
    for (const capability of ['available', 'off', 'unavailable', 'checking'] as const) {
      const html = render({ kind: 'idle' }, capability);
      expect(html).toContain('What did I record for the selected day?');
      expect(html).toContain('Compare my manually entered running with the previous 28 days.');
      expect(html).toContain('data-ask-state="idle"');
    }
    expect(render({ kind: 'idle' }, 'available', '', typed)).toContain('Ask in your own words (English or Russian)');
    expect(render({ kind: 'idle' }, 'off', '', typed)).not.toContain('Ask in your own words');
    expect(render({ kind: 'idle' }, 'off')).toContain('Typed questions are not available here right now');
    // No implementation detail reaches the screen.
    expect(render({ kind: 'idle' }, 'available', '', typed)).not.toMatch(/ollama|qwen|fake|provider/iu);
    expect(render({ kind: 'idle' }, 'available')).not.toMatch(/ollama|qwen|fake|provider/iu);
  });

  it('disables every way to ask while a request is in flight', () => {
    const html = render({ kind: 'interpreting' }, 'available', 'What did I record?', typed);
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

describe('Ask my data: the guided builder (ADR-0095)', () => {
  it('is the whole way to ask when interpretation is off or unavailable: no typed box, no mode switch', () => {
    for (const capability of ['off', 'unavailable', 'checking'] as const) {
      const html = render({ kind: 'idle' }, capability);
      expect(html).toContain('aria-label="Build a question"');
      expect(html).toContain('<label for="ask-guided-operation">What to read</label>');
      expect(html).not.toContain('Ask in your own words');
      expect(html).not.toContain('aria-label="How to ask"');
      expect(html).toContain('Review question');
    }
  });

  it('offers both modes, guided first, only when interpretation is available', () => {
    const html = render({ kind: 'idle' }, 'available');
    expect(html).toContain('aria-label="How to ask"');
    expect(html).toMatch(/<button aria-pressed="true" type="button">Choose a question<\/button><button aria-pressed="false" type="button">Type a question<\/button>/u);
    expect(html).toContain('aria-label="Build a question"');
    expect(html).not.toContain('Ask in your own words');
    const typedHtml = render({ kind: 'idle' }, 'available', '', typed);
    expect(typedHtml).toContain('Ask in your own words');
    expect(typedHtml).not.toContain('aria-label="Build a question"');
  });

  it('starts empty, asks only for the view, and shows no Review until the draft is complete', () => {
    const html = render({ kind: 'idle' });
    expect(html).toContain('<option value="" selected="">Choose…</option>');
    expect(html).not.toContain('id="ask-guided-period"');
    expect(html).toContain('Still to choose: what to read.');
    expect(html).toMatch(/<button aria-describedby="ask-guided-status" disabled="" type="submit">Review question<\/button>/u);
    expect(html).toContain('For another date, change the date at the top of Today.');
  });

  it('shows the fields of the chosen view with the selected date stated, and lists what is still missing', () => {
    const day = render({ kind: 'idle' }, 'available', '', guided({ operation: 'day_overview' }));
    expect(day).toContain('<label for="ask-guided-period">Day</label>');
    expect(day).toContain('The selected date (Thu, 5 Nov 2026)');
    expect(day).not.toContain('id="ask-guided-focus"');
    expect(day).toContain('Still to choose: the period.');
    const weekly = render({ kind: 'idle' }, 'available', '', guided({ operation: 'weekly_review', period: 'previous_week' }));
    expect(weekly).toContain('<label for="ask-guided-focus">Part of the week</label>');
    expect(weekly).toContain('Last week');
    expect(weekly).toContain('Still to choose: the part of the week.');
    const comparison = render({ kind: 'idle' }, 'available', '', guided({ operation: 'activity_comparison' }));
    for (const label of ['28 days ending', 'Records', 'Activity type']) expect(comparison).toContain(label);
    expect(comparison).toContain('Still to choose: the period, the records and the activity type.');
    expect(comparison).toContain('Sources are never combined');
    for (const source of ['Manual entries', 'GPX imports', 'TCX imports', 'Recorded runs']) expect(comparison).toContain(`>${source}</option>`);
  });

  it('a complete draft can be reviewed; nothing in the builder reads data by itself', () => {
    const html = render({ kind: 'idle' }, 'available', '', guided({ focus: 'nutrition', operation: 'weekly_review', period: 'current_week' }));
    expect(html).toContain('Ready to review. Nothing is read until you choose Get answer.');
    expect(html).toMatch(/<button aria-describedby="ask-guided-status" type="submit">Review question<\/button>/u);
  });

  it('recorded runs allow only run: other types are disabled, and an incompatible pair is named and blocked', () => {
    const recorded = render({ kind: 'idle' }, 'available', '', guided({ operation: 'activity_comparison', period: 'today', source: 'recorded_run' }));
    expect(recorded).toContain('<option value="run">Run</option>');
    expect(recorded).toContain('<option value="walk" disabled="">Walk</option>');
    const incompatible = render({ kind: 'idle' }, 'available', '', guided({ operation: 'activity_comparison', period: 'today', source: 'recorded_run', type: 'walk' }));
    expect(incompatible).toContain('Recorded runs are runs only. Choose Run, or another source.');
    expect(incompatible).toContain('aria-invalid="true"');
    expect(incompatible).toMatch(/disabled="" type="submit">Review question/u);
  });

  it('disables every choice while a request is in flight, and says a plan is being prepared without reading', () => {
    const html = render({ kind: 'resolving' }, 'off', '', guided({ operation: 'day_overview', period: 'today' }));
    expect(html).toContain('Preparing the plan… nothing is read yet.');
    expect(html).toContain('>Cancel<');
    expect(html).toMatch(/<select disabled="" id="ask-guided-operation"/u);
    expect(html).toMatch(/<select disabled="" id="ask-guided-period"/u);
    expect(html).toContain('data-ask-state="resolving"');
  });

  it('every clarification offers the way into the builder at the field to choose', () => {
    const labels = {
      activity_source_missing: 'Choose the source',
      activity_type_missing: 'Choose the activity type',
      operation_ambiguous: 'Choose the view',
      period_ambiguous: 'Choose a period',
    } as const;
    for (const [reason, label] of Object.entries(labels)) {
      const html = render({ kind: 'clarify', reason: reason as keyof typeof labels, sourceChoice: null }, 'available', 'x', typed);
      expect(html, reason).toContain(`>${label}</button>`);
    }
    expect(render({ kind: 'clarify', reason: 'period_ambiguous', sourceChoice: null }, 'available', 'x', typed)).toContain('change the date at the top of Today');
  });
});
