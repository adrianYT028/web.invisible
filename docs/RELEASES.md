# Releases & Payments Runbook

Operational steps for the pay-to-download flow. None of this is automated yet —
the code is in place, but a release is not downloadable until the manual steps
below are done.

## Why the installer is not on GitHub Releases anymore

The old flow served a public GitHub Releases URL. It was referenced in two
places — `SITE_META.downloadUrl` (which reached the **client bundle** via
`<DownloadStarter>`) and the JSON-LD block in `layout.tsx` (which renders in
`<head>` on **every page**, so it was served to anonymous visitors and indexed).

Any paywall over that arrangement is decorative: one paying customer copies one
URL and everyone else skips payment. Binaries now live in a **private** Supabase
Storage bucket and are only reachable through `/api/download/[platform]`, which
checks `entitlements.download_access` and returns a 5-minute signed URL.

Do not reintroduce a public asset URL. Link to `/download`.

---

## One-time setup

### 1. Run the migrations

```
supabase/migrations/009_payments.sql    -- payments, entitlements
supabase/migrations/010_releases.sql    -- releases, download_events
```

Both are additive. No existing table is altered.

### 2. Create the Storage bucket

In the Supabase dashboard → Storage → New bucket:

- Name: `releases`
- **Public bucket: OFF** — this is the whole point. If this is public, the
  paywall is bypassed again.

No bucket policies are needed. `releases` is read only by the service-role
client in `src/lib/releases.ts`.

### 3. Environment variables

Add to `.env.local` and to Vercel (all environments that take payments):

| Variable | Where to get it | Signs |
|---|---|---|
| `RAZORPAY_KEY_ID` | Razorpay Dashboard → Settings → API Keys | — (public-ish, sent to the browser) |
| `RAZORPAY_KEY_SECRET` | Same screen, shown once at generation | the **checkout** signature |
| `RAZORPAY_WEBHOOK_SECRET` | Set by you when creating the webhook | the **webhook** signature |

**These last two are different secrets signing different things.** Swapping them
fails every verification, and the symptom looks like "Razorpay isn't sending
webhooks" rather than a key mismatch. See the header comment in
`src/lib/payments/razorpay.ts`.

If they are absent, checkout degrades to `503 payment_not_configured` and the
rest of the site keeps working.

### 4. Register the webhook

Razorpay Dashboard → Settings → Webhooks → Add New Webhook:

- URL: `https://www.unviewable.online/api/payments/razorpay/webhook`
- Secret: the value you put in `RAZORPAY_WEBHOOK_SECRET`
- Active events: `payment.captured`, `payment.failed`, `refund.processed`

Anything else is acknowledged with `200 {ignored}` so Razorpay stops retrying.

The webhook — not the browser — is the authority on entitlement. A customer who
pays and immediately closes the tab still gets access.

### 5. Fill in the business details

Edit `src/components/constants/business-info.ts` and replace every value
prefixed `PLACEHOLDER:`. Razorpay's activation review checks the registered
name, address, phone, and email on `/contact`, and will reject placeholders.

```bash
grep -n "PLACEHOLDER:" src/components/constants/business-info.ts
```

