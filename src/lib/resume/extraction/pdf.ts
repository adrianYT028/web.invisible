// -----------------------------------------------------------------------------
// PDF adapter — pdfjs in, RawExtraction out
// -----------------------------------------------------------------------------
//
// Thin by design. All layout inference lives in ./layout.ts as pure functions on
// coordinates; this file's only job is to get those coordinates out of pdfjs and
// to translate pdfjs failures into `ExtractionError` codes the API can map.
//
// Nothing outside this directory may import pdfjs. See ./index.ts for why the
// seam exists and what would move it to a Python service.

import { logSafe } from '@/lib/http';

import { ExtractionError, type PageExtraction, type RawExtraction } from './index';
import {
  assembleText,
  detectColumnLayout,
  detectTables,
  groupIntoLines,
  type TextItem,
} from './layout';

/**
 * Cap on pages read.
 *
 * A resume is one or two pages. A 400-page PDF is either a mistake or an attempt
 * to exhaust the function's memory and time, and either way there is no value in
 * parsing past the point where the document has stopped being a resume.
 */
const MAX_PAGES = 15;

/**
 * Largest image pdfjs will decode, in pixels.
 *
 * Only text and the operator list are read here, so images should never be
 * decoded at all — this is a backstop against a malicious upload declaring a
 * gigantic image and exhausting the function's memory before anyone notices.
 */
const MAX_IMAGE_PIXELS = 8_000_000;

/**
 * Extract text and layout facts from a PDF.
 *
 * The options are chosen for untrusted input on a server that only needs text:
 * no outbound fetches, no font loading, and no console output. Note that pdfjs 6
 * no longer accepts `isEvalSupported` — eval-based font handling was removed
 * from the library, so that hardening flag is obsolete rather than missing.
 */
export async function extractPdf(bytes: Uint8Array): Promise<RawExtraction> {
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  let doc;
  try {
    doc = await getDocument({
      // pdfjs takes ownership of the buffer it is given, so hand it a copy —
      // the caller still needs these bytes to compute the content hash.
      data: new Uint8Array(bytes),
      // Uploads must never cause outbound fetches for fonts or colour profiles.
      useWorkerFetch: false,
      // Character mapping for text extraction comes from the PDF's own font
      // encoding, not from a system font, so loading fonts is pure cost here.
      useSystemFonts: false,
      disableFontFace: true,
      maxImageSize: MAX_IMAGE_PIXELS,
      // Silence pdfjs's console output. A malformed upload otherwise prints
      // recovery warnings on the server, which is both noise and a small
      // information leak about a user's document.
      verbosity: 0,
      // Try an empty password first so an encrypted file fails as `encrypted`
      // rather than surfacing as a generic parse error.
      password: '',
    }).promise;
  } catch (err) {
    throw translatePdfError(err);
  }

  const pagesRead = Math.min(doc.numPages, MAX_PAGES);
  const pages: PageExtraction[] = [];
  const textChunks: string[] = [];

  let columnLayoutSuspected = false;
  let tablesDetected = false;
  let anyTextFound = false;

  // The per-page work is wrapped, not just `getDocument`.
  //
  // Previously only document OPEN was inside a try/catch, so a failure part-way
  // through — `getPage`, `getTextContent`, a malformed font on page 3 — escaped as
  // a raw error and the upload route answered `500 internal_error`. That told the
  // user their file was fine and our server was broken, when the opposite was
  // true, and it gave them nothing to act on. A document that opens but cannot be
  // read past page N is still a document problem, so it maps to the same 422
  // `ExtractionError` family as every other unreadable file.
  try {
    for (let pageNumber = 1; pageNumber <= pagesRead; pageNumber++) {
      const page = await doc.getPage(pageNumber);

      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const items: TextItem[] = [];
      for (const item of content.items) {
        // pdfjs interleaves marked-content markers with text runs; only the latter
        // carry `str`.
        if (!('str' in item) || typeof item.str !== 'string') continue;
        const transform = item.transform as number[] | undefined;
        if (!transform || transform.length < 6) continue;
        items.push({
          str: item.str,
          x: transform[4],
          y: transform[5],
          width: typeof item.width === 'number' ? item.width : 0,
        });
      }

      const lines = groupIntoLines(items);
      const pageText = assembleText(lines);
      if (pageText.trim().length > 0) anyTextFound = true;

      // Layout is inferred per page and OR-ed: a two-column second page is still a
      // two-column resume, and aggregating coordinates across pages would compare
      // positions that never shared a sheet of paper.
      if (detectColumnLayout(items, viewport.width)) columnLayoutSuspected = true;
      if (detectTables(items)) tablesDetected = true;

      pages.push({
        pageNumber,
        text: pageText,
        hasImages: await pageHasImages(page, OPS),
      });
      textChunks.push(pageText);

      // Release the page's internal caches as we go rather than holding every
      // page's glyph data until the document is done.
      page.cleanup();
    }
  } catch (err) {
    // Salvage rather than discard. If enough text came back before the failure to
    // assess honestly, a partial read of a damaged file is more useful to the user
    // than a refusal — the parse-quality gate will still refuse it if the text is
    // too thin. Only a failure with nothing usable is fatal.
    logSafe('resume_pdf_page_failure', {
      page: pages.length + 1,
      pages_read: pages.length,
      of: doc.numPages,
      error_name: err instanceof Error ? err.name : 'unknown',
    });

    if (!anyTextFound) {
      throw new ExtractionError(
        'extraction_failed',
        pages.length === 0
          ? 'This PDF opened but its first page could not be read. Try re-exporting it from the original document.'
          : `This PDF could not be read past page ${pages.length}. Try re-exporting it from the original document.`,
        { cause: err }
      );
    }
  }

  await doc.cleanup().catch(() => {
    // Cleanup is a memory courtesy. Failing here after the text is already
    // extracted must not lose a successful read.
  });

  return {
    text: textChunks.join('\n\n'),
    // The number of pages actually READ, not `doc.numPages`.
    //
    // These differ whenever a document exceeds MAX_PAGES or a page failed
    // mid-loop, and reporting the document's total made the diagnostics lie: a
    // 40-page upload reported 40 pages alongside 15 pages of text, so
    // "thin content" looked like a sparse resume rather than truncation. The
    // untruncated total is kept separately below so the warning can name it.
    pageCount: pages.length,
    pagesInDocument: doc.numPages,
    pages,
    // A PDF that yielded no text on any page is a scan. The parse-quality gate
    // treats this as fatal and says so in one sentence.
    hasTextLayer: anyTextFound,
    columnLayoutSuspected,
    tablesDetected,
    engine: 'pdfjs',
  };
}

