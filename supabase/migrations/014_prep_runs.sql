-- Migration: 014_prep_runs
-- The application pipeline: one action that prepares many jobs.
--
-- WHAT THIS REPLACES
--   The student's manual loop is: find a job, read the JD, guess whether your
--   resume fits, rewrite it, apply, then find someone to email. Repeated per job,
--   that is hours. The pieces to automate it already exist separately — job index
--   (013), profile extraction, match scoring, tailored rewrite. This migration adds
--   the missing part: a RUN that chains them over a batch of jobs and remembers
--   where it got to.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A QUEUE AND NOT A REQUEST
--   The measured provider allowance is 8000 tokens per MINUTE for the entire
--   platform, and preparing one job costs roughly 1,400 (job-description
--   extraction plus rewrite; the profile is extracted once and cached). So the
--   ceiling is about five jobs per minute across all users.
--
--   A ten-job run therefore takes minutes of wall clock. That cannot live in an
--   HTTP request: the function would time out, and a user watching a spinner for
--   two minutes assumes it is broken. So a run is a row, items are processed
--   incrementally, and the UI polls.
--
--   It also means a run must be RESUMABLE. Hitting the rate limit is normal, not
--   exceptional — an item that cannot be served right now stays queued and is
--   picked up by the next tick rather than being failed.

-- -----------------------------------------------------------------------------
-- prep_runs — one batch
-- -----------------------------------------------------------------------------

create table if not exists public.prep_runs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  -- The resume every item in this run is prepared against. If the user uploads a
  -- new resume they start a new run; mixing resumes inside one run would make the
  -- scores incomparable.
  resume_id      uuid not null references public.resumes(id) on delete cascade,

  status         text not null default 'queued',
  -- What the user asked for, so progress can be shown as a fraction.
  requested      int not null,

  error          text,

  created_at     timestamptz not null default now(),
  finished_at    timestamptz,

  constraint prep_runs_status_check
    check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  constraint prep_runs_requested_positive
    check (requested > 0 and requested <= 25),
  -- A finished run has an end time; an unfinished one does not.
  constraint prep_runs_finished_consistent
    check (
      (status in ('done', 'failed', 'cancelled') and finished_at is not null)
      or (status in ('queued', 'running') and finished_at is null)
    )
);

create index if not exists prep_runs_user_created_idx
  on public.prep_runs (user_id, created_at desc);

-- The tick queue: unfinished runs, oldest first.
create index if not exists prep_runs_active_idx
  on public.prep_runs (created_at)
  where status in ('queued', 'running');

alter table public.prep_runs enable row level security;

drop policy if exists prep_runs_select_own on public.prep_runs;
create policy prep_runs_select_own on public.prep_runs
  for select using (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- prep_items — one job inside a run
-- -----------------------------------------------------------------------------

create table if not exists public.prep_items (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.prep_runs(id) on delete cascade,
  -- Denormalised so RLS and the item queries do not need a join through the run.
  user_id        uuid not null references auth.users(id) on delete cascade,

  posting_id     uuid not null references public.job_postings(id) on delete cascade,

  status         text not null default 'queued',
  -- Populated on failure. A single item failing must not fail its run.
  error          text,

  -- The match report for this posting, produced by the same scan path the user
  -- gets at /resume, so the numbers are identical rather than a second opinion.
  scan_id        uuid references public.resume_scans(id) on delete set null,
  match_score    int,

  -- The cold email, held as a draft. NOTHING IS EVER SENT FROM THE PLATFORM: the
  -- user reviews and sends from their own account. A shared sending domain doing
  -- student cold outreach would be blacklisted within weeks, and the recipient
  -- never consented to us holding their address.
  email_subject  text,
  email_body     text,
  -- Where to send it, taken ONLY from what the posting itself publishes — a
  -- careers address or a recruiter named in the job description. Null when the
  -- posting names nobody, which is the honest answer.
  contact_hint   text,

  -- How many tokens this item cost, for cost observability.
  tokens_used    int not null default 0,

  created_at     timestamptz not null default now(),
  completed_at   timestamptz,

  constraint prep_items_status_check
    check (status in ('queued', 'running', 'done', 'skipped', 'failed')),
  constraint prep_items_match_score_range
    check (match_score is null or match_score between 0 and 100),
  -- A score without a scan has no provenance.
  constraint prep_items_score_needs_scan
    check ((scan_id is null) = (match_score is null))
);

-- One item per posting per run. Re-running the tick cannot duplicate work.
create unique index if not exists prep_items_run_posting_uidx
  on public.prep_items (run_id, posting_id);

create index if not exists prep_items_run_idx
  on public.prep_items (run_id, created_at);

-- The work queue: the next item to process.
create index if not exists prep_items_queued_idx
  on public.prep_items (run_id)
  where status = 'queued';

alter table public.prep_items enable row level security;

drop policy if exists prep_items_select_own on public.prep_items;
create policy prep_items_select_own on public.prep_items
  for select using (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Run progress, in one query.
-- -----------------------------------------------------------------------------
--
-- A view rather than counters on `prep_runs`: counters need updating from the
-- worker on every item and drift the moment one update is lost. Counting rows
-- cannot drift.
create or replace view public.prep_run_progress as
  select
    r.id            as run_id,
    r.user_id,
    r.status,
    r.requested,
    r.created_at,
    r.finished_at,
    count(i.*)                                        as items,
    count(i.*) filter (where i.status = 'done')       as done,
    count(i.*) filter (where i.status = 'failed')     as failed,
    count(i.*) filter (where i.status = 'skipped')    as skipped,
    count(i.*) filter (where i.status = 'queued')     as queued,
    coalesce(sum(i.tokens_used), 0)                   as tokens_used
  from public.prep_runs r
  left join public.prep_items i on i.run_id = r.id
  group by r.id;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   select * from public.prep_run_progress order by created_at desc limit 5;
--
-- The finished-consistency invariant must reject this:
--   insert into public.prep_runs (user_id, resume_id, requested, status)
--   values ('00000000-0000-0000-0000-000000000000',
--           '00000000-0000-0000-0000-000000000000', 5, 'done');
