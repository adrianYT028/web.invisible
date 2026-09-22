// @vitest-environment node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// LIVE end-to-end test — hits the real Groq API and costs real tokens
// -----------------------------------------------------------------------------
//
// SKIPPED BY DEFAULT. Run deliberately with:
//
//     GROQ_LIVE_TEST=1 npx vitest --run src/lib/resume/ai/live.integration.test.ts
//
// Gated because it spends money and depends on a third party being up, neither of
// which belongs in a suite that runs on every change. The other 100+ resume tests
// are hermetic and cover the logic; this one answers a different question that
// mocks cannot: does the model actually return what the prompt asks for, and does
// the full pipeline hold together on a real document?
//
// It exists because the riskiest part of this feature is the one part that cannot
// be unit tested — whether extraction reliably produces JSON matching the schema.
//
// `supabaseAdmin` is mocked so usage logging does not write to the real database;
// everything else is the genuine code path.

const LIVE = process.env.GROQ_LIVE_TEST === '1';

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({ insert: async () => ({ error: null }) }),
  }),
}));

/**
 * Load GROQ_API_KEY from .env.local.
 *
 * Vitest does not read .env.local, and `env.groqApiKey` reads process.env at call
 * time, so the key has to be placed there before the module under test runs.
 */
beforeAll(() => {
  if (!LIVE) return;
  if (process.env.GROQ_API_KEY) return;

  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^GROQ_API_KEY=(.+)$/);
    if (match) {
      process.env.GROQ_API_KEY = match[1].trim();
      break;
    }
  }
});

const RESUME_TEXT = `Aarav Sharma
Noida, Uttar Pradesh
aarav.sharma@example.com
+91 98765 43210
github.com/aaravsharma

SUMMARY
Final-year computer science student with internship experience building
production web services.

EXPERIENCE

Backend Engineering Intern, Zenpay Technologies
Bengaluru, India
Jan 2024 - Jun 2024
Reduced median API latency from 420 ms to 180 ms by adding a Redis cache layer
Rebuilt the payment reconciliation job in Python, cutting nightly runtime by 40%
Migrated a reporting service from MongoDB to PostgreSQL with no downtime

Software Engineering Intern, Lumen Analytics
Remote
May 2023 - Aug 2023
Built an ingestion pipeline in Node handling roughly 2 million events a day
Responsible for maintaining the weekly analytics report

PROJECTS

Ledgerly, a double-entry bookkeeping API
Designed a PostgreSQL schema enforcing balanced entries with database constraints

EDUCATION

Bachelor of Technology, Computer Science
Amity University, Noida
2021 - 2025
8.4 CGPA

SKILLS
Python, TypeScript, Node.js, PostgreSQL, Redis, Docker, React, Git`;

const JD_TEXT = `Backend Engineer - Acme Payments
Bengaluru, India (hybrid)

We are looking for a backend engineer with 2+ years of experience building
production Python services.

Required:
- Strong Python
- PostgreSQL and relational data modelling
- REST API design
- Bachelor's degree in Computer Science or equivalent

Nice to have:
- Redis
- Kubernetes
- Experience with payment systems

You must be legally authorised to work in India.`;

