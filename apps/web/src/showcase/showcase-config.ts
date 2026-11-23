// The one build setting of the public read-only showcase (ADR-0099, docs/runbooks/showcase.md): the address of the
// invite-only application, shown as a link on every view. It is read from SHOWCASE_APP_URL by vite.showcase.config.ts at
// build time, validated here, and compiled into the page; the page validates it again before rendering a link. No
// default address exists: without the setting the page says that the link is not configured.

export class ShowcaseConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ShowcaseConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The validated application address, or null when none is configured (unset or empty). Accepted: an absolute `https:`
 * URL, or `http:` for a loopback host only (local previews and browser tests); without user name, password or fragment.
 * Anything else throws, so a build with a malformed or insecure address fails instead of publishing it.
 */
export function showcaseApplicationUrl(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ShowcaseConfigError('SHOWCASE_APP_URL must be an absolute URL, such as https://app.example.org/');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new ShowcaseConfigError('SHOWCASE_APP_URL must use https: (http: is accepted only for 127.0.0.1, localhost or [::1])');
  }
  if (url.username !== '' || url.password !== '') throw new ShowcaseConfigError('SHOWCASE_APP_URL must not contain a user name or password');
  if (url.hash !== '') throw new ShowcaseConfigError('SHOWCASE_APP_URL must not contain a fragment');
  return url.href;
}

/** The address compiled into a page, re-validated; a value that fails is treated as not configured. */
export function compiledApplicationUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return showcaseApplicationUrl(value);
  } catch {
    return null;
  }
}
