import type { Metadata } from 'next';

import { LegalShell } from '@/components/legal/LegalShell';
import { BUSINESS_INFO } from '@/components/constants/business-info';
import { formatInr, DOWNLOAD_LICENSE_PRICE } from '@/lib/payments/pricing';

export const metadata: Metadata = {
  title: 'Refund & Cancellation Policy',
  description:
    'When Unviewable purchases can be refunded, how to request a refund, and how long it takes.',
  alternates: { canonical: '/refund' },
};

/**
 * /refund — required for Razorpay activation.
 *
 * DRAFT FOR YOUR REVIEW. The stance below is deliberately more generous than
 * "no refunds on digital goods", for a commercial reason rather than a legal
 * one: Razorpay monitors dispute rates and can freeze a merchant account over
 * them. A visible, easy refund path converts would-be chargebacks into support
 * emails. Have a professional review this before you go live.
 */
export default function RefundPage() {
  const b = BUSINESS_INFO;
  const total = formatInr(DOWNLOAD_LICENSE_PRICE.totalAmountPaise);

  return (
    <LegalShell
      eyebrow="Refunds"
      title={
        <>
          Refund &amp; <em>cancellation</em>
        </>
      }
      lede={`Unviewable is a one-time ${total} purchase. If it doesn't work on your machine, we refund it.`}
      lastUpdated="17 August 2026"
    >
      <h2>What you are buying</h2>
      <p>
        A permanent licence to download and use Unviewable for Windows. It is a
        digital product delivered immediately — there is nothing to ship and
        nothing to cancel on a recurring basis, because there is no
        subscription.
      </p>

      <h2>When we refund</h2>
      <p>
        We will refund your purchase in full, within{' '}
        <strong>{b.refundWindowDays} days</strong> of payment, if any of the
        following apply:
      </p>
      <ul>
        <li>
          The application does not install or does not launch on a supported
          system (Windows 10 version 2004 or later).
        </li>
        <li>
          A core advertised feature does not work on your machine and we cannot
          resolve it with you.
        </li>
        <li>
          You were charged more than once for the same licence, or charged after
          a failed payment. Duplicate charges are refunded regardless of the{' '}
          {b.refundWindowDays}-day window.
        </li>
        <li>You paid but never received access to the download.</li>
      </ul>

      <h2>When we do not refund</h2>
      <ul>
        <li>
          Change of mind after you have successfully downloaded and run the
          application, outside the {b.refundWindowDays}-day window.
        </li>
        <li>
          Your AI provider (Groq) costs. Those are billed to you directly by
          Groq under your own API key; we never charge for them and cannot
          refund them.
        </li>
        <li>
          Consequences of use that breaches a third party&apos;s rules — for
          example an examination body&apos;s or employer&apos;s policy. Please
          read the <a href="/terms">Terms</a> before purchasing.
        </li>
        <li>
          Requests where we cannot match the payment to an account, after we
          have asked you for the details needed.
        </li>
      </ul>

      <h2>Capture exclusion is not guaranteed on every configuration</h2>
      <p>
        Unviewable relies on operating-system capture-exclusion behaviour, which
        varies by Windows version and by the conferencing or recording software
        in use. We list supported configurations on the{' '}
        <a href="/downloads">downloads page</a>. If capture exclusion does not
        work on a supported configuration, that qualifies as a core feature
        failure and is refundable under the terms above.
      </p>

      <h2>How to request a refund</h2>
      <p>
        Email <a href={`mailto:${b.email}`}>{b.email}</a> with the subject
        &ldquo;Refund request&rdquo;. Include:
      </p>
      <ul>
        <li>The email address on your Unviewable account</li>
        <li>
          Your Razorpay payment id (starts with <code>pay_</code>, shown on your
          payment receipt)
        </li>
        <li>A short description of the problem</li>
      </ul>

      <h2>How long it takes</h2>
      <p>
        We respond within {b.supportResponseDays} working days. Once approved,
        the refund is issued to your original payment method through Razorpay.
        Bank and card settlement typically takes a further 5 to 10 working days,
        which is outside our control.
      </p>
      <p>
        When a refund is processed, your download access is withdrawn and you
        must stop using the application.
      </p>

      <h2>Before you dispute a charge</h2>
      <p>
        Please email us first. A refund is faster for you than a bank dispute,
        and we would rather resolve it directly.
      </p>
    </LegalShell>
  );
}
