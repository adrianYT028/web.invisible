'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * `<PrepFlow />` — start a run, watch it, review the results.
 *
 * The loop is: POST /api/prep to create the run, then alternate POST
 * /api/prep/[id] (do work) with GET /api/prep/[id] (read progress) until the run
 * finishes. Two calls rather than one because a tick takes tens of seconds, and
 * progress must keep updating while it runs.
 *
 * The pace is set by the provider's per-minute token allowance, not by us: roughly
 * three jobs a minute across the whole platform. So the UI shows a real count and
 * an honest wait rather than a spinner that implies it is nearly done.
 */

interface PrepItem {
  id: string;
  status: 'queued' | 'running' | 'done' | 'skipped' | 'failed';
  error: string | null;
  matchScore: number | null;
  scanId: string | null;
  job: {
    id: string | null;
    title: string | null;
    company: string | null;
    location: string | null;
    isRemote: boolean;
    url: string | null;
  };
  email: {
    subject: string;
    body: string;
    to: string | null;
    guidance: string | null;
    gmailUrl: string | null;
    mailtoUrl: string | null;
  } | null;
}

interface RunState {
  run: {
    id: string;
    status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
    requested: number;
    done: number;
    failed: number;
    skipped: number;
    queued: number;
  };
  items: PrepItem[];
}

const COUNTS = [3, 5, 10];

function messageForCode(code: string | undefined): string {
  switch (code) {
    case 'no_resume':
      return 'Upload a resume first — the run needs your profile to match against.';
    case 'parse_quality_too_low':
      return 'Your resume did not parse cleanly enough to score. Fix the file problems at /resume first.';
    case 'no_postings':
      return 'No matching roles in the index yet. Try turning off the India filter.';
    case 'quota_exceeded':
      return 'Not enough scans left today for a run this size.';
    default:
      return 'Something went wrong starting the run.';
  }
}

/** Canonical UUID shape, so a hand-edited `?run=` is rejected before it is sent. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Record (or clear) the current run in the address bar.
 *
 * `history.replaceState` rather than the Next router: this is a bookmark for the
 * work already on screen, not a navigation. Pushing an entry would make the back
 * button walk through every run the user started, and a router navigation would
 * re-render the page and restart the tick loop.
 *
 * REPLACE, not push, for the same reason — the run id is a correction to the
 * current URL, and one run should not leave a history entry behind it.
 */
function rememberRun(runId: string | null): void {
  const url = new URL(window.location.href);
  if (runId) url.searchParams.set('run', runId);
  else url.searchParams.delete('run');
  window.history.replaceState(null, '', url);
}

