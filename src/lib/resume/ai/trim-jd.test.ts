import { describe, expect, it } from 'vitest';

import { trimJobDescription } from './trim-jd';

// -----------------------------------------------------------------------------
// JD trimming
//
// The bias is asymmetric and the tests encode it: leaving boilerplate in costs
// tokens, cutting a requirement out costs the user a wrong match report. So every
// ambiguous case must be KEPT.
// -----------------------------------------------------------------------------

const REAL_SHAPE = `About PhonePe Limited:

Headquartered in India, its flagship product is a digital payments app. Founded in
2015, the company has grown enormously and has a culture of ownership.

About the role

We are looking for a backend engineer to own our payments reconciliation systems.

Requirements

- 2+ years of Python
- Strong PostgreSQL
- REST API design

Nice to have

- Redis
- Kubernetes

Benefits

- Medical insurance for you and your family
- Relocation assistance
- Generous leave policy
- Free meals

Equal Opportunity Employer

PhonePe is an equal opportunity employer and does not discriminate on the basis of
any protected characteristic.

To all recruitment agencies

We do not accept unsolicited agency resumes.`;

describe('trimJobDescription', () => {
  const trimmed = trimJobDescription(REAL_SHAPE);

  it('keeps the requirements', () => {
    expect(trimmed).toContain('2+ years of Python');
    expect(trimmed).toContain('Strong PostgreSQL');
    expect(trimmed).toContain('REST API design');
  });

  it('keeps the nice-to-haves', () => {
    expect(trimmed).toContain('Redis');
    expect(trimmed).toContain('Kubernetes');
  });

  it('keeps the role description', () => {
    expect(trimmed).toContain('payments reconciliation');
  });

  it('drops the company history', () => {
    expect(trimmed).not.toContain('Founded in');
  });

  it('drops the benefits list', () => {
    expect(trimmed).not.toContain('Medical insurance');
    expect(trimmed).not.toContain('Free meals');
  });

  it('drops the EEO statement', () => {
    expect(trimmed).not.toContain('protected characteristic');
  });

  it('drops the agency notice', () => {
    expect(trimmed).not.toContain('unsolicited agency');
  });

  it('cuts it down substantially', () => {
    expect(trimmed.length).toBeLessThan(REAL_SHAPE.length * 0.6);
  });
});

describe('trimJobDescription — safety', () => {
  it('a requirements heading ENDS a drop', () => {
    // Boilerplate in the middle of a posting must not swallow what follows.
    const text = `Benefits\n\nFree lunch\n\nRequirements\n\n- Python\n- SQL`;
    const out = trimJobDescription(text);
    expect(out).toContain('Python');
    expect(out).toContain('SQL');
    expect(out).not.toContain('Free lunch');
  });

  it('does not truncate on the word "benefits" inside a sentence', () => {
    // Only heading-shaped lines can start a drop.
    const text =
      'You will own the service.\nThis role benefits from strong ownership, so you must know Python.\nMore about Python here.';
    expect(trimJobDescription(text)).toContain('More about Python');
  });

  it('keeps ambiguous headings that describe the job', () => {
    for (const heading of ['About the role', "What you'll do", 'Who you are', 'The role']) {
      const text = `${heading}\n\nOwn the payments service using Python.`;
      expect(trimJobDescription(text)).toContain('Python');
    }
  });

  it('falls back to the original when the strip removes nearly everything', () => {
    // If the headings were not what we assumed, a fragment is worse than a long
    // prompt.
    const text = 'About us\n\nWe are a company that uses Python and PostgreSQL daily.';
    expect(trimJobDescription(text)).toContain('Python');
  });

  it('caps very long postings', () => {
    const long = 'Requirements\n\n' + 'Python and SQL experience. '.repeat(1000);
    const out = trimJobDescription(long);
    expect(out.length).toBeLessThan(5200);
    expect(out).toContain('[truncated]');
  });

  it('handles an empty description', () => {
    expect(trimJobDescription('')).toBe('');
  });

  it('leaves a short posting untouched', () => {
    const short = 'Backend Engineer. Requirements: Python, SQL.';
    expect(trimJobDescription(short)).toBe(short);
  });
});
