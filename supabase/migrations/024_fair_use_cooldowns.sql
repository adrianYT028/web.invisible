-- Migration: 024_fair_use_cooldowns
--
-- Fair-use timeouts. Full access is ₹99 once and we pay for every AI call, so a
-- user whose AI use is far beyond normal (a script, a shared account, a bot) is
-- paused for a while instead of running an unbounded bill.
--
-- The rule lives in src/lib/plans/fair-use.ts. It counts the user's rows in
-- `api_usage` (every AI call is already logged there) over the last hour and the
-- last 24 hours. Over the limit -> a row here with `until` in the future:
--   1st strike in 24h: 1 hour, 2nd: 6 hours, 3rd and later: 24 hours.
-- While `until` is in the future, AI features answer 429 with a plain message.
-- Nothing else is affected: the tracker, saved data and downloads keep working.
--
-- To lift a timeout by hand:
--   delete from public.usage_cooldowns where user_id = '<uuid>';
-- To see who is currently paused:
--   select * from public.usage_cooldowns where until > now() order by until desc;

create table if not exists public.usage_cooldowns (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  until          timestamptz not null,
  strikes        int not null default 1,
  last_strike_at timestamptz not null default now(),
  -- Which limit was crossed, e.g. 'web_hour' or 'desktop_day'. For support only.
  reason         text not null,
  -- The counts at the moment of the strike, for support only.
  hour_count     int,
  day_count      int,
  constraint usage_cooldowns_strikes_positive check (strikes >= 1)
);

create index if not exists usage_cooldowns_until_idx on public.usage_cooldowns (until desc);

alter table public.usage_cooldowns enable row level security;
-- No policies: written and read by the service role only.
