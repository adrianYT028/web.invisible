import { describe, expect, it } from 'vitest';

import { emptyProfile, type ResumeProfile } from '@/lib/resume/schema';

import {
  looksEarlyCareer,
  looksSenior,
  profileSkills,
  rankPostings,
  type IndexedPosting,
} from './match';
import { htmlToPlainText, isIndiaLocation, looksRemote } from './sources';
import { toRow } from './sync';

// -----------------------------------------------------------------------------
// Job sources, sync reconciliation, and ranking
// -----------------------------------------------------------------------------

describe('htmlToPlainText', () => {
  it('decodes entity-encoded HTML before stripping tags', () => {
    // The real Greenhouse shape. Its `content` field arrives entity-encoded, so
    // stripping tags first matches nothing and the later decode then TURNS the
    // entities into visible markup — the "plain text" handed to the matcher was
    // raw HTML. Order is the entire fix.
    const raw =
      '&lt;div class=&quot;content-intro&quot;&gt;&lt;h2&gt;Who Are We?&lt;/h2&gt;&lt;p&gt;Postman is an API platform&lt;/p&gt;&lt;/div&gt;';
    const text = htmlToPlainText(raw);

    expect(text).not.toMatch(/[<>]/);
    expect(text).toContain('Who Are We?');
    expect(text).toContain('Postman is an API platform');
  });

  it('handles literal tags too', () => {
    expect(htmlToPlainText('<p>One</p><p>Two</p>')).toBe('One\nTwo');
  });

  it('keeps block boundaries as newlines', () => {
    // Without this every requirement runs into the next one and the extractor
    // sees one wall of prose.
    const text = htmlToPlainText('<h2>Requirements</h2><li>Python</li><li>SQL</li>');
    expect(text.split('\n').map((l) => l.trim())).toEqual([
      'Requirements',
      'Python',
      'SQL',
    ]);
  });

  it('decodes numeric and hex entities', () => {
    expect(htmlToPlainText('caf&#233; and caf&#xE9;')).toBe('café and café');
  });

  it('decodes &amp; last so a double-encoded entity survives', () => {
    // '&amp;lt;' means a literal '<' in the text, not a tag. Decoding &amp; first
    // would produce '&lt;' and then strip it as markup.
    expect(htmlToPlainText('a &amp;lt;b')).toBe('a &lt;b');
  });

  it('collapses excess blank lines', () => {
    expect(htmlToPlainText('<p>A</p><p></p><p></p><p>B</p>')).toBe('A\n\nB');
  });
});

describe('looksRemote', () => {
  it.each(['Remote', 'Remote - US', 'Anywhere', 'Work from home'])(
    'accepts %s',
    (loc) => {
      expect(looksRemote(loc)).toBe(true);
    }
  );

  it.each(['Bengaluru', 'Bangalore, Karnataka', 'Mumbai', null])(
    'rejects %s',
    (loc) => {
      expect(looksRemote(loc)).toBe(false);
    }
  );
});

describe('isIndiaLocation', () => {
  it.each([
    'Bengaluru',
    'Bangalore, Karnataka',
    'Gurgaon',
    'Gurugram',
    'Noida',
    'Hyderabad, India',
    'Mumbai',
  ])('accepts %s', (loc) => {
    expect(isIndiaLocation(loc)).toBe(true);
  });

  it.each(['Dubai, United Arab Emirates', 'San Francisco', 'London', null])(
    'rejects %s',
    (loc) => {
      expect(isIndiaLocation(loc)).toBe(false);
    }
  );

  it('matches both spellings of the same city', () => {
    // A posting written "Bangalore" is the same place as one written "Bengaluru".
    expect(isIndiaLocation('Bangalore')).toBe(isIndiaLocation('Bengaluru'));
  });
});

