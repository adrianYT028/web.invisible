import type { Metadata } from 'next';

import { LegalShell } from '@/components/legal/LegalShell';
import { BUSINESS_INFO } from '@/components/constants/business-info';
import { formatPriceDisclosure } from '@/lib/payments/pricing';

export const metadata: Metadata = {
  title: 'About Us',
  description:
    'What Unviewable is, who builds it, and what you get when you buy a licence.',
  alternates: { canonical: '/about' },
};

export default function AboutPage() {
  const b = BUSINESS_INFO;

  return (
    <LegalShell
      eyebrow="About"
      title={
        <>
          About <em>Unviewable</em>
        </>
      }
      lede="A desktop assistant that stays on your screen and out of your screen share."
      lastUpdated="17 August 2026"
    >
      <h2>What we make</h2>
      <p>
        Unviewable is a Windows desktop application. It listens to your meeting
        audio, transcribes it, and shows you AI-generated answers and summaries
        in an overlay that is excluded from screen-capture pipelines — so the
        overlay is visible on your physical display but does not appear in screen
        sharing, screen recording, or screenshots.
      </p>
      <p>
        It is intended for interview preparation, meeting note-taking, and
        accessibility support. It is not intended for, and we do not support,
        use that breaches an examination body&apos;s or employer&apos;s rules.
        Using it is your responsibility.
      </p>

      <h2>What you are buying</h2>
      <p>
        A one-time payment of <strong>{formatPriceDisclosure()}</strong> gives
        you a permanent licence to download and use the current Windows feature
        set. There is no subscription and no recurring charge. Full details are
        in our <a href="/terms">Terms of Service</a>.
      </p>
      <p>
        Your own AI provider key powers the AI features. You add a Groq API key
        in your account, we store it encrypted, and requests are billed by Groq
        to you — not resold by us.
      </p>

      <h2>Who we are</h2>
      <div className="surface">
        <dl className="legal-details">
          <dt>Registered name</dt>
          <dd>{b.legalName}</dd>

          <dt>Entity type</dt>
          <dd>{b.entityType}</dd>

          <dt>Registered address</dt>
          <dd>{b.registeredAddress}</dd>

          <dt>Email</dt>
          <dd>
            <a href={`mailto:${b.email}`}>{b.email}</a>
          </dd>
        </dl>
      </div>
      <p>
        Full contact details, including our phone number, are on the{' '}
        <a href="/contact">Contact page</a>.
      </p>

      <h2>Platforms</h2>
      <p>
        Windows 10 version 2004 or later is supported today. A macOS build is in
        development. Payments are currently accepted from India only.
      </p>
    </LegalShell>
  );
}
