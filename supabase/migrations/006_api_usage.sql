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
