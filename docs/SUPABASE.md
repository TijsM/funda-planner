# Supabase — setting one up from empty

Follow this top to bottom against a new Supabase project and you end up with working accounts,
plans in Postgres and render PNGs in a private bucket. Step 4 is the one that silently ships the
wrong product if you skip it.

Nothing here is required to run the editor. With no Supabase credentials at all the app is exactly
what it was before accounts landed — see [Local mode](#7-local-mode-no-credentials-at-all) at the
bottom.

## Checking it worked

Two commands, both of which run against whatever project `.env.local` points at:

```
pnpm verify:supabase    # schema, RLS, storage policies, OTP sign-in, the cascade
pnpm test:e2e:live      # the same flow through a real browser: sign in, save, sync, sign out
```

`verify:supabase` creates two throwaway accounts, tries to make one read the other's plans and
render PNGs, and deletes both. It is the only way to find out whether the policies actually hold —
RLS exists on the server, so nothing local can tell you.

Neither runs in CI, and neither needs mail: the code comes from the admin API, which mints exactly
what the email would have carried without sending it. That also means **neither proves an email
arrives.** Only step 5 does, and only by you reading one.

---

## 1. Create the project

[supabase.com/dashboard](https://supabase.com/dashboard) → **New project**. Pick a region near the
people using it; every plan save and every render poll is a round trip to it.

Then **Project Settings → API** (newer dashboards split this into **Data API** and **API Keys**) and
copy two things:

| | what it is |
|---|---|
| **Project URL** | `https://<ref>.supabase.co` |
| **Publishable key** | the browser key. Older dashboards call it the **anon** key — same thing. |

The publishable key belongs in the client bundle; that is what it is for. Row-level security is
what protects the data. The **service_role** key is the one that bypasses all of it — this app never
reads it, and it must never go anywhere near a `NEXT_PUBLIC_` variable.

## 2. `.env.local`

Copy `.env.example` to `.env.local` and fill in:

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<the publishable key>
FLUX_API_KEY=<from dashboard.bfl.ai/api/keys>
```

Exactly those names — `src/data/config.ts` reads the two `NEXT_PUBLIC_…` literals directly, because
Next inlines literals into the client bundle at build time and cannot see through a variable.
`NEXT_PUBLIC_SUPABASE_ANON_KEY` is accepted as a fallback for the second one, so an older `.env`
keeps working.

Both must be present. One without the other is not a half-configured cloud, it is local mode with a
stray variable, and nothing will tell you.

`FLUX_API_KEY` is unchanged by any of this: renders still go through our own server precisely so
that key never reaches a browser.

**`APP_LOGIN` and `SESSION_SECRET` are gone.** They were the single shared password and the secret
that signed its cookie. Accounts replaced both and nothing reads them any more — delete them from
any `.env` you already have rather than leaving them to look load-bearing.

`.env.local` is gitignored — `.gitignore` covers it with `.env*.local`, alongside the plain `.env`
that was there before.

## 3. Apply the migration

Everything the app needs — three tables, their RLS policies, the trigger that mirrors
`auth.users` into `profiles`, and the private Storage bucket — is one file:

```
supabase/migrations/20260816120000_init.sql
```

**With the CLI** (needs Docker for a local stack, but `db push` alone does not):

```
supabase login
supabase link --project-ref <ref>
supabase db push
```

**Without it**, which is the honest route if you have no Docker and no CLI: open the SQL editor in
the dashboard, paste the whole file, **Run**. It is written to run once against an empty project —
re-running it fails on the first `create table`, which is the correct kind of loud.

Then confirm, in **Table editor**: `profiles`, `plans`, `renders`, each showing **RLS enabled**. And
in **Storage**: a bucket named `renders`, **not public**, capped at 20 MB per object and restricted
to `image/png`. If the bucket is missing, the policy block at the bottom of the migration did not
run and every finished render will fail to store.

## 4. The OTP email template — do not skip this

Sign-in is `signInWithOtp` and then `verifyOtp` (`app/login/LoginForm.tsx`): the app asks for an address,
then for the six-digit code mailed to it. There is no password anywhere in the system.

**Supabase mails a magic link by default.** The six-digit code only appears in the email if the
template is edited to use `{{ .Token }}` instead of `{{ .ConfirmationURL }}`. That is a dashboard
setting, invisible from the code.

*Symptom if you skip it:* the app moves to "Enter the six-digit code from the email", the email
arrives, and it contains a link and no code. Nothing errors. There is no way in.

> **The template cannot be edited on the free tier while the built-in sender is in use.** The
> management API answers *"Email template modification is not available for free tier projects using
> the default email provider."* So this step and step 5 are one step: **do step 5 first**, and the
> templates unlock. There is no order in which you get working OTP mail without doing both.

Also set the code length to six, or the mail carries eight digits while the form says six —
**Authentication → Sign In / Providers → Email → Email OTP Length**. That one *is* editable on the
free tier, and it defaults to 8.

**Authentication → Emails → Templates**, and edit **both** of these:

- **Magic Link** — what an address that already has an account receives.
- **Confirm signup** — what a *brand-new* address receives, because the first sign-in also creates
  the account. Edit only the first and the very first code never arrives, which is the worst
  possible one to lose.

Same body for both:

```html
<h2>Your sign-in code</h2>
<p>Enter this code in Plattegrond Studio:</p>
<p style="font-size:28px;letter-spacing:6px"><strong>{{ .Token }}</strong></p>
<p>It is valid for one hour. If you did not ask for it, ignore this email.</p>
```

Send yourself one and read it before moving on. This is not a step to assume worked.

Because the flow never opens a link, **Site URL** and **Redirect URLs** under **Authentication →
URL Configuration** do not matter here.

## 5. SMTP — the thing the whole front door rests on

Do this one before step 4, because step 4 depends on it.

The built-in sender has three limits, and each was confirmed against a live project rather than read
off a docs page:

- **Two messages an hour.** `rate_limit_email_sent` is 2. The third person to sign in that hour
  cannot, and the app tells them so in as many words.
- **Only your own team.** It delivers to members of the Supabase organisation and refuses everyone
  else. Open signup plus the built-in sender means nobody outside the org can ever get in.
- **The templates are locked** while it is in use, so the code cannot be put in the email at all
  (step 4).

With an emailed code as the *only* way in, that is the whole product's front door. Configure your
own before anyone else touches the deployment: **Authentication → Emails → SMTP Settings** (older
dashboards: **Project Settings → Auth → SMTP**). Any transactional provider does — Resend, Postmark,
SES, Mailgun.

Resend, which is what this project uses:

| field | value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | the `re_…` API key |
| Sender | an address on a **verified** domain |

A send-only API key is enough — it never needs to read anything.

> **Verify your domain, or almost nobody can sign in.** Until a domain is verified in the provider,
> Resend accepts only `onboarding@resend.dev` as the sender and delivers only to the address that
> owns the Resend account. Everyone else's code is refused at the provider, which the login screen
> reports honestly and which looks nothing like a configuration problem to the person reading it.
> Open signup plus an unverified domain is a sign-up form that cannot admit anyone new. Add the
> domain, paste its DKIM and SPF records into DNS, then change the sender to something like
> `noreply@yourdomain`.

Then raise **Authentication → Rate Limits → Emails sent per hour** off 2, which the built-in cap
left it at — the API refuses that change until SMTP exists, with
*"Custom SMTP required to configure … RATE_LIMIT_EMAIL_SENT"*.

Two more knobs worth setting while you are here: **Email OTP Length** to 6 (it defaults to 8, and
the login screen says six), and the per-address minimum gap (`smtp_max_frequency`, 60 s by default)
down to something that does not make a mistyped address a one-minute penalty.

## 6. Auth settings worth a look

**Authentication → Sign In / Providers → Email**

- **Allow new users to sign up** is on by default, and the app does not override it — `sendCode`
  passes no `shouldCreateUser`, so anyone with a mailbox who reaches the login page gets an account
  and an empty library. That is the current posture, stated plainly rather than assumed: it is fine
  for a private URL and wrong for a public one. Turn it off and only addresses you have already
  invited can get in.
- **Email OTP Expiration** — 3600 seconds by default. The login screen tells the user "The code is
  valid for one hour" as literal text, so if you change this, change that line in
  `app/login/LoginForm.tsx` too.

**Authentication → Rate Limits** is where the per-hour email cap and the token-verification limits
live, and where to raise them once you are on your own SMTP. The app already translates the two
that a user can actually hit — "A code was just sent. You can ask for another in N seconds." and
"Too many attempts." — so a limit that is too tight shows up as those sentences rather than as
something broken.

## 7. Local mode — no credentials at all

With neither `NEXT_PUBLIC_SUPABASE_URL` nor the key set, `isCloud()` is false and the app is the
single-user editor it has always been: no login page, no gate in front of anything, plans in
`localStorage`, renders in IndexedDB, no network to Supabase at all. `pnpm build` runs with zero
secrets, and the Playwright suite runs in exactly this mode — `playwright.config.ts` blanks the two
`NEXT_PUBLIC_…` names for the server it starts, so a `.env.local` full of real credentials cannot
quietly gate the run and turn 68 specs red. The gate itself is covered by a separate invocation
(`E2E_GATE=1 pnpm test:e2e --project=gate`) against a server given credentials that point at a host
which cannot resolve.

`PLATTEGROND_MODE=local` is the opt-in for running that same single-user editor **in production on
purpose**. Without it, a production build with no credentials is refused — 503, with a message
naming the variables, from `proxy.ts` — rather than served. That refusal is deliberate: a public
host with the gate quietly switched off looks exactly like a working one, and the first sign that it
was not is a stranger reading your plans.

## 8. What is stored where

| | where it lives | notes |
|---|---|---|
| Accounts | `auth.users`, mirrored into `public.profiles` | by trigger, on insert |
| Plans | `plans` — the whole editor document in a `jsonb` column | plus name, address, source URL and floor count denormalised beside it, so the library list never parses a 200 KB document |
| Render metadata | `renders` — prompt, settings, seed, model, status, lineage | the failed ones too; a failed render is what a retry is built from |
| Render PNGs | the private `renders` bucket, at `<owner-uuid>/<render-uuid>.png` and `.thumb.png` | the bucket's policies authorise on that first path segment alone |
| The provider's poll URL | `renders.provider_poll_url`, server-side only | it never travels through the browser — that is what stops one account polling another's job |
| Offline copy of plans | `localStorage`, keys namespaced per account (`pgs.index.v2~<uuid>`) | written synchronously on every save; the account copy is pushed up on a timer, so the editor never waits on the network |

One honest correction to "everything is mirrored locally": in cloud mode **renders are not**.
IndexedDB (`pgs.renders.v1`) is the local-mode store only — a cloud record carries a signed URL and
no bytes, because downloading every PNG to draw a strip of 96 px thumbnails would be a megabyte a
cell. Plans work offline. The filmstrip does not.

## 9. Known limits

Stated because each one is a decision, not an oversight.

- **Two devices on one plan is last-write-wins.** Whichever document was saved last wins outright,
  and the other device's edits are gone — not merged, not conflicted, gone. The push is on an
  8-second timer, so the window is small and real.
- **A document over 4 MB does not sync.** What makes one that big is an embedded reference bitmap,
  inlined into the document as a base64 data URL with no downscaling. It stays saved in that browser
  and the app says so once, by name. The fix — reference images in Storage with a path in the
  document — is not built yet.
- **Signed URLs expire after an hour.** Every open of the Render panel re-signs the whole list, so
  the expiry is only ever reached by a tab left open overnight, which re-reads before it can draw a
  stale one. A URL copied out of the page dies on its own, which is the intended behaviour for
  bytes in a private bucket.
- **One owner per plan.** Every RLS policy in the migration is `owner_id = auth.uid()`. There is no
  sharing and no teams; when they land, that predicate is the one thing that changes.
