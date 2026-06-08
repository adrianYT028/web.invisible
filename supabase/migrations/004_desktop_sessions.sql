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
