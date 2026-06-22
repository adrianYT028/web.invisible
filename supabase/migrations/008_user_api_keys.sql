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
