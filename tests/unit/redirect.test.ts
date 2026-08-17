import { describe, expect, it } from 'vitest';
import { safeDestination } from '@data/redirect';

/** The `?next=` parameter on the sign-in screen. `/login` is the one page the
 *  proxy matcher deliberately excludes, so it opens for anyone and this value is
 *  attacker-controlled — a mailed link can set it to anything.
 *
 *  These are regression tests. The first implementation guarded with
 *  `next.startsWith('/') && !next.startsWith('//')`, which every case in
 *  "off-origin destinations are refused" walks straight past. */

const ORIGIN = 'https://plan.example.com';
const go = (next: string | null | undefined) => safeDestination(next, ORIGIN);

describe('off-origin destinations are refused', () => {
  /* Each of these resolves off-origin in a real browser. The backslash forms are
     the ones that matter: the URL standard normalises `\` to `/` in the
     authority position, so they pass any prefix test written against `//`. */
  it.each([
    ['a bare protocol-relative URL', '//evil.com'],
    ['a backslash authority', '/\\evil.com'],
    ['a mixed slash-backslash authority', '/\\/evil.com'],
    ['a double backslash authority', '/\\\\evil.com'],
    ['a backslash after a slash', '\\\\evil.com'],
    ['an absolute https URL', 'https://evil.com/steal'],
    ['an absolute http URL', 'http://evil.com'],
    ['a userinfo trick that looks like our host', 'https://plan.example.com@evil.com/'],
    ['a tab inside the authority', '/\t/evil.com'],
    ['a newline inside the authority', '/\n/evil.com'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
  ])('%s falls back to the editor', (_label, next) => {
    expect(go(next)).toBe('/');
  });

  it('refuses a different host on the same scheme', () => {
    expect(go('https://plan.example.com.evil.com/')).toBe('/');
  });

  it('refuses a different port on the same host', () => {
    expect(go('https://plan.example.com:8443/')).toBe('/');
  });
});

describe('same-origin destinations are kept', () => {
  it('keeps a plain path', () => {
    expect(go('/plan/42')).toBe('/plan/42');
  });

  it('keeps the query, which is where the deep links live', () => {
    expect(go('/?import=https%3A%2F%2Ffunda.nl%2Fkoop%2F1')).toBe('/?import=https%3A%2F%2Ffunda.nl%2Fkoop%2F1');
  });

  it('keeps a fragment', () => {
    expect(go('/#garden')).toBe('/#garden');
  });

  it('accepts an absolute URL that really is ours, and strips the origin', () => {
    expect(go('https://plan.example.com/plan/7?x=1')).toBe('/plan/7?x=1');
  });
});

describe('nothing to go on', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
  ])('%s means the editor', (_label, next) => {
    expect(go(next)).toBe('/');
  });

  /* An unparseable value is a broken link or a probe. Neither is a reason to
     refuse a sign-in that has already succeeded. */
  it('does not throw on a value the URL parser rejects', () => {
    expect(() => go('http://[::1')).not.toThrow();
    expect(go('http://[::1')).toBe('/');
  });
});
