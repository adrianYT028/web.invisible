import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assessParseQuality,
  warningsFromDiagnostics,
} from './parse-quality';
import type { RawExtraction } from './extraction';

/**
 * The warnings a user sees are now built in one place and consumed by three:
 * the live upload, the idempotent re-upload, and the stored scan report.
 *
 * This file asserts the property that makes that safe — `assessParseQuality`
 * produces exactly what `warningsFromDiagnostics` produces from its own
 * diagnostics. If a future edit adds a deduction with an inline message, or
 * changes a condition in one place only, these fail.
 *
 * That matters because the divergence is invisible: a score still comes back, and
 * the explanation just quietly stops matching it.
 */

function raw(over: Partial<RawExtraction> = {}): RawExtraction {
  return {
    text: '',
    pageCount: 1,
    pages: [{ pageNumber: 1, text: '', hasImages: false }],
    hasTextLayer: true,
    columnLayoutSuspected: false,
    tablesDetected: false,
    engine: 'test',
    ...over,
  };
}

/** A document with enough structure to clear the fatal gates. */
function healthyText(): string {
  return [
    'Jane Doe',
    'jane@example.com',
    '+91 98765 43210',
    '',
    'EXPERIENCE',
    'Engineer at Acme, Jan 2024 – Jun 2024',
    ...Array.from(
      { length: 40 },
      (_, i) => `Built and shipped feature number ${i} improving throughput.`
    ),
    '',
    'EDUCATION',
    'B.Tech, Some University, 2020 – 2024',
  ].join('\n');
}

describe('warningsFromDiagnostics reproduces assessParseQuality', () => {
  it('agrees on a healthy document', () => {
    const result = assessParseQuality(raw({ text: healthyText() }));
    expect(warningsFromDiagnostics(result.diagnostics)).toEqual(
      result.warnings
    );
  });

  // The fatal paths return a single warning and skip everything else.
  it('agrees on a scanned document with no text layer', () => {
    const result = assessParseQuality(raw({ hasTextLayer: false }));
    expect(result.warnings).toHaveLength(1);
    expect(warningsFromDiagnostics(result.diagnostics)).toEqual(
      result.warnings
    );
  });

  it('agrees on a near-empty document', () => {
    const result = assessParseQuality(raw({ text: 'Jane Doe' }));
    expect(result.warnings).toHaveLength(1);
    expect(warningsFromDiagnostics(result.diagnostics)).toEqual(
      result.warnings
    );
  });

  it('agrees when a document was truncated', () => {
    const result = assessParseQuality(
      raw({ text: healthyText(), pageCount: 15, pagesInDocument: 40 })
    );
    expect(result.warnings.some((w) => w.includes('first 15 of 40'))).toBe(
      true
    );
    expect(warningsFromDiagnostics(result.diagnostics)).toEqual(
      result.warnings
    );
  });

  it('says nothing about truncation when everything was read', () => {
    const result = assessParseQuality(
      raw({ text: healthyText(), pageCount: 2, pagesInDocument: 2 })
    );
    expect(result.warnings.some((w) => w.includes('pages were read'))).toBe(
      false
    );
  });

  // The property. Randomised over every flag the two functions branch on.
  it('agrees across arbitrary combinations of defects', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        (
          columns,
          tables,
          images,
          dropEmail,
          dropPhone,
          pagesRead,
          extraPages
        ) => {
          let text = healthyText();
          if (dropEmail) text = text.replace('jane@example.com', '');
          if (dropPhone) text = text.replace('+91 98765 43210', '');

          const result = assessParseQuality(
            raw({
              text,
              columnLayoutSuspected: columns,
              tablesDetected: tables,
              pageCount: pagesRead,
              pagesInDocument: pagesRead + extraPages,
              pages: images
                ? [
                    { pageNumber: 1, text: '', hasImages: true },
                    { pageNumber: 2, text, hasImages: false },
                  ]
                : [{ pageNumber: 1, text, hasImages: false }],
            })
          );

          expect(warningsFromDiagnostics(result.diagnostics)).toEqual(
            result.warnings
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  // Rows written before `pagesRead`/`pagesInDocument` existed do not carry them,
  // and a stored report must still rebuild rather than throw.
  it('tolerates diagnostics from before the page fields existed', () => {
    const result = assessParseQuality(raw({ text: healthyText() }));
    const legacy = { ...result.diagnostics };
    delete (legacy as Record<string, unknown>).pagesRead;
    delete (legacy as Record<string, unknown>).pagesInDocument;

    expect(() => warningsFromDiagnostics(legacy)).not.toThrow();
    // Everything except the truncation line, which is exactly what is missing.
    expect(warningsFromDiagnostics(legacy)).toEqual(
      result.warnings.filter((w) => !w.includes('pages were read'))
    );
  });

  it('tolerates diagnostics missing the array fields entirely', () => {
    const result = assessParseQuality(raw({ text: healthyText() }));
    const sparse = { ...result.diagnostics };
    delete (sparse as Record<string, unknown>).imageOnlyPages;
    delete (sparse as Record<string, unknown>).headingsMissing;
    expect(() => warningsFromDiagnostics(sparse)).not.toThrow();
  });
});
