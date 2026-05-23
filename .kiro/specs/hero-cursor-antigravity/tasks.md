# Implementation Plan: Hero Cursor Antigravity

## Overview

This plan implements the antigravity layer in two halves: a pure-TypeScript physics module that can be exhaustively property-tested in node, and a thin React client island that owns DOM concerns (mount, listeners, `requestAnimationFrame`, cleanup, capability gates). The pure module is built and verified first so the React shell wires up against a tested foundation. CSS, component, and integration changes follow, then a final checkpoint confirms the home hero paints the new layer behind the headline.

Each task references the granular sub-requirements it satisfies, and each property test is annotated with the property number and the requirement clause it validates. Test sub-tasks are marked optional with `*` and can be skipped for faster MVP delivery.

## Tasks

- [x] 1. Set up testing infrastructure
  - [x] 1.1 Install testing dev dependencies and add Vitest configuration
    - Install `vitest`, `fast-check`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, and `jsdom` as dev dependencies
    - Add `"test": "vitest --run"` and `"test:watch": "vitest"` scripts to `package.json`
    - Create `vitest.config.ts` with `environment: 'jsdom'`, `globals: true`, and a path alias for `@/*` matching `tsconfig.json`
    - Create a test setup file (e.g., `vitest.setup.ts`) that imports `@testing-library/jest-dom` and reference it from `vitest.config.ts`
    - _Requirements: 8.4_

- [x] 2. Implement pure physics module
  - [x] 2.1 Define physics types in `src/components/hero/antigravity-physics.ts`
    - Export `Vec2`, `Particle`, `PhysicsState`, `CursorState`, `Bounds`, and `PhysicsConfig` interfaces with `readonly` fields per the design
    - Add a file-level docblock describing the pure-module contract (no DOM, no `Math.random`, no time references; every input passed in)
    - _Requirements: 8.4_

  - [x] 2.2 Implement physics functions in `src/components/hero/antigravity-physics.ts`
    - `repulsion(particle, cursor, radius, strength): Vec2` — returns zero vector when `distance >= radius` or when points coincide; otherwise force points away from the cursor with magnitude using `1 / max(distance, 1)` to prevent runaway forces at microscopic distances
    - `clampVelocity(velocity, max): Vec2` — caps magnitude at `max`, returning the input unchanged if already within bound
    - `applyBoundary(particle, bounds, bounceCoefficient): Particle` — axis-wise position clamp combined with velocity reflection scaled by `bounceCoefficient` on the perpendicular component
    - `stepParticle(particle, cursor, bounds, config): Particle` — Euler integration: `v' = clampVelocity((v + force) * damping, maxVelocity)` then `applyBoundary({ position: position + v', velocity: v' })`. Force is zero when `cursor.inside === false`
    - `step(state, cursor, bounds, config): PhysicsState` — iterates `stepParticle` per particle and applies inter-element repulsion when `state.particles.length > 1`
    - All functions are pure, total over finite inputs, and never throw on valid input
    - _Requirements: 2.3, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 9.1, 9.2_

  - [ ]* 2.3 Set up test arbitraries and helpers in `src/components/hero/antigravity-physics.test.ts`
    - Create the file header tagged `// Feature: hero-cursor-antigravity`
    - Define `validParticleArb`, `validCursorArb`, `validBoundsArb`, `validConfigArb` fast-check arbitraries per the Testing Strategy ranges
    - Export `magnitude(v)` and `EPSILON` helpers for reuse across property assertions
    - Include edge-case coverage in generators: occasional cursor coincident with particle, narrow bounds (1px), positions slightly outside bounds

  - [ ]* 2.4 Write property test for cursor-outside invariance
    - **Property 1: Cursor outside has no influence on the step function**
    - **Validates: Requirements 2.3**
    - Generate a state, bounds, config, and two distinct cursor positions both with `inside: false`; assert `step(state, cursor1, bounds, config)` deeply equals `step(state, cursor2, bounds, config)`

  - [ ]* 2.5 Write property test for repulsion direction and bounds
    - **Property 2: Repulsion is directional, monotonic, and bounded by radius**
    - **Validates: Requirements 3.1**
    - For non-coincident particle and cursor: when `distance >= radius`, assert zero vector; when `distance < radius`, assert `force · (q - p) > 0` (away from cursor) and that magnitude strictly decreases as distance increases along the same direction

  - [ ]* 2.6 Write property test for velocity delta direction
    - **Property 3: Velocity delta direction matches force direction**
    - **Validates: Requirements 3.2**
    - With `cursor.inside === true` and non-coincident positions, project `(stepParticle(...).velocity - particle.velocity)` onto the unit force direction and assert the projection is non-negative

  - [ ]* 2.7 Write property test for damping
    - **Property 4: Damping reduces velocity magnitude in the absence of force**
    - **Validates: Requirements 3.3**
    - With `cursor.inside === false`, an interior position with margin greater than `maxVelocity`, and `0 < damping < 1`, assert `magnitude(next.velocity) <= magnitude(particle.velocity) * damping + EPSILON`

  - [ ]* 2.8 Write property test for velocity cap
    - **Property 5: Velocity magnitude never exceeds the configured cap**
    - **Validates: Requirements 3.4**
    - For arbitrary state, cursor, bounds, and config, assert every particle in `step(...).particles` has `magnitude(velocity) <= config.maxVelocity + EPSILON`

  - [ ]* 2.9 Write property test for interior integration
    - **Property 6: Interior position integration equals position plus velocity**
    - **Validates: Requirements 3.6**
    - With cursor distance exceeding `repulsionRadius` (force = 0) and an interior particle with margin greater than `maxVelocity`, assert `next.position` equals `particle.position + next.velocity` component-wise within `EPSILON`

  - [ ]* 2.10 Write property test for boundary clamp
    - **Property 7: Position is always within bounds**
    - **Validates: Requirements 4.1, 4.2, 4.4**
    - For any valid bounds with `minX < maxX` and `minY < maxY`, assert every output position satisfies `bounds.minX <= position.x <= bounds.maxX` and `bounds.minY <= position.y <= bounds.maxY`

  - [ ]* 2.11 Write property test for boundary reflection
    - **Property 8: Boundary collisions reflect and dampen the perpendicular velocity component**
    - **Validates: Requirements 4.3**
    - When the unbounded next position would land outside bounds on a given axis, assert the resulting axis velocity has the opposite sign of (or equals zero compared to) the pre-bounce axis velocity, and that `|v_axis_after| <= |v_axis_before| * config.bounceCoefficient`

  - [ ]* 2.12 Write property test for particle isolation
    - **Property 9: Per-particle update isolates non-interacting particles**
    - **Validates: Requirements 9.1**
    - For any state with two particles separated by more than the inter-element repulsion radius, assert `step(state, ...).particles[i]` equals `step(removeParticle(state, j), ...).particles[i]`

  - [ ]* 2.13 Write unit tests and performance benchmark
    - Pin specific outputs: `repulsion` at coincident points returns `(0, 0)`; `clampVelocity({ x: 100, y: 0 }, 10)` returns `{ x: 10, y: 0 }`; `applyBoundary` with a particle exactly on the boundary leaves it on the boundary with zeroed perpendicular velocity; `step` with a single particle at center and cursor at corner produces a velocity pointing toward the opposite corner
    - Benchmark: run `step` 10,000 times with `count = 8` and assert total wall-clock time < 100 ms
    - _Requirements: 5.3, 9.3_

