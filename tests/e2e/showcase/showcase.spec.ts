import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test as base, type Locator, type Page } from '@playwright/test';

import { showcaseBuild } from '../support/showcase.js';

// The public read-only showcase (release step 5, ADR-0099) in its static production build, served with NO API server.
// Every test runs behind a request guard that aborts and records any request to /api (auth and health included) or to
// another origin, and fails the test if there was one. The page is also instrumented to record every attempt to write
// browser storage (Web Storage, IndexedDB, cookies, Cache Storage, a service worker).

const LABEL = 'Read-only showcase · synthetic data';

interface Guard {
  forbidden: string[];
  requests: string[];
}

const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ context, page }, use) => {
      const guard: Guard = { forbidden: [], requests: [] };
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== showcaseBuild.webOrigin || url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          guard.forbidden.push(`${route.request().method()} ${url.href}`);
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
      page.on('request', (request) => guard.requests.push(request.url()));
      await page.addInitScript(() => {
        const writes: string[] = [];
        (window as unknown as { __storageWrites: string[] }).__storageWrites = writes;
        /** Replaces a prototype method with one that records the call, then calls the original with the same `this`. */
        const record = (target: object, name: string, describe: (args: unknown[]) => string) => {
          const descriptor = Object.getOwnPropertyDescriptor(target, name);
          const original = descriptor?.value as ((...args: unknown[]) => unknown) | undefined;
          if (descriptor === undefined || original === undefined) return;
          Object.defineProperty(target, name, {
            ...descriptor,
            value(this: unknown, ...args: unknown[]) {
              writes.push(describe(args));
              return Reflect.apply(original, this, args);
            },
          });
        };
        for (const name of ['setItem', 'removeItem', 'clear']) record(Storage.prototype, name, () => `storage.${name}`);
        record(IDBFactory.prototype, 'open', (args) => `indexedDB.open ${String(args[0])}`);
        if ('caches' in window) record(CacheStorage.prototype, 'open', (args) => `caches.open ${String(args[0])}`);
        if ('serviceWorker' in navigator) record(ServiceWorkerContainer.prototype, 'register', () => 'serviceWorker.register');
        const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
        if (cookie?.get !== undefined && cookie.set !== undefined) {
          // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound to the document with Reflect.apply below
          const { get, set } = cookie;
          Object.defineProperty(Document.prototype, 'cookie', {
            configurable: true,
            get(this: Document): unknown {
              return Reflect.apply(get, this, []);
            },
            set(this: Document, value: string) {
              writes.push('document.cookie');
              Reflect.apply(set, this, [value]);
            },
          });
        }
      });
      await use(guard);
      expect(guard.forbidden, 'requests to /api or another origin').toEqual([]);
      expect(guard.requests.filter((url) => new URL(url).pathname.startsWith('/api'))).toEqual([]);
    },
    { auto: true },
  ],
});

/** What the page tried to write to browser storage, and what is stored now. */
async function storageState(page: Page) {
  return page.evaluate(async () => ({
    cookie: document.cookie,
    databases: (await indexedDB.databases()).map((database) => database.name),
    local: localStorage.length,
    serviceWorkers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
    session: sessionStorage.length,
    writes: (window as unknown as { __storageWrites: string[] }).__storageWrites,
  }));
}

const NO_STORAGE = { cookie: '', databases: [], local: 0, serviceWorkers: 0, session: 0, writes: [] };

/** Words of controls that would change data, sign in or generate output. */
const FORBIDDEN_CONTROL = /\b(edit|delete|add|save|import|upload|record|start|finish|pause|resume|simulat\w*|sign in|sign out|log in|demo runner|demo coach|draft|generate|ask|share|refresh|retry)\b/iu;

async function expectReadOnlyView(page: Page) {
  await expect(page.getByText(LABEL, { exact: true })).toBeVisible();
  await expect(page.locator('a[data-app-link="configured"]')).toHaveAttribute('href', showcaseBuild.appUrl);
  const controls = await page.locator('main button, main a, main input:not([type="radio"]), main textarea, main [contenteditable="true"], form').evaluateAll((nodes) =>
    nodes.map((node) => `${node.tagName.toLowerCase()}:${(node.textContent ?? '').trim()}|${node.getAttribute('aria-label') ?? ''}|${node.getAttribute('type') ?? ''}`),
  );
  expect(controls.filter((control) => FORBIDDEN_CONTROL.test(control) || /^(?:input|textarea|form)/u.test(control))).toEqual([]);
  await expect(page.getByRole('button', { name: /Demo (runner|coach)/u })).toHaveCount(0);
}

