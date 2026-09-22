-- Verify a Supabase project is correctly set up for this app.
--
-- Safe to run against production: reads only, writes nothing.
--
-- ---------------------------------------------------------------------------
-- RUN PART 1 FIRST, THEN PART 2.
--
-- Part 1 reads only system catalogs, which always exist, so it works even on a
-- completely empty project and tells you what is missing.
--
-- Part 2 reads application tables. It CANNOT be merged into part 1: Postgres
-- resolves table names when it parses a query, not when it runs it, so a single
-- combined script aborts with "relation does not exist" on an empty project and
-- shows you none of the results. Two queries is the price of a useful answer in
-- the case where something actually went wrong.
--
-- Every row says PASS or FAIL, and failures sort to the top.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- PART 1 — structure. Select from here to the PART 2 marker and run.
-- ===========================================================================
with
expected_tables(name) as (
  values
    ('activity_events'), ('api_usage'), ('desktop_link_codes'),
    ('desktop_sessions'), ('devices'), ('download_events'), ('entitlements'),
    ('feature_limits'), ('job_companies'), ('job_postings'), ('payments'),
    ('prep_items'), ('prep_runs'), ('profiles'), ('releases'),
    ('resume_scans'), ('resumes'), ('signups'), ('tracked_jobs'),
    ('user_api_keys')
),
table_check as (
  select
    'table: ' || e.name as check_name,
    case when c.relname is null then 'FAIL — missing' else 'PASS' end as result
  from expected_tables e
  left join pg_class c
    on c.relname = e.name
   and c.relnamespace = 'public'::regnamespace
   and c.relkind = 'r'
),

-- Every table holding user data must have RLS ON. Without it the anon key can
-- read every user's rows, which is the worst misconfiguration available here.
-- feature_limits and releases are deliberately readable reference data.
rls_expected(name) as (
  values
    ('activity_events'), ('api_usage'), ('desktop_link_codes'),
    ('desktop_sessions'), ('devices'), ('download_events'), ('entitlements'),
    ('payments'), ('prep_items'), ('prep_runs'), ('profiles'),
    ('resume_scans'), ('resumes'), ('signups'), ('tracked_jobs'),
    ('user_api_keys')
),
rls_check as (
  select
    'RLS on: ' || e.name as check_name,
    case
      when c.relname is null then 'FAIL — table missing'
      when c.relrowsecurity then 'PASS'
      else 'FAIL — RLS IS OFF. Any user can read every other user''s rows.'
    end as result
  from rls_expected e
  left join pg_class c
    on c.relname = e.name
   and c.relnamespace = 'public'::regnamespace
   and c.relkind = 'r'
),

-- A table with RLS on but no policies denies everything, which looks like a
-- broken app rather than a missing policy.
policy_check as (
  select
    'policies exist: ' || e.name as check_name,
    case
      when c.relname is null then 'FAIL — table missing'
      when (select count(*) from pg_policy p where p.polrelid = c.oid) > 0
        then 'PASS'
      else 'FAIL — RLS on with NO policies, so every read returns nothing'
    end as result
  from rls_expected e
  left join pg_class c
    on c.relname = e.name
   and c.relnamespace = 'public'::regnamespace
   and c.relkind = 'r'
),

expected_functions(name) as (
  values
    ('delete_expired_resumes'), ('handle_new_user'), ('lapse_expired_plans'),
    ('set_updated_at'), ('utc_date')
),
function_check as (
  select
    'function: ' || e.name as check_name,
    case when p.proname is null then 'FAIL — missing' else 'PASS' end as result
  from expected_functions e
  left join pg_proc p
    on p.proname = e.name
   and p.pronamespace = 'public'::regnamespace
),

view_check as (
  select
    'view: prep_run_progress' as check_name,
    case
      when exists (
        select 1 from pg_class
        where relname = 'prep_run_progress'
          and relnamespace = 'public'::regnamespace
          and relkind = 'v'
      ) then 'PASS' else 'FAIL — missing' end as result
),

-- The signup trigger. Without it a new account gets no profiles row — exactly
-- the drift that migration 018 had to clean up in production.
trigger_check as (
  select
    'trigger: on_auth_user_created' as check_name,
    case
      when exists (
        select 1 from pg_trigger
        where tgname = 'on_auth_user_created' and not tgisinternal
      ) then 'PASS'
      else 'FAIL — new signups will get no profiles row' end as result
),