/**
 * Whether a page paints any raster image.
 *
 * Combined with empty page text this is what identifies a scanned page. Reading
 * the operator list is more work than reading text, but it is the only way to
 * distinguish "this page is a photograph of a resume" from "this page is blank",
 * and those two need different advice.
 */
async function pageHasImages(
  page: { getOperatorList: () => Promise<{ fnArray: number[] }> },
  OPS: Record<string, number>
): Promise<boolean> {
  try {
    const { fnArray } = await page.getOperatorList();
    const imageOps = new Set([
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      OPS.paintJpegXObject,
    ]);
    return fnArray.some((fn) => imageOps.has(fn));
  } catch {
    // A page whose operator list will not parse is not worth failing the whole
    // upload over — the text is already extracted. Report "no images" and let
    // the other diagnostics speak.
    return false;
  }
}

/**
 * Map a pdfjs failure to an `ExtractionError` code.
 *
 * The original error is always attached as `cause` and, for a failure we cannot
 * map, logged. A generic "could not be read" with the real error discarded is a
 * dead end for whoever has to debug it — which is precisely what happened the
 * first time this ran inside Next.
 */
function translatePdfError(err: unknown): ExtractionError {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);

  if (name === 'PasswordException' || /password/i.test(message)) {
    return new ExtractionError(
      'encrypted_document',
      'This PDF is password protected, so its contents cannot be read. Upload an unprotected copy.',
      { cause: err }
    );
  }
  if (name === 'InvalidPDFException' || /invalid pdf/i.test(message)) {
    return new ExtractionError(
      'corrupt_document',
      'This file is not a readable PDF. It may have been renamed from another format, or truncated during upload.',
      { cause: err }
    );
  }

  // Unmappable. This is either a genuinely broken document or an environment
  // problem, and those need very different fixes — so the real error name and
  // message are logged rather than swallowed. No document content is included.
  logSafe('resume_pdf_unmapped_failure', {
    error_name: name || 'unknown',
    error_message: message.slice(0, 300),
  });

  return new ExtractionError(
    'extraction_failed',
    'This PDF could not be read. Try re-exporting it from the original document.',
    { cause: err }
  );
}
