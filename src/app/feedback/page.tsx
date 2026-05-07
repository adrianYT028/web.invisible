import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Feedback — Share Your Unviewable Experience',
  description:
    'Tell us how Unviewable is working for you. Submit bug reports, feature requests, and general feedback to help us improve the product.',
  alternates: { canonical: '/feedback' },
  openGraph: {
    title: 'Feedback — Share Your Unviewable Experience',
    description:
      'Tell us how Unviewable is working for you. Submit feedback to help us improve.',
    url: '/feedback',
  },
};

export default function FeedbackPage() {
  return (
    <>
      <header className="site-header" role="banner">
        <nav className="nav-container" aria-label="Main navigation">
          <a href="/" className="logo" aria-label="Unviewable Home">
            <img
              src="/logo.png"
              alt="Unviewable Logo"
              className="logo-img"
              width={36}
              height={36}
            />
            <span className="logo-text">
              UNVIEWABLE<span className="logo-accent"></span>
            </span>
          </a>
          <ul className="nav-links" role="list">
            <li>
              <a href="/#features">Features</a>
            </li>
            <li>
              <a href="/downloads">Download</a>
            </li>
            <li>
              <a href="/guides/setup">Setup Guide</a>
            </li>
            <li>
              <a href="/#how-it-works">How It Works</a>
            </li>
            <li>
              <a href="/login">Login</a>
            </li>
          </ul>
        </nav>
      </header>

      <main id="main-content">
        <section className="hero" style={{ minHeight: '80vh' }}>
          <div className="hero-content">
            <p className="hero-tag">FEEDBACK</p>
            <h1 className="hero-headline">
              Tell Us How
              <br />
              It Feels
            </h1>
            <p className="hero-sub">
              Your feedback shapes the product. Log in to submit bug reports, feature requests, and
              general impressions.
            </p>

            <div className="hero-buttons">
              <Link
                href="/login?redirectedFrom=%2F%23reviews"
                className="download-button"
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  role="img"
                  aria-label="Login icon"
                >
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                  <polyline points="10 17 15 12 10 7" />
                  <line x1="15" y1="12" x2="3" y2="12" />
                </svg>
                <span>Log In to Submit Feedback</span>
              </Link>
            </div>

            <div className="tech-note glass-panel" style={{ marginTop: '3rem', textAlign: 'left' }}>
              <p>
                <strong>Prefer email?</strong> Reach us directly at{' '}
                <a
                  href="mailto:join.invisibleai@gmail.com"
                  style={{ color: 'var(--color-cyan)' }}
                >
                  join.invisibleai@gmail.com
                </a>{' '}
                or on{' '}
                <a
                  href="https://www.instagram.com/unviewable.online/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--color-cyan)' }}
                >
                  Instagram @unviewable.online
                </a>
                .
              </p>
            </div>
          </div>
          <div className="hero-glow" aria-hidden="true" />
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-container">
          <p className="footer-copy">
            &copy; <time dateTime="2026">2026</time> Unviewable. All rights reserved.
          </p>
          <p className="footer-note">Built for those who operate in the margins.</p>
        </div>
      </footer>
    </>
  );
}
