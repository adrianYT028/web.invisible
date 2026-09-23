// -----------------------------------------------------------------------------
// Document extraction — THE SEAM
// -----------------------------------------------------------------------------
//
// Everything in the resume pipeline that touches file bytes goes through
// `extractDocument`. Nothing outside this directory may import a PDF or DOCX
// library. That rule is the entire point of the module.
//
// ---------------------------------------------------------------------------
// WHY A SEAM AND NOT A SERVICE (yet)
//
// Extraction is the one part of this pipeline that genuinely wants to be its own
// deployable eventually: it is a pure function (bytes in, JSON out, owns no
// data, needs no user auth, persists nothing), and the tooling that does it best
// — PyMuPDF, pdfplumber, OCR, the BERT-family resume-NER models — is Python.
//
// It is NOT a separate service today, for two reasons.
//
//   1. A service that reads and writes the same Supabase tables is not a
//      microservice, it is a distributed monolith: two deploy units welded
//      together through one schema, paying every cost of separation for none of
//      the isolation. The only version worth building is stateless, and
//      statelessness is a property of THIS boundary, not of "the resume feature".
//
//   2. The technical forcing function largely evaporated. Vercel Functions now
//      support Node and Python packages far beyond the old 250 MB ceiling and
//      durations far beyond the old timeout, so "Vercel cannot run a parser" is
//      no longer true.
//
// So: build the seam, don't pay for the split. Callers depend on
// `extractDocument`'s signature and nothing else, which means the day OCR or a
// real NER model justifies a Python box, the change is this function's body —
// a `fetch()` instead of a dynamic import — and no caller moves.
//
// SPLIT WHEN, and not before:
//   - OCR is needed for scanned resumes (native deps, slow, awkward to bundle)
//   - a trained NER model replaces LLM extraction (published resume-NER runs
//     ~99% F1 on clean text vs ~69% on noisy text; worth it, and it is Python)
//   - extraction p95 starts eating the request budget
//   - parse failures begin affecting unrelated routes
//
// WHEN IT SPLITS, the contract is: shared-secret HMAC, server-to-server only,
// never browser-reachable, colocated with the database, logs no document
// content, and keyed on the content hash so a retry cannot double-charge quota.

import type { ParseDiagnostics } from '../schema';

/**
 * What only a document parser can know.
 *
 * The split between this and `ParseDiagnostics` is deliberate and load-bearing.
 * These fields require the PDF/DOCX library — page count, whether a text layer
 * exists, what the layout engine thinks about columns and tables. Everything
 * else in `ParseDiagnostics` (headings, dates, encoding damage, contact
 * details) is derived from `text` by pure string analysis.
 *
 * That is what makes the parse-quality checker unit-testable from plain strings
 * with no PDF fixtures and no library in the test path — which matters, because
 * it is the highest-weighted sub-score in the product.
 */
export interface RawExtraction {
  /** Full document text, pages joined in reading order. */
  text: string;
  /**
   * Pages actually READ and represented in `text` and `pages`.
   *
   * Not the document's page count. An adapter may read fewer — a page cap, or a
   * page that failed mid-document — and conflating the two made the diagnostics
   * misleading: a long upload reported its full length beside a fraction of its
   * text, so truncation looked like a sparse document.
   */
  pageCount: number;
  /**
   * Pages the document CLAIMS to have, when the format reports it.
   *
   * Greater than `pageCount` means content was not read, which the parse-quality
   * gate turns into an explicit truncation warning rather than letting it show up
   * as unexplained thin content. Undefined for formats with no page concept
   * (DOCX as parsed here, plain text).
   */
  pagesInDocument?: number;
  /** Per-page detail. Drives image-only page detection. */
  pages: PageExtraction[];
  /**
   * False for a scanned/image-only document: there is no text to extract
   * without OCR, and every downstream score would be computed on nothing.
   */
  hasTextLayer: boolean;
  /**
   * Multi-column layout suspected by the layout engine.
   *
   * A PDF stores characters and their positions, not paragraphs — a two-column
   * page is not two text streams but a set of coordinates that happen to look
   * like columns when drawn. Recovering reading order is a computer-vision
   * problem, and commercial parsing vendors put column layouts at roughly 15%
   * of all CVs. So this is a genuine risk flag, not a claim of failure.
   */
  columnLayoutSuspected: boolean;
  /** Tabular structure detected. Cell reading order is frequently mangled. */
  tablesDetected: boolean;
  /** Which implementation produced this, e.g. 'pdfjs', 'mammoth', 'plain'. */
  engine: string;
  /**
   * The type actually used to parse, decided from the bytes (see ./sniff.ts).
   *
   * Store THIS rather than the client's declared type: a PDF uploaded as
   * `resume.docx` should be recorded as a PDF, because that is what it is and what
   * a re-read of the stored object will find.
   */
  resolvedMime?: string;
  /**
   * True when `resolvedMime` disagreed with what the client declared.
   *
   * Surfaced so the caller can log it. A silent correction nobody can see is one
   * that gets re-broken.
   */
  mimeCorrected?: boolean;
}

