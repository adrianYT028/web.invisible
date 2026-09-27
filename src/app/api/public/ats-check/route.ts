import { NextResponse } from 'next/server';

import { trackEvent } from '@/lib/analytics/track';
import { jsonError, logSafe } from '@/lib/http';
import { getRequestIp, rateLimitAtsCheckByIp } from '@/lib/ratelimit';
import { extractDocument, ExtractionError } from '@/lib/resume/extraction';
import { assessParseQuality } from '@/lib/resume/parse-quality';
import { keywordGap } from '@/lib/resume/public-check';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/public/ats-check — the free, no-login ATS checker
// -----------------------------------------------------------------------------
//
// multipart/form-data: file (PDF/DOCX/TXT, up to 5 MB), jd (optional text)
//
// Deliberately cheap and private:
//   - NO sign-in, so it is rate-limited per IP (10 an hour).
//   - NO AI: the same deterministic parse check the signed-in upload runs, plus
//     a plain keyword comparison when a job description is pasted.
//   - NOTHING IS STORED. The file is read in memory and dropped when the
//     response is sent. The page tells the visitor this.
// -----------------------------------------------------------------------------

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_JD_CHARS = 20_000;

export async function POST(request: Request) {
  const limit = await rateLimitAtsCheckByIp(getRequestIp(request));
  if (!limit.ok) {
    return jsonError(
      429,
      'rate_limited',
      'You have run a lot of checks. Sign up free to keep going, or try again in an hour.'
    );
  }

  let file: File | null = null;
  let jd = '';
  try {
    const form = await request.formData();
    const candidate = form.get('file');
    if (candidate instanceof File) file = candidate;
    const jdField = form.get('jd');
    if (typeof jdField === 'string') jd = jdField.trim().slice(0, MAX_JD_CHARS);
  } catch {
    return jsonError(400, 'invalid_input');
  }
  if (!file) return jsonError(400, 'no_file');
  if (file.size === 0) return jsonError(400, 'empty_file');
  if (file.size > MAX_FILE_BYTES) return jsonError(413, 'file_too_large');

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const raw = await extractDocument(bytes, file.type || 'application/octet-stream');
    const assessment = assessParseQuality(raw);

    const keywords =
      jd.length >= 80 && assessment.raw.text ? keywordGap(jd, assessment.raw.text) : null;

    await trackEvent('ats_check_public', null, {
      scannable: assessment.scannable,
      with_jd: keywords !== null,
    });

    return NextResponse.json({
      parseIntegrity: assessment.parseIntegrity,
      scannable: assessment.scannable,
      pageCount: assessment.raw.pageCount,
      warnings: assessment.warnings,
      keywords,
    });
  } catch (err) {
    if (err instanceof ExtractionError) {
      const status = err.code === 'engine_unavailable' ? 503 : 422;
      return NextResponse.json({ code: err.code, message: err.message }, { status });
    }
    logSafe('public_ats_check_failed', { error: err instanceof Error ? err.name : 'unknown' });
    return jsonError(500, 'internal_error');
  }
}
