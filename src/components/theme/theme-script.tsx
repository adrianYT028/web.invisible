/**
 * Pre-paint inline theme script.
 *
 * This is a SERVER component that returns a `<script>` element with
 * `dangerouslySetInnerHTML`. It is mounted inside `<head>` from
 * `src/app/layout.tsx`, before any stylesheet `<link>`, so the synchronous
 * IIFE runs before first paint and the initial render already reflects the
 * persisted theme — no FOUC, no hydration mismatch.
 *
 * Behavior (matches design.md → Theme System → Pre-Paint Inline Script):
 *   1. Read `localStorage.getItem('unviewable-theme')`.
 *   2. If the value is not `'dark'` or `'light'`, overwrite it with `'dark'`.
 *   3. Set `data-theme` on `<html>` to the resolved value.
 *   4. Every error path (storage unavailable, quota, missing
 *      `document.documentElement`) is swallowed and falls back to `'dark'`.
 *
 * The IIFE intentionally inlines the storage key string instead of importing
 * `THEME_KEY` from `./theme-types` because this script runs before any module
 * graph evaluates. If the key changes, update both files.
 */

const themeScriptSource = `(function () {
  try {
    var k = 'unviewable-theme';
    var v = localStorage.getItem(k);
    if (v !== 'dark' && v !== 'light') {
      v = 'dark';
      try { localStorage.setItem(k, v); } catch (_) {}
    }
    document.documentElement.setAttribute('data-theme', v);
  } catch (_) {
    try { document.documentElement.setAttribute('data-theme', 'dark'); } catch (_) {}
  }
})();`;

export function ThemeScript() {
  return (
    <script
      // eslint-disable-next-line react/no-danger -- inline IIFE must run before paint; content is a constant string
      dangerouslySetInnerHTML={{ __html: themeScriptSource }}
    />
  );
}
