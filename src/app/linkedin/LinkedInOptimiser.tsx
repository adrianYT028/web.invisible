'use client';

import Link from 'next/link';
import { useState } from 'react';

/**
 * `<LinkedInOptimiser />` — one input (optional target role), one button, and
 * the result with a Copy button next to each part. Nothing to configure.
 */

interface Draft {
  headline: string;
  about: string;
  topSkills: string[];
  removed: number;
  targetRole: string | null;
}

export function LinkedInOptimiser({
  initialDraft,
  initialRemaining,
  hasResume,
}: {
  initialDraft: Draft | null;
  initialRemaining: number | null;
  hasResume: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(initialDraft);
  const [remaining, setRemaining] = useState<number | null>(initialRemaining);
  const [role, setRole] = useState(initialDraft?.targetRole ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/linkedin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetRole: role.trim() || undefined }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.message ?? 'That did not work. Try again.');
        return;
      }
      setDraft(body.draft as Draft);
      setRemaining(body.remaining ?? null);
    } catch {
      setError('Could not reach Unviewable. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Copy did not work in this browser. Select the text and copy it instead.');
    }
  }

  if (!hasResume) {
    return (
      <div className="resume-flow">
        <section className="resume-step">
          <h2 className="resume-step-title">Upload your resume first</h2>
          <p className="resume-lede">
            We write your LinkedIn profile from your resume, so we need it first.
          </p>
          <div className="resume-actions">
            <Link className="cta cta-primary" href="/resume">
              Upload my resume
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const outOfTries = remaining === 0;

  return (
    <div className="resume-flow">
      <section className="resume-step">
        <label className="resume-label" htmlFor="li-role">
          The role you want next (optional)
        </label>
        <input
          id="li-role"
          className="account-input"
          value={role}
          maxLength={120}
          placeholder="e.g. Data Analyst, Frontend Developer intern"
          onChange={(e) => setRole(e.target.value)}
        />
        <div className="resume-actions">
          <button
            type="button"
            className="cta cta-primary"
            disabled={busy || outOfTries}
            onClick={() => void generate()}
          >
            {busy ? 'Writing…' : draft ? 'Write it again' : 'Write my LinkedIn profile'}
          </button>
          {remaining !== null ? (
            <span className="resume-counter">
              {remaining} left today
            </span>
          ) : null}
        </div>
        {outOfTries ? (
          <p className="resume-note">
            You have used today&apos;s free rewrite. <Link href="/pricing">Full access</Link> gives
            you up to 10 a day.
          </p>
        ) : null}
        {error ? (
          <p className="resume-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {draft ? (
        <>
          <section className="resume-block" aria-live="polite">
            <h3>Headline</h3>
            <p className="resume-lede">{draft.headline}</p>
            <div className="resume-actions">
              <button type="button" className="cta cta-secondary" onClick={() => void copy('headline', draft.headline)}>
                {copied === 'headline' ? 'Copied' : 'Copy headline'}
              </button>
              <span className="resume-counter">{draft.headline.length}/220</span>
            </div>
          </section>

          <section className="resume-block">
            <h3>About</h3>
            {draft.about.split('\n\n').map((p, i) => (
              <p key={i} className="resume-lede">
                {p}
              </p>
            ))}
            <div className="resume-actions">
              <button type="button" className="cta cta-secondary" onClick={() => void copy('about', draft.about)}>
                {copied === 'about' ? 'Copied' : 'Copy About'}
              </button>
              <span className="resume-counter">{draft.about.length}/2600</span>
            </div>
          </section>

          {draft.topSkills.length > 0 ? (
            <section className="resume-block">
              <h3>Skills to pin at the top</h3>
              <ul className="resume-keywords">
                {draft.topSkills.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="resume-note">
            Written only from what your resume says.
            {draft.removed > 0
              ? ` We removed ${draft.removed} sentence${draft.removed === 1 ? '' : 's'} that claimed something your resume does not.`
              : ''}{' '}
            Read it before you paste it, and change anything that does not sound like you.
          </p>
        </>
      ) : null}
    </div>
  );
}
