/**
 * FeatureGrid — the three-card "what it does" section composed onto the
 * home page directly under the hero.
 *
 * Why this is a server component:
 *   The grid renders three static <FeatureCard /> instances with hard-coded
 *   copy and inline SVG marks. Nothing here changes at runtime, so the file
 *   ships zero JavaScript and contributes nothing to the per-route JS
 *   budget (Req 13.7, 13.8). The legacy implementation used an inline
 *   `onMouseMove` handler on each `.feature-card` to drive a cursor-tracking
 *   gradient (Req 7.4 violation); deleting that handler is exactly what
 *   lets this file stay on the server side of the boundary.
 *
 * Section structure (Req 7.1, 7.2):
 *   <section class="features">
 *     <div class="features-section">       ← max-width container
 *       <p class="eyebrow">                ← mono caption
 *       <h2>                                ← single h2 for the section
 *       <p class="lede">                    ← supporting positioning copy
 *       <div class="features-grid">        ← 1/2/3-col responsive grid
 *         <FeatureCard /> × 3
 *       </div>
 *     </div>
 *   </section>
 *
 * Icon contract (Req 7.2, 7.7, 12.3):
 *   Every icon is a 24×24 viewBox SVG with `stroke="currentColor"`,
 *   `strokeWidth="1.5"`, `fill="none"`, `strokeLinecap="round"`,
 *   `strokeLinejoin="round"`, and `aria-hidden="true"`. The same stroke
 *   width across the trio is the visual discipline that makes the three
 *   cards read as a typographic family — different glyphs, identical
 *   weight. The 48×48 chrome box, its border, and its radius live on the
 *   `.feature-icon` rule in `globals.css` so every consumer of
 *   <FeatureCard /> inherits the same container.
 *
 * Copy discipline (Req 7.3, 7.6, 7.8, 7.9):
 *   Each description preserves the existing technical claims —
 *     - Stealth Execution → Windows Display Affinity API + screen-capture
 *       pipelines (OBS, Zoom, Teams, Discord)
 *     - Audio Loopback → WASAPI loopback for real-time transcription, no
 *       virtual cables or plugins
 *     - Vision Context → selective region capture (code editors, terminal,
 *       docs) without exposing the full desktop
 *   Word counts sit between 24 and 56 per the spec, which keeps every card
 *   visually balanced regardless of which one is widest.
 *
 * Layout breakpoints (Req 7.1):
 *   `.features-grid` rule in `globals.css`:
 *     - default          → 1 column
 *     - >= 768px         → 2 columns
 *     - >= 1024px        → 3 columns
 *   `gap: var(--space-6)` keeps a consistent rhythm between cards.
 */

import { FeatureCard } from './FeatureCard';

/**
 * Stealth Execution — Windows Display Affinity API renders the overlay on
 * a layer that the OS reports as off-screen to every screen-capture
 * pipeline. The mark is a monitor with a slashed-out frame, signalling
 * "screen, not captured."
 */
function StealthIcon() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.75" y="4.25" width="18.5" height="12" rx="1.75" />
      <path d="M8 20h8" />
      <path d="M12 16.25V20" />
      <path d="M3.5 3.5L20.5 20.5" />
    </svg>
  );
}

/**
 * Audio Loopback — WASAPI loopback taps the audio that the OS sends to
 * the speakers. The mark is a five-bar audio-lines waveform centred in the
 * 24×24 viewBox; bar heights step up then down to read as "voice signal."
 */
function AudioIcon() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 11v2" />
      <path d="M7.5 8v8" />
      <path d="M12 4.5v15" />
      <path d="M16.5 8v8" />
      <path d="M21 11v2" />
    </svg>
  );
}

/**
 * Vision Context — selective region capture frames a piece of the desktop
 * (a code editor, a terminal pane, an open spec) and feeds those pixels to
 * the model. The mark is a viewfinder bracket with an eye-pupil dot at
 * centre, signalling "framed, focused vision."
 */
function VisionIcon() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8V5.5A1.5 1.5 0 0 1 4.5 4H7" />
      <path d="M17 4h2.5A1.5 1.5 0 0 1 21 5.5V8" />
      <path d="M21 16v2.5a1.5 1.5 0 0 1-1.5 1.5H17" />
      <path d="M7 20H4.5A1.5 1.5 0 0 1 3 18.5V16" />
      <circle cx="12" cy="12" r="2.25" />
    </svg>
  );
}

export function FeatureGrid() {
  return (
    <section className="features">
      <div className="features-section">
        <p className="eyebrow">What it does</p>
        <h2>Engineered to be unseen</h2>
        <p className="lede">
          Three primitives compose the overlay: stealth rendering, system
          audio capture, and selective vision. Together they produce live
          intelligence that interviewers and meeting hosts cannot detect or
          screen-share.
        </p>
        <div className="features-grid">
          <FeatureCard
            icon={<StealthIcon />}
            title="Stealth Execution"
            description="Built on the Windows Display Affinity API, the overlay is invisible to every screen-capture and screen-share pipeline — OBS, Zoom, Teams, Discord, browser share. Interviewers see only your face and shared desktop while the assistant runs locally, on your screen alone."
          />
          <FeatureCard
            icon={<AudioIcon />}
            title="Audio Loopback"
            description="WASAPI loopback taps your system audio directly for real-time transcription — every voice in the call, including yours. No virtual cables, no plugins, no audio routing. Install once and the assistant hears the meeting exactly as your speakers do."
          />
          <FeatureCard
            icon={<VisionIcon />}
            title="Vision Context"
            description="Selective region capture sends only the pixels you mark — a code editor, a terminal pane, an open spec — to the model. The rest of your desktop stays private. Visual context arrives without ever exposing the full screen or background tabs."
          />
        </div>
      </div>
    </section>
  );
}
