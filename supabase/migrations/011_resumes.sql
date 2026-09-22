-- Migration: 011_resumes
-- Resume storage, extraction results, and per-job match scans.
--
-- WHY THIS EXISTS:
--   Phase 1 of the student job-search platform. The pipeline is
--       upload -> extract -> parse-quality gate -> match report -> rewrite
--   and this migration owns the two tables it persists to: `resumes` (one row
--   per uploaded document) and `resume_scans` (one row per resume x job
--   description analysis).
--
-- ---------------------------------------------------------------------------
-- PRIVACY POSTURE (read this before adding a column)
--
--   A resume is the densest piece of personal data this product will ever
--   hold: legal name, phone, email, postal address, education history,
--   employment history, and — for a student user base — often a person under
--   18. India's DPDP Act applies to all of it.
--
--   Three consequences are encoded structurally below rather than left to
--   application discipline:
--
--     1. RETENTION IS A COLUMN, NOT A POLICY DOC. `expires_at` is NOT NULL
--        with a 90-day default, so a row cannot be written without an expiry.
--        `public.delete_expired_resumes()` is the reaper; the scheduled job
--        that calls it is documented at the bottom of this file.
--
--     2. THE FILE NEVER BECOMES PUBLIC. Uploads live in the private `resumes`
--        Storage bucket, following the `releases` pattern from migration 010:
--        the bucket is private and objects are only ever handed out as
--        short-lived signed URLs.
--
--     3. NO CONTENT IN LOGS. `extracted_text` and `profile` live here and
--        nowhere else. They must never reach `api_usage`, `activity_events`,
--        or any log line. `api_usage` already forbids this by column list.
--
--   Do not add a column that copies resume content into another table.
--
-- ---------------------------------------------------------------------------
-- WHY `extracted_text` IS STORED AT ALL
--
--   It duplicates personal data, which the posture above argues against. It is
--   stored anyway because re-extraction is the single most expensive step in
--   the pipeline (a scanned PDF requires OCR) and a user scanning one resume
--   against eight jobs would otherwise pay that cost eight times. The
--   mitigation is that it expires with the row: `expires_at` covers the text,
--   the profile, and the file together.
--
-- ---------------------------------------------------------------------------
-- WHY SCORE WEIGHTS ARE NOT IN THIS SCHEMA
--
--   The five sub-scores are stored; the weights that combine them are not.
--   Weights are product tuning and will change; a migration per tweak is
--   absurd. But a report rendered months ago must still be interpretable, so
--   `weights_version` records which weight set produced `overall_score`.
--   The weights themselves live in src/lib/resume/scoring/weights.ts.

-- -----------------------------------------------------------------------------
-- resumes — one row per uploaded document.
-- -----------------------------------------------------------------------------

create table if not exists public.resumes (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,

  -- Private Storage coordinates (migration 010 pattern). Delivered to the
  -- browser only as a short-lived signed URL, never as a raw path.
  storage_bucket     text not null default 'resumes',
  storage_path       text not null,

  original_filename  text not null,
  mime_type          text not null,
  size_bytes         int  not null,

  -- sha256 of the uploaded bytes, lowercase hex. Two purposes:
  --   1. Idempotency — re-uploading the same file is a no-op, not a duplicate.
  --   2. Scan caching — the (resume, jd) uniqueness below keys off this row,
  --      so an unchanged resume never re-runs an identical scan.
  content_hash       text not null,

  -- Extraction lifecycle. `pending` is the only state written at upload time;
  -- everything else is set once extraction finishes or fails.
  extraction_status  text not null default 'pending',
  extraction_error   text,

  -- Extraction output. NULL until extraction succeeds.
  extracted_text     text,
  page_count         int,

  -- Deterministic layout diagnostics from the parse-quality checker: column
  -- layout suspicion, tables, image-only pages, headings found, date
  -- parseability. Shape is `ParseDiagnostics` in src/lib/resume/schema.ts.
  diagnostics        jsonb not null default '{}',

  -- Parse Integrity, 0-100. The one sub-score computed with no AI at all, and
  -- the gate for the rest of the pipeline: below the floor in
  -- src/lib/resume/scoring/weights.ts the scan is refused rather than scored,
  -- because scoring an unreadable parse produces a confident wrong answer.
  parse_integrity    int,

  -- The structured profile: skills, roles, dates, projects, education,
  -- bullets. THE shared object of the whole platform — job matching, cold
  -- mail, and interview prep are all views over this. Shape is owned by
  -- src/lib/resume/schema.ts and versioned by `profile_schema_version` so an
  -- older row stays readable after the schema moves.
  profile               jsonb,
  profile_schema_version int,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- DPDP retention. NOT NULL so a row cannot exist without an expiry.
  expires_at         timestamptz not null default (now() + interval '90 days'),

  constraint resumes_extraction_status_check
    check (extraction_status in ('pending', 'extracted', 'failed')),
  constraint resumes_storage_path_not_blank
    check (char_length(storage_path) > 0),
  constraint resumes_filename_not_blank
    check (char_length(original_filename) > 0),
  constraint resumes_content_hash_hex
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint resumes_size_positive
    check (size_bytes > 0),
  constraint resumes_page_count_positive
    check (page_count is null or page_count > 0),
  constraint resumes_parse_integrity_range
    check (parse_integrity is null or parse_integrity between 0 and 100),
  -- A row claiming successful extraction must carry the evidence of it. This is
  -- what lets the scan path trust `extraction_status` alone.
  constraint resumes_extracted_requires_text
    check (extraction_status <> 'extracted' or extracted_text is not null),
  constraint resumes_extracted_requires_parse_integrity
    check (extraction_status <> 'extracted' or parse_integrity is not null),
  constraint resumes_failed_requires_error
    check (extraction_status <> 'failed' or extraction_error is not null),
  -- A profile and its schema version travel together or not at all.
  constraint resumes_profile_versioned
    check ((profile is null) = (profile_schema_version is null)),
  constraint resumes_expires_after_created
    check (expires_at > created_at)
);