- [x] 3. Checkpoint - Verify physics module
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Add CSS for the antigravity layer
  - [x] 4.1 Add `.hero-antigravity` styles to `src/app/globals.css`
    - Wrapper rule: `position: absolute; inset: 0; pointer-events: none; z-index: 0; overflow: hidden;`
    - Element rule (`.hero-antigravity .hero-antigravity__el`): `position: absolute; top: 0; left: 0; border-radius: 50%;` with a radial-gradient using `color-mix(in oklch, var(--accent) ...)`, `filter: blur(8px)`, `opacity: 0.45`, `will-change: transform`, and initial `transform: translate3d(0, 0, 0)`
    - Reduced-motion override: inside `@media (prefers-reduced-motion: reduce)`, set `will-change: auto` on the element
    - _Requirements: 1.4, 1.5, 5.4, 6.1, 6.2, 6.3, 6.4_

- [x] 5. Implement HeroAntigravity client component
  - [x] 5.1 Create component skeleton in `src/components/hero/HeroAntigravity.tsx`
    - Add `'use client'` directive and a file-level docblock matching the `HeroSpotlight` documentation style
    - Define and export `HeroAntigravityProps` and `HeroAntigravityElementStyle` interfaces per the design
    - Normalize props in a `useMemo`: clamp `count` to `[1, 16]`, validate each numeric prop with finite-positive checks and sensible fallbacks (defaults: `repulsionRadius = 300`, `damping = 0.92`, `maxVelocity = 12`, `edgePadding = 20`, `bounceCoefficient = 0.6`); emit `console.warn` in development on out-of-range values
    - Return `null` when `typeof window !== 'undefined' && window.innerWidth < 768`
    - Otherwise render a wrapper `<div className="hero-antigravity" aria-hidden="true">` containing `count` `<div className="hero-antigravity__el">` element nodes; each child receives a ref slot and inline `width`, `height`, `background-color` (or `--accent` override), and `opacity` from the per-element style array
    - Declare `containerRef`, `elementRefs`, `stateRef`, `cursorRef`, `boundsRef`, `frameRef` via `useRef` per the design
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 6.5, 7.3, 7.4, 8.1, 8.3, 8.4, 8.5, 9.4, 10.1_

  - [x] 5.2 Implement effect: capability gates, listeners, rAF loop, observers, cleanup in `src/components/hero/HeroAntigravity.tsx`
    - In `useEffect`, gate on `window.matchMedia('(prefers-reduced-motion: reduce)').matches` and `window.matchMedia('(hover: none)').matches`; if either is true, write each particle's rest position via inline `transform: translate3d(...)` once and return without attaching listeners
    - Resolve `hero = containerRef.current?.parentElement`; bail if null
    - Compute initial `Bounds` from `hero.getBoundingClientRect()` (subtract `edgePadding` and per-element size); seed `stateRef.current` with deterministic positions (e.g., evenly distributed across the hero)
    - Attach `pointermove` (passive: true) and `pointerleave` listeners on `hero` to update `cursorRef.current` (set `position` and toggle `inside`); when `pointerType === 'touch'`, treat the touch position as the cursor and use only the first touch point
    - Run a `requestAnimationFrame` loop that: refreshes `boundsRef`, skips the frame when `rect.width === 0 || rect.height === 0`, calls `step(stateRef.current, cursorRef.current, boundsRef.current, config)`, mutates `stateRef.current` to the new state, and writes `el.style.transform = translate3d(x, y, 0)` per particle
    - Add an `IntersectionObserver` on `hero` to pause/resume the rAF loop when the hero enters/leaves the viewport; if `IntersectionObserver` is unavailable, run the loop unconditionally
    - Add a `ResizeObserver` to refresh `boundsRef` on hero size change; if unavailable, fall back to a `resize` listener on `window`
    - On unmount: `cancelAnimationFrame(frameRef.current)`, remove both pointer listeners, `disconnect()` both observers, and null out all refs
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 5.1, 5.2, 5.3, 5.5, 7.1, 7.2, 10.2, 10.3, 10.4_

  - [ ]* 5.3 Write component tests in `src/components/hero/HeroAntigravity.test.tsx`
    - Render with `count = 3` and assert exactly three `.hero-antigravity__el` nodes are present (Req 1.1, 9.4)
    - Assert the wrapper has `aria-hidden="true"` and that computed `pointer-events` is `none` (Req 7.3, 7.4)
    - Spy on `requestAnimationFrame` and assert it is invoked after mount when no gates fire (Req 2.4)
    - Mock `window.matchMedia` to return `matches: true` for `(prefers-reduced-motion: reduce)` and assert no `pointermove` listener is registered on the parent (Req 7.1, 7.2)
    - Mock `window.matchMedia` to return `matches: true` for `(hover: none)` and assert no listeners are registered
    - Set `window.innerWidth = 500` before render and assert the component returns `null` (Req 10.1)
    - On unmount, assert `cancelAnimationFrame` is called and both pointer listeners are removed (Req 5.5)
    - Assert each element's first-frame inline `style.transform` matches `/^translate3d\(/` and that `style.top`/`style.left` are unset (Req 1.4)

