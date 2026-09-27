'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

/**
 * `<InterviewPractice />` — three simple steps:
 *   1. Pick a job from your tracker, or type a role.
 *   2. Answer one question at a time, typing or speaking.
 *   3. Get feedback after each answer, then move on.
 *
 * Speaking uses the browser's own speech-to-text (Chrome and Edge), so no audio
 * ever leaves the browser. Where it is not supported the button is hidden and
 * typing works as normal.
 */

interface TrackerJob {
  id: string;
  job_title: string;
  company: string;
}

interface Question {
  id: string;
  kind: 'about_you' | 'behavioural' | 'role' | 'technical';
  question: string;
  tip: string;
}

interface Session {
  sessionId: string;
  role: string;
  company: string | null;
  questions: Question[];
}

interface Feedback {
  score: number;
  strengths: string[];
  improve: string[];
  betterAnswer: string;
}

const KIND_LABEL: Record<Question['kind'], string> = {
  about_you: 'About you',
  behavioural: 'Behavioural',
  role: 'About the role',
  technical: 'Technical',
};

const SCORE_LABEL = ['', 'Needs a lot of work', 'Getting there', 'Good start', 'Strong', 'Excellent'];

// Minimal typing for the Web Speech API, which is not in the DOM lib.
interface SpeechResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
  resultIndex: number;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

function speechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function InterviewPractice({
  jobs,
  remaining,
  hasResume,
}: {
  jobs: TrackerJob[];
  remaining: number | null;
  hasResume: boolean;
}) {
  const [jobId, setJobId] = useState(jobs[0]?.id ?? '');
  const [role, setRole] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [busy, setBusy] = useState<'start' | 'feedback' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setCanSpeak(speechRecognition() !== null);
    return () => recognitionRef.current?.stop();
  }, []);

  const useTracker = jobs.length > 0 && jobId !== '';

  async function start() {
    setBusy('start');
    setError(null);
    try {
      const res = await fetch('/api/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(useTracker ? { jobId } : { role: role.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.message ?? 'That did not work. Try again.');
        return;
      }
      setSession(body as Session);
      setIndex(0);
      setAnswer('');
      setFeedback({});
    } catch {
      setError('Could not reach Unviewable. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  async function getFeedback() {
    if (!session) return;
    const question = session.questions[index];
    setBusy('feedback');
    setError(null);
    recognitionRef.current?.stop();
    try {
      const res = await fetch('/api/interview/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, questionId: question.id, answer }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.message ?? 'That did not work. Try again.');
        return;
      }
      setFeedback((f) => ({ ...f, [question.id]: body.feedback as Feedback }));
    } catch {
      setError('Could not reach Unviewable. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  function toggleSpeaking() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Recognition = speechRecognition();
    if (!Recognition) return;
    const rec = new Recognition();
    rec.lang = 'en-IN';
    rec.continuous = true;
    rec.interimResults = false;
    const before = answer.trim();
    let spoken = '';
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        if (e.results[i].isFinal) spoken += `${e.results[i][0].transcript.trim()} `;
      }
      setAnswer(`${before}${before ? ' ' : ''}${spoken}`.trimEnd());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => {
      setListening(false);
      setError('Your microphone is not available. Check browser permissions, or type your answer.');
    };
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }

  function next() {
    setIndex((i) => i + 1);
    setAnswer('');
    setError(null);
  }

  // --- step 1: choose what to practise for ---------------------------------
  if (!session) {
    return (
      <div className="resume-flow">
        <section className="resume-step">
          <div className="resume-step-head">
            <span className="resume-step-index" aria-hidden="true">01</span>
            <h2 className="resume-step-title">What are you preparing for?</h2>
          </div>

          {jobs.length > 0 ? (
            <>
              <label className="resume-label" htmlFor="iv-job">
                A job from your tracker
              </label>
              <span className="resume-select-wrap">
                <select
                  id="iv-job"
                  className="resume-select"
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                >
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.job_title} at {j.company}
                    </option>
                  ))}
                  <option value="">Something else (type it below)</option>
                </select>
              </span>
            </>
          ) : null}

          {!useTracker ? (
            <>
              <label className="resume-label" htmlFor="iv-role">
                The role
              </label>
              <input
                id="iv-role"
                className="account-input"
                value={role}
                maxLength={120}
                placeholder="e.g. Data Analyst intern, Java developer"
                onChange={(e) => setRole(e.target.value)}
              />
            </>
          ) : null}

          <p className="resume-note">
            {hasResume
              ? 'Questions use your resume and the job description, so they are close to what you will really be asked.'
              : <>Questions will be general for the role. <Link href="/resume">Upload your resume</Link> to make them about you.</>}
          </p>

          <div className="resume-actions">
            <button
              type="button"
              className="cta cta-primary"
              disabled={busy !== null || remaining === 0 || (!useTracker && role.trim().length < 2)}
              onClick={() => void start()}
            >
              {busy === 'start' ? 'Preparing your questions…' : 'Start practice'}
            </button>
            {remaining !== null ? (
              <span className="resume-counter">{remaining} session{remaining === 1 ? '' : 's'} left today</span>
            ) : null}
          </div>
          {remaining === 0 ? (
            <p className="resume-note">
              You have used today&apos;s free session. <Link href="/pricing">Full access</Link> gives you up to 10 a day.
            </p>
          ) : null}
          {error ? <p className="resume-error" role="alert">{error}</p> : null}
        </section>
      </div>
    );
  }

  // --- finished --------------------------------------------------------------
  if (index >= session.questions.length) {
    const scores = Object.values(feedback).map((f) => f.score);
    const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;
    return (
      <div className="resume-flow">
        <section className="resume-step">
          <h2 className="resume-step-title">Practice done</h2>
          <p className="resume-lede">
            {avg
              ? `You answered ${scores.length} of ${session.questions.length} questions, with an average of ${avg} out of 5.`
              : 'You went through every question.'}{' '}
            Practising the same questions again tomorrow is the fastest way to improve.
          </p>
          <div className="resume-actions">
            <button type="button" className="cta cta-primary" onClick={() => setSession(null)}>
              Practise for another job
            </button>
            <Link className="cta cta-secondary" href="/jobs">
              Back to my jobs
            </Link>
          </div>
        </section>
      </div>
    );
  }

  // --- step 2: one question at a time ---------------------------------------
  const question = session.questions[index];
  const result = feedback[question.id];

  return (
    <div className="resume-flow">
      <p className="resume-allowance">
        <span>
          {session.role}
          {session.company ? ` · ${session.company}` : ''}
        </span>
        <span>
          Question <strong>{index + 1}</strong> of {session.questions.length}
        </span>
      </p>

      <section className="resume-step">
        <p className="resume-label">{KIND_LABEL[question.kind]}</p>
        <h2 className="resume-step-title">{question.question}</h2>

        <label className="resume-label" htmlFor="iv-answer">
          Your answer
        </label>
        <textarea
          id="iv-answer"
          className="resume-jd"
          value={answer}
          maxLength={4000}
          placeholder={canSpeak ? 'Type your answer, or press Speak and answer out loud.' : 'Type your answer as you would say it.'}
          onChange={(e) => setAnswer(e.target.value)}
          disabled={busy === 'feedback'}
        />
        <div className="resume-actions">
          {canSpeak ? (
            <button
              type="button"
              className="cta cta-secondary"
              aria-pressed={listening}
              onClick={toggleSpeaking}
              disabled={busy === 'feedback'}
            >
              {listening ? 'Stop speaking' : 'Speak'}
            </button>
          ) : null}
          <button
            type="button"
            className="cta cta-primary"
            disabled={busy !== null || answer.trim().length < 15}
            onClick={() => void getFeedback()}
          >
            {busy === 'feedback' ? 'Reading your answer…' : result ? 'Get feedback again' : 'Get feedback'}
          </button>
          <button type="button" className="resume-job-remove" onClick={next}>
            {result ? 'Next question' : 'Skip'}
          </button>
        </div>
        {error ? <p className="resume-error" role="alert">{error}</p> : null}
      </section>

      {result ? (
        <section className="resume-block" aria-live="polite">
          <h3>
            {result.score}/5 · {SCORE_LABEL[result.score]}
          </h3>
          {result.strengths.length > 0 ? (
            <>
              <p className="resume-label">What worked</p>
              <ul className="resume-warnings">
                {result.strengths.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </>
          ) : null}
          {result.improve.length > 0 ? (
            <>
              <p className="resume-label">To make it stronger</p>
              <ul className="resume-warnings">
                {result.improve.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </>
          ) : null}
          {result.betterAnswer ? (
            <>
              <p className="resume-label">A stronger version</p>
              <p className="resume-lede">{result.betterAnswer}</p>
              <p className="resume-note">
                Anything in [brackets] is for you to fill in with a real example. Say it in your own words.
              </p>
            </>
          ) : null}
          <p className="resume-note">Tip: {question.tip}</p>
          <div className="resume-actions">
            <button type="button" className="cta cta-primary" onClick={next}>
              {index + 1 < session.questions.length ? 'Next question' : 'Finish'}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
