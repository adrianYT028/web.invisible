# Create a separate dev database

Right now local development and production share **one** Supabase project. Every
schema change you make locally is a live production change. That is what broke
saving API keys after migration 016: the column moved in production the moment it
moved in dev, while the deployed code still expected the old shape.

This guide gives you a second project for dev. Production is never touched.

**Time: about 15 minutes.** Nothing here can affect production except step 7,
which is the only step that edits a file the app reads — and even that only
changes which database *your laptop* talks to.

---

## Before you start

Back up the current values so you can always get back to production:

```bash
cd .web.invisible
cp .env.local .env.local.production-backup
```

That file is gitignored. Keep it.

---

## Step 1 — Create the project

1. Go to <https://supabase.com/dashboard>
2. **New project**
3. Fill in:
   - **Name:** `unviewable-dev` (so it is never confused with the live one)
   - **Database password:** generate one and save it in your password manager.
     You will not be shown it again, and you need it if you ever use the CLI.
   - **Region:** the same region as production. Different regions have different
     latency, and you want dev to feel like prod.
   - **Plan:** Free is fine for dev.
4. Create it, then wait for provisioning (1–2 minutes).

## Step 2 — Build the schema

All 18 migrations are pre-joined into one file so you paste once instead of 18
times, wrapped in a single transaction so a failure leaves you with an empty
database rather than a half-built one.

1. In the **new** project, open **SQL Editor** → **New query**
2. Open `supabase/setup/dev-schema.sql`, select all, copy
3. Paste, click **Run**
4. Expect `Success. No rows returned.`

If it errors, nothing was applied. Send me the message.

> Regenerate that file with `node supabase/setup/build-dev-schema.mjs` whenever a
> migration is added, so this path cannot drift from the real migration history.

## Step 3 — Confirm you are in the right project

Check the project name in the top-left of the dashboard says **unviewable-dev**.

This is worth ten seconds. Every destructive accident in this codebase so far has
come from two projects looking identical in two browser tabs.

## Step 4 — Create the two Storage buckets

Buckets cannot be created from SQL, so this is manual and it is easy to forget.
Uploads fail with a confusing error if you skip it.

**Storage** → **New bucket**, twice:

| Name       | Public |
| ---------- | ------ |
| `resumes`  | **OFF** |
| `releases` | **OFF** |

**Public must be OFF on both.** A public `resumes` bucket means every CV anyone
uploads is readable by anyone who can guess a URL. That is a personal-data
breach, not a misconfiguration. The app hands out short-lived signed URLs
instead, which is why private works.

## Step 5 — Set the auth URLs

**Authentication** → **URL Configuration**:

- **Site URL:** `http://localhost:3000`
- **Redirect URLs:** add `http://localhost:3000/**`

Without these, signup emails and password resets point at production and you end
up authenticated against the wrong database while testing.

Email + password signup works with no further setup. Google sign-in is optional
in dev — skip it unless you are specifically testing the Google button, in which
case you need a separate OAuth client for `localhost`.

While you are here, **Authentication** → **Providers** → **Email**: turn
**Confirm email** OFF for dev. It saves you a mailbox round-trip on every test
account. Leave it ON in production.

## Step 6 — Copy the three keys

**Project Settings** → **API**. You need:

| Dashboard label     | Goes into                        |
| ------------------- | -------------------------------- |
| Project URL         | `NEXT_PUBLIC_SUPABASE_URL`       |
| `anon` `public` key | `NEXT_PUBLIC_SUPABASE_ANON_KEY`  |
| `service_role` key  | `SUPABASE_SERVICE_ROLE_KEY`      |

The `service_role` key bypasses all row-level security. It belongs only in
`.env.local` and in Vercel's server-side environment variables. Never in client
code, never in a commit, never in chat.

## Step 7 — Point your laptop at the new project

Edit `.web.invisible/.env.local` and replace **only those three values**.
Everything else stays as it is.

Then restart the dev server — Next.js reads env vars at boot, so an edit without
a restart silently keeps using the old project:

```bash
# stop the running server (Ctrl-C), then
npm run dev
```

## Step 8 — Verify

1. SQL Editor → paste `supabase/setup/verify.sql` → **Run**
2. Failures sort to the top. Everything should say PASS, and the last row should
   report **0 user(s)** — proof you are on the fresh project and not production.

Then check the app end to end:

```bash
# fresh signup against the new database
open http://localhost:3000/login
```

Create an account, then back in SQL Editor:

```sql
select id, plan, created_at from public.profiles order by created_at desc limit 5;
```

A row with `plan = 'free'` means the signup trigger fired. If the table is empty
but the account exists, migration 001's trigger did not apply.

Last, upload a resume at <http://localhost:3000/resume>. That exercises the
`resumes` bucket, so it is the check that catches a missed step 4.

---

## What you now have

| | Production | Dev |
| --- | --- | --- |
| Database | untouched | `unviewable-dev` |
| Used by | Vercel | your laptop |
| Schema changes | only when you choose to apply them | free to break |

**New rule this buys you:** apply a migration to dev first, confirm the app still
works, deploy the code, and only then apply it to production. Migration 016
broke because those three things happened in the wrong order.

---

## Two things to fix while you are in here

**1. Your local `.env.local` holds LIVE Razorpay keys.** Its own comment says so.
Any checkout you trigger locally charges a real card. Get Test Mode keys from
Razorpay (Settings → API Keys, toggle set to Test — they start with `rzp_test_`)
and use those locally. Live keys belong only in Vercel.

**2. The dev `KEY_VAULT_SECRET` was pasted in chat.** Its comment says not to
reuse it in production. Worth confirming Vercel has a different one:

```bash
openssl rand -base64 32   # generate a fresh key if it does not
```

If production is currently using the key that was shared in chat, rotate it.

---

## Rolling back

Nothing to undo. Restore the backup and restart:

```bash
cp .env.local.production-backup .env.local
npm run dev
```

Leave the dev project in place — an empty spare project costs nothing and you
will want it next time.
