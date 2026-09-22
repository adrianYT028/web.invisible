-- Migration: 015_plan_expiry
-- Gives a paid plan an end date, so a subscription can lapse.
--
-- ---------------------------------------------------------------------------
-- THE PROBLEM
--   `profiles.plan` (migration 001) is a bare text column with no notion of
--   time. Whatever is written to it is held forever. That is correct for the
--   one-time ₹99 desktop licence, and wrong for anything sold monthly: a
--   subscriber who stops paying keeps platform-funded Groq inference and the
--   full service bundle indefinitely, and there is no way to express the normal
--   state of a subscription — "paid through the end of this period".
--
--   Today that is latent rather than live, because nothing in the application
--   writes `profiles.plan` at all; the only way to become `student_pro` is a
--   manual UPDATE. This column is the prerequisite for giving the plan a real
--   purchase path, because a purchase has to grant access *for a period*.
--
-- ---------------------------------------------------------------------------
-- WHY A COLUMN AND NOT A SUBSCRIPTIONS TABLE
--   A separate table would be a second source of truth about who is entitled to
--   what, alongside `profiles.plan` and `entitlements.download_access`. There are
--   already two and the ambiguity is the problem, not the storage. Keeping the
--   expiry immediately beside the plan means a single row answers "what plan, and
--   until when", and there is no join that can disagree with itself.
--
--   When recurring billing arrives, the provider's subscription id belongs on the
--   `payments` ledger (migration 009), which already records provider ids. This
--   column stays the answer to "is it in force right now".
--
-- ---------------------------------------------------------------------------
-- WHY NULL MEANS PERPETUAL
--   Every row that exists when this migration runs has no expiry, and every one
--   of those users is entitled to what they have. If NULL meant "expired", adding
--   this column would instantly downgrade the entire user base — including the
--   author's own account. NULL therefore means "does not expire", which is both
--   the safe reading and the correct one for a comped or grandfathered account.
--
--   Note this is the OPPOSITE convention to `resumes.expires_at` (migration 011),
--   which is NOT NULL precisely so a resume cannot outlive its retention window.
--   The difference is deliberate: there, a missing expiry is a data-protection
--   failure; here, a missing expiry is a valid perpetual grant.
--
--   The resolution rule lives in `resolveEffectivePlan`
--   (src/lib/plans/services.ts) and is exclusive: `expires_at > now()` is in
--   force, `<= now()` has lapsed.

alter table public.profiles
  add column if not exists plan_expires_at timestamptz;

comment on column public.profiles.plan_expires_at is
  'When `plan` stops being in force. NULL means it does not expire (the correct '
  'reading for pre-existing rows, comps, and grandfathered accounts). Resolve '
  'the pair through resolveEffectivePlan() in src/lib/plans/services.ts — '
  'reading `plan` alone reports a lapsed subscriber as still paid.';

-- A free plan has nothing to expire, so an expiry on one is a contradiction that
-- would make `plan_expires_at` unreadable: is this a free user with a stale
-- timestamp, or a lapsed subscriber whose plan was already reset? Rejecting the
-- combination keeps the column's meaning single.
--
-- NOT VALID so the constraint applies to new and updated rows without requiring
-- a full-table scan to add, and without failing the migration if any row already
-- violates it. Validate separately once the data is known clean:
--   alter table public.profiles validate constraint profiles_free_plan_no_expiry;
alter table public.profiles
  drop constraint if exists profiles_free_plan_no_expiry;
alter table public.profiles
  add constraint profiles_free_plan_no_expiry
  check (plan <> 'free' or plan_expires_at is null)
  not valid;

-- Drives the lapse sweep below, and any "expiring soon" reminder. Partial: rows
-- with no expiry are the majority and are never the answer to "what is expiring".
create index if not exists profiles_plan_expires_at_idx
  on public.profiles (plan_expires_at)
  where plan_expires_at is not null;

-- -----------------------------------------------------------------------------
-- Lapse sweep
-- -----------------------------------------------------------------------------
--
-- Access control does NOT depend on this function. `resolveEffectivePlan` treats
-- an elapsed expiry as free at read time, so a lapsed subscriber loses access the
-- moment their expiry passes whether or not this has run. That ordering matters:
-- a cron that fails must never leave someone entitled to something they stopped
-- paying for.
--
-- What this does is normalise the stored row afterwards, so `plan` means "the
-- plan they have" rather than "the last plan they bought". Without it, lapsed
-- rows accumulate as `student_pro` with a past date and every query about the
-- paying user base has to know to filter on the expiry.
--
-- Returns the affected users so the caller can act on them — a "your plan ended"
-- email, or an analytics event.
--
-- The old values are captured in a CTE rather than taken from RETURNING, because
-- an UPDATE ... RETURNING yields the NEW row: `plan` would come back as the
-- literal 'free' this statement just wrote, and `plan_expires_at` as NULL, so the
-- caller would be told nothing about what actually lapsed. (`RETURNING OLD.*`
-- would express this directly but needs PostgreSQL 18.)
--
-- The data-modifying CTE is not referenced by the final SELECT, which is safe and
-- intentional: PostgreSQL executes data-modifying WITH clauses exactly once and
-- always to completion, whether or not the primary query reads their output.
--
-- `for update` locks the matched rows for the duration of the statement, so two
-- concurrent sweeps cannot both report the same user as having lapsed.
create or replace function public.lapse_expired_plans()
returns table (user_id uuid, lapsed_from text, expired_at timestamptz)
language sql
security definer
set search_path = public
as $$
  with expired as (
    select p.id, p.plan, p.plan_expires_at
      from public.profiles p
     where p.plan <> 'free'
       and p.plan_expires_at is not null
       and p.plan_expires_at <= now()
       for update
  ),
  lapsed as (
    update public.profiles p
       set plan            = 'free',
           plan_expires_at = null
      from expired e
     where p.id = e.id
    returning p.id
  )
  select e.id, e.plan, e.plan_expires_at from expired e;
$$;

-- Same posture as delete_expired_resumes(): callable only by the service role.
revoke all on function public.lapse_expired_plans() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- VERIFY
-- -----------------------------------------------------------------------------
--   select id, plan, plan_expires_at from public.profiles order by plan;
--
-- The contradiction guard must reject this:
--   update public.profiles set plan_expires_at = now() + interval '30 days'
--    where plan = 'free';
--
-- A grant looks like this (what the payment webhook will do):
--   update public.profiles
--      set plan = 'student_pro',
--          plan_expires_at = coalesce(
--            greatest(plan_expires_at, now()), now()
--          ) + interval '30 days'
--    where id = '<user>';
--   -- greatest(...) so renewing early EXTENDS the term instead of truncating it.
