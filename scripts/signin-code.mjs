#!/usr/bin/env node
/** Mints a real sign-in code without sending an email.
 *
 *    node scripts/signin-code.mjs you@example.com
 *
 *  The code this prints is the same one `signInWithOtp` would have mailed, and
 *  the login form verifies it the same way — `generateLink` produces the token
 *  and deliberately does not send it. So this is a way past the *mailer*, never
 *  past the authentication: the code still expires, still belongs to one
 *  address, and is still exchanged by the real `verifyOtp`.
 *
 *  Why it exists: Supabase's built-in sender does two messages an hour, refuses
 *  every address outside the project's own organisation, and locks the email
 *  template so the code cannot be put in the mail at all. Until SMTP is
 *  configured — docs/SUPABASE.md step 5 — that is the front door, and this is
 *  how you get in while fixing it.
 *
 *  It needs `SUPABASE_PRIVATE_KEY`, which is the project's secret key. Anyone
 *  holding that key already has unrestricted access to the database, so this
 *  hands out nothing they did not have; it is a developer tool for whoever owns
 *  the project, and the key must never reach a browser or a build.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const file of ['.env', '.env.local']) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const pick = (...names) => names.map(n => process.env[n]).find(v => v && v.trim())?.trim();
const URL_ = pick('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL');
const SECRET = pick('SUPABASE_PRIVATE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');

const email = process.argv[2]?.trim();

if (!email || !URL_ || !SECRET) {
  console.error(
    'Usage: node scripts/signin-code.mjs you@example.com\n'
    + (!URL_ ? '\nMissing NEXT_PUBLIC_SUPABASE_URL.' : '')
    + (!SECRET ? '\nMissing SUPABASE_PRIVATE_KEY.' : ''),
  );
  process.exit(2);
}

const admin = createClient(URL_, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });

/** `magiclink` is for an address that already has an account and `signup` is for
 *  one that does not — asking for the wrong one is an error rather than a
 *  fallback, so try the existing-user case first and create on the way past. */
async function mint() {
  const existing = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (!existing.error) return { otp: existing.data.properties?.email_otp, created: false };

  const made = await admin.auth.admin.generateLink({ type: 'signup', email, password: crypto.randomUUID() });
  if (made.error) throw new Error(made.error.message);
  return { otp: made.data.properties?.email_otp, created: true };
}

try {
  const { otp, created } = await mint();
  if (!otp) throw new Error('Supabase returned no email_otp for that address.');
  console.log(`\n  ${email}${created ? '   (new account)' : ''}`);
  console.log(`\n  \x1b[1m${otp}\x1b[0m\n`);
  console.log('  Type it into the code field. It expires in an hour and works once.\n');
} catch (e) {
  console.error(`\nCould not mint a code for ${email}: ${e.message}\n`);
  process.exit(1);
}
