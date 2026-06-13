'use client';

/**
 * ScreenSimulator — the hero's interactive proof of the product claim.
 *
 * A mock video-call window with two views, switched by a small tab pair:
 *
 *   - "Your screen"  → the call grid with the Unviewable overlay floating
 *     on the right, mid-answer.
 *   - "Their screen" → the identical call grid as a screen-capture pipeline
 *     would see it: the overlay dissolves away (opacity + blur via the
 *     `data-view` attribute — see the `.sim-*` rules in globals.css).
 *
 * The component is purely presentational: no network calls, no Supabase,
 * no globals. The only state is the active view plus a flag that stops the
 * idle auto-flip once the visitor interacts.
 *
 * Auto-flip: until the user touches the tabs, the view alternates every
 * few seconds so the hero demonstrates itself. The interval is skipped
 * entirely for `prefers-reduced-motion: reduce` and torn down on unmount
 * or first interaction.
 */

import { useEffect, useRef, useState } from 'react';

type View = 'yours' | 'theirs';

const AUTO_FLIP_MS = 4200;

export function ScreenSimulator() {
  const [view, setView] = useState<View>('yours');
  const [userTouched, setUserTouched] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (userTouched) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    intervalRef.current = setInterval(() => {
      setView((v) => (v === 'yours' ? 'theirs' : 'yours'));
    }, AUTO_FLIP_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [userTouched]);

  const select = (v: View) => {
    setUserTouched(true);
    setView(v);
  };

  return (
    <div className="sim" role="group" aria-label="Screen share simulation">
      <div className="sim-tabs" role="tablist" aria-label="Choose a viewpoint">
        <button
          type="button"
          role="tab"
          className="sim-tab"
          aria-selected={view === 'yours'}
          onClick={() => select('yours')}
        >
          Your screen
        </button>
        <button
          type="button"
          role="tab"
          className="sim-tab"
          aria-selected={view === 'theirs'}
          onClick={() => select('theirs')}
        >
          Their screen
        </button>
      </div>

      <div className="sim-window" data-view={view}>
        <div className="sim-titlebar">
          <span className="sim-dots" aria-hidden="true">
            <i /><i /><i />
          </span>
          <span className="sim-url">meet — final-round interview</span>
          <span className="sim-rec">REC</span>
        </div>

        <div className="sim-stage">
          <div className="sim-grid">
            <div className="sim-tile">
              <span className="sim-avatar" aria-hidden="true">AR</span>
              <span className="sim-name">A. Rivera — Interviewer</span>
            </div>
            <div className="sim-tile">
              <span className="sim-avatar" aria-hidden="true">SC</span>
              <span className="sim-name">S. Chen — Panel</span>
            </div>
            <div className="sim-tile sim-tile--you">
              <span className="sim-avatar" aria-hidden="true">You</span>
              <span className="sim-name">You — Sharing screen</span>
            </div>
            <div className="sim-tile">
              <span className="sim-avatar" aria-hidden="true">MK</span>
              <span className="sim-name">M. Kim — Recruiter</span>
            </div>
          </div>

          {/* The product overlay. Present in the DOM in both views; the
              dissolve is pure CSS so the toggle reads as display affinity
              doing its work, not React unmounting a node. */}
          <div className="sim-overlay" aria-hidden={view === 'theirs'}>
            <p className="sim-overlay-head">UNVIEWABLE — STEALTH ON</p>
            <p className="sim-overlay-q">“How would you scale this 10×?”</p>
            <p className="sim-overlay-a">
              <strong>→</strong> Cache the read path, then split reads onto
              replicas.
            </p>
            <p className="sim-overlay-a sim-overlay-a--secondary">
              <strong>→</strong> Mention back-pressure.
            </p>
          </div>
        </div>

        <div className="sim-status" aria-live="polite">
          {view === 'yours'
            ? 'OVERLAY ACTIVE — VISIBLE ONLY TO YOU'
            : 'CAPTURE OUTPUT — NO OVERLAY DETECTED'}
        </div>
      </div>
    </div>
  );
}

export default ScreenSimulator;
