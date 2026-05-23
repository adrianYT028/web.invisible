/**
 * Pure-TypeScript physics module for the hero antigravity layer.
 *
 * Contract:
 * - This module is a pure function library. It MUST NOT touch the DOM, MUST
 *   NOT call `Math.random`, and MUST NOT reference time (no `Date.now`,
 *   `performance.now`, `requestAnimationFrame`, timers, etc.). Every input
 *   the math depends on is passed in explicitly via function parameters.
 * - Every exported function is total over finite numeric inputs, never
 *   throws, and returns new values rather than mutating its arguments. All
 *   data shapes use `readonly` fields so accidental mutation is a type
 *   error.
 * - Velocities are expressed in pixels-per-frame at a notional 60 FPS
 *   fixed-step integrator. Positions are in hero-local CSS pixel
 *   coordinates (origin at the hero element's top-left).
 * - Invalid inputs (`NaN`, `Infinity`, inverted bounds) are out of contract.
 *   The React shell that calls this module is responsible for screening
 *   them; given valid inputs, this module's invariants (bounded velocity,
 *   in-bounds position, etc.) hold.
 *
 * The split between this module and `HeroAntigravity.tsx` is deliberate:
 * keeping the per-frame math side-effect free is what makes the feature
 * exhaustively property-testable without a browser.
 */

/** A pure 2D vector in CSS pixels (hero-local coordinates). */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** One simulated mass: position and velocity, both in hero-local pixels. */
export interface Particle {
  readonly position: Vec2;
  readonly velocity: Vec2;
}

/**
 * The full simulation state. Particle order is significant: the React layer
 * pairs `state.particles[i]` with the i-th DOM element ref.
 */
export interface PhysicsState {
  readonly particles: ReadonlyArray<Particle>;
}

/**
 * Cursor position plus an `inside` flag. When `inside` is `false`, the
 * physics module emits zero repulsion force so particles coast to a stop
 * under damping (this is what lets the cursor-leaves-viewport behavior work
 * without storing a stale "last seen" timestamp).
 */
export interface CursorState {
  readonly position: Vec2;
  readonly inside: boolean;
}

/**
 * Pre-computed clamp limits in hero-local coordinates. The React layer
 * subtracts both the edge padding and the per-element size up front so this
 * module can clamp directly without knowing about element radius.
 *
 * Invariant (caller-enforced): `minX < maxX` and `minY < maxY`.
 */
export interface Bounds {
  /** = edgePadding */
  readonly minX: number;
  /** = heroWidth - edgePadding - elementSize */
  readonly maxX: number;
  /** = edgePadding */
  readonly minY: number;
  /** = heroHeight - edgePadding - elementSize */
  readonly maxY: number;
}

/** Tuning knobs for the integrator. */
export interface PhysicsConfig {
  /** Cursor influence radius in CSS pixels. */
  readonly repulsionRadius: number;
  /** Peak repulsion strength (force at distance = 0, before clamping). */
  readonly repulsionStrength: number;
  /** Per-frame velocity damping factor in `[0, 1)`. */
  readonly damping: number;
  /** Maximum velocity magnitude in pixels-per-frame; must be > 0. */
  readonly maxVelocity: number;
  /** Boundary bounce coefficient in `(0, 1]`. */
  readonly bounceCoefficient: number;
}

// ---------------------------------------------------------------------------
// Internal constants and helpers
// ---------------------------------------------------------------------------

/**
 * Distance under which two particles influence each other via inter-element
 * repulsion. Kept small relative to `PhysicsConfig.repulsionRadius` so most
 * particle pairs are non-interacting by default — this is what makes the
 * isolation property (P9) hold for normally-spaced layouts.
 */
const INTER_ELEMENT_RADIUS = 80;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the repulsion force on a particle from a cursor. Returns the zero
 * vector when the cursor is outside `radius` or coincident with the particle
 * (direction undefined at distance = 0).
 */
export function repulsion(
  particle: Vec2,
  cursor: Vec2,
  radius: number,
  strength: number,
): Vec2 {
  const dx = particle.x - cursor.x;
  const dy = particle.y - cursor.y;
  const distSq = dx * dx + dy * dy;
  if (distSq === 0) {
    return { x: 0, y: 0 };
  }
  const dist = Math.sqrt(distSq);
  if (dist >= radius) {
    return { x: 0, y: 0 };
  }
  // `max(dist, 1)` prevents the inverse-distance term from blowing up at
  // microscopic distances, which would otherwise let a single frame eject a
  // particle past the velocity cap before clamping kicks in.
  const forceMag = strength / Math.max(dist, 1);
  return {
    x: (dx / dist) * forceMag,
    y: (dy / dist) * forceMag,
  };
}

