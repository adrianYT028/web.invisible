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
