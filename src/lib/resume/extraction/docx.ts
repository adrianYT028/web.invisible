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

  return {
    text,
    // A .docx has no fixed pagination — pagination is computed by the renderer
    // from fonts and page size, so there is no page count in the file to read.
    // Reporting 1 is honest for a format that does not paginate itself, and the
    // per-page diagnostics below are correspondingly whole-document.
    pageCount: 1,
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
