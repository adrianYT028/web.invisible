#!/usr/bin/env node
/**
 * Walks the ENTIRE paid flow on production: upload -> scan -> save to tracker ->
 * read the tracker back.
 *
 * WHY A PAID THROWAWAY
 *   POST /api/jobs is gated on the `jobs` service, so a free account gets 402 and
 *   proves nothing about the save. The throwaway is therefore granted
 *   `student_pro` for the duration and deleted afterwards; `tracked_jobs`,
 *   `resumes` and `resume_scans` all cascade from `auth.users`, so the delete takes
 *   the test data with it.
 *
 * WHAT IT IS CHECKING
 *   Production shows three scans today and an empty tracker for the same account.
 *   Either "Save to tracker" is never being clicked, or it fails. Only one of those
 *   is a bug, and the difference is not visible from the data — a failed save leaves
 *   no row, and so does a save nobody attempted.
 *
 *   Step 4 reads the tracker back rather than trusting the POST's status, because a
 *   201 with a row the tracker then does not show would be a different bug again.
 *
 * Usage: node scripts/diagnose-prod-tracker.mjs [base-url] [env-file]
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

const JD = [
  'Backend Engineer, Payments — Zenpay',
  '',
  'Requirements',
  '- 2+ years of Go or Java in production',
  '- Strong PostgreSQL including query optimisation',
  '- Kubernetes and containerised deployment',
  '- Payment gateway integration and idempotency',
  '- BTech in Computer Science or equivalent experience',
  '',
  'Nice to have',
  '- Redis',
  '- Distributed tracing',
].join('\n');

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
  // --- create + grant ---------------------------------------------------------
  const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { purpose: 'temporary tracker diagnostic, safe to delete' },
    }),
  });
  if (!created.ok) throw new Error(`create user: ${created.status} ${await created.text()}`);
  userId = (await created.json()).id;

  const grant = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
    method: 'POST',
    headers: {
      ...admin,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{ id: userId, plan: 'student_pro', plan_expires_at: null }]),
  });
  if (!grant.ok) throw new Error(`grant plan: ${grant.status} ${await grant.text()}`);
  console.log(`throwaway paid user ${EMAIL}\n`);

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

  // --- 1. upload --------------------------------------------------------------
  const pdf = buildPdf([
    'Jordan Blake',
    'Backend Engineer',
    'jordan.blake@example.com',
    '+91 98765 43210',
    'EXPERIENCE',
    'Zenpay — Backend Engineer, 2023 to 2026',
    'Built payment reconciliation in Go against PostgreSQL.',
    'Deployed services on Kubernetes with Redis caching.',
    'EDUCATION',
    'BTech Computer Science, 2023',
    'SKILLS',
    'Go, PostgreSQL, Kubernetes, Redis, Docker',
    `diagnostic ${stamp}`,
  ]);
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'resume.pdf');
  const up = await fetch(`${base}/api/resume/upload`, { method: 'POST', headers: { cookie }, body: form });
  const upBody = await up.json().catch(() => ({}));
  console.log(`1. upload          ${up.status}  ${upBody.code ?? ''} integrity=${upBody.parseIntegrity ?? '-'} scannable=${upBody.scannable}`);
  if (!up.ok) throw new Error('upload failed, cannot continue');

  // --- 2. scan ----------------------------------------------------------------
  const scanRes = await fetch(`${base}/api/resume/scan`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeId: upBody.resumeId, jdText: JD }),
  });
  const scan = await scanRes.json().catch(() => ({}));
  console.log(`2. scan            ${scanRes.status}  ${scan.code ?? ''} score=${scan.overallScore ?? scan.score ?? '-'} scanId=${scan.scanId ?? '-'}`);
  console.log(`   scan response keys: ${Object.keys(scan).join(', ')}`);
  if (!scanRes.ok) throw new Error('scan failed, cannot continue');

  // --- 3. save to tracker -----------------------------------------------------
  // Exactly the body ResumeAnalyser sends.
  const saveBody = {
    company: scan.company ?? 'Unknown company',
    job_title: scan.jobTitle ?? 'Untitled role',
    jd_text: JD,
    scan_id: scan.scanId,
    status: 'saved',
  };
  const save = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(saveBody),
  });
  const saveText = await save.text();
  let saved;
  try {
    saved = JSON.parse(saveText);
  } catch {
    saved = { raw: saveText.slice(0, 300) };
  }
  console.log(`3. save to tracker ${save.status}  ${saved.code ?? ''} ${(saved.message ?? '').slice(0, 80)}`);
  console.log(`   sent: ${JSON.stringify(saveBody).slice(0, 200)}`);

  // --- 4. read the tracker back ----------------------------------------------
  const rows = await fetch(`${supabaseUrl}/rest/v1/tracked_jobs?select=company,job_title,match_score,scan_id&user_id=eq.${userId}`, { headers: admin });
  const list = await rows.json();
  console.log(`4. tracker rows    ${Array.isArray(list) ? list.length : '?'}`);
  if (Array.isArray(list)) {
    for (const r of list) {
      console.log(`   ${r.company} / ${r.job_title} score=${r.match_score} scan_id=${r.scan_id ? 'set' : 'null'}`);
    }
  }

  console.log('\n--- reading ---');
  if (save.ok && Array.isArray(list) && list.length > 0) {
    console.log('The whole flow WORKS end to end, including the save.');
    console.log('So the empty tracker in production means "Save to tracker" was never');
    console.log('clicked — the scan alone does not add a row, by design.');
  } else if (!save.ok) {
    console.log(`REPRODUCED: the save fails with ${save.status} ${saved.code ?? ''}.`);
  } else {
    console.log('Save returned OK but no row is present — worse than a failed save.');
  }
} finally {
  if (userId) {
    const del = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: admin,
    });
    console.log(`\ncleanup: ${del.status === 200 ? 'user + cascaded rows deleted' : `FAILED ${del.status} — delete ${EMAIL} manually`}`);
  }
}
