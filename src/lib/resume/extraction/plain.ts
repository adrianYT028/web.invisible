// -----------------------------------------------------------------------------
// Plain-text adapter
// -----------------------------------------------------------------------------
//
// Accepted mainly so the pipeline has a dependency-free path: it makes the API
// routes and the scoring engine testable end to end without a PDF fixture, and
// it gives a user whose PDF will not parse a way to get an answer by pasting
// their resume as text.
//
// A .txt has no layout at all, so there is nothing to infer — which is why every
// layout flag below is a fixed value rather than a detection.

import { ExtractionError, type RawExtraction } from './index';

export function extractPlainText(bytes: Uint8Array): RawExtraction {
  let text: string;
  try {
    // `fatal: true` so mis-declared binary (a PDF uploaded as text/plain) is
    // rejected as corrupt rather than silently decoded into replacement
    // characters — which would otherwise reach the encoding-damage detector and
    // be reported as a font problem the user cannot act on.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ExtractionError(
      'corrupt_document',
      'This file is not readable as UTF-8 text. If it is a PDF or Word document, upload it with its proper file extension.'
    );
  }

  // Normalise line endings so the heading detector sees consistent lines
  // regardless of which platform produced the file.
  const normalised = text.replace(/\r\n?/g, '\n');

  return {
    text: normalised,
    // Plain text has no pagination whatsoever — not "one page", none. Reporting 1
    // was a claim about a property the format does not have. Null, and the UI says
    // "not reported".
    pageCount: null,
    pages: [{ pageNumber: 1, text: normalised, hasImages: false }],
    hasTextLayer: normalised.trim().length > 0,
    columnLayoutSuspected: false,
    tablesDetected: false,
    engine: 'plain',
  };
}
