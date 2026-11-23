import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { initialShowcaseState, showcaseReducer, type ShowcaseAction, type ShowcaseState } from './showcase-state.js';
import { committedSnapshot } from './showcase-test-support.js';
import { SHOWCASE_LABEL, ShowcaseFrame, ShowcaseLoadState, ShowcaseMeals, ShowcaseReview, ShowcaseToday, ShowcaseTrends } from './ShowcaseViews.js';

const snapshot = committedSnapshot();
const noop = () => undefined;
const state = (actions: ShowcaseAction[] = []): ShowcaseState => actions.reduce((current, action) => showcaseReducer(snapshot, current, action), initialShowcaseState(snapshot));

function page(view: ShowcaseState, appUrl: string | null = 'https://app.example.org/'): string {
  const props = { dispatch: noop, snapshot, state: view };
  return renderToStaticMarkup(
    <ShowcaseFrame appUrl={appUrl} dispatch={noop} snapshot={snapshot} view={view.view}>
      {view.view === 'today' && <ShowcaseToday {...props} />}
      {view.view === 'review' && <ShowcaseReview {...props} />}
      {view.view === 'trends' && <ShowcaseTrends {...props} />}
      {view.view === 'meals' && <ShowcaseMeals {...props} />}
    </ShowcaseFrame>,
  );
}

const views = {
  meals: state([{ kind: 'meals-of-day' }]),
  review: state([{ kind: 'review-of-day' }]),
  today: state(),
  trends: state([{ kind: 'navigate', view: 'trends' }, { kind: 'choose-metric', metric: 'foodEnergyKcal' }]),
};

/** Visible words of controls that would change data, sign in or generate output: none may exist in the showcase. */
const FORBIDDEN_CONTROLS = /\b(Edit|Delete|Add|Save|Import|Upload|Record|Start|Finish|Pause|Resume|Simulat\w*|Sign in|Sign out|Demo runner|Demo coach|Draft|Generate|Ask|Share|Refresh|Retry)\b/u;
const controlTexts = (html: string) => [...html.matchAll(/<(button|a)\b[^>]*>(.*?)<\/\1>/gsu)].map((match) => match[2]!.replace(/<[^>]+>/gu, ''));

describe('every showcase view', () => {
  it.each(Object.entries(views))('%s carries the read-only, synthetic label, the data it shows and the application link', (_name, view) => {
    const html = page(view);
    expect(html).toContain(`<strong>${SHOWCASE_LABEL}</strong>`);
    expect(SHOWCASE_LABEL).toBe('Read-only showcase · synthetic data');
    expect(html).toContain('Generated data of one fictional person, Sun, 27 Sept 2026 to Sat, 21 Nov 2026 in Europe/Warsaw; sample date Sat, 21 Nov 2026.');
    expect(html).toContain('href="https://app.example.org/"');
    expect(html).toContain('Open the invite-only application');
    expect(html).toContain('Optional AI features are off by default and are not part of this showcase.');
  });

  it.each(Object.entries(views))('%s has no editing, deletion, import, recording, generation or sign-in control', (_name, view) => {
    const html = page(view);
    expect(controlTexts(html).filter((text) => FORBIDDEN_CONTROLS.test(text))).toEqual([]);
    expect(html).not.toMatch(/<form|<textarea|type="file"|type="date"|contenteditable/u);
  });

  it('says so when the application link is not configured, and links nowhere', () => {
    const html = page(views.today, null);
    expect(html).toContain('The address of the invite-only application is not configured in this build.');
    expect(html).not.toContain('<a ');
  });
});

