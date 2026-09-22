'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

/**
 * `<DiscoverClient />` — browse the job index, ranked against the stored profile.
 *
 * Filters drive a refetch rather than client-side filtering, because the server
 * ranks against the profile and holds far more postings than are sent down.
 *
 * The relevance figure is labelled "skills matched", never as a score. It reads
 * only a description, so presenting it as a number next to the Match Score would
 * invite a comparison it cannot survive.
 */

interface DiscoverJob {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  isRemote: boolean;
  isIndia: boolean;
  url: string;
  postedAt: string | null;
  relevance: number | null;
  matchedSkills: string[];
  unscored: boolean;
  earlyCareer: boolean;
}

interface DiscoverResponse {
  hasProfile: boolean;
  total: number;
  jobs: DiscoverJob[];
}

export function DiscoverClient() {
  const [india, setIndia] = useState(true);
  const [remote, setRemote] = useState(true);
  const [early, setEarly] = useState(false);
  const [data, setData] = useState<DiscoverResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (india) q.set('india', '1');
      if (remote) q.set('remote', '1');
      if (early) q.set('early', '1');
      const res = await fetch(`/api/jobs/discover?${q}`);
      if (!res.ok) throw new Error('failed');
      setData((await res.json()) as DiscoverResponse);
    } catch {
      setError('Could not load jobs. Try again.');
    } finally {
      setBusy(false);
    }
  }, [india, remote, early]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(job: DiscoverJob) {
    // Optimistic: the button is the only affordance on the row, so it has to
    // respond immediately.
    setSaved((s) => new Set(s).add(job.id));
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: job.company ?? 'Unknown company',
          job_title: job.title,
          location: job.location,
          is_remote: job.isRemote,
          url: job.url,
          status: 'saved',
        }),
      });
      // 409 means it is already tracked, which is the same end state the user
      // wanted — so it stays marked saved rather than reverting.
      if (!res.ok && res.status !== 409) throw new Error('failed');
    } catch {
      setSaved((s) => {
        const next = new Set(s);
        next.delete(job.id);
        return next;
      });
      setError('Could not save that job. Try again.');
    }
  }

  return (
    <div className="resume-flow">
      <div className="resume-actions">
        <label className="resume-toggle">
          <input
            type="checkbox"
            checked={india}
            onChange={(e) => setIndia(e.target.checked)}
          />
          <span>India</span>
        </label>
        <label className="resume-toggle">
          <input
            type="checkbox"
            checked={remote}
            onChange={(e) => setRemote(e.target.checked)}
          />
          <span>Include remote</span>
        </label>
        <label className="resume-toggle">
          <input
            type="checkbox"
            checked={early}
            onChange={(e) => setEarly(e.target.checked)}
          />
          <span>Early career only</span>
        </label>
        {data && (
          <span className="resume-counter">
            {data.total} open {data.total === 1 ? 'role' : 'roles'}
          </span>
        )}
      </div>

      {data && !data.hasProfile && (
        <p className="resume-note">
          Upload a resume at <Link href="/resume">/resume</Link> and these roles
          get ordered by how well they match your skills. Until then they are
          newest first.
        </p>
      )}

      {error && (
        <p className="resume-error" role="alert">
          {error}
        </p>
      )}

      {busy && <p className="resume-note">Loading roles…</p>}

      {!busy && data && data.jobs.length === 0 && (
        <section className="resume-step">
          <h2 className="resume-step-title">No roles match those filters</h2>
          <p className="resume-lede">
            Try turning off <strong>Early career only</strong>, or widen beyond
            India. The index is also still small — it grows as more company boards
            are added.
          </p>
        </section>
      )}

      {!busy && data && data.jobs.length > 0 && (
        <ul className="resume-rows">
          {data.jobs.map((job) => (
            <li key={job.id} className="resume-job">
              <div className="resume-job-main">
                <p className="resume-job-title">
                  <a href={job.url} target="_blank" rel="noopener noreferrer">
                    {job.title}
                  </a>
                </p>
                <p className="resume-job-meta">
                  {job.company ?? 'Unknown company'}
                  {job.location ? ` · ${job.location}` : ''}
                  {job.isRemote ? ' · Remote' : ''}
                  {job.earlyCareer ? ' · Early career' : ''}
                </p>
                {job.matchedSkills.length > 0 && (
                  <p className="resume-job-meta">
                    Matches your {job.matchedSkills.slice(0, 6).join(', ')}
                  </p>
                )}
              </div>

              <div className="resume-job-score">
                {job.unscored || job.relevance === null ? (
                  <span className="resume-job-score-none">no description</span>
                ) : (
                  <span className="resume-job-score-none">
                    {job.matchedSkills.length} skill
                    {job.matchedSkills.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>

              <div className="resume-job-controls">
                <button
                  type="button"
                  className="cta cta-secondary"
                  disabled={saved.has(job.id)}
                  onClick={() => void save(job)}
                >
                  {saved.has(job.id) ? 'Saved' : 'Save'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
