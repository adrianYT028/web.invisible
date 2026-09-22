import { NextResponse } from 'next/server';

import { requireCronSecret } from '@/lib/cron/auth';
import { logSafe } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** Storage deletions are batched network calls; the default would be tight. */
export const maxDuration = 120;

// -----------------------------------------------------------------------------
// POST /api/cron/reap-resumes — enforce the 90-day resume retention window
//
// Migration 011 gives every `resumes` row `expires_at = now() + 90 days` and ships
// a `delete_expired_resumes()` function, with a comment stating that a scheduled
// job must call it AND delete the returned Storage objects. That job was never
// built. The column, the function and the promise have all existed since the
// feature shipped; nothing has ever actually deleted anything.
//
// Nothing is overdue yet — the earliest expiry on the live database is still
// months away — so this lands before the first violation rather than after.
//
// ---------------------------------------------------------------------------
// WHY THIS DOES NOT USE delete_expired_resumes()
//
// That function deletes the rows and returns their Storage paths in one
// statement, which forces the wrong failure ordering: the row is gone before the
// file is, so if the Storage call then fails the file survives with nothing left
// pointing at it. Orphaned personal data that no query can find is the exact
// outcome the retention window exists to prevent, and it is unrecoverable
// without trawling the bucket by hand.
//
// So this reads the expired rows first, deletes the FILES, and only then deletes
// the rows. The failure directions become:
//
//   Storage delete fails  -> nothing is deleted, retried next run.
//   Row delete fails      -> file gone, row remains and points at nothing.
//                            Harmless (the scan path already treats a missing
//                            object as unreadable) and self-correcting, because
//                            the row is still expired and gets picked up again.
//
// Both are recoverable. The version this replaces was not.
//
// `delete_expired_resumes()` is left in place as a manual SQL fallback.
// -----------------------------------------------------------------------------

/**
 * Rows per run. Bounds the wall clock so one run cannot exceed `maxDuration`, and
 * bounds the damage of a mistake. The reaper runs daily against a 90-day window,
 * so a backlog this large would itself be the anomaly worth noticing.
 */
const MAX_PER_RUN = 500;

/** Storage `remove()` takes an array; this caps how many paths go per call. */
const STORAGE_BATCH = 100;

interface ExpiredRow {
  id: string;
  storage_bucket: string;
  storage_path: string;
}

export async function POST(request: Request) {
  const denied = requireCronSecret(request, 'resume_reaper');
  if (denied) return denied;

  const admin = supabaseAdmin();
  const nowIso = new Date().toISOString();

  // --- 1. Find what is due -------------------------------------------------
  const { data, error } = await admin
    .from('resumes')
    .select('id, storage_bucket, storage_path')
    .lte('expires_at', nowIso)
    // Oldest first, so a backlog drains in the order it accumulated.
    .order('expires_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    logSafe('resume_reaper_select_failed', { error: error.message });
    // 500 so the scheduler retries.
    return NextResponse.json({ code: 'internal_error' }, { status: 500 });
  }

  const rows = (data ?? []) as ExpiredRow[];
  if (rows.length === 0) {
    logSafe('resume_reaper_nothing_due');
    return NextResponse.json({ ok: true, expired: 0, files: 0, rows: 0 });
  }

  // --- 2. Delete the FILES first ------------------------------------------
  //
  // Grouped by bucket because `storage.from(bucket)` is per-bucket, and the
  // column exists precisely so the bucket is not assumed.
  const byBucket = new Map<string, ExpiredRow[]>();
  for (const row of rows) {
    const list = byBucket.get(row.storage_bucket) ?? [];
    list.push(row);
    byBucket.set(row.storage_bucket, list);
  }

  const deletableIds: string[] = [];
  let filesRemoved = 0;
  let storageFailures = 0;

  for (const [bucket, bucketRows] of byBucket) {
    for (let i = 0; i < bucketRows.length; i += STORAGE_BATCH) {
      const batch = bucketRows.slice(i, i + STORAGE_BATCH);
      const paths = batch.map((r) => r.storage_path);

      const { error: removeError } = await admin.storage
        .from(bucket)
        .remove(paths);

      if (removeError) {
        // Leave these rows alone so the next run retries them. Deleting the row
        // now would strand the file permanently.
        storageFailures += batch.length;
        logSafe('resume_reaper_storage_remove_failed', {
          bucket,
          count: batch.length,
          error: removeError.message,
        });
        continue;
      }

      // No error covers "already gone" as well as "removed". Both mean the file
      // is not there any more, which is the postcondition that matters — and a
      // row whose object was deleted by hand must not become permanently stuck.
      filesRemoved += batch.length;
      for (const row of batch) deletableIds.push(row.id);
    }
  }

  // --- 3. Then delete the rows --------------------------------------------
  //
  // `resume_scans` follows via ON DELETE CASCADE (migration 011).
  let rowsDeleted = 0;
  if (deletableIds.length > 0) {
    const { error: deleteError } = await admin
      .from('resumes')
      .delete()
      .in('id', deletableIds);

    if (deleteError) {
      logSafe('resume_reaper_delete_failed', {
        count: deletableIds.length,
        error: deleteError.message,
      });
      // The files are gone; the rows will be retried. Report a failure so the
      // scheduler surfaces it rather than reporting a clean run.
      return NextResponse.json(
        { code: 'internal_error', files: filesRemoved, rows: 0 },
        { status: 500 }
      );
    }
    rowsDeleted = deletableIds.length;
  }

  logSafe('resume_reaper_ran', {
    expired: rows.length,
    files: filesRemoved,
    rows: rowsDeleted,
    storage_failures: storageFailures,
    // A full batch means there is probably more waiting.
    more_likely: rows.length === MAX_PER_RUN,
  });

  return NextResponse.json({
    ok: true,
    expired: rows.length,
    files: filesRemoved,
    rows: rowsDeleted,
    storageFailures,
    moreLikely: rows.length === MAX_PER_RUN,
  });
}

/**
 * VERCEL CRON INVOKES WITH GET, NOT POST.
 *
 * This route exported only `POST`, so the scheduled job in vercel.json received
 * `405 Method Not Allowed` and the reaper never ran once in production. Vercel's
 * documentation is explicit: "To trigger a cron job, Vercel makes an HTTP GET
 * request to your project's production deployment URL."
 *
 * That is the exact failure this route was written to fix — migration 011 shipped a
 * retention window with no job to enforce it — and it was reintroduced one layer
 * up. It went unnoticed because the route was verified by calling it with POST,
 * which proved the handler worked and said nothing about whether the scheduler
 * could reach it.
 *
 * GET is an alias rather than a copy so the two can never diverge. The handler is
 * not idempotent in the REST sense — it deletes rows — which normally argues
 * against GET, but the caller here is a scheduler that only speaks GET, and the
 * `CRON_SECRET` bearer check still gates every invocation.
 */
export const GET = POST;
