// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { extractDocument, ExtractionError, isSupportedMimeType } from './index';
import { assessParseQuality } from '../parse-quality';

// -----------------------------------------------------------------------------
// End-to-end extraction tests — real pdfjs, real bytes
//
// The unit tests in layout.test.ts and parse-quality.test.ts run on synthetic
// coordinates and plain strings, which proves the inference is correct but proves
// nothing about the library actually being driven properly. These tests build
// real PDFs and push them through the full seam:
//
//     bytes -> extractDocument -> assessParseQuality -> diagnostics + score
//
// Runs in the `node` environment rather than the project default `jsdom`: this is
// server-side code, and pdfjs takes a different (canvas-dependent) path when it
// finds a DOM.
// -----------------------------------------------------------------------------

/** One positioned line of text in a generated PDF. */
interface PdfLine {
  text: string;
  x: number;
  y: number;
}

/**
 * Build a minimal single-page PDF placing each line at an absolute position.
 *
 * Hand-rolled rather than pulled from a fixture file so the geometry under test
 * is visible in the test itself — the whole question here is what pdfjs reports
 * for a known layout, which a binary fixture would hide.
 */
function buildPdf(lines: PdfLine[], pageWidth = 612, pageHeight = 792): Uint8Array {
  const content = lines
    .map(
      ({ text, x, y }) =>
        `BT /F1 11 Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`
    )
    .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      '/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  objects.forEach((body, index) => {
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n%%EOF`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

/** Escape the characters that terminate a PDF string literal. */
function escapePdfText(text: string): string {
  return text.replace(/([\\()])/g, '\\$1');
}

/** A believable single-column resume, positioned line by line. */
function singleColumnResumeLines(): PdfLine[] {
  const body = [
    'Aarav Sharma',
    'aarav.sharma@example.com',
    '+91 98765 43210',
    'EXPERIENCE',
    'Backend Engineering Intern, Zenpay Technologies',
    'Jan 2024 - Jun 2024',
    'Rebuilt the payment reconciliation job in Python',
    'Reduced median API latency from 420 ms to 180 ms',
    'Wrote integration tests covering the refund path',
    'PROJECTS',
    'Ledgerly, a double-entry bookkeeping API',
    'Designed a Postgres schema enforcing balanced entries',
    'Wrote property-based tests for transaction sequences',
    'EDUCATION',
    'Bachelor of Technology, Computer Science',
    'Amity University, Noida',
    '2021 - 2025',
    'SKILLS',
    'Python, TypeScript, Node, PostgreSQL, Redis, Docker, React, Git',
  ];
  return body.map((text, i) => ({ text, x: 72, y: 740 - i * 20 }));
}

// -----------------------------------------------------------------------------

describe('extractDocument — PDF', () => {
  it('extracts text, page count, and the engine that produced it', async () => {
    const bytes = buildPdf(singleColumnResumeLines());
    const raw = await extractDocument(bytes, 'application/pdf');

    expect(raw.engine).toBe('pdfjs');
    expect(raw.pageCount).toBe(1);
    expect(raw.hasTextLayer).toBe(true);
    expect(raw.text).toContain('Aarav Sharma');
    expect(raw.text).toContain('aarav.sharma@example.com');
  });

  it('preserves line structure so headings stay findable', async () => {
    // If reading order collapsed into one line, every section heading would be
    // buried mid-sentence and the resume would score as structureless.
    const bytes = buildPdf(singleColumnResumeLines());
    const raw = await extractDocument(bytes, 'application/pdf');

    const lines = raw.text.split('\n').map((l) => l.trim());
    expect(lines).toContain('EXPERIENCE');
    expect(lines).toContain('EDUCATION');
  });

  it('reports a clean single-column resume as scannable', async () => {
    const bytes = buildPdf(singleColumnResumeLines());
    const raw = await extractDocument(bytes, 'application/pdf');
    const assessment = assessParseQuality(raw);

    expect(assessment.diagnostics.hasEmail).toBe(true);
    expect(assessment.diagnostics.hasPhone).toBe(true);
    expect(assessment.diagnostics.columnLayoutSuspected).toBe(false);
    expect([...assessment.diagnostics.headingsFound].sort()).toEqual([
      'education',
      'experience',
      'projects',
      'skills',
    ]);
    expect(assessment.scannable).toBe(true);
  });

  it('detects a genuine two-column layout end to end', async () => {
    // Full-width name, then two independent flows on offset baselines.
    const lines: PdfLine[] = [{ text: 'AARAV SHARMA', x: 72, y: 750 }];
    for (let i = 0; i < 9; i++) {
      lines.push({ text: 'Left column body line here', x: 72, y: 700 - i * 20 });
    }
    for (let i = 0; i < 9; i++) {
      lines.push({ text: 'Right column body line', x: 380, y: 690 - i * 20 });
    }

    const raw = await extractDocument(buildPdf(lines), 'application/pdf');
    const assessment = assessParseQuality(raw);

    expect(assessment.diagnostics.columnLayoutSuspected).toBe(true);
    expect(assessment.warnings.join(' ')).toMatch(/single-column/i);
    expect(assessment.parseIntegrity).toBeLessThan(100);
  });

  it('does not flag right-aligned dates as a two-column layout', async () => {
    // The false positive that would otherwise fire at a large share of ordinary
    // resumes. Asserted here against real pdfjs output, not synthetic geometry.
    const lines: PdfLine[] = [
      { text: 'Aarav Sharma', x: 72, y: 750 },
      { text: 'aarav.sharma@example.com  +91 98765 43210', x: 72, y: 730 },
      { text: 'EXPERIENCE', x: 72, y: 700 },
    ];
    let y = 680;
    for (let role = 0; role < 3; role++) {
      lines.push({ text: 'Backend Engineering Intern, Zenpay', x: 72, y });
      lines.push({ text: 'Jan 2024 - Jun 2024', x: 430, y });
      y -= 20;
      for (let bullet = 0; bullet < 3; bullet++) {
        lines.push({ text: 'Delivered a measurable improvement', x: 90, y });
        y -= 20;
      }
    }
    lines.push({ text: 'EDUCATION', x: 72, y });
    lines.push({ text: 'Amity University, Noida, 2021 - 2025', x: 72, y: y - 20 });

    const raw = await extractDocument(buildPdf(lines), 'application/pdf');
    const assessment = assessParseQuality(raw);

    expect(assessment.diagnostics.columnLayoutSuspected).toBe(false);
    expect(assessment.warnings.join(' ')).not.toMatch(/single-column/i);
  });

  it('rejects a document with no text as a scan, fatally', async () => {
    // A PDF with no text operators at all — the shape a scanned resume takes.
    const raw = await extractDocument(buildPdf([]), 'application/pdf');
    const assessment = assessParseQuality(raw);

    expect(raw.hasTextLayer).toBe(false);
    expect(assessment.parseIntegrity).toBe(0);
    expect(assessment.scannable).toBe(false);
    expect(assessment.warnings).toHaveLength(1);
    expect(assessment.warnings[0]).toMatch(/no selectable text/i);
  });

  it('reports a non-PDF payload as corrupt rather than crashing', async () => {
    const notAPdf = new Uint8Array(Buffer.from('this is plainly not a PDF'));
    await expect(
      extractDocument(notAPdf, 'application/pdf')
    ).rejects.toThrow(ExtractionError);
  });
});

describe('extractDocument — plain text', () => {
  it('round-trips text and normalises CRLF line endings', async () => {
    const bytes = new Uint8Array(
      Buffer.from('EXPERIENCE\r\nBackend Intern\r\nEDUCATION')
    );
    const raw = await extractDocument(bytes, 'text/plain');

    expect(raw.engine).toBe('plain');
    expect(raw.text).toBe('EXPERIENCE\nBackend Intern\nEDUCATION');
    expect(raw.hasTextLayer).toBe(true);
  });

  it('rejects binary mislabelled as text instead of producing glyph soup', async () => {
    // Decoding this leniently would yield replacement characters, which the
    // encoding-damage detector would then report as a font problem — advice the
    // user cannot act on for what is really a wrong file type.
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80, 0x90]);
    await expect(extractDocument(binary, 'text/plain')).rejects.toThrow(
      ExtractionError
    );
  });
});

describe('extractDocument — guards', () => {
  it('rejects an unsupported type before touching any parser', async () => {
    const bytes = new Uint8Array(Buffer.from('x'));
    await expect(
      extractDocument(bytes, 'application/msword')
    ).rejects.toMatchObject({ code: 'unsupported_type' });
  });

  // Sniffing must not swallow this. A specific unsupported declaration is the
  // client telling us what the file is, and guessing text/plain over it replaces
  // "we cannot read .doc files" with "this is not readable text" — the second is
  // wrong and gives the user nothing to do.
  it('tells the user which format it cannot read, and what to upload instead', async () => {
    const err = (await extractDocument(
      new Uint8Array(Buffer.from('x')),
      'application/msword'
    ).then(
      () => null,
      (e: unknown) => e as Error
    )) as Error;

    expect(err.message).toContain('application/msword');
    expect(err.message).toMatch(/PDF, DOCX, or plain-text/);
  });

  // A legacy .doc renamed .pdf used to reach pdfjs, which reported
  // `corrupt_document` — "this is not a readable PDF" for a file the user never
  // called a PDF. Naming it from the bytes gives the actionable answer.
  it('names a legacy .doc from its bytes even when declared a PDF', async () => {
    const ole2 = new Uint8Array([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00,
    ]);

    await expect(
      extractDocument(ole2, 'application/pdf')
    ).rejects.toMatchObject({ code: 'unsupported_type' });
    await expect(extractDocument(ole2, 'application/pdf')).rejects.toThrow(
      /application\/msword/
    );
  });

  // People screenshot a resume and upload the PNG. There is no OCR in this
  // pipeline, so the honest refusal is "an image has no text to read".
  it('refuses an image without pretending it is a corrupt document', async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);

    await expect(
      extractDocument(png, 'application/octet-stream')
    ).rejects.toMatchObject({ code: 'unsupported_type' });
  });

  // The case sniffing exists for, end to end: the bytes are a real PDF and the
  // browser guessed DOCX from the filename. This used to fail in mammoth.
  it('reads a PDF that was uploaded with a DOCX content type', async () => {
    const bytes = buildPdf(singleColumnResumeLines());
    const raw = await extractDocument(
      bytes,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    expect(raw.engine).toBe('pdfjs');
    expect(raw.resolvedMime).toBe('application/pdf');
    expect(raw.mimeCorrected).toBe(true);
    expect(raw.text).toContain('Aarav Sharma');
  });

  it('reads a signature-free text file sent as application/octet-stream', async () => {
    const bytes = new Uint8Array(Buffer.from('EXPERIENCE\nBackend Intern'));
    const raw = await extractDocument(bytes, 'application/octet-stream');

    expect(raw.engine).toBe('plain');
    expect(raw.resolvedMime).toBe('text/plain');
    expect(raw.mimeCorrected).toBe(true);
  });

  it('rejects an empty upload', async () => {
    await expect(
      extractDocument(new Uint8Array(), 'application/pdf')
    ).rejects.toMatchObject({ code: 'empty_document' });
  });

  it('agrees with isSupportedMimeType about what it accepts', () => {
    expect(isSupportedMimeType('application/pdf')).toBe(true);
    expect(isSupportedMimeType('text/plain')).toBe(true);
    expect(
      isSupportedMimeType(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
    ).toBe(true);
    expect(isSupportedMimeType('application/msword')).toBe(false);
    expect(isSupportedMimeType('image/png')).toBe(false);
  });
});
