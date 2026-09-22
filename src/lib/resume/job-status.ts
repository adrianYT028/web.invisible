// -----------------------------------------------------------------------------
// Tracker pipeline stages
// -----------------------------------------------------------------------------
//
// Migration 012 enforces an invariant that is easy to violate from a route:
//
//   applied_at IS NULL      for 'saved' and 'archived'
//   applied_at IS NOT NULL  for every other status
//
// A status change therefore has to move `applied_at` with it, or the UPDATE is
// rejected by the database and the user sees a failed save for what looks like a
// simple dropdown change. That coupling lives here, in one place, rather than
// being re-derived by every caller that touches a status.

export const JOB_STATUSES = [
  'saved',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'archived',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses that must NOT carry an applied date. */
const PRE_APPLICATION: ReadonlySet<string> = new Set(['saved', 'archived']);

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * The `applied_at` value that must accompany a move to `next`.
 *
 * `existing` is preserved when the job was already past the application stage, so
 * advancing from 'applied' to 'interviewing' keeps the original application date
 * rather than resetting it to now — the date the user applied does not change
 * because they got an interview.
 *
 * Moving back to 'saved' or 'archived' clears it, which the CHECK constraint
 * requires and which is also the honest reading: the row no longer claims an
 * application was sent.
 */
export function appliedAtFor(
  next: JobStatus,
  existing: string | null,
  now: Date = new Date()
): string | null {
  if (PRE_APPLICATION.has(next)) return null;
  return existing ?? now.toISOString();
}