/** Cap a vector's magnitude at `max`. Returns the input if already within. */
export function clampVelocity(velocity: Vec2, max: number): Vec2 {
  const magSq = velocity.x * velocity.x + velocity.y * velocity.y;
  const maxSq = max * max;
  if (magSq <= maxSq) {
    return velocity;
  }
  const scale = max / Math.sqrt(magSq);
  return {
    x: velocity.x * scale,
    y: velocity.y * scale,
  };
}

/**
 * Constrain a position to bounds and reflect velocity at any axis that hit,
 * scaling the perpendicular component by `bounceCoefficient`.
 */
export function applyBoundary(
  particle: Particle,
  bounds: Bounds,
  bounceCoefficient: number,
): Particle {
  let px = particle.position.x;
  let py = particle.position.y;
  let vx = particle.velocity.x;
  let vy = particle.velocity.y;

  if (px < bounds.minX) {
    px = bounds.minX;
    vx = -vx * bounceCoefficient;
  } else if (px > bounds.maxX) {
    px = bounds.maxX;
    vx = -vx * bounceCoefficient;
  }

  if (py < bounds.minY) {
    py = bounds.minY;
    vy = -vy * bounceCoefficient;
  } else if (py > bounds.maxY) {
    py = bounds.maxY;
    vy = -vy * bounceCoefficient;
  }

  return {
    position: { x: px, y: py },
    velocity: { x: vx, y: vy },
  };
}

/**
 * Shared Euler integration kernel: combine the current velocity with an
 * external force, apply damping, clamp magnitude, advance position, then
 * fold in boundary handling. Used by both `stepParticle` (cursor only) and
 * `step` (cursor + inter-element).
 */
function integrate(
  particle: Particle,
  force: Vec2,
  bounds: Bounds,
  config: PhysicsConfig,
): Particle {
  const combinedVelocity: Vec2 = {
    x: (particle.velocity.x + force.x) * config.damping,
    y: (particle.velocity.y + force.y) * config.damping,
  };
  const nextVelocity = clampVelocity(combinedVelocity, config.maxVelocity);
  const unbounded: Particle = {
    position: {
      x: particle.position.x + nextVelocity.x,
      y: particle.position.y + nextVelocity.y,
    },
    velocity: nextVelocity,
  };
  return applyBoundary(unbounded, bounds, config.bounceCoefficient);
}

/**
 * One Euler integration step:
 *   velocity' = clampVelocity((velocity + force) * damping, maxVelocity)
 *   position' = applyBoundary(position + velocity').
 * Force is the cursor repulsion only (gravity = 0). Force is zero when
 * `cursor.inside === false`.
 */
export function stepParticle(
  particle: Particle,
  cursor: CursorState,
  bounds: Bounds,
  config: PhysicsConfig,
): Particle {
  const force: Vec2 = cursor.inside
    ? repulsion(
        particle.position,
        cursor.position,
        config.repulsionRadius,
        config.repulsionStrength,
      )
    : { x: 0, y: 0 };
  return integrate(particle, force, bounds, config);
}

/**
 * Multi-particle step: each particle integrates against the cursor and,
 * when there are siblings, against an inter-element repulsion. Always
 * returns a state with the same particle count as the input.
 */
export function step(
  state: PhysicsState,
  cursor: CursorState,
  bounds: Bounds,
  config: PhysicsConfig,
): PhysicsState {
  const particles = state.particles;
  const n = particles.length;
  const next: Particle[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const p = particles[i];
    const cursorForce: Vec2 = cursor.inside
      ? repulsion(
          p.position,
          cursor.position,
          config.repulsionRadius,
          config.repulsionStrength,
        )
      : { x: 0, y: 0 };

    let fx = cursorForce.x;
    let fy = cursorForce.y;

    if (n > 1) {
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const interForce = repulsion(
          p.position,
          particles[j].position,
          INTER_ELEMENT_RADIUS,
          config.repulsionStrength,
        );
        fx += interForce.x;
        fy += interForce.y;
      }
    }

    next[i] = integrate(p, { x: fx, y: fy }, bounds, config);
  }

  return { particles: next };
}
