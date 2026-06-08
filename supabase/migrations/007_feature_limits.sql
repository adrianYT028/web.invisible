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