/** A select by the text of the label that wraps it (its accessible name also contains the selected option). */
function select(page: Page, label: 'Date' | 'End date' | 'Week'): Locator {
  return page.locator('main label').filter({ hasText: new RegExp(`^${label}`, 'u') }).locator('select');
}

function rowOf(page: Page, date: string): Locator {
  return page.locator(`.trends-table tr[data-date="${date}"]`);
}

test.describe('the public read-only showcase, static production build, no API server', () => {
  test('follows the journey Today → Weekly review → Trends → the original day or its meals, and back @cross-browser', async ({ page }) => {
    await page.goto('/');
    // Today on the sample date, the snapshot's anchor (the browser runs in Auckland on today's clock: neither matters).
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await expect(page.locator('.today-day')).toHaveText('Showing Sat, 21 Nov 2026 (sample date) in the time zone Europe/Warsaw.');
    await expect(page.locator('.showcase-banner__data')).toContainText('Sun, 27 Sept 2026 to Sat, 21 Nov 2026 in Europe/Warsaw; sample date Sat, 21 Nov 2026');
    await expect(page.getByLabel('Check-in values')).toContainText('70.73 kg');
    await expect(page.getByLabel('Movement values')).toContainText('8,424');
    await expectReadOnlyView(page);

    // The completed week of the primary journey: Today on Sunday 15 Nov → its week → Trends ending on that Sunday.
    await select(page, 'Date').selectOption('2026-11-15');
    await page.getByRole('button', { name: /^Weekly review of / }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Weekly review' })).toBeFocused();
    await expect(select(page, 'Week')).toHaveValue('2026-11-09');
    await expect(page.getByLabel('What your records show')).toBeVisible();
    await expect(page.getByText('The range ends on this week’s Sunday.')).toBeVisible();
    await expectReadOnlyView(page);
    await page.getByRole('button', { name: 'Open 28-day trends ending on Sun, 15 Nov 2026' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Trends' })).toBeFocused();
    await expect(page.locator('.today-day').first()).toContainText('Range: 28 days, Mon, 19 Oct 2026 to Sun, 15 Nov 2026');
    await page.getByRole('radio', { name: 'Food energy' }).check();
    // A date without any meal entry is unknown, not zero.
    await expect(rowOf(page, '2026-10-29')).toHaveClass(/trends-table__missing/u);
    await expect(rowOf(page, '2026-10-29').locator('.trends-table__value')).toHaveText('Not recorded');
    await expectReadOnlyView(page);

    // A row opens that date's meals, read-only, and Back to Trends returns to the same range and series.
    await page.getByRole('button', { name: 'Open the logged meals of Sat, 14 Nov 2026' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Logged meals' })).toBeFocused();
    await expect(page.getByRole('list', { name: 'Entries for Sat, 14 Nov 2026' }).getByRole('listitem')).toHaveCount(2);
    await expect(page.getByLabel('Values of lunch "Canteen salad"')).toContainText('Not recorded');
    await expectReadOnlyView(page);
    await page.getByRole('button', { name: 'Back to Trends ending Sun, 15 Nov 2026, Food energy' }).click();
    await expect(select(page, 'End date')).toHaveValue('2026-11-15');
    await expect(page.getByRole('radio', { name: 'Food energy' })).toBeChecked();

    // A row opens the original day; ordinary navigation back to Trends also keeps the range and series.
    await page.getByRole('button', { name: 'Open Today on Thu, 29 Oct 2026' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeFocused();
    await expect(page.locator('.today-day')).toHaveText('Showing Thu, 29 Oct 2026 in the time zone Europe/Warsaw.');
    await expect(page.locator('[aria-labelledby="today-meals-title"] .today-missing')).toHaveText('No meal or snack logged for this day.');
    await page.getByRole('navigation', { name: 'Showcase view' }).getByRole('button', { name: 'Trends' }).click();
    await expect(select(page, 'End date')).toHaveValue('2026-11-15');
    await expect(page.getByRole('radio', { name: 'Food energy' })).toBeChecked();

    // Partial coverage: carbohydrate recorded on 1 of the 2 entries of 14 Nov.
    await page.getByRole('radio', { name: 'Carbohydrate' }).check();
    await expect(rowOf(page, '2026-11-14')).toHaveAttribute('data-coverage', 'partial');

    // The other offered range: the anchor's week, which ends on the snapshot's last date; the comparison the service computed.
    await select(page, 'End date').selectOption('2026-11-21');
    await expect(page.locator('.today-day').first()).toContainText('Range: 28 days, Sun, 25 Oct 2026 to Sat, 21 Nov 2026');
    await expect(page.locator('[data-comparison-measure="count"] [data-change-status]')).toHaveText('+1 (+12.5%)');
    await expect(page.locator('[data-comparison-measure="distance"] [data-change-status]')).toHaveText('+11.60 km (+18.8%)');
    // A recorded zero: the coffee of 21 Nov, from Today's meals.
    await page.getByRole('button', { name: 'Open Today on Sat, 21 Nov 2026' }).click();
    await page.getByRole('button', { name: 'Logged meals of Sat, 21 Nov 2026' }).click();
    await expect(page.getByLabel('Values of snack "Black coffee"')).toContainText('0 kcal');

    expect(await storageState(page)).toEqual(NO_STORAGE);
  });

  test('every view carries the label, its date or range, the application link and no mutation control', async ({ page }) => {
    await page.goto('/');
    const navigation = page.getByRole('navigation', { name: 'Showcase view' });
    for (const view of ['Today', 'Weekly review', 'Trends'] as const) {
      await navigation.getByRole('button', { name: view }).click();
      await expect(page.getByRole('heading', { level: 1, name: view })).toBeVisible();
      await expect(navigation.getByRole('button', { name: view })).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('.today-day').first()).toContainText(view === 'Trends' ? 'Range: 28 days, Sun, 25 Oct 2026 to Sat, 21 Nov 2026' : view === 'Today' ? 'Sat, 21 Nov 2026' : '16');
      await expectReadOnlyView(page);
    }
    // The Weekly review of the anchor's unfinished week ends its Trends range on the snapshot's last date.
    await navigation.getByRole('button', { name: 'Weekly review' }).click();
    await expect(page.getByText('This week continues after the snapshot’s last date, Sat, 21 Nov 2026, so the range ends on that date.')).toBeVisible();
    // An October week's range is not in the snapshot: said, never a dead control.
    await select(page, 'Week').selectOption('2026-10-19');
    await expect(page.getByText(/This week's 28-day trends would end on Sun, 25 Oct 2026/u)).toBeVisible();
    await expect(page.getByRole('button', { name: /Open 28-day trends/u })).toHaveCount(0);
    // An unlogged date.
    await navigation.getByRole('button', { name: 'Today' }).click();
    await select(page, 'Date').selectOption('2026-11-11');
    await expect(page.getByText('Nothing is recorded for Wed, 11 Nov 2026 yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Logged meals of Wed, 11 Nov 2026' }).click();
    await expect(page.getByText('Nothing is logged for Wed, 11 Nov 2026. That is unknown, not zero: no entry was made.')).toBeVisible();
    await expectReadOnlyView(page);
    await expect(page.getByText('Optional AI features are off by default and are not part of this showcase.')).toBeVisible();
    expect(await storageState(page)).toEqual(NO_STORAGE);
  });

  test('works with the keyboard and at 375 px, with the label always in view', async ({ page }) => {
    await page.setViewportSize({ height: 812, width: 375 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await fits();

    // Tab reaches the application link first, then the three views in order; Enter opens one and focuses its heading.
    await page.keyboard.press('Tab');
    await expect(page.locator('a[data-app-link="configured"]')).toBeFocused();
    const navigation = page.getByRole('navigation', { name: 'Showcase view' });
    for (const name of ['Today', 'Weekly review', 'Trends']) {
      await page.keyboard.press('Tab');
      await expect(navigation.getByRole('button', { name })).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Trends' })).toBeFocused();
    await fits();

    // A series by keyboard: Tab into the radio group, arrows move the choice.
    const radio = page.getByRole('radio', { name: 'Weight' });
    await radio.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Sleep' })).toBeChecked();
    // A row's Open by keyboard, and Back to Trends.
    await page.getByRole('button', { name: 'Open Today on Fri, 20 Nov 2026' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeFocused();
    await fits();
    await page.getByRole('button', { name: /^Back to Trends/u }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('radio', { name: 'Sleep' })).toBeChecked();
    await fits();

    // The label stays on screen when the page is scrolled to its end.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.getByText(LABEL, { exact: true })).toBeInViewport();
    await page.screenshot({ path: join(showcaseBuild.outDir, '..', 'showcase-375-scrolled.png') });
    for (const view of ['Today', 'Weekly review']) {
      await navigation.getByRole('button', { name: view }).click();
      await fits();
    }
    await page.getByRole('button', { name: /^Open 28-day trends ending on/u }).click();
    await fits();
    expect(await storageState(page)).toEqual(NO_STORAGE);
  });

  for (const [name, fulfil, message] of [
    ['A missing snapshot', { body: 'Not found', status: 404 }, 'The showcase data file is not available (HTTP 404). This build may be incomplete.'],
    ['A snapshot that is not JSON', { body: '{ "format": ', contentType: 'application/json', status: 200 }, 'The showcase data file is damaged: it is not valid JSON.'],
    ['A snapshot of another format', { body: JSON.stringify({ format: 'somalane-showcase-snapshot', version: 2 }), contentType: 'application/json', status: 200 }, 'The showcase data file does not match the format this page expects'],
  ] as const) {
    test(`${name} is reported on the page, with the label and link, and nothing else is asked`, async ({ page }) => {
      let snapshotRequests = 0;
      await page.route('**/showcase-snapshot.json', async (route) => {
        snapshotRequests += 1;
        await route.fulfill(fulfil);
      });
      await page.goto('/');
      await expect(page.getByRole('alert')).toContainText(message);
      await expect(page.getByRole('alert')).toContainText('it never asks the application for data');
      await expect(page.getByText(LABEL, { exact: true })).toBeVisible();
      await expect(page.locator('a[data-app-link="configured"]')).toHaveAttribute('href', showcaseBuild.appUrl);
      await expect(page.getByRole('navigation', { name: 'Showcase view' })).toHaveCount(0);
      // Try again asks for the same file again, and only for it.
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect.poll(() => snapshotRequests).toBe(2);
      await expect(page.getByRole('alert')).toContainText(message);
      expect(await storageState(page)).toEqual(NO_STORAGE);
    });
  }

  test('the request guard catches and fails an /api request, including auth and health @cross-browser', async ({ guard, page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    // Prove the instrument: requests made on purpose from the page are aborted and recorded.
    const outcomes = await page.evaluate(async () =>
      Promise.all(['/api/health/ready', '/api/session', '/api/auth/login'].map((path) => fetch(path).then(() => 'answered', () => 'failed'))),
    );
    expect(outcomes).toEqual(['failed', 'failed', 'failed']);
    expect(guard.forbidden.map((entry) => new URL(entry.split(' ')[1]!).pathname)).toEqual(['/api/health/ready', '/api/session', '/api/auth/login']);
    // Reset, so the guard's own end-of-test check covers only what the showcase itself did.
    guard.forbidden.length = 0;
    guard.requests.length = 0;
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    // The page asked for its own HTML, scripts, stylesheet and snapshot file only.
    const paths = guard.requests.map((url) => new URL(url).pathname);
    expect(paths.every((path) => path === '/' || path === '/showcase-snapshot.json' || /^\/assets\/[\w.-]+\.(?:js|css)$/u.test(path))).toBe(true);
    expect(paths).toContain('/showcase-snapshot.json');
  });

  test('the built files contain no API route, storage or sign-in code', () => {
    const assets = join(showcaseBuild.outDir, 'assets');
    const files = readdirSync(assets).filter((file) => /\.(?:js|css)$/u.test(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(assets, file), 'utf8');
      expect(text, file).not.toMatch(/\/api\/|localStorage|sessionStorage|indexedDB|serviceWorker|X-CSRF|Demo runner|Demo coach/u);
    }
    const html = readFileSync(join(showcaseBuild.outDir, 'index.html'), 'utf8');
    expect(html).toContain('<title>SomaLane · Read-only showcase · synthetic data</title>');
    expect(html).not.toMatch(/src="\/|href="\//u);
  });
});
