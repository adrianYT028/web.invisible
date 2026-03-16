"use client";

import { useEffect, useMemo, useRef, useState } from 'react';

import { createSupabaseBrowserClient } from '@/lib/supabase/browser';

type SubmitState = 'idle' | 'loading' | 'success';

function useParticles(canvasId: string) {
  const rafRef = useRef<number | null>(null);
  const particlesRef = useRef<
    Array<{ x: number; y: number; vx: number; vy: number; radius: number; alpha: number }>
  >([]);

  useEffect(() => {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) return;
    const canvasEl = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function resize() {
      canvasEl.width = window.innerWidth;
      canvasEl.height = window.innerHeight;
    }

    resize();

    const count = 45;
    particlesRef.current = Array.from({ length: count }, () => ({
      x: Math.random() * canvasEl.width,
      y: Math.random() * canvasEl.height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      radius: Math.random() * 1.5 + 0.5,
      alpha: Math.random() * 0.3 + 0.1,
    }));

    let resizeTimeout: number | undefined;
    const onResize = () => {
      window.clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(resize, 200);
    };
    window.addEventListener('resize', onResize);

    const tick = () => {
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      for (const p of particlesRef.current) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = canvasEl.width;
        if (p.x > canvasEl.width) p.x = 0;
        if (p.y < 0) p.y = canvasEl.height;
        if (p.y > canvasEl.height) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0, 242, 255, ${p.alpha})`;
        ctx.fill();
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('resize', onResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [canvasId]);
}

function useScrollReveal() {
  useEffect(() => {
    document.body.classList.add('js-ready');

    // 1. First, dynamically add animation classes to elements
    const animConfigs: Array<{
      selector: string;
      cls: string;
      baseDelay: number;
      stagger?: number;
    }> = [
      { selector: '.section-tag', cls: 'fade-in-up', baseDelay: 0 },
      { selector: '.section-title', cls: 'fade-in-up', baseDelay: 80 },
      { selector: '.section-sub', cls: 'fade-in-up', baseDelay: 160 },
      { selector: '.feature-card', cls: 'fade-in-up', baseDelay: 0, stagger: 120 },
      { selector: '.step-card', cls: 'fade-in-up', baseDelay: 0, stagger: 150 },
      { selector: '.tech-note', cls: 'scale-in', baseDelay: 200 },
      { selector: '.review-form', cls: 'scale-in', baseDelay: 80 },
    ];

    animConfigs.forEach(({ selector, cls, baseDelay, stagger }) => {
      const staggerMs = stagger ?? 0;
      document.querySelectorAll(selector).forEach((el, i) => {
        el.classList.add(cls);
        (el as HTMLElement).style.transitionDelay = `${baseDelay + i * staggerMs}ms`;
      });
    });

    // 2. Then, set up IntersectionObserver to watch all classified elements
    const selectors = ['.fade-in-up', '.fade-in-left', '.fade-in-right', '.scale-in', '.section-divider'];
    const threshold = 0.15;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold }
    );

    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => observer.observe(el));
    });

    return () => {
      document.body.classList.remove('js-ready');
      observer.disconnect();
    };
  }, []);
}

export default function Home() {
  useParticles('particles');
  useScrollReveal();

  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [userEmail, setUserEmail] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [review, setReview] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase.auth.getUser();
      if (cancelled) return;
      if (error || !data?.user) {
        // Middleware should catch this, but keep a safe fallback.
        window.location.href = '/login';
        return;
      }
      setUserEmail(data.user.email || '');

      // Ensure signup row exists (server-side route inserts with RLS).
      fetch('/api/signups/ensure', { method: 'POST' }).catch(() => {});
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  async function handleLogout() {
    try {
      await supabase.auth.signOut();
    } finally {
      window.location.href = '/login';
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');

    if (!rating) {
      setFormError('Add a rating so we know severity.');
      return;
    }
    if (review.trim().length < 7) {
      setFormError('Please add a few details (at least 7 characters).');
      return;
    }

    setSubmitState('loading');
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, review: review.trim() }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || 'Could not save your review. Please try again.');
      }

      setSubmitState('success');
      setTimeout(() => {
        setSubmitState('idle');
        setRating(null);
        setReview('');
      }, 2500);
    } catch (e: any) {
      setSubmitState('idle');
      setFormError(e?.message || 'Could not save your review. Please try again.');
    }
  }

  const submitBtnClass =
    submitState === 'loading'
      ? 'submit-btn is-loading'
      : submitState === 'success'
        ? 'submit-btn is-success'
        : 'submit-btn';

  return (
    <>
      <canvas className="particles-canvas" id="particles" aria-hidden="true" />
      <div className="noise-overlay" aria-hidden="true" />
      <div className="scanline-overlay" aria-hidden="true" />

      <header className="site-header">
        <nav className="nav-container">
          <a href="#" className="logo" aria-label="Invisible AI Home">
            <span className="logo-icon">&#9670;</span>
            <span className="logo-text">
              INVISIBLE<span className="logo-accent">AI</span>
            </span>
          </a>
          <ul className="nav-links" role="list">
            <li>
              <a href="#features">Features</a>
            </li>
            <li>
              <a href="#install">Guide</a>
            </li>
            <li>
              <a href="#usage-guide">Usage</a>
            </li>
            <li>
              <a href="#how-it-works">How It Works</a>
            </li>
            <li>
              <a href="#reviews">Feedback</a>
            </li>
            <li>
              <a href="#account">Account</a>
            </li>
            <li>
              <button className="logout-link" onClick={handleLogout} type="button">
                Logout
              </button>
            </li>
          </ul>
        </nav>
      </header>

      <main>
        <section className="hero" id="hero">
          <div className="hero-content">
            <p className="hero-tag">STEALTH-MODE AI OVERLAY</p>
            <h1 className="hero-headline">
              The Intelligence<br />They Can't See.
            </h1>
            <p className="hero-sub">
              A 100% invisible AI assistant for high-stakes interviews and meetings.
              <br />
              Bypasses all screen-capture pipelines.
            </p>

            <div className="hero-buttons">
              <a
                href="https://github.com/adrianYT028/AIMeetingAssistant-Releases/releases/download/v1.0.0/AIMeetingAssistant_Setup_1.1.0.exe"
                className="download-button"
                download
              >
                <svg
                  className="download-icon"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>Download for Windows</span>
                <span className="version-badge">v1.0.0</span>
              </a>
              <button className="download-button mac-button" disabled>
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.09997 22C7.78997 22.05 6.79997 20.68 5.95997 19.47C4.24997 17 2.93997 12.45 4.69997 9.39C5.56997 7.87 7.12997 6.91 8.81997 6.88C10.1 6.86 11.32 7.75 12.11 7.75C12.89 7.75 14.37 6.68 15.92 6.84C16.57 6.87 18.39 7.1 19.56 8.82C19.47 8.88 17.39 10.1 17.41 12.63C17.44 15.65 20.06 16.66 20.09 16.67C20.06 16.74 19.67 18.11 18.71 19.5Z" />
                  <path d="M13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z" />
                </svg>
                <span>Download for Mac</span>
                <span className="version-badge coming-soon">Coming Soon</span>
              </button>
            </div>
          </div>
          <div className="hero-glow" aria-hidden="true" />
        </section>

        <section className="video-section" id="install">
          <div className="section-container">
            <p className="section-tag">INSTALL &amp; RUN</p>
            <h2 className="section-title">Watch the 2-minute setup</h2>
            <p className="section-sub">
              Follow along to download, install, and launch Invisible AI on Windows without showing a trace.
            </p>

            <div className="video-grid glass-panel">
              <div className="video-frame fade-in-up">
                <div className="video-embed">
                  <iframe
                    src="https://drive.google.com/file/d/12cv5t8-Q46hb2Pd6CVomRuMNd4DvCCKf/preview"
                    title="Invisible AI install and run tutorial"
                    allow="autoplay; encrypted-media"
                    allowFullScreen
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                </div>
              </div>

              <div className="video-steps fade-in-up">
                <h3 className="video-steps-title">Checklist</h3>
                <ol className="video-steps-list">
                  <li>
                    <strong>Download</strong> the Windows installer (v1.0.0) from the hero CTA.
                  </li>
                  <li>
                    <strong>Run</strong> the setup and approve Windows SmartScreen prompts.
                  </li>
                  <li>
                    <strong>Launch</strong> the app and trigger the overlay with the hotkey shown.
                  </li>
                  <li>
                    <strong>Test</strong> in Zoom/Teams/OBS — capture tools will see nothing.
                  </li>
                </ol>
                <p className="video-note">Tip: If antivirus blocks the installer, whitelist it and rerun the setup.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="video-section" id="usage-guide">
          <div className="section-container">
            <p className="section-tag">USAGE GUIDE</p>
            <h2 className="section-title">How to run it live</h2>
            <p className="section-sub">A quick walkthrough on using the overlay during live meetings and interviews.</p>

            <div className="video-grid glass-panel">
              <div className="video-frame fade-in-up">
                <div className="video-embed">
                  <iframe
                    src="https://drive.google.com/file/d/1uAdBSS_QJXy_S8nrLbvTpp887MvXjpBg/preview"
                    title="Invisible AI usage guide"
                    allow="autoplay; encrypted-media"
                    allowFullScreen
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                </div>
              </div>

              <div className="video-steps fade-in-up">
                <h3 className="video-steps-title">In-session flow</h3>
                <ol className="video-steps-list">
                  <li>
                    <strong>Launch</strong> the overlay before the call starts.
                  </li>
                  <li>
                    <strong>Select</strong> the screen region you want the AI to watch.
                  </li>
                  <li>
                    <strong>Use</strong> the hotkeys to reposition or hide the panel.
                  </li>
                  <li>
                    <strong>Review</strong> suggestions discreetly while you speak.
                  </li>
                </ol>
                <p className="video-note">Tip: Keep the overlay near your eyeline for natural delivery.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="features" id="features">
          <div className="section-container">
            <p className="section-tag">PRODUCT CAPABILITIES</p>
            <h2 className="section-title">Engineered to be Unseen</h2>
            <p className="section-sub">Three core subsystems working in concert to deliver invisible intelligence.</p>

            <div className="features-grid">
              <article
                className="feature-card glass-panel"
                onMouseMove={(e) => {
                  const el = e.currentTarget;
                  const rect = el.getBoundingClientRect();
                  const x = ((e.clientX - rect.left) / rect.width) * 100;
                  const y = ((e.clientY - rect.top) / rect.height) * 100;
                  el.style.setProperty('--mouse-x', `${x}%`);
                  el.style.setProperty('--mouse-y', `${y}%`);
                }}
              >
                <div className="feature-icon">
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="2" y="3" width="20" height="14" rx="2" />
                    <path d="M8 21h8" />
                    <path d="M12 17v4" />
                    <path d="M2 8h20" />
                    <line x1="6" y1="12" x2="6" y2="12.01" />
                  </svg>
                </div>
                <h3 className="feature-title">Stealth Execution</h3>
                <p className="feature-desc">
                  Leverages the Windows Display Affinity API to make the overlay completely invisible to all screen-capture
                  and screen-share pipelines — OBS, Zoom, Teams, Discord.
                </p>
              </article>

              <article
                className="feature-card glass-panel"
                onMouseMove={(e) => {
                  const el = e.currentTarget;
                  const rect = el.getBoundingClientRect();
                  const x = ((e.clientX - rect.left) / rect.width) * 100;
                  const y = ((e.clientY - rect.top) / rect.height) * 100;
                  el.style.setProperty('--mouse-x', `${x}%`);
                  el.style.setProperty('--mouse-y', `${y}%`);
                }}
              >
                <div className="feature-icon">
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                </div>
                <h3 className="feature-title">Audio Loopback</h3>
                <p className="feature-desc">
                  Captures system audio through the Windows Audio Session API loopback device. Real-time transcription of
                  meeting audio without any virtual cable hacks.
                </p>
              </article>

              <article
                className="feature-card glass-panel"
                onMouseMove={(e) => {
                  const el = e.currentTarget;
                  const rect = el.getBoundingClientRect();
                  const x = ((e.clientX - rect.left) / rect.width) * 100;
                  const y = ((e.clientY - rect.top) / rect.height) * 100;
                  el.style.setProperty('--mouse-x', `${x}%`);
                  el.style.setProperty('--mouse-y', `${y}%`);
                }}
              >
                <div className="feature-icon">
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </div>
                <h3 className="feature-title">Vision Context</h3>
                <p className="feature-desc">
                  Selective region capture feeds visual context to the model — code editors, terminal output, documentation
                  — without exposing your full desktop.
                </p>
              </article>
            </div>
          </div>
        </section>

        <div className="section-divider" aria-hidden="true" />
        <div className="section-divider" aria-hidden="true" />

        <section className="how-it-works" id="how-it-works">
          <div className="section-container">
            <p className="section-tag">HOW IT WORKS</p>
            <h2 className="section-title">Three Steps. Zero Traces.</h2>
            <p className="section-sub">From launch to live intelligence — the entire pipeline runs silently in under 2 seconds.</p>

            <div className="steps-grid">
              <article className="step-card glass-panel">
                <div className="step-number">01</div>
                <h3 className="step-title">Launch the Overlay</h3>
                <p className="step-desc">
                  Start the assistant with a single hotkey. The overlay attaches to your display and immediately becomes
                  invisible to every screen-capture and screen-share pipeline.
                </p>
              </article>

              <article className="step-card glass-panel">
                <div className="step-number">02</div>
                <h3 className="step-title">Capture Context</h3>
                <p className="step-desc">
                  The system silently captures meeting audio and selected screen regions, feeding real-time context to the AI
                  model — no virtual cables, no plugins.
                </p>
              </article>

              <article className="step-card glass-panel">
                <div className="step-number">03</div>
                <h3 className="step-title">Get Live Intelligence</h3>
                <p className="step-desc">
                  AI-generated suggestions, answers, and talking points appear directly on your screen. Only you can see them.
                  Screen recorders and participants see nothing.
                </p>
              </article>
            </div>

            <div className="tech-note glass-panel">
              <p>
                <strong>Compatibility:</strong> Requires Windows 10 version 2004 or later. Works with Zoom, Teams, Google Meet,
                Discord, OBS, and all DXGI-based capture tools.
              </p>
            </div>
          </div>
        </section>

        <div className="section-divider" aria-hidden="true" />

        <section className="reviews" id="reviews">
          <div className="section-container">
            <p className="section-tag">FEEDBACK</p>
            <h2 className="section-title">Tell Us How It Feels</h2>
            <p className="section-sub">
              Share your experience so we can harden the product. Your email stays private and is only used to follow up if
              there is an issue.
            </p>

            <form className="review-form glass-panel" id="reviewForm" onSubmit={handleSubmit} noValidate>
              <div className="form-grid">
                <div className="form-stack">
                  <label htmlFor="reviewEmail">Signed-in email</label>
                  <input
                    type="email"
                    id="reviewEmail"
                    name="email"
                    className="field-control"
                    placeholder="you@company.com"
                    required
                    autoComplete="email"
                    aria-label="Email address for follow-up"
                    readOnly
                    value={userEmail}
                  />
                </div>
                <div className="form-stack">
                  <span className="rating-label">Rating</span>
                  <div className="rating-group" role="radiogroup" aria-label="Rating" onMouseLeave={() => setHoverRating(null)}>
                    {[1, 2, 3, 4, 5].map((n) => {
                      const isActive = rating !== null && rating >= n;
                      const isHovered = hoverRating !== null && hoverRating >= n;
                      let cls = '';
                      if (isActive) cls = 'active';
                      if (isHovered) cls += ' hovered';
                      return (
                        <span key={n}>
                          <input
                            type="radio"
                            id={`star${n}`}
                            name="rating"
                            value={n}
                            aria-label={`${n} star${n === 1 ? '' : 's'}`}
                            checked={rating === n}
                            onChange={() => {
                              setFormError('');
                              setRating(n);
                            }}
                          />
                          <label
                            htmlFor={`star${n}`}
                            title={`${n}`}
                            data-value={n}
                            className={cls.trim()}
                            onMouseEnter={() => setHoverRating(n)}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M12 2.5l2.9 6 6.6.5-5.1 4.5 1.6 6.4-6-3.6-6 3.6 1.6-6.4-5.1-4.5 6.6-.5z" />
                            </svg>
                          </label>
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="form-stack">
                <label htmlFor="reviewMessage">What worked? What broke?</label>
                <textarea
                  id="reviewMessage"
                  name="review"
                  rows={5}
                  placeholder="Include any glitches, context (app, meeting platform), and what you expect next."
                  minLength={7}
                  required
                  aria-label="Review details"
                  value={review}
                  onChange={(e) => {
                    setFormError('');
                    setReview(e.target.value);
                  }}
                />
              </div>

              <p className="form-hint">If something looks bad, we will only use your email to reach out for fixes.</p>

              <div className="form-actions">
                <button type="submit" className={submitBtnClass} id="reviewSubmitBtn" disabled={submitState === 'loading'}>
                  <span className="btn-text">Submit review</span>
                  <span className="btn-loader" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                    </svg>
                  </span>
                  <span className="btn-check" aria-hidden="true">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                </button>
                <p className="form-error" id="reviewFormError" role="alert" aria-live="polite">
                  {formError}
                </p>
              </div>
            </form>
          </div>
        </section>

        <section className="video-section" id="account">
          <div className="section-container">
            <p className="section-tag">ACCOUNT</p>
            <h2 className="section-title">Your account</h2>
            <p className="section-sub">Signed in as:</p>

            <div className="glass-panel" style={{ padding: '22px' }}>
              <p style={{ margin: 0 }}>{userEmail || '—'}</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-container">
          <p className="footer-copy">
            &copy; <time dateTime="2026">2026</time> Invisible AI. All rights reserved.
          </p>
          <p className="footer-note">Built for those who operate in the margins.</p>
        </div>
      </footer>
    </>
  );
}
