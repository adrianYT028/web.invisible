/* ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ
   INVISIBLE AI ΓÇö JavaScript
   ES6 Classes ┬╖ Constraint Validation ┬╖ IntersectionObserver
   ΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉΓòÉ */

const SUPABASE_URL = 'https://kqyezzrlvtzbfenfqvau.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtxeWV6enJsdnR6YmZlbmZxdmF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MDMwNzgsImV4cCI6MjA4OTA3OTA3OH0.JeDliElsw_a6F-kvspqII3Nub3fUvjkgkv0Xm0mjPD8';

let supabaseClient = null;
function getSupabase() {
  if (!supabaseClient) {
    if (!window.supabase) {
      throw new Error('Supabase client library not loaded');
    }
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabaseClient;
}

async function requireAuth() {
  const sb = getSupabase();
  const { data, error } = await sb.auth.getSession();
  if (error || !data?.session) {
    window.location.href = '/login/';
    return false;
  }
  return true;
}

async function ensureSignupRecord() {
  const sb = getSupabase();
  const { data } = await sb.auth.getSession();
  const user = data?.session?.user;
  if (!user) return;

  const name = (user.user_metadata?.full_name || user.user_metadata?.name || user.email || '').split('@')[0];
  const email = (user.email || '').toLowerCase();
  if (!email) return;

  await sb
    .from('signups')
    .upsert({
      name: name || 'User',
      email,
      user_id: user.id
    }, { onConflict: 'email' });
}

async function bindLogout() {
  const btn = document.getElementById('logoutBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      const sb = getSupabase();
      await sb.auth.signOut();
    } finally {
      document.cookie = 'sb_access_token=; Max-Age=0; Path=/; SameSite=Lax';
      window.location.href = '/login/';
    }
  });
}

/**
 * ReviewForm
 * Captures rating + qualitative feedback with email for follow-up.
 */
class ReviewForm {
  #form;
  #email;
  #ratingInputs;
  #ratingLabels;
  #message;
  #button;
  #errorEl;

  constructor(formSelector) {
    this.#form     = document.querySelector(formSelector);
    this.#email    = this.#form.querySelector('input[type="email"]');
    this.#ratingInputs = Array.from(this.#form.querySelectorAll('input[name="rating"]'));
    this.#ratingLabels = Array.from(this.#form.querySelectorAll('.rating-group label'));
    this.#message  = this.#form.querySelector('textarea[name="review"]');
    this.#button   = this.#form.querySelector('.submit-btn');
    this.#errorEl  = this.#form.querySelector('.form-error');
    this.#bind();
    this.#prefillEmail();
  }

  #bind() {
    this.#form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.#handleSubmit();
    });

    [this.#email, this.#message].forEach((field) => {
      field.addEventListener('input', () => this.#clearError());
      field.addEventListener('change', () => this.#clearError());
    });

    this.#ratingInputs.forEach((input) => {
      input.addEventListener('change', () => {
        this.#clearError();
        this.#syncStars(input.value);
      });
      input.addEventListener('focus', () => this.#clearError());
    });

    this.#ratingLabels.forEach((label) => {
      label.addEventListener('mouseenter', () => this.#syncStars(label.dataset.value));
      label.addEventListener('mouseleave', () => this.#syncStars(this.#getRating()));
      label.addEventListener('focus', () => this.#syncStars(label.dataset.value));
      label.addEventListener('blur', () => this.#syncStars(this.#getRating()));
    });

    this.#syncStars(this.#getRating());
  }

  #validate() {
    var selectedRating = this.#getRating();
    if (!selectedRating) {
      this.#showError('Add a rating so we know severity.');
      return false;
    }

    if (this.#message.value.trim().length < 7) {
      this.#showError('Please add a few details (at least 7 characters).');
      return false;
    }

    return true;
  }

  async #prefillEmail() {
    try {
      const sb = getSupabase();
      const { data } = await sb.auth.getSession();
      const email = data?.session?.user?.email || '';
      if (email) {
        this.#email.value = email;
      }
    } catch {
      // ignore prefill failures
    }
  }

  #showError(message) {
    this.#errorEl.textContent = message;
    this.#form.classList.add('has-error');
  }

  #clearError() {
    this.#errorEl.textContent = '';
    this.#form.classList.remove('has-error');
  }

  async #handleSubmit() {
    this.#clearError();

    if (!this.#validate()) {
      return;
    }

    var selectedRating = this.#getRating();

    this.#button.classList.add('is-loading');
    this.#button.disabled = true;

    try {
      await this.#submitReview({
        email: this.#email.value,
        rating: selectedRating,
        review: this.#message.value.trim(),
      });

      this.#button.classList.remove('is-loading');
      this.#button.classList.add('is-success');

      setTimeout(() => {
        this.#button.classList.remove('is-success');
        this.#button.disabled = false;
        this.#form.reset();
        this.#syncStars('');
      }, 2500);
    } catch {
      this.#button.classList.remove('is-loading');
      this.#button.disabled = false;
      this.#showError('Could not save your review. Please try again.');
    }
  }

  async #submitReview(payload) {
    const sb = getSupabase();
    const { data } = await sb.auth.getSession();
    const user = data?.session?.user;
    if (!user?.id || !user?.email) {
      throw new Error('You must be signed in to submit feedback.');
    }

    const { error } = await sb
      .from('reviews')
      .insert({
        email: user.email.toLowerCase(),
        user_id: user.id,
        rating: Number(payload.rating),
        review: payload.review,
        source: 'review'
      });
    if (error) throw new Error(error.message || 'Something went wrong.');
  }

  #getRating() {
    var checked = this.#ratingInputs.find((input) => input.checked);
    return checked ? checked.value : '';
  }

  #syncStars(value) {
    var target = Number(value || 0);
    this.#ratingLabels.forEach((label) => {
      var starValue = Number(label.dataset.value || 0);
      if (starValue <= target) {
        label.classList.add('active');
      } else {
        label.classList.remove('active');
      }
    });
  }
}


