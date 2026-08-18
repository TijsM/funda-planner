import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MISCONFIGURED_MESSAGE, isCloud, mode, supabaseConfig } from '@data/config';

/** Which of the two worlds the process is in — read fresh from the environment
 *  on every call, which is exactly what makes it testable like this.
 *
 *  The case worth the most here is the last one: production with no credentials
 *  and no opt-in. Getting that wrong does not break anything visibly, it just
 *  serves one person's editor to everyone who finds the URL. */

const NAMES = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'PLATTEGROND_MODE',
  'NODE_ENV',
] as const;

/* Vitest runs every file in one process, so a leaked variable is not a failure
   here — it is a failure three files away. Saved as entries rather than a spread
   copy so that "was not set at all" survives the restore. */
let saved: [string, string | undefined][] = [];

beforeEach(() => {
  saved = NAMES.map(n => [n, process.env[n]] as [string, string | undefined]);
  for (const n of NAMES) delete process.env[n];
});

afterEach(() => {
  for (const [n, v] of saved) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
});

/* NODE_ENV is declared read-only, and rightly so — application code has no
   business writing it. A test whose whole subject is what happens in production
   does, and this is the one line that admits it rather than spreading a cast
   across every case. */
const nodeEnv = (v: string) => { (process.env as Record<string, string | undefined>).NODE_ENV = v; };

const cloudEnv = () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_not_a_real_key';
};

describe('mode', () => {
  it('is cloud when both variables are set', () => {
    cloudEnv();
    expect(mode()).toBe('cloud');
    expect(isCloud()).toBe(true);
  });

  /* Credentials win in every environment: a production deployment that has them
     is a cloud deployment, and the opt-in is not a way to switch the gate off. */
  it('is cloud in production too, opt-in or not', () => {
    cloudEnv();
    nodeEnv('production');
    process.env.PLATTEGROND_MODE = 'local';
    expect(mode()).toBe('cloud');
  });

  it('is local in development with nothing configured', () => {
    nodeEnv('development');
    expect(mode()).toBe('local');
    expect(isCloud()).toBe(false);
  });

  /* This is what CI and the Playwright suite run in: NODE_ENV is not
     'production', so no opt-in is needed to get the ungated editor. */
  it('is local when NODE_ENV is not set at all', () => {
    expect(mode()).toBe('local');
  });

  it('is local in production only with the explicit opt-in', () => {
    nodeEnv('production');
    process.env.PLATTEGROND_MODE = 'local';
    expect(mode()).toBe('local');
  });

  it('is misconfigured in production with no credentials and no opt-in', () => {
    nodeEnv('production');
    expect(mode()).toBe('misconfigured');
  });

  /* Anything other than the exact word is a typo, and a typo must not open the
     door — 'true', '1' and 'LOCAL' all mean "someone meant to opt in and did
     not", which is precisely when refusing is worth more than guessing. */
  it.each(['true', '1', 'LOCAL', 'cloud', ''])('refuses PLATTEGROND_MODE=%o in production', v => {
    nodeEnv('production');
    process.env.PLATTEGROND_MODE = v;
    expect(mode()).toBe('misconfigured');
  });

  /* Half a configuration is not a configuration. It falls back to the local
     rules rather than pretending to be cloud, and in production that means the
     deployment is refused — which is the loud failure someone needs. */
  it('does not go cloud on a url with no key, or a key with no url', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    expect(mode()).toBe('local');
    expect(supabaseConfig()).toBeNull();

    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_not_a_real_key';
    expect(mode()).toBe('local');
    expect(supabaseConfig()).toBeNull();
  });

  /* An empty or whitespace-only value is what a shell writes when a CI secret is
     missing, and it must read as absent rather than as a credential that fails
     later, inside a fetch. */
  it('treats blank values as absent', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = '   ';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = '';
    expect(mode()).toBe('local');
    expect(isCloud()).toBe(false);
  });
});

describe('supabaseConfig', () => {
  it('still accepts the older ANON_KEY name', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'legacy-anon-key';
    expect(mode()).toBe('cloud');
    expect(supabaseConfig()).toEqual({ url: 'https://abcdefgh.supabase.co', key: 'legacy-anon-key' });
  });

  it('prefers the publishable name when both are present', () => {
    cloudEnv();
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'legacy-anon-key';
    expect(supabaseConfig()?.key).toBe('sb_publishable_not_a_real_key');
  });

  /* A trailing newline from `echo` into a .env is the classic one, and it turns
     the url into a host that does not resolve. */
  it('trims what it reads', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = '  https://abcdefgh.supabase.co\n';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ' sb_publishable_not_a_real_key ';
    expect(supabaseConfig()).toEqual({ url: 'https://abcdefgh.supabase.co', key: 'sb_publishable_not_a_real_key' });
  });

  it('is null in local mode', () => {
    expect(supabaseConfig()).toBeNull();
  });
});

describe('the misconfigured message', () => {
  /* It is the only thing a misconfigured deployment ever says, so it has to name
     the variables rather than telling whoever deployed it to check something. */
  it('names every variable that would fix it', () => {
    expect(MISCONFIGURED_MESSAGE).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(MISCONFIGURED_MESSAGE).toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    expect(MISCONFIGURED_MESSAGE).toContain('PLATTEGROND_MODE=local');
  });
});
