/**
 * Single source of truth for marketing-surface metadata that is reused across
 * the JSON-LD `SoftwareApplication` schema in `src/app/layout.tsx`,
 * the `<TrustStrip />` component, the footer contact row, and the social link
 * surfaces. Values are typed `as const` so consumers see narrow string-literal
 * types and the constant can never drift from the JSON-LD output.
 *
 * IMPORTANT: The `softwareVersion`, `ratingValue`, and `ratingCount` strings
 * MUST stay byte-identical to the strings that appear in the JSON-LD schema.
 */
export const SITE_META = {
  softwareVersion: '2.1.0',
  ratingValue: '4.9',
  ratingCount: '124',
  downloadUrl:
    'https://github.com/adrianYT028/AIMeetingAssistant-Releases/releases/download/2.0.1/Unviewable_Setup_2.1.0.exe',
  contactEmail: 'join.invisibleai@gmail.com',
  instagramUrl: 'https://www.instagram.com/unviewable.online/',
} as const;

export type SiteMeta = typeof SITE_META;
