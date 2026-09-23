#!/usr/bin/env node
/**
 * Uploads a real PDF to /api/resume/upload on a running server, as a real
 * signed-in user.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The PDF worker bug shipped to production while 867 unit tests passed and the
 * feature worked in `next dev`. Both of those resolve pdfjs from node_modules,
 * where the worker file always exists. Only a PRODUCTION BUILD reveals it,
 * because only then does Next decide which files to deploy.
 *
 * So the check that matters is: point this at `npm start`, not at `npm run dev`.
 *
 *   npm run build && npm start -- --port 3210
 *   node scripts/e2e-resume-upload.mjs http://localhost:3210
 *
 * ---------------------------------------------------------------------------
 * THE COOKIE
 *
 * The route authenticates from cookies, not a bearer token, so a raw
 * Authorization header will not do. @supabase/ssr 0.9 stores the session in
 * `sb-<project-ref>-auth-token` as `base64-` + base64(JSON), split into
 * `.0`, `.1`, ... chunks once it exceeds MAX_CHUNK_SIZE (3180). A session with
 * two JWTs in it does exceed that, so chunking is not optional.
 */

import { readFileSync } from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:3210').replace(/\/$/, '');
const envFile = process.argv[3] ?? '.env.local';

const env = {};
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const projectRef = new URL(supabaseUrl).hostname.split('.')[0];

const EMAIL = process.env.E2E_EMAIL ?? 'paid@dev.local';
const PASSWORD = process.env.E2E_PASSWORD ?? 'devpassword123';

const MAX_CHUNK_SIZE = 3180;

/** Minimal but genuinely valid single-page PDF with extractable text. */
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

// --- sign in -----------------------------------------------------------------
const signIn = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anonKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!signIn.ok) {
  console.error(`sign in failed for ${EMAIL}: ${signIn.status} ${await signIn.text()}`);
  process.exit(2);
}
const session = await signIn.json();
console.log(`signed in as ${EMAIL} (${session.user.id})`);

// --- build the cookie header -------------------------------------------------
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
    parts.push(
      `${name}.${n}=${encodeURIComponent(encoded.slice(i, i + MAX_CHUNK_SIZE))}`
    );
  }
}
const cookie = parts.join('; ');
console.log(`cookie ${name}, ${encoded.length} chars in ${parts.length} chunk(s)`);

// --- upload ------------------------------------------------------------------
// Unique content so the route's content-hash idempotency does not short-circuit
// and hand back a stored row without ever invoking pdfjs — which would make a
// broken extractor look healthy.
const pdf = buildPdf([
  'Jordan Blake',
  'Backend Engineer',
  'jordan.blake@example.com',
  'EXPERIENCE',
  'Zenpay - Backend Engineer, 2023 to 2026',
  'Built payment reconciliation in Go and Postgres.',
  'SKILLS',
  'Go, Postgres, Kubernetes, Redis',
  `run-id ${Date.now()}-${Math.random().toString(36).slice(2)}`,
]);

const form = new FormData();
form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'resume.pdf');

console.log(`\nPOST ${base}/api/resume/upload   (${pdf.length} bytes)`);
const res = await fetch(`${base}/api/resume/upload`, {
  method: 'POST',
  headers: { cookie },
  body: form,
});

const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { raw: text.slice(0, 500) };
}

console.log(`status ${res.status}`);
console.log(JSON.stringify(body, null, 2).slice(0, 1200));
console.log('');

if (res.status === 401) {
  console.log('INCONCLUSIVE: not authenticated. The cookie format may have changed.');
  process.exit(2);
}
if (res.status === 429) {
  console.log('INCONCLUSIVE: daily quota hit. Try the other test account.');
  process.exit(2);
}
if (res.status === 500 && body.code === 'internal_error') {
  console.log('FAIL: reproduced the production bug — extraction threw.');
  console.log('      Check the server output for resume_upload_extract_failed.');
  process.exit(1);
}
if (!res.ok) {
  console.log(`FAIL: unexpected ${res.status} ${body.code ?? ''}`);
  process.exit(1);
}

// A 200 is necessary but not sufficient: the point is that pdfjs actually read
// the text. A zero page count or a null integrity score means the parser ran and
// produced nothing, which for this fixture would still be a failure.
if (typeof body.parseIntegrity !== 'number' || body.pageCount !== 1) {
  console.log(
    `FAIL: 200 but the parse looks wrong — pageCount=${body.pageCount} parseIntegrity=${body.parseIntegrity}`
  );
  process.exit(1);
}

console.log(
  `PASS: extracted a ${body.pageCount}-page PDF, parseIntegrity ${body.parseIntegrity}, scannable ${body.scannable}.`
);
