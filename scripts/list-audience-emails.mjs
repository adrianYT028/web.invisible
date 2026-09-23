#!/usr/bin/env node
/**
 * Prints email addresses for one send segment, comma-separated and ready to
 * paste into a mail tool.
 *
 * One script for every segment rather than one per segment, because the
 * definitions are complements of each other: "free" is precisely "not paid", and
 * two files would eventually disagree about who is which. Someone would then be
 * in both lists, or neither.
 *
 *   paid   active licence      -> emails/01-paying-customers.*
 *   free   no active licence   -> emails/02-free-accounts.*
 *   all    every reachable account
 *
 * TWO FILTERS APPLY TO EVERY SEGMENT
 *
 *   revoked_at is null  — matching `hasDownloadAccess`. A refunded customer is
 *     not "paid". Filtering on `download_access` alone would put them in a
 *     thank-you send, and leave them out of the sales send, which is backwards.
 *
 *   email_confirmed_at is not null — an unconfirmed address is one nobody has
 *     proven they own. It may be a typo or somebody else's inbox, and mailing it
 *     is how a domain with no sending history earns a spam reputation.
 *
 * Usage:
 *   node scripts/list-audience-emails.mjs <env-file> <paid|free|all> [--exclude-own]
 */

import { readFileSync } from 'node:fs';

const [, , envFile, segment = 'all', ...flags] = process.argv;
const VALID = new Set(['paid', 'free', 'all']);

if (!envFile || !VALID.has(segment)) {
  console.error(
    'usage: node scripts/list-audience-emails.mjs <env-file> <paid|free|all> [--exclude-own]'
  );
  process.exit(2);
}

/**
 * The project's own accounts. Not customers; useful as test sends.
 *
 * `kartikbhat028@` is the proprietor — see `legalName` in
 * src/components/constants/business-info.ts. It was sitting in the 74-address
 * "safe to send" list, which would have counted the owner reading his own launch
 * email as an open.
 */
const OWN_ACCOUNTS = new Set([
  'join.invisibleai@gmail.com',
  'adriayt028@gmail.com',
  'kartikbhat028@gmail.com',
]);
const excludeOwn = flags.includes('--exclude-own');

const env = {};
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: key, Authorization: `Bearer ${key}` };

