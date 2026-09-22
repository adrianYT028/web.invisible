-- Migration: 013_job_index
-- The job index: a company registry and a cache of their open postings.
--
-- WHY A CACHE AND NOT LIVE FETCHES
--   Matching a user's profile against postings means reading every description.
--   Fetching boards per request would mean hundreds of outbound calls inside one
--   page load, would hammer somebody else's API, and would make the feature fail
--   whenever a third party is slow. So a scheduled sync fills this table and
--   requests read locally.
--
-- WHY THIS IS SHARED, NOT PER-USER
--   Job postings are public business data. One row serves every user, which is
--   also what makes the sync affordable: one fetch per company per day rather
--   than per user. RLS therefore grants read to any authenticated user rather
--   than read-own — this is the only table in the schema where that is correct,
--   because it holds nobody's personal data.
--
-- COVERAGE IS A PROPERTY OF `job_companies`, NOT OF THE PLATFORMS
--   Verified live: Greenhouse, Lever and Ashby all serve full boards without auth
--   (PhonePe 64, Postman 66, Meesho 48, Mindtickle 21, CRED 14, Ashby 62). A
--   guessed list of 48 Indian companies found 7. That is the guess failing, not a
--   ceiling — growing this registry is the whole lever on coverage.

-- -----------------------------------------------------------------------------
-- job_companies — which boards to poll
-- -----------------------------------------------------------------------------

create table if not exists public.job_companies (
  id                uuid primary key default gen_random_uuid(),

  source            text not null,
  -- The board identifier in that platform's URL space.
  slug              text not null,
  name              text not null,

  -- Set false to stop polling without losing the postings already collected, and
  -- without losing the row's sync history.
  is_active         boolean not null default true,

  -- Rough hint used for ordering the sync and for surfacing India-relevant
  -- companies first. Not a filter: a US company with Bengaluru roles still matters.
  primary_region    text,

  last_synced_at    timestamptz,
  -- Last failure reason, or NULL after a success. A slug that 404s sits here
  -- rather than failing silently, which is how the wrong `slice` (a US pizza
  -- chain, not the Indian fintech) would have been caught earlier.
  last_sync_error   text,
  last_posting_count int not null default 0,

  created_at        timestamptz not null default now(),

  constraint job_companies_source_check
    check (source in ('greenhouse', 'lever', 'ashby')),
  constraint job_companies_slug_not_blank
    check (char_length(slug) > 0),
  constraint job_companies_name_not_blank
    check (char_length(name) > 0)
);

-- One registry row per board.
create unique index if not exists job_companies_source_slug_uidx
  on public.job_companies (source, slug);

-- The sync queue: least-recently-synced active companies first, NULLs first so a
-- newly added company is picked up on the next run.
create index if not exists job_companies_sync_queue_idx
  on public.job_companies (last_synced_at nulls first)
  where is_active;

alter table public.job_companies enable row level security;

-- Readable by any signed-in user; only the service role writes.
drop policy if exists job_companies_select_authenticated on public.job_companies;
create policy job_companies_select_authenticated on public.job_companies
  for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- job_postings — the cached openings
-- -----------------------------------------------------------------------------

create table if not exists public.job_postings (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.job_companies(id) on delete cascade,

  source         text not null,
  -- The platform's own posting id.
  external_id    text not null,

  title          text not null,
  location       text,
  is_remote      boolean not null default false,
  -- Denormalised because it is the primary filter for the launch market and
  -- recomputing a city regex across every row on every query is waste.
  is_india       boolean not null default false,

  url            text not null,
  -- Plain text, entity-decoded and tag-stripped. EMPTY for Ashby, whose public
  -- board does not return descriptions — recorded as empty rather than
  -- substituted from the title, because scoring an invented description would
  -- produce a confident wrong match.
  description    text not null default '',

  posted_at      timestamptz,

  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  -- Postings vanish from a board once filled. They are CLOSED, never deleted: a
  -- user who tracked or scanned this role must keep the record, and "this closed
  -- three days ago" is useful information.
  is_open        boolean not null default true,

  constraint job_postings_source_check
    check (source in ('greenhouse', 'lever', 'ashby')),
  constraint job_postings_title_not_blank
    check (char_length(title) > 0),
  constraint job_postings_url_not_blank
    check (char_length(url) > 0)
);

-- Idempotent sync: re-polling a board updates rows instead of duplicating them.
create unique index if not exists job_postings_source_external_uidx
  on public.job_postings (source, external_id);

-- The browse query: open India roles, newest first.
create index if not exists job_postings_open_india_idx
  on public.job_postings (is_india, posted_at desc nulls last)
  where is_open;

create index if not exists job_postings_company_idx
  on public.job_postings (company_id);

-- Closing pass after a sync: find rows for a company not seen in this run.
create index if not exists job_postings_last_seen_idx
  on public.job_postings (company_id, last_seen_at)
  where is_open;

alter table public.job_postings enable row level security;

drop policy if exists job_postings_select_authenticated on public.job_postings;
create policy job_postings_select_authenticated on public.job_postings
  for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- Seed: boards verified live against the real APIs
-- -----------------------------------------------------------------------------
--
-- Every slug below was fetched and returned a real board. Deliberately excluded:
-- `greenhouse/slice`, which resolves to a US pizza chain rather than the Indian
-- fintech of the same name — a reminder that slugs need verifying, not guessing.

insert into public.job_companies (source, slug, name, primary_region) values
  ('greenhouse', 'phonepe',    'PhonePe',    'india'),
  ('greenhouse', 'postman',    'Postman',    'india'),
  ('greenhouse', 'groww',      'Groww',      'india'),
  ('lever',      'meesho',     'Meesho',     'india'),
  ('lever',      'cred',       'CRED',       'india'),
  ('lever',      'mindtickle', 'Mindtickle', 'india'),
  ('greenhouse', 'stripe',     'Stripe',     'global'),
  ('greenhouse', 'airbnb',     'Airbnb',     'global'),
  ('greenhouse', 'coinbase',   'Coinbase',   'global'),
  ('greenhouse', 'reddit',     'Reddit',     'global'),
  ('greenhouse', 'asana',      'Asana',      'global'),
  ('greenhouse', 'dropbox',    'Dropbox',    'global'),
  ('greenhouse', 'discord',    'Discord',    'global'),
  ('greenhouse', 'robinhood',  'Robinhood',  'global')
on conflict (source, slug) do nothing;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   select source, count(*) from public.job_companies group by source;
--
-- After the first sync run:
--   select c.name, count(p.*) filter (where p.is_open) as open_roles,
--          count(p.*) filter (where p.is_open and p.is_india) as india_roles,
--          c.last_sync_error
--     from public.job_companies c
--     left join public.job_postings p on p.company_id = c.id
--    group by c.id, c.name, c.last_sync_error
--    order by india_roles desc;
