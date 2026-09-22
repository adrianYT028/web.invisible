-- Migration: 016_multi_provider_keys
-- Lets one user vault a key per AI provider instead of exactly one key total.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGES
--   `user_api_keys.user_id` is currently the PRIMARY KEY, which migration 008
--   chose deliberately: it enforced "at most one key per user" for free and made
--   `ON CONFLICT (user_id)` the replace path. That was right when Groq was the
--   only provider. It is now the thing preventing a user from bringing an OpenAI
--   or OpenRouter key alongside it.
--
--   So: add `provider`, and move the primary key to `(user_id, provider)`.
--
-- ---------------------------------------------------------------------------
-- WHY THE BACKFILL IS SAFE
--   Every existing row is a Groq key — that is the only kind the application has
--   ever been able to store. `default 'groq'` on a NOT NULL column therefore
--   labels the existing rows correctly rather than guessing, and because each
--   user has at most one row today, every one of them satisfies the new
--   composite key without deduplication.
--   
--   Verified before writing this: 7 rows, one per user, all Groq.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES NOT DO
--   It does not re-encrypt anything. The AES-256-GCM envelope in
--   src/lib/crypto/key-vault.ts binds no additional authenticated data, so a
--   ciphertext is not cryptographically tied to its user or its provider — a row
--   swap would decrypt cleanly and send the wrong key to the wrong provider.
--   Binding `user_id||provider` as GCM AAD is the correct hardening, but it
--   invalidates all 7 existing ciphertexts, so it needs a key-rotation pass
--   rather than a column addition. Left as follow-up work, recorded here so the
--   gap is known rather than assumed absent.

-- -----------------------------------------------------------------------------
-- 1. The provider column
-- -----------------------------------------------------------------------------

alter table public.user_api_keys
  add column if not exists provider text not null default 'groq';

comment on column public.user_api_keys.provider is
  'Which AI provider this key authenticates against. Values are constrained to '
  'the set src/lib/ai/providers.ts knows how to call — an unconstrained value '
  'would be a key we accept, store, and can never use.';

-- An allowlist, not free text. `profiles.plan` is free text and that has already
-- cost us: an unrecognised value there fails closed silently. Here the failure
-- would be worse — a stored key nothing can send anywhere — so the database
-- refuses it at write time.
--
-- Deliberately does NOT yet include 'anthropic'. Claude's native API is not
-- OpenAI-shaped (different endpoint, auth header, request body and response
-- shape), and the shipped desktop binaries parse responses by scanning for
-- `"content":`, which Anthropic's content-block reply does not contain. Until a
-- translation adapter exists, accepting an Anthropic key would mean storing a
-- credential we cannot honour. Claude is reachable today via 'openrouter', which
-- is OpenAI-shaped. Add 'anthropic' here in the same commit as its adapter.
alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;
alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in ('groq', 'openai', 'openrouter'));

-- -----------------------------------------------------------------------------
-- 2. Repoint the primary key
-- -----------------------------------------------------------------------------
--
-- Guarded rather than a bare ALTER: `add primary key` fails if one already
-- exists, so re-running this migration would error on an otherwise-correct
-- database. The catalogue lookup makes it idempotent.
--
-- The swap runs inside the implicit statement transaction of the migration, so
-- the table is never left without a primary key visible to another session.
do $$
declare
  pk_columns text;
begin
  select string_agg(a.attname, ',' order by k.ord)
    into pk_columns
    from pg_constraint c
    cross join unnest(c.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a
      on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'public.user_api_keys'::regclass
     and c.contype  = 'p';

  if pk_columns is null then
    -- No primary key at all (unexpected, but recoverable).
    alter table public.user_api_keys add primary key (user_id, provider);

  elsif pk_columns = 'user_id' then
    -- The migration-008 shape. Swap it.
    alter table public.user_api_keys drop constraint user_api_keys_pkey;
    alter table public.user_api_keys add primary key (user_id, provider);

  elsif pk_columns = 'user_id,provider' then
    -- Already migrated. Nothing to do.
    null;

  else
    raise exception
      'user_api_keys has an unexpected primary key (%). Refusing to guess.',
      pk_columns;
  end if;
end $$;

-- Listing a user's providers is the common read (the account page renders one
-- row per saved key), and the composite PK already leads with user_id, so no
-- extra index is needed for it.

-- -----------------------------------------------------------------------------
-- 3. RLS
-- -----------------------------------------------------------------------------
--
-- The four policies from migration 008 are all `user_id = auth.uid()`, which
-- stays correct for multiple rows per user without modification — a user may
-- touch every one of their own keys and none of anyone else's. Re-asserted here
-- so this migration is self-describing about the access model it leaves behind.

alter table public.user_api_keys enable row level security;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   -- Existing keys must all be labelled groq, one row per user:
--   select provider, count(*) from public.user_api_keys group by provider;
--   -- Expect: groq | 7
--
--   -- The primary key must now be composite:
--   select a.attname
--     from pg_constraint c
--     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
--    where c.conrelid = 'public.user_api_keys'::regclass and c.contype = 'p';
--   -- Expect: user_id, provider
--
--   -- The allowlist must reject an unusable provider:
--   update public.user_api_keys set provider = 'gemini' where false;
--   -- (use a real row id to actually exercise it)
