'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

/**
 * `<JobTracker />` — the application pipeline.
 *
 * Stage changes are OPTIMISTIC: the row moves as soon as the dropdown changes, and
 * reverts if the request fails. A tracker is a bookkeeping tool people update in
 * bursts, and a spinner per change makes that feel like filing paperwork.
 *
 * Visual language matches /resume — transparent rows separated by hairline rules,
 * mono micro-labels, colour only from --signal / --error. See the note above the
 * .resume-* rules in globals.css.
 */

export interface TrackedJob {
  id: string;
  source: string;
  company: string;
  job_title: string;
  location: string | null;
  is_remote: boolean;
  url: string | null;
  status: JobStatus;
  scan_id: string | null;
  match_score: number | null;
  notes: string | null;
  applied_at: string | null;
  created_at: string;
}

type JobStatus =
  | 'saved'
  | 'applied'
  | 'interviewing'
  | 'offer'
  | 'rejected'
  | 'archived';

/** Pipeline order, and the label shown for each stage. */
const STAGES: Array<{ value: JobStatus; label: string }> = [
  { value: 'saved', label: 'Saved' },
  { value: 'applied', label: 'Applied' },
  { value: 'interviewing', label: 'Interviewing' },
  { value: 'offer', label: 'Offer' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'archived', label: 'Archived' },
];

/** Stages that count as live pipeline for the summary counts. */
const ACTIVE: ReadonlySet<JobStatus> = new Set([
  'applied',
  'interviewing',
  'offer',
]);

export function JobTracker({ initialJobs }: { initialJobs: TrackedJob[] }) {
  const [jobs, setJobs] = useState<TrackedJob[]>(initialJobs);
  const [filter, setFilter] = useState<JobStatus | 'all'>('all');
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => {
    let active = 0;
    let saved = 0;
    let scored = 0;
    let scoreTotal = 0;
    for (const j of jobs) {
      if (ACTIVE.has(j.status)) active++;
      if (j.status === 'saved') saved++;
      if (typeof j.match_score === 'number') {
        scored++;
        scoreTotal += j.match_score;
      }
    }
    return {
      total: jobs.length,
      active,
      saved,
      // Only meaningful across scanned jobs; an unscanned job is not a zero.
      averageScore: scored > 0 ? Math.round(scoreTotal / scored) : null,
    };
  }, [jobs]);

  const visible = useMemo(
    () => (filter === 'all' ? jobs : jobs.filter((j) => j.status === filter)),
    [jobs, filter]
  );

  async function changeStage(id: string, status: JobStatus) {
    const previous = jobs;
    // Optimistic — see the component note.
    setJobs((current) =>
      current.map((j) => (j.id === id ? { ...j, status } : j))
    );
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error('failed');
      // The server owns `applied_at`, which moves with the stage, so the
      // authoritative row replaces the optimistic guess.
      const body = (await res.json()) as { job: TrackedJob };
      setJobs((current) => current.map((j) => (j.id === id ? body.job : j)));
    } catch {
      setJobs(previous);
      setError('That change did not save. Check your connection and try again.');
    }
  }

  async function remove(id: string) {
    const previous = jobs;
    setJobs((current) => current.filter((j) => j.id !== id));
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('failed');
    } catch {
      setJobs(previous);
      setError('That job could not be removed. Try again.');
    }
  }

  if (jobs.length === 0) {
    return (
      <div className="resume-flow">
        <section className="resume-step">
          <h2 className="resume-step-title">Nothing tracked yet</h2>
          <p className="resume-lede">
            Scan a resume against a job description and choose{' '}
            <strong>Save to tracker</strong>. The role lands here with its match
            score attached, so you can see at a glance which applications are worth
            your time.
          </p>
          <div className="resume-actions">
            <Link className="cta cta-primary" href="/resume">
              Scan a resume
            </Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="resume-flow">
      <p className="resume-allowance">
        <span>
          Tracked <strong>{counts.total}</strong>
        </span>
        <span>
          In play <strong>{counts.active}</strong>
        </span>
        <span>
          Not yet applied <strong>{counts.saved}</strong>
        </span>
        <span>
          Average match <strong>{counts.averageScore ?? '—'}</strong>
        </span>
      </p>

      <section className="resume-step">
        <div className="resume-actions">
          <label className="resume-filter">
            <span className="resume-filter-label">Stage</span>
            <span className="resume-select-wrap">
            <select
              className="resume-select"
              value={filter}
              onChange={(e) => setFilter(e.target.value as JobStatus | 'all')}
            >
              <option value="all">All ({jobs.length})</option>
              {STAGES.map((s) => {
                const n = jobs.filter((j) => j.status === s.value).length;
                return (
                  <option key={s.value} value={s.value} disabled={n === 0}>
                    {s.label} ({n})
                  </option>
                );
              })}
            </select>
            </span>
          </label>

          {/*
            A plain anchor, deliberately NOT next/link. This is a FILE DOWNLOAD, not
            a navigation: `Link` would perform a client-side transition, which
            cannot honour Content-Disposition, so the CSV would never be saved.
            Letting the browser handle it also avoids holding the whole file in
            memory as a blob.
          */}
          <a className="cta cta-secondary" href="/api/jobs/export" download>
            Export CSV
          </a>
        </div>

        {error && (
          <p className="resume-error" role="alert">
            {error}
          </p>
        )}

        <ul className="resume-rows">
          {visible.map((job) => (
            <li key={job.id} className="resume-job" data-state={job.status}>
              <div className="resume-job-main">
                <p className="resume-job-title">
                  {job.url ? (
                    <a href={job.url} target="_blank" rel="noopener noreferrer">
                      {job.job_title}
                    </a>
                  ) : (
                    job.job_title
                  )}
                </p>
                <p className="resume-job-meta">
                  {job.company}
                  {job.location ? ` · ${job.location}` : ''}
                  {job.is_remote ? ' · Remote' : ''}
                  {job.source !== 'manual' ? ` · ${job.source}` : ''}
                </p>
                {job.applied_at && (
                  <p className="resume-job-meta">
                    Applied {job.applied_at.slice(0, 10)}
                  </p>
                )}
              </div>

              <div className="resume-job-score">
                {typeof job.match_score === 'number' ? (
                  <>
                    <span className="resume-job-score-value">
                      {job.match_score}
                    </span>
                    <span className="resume-job-score-max">/100</span>
                  </>
                ) : (
                  <span className="resume-job-score-none">not scanned</span>
                )}
              </div>

              <div className="resume-job-controls">
                <span className="resume-select-wrap">
                <select
                  className="resume-select"
                  value={job.status}
                  aria-label={`Stage for ${job.job_title} at ${job.company}`}
                  onChange={(e) =>
                    void changeStage(job.id, e.target.value as JobStatus)
                  }
                >
                  {STAGES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                </span>
                <button
                  type="button"
                  className="resume-job-remove"
                  aria-label={`Remove ${job.job_title} at ${job.company}`}
                  onClick={() => void remove(job.id)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
