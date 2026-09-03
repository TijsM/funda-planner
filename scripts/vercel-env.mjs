#!/usr/bin/env node
/** Push this app's server configuration to a Vercel project.
 *
 *    node scripts/vercel-env.mjs              # show the plan, change nothing
 *    node scripts/vercel-env.mjs --yes        # write it
 *
 *  Reads .env and .env.local the way `next dev` does (.env.local wins, an
 *  already-exported value wins over both), then upserts each variable through
 *  Vercel's own SDK.
 *
 *  DRY BY DEFAULT, because the failure mode is silent and remote: a wrong value
 *  written to `production` is a broken deployment discovered by a person trying
 *  to render something, not by anything here. Nothing is sent until `--yes`.
 *
 *  IT SYNCS AN ALLOWLIST, NOT `.env`. This is the whole point of the file and
 *  the reason it is not three lines of `vercel env add`. A local .env
 *  accumulates credentials that have no business in a deployment, and
 *  "everything in the file" would ship them:
 *
 *    · VERCEL_OIDC_TOKEN — Vercel mints this itself, per deployment, and the
 *      copy in .env.local is a stale artefact of `vercel dev`. Uploading it
 *      would shadow the real one with an expired token.
 *    · SUPABASE_PERSONAL_TOKEN — a Management API token. It can run arbitrary
 *      SQL against the project and drop the database. The app never reads it;
 *      it exists for migrations run from a laptop.
 *    · SUPABASE_PRIVATE_KEY — the `sb_secret_` service key, which bypasses RLS
 *      entirely. Only scripts/verify-supabase.mjs, scripts/signin-code.mjs and
 *      the account e2e spec use it. The app authenticates as the person using
 *      it and must never be handed a key that ignores their row policies.
 *    · SESSION_SECRET, APP_LOGIN, RESEND_API_KEY — legacy. They survive in
 *      .env.example and the docs but no code reads them any more.
 *
 *  So the list below is derived from what the code actually reads — grep for
 *  `process.env.` under src/ and app/ and you get exactly these — and anything
 *  else in .env is reported as deliberately skipped rather than silently
 *  dropped, because a variable that is missing in production and unmentioned
 *  here is the bug this script is supposed to prevent.
 */

import { readFileSync, existsSync } from 'node:fs';
import { Vercel } from '@vercel/sdk';

/* ── the allowlist ────────────────────────────────────────────────── */

/** Every variable the deployed app reads, and nothing else.
 *
 *  `required` marks the ones without which the app is broken rather than merely
 *  reduced: with no Supabase URL or key a production build refuses to serve at
 *  all (see src/data/config.ts), whereas a missing provider key costs you that
 *  one model and is refused by name in the panel — which is why the render
 *  providers are optional here. */
