import { describe, expect, it } from 'vitest';

import {
  csvFilename,
  escapeCsvCell,
  jobsToCsv,
  toCsv,
  type ExportableJob,
} from './csv';

// -----------------------------------------------------------------------------
// CSV export
//
// The injection tests carry the weight here. Every field in this export comes
// from a third-party job board or from user free text, so nothing in it is
// authored by us — and a spreadsheet executes a cell that begins with `=`.
// -----------------------------------------------------------------------------

describe('escapeCsvCell — formula injection', () => {
  it.each([
    ['=HYPERLINK("http://evil","Click")', '='],
    ['+1+1', '+'],
    ['-2+3', '-'],
    ['@SUM(A1:A9)', '@'],
    ['\tinjected', 'TAB'],
    ['\rinjected', 'CR'],
  ])('neutralises a leading %s (%s)', (input) => {
    const cell = escapeCsvCell(input);
    // The apostrophe sits INSIDE the quoted field, so the spreadsheet consumes it
    // as "the rest is literal text" rather than it becoming part of the CSV syntax.
    expect(cell.startsWith('"\'')).toBe(true);
  });

  it('neutralises the Excel DDE form', () => {
    // The variant that can attempt to launch a local process.
    const cell = escapeCsvCell('=cmd|\' /C calc\'!A0');
    expect(cell.startsWith('"\'=')).toBe(true);
  });

  it('leaves ordinary text alone apart from quoting', () => {
    expect(escapeCsvCell('Backend Engineer')).toBe('"Backend Engineer"');
  });

  it('neutralises a negative number, because a spreadsheet cannot tell it from a formula', () => {
    expect(escapeCsvCell(-5)).toBe('"\'-5"');
  });

  it('does not touch a positive number', () => {
    expect(escapeCsvCell(74)).toBe('"74"');
  });
});

describe('escapeCsvCell — CSV structure', () => {
  it('doubles internal quotes', () => {
    expect(escapeCsvCell('Senior "Staff" Engineer')).toBe(
      '"Senior ""Staff"" Engineer"'
    );
  });

  it('keeps a comma inside one cell', () => {
    expect(escapeCsvCell('Bengaluru, Karnataka')).toBe('"Bengaluru, Karnataka"');
  });

  it('preserves newlines inside a cell rather than stripping them', () => {
    // A multi-line note is legitimate content; quoting is what makes it safe.
    expect(escapeCsvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('renders null and undefined as empty, not as the strings', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('does not mistake an empty string for a formula', () => {
    expect(escapeCsvCell('')).toBe('""');
  });
});

describe('toCsv', () => {
  it('emits a UTF-8 BOM so Excel reads it as UTF-8', () => {
    // Without this, a rupee sign or an accented name is mangled on Windows.
    expect(toCsv(['A'], [['x']]).startsWith('\uFEFF')).toBe(true);
  });

  it('uses CRLF line endings per RFC 4180', () => {
    const csv = toCsv(['A', 'B'], [['1', '2']]);
    expect(csv).toBe('\uFEFF"A","B"\r\n"1","2"\r\n');
  });

  it('writes a header-only document when there are no rows', () => {
    expect(toCsv(['A', 'B'], [])).toBe('\uFEFF"A","B"\r\n');
  });
});

describe('jobsToCsv', () => {
  function job(overrides: Partial<ExportableJob> = {}): ExportableJob {
    return {
      company: 'Postman',
      job_title: 'Backend Engineer',
      location: 'Bengaluru',
      is_remote: false,
      status: 'applied',
      match_score: 74,
      url: 'https://example.com/job/1',
      notes: null,
      applied_at: '2026-08-20T10:00:00.000Z',
      created_at: '2026-08-18T09:30:00.000Z',
      source: 'greenhouse',
      ...overrides,
    };
  }

  it('puts the human-scannable columns first', () => {
    const header = jobsToCsv([]).replace('\uFEFF', '').split('\r\n')[0];
    expect(header).toBe(
      '"Company","Role","Location","Remote","Status","Match score","Applied on","Saved on","Source","Link","Notes"'
    );
  });

  it('renders a row in column order', () => {
    const row = jobsToCsv([job()]).split('\r\n')[1];
    expect(row).toBe(
      '"Postman","Backend Engineer","Bengaluru","No","Applied","74","2026-08-20","2026-08-18","greenhouse","https://example.com/job/1",""'
    );
  });

  it('formats dates as ISO so they sort correctly as text', () => {
    // DD/MM vs MM/DD is indistinguishable in a spreadsheet and mis-sorts silently.
    const row = jobsToCsv([job()]).split('\r\n')[1];
    expect(row).toContain('"2026-08-20"');
  });

  it('leaves an unscanned job with an empty match score rather than a zero', () => {
    // 0 would read as "scored badly"; empty reads as "not scored".
    const row = jobsToCsv([job({ match_score: null, scan_id: null } as never)]).split(
      '\r\n'
    )[1];
    expect(row).toContain('"Applied","",');
  });

  it('survives a hostile job title from a third-party board', () => {
    const csv = jobsToCsv([job({ job_title: '=1+1' })]);
    expect(csv).toContain('"\'=1+1"');
  });

  it('survives a hostile note written by the user', () => {
    const csv = jobsToCsv([job({ notes: '@SUM(A1:A9)' })]);
    expect(csv).toContain('"\'@SUM(A1:A9)"');
  });

  it('keeps one row per job even with newlines in a note', () => {
    const csv = jobsToCsv([job({ notes: 'spoke to\nthe recruiter' })]);
    // Header + the row (whose embedded newline splits it) + trailing empty.
    expect(csv.split('\r\n').filter((l) => l.length > 0)).toHaveLength(2);
  });

  it('handles an empty tracker', () => {
    expect(jobsToCsv([]).split('\r\n').filter((l) => l).length).toBe(1);
  });
});

describe('csvFilename', () => {
  it('is dated, so repeated downloads do not collide', () => {
    expect(csvFilename(new Date('2026-08-25T12:00:00Z'))).toBe(
      'unviewable-jobs-2026-08-25.csv'
    );
  });
});
