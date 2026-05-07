import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Setup Guide — Install Unviewable in 2 Minutes',
  description:
    'Step-by-step installation guide for Unviewable on Windows. Download, install, and launch the stealth AI overlay in under 2 minutes.',
  alternates: { canonical: '/guides/setup' },
  openGraph: {
    title: 'Setup Guide — Install Unviewable in 2 Minutes',
    description:
      'Step-by-step installation guide for Unviewable on Windows.',
    url: '/guides/setup',
  },
};

export default function SetupGuidePage() {
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
              <a href="/guides/usage">Usage Guide</a>
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
            <p className="section-tag">INSTALL &amp; RUN</p>
            <h1 className="section-title">Setup Guide</h1>
            <p className="section-sub">
              Follow along to download, install, and launch Unviewable on Windows without showing a
              trace.
            </p>

            <div className="video-grid glass-panel">
              <div className="video-frame">
                <div className="video-embed">
                  <iframe
                    src="https://drive.google.com/file/d/12cv5t8-Q46hb2Pd6CVomRuMNd4DvCCKf/preview"
                    title="Unviewable install and run tutorial"
                    allow="autoplay; encrypted-media"
                    allowFullScreen
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                </div>
              </div>

              <div className="video-steps">
                <h2 className="video-steps-title">Checklist</h2>
                <ol className="video-steps-list">
                  <li>
                    <strong>Download</strong> the Windows installer (v2.0.0) from the{' '}
                    <a href="/downloads" style={{ color: 'var(--color-cyan)' }}>
                      downloads page
                    </a>
                    .
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
                <p className="video-note">
                  Tip: If antivirus blocks the installer, whitelist it and rerun the setup.
                </p>
              </div>
            </div>

            <div
              className="tech-note glass-panel"
              style={{ marginTop: '2rem' }}
            >
              <p>
                <strong>Need help?</strong> Contact us at{' '}
                <a
                  href="mailto:join.invisibleai@gmail.com"
                  style={{ color: 'var(--color-cyan)' }}
                >
                  join.invisibleai@gmail.com
                </a>{' '}
                or reach out on{' '}
                <a
                  href="https://www.instagram.com/unviewable.online/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--color-cyan)' }}
                >
                  Instagram
                </a>
                .
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
