// The secondary views, loaded on demand as ONE chunk (release step 4, ADR-0098). Import this module only through
// `secondaryViews` in DeferredView.tsx (a dynamic import); a static import from App or any module it loads at start
// would put every view below back into the first page's bundle.
//
// One chunk rather than one per view: the views share code that is not part of the first page (the run details used by
// Archive, Activity and Runner's result, the map helpers, the check-in controller). Per-view chunks would put that code
// in shared deferred chunks, and Chromium keeps a failed chunk failed for the life of the page, so a retry could never
// succeed after a shared chunk failed. With one chunk whose static imports are all initial, a retry can (deferred-module.ts).

export { ActivityScreen } from './ActivityScreen.js';
export { ArchiveScreen } from './ArchiveScreen.js';
export { CoachScreen } from './CoachScreen.js';
export { DailyCheckInScreen } from './DailyCheckInScreen.js';
export { MealLogScreen } from './MealLogScreen.js';
export { RunDetailScreen } from './RunDetailScreen.js';
