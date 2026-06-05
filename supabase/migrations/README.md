# Supabase Migrations

Migrations for the user-account-platform feature. Apply them **in numeric order**.

## How to apply (without the Supabase CLI)

1. Open Supabase Studio for your project: <https://supabase.com/dashboard/project/kqyezzrlvtzbfenfqvau>
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
   You should see: `activity_events`, `api_usage`, `desktop_link_codes`, `desktop_sessions`, `devices`, `feature_limits`, `profiles`.

## Apply order

1. `001_profiles.sql` — `profiles` table + `auth.users` trigger
2. `002_devices.sql` — `devices` table
3. `003_desktop_link_codes.sql` — one-time link tickets
4. `004_desktop_sessions.sql` — refresh-token sessions
5. `005_activity_events.sql` — activity timeline (P5 idempotency)
6. `006_api_usage.sql` — per-call AI usage log
7. `007_feature_limits.sql` — per-plan caps + `('free', NULL, NULL, NULL)` seed

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
