'use client';

import Image from 'next/image';
import { useState } from 'react';

/**
 * ScreenshotFrame — single guide screenshot wrapped in a 1px-bordered frame.
 *
 * Why this is a client component:
 *   The component must react to a runtime `onError` callback fired by
 *   `next/image` when the underlying image asset fails to load (404, network
 *   error, blocked by an extension). Server components cannot subscribe to
 *   client-side events, so the file is marked `'use client'`. The placeholder
 *   swap is local state — no Supabase, no fetch, no DOM measurement — so the
 *   client cost is a single ~hundred-byte React tree per frame.
 *
 * Behavior contracts:
 *   - Renders `<div class="screenshot-frame">` carrying the 1px
 *     `var(--border)` outline. In dark theme this border satisfies the
 *     "every image and screenshot has a 1px border" rule (Req 16.5).
 *   - The inner `<Image>` declares explicit `width` and `height` props
 *     matching the source PNG intrinsic dimensions so the layout reserves
 *     the exact pixel box on first paint. That contributes zero CLS
 *     (Req 9.5, 19.3, 19.6) — the slot is already the right size before
 *     the image bytes arrive.
 *   - On `onError` we flip a single boolean and re-render the same frame
 *     with a placeholder `<div class="screenshot-frame-placeholder">` of
 *     identical `width` and `height`. Surrounding layout therefore does
 *     not shift when an image is missing in production (Req 9.7, 19.5).
 *   - `next/image` defaults to lazy-loading below-the-fold images. Guide
 *     screenshots are below the fold by definition, so we leave the
 *     default in place to keep TTI on the guide pages low.
 *
 * Token-driven styling (Req 16.5):
 *   The frame's border, radius, background, and the placeholder's surface
 *   color are all driven by tokens in `globals.css` so theme swaps recolor
 *   the chrome without any JS roundtrip.
 *
 * Accessibility (Req 14.6):
 *   The `alt` prop is required and propagated verbatim onto `<Image>`. For
 *   purely decorative screenshots a caller can pass `alt=""`, but every
 *   guide screenshot is meaningful so callers should pass descriptive copy.
 */
export type ScreenshotFrameProps = {
  src: string;
  alt: string;
  /** Intrinsic width in CSS pixels — must match the source PNG. */
  width: number;
  /** Intrinsic height in CSS pixels — must match the source PNG. */
  height: number;
};

export function ScreenshotFrame({ src, alt, width, height }: ScreenshotFrameProps) {
  // Single boolean tracks whether the underlying image failed to load.
  // We do not store the error itself — only whether to render the
  // placeholder branch — so the state surface stays minimal.
  const [errored, setErrored] = useState(false);

  return (
    <div className="screenshot-frame">
      {errored ? (
        // Placeholder div carries the SAME explicit width/height as the
        // image it replaces. CSS uses these inline dimensions verbatim so
        // the surrounding layout cannot shift when the image 404s.
        // `role="img"` + `aria-label` keeps the accessible name aligned
        // with what the loaded image would have announced — assistive
        // tech still reads the descriptive alt copy.
        <div
          className="screenshot-frame-placeholder"
          style={{ width: `${width}px`, height: `${height}px` }}
          role="img"
          aria-label={alt}
        />
      ) : (
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}

export default ScreenshotFrame;
