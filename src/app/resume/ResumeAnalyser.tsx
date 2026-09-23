'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';

/**
 * `<ResumeAnalyser />` — the two-step resume flow.
 *
 *   1. Upload a file. The parse gate runs with no AI, and its verdict is shown
 *      immediately.
 *   2. If the file is readable, paste a job description and scan it.
 *
 * THE PARSE VERDICT IS A DESTINATION, NOT A LOADING STATE. Step one is a complete
 * answer on its own — "your two-column layout will scramble your dates" is the
 * most actionable thing most students will hear. So an unreadable file ENDS the
 * flow with a fixable list rather than continuing into a score, because every
 * downstream number would be computed from text the candidate never wrote.
 *
 * The score is labelled as ours, not the employer's, wherever it appears. No
 * applicant tracking system publishes a score to candidates, so calling it an
 * "ATS score" would be a false statement about someone else's software.
 *
 * VISUAL LANGUAGE: transparent sections separated by hairline rules, mono
 * micro-labels, colour only from --signal / --error. That is the incumbent
 * system's own direction — see the note above the .resume-* rules in globals.css
 * for the evidence, and for what an earlier card-and-coloured-border pass got
 * wrong.
 */

interface ResumeAnalyserProps {
  plan: string;
  /** null means unlimited. */
  uploadsLeft: number | null;
  scansLeft: number | null;
  /** e.g. '₹99 + 18% GST = ₹116.82'. */
  upgradePrice: string;
}

interface Diagnostics {
  hasTextLayer: boolean;
  imageOnlyPages: number[];
  columnLayoutSuspected: boolean;
  tablesDetected: boolean;
  headingsFound: string[];
  headingsMissing: string[];
  datesFound: number;
  datesParsed: number;
  wordCount: number;
  hasEmail: boolean;
  hasPhone: boolean;
}

interface UploadResult {
  resumeId: string;
  reused: boolean;
  parseIntegrity: number;
  diagnostics: Diagnostics;
  /** Null when the format does not record one — see the Pages row below. */
  pageCount: number | null;
  scannable: boolean;
  warnings: string[];
}

type RequirementStatus = 'met' | 'partial' | 'missing';

interface ScanResult {
  scanId: string;
  jobTitle: string | null;
  company: string | null;
  overallScore: number;
  subScores: {
    parseIntegrity: number;
    requirementCoverage: number;
    keywordAlignment: number;
    evidenceQuality: number;
    knockoutRisk: number;
  };
  report: {
    requirements: Array<{
      text: string;
      kind: 'must' | 'nice';
      status: RequirementStatus;
      evidenceBulletIds: string[];
      note: string | null;
    }>;
    knockouts: Array<{
      kind: string;
      severity: 'blocking' | 'likely' | 'unclear';
      note: string;
    }>;
    keywords: { missing: Array<{ term: string; jdCount: number }> };
    genuineGaps: string[];
    parseWarnings: string[];
    rewrite: Array<{
      sourceBulletId: string;
      original: string;
      rewritten: string;
      rationale: string;
    }>;
  };
  reused: boolean;
}

/** Minimum job-description length the scan endpoint accepts. */
const MIN_JD_CHARS = 80;

const SUB_SCORES: Array<{
  key: keyof ScanResult['subScores'];
  label: string;
  weight: string;
  blurb: string;
}> = [
  {
    key: 'parseIntegrity',
    label: 'Parse integrity',
    weight: '25%',
    blurb: 'Whether the file survives being read at all. Fully deterministic.',
  },
  {
    key: 'requirementCoverage',
    label: 'Requirement coverage',
    weight: '30%',
    blurb: 'Which of the job’s requirements your resume actually evidences.',
  },
  {
    key: 'keywordAlignment',
    label: 'Keyword and title alignment',
    weight: '20%',
    blurb:
      'Vocabulary overlap with the posting, weighted by how central each term is.',
  },
  {
    key: 'evidenceQuality',
    label: 'Evidence quality',
    weight: '15%',
    blurb: 'Quantified achievements versus duty statements.',
  },
  {
    key: 'knockoutRisk',
    label: 'Knockout risk',
    weight: '10%',
    blurb: '100 means nothing was found that would auto-reject you.',
  },
];

