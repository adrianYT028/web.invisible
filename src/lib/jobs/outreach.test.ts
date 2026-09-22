import { describe, expect, it } from 'vitest';

import {
  findPostingContact,
  gmailComposeUrl,
  mailtoUrl,
  nameFromEmail,
} from './contacts';
import { hasPlaceholder } from './outreach';

// -----------------------------------------------------------------------------
// Contact discovery + outreach guards
//
// Contacts come only from what a posting publishes. Nothing here looks anything
// up, and these tests pin that: the input is a job description, always.
// -----------------------------------------------------------------------------

describe('findPostingContact', () => {
  it('finds a published careers address', () => {
    const c = findPostingContact({
      description: 'Send your CV to careers@acme.com to apply.',
      companyName: 'Acme',
    });
    expect(c.email).toBe('careers@acme.com');
    expect(c.provenance).toBe('published_in_posting');
  });

  it('prefers a role account over an individual', () => {
    // A role account is unambiguously for applicants. An individual in a long JD
    // may be mentioned for another reason entirely.
    const c = findPostingContact({
      description: 'Questions? ask priya.sharma@acme.com. Applications: jobs@acme.com',
      companyName: 'Acme',
    });
    expect(c.email).toBe('jobs@acme.com');
    expect(c.name).toBeNull();
  });

  it('uses an individual when that is all the posting gives', () => {
    const c = findPostingContact({
      description: 'Reach out to priya.sharma@acme.com with questions about this role.',
      companyName: 'Acme',
    });
    expect(c.email).toBe('priya.sharma@acme.com');
    expect(c.name).toBe('Priya');
  });

  it.each([
    'privacy@acme.com',
    'dpo@acme.com',
    'press@acme.com',
    'legal@acme.com',
    'accessibility@acme.com',
    'noreply@acme.com',
  ])('ignores %s', (email) => {
    // Job descriptions routinely carry a GDPR contact and an accessibility line.
    // Mailing those wastes the candidate's one shot and annoys someone who cannot
    // help.
    const c = findPostingContact({
      description: `For data questions contact ${email}.`,
      companyName: 'Acme',
    });
    expect(c.email).toBeNull();
    expect(c.provenance).toBe('none');
  });

  it('gives real guidance when nothing is published', () => {
    const c = findPostingContact({
      description: 'Apply via the button below.',
      companyName: 'Acme',
    });
    expect(c.email).toBeNull();
    expect(c.provenance).toBe('none');
    // "No contact published" must still tell the candidate what to do.
    expect(c.guidance).toMatch(/Acme/);
    expect(c.guidance.length).toBeGreaterThan(40);
  });

  it('strips trailing punctuation from an address', () => {
    const c = findPostingContact({
      description: 'Write to careers@acme.com.',
      companyName: 'Acme',
    });
    expect(c.email).toBe('careers@acme.com');
  });

  it('deduplicates a repeated address', () => {
    const c = findPostingContact({
      description: 'careers@acme.com ... again careers@acme.com',
      companyName: 'Acme',
    });
    expect(c.email).toBe('careers@acme.com');
  });

  it('never invents an address for an empty description', () => {
    // Ashby postings arrive with no description at all.
    const c = findPostingContact({ description: '', companyName: null });
    expect(c.email).toBeNull();
    expect(c.guidance).toMatch(/the company/);
  });
});

describe('nameFromEmail', () => {
  it('reads a first name from a dotted local part', () => {
    expect(nameFromEmail('priya.sharma@acme.com')).toBe('Priya');
  });

  it('refuses anything that is not clearly a name', () => {
    // Only ever chooses between "Hi Priya" and "Hello", so a wrong guess is worse
    // than no guess.
    expect(nameFromEmail('hr2024@acme.com')).toBeNull();
    expect(nameFromEmail('a@acme.com')).toBeNull();
    expect(nameFromEmail('recruitmentteamforengineering@acme.com')).toBeNull();
  });
});

describe('hasPlaceholder', () => {
  it.each([
    'Hi [Name], I saw your posting',
    'Best, {{firstName}}',
    'Regards, <Your Name>',
    'Please insert your achievements here',
    'Contact me at XXXX',
    'lorem ipsum dolor',
  ])('rejects "%s"', (text) => {
    // A draft with an unfilled placeholder is worse than no draft: it gets sent
    // and the hiring manager reads "[Your Name]".
    expect(hasPlaceholder(text)).toBe(true);
  });

  it.each([
    'Hi Priya, I saw the Backend Engineer role at Acme.',
    'I cut API latency from 420 ms to 180 ms with a Redis cache.',
    'Best,\nAarav',
  ])('accepts "%s"', (text) => {
    expect(hasPlaceholder(text)).toBe(false);
  });

  it('does not trip on ordinary parentheses or punctuation', () => {
    expect(hasPlaceholder('I work on payments (reconciliation, refunds).')).toBe(false);
  });
});

describe('compose links', () => {
  const draft = {
    to: 'careers@acme.com',
    subject: 'Backend Engineer role',
    body: 'Hello,\n\nI cut latency by half.\n\nBest,\nAarav',
  };

  it('builds a Gmail compose URL with the draft pre-filled', () => {
    const url = gmailComposeUrl(draft);
    expect(url.startsWith('https://mail.google.com/mail/?')).toBe(true);
    expect(url).toContain('view=cm');
    expect(url).toContain('careers%40acme.com');
  });

  it('encodes newlines so the body survives', () => {
    // A raw newline in a query string truncates the body.
    expect(gmailComposeUrl(draft)).not.toMatch(/\n/);
  });

  it('offers a mailto fallback for non-Gmail users', () => {
    expect(mailtoUrl(draft).startsWith('mailto:')).toBe(true);
  });
});
