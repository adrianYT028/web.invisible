import { describe, expect, it } from 'vitest';

import {
  bulletId,
  emptyProfile,
  type BulletFeedback,
  type ResumeProfile,
  type ResumeRole,
} from '../schema';
import { isMateriallyUnchanged, selectBulletsToRewrite } from './rewrite';
import {
  extractNamedThings,
  extractNumbers,
  extractNumericFacts,
  verifyNoNewFacts,
} from './verify-no-new-facts';

// -----------------------------------------------------------------------------
// Anti-fabrication verifier + rewrite selection
//
// The verifier is the only thing standing between a helpful-sounding model and a
// student defending a metric they never measured in an interview. It is tested
// harder than anything else in the rewrite path, and the bias is deliberate:
// a false rejection costs one suggestion, a false acceptance costs the interview.
// -----------------------------------------------------------------------------

function profileWith(overrides: Partial<ResumeProfile> = {}): ResumeProfile {
  return {
    ...emptyProfile(),
    skills: [
      { name: 'Python', normalised: 'python', category: null, evidenceBulletIds: [] },
      { name: 'Redis', normalised: 'redis', category: null, evidenceBulletIds: [] },
      {
        name: 'PostgreSQL',
        normalised: 'postgresql',
        category: null,
        evidenceBulletIds: [],
      },
    ],
    experience: [
      {
        title: 'Backend Engineering Intern',
        company: 'Zenpay Technologies',
        location: null,
        startDate: null,
        endDate: null,
        isCurrent: false,
        bullets: [],
      } satisfies ResumeRole,
    ],
    ...overrides,
  };
}

describe('extractNumbers', () => {
  it('finds plain figures', () => {
    expect(extractNumbers('Cut latency from 420 ms to 180 ms')).toEqual(['420', '180']);
  });

  it('normalises thousands separators so reformatting is not fabrication', () => {
    // '2,000' and '2000' are the same fact stated two ways.
    expect(extractNumbers('handled 2,000 events')).toEqual(['2000']);
  });

  it('normalises trailing zeros', () => {
    expect(extractNumbers('180.0 ms')).toEqual(['180']);
  });

  it('returns nothing for a bullet with no figures', () => {
    expect(extractNumbers('Improved the onboarding flow')).toEqual([]);
  });
});

describe('extractNumericFacts — measurement vs bare phrasing', () => {
  // The distinction that a bare whitelist got wrong: '2' in "2 million events" is
  // a large invented claim whose leading digit merely happens to be small, while
  // '2' in "2 idempotent passes" is ordinary phrasing.
  it.each([
    ['handled 2 million events', true, 'magnitude word'],
    ['cut runtime by 40%', true, 'percentage'],
    ['grew signups 3x', true, 'multiplier'],
    ['reduced latency to 180 ms', true, 'unit'],
    ['saved ₹2.4 lakh', true, 'currency'],
    ['supported 50k users', true, 'magnitude + unit'],
    ['ran 2 idempotent passes', false, 'bare integer, no unit'],
    ['split into 3 stages', false, 'bare integer, no unit'],
  ])('%s -> measurement=%s (%s)', (text, expected) => {
    const facts = extractNumericFacts(text);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((f) => f.measurement)).toBe(expected);
  });

  it('normalises equal values written differently', () => {
    expect(extractNumericFacts('2,000 rows')[0].value).toBe('2000');
    expect(extractNumericFacts('180.0 ms')[0].value).toBe('180');
  });
});

describe('extractNamedThings', () => {
  it('finds capitalised technology names', () => {
    const found = extractNamedThings('Migrated from MongoDB to PostgreSQL');
    expect(found).toContain('mongodb');
    expect(found).toContain('postgresql');
  });

  it('finds lowercase technology spellings a resume commonly uses', () => {
    expect(extractNamedThings('built the api in node')).toContain('node');
  });
});

