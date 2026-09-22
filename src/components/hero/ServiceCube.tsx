'use client';

/**
 * ServiceCube — the hero's proof, for all four services instead of one.
 *
 * The hero used to show a single demo: a video call with the overlay visible on
 * "your screen" and gone on "theirs". That sold the desktop app, which is now one
 * quarter of what is on sale. This rotates that same demo onto the front face of a
 * cube and gives the other three faces to the resume analyser, the job index, and
 * the outreach flow — same window chrome, same mono status line, so it reads as
 * one product with four rooms rather than four unrelated screenshots.
 *
 * ---------------------------------------------------------------------------
 * WHY A CUBE AND NOT A CAROUSEL
 *
 * A carousel implies a list you page through. A cube implies one object you turn
 * over, which is the claim: these are faces of a single purchase, not a menu of
 * add-ons. That is the whole reason the pricing collapsed to one product.
 *
 * ---------------------------------------------------------------------------
 * HOW THE 3D WORKS, AND THE ONE CONSTRAINT
 *
 * A CSS cube needs each face pushed out by half the cube's width along Z. That
 * distance cannot be a percentage — `translateZ` resolves percentages against
 * nothing — so the shell has a FIXED max-width and `--cube-z` is declared
 * alongside it in globals.css at each breakpoint. Change one without the other and
 * the faces stop meeting at the corners. There is no JS measurement here on
 * purpose: reading layout to set a transform means the first paint is wrong.
 *
 * ---------------------------------------------------------------------------
 * REDUCED MOTION
 *
 * `prefers-reduced-motion: reduce` gets no auto-rotation AND no 3D — the CSS drops
 * the cube to a flat stack showing only the active face, because a spinning
 * perspective transform is exactly the vestibular trigger that setting exists for.
 * The dot controls still work, so the content stays reachable.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * Milliseconds a face is held before the cube turns.
 *
 * The CSS turn is 700ms, so this is the full cycle: 700ms moving, 1300ms settled.
 * Keep it comfortably above the transition or the next turn starts before the last
 * one finishes and the cube never appears to stop.
 */
const AUTO_ROTATE_MS = 2000;

/**
 * How often face 0 alternates between your screen and theirs.
 *
 * Deliberately shorter than `AUTO_ROTATE_MS`: face 0 is only on screen for two
 * seconds at a time, and the overlay dissolve is the single most important thing
 * on the cube. At the old 2600ms it fired less often than the face was visible, so
 * most visitors never saw the overlay disappear at all.
 */
const FLIP_MS = 1000;

interface Face {
  /** Service label, shown on the control and read by assistive tech. */
  label: string;
  /** The window's fake title, in the titlebar. */
  title: string;
  /** Mono status line along the bottom. */
  status: string;
}

/**
 * Order matters: face 0 is the overlay demo, because it is the claim the brand is
 * built on and the one a returning visitor recognises. The rest follow the order in
 * PLATFORM_SERVICES so the cube and the pricing page list the same things in the
 * same sequence.
 */
const FACES: Face[] = [
  {
    label: 'Invisible overlay',
    title: 'meet — final-round interview',
    status: 'OVERLAY ACTIVE — VISIBLE ONLY TO YOU',
  },
  {
    label: 'Resume analyser',
    title: 'resume — ats readiness',
    status: 'PARSED 1 PAGE — NO TEXT LAYER ISSUES',
  },
  {
    label: 'Job openings',
    title: 'openings — matched to your profile',
    status: '5 OPEN ROLES — RANKED BY FIT',
  },
  {
    label: 'Auto-apply',
    title: 'outreach — draft ready to send',
    status: 'DRAFTED FROM YOUR MATCH REPORT',
  },
];

