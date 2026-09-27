import type { Metadata } from 'next';

import { LegalShell } from '@/components/legal/LegalShell';
import { BUSINESS_INFO } from '@/components/constants/business-info';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'What data Unviewable collects, how it is stored, who processes it, and how to delete it.',
  alternates: { canonical: '/privacy' },
};

/**
 * /privacy — required for Razorpay activation.
 *
 * DRAFT FOR YOUR REVIEW — have a professional check this before going live.
 *
 * The contents are written to match what the codebase ACTUALLY does, not a
 * generic template, because an inaccurate privacy policy is worse than none:
 *   - profiles, devices, desktop_sessions, activity_events, api_usage,
 *     user_api_keys, payments, entitlements, download_events (Supabase)
 *   - Groq key encrypted AES-256-GCM, master key in an env var, never in
 *     Postgres (src/lib/crypto/key-vault.ts)
 *   - refresh tokens stored only as SHA-256 hashes (004_desktop_sessions.sql)
 *   - audio/screenshots proxied to Groq, not persisted by us
 *     (src/app/api/ai/_shared.ts)
 *   - download_events records IP + user agent (010_releases.sql)
 * If any of that changes, update this page in the same commit.
 */
export default function PrivacyPage() {
  const b = BUSINESS_INFO;

  return (
    <LegalShell
      eyebrow="Legal"
      title={
        <>
          Privacy <em>Policy</em>
        </>
      }
      lede={`How ${b.legalName} handles your data when you use Unviewable.`}
      lastUpdated="27 September 2026"
    >
      <h2>1. Who we are</h2>
      <p>
        {b.legalName} ({b.entityType}), {b.registeredAddress}, is the data
        controller. Contact us at{' '}
        <a href={`mailto:${b.email}`}>{b.email}</a>.
      </p>

      <h2>2. What we collect</h2>
      <h3>Account data</h3>
      <p>
        Your email address and authentication credentials, handled by Supabase
        Auth. If you sign in with Google, we receive your email address and basic
        profile information from Google. We never see your Google password.
      </p>

      <h3>Payment data</h3>
      <p>
        Razorpay processes your payment and we never receive or store your card
        number, CVV, UPI PIN, or bank credentials. We store the Razorpay order
        and payment identifiers, the amount, the tax component, the status, the
        IP address recorded at the time of purchase, and your browser user agent
        — the records we need for accounting, support, and dispute handling.
      </p>

      <h3>Device and session data</h3>
      <p>
        When you sign the desktop app into your account we store a random device
        identifier it generates, session timestamps, the IP address at sign-in,
        and the user agent. Sign-in tokens are stored only as SHA-256 hashes, so
        a person reading our database cannot use them to sign in as you.
      </p>

      <h3>Your AI provider key</h3>
      <p>
        If you add a Groq API key, we encrypt it with AES-256-GCM before storing
        it. The encryption key is held in our server environment and never in the
        database, so database access alone does not reveal your key. We display
        only its last four characters. We never return the key to any client and
        never log it.
      </p>

      <h3>Usage data</h3>
      <p>
        We record which AI endpoint you called, the model, token counts, response
        latency, and status codes, so we can operate the service and enforce
        limits. The desktop app also reports coarse events such as sign-in,
        sign-out, launch, quit, and errors. We record downloads — the build, when,
        the IP address, and the user agent — to detect licence sharing.
      </p>

      <h3>Resumes, jobs and career tools</h3>
      <p>
        When you upload a resume we store the file privately, the text we read
        from it, and a structured summary (skills, roles, education) used to
        score it against jobs. Resumes and their scan reports are deleted
        automatically after 90 days. Jobs you save to your tracker, with any
        notes, follow-up dates and job descriptions, are kept until you delete
        them or your account. LinkedIn drafts and interview practice questions
        are kept for 30 days so you can come back to them. Your interview
        answers are sent to our AI provider to generate feedback and are not
        stored; we keep only the score.
      </p>
      <p>
        The free ATS checker at /ats-checker does not store the file you check:
        it is read in memory and discarded when the result is returned.
      </p>

      <h3 id="browser-extension">Browser extension</h3>
      <p>
        The Unviewable Chrome extension reads a web page only when you click its
        icon, and only to fill in the job details (role, company, location,
        description) in its window. It does not track your browsing, read pages
        in the background, or collect browsing history. Job details are sent to
        your Unviewable account only when you press <em>Save to tracker</em> or{' '}
        <em>Check match</em>. The extension keeps a sign-in token in your
        browser&apos;s extension storage so you stay connected; you can remove
        it at any time with <em>Sign out</em> in the extension, or by signing
        out every device from your account page.
      </p>

      <h3>Emails</h3>
      <p>
        We send a welcome email when you sign up, reminders on follow-up dates
        you set in your tracker, and a weekly email with new jobs that match your
        resume. Every email has a one-click unsubscribe link. Receipts for
        payments are sent regardless, because they are records of a purchase.
      </p>

      <h3>Product analytics</h3>
      <p>
        We count key actions (for example: signed up, checked a resume, saved a
        job, paid) against your account to understand how the product is used.
        These records contain no resume text, job text or other content. Page
        views are measured with Vercel Web Analytics, which uses no cookies and
        does not identify you.
      </p>

      <h3>What we do NOT store</h3>
      <p>
        We do not store your meeting audio, transcripts, screenshots, or AI
        conversations. When you use an AI feature, the audio or image is relayed
        through our server to Groq and discarded once the response is returned.
        Transcripts exist only in the memory of the application on your own
        machine.
      </p>

      <h2>3. Why we process it</h2>
      <ul>
        <li>To provide your account, licence, and downloads (contract).</li>
        <li>To take payment and meet tax and accounting obligations (legal).</li>
        <li>
          To secure the service, prevent fraud, and detect licence sharing
          (legitimate interests).
        </li>
        <li>To provide support when you contact us (contract).</li>
      </ul>

      <h2>4. Who we share it with</h2>
      <p>We use these processors, and no others:</p>
      <ul>
        <li>
          <strong>Supabase</strong> — authentication, database, and private file
          storage for installers.
        </li>
        <li>
          <strong>Vercel</strong> — application hosting and request logs.
        </li>
        <li>
          <strong>Razorpay</strong> — payment processing. Governed by their own
          privacy policy.
        </li>
        <li>
          <strong>Groq</strong> — AI inference. Your prompts, audio, and images
          are sent to Groq to generate responses, under your own API key or
          ours, and their terms. For the website&apos;s resume, LinkedIn and
          interview features this includes your resume text, the job
          description and your practice answers.
        </li>
        <li>
          <strong>Google</strong> — only if you choose Google sign-in.
        </li>
        <li>
          <strong>Resend</strong> — sending account and reminder emails. They
          receive your email address and the email content.
        </li>
      </ul>
      <p>
        We do not sell your data, and we do not share it for advertising. We may
        disclose data where legally required.
      </p>

      <h2>5. International transfers</h2>
      <p>
        Our processors may store or process data outside India, including in the
        United States and the European Union. We rely on their contractual data
        protection commitments for those transfers.
      </p>

      <h2>6. How long we keep it</h2>
      <ul>
        <li>
          Account, licence, and payment records: while your account is open, and
          afterwards for as long as tax and accounting law requires.
        </li>
        <li>Sign-in sessions: until they expire or are revoked.</li>
        <li>Usage, activity, and download logs: up to 24 months.</li>
        <li>Resumes and resume scan reports: 90 days, then deleted automatically.</li>
        <li>LinkedIn drafts and interview practice sessions: 30 days.</li>
        <li>Your job tracker: until you delete the jobs or your account.</li>
        <li>Your Groq key: until you remove it, or you delete your account.</li>
      </ul>

      <h2>7. Your choices</h2>
      <p>
        You can remove your Groq API key at any time from your account page, and
        sign out every device from there too. To request a copy of your data, a
        correction, or deletion of your account, email{' '}
        <a href={`mailto:${b.email}`}>{b.email}</a>; we respond within{' '}
        {b.supportResponseDays} working days.
      </p>
      <p>
        Deleting your account removes your profile, sessions, stored key, and
        activity. We retain the minimum payment records that tax law requires,
        and deletion ends your licence and download access.
      </p>

      <h2>8. Security</h2>
      <p>
        Secrets live in server-side environment variables, never in client code.
        Your AI key is encrypted at rest. Sign-in tokens are stored as hashes
        only. Installers sit in a private bucket and are served through
        short-lived links tied to your entitlement. Logging is filtered to strip
        credentials before anything is written. No system is perfectly secure,
        and we will notify you and the relevant authority of a breach affecting
        you as required by law.
      </p>

      <h2>9. Children</h2>
      <p>
        Unviewable is not intended for anyone under 18, and we do not knowingly
        collect their data. Contact us if you believe a child has provided us
        data and we will delete it.
      </p>

      <h2>10. Cookies</h2>
      <p>
        We set cookies that are strictly necessary to keep you signed in and to
        remember your theme preference. We do not use advertising or analytics
        cookies (Vercel Web Analytics is cookieless).
      </p>

      <h2>11. Changes</h2>
      <p>
        We will update this page when our practices change and revise the
        &ldquo;Last updated&rdquo; date. Material changes affecting your rights
        will be notified by email.
      </p>
    </LegalShell>
  );
}
