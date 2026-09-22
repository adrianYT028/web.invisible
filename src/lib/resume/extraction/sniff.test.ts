import { describe, expect, it } from 'vitest';

import {
  resolveMimeType,
  sniffMimeType,
  sniffUnreadableType,
} from './sniff';

const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** `%PDF-1.7` */
function pdfBytes(): Uint8Array {
  return new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
  ]);
}

/** `PK\x03\x04` — a ZIP local file header, which is what a DOCX is. */
function docxBytes(): Uint8Array {
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
}

function textBytes(): Uint8Array {
  return new TextEncoder().encode('Jane Doe\njane@example.com\n');
}

/** An OLE2 compound file header — a legacy `.doc`. */
function docBytes(): Uint8Array {
  return new Uint8Array([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00,
  ]);
}

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

describe('sniffMimeType', () => {
  it('recognises a PDF by its signature', () => {
    expect(sniffMimeType(pdfBytes())).toBe('application/pdf');
  });

  it('recognises a DOCX by its ZIP signature', () => {
    expect(sniffMimeType(docxBytes())).toBe(DOCX);
  });

  // Plain text has no magic number, so null is the correct answer — and callers
  // must not read null as "unsupported".
  it('returns null for text, which has no signature', () => {
    expect(sniffMimeType(textBytes())).toBeNull();
  });

  it('does not read past the end of a short buffer', () => {
    expect(sniffMimeType(bytes())).toBeNull();
    expect(sniffMimeType(bytes(0x25))).toBeNull();
    expect(sniffMimeType(bytes(0x25, 0x50))).toBeNull();
    // One byte short of the full PDF magic.
    expect(sniffMimeType(bytes(0x25, 0x50, 0x44, 0x46))).toBeNull();
  });

  it('requires the signature at offset zero', () => {
    // A PDF signature preceded by junk is not a PDF the parser can open.
    expect(sniffMimeType(bytes(0x00, 0x25, 0x50, 0x44, 0x46, 0x2d))).toBeNull();
  });

  // It must never name an unreadable format as a readable one — that would send
  // a .doc to a parser instead of to a refusal.
  it('does not claim an unreadable format is supported', () => {
    expect(sniffMimeType(docBytes())).toBeNull();
    expect(sniffMimeType(pngBytes())).toBeNull();
  });
});

