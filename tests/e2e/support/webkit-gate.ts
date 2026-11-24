// The bounded WebKit gate (release step 6, ADR-0100): `npm run test:e2e:webkit`. One place for its two emulation
// settings, used by the three configurations it runs in (playwright.config.ts for the development servers,
// playwright.production-build.config.ts for the application's production build, playwright.showcase.config.ts for the
// showcase's static build). Each WebKit project writes to its own directory under webkit-results/, so a WebKit run never
// removes or mixes with the Chromium and Firefox results in test-results/.
//
// This is Playwright's WebKit build (the one @playwright/test pins), driven on the workstation or a Linux CI runner. It
// is WebKit automation: not Safari, not iOS, not a phone. The phone-sized setting below changes the viewport, the device
// pixel ratio, meta-viewport handling and touch support only; the user agent stays Playwright WebKit's own default
// string, which reads as desktop Safari on macOS even on Windows and Linux (no iPhone user agent is set, and that string
// is not evidence of Safari), and there is no real GPS, keyboard, network or sleep behaviour of a phone.

/** Desktop: Playwright's default desktop viewport, stated explicitly. */
export const webkitDesktop = {
  browserName: 'webkit',
  viewport: { height: 720, width: 1280 },
} as const;

/** Phone-sized: the CSS viewport of a 6.1-inch phone, with mobile meta-viewport handling and touch enabled. */
export const webkitPhone = {
  browserName: 'webkit',
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
  viewport: { height: 844, width: 390 },
} as const;

export const webkitResults = (name: string): string => `webkit-results/${name}`;
