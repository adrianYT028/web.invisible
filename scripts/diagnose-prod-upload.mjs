#!/usr/bin/env node
/**
 * Reproduces the resume-upload failure against PRODUCTION and localises it by
 * file type.
 *
 * WHY BY FILE TYPE
 *   `/api/resume/upload` returns 500 `internal_error` from exactly two places:
 *   the catch around extraction, and the `resumes` insert. Everything else has a
 *   distinct code (422 extraction_failed, 500 storage_failed, 429 quota,
 *   413 file_too_large), so those are already ruled out by the status alone.
 *
 *   The three extractors do not share a parser:
 *     .txt   plain, no dependency at all
 *     .docx  mammoth
 *     .pdf   pdfjs
 *
 *   So the pattern across the three separates "the parser cannot load" from
 *   "everything after extraction is broken":
 *
 *     all three fail      -> not the parser. The insert, or shared setup.
 *     only pdf fails      -> pdfjs cannot load or run in the deployed bundle.
 *     pdf + docx fail     -> both external packages are unresolvable, i.e. the
 *                            serverExternalPackages deployment is the problem.
 *
 *   This matters because guessing already went wrong once: a MISSING pdf worker
 *   produces 422 `extraction_failed`, not the 500 that was reported. So the
 *   worker was a real bug but not this bug.
 *
 * WHY A THROWAWAY ACCOUNT, AND ONE PER FILE
 *   The route needs a session cookie, and no customer's account may be used. The
 *   free plan allows ONE upload per day, so each file type needs its own account
 *   or the second attempt returns 429 and proves nothing. Every account is
 *   deleted in a finally block, and named so a leaked one is obvious.
 *
 * Usage: node scripts/diagnose-prod-upload.mjs [base-url] [env-file]
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

const RESUME_LINES = [
  'Jordan Blake',
  'Backend Engineer',
  'jordan.blake@example.com',
  '+91 98765 43210',
  'EXPERIENCE',
  'Zenpay - Backend Engineer, 2023 to 2026',
  'Built payment reconciliation in Go and Postgres.',
  'EDUCATION',
  'BTech Computer Science, 2023',
  'SKILLS',
  'Go, Postgres, Kubernetes, Redis',
];

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

/**
 * Minimal real .docx. A docx is a zip, and mammoth needs a genuine one, so the
 * central directory is assembled by hand with stored (uncompressed) entries.
 */
function buildDocx(lines) {
  const paras = lines
    .map((l) => `<w:p><w:r><w:t xml:space="preserve">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`)
    .join('');
  const files = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
        'utf8'
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
        'utf8'
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          `<w:body>${paras}</w:body></w:document>`,
        'utf8'
      ),
    },
  ];

  // CRC32, needed because zip readers validate it.
  const table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (const b of buf) c = (c >>> 8) ^ table[(c ^ b) & 0xff];
    return (c ^ -1) >>> 0;
  };

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, f.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + f.data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

const CASES = [
  {
    label: 'txt  (plain, no parser)',
    filename: 'resume.txt',
    mime: 'text/plain',
    bytes: () => Buffer.from(RESUME_LINES.join('\n'), 'utf8'),
  },
  {
    label: 'docx (mammoth)',
    filename: 'resume.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: () => buildDocx(RESUME_LINES),
  },
  {
    label: 'pdf  (pdfjs)',
    filename: 'resume.pdf',
    mime: 'application/pdf',
    bytes: () => buildPdf(RESUME_LINES),
  },
];

async function withThrowawayUser(fn) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `zz-diagnostic-delete-me-${stamp}@unviewable.online`;
  const password = `Diag-${stamp}!aA1`;
  let userId = null;
  try {
    const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { ...admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { purpose: 'temporary upload diagnostic, safe to delete' },
      }),
    });
    if (!created.ok) throw new Error(`create user: ${created.status} ${await created.text()}`);
    userId = (await created.json()).id;

    const signIn = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
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
    return await fn(parts.join('; '));
  } finally {
    if (userId) {
      const del = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: admin,
      });
      if (del.status !== 200) {
        console.log(`  CLEANUP FAILED, DELETE MANUALLY: ${email} (${userId})`);
      }
    }
  }
}

console.log(`target ${base}`);
console.log(`project ${projectRef}\n`);

const results = [];

for (const c of CASES) {
  const bytes = c.bytes();
  const out = await withThrowawayUser(async (cookie) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: c.mime }), c.filename);
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
      body = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body };
  });

  results.push({ label: c.label, ...out });
  console.log(
    `${c.label.padEnd(24)} ${String(out.status).padEnd(5)} ${out.body.code ?? ''}` +
      (out.status === 200
        ? `  pages=${out.body.pageCount} integrity=${out.body.parseIntegrity}`
        : `  ${(out.body.message ?? '').slice(0, 60)}`)
  );
}

// --- reading ------------------------------------------------------------------
const failed = results.filter((r) => r.status !== 200);
const is500 = (r) => r.status === 500 && r.body.code === 'internal_error';

console.log('\n--- reading ---');
if (failed.length === 0) {
  console.log('All three succeed. The upload route is healthy; the reported error is');
  console.log('elsewhere (the SCAN step, or a specific file this fixture does not model).');
} else if (results.every(is500)) {
  console.log('ALL THREE return 500 internal_error, including plain text which uses NO');
  console.log('parser at all. So this is not pdfjs and not mammoth — it is shared code:');
  console.log('the `resumes` insert, or something before extraction that throws.');
} else if (is500(results[2]) && !is500(results[0])) {
  console.log('Only the PDF fails. pdfjs cannot load or run in the deployed bundle.');
} else {
  console.log('Mixed result — see the table above.');
}
