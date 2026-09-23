import { createHash } from 'node:crypto';

import { NextResponse } from 'next/server';

import { jsonError, logSafe } from '@/lib/http';
import { extractDocument, ExtractionError } from '@/lib/resume/extraction';
import {
  assessParseQuality,
  warningsFromDiagnostics,
} from '@/lib/resume/parse-quality';
import { checkResumeQuota, readPlan } from '@/lib/resume/quota';
import { PARSE_INTEGRITY_FLOOR } from '@/lib/resume/scoring/weights';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

export const dynamic = 'force-dynamic';
// pdfjs and mammoth are Node libraries — this cannot run on the edge runtime.
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/resume/upload — take a resume file and report whether it is readable
// -----------------------------------------------------------------------------
//
// Pipeline:
//   1. Cookie/session auth (the website surface, not the desktop bearer path)
//   2. Quota check BEFORE any parsing work
//   3. Read + hash the bytes
//   4. Idempotency: an identical file already uploaded returns the stored row
//   5. Extract text and layout facts
//   6. Parse-quality gate — deterministic, no AI
//   7. Store the file privately and the diagnostics in `resumes`
//
// NO INFERENCE HAPPENS HERE. Structured profile extraction is deliberately
// deferred to the scan, so a document that fails the parse gate never costs a
// token. That ordering is the main cost control on the free tier, and it is also
// the honest product: if we cannot read the file, the only useful thing to say is
// what is wrong with it.
//
// The response deliberately includes the parse verdict and warnings even when the
// document is unscannable — that IS the value of this endpoint, and the reason the
// parse check is a feature rather than a precondition.

