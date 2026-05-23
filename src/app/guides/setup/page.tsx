import type { Metadata } from 'next';
import Link from 'next/link';

import { SiteShell } from '@/components/chrome/SiteShell';
import { GuideShell, type GuideStepData } from '@/components/guides/GuideShell';

export const metadata: Metadata = {
  title: 'Setup Guide — Install Unviewable in 2 Minutes',
  description:
    'Step-by-step installation guide for Unviewable on Windows. Download, configure the Groq API key, and launch the stealth AI overlay.',
  alternates: { canonical: '/guides/setup' },
  openGraph: {
    title: 'Setup Guide — Install Unviewable in 2 Minutes',
    description: 'Step-by-step installation guide for Unviewable on Windows.',
    url: '/guides/setup',
  },
};

/**
 * Screenshot intrinsic dimensions.
 *
 * The four guide screenshots in `public/guides/` were authored as 1024×1024
 * JPEG/PNG renders. We pass these intrinsic dimensions to `<ScreenshotFrame />`
 * so `next/image` can reserve the exact pixel slot at first paint and
 * contribute zero CLS to the page (Req 19.3, 19.6). If any screenshot is
 * later re-exported at a different resolution, update the matching entry
 * here so the served `srcset` continues to match the intrinsic ratio.
 */
const SCREENSHOT_DIMS = { width: 1024, height: 1024 } as const;

const SETUP_STEPS: GuideStepData[] = [
  {
    id: 'download',
    title: 'Download the application',
    image: {
      src: '/guides/step-download.png',
      alt: 'Download the Unviewable application',
      ...SCREENSHOT_DIMS,
    },
    body: (
      <>
        <p>
          Head to the{' '}
          <Link href="/downloads">downloads page</Link>{' '}
          and grab the latest release. Extract the folder to a permanent location like{' '}
          <code>Documents</code> or <code>Desktop</code>.
        </p>
        <p>
          The download is a single portable folder — no installer wizard, no system-wide
          dependencies. Everything Unviewable needs lives inside the extracted directory.
        </p>
      </>
    ),
  },
  {
    id: 'groq-api',
    title: 'Get your Groq API key',
    image: {
      src: '/guides/step-groq-api.png',
      alt: 'Groq Console API key generation page',
      ...SCREENSHOT_DIMS,
    },
    body: (
      <>
        <p>
          Sign up for free at{' '}
          <a href="https://console.groq.com" target="_blank" rel="noopener noreferrer">
            console.groq.com
          </a>
          . Navigate to <strong>API Keys</strong> in the sidebar and click{' '}
          <strong>Create API Key</strong>. Copy the key — you&apos;ll need it in the next step.
        </p>
        <p>
          Groq&apos;s free tier includes generous rate limits, more than enough for live
          meetings and interviews.
        </p>
      </>
    ),
  },
  {
    id: 'configure',
    title: 'Configure the app',
    image: {
      src: '/guides/step-configure.png',
      alt: 'Configuring the API key via terminal or config.ini',
      ...SCREENSHOT_DIMS,
    },
    body: (
      <>
        <p>Set your API key using either method.</p>
        <p>
          <strong>Option A — Environment variable.</strong> Open a terminal and run:
        </p>
        <p>
          <code>setx GROQ_API_KEY &quot;your-api-key-here&quot;</code>
        </p>
        <p>
          <strong>Option B — Config file.</strong> Open <code>config.ini</code> in the app
          folder and paste your key into the <code>api_key</code> field under{' '}
          <code>[General]</code>.
        </p>
        <p>
          You can also tweak the AI model, font size, panel opacity, and other behaviour from
          the same <code>config.ini</code>.
        </p>
      </>
    ),
  },
  {
    id: 'launch',
    title: 'Launch the app',
    image: {
      src: '/guides/step-launch.png',
      alt: 'Launching Unviewable with hotkey',
      ...SCREENSHOT_DIMS,
    },
    body: (
      <>
        <p>
          Double-click <code>InvisibleOverlay.exe</code> to start. The overlay attaches to
          your display and becomes invisible to screen-capture tools immediately. You&apos;ll
          see a system tray icon confirming it&apos;s running.
        </p>
        <p>
          The app starts listening to system audio automatically — no virtual cables, no
          extra setup needed.
        </p>
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
    question: 'My antivirus flagged the app',
    answer:
      'Invisible overlays sometimes trigger false positives due to screen-reading behavior and capture-exclusion APIs. Add InvisibleOverlay.exe to your antivirus whitelist and re-run the setup.',
  },
  {
    question: "The app says 'No API key — AI features disabled'",
    answer:
      "Your Groq API key isn't being detected. Make sure you either set the GROQ_API_KEY environment variable (restart your terminal after running setx) or pasted the key into config.ini under the [General] section.",
  },
  {
    question: 'Windows SmartScreen is blocking the download',
    answer:
      'Click "More info" on the SmartScreen prompt, then click "Run anyway". This happens because the app is new and hasn\'t been signed with an EV certificate yet.',
  },
  {
    question: 'Is it really invisible to screen share?',
    answer:
      "Yes. Unviewable uses the Windows DWM API (SetWindowDisplayAffinity with WDA_EXCLUDEFROMCAPTURE). This tells the operating system's compositor to exclude the window from all DXGI-based capture pipelines — Zoom, Teams, Discord, OBS, and any other tool that uses screen capture.",
  },
  {
    question: 'Still having trouble? Contact support',
    answer: (
      <>
        If you are experiencing issues or have questions, please reach out to our team
        directly at{' '}
        <a href="mailto:join.invisibleai@gmail.com">join.invisibleai@gmail.com</a>. We&apos;re
        here to help.
      </>
    ),
  },
];

export default function SetupGuidePage() {
  return (
    <SiteShell>
      <GuideShell
        eyebrow="Install & run"
        title="Setup guide"
        lede="Welcome to your AI meeting assistant. Install the invisible overlay and start leveraging real-time intelligence in your meetings and interviews."
        steps={SETUP_STEPS}
      />

      {/* Compatibility callout — preserves the link to the usage guide that
          previously lived in `.tech-note glass-panel` (now token-driven
          `.callout`, see globals.css). Sits below the steps so readers who
          followed all four steps land on the natural next action. The
          `.guide-aftermatter` wrapper centers the callout to the same
          max-width as the GuideShell content above it. */}
      <div className="guide-aftermatter">
        <div className="callout">
          <p>
            <strong>All set?</strong> Head to the{' '}
            <Link href="/guides/usage">usage guide</Link> to learn hotkeys, best practices,
            and how to get the most out of the AI during live sessions.
          </p>
        </div>
      </div>

      {/* Troubleshooting FAQ — zero-JS native disclosure widgets. The legacy
          inline `<script>` that toggled `.is-open` on click is fully gone:
          `<details>` handles open/close natively with full keyboard support
          (Enter/Space toggles, focus ring on summary). */}
      <section className="guide-faq" aria-labelledby="setup-faq-heading">
        <p className="eyebrow">Troubleshooting</p>
        <h2 id="setup-faq-heading">Common questions</h2>
        <div className="guide-faq-list">
          {FAQ_ITEMS.map((item) => (
            <details key={item.question}>
              <summary>{item.question}</summary>
              <div>{item.answer}</div>
            </details>
          ))}
        </div>
      </section>
    </SiteShell>
  );
}
