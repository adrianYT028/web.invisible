'use client';

/**
 * FeedbackReview — client island that renders the review form on `/feedback`
 * for authenticated visitors.
 *
 * Mirrors the contract used by `<HomeClient />` on the home page:
 *
 *   - The review-form chunk loads via `next/dynamic` with `{ ssr: false }`
 *     so the `<ReviewForm />` JS never reaches anonymous visitors. The
 *     parent server component (`feedback/page.tsx`) gates render of this
 *     island on the Supabase session, so anonymous traffic never even
 *     mounts this component.
 *
 *   - The chrome wrapper (`#reviews` anchor + eyebrow + h2 + lede) reuses
 *     the same `.reviews-island` / `.reviews-island-section` CSS contract
 *     as the home-page island so the visual rhythm matches across pages.
 *
 *   - The review form itself preserves the byte-identical `/api/reviews`
 *     POST shape `{ rating, review: review.trim() }` per Req 17.6 — the
 *     form code is shared (`@/components/forms/ReviewForm`), so this
 *     wrapper has no submission logic of its own.
 */

import dynamic from 'next/dynamic';

const ReviewForm = dynamic(
  () => import('@/components/forms/ReviewForm').then((m) => m.ReviewForm),
  { ssr: false },
);

type Props = {
  userEmail: string;
};

export function FeedbackReview({ userEmail }: Props) {
  return (
    <section className="reviews-island" id="reviews">
      <div className="reviews-island-section">
        <p className="eyebrow">Review</p>
        <h2>Submit your feedback</h2>
        <p className="lede">
          Share what worked, what broke, and what you expect next. Your email
          stays private and is only used to follow up if there is an issue.
        </p>
        <ReviewForm userEmail={userEmail} />
      </div>
    </section>
  );
}

export default FeedbackReview;
