// -----------------------------------------------------------------------------
// Job index sync
// -----------------------------------------------------------------------------
//
// Polls the registered boards and reconciles `job_postings`.
//
// THREE PROPERTIES THAT MATTER MORE THAN SPEED
//
//   IDEMPOTENT. Re-running the sync must not duplicate rows or reset dates. Every
//   write is an upsert on (source, external_id), and `first_seen_at` is never
//   overwritten — it is how "posted 3 days ago" stays true across runs.
//
//   POSTINGS CLOSE, THEY DO NOT DISAPPEAR. A role vanishing from a board means it
//   was filled. Deleting the row would erase history a user may have tracked or
//   scanned against, so rows not seen in a run are marked `is_open = false`.
//
//   ONE COMPANY'S FAILURE IS NOT THE RUN'S FAILURE. A dead slug or a slow board
//   records its error on that company and the run continues. A sync that aborts
//   on the first 404 would leave the whole index stale because of one typo.

import { type SupabaseClient } from '@supabase/supabase-js';

import { logSafe } from '@/lib/http';
import {
  fetchBoard,
  isIndiaLocation,
  type FetchedPosting,
  type JobSource,
} from './sources';

/**
 * Companies polled per run.
 *
 * Bounded so a scheduled invocation finishes inside a serverless time limit. The
 * queue is ordered by least-recently-synced, so consecutive runs rotate through
 * the whole registry rather than re-polling the same head every time.
 */
const DEFAULT_BATCH = 25;

/** Concurrent board fetches. Enough to be quick, low enough to be a good citizen. */
const CONCURRENCY = 5;

export interface CompanyRow {
  id: string;
  source: JobSource;
  slug: string;
  name: string;
}

export interface SyncReport {
  companiesPolled: number;
  postingsUpserted: number;
  postingsClosed: number;
  failures: Array<{ slug: string; source: string; error: string }>;
}

/**
 * Poll the least-recently-synced active companies and reconcile their postings.
 */
export async function syncJobIndex(
  admin: SupabaseClient,
  options: { batchSize?: number; now?: Date } = {}
): Promise<SyncReport> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const now = options.now ?? new Date();

  const { data, error } = await admin
    .from('job_companies')
    .select('id, source, slug, name')
    .eq('is_active', true)
    // NULLs first so a newly registered company is picked up immediately.
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(batchSize);

  if (error) {
    logSafe('job_sync_queue_failed', { error: error.message });
    return {
      companiesPolled: 0,
      postingsUpserted: 0,
      postingsClosed: 0,
      failures: [],
    };
  }

  const companies = (data ?? []) as CompanyRow[];
  const report: SyncReport = {
    companiesPolled: 0,
    postingsUpserted: 0,
    postingsClosed: 0,
    failures: [],
  };

  // Fixed-size windows rather than one big Promise.all: the point is to cap how
  // many outbound requests exist at once.
  for (let i = 0; i < companies.length; i += CONCURRENCY) {
    const window = companies.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      window.map((company) => syncOneCompany(admin, company, now))
    );
    for (const r of results) {
      report.companiesPolled++;
      report.postingsUpserted += r.upserted;
      report.postingsClosed += r.closed;
      if (r.error) {
        report.failures.push({
          slug: r.company.slug,
          source: r.company.source,
          error: r.error,
        });
      }
    }
  }

  logSafe('job_sync_complete', {
    companies: report.companiesPolled,
    upserted: report.postingsUpserted,
    closed: report.postingsClosed,
    failures: report.failures.length,
  });

  return report;
}

interface CompanySyncResult {
  company: CompanyRow;
  upserted: number;
  closed: number;
  error: string | null;
}

async function syncOneCompany(
  admin: SupabaseClient,
  company: CompanyRow,
  now: Date
): Promise<CompanySyncResult> {
  const { postings, error } = await fetchBoard(company.source, company.slug);

  if (error) {
    // Recorded against the company so a dead slug is visible rather than looking
    // like a company that simply has no openings.
    await admin
      .from('job_companies')
      .update({ last_synced_at: now.toISOString(), last_sync_error: error })
      .eq('id', company.id);
    return { company, upserted: 0, closed: 0, error };
  }

  const seenAt = now.toISOString();
  let upserted = 0;

  if (postings.length > 0) {
    const rows = postings.map((p) => toRow(p, company.id, seenAt));
    const { error: upsertError } = await admin
      .from('job_postings')
      .upsert(rows, { onConflict: 'source,external_id' });

    if (upsertError) {
      logSafe('job_sync_upsert_failed', {
        slug: company.slug,
        error: upsertError.message,
      });
      await admin
        .from('job_companies')
        .update({
          last_synced_at: seenAt,
          last_sync_error: `upsert: ${upsertError.message.slice(0, 100)}`,
        })
        .eq('id', company.id);
      return { company, upserted: 0, closed: 0, error: upsertError.message };
    }
    upserted = rows.length;
  }

  // Anything still open for this company that this run did NOT see has been
  // filled or withdrawn. Closed, not deleted.
  const { data: closedRows } = await admin
    .from('job_postings')
    .update({ is_open: false })
    .eq('company_id', company.id)
    .eq('is_open', true)
    .lt('last_seen_at', seenAt)
    .select('id');

  await admin
    .from('job_companies')
    .update({
      last_synced_at: seenAt,
      last_sync_error: null,
      last_posting_count: postings.length,
    })
    .eq('id', company.id);

  return {
    company,
    upserted,
    closed: closedRows?.length ?? 0,
    error: null,
  };
}

/**
 * A fetched posting as a database row.
 *
 * `first_seen_at` is deliberately absent: it has a column default, so an upsert
 * of an existing row leaves the original value untouched. Including it would
 * reset the discovery date on every sync and make every posting look new.
 */
export function toRow(
  posting: FetchedPosting,
  companyId: string,
  seenAt: string
): Record<string, unknown> {
  return {
    company_id: companyId,
    source: posting.source,
    external_id: posting.externalId,
    title: posting.title,
    location: posting.location,
    is_remote: posting.isRemote,
    is_india: isIndiaLocation(posting.location),
    url: posting.url,
    description: posting.description,
    posted_at: posting.postedAt,
    last_seen_at: seenAt,
    // A posting reappearing on a board after being closed is open again.
    is_open: true,
  };
}
