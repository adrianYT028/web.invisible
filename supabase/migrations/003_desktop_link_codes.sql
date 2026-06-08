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
