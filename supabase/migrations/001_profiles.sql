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
