// -----------------------------------------------------------------------------
// Prep-run export
// -----------------------------------------------------------------------------
//
// Turns one prep run into a spreadsheet a person can actually work from: one row
// per job, with the link, the score, the draft email, and the tailored bullets
// side by side.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS SEPARATELY FROM THE TRACKER EXPORT
//
// `/api/jobs/export` exports `tracked_jobs`, and a prep run does not write to
// `tracked_jobs` at all. So everything a run actually produces — the draft email,
// the contact, the tailored bullets, the per-item outcome — was unreachable in any
// file the user could download, even though the prep UI tells them "full reports
// are on your tracker".
//
// ---------------------------------------------------------------------------
// ONE ROW PER JOB, NOT ONE ROW PER BULLET
//
// The alternative shape — one row per rewritten bullet, so the tailoring columns
// are flat — reads better for reviewing rewrites in isolation. It was rejected
// because it answers the wrong question. Someone downloading this is working
// through a shortlist: open the link, check the score, paste the bullets, send the
// email. That is a per-job loop, and a per-bullet sheet makes the common case
// (jobs with no rewrites vanish, the email repeats on every row) worse to serve
// the rarer one. Bullets are stacked and NUMBERED inside their cells instead, so
// original / tailored / reason still line up by eye.
//
// ---------------------------------------------------------------------------
// THE RATIONALE COLUMN IS NOT OPTIONAL
//
// Every rewrite here already passed the mechanical anti-fabrication check in
// ai/verify-no-new-facts.ts — a suggestion that invented a number or a technology
// was dropped before it was ever stored. But that check is explicit about what it
// cannot see: "supported the migration" becoming "led the migration" adds no new
// token, so no token-level check catches it. The stated mitigation is that the
// rationale is shown to the user for every suggestion, and the human is the last
// check.
//
// An export that carried the rewritten bullets WITHOUT their rationale would
// remove that last check at exactly the moment the user is furthest from the
// product and closest to pasting text into a real application. So a tailored
// bullet is never emitted without its reason, and `assertRationalePaired` in the
// tests holds that.

import { datedCsvFilename, toCsv, type CsvRow } from '@/lib/resume/csv';

/**
 * One prep item as the export reads it.
 *
 * Deliberately shaped like the database row rather than like the API's `shapeItem`
 * output: the export needs `completed_at` and the raw scan report, neither of
 * which the client shape carries.
 */
export interface ExportablePrepItem {
  status: string;
  error: string | null;
  match_score: number | null;
  email_subject: string | null;
  email_body: string | null;
  contact_hint: string | null;
  completed_at: string | null;
  job_postings: {
    title?: string | null;
    location?: string | null;
    is_remote?: boolean | null;
    url?: string | null;
    job_companies?: { name?: string | null } | null;
  } | null;
  /** `resume_scans.report`. Untrusted jsonb — read defensively. */
  resume_scans: { report?: unknown } | null;
}

/**
 * Column order.
 *
 * Everything scannable comes first so the whole shortlist is readable without
 * scrolling: who, what, where, how well matched, what happened. The long free-text
 * columns — the email and the bullets — are last, because a spreadsheet with a
 * 400-character cell in column C is unusable.
 */
const COLUMNS = [
  'Company',
  'Role',
  'Location',
  'Remote',
  'Match score',
  'Outcome',
  'Prepared on',
  'Link',
  'Email to',
  'Contact notes',
  'Email subject',
  'Email body',
  'Original bullet',
  'Tailored bullet',
  'Why the change',
  'Gaps to close',
] as const;

/** Render one prep run as a CSV document. */
export function prepRunToCsv(items: readonly ExportablePrepItem[]): string {
  const rows: CsvRow[] = items.map((item) => {
    const posting = item.job_postings;
    const rewrites = readRewrites(item.resume_scans?.report);
    const contact = item.contact_hint;
    const hasAddress = isEmailAddress(contact);

    return [
      posting?.job_companies?.name ?? '',
      posting?.title ?? '',
      posting?.location ?? '',
      posting?.is_remote ? 'Yes' : 'No',
      item.match_score ?? '',
      outcomeLabel(item.status, item.error),
      formatDate(item.completed_at),
      posting?.url ?? '',
      hasAddress ? contact : '',
      hasAddress ? '' : (contact ?? ''),
      item.email_subject ?? '',
      item.email_body ?? '',
      numbered(rewrites.map((r) => r.original)),
      numbered(rewrites.map((r) => r.rewritten)),
      numbered(rewrites.map(reasonFor)),
      numbered(readGenuineGaps(item.resume_scans?.report)),
    ];
  });

  return toCsv(COLUMNS, rows);
}

/**
 * A dated filename carrying a short run discriminator.
 *
 * Two runs on the same day would otherwise produce the same name and the browser
 * would silently write `… (1).csv`, which is how someone ends up applying from
 * yesterday's shortlist. The discriminator is the leading segment of the run's own
 * UUID, which the user already has in the URL they requested.
 */
export function prepCsvFilename(runId: string, now: Date = new Date()): string {
  return datedCsvFilename(`prep-${runId.slice(0, 8)}`, now);
}

// -----------------------------------------------------------------------------
// Outcome
// -----------------------------------------------------------------------------

