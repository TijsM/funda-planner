'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        /* a full load, not router.push — the gate lives in proxy.ts, and only a
           fresh request carries the cookie it just set past it */
        window.location.href = '/';
        return;
      }
      const body = (await r.json().catch(() => null)) as { message?: string } | null;
      setError(
        body?.message
          ?? (r.status >= 500
            ? 'The server is not set up for logins yet.'
            : 'That password does not match.'),
      );
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  /* app/layout.tsx renders {children} bare, so this page brings its own centring
     — .ov is already a fixed, centred grid */
  return (
    <div className="ov open">
      <form className="modal" style={{ maxWidth: 380 }} onSubmit={submit}>
        <div className="m-h">
          <div style={{ flex: 1 }}>
            <h2>Plattegrond <span style={{ color: 'var(--vermilion)' }}>Studio</span></h2>
            <p>This studio is private. Enter the password to continue.</p>
          </div>
        </div>

        <div className="m-b">
          <label className="lbl" htmlFor="pw" style={{ display: 'block', marginBottom: 7 }}>Password</label>
          <div className="urlbar">
            <input
              id="pw" type="password" autoFocus autoComplete="current-password"
              spellCheck={false} placeholder="••••••••••"
              value={password} onChange={ev => setPassword(ev.target.value)}
            />
          </div>
          {error && (
            <div className="step err" id="loginErr" style={{ marginTop: 12 }}>
              <span className="tx">{error}</span>
            </div>
          )}
        </div>

        <div className="m-f">
          <span className="hint">Access is remembered on this browser for 30 days.</span>
          <div className="spring" />
          <button className="btn pri" id="loginGo" type="submit" disabled={busy || !password}>
            {busy ? 'Checking…' : 'Enter'}
          </button>
        </div>
      </form>
    </div>
  );
}
