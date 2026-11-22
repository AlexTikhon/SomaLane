import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { loadingReview } from './weekly-review-controller.js';
import { recentWeeks } from './weekly-insight.js';
import { ReviewPanelView } from './WeeklyReviewPanel.js';
import { ReviewJourneyActions, WeeklyReviewScreen } from './WeeklyReviewScreen.js';

const noop = () => undefined;
// Wednesday 18 Nov 2026, noon in Warsaw.
const WEDNESDAY_NOON = Date.parse('2026-11-18T11:00:00Z');

function screen(initialWeek: string | null): string {
  return renderToStaticMarkup(
    <WeeklyReviewScreen
      focusOnOpen={false}
      initialWeek={initialWeek}
      nowMs={WEDNESDAY_NOON}
      onOpenTrends={noop}
      onSelectWeek={noop}
      orgId="org-a"
      signal={new AbortController().signal}
      timeZone="Europe/Warsaw"
    />,
  );
}

/** Presses the action button of a rendered ReviewJourneyActions element and returns the end date it asked for. */
function pressTrends(weekStart: string, today: string): string | undefined {
  let asked: string | undefined;
  const element = ReviewJourneyActions({ onOpenTrends: (endDate) => { asked = endDate; }, today, weekStart });
  const [button] = (element.props as { children: Array<{ props: { onClick: () => void } }> }).children;
  button!.props.onClick();
  return asked;
}

describe('the Weekly review view', () => {
  it('is the existing review section with the page heading, the week picker and the Trends action under it', () => {
    const html = screen(null);
    expect(html).toContain('<h1 id="review-title" tabindex="-1">Weekly review</h1>');
    expect(html).not.toContain('<h2 id="review-title"');
    expect(html).toContain('Computed by the app');
    // The current week by default, and the Trends action names today's date, since the week is still in progress.
    expect(html).toContain('<option value="2026-11-16" selected="">This week: 16 Nov – 22 Nov 2026</option>');
    expect(html).toMatch(/aria-label="Open 28-day trends ending on Wed,? 18 Nov 2026"/u);
    expect(html).toContain('This week is still in progress, so the range ends today.');
    // Only the deterministic review: no AI insight section and no Check-in editor.
    expect(html).not.toContain('AI insight');
    expect(html).not.toContain('Save check-in');
    expect(html.indexOf('class="insight-panel__controls"')).toBeLessThan(html.indexOf('class="review-journey"'));
    expect(html.indexOf('class="review-journey"')).toBeLessThan(html.indexOf('data-review-state'));
  });

  it('opens a kept or contextual week, also an older one, and ignores one that is not a valid Monday', () => {
    const completed = screen('2026-11-09');
    expect(completed).toContain('<option value="2026-11-09" selected="">Last week: 9 Nov – 15 Nov 2026</option>');
    expect(completed).toMatch(/aria-label="Open 28-day trends ending on Sun,? 15 Nov 2026"/u);
    expect(completed).toContain('The range ends on this week’s Sunday.');
    expect(screen('2026-03-02')).toContain('<option value="2026-03-02" selected="">Week: 2 Mar – 8 Mar 2026</option>');
    for (const invalid of ['2026-11-10', '2026-11-23', 'nonsense']) {
      expect(screen(invalid), invalid).toContain('<option value="2026-11-16" selected="">');
    }
  });

  it('asks for Trends ending on Sunday for a completed week and today for the current week', () => {
    expect(pressTrends('2026-11-09', '2026-11-18')).toBe('2026-11-15');
    expect(pressTrends('2026-11-16', '2026-11-18')).toBe('2026-11-18');
    expect(pressTrends('2026-11-16', '2026-11-22')).toBe('2026-11-22');
  });

  it('leaves the Check-in tab section as it was: a level-2 heading and no actions', () => {
    const html = renderToStaticMarkup(
      <ReviewPanelView onRefresh={noop} onSelectWeek={noop} snapshot={loadingReview('2026-11-02')} weeks={recentWeeks('2026-11-11')} />,
    );
    expect(html).toContain('<h2 id="review-title" tabindex="-1">Weekly review</h2>');
    expect(html).not.toContain('review-journey');
  });
});
