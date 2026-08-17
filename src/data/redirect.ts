/** Where to send someone after they sign in.
 *
 *  `next` arrives in a query string, so it is attacker-controlled. The proxy is
 *  what normally puts it there, but nothing stops someone mailing a link with it
 *  set to whatever they like, and `/login` is the one page deliberately outside
 *  the gate — it opens for anyone.
 *
 *  Resolving against the real origin and comparing origins is the only check
 *  that holds. Prefix tests do not: `//evil.com` is the obvious one, but the URL
 *  standard treats a backslash as a slash in the authority position, so
 *  `/\evil.com` starts with `/`, does not start with `//`, and still resolves to
 *  `https://evil.com/`. Tab and newline are stripped before parsing too, which
 *  gives `/\tevil.com` and friends. Enumerating those is a losing game; asking
 *  the parser is not.
 *
 *  Why it matters more here than in most apps: the seconds after a genuine code
 *  has been mailed and accepted are exactly when a copy of this screen is
 *  believed, because the user has just proved to themselves that the site is
 *  real. */
export function safeDestination(raw: string | null | undefined, origin: string): string {
  if (!raw) return '/';
  try {
    const url = new URL(raw, origin);
    /* Not `startsWith` — `https://evil.com@app.example.com` and friends parse to
       an origin that is not ours, and the string comparison catches every one. */
    if (url.origin !== new URL(origin).origin) return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    /* An unparseable `next` is a broken link or a probe. Neither is a reason to
       refuse the sign-in that just succeeded. */
    return '/';
  }
}
