import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { extractJobDescription } from './extract-jd';
import { extractResumeProfile } from './extract-profile';

// -----------------------------------------------------------------------------
// LIVE — how much resume and job description actually fit in the budgets
// -----------------------------------------------------------------------------
//
// Costs real tokens against the real provider, so it is opt in:
//
//     GROQ_LIVE_TEST=1 npx vitest --run --reporter=verbose \
//       src/lib/resume/ai/budget-headroom.integration.test.ts
//
// WHY THIS EXISTS
//
// `token-budgets.test.ts` pins the budget NUMBERS (1600 / 1300 / 1200) so they
// cannot drift silently. It cannot say whether those numbers are big enough for a
// real document, because it never calls the provider.
//
// Users hit "This resume or job description was too long to analyse in one pass",
// which is the `truncated` code: the model ran out of completion budget before it
// finished its JSON. The INPUT limits are generous — MAX_RESUME_CHARS is 30,000 and
// a JD is trimmed to 5,000 — so the binding constraint is OUTPUT size. And output
// grows with how much STRUCTURE a document has, not its length: a dense two-page
// resume listing nine roles emits far more JSON than a wordy one-pager.
//
// So the ceiling is measured in the unit that actually binds — roles and bullets,
// requirements and keywords — not in characters.
//
// Failures are REPORTED rather than asserted. Throwing on the first one would hide
// every case after it, and the whole purpose is to find where the boundary sits.
// -----------------------------------------------------------------------------

const LIVE = process.env.GROQ_LIVE_TEST === '1';
const USER_ID = '00000000-0000-4000-8000-000000000000';

beforeAll(() => {
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

function buildResume(roles: number, bulletsPerRole: number): string {
  const lines = [
    'Jordan Blake',
    'Senior Backend Engineer',
    'jordan.blake@example.com | +91 98765 43210 | Bengaluru, India',
    '',
    'EXPERIENCE',
  ];
  for (let r = 0; r < roles; r += 1) {
    lines.push(`Company ${r + 1} — Backend Engineer, ${2010 + r} to ${2011 + r}`);
    for (let b = 0; b < bulletsPerRole; b += 1) {
      lines.push(
        `- Built and operated service ${b + 1} in Go against PostgreSQL, ` +
          'reducing p99 latency and handling reconciliation for payment flows.'
      );
    }
  }
  lines.push('', 'EDUCATION', 'BTech Computer Science, 2010', '', 'SKILLS');
  lines.push('Go, Java, PostgreSQL, Redis, Kubernetes, Docker, Kafka, gRPC, Terraform');
  return lines.join('\n');
}

function buildJd(requirements: number): string {
  const lines = ['Backend Engineer, Payments', '', 'Requirements:'];
  for (let i = 0; i < requirements; i += 1) {
    lines.push(
      `- Requirement ${i + 1}: strong experience with technology ${i + 1}, ` +
        'including production operation at scale.'
    );
  }
  lines.push('', 'Nice to have:', '- Distributed tracing', '- Redis');
  return lines.join('\n');
}

function describeError(err: unknown): string {
  const e = err as { code?: string; name?: string; message?: string };
  return `${e.code ?? e.name ?? 'unknown'} :: ${(e.message ?? String(err)).slice(0, 120)}`;
}

/**
 * Pause between live calls so the provider's per-minute budget refills.
 *
 * Without this the run is worthless for its stated purpose. The Groq account
 * allows 8,000 tokens per MINUTE in total and a single extraction spends roughly
 * 2,000-3,000, so the third call onwards returns 429 `rate_limited` — and every
 * larger case then "fails" for a reason that has nothing to do with the budget
 * being measured. The first attempt at this test reported exactly that and looked
 * like a truncation cliff.
 *
 * 65 seconds rather than 60: the provider's window is not aligned to ours, and
 * paying five extra seconds a case is cheaper than re-reading a misleading run.
 */
async function coolDown(): Promise<void> {
  await new Promise((r) => setTimeout(r, 65_000));
}

describe.skipIf(!LIVE)('LIVE — resume extraction headroom', () => {
  // Ascending, so the first genuine `truncated` IS the ceiling.
  const CASES = [
    { roles: 6, bullets: 5, label: 'dense, 6 roles x 5 bullets' },
    { roles: 9, bullets: 6, label: 'very dense, 9 roles x 6 bullets' },
    { roles: 14, bullets: 8, label: 'extreme, 14 roles x 8 bullets' },
  ];

  for (const [i, c] of CASES.entries()) {
    it(
      `extracts ${c.label}`,
      async () => {
        if (i > 0) await coolDown();
        const resumeText = buildResume(c.roles, c.bullets);
        let outcome: string;
        try {
          const profile = await extractResumeProfile({ userId: USER_ID, resumeText });
          const bullets = (profile.experience ?? []).reduce(
            (n, role) => n + ((role.bullets ?? []).length as number),
            0
          );
          outcome =
            `OK   roles=${profile.experience?.length ?? 0} bullets=${bullets} ` +
            `skills=${profile.skills?.length ?? 0}`;
        } catch (err) {
          outcome = `FAIL ${describeError(err)}`;
        }
        console.log(`  [resume] ${c.label.padEnd(32)} chars=${String(resumeText.length).padStart(5)} ${outcome}`);
        expect(outcome).toBeTruthy();
      },
      180_000
    );
  }
});

describe.skipIf(!LIVE)('LIVE — job description headroom', () => {
  const CASES = [20, 30, 45];

  for (const [i, n] of CASES.entries()) {
    it(
      `extracts a JD with ${n} requirements`,
      async () => {
        await coolDown();
        void i;
        const jdText = buildJd(n);
        let outcome: string;
        try {
          const jd = await extractJobDescription({ userId: USER_ID, jdText });
          outcome =
            `OK   requirements=${jd.requirements?.length ?? 0} ` +
            `knockouts=${jd.knockouts?.length ?? 0} keywords=${jd.keywords?.length ?? 0}`;
        } catch (err) {
          outcome = `FAIL ${describeError(err)}`;
        }
        console.log(`  [jd]     ${String(n).padStart(2)} requirements${' '.repeat(20)} chars=${String(jdText.length).padStart(5)} ${outcome}`);
        expect(outcome).toBeTruthy();
      },
      180_000
    );
  }
});