-- One row per (user, file contents). Makes re-upload idempotent and gives the
-- upload route a unique key to conflict-target.
create unique index if not exists resumes_user_content_hash_uidx
  on public.resumes (user_id, content_hash);

create index if not exists resumes_user_created_idx
  on public.resumes (user_id, created_at desc);

-- Drives the retention reaper.
create index if not exists resumes_expires_at_idx
  on public.resumes (expires_at);

alter table public.resumes enable row level security;

-- Read-own: the UI lists the caller's own resumes. Unlike `releases`, there is
-- no paywall to bypass here — the row describes the user's own document — so
-- read-own is correct and RLS is the enforcement.
--
-- All writes go through the service-role client in the API routes. There is
-- deliberately no insert/update/delete policy: a compromised anon key must not
-- be able to forge an `extracted` row (which would let it skip the parse gate)
-- or move `expires_at` (which would defeat retention).
drop policy if exists resumes_select_own on public.resumes;
create policy resumes_select_own on public.resumes
  for select using (user_id = auth.uid());

-- public.set_updated_at() is defined in 008_user_api_keys.sql. Re-declared with
-- `create or replace` so this migration is self-contained and order-safe.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists resumes_set_updated_at on public.resumes;
create trigger resumes_set_updated_at
  before update on public.resumes
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- resume_scans — one row per resume x job description analysis.
-- -----------------------------------------------------------------------------
--
-- The five sub-scores are stored individually and shown individually in the
-- report. The product deliberately does NOT present `overall_score` as "your
-- ATS score": no applicant tracking system publishes a score to candidates,
-- and claiming otherwise would be a false statement about a third party's
-- software. It is our match score, and the UI says so next to the number.
--
-- Auto-rejection that genuinely exists is knockout criteria on the application
-- form — work authorisation, location, years of experience — which is why
-- `knockout_risk` is its own sub-score rather than being folded into keywords.

create table if not exists public.resume_scans (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  resume_id            uuid not null references public.resumes(id) on delete cascade,

  -- The pasted job description. Phase 1 is paste-only: fetching a posting by
  -- URL would mean scraping job boards, which their terms generally forbid.
  jd_text              text not null,
  -- sha256 of the normalised JD text. With resume_id, the idempotency key.
  jd_hash              text not null,
  -- Best-effort, for the UI and later analytics. Never used for gating.
  jd_job_title         text,
  jd_company           text,

  -- The five sub-scores, 0-100 each. See src/lib/resume/scoring.
  parse_integrity      int not null,  -- mirrored from resumes at scan time
  requirement_coverage int not null,
  keyword_alignment    int not null,
  evidence_quality     int not null,
  knockout_risk        int not null,  -- 100 = no knockout risk detected

  overall_score        int not null,
  -- Which weight set produced `overall_score`. See the header note.
  weights_version      int not null,

  -- Full report: matched and missing requirements, per-bullet feedback,
  -- knockout warnings, and the tailored rewrite. Shape owned by
  -- src/lib/resume/schema.ts.
  report               jsonb not null default '{}',

  created_at           timestamptz not null default now(),

  constraint resume_scans_jd_not_blank
    check (char_length(jd_text) > 0),
  constraint resume_scans_jd_hash_hex
    check (jd_hash ~ '^[0-9a-f]{64}$'),
  constraint resume_scans_parse_integrity_range
    check (parse_integrity      between 0 and 100),
  constraint resume_scans_requirement_coverage_range
    check (requirement_coverage between 0 and 100),
  constraint resume_scans_keyword_alignment_range
    check (keyword_alignment    between 0 and 100),
  constraint resume_scans_evidence_quality_range
    check (evidence_quality     between 0 and 100),
  constraint resume_scans_knockout_risk_range
    check (knockout_risk        between 0 and 100),
  constraint resume_scans_overall_range
    check (overall_score        between 0 and 100),
  constraint resume_scans_weights_version_positive
    check (weights_version > 0)
);

