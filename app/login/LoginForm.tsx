'use client';

import { useEffect, useRef, useState } from 'react';
import { safeDestination } from '@data/redirect';
import { client } from '@data/supabase';

/** Sign-in, in two steps: an address, then the six-digit code mailed to it.
 *
 *  There is no password anywhere in the system, so there is nothing to leak,
 *  reset or rotate. What there is instead is a dependency on Supabase's Magic
 *  Link email template having been switched to `{{ .Token }}` — otherwise the
 *  same call mails a link and the code field waits for something that never
 *  arrives. That is a dashboard setting, invisible from here; see
 *  docs/SUPABASE.md.
 *
 *  app/layout.tsx renders {children} bare, so this brings its own centring —
 *  `.ov` is already a fixed, centred grid. */

type Step = 'email' | 'code';

/** Supabase's own wording is written for a developer reading a stack trace, not
 *  for someone waiting on an email.
 *
 *  Switched on `error.code`, which is a stable identifier, rather than on the
 *  prose — sniffing the message for "invalid" turned *Email address "x" is
 *  invalid* into "that code is wrong", which is a sentence about the wrong field
 *  entirely and sends the reader looking through their inbox for a code that was
 *  never sent. The step is passed in for the same reason: the same failure means
 *  different things depending on which half of the form is on screen.
 *
 *  Anything unrecognised is passed through verbatim. A vague house style is
 *  worse than a specific sentence from upstream. */
function phrase(step: Step, code: string | undefined, message: string): string {
  switch (code) {
    case 'email_address_invalid':
      return 'That address was refused. Check it for a typo — some throwaway and example domains are rejected outright.';
    case 'email_address_not_authorized':
      return 'The mail server refused to send to that address. It will only deliver to a domain it has been set up to send from.';
    /* The mail server rejected the message and Supabase reports the whole class
       as one opaque code — "Error sending confirmation email", with the real
       reason only in the project's auth log. It is nearly always a sending
       domain that has not been verified with the provider, which refuses every
       recipient except the account holder's own address. Worth naming, because
       from the outside it is indistinguishable from the app being broken and
       nobody would think to go and read an SMTP log. */
    case 'unexpected_failure':
      return step === 'email'
        ? 'The code could not be sent — the mail server rejected it. This is a setup problem on our side, not something you did: the sending domain most likely still needs verifying with the mail provider.'
        : message;
    case 'over_email_send_rate_limit':
      return 'Too many codes have been sent from this deployment in the last hour. Wait, and if this keeps happening the mail server needs its own SMTP credentials.';
    case 'over_request_rate_limit':
      return 'Too many attempts from here. Wait a few minutes and try again.';
    case 'otp_expired':
      return 'That code has expired. Send a new one.';
    case 'otp_disabled':
      return 'Email sign-in is switched off for this project.';
    case 'signup_disabled':
      return 'This address has no account, and new sign-ups are switched off.';
    case 'validation_failed':
      return step === 'email'
        ? 'That does not look like an email address.'
        : 'That code does not look right — it is six digits.';
    default:
      break;
  }

  /* No code, so fall back to the prose. `signInWithOtp` answers its own
     per-address cooldown this way and the number in it is the only thing that
     tells someone how long to wait. */
  const m = message.toLowerCase();
  const secs = /after (\d+) seconds?/.exec(m)?.[1];
  if (secs) return `A code was just sent. You can ask for another in ${secs} seconds.`;
  if (step === 'code' && (m.includes('expired') || m.includes('invalid') || m.includes('token'))) {
    return 'That code is wrong or has expired. Check the latest email, or send a new code.';
  }
  return message;
}

