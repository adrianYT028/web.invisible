import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Usage Guide — Mastering Unviewable in Live Meetings',
  description:
    'Complete usage guide for Unviewable: hotkeys, AI features, best practices, and troubleshooting for live meetings and interviews.',
  alternates: { canonical: '/guides/usage' },
  openGraph: {
    title: 'Usage Guide — Mastering Unviewable in Live Meetings',
    description:
      'Complete usage guide for Unviewable: hotkeys, AI features, and best practices.',
    url: '/guides/usage',
  },
};

export default function UsageGuidePage() {
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
            <li><a href="/guides/setup">Setup Guide</a></li>
            <li><a href="/#how-it-works">How It Works</a></li>
            <li><a href="/login">Login</a></li>
          </ul>
        </nav>
      </header>

      <main id="main-content">
        <section className="video-section" style={{ paddingTop: 'calc(var(--nav-height) + 4rem)' }}>
          <div className="section-container">
            <p className="section-tag">USAGE GUIDE</p>
            <h1 className="section-title">Mastering the Assistant</h1>
            <p className="section-sub">
              Everything you need to run the AI overlay during live calls — hotkeys, workflows, and pro tips.
            </p>

            {/* ─── THE GOLDEN RULE ─── */}
            <div className="stealth-banner">
              <div className="stealth-banner-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <div className="stealth-banner-content">
                <h2 className="stealth-banner-title">
                  The Golden Rule of <span>Invisibility</span>
                </h2>
                <p className="stealth-banner-text">
                  Thanks to <code>WDA_EXCLUDEFROMCAPTURE</code>, the overlay is <strong>completely hidden</strong> from
                  every screen-capture and screen-share pipeline — Zoom, Teams, Discord, OBS, and all DXGI-based tools.
                  What you see on your monitor <em>does not exist</em> for anyone else. You can use the assistant with
                  full confidence during any live session.
                </p>
              </div>
            </div>

            {/* ─── CORE HOTKEYS ─── */}
            <h2 className="section-title" style={{ fontSize: 'var(--fs-xl)', marginBottom: 'var(--space-sm)' }}>
              Core Hotkeys &amp; Features
            </h2>
            <p className="section-sub" style={{ marginBottom: 'var(--space-lg)' }}>
              All controls are keyboard-driven — no visible UI changes for participants.
            </p>

            <div className="hotkey-grid">
              <div className="hotkey-card">
                <div className="hotkey-keys">
                  <kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>S</kbd>
                </div>
                <div className="hotkey-info">
                  <div className="hotkey-name">Screen Capture to AI</div>
                  <p className="hotkey-desc">
                    Select a screen region — the AI reads and answers questions about the captured content (code, docs, chat).
                  </p>
                </div>
              </div>

              <div className="hotkey-card">
                <div className="hotkey-keys">
                  <kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>A</kbd>
                </div>
                <div className="hotkey-info">
                  <div className="hotkey-name">Ask AI</div>
                  <p className="hotkey-desc">
                    Query the AI based on the live transcribed meeting audio. It detects the most recent question and answers directly.
                  </p>
                </div>
              </div>

              <div className="hotkey-card">
                <div className="hotkey-keys">
                  <kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>M</kbd>
                </div>
                <div className="hotkey-info">
                  <div className="hotkey-name">Meeting Summary</div>
                  <p className="hotkey-desc">
                    Generate a summary of the transcript so far — key points, decisions, and action items.
                  </p>
                </div>
              </div>

              <div className="hotkey-card">
                <div className="hotkey-keys">
                  <kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>T</kbd>
                </div>
                <div className="hotkey-info">
                  <div className="hotkey-name">Toggle Panels</div>
                  <p className="hotkey-desc">
                    Show or hide all overlay panels (transcript, AI response, control panel) with a single press.
                  </p>
                </div>
              </div>

              <div className="hotkey-card">
                <div className="hotkey-keys">
                  <kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>I</kbd>
                </div>
                <div className="hotkey-info">
                  <div className="hotkey-name">Interactive Mode</div>
                  <p className="hotkey-desc">
                    Toggle interactive mode to scroll, resize, drag panels, and copy AI responses to clipboard.
                  </p>
                </div>
              </div>

              <div className="hotkey-card">
                <div className="hotkey-keys">
                  <kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>P</kbd>
                </div>
                <div className="hotkey-info">
                  <div className="hotkey-name">Settings</div>
                  <p className="hotkey-desc">
                    Open the settings window to adjust opacity, font size, AI model, and panel dimensions without restarting.
                  </p>
                </div>
              </div>

              <div className="hotkey-card">
                <div className="hotkey-keys">
                  <kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>Q</kbd>
                </div>
                <div className="hotkey-info">
                  <div className="hotkey-name">Quit Application</div>
                  <p className="hotkey-desc">
                    Safely exit the application and release all audio resources.
                  </p>
                </div>
              </div>
            </div>

            {/* Context Memory note */}
            <div className="guide-step-tip" style={{ marginTop: 'var(--space-xl)' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span>
                <strong>Context Memory:</strong> The AI remembers the last 10 interactions, so you can ask natural
                follow-up questions without repeating yourself. The conversation history resets when you close the app.
              </span>
            </div>

            {/* ─── VISUAL WORKFLOW ─── */}
            <div style={{ marginTop: 'var(--space-4xl)' }}>
              <h2 className="section-title" style={{ fontSize: 'var(--fs-xl)', marginBottom: 'var(--space-sm)' }}>
                In-Session Workflow
              </h2>
              <p className="section-sub" style={{ marginBottom: 'var(--space-xl)' }}>
                A typical meeting flow from launch to live AI suggestions.
              </p>

              <div className="guide-steps">
                {/* Step 1 */}
                <div className="guide-step">
                  <div className="guide-step-visual">
                    <img src="/guides/usage-launch.png" alt="Launching overlay before the call" loading="lazy" />
                  </div>
                  <div className="guide-step-content">
                    <div className="guide-step-number">1</div>
                    <h3 className="guide-step-title">Launch Before the Call</h3>
                    <p className="guide-step-desc">
                      Open Unviewable <strong>before</strong> joining your meeting. The app starts listening
                      to system audio immediately via WASAPI loopback — no virtual cables needed.
                    </p>
                  </div>
                </div>

                {/* Step 2 */}
                <div className="guide-step">
                  <div className="guide-step-visual">
                    <img src="/guides/usage-select.png" alt="Selecting a screen region for AI context" loading="lazy" />
                  </div>
                  <div className="guide-step-content">
                    <div className="guide-step-number">2</div>
                    <h3 className="guide-step-title">Capture Visual Context</h3>
                    <p className="guide-step-desc">
                      Press <kbd style={{ color: 'var(--color-cyan)', fontFamily: 'var(--font-mono)' }}>Ctrl+Shift+S</kbd>{' '}
                      to select a screen region. The AI will analyze the content — code, documents, chat messages —
                      and provide contextual answers.
                    </p>
                  </div>
                </div>

                {/* Step 3 */}
                <div className="guide-step">
                  <div className="guide-step-visual">
                    <img src="/guides/step-hotkeys-grid.png" alt="Using hotkeys to control the overlay" loading="lazy" />
                  </div>
                  <div className="guide-step-content">
                    <div className="guide-step-number">3</div>
                    <h3 className="guide-step-title">Ask &amp; Interact</h3>
                    <p className="guide-step-desc">
                      Use <kbd style={{ color: 'var(--color-cyan)', fontFamily: 'var(--font-mono)' }}>Ctrl+Shift+A</kbd> to
                      ask the AI about the meeting. Press <kbd style={{ color: 'var(--color-cyan)', fontFamily: 'var(--font-mono)' }}>Ctrl+Shift+I</kbd> to
                      enter interactive mode — scroll responses, drag panels, and copy text.
                    </p>
                  </div>
                </div>

                {/* Step 4 */}
                <div className="guide-step">
                  <div className="guide-step-visual">
                    <img src="/guides/usage-review.png" alt="AI suggestions on the stealth overlay" loading="lazy" />
                  </div>
                  <div className="guide-step-content">
                    <div className="guide-step-number">4</div>
                    <h3 className="guide-step-title">Review Live Intelligence</h3>
                    <p className="guide-step-desc">
                      AI-generated answers and talking points appear in real time. The auto-detect feature
                      listens for questions in the transcript and answers them automatically with a 15-second
                      cooldown to prevent spam.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* ─── BEST PRACTICES ─── */}
            <div style={{ marginTop: 'var(--space-4xl)' }}>
              <h2 className="section-title" style={{ fontSize: 'var(--fs-xl)', marginBottom: 'var(--space-sm)' }}>
                Best Practices &amp; Pro Tips
              </h2>
              <p className="section-sub" style={{ marginBottom: 'var(--space-lg)' }}>
                Level up from beginner to power user.
              </p>

              <div className="tips-grid">
                <div className="tip-card">
                  <div className="tip-card-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
                      <path d="M19 10v2a7 7 0 01-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
                    </svg>
                  </div>
                  <h3 className="tip-card-title">Audio Setup</h3>
                  <p className="tip-card-desc">
                    The app captures <strong>system audio</strong> (what comes out of your speakers/headphones),
                    not your mic. Make sure the meeting audio is playing through your default output device. If
                    you're on mute, the app still hears the other participants.
                  </p>
                </div>

                <div className="tip-card">
                  <div className="tip-card-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <line x1="3" y1="9" x2="21" y2="9" />
                      <line x1="9" y1="21" x2="9" y2="9" />
                    </svg>
                  </div>
                  <h3 className="tip-card-title">Screen Selection</h3>
                  <p className="tip-card-desc">
                    When using <strong>Ctrl+Shift+S</strong>, highlight just the relevant area — a code block,
                    a specific paragraph, or a chat message. Smaller regions give faster AI responses from the
                    Groq API because there's less visual data to process.
                  </p>
                </div>

                <div className="tip-card">
                  <div className="tip-card-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 9l4 4L19 3" />
                      <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                    </svg>
                  </div>
                  <h3 className="tip-card-title">Click-Through</h3>
                  <p className="tip-card-desc">
                    The overlay is <strong>click-through by default</strong> — your mouse passes right through it
                    to interact with windows underneath. Toggle interactive mode (<strong>Ctrl+Shift+I</strong>)
                    only when you need to scroll or drag panels.
                  </p>
                </div>

                <div className="tip-card">
                  <div className="tip-card-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </div>
                  <h3 className="tip-card-title">Panel Positioning</h3>
                  <p className="tip-card-desc">
                    Keep the overlay near your <strong>webcam eyeline</strong> for the most natural delivery.
                    In interactive mode, you can drag each panel independently — the control panel, response
                    panel, and transcript panel all have separate drag handles.
                  </p>
                </div>
              </div>
            </div>

            {/* ─── USAGE FAQ ─── */}
            <div className="faq-section">
              <h2 className="faq-section-title">Troubleshooting</h2>
              <div className="faq-list">
                <FaqItem
                  question="The AI isn't responding!"
                  answer="Check if your Groq API key is set correctly. Open config.ini and verify the api_key field, or run 'echo %GROQ_API_KEY%' in a terminal to check the environment variable. Also make sure you have internet access — the AI needs to reach Groq's servers."
                />
                <FaqItem
                  question="It's capturing my audio but not the meeting audio!"
                  answer="Unviewable uses WASAPI Loopback to capture system audio — the sound coming out of your speakers or headphones. If the meeting audio is routed to a different output device (e.g., a Bluetooth headset), make sure that device is set as the default Windows audio output."
                />
                <FaqItem
                  question="The transcript seems inaccurate"
                  answer="Whisper works best with clear audio. Ensure the meeting volume is at a reasonable level and there's minimal background noise. You can also change the whisper language in config.ini (e.g., language = hi for Hindi) if the meeting isn't in English."
                />
                <FaqItem
                  question="Can participants see the overlay?"
                  answer="No. The Windows DWM API (WDA_EXCLUDEFROMCAPTURE) tells the OS compositor to completely exclude the overlay from all DXGI-based capture pipelines. Zoom, Teams, Discord, OBS — none of them can see it. Only your physical monitor displays it."
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
                <strong>New here?</strong> Start with the{' '}
                <a href="/guides/setup" style={{ color: 'var(--color-cyan)' }}>Setup Guide</a>{' '}
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
