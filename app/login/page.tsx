import { redirect } from 'next/navigation';
import { MISCONFIGURED_MESSAGE, mode } from '@data/config';
import { LoginForm } from './LoginForm';

/** The sign-in screen — a Server Component whose only job is to decide whether
 *  there is anything to sign in to.
 *
 *  That decision has to be made here rather than in the browser, and it is the
 *  whole reason this file exists. `NEXT_PUBLIC_` variables are inlined into the
 *  client bundle at build time while the server reads them fresh per request, so
 *  the two halves can disagree — and when they did, the browser saw "no Supabase,
 *  go to /", the proxy saw "Supabase, go to /login", and the tab ping-ponged
 *  between them until someone closed it. The server's answer is the one that
 *  matches the gate, so the server gives it.
 *
 *  `/login` is also the one path the proxy matcher excludes, so it is the only
 *  page that can be reached in the misconfigured state — which makes it the
 *  right place to say what is wrong. */

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  const m = mode();

  /* No credentials and no gate: there are no accounts, so there is nothing this
     page can do. Anyone who typed the URL just wanted the editor. */
  if (m === 'local') redirect('/');

  if (m === 'misconfigured') {
    return (
      <div className="ov open">
        <div className="modal" style={{ maxWidth: 420 }}>
          <div className="m-h">
            <div style={{ flex: 1 }}>
              <h2>Not configured</h2>
              <p>{MISCONFIGURED_MESSAGE}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <LoginForm />;
}