async function api(path) {
  const res = await fetch(`${url}${path}`, { headers });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function authUsers() {
  const out = [];
  for (let page = 1; ; page += 1) {
    const body = await api(`/auth/v1/admin/users?page=${page}&per_page=1000`);
    const batch = body.users ?? [];
    out.push(...batch);
    if (batch.length < 1000) return out;
  }
}

const [users, entitlements] = await Promise.all([
  authUsers(),
  api('/rest/v1/entitlements?select=user_id,granted_at,revoked_at,download_access'),
]);

const paidIds = new Set(
  entitlements
    .filter((e) => e.download_access === true && e.revoked_at === null)
    .map((e) => e.user_id)
);
const grantedAt = new Map(entitlements.map((e) => [e.user_id, e.granted_at]));

const withEmail = users.filter((u) => (u.email ?? '').trim());
const confirmed = withEmail.filter((u) => u.email_confirmed_at);
const unconfirmed = withEmail.filter((u) => !u.email_confirmed_at);

let selected = confirmed.filter((u) => {
  if (segment === 'paid') return paidIds.has(u.id);
  if (segment === 'free') return !paidIds.has(u.id);
  return true;
});

const ownInSegment = selected.filter((u) => OWN_ACCOUNTS.has(u.email.toLowerCase()));
if (excludeOwn) {
  selected = selected.filter((u) => !OWN_ACCOUNTS.has(u.email.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Junk detection
//
// A confirmed address is not automatically a real one. This list contains
// throwaways created while testing signup, and a disposable-domain address.
// They matter out of proportion to their number: a hard bounce is the single
// heaviest negative signal a mailbox provider records, and on a domain with no
// sending history a bounce rate near 10% is enough for Gmail to start filtering
// everything that follows. Eight dead addresses out of 82 is exactly that.
//
// So these are SEPARATED, not silently dropped — a heuristic on email addresses
// will misjudge real people, and the decision about a borderline address belongs
// to whoever recognises the name.
// ---------------------------------------------------------------------------

/** Local parts that are obviously scratch accounts, anchored so `asd` does not catch `asdhikari`. */
const TEST_LOCAL = /^(test\d*|testing\d*|qwe\d*|asd\d*|abc\d*|foo|bar|temp\d*|demo\d*|dummy\d*|sample\d*|delete\d*|xxx+|aaa+|asdf\w*|qwerty\w*)$/i;

/** Domains that exist to be thrown away. Mail to these is never read. */
const DISPOSABLE_DOMAINS = new Set([
  'davopa.com', 'mailinator.com', 'guerrillamail.com', 'yopmail.com',
  '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'trashmail.com',
  'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc',
  'fakeinbox.com', 'throwawaymail.com', 'mintemail.com', 'moakt.com',
]);

function junkReason(user) {
  const email = user.email.toLowerCase();
  const [local, domain] = email.split('@');
  if (TEST_LOCAL.test(local)) return 'test account';
  if (DISPOSABLE_DOMAINS.has(domain)) return `disposable domain (${domain})`;
  if (OWN_ACCOUNTS.has(email)) return 'your own account';
  // Never signed in after confirming: they clicked the link and never returned.
  // NOT junk on its own — plenty of real people do this, and they are a
  // legitimate audience for a "here is what is new" email. Reported only.
  return null;
}

// Sort BEFORE splitting. `clean` and `suspect` are separate arrays, so sorting
// `selected` afterwards leaves both in whatever order the API returned — which is
// newest-first, the opposite of what the batching advice below assumes.
//
// Oldest account first. Stable ordering matters when a send is split into
// batches: it makes "the first 40" mean the same thing on a re-run.
selected.sort(
  (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
);

const suspect = selected.filter((u) => junkReason(u));
const clean = selected.filter((u) => !junkReason(u));

console.log(`segment            ${segment}`);
console.log(`auth accounts      ${users.length}`);
console.log(`with an email      ${withEmail.length}`);
console.log(`confirmed          ${confirmed.length}`);
console.log(`EXCLUDED unconfirmed ${unconfirmed.length}`);
if (segment !== 'paid') {
  console.log(`active paid licences ${paidIds.size}`);
}
if (ownInSegment.length) {
  console.log(
    `own account(s) in segment: ${ownInSegment.map((u) => u.email).join(', ')}` +
      (excludeOwn ? '  -> EXCLUDED' : '  (pass --exclude-own to drop)')
  );
}
console.log(`\nSELECTED           ${selected.length}`);
console.log(`  safe to send     ${clean.length}`);
console.log(`  likely junk      ${suspect.length}   <- excluded from the list below\n`);

console.log('--- comma separated, SAFE TO SEND ---');
console.log(clean.map((u) => u.email).join(', '));

console.log('\n--- one per line, safe to send ---');
for (const u of clean) {
  const paid = paidIds.has(u.id)
    ? `  PAID ${(grantedAt.get(u.id) ?? '').slice(0, 10)}`
    : '';
  const dormant = u.last_sign_in_at ? '' : '  never signed in';
  console.log(`${u.email}${paid}${dormant}`);
}

if (suspect.length) {
  console.log('\n--- HELD BACK. Review these before including any of them ---');
  for (const u of suspect) {
    console.log(`${u.email}   ${junkReason(u)}`);
  }
  console.log(
    '\nA hard bounce is the heaviest negative signal a mailbox provider records.' +
      `\n${suspect.length} dead addresses in a ${selected.length}-address send is a ` +
      `${Math.round((suspect.length / selected.length) * 100)}% bounce rate, which is` +
      '\nenough for Gmail to start filtering everything sent afterwards.'
  );
}

if (unconfirmed.length) {
  console.log('\n--- excluded, email never confirmed. Do not mail these ---');
  for (const u of unconfirmed) console.log(u.email);
}