export function LoginForm() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const db = client();

  /* autoFocus on a field that is only rendered after a state change does not
     fire, and the code is the one thing the user is about to type. */
  useEffect(() => { if (step === 'code') codeRef.current?.focus(); }, [step]);

  /* The server decided this deployment has Supabase and rendered this form, yet
     the browser bundle has no credentials in it. That is not a runtime fault: a
     NEXT_PUBLIC_ variable is inlined at build time, so this is a build made
     without the variables and then deployed with them. Say so, rather than
     bouncing to `/` — which the proxy would bounce straight back here, forever. */
  if (!db) {
    return (
      <div className="ov open">
        <div className="modal" style={{ maxWidth: 420 }}>
          <div className="m-h">
            <div style={{ flex: 1 }}>
              <h2>Not signed in, and cannot sign in</h2>
              <p>
                This server has Supabase credentials but the browser bundle was compiled without
                them. <code>NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
                <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> have to be set at{' '}
                <em>build</em> time, not only at run time. Rebuild with them present.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const sendCode = async () => {
    const address = email.trim();
    if (!address) return;
    setBusy(true); setError(''); setNote('');
    const { error: err } = await db.auth.signInWithOtp({ email: address });
    setBusy(false);
    if (err) { setError(phrase('email', err.code, err.message)); return; }
    setStep('code');
    setNote(`We sent a six-digit code to ${address}.`);
  };

  const verify = async () => {
    const token = code.trim();
    if (!token) return;
    setBusy(true); setError('');
    const { error: err } = await db.auth.verifyOtp({ email: email.trim(), token, type: 'email' });
    if (err) { setBusy(false); setError(phrase('code', err.code, err.message)); return; }

    /* A full load, not router.push — the gate lives in proxy.ts, and only a
       fresh request carries the cookies that were just written past it. `busy`
       is deliberately left true: the navigation is the end of this page's life,
       and re-enabling the button would only invite a second submit. */
    const next = new URLSearchParams(window.location.search).get('next');
    window.location.href = safeDestination(next, window.location.origin);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    void (step === 'email' ? sendCode() : verify());
  };

  const restart = () => {
    setStep('email'); setCode(''); setError(''); setNote('');
  };

  return (
    <div className="ov open">
      <form className="modal" style={{ maxWidth: 380 }} onSubmit={submit}>
        <div className="m-h">
          <div style={{ flex: 1 }}>
            <h2>Plattegrond <span style={{ color: 'var(--vermilion)' }}>Studio</span></h2>
            <p>
              {step === 'email'
                ? 'Sign in with your email. We send a code — there is no password.'
                : 'Enter the six-digit code from the email.'}
            </p>
          </div>
        </div>

        <div className="m-b">
          {step === 'email' ? (
            <>
              <label className="lbl" htmlFor="email" style={{ display: 'block', marginBottom: 7 }}>Email</label>
              <div className="urlbar">
                <input
                  id="email" type="email" autoFocus autoComplete="email"
                  spellCheck={false} placeholder="you@example.com"
                  value={email} onChange={ev => setEmail(ev.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <label className="lbl" htmlFor="code" style={{ display: 'block', marginBottom: 7 }}>Code</label>
              <div className="urlbar">
                <input
                  ref={codeRef}
                  id="code" type="text" inputMode="numeric" autoComplete="one-time-code"
                  spellCheck={false} placeholder="123456" maxLength={10}
                  value={code} onChange={ev => setCode(ev.target.value)}
                />
              </div>
            </>
          )}

          {note && !error && (
            <div className="step ok" id="loginNote" style={{ marginTop: 12 }}>
              <span className="tx">{note}</span>
            </div>
          )}
          {error && (
            <div className="step err" id="loginErr" style={{ marginTop: 12 }}>
              <span className="tx">{error}</span>
            </div>
          )}
        </div>

        <div className="m-f">
          {step === 'code'
            ? (
              <button className="btn" id="loginBack" type="button" onClick={restart} disabled={busy}>
                Use another address
              </button>
            )
            : <span className="hint">The code is valid for one hour.</span>}
          <div className="spring" />
          <button
            className="btn pri" id="loginGo" type="submit"
            disabled={busy || (step === 'email' ? !email.trim() : !code.trim())}
          >
            {busy ? 'Working…' : step === 'email' ? 'Send code' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