-- Scanning the same resume against the same job twice returns the stored
-- report instead of paying for inference again. This is both a cost control and
-- the reason the scan route can be safely retried.
create unique index if not exists resume_scans_resume_jd_uidx
  on public.resume_scans (resume_id, jd_hash);

create index if not exists resume_scans_user_created_idx
  on public.resume_scans (user_id, created_at desc);

alter table public.resume_scans enable row level security;

-- Read-own for the report UI. Writes are service-role only: the scores are the
-- product, and a client that could write them could fabricate a 100.
drop policy if exists resume_scans_select_own on public.resume_scans;
create policy resume_scans_select_own on public.resume_scans
  for select using (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- feature_limits — resume caps.
-- -----------------------------------------------------------------------------
--
-- CAREFUL: in `feature_limits`, NULL means UNLIMITED (migration 007). Adding
-- nullable columns therefore hands every existing plan — including `free` —
-- unlimited access to the paid feature. The explicit UPDATE below is not
-- optional tidying; without it the resume analyser ships free to everyone.

alter table public.feature_limits
  add column if not exists max_resume_uploads_per_day int,
  add column if not exists max_resume_scans_per_day   int;

alter table public.feature_limits
  drop constraint if exists ru_range;
alter table public.feature_limits
  add constraint ru_range
  check (max_resume_uploads_per_day is null
         or max_resume_uploads_per_day between 0 and 1000000);

alter table public.feature_limits
  drop constraint if exists rs_range;
alter table public.feature_limits
  add constraint rs_range
  check (max_resume_scans_per_day is null
         or max_resume_scans_per_day between 0 and 1000000);

-- `free` gets a deliberate taster, not unlimited access. One upload and one
-- scan per day is enough to see a real parse verdict and a real match report on
-- one job, which is the honest version of a free tier: the value is visible
-- before payment, and the limit is volume rather than a blurred result.
update public.feature_limits
   set max_resume_uploads_per_day = 1,
       max_resume_scans_per_day   = 1
 where plan = 'free';

-- The paid tier. Generous rather than unlimited: uncapped LLM access on a
-- subscription is an unbounded liability if a single account is shared or
-- scripted. These numbers are far above genuine individual use.
insert into public.feature_limits (plan,
                                   max_questions_per_day,
                                   max_transcription_minutes_per_day,
                                   max_vision_per_day,
                                   max_resume_uploads_per_day,
                                   max_resume_scans_per_day)
values ('student_pro', null, null, null, 20, 40)
on conflict (plan) do nothing;

-- -----------------------------------------------------------------------------
-- Retention reaper.
-- -----------------------------------------------------------------------------
--
-- Deletes expired resume rows. `resume_scans` follows via ON DELETE CASCADE.
--
-- IMPORTANT: this removes DATABASE rows only. The uploaded FILES in the private
-- `resumes` Storage bucket are not reachable from SQL, so the returned paths
-- must be deleted from Storage by the caller. Losing that step leaves orphaned
-- personal data in the bucket after the row that pointed to it is gone — the
-- exact failure a DPDP deletion request would expose. The scheduled job is
-- responsible for both halves.
create or replace function public.delete_expired_resumes()
returns table (deleted_bucket text, deleted_path text)
language sql
security definer
set search_path = public
as $$
  delete from public.resumes
   where expires_at <= now()
  returning storage_bucket, storage_path;
$$;

revoke all on function public.delete_expired_resumes() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- MANUAL STEPS (not expressible in this migration)
-- -----------------------------------------------------------------------------
--
-- 1. Create the private Storage bucket, exactly as `releases` was created:
--      Supabase Studio -> Storage -> New bucket
--        Name:   resumes
--        Public: OFF        <- a public bucket here is a personal-data breach
--      Add no policies: the service-role client is the only writer, and reads
--      are issued as signed URLs by the API.
--
-- 2. Schedule the reaper daily and delete the returned Storage objects. A
--    Vercel Cron route is the fit here, because it can do both halves:
--      select * from public.delete_expired_resumes();
--      -> then storage.from(bucket).remove(paths) for every returned row.
--
-- 3. Verify the free-tier gate actually applied — if this returns NULLs, the
--    resume analyser is currently free for everyone:
--      select plan, max_resume_uploads_per_day, max_resume_scans_per_day
--        from public.feature_limits order by plan;
--    Expect: free = (1, 1), student_pro = (20, 40).