export function PrepFlow() {
  const [count, setCount] = useState(5);
  const [indiaOnly, setIndiaOnly] = useState(true);
  const [runId, setRunId] = useState<string | null>(null);
  const [state, setState] = useState<RunState | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitingUntil, setWaitingUntil] = useState<number | null>(null);
  // Guards against two tick loops running if a re-render restarts the effect.
  const ticking = useRef(false);

  // Restore the run named in the URL.
  //
  // `runId` used to live only in component state, so a reload or a tab close lost
  // the finished run permanently — the results were still in the database and
  // nothing in the product could reach them again. That was survivable while the
  // page was the only way to read a run; it stopped being survivable once there
  // was a file to download, because the moment someone wants the file is after
  // they have closed the tab to go and apply.
  //
  // Restoring a FINISHED run is safe and spends nothing: the tick loop below
  // refreshes first and breaks on a done/failed status before it ever POSTs.
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get('run');
    // Shape-checked before it reaches the API. A bad id would 404 harmlessly, but
    // there is no reason to send an obviously invalid one.
    if (param && UUID.test(param)) setRunId(param);
    // Mount only: this seeds initial state and must not fight later changes.
  }, []);

  const refresh = useCallback(async (id: string) => {
    const res = await fetch(`/api/prep/${id}`);
    if (!res.ok) return null;
    const body = (await res.json()) as RunState;
    setState(body);
    return body;
  }, []);

  async function start() {
    setStarting(true);
    setError(null);
    setState(null);
    setRunId(null);
    try {
      const res = await fetch('/api/prep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, indiaOnly }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.message ?? messageForCode(body?.code));
        return;
      }
      setRunId(body.runId as string);
      rememberRun(body.runId as string);
      await refresh(body.runId as string);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setStarting(false);
    }
  }

  // Drive the run to completion.
  useEffect(() => {
    if (!runId || ticking.current) return;
    let cancelled = false;
    ticking.current = true;

    (async () => {
      for (;;) {
        if (cancelled) break;
        const snapshot = await refresh(runId);
        if (!snapshot) break;
        if (snapshot.run.status === 'done' || snapshot.run.status === 'failed') break;

        const res = await fetch(`/api/prep/${runId}`, { method: 'POST' });
        if (!res.ok) break;
        const tick = (await res.json()) as {
          remaining: number;
          runStatus: string;
          retryAfterSeconds: number | null;
        };

        if (tick.runStatus === 'done' || tick.remaining === 0) {
          await refresh(runId);
          break;
        }

        // Rate limited: show a real countdown instead of pretending to work.
        if (tick.retryAfterSeconds) {
          const until = Date.now() + tick.retryAfterSeconds * 1000;
          setWaitingUntil(until);
          await new Promise((r) => setTimeout(r, tick.retryAfterSeconds! * 1000));
          setWaitingUntil(null);
        }
      }
      ticking.current = false;
    })();

    return () => {
      cancelled = true;
      ticking.current = false;
    };
  }, [runId, refresh]);

  const run = state?.run;
  const active = run?.status === 'queued' || run?.status === 'running';
  const ready = (state?.items ?? []).filter((i) => i.status === 'done');

  return (
    <div className="resume-flow">
      {/* ---- start ------------------------------------------------------- */}
      {!runId && (
        <section className="resume-step">
          <div className="resume-step-head">
            <span className="resume-step-index" aria-hidden="true">
              01
            </span>
            <h2 className="resume-step-title">How many roles?</h2>
          </div>
          <p className="resume-lede">
            For each one we read the job description, score it against your resume,
            tailor your weakest bullets toward it, and draft an email. You review
            and send — nothing is applied or emailed for you.
          </p>

          <div className="resume-actions">
            {COUNTS.map((n) => (
              <label key={n} className="resume-toggle">
                <input
                  type="radio"
                  name="count"
                  checked={count === n}
                  onChange={() => setCount(n)}
                />
                <span>{n} roles</span>
              </label>
            ))}
            <label className="resume-toggle">
              <input
                type="checkbox"
                checked={indiaOnly}
                onChange={(e) => setIndiaOnly(e.target.checked)}
              />
              <span>India + remote only</span>
            </label>
          </div>

          <div className="resume-actions">
            <button
              type="button"
              className="cta cta-primary"
              disabled={starting}
              onClick={() => void start()}
            >
              {starting ? 'Starting…' : `Prepare ${count} roles`}
            </button>
            <span className="resume-counter">
              about {Math.ceil((count * 20) / 60)}–{Math.ceil((count * 30) / 60)} min
            </span>
          </div>

          {error && (
            <p className="resume-error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}

      {/* ---- progress ---------------------------------------------------- */}
      {run && (
        <section className="resume-step">
          <div className="resume-verdict-head">
            <h2 className="resume-step-title">
              {active ? 'Preparing your applications' : 'Ready to send'}
            </h2>
            <span className="resume-verdict-score">
              {run.done}/{run.requested}
            </span>
          </div>

          <span className="resume-bar" role="img" aria-label={`${run.done} of ${run.requested} prepared`}>
            <span style={{ width: `${(run.done / Math.max(run.requested, 1)) * 100}%` }} />
          </span>

          {active && (
            <p className="resume-note">
              {waitingUntil
                ? 'Provider rate limit reached — waiting for the next window. This is normal and the run resumes automatically.'
                : 'Working through them a couple at a time. You can leave this page open.'}
            </p>
          )}

          {(run.failed > 0 || run.skipped > 0) && (
            <p className="resume-note">
              {run.skipped > 0 && `${run.skipped} skipped (no job description). `}
              {run.failed > 0 && `${run.failed} failed. `}
              The rest are below.
            </p>
          )}
        </section>
      )}

      {/* ---- results ----------------------------------------------------- */}
      {ready.length > 0 && (
        <ul className="resume-rows">
          {ready.map((item) => (
            <li key={item.id} className="resume-prep">
              <div className="resume-verdict-head">
                <div className="resume-job-main">
                  <p className="resume-job-title">
                    {item.job.url ? (
                      <a href={item.job.url} target="_blank" rel="noopener noreferrer">
                        {item.job.title}
                      </a>
                    ) : (
                      item.job.title
                    )}
                  </p>
                  <p className="resume-job-meta">
                    {item.job.company}
                    {item.job.location ? ` · ${item.job.location}` : ''}
                    {item.job.isRemote ? ' · Remote' : ''}
                  </p>
                </div>
                <div className="resume-job-score">
                  <span className="resume-job-score-value">{item.matchScore}</span>
                  <span className="resume-job-score-max">/100</span>
                </div>
              </div>

              {item.email ? (
                <div className="resume-prep-mail">
                  <p className="resume-label">
                    {item.email.to ? `Email to ${item.email.to}` : 'Draft email'}
                  </p>
                  <p className="resume-prep-subject">{item.email.subject}</p>
                  <pre className="resume-prep-body">{item.email.body}</pre>

                  {item.email.guidance && (
                    <p className="resume-note">{item.email.guidance}</p>
                  )}

                  <div className="resume-actions">
                    {item.email.gmailUrl && (
                      <a
                        className="cta cta-primary"
                        href={item.email.gmailUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open in Gmail
                      </a>
                    )}
                    <button
                      type="button"
                      className="cta cta-secondary"
                      onClick={() =>
                        void navigator.clipboard.writeText(
                          `${item.email!.subject}\n\n${item.email!.body}`
                        )
                      }
                    >
                      Copy
                    </button>
                    {item.job.url && (
                      <a
                        className="cta cta-secondary"
                        href={item.job.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Apply
                      </a>
                    )}
                  </div>
                </div>
              ) : (
                <p className="resume-note">
                  No email drafted for this one. Apply through the form.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {run && !active && (
        <section className="resume-step">
          <p className="resume-lede">
            Full reports for each of these are on <Link href="/jobs">your tracker</Link>.
          </p>
          <div className="resume-actions">
            {/*
              A plain anchor, not next/link: a client-side transition cannot honour
              `Content-Disposition`, so the CSV would render as text in the tab
              instead of downloading. Same reason as the tracker's Export CSV.

              Offered once the run is finished rather than while it is working. The
              route happily exports a partial run, but a file downloaded mid-run is
              a stale shortlist someone then applies from.
            */}
            <a
              className="cta cta-secondary"
              href={`/api/prep/${runId}/export`}
              download
            >
              Download as CSV
            </a>
            <button
              type="button"
              className="cta cta-secondary"
              onClick={() => {
                setRunId(null);
                setState(null);
                rememberRun(null);
              }}
            >
              Start another run
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
