#!/usr/bin/env node
/** End-to-end check of a real Supabase project against what this app expects.
 *
 *  Everything here runs against the live project named in the environment, with
 *  two throwaway accounts it creates and deletes. It is the answer to "is the
 *  migration applied and are the policies actually doing anything", which no
 *  amount of local testing can settle — RLS only exists on the server.
 *
 *  The sign-in step deliberately goes through the real OTP path: the admin API
 *  can generate the same token the email would carry, so `verifyOtp` is
 *  exercised exactly as a person would exercise it, without a mailbox.
 *
 *    node scripts/verify-supabase.mjs
 *
 *  Reads .env and .env.local. Needs the project URL, the publishable key, and
 *  the secret key — the last only to create and delete the test accounts. The
 *  app itself never uses a secret key and must never be given one.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

/* ── environment ──────────────────────────────────────────────────── */

for (const file of ['.env', '.env.local']) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    /* .env.local wins, and an already-exported value wins over both */
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const pick = (...names) => names.map(n => process.env[n]).find(v => v && v.trim())?.trim();

const URL_ = pick('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL');
const PUBLISHABLE = pick(
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY',
);
const SECRET = pick('SUPABASE_PRIVATE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');

const missing = [
  !URL_ && 'the project URL (NEXT_PUBLIC_SUPABASE_URL, e.g. https://abcdefgh.supabase.co)',
  !PUBLISHABLE && 'the publishable key (NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)',
  !SECRET && 'the secret key (SUPABASE_PRIVATE_KEY) — only to create and delete the test accounts',
].filter(Boolean);

if (missing.length) {
  console.error('Cannot run. Missing:\n' + missing.map(m => `  - ${m}`).join('\n'));
  process.exit(2);
}

/* ── reporting ────────────────────────────────────────────────────── */

let failures = 0;
let stepNo = 0;
const pad = s => String(s).padStart(2, ' ');

function ok(label, detail = '') {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}
function bad(label, detail = '') {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      \x1b[31m${detail}\x1b[0m` : ''}`);
}
function step(title) {
  console.log(`\n\x1b[1m${pad(++stepNo)}. ${title}\x1b[0m`);
}
const msg = e => (e ? (e.message ?? String(e)) : '');

/* ── clients ──────────────────────────────────────────────────────── */

const admin = createClient(URL_, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });

/** A client that is a specific signed-in person, exactly as the browser's is:
 *  the publishable key plus that person's access token, so every query is
 *  subject to RLS. Using the secret key here would prove nothing. */
