# ADR-0097: Navigation and first-use flow — Today first, a Weekly review view, and recording independent of the view

- Status: accepted; implemented and verified on the workstation (see the
  [verification report](../reports/navigation-first-use-verification-2026-11-22.md)). No hosted CI run and no physical
  device.
- Date: 2026-11-22
- Release step: 3 of the [portfolio v1 release plan](../portfolio-v1-release-plan.md#step-3-navigation-and-first-use-flow).
- Amends: [ADR-0082](0082-today-daily-overview.md) (the page no longer opens on Runner; Today is the start view),
  [ADR-0094](0094-ask-my-data.md) (an answer's "Open the weekly review" opens the Weekly review view, not the Check-in tab).
- Relates to: ADR-0077/0079/0093 (the deterministic weekly review, unchanged), ADR-0084/0096 (Trends and its Meal log
  way back, unchanged), ADR-0052/0053/0059/0061 (run authority, writer lease, request ownership, capture; unchanged).
- Scope: `apps/web` only (App, navigation intents, a date-policy module, a Weekly review view composed of the existing
  panel, a derived Runner status, Today's new action, styles), tests and docs. No API, contract, schema, migration,
  storage format, dependency, routing library, URL scheme or browser storage.

## Context

The primary journey of portfolio v1 is daily records → Today → weekly review → Trends → back to the records. Before
this change the page opened on Runner, because Runner's startup restores and recovers an active run (ADR-0082 kept it
the start view for that reason), and the weekly review was reachable only as a section at the bottom of the Check-in tab,
below two editor forms. A first-time visitor saw a run console, and nothing pointed at the week.

Two properties had to survive: an active run is restored and resumed after a reload whatever view opens, and moving
between views never stops capture, uploads or the writer lease. Both already hold because App, not a screen, owns
restoration, the authority reads, the upload worker, the capture controller and the writer coordinator, and the Runner
view stays mounted (hidden) while other views are shown. So the start view can change without moving any lifetime.

## Decision 1: Today is the start view; no effect ever changes the view

`START_VIEW = 'today'` (`navigation-intent.ts`) is the initial view state. Restoration from IndexedDB, the writer
claim, the authority read, capture and uploads start exactly as before, from App's effects, independent of the view;
none of them calls `setActiveView`. The view changes only on a person's action (a navigation button, a contextual
action, the status's "Go to Runner"). A reload therefore always opens Today, also during a recorded run; the run is
restored and resumes in the background, and the status below says so.

Rejected: opening Runner when restoration finds an active run. Restoration is asynchronous, so that would be a late
initialization effect switching the view under a person who may already have navigated, which is exactly what this
step must not do.

## Decision 2: one navigation landmark, the journey first, the rest in two named groups

The `nav` "Application view" keeps every view as a button with `aria-current="page"` on the shown one, so existing
labels and selectors stay. Inside it:

- a group "Your days and weeks" with **Today**, **Weekly review**, **Trends**, larger and first;
- a group **Records**: Check-in (with movement), Meal log, Activity;
- a group **Runs**: Runner, Coach, Archive.

Groups are `role="group"` named by their visible label. The navigation takes its own row under the brand; at 520 px
and below each group gets a row and its buttons share it (at least 40 px high), so 375 px needs no horizontal scrolling.
DOM order is the visual order, so Tab follows it. No onboarding wizard, persisted preference or router.

## Decision 3: the Weekly review is a view composed of the existing panel

`WeeklyReviewScreen` renders the existing `WeeklyReviewPanel` (its controller, its reads, its words) with the heading at
level 1 and one action slot under the week picker. Nothing is computed in the view. It is mounted only while shown and
keyed by session, person and organization, like Today and Trends, so every opening reads the week again and a disposed
screen aborts its read. One reader for the visible destination. The optional AI insight stays in the Check-in tab, off
by default, and is not shown or generated here. The Check-in tab keeps its review section, unchanged, beside its editors.

## Decision 4: the date and context policy

All of it is calendar arithmetic over local dates in `journey-navigation.ts`, with the existing validation
(`checkInDateProblem`, `mondayOf`, `addLocalDays`); no time zone is applied, so day attribution, coverage and
null-versus-zero rules are untouched.

| Movement | Week or date used |
|---|---|
| Today → Weekly review (Today's new **Weekly review** action) | the Monday-to-Sunday week containing the date Today shows; it becomes the kept week |
| Ask my data answer → Weekly review | the answer's week (offered even when older than the eight recent weeks); kept |
| Direct opening (navigation button) | the kept week for the current scope if it is still a valid Monday not after today; otherwise the existing default, the current week. A default is never written into the kept state |
| Weekly review → Trends (**28-day trends ending …**) | the week's Sunday when the week is complete (Sunday before today); today while the week is in progress. Never a future date. The label names the date |
| Trends → Meal log → Back to Trends | unchanged (ADR-0096): the range end and nutrition series, read again |
| Trends row → Today, Today → editors and history | unchanged (ADR-0082/0088): date, zone and source carried |
| Ordinary navigation | keeps Today's date, the review's week, the Trends range, series and Activity choice |

Kept selections and intents are App memory only, each tagged with its scope (session generation, person, organization)
and read through `inScope`, so another scope never sees them; sign-out clears all of them. Returning to the same scope in
the same session finds that scope's own selections again, as for Today's date since ADR-0082. Late answers cannot cross
a change: every screen is keyed by the scope and its controllers abort and ignore their reads on disposal.

## Decision 5: a compact Runner status away from Runner

`runAttention` (`run-attention.ts`) derives one status from state App already has (run, authority, upload queue, capture
state, writer, storage) and `RunStatusNotice` shows it above any view but Runner, with **Go to Runner**. No request, no
polling, no endpoint. Kinds:

- **Recording**: only while the capture controller reports an active watch (`capturing`) for a run the server lets record;
- **Paused**;
- **Synchronizing**: a lifecycle request in flight, or points still waiting to upload (with the count);
- **Needs attention**: a failed request, a refused run, rejected points, another tab or a lost lease, failed storage, an
  unconfirmed run, or a recording run whose capture is not running (starting, complete, failed). It says that nothing
  is being recorded.

The headline is in a polite `role="status"` and does not change with each point; counts are in a detail line outside it.

## Consequences

- Visitors land on Today and can follow the journey from the primary navigation; Runner is one click away and its
  state is visible from every view while it matters.
- Tests that read Runner's cards after a reload now show the Runner view first (`RunnerPage.showView()`); the lifecycle
  assertions are unchanged.
- The weekly review appears in two places (its view and the Check-in tab); both use the same component and controller.
- Not done here: lazy loading (release step 4), deep links or URL state, a persisted preference.
