# Supabase Migrations

Migrations for the user-account-platform feature. Apply them **in numeric order**.

> ## There are now TWO projects. Know which one you are in.
>
> | | Project ref | Used by |
> | --- | --- | --- |
> | **Dev** | `wzxuavsgwilahvkpbkps` | your laptop (`.env.local`) |
> | **Production** | `kqyezzrlvtzbfenfqvau` | Vercel |
>
> **Apply to dev first.** Confirm the app still works, deploy the code, and only
> then apply to production. Migration 016 broke because a column moved in the
> shared database while the deployed code still expected the old shape — the
> order below is what prevents that repeating.
>
> Setting up a project from scratch? Use `supabase/setup/README.md` instead: it
> has all of these pre-joined into one paste plus a pass/fail verification script.

## How to apply (without the Supabase CLI)

1. Open Supabase Studio and **check the project name in the top-left before you
   run anything.** Both projects look identical in two browser tabs.
   - dev: <https://supabase.com/dashboard/project/wzxuavsgwilahvkpbkps>
   - production: <https://supabase.com/dashboard/project/kqyezzrlvtzbfenfqvau>
2. Go to **SQL Editor** (left sidebar)
3. For each file in this folder, in order:
   - Open the `.sql` file in your editor and copy everything
   - Paste into a new SQL Editor query in Studio
   - Click **Run**
   - Confirm "Success. No rows returned."
4. Verify the schema by running this in the SQL Editor:
   ```sql
   select table_name from information_schema.tables
   where table_schema = 'public'
   order by table_name;
   ```
   You should see: `activity_events`, `api_usage`, `desktop_link_codes`,
   `desktop_sessions`, `devices`, `download_events`, `entitlements`,
   `feature_limits`, `payments`, `profiles`, `releases`, `resume_scans`,
   `resumes`, `user_api_keys`.

## Apply order

1. `001_profiles.sql` — `profiles` table + `auth.users` trigger
2. `002_devices.sql` — `devices` table
3. `003_desktop_link_codes.sql` — one-time link tickets
4. `004_desktop_sessions.sql` — refresh-token sessions
5. `005_activity_events.sql` — activity timeline (P5 idempotency)
6. `006_api_usage.sql` — per-call AI usage log
7. `007_feature_limits.sql` — per-plan caps + `('free', NULL, NULL, NULL)` seed
8. `008_user_api_keys.sql` — encrypted BYO Groq key vault + `set_updated_at()`
9. `009_payments.sql` — Razorpay ledger (integer paise) + `entitlements`
10. `010_releases.sql` — release catalogue (private bucket) + download audit
11. `011_resumes.sql` — resumes, match scans, resume caps, retention reaper
12. `012_tracked_jobs.sql` — the job tracker (pipeline stages + CSV export source)

### `011_resumes.sql` has manual steps

It is the first migration that cannot fully configure itself. After applying it:

1. **Create the private `resumes` Storage bucket** (Studio → Storage → New
   bucket, name `resumes`, **Public: OFF**). A public bucket here is a
   personal-data breach, not a misconfiguration.
2. **Schedule `public.delete_expired_resumes()` daily.** It deletes DB rows and
   returns the Storage paths it orphaned — the caller must then remove those
   objects from the bucket. Skipping that half leaves personal data in Storage
   after the row pointing at it is gone.
3. **Confirm the free-tier gate applied.** In `feature_limits`, `NULL` means
   *unlimited*, so a missed `UPDATE` ships the paid resume analyser free to
   everyone:

   ```sql
   select plan, max_resume_uploads_per_day, max_resume_scans_per_day
     from public.feature_limits order by plan;
   ```

   Expect `free = (1, 1)` and `student_pro = (20, 40)`.

## Verify the trigger works

After applying `001`, sign up a new test user via the website. Then in SQL Editor:

```sql
select id, plan, created_at from public.profiles order by created_at desc limit 5;
```

You should see a row for the test user with `plan = 'free'`.

## Verify RLS denies cross-user reads

```sql
-- As an authenticated session for user A, this must return only user A's rows:
select count(*) from public.activity_events;   -- runs through RLS
-- Compared with the service-role view, which sees everything:
-- (run that in the Supabase Studio's "SQL Editor (service role)" mode)
```
