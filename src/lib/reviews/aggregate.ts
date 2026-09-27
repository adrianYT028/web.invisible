import { supabaseAdmin } from '@/lib/supabase/admin';

// -----------------------------------------------------------------------------
// Real review aggregate — the ONLY sanctioned source of a public star rating.
//
// This replaces a hardcoded "4.9 from 124 reviewers" that lived in SITE_META and
// was rendered on `/` and emitted as JSON-LD `aggregateRating`, while production
// held 4 reviews (migration 020). A fabricated rating breaks Google's
// structured-data policy (manual action risk) and is a misleading trade practice
// under the Consumer Protection (E-Commerce) Rules. Never reintroduce a constant.
//
// Only `rating` is selected. `reviews.email` is publicly readable under RLS
// (see migration 020) and must not be pulled into a page render for no reason.
// -----------------------------------------------------------------------------

/**
 * Below this many reviews the rating is not shown at all. A "5.0 from 2
 * reviewers" badge reads as fake even when it is real, and small samples swing
 * wildly. Raise it as volume grows; never lower it to 1.
 */
export const MIN_PUBLIC_REVIEWS = 5;

export interface ReviewAggregate {
  /** Mean rating, rounded to one decimal, as displayed. */
  average: number;
  /** Number of reviews the average is computed from. */
  count: number;
}

/** Pure aggregation, exported for tests. Ignores anything outside 1..5. */
export function aggregateRatings(ratings: readonly unknown[]): ReviewAggregate | null {
  const valid = ratings
    .map((r) => Number(r))
    .filter((r) => Number.isInteger(r) && r >= 1 && r <= 5);
  if (valid.length === 0) return null;
  const sum = valid.reduce((a, b) => a + b, 0);
  return {
    average: Math.round((sum / valid.length) * 10) / 10,
    count: valid.length,
  };
}

/**
 * The public rating, or null when there is not enough real data to show one.
 *
 * Fails closed: any database or configuration error returns null, so the worst
 * case is a missing badge rather than a broken homepage or an invented number.
 */
export async function getPublicReviewAggregate(): Promise<ReviewAggregate | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('reviews')
      .select('rating')
      .eq('source', 'review');
    if (error || !data) return null;
    const agg = aggregateRatings(data.map((row) => row.rating));
    if (!agg || agg.count < MIN_PUBLIC_REVIEWS) return null;
    return agg;
  } catch {
    return null;
  }
}
