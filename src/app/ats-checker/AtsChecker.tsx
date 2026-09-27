'use client';

import { useState } from 'react';

/**
 * `<AtsChecker />` — the free, no-login resume check.
 *
 * One step: choose a file, optionally paste a job description, press Check. The
 * result is the parse check (can software read this file?) and, with a job
 * description, the words the job repeats that the resume never uses. Everything
 * past that (the real match score, rewrites, tracker) is one free signup away,
 * and the call to action says exactly that.
 */

interface CheckResult {
  parseIntegrity: number;
  scannable: boolean;
  pageCount: number | null;
  warnings: string[];
  keywords: { missing: string[]; matched: string[] } | null;
}

const ERRORS: Record<string, string> = {
  no_file: 'Choose a resume file first.',
  empty_file: 'That file is empty.',
  file_too_large: 'That file is over 5 MB. Export a smaller PDF and try again.',
  unsupported_type: 'We can read PDF, Word (.docx) and plain text files.',
  encrypted: 'That PDF is password-protected. Remove the password and try again.',
  rate_limited: 'You have run a lot of checks. Sign up free to keep going, or try again in an hour.',
};

export function AtsChecker() {
  const [file, setFile] = useState<File | null>(null);
  const [jd, setJd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  async function check() {
    if (!file) {
      setError(ERRORS.no_file);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      if (jd.trim()) form.append('jd', jd.trim());
      const res = await fetch('/api/public/ats-check', { method: 'POST', body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const code = body?.code as string | undefined;
        setError((code && ERRORS[code]) || body?.message || 'Something went wrong. Try again.');
        return;
      }
      setResult(body as CheckResult);
    } catch {
      setError('Could not reach the checker. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="resume-flow">
      <section className="resume-step">
        <div className="resume-step-head">
          <span className="resume-step-index" aria-hidden="true">
            01
          </span>
          <h2 className="resume-step-title">Your resume</h2>
        </div>
        <label className="resume-drop" data-busy={busy}>
          <input
            type="file"
            className="resume-drop-input"
            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
            }}
          />
          <span className="resume-drop-action">{file ? file.name : 'Choose a file'}</span>
          <span className="resume-drop-hint">PDF, DOCX or TXT · up to 5 MB · not stored</span>
        </label>
      </section>

      <section className="resume-step">
        <div className="resume-step-head">
          <span className="resume-step-index" aria-hidden="true">
            02
          </span>
          <h2 className="resume-step-title">The job description (optional)</h2>
        </div>
        <label className="resume-label" htmlFor="ats-jd">
          Paste it to see which of its words your resume is missing
        </label>
        <textarea
          id="ats-jd"
          className="resume-jd"
          value={jd}
          maxLength={20000}
          onChange={(e) => setJd(e.target.value)}
          placeholder="Paste the full job description here"
        />
        <div className="resume-actions">
          <button
            type="button"
            className="cta cta-primary"
            disabled={busy || !file}
            onClick={() => void check()}
          >
            {busy ? 'Checking…' : 'Check my resume'}
          </button>
        </div>
        {error ? (
          <p className="resume-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {result ? (
        <section className="resume-verdict" data-scannable={result.scannable} aria-live="polite">
          <div className="resume-verdict-head">
            <h2 className="resume-step-title">Can software read it?</h2>
            <span className="resume-verdict-state">
              {result.scannable ? 'readable' : 'hard to read'}
            </span>
            <span className="resume-verdict-score">{result.parseIntegrity}/100</span>
          </div>
          <p className="resume-lede">
            {result.scannable
              ? result.warnings.length > 0
                ? 'Your resume reads well enough, but fix the points below before you send it.'
                : 'No problems found. Applicant tracking systems should read this file cleanly.'
              : 'Applicant tracking systems will struggle with this file. Fix the problems below first: it is usually the biggest single improvement you can make.'}
          </p>
          {result.warnings.length > 0 ? (
            <ul className="resume-warnings">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}

          {result.keywords ? (
            <div className="resume-block">
              <h3>Words the job uses that your resume does not</h3>
              {result.keywords.missing.length > 0 ? (
                <>
                  <p className="resume-lede">
                    Add a word only if it is genuinely true of you.
                  </p>
                  <ul className="resume-keywords">
                    {result.keywords.missing.map((k) => (
                      <li key={k}>{k}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="resume-lede">
                  Your resume already uses the main words from this job.
                </p>
              )}
            </div>
          ) : null}

          <div className="resume-block">
            <h3>Want the full picture?</h3>
            <p className="resume-lede">
              Sign up free to get a match score for this job, requirement by
              requirement, stronger wording for your weakest bullets, and a
              resume you can download. No card needed.
            </p>
            <div className="resume-actions">
              <a className="cta cta-primary" href="/login?redirectedFrom=%2Fresume">
                Sign up free
              </a>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
