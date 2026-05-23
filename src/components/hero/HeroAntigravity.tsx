'use client';

/**
 * HeroAntigravity — cursor-repelled mass layer for the hero.
 *
 * Where `HeroSpotlight` paints a soft glow that tracks the cursor (light
 * follows the pointer), `HeroAntigravity` is the visual inverse: a small
 * decorative mass that *runs away* from the cursor with simulated
 * momentum. The two layers read together as cause and effect — light
 * follows the cursor, matter dodges it.
 *
 * The implementation is intentionally split in two:
 *
 *   1. This file — the React shell. Owns mount, capability gates,
 *      `pointermove`/`pointerleave` listeners, the `requestAnimationFrame`
 *      loop, the `IntersectionObserver`/`ResizeObserver` lifecycle, and
 *      cleanup. It writes positions directly to the DOM via
 *      `style.transform = translate3d(...)` so the rAF loop never
 *      schedules a React re-render after mount.
 *
 *   2. `./antigravity-physics` — a pure TypeScript module. Owns every
 *      per-frame calculation (force, integration, damping, clamping,
 *      bounce). It is exhaustively property-tested in node without any
 *      DOM dependency. The split is what makes the feature testable and
 *      keeps the React side thin.
 *
 * Capability gates mirror `HeroSpotlight` for consistency and add the
 * Req-10.1 viewport-width gate:
 *
 *   - `prefers-reduced-motion: reduce` → element renders in its rest
 *     position with no listeners and no rAF (Req 7.1, 7.2).
 *   - `hover: none` (touch-primary devices) → same static fallback.
 *   - `window.innerWidth < 768` → component returns `null` so the DOM
 *     contains no antigravity nodes on phones at all (Req 10.1).
 *
 * Stacking is owned by DOM order: the wrapper `<div>` is mounted *after*
 * `<HeroSpotlight />` and *before* `<div className="hero-content">` in
 * `HeroSection`, so the painter's algorithm puts the mass on top of the
 * spotlight glow and behind the headline + CTAs. No CSS z-index changes
 * to the existing two layers are required (Req 1.3).
 *
 * Props are normalized once at mount inside a `useMemo`. Out-of-range
 * numeric inputs fall back to defaults and emit a development-only
 * `console.warn`; the rAF loop only ever sees clean numbers, which is
 * what makes the physics module's invariants (bounded velocity,
 * in-bounds position) hold.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  step,
  type Bounds,
  type CursorState,
  type Particle,
  type PhysicsConfig,
  type PhysicsState,
} from './antigravity-physics';

/**
 * Per-element visual configuration. The component renders one `<div>` per
 * entry up to `HeroAntigravityProps.count`; missing entries fall back to
 * the defaults below.
 */
export interface HeroAntigravityElementStyle {
  /** CSS pixel diameter of the element. Default 12. Clamped to (0, 256]. */
  size?: number;
  /**
   * CSS color override. When provided, it is forwarded as a `--accent`
   * custom property on the element so the radial-gradient background
   * declared in `globals.css` picks it up via `var(--accent)`. Default
   * `var(--accent)` (the design-system token).
   */
  color?: string;
  /** Final layer opacity, clamped to [0, 1]. Default 0.75. */
  opacity?: number;
}

/** Props for the antigravity layer. All fields are optional. */
export interface HeroAntigravityProps {
  /** Number of independent elements. Default 1. Clamped to [1, 16]. (Req 9) */
  count?: number;
  /** Repulsion radius in CSS pixels. Default 300. (Req 3.1) */
  repulsionRadius?: number;
  /** Repulsion peak strength (force at distance = 0). Default tuned visually. (Req 3.1) */
  repulsionStrength?: number;
  /** Velocity damping factor per frame, [0.5..0.999]. Default 0.94. (Req 3.3) */
  damping?: number;
  /** Maximum velocity magnitude in px/frame. Default 6. (Req 3.4) */
  maxVelocity?: number;
  /** Inset from hero edges in CSS pixels. Default 20. (Req 4.4) */
  edgePadding?: number;
  /** Bounce coefficient applied at boundary collision, (0..1]. Default 0.6. (Req 4.3) */
  bounceCoefficient?: number;
  /** Per-element visual config, indexed up to `count`. (Req 9.4) */
  elements?: ReadonlyArray<HeroAntigravityElementStyle>;
}

