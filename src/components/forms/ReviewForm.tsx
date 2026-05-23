'use client';

/**
 * ReviewForm — client component (Req 14.7, 14.8, 14.9, 17.2, 17.3, 17.6).
 *
 * Auth-gated review submission island used by the home page. The
 * `<HomeClient />` wrapper handles the authentication gate and only
 * mounts this component for signed-in visitors, so the form assumes a
 * known `userEmail` and never renders a sign-in prompt of its own.
 *
 * Frozen contract (Req 17.3 + 17.6):
 *
 *   - Validation rules and the user-visible error strings are byte-
 *     identical to the pre-redesign implementation in `src/app/page.tsx`:
 *
 *       1) `rating` must be 1..5 — error "Add a rating so we know severity."
 *       2) `review.trim().length >= 7` — error "Please add a few details
 *          (at least 7 characters)."
 *
 *   - The POST to `/api/reviews` is built EXACTLY the same way the
 *     legacy code built it:
 *
 *       fetch('/api/reviews', {
 *         method: 'POST',
 *         headers: { 'Content-Type': 'application/json' },
 *         body: JSON.stringify({ rating, review: review.trim() }),
 *       });
 *
 *     The object-literal key order `{ rating, review }` matters because
 *     `JSON.stringify` preserves insertion order — flipping the keys would
 *     make the serialized body bytes diverge from the pre-redesign output
 *     and break Req 17.6's "byte-identical request body" promise.
 *
 *   - Success path keeps the 2500 ms reset window and the same state
 *     transitions (`loading -> success -> idle`, with the form fields
 *     cleared inside the timeout). Failure path leaves the entered values
 *     in place so the visitor can correct without retyping.
 *
 *   - The fallback error string "Could not save your review. Please try
 *     again." is reused verbatim for both API-level failures (parsed
 *     `data.error` missing) and network errors. The catch reads
 *     `(e as Error)?.message` so the original `data.error` propagates when
 *     the server provided one.
 *
 * Accessibility:
 *
 *   - The `<p id="review-error" role="alert" aria-live="polite">` host
 *     announces validation and submission errors without stealing focus
 *     (Req 14.7, 14.8). It always renders so screen readers don't have to
 *     re-detect a freshly-mounted live region after the first failure.
 *
 *   - Each input that currently fails validation gets `aria-invalid="true"`.
 *     The mapping is intentionally specific: the rating-group input is
 *     marked invalid only for the rating error string, the textarea only
 *     for the review-length error string. Any other error (e.g. a
 *     server-side failure) leaves both inputs without `aria-invalid` so
 *     assistive tech doesn't blame the wrong field.
 *
 *   - The submit button reflects its progress via the same className
 *     contract the legacy `.submit-btn` styles already understand:
 *     `submit-btn`, `submit-btn is-loading`, `submit-btn is-success`.
 */

import { useState } from 'react';

import { StarRating } from '@/components/forms/StarRating';

type SubmitState = 'idle' | 'loading' | 'success';

type Props = {
  /** The signed-in visitor's email. Rendered into the read-only email field. */
  userEmail: string;
};

// Frozen error strings — referenced by name so the test suite can pin the
// exact bytes (Req 17.3). Changing these breaks the legacy contract.
const ERROR_RATING = 'Add a rating so we know severity.';
const ERROR_REVIEW = 'Please add a few details (at least 7 characters).';
const ERROR_FALLBACK = 'Could not save your review. Please try again.';

export function ReviewForm({ userEmail }: Props) {
  const [rating, setRating] = useState<number | null>(null);
  const [review, setReview] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [formError, setFormError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');

    // Validation order matches the legacy implementation: rating first,
    // then review length. Reordering would change which error appears
    // when both are missing, so it stays as-is.
    if (!rating) {
      setFormError(ERROR_RATING);
      return;
    }
    if (review.trim().length < 7) {
      setFormError(ERROR_REVIEW);
      return;
    }

    setSubmitState('loading');
    try {
      // The body shape is FROZEN. Object-literal key order is
      // `{ rating, review }` — JSON.stringify preserves insertion order
      // and any deviation breaks Req 17.6 (byte-identical request body).
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, review: review.trim() }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || ERROR_FALLBACK);
      }

      setSubmitState('success');
      // 2500 ms matches the legacy reset window — long enough for the
      // success affordance to register, short enough that the form
      // becomes usable again before the visitor moves on.
      setTimeout(() => {
        setSubmitState('idle');
        setRating(null);
        setReview('');
      }, 2500);
    } catch (err) {
      setSubmitState('idle');
      const message =
        err instanceof Error && err.message ? err.message : ERROR_FALLBACK;
      setFormError(message);
    }
  }

  // Mirrors the legacy className tri-state so the existing `.submit-btn`
  // CSS variants keep working without conditional rendering inside the
  // button itself.
  const submitBtnClass =
    submitState === 'loading'
      ? 'submit-btn is-loading'
      : submitState === 'success'
        ? 'submit-btn is-success'
        : 'submit-btn';

  // Field-specific aria-invalid wiring. Only the field actually flagged
  // by the current `formError` is marked invalid so screen readers don't
  // blame an unrelated input on a server-side failure.
  const ratingInvalid = formError === ERROR_RATING;
  const reviewInvalid = formError === ERROR_REVIEW;

  return (
    <form
      className="review-form"
      id="reviewForm"
      onSubmit={handleSubmit}
      noValidate
    >
      <div className="form-grid">
        <div className="form-stack">
          <label htmlFor="reviewEmail">Signed-in email</label>
          <input
            type="email"
            id="reviewEmail"
            name="email"
            className="field-control"
            placeholder="you@company.com"
            required
            autoComplete="email"
            aria-label="Email address for follow-up"
            readOnly
            value={userEmail}
          />
        </div>
        <div
          className="form-stack"
          aria-invalid={ratingInvalid ? true : undefined}
        >
          <span className="rating-label">Rating</span>
          <StarRating
            value={rating}
            onChange={(n) => {
              // Clear the rating-specific error as soon as the visitor
              // makes a selection so the live region doesn't keep
              // announcing the stale message after the issue is fixed.
              if (formError === ERROR_RATING) {
                setFormError('');
              }
              setRating(n);
            }}
          />
        </div>
      </div>

      <div className="form-stack">
        <label htmlFor="reviewMessage">What worked? What broke?</label>
        <textarea
          id="reviewMessage"
          name="review"
          rows={5}
          placeholder="Include any glitches, context (app, meeting platform), and what you expect next."
          minLength={7}
          required
          aria-label="Review details"
          aria-describedby="review-error"
          aria-invalid={reviewInvalid ? true : undefined}
          value={review}
          onChange={(e) => {
            // Same self-clear pattern as the rating input — the moment the
            // visitor types past the threshold, the stale error string
            // gets cleared from the live region.
            if (formError === ERROR_REVIEW) {
              setFormError('');
            }
            setReview(e.target.value);
          }}
        />
      </div>

      <p className="form-hint">
        If something looks bad, we will only use your email to reach out for fixes.
      </p>

      <div className="form-actions">
        <button
          type="submit"
          className={submitBtnClass}
          id="reviewSubmitBtn"
          disabled={submitState === 'loading'}
        >
          Submit review
        </button>
        <p
          id="review-error"
          className="form-error"
          role="alert"
          aria-live="polite"
        >
          {formError}
        </p>
      </div>
    </form>
  );
}

export default ReviewForm;
