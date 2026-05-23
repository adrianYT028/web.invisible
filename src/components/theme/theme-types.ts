/**
 * Theme system shared types and constants.
 *
 * Source of truth for the persisted theme key and the union of valid theme
 * modes. Both the synchronous pre-paint script (`theme-script.tsx`) and the
 * client-side toggle (`ThemeToggle.tsx`) must read/write the SAME storage key
 * so the theme state stays consistent across reloads and tabs.
 *
 * The string literal `'unviewable-theme'` is duplicated verbatim inside the
 * inline IIFE in `theme-script.tsx` because that script runs before any JS
 * module graph evaluates — it cannot import this constant. Keep them in sync.
 */

export type ThemeMode = 'dark' | 'light';

export const THEME_KEY = 'unviewable-theme';
