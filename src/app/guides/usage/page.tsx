import type { Metadata } from 'next';
import Link from 'next/link';

import { SiteShell } from '@/components/chrome/SiteShell';
import { GuideShell, type GuideStepData } from '@/components/guides/GuideShell';

/**
 * Metadata is preserved verbatim from the legacy `usage` page so the
 * canonical URL, title, description, and Open Graph block all stay
 * byte-identical (Req 18.5, 18.6, 18.7).
 */
export const metadata: Metadata = {
  title: 'Usage Guide — Mastering Unviewable in Live Meetings',
  description:
    'Complete usage guide for Unviewable: hotkeys, AI features, best practices, and troubleshooting for live meetings and interviews.',
  alternates: { canonical: '/guides/usage' },
  openGraph: {
    title: 'Usage Guide — Mastering Unviewable in Live Meetings',
    description:
      'Complete usage guide for Unviewable: hotkeys, AI features, and best practices.',
    url: '/guides/usage',
  },
};

/**
 * Screenshot intrinsic dimensions.
 *
 * The four screenshots in `public/guides/` consumed by this guide
 * (`usage-launch.png`, `usage-select.png`, `step-hotkeys-grid.png`,
 * `usage-review.png`) were authored as 1024×1024 PNG renders. Passing the
 * exact intrinsic width/height to `<ScreenshotFrame />` lets `next/image`
 * reserve the slot at first paint and contributes zero CLS to the page
 * (Req 19.3, 19.6). If a future re-export changes the resolution, update
 * the matching entry below so the served `srcset` keeps the same ratio.
 */
const SCREENSHOT_DIMS = { width: 1024, height: 1024 } as const;

/**
 * USAGE_STEPS — the four-step in-session walkthrough rendered as the
 * body of the usage guide. Each entry maps 1:1 onto `<GuideStep />` via
 * the `<GuideShell>` shell. Heading hierarchy stays linear: the single
 * `<h1>` lives in the shell's hero band and each step contributes one
 * `<h2>` (Req 9.3, 14.5).
 *
 * The `<kbd>` elements inside the hotkeys step body carry the
 * `.guide-kbd` class. The class is decorative — the global `kbd, .guide-kbd`
 * rule in `globals.css` already styles bare `<kbd>` elements identically;
 * naming it explicitly keeps the intent visible at the call-site and lets
 * future styling diverge from the global default if needed without
 * touching every consumer.
 */
