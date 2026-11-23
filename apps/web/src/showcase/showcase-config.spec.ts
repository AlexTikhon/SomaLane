import { describe, expect, it } from 'vitest';

import { compiledApplicationUrl, ShowcaseConfigError, showcaseApplicationUrl } from './showcase-config.js';

describe('the invite-only application address of a showcase build', () => {
  it('is not configured when unset or empty: there is no default address', () => {
    expect(showcaseApplicationUrl(undefined)).toBeNull();
    expect(showcaseApplicationUrl('')).toBeNull();
    expect(showcaseApplicationUrl('   ')).toBeNull();
  });

  it('accepts an absolute https address, and http only for a loopback host', () => {
    expect(showcaseApplicationUrl('https://app.example.org')).toBe('https://app.example.org/');
    expect(showcaseApplicationUrl(' https://app.example.org/sign-in?from=showcase ')).toBe('https://app.example.org/sign-in?from=showcase');
    expect(showcaseApplicationUrl('http://127.0.0.1:5999/')).toBe('http://127.0.0.1:5999/');
    expect(showcaseApplicationUrl('http://localhost:5999')).toBe('http://localhost:5999/');
    expect(showcaseApplicationUrl('http://[::1]:5999/')).toBe('http://[::1]:5999/');
  });

  it.each([
    ['a relative path', '/app'],
    ['plain http to a public host', 'http://app.example.org/'],
    ['another scheme', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,hi'],
    ['credentials', 'https://user:secret@app.example.org/'],
    ['a fragment', 'https://app.example.org/#x'],
    ['no host', 'https://'],
  ])('refuses %s, so the build fails', (_name, value) => {
    expect(() => showcaseApplicationUrl(value)).toThrow(ShowcaseConfigError);
  });

  it('re-validates the compiled value and treats anything wrong as not configured', () => {
    expect(compiledApplicationUrl('https://app.example.org/')).toBe('https://app.example.org/');
    expect(compiledApplicationUrl(null)).toBeNull();
    expect(compiledApplicationUrl(42)).toBeNull();
    expect(compiledApplicationUrl('http://app.example.org/')).toBeNull();
  });
});
