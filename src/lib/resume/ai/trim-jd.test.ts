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
    // 3,000 plus the marker. Was 5,200, which was above the point where extraction
    // actually fails — see the cap comment in trim-jd.ts.
    expect(out.length).toBeLessThan(3100);
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

// =============================================================================
// The cap exists to stop extraction truncating, so it is sized against MEASURED
// behaviour rather than against prompt cost.
//
// Live measurement (budget-headroom.integration.test.ts, completion budget 1300):
//
//     20 requirements   2,008 chars   OK
//     30 requirements   2,978 chars   OK
//     45 requirements   4,433 chars   TRUNCATED
//
// The previous 5,000 cap therefore accepted postings that were guaranteed to fail,
// and the user paid a day's scan quota to find out.
// =============================================================================
describe('trimJobDescription — staying inside the completion budget', () => {
  /** A posting with `n` requirement bullets, each roughly `chars` long. */
  function posting(n: number, chars = 90): string {
    const lines = ['Backend Engineer', '', 'Requirements'];
    for (let i = 0; i < n; i += 1) {
      const filler = 'production experience at scale'.padEnd(chars - 30, ' x');
      lines.push(`- Requirement ${i + 1}: ${filler}`);
    }
    return lines.join('\n');
  }

  it('keeps a 30-requirement posting whole, since that size is proven to work', () => {
    const out = trimJobDescription(posting(30));
    expect(out).not.toContain('[truncated]');
    expect(out).toContain('Requirement 30');
  });

  it('never exceeds the measured ceiling', () => {
    // Several shapes, because the cap has to hold for all of them: many short
    // bullets, few long ones, and one unbroken paragraph.
    const shapes = [
      posting(200, 40),
      posting(60, 300),
      'Requirements\n' + 'Python and SQL and Go and Kubernetes. '.repeat(400),
    ];
    for (const shape of shapes) {
      const out = trimJobDescription(shape);
      expect(out.length).toBeLessThan(3200);
    }
  });

  it('cuts at a line boundary, not mid-word', () => {
    // A fragment like "- Strong experience with Postgre" is worse than dropping the
    // line: the model extracts a requirement for a technology that does not exist,
    // and the resume is then scored against it. A half-requirement is a fabricated
    // requirement.
    const out = trimJobDescription(posting(200, 40));
    const body = out.replace(/\n\[truncated\]$/, '').replace(/\n\[\d+ further[^\]]*\]$/, '');
    const lastLine = body.split('\n').filter((l) => l.trim().length > 0).at(-1) ?? '';

    // Every requirement line in the fixture ends with the padding character, so a
    // line cut mid-word would end partway through "Requirement N: production…".
    expect(lastLine.startsWith('- Requirement')).toBe(true);
    expect(lastLine).toMatch(/x$|scale$/);
  });

  it('bounds the NUMBER of requirements, which is what the budget responds to', () => {
    // A character cap alone is not enough: fifty terse bullets sit well under
    // 3,000 characters and still ask the model for fifty JSON objects.
    const terse = ['Requirements', ...Array.from({ length: 80 }, (_, i) => `- Skill ${i + 1}`)].join('\n');
    expect(terse.length).toBeLessThan(3000);

    const out = trimJobDescription(terse);
    const bullets = out.split('\n').filter((l) => /^- Skill/.test(l));
    expect(bullets.length).toBeLessThanOrEqual(40);
    expect(out).toMatch(/further requirement line\(s\) omitted/);
  });

  it('says when requirements were dropped rather than dropping them silently', () => {
    const out = trimJobDescription(posting(120, 40));
    // A reader of the prompt — or of a logged prompt — must be able to tell a short
    // posting from a cut one.
    expect(out).toMatch(/\[truncated\]|further requirement line\(s\) omitted/);
  });

  it('keeps the title and headings even when bullets are dropped', () => {
    const out = trimJobDescription(posting(120, 40));
    expect(out).toContain('Backend Engineer');
    expect(out).toContain('Requirements');
  });

  it('does not mangle a posting written as one long paragraph', () => {
    // No line breaks to cut at, so the line-boundary rule must fall back to a hard
    // cut rather than returning almost nothing.
    const paragraph = 'Requirements\n' + 'We need Python and SQL. '.repeat(500);
    const out = trimJobDescription(paragraph);
    expect(out.length).toBeGreaterThan(2000);
    expect(out.length).toBeLessThan(3200);
    expect(out).toContain('Python');
  });
});