const USAGE_STEPS: GuideStepData[] = [
  {
    id: 'launch',
    title: 'Launch before the call',
    image: {
      src: '/guides/usage-launch.png',
      alt: 'Launching overlay before the call',
      ...SCREENSHOT_DIMS,
    },
    body: (
      <>
        <p>
          Open Unviewable <strong>before</strong> joining your meeting. The
          overlay attaches to your display and starts listening to system audio
          immediately — there is no extra setup at call time.
        </p>
        <p>
          Audio capture runs through Windows&apos; native WASAPI loopback, so
          you do not need a virtual cable, a re-routed output device, or a
          mixer. Whatever your default playback device hears, Unviewable hears.
        </p>
      </>
    ),
  },
  {
    id: 'capture',
    title: 'Capture visual context',
    image: {
      src: '/guides/usage-select.png',
      alt: 'Selecting a screen region for AI context',
      ...SCREENSHOT_DIMS,
    },
    body: (
      <>
        <p>
          Press <kbd className="guide-kbd">Ctrl</kbd>+
          <kbd className="guide-kbd">Shift</kbd>+
          <kbd className="guide-kbd">S</kbd> to draw a rectangle around the
          region you want the AI to read. Anything inside the rectangle —
          code, documents, chat messages, dashboards — feeds straight into the
          next AI analysis.
        </p>
        <p>
          Smaller selections produce faster responses because there is less
          visual data to process, so highlight only the part you care about
          rather than capturing the whole screen.
        </p>
      </>
    ),
  },
  {
    id: 'hotkeys',
    title: 'Drive it with hotkeys',
    image: {
      src: '/guides/step-hotkeys-grid.png',
      alt: 'Hotkeys grid',
      ...SCREENSHOT_DIMS,
    },
    body: (
      <>
        <p>
          Every action runs from the keyboard so the overlay never demands a
          mouse on screen during a call. The seven core bindings all share the{' '}
          <kbd className="guide-kbd">Ctrl</kbd>+
          <kbd className="guide-kbd">Shift</kbd>+&hellip; prefix so they are
          easy to recall mid-conversation:
        </p>
        <ul>
          <li>
            <kbd className="guide-kbd">Ctrl</kbd>+
            <kbd className="guide-kbd">Shift</kbd>+
            <kbd className="guide-kbd">S</kbd> — Screen capture — select a
            screen region for the AI to read.
          </li>
          <li>
            <kbd className="guide-kbd">Ctrl</kbd>+
            <kbd className="guide-kbd">Shift</kbd>+
            <kbd className="guide-kbd">A</kbd> — Ask AI — query the AI against
            the live transcript.
          </li>
          <li>
            <kbd className="guide-kbd">Ctrl</kbd>+
            <kbd className="guide-kbd">Shift</kbd>+
            <kbd className="guide-kbd">M</kbd> — Meeting summary — generate a
            summary of the transcript so far.
          </li>
          <li>
            <kbd className="guide-kbd">Ctrl</kbd>+
            <kbd className="guide-kbd">Shift</kbd>+
            <kbd className="guide-kbd">T</kbd> — Toggle panels — show or hide
            every overlay panel with a single press.
          </li>
          <li>
            <kbd className="guide-kbd">Ctrl</kbd>+
            <kbd className="guide-kbd">Shift</kbd>+
            <kbd className="guide-kbd">I</kbd> — Interactive mode — flip in to
            scroll, drag, and copy AI responses.
          </li>
          <li>
            <kbd className="guide-kbd">Ctrl</kbd>+
            <kbd className="guide-kbd">Shift</kbd>+
            <kbd className="guide-kbd">P</kbd> — Settings — open settings to
            tune opacity, font size, and the AI model.
          </li>
          <li>
            <kbd className="guide-kbd">Ctrl</kbd>+
            <kbd className="guide-kbd">Shift</kbd>+
            <kbd className="guide-kbd">Q</kbd> — Quit — exit the application
            and release audio resources.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'review',
    title: 'Review live intelligence',
    image: {
      src: '/guides/usage-review.png',
      alt: 'AI suggestions on the stealth overlay',
      ...SCREENSHOT_DIMS,
    },
    body: (
      <>
        <p>
          AI-generated answers and talking points appear on the overlay in real
          time as the meeting progresses. Auto-detect listens for questions in
          the transcript and answers them automatically, with a 15-second
          cooldown between answers so the panel never spams you while one
          person speaks.
        </p>
        <p>
          The overlay is invisible to every screen-capture pipeline, so what
          you read here never leaves your monitor.
        </p>
      </>
    ),
  },
];

/**
 * BEST_PRACTICES — four pro-tip cards rendered below the step walkthrough.
 *
 * Copy is preserved from the legacy `.tips-grid` block (commit 5b154e0) so
 * existing readers landing on the page see the same advice. Each entry
 * becomes a `<article class="usage-tip-card">` in the grid; the class
 * mirrors `.feature-card`'s surface contract (`var(--surface-raised)`
 * background, 1px `var(--border)`, hover bumps to `var(--border-strong)`
 * + `var(--shadow-card)`) without re-using the `.feature-card` className
 * itself so the home-page feature grid and this tip grid can evolve
 * independently.
 */
const BEST_PRACTICES: Array<{ title: string; body: React.ReactNode }> = [
  {
    title: 'Audio setup',
    body: (
      <>
        The app captures <strong>system audio</strong> — what comes out of your
        speakers or headphones — not your mic. Make sure the meeting audio is
        playing through your default output device. If you are on mute, the
        app still hears the other participants.
      </>
    ),
  },
  {
    title: 'Screen selection',
    body: (
      <>
        When using <kbd className="guide-kbd">Ctrl</kbd>+
        <kbd className="guide-kbd">Shift</kbd>+
        <kbd className="guide-kbd">S</kbd>, highlight just the relevant area —
        a code block, a specific paragraph, or a chat message. Smaller regions
        give faster AI responses from the Groq API because there is less
        visual data to process.
      </>
    ),
  },
  {
    title: 'Click-through',
    body: (
      <>
        The overlay is <strong>click-through by default</strong> — your mouse
        passes right through it to interact with windows underneath. Toggle
        interactive mode (<kbd className="guide-kbd">Ctrl</kbd>+
        <kbd className="guide-kbd">Shift</kbd>+
        <kbd className="guide-kbd">I</kbd>) only when you need to scroll or
        drag panels.
      </>
    ),
  },
  {
    title: 'Panel positioning',
    body: (
      <>
        Keep the overlay near your <strong>webcam eyeline</strong> for the most
        natural delivery. In interactive mode, you can drag each panel
        independently — the control panel, response panel, and transcript
        panel all have separate drag handles.
      </>
    ),
  },
];

/**
 * Troubleshooting FAQ items.
 *
 * Each item becomes a native `<details>` / `<summary>` pair below. Native
 * `<details>` ships zero JS for the open/close behaviour, replacing the
 * legacy inline `<script dangerouslySetInnerHTML>` toggler that listened
 * for clicks on `.faq-question` buttons in the pre-redesign page.
 */
const FAQ_ITEMS: Array<{ question: string; answer: React.ReactNode }> = [
  {
    question: "The AI isn't responding",
    answer:
      "Check that your Groq API key is set correctly. Open config.ini and verify the api_key field, or run 'echo %GROQ_API_KEY%' in a terminal to check the environment variable. Also make sure you have internet access — the AI needs to reach Groq's servers.",
  },
  {
    question: "It's capturing my audio but not the meeting audio",
    answer:
      'Unviewable uses WASAPI Loopback to capture system audio — the sound coming out of your speakers or headphones. If the meeting audio is routed to a different output device (e.g., a Bluetooth headset), make sure that device is set as the default Windows audio output.',
  },
  {
    question: 'The transcript seems inaccurate',
    answer:
      "Whisper works best with clear audio. Ensure the meeting volume is at a reasonable level and there's minimal background noise. You can also change the whisper language in config.ini (e.g., language = hi for Hindi) if the meeting isn't in English.",
  },
  {
    question: 'Can participants see the overlay?',
    answer:
      'No. The Windows DWM API (WDA_EXCLUDEFROMCAPTURE) tells the OS compositor to completely exclude the overlay from all DXGI-based capture pipelines. Zoom, Teams, Discord, OBS — none of them can see it. Only your physical monitor displays it.',
  },
  {
    question: 'Still having trouble? Contact support',
    answer: (
      <>
        If you are experiencing issues or have questions, please reach out to
        our team directly at{' '}
        <a href="mailto:join.invisibleai@gmail.com">join.invisibleai@gmail.com</a>.
        We&apos;re here to help.
      </>
    ),
  },
];

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://www.unviewable.online';

/**
 * Structured data for the usage guide:
 *   - FAQPage: derived from FAQ_ITEMS, skipping the JSX "contact support"
 *     entry so only real question/answer pairs are emitted. These troubleshooting
 *     Q&As are exactly the kind of content AI answer engines cite.
 *   - BreadcrumbList: Home → Usage guide.
 */
function usageJsonLd() {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: FAQ_ITEMS.filter(
        (item) => typeof item.answer === 'string',
      ).map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: { '@type': 'Answer', text: item.answer as string },
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Home',
          item: SITE_URL,
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'Usage guide',
          item: `${SITE_URL}/guides/usage`,
        },
      ],
    },
  ];
}

