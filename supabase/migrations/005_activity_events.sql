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