// ---------------------------------------------------------------------------
// Defaults — kept in one place so the docblocks above and the runtime
// fallbacks below cannot drift.
// ---------------------------------------------------------------------------

const DEFAULT_COUNT = 1;
const DEFAULT_REPULSION_RADIUS = 300;
const DEFAULT_REPULSION_STRENGTH = 280;
const DEFAULT_DAMPING = 0.94;
const DEFAULT_MAX_VELOCITY = 6;
const DEFAULT_EDGE_PADDING = 20;
const DEFAULT_BOUNCE_COEFFICIENT = 0.6;

// Particles render as small glowing points (constellation feel) rather
// than large blurred blobs — the soft outer glow comes from the layered
// `box-shadow` stack in `globals.css`, so the element itself can be tiny
// and still read as ambient light.
const DEFAULT_ELEMENT_SIZE = 12;
const DEFAULT_ELEMENT_COLOR = 'var(--accent)';
// Higher default opacity to compensate for the smaller footprint — the
// box-shadow glow does most of the visual work, so the core can be
// brighter without dominating the hero.
const DEFAULT_ELEMENT_OPACITY = 0.75;

const COUNT_MIN = 1;
const COUNT_MAX = 16;
// Floor stays at 0.5 so the prop validator keeps a wide acceptable range,
// but the typical band for a smooth, fluid feel is 0.9–0.97 — anything
// below that decays kinetic energy too quickly and the layer reads as
// jittery rather than flowing. Default sits at 0.94.
const DAMPING_MIN = 0.5;
const DAMPING_MAX = 0.999;
const SIZE_MAX = 256;
const MOBILE_BREAKPOINT = 768;

// ---------------------------------------------------------------------------
// Normalized config shape consumed by the component body and (in the
// follow-up task) the physics module.
// ---------------------------------------------------------------------------

interface NormalizedElementStyle {
  readonly size: number;
  readonly color: string;
  /** True when the caller supplied a non-default color (drives the inline
   *  `--accent` override; left out otherwise so the CSS default applies). */
  readonly hasColorOverride: boolean;
  readonly opacity: number;
}

interface NormalizedConfig {
  readonly count: number;
  readonly repulsionRadius: number;
  readonly repulsionStrength: number;
  readonly damping: number;
  readonly maxVelocity: number;
  readonly edgePadding: number;
  readonly bounceCoefficient: number;
  readonly elements: ReadonlyArray<NormalizedElementStyle>;
}

// ---------------------------------------------------------------------------
// Validation helpers. Each returns `null` when the input is unusable so the
// caller can fall back to the default and emit a single warning per prop.
// ---------------------------------------------------------------------------

const isDev =
  typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

function warnDev(message: string): void {
  if (isDev) {
    // eslint-disable-next-line no-console
    console.warn(`[HeroAntigravity] ${message}`);
  }
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizeFinitePositive(
  raw: number | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined) return fallback;
  if (!isFinitePositive(raw)) {
    warnDev(`${label} must be a finite positive number; falling back to ${fallback}.`);
    return fallback;
  }
  return raw;
}

function normalizeCount(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_COUNT;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    warnDev(`count must be a finite integer; falling back to ${DEFAULT_COUNT}.`);
    return DEFAULT_COUNT;
  }
  const rounded = Math.round(raw);
  const clamped = clamp(rounded, COUNT_MIN, COUNT_MAX);
  if (clamped !== raw) {
    warnDev(
      `count ${raw} is outside [${COUNT_MIN}, ${COUNT_MAX}]; clamped to ${clamped}.`,
    );
  }
  return clamped;
}

