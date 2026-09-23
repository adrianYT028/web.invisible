// -----------------------------------------------------------------------------
// DOCX adapter — mammoth in, RawExtraction out
// -----------------------------------------------------------------------------
//
// DOCX is a far easier document than PDF: it stores real structure — paragraphs,
// tables, headings — rather than glyph positions, so reading order is recorded
// instead of inferred. That has two consequences worth stating plainly, because
// they invert the PDF logic:
//
//   - Column layout cannot be detected the same way and largely does not matter.
//     Word columns and text boxes exist, but mammoth resolves the document's own
//     paragraph order, so there is no interleaving risk to warn about.
//   - Tables ARE reliably detectable, because the format marks them as tables.
//     Unlike the PDF heuristic, a positive here is a fact.
//
// This is also why a DOCX upload is usually the better file to analyse, and why
// the PDF advice for damaged text suggests uploading a DOCX instead.

import { ExtractionError, type RawExtraction } from './index';

/**
 * Extract text and structure from a .docx.
 *
 * mammoth is asked for HTML rather than raw text, because raw text discards the
 * table markup that is the one structural signal worth reporting. The HTML is
 * then flattened here.
 */
export async function extractDocx(bytes: Uint8Array): Promise<RawExtraction> {
  const mammoth = await import('mammoth');

  let html: string;
  try {
    const result = await mammoth.convertToHtml({
      // mammoth expects a Node Buffer.
      buffer: Buffer.from(bytes),
    });
    html = result.value;
  } catch (err) {
    throw translateDocxError(err);
  }

  const tablesDetected = /<table[\s>]/i.test(html);
  const text = htmlToText(html);
  const pageCount = await readRecordedPageCount(bytes);

  return {
    text,
    // -----------------------------------------------------------------------
    // NULL, NOT 1, WHEN THE PAGE COUNT IS UNKNOWN.
    //
    // This used to report 1 unconditionally, with a comment arguing that was
    // "honest for a format that does not paginate itself". It is not honest: "1"
    // is a specific factual claim, and a user who uploaded a three-page resume was
    // shown "Pages: 1". They noticed immediately, and were right to — a report
    // that is wrong about the one thing the reader can verify by looking at their
    // own document earns no trust for the numbers they cannot check.
    //
    // It also silently disabled advice. `truncationWarning` in parse-quality.ts
    // tells a user their resume is too long to be read in full, and it can only
    // fire when the page count is known. With 1 hardcoded it could never fire for
    // DOCX — which is the format most resumes arrive in.
    //
    // `readRecordedPageCount` recovers the real figure when Word left it in the
    // file. When it did not, null means unknown and the UI says so.
    // -----------------------------------------------------------------------
    pageCount,
    // Word's own count of the whole document. Equal to `pageCount` here because,
    // unlike the PDF reader, nothing is skipped — mammoth converts all of it. The
    // field exists so a reader does not have to know that.
    pagesInDocument: pageCount ?? undefined,
    // One synthetic page holding the whole document. This is the unit the
    // image-only-page check works in, and for DOCX that check is whole-document.
    pages: [{ pageNumber: 1, text, hasImages: /<img[\s>]/i.test(html) }],
    // If mammoth produced any text, the document has readable text. A .docx
    // containing only images is possible but rare.
    hasTextLayer: text.trim().length > 0,
    // Not inferable from DOCX, and not a real risk for it — see the header.
    columnLayoutSuspected: false,
    tablesDetected,
    engine: 'mammoth',
  };
}

/**
 * Flatten mammoth's HTML to plain text, preserving line structure.
 *
 * Block boundaries must become newlines, because the parse-quality gate finds
 * section headings by looking at whole short lines. Collapsing `</p><p>` to a
 * space would run every heading into the paragraph after it and make the resume
 * look structureless — reporting a defect the document does not have.
 */
export function htmlToText(html: string): string {
  return (
    html
      // Table cells become tab-separated so a row stays one line.
      .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, '\t')
      // Every closing block element ends a line.
      .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // Drop all remaining tags.
      .replace(/<[^>]+>/g, '')
      // Decode the entities mammoth emits.
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      // Tidy whitespace without destroying line structure: collapse runs of
      // blank lines, and trim trailing spaces per line.
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * The page count Word recorded in the file, or null.
 *
 * A .docx does not paginate itself — pagination is computed by whatever renders
 * it, from the page size and the fonts actually available. But Word (and LibreOffice,
 * and Pages) write the count from their LAST render into `docProps/app.xml` as
 * `<Pages>`. That is exactly the number the author saw, which is the number worth
 * reporting.
 *
 * WHAT IT IS NOT
 *   It is not computed, and it can be stale — it reflects the last save, so a
 *   document edited by a tool that does not update it will disagree. It is also
 *   absent entirely from some exporters, notably Google Docs. Both cases return
 *   null rather than a guess.
 *
 *   Estimating pages from character count was considered and rejected. It would be
 *   wrong often enough to be worse than saying nothing, and the specific harm is
 *   that `truncationWarning` would then tell people to cut a resume that is
 *   already short.
 *
 * NEVER THROWS. A missing or malformed app.xml is normal, not an error, and a
 * document that converted successfully must not fail over a metadata field.
 */
async function readRecordedPageCount(bytes: Uint8Array): Promise<number | null> {
  try {
    // jszip is already how mammoth opens the container, so this adds no new
    // dependency at runtime — but it is declared directly in package.json rather
    // than relied on transitively, because a mammoth upgrade could drop it and the
    // only symptom would be page counts quietly becoming null again.
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(Buffer.from(bytes));
    const appXml = zip.file('docProps/app.xml');
    if (!appXml) return null;

    const xml = await appXml.async('string');
    const match = /<Pages>\s*(\d+)\s*<\/Pages>/i.exec(xml);
    if (!match) return null;

    const pages = Number(match[1]);
    // 0 appears in files saved by tools that write the element without filling it
    // in. An absurd value means we are reading something we do not understand.
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > 1000) return null;
    return pages;
  } catch {
    return null;
  }
}

function translateDocxError(err: unknown): ExtractionError {
  const message = err instanceof Error ? err.message : String(err);

  // mammoth reports a non-zip payload this way — usually a .doc, or a PDF that
  // was renamed.
  if (/zip|end of central directory|not a valid/i.test(message)) {
    return new ExtractionError(
      'corrupt_document',
      'This file is not a readable .docx. Older .doc files and renamed PDFs are not supported — open it in Word or Google Docs and save it as .docx.'
    );
  }
  return new ExtractionError(
    'extraction_failed',
    'This document could not be read. Try re-saving it as a .docx or exporting a PDF.'
  );
}