describe('toRow', () => {
  const posting = {
    source: 'greenhouse' as const,
    externalId: '123',
    companySlug: 'phonepe',
    companyName: 'PhonePe',
    title: 'Backend Engineer',
    location: 'Bangalore',
    isRemote: false,
    url: 'https://example.com/1',
    description: 'Python and PostgreSQL',
    postedAt: '2026-08-01T00:00:00.000Z',
  };

  it('derives is_india from the location', () => {
    expect(toRow(posting, 'c1', '2026-08-25T00:00:00.000Z').is_india).toBe(true);
  });

  it('NEVER writes first_seen_at', () => {
    // It has a column default, so omitting it means an upsert leaves the original
    // discovery date intact. Including it would reset the date on every sync and
    // make every posting look newly discovered.
    expect(toRow(posting, 'c1', '2026-08-25T00:00:00.000Z')).not.toHaveProperty(
      'first_seen_at'
    );
  });

  it('reopens a posting that reappeared on a board', () => {
    expect(toRow(posting, 'c1', '2026-08-25T00:00:00.000Z').is_open).toBe(true);
  });

  it('stamps last_seen_at with the run time, not the posted date', () => {
    const row = toRow(posting, 'c1', '2026-08-25T00:00:00.000Z');
    expect(row.last_seen_at).toBe('2026-08-25T00:00:00.000Z');
    expect(row.posted_at).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('profileSkills', () => {
  function withSkills(
    names: Array<[string, number]>,
    technologies: string[] = []
  ): ResumeProfile {
    return {
      ...emptyProfile(),
      skills: names.map(([name, evidence]) => ({
        name,
        normalised: name.toLowerCase(),
        category: null,
        evidenceBulletIds: Array.from({ length: evidence }, (_, i) => `exp.0.${i}`),
      })),
      projects: technologies.length
        ? [
            {
              name: 'P',
              description: null,
              technologies,
              link: null,
              bullets: [],
            },
          ]
        : [],
    };
  }

  it('puts evidenced skills before merely listed ones', () => {
    // If the cap truncates anything it should be the unevidenced tail.
    const skills = profileSkills(
      withSkills([
        ['Listed', 0],
        ['Evidenced', 1],
      ])
    );
    expect(skills[0]).toBe('evidenced');
  });

  it('includes project technologies', () => {
    expect(profileSkills(withSkills([], ['Docker']))).toContain('docker');
  });

  it('deduplicates across skills and projects', () => {
    const skills = profileSkills(withSkills([['Docker', 1]], ['Docker']));
    expect(skills.filter((s) => s === 'docker')).toHaveLength(1);
  });

  it('caps the list so a long resume does not flatten the ranking', () => {
    const many: Array<[string, number]> = Array.from({ length: 40 }, (_, i) => [
      `skill${i}`,
      0,
    ]);
    expect(profileSkills(withSkills(many)).length).toBeLessThanOrEqual(12);
  });
});

describe('rankPostings', () => {
  const profile: ResumeProfile = {
    ...emptyProfile(),
    skills: [
      { name: 'Python', normalised: 'python', category: null, evidenceBulletIds: ['exp.0.0'] },
      { name: 'PostgreSQL', normalised: 'postgresql', category: null, evidenceBulletIds: [] },
      { name: 'Redis', normalised: 'redis', category: null, evidenceBulletIds: [] },
    ],
  };

  function posting(over: Partial<IndexedPosting>): IndexedPosting {
    return {
      id: 'p',
      title: 'Engineer',
      location: 'Bengaluru',
      is_remote: false,
      is_india: true,
      url: 'https://example.com',
      description: '',
      posted_at: null,
      ...over,
    };
  }

  it('ranks a title match above a description match', () => {
    // A skill in the title says what the role IS; the same word in a benefits
    // paragraph does not.
    const ranked = rankPostings(profile, [
      posting({ id: 'body', title: 'Engineer', description: 'we use python here' }),
      posting({ id: 'title', title: 'Python Engineer', description: 'a role' }),
    ]);
    expect(ranked[0].id).toBe('title');
  });

  it('reports which skills matched', () => {
    const ranked = rankPostings(profile, [
      posting({ description: 'python and redis experience' }),
    ]);
    expect(ranked[0].matchedSkills.sort()).toEqual(['python', 'redis']);
  });

  it('marks a description-less posting unscored, not zero', () => {
    // Ashby returns no descriptions. Zero would read as "bad match" when the truth
    // is "nothing to compare".
    const ranked = rankPostings(profile, [posting({ description: '' })]);
    expect(ranked[0].unscored).toBe(true);
  });

  it('sorts unscored postings last regardless of recency', () => {
    const ranked = rankPostings(profile, [
      posting({ id: 'unscored', description: '', posted_at: '2026-08-25T00:00:00Z' }),
      posting({ id: 'weak', description: 'unrelated role', posted_at: '2020-01-01T00:00:00Z' }),
    ]);
    expect(ranked[0].id).toBe('weak');
  });

  it('breaks ties on recency', () => {
    const ranked = rankPostings(profile, [
      posting({ id: 'old', description: 'python', posted_at: '2026-01-01T00:00:00Z' }),
      posting({ id: 'new', description: 'python', posted_at: '2026-08-01T00:00:00Z' }),
    ]);
    expect(ranked[0].id).toBe('new');
  });

  it('normalises against the profile, so a short skill list can still score high', () => {
    // Otherwise a candidate with three skills is permanently capped below one with
    // thirty, which measures resume length rather than fit.
    const ranked = rankPostings(profile, [
      posting({ title: 'Python PostgreSQL Redis Engineer', description: 'x' }),
    ]);
    expect(ranked[0].relevance).toBe(100);
  });

  it('handles an empty profile without dividing by zero', () => {
    const ranked = rankPostings(emptyProfile(), [posting({ description: 'python' })]);
    expect(ranked[0].relevance).toBe(0);
  });

  it('handles an empty index', () => {
    expect(rankPostings(profile, [])).toEqual([]);
  });

  it('matches a skill through an alias', () => {
    // The posting says Postgres, the resume says PostgreSQL.
    const ranked = rankPostings(profile, [
      posting({ description: 'experience with postgres' }),
    ]);
    expect(ranked[0].matchedSkills).toContain('postgresql');
  });
});

describe('career-level hints', () => {
  it.each(['Software Engineering Intern', 'Graduate Analyst', 'Junior Developer'])(
    'flags %s as early career',
    (t) => {
      expect(looksEarlyCareer(t)).toBe(true);
    }
  );

  it.each(['Staff Engineer', 'Engineering Manager', 'Principal Architect'])(
    'flags %s as senior',
    (t) => {
      expect(looksSenior(t)).toBe(true);
    }
  );

  it('treats a plain title as neither', () => {
    expect(looksEarlyCareer('Backend Engineer')).toBe(false);
    expect(looksSenior('Backend Engineer')).toBe(false);
  });
});
