-- Migration: 009_payments
-- Razorpay pay-to-download ledger + the derived download entitlement.
--
-- Money model (GST-EXCLUSIVE, decided 2026-08):
--   base  ₹99.00      =  9900 paise   <- the advertised price
--   GST   18% of base =  1782 paise
--   total ₹116.82     = 11682 paise   <- what Razorpay actually charges
--
-- ALL money is integer paise. There is no float/numeric column anywhere in
-- this migration on purpose: ₹116.82 is not representable in binary floating
-- point, and a rounding drift between what Razorpay captured and what we
-- recorded would be an unreconcilable ledger. The API layer
-- (src/lib/payments/pricing.ts) is the single source of the derivation; the
-- DB enforces only the STRUCTURAL invariants (total = base + gst, positivity)
-- so a future price change does not require a migration, while a payment row
-- that does not add up can never be written.
--
-- Why a separate `entitlements` table instead of reusing `profiles.plan`:
--   `plan` is reserved for the forthcoming subscription tiers. Overloading it
--   with the one-time download license would collide with those tiers the
--   moment they ship. `entitlements` is also the manual-override surface we
--   need for support comps and post-refund revocation.

-- -----------------------------------------------------------------------------
-- payments — one row per Razorpay order, whatever its outcome.
-- -----------------------------------------------------------------------------

create table if not exists public.payments (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  provider             text not null default 'razorpay',
  product              text not null default 'download_license',

  -- Razorpay identifiers. order_id exists from creation; payment_id only
  -- appears once the customer actually pays.
  razorpay_order_id    text not null,
  razorpay_payment_id  text,

  -- Integer paise only. See the header note.
  base_amount_paise    int  not null,
  gst_bps              int  not null,          -- basis points: 1800 = 18.00%
  gst_amount_paise     int  not null,
  total_amount_paise   int  not null,
  currency             text not null default 'INR',

  status               text not null default 'created',

  receipt              text,                  -- our idempotent receipt string
  notes                jsonb not null default '{}',
  failure_reason       text,                  -- Razorpay error_description

  created_at           timestamptz not null default now(),
  paid_at              timestamptz,
  failed_at            timestamptz,
  refunded_at          timestamptz,

  constraint payments_status_check
    check (status in ('created', 'paid', 'failed', 'refunded')),
  constraint payments_provider_check
    check (provider in ('razorpay')),
  -- India-only launch: a non-INR row would mean the checkout was misconfigured.
  constraint payments_currency_check
    check (currency = 'INR'),
  constraint payments_base_positive
    check (base_amount_paise > 0),
  constraint payments_gst_nonneg
    check (gst_amount_paise >= 0),
  constraint payments_gst_bps_range
    check (gst_bps >= 0 and gst_bps <= 10000),
  -- The load-bearing money invariant.
  constraint payments_total_is_base_plus_gst
    check (total_amount_paise = base_amount_paise + gst_amount_paise),
  -- A row cannot claim to be paid without the Razorpay payment id that proves
  -- it. This is what makes the entitlement grant auditable.
  constraint payments_paid_requires_payment_id
    check (status <> 'paid' or razorpay_payment_id is not null),
  constraint payments_paid_requires_paid_at
    check (status <> 'paid' or paid_at is not null),
  constraint payments_refunded_requires_refunded_at
    check (status <> 'refunded' or refunded_at is not null)
);

-- One payments row per Razorpay order. Makes the order-create path safely
-- retryable and gives the webhook a unique lookup key.
create unique index if not exists payments_razorpay_order_id_uidx
  on public.payments (razorpay_order_id);

-- THE idempotency key for webhook delivery. Razorpay retries webhooks, and
-- `payment.captured` can arrive more than once; this index makes a duplicate
-- grant impossible at the storage layer rather than only in application code.
create unique index if not exists payments_razorpay_payment_id_uidx
  on public.payments (razorpay_payment_id)
  where razorpay_payment_id is not null;

create index if not exists payments_user_created_idx
  on public.payments (user_id, created_at desc);

-- Supports "has this user ever paid" without scanning their whole history.
create index if not exists payments_user_paid_idx
  on public.payments (user_id)
  where status = 'paid';

alter table public.payments enable row level security;

-- Users may read their own payment history (receipts in /account). All writes
-- go through the service-role client in the API routes: there is deliberately
-- no insert/update/delete policy, so a compromised anon key cannot mint a
-- paid row and grant itself the download.
drop policy if exists payments_select_own on public.payments;
create policy payments_select_own on public.payments
  for select using (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- entitlements — what the user is currently allowed to do.
-- -----------------------------------------------------------------------------

create table if not exists public.entitlements (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  download_access       boolean not null default false,
  granted_by_payment_id uuid references public.payments(id) on delete set null,
  granted_at            timestamptz,
  revoked_at            timestamptz,
  revoked_reason        text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint entitlements_granted_requires_granted_at
    check (download_access = false or granted_at is not null)
);

alter table public.entitlements enable row level security;

-- Read-own so the /download page and /account can render entitlement state.
-- Writes are service-role only (webhook / verify / support tooling).
drop policy if exists entitlements_select_own on public.entitlements;
create policy entitlements_select_own on public.entitlements
  for select using (user_id = auth.uid());

-- public.set_updated_at() is defined in 008_user_api_keys.sql. Re-declared
-- with `create or replace` so this migration is self-contained and order-safe.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists entitlements_set_updated_at on public.entitlements;
create trigger entitlements_set_updated_at
  before update on public.entitlements
  for each row execute function public.set_updated_at();
