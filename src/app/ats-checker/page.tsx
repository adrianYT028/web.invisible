import type { Metadata } from 'next';

import { SiteShell } from '@/components/chrome/SiteShell';

import { AtsChecker } from './AtsChecker';

/**
 * `/ats-checker` — free resume check, no sign-in.
 *
 * The page people land on from search ("ATS resume checker", "resume score").
 * Public in src/proxy.ts and listed in the sitemap. The check itself runs at
 * /api/public/ats-check: deterministic, no AI, nothing stored.
 */

export const metadata: Metadata = {
  title: 'Free ATS Resume Checker — No Sign-up',
  description:
    'Check if applicant tracking systems can read your resume, and which words from the job description it is missing. Free, no sign-up, your file is not stored.',
  alternates: { canonical: '/ats-checker' },
  openGraph: {
    title: 'Free ATS Resume Checker — No Sign-up',
    description:
      'See if your resume survives applicant tracking software, and which job keywords it is missing. Free and private.',
    url: '/ats-checker',
  },
};

const FAQ = [
  {
    q: 'What does this check?',
    a: 'Whether software can read your file at all (scanned images, columns, tables and unusual fonts are common problems), and, if you paste a job description, which words the job repeats that your resume never uses.',
  },
  {
    q: 'Is my resume stored?',
    a: 'No. The file is read in memory to run the check and is not saved anywhere.',
  },
  {
    q: 'Is this the score employers see?',
    a: 'No applicant tracking system shows candidates a score. This checks readability and word overlap, the two things you can fix yourself.',
  },
  {
    q: 'What do I get if I sign up?',
    a: 'A match score for a specific job, requirement by requirement, stronger wording for your weakest bullet points (never inventing experience), a downloadable resume, and a free job tracker.',
  },
];

export default function AtsCheckerPage() {
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner account-inner--wide">
          <p className="eyebrow">Free · no sign-up</p>
          <h1 className="section-serif-em">
            Will software <em>read</em> your resume?
          </h1>
          <p className="lede">
            Most companies run resumes through an applicant tracking system before
            a person sees them. Check yours in a few seconds. Your file is not
            stored.
          </p>

          <AtsChecker />

          <section className="resume-block">
            <h2>Common questions</h2>
            {FAQ.map((f) => (
              <div key={f.q}>
                <h3>{f.q}</h3>
                <p className="resume-lede">{f.a}</p>
              </div>
            ))}
          </section>
        </div>
      </section>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
    </SiteShell>
  );
}
