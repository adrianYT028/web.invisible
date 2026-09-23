import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { extractDocx } from './docx';

// -----------------------------------------------------------------------------
// The reported page count must be the real one, or nothing
// -----------------------------------------------------------------------------
//
// `extractDocx` returned a hardcoded `pageCount: 1`. A user uploaded a three-page
// resume, the report said "Pages: 1", and they asked why. That is the worst kind of
// wrong number: it is the one figure on the whole report a reader can check against
// their own file, so being wrong about it discredits every figure they cannot check.
//
// It also disabled advice silently. `truncationWarning` in parse-quality.ts tells
// someone their resume is too long to be read in full, and it can only fire when the
// page count is known. Pinned at 1, it could never fire for DOCX — the format most
// resumes arrive in.
//
// A .docx genuinely does not paginate itself; pagination is computed by whatever
// renders it. But Word, LibreOffice and Pages all record the count from their last
// render in `docProps/app.xml` as `<Pages>`, and that is the number the author saw.
// These tests cover both halves: read it when it is there, say nothing when it is
// not.
// -----------------------------------------------------------------------------

/**
 * A real .docx, optionally carrying a `docProps/app.xml` with a page count.
 *
 * Built with JSZip rather than checked in as a binary fixture so the presence,
 * absence and malformation of that one field can each be expressed directly.
 */
async function buildDocx(options: {
  paragraphs: string[];
  /** Raw contents of `<Pages>`. Omit the property to leave out app.xml entirely. */
  recordedPages?: string;
}): Promise<Uint8Array> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
  );

  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
  );

  const body = options.paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('');
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>`
  );

  if (options.recordedPages !== undefined) {
    zip.file(
      'docProps/app.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
        `<Pages>${options.recordedPages}</Pages>` +
        '<Words>412</Words><Application>Microsoft Office Word</Application>' +
        '</Properties>'
    );
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return new Uint8Array(buf);
}

const PARAGRAPHS = [
  'Kartik Bhat',
  'Backend Engineer',
  'EXPERIENCE',
  'Zenpay — Backend Engineer, 2023 to 2026',
  'EDUCATION',
  'BTech Computer Science',
];

describe('extractDocx — page count', () => {
  it('reports the page count Word recorded', async () => {
    const raw = await extractDocx(await buildDocx({ paragraphs: PARAGRAPHS, recordedPages: '3' }));
    // The whole point: a three-page document must not report 1.
    expect(raw.pageCount).toBe(3);
    expect(raw.pagesInDocument).toBe(3);
  });

  it('reports null when the file records no page count', async () => {
    // Normal, not exceptional — Google Docs exports omit app.xml.
    const raw = await extractDocx(await buildDocx({ paragraphs: PARAGRAPHS }));
    expect(raw.pageCount).toBeNull();
    expect(raw.pagesInDocument).toBeUndefined();
  });

  it('does not report 1 as a stand-in for unknown', async () => {
    // Guards the exact regression. 1 is a claim, not a default.
    const raw = await extractDocx(await buildDocx({ paragraphs: PARAGRAPHS }));
    expect(raw.pageCount).not.toBe(1);
  });

  it('still extracts the text when the page count is missing', async () => {
    const raw = await extractDocx(await buildDocx({ paragraphs: PARAGRAPHS }));
    expect(raw.text).toContain('Kartik Bhat');
    expect(raw.text).toContain('EXPERIENCE');
  });

  it.each([
    ['0', 'zero, written by tools that add the element without filling it'],
    ['-2', 'negative'],
    ['99999', 'absurd — we are reading something we do not understand'],
    ['', 'empty'],
    ['three', 'not a number'],
  ])('treats a page count of "%s" as unknown (%s)', async (value) => {
    const raw = await extractDocx(await buildDocx({ paragraphs: PARAGRAPHS, recordedPages: value }));
    expect(raw.pageCount).toBeNull();
  });

  it('survives a corrupt app.xml without failing the whole extraction', async () => {
    // A document that converted successfully must not be rejected over a metadata
    // field. `readRecordedPageCount` never throws.
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    );
    zip.file(
      '_rels/.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    );
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body><w:p><w:r><w:t>Kartik Bhat</w:t></w:r></w:p></w:body></w:document>'
    );
    zip.file('docProps/app.xml', 'this is not xml at all <<<>>>');

    const bytes = new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
    const raw = await extractDocx(bytes);
    expect(raw.pageCount).toBeNull();
    expect(raw.text).toContain('Kartik Bhat');
  });
});
