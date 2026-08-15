import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verify } from './src/server/session';

/* The gate. Node runtime only in Next 16 — so `node:crypto` works here directly
   and there is deliberately no `runtime` export, which would throw. */

export async function proxy(request: NextRequest) {
  if (verify(request.cookies.get('session')?.value)) return NextResponse.next();

  /* Proxy still runs on `/_next/data/*` even though the matcher excludes
     `_next` — intentional on Next's part, so protecting a page cannot leave its
     data route open. That means this branch sees paths the matcher never
     enumerated: answer anything machine-shaped with JSON, and only send an HTML
     redirect to something that could actually render one. */
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/api/') || pathname.startsWith('/_next/')) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

/* Matcher values have to be static literals — Next reads them at build time and
   silently ignores anything computed. */
export const config = {
  matcher: ['/((?!api/login$|login$|_next/static|_next/image|favicon\\.ico$).*)'],
};
