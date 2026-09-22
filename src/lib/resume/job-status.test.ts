import { describe, expect, it } from 'vitest';

import { appliedAtFor, isJobStatus, JOB_STATUSES } from './job-status';

// -----------------------------------------------------------------------------
// Pipeline stage transitions
//
// Migration 012 requires applied_at to be NULL for 'saved'/'archived' and NOT NULL
// otherwise. Get this wrong and a dropdown change fails at the database with a
// constraint violation the user cannot interpret.
// -----------------------------------------------------------------------------

const NOW = new Date('2026-08-25T12:00:00.000Z');

describe('isJobStatus', () => {
  it.each(JOB_STATUSES)('accepts %s', (s) => {
    expect(isJobStatus(s)).toBe(true);
  });

  it.each([['Applied'], ['APPLIED'], ['ghosted'], [''], [null], [7]])(
    'rejects %s',
    (v) => {
      expect(isJobStatus(v)).toBe(false);
    }
  );
});

describe('appliedAtFor', () => {
  it('stamps an application date when moving to applied', () => {
    expect(appliedAtFor('applied', null, NOW)).toBe('2026-08-25T12:00:00.000Z');
  });

  it('PRESERVES the original date when advancing further down the pipeline', () => {
    // The date you applied does not change because you got an interview.
    const original = '2026-08-01T09:00:00.000Z';
    expect(appliedAtFor('interviewing', original, NOW)).toBe(original);
    expect(appliedAtFor('offer', original, NOW)).toBe(original);
    expect(appliedAtFor('rejected', original, NOW)).toBe(original);
  });

  it('stamps a date when jumping straight to a later stage', () => {
    // Users routinely add a job they already interviewed for.
    expect(appliedAtFor('interviewing', null, NOW)).toBe('2026-08-25T12:00:00.000Z');
  });

  it('CLEARS the date when moving back to saved', () => {
    // Required by the CHECK constraint, and honest: the row no longer claims an
    // application was sent.
    expect(appliedAtFor('saved', '2026-08-01T09:00:00.000Z', NOW)).toBeNull();
  });

  it('clears the date when archiving', () => {
    expect(appliedAtFor('archived', '2026-08-01T09:00:00.000Z', NOW)).toBeNull();
  });

  it('never returns a date for a pre-application status, whatever it was given', () => {
    for (const s of ['saved', 'archived'] as const) {
      expect(appliedAtFor(s, NOW.toISOString(), NOW)).toBeNull();
    }
  });

  it('always returns a date for a post-application status', () => {
    for (const s of ['applied', 'interviewing', 'offer', 'rejected'] as const) {
      expect(appliedAtFor(s, null, NOW)).not.toBeNull();
    }
  });
});