const SYNC = [
  { key: 'NEXT_PUBLIC_SUPABASE_URL', required: true, note: 'the project the accounts live in' },
  { key: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', required: true, note: 'the browser key' },
  { key: 'FLUX_API_KEY', required: false, note: 'FLUX.2 and the ControlNet models' },
  { key: 'GEMINI_API_KEY', required: false, note: "Google's image models, the default pick" },
  { key: 'OPENAI_API_KEY', required: false, note: 'the GPT Image models' },
  { key: 'FAL_KEY', required: false, note: 'Z-Image and Qwen Edit, via fal' },
];

/** Named so the report can say "skipped on purpose" rather than nothing at all.
 *  See the note at the top of the file for why each one is refused. */
const NEVER = new Set([
  'VERCEL_OIDC_TOKEN', 'SUPABASE_PERSONAL_TOKEN', 'SUPABASE_PRIVATE_KEY',
  'SUPABASE_PUBLISHABLE_KEY', 'SESSION_SECRET', 'APP_LOGIN', 'RESEND_API_KEY',
]);

const TARGETS = ['production', 'preview', 'development'];

/** The types Vercel stores a value under. `encrypted` is its default and is
 *  readable back in the dashboard; `sensitive` is write-only and cannot be read
 *  by anyone, including the person who set it; `plain` is not encrypted at all. */
const TYPES = ['encrypted', 'sensitive', 'plain'];

/** Whatever the project already uses, which is the default and the reason this
 *  is not a flag anybody has to think about: a config where one key is sensitive
 *  and its five neighbours are encrypted is a config that reads as a mistake
 *  every time somebody opens the dashboard. Falls back to Vercel's own default
 *  when the project has nothing to copy — a brand new project, say. */
function matchType(existing) {
  const tally = new Map();
  for (const entries of existing.values()) {
    for (const e of entries) {
      if (TYPES.includes(e.type)) tally.set(e.type, (tally.get(e.type) ?? 0) + 1);
    }
  }
  if (!tally.size) return { type: 'encrypted', why: 'the project has none to copy, so Vercel\'s default' };
  const [type, n] = [...tally].sort((a, b) => b[1] - a[1])[0];
  const spread = [...tally].map(([t, c]) => `${c}×${t}`).join(', ');
  return { type, why: `matching the ${n === 1 ? 'one' : n} already there (${spread})` };
}

/* ── the local environment ────────────────────────────────────────── */

/** The same precedence `next dev` uses, so what is pushed is what you have been
 *  running against. */
function loadEnv() {
  const found = new Map();
  for (const file of ['.env', '.env.local']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, '');
      if (value) found.set(m[1], { value, file });   /* .env.local wins */
    }
  }
  /* An exported value beats both files, matching Next and letting CI override. */
  for (const { key } of SYNC) {
    if (process.env[key]?.trim()) found.set(key, { value: process.env[key].trim(), file: 'the shell' });
  }
  return found;
}

/** Enough of a value to recognise, never enough to use. */
const mask = (v) => (v.length <= 8 ? '*'.repeat(v.length) : `${v.slice(0, 4)}…${v.slice(-2)} (${v.length})`);

/* ── where it goes ────────────────────────────────────────────────── */

/** The project Vercel should be told about. `.vercel/project.json` is what
 *  `vercel link` writes and is gitignored, so it is absent in a fresh worktree —
 *  hence the environment override, which is also how CI would call this. */
function target(dir) {
  const fromEnv = {
    projectId: process.env.VERCEL_PROJECT_ID?.trim(),
    teamId: process.env.VERCEL_TEAM_ID?.trim() ?? process.env.VERCEL_ORG_ID?.trim(),
  };
  if (fromEnv.projectId) return fromEnv;

  const path = `${dir}/.vercel/project.json`;
  if (!existsSync(path)) {
    throw new Error(`No Vercel project found. Either run \`vercel link\`, point --project-dir at a`
      + ` checkout that has .vercel/project.json, or set VERCEL_PROJECT_ID and VERCEL_TEAM_ID.`);
  }
  const linked = JSON.parse(readFileSync(path, 'utf8'));
  return { projectId: linked.projectId, teamId: linked.orgId, name: linked.projectName };
}