/**
 * Every code `prepareItem` can write to `prep_items.error`, in words a user can
 * act on.
 *
 * Failed and skipped items are exported rather than filtered out. A sheet holding
 * 7 rows for a run of 10 reads as "the tool did less than it promised"; a sheet
 * that says why the other 3 are empty reads as a tool that knows what happened.
 *
 * The set comes from three places in the code, which is why `prep-csv.test.ts`
 * re-derives it from the source rather than trusting this list: `no_description`
 * from the skip path, `parse_quality_too_low` from `ParseGateError`, `internal_error`
 * from the fallback, and the rest from `AiExtractionError`'s `code` union, which is
 * assigned straight through. The first live export rendered "Failed — truncated"
 * because that union had grown past this map.
 */
export const FAILURE_REASONS: Record<string, string> = {
  no_description: 'Skipped — the posting published no job description',
  parse_quality_too_low:
    'Failed — your resume could not be read well enough to score against this role',
  not_configured: 'Failed — no AI key was configured when this ran',
  truncated:
    'Failed — the analysis was cut off before it finished. Re-running usually fixes it',
  invalid_json: 'Failed — the analysis came back unreadable. Re-running usually fixes it',
  rate_limited: 'Failed — the AI provider was rate limited. Try this one again later',
  upstream_unavailable: 'Failed — the AI provider was unreachable. Try again later',
  upstream_error: 'Failed — the AI provider returned an error. Try again later',
  internal_error: 'Failed — something broke on our side, not in your resume',
};

/** A human outcome for one item. */
export function outcomeLabel(status: string, error: string | null): string {
  if (status === 'done') return 'Ready';
  if (error && FAILURE_REASONS[error]) return FAILURE_REASONS[error];
  if (error) {
    // An unmapped code still names itself rather than collapsing to "failed".
    // Truncated because it is written by a provider, not by us.
    return `${titleCase(status)} — ${error.slice(0, 80)}`;
  }
  // 'queued' and 'running' reach here when a run is exported before it finished,
  // which is allowed: a partial sheet is useful and the status says so.
  return titleCase(status);
}

function titleCase(text: string): string {
  return text.length === 0 ? '' : text.charAt(0).toUpperCase() + text.slice(1);
}

// -----------------------------------------------------------------------------
// Reading the stored report
// -----------------------------------------------------------------------------

/** A rewrite, once it has been proved to be one. */
interface ExportableRewrite {
  original: string;
  rewritten: string;
  rationale: string;
  addedNoNewFacts: boolean;
}

/**
 * Pull the rewrites out of `resume_scans.report`.
 *
 * Validated field by field rather than cast. This is jsonb: the column is typed
 * `jsonb not null default '{}'`, rows predate the current schema version, and a
 * cast would turn a missing `rewritten` into the string "undefined" in a cell the
 * user is about to paste into a job application.
 */
function readRewrites(report: unknown): ExportableRewrite[] {
  if (!isRecord(report)) return [];
  const raw = report.rewrite;
  if (!Array.isArray(raw)) return [];

  const out: ExportableRewrite[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const original = asText(entry.original);
    const rewritten = asText(entry.rewritten);
    // A rewrite with nothing to show, or nothing to compare against, is not
    // exportable — the whole point of the pair is that a human can judge it.
    if (!original || !rewritten) continue;
    out.push({
      original,
      rewritten,
      rationale: asText(entry.rationale),
      addedNoNewFacts: entry.addedNoNewFacts === true,
    });
  }
  return out;
}

function readGenuineGaps(report: unknown): string[] {
  if (!isRecord(report)) return [];
  const raw = report.genuineGaps;
  if (!Array.isArray(raw)) return [];
  return raw.map(asText).filter((gap) => gap.length > 0);
}

/**
 * The reason text for one rewrite.
 *
 * Two things are load-bearing here.
 *
 * A MISSING rationale gets an explicit instruction rather than an empty cell.
 * Current code always writes one, but scans stored before that fallback existed
 * may not have, and a blank "why" next to a suggested change reads as "no reason
 * needed" instead of "no reason recorded".
 *
 * `addedNoNewFacts === false` is FLAGGED. It is the model's own admission that it
 * added something, on a suggestion the mechanical verifier nonetheless passed —
 * so the two disagree, and the export is the surface where a human is most likely
 * to paste without thinking. The schema keeps this claim precisely so a violation
 * is detectable afterwards; surfacing it here is what makes it detectable by the
 * person it would harm.
 */
function reasonFor(rewrite: ExportableRewrite): string {
  const reason =
    rewrite.rationale.length > 0
      ? rewrite.rationale
      : 'No reason was recorded for this change — check it against your own record before using it.';

  return rewrite.addedNoNewFacts
    ? reason
    : `[CHECK THIS ONE] The model did not confirm it stuck to facts already in your resume. ${reason}`;
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

/**
 * Stack values in one cell as a numbered list.
 *
 * The numbers are what let the three tailoring columns be read together: bullet 2
 * in "Tailored bullet" is bullet 2 in "Why the change". A bare newline-joined list
 * loses that as soon as one entry wraps.
 *
 * A single value is emitted unnumbered — "1. " in front of a lone item is noise.
 */
export function numbered(values: readonly string[]): string {
  const present = values.filter((value) => value.trim().length > 0);
  if (present.length === 0) return '';
  if (present.length === 1) return present[0];
  return present.map((value, i) => `${i + 1}. ${value}`).join('\n');
}

/** True for something that is an address rather than guidance prose. */
function isEmailAddress(contact: string | null): contact is string {
  return contact !== null && contact.includes('@') && !contact.includes(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** ISO timestamp to `YYYY-MM-DD`. Sorts correctly as text in every tool. */
function formatDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
