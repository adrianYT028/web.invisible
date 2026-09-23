#!/usr/bin/env node
/**
 * Shows, for each account with any resume activity, their plan, today's usage and
 * the cap that applies.
 *
 * WHY
 *   "I upload a resume and nothing happens" has a boring explanation that looks
 *   exactly like a bug: the free plan allows ONE upload a day, and when it is spent
 *   `ResumeAnalyser` renders the file input with `disabled`. A disabled input
 *   swallows the click silently — the note explaining why is further down the page
 *   and easy to miss. So before debugging the uploader, check whether it was ever
 *   enabled.
 *
 * Usage: node scripts/check-resume-quota.mjs <env-file> [email]
 */

import { readFileSync } from 'node:fs';

const [, , envFile, onlyEmail] = process.argv;
if (!envFile) {
  console.error('usage: node scripts/check-resume-quota.mjs <env-file> [email]');
  process.exit(2);
}

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

// UTC day, matching `public.utc_date()` which the quota counter uses. Using local
// midnight here would report a different day than the database enforces.
const today = new Date().toISOString().slice(0, 10);

const [users, limits, resumes, scans] = await Promise.all([
  authUsers(),
  api('/rest/v1/feature_limits?select=*'),
  api(`/rest/v1/resumes?select=user_id,created_at,original_filename,parse_integrity&created_at=gte.${today}`),
  api(`/rest/v1/resume_scans?select=user_id,created_at&created_at=gte.${today}`),
  ]);

const emailOf = new Map(users.map((u) => [u.id, u.email]));
const profiles = await api('/rest/v1/profiles?select=id,plan');
const planOf = new Map(profiles.map((p) => [p.id, p.plan]));

const capFor = (plan) => {
  const row = limits.find((l) => l.plan === plan);
  return row ?? null;
};

console.log(`UTC day ${today}`);
console.log('\nfeature_limits:');
for (const l of limits) {
  console.log(`  ${String(l.plan).padEnd(14)} ${JSON.stringify(l)}`);
}

const active = new Map();
for (const r of resumes) {
  const e = active.get(r.user_id) ?? { uploads: 0, scans: 0, files: [] };
  e.uploads += 1;
  e.files.push(`${r.original_filename ?? '?'} (integrity ${r.parse_integrity ?? '?'})`);
  active.set(r.user_id, e);
}
for (const s of scans) {
  const e = active.get(s.user_id) ?? { uploads: 0, scans: 0, files: [] };
  e.scans += 1;
  active.set(s.user_id, e);
}

console.log(`\naccounts with resume activity today: ${active.size}`);
if (active.size === 0) {
  console.log('  none — so nobody has spent a quota today, and an upload that does');
  console.log('  nothing is NOT the daily cap.');
}

for (const [userId, e] of active) {
  const email = emailOf.get(userId) ?? userId;
  if (onlyEmail && email.toLowerCase() !== onlyEmail.toLowerCase()) continue;
  const plan = planOf.get(userId) ?? 'free (no row)';
  const cap = capFor(plan.startsWith('free') ? 'free' : plan);
  const uploadCap = cap?.resume_uploads_per_day ?? null;
  const scanCap = cap?.resume_scans_per_day ?? null;
  const spent = uploadCap !== null && e.uploads >= uploadCap;

  console.log(`\n  ${email}`);
  console.log(`    plan            ${plan}`);
  console.log(`    uploads today   ${e.uploads} / ${uploadCap ?? 'unlimited'}${spent ? '   <- SPENT. The file input is disabled.' : ''}`);
  console.log(`    scans today     ${e.scans} / ${scanCap ?? 'unlimited'}`);
  for (const f of e.files) console.log(`    uploaded        ${f}`);
}

// The specific accounts worth checking by name even with no activity today.
console.log('\nowner accounts, plan only:');
for (const email of ['kartikbhat028@gmail.com', 'adriayt028@gmail.com', 'join.invisibleai@gmail.com']) {
  const u = users.find((x) => (x.email ?? '').toLowerCase() === email);
  if (!u) continue;
  const plan = planOf.get(u.id) ?? 'free (no profiles row)';
  const e = active.get(u.id);
  console.log(
    `  ${email.padEnd(30)} plan=${String(plan).padEnd(12)} uploads today=${e?.uploads ?? 0} scans today=${e?.scans ?? 0}`
  );
}