While any remain, a warning banner renders on the legal pages **in development
only** (never in production, so don't rely on it).

Also have someone review `/terms`, `/privacy`, and `/refund`. They are drafts
written to match what the code actually does, not legal advice.

---

## Publishing a release

### 1. Upload the binary

Storage → `releases` → upload under a `windows/` prefix. Use a versioned object
name so old builds stay retrievable.

### 2. Compute the checksum

```bash
shasum -a 256 <installer>
```

Published on `/download` and via `/api/releases/latest` so users can verify a
build that now arrives through an opaque expiring URL.

### 3. Insert the row and promote it

`releases_one_latest_per_platform_uidx` allows **at most one** `is_latest` row
per platform, so the demotion and the promotion must happen in one transaction
or the insert is rejected. That is the intended failure mode — better than two
"latest" Windows builds and a coin-flip download.

```sql
begin;

update public.releases
   set is_latest = false
 where platform = 'windows' and is_latest;

insert into public.releases
  (platform, version, storage_path, file_name, file_size_bytes,
   sha256, min_os, release_notes, is_latest)
values
  ('windows',
   '2.1.0',
   'windows/<object-name-you-uploaded>',
   '<name-the-browser-should-save-it-as>',
   <bytes>,
   '<64-char-lowercase-hex>',
   'Windows 10 2004',
   'Release notes here.',
   true);

commit;
```

`sha256` is constrained to `^[0-9a-f]{64}$` — lowercase hex or the insert fails.

### 4. Bump the displayed version

`SITE_META.softwareVersion` in `src/components/constants/site-meta.ts` drives
the version pill on the home and downloads pages. It is not read from the
database yet, so it must be updated by hand to match.

### 5. Verify

```bash
# Public metadata, no auth, must NOT contain a URL or storage path
curl -s https://www.unviewable.online/api/releases/latest?platform=windows

# Unauthenticated download attempt -> 401
curl -si https://www.unviewable.online/api/download/windows | head -1
```

Then sign in as a user **without** an entitlement and confirm `/download` shows
checkout, not a download button.

---

## Pricing

Single source of truth: `src/lib/payments/pricing.ts`.

GST-**exclusive**: ₹99 advertised, 18% GST added at checkout, **₹116.82
charged**.

| | paise |
|---|---|
| Base | 9900 |
| GST (1800 bps) | 1782 |
| **Total charged** | **11682** |

Everything is integer paise. ₹116.82 is not exactly representable in binary
floating point, and a rounding drift between our record and the integer paise
Razorpay echoes back would make the ledger unreconcilable.

Every customer-facing surface must show the total or the full
`₹99 + 18% GST = ₹116.82` disclosure — never a bare "₹99" next to a Pay button.
A surprise delta at the payment sheet is the most common cause of abandoned
checkouts and disputes.

To change the price, edit `BASE_AMOUNT_PAISE`. No migration needed: the DB
enforces only `total = base + gst`, not a specific amount. Existing `payments`
rows keep the price they were charged, and in-flight orders are not reused
across a price change (the order route matches on exact total).

---

## Support tasks

**Refund.** Issue it in the Razorpay dashboard. The `refund.processed` webhook
marks the payment `refunded` and revokes `download_access` automatically. No
manual DB edit.

**Comp a licence** (support goodwill, tester):

```sql
insert into public.entitlements (user_id, download_access, granted_at)
values ('<auth.users.id>', true, now())
on conflict (user_id) do update
  set download_access = true, granted_at = now(),
      revoked_at = null, revoked_reason = null;
```

**Investigate licence sharing.** A one-time lifetime licence creates an obvious
incentive to share one account. Signed URLs expire in minutes, so the attack is
scripted re-generation — which `download_events` makes visible:

```sql
select user_id, count(distinct ip) as ips, count(*) as downloads
  from public.download_events
 where created_at > now() - interval '30 days'
 group by user_id
having count(distinct ip) > 5
 order by ips desc;
```

Then `revokeDownloadAccess(userId, reason)` — or the equivalent UPDATE — which
keeps the audit trail rather than deleting the row.

**Find a customer's payment.** Ask for the `pay_...` id from their receipt:

```sql
select * from public.payments where razorpay_payment_id = 'pay_...';
```

---

## Known gaps

- **No auto-update endpoint.** `/api/releases/latest` returns metadata only. The
  desktop client cannot self-update; a Sparkle-compatible appcast is needed for
  the macOS client and does not exist yet.
- **Windows only.** The schema and routes accept `macos`, but nothing writes it.
  `/api/download/macos` returns `404 release_not_found` until a row exists.
- **India only.** Razorpay international is not enabled, and `payments` has a
  `currency = 'INR'` check constraint. A non-INR order means the checkout was
  misconfigured.
- **Storage egress.** Supabase free tier allows 5 GB/month; a 50 MB installer
  exhausts that in ~100 downloads. Cloudflare R2 (zero egress fees) is the right
  home at real volume — swap the implementation of
  `createSignedDownloadUrl()`, which is the only function that knows where
  binaries live.
- **KV required in production.** `src/lib/ratelimit.ts` falls back to a
  per-process in-memory counter, which is ineffective on Vercel. Set
  `KV_REST_API_URL` / `KV_REST_API_TOKEN` or the order and download rate limits
  do nothing.
