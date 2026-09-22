// -----------------------------------------------------------------------------
// Seed the DEV database so the app is walkable locally.
// -----------------------------------------------------------------------------
//
//   node scripts/seed-dev.mjs
//   node scripts/seed-dev.mjs --reset     (delete the seed, then re-create it)
//
// Creates two accounts so both sides of the entitlement gate can be seen side by
// side, plus a small job index so /jobs and /jobs/discover are not empty pages
// that look broken.
//
// ---------------------------------------------------------------------------
// IT REFUSES TO RUN AGAINST PRODUCTION
//
// This writes users and grants a paid plan. Pointed at production that is a fake
// customer and a free upgrade in the real payments ledger, so the project ref is
// checked against an explicit allowlist before anything happens. A safety check
// that can be satisfied by editing .env.local is not a safety check, hence the
// hardcoded ref rather than "is this not prod".
//
// It does NOT seed resumes or prep runs. Both require real model calls
// (extraction, scoring, rewriting) and would spend Groq tokens on every run. Upload
// a resume through the UI instead — that is the flow worth exercising by hand.

import { readFileSync } from 'node:fs';

const DEV_REF = 'wzxuavsgwilahvkpbkps';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const URL_BASE = (env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ref = URL_BASE.replace(/^https:\/\//, '').split('.')[0];

if (ref !== DEV_REF) {
  console.error(
    `REFUSING TO RUN.\n` +
      `  .env.local points at project : ${ref || '(none)'}\n` +
      `  this script only ever touches: ${DEV_REF}\n\n` +
      `  It creates users and grants a paid plan. That does not belong in a real\n` +
      `  payments ledger.`
  );
  process.exit(1);
}

const H = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  'Content-Type': 'application/json',
};

const PASSWORD = 'devpassword123';
const ACCOUNTS = [
  { email: 'free@dev.local', plan: 'free', download: false },
  { email: 'paid@dev.local', plan: 'student_pro', download: true },
];

const reset = process.argv.includes('--reset');

async function api(path, init = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: { ...H, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return body;
}

async function findUser(email) {
  const body = await api(`/auth/v1/admin/users?per_page=200`);
  return (body.users ?? []).find((u) => u.email === email) ?? null;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------
if (reset) {
  console.log('--- reset ---');
  for (const { email } of ACCOUNTS) {
    const user = await findUser(email);
    if (user) {
      // Deleting the account cascades to profiles, entitlements and tracked_jobs.
      await api(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' });
      console.log(`  deleted ${email}`);
    }
  }
  // Seeded companies cascade to their postings.
  await api(`/rest/v1/job_companies?source=eq.greenhouse&slug=like.dev-seed-*`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
  console.log('  deleted seeded job companies and their postings');
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
console.log('--- accounts ---');
const ids = {};

for (const { email, plan, download } of ACCOUNTS) {
  let user = await findUser(email);

  if (!user) {
    user = await api('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
    });
    console.log(`  created ${email}`);
  } else {
    console.log(`  exists  ${email}`);
  }
  ids[email] = user.id;

  // The signup trigger already made a free profile; PATCH it to the target plan.
  // plan_expires_at stays null: migration 015 reads null as "does not expire",
  // and the profiles_free_plan_no_expiry constraint forbids an expiry on free.
  await api(`/rest/v1/profiles?id=eq.${user.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ plan, plan_expires_at: null }),
  });

  // The legacy ₹99 desktop licence lives here, separate from the plan, which is
  // why a bundle subscriber and a one-time buyer both reach the desktop app.
  await api('/rest/v1/entitlements', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      user_id: user.id,
      download_access: download,
      granted_at: download ? new Date().toISOString() : null,
    }),
  });

  console.log(`          plan=${plan} download_access=${download}`);
}

// ---------------------------------------------------------------------------
// Job index — so /jobs/discover has something to show
// ---------------------------------------------------------------------------
console.log('--- job index ---');

const COMPANIES = [
  { slug: 'dev-seed-zenpay', name: 'Zenpay Technologies', primary_region: 'IN' },
  { slug: 'dev-seed-lumen', name: 'Lumen Analytics', primary_region: 'IN' },
  { slug: 'dev-seed-northwind', name: 'Northwind Cloud', primary_region: 'US' },
];

const companyIds = {};
for (const c of COMPANIES) {
  const existing = await api(
    `/rest/v1/job_companies?source=eq.greenhouse&slug=eq.${c.slug}&select=id`
  );
  if (existing.length > 0) {
    companyIds[c.slug] = existing[0].id;
    continue;
  }
  const [row] = await api('/rest/v1/job_companies', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...c, source: 'greenhouse', is_active: true }),
  });
  companyIds[c.slug] = row.id;
}
console.log(`  ${Object.keys(companyIds).length} companies`);

// Descriptions are deliberately real-ish: `startPrepRun` skips any posting whose
// description is empty, so a blank one would make the prep flow look broken.
const POSTINGS = [
  {
    slug: 'dev-seed-zenpay',
    title: 'Backend Engineering Intern',
    location: 'Bengaluru, India',
    is_india: true,
    description:
      'We are looking for a backend intern to work on payment reconciliation. ' +
      'Requirements: Python or TypeScript, SQL and relational modelling, REST APIs, ' +
      'Git. Nice to have: Postgres, Redis, Docker, experience writing tests. ' +
      'You will build internal services, add integration tests, and help reduce ' +
      'API latency. Final-year students and recent graduates welcome.',
  },
  {
    slug: 'dev-seed-zenpay',
    title: 'Junior Platform Engineer',
    location: 'Remote, India',
    is_remote: true,
    is_india: true,
    description:
      'Join the platform team to maintain CI pipelines and container images. ' +
      'Requirements: Linux, Docker, one scripting language, basic networking. ' +
      'Nice to have: Kubernetes, Terraform, GitHub Actions, Prometheus. ' +
      'You will own build tooling and improve deploy times.',
  },
  {
    slug: 'dev-seed-lumen',
    title: 'Data Analyst (Entry Level)',
    location: 'Pune, India',
    is_india: true,
    description:
      'Analyse product usage and build dashboards for the growth team. ' +
      'Requirements: SQL, spreadsheets, one of Python or R, clear written ' +
      'communication. Nice to have: dbt, Looker, statistics coursework. ' +
      'You will define metrics and present findings to non-technical partners.',
  },
  {
    slug: 'dev-seed-lumen',
    title: 'Machine Learning Intern',
    location: 'Hyderabad, India',
    is_india: true,
    description:
      'Work with the ML team on document extraction models. Requirements: ' +
      'Python, NumPy, one deep-learning framework, understanding of evaluation ' +
      'metrics. Nice to have: PyTorch, HuggingFace, NER experience, published ' +
      'coursework. You will run experiments and report results.',
  },
  {
    slug: 'dev-seed-northwind',
    title: 'Software Engineer I',
    location: 'Remote',
    is_remote: true,
    description:
      'Build customer-facing features on a TypeScript and Postgres stack. ' +
      'Requirements: 0-2 years experience, JavaScript or TypeScript, HTTP APIs, ' +
      'relational databases. Nice to have: React, Next.js, AWS. You will ship ' +
      'features end to end with review from senior engineers.',
  },
];

let inserted = 0;
for (const [i, p] of POSTINGS.entries()) {
  const externalId = `dev-seed-${i + 1}`;
  const existing = await api(
    `/rest/v1/job_postings?source=eq.greenhouse&external_id=eq.${externalId}&select=id`
  );
  if (existing.length > 0) continue;

  await api('/rest/v1/job_postings', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      company_id: companyIds[p.slug],
      source: 'greenhouse',
      external_id: externalId,
      title: p.title,
      location: p.location,
      is_remote: p.is_remote ?? false,
      is_india: p.is_india ?? false,
      url: `https://example.com/jobs/${externalId}`,
      description: p.description,
      // Recent, because ranking and the "new this week" framing both read this.
      posted_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
      is_open: true,
    }),
  });
  inserted++;
}
console.log(`  ${inserted} new postings (${POSTINGS.length} total in the seed)`);

// ---------------------------------------------------------------------------
// Tracked jobs for the paid account — so /jobs is not an empty tracker
// ---------------------------------------------------------------------------
console.log('--- tracked jobs ---');
const paidId = ids['paid@dev.local'];

// NO match_score here, deliberately.
//
// `tracked_jobs_score_needs_scan` enforces `(scan_id is null) = (match_score is
// null)`: a score without a scan is a number with no provenance. Faking one would
// mean inventing a resume_scans row with an empty report, which is exactly the
// drift the constraint exists to stop. A seeded tracker therefore shows no scores
// until a real scan produces one — which is also what a new user actually sees.
const TRACKED = [
  { company: 'Zenpay Technologies', job_title: 'Backend Engineering Intern', location: 'Bengaluru, India', status: 'applied', notes: 'Referred by a senior from college.' },
  { company: 'Lumen Analytics', job_title: 'Data Analyst (Entry Level)', location: 'Pune, India', status: 'interviewing', notes: 'Round 2 on Thursday.' },
  { company: 'Northwind Cloud', job_title: 'Software Engineer I', location: 'Remote', is_remote: true, status: 'saved', notes: null },
  { company: 'Aperture Labs', job_title: 'Frontend Intern', location: 'Mumbai, India', status: 'rejected', notes: 'No response after 3 weeks.' },
];

const existingTracked = await api(
  `/rest/v1/tracked_jobs?user_id=eq.${paidId}&select=id`
);
if (existingTracked.length > 0) {
  console.log(`  ${existingTracked.length} already present, left alone`);
} else {
  await api('/rest/v1/tracked_jobs', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(
      TRACKED.map((t, i) => ({
        user_id: paidId,
        source: 'manual',
        company: t.company,
        job_title: t.job_title,
        location: t.location,
        is_remote: t.is_remote ?? false,
        url: `https://example.com/jobs/tracked-${i + 1}`,
        status: t.status,
        notes: t.notes,
        applied_at:
          t.status === 'saved' ? null : new Date(Date.now() - (i + 2) * 86400000).toISOString(),
      }))
    ),
  });
  console.log(`  ${TRACKED.length} tracked jobs for paid@dev.local`);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('=========================================================');
console.log('  DEV SEED READY   project ' + ref);
console.log('=========================================================');
console.log('  http://localhost:3111/login');
console.log('');
console.log('  free@dev.local  / ' + PASSWORD + '   -> sees the paywalls');
console.log('  paid@dev.local  / ' + PASSWORD + '   -> full access');
console.log('');
console.log('  Undo with:  node scripts/seed-dev.mjs --reset');
console.log('=========================================================');
