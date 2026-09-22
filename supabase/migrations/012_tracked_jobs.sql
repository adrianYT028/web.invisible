-- Migration: 012_tracked_jobs
-- The job tracker: one row per role a user is pursuing.
--
-- WHY THIS IS A TABLE AND NOT A SPREADSHEET EXPORT
--   The request was "record all those in sheets or somewhere easily accessible".
--   A spreadsheet is the wrong primary home for this data: it cannot show a match
--   score that updates when the resume changes, cannot re-run a scan, and cannot
--   link back to a report. So the tracker lives here and CSV is an EXPORT of it —
--   which opens directly in Excel and Google Sheets, so nothing is lost.
--
-- RELATIONSHIP TO `resume_scans`
--   A tracked job may carry `scan_id`, linking it to the match report for that
--   posting. `match_score` is denormalised alongside it, deliberately: the tracker
--   is sorted and exported by score, and a join per row for a list view is waste.
--   The scan reference is ON DELETE SET NULL so a scan expiring under the 90-day
--   retention policy does not delete the user's application history — losing the
--   record of a job you applied to because an analysis aged out would be an
--   obviously wrong outcome.

create table if not exists public.tracked_jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,

  -- Where this row came from. 'manual' is a user-pasted job; the others are
  -- public ATS job boards.
  source        text not null default 'manual',
  -- The ATS's own posting id, when there is one. Drives deduplication so a
  -- nightly poll cannot insert the same opening twice.
  external_id   text,

  company       text not null,
  job_title     text not null,
  location      text,
  is_remote     boolean not null default false,
  -- The apply link. Not a foreign key to anything; it is the thing the user
  -- actually clicks.
  url           text,

  -- Kept so a saved job can be re-scanned after the user edits their resume,
  -- without needing the original posting to still be online. Job postings are
  -- taken down constantly, and a tracker that loses the requirements when that
  -- happens cannot answer "why was I a poor match for this?".
  jd_text       text,

  status        text not null default 'saved',

  -- The match report for this posting, if one has been run.
  scan_id       uuid references public.resume_scans(id) on delete set null,
  match_score   int,

  notes         text,
  applied_at    timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint tracked_jobs_source_check
    check (source in ('manual', 'greenhouse', 'lever', 'ashby', 'adzuna')),
  -- A deliberately small, ordered pipeline. Adding a stage is a migration, which
  -- is the correct amount of friction: an ad-hoc free-text status column becomes
  -- forty spellings of "applied" within a month and can never be reported on.
  constraint tracked_jobs_status_check
    check (status in ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'archived')),
  constraint tracked_jobs_company_not_blank
    check (char_length(company) > 0),
  constraint tracked_jobs_title_not_blank
    check (char_length(job_title) > 0),
  constraint tracked_jobs_match_score_range
    check (match_score is null or match_score between 0 and 100),
  -- `match_score` without a scan is a number with no provenance; a scan without a
  -- score means the report was never read. Either both or neither.
  constraint tracked_jobs_score_needs_scan
    check ((scan_id is null) = (match_score is null)),
  -- A row cannot claim to have been applied to without a date, or carry a date
  -- while still sitting in 'saved'.
  constraint tracked_jobs_applied_at_consistent
    check (
      (status in ('saved', 'archived') and applied_at is null)
      or (status not in ('saved', 'archived') and applied_at is not null)
    )
);

-- One row per (user, source, posting). Partial because `external_id` is NULL for
-- manual entries, and a UNIQUE index would otherwise permit only one of them:
-- in Postgres, NULLs are distinct, but being explicit documents the intent.
create unique index if not exists tracked_jobs_user_source_external_uidx
  on public.tracked_jobs (user_id, source, external_id)
  where external_id is not null;

-- The list view: newest first, filtered by status.
create index if not exists tracked_jobs_user_created_idx
  on public.tracked_jobs (user_id, created_at desc);

create index if not exists tracked_jobs_user_status_idx
  on public.tracked_jobs (user_id, status);

alter table public.tracked_jobs enable row level security;

-- Read-own for the tracker UI and the CSV export. Writes go through the API
-- routes on the service-role client, matching every other table in this schema —
-- `match_score` and `scan_id` are derived values, and a client that could write
-- them could fabricate a match it never earned.
drop policy if exists tracked_jobs_select_own on public.tracked_jobs;
create policy tracked_jobs_select_own on public.tracked_jobs
  for select using (user_id = auth.uid());

-- public.set_updated_at() is defined in 008_user_api_keys.sql. Re-declared so
-- this migration is self-contained and order-safe.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists tracked_jobs_set_updated_at on public.tracked_jobs;
create trigger tracked_jobs_set_updated_at
  before update on public.tracked_jobs
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   select status, count(*) from public.tracked_jobs group by status order by status;
--
-- And confirm the applied_at invariant is actually enforced — this must FAIL:
--   insert into public.tracked_jobs (user_id, company, job_title, status)
--   values ('00000000-0000-0000-0000-000000000000', 'X', 'Y', 'applied');