function messageForCode(code: string | undefined, fallback?: string): string {
  switch (code) {
    // The server message is preferred because it NAMES the format it identified
    // from the bytes — "application/msword files cannot be read" tells someone
    // with a legacy .doc what is actually wrong. The generic line is the fallback
    // for older responses that sent a code with no message.
    case 'unsupported_type':
      return fallback ?? 'Upload a PDF, a Word .docx, or a plain .txt file.';
    case 'file_too_large':
      return 'That file is over 5 MB. Resumes should be well under that.';
    case 'empty_file':
    case 'no_file':
      return 'That file appears to be empty.';
    case 'document_unreadable':
      return fallback ?? 'This document could not be read. Try re-exporting it.';
    case 'quota_exceeded':
      return 'You have used your allowance for today.';
    case 'analysis_busy':
      return 'Too many analyses are running right now. Try again in a moment.';
    case 'analysis_unavailable':
      return 'Analysis is temporarily unavailable. Please try again shortly.';
    case 'not_authenticated':
      return 'Your session expired. Reload the page and sign in again.';
    default:
      return fallback ?? 'Something went wrong. Please try again.';
  }
}

export function ResumeAnalyser({
  plan,
  uploadsLeft,
  scansLeft,
  upgradePrice,
}: ResumeAnalyserProps) {
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [jdText, setJdText] = useState('');
  const [busy, setBusy] = useState<'upload' | 'scan' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'duplicate'>(
    'idle'
  );
  const resultRef = useRef<HTMLDivElement>(null);

  const outOfUploads = uploadsLeft !== null && uploadsLeft <= 0;
  const outOfScans = scansLeft !== null && scansLeft <= 0;
  const jdLength = jdText.trim().length;
  const canScan = jdLength >= MIN_JD_CHARS && busy === null && !outOfScans;

  async function handleUpload(file: File) {
    setBusy('upload');
    setError(null);
    setScan(null);
    setUpload(null);
    setFileName(file.name);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/resume/upload', {
        method: 'POST',
        body: form,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(messageForCode(body?.code, body?.message));
        return;
      }
      setUpload(body as UploadResult);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  async function handleScan() {
    if (!upload || !canScan) return;
    setBusy('scan');
    setError(null);
    try {
      const res = await fetch('/api/resume/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeId: upload.resumeId, jdText: jdText.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(messageForCode(body?.code, body?.message));
        return;
      }
      setScan(body as ScanResult);
      setSaveState('idle');
      // The report appears below the fold on most screens; without this the
      // button appears to do nothing on a fast connection.
      requestAnimationFrame(() =>
        resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      );
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  async function handleSaveToTracker() {
    if (!scan || saveState === 'saving' || saveState === 'saved') return;
    setSaveState('saving');
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: scan.company ?? 'Unknown company',
          job_title: scan.jobTitle ?? 'Untitled role',
          jd_text: jdText.trim(),
          // The server re-reads the score from the scan rather than trusting this,
          // so a tampered client cannot fabricate a match.
          scan_id: scan.scanId,
          status: 'saved',
        }),
      });
      if (res.status === 409) {
        setSaveState('duplicate');
        return;
      }
      if (!res.ok) {
        setSaveState('idle');
        const body = await res.json().catch(() => null);
        setError(messageForCode(body?.code, body?.message));
        return;
      }
      setSaveState('saved');
    } catch {
      setSaveState('idle');
      setError('Could not reach the server. Check your connection and try again.');
    }
  }

  return (
    <div className="resume-flow">
      <p className="resume-allowance">
        <span>
          Plan <strong>{plan}</strong>
        </span>
        <span>
          Uploads left <strong>{uploadsLeft ?? '∞'}</strong>
        </span>
        <span>
          Scans left <strong>{scansLeft ?? '∞'}</strong>
        </span>
      </p>

      {/* ---- step 1 ---------------------------------------------------- */}
      <section className="resume-step">
        <div className="resume-step-head">
          <span className="resume-step-index" aria-hidden="true">
            01
          </span>
          <h2 className="resume-step-title">Upload your resume</h2>
        </div>
        <p className="resume-lede">
          PDF, Word .docx, or plain text. We check that it parses before scoring
          anything — no analysis is spent on a file that cannot be read.
        </p>

        <label
          className="resume-drop"
          data-busy={busy === 'upload'}
          data-disabled={outOfUploads}
        >
          <input
            type="file"
            className="resume-drop-input"
            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            disabled={busy !== null || outOfUploads}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
              // Reset so re-selecting the same file fires onChange again.
              e.target.value = '';
            }}
          />
          <span className="resume-drop-action">
            {busy === 'upload' ? 'Reading your file…' : 'Choose a file'}
          </span>
          <span className="resume-drop-hint">PDF, DOCX or TXT · up to 5 MB</span>
        </label>

        {fileName && busy !== 'upload' && (
          <p className="resume-filename">{fileName}</p>
        )}

        {outOfUploads && (
          <p className="resume-note">
            Today’s upload is used. Student Pro raises this to 20 uploads and 40
            scans a day, at {upgradePrice}.
          </p>
        )}
      </section>

      {/* ---- parse verdict --------------------------------------------- */}
      {upload && (
        <section className="resume-verdict" data-scannable={upload.scannable}>
          <div className="resume-verdict-head">
            <h2 className="resume-step-title">Parse check</h2>
            <span className="resume-verdict-state">
              {upload.scannable ? 'readable' : 'cannot be scored'}
            </span>
            <span className="resume-verdict-score">
              {upload.parseIntegrity}/100
            </span>
          </div>

          <p className="resume-lede">
            {upload.scannable ? (
              upload.warnings.length > 0 ? (
                'This file reads cleanly enough to score, but the points below are worth fixing before you send it anywhere.'
              ) : (
                'Nothing wrong detected. This file reads cleanly.'
              )
            ) : (
              <>
                <strong>We will not score this file.</strong> Every other number
                would be computed from text you never wrote. Fix the problems
                below and upload again — for most resumes this is the single
                highest-value change available.
              </>
            )}
          </p>

          {upload.warnings.length > 0 && (
            <ul className="resume-warnings">
              {upload.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          )}

          <dl className="resume-diagnostics">
            <div>
              <dt>Selectable text</dt>
              <dd data-flag={upload.diagnostics.hasTextLayer ? undefined : 'bad'}>
                {upload.diagnostics.hasTextLayer ? 'Yes' : 'No — looks scanned'}
              </dd>
            </div>
            <div>
              <dt>Layout</dt>
              <dd
                data-flag={
                  upload.diagnostics.columnLayoutSuspected ? 'bad' : undefined
                }
              >
                {upload.diagnostics.columnLayoutSuspected
                  ? 'Multi-column'
                  : 'Single column'}
              </dd>
            </div>
            <div>
              <dt>Sections found</dt>
              <dd>
                {upload.diagnostics.headingsFound.length > 0
                  ? upload.diagnostics.headingsFound.join(', ')
                  : 'None identified'}
              </dd>
            </div>
            <div>
              <dt>Dates read</dt>
              <dd>
                {upload.diagnostics.datesParsed} of {upload.diagnostics.datesFound}
              </dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd data-flag={upload.diagnostics.hasEmail ? undefined : 'bad'}>
                {upload.diagnostics.hasEmail ? 'Found' : 'Not found'}
              </dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd data-flag={upload.diagnostics.hasPhone ? undefined : 'bad'}>
                {upload.diagnostics.hasPhone ? 'Found' : 'Not found'}
              </dd>
            </div>
            <div>
              <dt>Words extracted</dt>
              <dd>{upload.diagnostics.wordCount}</dd>
            </div>
            <div>
              <dt>Pages</dt>
              {/* A .docx does not paginate itself and a .txt has no pages at all,
                  so the count is only known when the writing tool recorded it. This
                  showed a flat "1" for every DOCX, which a user with a three-page
                  resume spotted at once — and a report that is wrong about the one
                  figure the reader can check against their own file earns no trust
                  for the figures they cannot. */}
              <dd>
                {typeof upload.pageCount === 'number' ? (
                  upload.pageCount
                ) : (
                  <span title="A .docx stores no page count unless the app that saved it recorded one. Plain text has no pages.">
                    not reported
                  </span>
                )}
              </dd>
            </div>
          </dl>
        </section>
      )}

      {/* ---- step 2 ---------------------------------------------------- */}
      {upload?.scannable && (
        <section className="resume-step">
          <div className="resume-step-head">
            <span className="resume-step-index" aria-hidden="true">
              02
            </span>
            <h2 className="resume-step-title">Paste the job description</h2>
          </div>
          <p className="resume-lede">
            The whole posting, including the requirements. We compare what it asks
            for against what your resume evidences.
          </p>

          <textarea
            className="resume-jd"
            value={jdText}
            disabled={busy !== null}
            onChange={(e) => setJdText(e.target.value)}
            placeholder="Paste the full job description here…"
            aria-label="Job description"
          />

          <div className="resume-actions">
            <button
              type="button"
              className="cta cta-primary"
              disabled={!canScan}
              onClick={() => void handleScan()}
            >
              {busy === 'scan' ? 'Analysing…' : 'Check the match'}
            </button>
            <span className="resume-counter">
              {jdLength < MIN_JD_CHARS
                ? `${MIN_JD_CHARS - jdLength} more characters needed`
                : `${jdLength.toLocaleString()} characters`}
            </span>
          </div>

          {outOfScans && (
            <p className="resume-note">
              Today’s scan is used. Student Pro raises this to 40 scans a day, at{' '}
              {upgradePrice}.
            </p>
          )}
        </section>
      )}

      {error && (
        <p className="resume-error" role="alert">
          {error}
        </p>
      )}

      {/* ---- report ---------------------------------------------------- */}
      {scan && (
        <div className="resume-result" ref={resultRef}>
          <div>
            <p className="resume-label">Unviewable match score</p>
            <p className="resume-score">
              <span className="resume-score-value">{scan.overallScore}</span>
              <span className="resume-score-max">/100</span>
            </p>
          </div>

          {/* ------------------------------------------------------------------
              PRIMARY, not secondary.
              
              This is the only way a role reaches the tracker, and it used to be a
              ghost button sitting below the whole score breakdown. The result was a
              loop with no exit: /jobs is empty, its empty state sends you to
              /resume, you scan, you miss the faint button, you go back to /jobs and
              it is still empty. Measured on production — one account had three
              scans on the same day and zero tracked jobs.
              
              Nothing was broken. The save works; it just did not look like the next
              step, so nobody took it. The hint below says out loud what the button
              is for, because "Save to tracker" does not explain that the tracker is
              otherwise empty by definition.
              ------------------------------------------------------------------ */}
          <div className="resume-actions">
            <button
              type="button"
              className="cta cta-primary"
              disabled={saveState === 'saving' || saveState === 'saved'}
              onClick={() => void handleSaveToTracker()}
            >
              {saveState === 'saved'
                ? 'Saved to tracker'
                : saveState === 'saving'
                  ? 'Saving\u2026'
                  : 'Save to tracker'}
            </button>

            {saveState === 'saved' || saveState === 'duplicate' ? (
              <Link className="cta cta-secondary" href="/jobs">
                View tracker
              </Link>
            ) : null}

            {saveState === 'duplicate' && (
              <span className="resume-counter">Already in your tracker</span>
            )}
          </div>

          {saveState === 'idle' && (
            <p className="resume-counter">
              Keeps this role and its score in your{' '}
              <Link href="/jobs">tracker</Link>. Scanning alone does not add it.
            </p>
          )}

          <p className="resume-score-honesty">
            This is our score, not the employer’s. No applicant tracking system
            publishes a score to candidates. It measures how well your resume
            evidences <em>this</em> job’s requirements, and whether it parses
            cleanly.
          </p>

          <ul className="resume-subscores">
            {SUB_SCORES.map(({ key, label, weight, blurb }) => (
              <li key={key} className="resume-subscore">
                <div className="resume-subscore-head">
                  <span className="resume-subscore-label">{label}</span>
                  <span className="resume-subscore-weight">{weight}</span>
                  <span className="resume-subscore-value">
                    {scan.subScores[key]}
                  </span>
                </div>
                <span
                  className="resume-bar"
                  role="img"
                  aria-label={`${label}: ${scan.subScores[key]} out of 100`}
                >
                  <span style={{ width: `${scan.subScores[key]}%` }} />
                </span>
                <p className="resume-subscore-blurb">{blurb}</p>
              </li>
            ))}
          </ul>

          {scan.report.knockouts.length > 0 && (
            <section className="resume-block">
              <h3>What can auto-reject you</h3>
              <p className="resume-lede">
                These are application-form questions, not resume wording. They are
                the only part of an application that rejects you without a human
                involved.
              </p>
              <ul className="resume-rows">
                {scan.report.knockouts.map((k, i) => (
                  <li key={i} className="resume-row" data-state={k.severity}>
                    <span className="resume-row-state">{k.severity}</span>
                    <div className="resume-row-body">
                      <p className="resume-row-text">{k.note}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="resume-block">
            <h3>Requirement by requirement</h3>
            <ul className="resume-rows">
              {scan.report.requirements.map((r, i) => (
                <li key={i} className="resume-row" data-state={r.status}>
                  <span className="resume-row-state">{r.status}</span>
                  <div className="resume-row-body">
                    <p className="resume-row-text">
                      {r.text}
                      {r.kind === 'nice' && (
                        <span className="resume-row-kind"> · preferred</span>
                      )}
                    </p>
                    {r.note && <p className="resume-row-note">{r.note}</p>}
                    {r.evidenceBulletIds.length > 0 && (
                      <p className="resume-row-evidence">
                        Evidenced by {r.evidenceBulletIds.length} bullet
                        {r.evidenceBulletIds.length === 1 ? '' : 's'}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {scan.report.rewrite.length > 0 && (
            <section className="resume-block">
              <h3>Stronger wording</h3>
              {/* The guarantee is worth stating plainly, because it is the thing
                  that separates this from a tool that quietly invents metrics. */}
              <p className="resume-lede">
                Rephrased from what your resume already says. Nothing here adds a
                number, a technology, or an outcome you did not already claim — any
                suggestion that did was discarded before you saw it.
              </p>
              <ul className="resume-diffs">
                {scan.report.rewrite.map((r) => (
                  <li key={r.sourceBulletId} className="resume-diff">
                    <p className="resume-diff-line" data-side="before">
                      <span className="resume-diff-tag">before</span>
                      <span>{r.original}</span>
                    </p>
                    <p className="resume-diff-line" data-side="after">
                      <span className="resume-diff-tag">after</span>
                      <span>{r.rewritten}</span>
                    </p>
                    <p className="resume-diff-why">{r.rationale}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {scan.report.genuineGaps.length > 0 && (
            <section className="resume-block">
              <h3>Genuinely missing</h3>
              {/* Deliberately separate from any wording advice. The honest answer
                  to a missing skill is to acquire it, not to reword the resume
                  until it implies otherwise. */}
              <p className="resume-lede">
                Required things your resume does not evidence. The answer to these
                is to learn them, not to rephrase around them.
              </p>
              <ul className="resume-rows">
                {scan.report.genuineGaps.map((gap, i) => (
                  <li key={i} className="resume-row" data-state="missing">
                    <span className="resume-row-state">build</span>
                    <div className="resume-row-body">
                      <p className="resume-row-text">{gap}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {scan.report.keywords.missing.length > 0 && (
            <section className="resume-block">
              <h3>Terms the posting uses that yours does not</h3>
              <p className="resume-lede">
                Ordered by how often the posting mentions them. Only add a term if
                it is genuinely true of you.
              </p>
              <ul className="resume-keywords">
                {scan.report.keywords.missing.slice(0, 14).map((k) => (
                  <li key={k.term}>
                    {k.term}
                    <span className="resume-keyword-count">×{k.jdCount}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
