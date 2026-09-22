import { beforeEach, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// PDF adapter — failure containment
//
// WHY THIS FILE MOCKS pdfjs WHEN extract.integration.test.ts DELIBERATELY DOES NOT
//
// The integration tests build real PDFs and run the real library, which is the
// right way to prove that layout inference is driven correctly. It is the wrong
// way to prove what happens when page 3 of 4 fails: making a hand-built PDF fail
// at a chosen page, and only there, means encoding a specific pdfjs recovery path
// into a fixture — which is both unreadable and pinned to a library version.
//
// The behaviour under test is not pdfjs's, it is ours: the shape of the try/catch
// around the page loop. So this file replaces the library with a driver that fails
// exactly where asked.
//
// THE BUG THIS GUARDS. Only `getDocument` used to be wrapped. A failure part-way
// through the loop escaped `extractPdf` as a raw error, so the upload route
// answered `500 internal_error` — telling the user our server was broken when
// their file was the problem, and giving them nothing to do about it. A document
// that opens but cannot be read past page N is a document problem: 422, with the
// page named.
// -----------------------------------------------------------------------------

const logSafe = vi.fn();
vi.mock('@/lib/http', () => ({
  logSafe: (...args: unknown[]) => logSafe(...args),
}));

/** Matches the subset of the pdfjs surface that pdf.ts actually touches. */
interface FakePage {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  getTextContent: () => Promise<{ items: unknown[] }>;
  getOperatorList: () => Promise<{ fnArray: number[] }>;
  cleanup: () => void;
}

const getDocument = vi.fn();
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: (...args: unknown[]) => getDocument(...args),
  OPS: {
    paintImageXObject: 85,
    paintInlineImageXObject: 86,
    paintImageMaskXObject: 87,
    paintJpegXObject: 88,
  },
}));

/** One text run at a position, in the tuple layout pdfjs reports. */
function textItem(str: string, x: number, y: number) {
  return { str, transform: [1, 0, 0, 1, x, y], width: str.length * 5 };
}

/**
 * A page whose text is one line per entry, laid out top-down in a single column
 * so ./layout.ts sees an ordinary page rather than an accidental table.
 */
function page(lines: string[]): FakePage {
  return {
    getViewport: () => ({ width: 612, height: 792 }),
    getTextContent: async () => ({
      items: lines.map((line, i) => textItem(line, 72, 740 - i * 20)),
    }),
    getOperatorList: async () => ({ fnArray: [] }),
    cleanup: () => {},
  };
}

const FAIL = Symbol('fail');

/**
 * Install a fake document.
 *
 * `pages` may contain FAIL, meaning "this page throws when read". `numPages`
 * defaults to the array length but can be set higher to model a document that
 * claims more pages than it hands over.
 */
function mockDocument(
  pages: (FakePage | typeof FAIL)[],
  options: { numPages?: number; cleanupRejects?: boolean } = {}
) {
  const doc = {
    numPages: options.numPages ?? pages.length,
    getPage: vi.fn(async (n: number) => {
      const entry = pages[n - 1];
      if (entry === FAIL || entry === undefined) {
        const err = new Error(`page ${n} is unreadable`);
        err.name = 'FormatError';
        throw err;
      }
      return entry;
    }),
    cleanup: vi.fn(async () => {
      if (options.cleanupRejects) throw new Error('cleanup failed');
    }),
  };
  getDocument.mockReturnValue({ promise: Promise.resolve(doc) });
  return doc;
}