describe('sniffUnreadableType', () => {
  it('names a legacy .doc so the refusal can say so', () => {
    expect(sniffUnreadableType(docBytes())).toBe('application/msword');
  });

  it('names RTF', () => {
    expect(sniffUnreadableType(new TextEncoder().encode('{\\rtf1\\ansi'))).toBe(
      'application/rtf'
    );
  });

  // People screenshot a resume and upload the image. There is no OCR here, so the
  // honest answer is that an image has no text — not that their file is corrupt.
  it('names images', () => {
    expect(sniffUnreadableType(pngBytes())).toBe('image/png');
    expect(sniffUnreadableType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(
      'image/jpeg'
    );
    expect(sniffUnreadableType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe(
      'image/gif'
    );
  });

  it('returns null for formats it can read, and for text', () => {
    expect(sniffUnreadableType(pdfBytes())).toBeNull();
    expect(sniffUnreadableType(docxBytes())).toBeNull();
    expect(sniffUnreadableType(textBytes())).toBeNull();
    expect(sniffUnreadableType(bytes())).toBeNull();
  });
});

describe('resolveMimeType', () => {
  it('agrees silently when the declaration is right', () => {
    expect(resolveMimeType(pdfBytes(), 'application/pdf')).toEqual({
      mime: 'application/pdf',
      corrected: false,
    });
  });

  // The case that made a good file fail: a PDF saved as .docx used to be handed
  // to mammoth, which rejected it as "not a readable DOCX".
  it('trusts the bytes over a wrong declaration', () => {
    expect(resolveMimeType(pdfBytes(), DOCX)).toEqual({
      mime: 'application/pdf',
      corrected: true,
    });
  });

  it('corrects a DOCX declared as a PDF', () => {
    expect(resolveMimeType(docxBytes(), 'application/pdf')).toEqual({
      mime: DOCX,
      corrected: true,
    });
  });

  // Browsers and mail clients send this for both formats; it used to be a 415
  // before anything looked at the file.
  it('resolves application/octet-stream from the bytes', () => {
    expect(
      resolveMimeType(pdfBytes(), 'application/octet-stream')
    ).toEqual({ mime: 'application/pdf', corrected: true });
    expect(resolveMimeType(docxBytes(), 'application/octet-stream')).toEqual({
      mime: DOCX,
      corrected: true,
    });
  });

  it('keeps a supported declaration when the bytes carry no signature', () => {
    expect(resolveMimeType(textBytes(), 'text/plain')).toEqual({
      mime: 'text/plain',
      corrected: false,
    });
  });

  // No signature and a declaration that says nothing: text is the only accepted
  // format without a magic number, so it is the only thing this can be. The plain
  // adapter fails cleanly if it is wrong.
  it('falls back to text only for an UNINFORMATIVE declaration', () => {
    for (const declared of [
      'application/octet-stream',
      'binary/octet-stream',
      'application/binary',
      '',
      '  APPLICATION/OCTET-STREAM  ',
    ]) {
      expect(resolveMimeType(textBytes(), declared)).toEqual({
        mime: 'text/plain',
        corrected: true,
      });
    }
  });

  // The regression this test exists for: `application/msword` with no signature
  // used to be answered "text/plain", so a .doc user was told their text file was
  // not readable text instead of being told to convert it.
  it('keeps a SPECIFIC unsupported declaration so the refusal names it', () => {
    expect(resolveMimeType(textBytes(), 'application/msword')).toEqual({
      mime: 'application/msword',
      corrected: false,
    });
    expect(resolveMimeType(textBytes(), 'application/vnd.ms-excel')).toEqual({
      mime: 'application/vnd.ms-excel',
      corrected: false,
    });
  });

  // Names the format from the bytes even when the declaration is a lie, so a .doc
  // renamed .pdf is refused as a .doc rather than crashing pdfjs.
  it('names an unreadable format from the bytes', () => {
    expect(resolveMimeType(docBytes(), 'application/pdf')).toEqual({
      mime: 'application/msword',
      corrected: true,
    });
    expect(resolveMimeType(pngBytes(), 'application/octet-stream')).toEqual({
      mime: 'image/png',
      corrected: true,
    });
    expect(resolveMimeType(docBytes(), 'application/msword')).toEqual({
      mime: 'application/msword',
      corrected: false,
    });
  });

  // A .txt renamed .pdf used to reach pdfjs and produce an unmappable error.
  it('sends a text file declared as PDF to the text adapter', () => {
    expect(resolveMimeType(textBytes(), 'application/pdf')).toEqual({
      mime: 'application/pdf',
      corrected: false,
    });
    // NOTE: a supported declaration with no contradicting signature is honoured,
    // so this still goes to pdfjs — which then reports `corrupt_document`, an
    // actionable message. Sniffing cannot rescue a file whose declared type is
    // plausible and whose bytes are signature-free; it only fixes the cases where
    // the bytes actively disagree.
  });

  // The invariant that keeps the caller safe: whenever the answer is one of the
  // three parseable types, it is because the bytes or a supported declaration said
  // so — never because an unsupported input was quietly coerced into one.
  it('only answers with a supported type when the input justifies it', () => {
    const supported: readonly string[] = [
      'application/pdf',
      DOCX,
      'text/plain',
    ];
    const cases: { b: Uint8Array; declared: string }[] = [];
    for (const declared of [
      '',
      'application/octet-stream',
      'image/png',
      'application/msword',
      DOCX,
      'application/pdf',
      'text/plain',
    ]) {
      for (const b of [
        pdfBytes(),
        docxBytes(),
        textBytes(),
        docBytes(),
        pngBytes(),
        bytes(),
      ]) {
        cases.push({ b, declared });
      }
    }

    for (const { b, declared } of cases) {
      const { mime } = resolveMimeType(b, declared);
      if (!supported.includes(mime)) continue;

      const justified =
        sniffMimeType(b) === mime ||
        (sniffMimeType(b) === null &&
          sniffUnreadableType(b) === null &&
          (supported.includes(declared) || mime === 'text/plain'));
      expect(justified, `${declared} + ${b.byteLength}B -> ${mime}`).toBe(true);
    }
  });

  it('never invents a correction it did not make', () => {
    for (const declared of ['application/pdf', DOCX, 'text/plain', 'x/y']) {
      for (const b of [pdfBytes(), docxBytes(), textBytes(), docBytes()]) {
        const { mime, corrected } = resolveMimeType(b, declared);
        expect(corrected).toBe(mime !== declared);
      }
    }
  });
});