- [ ] 6. Integrate antigravity into the home hero
  - [x] 6.1 Update `src/components/hero/HeroSection.tsx` to accept the `antigravity` prop
    - Extend `HeroSectionProps` with `antigravity?: boolean | HeroAntigravityProps`
    - Import `HeroAntigravity` and mount it between `<HeroSpotlight />` and `<div className="hero-content">` so DOM order produces spotlight → antigravity → content stacking
    - When `antigravity` is `true`, mount `<HeroAntigravity />` with defaults; when it is an object, forward the object as props; when it is falsy, render nothing
    - _Requirements: 1.3, 8.1, 8.2, 8.3_

  - [x] 6.2 Enable antigravity on the home page in `src/app/page.tsx`
    - Pass `antigravity` (boolean) to the `<HeroSection>` element on the home route
    - Confirm other routes that render `HeroSection` (downloads, feedback, login, account, guides) do not pass the prop, keeping their bundles unaffected
    - _Requirements: 5.1, 8.2_

- [x] 7. Final checkpoint - Verify integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP delivery
- Each task references specific requirement clauses for traceability
- Property tests target the pure physics module; the React shell is exercised via component tests because its behaviors (rAF wiring, listener cleanup, capability gates) are not universally quantified over input space
- The pure module is implemented before the React shell so the rAF loop wires up against a tested foundation
- CSS is added in a separate task so styling can be reviewed in isolation from JS behavior

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1"] },
    { "id": 1, "tasks": ["2.2"] },
    { "id": 2, "tasks": ["2.3", "5.1"] },
    { "id": 3, "tasks": ["2.4", "5.2"] },
    { "id": 4, "tasks": ["2.5", "5.3"] },
    { "id": 5, "tasks": ["2.6", "6.1"] },
    { "id": 6, "tasks": ["2.7", "6.2"] },
    { "id": 7, "tasks": ["2.8"] },
    { "id": 8, "tasks": ["2.9"] },
    { "id": 9, "tasks": ["2.10"] },
    { "id": 10, "tasks": ["2.11"] },
    { "id": 11, "tasks": ["2.12"] },
    { "id": 12, "tasks": ["2.13"] }
  ]
}
```
