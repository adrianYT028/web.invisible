'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

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
  /** 'YYYY-MM-DD' — when to follow up. Set automatically a week after "Applied". */
  follow_up_at: string | null;
  applied_at: string | null;
  created_at: string;
}

/** Today's date as 'YYYY-MM-DD' in the user's own timezone. */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function inDaysLocal(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Human "Follow up today / in 3 days / 2 days overdue". */
function followUpLabel(date: string): { text: string; due: boolean } {
  const today = todayLocal();
  const days = Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
  if (days === 0) return { text: 'Follow up today', due: true };
  if (days < 0) return { text: `Follow up (${-days} day${days === -1 ? '' : 's'} overdue)`, due: true };
  if (days === 1) return { text: 'Follow up tomorrow', due: false };
  return { text: `Follow up on ${date}`, due: false };
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
  /** The one row whose details panel is open. One at a time keeps the list calm. */
  const [openId, setOpenId] = useState<string | null>(null);

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

  /** Save notes or a follow-up date. Not optimistic: the field shows "Saving…". */
  async function saveFields(
    id: string,
    fields: { notes?: string; follow_up_at?: string | null }
  ): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? 'That change did not save. Try again.');
      }
      const body = (await res.json()) as { job: TrackedJob };
      setJobs((current) => current.map((j) => (j.id === id ? body.job : j)));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That change did not save. Try again.');
      return false;
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
            Save jobs from <strong>Job openings</strong>, from a resume check, or
            from any job site with the browser extension. Each job shows its stage,
            match score, notes and a follow-up reminder.
          </p>
          <div className="resume-actions">
            <Link className="cta cta-primary" href="/jobs/discover">
              Browse job openings
            </Link>
            <Link className="cta cta-secondary" href="/resume">
              Check my resume
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
                {(job.applied_at || job.follow_up_at) && (
                  <p className="resume-job-meta">
                    {job.applied_at ? `Applied ${job.applied_at.slice(0, 10)}` : ''}
                    {job.applied_at && job.follow_up_at ? ' · ' : ''}
                    {job.follow_up_at ? (
                      <span className={followUpLabel(job.follow_up_at).due ? 'tracker-due' : undefined}>
                        {followUpLabel(job.follow_up_at).text}
                      </span>
                    ) : null}
                  </p>
                )}
                {job.notes && openId !== job.id ? (
                  <p className="resume-job-meta">Note: {job.notes.length > 90 ? `${job.notes.slice(0, 90)}…` : job.notes}</p>
                ) : null}
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
                  aria-expanded={openId === job.id}
                  aria-controls={`job-details-${job.id}`}
                  onClick={() => setOpenId(openId === job.id ? null : job.id)}
                >
                  {openId === job.id ? 'Close' : 'Details'}
                </button>
                <button
                  type="button"
                  className="resume-job-remove"
                  aria-label={`Remove ${job.job_title} at ${job.company}`}
                  onClick={() => void remove(job.id)}
                >
                  Remove
                </button>
              </div>

              {openId === job.id ? (
                <JobDetails job={job} onSave={(fields) => saveFields(job.id, fields)} />
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * The per-row details panel: follow-up date, notes, and the job description that
 * was saved with the job (fetched when the panel opens, since descriptions are
 * long and most rows are never opened).
 */
function JobDetails({
  job,
  onSave,
}: {
  job: TrackedJob;
  onSave: (fields: { notes?: string; follow_up_at?: string | null }) => Promise<boolean>;
}) {
  const [notes, setNotes] = useState(job.notes ?? '');
  const [savingNotes, setSavingNotes] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [jd, setJd] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${job.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { job?: { jd_text?: string | null } } | null) => {
        if (!cancelled) setJd(body?.job?.jd_text ?? null);
      })
      .catch(() => {
        if (!cancelled) setJd(null);
      });
    return () => {
      cancelled = true;
    };
  }, [job.id]);

  async function saveNotes() {
    setSavingNotes('saving');
    const ok = await onSave({ notes });
    setSavingNotes(ok ? 'saved' : 'idle');
  }

  const fieldId = `job-details-${job.id}`;

  return (
    <div className="tracker-details" id={fieldId}>
      <div className="tracker-field">
        <label className="resume-label" htmlFor={`${fieldId}-follow`}>
          Follow up on
        </label>
        <div className="tracker-inline">
          <input
            id={`${fieldId}-follow`}
            type="date"
            className="tracker-date"
            value={job.follow_up_at ?? ''}
            min={todayLocal()}
            onChange={(e) => void onSave({ follow_up_at: e.target.value || null })}
          />
          <button
            type="button"
            className="resume-job-remove"
            onClick={() => void onSave({ follow_up_at: inDaysLocal(7) })}
          >
            In 7 days
          </button>
          {job.follow_up_at ? (
            <button
              type="button"
              className="resume-job-remove"
              onClick={() => void onSave({ follow_up_at: null })}
            >
              No reminder
            </button>
          ) : null}
        </div>
        <p className="resume-note">
          We email you on this date so you remember to check in with the recruiter.
        </p>
      </div>

      <div className="tracker-field">
        <label className="resume-label" htmlFor={`${fieldId}-notes`}>
          Notes
        </label>
        <textarea
          id={`${fieldId}-notes`}
          className="resume-jd tracker-notes"
          value={notes}
          maxLength={4000}
          placeholder="Recruiter name, referral, interview dates, salary…"
          onChange={(e) => {
            setNotes(e.target.value);
            setSavingNotes('idle');
          }}
        />
        <div className="tracker-inline">
          <button
            type="button"
            className="cta cta-secondary"
            disabled={savingNotes === 'saving' || notes === (job.notes ?? '')}
            onClick={() => void saveNotes()}
          >
            {savingNotes === 'saving' ? 'Saving…' : 'Save notes'}
          </button>
          {savingNotes === 'saved' ? <span className="resume-note">Saved.</span> : null}
        </div>
      </div>

      <div className="tracker-field">
        <span className="resume-label">Saved job description</span>
        {jd === undefined ? (
          <p className="resume-note">Loading…</p>
        ) : jd ? (
          <p className="tracker-jd">{jd}</p>
        ) : (
          <p className="resume-note">No description was saved with this job.</p>
        )}
      </div>
    </div>
  );
}
