-- Migration: 017_preferred_provider
-- Lets a user nominate which of their vaulted keys is the default.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NEEDED
--   The desktop app sends a model name and nothing else, and it is a shipped
--   binary that cannot be taught to send more. So when a request names a model we
--   do not recognise, the proxy has to decide whose key to spend.
--
--   With one vaulted key there is no decision. With several there is, and it
--   cannot be resolved at request time — the desktop app cannot be asked
--   mid-request. So the user answers once, in the account UI, and it is recorded
--   here.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A FLAG ON THE KEY, NOT A COLUMN ON `profiles`
--   `profiles.preferred_provider = 'openai'` would be a reference with no
--   referent: delete the OpenAI key and the preference survives, pointing at a
--   provider the user can no longer authenticate against. Every reader would then
--   need to re-check that a matching key still exists.
--
--   As a flag on `user_api_keys`, deleting the key deletes the preference. The
--   invariant is structural rather than maintained.
--
-- ---------------------------------------------------------------------------
-- THE DEFAULT IS "NO PREFERENCE", NOT A PROVIDER
--   `false` for every existing row. A user who has never been asked has not
--   answered, and inventing an answer for them would silently change which key
--   gets spent. The resolver treats "no preference" by falling back to a fixed
--   priority order that begins with Groq — which is exactly today's behaviour, so
--   nobody's requests move as a result of this migration.

alter table public.user_api_keys
  add column if not exists is_preferred boolean not null default false;

comment on column public.user_api_keys.is_preferred is
  'The key to use when a request names a model we cannot attribute to a specific '
  'provider. At most one per user, enforced by a partial unique index. All false '
  'means the user has not chosen; the resolver then uses its priority order.';

-- At most one preferred key per user.
--
-- A PARTIAL unique index, so the constraint applies only to the rows that claim
-- the preference. A plain unique index on (user_id, is_preferred) would instead
-- forbid a user from having two NON-preferred keys, which is the normal state and
-- would make adding a second key impossible.
create unique index if not exists user_api_keys_one_preferred_per_user
  on public.user_api_keys (user_id)
  where is_preferred;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   select user_id, provider, is_preferred from public.user_api_keys
--    order by user_id, provider;
--   -- Expect: every row false immediately after this migration.
--
--   -- The partial unique index must permit many non-preferred keys per user...
--   -- ...and reject a second preferred one:
--   --   update public.user_api_keys set is_preferred = true where user_id = '<u>';
--   -- With two or more rows for that user, this must fail.
--
--   -- Setting a preference is therefore a two-step write, and must be atomic:
--   --   begin;
--   --     update public.user_api_keys set is_preferred = false where user_id = '<u>';
--   --     update public.user_api_keys set is_preferred = true
--   --      where user_id = '<u>' and provider = '<p>';
--   --   commit;