/* ── the run ──────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const o = { yes: false, targets: TARGETS, projectDir: process.cwd(), type: null };
  for (let i = 0; i < argv.length; i++) {
    const take = (name) => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
      i++;
      return v;
    };
    switch (argv[i]) {
      case '--yes': o.yes = true; break;
      /* Left null by default, which means "whatever the project already uses" —
         see `matchType`. Given explicitly only to change the convention. */
      case '--type': o.type = take('type'); break;
      case '--targets': o.targets = take('targets').split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--project-dir': o.projectDir = take('project-dir'); break;
      default: throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  for (const t of o.targets) {
    if (!TARGETS.includes(t)) throw new Error(`unknown target "${t}". Known: ${TARGETS.join(', ')}`);
  }
  if (o.type !== null && !TYPES.includes(o.type)) {
    throw new Error(`unknown --type "${o.type}". Known: ${TYPES.join(', ')}, or omit it to match the project.`);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.VERCEL_TOKEN?.trim();
  if (!token) {
    throw new Error('VERCEL_TOKEN is not set. Create one at vercel.com/account/settings/tokens'
      + ' (scope it to the team that owns the project) and pass it in the environment —'
      + ' VERCEL_TOKEN=… node scripts/vercel-env.mjs. It is deliberately not read from .env:'
      + ' a token that can rewrite production config should not sit in a file the app loads.');
  }

  const { projectId, teamId, name } = target(opts.projectDir);
  const env = loadEnv();
  const vercel = new Vercel({ bearerToken: token });

  /* What is there now, so the plan can say "new" or "changed" rather than just
     "sent". Values come back encrypted, so this compares presence and targets,
     not contents — an upsert of an identical value is a no-op at Vercel anyway. */
  const existing = new Map();
  const current = await vercel.projects.filterProjectEnvs({ idOrName: projectId, teamId });
  for (const e of current.envs ?? []) {
    if (!existing.has(e.key)) existing.set(e.key, []);
    existing.get(e.key).push(e);
  }

  const matched = matchType(existing);
  const type = opts.type ?? matched.type;

  console.log(`PROJECT  ${name ?? projectId}${teamId ? ` (team ${teamId})` : ''}`);
  console.log(`TARGETS  ${opts.targets.join(', ')}`);
  console.log(`TYPE     ${type}${opts.type ? ' (given)' : ` — ${matched.why}`}\n`);

  const plan = [];
  const missing = [];
  for (const { key, required, note } of SYNC) {
    const local = env.get(key);
    if (!local) {
      missing.push({ key, required, note });
      continue;
    }
    const have = existing.get(key) ?? [];
    const covered = opts.targets.filter((t) => have.some((e) => (e.target ?? []).includes(t)));
    plan.push({ key, value: local.value, from: local.file, note, covered });
  }

  console.log('WILL SYNC');
  for (const p of plan) {
    const state = p.covered.length === 0 ? 'new'
      : p.covered.length === opts.targets.length ? 'overwrite'
        : `partial — already on ${p.covered.join(', ')}`;
    console.log(`  ${p.key.padEnd(38)} ${mask(p.value).padEnd(22)} ${state.padEnd(34)} from ${p.from}`);
  }
  if (!plan.length) console.log('  nothing — no allowlisted variable has a local value');

  if (missing.length) {
    console.log('\nMISSING LOCALLY, so nothing to push');
    for (const m of missing) {
      console.log(`  ${m.key.padEnd(38)} ${m.required ? 'REQUIRED — the app will not serve without it' : `optional — ${m.note}`}`);
    }
  }

  /* Everything in .env that is NOT going, said out loud. A variable silently
     absent from production is exactly the bug this script exists to prevent, so
     the skips are part of the report rather than an omission from it. */
  const skipped = [...env.keys()].filter((k) => !SYNC.some((s) => s.key === k));
  if (skipped.length) {
    console.log('\nNOT SYNCED, on purpose (see the note at the top of this file)');
    for (const k of skipped) {
      console.log(`  ${k.padEnd(38)} ${NEVER.has(k) ? 'refused by name' : 'not read by the deployed app'}`);
    }
  }

  const blocked = missing.filter((m) => m.required);
  if (blocked.length) {
    console.log(`\nREFUSED\n  ${blocked.map((b) => b.key).join(', ')} required but absent locally.`
      + ' Syncing the rest would leave the deployment half-configured; fix .env first.');
    process.exitCode = 1;
    return;
  }

  if (!opts.yes) {
    console.log('\nDRY RUN — nothing sent. Re-run with --yes to write it.');
    return;
  }
  if (!plan.length) return;

  /* One batched upsert: `upsert=true` updates a key that already exists instead
     of failing on the conflict, which is what makes this re-runnable. */
  await vercel.projects.createProjectEnv({
    idOrName: projectId,
    teamId,
    upsert: 'true',
    requestBody: plan.map((p) => ({
      key: p.key,
      value: p.value,
      type,
      target: opts.targets,
      comment: 'synced from a local .env by scripts/vercel-env.mjs',
    })),
  });

  console.log(`\nWROTE ${plan.length} variable(s) to ${opts.targets.join(', ')}.`);
  console.log('Existing deployments keep the values they were built with —'
    + ' redeploy for these to take effect.');
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
});