function normalizeDamping(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_DAMPING;
  if (!Number.isFinite(raw as number)) {
    warnDev(`damping must be finite; falling back to ${DEFAULT_DAMPING}.`);
    return DEFAULT_DAMPING;
  }
  const clamped = clamp(raw as number, DAMPING_MIN, DAMPING_MAX);
  if (clamped !== raw) {
    warnDev(
      `damping ${raw} is outside [${DAMPING_MIN}, ${DAMPING_MAX}]; clamped to ${clamped}.`,
    );
  }
  return clamped;
}

function normalizeBounceCoefficient(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_BOUNCE_COEFFICIENT;
  if (!Number.isFinite(raw as number)) {
    warnDev(
      `bounceCoefficient must be finite; falling back to ${DEFAULT_BOUNCE_COEFFICIENT}.`,
    );
    return DEFAULT_BOUNCE_COEFFICIENT;
  }
  // Open-low, closed-high interval (0, 1]. Use a tiny floor so 0 (which would
  // freeze a particle on bounce) is excluded.
  const lo = 1e-3;
  const clamped = clamp(raw as number, lo, 1);
  if (clamped !== raw) {
    warnDev(`bounceCoefficient ${raw} is outside (0, 1]; clamped to ${clamped}.`);
  }
  return clamped;
}

function normalizeEdgePadding(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_EDGE_PADDING;
  if (!isFiniteNonNegative(raw)) {
    warnDev(
      `edgePadding must be a finite non-negative number; falling back to ${DEFAULT_EDGE_PADDING}.`,
    );
    return DEFAULT_EDGE_PADDING;
  }
  return raw;
}

function normalizeOpacity(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_ELEMENT_OPACITY;
  if (!Number.isFinite(raw as number)) {
    warnDev(
      `elements[].opacity must be finite; falling back to ${DEFAULT_ELEMENT_OPACITY}.`,
    );
    return DEFAULT_ELEMENT_OPACITY;
  }

  const clamped = clamp(raw as number, 0, 1);
  if (clamped !== raw) {
    warnDev(`elements[].opacity ${raw} is outside [0, 1]; clamped to ${clamped}.`);
  }
  return clamped;
}

function normalizeSize(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_ELEMENT_SIZE;
  if (!isFinitePositive(raw)) {
    warnDev(
      `elements[].size must be a finite positive number; falling back to ${DEFAULT_ELEMENT_SIZE}.`,
    );
    return DEFAULT_ELEMENT_SIZE;
  }
  const clamped = clamp(raw, 1, SIZE_MAX);
  if (clamped !== raw) {
    warnDev(`elements[].size ${raw} is outside (0, ${SIZE_MAX}]; clamped to ${clamped}.`);
  }
  return clamped;
}

