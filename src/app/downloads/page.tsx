import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Download Unviewable for Windows',
  description:
    'Download the latest version of Unviewable — a stealth AI overlay for meetings and interviews. Free for Windows 10+. No traces, no detection.',
  alternates: { canonical: '/downloads' },
  openGraph: {
    title: 'Download Unviewable for Windows',
    description:
      'Download the latest version of Unviewable — a stealth AI overlay for meetings and interviews.',
    url: '/downloads',
  },
};

const downloadUrl =
  'https://github.com/adrianYT028/AIMeetingAssistant-Releases/releases/download/2.0.0/Unviewable_Setup_2.0.0.exe';

export default function DownloadsPage() {
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
              <a href="/guides/setup">Setup Guide</a>
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
        <section className="hero" style={{ minHeight: '80vh' }}>
          <div className="hero-content">
            <p className="hero-tag">DOWNLOAD</p>
            <h1 className="hero-headline">
              Get Unviewable
              <br />
              for Windows
            </h1>
            <p className="hero-sub">
              Free download. No subscription, no telemetry, no traces.
              <br />
              Requires Windows 10 version 2004 or later.
            </p>

            <div className="hero-buttons">
              <a
                href={downloadUrl}
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
                  role="img"
                  aria-label="Download icon"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>Download for Windows</span>
                <span className="version-badge">v2.0.0</span>
              </a>
            </div>

            <div className="tech-note glass-panel" style={{ marginTop: '3rem', textAlign: 'left' }}>
              <h2 style={{ fontSize: '1.125rem', marginBottom: '1rem', color: '#fff' }}>
                System Requirements
              </h2>
              <ul style={{ listStyle: 'disc', paddingLeft: '1.5rem', lineHeight: 2 }}>
                <li>Windows 10 version 2004 (May 2020 Update) or later</li>
                <li>4 GB RAM minimum (8 GB recommended)</li>
                <li>50 MB disk space</li>
                <li>Active internet connection for AI features</li>
                <li>
                  Compatible with Zoom, Teams, Google Meet, Discord, OBS, and all DXGI-based
                  capture tools
                </li>
              </ul>
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