describe('verifyNoNewFacts — the figures rule', () => {
  const profile = profileWith();

  it('accepts a faithful rephrasing', () => {
    const result = verifyNoNewFacts(
      'Responsible for reducing API latency from 420 ms to 180 ms using a Redis cache',
      'Cut median API latency from 420 ms to 180 ms with a Redis cache layer',
      profile
    );
    expect(result.ok).toBe(true);
  });

  it('REJECTS an invented percentage', () => {
    // The single most likely fabrication: a vague bullet "improved" into a
    // specific claim the candidate cannot defend.
    const result = verifyNoNewFacts(
      'Worked on improving application performance',
      'Improved application performance by 40%',
      profile
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('invented_number:40');
  });

  it('REJECTS an invented scale figure', () => {
    const result = verifyNoNewFacts(
      'Built an ingestion pipeline in Node',
      'Built an ingestion pipeline in Node handling 2 million events a day',
      profile
    );
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.startsWith('invented_number'))).toBe(true);
  });

  it('does not carry a figure across from a different bullet', () => {
    // A number that exists elsewhere on the resume still belongs to a different
    // role. Attributing it here would misassign someone's achievement.
    const withOtherBullet = profileWith({
      experience: [
        {
          title: 'Intern',
          company: 'Other Co',
          location: null,
          startDate: null,
          endDate: null,
          isCurrent: false,
          bullets: [{ id: bulletId('exp', 0, 0), text: 'Cut costs by 55%' }],
        },
      ],
    });
    const result = verifyNoNewFacts(
      'Maintained the reporting service',
      'Maintained the reporting service, cutting costs by 55%',
      withOtherBullet
    );
    expect(result.ok).toBe(false);
  });

  it('permits innocuous small numbers used in phrasing', () => {
    const result = verifyNoNewFacts(
      'Rebuilt the reconciliation job in Python',
      'Rebuilt the Python reconciliation job as 1 idempotent pass',
      profile
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a figure that was already in the original, reordered', () => {
    const result = verifyNoNewFacts(
      'Raised test coverage from 41 to 78 on the refund path',
      'Raised refund-path test coverage from 41 to 78',
      profile
    );
    expect(result.ok).toBe(true);
  });
});