/** 5 MB. A resume that exceeds this is not a resume. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const BUCKET = 'resumes';

export async function POST(request: Request) {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  const admin = supabaseAdmin();
  const plan = await readPlan(admin, user.id);

  // Quota first: parsing a PDF costs real CPU, and an over-quota user should not
  // be able to spend it.
  const quota = await checkResumeQuota(admin, user.id, 'upload', plan);
  if (!quota.allowed) {
    return NextResponse.json(
      {
        code: 'quota_exceeded',
        action: 'upload',
        cap: quota.cap,
        used: quota.used,
        plan: quota.plan,
      },
      { status: 429 }
    );
  }

  // --- read the upload ------------------------------------------------------
  let file: File | null = null;
  try {
    const form = await request.formData();
    const candidate = form.get('file');
    if (candidate instanceof File) file = candidate;
  } catch {
    return jsonError(400, 'invalid_input');
  }
  if (!file) return jsonError(400, 'no_file');

  if (file.size === 0) return jsonError(400, 'empty_file');
  if (file.size > MAX_FILE_BYTES) return jsonError(413, 'file_too_large');

  // The declared type is NOT rejected here any more.
  //
  // It used to be: an unsupported `file.type` was a 415 before anything read the
  // bytes. That turned three recoverable situations into failures — a PDF saved as
  // `.docx`, a browser sending `application/octet-stream` for both, a `.txt`
  // renamed `.pdf`. In each case the bytes were unambiguous and nothing looked at
  // them. `extractDocument` now sniffs the magic number and picks the parser from
  // that, throwing `unsupported_type` (mapped to 422 below) only when the bytes
  // themselves are unusable.
  const declaredMime = file.type || 'application/octet-stream';

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentHash = createHash('sha256').update(bytes).digest('hex');

  // --- idempotency ----------------------------------------------------------
  // Re-uploading the same file must not create a second row, spend a second
  // allowance, or re-run extraction.
  const { data: existing } = await admin
    .from('resumes')
    .select('id, parse_integrity, diagnostics, extraction_status, page_count')
    .eq('user_id', user.id)
    .eq('content_hash', contentHash)
    .maybeSingle();

  if (existing && existing.extraction_status === 'extracted') {
    // Warnings are RE-DERIVED from the stored diagnostics rather than returned
    // empty.
    //
    // This path used to send `warnings: []`, so re-uploading the same file showed
    // a score and no explanation — the user saw "42/100" with nothing to fix,
    // while a first-time upload of the identical bytes listed every problem. The
    // diagnostics were already stored precisely so the advice could be rebuilt
    // without re-reading the file.
    return NextResponse.json({
      resumeId: existing.id,
      reused: true,
      parseIntegrity: existing.parse_integrity,
      diagnostics: existing.diagnostics,
      pageCount: existing.page_count,
      scannable:
        typeof existing.parse_integrity === 'number' &&
        existing.parse_integrity >= PARSE_INTEGRITY_FLOOR,
      warnings: warningsFromDiagnostics(existing.diagnostics),
    });
  }

  // --- extract + assess (no AI) --------------------------------------------
  let assessment;
  try {
    const raw = await extractDocument(bytes, declaredMime);
    if (raw.mimeCorrected) {
      // Logged rather than silent: a correction nobody can see is one that gets
      // re-broken, and a spike here means a browser or client is mislabelling.
      logSafe('resume_upload_mime_corrected', {
        user_id: user.id,
        declared: declaredMime.slice(0, 64),
        actual: raw.resolvedMime,
      });
    }
    assessment = assessParseQuality(raw);
  } catch (err) {
    if (err instanceof ExtractionError) {
      // 422 says "your document is unprocessable", which is true for every code
      // here EXCEPT `engine_unavailable` — that one means our parser would not
      // load and the user's file was never even read. Answering 422 there tells
      // someone to go and re-export a file that is perfectly fine, and hides an
      // outage as a content problem. 503 is the honest answer, and it is the one
      // uptime checks and clients already understand as "retry later".
      const status = err.code === 'engine_unavailable' ? 503 : 422;
      if (status === 503) {
        logSafe('resume_upload_engine_unavailable', { user_id: user.id });
      }
      return NextResponse.json(
        { code: err.code, message: err.message },
        { status }
      );
    }
    logSafe('resume_upload_extract_failed', {
      user_id: user.id,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return jsonError(500, 'internal_error');
  }

  // --- store ---------------------------------------------------------------
  const storagePath = `${user.id}/${contentHash}`;

  // The type that was actually PARSED, not the one the client declared. A PDF
  // uploaded as `resume.docx` is stored as a PDF, because that is what the bytes
  // are and what a re-read of this object will find.
  const storedMime = assessment.raw.resolvedMime ?? declaredMime;

  const upload = await admin.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: storedMime,
    // Idempotent by content hash: the same bytes always land on the same key, so
    // overwriting is a no-op rather than a duplicate.
    upsert: true,
  });
  if (upload.error) {
    logSafe('resume_upload_storage_failed', {
      user_id: user.id,
      error: upload.error.message,
    });
    return jsonError(500, 'storage_failed');
  }

  const { data: row, error: insertError } = await admin
    .from('resumes')
    .upsert(
      {
        user_id: user.id,
        storage_bucket: BUCKET,
        storage_path: storagePath,
        original_filename: file.name || 'resume',
        mime_type: storedMime,
        size_bytes: bytes.byteLength,
        content_hash: contentHash,
        extraction_status: 'extracted',
        extraction_error: null,
        extracted_text: assessment.raw.text,
        page_count: assessment.raw.pageCount,
        diagnostics: assessment.diagnostics,
        parse_integrity: assessment.parseIntegrity,
        // The structured profile is NOT written here — it costs inference and is
        // produced by the scan, which only runs if the parse gate passed.
        profile: null,
        profile_schema_version: null,
      },
      { onConflict: 'user_id,content_hash' }
    )
    .select('id')
    .single();

  if (insertError || !row) {
    logSafe('resume_upload_insert_failed', {
      user_id: user.id,
      error: insertError?.message,
    });
    return jsonError(500, 'internal_error');
  }

  logSafe('resume_uploaded', {
    user_id: user.id,
    parse_integrity: assessment.parseIntegrity,
    scannable: assessment.scannable,
    engine: assessment.raw.engine,
  });

  return NextResponse.json({
    resumeId: row.id,
    reused: false,
    parseIntegrity: assessment.parseIntegrity,
    diagnostics: assessment.diagnostics,
    pageCount: assessment.raw.pageCount,
    // False means the scan endpoint will refuse this document. Surfaced here so
    // the UI can show the file problems immediately instead of after a failed scan.
    scannable: assessment.scannable,
    warnings: assessment.warnings,
  });
}


