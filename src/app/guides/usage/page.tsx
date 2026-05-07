import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Usage Guide — How to Use Unviewable in Live Meetings',
  description:
    'Learn how to use the Unviewable AI overlay during live meetings and interviews. Hotkeys, positioning, and real-time AI suggestions.',
  alternates: { canonical: '/guides/usage' },
  openGraph: {
    title: 'Usage Guide — How to Use Unviewable in Live Meetings',
    description:
      'Learn how to use the Unviewable AI overlay during live meetings and interviews.',
    url: '/guides/usage',
  },
};

export default function UsageGuidePage() {
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
        <section className="video-section" style={{ paddingTop: 'calc(var(--nav-height) + 4rem)' }}>
          <div className="section-container">
            <p className="section-tag">USAGE GUIDE</p>
            <h1 className="section-title">How to Use Unviewable in Live Meetings</h1>
            <p className="section-sub">
              A quick walkthrough on using the overlay during live meetings and interviews.
            </p>

            <div className="video-grid glass-panel">
              <div className="video-frame">
                <div className="video-embed">
                  <iframe
                    src="https://drive.google.com/file/d/1uAdBSS_QJXy_S8nrLbvTpp887MvXjpBg/preview"
                    title="Unviewable usage guide"
                    allow="autoplay; encrypted-media"
                    allowFullScreen
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                </div>
              </div>

              <div className="video-steps">
                <h2 className="video-steps-title">In-session Flow</h2>
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
                <p className="video-note">
                  Tip: Keep the overlay near your eyeline for natural delivery.
                </p>
              </div>
            </div>

            <div
              className="tech-note glass-panel"
              style={{ marginTop: '2rem' }}
            >
              <p>
                <strong>First time?</strong> Start with the{' '}
                <a href="/guides/setup" style={{ color: 'var(--color-cyan)' }}>
                  setup guide
                </a>{' '}
                to install and configure Unviewable before your first session.
              </p>
            </div>
          </div>
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