-- Buckets cannot be created from SQL; they are made in Studio -> Storage. Both
-- must be private. A public `resumes` bucket means every uploaded CV is readable
-- by anyone who can guess a URL: a personal-data breach, not a bad default.
bucket_expected(name) as (values ('resumes'), ('releases')),
bucket_check as (
  select
    'bucket: ' || e.name as check_name,
    case
      when b.name is null then 'FAIL — missing. Studio -> Storage -> New bucket'
      when b.public then 'FAIL — BUCKET IS PUBLIC. Turn Public OFF now.'
      else 'PASS (private)'
    end as result
  from bucket_expected e
  left join storage.buckets b on b.name = e.name
),

-- If you meant to build a SEPARATE dev database and this reports existing users,
-- you are pointed at production.
freshness as (
  select
    'account count (0 = fresh project)' as check_name,
    'INFO — ' || (select count(*) from auth.users)::text || ' user(s)' as result
),

all_checks as (
  select 1 as grp, * from table_check
  union all select 2, * from rls_check
  union all select 3, * from policy_check
  union all select 4, * from function_check
  union all select 4, * from view_check
  union all select 4, * from trigger_check
  union all select 5, * from bucket_check
  union all select 6, * from freshness
)
select check_name, result
  from all_checks
 -- Failures first: this file exists to surface problems, not to make you scroll
 -- past 50 passing rows hunting for the one that broke.
 order by case when result like 'FAIL%' then 0 else 1 end, grp, check_name;


-- ===========================================================================
-- PART 2 — seed data. Run this only once PART 1 shows no missing tables.
-- ===========================================================================
--
-- NULL in feature_limits means UNLIMITED, so a missed seed ships the paid resume
-- analyser free to everyone. That is a revenue leak, not a cosmetic default.

with caps as (
  select
    plan,
    max_resume_uploads_per_day as uploads,
    max_resume_scans_per_day   as scans
  from public.feature_limits
),
free_caps as (
  select
    'free plan caps = 1 upload, 1 scan' as check_name,
    case
      when not exists (select 1 from caps where plan = 'free')
        then 'FAIL — no free row'
      when exists (select 1 from caps where plan = 'free' and uploads = 1 and scans = 1)
        then 'PASS'
      else 'FAIL — free tier is '
           || coalesce((select uploads::text from caps where plan = 'free'), 'NULL')
           || '/'
           || coalesce((select scans::text from caps where plan = 'free'), 'NULL')
           || ' — NULL means UNLIMITED, so the paid analyser is free to everyone'
    end as result
),
paid_caps as (
  select
    'student_pro caps = 20 uploads, 40 scans' as check_name,
    case
      when not exists (select 1 from caps where plan = 'student_pro')
        then 'FAIL — no student_pro row'
      when exists (
        select 1 from caps where plan = 'student_pro' and uploads = 20 and scans = 40
      ) then 'PASS'
      else 'FAIL — student_pro is '
           || coalesce((select uploads::text from caps where plan = 'student_pro'), 'NULL')
           || '/'
           || coalesce((select scans::text from caps where plan = 'student_pro'), 'NULL')
           || ', expected 20/40'
    end as result
),
-- Confirms the trigger from part 1 actually fires, which only a real signup can
-- prove. Compares accounts against profiles rows.
profile_coverage as (
  select
    'every account has a profiles row' as check_name,
    case
      when (select count(*) from auth.users) = 0 then 'INFO — no accounts yet'
      when (
        select count(*) from auth.users u
        left join public.profiles p on p.id = u.id
        where p.id is null
      ) = 0 then 'PASS'
      else 'FAIL — '
           || (
             select count(*)::text from auth.users u
             left join public.profiles p on p.id = u.id
             where p.id is null
           )
           || ' account(s) with no profile. Re-run 018_backfill_profiles.sql'
    end as result
),
content as (
  select
    'stored content' as check_name,
    'INFO — '
    || (select count(*) from public.resumes)::text     || ' resume(s), '
    || (select count(*) from public.tracked_jobs)::text || ' tracked job(s), '
    || (select count(*) from public.prep_runs)::text    || ' prep run(s)' as result
),
all_checks as (
  select 1 as grp, * from free_caps
  union all select 1, * from paid_caps
  union all select 2, * from profile_coverage
  union all select 3, * from content
)
select check_name, result
  from all_checks
 order by case when result like 'FAIL%' then 0 else 1 end, grp, check_name;
