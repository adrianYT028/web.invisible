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