const asUser = accessToken => createClient(URL_, PUBLISHABLE, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${accessToken}` } },
});

const stamp = Date.now();
const emailFor = who => `plattegrond-verify+${who}-${stamp}@example.com`;
const users = [];

async function makeUser(who) {
  const email = emailFor(who);
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw new Error(`could not create the ${who} test account: ${msg(error)}`);
  users.push(data.user.id);
  return { id: data.user.id, email };
}

/** Signs in through the genuine OTP path. `generate_link` hands back the very
 *  token the email would have carried, so this is `verifyOtp` under test, not a
 *  shortcut around it. */
async function signInWithOtp(email) {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`could not mint an OTP for ${email}: ${msg(error)}`);
  const token = data.properties?.email_otp;
  if (!token) throw new Error('the admin API returned no email_otp — cannot test the code path');

  const anon = createClient(URL_, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: session, error: vErr } = await anon.auth.verifyOtp({ email, token, type: 'email' });
  if (vErr || !session.session) throw new Error(`verifyOtp refused the code: ${msg(vErr)}`);
  return { token, accessToken: session.session.access_token, userId: session.user.id };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const doc = name => ({
  schema: 2,
  id: `verify${stamp.toString(36)}`,
  name,
  createdAt: stamp,
  updatedAt: stamp,
  source: { url: 'https://funda.nl/x', address: 'Teststraat 1', title: null, projectId: 1, fetchedAt: stamp },
  floors: [{
    id: 'floor1', name: 'Begane grond', level: 0,
    walls: [], areas: [], items: [], notes: [], dims: [], lines: [], ref: null,
  }],
});

/* ── the run ──────────────────────────────────────────────────────── */

async function main() {
  console.log(`\n\x1b[1mVerifying ${URL_}\x1b[0m`);

  /* 1 */
  step('The project answers');
  {
    const res = await fetch(`${URL_}/auth/v1/health`, { headers: { apikey: PUBLISHABLE } });
    res.ok ? ok('auth is reachable', `HTTP ${res.status}`)
      : bad('auth is not reachable', `HTTP ${res.status} — check the URL`);
    if (!res.ok) return;
  }

  /* 2 */
  step('The migration has been applied');
  for (const table of ['profiles', 'plans', 'renders']) {
    const { error } = await admin.from(table).select('*', { count: 'exact', head: true });
    error
      ? bad(`table ${table}`, `${msg(error)} — run supabase/migrations/20260816120000_init.sql`)
      : ok(`table ${table}`);
  }
  {
    const { data, error } = await admin.storage.listBuckets();
    const bucket = data?.find(b => b.id === 'renders');
    if (error) bad('the renders bucket', msg(error));
    else if (!bucket) bad('the renders bucket', 'not found — the migration creates it');
    else if (bucket.public) bad('the renders bucket', 'it is PUBLIC; every render is world-readable');
    else ok('the renders bucket', 'private');
  }
  if (failures) { console.log('\nStopping: the schema is not in place, so nothing below would mean anything.'); return; }

  /* 3 */
  step('Two accounts sign in through the real OTP flow');
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const aSess = await signInWithOtp(alice.email);
  ok('alice: signInWithOtp → verifyOtp', `code was ${aSess.token.length} characters`);
  if (!/^\d{6}$/.test(aSess.token)) {
    bad('the OTP is not a six-digit code',
      `got "${aSess.token}" — the app's login form expects the digits from {{ .Token }}`);
  } else ok('the OTP is a six-digit code', 'matches what the login form asks for');
  const bSess = await signInWithOtp(bob.email);
  ok('bob: signed in');

  const A = asUser(aSess.accessToken);
  const B = asUser(bSess.accessToken);

  /* 4 */
  step('The profile trigger fired');
  {
    const { data, error } = await A.from('profiles').select('id, email').eq('id', aSess.userId).maybeSingle();
    if (error) bad('alice can read her profile', msg(error));
    else if (!data) bad('alice has a profile row', 'the on_auth_user_created trigger did not fire');
    else if (data.email !== alice.email) bad('the profile carries the address', `got ${data.email}`);
    else ok('alice has a profile row with her address');
  }

  /* 5 */
  step('A plan round-trips, and only for its owner');
  let planId = null;
  {
    const d = doc('Verification plan');
    const { data, error } = await A.from('plans').upsert({
      owner_id: aSess.userId,
      client_id: d.id,
      name: d.name,
      address: 'Teststraat 1',
      source_url: 'https://funda.nl/x',
      funda_project_id: 1,
      floor_count: 1,
      doc: d,
      doc_updated_at: new Date(stamp).toISOString(),
    }, { onConflict: 'owner_id,client_id' }).select('id').single();
    if (error) { bad('alice can save a plan', msg(error)); return await cleanup(); }
    planId = data.id;
    ok('alice saved a plan');

    const { data: back, error: rErr } = await A.from('plans').select('doc, name').eq('id', planId).single();
    if (rErr) bad('alice can read it back', msg(rErr));
    else if (back.doc?.floors?.[0]?.name !== 'Begane grond') bad('the document survived jsonb', JSON.stringify(back.doc).slice(0, 120));
    else ok('the document survived the jsonb round trip');

    const { data: theft } = await B.from('plans').select('id').eq('id', planId);
    theft?.length
      ? bad('RLS: bob cannot read alice\'s plan', 'HE CAN — the select policy is not doing its job')
      : ok('RLS: bob cannot read alice\'s plan');

    const { data: tamper } = await B.from('plans').update({ name: 'owned' }).eq('id', planId).select('id');
    tamper?.length
      ? bad('RLS: bob cannot edit alice\'s plan', 'HE CAN — the update policy is not doing its job')
      : ok('RLS: bob cannot edit alice\'s plan');

    const { data: nuke } = await B.from('plans').delete().eq('id', planId).select('id');
    nuke?.length
      ? bad('RLS: bob cannot delete alice\'s plan', 'HE CAN — the delete policy is not doing its job')
      : ok('RLS: bob cannot delete alice\'s plan');
  }

  /* 6 */
  step('An owner cannot forge the owner_id');
  {
    const { error } = await A.from('plans').insert({
      owner_id: bSess.userId,
      client_id: `forged${stamp}`,
      doc: doc('Forged'),
      doc_updated_at: new Date(stamp).toISOString(),
    });
    error ? ok('alice cannot insert a plan owned by bob', 'refused by WITH CHECK')
      : bad('alice CAN insert a plan owned by bob', 'the insert policy has no WITH CHECK on owner_id');
  }

  /* 7 */
  step('Render bytes go to the private bucket, and stay private');
  const objectPath = `${aSess.userId}/${stamp}.png`;
  {
    const { error } = await A.storage.from('renders').upload(objectPath, PNG, { contentType: 'image/png', upsert: true });
    if (error) bad('alice can upload a render', msg(error));
    else ok('alice can upload a render', objectPath);

    const { data: signed, error: sErr } = await A.storage.from('renders').createSignedUrl(objectPath, 60);
    if (sErr || !signed?.signedUrl) bad('the object can be signed', msg(sErr));
    else {
      const res = await fetch(signed.signedUrl);
      const bytes = Buffer.from(await res.arrayBuffer());
      bytes.equals(PNG) ? ok('the signed URL returns the exact bytes') : bad('the signed URL returns the bytes', `${bytes.length} bytes back, ${PNG.length} sent`);
    }

    const bare = await fetch(`${URL_}/storage/v1/object/public/renders/${objectPath}`);
    bare.ok ? bad('the object is not publicly readable', 'IT IS — the bucket is serving without a signature')
      : ok('the object is not publicly readable', `HTTP ${bare.status} without a signature`);

    const { error: bErr } = await B.storage.from('renders').download(objectPath);
    bErr ? ok('RLS: bob cannot download alice\'s render') : bad('RLS: bob cannot download alice\'s render', 'HE CAN');

    const { error: bUp } = await B.storage.from('renders').upload(`${aSess.userId}/intruder.png`, PNG, { contentType: 'image/png' });
    bUp ? ok('RLS: bob cannot write into alice\'s folder') : bad('RLS: bob cannot write into alice\'s folder', 'HE CAN');
  }

  /* 8 */
  step('A render row references its plan, and dies with it');
  {
    const { data, error } = await A.from('renders').insert({
      owner_id: aSess.userId,
      plan_id: planId,
      client_id: `r${stamp}`,
      floor_id: 'floor1',
      prompt: 'a verification render',
      settings: { view: 'top', room: '*', style: '', furniture: true, dimensions: false, roomLabels: true, imgMeasures: false },
      status: 'ready',
      image_path: objectPath,
      bytes: PNG.length,
    }).select('id').single();
    if (error) { bad('alice can record a render', msg(error)); return await cleanup(); }
    ok('alice recorded a render');

    const { error: fkErr } = await A.from('renders').insert({
      owner_id: aSess.userId,
      plan_id: '00000000-0000-0000-0000-000000000000',
      client_id: `orphan${stamp}`,
      floor_id: 'floor1',
      prompt: 'orphan',
    });
    fkErr ? ok('a render cannot reference a plan that is not there', 'foreign key holds')
      : bad('a render CAN reference a plan that is not there', 'the foreign key is missing');

    await A.from('plans').delete().eq('id', planId);
    const { data: left } = await A.from('renders').select('id').eq('id', data.id);
    left?.length ? bad('deleting the plan takes its renders', 'it did not — the cascade is missing')
      : ok('deleting the plan takes its renders with it', 'on delete cascade');
  }

  await cleanup();
}

async function cleanup() {
  step('Cleaning up');
  for (const id of users) {
    /* deleting the account cascades to plans, renders and the profile row; the
       bucket objects go with the folder because nothing else references them */
    const { error } = await admin.auth.admin.deleteUser(id);
    error ? bad(`removing test account ${id}`, msg(error)) : ok(`removed test account ${id.slice(0, 8)}…`);
  }
}

main()
  .catch(e => { failures++; console.error(`\n\x1b[31mAborted:\x1b[0m ${msg(e)}`); return cleanup().catch(() => {}); })
  .finally(() => {
    console.log(failures
      ? `\n\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed.\x1b[0m\n`
      : '\n\x1b[32mEverything checks out.\x1b[0m\n');
    process.exit(failures ? 1 : 0);
  });
