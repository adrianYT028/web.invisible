-- Supabase schema for Invisible AI
-- Run in the Supabase SQL editor or psql against your project DB

create table if not exists signups (
  id bigserial primary key,
  name text not null,
  email text unique not null,
  user_id uuid,
  created_at timestamptz default timezone('utc', now()) not null
);

create table if not exists reviews (
  id bigserial primary key,
  email text not null,
  user_id uuid,
  rating int not null check (rating between 1 and 5),
  review text not null,
  source text default 'review',
  created_at timestamptz default timezone('utc', now()) not null
);

alter table signups add column if not exists user_id uuid;
alter table reviews add column if not exists user_id uuid;

-- Case-insensitive email uniqueness
create extension if not exists citext;
alter table signups alter column email type citext;
alter table reviews alter column email type citext;

create unique index if not exists signups_user_id_key on signups(user_id);

-- RLS on
alter table reviews enable row level security;
alter table signups enable row level security;

-- Allow inserts from authenticated users only (idempotent)
drop policy if exists "reviews_insert_only" on reviews;
drop policy if exists "signups_insert_only" on signups;
drop policy if exists "signups_update_self" on signups;

create policy "reviews_insert_only" on reviews
  for insert
  with check (auth.uid() = user_id);

create policy "signups_insert_only" on signups
  for insert
  with check (auth.uid() = user_id);

create policy "signups_update_self" on signups
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Optional: block select for anon explicitly
revoke select on reviews from anon;
revoke select on signups from anon;

-- Optional: if you want service role to read
-- grant select on reviews to service_role;
