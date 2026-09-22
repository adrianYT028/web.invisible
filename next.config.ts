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
  serverExternalPackages: ["pdfjs-dist", "mammoth"],
};

export default nextConfig;