describe('Today in the showcase', () => {
  it('shows the sample date’s overview without any action, from the snapshot only', () => {
    const html = page(views.today);
    expect(html).toContain('Showing <strong>Sat, 21 Nov 2026</strong> (sample date) in the time zone Europe/Warsaw.');
    expect(html).toMatch(/aria-label="Weekly review of 16[^"]*22 Nov 2026"/u);
    expect(html).toContain('Open 28-day trends ending on Sat, 21 Nov 2026');
    expect(html).toContain('<p class="today-note">A note is saved with this check-in.</p>');
    expect(html).toContain('The text of a check-in note is not part of the snapshot.');
    expect(html).toContain('8,424');
    // Only offered dates can be chosen.
    expect([...html.matchAll(/<option value="([^"]+)"/gu)].map((match) => match[1])).toEqual(snapshot.selections.days);
  });

  it('shows an unlogged date as nothing recorded, and says where its 28-day trends are', () => {
    const html = page(state([{ kind: 'choose-day', localDate: '2026-11-11' }]));
    expect(html).toContain('Nothing is recorded for Wed, 11 Nov 2026 yet.');
    expect(html).toContain('28-day trends in this showcase end on Sun, 15 Nov 2026 and Sat, 21 Nov 2026; open them from the Trends view.');
    expect(html).not.toContain('Open 28-day trends ending on Wed, 11 Nov 2026');
  });

  it('offers Back to Trends only when it was opened from a Trends row', () => {
    expect(page(views.today)).not.toContain('Back to Trends');
    const fromTrends = state([{ kind: 'open-day-from-trends', back: { endDate: '2026-11-15', metric: 'proteinG' }, localDate: '2026-11-01' }]);
    expect(page(fromTrends)).toContain('aria-label="Back to Trends ending Sun, 15 Nov 2026, Protein"');
  });
});

describe('the Weekly review in the showcase', () => {
  it('is the application’s review content for the week of the sample date, with the policy’s Trends end date', () => {
    const html = page(views.review);
    expect(html).toContain('<h1 id="review-title" tabindex="-1">Weekly review</h1>');
    expect(html).toContain('Open 28-day trends ending on Sat, 21 Nov 2026');
    expect(html).toContain('This week continues after the snapshot’s last date, Sat, 21 Nov 2026, so the range ends on that date.');
    expect(html).toContain('aria-label="What your records show"');
    expect([...html.matchAll(/<option value="([^"]+)"/gu)].map((match) => match[1])).toEqual(snapshot.selections.weeks);
  });

  it('says when a week’s range is not part of the snapshot instead of offering a dead action', () => {
    const html = page(state([{ kind: 'choose-day', localDate: '2026-10-20' }, { kind: 'review-of-day' }]));
    expect(html).toContain('This week&#x27;s 28-day trends would end on Sun, 25 Oct 2026; this showcase includes the ranges ending on Sun, 15 Nov 2026 and Sat, 21 Nov 2026.');
    expect(html).not.toContain('Open 28-day trends ending on Sun, 25 Oct 2026');
    expect(html).toContain('The range ends on this week’s Sunday.');
  });
});

describe('Trends in the showcase', () => {
  it('shows the range, the series and read-only meal actions on nutrition rows, with partial and missing dates as such', () => {
    const html = page(views.trends);
    expect(html).toContain('Range: <strong>28 days, Sun, 25 Oct 2026 to Sat, 21 Nov 2026</strong>');
    expect(html).toContain('Meals lists that date’s logged entries, read-only, with a way back here.');
    expect(html).toContain('aria-label="Open the logged meals of Sat, 14 Nov 2026"');
    expect(html).not.toContain('Open Meal log on');
    expect(html).toMatch(/<tr class="trends-table__missing"[^>]*data-date="2026-10-29"/u);
    // Carbohydrate is recorded on 1 of the 2 entries of 14 Nov: a partial date.
    const carbohydrate = page(state([{ kind: 'navigate', view: 'trends' }, { kind: 'choose-metric', metric: 'carbohydrateG' }]));
    expect(carbohydrate).toMatch(/data-coverage="partial" data-date="2026-11-14"/u);
    expect([...html.matchAll(/<option value="(2026-[^"]+)"/gu)].map((match) => match[1])).toEqual(['2026-11-15', '2026-11-21']);
  });

  it('offers only the activity sources and types the snapshot holds, with the comparison the service computed', () => {
    const html = page(views.trends);
    expect(html).toContain('data-showcase-activity="manual|run"');
    expect(html).toContain('Compared with the previous 28 days');
    const sources = [...html.matchAll(/<option value="(manual|gpx|tcx|recorded_run)"/gu)].map((match) => match[1]);
    expect(sources).toEqual(['manual', 'gpx', 'tcx', 'recorded_run']);
    const types = [...html.matchAll(/<option value="(run|walk|ride|hike|swim|strength|other)"/gu)].map((match) => match[1]);
    expect(types).toEqual(['run', 'walk', 'strength']);
  });
});

describe('the read-only meal list', () => {
  it('lists a date’s entries with recorded zeros as 0 and a missing value as not recorded', () => {
    const html = page(views.meals);
    expect(html).toContain('<h1 id="meals-title" tabindex="-1">Logged meals</h1>');
    expect(html).toContain('Black coffee');
    expect(html).toContain('Entries for Sat, 21 Nov 2026');
    const titleOnly = page(state([{ kind: 'choose-day', localDate: '2026-11-20' }, { kind: 'meals-of-day' }]));
    expect(titleOnly).toContain('today-rows__missing');
  });

  it('says that a date without entries is unknown, not zero', () => {
    const html = page(state([{ kind: 'choose-day', localDate: '2026-10-29' }, { kind: 'meals-of-day' }]));
    expect(html).toContain('Nothing is logged for Thu, 29 Oct 2026. That is unknown, not zero: no entry was made.');
  });
});

describe('the snapshot’s loading and failure', () => {
  it('keeps the label and the link, says what failed and offers only to load the file again', () => {
    const html = renderToStaticMarkup(
      <ShowcaseFrame appUrl={null} snapshot={null} view={null}>
        <ShowcaseLoadState load={{ kind: 'error', message: 'The showcase data file is not available (HTTP 404). This build may be incomplete.' }} onRetry={noop} />
      </ShowcaseFrame>,
    );
    expect(html).toContain(SHOWCASE_LABEL);
    expect(html).toContain('role="alert"');
    expect(html).toContain('The showcase data file is not available (HTTP 404).');
    expect(html).toContain('it never asks the application for data');
    expect(controlTexts(html)).toEqual(['Try again']);
    expect(html).not.toContain('Showcase view');
  });

  it('shows a polite loading state', () => {
    const html = renderToStaticMarkup(<ShowcaseLoadState load={{ kind: 'loading' }} onRetry={noop} />);
    expect(html).toContain('Loading the synthetic snapshot…');
    expect(html).toContain('role="status"');
  });
});
