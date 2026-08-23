import type { Metadata } from 'next';

import { LegalShell } from '@/components/legal/LegalShell';
import { BUSINESS_INFO } from '@/components/constants/business-info';
import { formatPriceDisclosure } from '@/lib/payments/pricing';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description:
    'The terms governing your purchase and use of Unviewable, including licence scope and acceptable use.',
  alternates: { canonical: '/terms' },
};

/**
 * /terms — required for Razorpay activation.
 *
 * DRAFT FOR YOUR REVIEW — have a professional check this before going live.
 *
 * Section 3 is the commercially important one. The product is sold today as a
 * one-time payment, and tiered subscriptions are planned. Without an explicit
 * statement that the licence covers the CURRENT feature set and that future
 * premium features are priced separately, early buyers will reasonably believe
 * they bought everything forever — and gating a feature they had produces
 * refund demands and public complaints. Saying it before the first sale costs
 * nothing; saying it afterwards is a broken promise.
 */
export default function TermsPage() {
  const b = BUSINESS_INFO;

  return (
    <LegalShell
      eyebrow="Legal"
      title={
        <>
          Terms of <em>Service</em>
        </>
      }
      lede={`These terms govern your purchase and use of Unviewable, operated by ${b.legalName}.`}
      lastUpdated="17 August 2026"
    >
      <h2>1. Agreement</h2>
      <p>
        By creating an account, purchasing a licence, or using Unviewable, you
        agree to these terms. If you do not agree, do not purchase or use the
        software. You must be legally capable of entering a contract in your
        jurisdiction.
      </p>

      <h2>2. What Unviewable does</h2>
      <p>
        Unviewable is a Windows desktop application that transcribes meeting
        audio and displays AI-generated responses in an overlay excluded from
        screen-capture pipelines. It is provided for interview preparation,
        meeting assistance, note-taking, and accessibility support.
      </p>

      <h2>3. Licence scope — please read</h2>
      <p>
        Your one-time payment of <strong>{formatPriceDisclosure()}</strong> grants
        you a personal, non-exclusive, non-transferable licence to download and
        use <strong>the Windows feature set as it exists at the date of your
        purchase</strong>, permanently, with no recurring fee.
      </p>
      <p>
        We intend to introduce additional paid tiers and premium features in
        future. <strong>Those future premium features are not included in this
        licence</strong> and will be offered separately. Your purchase will
        continue to give you the feature set you paid for; we will not move an
        existing capability behind a new paywall for customers who already
        bought it.
      </p>
      <p>
        The licence is for one person. You may install it on machines you
        personally use. You may not share your account credentials, resell,
        sublicense, rent, or redistribute the software or your download links.
        Download activity is logged, and accounts used to redistribute the
        installer may have access withdrawn without refund.
      </p>

      <h2>4. Acceptable use</h2>
      <p>
        You are responsible for how you use Unviewable and for complying with
        all laws and rules that apply to you. In particular, many examination
        bodies, certification providers, educational institutions, and employers
        prohibit assistance tools during assessments, and many jurisdictions
        regulate recording or transcribing a conversation without the consent of
        the participants.
      </p>
      <p>
        We do not endorse or support use that breaches those rules or laws.
        Determining what applies to your situation, and obtaining any consent
        required, is your responsibility. We accept no liability for
        consequences arising from your use, including academic penalties,
        disciplinary action, loss of employment, or legal claims.
      </p>
      <p>You must not:</p>
      <ul>
        <li>
          Reverse engineer, decompile, or attempt to derive source code, except
          where that right cannot lawfully be excluded.
        </li>
        <li>
          Circumvent the licensing, payment, or download-protection mechanisms.
        </li>
        <li>Use the software to harass, defraud, or impersonate anyone.</li>
      </ul>

      <h2>5. AI features and your API key</h2>
      <p>
        AI features run on your own Groq API key, which you supply in your
        account. We store it encrypted and use it only to serve your requests.
        Groq bills you directly for that usage under your own agreement with
        them; we do not resell AI capacity and do not charge for tokens.
      </p>
      <p>
        AI output can be inaccurate, incomplete, or wrong. Do not rely on it as
        professional, legal, medical, or financial advice. You are responsible
        for anything you do with it.
      </p>

      <h2>6. Accounts</h2>
      <p>
        You must provide accurate information and keep your credentials secure.
        You are responsible for activity under your account. Tell us promptly at{' '}
        <a href={`mailto:${b.email}`}>{b.email}</a> if you believe it has been
        compromised.
      </p>

      <h2>7. Payment</h2>
      <p>
        Prices are shown in Indian Rupees and are exclusive of GST, which is
        added at checkout and shown before you pay. Payments are processed by
        Razorpay; we do not store your card details. Payments are currently
        accepted from India only.
      </p>

      <h2>8. Refunds</h2>
      <p>
        Refunds are governed by our{' '}
        <a href="/refund">Refund &amp; Cancellation Policy</a>, which forms part
        of these terms.
      </p>

      <h2>9. Capture exclusion — no absolute guarantee</h2>
      <p>
        Capture exclusion depends on operating-system behaviour and on the
        conferencing or recording software in use. It can change with an
        operating-system or third-party update outside our control. We publish
        the configurations we support and test against, and we will tell you when
        that list changes. We do not warrant that the overlay will remain hidden
        under every possible configuration, and you should not rely on it where
        the consequences of visibility would be serious.
      </p>

      <h2>10. Availability</h2>
      <p>
        We aim to keep the service available but do not guarantee uninterrupted
        operation. We may modify, suspend, or discontinue parts of the service.
        If we permanently discontinue the download service, we will give
        reasonable notice so you can retain your installer.
      </p>

      <h2>11. Liability</h2>
      <p>
        The software is provided &ldquo;as is&rdquo;. To the maximum extent
        permitted by law, we exclude implied warranties, and our total liability
        for any claim relating to Unviewable is limited to the amount you paid
        for your licence. We are not liable for indirect or consequential loss,
        including lost profits, lost opportunities, or reputational harm. Nothing
        here limits liability that cannot lawfully be limited.
      </p>

      <h2>12. Termination</h2>
      <p>
        We may suspend or terminate your access if you materially breach these
        terms, including redistributing the software or circumventing payment. We
        will tell you why. Where termination is not the result of your breach, we
        will refund a fair amount.
      </p>

      <h2>13. Changes</h2>
      <p>
        We may update these terms. Material changes will be reflected in the
        &ldquo;Last updated&rdquo; date below and, where the change affects your
        rights, notified by email. Changes do not retroactively reduce the
        feature set of a licence you have already bought.
      </p>

      <h2>14. Governing law</h2>
      <p>
        These terms are governed by the laws of India, and the courts at{' '}
        {b.jurisdiction} have exclusive jurisdiction.
      </p>

      <h2>15. Contact</h2>
      <p>
        {b.legalName}, {b.registeredAddress}. Email{' '}
        <a href={`mailto:${b.email}`}>{b.email}</a>. Full details on the{' '}
        <a href="/contact">Contact page</a>.
      </p>
    </LegalShell>
  );
}