/**
 * ScrollReveal
 * Uses IntersectionObserver for varied animation types on scroll.
 */
class ScrollReveal {
  #observer;

  constructor(selectors = ['.fade-in-up', '.fade-in-left', '.fade-in-right', '.scale-in', '.section-divider'], threshold = 0.15) {
    this.#observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            this.#observer.unobserve(entry.target);
          }
        });
      },
      { threshold }
    );

    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        this.#observer.observe(el);
      });
    });
  }
}


/**
 * ParticleField
 * Renders floating cyan dots on a <canvas> for atmosphere.
 * Lightweight ΓÇö uses requestAnimationFrame with throttling.
 */
class ParticleField {
  #canvas;
  #ctx;
  #particles;
  #animId;
  #width;
  #height;

  constructor(canvasSelector, count = 40) {
    this.#canvas = document.querySelector(canvasSelector);
    if (!this.#canvas) return;
    this.#ctx = this.#canvas.getContext('2d');
    this.#particles = [];
    this.#animId = null;
    this.#resize();
    this.#init(count);
    this.#bindResize();
    this.#animate();
  }

  #resize() {
    this.#width = this.#canvas.width = window.innerWidth;
    this.#height = this.#canvas.height = window.innerHeight;
  }

  #bindResize() {
    let timeout;
    window.addEventListener('resize', () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => this.#resize(), 200);
    });
  }

  #init(count) {
    this.#particles = Array.from({ length: count }, () => ({
      x: Math.random() * this.#width,
      y: Math.random() * this.#height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      radius: Math.random() * 1.5 + 0.5,
      alpha: Math.random() * 0.3 + 0.1,
    }));
  }

  #animate() {
    this.#ctx.clearRect(0, 0, this.#width, this.#height);

    for (const p of this.#particles) {
      p.x += p.vx;
      p.y += p.vy;

      // Wrap around edges
      if (p.x < 0) p.x = this.#width;
      if (p.x > this.#width) p.x = 0;
      if (p.y < 0) p.y = this.#height;
      if (p.y > this.#height) p.y = 0;

      this.#ctx.beginPath();
      this.#ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      this.#ctx.fillStyle = `rgba(0, 242, 255, ${p.alpha})`;
      this.#ctx.fill();
    }

    this.#animId = requestAnimationFrame(() => this.#animate());
  }

  stop() {
    if (this.#animId) cancelAnimationFrame(this.#animId);
  }
}


/**
 * CardGlow
 * Tracks mouse position on cards and sets CSS custom properties
 * for the radial glow follow effect.
 */
class CardGlow {
  constructor(selector) {
    document.querySelectorAll(selector).forEach((card) => {
      card.addEventListener('mousemove', (e) => {
        const rect = card.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        card.style.setProperty('--mouse-x', `${x}%`);
        card.style.setProperty('--mouse-y', `${y}%`);
      });
    });
  }
}


/* ΓöÇΓöÇ Initialize ΓöÇΓöÇ */
document.addEventListener('DOMContentLoaded', () => {
  requireAuth().then((ok) => {
    if (!ok) return;
    const reviewForm = new ReviewForm('#reviewForm');
    bindLogout();
    ensureSignupRecord();

    // Floating particle background
    const particles = new ParticleField('#particles', 45);

    // Mouse-tracking glow on feature cards
    const cardGlow = new CardGlow('.feature-card');

    // Tag animatable elements with varied animation types
    const animConfigs = [
      { selector: '.section-tag',     cls: 'fade-in-up',   baseDelay: 0 },
      { selector: '.section-title',   cls: 'fade-in-up',   baseDelay: 80 },
      { selector: '.section-sub',     cls: 'fade-in-up',   baseDelay: 160 },
      { selector: '.feature-card',    cls: 'fade-in-up',   baseDelay: 0, stagger: 120 },
      { selector: '.step-card',       cls: 'fade-in-up',   baseDelay: 0, stagger: 150 },
      { selector: '.tech-note',       cls: 'scale-in',     baseDelay: 200 },
      { selector: '.review-form',     cls: 'scale-in',     baseDelay: 80 },
      { selector: '.notify-form',     cls: 'scale-in',     baseDelay: 100 },
    ];

    animConfigs.forEach(({ selector, cls, baseDelay, stagger = 0 }) => {
      document.querySelectorAll(selector).forEach((el, i) => {
        el.classList.add(cls);
        el.style.transitionDelay = `${baseDelay + i * stagger}ms`;
      });
    });

    const scrollReveal = new ScrollReveal();
  });
});