describe('verifyNoNewFacts — the named-things rule', () => {
  const profile = profileWith();

  it('REJECTS a technology the resume never mentions', () => {
    const result = verifyNoNewFacts(
      'Deployed the service to production',
      'Deployed the service to production on Kubernetes',
      profile
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('invented_entity:kubernetes');
  });

  it('accepts a skill the candidate lists elsewhere on the resume', () => {
    // Naming a skill they already claim is reframing, not invention.
    const result = verifyNoNewFacts(
      'Sped up the nightly job',
      'Sped up the nightly Python job',
      profile
    );
    expect(result.ok).toBe(true);
  });

  it('accepts the employer named on the resume', () => {
    const result = verifyNoNewFacts(
      'Shipped an internal dashboard',
      'Shipped an internal dashboard at Zenpay Technologies',
      profile
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a multi-word phrase whose parts are all accounted for', () => {
    const result = verifyNoNewFacts(
      'Added a Redis cache to the API',
      'Added a Redis cache layer to the API',
      profile
    );
    expect(result.ok).toBe(true);
  });

  it('accepts project technologies', () => {
    const withProject = profileWith({
      projects: [
        {
          name: 'Ledgerly',
          description: null,
          technologies: ['Docker'],
          link: null,
          bullets: [],
        },
      ],
    });
    const result = verifyNoNewFacts(
      'Containerised the build',
      'Containerised the build with Docker',
      withProject
    );
    expect(result.ok).toBe(true);
  });
});

describe('verifyNoNewFacts — sentence-initial verbs are not entities', () => {
  const profile = profileWith();

  it('accepts a rewrite opening with an action verb not on any list', () => {
    // The exact false positive from the first live run: the model correctly
    // rewrote a duty-phrased bullet to open with "Produced", and the verifier
    // discarded it as an invented entity because sentence-initial words are
    // capitalised. The prompt ASKS for a strong opening verb, so rejecting
    // unlisted verbs defeated the feature.
    const result = verifyNoNewFacts(
      'Responsible for maintaining the weekly analytics report',
      'Produced the weekly analytics report',
      profile
    );
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    'Overhauled the onboarding flow',
    'Consolidated the reporting jobs',
    'Streamlined the release process',
    'Authored the internal runbook',
  ])('accepts the unlisted opening verb in "%s"', (rewritten) => {
    const result = verifyNoNewFacts(
      'Worked on the onboarding flow and reporting jobs and release process and runbook',
      rewritten,
      profile
    );
    expect(result.ok).toBe(true);
  });

  it('still catches an invented technology even at the start of a sentence', () => {
    // The exemption is by POSITION, not blanket. Shape still marks a name:
    // an internal capital gives 'MongoDB' away wherever it appears.
    const result = verifyNoNewFacts(
      'Maintained the reporting service',
      'MongoDB replication kept the reporting service online',
      profile
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('invented_entity:mongodb');
  });

  it('still catches an invented all-caps technology at the start', () => {
    const result = verifyNoNewFacts(
      'Deployed the service',
      'AWS hosted the deployed service',
      profile
    );
    expect(result.ok).toBe(false);
  });

  it('still catches an invented technology mid-sentence', () => {
    const result = verifyNoNewFacts(
      'Deployed the service to production',
      'Deployed the service to production via Terraform',
      profile
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('invented_entity:terraform');
  });
});

describe('verifyNoNewFacts — known limits', () => {
  it('CANNOT catch role escalation, which is why the prompt forbids it', () => {
    // 'supported' -> 'led' adds no number and no entity, so no token-level check
    // sees it. Documented rather than hidden: the prompt bans it explicitly and
    // the rationale is shown to the user for every suggestion.
    const result = verifyNoNewFacts(
      'Supported the migration to PostgreSQL',
      'Led the migration to PostgreSQL',
      profileWith()
    );
    expect(result.ok).toBe(true);
  });
});

describe('isMateriallyUnchanged', () => {
  it('treats an added full stop as unchanged', () => {
    // Straight from a live run: the model returned the original text with a
    // trailing period and a rationale saying it was kept unchanged. An exact
    // `===` check let that through as a suggestion that changed nothing.
    expect(
      isMateriallyUnchanged(
        'Designed a PostgreSQL schema enforcing balanced entries with database constraints',
        'Designed a PostgreSQL schema enforcing balanced entries with database constraints.'
      )
    ).toBe(true);
  });

  it('ignores case and whitespace differences', () => {
    expect(isMateriallyUnchanged('Built the API', '  built   the api ')).toBe(true);
  });

  it('ignores the em dashes and non-breaking hyphens models emit', () => {
    expect(
      isMateriallyUnchanged('Opened with a past tense verb', 'Opened with a past‑tense verb')
    ).toBe(true);
  });

  it('recognises a genuine rewrite as changed', () => {
    expect(
      isMateriallyUnchanged(
        'Responsible for maintaining the weekly analytics report',
        'Maintained the weekly analytics report'
      )
    ).toBe(false);
  });

  it('recognises a reordering as changed', () => {
    expect(
      isMateriallyUnchanged(
        'Raised coverage from 41 to 78 on the refund path',
        'Raised refund-path coverage from 41 to 78'
      )
    ).toBe(false);
  });
});

describe('selectBulletsToRewrite', () => {
  function feedback(
    id: string,
    flags: Partial<Omit<BulletFeedback, 'bulletId'>> = {}
  ): BulletFeedback {
    return {
      bulletId: id,
      isQuantified: true,
      hasActionVerb: true,
      describesOutcome: true,
      note: null,
      ...flags,
    };
  }

  const profile = profileWith({
    experience: [
      {
        title: 'Intern',
        company: 'Zenpay Technologies',
        location: null,
        startDate: null,
        endDate: null,
        isCurrent: false,
        bullets: [
          { id: 'exp.0.0', text: 'Cut median API latency from 420 ms to 180 ms' },
          { id: 'exp.0.1', text: 'Responsible for maintaining the reporting service' },
          { id: 'exp.0.2', text: 'Built an internal dashboard for the support team' },
          { id: 'exp.0.3', text: 'Python, SQL' },
        ],
      },
    ],
  });

  it('leaves strong bullets alone', () => {
    const selected = selectBulletsToRewrite(profile, [feedback('exp.0.0')]);
    expect(selected).toEqual([]);
  });

  it('puts the weakest bullet first', () => {
    // Missing an action verb is the most damaging defect, so it outranks a bullet
    // that merely lacks a figure.
    const selected = selectBulletsToRewrite(profile, [
      feedback('exp.0.2', { isQuantified: false, note: 'no figure' }),
      feedback('exp.0.1', {
        hasActionVerb: false,
        isQuantified: false,
        describesOutcome: false,
        note: 'duty',
      }),
    ]);
    expect(selected[0].id).toBe('exp.0.1');
  });

  it('skips fragments that are not achievement statements', () => {
    // 'Python, SQL' is a skills line extraction happened to capture as a bullet.
    const selected = selectBulletsToRewrite(profile, [
      feedback('exp.0.3', { isQuantified: false, describesOutcome: false }),
    ]);
    expect(selected).toEqual([]);
  });

  it('honours the batch limit', () => {
    const many = ['exp.0.1', 'exp.0.2'].map((id) =>
      feedback(id, { isQuantified: false, describesOutcome: false })
    );
    expect(selectBulletsToRewrite(profile, many, 1)).toHaveLength(1);
  });

  it('carries the original text and the weakness note through', () => {
    const selected = selectBulletsToRewrite(profile, [
      feedback('exp.0.1', { hasActionVerb: false, note: 'starts with a duty' }),
    ]);
    expect(selected[0].text).toBe(
      'Responsible for maintaining the reporting service'
    );
    expect(selected[0].note).toBe('starts with a duty');
  });
});
