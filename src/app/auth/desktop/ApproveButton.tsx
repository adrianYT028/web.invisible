'use client';

import { useFormStatus } from 'react-dom';

/**
 * Submit button for the /auth/desktop approve form. Disables itself while the
 * server action runs so repeat clicks cannot queue more actions (each queued
 * action delays the hand-off to /auth/desktop/open), and shows that the click
 * was received.
 */
export default function ApproveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="cta cta-primary"
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? 'Signing in…' : 'Sign in the desktop app'}
    </button>
  );
}
