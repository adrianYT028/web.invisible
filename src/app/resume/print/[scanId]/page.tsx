import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { loadTailoredResume } from '@/lib/resume/export/load';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

import { PrintButton } from './PrintButton';

/**
 * `/resume/print/[scanId]` — the tailored resume as a printable page.
 *
 * "Save as PDF" in the browser's print dialog turns this into the PDF, so we
 * need no PDF library. The page has no site header or footer and a print
 * stylesheet (see .print-* in globals.css) that hides the toolbar and fits A4.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your tailored resume',
  robots: { index: false },
};

interface PageProps {
  params: Promise<{ scanId: string }>;
}

export default async function PrintResumePage({ params }: PageProps) {
  const { scanId } = await params;
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect(`/login?redirectedFrom=${encodeURIComponent(`/resume/print/${scanId}`)}`);

  const loaded = await loadTailoredResume(user.id, scanId);
  if (!loaded) notFound();
  const { doc } = loaded;

  return (
    <main className="print-page">
      <div className="print-toolbar">
        <p>
          In the print window, choose <strong>Save as PDF</strong> as the
          destination.
          {doc.rewritesApplied > 0
            ? ` ${doc.rewritesApplied} bullet${doc.rewritesApplied === 1 ? '' : 's'} use the stronger wording from your scan.`
            : ''}
        </p>
        <PrintButton />
        <a className="cta cta-secondary" href={`/api/resume/export/${scanId}`} download>
          Download Word instead
        </a>
      </div>

      <article className="print-resume">
        <h1>{doc.name}</h1>
        {doc.contactLine ? <p className="print-contact">{doc.contactLine}</p> : null}

        {doc.summary ? (
          <section>
            <h2>Summary</h2>
            <p>{doc.summary}</p>
          </section>
        ) : null}

        {doc.sections.map((section) => (
          <section key={section.heading}>
            <h2>{section.heading}</h2>
            {section.line ? <p>{section.line}</p> : null}
            {section.items.map((item, i) => (
              <div key={`${item.title}-${i}`} className="print-item">
                <p className="print-item-head">
                  <strong>{item.title}</strong>
                  {item.dates ? <span>{item.dates}</span> : null}
                </p>
                {item.subtitle ? <p className="print-item-sub">{item.subtitle}</p> : null}
                {item.bullets.length > 0 ? (
                  <ul>
                    {item.bullets.map((b, j) => (
                      <li key={j}>{b}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </section>
        ))}
      </article>
    </main>
  );
}
