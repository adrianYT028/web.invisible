/* ═══════════════════════════════════════════════════
   INVISIBLE AI — JavaScript
   ES6 Classes · Constraint Validation · IntersectionObserver
   ═══════════════════════════════════════════════════ */

/**
 * LaunchCountdown
 * Encapsulates all countdown timer logic.
 * Calculates remaining time from a fixed target date.
 */
class LaunchCountdown {
  #targetDate;
  #elements;
  #intervalId;

  constructor(targetDateISO, containerSelector) {
    this.#targetDate = new Date(targetDateISO).getTime();
    const container = document.querySelector(containerSelector);
    this.#elements = {
      days:    container.querySelector('[data-unit="days"]'),
      hours:   container.querySelector('[data-unit="hours"]'),
      minutes: container.querySelector('[data-unit="minutes"]'),
      seconds: container.querySelector('[data-unit="seconds"]'),
    };
    this.#intervalId = null;
  }

  #pad(value) {
    return String(value).padStart(2, '0');
  }

  #calculateRemaining() {
    const now = Date.now();
    const diff = this.#targetDate - now;

    if (diff <= 0) {
      return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
    }

    const seconds = Math.floor(diff / 1000);
    return {
      days:    Math.floor(seconds / 86400),
      hours:   Math.floor((seconds % 86400) / 3600),
      minutes: Math.floor((seconds % 3600) / 60),
      seconds: seconds % 60,
      expired: false,
    };
  }

  #render(time) {
    this.#elements.days.textContent    = this.#pad(time.days);
    this.#elements.hours.textContent   = this.#pad(time.hours);
    this.#elements.minutes.textContent = this.#pad(time.minutes);
    this.#elements.seconds.textContent = this.#pad(time.seconds);
  }

  start() {
    // Render immediately to avoid flash of "00"
    this.#render(this.#calculateRemaining());

    this.#intervalId = setInterval(() => {
      const time = this.#calculateRemaining();
      this.#render(time);

      if (time.expired) {
        this.stop();
      }
    }, 1000);
  }

  stop() {
    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
  }
}


/**
 * NotifyForm
 * Handles subscription form with Constraint Validation API,
 * loading state, success micro-animation, and Google Sheets storage.
 */
class NotifyForm {
  #form;
  #input;
  #button;
  #errorEl;
  #endpoint;

  /**
   * @param {string} formSelector  — CSS selector for the form
   * @param {string} endpoint      — Google Apps Script web app URL
   */
  constructor(formSelector, endpoint) {
    this.#form     = document.querySelector(formSelector);
    this.#input    = this.#form.querySelector('input[type="email"]');
    this.#button   = this.#form.querySelector('.submit-btn');
    this.#errorEl  = this.#form.querySelector('.form-error');
    this.#endpoint = endpoint;
    this.#bind();
  }

  #bind() {
    this.#form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.#handleSubmit();
    });

    // Clear error on input
    this.#input.addEventListener('input', () => {
      this.#clearError();
    });
  }

  #validate() {
    // Use Constraint Validation API
    if (this.#input.validity.valueMissing) {
      this.#showError('Email address is required.');
      return false;
    }
    if (this.#input.validity.typeMismatch) {
      this.#showError('Please enter a valid email address.');
      return false;
    }
    return true;
  }

  #showError(message) {
    this.#errorEl.textContent = message;
    this.#input.closest('.input-wrapper').classList.add('has-error');
  }

  #clearError() {
    this.#errorEl.textContent = '';
    this.#input.closest('.input-wrapper').classList.remove('has-error');
  }

  async #handleSubmit() {
    this.#clearError();

    if (!this.#validate()) {
      return;
    }

    // Enter loading state
    this.#button.classList.add('is-loading');
    this.#button.disabled = true;

    try {
      await this.#submitEmail(this.#input.value);

      // Exit loading → success
      this.#button.classList.remove('is-loading');
      this.#button.classList.add('is-success');

      // Reset after animation
      setTimeout(() => {
        this.#button.classList.remove('is-success');
        this.#button.disabled = false;
        this.#input.value = '';
      }, 2500);
    } catch {
      this.#button.classList.remove('is-loading');
      this.#button.disabled = false;
      this.#showError('Something went wrong. Please try again.');
    }
  }

  async #submitEmail(email) {
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, timestamp: new Date().toISOString() }),
    });
    // no-cors means response is opaque, so we trust it went through
    return response;
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
 * Lightweight — uses requestAnimationFrame with throttling.
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


/* ── Initialize ── */
document.addEventListener('DOMContentLoaded', () => {
  // Set target date to 5 days from today for the countdown
  const target = new Date();
  target.setDate(target.getDate() + 5);
  const targetISO = target.toISOString();

  const countdown = new LaunchCountdown(targetISO, '#countdown');
  countdown.start();

  const SHEETS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwZRZm6f3eCuYf1lIF2_nJPwEDrddccpzmbbpSksyhL4eFjDTX-SLjQpDN8SIE4fkR5/exec';

  const notifyForm = new NotifyForm('#notifyForm', SHEETS_ENDPOINT);

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
