-- Migration: 018_backfill_profiles
-- Creates the missing `profiles` rows for accounts that predate the trigger.
--
-- ---------------------------------------------------------------------------
-- WHAT WENT WRONG
--   Migration 001 created `public.profiles` and an `on_auth_user_created`
--   trigger that inserts a row whenever Supabase Auth creates a user. Triggers
--   only fire on NEW inserts, and nothing backfilled the accounts that already
--   existed when it was installed.
--
--   Measured before writing this: 97 auth users, 37 profiles, 60 missing. The
--   split is clean by signup month — every account from 2026-06 onward has a
--   profile, and none before it does. So the trigger is healthy; the gap is
--   entirely historical.
--
--   Four of the 60 have already paid for something.
--
-- ---------------------------------------------------------------------------
-- WHY IT LOOKED HARMLESS, AND WHY IT IS NOT
--   Every reader of `profiles.plan` treats a missing row as the free plan
--   (`readEffectivePlan` in src/lib/plans/read-plan.ts returns DEFAULT_PLAN when
--   the row is absent). So a missing profile costs those users nothing today, and
--   nothing errors — which is exactly why it went unnoticed for months.
--
--   It becomes a money bug the moment a plan is WRITTEN. An UPDATE against a
--   non-existent row affects zero rows and reports success, so a legacy customer
--   could buy the bundle, be charged, and receive no plan, with no error raised
--   anywhere in the stack. `grantBundleAccess` was written that way and has been
--   changed to an upsert; this migration removes the underlying condition rather
--   than relying on every future writer remembering it.
--
-- ---------------------------------------------------------------------------
-- WHY plan = 'free' IS THE CORRECT BACKFILL
--   It is what these users are ALREADY treated as. Inserting 'free' changes no
--   behaviour whatsoever — it makes the existing, implicit answer explicit. Any
--   other value would be inventing an entitlement nobody bought.
--
--   `plan_expires_at` is left NULL, which migration 015 defines as "does not
--   expire", and satisfies its `profiles_free_plan_no_expiry` constraint (a free
--   plan must carry no expiry).

insert into public.profiles (id, plan)
select u.id, 'free'
  from auth.users u
  left join public.profiles p on p.id = u.id
 where p.id is null
-- Belt and braces alongside the LEFT JOIN: if this migration is run twice, or
-- races the trigger for a signup happening right now, the second write is a
-- no-op instead of a unique violation that fails the whole migration.
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   -- Must return 0:
--   select count(*)
--     from auth.users u
--     left join public.profiles p on p.id = u.id
--    where p.id is null;
--
--   -- Nobody should have been granted anything by this migration:
--   select plan, count(*) from public.profiles group by plan order by plan;
--   -- Expect the paid-tier count to be UNCHANGED from before it ran.
--
--   -- And the free-plan expiry invariant must still hold:
--   select count(*) from public.profiles
--    where plan = 'free' and plan_expires_at is not null;
--   -- Expect 0.
