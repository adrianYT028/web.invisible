import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Keep these out of the server bundle and `require` them from node_modules at
   * runtime instead.
   *
   * WHY pdfjs-dist MUST BE HERE:
   *   pdfjs loads its parser in a worker. Under Node it falls back to a "fake
   *   worker", which dynamically imports `pdf.worker.mjs` from a path relative to
   *   the module doing the importing. When Turbopack bundles `pdf.mjs` into
   *   `.next/.../chunks/`, the worker file is NOT copied alongside it, so that
   *   lookup fails at request time with:
   *
   *     Setting up fake worker failed: "Cannot find module
   *      '.../.next/dev/server/chunks/pdf.worker.mjs'"
   *
   *   and every PDF upload returns "this PDF could not be read" — a message that
   *   blames the user's file for an environment problem.
   *
   *   Marking the package external leaves it in node_modules, where `pdf.mjs` and
   *   `pdf.worker.mjs` are siblings, and the relative import resolves.
   *
   *   Note this class of failure CANNOT be caught by the unit or integration
   *   tests: vitest resolves the package straight from node_modules, so the
   *   worker is always found there. It only appears once Next does the bundling.
   *
   * mammoth is listed for the same reason in principle — it is a Node-only
   * library with no business being bundled for the browser — though it has no
   * worker and did not fail.
   */
  // `@napi-rs/canvas` is a NATIVE module (a prebuilt Skia `.node` binary).
  // Bundling it is not merely wasteful, it cannot work — a `.node` file has to be
  // loaded by Node's own dlopen, not inlined into a JS chunk.
  serverExternalPackages: ["pdfjs-dist", "mammoth", "@napi-rs/canvas"],

  /**
   * Force `pdf.worker.mjs` into the deployed function bundle.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS NEEDED ON TOP OF serverExternalPackages
   *
   * `serverExternalPackages` fixed the DEV failure above by leaving pdfjs in
   * node_modules, where `pdf.mjs` and `pdf.worker.mjs` sit side by side. It did
   * NOT fix production, because Vercel does not deploy node_modules — it deploys
   * only the files Next's static tracing decided each route needs.
   *
   * The fake worker's import is COMPUTED at runtime from the module's own URL, so
   * static tracing cannot see it. Measured on the built output before adding this:
   *
   *     .next/server/app/api/resume/upload/route.js.nft.json
   *       pdfjs-dist files traced: 3   (pdf.mjs, and two chunk shims)
   *       pdf.worker.* traced:     0
   *
   * So the deployed function contained the parser entry point and not the worker
   * it loads. Every PDF upload in production threw inside `extractDocument`, hit
   * the generic catch in /api/resume/upload, and answered
   * `500 internal_error` — surfaced to the user as "An unexpected error
   * occurred." Locally it worked, in dev it worked, and all 867 tests passed,
   * because vitest and `next dev` both resolve pdfjs straight from node_modules.
   *
   * ---------------------------------------------------------------------------
   * WHY NOT THE OTHER FIXES
   *
   * Setting `GlobalWorkerOptions.workerSrc` does not help: it changes WHICH path
   * is imported, and the problem is that no worker file is present at any path.
   * Bundling pdfjs instead of externalising it reintroduces the original dev bug.
   * The file has to be shipped, so ship it.
   *
   * Only `/api/resume/upload` is listed because it is the only route whose trace
   * contains pdf.mjs at all — `/api/resume/scan` reads `extracted_text` back out
   * of the database and never touches pdfjs. If another route starts extracting,
   * it needs an entry here too, and the symptom will be this exact 500.
   *
   * `pdf.worker.mjs`, not `.min.mjs`: `pdf.mjs` names the unminified file, once.
   * It is 2.3 MB, against Vercel's 250 MB uncompressed function limit.
   */
  outputFileTracingIncludes: {
    "/api/resume/upload": [
      // THE ACTUAL CAUSE OF THE PRODUCTION 500.
      //
      // Node's module resolver reads a package's own `package.json` to work out
      // the package boundary and its module type before it will load ANY file
      // inside it. Tracing recorded `pdf.mjs` and skipped `package.json`, so the
      // deployed function held the parser source with no way to resolve it, and
      // `await import('pdfjs-dist/legacy/build/pdf.mjs')` threw
      // ERR_MODULE_NOT_FOUND on a file that was sitting right there.
      //
      // Nothing about this is visible locally: `next start` and vitest both run
      // against a complete node_modules, where package.json is always present.
      "./node_modules/pdfjs-dist/package.json",

      // The worker, a SEPARATE bug found first and fixed in the same place. The
      // fake-worker import is computed from the module's own URL at runtime, so
      // static tracing cannot see it either. Missing it fails differently —
      // `422 extraction_failed` rather than a 500 — which is what made it a
      // plausible but wrong first diagnosis.
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",

      // -----------------------------------------------------------------------
      // DOMMatrix. This is what actually kept PDF upload broken.
      //
      // Node provides no `DOMMatrix` on any version (verified: undefined on both
      // 20 and 22). pdfjs polyfills it from `@napi-rs/canvas`, which it declares
      // as an OPTIONAL dependency — so it is installed, it is never imported by
      // our code, and tracing therefore never saw it. Without it, loading
      // pdf.mjs throws `DOMMatrix is not defined`.
      //
      // Measured with scripts/probe-pdfjs-minimal.mjs, which builds sandboxes
      // containing only a candidate file set:
      //
      //   pdf.mjs only ................... FAIL  DOMMatrix is not defined
      //   + package.json ................. FAIL  DOMMatrix is not defined
      //   + package.json + worker ........ FAIL  DOMMatrix is not defined
      //   + wasm/ ........................ FAIL  DOMMatrix is not defined
      //   whole pdfjs, no canvas ......... FAIL  DOMMatrix is not defined
      //   pdfjs + @napi-rs/canvas ........ PASS  pages=1 chars=46
      //
      // The binary is platform-suffixed and npm installs only the host's variant,
      // so the glob matches `canvas-linux-x64-gnu` on Vercel and
      // `canvas-darwin-arm64` here. It does not multiply the bundle across
      // platforms.
      //
      // Roughly 34 MB, against Vercel's 250 MB uncompressed limit. A hand-written
      // DOMMatrix shim would be far smaller and was rejected: the layout analysis
      // in src/lib/resume/extraction/layout.ts reads text transforms to detect
      // columns and tables, so a subtly wrong matrix would not crash — it would
      // silently mis-score resumes, which is worse than being 34 MB larger.
      "./node_modules/@napi-rs/canvas/**",
      "./node_modules/@napi-rs/canvas-*/**",
      "./node_modules/@napi-rs/wasm-runtime/**",
    ],
  },
};

export default nextConfig;