export function ServiceCube() {
  const [face, setFace] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [paused, setPaused] = useState(false);
  const reduced = useRef(false);

  // Auto-rotate, unless the visitor has taken control or asked for less motion.
  useEffect(() => {
    reduced.current = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;
    if (reduced.current || paused) return;

    const turn = setInterval(
      () => setFace((f) => (f + 1) % FACES.length),
      AUTO_ROTATE_MS
    );
    return () => clearInterval(turn);
  }, [paused]);

  // Face 0's own animation: the overlay dissolving out of the capture. Runs only
  // while face 0 is the one showing, so it is not animating out of sight.
  useEffect(() => {
    // No `setFlipped(false)` reset here, deliberately.
    //
    // Resetting synchronously inside the effect trips
    // `react-hooks/set-state-in-effect` and causes a cascading render on every
    // turn of the cube. It is also unnecessary: a stale `flipped` value only ever
    // applies to face 0, and when face 0 is not the active face it is turned away
    // from the viewer, so nothing visible depends on it. The interval simply does
    // not run while another face is showing.
    if (reduced.current || face !== 0) return;

    const flip = setInterval(() => setFlipped((v) => !v), FLIP_MS);
    return () => clearInterval(flip);
  }, [face]);

  const show = (index: number) => {
    setPaused(true);
    setFace(index);
  };

  return (
    <div className="cube-shell">
      <div
        className="cube"
        data-face={face}
        role="group"
        aria-label="What you get, on four faces"
      >
        {FACES.map((f, i) => (
          <article
            className="cube-face"
            key={f.label}
            // Only the visible face is exposed to assistive tech and the tab
            // order. Without this, a screen reader reads four stacked screens at
            // once and keyboard focus lands on controls facing away from the user.
            aria-hidden={i !== face}
            {...(i !== face ? { inert: '' as unknown as boolean } : {})}
          >
            <div className="sim-window" data-view={i === 0 && flipped ? 'theirs' : 'yours'}>
              <div className="sim-titlebar">
                <span className="sim-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="sim-url">{f.title}</span>
                {i === 0 ? <span className="sim-rec">REC</span> : null}
              </div>

              <div className="sim-stage">{renderFace(i)}</div>

              <div className="sim-status" aria-live={i === face ? 'polite' : 'off'}>
                {i === 0 && flipped
                  ? 'CAPTURE OUTPUT — NO OVERLAY DETECTED'
                  : f.status}
              </div>
            </div>
          </article>
        ))}
      </div>

      <div className="cube-dots" role="tablist" aria-label="Choose a service">
        {FACES.map((f, i) => (
          <button
            type="button"
            role="tab"
            key={f.label}
            className="cube-dot"
            aria-selected={i === face}
            onClick={() => show(i)}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The body of one face. Split out so the shell above stays readable. */
function renderFace(index: number) {
  if (index === 0) return <OverlayFace />;
  if (index === 1) return <ResumeFace />;
  if (index === 2) return <OpeningsFace />;
  return <OutreachFace />;
}

/** Face 0 — the original demo: a call, with the overlay only you can see. */
function OverlayFace() {
  return (
    <>
      <div className="sim-grid">
        <div className="sim-tile">
          <span className="sim-avatar" aria-hidden="true">
            AR
          </span>
          <span className="sim-name">A. Rivera — Interviewer</span>
        </div>
        <div className="sim-tile">
          <span className="sim-avatar" aria-hidden="true">
            SC
          </span>
          <span className="sim-name">S. Chen — Panel</span>
        </div>
        <div className="sim-tile sim-tile--you">
          <span className="sim-avatar" aria-hidden="true">
            You
          </span>
          <span className="sim-name">You — Sharing screen</span>
        </div>
        <div className="sim-tile">
          <span className="sim-avatar" aria-hidden="true">
            MK
          </span>
          <span className="sim-name">M. Kim — Recruiter</span>
        </div>
      </div>

      {/* Present in the DOM in both views: the dissolve is CSS on
          `[data-view]`, so it reads as the capture pipeline missing the layer
          rather than React unmounting a node. */}
      <div className="sim-overlay">
        <p className="sim-overlay-head">UNVIEWABLE — STEALTH ON</p>
        <p className="sim-overlay-q">“How would you scale this 10×?”</p>
        <p className="sim-overlay-a">
          <strong>→</strong> Cache the read path, then split reads onto replicas.
        </p>
        <p className="sim-overlay-a sim-overlay-a--secondary">
          <strong>→</strong> Mention back-pressure.
        </p>
      </div>
    </>
  );
}

/**
 * Face 1 — the resume analyser.
 *
 * Leads with Parse Integrity rather than the overall score, because that is the
 * differentiator: every competitor scores keywords, and almost none tell you the
 * ATS could not read your file in the first place.
 */
function ResumeFace() {
  const bars = [
    { label: 'Parse integrity', value: 100 },
    { label: 'Requirement coverage', value: 62 },
    { label: 'Keyword alignment', value: 77 },
    { label: 'Evidence quality', value: 63 },
  ];

  return (
    <div className="cube-panel">
      <p className="cube-score">
        <span className="cube-score-value">75</span>
        <span className="cube-score-max">/100 match</span>
      </p>
      <ul className="cube-bars">
        {bars.map((b) => (
          <li key={b.label}>
            <span className="cube-bar-label">{b.label}</span>
            <span className="cube-bar" aria-hidden="true">
              <i style={{ width: `${b.value}%` }} />
            </span>
            <span className="cube-bar-value">{b.value}</span>
          </li>
        ))}
      </ul>
      <p className="cube-note">
        2 knockouts found · 3 keywords missing · 4 bullets rewritten
      </p>
    </div>
  );
}

/** Face 2 — the job index, ranked against the parsed profile. */
function OpeningsFace() {
  const roles = [
    { title: 'Backend Engineering Intern', org: 'Zenpay', fit: 78 },
    { title: 'Junior Platform Engineer', org: 'Zenpay · Remote', fit: 71 },
    { title: 'Data Analyst (Entry Level)', org: 'Lumen', fit: 66 },
    { title: 'Machine Learning Intern', org: 'Lumen', fit: 61 },
  ];

  return (
    <div className="cube-panel">
      <ul className="cube-rows">
        {roles.map((r) => (
          <li key={r.title}>
            <span className="cube-row-main">
              <strong>{r.title}</strong>
              <span className="cube-row-sub">{r.org}</span>
            </span>
            <span className="cube-fit">{r.fit}</span>
          </li>
        ))}
      </ul>
      <p className="cube-note">
        Pulled from company boards, not a scraped aggregator
      </p>
    </div>
  );
}

/** Face 3 — the outreach draft. Never sent by us; the user sends it. */
function OutreachFace() {
  return (
    <div className="cube-panel">
      <p className="cube-mail-to">
        <span className="cube-mail-label">To</span> careers@zenpay.example
      </p>
      <p className="cube-mail-subject">
        Backend Engineering Intern — Aarav Sharma
      </p>
      <p className="cube-mail-body">
        I rebuilt a payment reconciliation job in Python and cut median API
        latency from 420 ms to 180 ms. Your posting asks for exactly that, so I
        have attached a resume tailored to it.
      </p>
      <p className="cube-note">
        You review and send it from your own account — nothing is sent for you
      </p>
    </div>
  );
}

export default ServiceCube;
