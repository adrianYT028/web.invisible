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
    id: 'api-key',
    title: 'AI access — usually nothing to do',
    image: {
      src: '/guides/step-groq-api.png',
      alt: 'Saving an AI provider key on the account page',
      ...SCREENSHOT_DIMS,
    },
    body: (
      <>
        {/* REWRITTEN. This step used to instruct EVERY user to sign up at
            console.groq.com and create their own key. That is wrong twice over
            now: full access is platform-funded (PLATFORM_FUNDED_PLANS in
            src/lib/ai/plans.ts), so a paying customer needs no key at all — and
            telling them to go and get one is asking them to do work they already
            paid to avoid. */}
        <p>
          <strong>If you have full access, skip this step.</strong> Inference is
          included in your purchase — the platform supplies the AI, and there is
          no key to create and no usage to pay for.
        </p>
        <p>
          <strong>Otherwise this step is required</strong>, or the app will start
          with AI disabled. Go to{' '}
          <a href="/account">
            <strong>Account → API keys</strong>
          </a>
          , pick a provider, paste the key, and save. Do it once: every device
          linked to your account picks it up, so a reinstall or a second machine
          needs no setup.
        </p>
        <p>Three providers are supported:</p>
        <ul>
          <li>
            <a
              href="https://console.groq.com/keys"
              target="_blank"
              rel="noopener noreferrer"
            >
              Groq
            </a>{' '}
            — free tier, fastest responses. The usual choice.
          </li>
          <li>
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
            >
              OpenAI
            </a>{' '}
            — paid, billed by them.
          </li>
          <li>
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
            >
              OpenRouter
            </a>{' '}
            — one key, many models.
          </li>
        </ul>
        <p>
          Keys are encrypted before they are stored and are never shown back to
          you in full. You can save more than one and choose which to prefer.
        </p>
      </>
    ),
  },
  {
    id: 'sign-in',
    title: 'Sign the app in to your account',
    image: {
      src: '/guides/step-configure.png',
      alt: 'Signing the desktop app in to your Unviewable account',
      ...SCREENSHOT_DIMS,
    },
    body: (
      <>
        {/* REWRITTEN. The old step told users to run
            `setx GROQ_API_KEY "..."` or paste a key into config.ini. Neither is
            how the app has worked since the account key vault shipped: the app
            authenticates to your account and the key is read from the vault
            server-side. Publishing the old instructions leaves people editing a
            file that no longer decides anything. */}
        <p>
          Launch the app and choose <strong>Sign in</strong>. Your browser opens,
          you approve the device, and the app is linked to your account.
        </p>
        <p>
          This is what connects the app to whatever you set up in the previous
          step — your saved provider key, or platform-funded access if you have
          full access. The app never holds the key itself: it asks your account,
          and the key is read and decrypted server-side on each request.
        </p>
        <p>
          So there is nothing to paste into a config file and no environment
          variable to set. <code>config.ini</code> still exists for preferences —
          AI model, font size, panel opacity, hotkeys — but it no longer holds
          credentials.
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
      "The app is not signed in, or your account has no key saved and no full access. Choose Sign in inside the app to link it to your account. If you do not have full access, save a Groq, OpenAI or OpenRouter key on your account page - the app reads it from there. Setting a GROQ_API_KEY environment variable or editing config.ini no longer has any effect; credentials moved to the account key vault.",
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

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://www.unviewable.online';

/**
 * Plain-text step summaries for the HowTo JSON-LD. Kept beside the visual
 * steps so the structured data Google and AI engines read stays in sync
 * with the on-page guide. (The visual step bodies are rich JSX, so the
 * machine-readable summary is authored separately and deliberately concise.)
 */
const HOWTO_STEPS = [
  {
    id: 'download',
    name: 'Download the application',
    text: 'Head to the Unviewable downloads page and grab the latest Windows release. Extract the portable folder to a permanent location such as Documents or Desktop.',
  },
  {
    id: 'api-key',
    name: 'Get your Groq API key',
    text: 'Full access includes AI inference, so there is nothing to do. Otherwise create a key at Groq, OpenAI or OpenRouter and save it on your Unviewable account page.',
  },
  {
    id: 'configure',
    name: 'Configure the app',
    text: 'Launch the app and choose Sign in. Approve the device in the browser to link it to your account. No API key or config file editing is required.',
  },
  {
    id: 'launch',
    name: 'Launch the app',
    text: 'Double-click InvisibleOverlay.exe to start. The overlay attaches to your display and immediately becomes invisible to every screen-capture and screen-share pipeline.',
  },
] as const;

/**
 * Structured data for the setup guide:
 *   - HowTo: the four-step installation, so search and AI answer engines can
 *     surface the procedure directly (strong for "how to install" queries).
 *   - FAQPage: derived from FAQ_ITEMS, automatically skipping the JSX
 *     "contact support" entry so only real question/answer pairs are emitted.
 *   - BreadcrumbList: Home → Setup guide.
 */
function setupJsonLd() {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'HowTo',
      name: 'How to set up Unviewable on Windows',
      description:
        'Install and configure Unviewable — a stealth AI overlay for meetings and interviews — on Windows in under two minutes.',
      totalTime: 'PT2M',
      step: HOWTO_STEPS.map((s, i) => ({
        '@type': 'HowToStep',
        position: i + 1,
        name: s.name,
        text: s.text,
        url: `${SITE_URL}/guides/setup#${s.id}`,
      })),
    },
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
          name: 'Setup guide',
          item: `${SITE_URL}/guides/setup`,
        },
      ],
    },
  ];
}

export default function SetupGuidePage() {
  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(setupJsonLd()) }}
      />
      <GuideShell
        eyebrow="Install & run"
        title={
          <>
            Setup <em>guide</em>
          </>
        }
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
