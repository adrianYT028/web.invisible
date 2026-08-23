import type { Metadata } from 'next';

import { LegalShell } from '@/components/legal/LegalShell';
import { BUSINESS_INFO } from '@/components/constants/business-info';

export const metadata: Metadata = {
  title: 'Contact Us',
  description:
    'Reach the Unviewable team — registered business details, support email, and phone number.',
  alternates: { canonical: '/contact' },
};

/**
 * /contact — the page Razorpay's reviewer checks most closely.
 *
 * Their onboarding guidance asks for a registered name, a registered and
 * operating address that can be verified externally, a contact number, and an
 * email. All of it comes from BUSINESS_INFO so there is exactly one place to
 * edit, and placeholders are detectable programmatically.
 */
export default function ContactPage() {
  const b = BUSINESS_INFO;

  return (
    <LegalShell
      eyebrow="Contact"
      title={
        <>
          Get in <em>touch</em>
        </>
      }
      lede={`We answer support email within ${b.supportResponseDays} working days.`}
      lastUpdated="17 August 2026"
    >
      <div className="surface">
        <dl className="legal-details">
          <dt>Registered name</dt>
          <dd>{b.legalName}</dd>

          <dt>Entity type</dt>
          <dd>{b.entityType}</dd>

          <dt>Trading as</dt>
          <dd>{b.tradingName}</dd>

          <dt>Registered address</dt>
          <dd>{b.registeredAddress}</dd>

          <dt>Operating address</dt>
          <dd>{b.operatingAddress}</dd>

          <dt>Phone</dt>
          <dd>
            <a href={`tel:${b.phone.replace(/\s+/g, '')}`}>{b.phone}</a>
          </dd>

          <dt>Email</dt>
          <dd>
            <a href={`mailto:${b.email}`}>{b.email}</a>
          </dd>

          {b.gstin ? (
            <>
              <dt>GSTIN</dt>
              <dd>{b.gstin}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <h2>What to include</h2>
      <p>
        For payment or refund questions, send the email address you signed up
        with and your Razorpay payment id (it starts with <code>pay_</code> and
        appears on your payment receipt). That lets us find your order without a
        back-and-forth.
      </p>

      <h2>Billing and refunds</h2>
      <p>
        See our <a href="/refund">Refund &amp; Cancellation Policy</a> for what
        is refundable and how long it takes.
      </p>
    </LegalShell>
  );
}