export default function UsageGuidePage() {
  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(usageJsonLd()) }}
      />
      <GuideShell
        eyebrow="Run & operate"
        title={
          <>
            Usage <em>guide</em>
          </>
        }
        lede="Everything you need to run the AI overlay during live calls — hotkeys, workflows, and pro tips."
        steps={USAGE_STEPS}
      />

      {/* Best practices — four pro-tip cards in a 2-column grid at >= 768px,
          single column below. Token-driven; no `glass-panel` blur, no
          inline `style={…}` — colors and chrome come from the same tokens
          driving the rest of the redesign. The cards reuse the
          `.usage-tip-card` class which mirrors `.feature-card`'s surface
          contract (see globals.css for the rule body). */}
      <section className="usage-tips" aria-labelledby="usage-tips-heading">
        <div className="usage-tips-inner">
          <p className="eyebrow">Pro tips</p>
          <h2 id="usage-tips-heading">Best practices</h2>
          <p className="usage-tips-lede">
            Level up from beginner to power user. A handful of habits make the
            difference between a clean session and one that fights you.
          </p>
          <div className="usage-tips-grid">
            {BEST_PRACTICES.map((tip) => (
              <article key={tip.title} className="usage-tip-card">
                <h3>{tip.title}</h3>
                <p>{tip.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Troubleshooting FAQ — zero-JS native disclosure widgets. The legacy
          inline `<script>` that toggled `.is-open` on click is fully gone:
          `<details>` handles open/close natively with full keyboard support
          (Enter/Space toggles, focus ring on summary). */}
      <section className="guide-faq" aria-labelledby="usage-faq-heading">
        <p className="eyebrow">Troubleshooting</p>
        <h2 id="usage-faq-heading">Common questions</h2>
        <div className="guide-faq-list">
          {FAQ_ITEMS.map((item) => (
            <details key={item.question}>
              <summary>{item.question}</summary>
              <div>{item.answer}</div>
            </details>
          ))}
        </div>
      </section>

      {/* Closing callout — links back to the setup guide for readers who
          arrived here before installing. Mirrors the structure of the
          callout at the bottom of `/guides/setup` (which links forward to
          this page), so the two guides cross-reference cleanly. The
          `.guide-aftermatter` wrapper centres the callout to the same
          max-width as the GuideShell content above it. */}
      <div className="guide-aftermatter">
        <div className="callout">
          <p>
            <strong>New here?</strong> Start with the{' '}
            <Link href="/guides/setup">Setup Guide</Link> to install and
            configure Unviewable before your first session.
          </p>
        </div>
      </div>
    </SiteShell>
  );
}
