#!/usr/bin/env node
/**
 * Reproduces the resume SCAN failure against production: uploads a PDF, then
 * scans it against a job description, and reports the exact code.
 *
 * WHY SEPARATE FROM diagnose-prod-upload.mjs
 *   Upload and scan fail for completely different reasons. Upload parses the file
 *   locally with pdfjs and touches no AI provider at all. Scan is the step that
 *   spends inference, and it is funded by the PLATFORM key
 *   (`env.groqApiKey` in src/lib/resume/ai/client.ts) rather than by a user's
 *   vaulted key — nobody is going to create a Groq account to have a resume
 *   checked.
 *
 *   So "Analysis is temporarily unavailable. Please try again shortly." is not the
 *   same bug as the upload 500. That string maps to `analysis_unavailable`, which
 *   /api/resume/scan returns for exactly one cause: the AI client raised
 *   `not_configured`, which happens when and only when GROQ_API_KEY is absent.
 *
 * INTERPRETING THE RESULT
 *   503 analysis_unavailable  -> GROQ_API_KEY is missing or empty in the Vercel
 *                                environment. A provisioning problem, not a code
 *                                one; no deploy will fix it.
 *   429 analysis_busy         -> the key works and the account hit its tokens-per-
 *                                minute ceiling. Retryable.
 *   502 upstream_unavailable  -> the key works and Groq itself is unhappy.
 *   200                       -> scanning works; the report is elsewhere.
 *
 * A throwaway account is created and deleted. The free plan allows one scan a day,
 * which is all this needs.
 *
 * Usage: node scripts/diagnose-prod-scan.mjs [base-url] [env-file]
 */

import { readFileSync } from 'node:fs';

const base = (process.argv[2] ?? 'https://www.unviewable.online').replace(/\/$/, '');
const envFile = process.argv[3] ?? '.env.local.production-backup';

const env = {};
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
const admin = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const MAX_CHUNK_SIZE = 3180;

const JD = `
Backend Engineer, Payments

We are looking for a backend engineer to work on payment reconciliation.

Requirements:
- 2+ years of Go or Java
- Strong PostgreSQL, including query optimisation
- Experience with Kubernetes and containerised deployment
- Familiarity with payment gateways and idempotency
- BTech in Computer Science or equivalent experience

Nice to have:
- Redis
- Distributed tracing
`.trim();

function buildPdf(lines) {
  const text = lines
    .map((l, i) => `BT /F1 11 Tf 72 ${700 - i * 16} Td (${l.replace(/([()\\])/g, '\\$1')}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  objects.forEach((body, i) => {
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const EMAIL = `zz-diagnostic-delete-me-${stamp}@unviewable.online`;
const PASSWORD = `Diag-${stamp}!aA1`;
let userId = null;

try {
  const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { purpose: 'temporary scan diagnostic, safe to delete' },
    }),
  });
  if (!created.ok) throw new Error(`create user: ${created.status} ${await created.text()}`);
  userId = (await created.json()).id;

  const signIn = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!signIn.ok) throw new Error(`sign in: ${signIn.status} ${await signIn.text()}`);
  const session = await signIn.json();

  const name = `sb-${projectRef}-auth-token`;
  const encoded =
    'base64-' +
    Buffer.from(
      JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
        expires_at: session.expires_at,
        token_type: session.token_type,
        user: session.user,
      }),
      'utf8'
    ).toString('base64');

  const parts = [];
  if (encoded.length <= MAX_CHUNK_SIZE) {
    parts.push(`${name}=${encodeURIComponent(encoded)}`);
  } else {
    for (let i = 0, n = 0; i < encoded.length; i += MAX_CHUNK_SIZE, n += 1) {
      parts.push(`${name}.${n}=${encodeURIComponent(encoded.slice(i, i + MAX_CHUNK_SIZE))}`);
    }
  }
  const cookie = parts.join('; ');

  console.log(`target ${base}`);
  console.log(`throwaway user ${EMAIL}\n`);

  // --- step 1: upload ---------------------------------------------------------
  const pdf = buildPdf([
    'Jordan Blake',
    'Backend Engineer',
    'jordan.blake@example.com',
    '+91 98765 43210',
    'EXPERIENCE',
    'Zenpay - Backend Engineer, 2023 to 2026',
    'Built payment reconciliation in Go and PostgreSQL.',
    'Deployed services on Kubernetes with Redis caching.',
    'EDUCATION',
    'BTech Computer Science, 2023',
    'SKILLS',
    'Go, PostgreSQL, Kubernetes, Redis, Docker',
    `diagnostic ${stamp}`,
  ]);

  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'resume.pdf');

  const up = await fetch(`${base}/api/resume/upload`, {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
  const upBody = await up.json().catch(() => ({}));
  console.log(`1. upload  ${up.status}  ${upBody.code ?? ''} resumeId=${upBody.resumeId ?? '-'}`);

  if (!up.ok) {
    console.log('\nUpload failed, so the scan cannot be reached. Fix upload first.');
    process.exit(1);
  }

  // --- step 2: scan -----------------------------------------------------------
  const scanRes = await fetch(`${base}/api/resume/scan`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeId: upBody.resumeId, jdText: JD }),
  });
  const text = await scanRes.text();
  let scan;
  try {
    scan = JSON.parse(text);
  } catch {
    scan = { raw: text.slice(0, 400) };
  }

  console.log(`2. scan    ${scanRes.status}  ${scan.code ?? ''} ${(scan.message ?? '').slice(0, 70)}`);

  console.log('\n--- reading ---');
  if (scanRes.status === 200) {
    console.log(`Scan WORKS. score=${scan.score ?? '?'}`);
  } else if (scan.code === 'analysis_unavailable') {
    console.log('REPRODUCED. `analysis_unavailable` has exactly one cause in this');
    console.log('codebase: the AI client raised `not_configured`, which happens only');
    console.log('when GROQ_API_KEY is absent or empty.');
    console.log('');
    console.log('GROQ_API_KEY is NOT set in the Vercel production environment.');
    console.log('This is a provisioning gap — no code change or deploy will fix it.');
  } else if (scan.code === 'analysis_busy') {
    console.log('The key works; the Groq account hit its tokens-per-minute ceiling.');
  } else if (scan.code === 'upstream_unavailable') {
    console.log('The key works; Groq itself returned an error.');
  } else {
    console.log(`Unexpected: ${scanRes.status} ${scan.code ?? ''}`);
  }
} finally {
  if (userId) {
    const del = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: admin,
    });
    console.log(`\ncleanup: ${del.status === 200 ? 'throwaway user deleted' : `FAILED ${del.status} — delete ${EMAIL} manually`}`);
  }
}