export interface PageExtraction {
  /** 1-based. */
  pageNumber: number;
  text: string;
  /** Page contains raster images. With empty text, implies a scanned page. */
  hasImages: boolean;
}

/**
 * The full result of assessing an uploaded document: the raw extraction, the
 * derived diagnostics, the Parse Integrity score, and the human-readable
 * warnings the report shows.
 */
export interface ExtractionAssessment {
  raw: RawExtraction;
  diagnostics: ParseDiagnostics;
  /** Parse Integrity, 0-100. Written to `resumes.parse_integrity`. */
  parseIntegrity: number;
  /** Shown to the user, ordered most to least severe. */
  warnings: string[];
  /**
   * True when `parseIntegrity` is at or above `PARSE_INTEGRITY_FLOOR`. False
   * means the scan must be refused, not scored — see the floor's rationale in
   * scoring/weights.ts.
   */
  scannable: boolean;
}

/** Supported upload types. Anything else is rejected at the API boundary. */
export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export function isSupportedMimeType(mime: string): mime is SupportedMimeType {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Extraction failed in a way the user can act on.
 *
 * `code` is machine-readable so the API can map it to a stable error envelope
 * without string-matching a message, matching the `jsonError` convention used
 * by the AI proxy.
 */
export class ExtractionError extends Error {
  constructor(
    readonly code:
      | 'unsupported_type'
      | 'corrupt_document'
      | 'encrypted_document'
      | 'empty_document'
      | 'extraction_failed'
      // OUR fault, not the document's: the parser library could not be loaded at
      // all. Kept distinct from `extraction_failed` because every other code here
      // means "there is something wrong with your file", and telling someone to
      // re-export a perfectly good PDF while the real problem is our runtime is
      // how a server bug gets reported as a user error. The route maps this one to
      // 503 rather than 422 for the same reason.
      | 'engine_unavailable',
    message: string,
    /**
     * The underlying failure, preserved.
     *
     * The user-facing `message` is deliberately vague, which is correct for a
     * response body and useless for debugging. Without the cause attached, an
     * unmappable parser failure produces "could not be read" and nothing else —
     * exactly the dead end this hit in practice.
     */
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ExtractionError';
  }
}

/**
 * Extract text and layout facts from an uploaded document.
 *
 * THIS SIGNATURE IS THE CONTRACT. Callers must depend on nothing else from this
 * directory. When extraction moves to a Python service, only this body changes.
 *
 * Adapters are loaded with dynamic `import()` rather than top-level imports so
 * a PDF library never enters a bundle that only needed DOCX — and so importing
 * the types (or the parse-quality checker) never drags a parser in at all.
 */
export async function extractDocument(
  bytes: Uint8Array,
  declaredMime: string
): Promise<RawExtraction> {
  if (bytes.byteLength === 0) {
    throw new ExtractionError('empty_document', 'The uploaded file is empty.');
  }

  // The BYTES choose the parser, not the declared type.
  //
  // `file.type` is the browser's guess, usually from the filename, and it is
  // wrong often enough to matter: a PDF saved as `.docx` used to be handed to
  // mammoth and fail as "not a readable DOCX" for a file that was a perfectly
  // good PDF. Reading the magic number turns that into a successful upload. See
  // ./sniff.ts — it decides a parser, it is not a security control.
  const { resolveMimeType } = await import('./sniff');
  const { mime, corrected } = resolveMimeType(bytes, declaredMime);

  if (!isSupportedMimeType(mime)) {
    // `mime` here is either a format sniff.ts NAMED from the bytes (a legacy
    // .doc, an RTF, a screenshot) or the client's own declaration. Either way it
    // is untrusted input being echoed back, so it is truncated — a browser can
    // send an arbitrarily long type string, and an unbounded one ends up in logs
    // and in an error body.
    const label = mime.slice(0, 64);
    throw new ExtractionError(
      'unsupported_type',
      `${label} files cannot be read. Upload a PDF, DOCX, or plain-text resume.`
    );
  }

  // The correction is REPORTED on the result rather than logged here. This module
  // is the seam every caller depends on, and pulling `@/lib/http` in for one log
  // line would drag server-only code into something the parse-quality checker and
  // the type imports also reach. The caller logs it, and stores the corrected type
  // instead of the declared one.
  const withResolved = (raw: RawExtraction): RawExtraction => ({
    ...raw,
    resolvedMime: mime,
    mimeCorrected: corrected,
  });

  switch (mime) {
    case 'application/pdf': {
      const { extractPdf } = await import('./pdf');
      return withResolved(await extractPdf(bytes));
    }
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
      const { extractDocx } = await import('./docx');
      return withResolved(await extractDocx(bytes));
    }
    case 'text/plain': {
      const { extractPlainText } = await import('./plain');
      return withResolved(extractPlainText(bytes));
    }
  }
}