async function extract(bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])) {
  const { extractPdf } = await import('./pdf');
  return extractPdf(bytes);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractPdf — a page failing mid-document', () => {
  it('salvages the pages it did read instead of losing the whole upload', async () => {
    mockDocument([
      page(['Aarav Sharma', 'aarav@example.com', 'EXPERIENCE']),
      page(['Backend Engineering Intern', 'Rebuilt the reconciliation job']),
      FAIL,
    ]);

    const raw = await extract();

    expect(raw.text).toContain('Aarav Sharma');
    expect(raw.text).toContain('Rebuilt the reconciliation job');
    expect(raw.pages).toHaveLength(2);
    expect(raw.hasTextLayer).toBe(true);
  });

  it('reports pages READ separately from pages the document claims', async () => {
    mockDocument([page(['Aarav Sharma', 'EXPERIENCE']), FAIL, FAIL]);

    const raw = await extract();

    // The distinction the diagnostics depend on: a 3-page document that yielded
    // one page of text must not report 3, or thin content reads as a sparse
    // resume rather than as a failed read.
    expect(raw.pageCount).toBe(1);
    expect(raw.pagesInDocument).toBe(3);
  });

  it('never lets a raw error escape, which is what produced a 500', async () => {
    mockDocument([FAIL]);

    const err = await extract().catch((e: unknown) => e);

    // The assertion is about the CLASS, not the message: the upload route maps
    // ExtractionError to 422 and anything else to 500 internal_error.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('ExtractionError');
    expect((err as { code: string }).code).toBe('extraction_failed');
  });

  it('names the first page when nothing at all could be read', async () => {
    mockDocument([FAIL, FAIL]);

    await expect(extract()).rejects.toThrow(/first page could not be read/i);
  });

  it('names the page it stopped at when no text was recovered', async () => {
    // Two pages that parse but carry no text — a scan — then a hard failure.
    // There is nothing to salvage, so this is fatal, and the message has to say
    // where it stopped rather than blaming page one.
    mockDocument([page([]), page([]), FAIL]);

    await expect(extract()).rejects.toThrow(/past page 2/i);
  });

  it('preserves the underlying error as `cause` for debugging', async () => {
    mockDocument([FAIL]);

    const err = (await extract().catch((e: unknown) => e)) as Error;

    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toMatch(/unreadable/);
  });

  it('logs the failure with the page numbers and no document content', async () => {
    mockDocument([page(['Aarav Sharma', 'EXPERIENCE']), FAIL], {
      numPages: 2,
    });

    await extract();

    expect(logSafe).toHaveBeenCalledWith(
      'resume_pdf_page_failure',
      expect.objectContaining({ page: 2, pages_read: 1, of: 2 })
    );
    const [, fields] = logSafe.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.stringify(fields)).not.toContain('Aarav');
  });
});

describe('extractPdf — surrounding guarantees', () => {
  it('does not lose a successful read when cleanup rejects', async () => {
    mockDocument([page(['Aarav Sharma', 'EXPERIENCE'])], {
      cleanupRejects: true,
    });

    const raw = await extract();

    expect(raw.text).toContain('Aarav Sharma');
  });

  it('caps pages read and records the real length so truncation is visible', async () => {
    const pages = Array.from({ length: 40 }, (_, i) =>
      page([`Page ${i + 1} heading`, 'some body text on this page'])
    );
    mockDocument(pages);

    const raw = await extract();

    expect(raw.pageCount).toBe(15);
    expect(raw.pagesInDocument).toBe(40);
    // The cap is not a failure, so nothing is thrown and nothing is logged as one.
    expect(logSafe).not.toHaveBeenCalledWith(
      'resume_pdf_page_failure',
      expect.anything()
    );
  });

  it('reports no text layer for a document that parses but has no text', async () => {
    mockDocument([page([]), page([])]);

    const raw = await extract();

    expect(raw.hasTextLayer).toBe(false);
    expect(raw.pageCount).toBe(2);
  });

  it('hands pdfjs a COPY of the bytes, since it takes ownership of the buffer', async () => {
    mockDocument([page(['Aarav Sharma'])]);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

    await extract(bytes);

    const [options] = getDocument.mock.calls[0] as [{ data: Uint8Array }];
    expect(options.data).not.toBe(bytes);
    expect(Array.from(options.data)).toEqual(Array.from(bytes));
  });
});