describe.skipIf(!LIVE)('LIVE — full Phase 1 pipeline', () => {
  it(
    'extracts a profile, a job description, and scores them',
    async () => {
      const { extractDocument } = await import('../extraction');
      const { assessParseQuality } = await import('../parse-quality');
      const { extractResumeProfile } = await import('./extract-profile');
      const { extractJobDescription } = await import('./extract-jd');
      const { scoreResumeAgainstJob } = await import('../scoring');

      // --- document layer (no AI) ------------------------------------------
      const raw = await extractDocument(
        new Uint8Array(Buffer.from(RESUME_TEXT, 'utf8')),
        'text/plain'
      );
      const assessment = assessParseQuality(raw);
      expect(assessment.scannable).toBe(true);

      // --- extraction (live AI) --------------------------------------------
      // SEQUENTIAL, deliberately. Groq charges prompt + max_completion_tokens
      // against a per-minute allowance up front, so Promise.all here reserves both
      // budgets in the same instant and roughly doubles peak usage against an
      // 8000 TPM ceiling. The first version of this test ran them in parallel and
      // 413'd.
      const profile = await extractResumeProfile({
        userId: 'live-test',
        resumeText: raw.text,
      });
      const jd = await extractJobDescription({
        userId: 'live-test',
        jdText: JD_TEXT,
      });

      // The profile must reflect the document, not an improved version of it.
      expect(profile.contact.email).toBe('aarav.sharma@example.com');
      expect(profile.experience.length).toBeGreaterThanOrEqual(2);
      expect(profile.education.length).toBeGreaterThanOrEqual(1);
      expect(profile.skills.length).toBeGreaterThanOrEqual(5);

      // Dates must survive as written and resolve through the shared parser.
      const firstRole = profile.experience[0];
      expect(firstRole.startDate?.year).toBe(2024);
      expect(firstRole.startDate?.month).toBe(1);

      // Bullets must be verbatim — the whole product rests on this.
      const bulletTexts = profile.experience.flatMap((r) =>
        r.bullets.map((b) => b.text)
      );
      expect(bulletTexts.some((t) => t.includes('420') && t.includes('180'))).toBe(
        true
      );

      // Bullet ids must be ours, deterministic and positional.
      expect(profile.experience[0].bullets[0].id).toBe('exp.0.0');

      // The job description must yield the three real knockouts.
      const kinds = jd.knockouts.map((k) => k.kind).sort();
      expect(kinds).toContain('years_experience');
      expect(kinds).toContain('work_authorisation');
      expect(jd.knockouts.find((k) => k.kind === 'years_experience')?.minYears).toBe(
        2
      );
      expect(jd.jobTitle?.toLowerCase()).toContain('backend');
      expect(jd.requirements.length).toBeGreaterThanOrEqual(4);
      expect(jd.requirements.some((r) => r.kind === 'nice')).toBe(true);

      // Terms must be concrete skill names, not posting filler. This is the
      // instruction that had to be added after live output returned 'experience',
      // 'essential' and 'design' as if they were skills.
      const allTerms = jd.requirements
        .flatMap((r) => r.terms)
        .map((t) => t.toLowerCase());
      for (const junk of ['experience', 'essential', 'strong', 'knowledge']) {
        expect(allTerms).not.toContain(junk);
      }

      // --- scoring (deterministic) -----------------------------------------
      const result = scoreResumeAgainstJob({
        profile,
        jd,
        parse: assessment,
        now: new Date('2026-08-25T00:00:00Z'),
      });

      // --- tailored rewrite, with the anti-fabrication guarantee live -------
      const { generateRewrites } = await import('./rewrite');
      const { verifyNoNewFacts } = await import('./verify-no-new-facts');
      const { rewrites, rejected } = await generateRewrites({
        userId: 'live-test',
        profile,
        jd,
        report: result.report,
      });
      result.report.rewrite = rewrites;

      // The guarantee, re-checked here independently of the generator: nothing
      // that reached the user may contain a fact its source bullet lacked.
      for (const r of rewrites) {
        const recheck = verifyNoNewFacts(r.original, r.rewritten, profile);
        expect(recheck.violations).toEqual([]);
        expect(r.rewritten).not.toBe(r.original);
      }
      // The fixture deliberately contains a duty-phrased bullet ("Responsible for
      // maintaining the weekly analytics report"), so there is something to fix.
      expect(rewrites.length + rejected.length).toBeGreaterThan(0);

      expect(result.overallScore).toBeGreaterThan(0);
      expect(result.overallScore).toBeLessThanOrEqual(100);
      // Python and PostgreSQL are both evidenced in bullets, so coverage should
      // be substantial rather than marginal.
      expect(result.subScores.requirementCoverage).toBeGreaterThan(50);
      // The resume has 0.5 years against a 2+ year ask, so this must be flagged.
      expect(result.report.knockouts.length).toBeGreaterThan(0);

      // Written to a file rather than console.log: vitest's console interception
      // does not reliably surface stdout from a passing test, and the point of
      // running this by hand is to READ the result.
      fs.writeFileSync(
        path.join(os.tmpdir(), 'unviewable-live-scan.json'),
        JSON.stringify(
          {
            overallScore: result.overallScore,
            subScores: result.subScores,
            profile: {
              name: profile.contact.name,
              skills: profile.skills.map((s) => s.name),
              roles: profile.experience.map((r) => ({
                title: r.title,
                start: r.startDate?.raw,
                end: r.endDate?.raw,
                bullets: r.bullets.length,
              })),
            },
            jd: {
              jobTitle: jd.jobTitle,
              requirements: jd.requirements.map((r) => ({
                kind: r.kind,
                terms: r.terms,
              })),
              knockouts: jd.knockouts,
            },
            requirements: result.report.requirements.map((r) => ({
              status: r.status,
              kind: r.kind,
              text: r.text.slice(0, 60),
              evidence: r.evidenceBulletIds,
            })),
            knockouts: result.report.knockouts.map((k) => ({
              severity: k.severity,
              kind: k.kind,
            })),
            genuineGaps: result.report.genuineGaps,
            rewrites: result.report.rewrite.map((r) => ({
              id: r.sourceBulletId,
              original: r.original,
              rewritten: r.rewritten,
              rationale: r.rationale,
            })),
            rewritesRejected: rejected,
            weakestBullets: result.report.bulletFeedback
              .filter((b) => b.note !== null)
              .map((b) => b.bulletId),
          },
          null,
          2
        )
      );
    },
    120_000
  );
});
