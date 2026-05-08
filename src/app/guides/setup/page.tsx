import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Setup Guide — Install Unviewable in 2 Minutes',
  description:
    'Step-by-step installation guide for Unviewable on Windows. Download, configure the Groq API key, and launch the stealth AI overlay.',
  alternates: { canonical: '/guides/setup' },
  openGraph: {
    title: 'Setup Guide — Install Unviewable in 2 Minutes',
    description:
      'Step-by-step installation guide for Unviewable on Windows.',
    url: '/guides/setup',
  },
};

const tipIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);

const faqPlusIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export default function SetupGuidePage() {
  return (
    <>
      <header className="site-header" role="banner">
        <nav className="nav-container" aria-label="Main navigation">
          <a href="/" className="logo" aria-label="Unviewable Home">
            <img src="/logo.png" alt="Unviewable Logo" className="logo-img" width={36} height={36} />
            <span className="logo-text">UNVIEWABLE<span className="logo-accent"></span></span>
          </a>
          <ul className="nav-links" role="list">
            <li><a href="/#features">Features</a></li>
            <li><a href="/downloads">Download</a></li>
            <li><a href="/guides/usage">Usage Guide</a></li>
            <li><a href="/#how-it-works">How It Works</a></li>
            <li><a href="/login">Login</a></li>
          </ul>
        </nav>
      </header>

      <main id="main-content">
        {/* ─── INTRO ─── */}
        <section className="video-section" style={{ paddingTop: 'calc(var(--nav-height) + 4rem)' }}>
          <div className="section-container">
            <p className="section-tag">INSTALL &amp; RUN</p>
            <h1 className="section-title">Setup Guide</h1>
            <p className="section-sub">
              Welcome to your AI Meeting Assistant. Learn how to set up the invisible overlay and leverage
              real-time AI assistance during your meetings and interviews.
            </p>

            {/* ─── What It Does ─── */}
            <div className="stealth-banner">
              <div className="stealth-banner-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </div>
              <div className="stealth-banner-content">
                <h2 className="stealth-banner-title">
                  What <span>Unviewable</span> Does
                </h2>
                <p className="stealth-banner-text">
                  Unviewable is a <strong>100% invisible AI overlay</strong> for Windows. It captures meeting audio via WASAPI loopback,
                  transcribes it in real time with Whisper, and feeds context to an AI model that generates answers, summaries, and
                  talking points — all displayed on a stealth panel that is <strong>completely invisible</strong> to Zoom, Teams, Discord,
                  OBS, and every other screen-capture tool.
                </p>
              </div>
            </div>

            {/* ─── PREREQUISITES ─── */}
            <h2 className="section-title" style={{ fontSize: 'var(--fs-xl)', marginBottom: 'var(--space-xl)' }}>
              Prerequisites
            </h2>
            <div className="prereq-grid">
              <div className="prereq-card">
                <div className="prereq-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="3" width="20" height="14" rx="2" />
                    <path d="M8 21h8" /><path d="M12 17v4" />
                  </svg>
                </div>
                <h3 className="prereq-title">Windows 10 / 11</h3>
                <p className="prereq-desc">
                  Requires Windows 10 version 2004 or later. The <code>WDA_EXCLUDEFROMCAPTURE</code> API
                  used for stealth is not available on older versions.
                </p>
              </div>
              <div className="prereq-card">
                <div className="prereq-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </div>
                <h3 className="prereq-title">No Dependencies</h3>
                <p className="prereq-desc">
                  The portable <code>.exe</code> bundles everything. No Visual&nbsp;C++ Redistributable or
                  additional runtimes required.
                </p>
              </div>
              <div className="prereq-card">
                <div className="prereq-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0110 0v4" />
                  </svg>
                </div>
                <h3 className="prereq-title">Groq API Key</h3>
                <p className="prereq-desc">
                  A <strong>free</strong> API key from{' '}
                  <a href="https://console.groq.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-cyan)' }}>
                    console.groq.com
                  </a>. Powers the Whisper transcription and Llama AI model.
                </p>
              </div>
            </div>

            {/* ─── STEP-BY-STEP ─── */}
            <div className="guide-steps">
              {/* Step 1: Download */}
              <div className="guide-step">
                <div className="guide-step-visual">
                  <img src="/guides/step-download.png" alt="Download the Unviewable application" loading="eager" />
                </div>
                <div className="guide-step-content">
                  <div className="guide-step-number">1</div>
                  <h2 className="guide-step-title">Download the Application</h2>
                  <p className="guide-step-desc">
                    Head to the{' '}
                    <a href="/downloads" style={{ color: 'var(--color-cyan)' }}>downloads page</a>{' '}
                    and grab the latest release. Extract the folder to a permanent
                    location like <code>Documents</code> or <code>Desktop</code>.
                  </p>
                  <div className="guide-step-tip">
                    {tipIcon}
                    <span>The download is a single portable folder — no installer wizard needed.</span>
                  </div>
                </div>
              </div>

              {/* Step 2: Get Groq API Key */}
              <div className="guide-step">
                <div className="guide-step-visual">
                  <img src="/guides/step-groq-api.png" alt="Groq Console API key generation page" loading="lazy" />
                </div>
                <div className="guide-step-content">
                  <div className="guide-step-number">2</div>
                  <h2 className="guide-step-title">Get Your Groq API Key</h2>
                  <p className="guide-step-desc">
                    Sign up for free at{' '}
                    <a href="https://console.groq.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-cyan)' }}>
                      console.groq.com
                    </a>. Navigate to <strong>API Keys</strong> in the sidebar
                    and click <strong>"Create API Key"</strong>. Copy the key — you'll need it next.
                  </p>
                  <div className="guide-step-tip">
                    {tipIcon}
                    <span>Groq's free tier includes generous rate limits — more than enough for meetings.</span>
                  </div>
                </div>
              </div>

              {/* Step 3: Configure */}
              <div className="guide-step">
                <div className="guide-step-visual">
                  <img src="/guides/step-configure.png" alt="Configuring the API key via terminal or config.ini" loading="lazy" />
                </div>
                <div className="guide-step-content">
                  <div className="guide-step-number">3</div>
                  <h2 className="guide-step-title">Configure the App</h2>
                  <p className="guide-step-desc">
                    Set your API key using <strong>either</strong> method:
                  </p>
                  <p className="guide-step-desc" style={{ marginBottom: 'var(--space-sm)' }}>
                    <strong>Option A — Environment variable:</strong>
                  </p>
                  <code className="guide-code-block">setx GROQ_API_KEY &quot;your-api-key-here&quot;</code>
                  <p className="guide-step-desc" style={{ marginBottom: 'var(--space-sm)' }}>
                    <strong>Option B — Config file:</strong> Open <code>config.ini</code> in the app
                    folder and paste your key into the <code>api_key</code> field under <code>[General]</code>.
                  </p>
                  <div className="guide-step-tip">
                    {tipIcon}
                    <span>
                      You can also tweak the AI model, font size, panel opacity, and more in <code>config.ini</code>.
                    </span>
                  </div>
                </div>
              </div>

              {/* Step 4: Launch */}
              <div className="guide-step">
                <div className="guide-step-visual">
                  <img src="/guides/step-launch.png" alt="Launching Unviewable with hotkey" loading="lazy" />
                </div>
                <div className="guide-step-content">
                  <div className="guide-step-number">4</div>
                  <h2 className="guide-step-title">Launch the App</h2>
                  <p className="guide-step-desc">
                    Double-click <code>InvisibleOverlay.exe</code> to start. The overlay attaches to your
                    display and becomes invisible to screen capture immediately. You'll see a system tray icon
                    confirming it's running.
                  </p>
                  <p className="guide-step-desc">
                    <strong>Want text-to-speech?</strong> Enable it in <code>config.ini</code> by setting{' '}
                    <code>enable_tts = true</code>, or launch from the command line:
                  </p>
                  <code className="guide-code-block">InvisibleOverlay.exe --tts</code>
                  <div className="guide-step-tip">
                    {tipIcon}
                    <span>The app starts listening to system audio automatically — no extra setup needed.</span>
                  </div>
                </div>
              </div>
            </div>

            {/* ─── TROUBLESHOOTING FAQ ─── */}
            <div className="faq-section">
              <h2 className="faq-section-title">Troubleshooting</h2>
              <div className="faq-list">
                <FaqItem
                  question="My antivirus flagged the app"
                  answer="Invisible overlays sometimes trigger false positives due to screen-reading behavior and capture exclusion APIs. Add InvisibleOverlay.exe to your antivirus whitelist and re-run the setup."
                />
                <FaqItem
                  question="The app says 'No API key — AI features disabled'"
                  answer="Your Groq API key isn't being detected. Make sure you either set the GROQ_API_KEY environment variable (restart your terminal after running setx) or pasted the key into config.ini under the [General] section."
                />
                <FaqItem
                  question="Windows SmartScreen is blocking the download"
                  answer={'Click "More info" on the SmartScreen prompt, then click "Run anyway". This happens because the app is new and hasn\'t been signed with an EV certificate yet.'}
                />
                <FaqItem
                  question="Is it really invisible to screen share?"
                  answer="Yes. Unviewable uses the Windows DWM API (SetWindowDisplayAffinity with WDA_EXCLUDEFROMCAPTURE). This tells the operating system's compositor to exclude the window from all DXGI-based capture pipelines — Zoom, Teams, Discord, OBS, and any other tool that uses screen capture."
                />
                <FaqItem
                  question="Still having trouble? Contact Support"
                  answer={
                    <>
                      If you are experiencing issues or have questions, please reach out to our team directly at <a href="mailto:join.invisibleai@gmail.com" style={{ color: 'var(--color-cyan)', textDecoration: 'underline' }}>join.invisibleai@gmail.com</a>. We're here to help!
                    </>
                  }
                />
              </div>
            </div>

            <div className="tech-note glass-panel" style={{ marginTop: '3rem' }}>
              <p>
                <strong>All set?</strong> Head to the{' '}
                <a href="/guides/usage" style={{ color: 'var(--color-cyan)' }}>Usage Guide</a>{' '}
                to learn hotkeys, best practices, and how to get the most out of the AI during live sessions.
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

      {/* FAQ Toggle Script */}
      <script dangerouslySetInnerHTML={{ __html: `
        document.addEventListener('click', function(e) {
          var btn = e.target.closest('.faq-question');
          if (!btn) return;
          var item = btn.closest('.faq-item');
          if (item) item.classList.toggle('is-open');
        });
      `}} />
    </>
  );
}

function FaqItem({ question, answer }: { question: string; answer: React.ReactNode }) {
  return (
    <div className="faq-item">
      <button className="faq-question" type="button" aria-expanded="false">
        <span>{question}</span>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <div className="faq-answer">
        <p>{answer}</p>
      </div>
    </div>
  );
}