function normalizeElementStyle(
  raw: HeroAntigravityElementStyle | undefined,
): NormalizedElementStyle {
  const hasColorOverride =
    typeof raw?.color === 'string' && raw.color.length > 0;
  return {
    size: normalizeSize(raw?.size),
    color: hasColorOverride ? raw!.color! : DEFAULT_ELEMENT_COLOR,
    hasColorOverride,
    opacity: normalizeOpacity(raw?.opacity),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HeroAntigravity(props: HeroAntigravityProps) {
  const {
    count: rawCount,
    repulsionRadius: rawRepulsionRadius,
    repulsionStrength: rawRepulsionStrength,
    damping: rawDamping,
    maxVelocity: rawMaxVelocity,
    edgePadding: rawEdgePadding,
    bounceCoefficient: rawBounceCoefficient,
    elements: rawElements,
  } = props;

  const config = useMemo<NormalizedConfig>(() => {
    const count = normalizeCount(rawCount);
    const elements: NormalizedElementStyle[] = new Array(count);
    for (let i = 0; i < count; i++) {
      elements[i] = normalizeElementStyle(rawElements?.[i]);
    }
    return {
      count,
      repulsionRadius: normalizeFinitePositive(
        rawRepulsionRadius,
        DEFAULT_REPULSION_RADIUS,
        'repulsionRadius',
      ),
      repulsionStrength: normalizeFinitePositive(
        rawRepulsionStrength,
        DEFAULT_REPULSION_STRENGTH,
        'repulsionStrength',
      ),
      damping: normalizeDamping(rawDamping),
      maxVelocity: normalizeFinitePositive(
        rawMaxVelocity,
        DEFAULT_MAX_VELOCITY,
        'maxVelocity',
      ),
      edgePadding: normalizeEdgePadding(rawEdgePadding),
      bounceCoefficient: normalizeBounceCoefficient(rawBounceCoefficient),
      elements,
    };
  }, [
    rawCount,
    rawRepulsionRadius,
    rawRepulsionStrength,
    rawDamping,
    rawMaxVelocity,
    rawEdgePadding,
    rawBounceCoefficient,
    rawElements,
  ]);

  // Refs declared here per the design's "Components and Interfaces" table.
  // The rAF loop and listener wiring populate these in the effect below.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const elementRefs = useRef<Array<HTMLDivElement | null>>([]);
  // Live physics state, last cursor reading, and the cached hero bounds.
  // All three are mutated by the rAF loop without ever calling `setState`,
  // so the loop never schedules a React re-render after mount.
  const stateRef = useRef<PhysicsState | null>(null);
  const cursorRef = useRef<CursorState | null>(null);
  const boundsRef = useRef<Bounds | null>(null);
  const frameRef = useRef<number | null>(null);

  // SSR-safe mount gate. The viewport-width check (Req 10.1) can only run on
  // the client, so we render `null` on the server and on the first client
  // render, then re-render after mount. This keeps the SSR markup and the
  // first client markup identical (no hydration mismatch) while still
  // honoring the < 768px gate.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // ---------------------------------------------------------------------
  // Antigravity wiring effect.
  //
  // Owns: capability gates (prefers-reduced-motion, hover: none), pointer
  // listeners on the hero element, the requestAnimationFrame loop, the
  // IntersectionObserver (pause/resume on viewport entry/exit), and the
  // ResizeObserver (refresh cached bounds on hero size change). Every
  // resource it acquires is released on cleanup.
  //
  // The hook order is preserved across all renders: the early returns
  // below (`!mounted`, `< 768px`) sit *after* every hook call, and we
  // bail inside the effect itself when `containerRef.current` is null —
  // that's the case where the component rendered `null` and there is no
  // DOM to operate on.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // The wrapper has not been committed to the DOM yet — first render
    // returned `null` because the SSR-safe mount gate has not flipped.
    // The effect re-runs once `mounted` is true (it's in the dep array),
    // at which point the wrapper exists and we can wire up everything.
    if (!mounted) return;

    const container = containerRef.current;
    if (!container) return; // component rendered null, nothing to wire up

    // The component is mounted as a child of `<section class="hero">`, so
    // its `parentElement` is the spotlight target. Bail defensively if not
    // present (matches the same pattern in HeroSpotlight).
    const hero = container.parentElement;
    if (!hero) return;

    // -----------------------------------------------------------------
    // Bounds: convert a hero rect into the clamp limits the physics
    // module expects. We subtract `edgePadding` from each axis and the
    // largest element size so the largest particle's *bottom-right*
    // corner stays inside the visible inset (CSS positions translate
    // from the element's top-left, so element extent is added on the
    // max side only). Returns `null` when the rect is zero-sized — the
    // rAF tick uses that to skip the frame entirely.
    // -----------------------------------------------------------------
    const maxElementSize = config.elements.reduce(
      (acc, e) => (e.size > acc ? e.size : acc),
      0,
    );

    const computeBounds = (rect: DOMRect): Bounds | null => {
      const w = rect.width;
      const h = rect.height;
      if (w === 0 || h === 0) return null;
      const minX = config.edgePadding;
      const minY = config.edgePadding;
      // `Math.max(minX, ...)` keeps the bounds non-inverted even when the
      // hero is briefly narrower than `2 * edgePadding + elementSize` —
      // the physics module's `minX <= maxX` invariant still holds.
      const maxX = Math.max(minX, w - config.edgePadding - maxElementSize);
      const maxY = Math.max(minY, h - config.edgePadding - maxElementSize);
      return { minX, maxX, minY, maxY };
    };

    // Seed bounds. If the hero is currently zero-sized we initialize a
    // collapsed bounds; the rAF loop refreshes on every tick and will
    // pick up real values as soon as the rect becomes non-zero.
    const initialBounds: Bounds =
      computeBounds(hero.getBoundingClientRect()) ?? {
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0,
      };
    boundsRef.current = initialBounds;

    // Seed deterministic initial positions so the first paint is stable
    // (no Math.random in this layer — keeps SSR/CSR markup identical and
    // lets tests pin specific outputs). Uses the R2 low-discrepancy
    // sequence (the 2D analog of the golden ratio, derived from the
    // plastic constant). Output looks scattered but covers the area
    // uniformly — far better than a grid for ambient particles, and
    // avoids the clustering the previous (i+0.5)/n + golden-ratio-on-y
    // seeding produced when count was small.
    const seedParticles = (bounds: Bounds): Particle[] => {
      const n = config.count;
      const out: Particle[] = new Array(n);
      // Plastic constant ρ ≈ 1.32471795724474602596. The R2 sequence uses
      // (1/ρ, 1/ρ²) as its irrational increments; together they produce
      // a 2D quasi-random sequence with provably low discrepancy.
      const g = 1.32471795724474602596;
      const a1 = 1 / g;
      const a2 = 1 / (g * g);
      const xRange = bounds.maxX - bounds.minX;
      const yRange = bounds.maxY - bounds.minY;
      for (let i = 0; i < n; i++) {
        const tx = (0.5 + a1 * (i + 1)) % 1;
        const ty = (0.5 + a2 * (i + 1)) % 1;
        out[i] = {
          position: {
            x: bounds.minX + tx * xRange,
            y: bounds.minY + ty * yRange,
          },
          velocity: { x: 0, y: 0 },
        };
      }
      return out;
    };

    const initialParticles = seedParticles(initialBounds);
    stateRef.current = { particles: initialParticles };

    // Cursor starts neutral and outside; the physics module emits zero
    // force when `inside === false`, so particles sit at rest until the
    // first pointermove flips the flag.
    cursorRef.current = {
      position: { x: 0, y: 0 },
      inside: false,
    };

    // Write rest positions to the DOM immediately. This both prevents a
    // flash of (0, 0) before the first rAF tick and serves as the static
    // fallback for the reduced-motion / no-hover case below.
    for (let i = 0; i < initialParticles.length; i++) {
      const el = elementRefs.current[i];
      if (el) {
        const { x, y } = initialParticles[i].position;
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
    }

    // -----------------------------------------------------------------
    // Capability gates. We check these *after* seeding rest positions so
    // that prefers-reduced-motion / touch-only users still see the
    // particles painted in their rest state — they just don't get the
    // physics, the listeners, or the rAF loop. (Req 7.1, 7.2, 10.2.)
    // -----------------------------------------------------------------
    const matchMedia =
      typeof window.matchMedia === 'function' ? window.matchMedia : null;
    const reduced = matchMedia
      ? matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
    const noHover = matchMedia ? matchMedia('(hover: none)').matches : false;
    if (reduced || noHover) {
      // Static fallback: no listeners, no rAF, no observers. Returning
      // `undefined` here means React has no cleanup function to call,
      // which is exactly right because we did not acquire any resources.
      return;
    }

    // -----------------------------------------------------------------
    // Build the PhysicsConfig the pure module consumes. Only the
    // simulation-relevant fields make it through — `count`, `edgePadding`,
    // and the per-element styling stay in the React layer.
    // -----------------------------------------------------------------
    const physicsConfig: PhysicsConfig = {
      repulsionRadius: config.repulsionRadius,
      repulsionStrength: config.repulsionStrength,
      damping: config.damping,
      maxVelocity: config.maxVelocity,
      bounceCoefficient: config.bounceCoefficient,
    };

    // -----------------------------------------------------------------
    // Pointer event handlers. Same pattern as HeroSpotlight: scope to
    // the hero element so we get free hit-testing through the rest of
    // the page. `passive: true` on pointermove because we never call
    // preventDefault — this lets the browser optimise scroll handling.
    // -----------------------------------------------------------------
    const onPointerMove = (event: PointerEvent) => {
      // Touch devices: only honor the first (primary) touch point.
      // Hybrid devices (touch + mouse) hit this branch when a finger is
      // down; pure-touch phones never get here because the `hover: none`
      // gate above already returned. (Req 10.3, 10.4.)
      if (event.pointerType === 'touch' && !event.isPrimary) return;

      const rect = hero.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      cursorRef.current = {
        position: {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        },
        inside: true,
      };
    };

    const onPointerLeave = () => {
      // Retain the last known position (Req 2.3) — the physics module
      // emits zero force when `inside` is false regardless of where
      // `position` is, so the value here is purely informational.
      const previous = cursorRef.current ?? {
        position: { x: 0, y: 0 },
        inside: false,
      };
      cursorRef.current = {
        position: previous.position,
        inside: false,
      };
    };

    hero.addEventListener('pointermove', onPointerMove, { passive: true });
    hero.addEventListener('pointerleave', onPointerLeave);

    // -----------------------------------------------------------------
    // requestAnimationFrame loop. The loop reads from refs only, never
    // from the React render path — `step()` returns a new state, we
    // mutate `stateRef.current` to it, and we write each particle's new
    // position to the DOM via `style.transform`. No setState ever fires.
    //
    // Ambient drift: after the deterministic physics step we add a tiny
    // per-particle sine-wave force directly to velocity. Each particle
    // gets unique phase offsets (derived from its index) so the drift
    // looks organic rather than synchronised, and the magnitude
    // (~0.08 px/frame) is small enough that cursor repulsion still
    // dominates when the cursor is near. The result: particles never
    // freeze at rest — there is always a slow, breathing motion, which
    // is what gives the layer its "constellation" feel.
    // -----------------------------------------------------------------
    let frameCount = 0;
    const tick = () => {
      const rect = hero.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        // Skip the frame: no math, no DOM writes. This handles the brief
        // zero-sized state during route transitions or orientation change.
        frameRef.current = requestAnimationFrame(tick);
        return;
      }

      const refreshed = computeBounds(rect);
      if (refreshed) {
        boundsRef.current = refreshed;
      }

      const cursor = cursorRef.current;
      const bounds = boundsRef.current;
      const state = stateRef.current;
      if (cursor && bounds && state) {
        const next = step(state, cursor, bounds, physicsConfig);

        // Ambient drift: tiny per-particle sine-wave force for organic
        // motion when the cursor isn't pushing the particle. Each
        // particle gets a unique phase based on its index so they drift
        // independently rather than moving in lockstep. Magnitude is
        // small (≈0.08 px/frame) so it never overrides the cursor
        // repulsion when the cursor is near.
        const driftedParticles = next.particles.map((p, i) => {
          const phaseX = frameCount * 0.008 + i * 1.7;
          const phaseY = frameCount * 0.006 + i * 2.3;
          const driftX = Math.sin(phaseX) * 0.08;
          const driftY = Math.cos(phaseY) * 0.08;
          return {
            position: p.position,
            velocity: {
              x: p.velocity.x + driftX,
              y: p.velocity.y + driftY,
            },
          };
        });

        stateRef.current = { particles: driftedParticles };

        for (let i = 0; i < driftedParticles.length; i++) {
          const el = elementRefs.current[i];
          if (el) {
            const { x, y } = driftedParticles[i].position;
            // Round to 2 decimal places to reduce GPU sub-pixel jitter
            // when the integrator produces long fractional positions.
            el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
          }
        }
      }

      frameCount++;
      frameRef.current = requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };

    const stopLoop = () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    // -----------------------------------------------------------------
    // IntersectionObserver: pause the rAF loop when the hero scrolls
    // out of view. The observer fires synchronously with the current
    // intersection state on `.observe()`, so the loop starts on its
    // own when the hero is initially visible. When `IntersectionObserver`
    // is unavailable (old browsers, some test environments), fall back
    // to running the loop unconditionally — the perf cost is acceptable.
    // (Req 5.1, 5.2.)
    // -----------------------------------------------------------------
    let intersectionObserver: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              startLoop();
            } else {
              stopLoop();
            }
          }
        },
        { threshold: 0 },
      );
      intersectionObserver.observe(hero);
    } else {
      startLoop();
    }

    // -----------------------------------------------------------------
    // ResizeObserver: refresh the cached bounds when the hero element
    // changes size (devtools open, font load, etc.). The rAF loop also
    // refreshes bounds on every tick as a defensive measure, but the
    // observer catches the change immediately. Falls back to a window
    // `resize` listener when ResizeObserver is unavailable.
    // -----------------------------------------------------------------
    const refreshBoundsFromHero = () => {
      const r = hero.getBoundingClientRect();
      const b = computeBounds(r);
      if (b) boundsRef.current = b;
    };

    let resizeObserver: ResizeObserver | null = null;
    let onWindowResize: (() => void) | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(refreshBoundsFromHero);
      resizeObserver.observe(hero);
    } else {
      onWindowResize = refreshBoundsFromHero;
      window.addEventListener('resize', onWindowResize);
    }

    // -----------------------------------------------------------------
    // Cleanup contract (mirrors HeroSpotlight). Every resource acquired
    // above is released here: rAF cancelled, listeners removed, both
    // observers disconnected, refs nulled out.
    // -----------------------------------------------------------------
    return () => {
      stopLoop();
      hero.removeEventListener('pointermove', onPointerMove);
      hero.removeEventListener('pointerleave', onPointerLeave);
      if (intersectionObserver) intersectionObserver.disconnect();
      if (resizeObserver) resizeObserver.disconnect();
      if (onWindowResize) window.removeEventListener('resize', onWindowResize);
      stateRef.current = null;
      cursorRef.current = null;
      boundsRef.current = null;
      frameRef.current = null;
    };
  }, [config, mounted]);

  if (!mounted) return null;

  // After mount we are guaranteed to be on the client; the `typeof window`
  // check is defensive but cheap, and matches the explicit form called for
  // by the task / Req 10.1.
  if (typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT) {
    return null;
  }

  return (
    <div ref={containerRef} className="hero-antigravity" aria-hidden="true">
      {config.elements.map((style, i) => {
        // CSS custom properties are not in React's `CSSProperties` type by
        // default, so we build the inline style object as a record and cast
        // once at the assignment site.
        const inlineStyle: Record<string, string | number> = {
          width: `${style.size}px`,
          height: `${style.size}px`,
          opacity: style.opacity,
        };
        if (style.hasColorOverride) {
          // Forward as `--accent` so the radial-gradient declared in
          // globals.css (which references `var(--accent)`) picks it up
          // without us needing to restate the gradient inline.
          inlineStyle['--accent'] = style.color;
        } else {
          // The CSS already paints the gradient via `var(--accent)`; we set
          // background-color too as a flat fallback for environments that
          // do not support `color-mix` / radial gradients.
          inlineStyle.backgroundColor = style.color;
        }
        return (
          <div
            key={i}
            ref={(node) => {
              elementRefs.current[i] = node;
            }}
            className="hero-antigravity__el"
            style={inlineStyle as React.CSSProperties}
          />
        );
      })}
    </div>
  );
}

export default HeroAntigravity;
