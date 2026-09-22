-- GENERATED FILE — do not edit by hand.
-- Source: supabase/migrations/*.sql   Regenerate: node supabase/setup/build-dev-schema.mjs
-- Generated: 2026-09-14
--
-- Every migration, in order, as one transaction. Paste into the Supabase SQL
-- Editor of a NEW, EMPTY project and run once.
--
-- This does NOT create the two Storage buckets. Those cannot be made from SQL
-- and are step 4 of supabase/setup/README.md. Uploads fail without them.

begin;

-- ==========================================================================
-- 001_profiles.sql
-- ==========================================================================

-- Migration: 001_profiles
-- Creates the per-user profile row that holds plan and display name.
-- Adds a trigger so every new auth.users row automatically gets a profile.

-- Schema -------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  plan         text not null default 'free',
  display_name text,
  created_at   timestamptz not null default now()
);

-- Trigger ------------------------------------------------------------------
-- Whenever Supabase Auth creates a row in auth.users, insert a matching
-- profiles row with plan='free'. SECURITY DEFINER lets the trigger bypass RLS.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, plan)
  values (new.id, 'free')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Row Level Security ------------------------------------------------------

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());

-- INSERT/UPDATE/DELETE: no policy = denied for normal users.
-- Service role bypasses RLS entirely, so the API routes can still write.


-- ==========================================================================
-- 002_devices.sql
-- ==========================================================================

-- Migration: 002_devices
-- One row per (user, installed device). Lets us list and revoke devices later.

create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  device_id    text not null,
  device_name  text,
  os           text,
  app_version  text,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint devices_user_device_unique unique (user_id, device_id)
);

create index if not exists devices_user_id_idx on public.devices (user_id);

alter table public.devices enable row level security;

drop policy if exists devices_select_own on public.devices;
create policy devices_select_own on public.devices
  for select using (user_id = auth.uid());


-- ==========================================================================
-- 003_desktop_link_codes.sql
-- ==========================================================================

-- Migration: 003_desktop_link_codes
-- One-time tickets that bind a desktop install to a user account.
-- Stored as SHA-256 hash; never plaintext. Single-use; expire in 10 minutes.

create table if not exists public.desktop_link_codes (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  device_code_hash  text not null,
  device_id         text not null,
  expires_at        timestamptz not null,
  consumed_at       timestamptz,
  created_at        timestamptz not null default now()
);

-- Lookup index (also enforces no two unconsumed codes hash-collide).
create unique index if not exists desktop_link_codes_hash_uidx
  on public.desktop_link_codes (device_code_hash);

-- Helps the periodic cleanup job find expired-but-unconsumed rows.
create index if not exists desktop_link_codes_expires_idx
  on public.desktop_link_codes (expires_at)
  where consumed_at is null;

-- RLS: this table is internal. No client-side reads. Only service-role writes.
alter table public.desktop_link_codes enable row level security;
-- (deliberately no SELECT policy)


-- ==========================================================================
-- 004_desktop_sessions.sql
-- ==========================================================================

-- Migration: 004_desktop_sessions
-- One row per "this user is signed in on this device".
-- Refresh token is stored as SHA-256 hash; never plaintext.
-- 30-day default TTL set by the API on insert (expires_at column).

create table if not exists public.desktop_sessions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  device_id           text not null,
  refresh_token_hash  text not null,
  issued_at           timestamptz not null default now(),
  last_used_at        timestamptz,
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  ip_at_issue         text,
  user_agent          text
);

-- Refresh token hashes are unique (collisions across users would be a bug).
create unique index if not exists desktop_sessions_refresh_hash_uidx
  on public.desktop_sessions (refresh_token_hash);

-- Listing active sessions for /account "your devices" view.
create index if not exists desktop_sessions_user_active_idx
  on public.desktop_sessions (user_id, revoked_at);

alter table public.desktop_sessions enable row level security;

drop policy if exists desktop_sessions_select_own on public.desktop_sessions;
create policy desktop_sessions_select_own on public.desktop_sessions
  for select using (user_id = auth.uid());


-- ==========================================================================
-- 005_activity_events.sql
-- ==========================================================================

-- Migration: 005_activity_events
-- One row per user action. event_data is JSONB so new event types can be
-- added without schema changes (cold-mail, resume builder, etc.).
-- event_id is a client-generated UUIDv4 — INSERT ... ON CONFLICT (event_id)
-- DO NOTHING gives us idempotent batch upload (Property P5).

create table if not exists public.activity_events (
  id                  bigserial primary key,
  event_id            uuid not null,
  user_id             uuid not null references auth.users(id) on delete cascade,
  device_id           text,
  event_type          text not null,
  event_data          jsonb not null default '{}'::jsonb,
  occurred_at         timestamptz not null,
  server_received_at  timestamptz not null default now()
);

-- Idempotency key. Required for ON CONFLICT.
create unique index if not exists activity_events_event_id_uidx
  on public.activity_events (event_id);

-- Activity timeline view (most recent first).
create index if not exists activity_events_user_time_idx
  on public.activity_events (user_id, occurred_at desc);

alter table public.activity_events enable row level security;

drop policy if exists activity_events_select_own on public.activity_events;
create policy activity_events_select_own on public.activity_events
  for select using (user_id = auth.uid());


-- ==========================================================================
-- 006_api_usage.sql
-- ==========================================================================

-- Migration: 006_api_usage
-- Server-side log of AI API calls. Under BYO-only, the desktop emits an
-- ai_call_completed Activity_Event with the same fields and the API copies
-- those events into this table (so we keep the Activity_Events stream
-- separate from the analytics table even though they share data today).
--
-- The (user_id, endpoint, utc_date(occurred_at)) index supports per-day cap
-- counting when paid plans ship later.
--
-- Postgres rejects functional indexes whose expressions are not IMMUTABLE.
-- The plain `occurred_at::date` cast on a `timestamptz` is STABLE (not
-- IMMUTABLE) because its result depends on the session timezone. We pin
-- the timezone to UTC in a SQL helper marked IMMUTABLE so the day-rollover
-- is deterministic across all sessions and the index is allowed.

create or replace function public.utc_date(ts timestamptz)
returns date
language sql
immutable
parallel safe
as $$ select (ts at time zone 'UTC')::date $$;

create table if not exists public.api_usage (
  id                bigserial primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  device_id         text,
  endpoint          text not null,
  model             text,
  prompt_tokens     int not null default 0,
  completion_tokens int not null default 0,
  total_tokens      int not null default 0,
  latency_ms        int,
  status_code       int,
  occurred_at       timestamptz not null default now()
);

create index if not exists api_usage_user_time_idx
  on public.api_usage (user_id, occurred_at desc);

create index if not exists api_usage_user_endpoint_day_idx
  on public.api_usage (user_id, endpoint, public.utc_date(occurred_at));

alter table public.api_usage enable row level security;

drop policy if exists api_usage_select_own on public.api_usage;
create policy api_usage_select_own on public.api_usage
  for select using (user_id = auth.uid());


-- ==========================================================================
-- 007_feature_limits.sql
-- ==========================================================================

-- Migration: 007_feature_limits
-- Per-plan caps. NULL = unlimited (so we ship "everything free" today, but
-- the enforcement code path exists from day one. Adding ('pro', 1000, ...)
-- later flips paid limits without a code change).
--
-- This table is world-readable on purpose: it's not user data.

create table if not exists public.feature_limits (
  plan                              text primary key,
  max_questions_per_day             int,
  max_transcription_minutes_per_day int,
  max_vision_per_day                int,
  constraint plan_max_length        check (char_length(plan) <= 32),
  constraint q_range                check (max_questions_per_day             is null or max_questions_per_day             between 0 and 1000000),
  constraint t_range                check (max_transcription_minutes_per_day is null or max_transcription_minutes_per_day between 0 and 1000000),
  constraint v_range                check (max_vision_per_day                is null or max_vision_per_day                between 0 and 1000000)
);

-- Seed the only plan that exists today. NULLs mean unlimited.
insert into public.feature_limits (plan, max_questions_per_day,
                                   max_transcription_minutes_per_day,
                                   max_vision_per_day)
values ('free', null, null, null)
on conflict (plan) do nothing;

-- World-readable.
alter table public.feature_limits enable row level security;

drop policy if exists feature_limits_select_all on public.feature_limits;
create policy feature_limits_select_all on public.feature_limits
  for select using (true);


-- ==========================================================================
-- 008_user_api_keys.sql
-- ==========================================================================

-- Migration: 008_user_api_keys
-- Encrypted per-user Groq key vault (AES-256-GCM). The database holds
-- CIPHERTEXT ONLY: an actor with read access to this table cannot recover any
-- plaintext key without KEY_VAULT_SECRET (the Master_Key), which lives only in
-- a Vercel environment variable and never in Postgres (P8, P12, Req 8.1).
--
-- Binary fields are stored as base64 TEXT (not bytea) so the PostgREST/JS
-- client round-trips them as plain strings with no hex-escape decoding step,
-- matching how 003/004 store hashes as hex text.

create table if not exists public.user_api_keys (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  key_ciphertext  text not null,          -- base64 AES-256-GCM ciphertext
  key_nonce       text not null,          -- base64 96-bit IV, unique per encryption (P10)
  key_auth_tag    text not null,          -- base64 128-bit GCM auth tag
  key_version     int  not null,          -- Master_Key_Version (P11)
  last_four       text not null,          -- final 4 chars of plaintext (Req 1.10, 2.1)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint user_api_keys_version_min check (key_version >= 1),       -- Req 7.2
  constraint user_api_keys_last_four_len check (char_length(last_four) <= 4),
  constraint user_api_keys_no_plaintext_marker check (char_length(key_ciphertext) > 0)
);

-- user_id is the PRIMARY KEY, which already enforces "at most one key per
-- user" (Req 7.3) and makes ON CONFLICT (user_id) upsert the replace path
-- for Req 1.11.

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists user_api_keys_set_updated_at on public.user_api_keys;
create trigger user_api_keys_set_updated_at
  before update on public.user_api_keys
  for each row execute function public.set_updated_at();

alter table public.user_api_keys enable row level security;   -- Req 7.5

-- Per-user RLS: a user may touch ONLY their own row (Req 7.6, 7.7).
drop policy if exists user_api_keys_select_own on public.user_api_keys;
create policy user_api_keys_select_own on public.user_api_keys
  for select using (user_id = auth.uid());

drop policy if exists user_api_keys_insert_own on public.user_api_keys;
create policy user_api_keys_insert_own on public.user_api_keys
  for insert with check (user_id = auth.uid());

drop policy if exists user_api_keys_update_own on public.user_api_keys;
create policy user_api_keys_update_own on public.user_api_keys
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists user_api_keys_delete_own on public.user_api_keys;
create policy user_api_keys_delete_own on public.user_api_keys
  for delete using (user_id = auth.uid());


-- ==========================================================================
-- 009_payments.sql
-- ==========================================================================

-- Migration: 009_payments
-- Razorpay pay-to-download ledger + the derived download entitlement.
--
-- Money model (GST-EXCLUSIVE, decided 2026-08):
--   base  ₹99.00      =  9900 paise   <- the advertised price
--   GST   18% of base =  1782 paise
--   total ₹116.82     = 11682 paise   <- what Razorpay actually charges
--
-- ALL money is integer paise. There is no float/numeric column anywhere in
-- this migration on purpose: ₹116.82 is not representable in binary floating
-- point, and a rounding drift between what Razorpay captured and what we
-- recorded would be an unreconcilable ledger. The API layer
-- (src/lib/payments/pricing.ts) is the single source of the derivation; the
-- DB enforces only the STRUCTURAL invariants (total = base + gst, positivity)
-- so a future price change does not require a migration, while a payment row
-- that does not add up can never be written.
--
-- Why a separate `entitlements` table instead of reusing `profiles.plan`:
--   `plan` is reserved for the forthcoming subscription tiers. Overloading it
--   with the one-time download license would collide with those tiers the
--   moment they ship. `entitlements` is also the manual-override surface we
--   need for support comps and post-refund revocation.

-- -----------------------------------------------------------------------------
-- payments — one row per Razorpay order, whatever its outcome.
-- -----------------------------------------------------------------------------

create table if not exists public.payments (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  provider             text not null default 'razorpay',
  product              text not null default 'download_license',

  -- Razorpay identifiers. order_id exists from creation; payment_id only
  -- appears once the customer actually pays.
  razorpay_order_id    text not null,
  razorpay_payment_id  text,

  -- Integer paise only. See the header note.
  base_amount_paise    int  not null,
  gst_bps              int  not null,          -- basis points: 1800 = 18.00%
  gst_amount_paise     int  not null,
  total_amount_paise   int  not null,
  currency             text not null default 'INR',

  status               text not null default 'created',

  receipt              text,                  -- our idempotent receipt string
  notes                jsonb not null default '{}',
  failure_reason       text,                  -- Razorpay error_description

  created_at           timestamptz not null default now(),
  paid_at              timestamptz,
  failed_at            timestamptz,
  refunded_at          timestamptz,

  constraint payments_status_check
    check (status in ('created', 'paid', 'failed', 'refunded')),
  constraint payments_provider_check
    check (provider in ('razorpay')),
  -- India-only launch: a non-INR row would mean the checkout was misconfigured.
  constraint payments_currency_check
    check (currency = 'INR'),
  constraint payments_base_positive
    check (base_amount_paise > 0),
  constraint payments_gst_nonneg
    check (gst_amount_paise >= 0),
  constraint payments_gst_bps_range
    check (gst_bps >= 0 and gst_bps <= 10000),
  -- The load-bearing money invariant.
  constraint payments_total_is_base_plus_gst
    check (total_amount_paise = base_amount_paise + gst_amount_paise),
  -- A row cannot claim to be paid without the Razorpay payment id that proves
  -- it. This is what makes the entitlement grant auditable.
  constraint payments_paid_requires_payment_id
    check (status <> 'paid' or razorpay_payment_id is not null),
  constraint payments_paid_requires_paid_at
    check (status <> 'paid' or paid_at is not null),
  constraint payments_refunded_requires_refunded_at
    check (status <> 'refunded' or refunded_at is not null)
);

-- One payments row per Razorpay order. Makes the order-create path safely
-- retryable and gives the webhook a unique lookup key.
create unique index if not exists payments_razorpay_order_id_uidx
  on public.payments (razorpay_order_id);

-- THE idempotency key for webhook delivery. Razorpay retries webhooks, and
-- `payment.captured` can arrive more than once; this index makes a duplicate
-- grant impossible at the storage layer rather than only in application code.
create unique index if not exists payments_razorpay_payment_id_uidx
  on public.payments (razorpay_payment_id)
  where razorpay_payment_id is not null;

create index if not exists payments_user_created_idx
  on public.payments (user_id, created_at desc);

-- Supports "has this user ever paid" without scanning their whole history.
create index if not exists payments_user_paid_idx
  on public.payments (user_id)
  where status = 'paid';

alter table public.payments enable row level security;

-- Users may read their own payment history (receipts in /account). All writes
-- go through the service-role client in the API routes: there is deliberately
-- no insert/update/delete policy, so a compromised anon key cannot mint a
-- paid row and grant itself the download.
drop policy if exists payments_select_own on public.payments;
create policy payments_select_own on public.payments
  for select using (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- entitlements — what the user is currently allowed to do.
-- -----------------------------------------------------------------------------

create table if not exists public.entitlements (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  download_access       boolean not null default false,
  granted_by_payment_id uuid references public.payments(id) on delete set null,
  granted_at            timestamptz,
  revoked_at            timestamptz,
  revoked_reason        text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint entitlements_granted_requires_granted_at
    check (download_access = false or granted_at is not null)
);

alter table public.entitlements enable row level security;

-- Read-own so the /download page and /account can render entitlement state.
-- Writes are service-role only (webhook / verify / support tooling).
drop policy if exists entitlements_select_own on public.entitlements;
create policy entitlements_select_own on public.entitlements
  for select using (user_id = auth.uid());

-- public.set_updated_at() is defined in 008_user_api_keys.sql. Re-declared
-- with `create or replace` so this migration is self-contained and order-safe.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists entitlements_set_updated_at on public.entitlements;
create trigger entitlements_set_updated_at
  before update on public.entitlements
  for each row execute function public.set_updated_at();


-- ==========================================================================
-- 010_releases.sql
-- ==========================================================================

  -- Migration: 010_releases
  -- Release catalogue + download audit trail.
  --
  -- WHY THIS EXISTS (the bug it closes):
  --   Before this migration the installer URL was a hardcoded PUBLIC GitHub
  --   Releases asset, referenced in two places:
  --     1. SITE_META.downloadUrl, which reached the client bundle via
  --        <DownloadStarter url={...} /> on /download, and
  --     2. the JSON-LD SoftwareApplication block in layout.tsx, which is
  --        emitted in <head> on EVERY page and is therefore served to
  --        anonymous visitors and indexed by search engines.
  --   Any paywall built over that arrangement is bypassed by copying one URL.
  --   Binaries now live in a PRIVATE Supabase Storage bucket and are handed out
  --   only as short-lived signed URLs by /api/download/[platform], which checks
  --   `entitlements.download_access` first. This table maps a platform to the
  --   private object key; the key itself is never sent to a browser.
  --
  -- `storage_path` is intentionally NOT readable by end users: this table has
  -- RLS enabled with NO policies (the 003_desktop_link_codes pattern), so only
  -- the service-role client can read it. Public version metadata is exposed
  -- through /api/releases/latest, which selects an explicit column allowlist.

  create table if not exists public.releases (
    id                uuid primary key default gen_random_uuid(),

    platform          text not null,
    version           text not null,

    -- Private Supabase Storage coordinates. Never serialized to a client.
    storage_bucket    text not null default 'releases',
    storage_path      text not null,

    -- What the browser should save the file as, independent of the object key.
    file_name         text not null,
    file_size_bytes   bigint,
    sha256            text,                    -- lowercase hex, for verification

    min_os            text,                    -- e.g. 'Windows 10 2004'
    release_notes     text,

    -- Sparkle appcast signature, used when the macOS client ships. Unused today.
    ed25519_signature text,

    is_latest         boolean not null default false,
    published_at      timestamptz not null default now(),
    created_at        timestamptz not null default now(),

    -- macos is permitted now so the mac client needs no migration later, but
    -- nothing writes it yet (Windows-only launch).
    constraint releases_platform_check
      check (platform in ('windows', 'macos')),
    constraint releases_version_not_blank
      check (char_length(version) > 0),
    constraint releases_storage_path_not_blank
      check (char_length(storage_path) > 0),
    constraint releases_file_name_not_blank
      check (char_length(file_name) > 0),
    constraint releases_sha256_hex
      check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
    constraint releases_file_size_positive
      check (file_size_bytes is null or file_size_bytes > 0)
  );

  create unique index if not exists releases_platform_version_uidx
    on public.releases (platform, version);

  -- At most ONE current release per platform, enforced by the database rather
  -- than by remembering to clear the old flag. Promoting a new build must clear
  -- the previous `is_latest` in the same transaction or the insert is rejected —
  -- which is the desired failure mode (better than two "latest" Windows builds
  -- and a coin-flip download).
  create unique index if not exists releases_one_latest_per_platform_uidx
    on public.releases (platform)
    where is_latest;

  alter table public.releases enable row level security;
  -- No policies: service-role reads only. `storage_path` must not be reachable
  -- with the anon key even for a signed-in user.

  -- -----------------------------------------------------------------------------
  -- download_events — who fetched which build, and when.
  -- -----------------------------------------------------------------------------
  --
  -- A one-time ₹99 lifetime license creates an obvious sharing incentive: one
  -- account, one password, posted publicly. Signed URLs expire in minutes, but
  -- an account can be reused indefinitely. This table makes that visible — a
  -- single user_id pulling the installer from many IPs is the signal — and
  -- gives us the evidence needed before revoking an entitlement.

  create table if not exists public.download_events (
    id           bigserial primary key,
    user_id      uuid not null references auth.users(id) on delete cascade,
    release_id   uuid references public.releases(id) on delete set null,
    platform     text not null,
    version      text,
    ip           text,
    user_agent   text,
    created_at   timestamptz not null default now(),

    constraint download_events_platform_check
      check (platform in ('windows', 'macos'))
  );

  create index if not exists download_events_user_created_idx
    on public.download_events (user_id, created_at desc);

  -- Abuse review: "distinct IPs per user in the last N days".
  create index if not exists download_events_created_idx
    on public.download_events (created_at desc);

  alter table public.download_events enable row level security;

  drop policy if exists download_events_select_own on public.download_events;
  create policy download_events_select_own on public.download_events
    for select using (user_id = auth.uid());


-- ==========================================================================
-- 011_resumes.sql
-- ==========================================================================

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


-- ==========================================================================
-- 012_tracked_jobs.sql
-- ==========================================================================

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


-- ==========================================================================
-- 013_job_index.sql
-- ==========================================================================

-- Migration: 013_job_index
-- The job index: a company registry and a cache of their open postings.
--
-- WHY A CACHE AND NOT LIVE FETCHES
--   Matching a user's profile against postings means reading every description.
--   Fetching boards per request would mean hundreds of outbound calls inside one
--   page load, would hammer somebody else's API, and would make the feature fail
--   whenever a third party is slow. So a scheduled sync fills this table and
--   requests read locally.
--
-- WHY THIS IS SHARED, NOT PER-USER
--   Job postings are public business data. One row serves every user, which is
--   also what makes the sync affordable: one fetch per company per day rather
--   than per user. RLS therefore grants read to any authenticated user rather
--   than read-own — this is the only table in the schema where that is correct,
--   because it holds nobody's personal data.
--
-- COVERAGE IS A PROPERTY OF `job_companies`, NOT OF THE PLATFORMS
--   Verified live: Greenhouse, Lever and Ashby all serve full boards without auth
--   (PhonePe 64, Postman 66, Meesho 48, Mindtickle 21, CRED 14, Ashby 62). A
--   guessed list of 48 Indian companies found 7. That is the guess failing, not a
--   ceiling — growing this registry is the whole lever on coverage.

-- -----------------------------------------------------------------------------
-- job_companies — which boards to poll
-- -----------------------------------------------------------------------------

create table if not exists public.job_companies (
  id                uuid primary key default gen_random_uuid(),

  source            text not null,
  -- The board identifier in that platform's URL space.
  slug              text not null,
  name              text not null,

  -- Set false to stop polling without losing the postings already collected, and
  -- without losing the row's sync history.
  is_active         boolean not null default true,

  -- Rough hint used for ordering the sync and for surfacing India-relevant
  -- companies first. Not a filter: a US company with Bengaluru roles still matters.
  primary_region    text,

  last_synced_at    timestamptz,
  -- Last failure reason, or NULL after a success. A slug that 404s sits here
  -- rather than failing silently, which is how the wrong `slice` (a US pizza
  -- chain, not the Indian fintech) would have been caught earlier.
  last_sync_error   text,
  last_posting_count int not null default 0,

  created_at        timestamptz not null default now(),

  constraint job_companies_source_check
    check (source in ('greenhouse', 'lever', 'ashby')),
  constraint job_companies_slug_not_blank
    check (char_length(slug) > 0),
  constraint job_companies_name_not_blank
    check (char_length(name) > 0)
);

-- One registry row per board.
create unique index if not exists job_companies_source_slug_uidx
  on public.job_companies (source, slug);

-- The sync queue: least-recently-synced active companies first, NULLs first so a
-- newly added company is picked up on the next run.
create index if not exists job_companies_sync_queue_idx
  on public.job_companies (last_synced_at nulls first)
  where is_active;

alter table public.job_companies enable row level security;

-- Readable by any signed-in user; only the service role writes.
drop policy if exists job_companies_select_authenticated on public.job_companies;
create policy job_companies_select_authenticated on public.job_companies
  for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- job_postings — the cached openings
-- -----------------------------------------------------------------------------

create table if not exists public.job_postings (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.job_companies(id) on delete cascade,

  source         text not null,
  -- The platform's own posting id.
  external_id    text not null,

  title          text not null,
  location       text,
  is_remote      boolean not null default false,
  -- Denormalised because it is the primary filter for the launch market and
  -- recomputing a city regex across every row on every query is waste.
  is_india       boolean not null default false,

  url            text not null,
  -- Plain text, entity-decoded and tag-stripped. EMPTY for Ashby, whose public
  -- board does not return descriptions — recorded as empty rather than
  -- substituted from the title, because scoring an invented description would
  -- produce a confident wrong match.
  description    text not null default '',

  posted_at      timestamptz,

  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  -- Postings vanish from a board once filled. They are CLOSED, never deleted: a
  -- user who tracked or scanned this role must keep the record, and "this closed
  -- three days ago" is useful information.
  is_open        boolean not null default true,

  constraint job_postings_source_check
    check (source in ('greenhouse', 'lever', 'ashby')),
  constraint job_postings_title_not_blank
    check (char_length(title) > 0),
  constraint job_postings_url_not_blank
    check (char_length(url) > 0)
);

-- Idempotent sync: re-polling a board updates rows instead of duplicating them.
create unique index if not exists job_postings_source_external_uidx
  on public.job_postings (source, external_id);

-- The browse query: open India roles, newest first.
create index if not exists job_postings_open_india_idx
  on public.job_postings (is_india, posted_at desc nulls last)
  where is_open;

create index if not exists job_postings_company_idx
  on public.job_postings (company_id);

-- Closing pass after a sync: find rows for a company not seen in this run.
create index if not exists job_postings_last_seen_idx
  on public.job_postings (company_id, last_seen_at)
  where is_open;

alter table public.job_postings enable row level security;

drop policy if exists job_postings_select_authenticated on public.job_postings;
create policy job_postings_select_authenticated on public.job_postings
  for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- Seed: boards verified live against the real APIs
-- -----------------------------------------------------------------------------
--
-- Every slug below was fetched and returned a real board. Deliberately excluded:
-- `greenhouse/slice`, which resolves to a US pizza chain rather than the Indian
-- fintech of the same name — a reminder that slugs need verifying, not guessing.

insert into public.job_companies (source, slug, name, primary_region) values
  ('greenhouse', 'phonepe',    'PhonePe',    'india'),
  ('greenhouse', 'postman',    'Postman',    'india'),
  ('greenhouse', 'groww',      'Groww',      'india'),
  ('lever',      'meesho',     'Meesho',     'india'),
  ('lever',      'cred',       'CRED',       'india'),
  ('lever',      'mindtickle', 'Mindtickle', 'india'),
  ('greenhouse', 'stripe',     'Stripe',     'global'),
  ('greenhouse', 'airbnb',     'Airbnb',     'global'),
  ('greenhouse', 'coinbase',   'Coinbase',   'global'),
  ('greenhouse', 'reddit',     'Reddit',     'global'),
  ('greenhouse', 'asana',      'Asana',      'global'),
  ('greenhouse', 'dropbox',    'Dropbox',    'global'),
  ('greenhouse', 'discord',    'Discord',    'global'),
  ('greenhouse', 'robinhood',  'Robinhood',  'global')
on conflict (source, slug) do nothing;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   select source, count(*) from public.job_companies group by source;
--
-- After the first sync run:
--   select c.name, count(p.*) filter (where p.is_open) as open_roles,
--          count(p.*) filter (where p.is_open and p.is_india) as india_roles,
--          c.last_sync_error
--     from public.job_companies c
--     left join public.job_postings p on p.company_id = c.id
--    group by c.id, c.name, c.last_sync_error
--    order by india_roles desc;


-- ==========================================================================
-- 014_prep_runs.sql
-- ==========================================================================

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


-- ==========================================================================
-- 015_plan_expiry.sql
-- ==========================================================================

-- Migration: 015_plan_expiry
-- Gives a paid plan an end date, so a subscription can lapse.
--
-- ---------------------------------------------------------------------------
-- THE PROBLEM
--   `profiles.plan` (migration 001) is a bare text column with no notion of
--   time. Whatever is written to it is held forever. That is correct for the
--   one-time ₹99 desktop licence, and wrong for anything sold monthly: a
--   subscriber who stops paying keeps platform-funded Groq inference and the
--   full service bundle indefinitely, and there is no way to express the normal
--   state of a subscription — "paid through the end of this period".
--
--   Today that is latent rather than live, because nothing in the application
--   writes `profiles.plan` at all; the only way to become `student_pro` is a
--   manual UPDATE. This column is the prerequisite for giving the plan a real
--   purchase path, because a purchase has to grant access *for a period*.
--
-- ---------------------------------------------------------------------------
-- WHY A COLUMN AND NOT A SUBSCRIPTIONS TABLE
--   A separate table would be a second source of truth about who is entitled to
--   what, alongside `profiles.plan` and `entitlements.download_access`. There are
--   already two and the ambiguity is the problem, not the storage. Keeping the
--   expiry immediately beside the plan means a single row answers "what plan, and
--   until when", and there is no join that can disagree with itself.
--
--   When recurring billing arrives, the provider's subscription id belongs on the
--   `payments` ledger (migration 009), which already records provider ids. This
--   column stays the answer to "is it in force right now".
--
-- ---------------------------------------------------------------------------
-- WHY NULL MEANS PERPETUAL
--   Every row that exists when this migration runs has no expiry, and every one
--   of those users is entitled to what they have. If NULL meant "expired", adding
--   this column would instantly downgrade the entire user base — including the
--   author's own account. NULL therefore means "does not expire", which is both
--   the safe reading and the correct one for a comped or grandfathered account.
--
--   Note this is the OPPOSITE convention to `resumes.expires_at` (migration 011),
--   which is NOT NULL precisely so a resume cannot outlive its retention window.
--   The difference is deliberate: there, a missing expiry is a data-protection
--   failure; here, a missing expiry is a valid perpetual grant.
--
--   The resolution rule lives in `resolveEffectivePlan`
--   (src/lib/plans/services.ts) and is exclusive: `expires_at > now()` is in
--   force, `<= now()` has lapsed.

alter table public.profiles
  add column if not exists plan_expires_at timestamptz;

comment on column public.profiles.plan_expires_at is
  'When `plan` stops being in force. NULL means it does not expire (the correct '
  'reading for pre-existing rows, comps, and grandfathered accounts). Resolve '
  'the pair through resolveEffectivePlan() in src/lib/plans/services.ts — '
  'reading `plan` alone reports a lapsed subscriber as still paid.';

-- A free plan has nothing to expire, so an expiry on one is a contradiction that
-- would make `plan_expires_at` unreadable: is this a free user with a stale
-- timestamp, or a lapsed subscriber whose plan was already reset? Rejecting the
-- combination keeps the column's meaning single.
--
-- NOT VALID so the constraint applies to new and updated rows without requiring
-- a full-table scan to add, and without failing the migration if any row already
-- violates it. Validate separately once the data is known clean:
--   alter table public.profiles validate constraint profiles_free_plan_no_expiry;
alter table public.profiles
  drop constraint if exists profiles_free_plan_no_expiry;
alter table public.profiles
  add constraint profiles_free_plan_no_expiry
  check (plan <> 'free' or plan_expires_at is null)
  not valid;

-- Drives the lapse sweep below, and any "expiring soon" reminder. Partial: rows
-- with no expiry are the majority and are never the answer to "what is expiring".
create index if not exists profiles_plan_expires_at_idx
  on public.profiles (plan_expires_at)
  where plan_expires_at is not null;

-- -----------------------------------------------------------------------------
-- Lapse sweep
-- -----------------------------------------------------------------------------
--
-- Access control does NOT depend on this function. `resolveEffectivePlan` treats
-- an elapsed expiry as free at read time, so a lapsed subscriber loses access the
-- moment their expiry passes whether or not this has run. That ordering matters:
-- a cron that fails must never leave someone entitled to something they stopped
-- paying for.
--
-- What this does is normalise the stored row afterwards, so `plan` means "the
-- plan they have" rather than "the last plan they bought". Without it, lapsed
-- rows accumulate as `student_pro` with a past date and every query about the
-- paying user base has to know to filter on the expiry.
--
-- Returns the affected users so the caller can act on them — a "your plan ended"
-- email, or an analytics event.
--
-- The old values are captured in a CTE rather than taken from RETURNING, because
-- an UPDATE ... RETURNING yields the NEW row: `plan` would come back as the
-- literal 'free' this statement just wrote, and `plan_expires_at` as NULL, so the
-- caller would be told nothing about what actually lapsed. (`RETURNING OLD.*`
-- would express this directly but needs PostgreSQL 18.)
--
-- The data-modifying CTE is not referenced by the final SELECT, which is safe and
-- intentional: PostgreSQL executes data-modifying WITH clauses exactly once and
-- always to completion, whether or not the primary query reads their output.
--
-- `for update` locks the matched rows for the duration of the statement, so two
-- concurrent sweeps cannot both report the same user as having lapsed.
create or replace function public.lapse_expired_plans()
returns table (user_id uuid, lapsed_from text, expired_at timestamptz)
language sql
security definer
set search_path = public
as $$
  with expired as (
    select p.id, p.plan, p.plan_expires_at
      from public.profiles p
     where p.plan <> 'free'
       and p.plan_expires_at is not null
       and p.plan_expires_at <= now()
       for update
  ),
  lapsed as (
    update public.profiles p
       set plan            = 'free',
           plan_expires_at = null
      from expired e
     where p.id = e.id
    returning p.id
  )
  select e.id, e.plan, e.plan_expires_at from expired e;
$$;

-- Same posture as delete_expired_resumes(): callable only by the service role.
revoke all on function public.lapse_expired_plans() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   select id, plan, plan_expires_at from public.profiles order by plan;
--
-- The contradiction guard must reject this:
--   update public.profiles set plan_expires_at = now() + interval '30 days'
--    where plan = 'free';
--
-- A grant looks like this (what the payment webhook will do):
--   update public.profiles
--      set plan = 'student_pro',
--          plan_expires_at = coalesce(
--            greatest(plan_expires_at, now()), now()
--          ) + interval '30 days'
--    where id = '<user>';
--   -- greatest(...) so renewing early EXTENDS the term instead of truncating it.


-- ==========================================================================
-- 016_multi_provider_keys.sql
-- ==========================================================================

-- Migration: 016_multi_provider_keys
-- Lets one user vault a key per AI provider instead of exactly one key total.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGES
--   `user_api_keys.user_id` is currently the PRIMARY KEY, which migration 008
--   chose deliberately: it enforced "at most one key per user" for free and made
--   `ON CONFLICT (user_id)` the replace path. That was right when Groq was the
--   only provider. It is now the thing preventing a user from bringing an OpenAI
--   or OpenRouter key alongside it.
--
--   So: add `provider`, and move the primary key to `(user_id, provider)`.
--
-- ---------------------------------------------------------------------------
-- WHY THE BACKFILL IS SAFE
--   Every existing row is a Groq key — that is the only kind the application has
--   ever been able to store. `default 'groq'` on a NOT NULL column therefore
--   labels the existing rows correctly rather than guessing, and because each
--   user has at most one row today, every one of them satisfies the new
--   composite key without deduplication.
--   
--   Verified before writing this: 7 rows, one per user, all Groq.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES NOT DO
--   It does not re-encrypt anything. The AES-256-GCM envelope in
--   src/lib/crypto/key-vault.ts binds no additional authenticated data, so a
--   ciphertext is not cryptographically tied to its user or its provider — a row
--   swap would decrypt cleanly and send the wrong key to the wrong provider.
--   Binding `user_id||provider` as GCM AAD is the correct hardening, but it
--   invalidates all 7 existing ciphertexts, so it needs a key-rotation pass
--   rather than a column addition. Left as follow-up work, recorded here so the
--   gap is known rather than assumed absent.

-- -----------------------------------------------------------------------------
-- 1. The provider column
-- -----------------------------------------------------------------------------

alter table public.user_api_keys
  add column if not exists provider text not null default 'groq';

comment on column public.user_api_keys.provider is
  'Which AI provider this key authenticates against. Values are constrained to '
  'the set src/lib/ai/providers.ts knows how to call — an unconstrained value '
  'would be a key we accept, store, and can never use.';

-- An allowlist, not free text. `profiles.plan` is free text and that has already
-- cost us: an unrecognised value there fails closed silently. Here the failure
-- would be worse — a stored key nothing can send anywhere — so the database
-- refuses it at write time.
--
-- Deliberately does NOT yet include 'anthropic'. Claude's native API is not
-- OpenAI-shaped (different endpoint, auth header, request body and response
-- shape), and the shipped desktop binaries parse responses by scanning for
-- `"content":`, which Anthropic's content-block reply does not contain. Until a
-- translation adapter exists, accepting an Anthropic key would mean storing a
-- credential we cannot honour. Claude is reachable today via 'openrouter', which
-- is OpenAI-shaped. Add 'anthropic' here in the same commit as its adapter.
alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;
alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in ('groq', 'openai', 'openrouter'));

-- -----------------------------------------------------------------------------
-- 2. Repoint the primary key
-- -----------------------------------------------------------------------------
--
-- Guarded rather than a bare ALTER: `add primary key` fails if one already
-- exists, so re-running this migration would error on an otherwise-correct
-- database. The catalogue lookup makes it idempotent.
--
-- The swap runs inside the implicit statement transaction of the migration, so
-- the table is never left without a primary key visible to another session.
do $$
declare
  pk_columns text;
begin
  select string_agg(a.attname, ',' order by k.ord)
    into pk_columns
    from pg_constraint c
    cross join unnest(c.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a
      on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'public.user_api_keys'::regclass
     and c.contype  = 'p';

  if pk_columns is null then
    -- No primary key at all (unexpected, but recoverable).
    alter table public.user_api_keys add primary key (user_id, provider);

  elsif pk_columns = 'user_id' then
    -- The migration-008 shape. Swap it.
    alter table public.user_api_keys drop constraint user_api_keys_pkey;
    alter table public.user_api_keys add primary key (user_id, provider);

  elsif pk_columns = 'user_id,provider' then
    -- Already migrated. Nothing to do.
    null;

  else
    raise exception
      'user_api_keys has an unexpected primary key (%). Refusing to guess.',
      pk_columns;
  end if;
end $$;

-- Listing a user's providers is the common read (the account page renders one
-- row per saved key), and the composite PK already leads with user_id, so no
-- extra index is needed for it.

-- -----------------------------------------------------------------------------
-- 3. RLS
-- -----------------------------------------------------------------------------
--
-- The four policies from migration 008 are all `user_id = auth.uid()`, which
-- stays correct for multiple rows per user without modification — a user may
-- touch every one of their own keys and none of anyone else's. Re-asserted here
-- so this migration is self-describing about the access model it leaves behind.

alter table public.user_api_keys enable row level security;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   -- Existing keys must all be labelled groq, one row per user:
--   select provider, count(*) from public.user_api_keys group by provider;
--   -- Expect: groq | 7
--
--   -- The primary key must now be composite:
--   select a.attname
--     from pg_constraint c
--     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
--    where c.conrelid = 'public.user_api_keys'::regclass and c.contype = 'p';
--   -- Expect: user_id, provider
--
--   -- The allowlist must reject an unusable provider:
--   update public.user_api_keys set provider = 'gemini' where false;
--   -- (use a real row id to actually exercise it)


-- ==========================================================================
-- 017_preferred_provider.sql
-- ==========================================================================

-- Migration: 017_preferred_provider
-- Lets a user nominate which of their vaulted keys is the default.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NEEDED
--   The desktop app sends a model name and nothing else, and it is a shipped
--   binary that cannot be taught to send more. So when a request names a model we
--   do not recognise, the proxy has to decide whose key to spend.
--
--   With one vaulted key there is no decision. With several there is, and it
--   cannot be resolved at request time — the desktop app cannot be asked
--   mid-request. So the user answers once, in the account UI, and it is recorded
--   here.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A FLAG ON THE KEY, NOT A COLUMN ON `profiles`
--   `profiles.preferred_provider = 'openai'` would be a reference with no
--   referent: delete the OpenAI key and the preference survives, pointing at a
--   provider the user can no longer authenticate against. Every reader would then
--   need to re-check that a matching key still exists.
--
--   As a flag on `user_api_keys`, deleting the key deletes the preference. The
--   invariant is structural rather than maintained.
--
-- ---------------------------------------------------------------------------
-- THE DEFAULT IS "NO PREFERENCE", NOT A PROVIDER
--   `false` for every existing row. A user who has never been asked has not
--   answered, and inventing an answer for them would silently change which key
--   gets spent. The resolver treats "no preference" by falling back to a fixed
--   priority order that begins with Groq — which is exactly today's behaviour, so
--   nobody's requests move as a result of this migration.

alter table public.user_api_keys
  add column if not exists is_preferred boolean not null default false;

comment on column public.user_api_keys.is_preferred is
  'The key to use when a request names a model we cannot attribute to a specific '
  'provider. At most one per user, enforced by a partial unique index. All false '
  'means the user has not chosen; the resolver then uses its priority order.';

-- At most one preferred key per user.
--
-- A PARTIAL unique index, so the constraint applies only to the rows that claim
-- the preference. A plain unique index on (user_id, is_preferred) would instead
-- forbid a user from having two NON-preferred keys, which is the normal state and
-- would make adding a second key impossible.
create unique index if not exists user_api_keys_one_preferred_per_user
  on public.user_api_keys (user_id)
  where is_preferred;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   select user_id, provider, is_preferred from public.user_api_keys
--    order by user_id, provider;
--   -- Expect: every row false immediately after this migration.
--
--   -- The partial unique index must permit many non-preferred keys per user...
--   -- ...and reject a second preferred one:
--   --   update public.user_api_keys set is_preferred = true where user_id = '<u>';
--   -- With two or more rows for that user, this must fail.
--
--   -- Setting a preference is therefore a two-step write, and must be atomic:
--   --   begin;
--   --     update public.user_api_keys set is_preferred = false where user_id = '<u>';
--   --     update public.user_api_keys set is_preferred = true
--   --      where user_id = '<u>' and provider = '<p>';
--   --   commit;


-- ==========================================================================
-- 018_backfill_profiles.sql
-- ==========================================================================

-- Migration: 018_backfill_profiles
-- Creates the missing `profiles` rows for accounts that predate the trigger.
--
-- ---------------------------------------------------------------------------
-- WHAT WENT WRONG
--   Migration 001 created `public.profiles` and an `on_auth_user_created`
--   trigger that inserts a row whenever Supabase Auth creates a user. Triggers
--   only fire on NEW inserts, and nothing backfilled the accounts that already
--   existed when it was installed.
--
--   Measured before writing this: 97 auth users, 37 profiles, 60 missing. The
--   split is clean by signup month — every account from 2026-06 onward has a
--   profile, and none before it does. So the trigger is healthy; the gap is
--   entirely historical.
--
--   Four of the 60 have already paid for something.
--
-- ---------------------------------------------------------------------------
-- WHY IT LOOKED HARMLESS, AND WHY IT IS NOT
--   Every reader of `profiles.plan` treats a missing row as the free plan
--   (`readEffectivePlan` in src/lib/plans/read-plan.ts returns DEFAULT_PLAN when
--   the row is absent). So a missing profile costs those users nothing today, and
--   nothing errors — which is exactly why it went unnoticed for months.
--
--   It becomes a money bug the moment a plan is WRITTEN. An UPDATE against a
--   non-existent row affects zero rows and reports success, so a legacy customer
--   could buy the bundle, be charged, and receive no plan, with no error raised
--   anywhere in the stack. `grantBundleAccess` was written that way and has been
--   changed to an upsert; this migration removes the underlying condition rather
--   than relying on every future writer remembering it.
--
-- ---------------------------------------------------------------------------
-- WHY plan = 'free' IS THE CORRECT BACKFILL
--   It is what these users are ALREADY treated as. Inserting 'free' changes no
--   behaviour whatsoever — it makes the existing, implicit answer explicit. Any
--   other value would be inventing an entitlement nobody bought.
--
--   `plan_expires_at` is left NULL, which migration 015 defines as "does not
--   expire", and satisfies its `profiles_free_plan_no_expiry` constraint (a free
--   plan must carry no expiry).

insert into public.profiles (id, plan)
select u.id, 'free'
  from auth.users u
  left join public.profiles p on p.id = u.id
 where p.id is null
-- Belt and braces alongside the LEFT JOIN: if this migration is run twice, or
-- races the trigger for a signup happening right now, the second write is a
-- no-op instead of a unique violation that fails the whole migration.
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   -- Must return 0:
--   select count(*)
--     from auth.users u
--     left join public.profiles p on p.id = u.id
--    where p.id is null;
--
--   -- Nobody should have been granted anything by this migration:
--   select plan, count(*) from public.profiles group by plan order by plan;
--   -- Expect the paid-tier count to be UNCHANGED from before it ran.
--
--   -- And the free-plan expiry invariant must still hold:
--   select count(*) from public.profiles
--    where plan = 'free' and plan_expires_at is not null;
--   -- Expect 0.


-- ==========================================================================
-- 019_signups.sql
-- ==========================================================================

-- Migration: 019_signups
-- Brings the `signups` table into the migration history, and closes an
-- unauthenticated write hole on it.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
--
-- `public.signups` has been live in production since before this migration
-- directory did, and NO migration ever created it — it was made by hand in the
-- dashboard. Two consequences, both found by pointing local development at a
-- fresh database for the first time:
--
--   1. A new environment has no `signups` table at all, so every landing-page
--      visit by a signed-in user logs
--        [signups/ensure] upsert error: Could not find the table 'public.signups'
--      The route is deliberately non-fatal, so nothing broke loudly and nothing
--      got recorded either.
--
--   2. The schema was only knowable by introspecting production. A table no
--      migration describes cannot be reviewed, tested against, or recreated.
--
-- The shape below was read from production's PostgREST definition, not invented:
--
--     id          bigint       not null primary key
--     name        text         not null
--     email       public.citext not null
--     created_at  timestamptz  not null default timezone('utc', now())
--     user_id     uuid         null
--
-- ---------------------------------------------------------------------------
-- WHAT THE TABLE IS FOR
--
-- A marketing/contact list: the display name and email of everyone who has ever
-- signed in, upserted by `/api/signups/ensure` (called fire-and-forget by
-- HomeClient after auth). It deliberately duplicates `auth.users.email` because
-- `auth.users` is not queryable from the client and carries no display name.
--
-- Production holds 70 rows against 97 accounts — it is a partial list, which is
-- expected for something written fire-and-forget with errors swallowed.

-- `email` is citext so that Alice@x.com and alice@x.com are the same row. Without
-- it the ON CONFLICT (email) upsert below would create a second row per casing,
-- and the marketing list would double-count people. Matching production's schema,
-- the extension lives in `public`.
create extension if not exists citext with schema public;

create table if not exists public.signups (
  -- bigint identity rather than uuid, matching production. This is a mailing
  -- list, not a security boundary, and the ids are never exposed in a URL.
  id         bigint generated by default as identity primary key,
  name       text not null,
  email      public.citext not null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  -- NULLABLE, and deliberately WITHOUT a foreign key to auth.users, because
  -- production has neither.
  --
  -- The nullability is load-bearing for the legacy static site in `__ref/`, whose
  -- sign-up form upserts a row immediately after `signUp()` — before email
  -- confirmation, so there is no session and no confirmed user to reference yet.
  --
  -- A foreign key is NOT added here even though it would be better hygiene: this
  -- migration's purpose is to make dev match prod so schema changes can be tested
  -- before they are deployed, and silently tightening the shape would defeat that.
  -- Add it in a later migration, applied to both, if wanted.
  user_id    uuid
);

-- Required by the route's `upsert(..., { onConflict: 'email' })`. Without a unique
-- index on `email`, PostgREST rejects that request outright — so this constraint
-- is not hygiene, it is what makes the endpoint work at all.
create unique index if not exists signups_email_uidx on public.signups (email);

-- Looked up by user, on the ensure path.
create index if not exists signups_user_id_idx on public.signups (user_id)
  where user_id is not null;

comment on table public.signups is
  'Marketing/contact list: display name + email of everyone who has signed in. '
  'Upserted by /api/signups/ensure. Partial by design — written fire-and-forget.';

-- -----------------------------------------------------------------------------
-- SECURITY: this table accepted writes from anyone
-- -----------------------------------------------------------------------------
--
-- Measured against production with nothing but the publishable anon key:
--
--     anon SELECT -> 401  permission denied for table signups
--     anon INSERT -> 201  row created
--
-- So the table was readable by nobody and writable by everybody. Anyone who
-- viewed the site could read the anon key out of the page and insert unlimited
-- rows — junk names, other people's email addresses, or enough volume to make the
-- list useless. Nothing rate-limits it and nothing validates it.
--
-- That grant was not gratuitous: the legacy static site in `__ref/` upserts a
-- signup row directly from the browser straight after `signUp()`, which returns no
-- session when email confirmation is on. That call can only be anonymous.
--
-- The current Next.js app does not need it. `/api/signups/ensure` calls
-- `supabase.auth.getUser()` and returns 401 before touching the table, so every
-- write it makes is authenticated.
--
-- ---------------------------------------------------------------------------
-- APPLYING THIS TO PRODUCTION IS A BEHAVIOUR CHANGE. READ FIRST.
--
-- Everything above is inert on production, which already has the table. THIS
-- section is not: it revokes a grant production is currently relying on if any
-- unauthenticated writer still exists.
--
-- Verified safe for the deployed Next.js app. NOT safe if the `__ref/` static site
-- is still served anywhere — its sign-up form would stop recording names. Confirm
-- that first; `__ref/` is a reference copy in this repo, not a deployment target.
--
-- The service role bypasses RLS entirely, so admin reads, exports and the
-- existing 70 rows are unaffected.

alter table public.signups enable row level security;

-- Anonymous callers get nothing. This is the actual fix.
revoke all on public.signups from anon;

-- Authenticated users may see the row that is theirs — matched by id OR by email,
-- because rows created by the legacy anonymous path have a null `user_id` and are
-- only identifiable by address.
drop policy if exists signups_select_own on public.signups;
create policy signups_select_own on public.signups
  for select to authenticated
  using (
    user_id = auth.uid()
    or email = (auth.jwt() ->> 'email')::public.citext
  );

-- You may create only your own row, and only claiming your own identity: both the
-- uid and the address must be yours. Without the email check a signed-in user
-- could insert rows for arbitrary addresses under their own uid.
drop policy if exists signups_insert_own on public.signups;
create policy signups_insert_own on public.signups
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and email = (auth.jwt() ->> 'email')::public.citext
  );

-- The upsert's UPDATE half. `using` accepts a pre-existing row that carries your
-- address but no uid — that is exactly the row the legacy anonymous path left
-- behind, and claiming it is the point of the ensure endpoint. `with check`
-- then forces the result to be owned by you, so a claim cannot hand the row to
-- someone else.
drop policy if exists signups_update_own on public.signups;
create policy signups_update_own on public.signups
  for update to authenticated
  using (
    user_id = auth.uid()
    or email = (auth.jwt() ->> 'email')::public.citext
  )
  with check (
    user_id = auth.uid()
    and email = (auth.jwt() ->> 'email')::public.citext
  );

-- No DELETE policy: nothing in the product deletes a signup, and a mailing-list
-- row is not the user's own data to remove here — account deletion is the path
-- for that, and it runs as the service role.

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   -- Anon must now be refused. With the anon key:
--   --   POST /rest/v1/signups  -> 401/403, NOT 201
--
--   -- RLS on, three policies:
--   select relrowsecurity from pg_class
--    where relname = 'signups' and relnamespace = 'public'::regnamespace;
--   -- expect: true
--   select policyname, cmd from pg_policies
--    where tablename = 'signups' order by policyname;
--   -- expect: signups_insert_own INSERT, signups_select_own SELECT,
--   --         signups_update_own UPDATE
--
--   -- Case-insensitive uniqueness really applies:
--   --   two upserts differing only in case must leave ONE row.
--
--   -- And the real flow still records a row: sign in through the app, then
--   select count(*) from public.signups;


commit;
