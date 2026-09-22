// -----------------------------------------------------------------------------
// Resume text → ResumeProfile
// -----------------------------------------------------------------------------
//
// Produces THE shared object of the platform. Job matching, cold-mail drafting and
// interview prep are all views over this rather than separate parses of the same
// PDF, so the cost of getting it wrong here is paid by every feature downstream.
//
// Extraction only: the model transcribes what the resume says into structure. It
// does not judge, score, improve, or infer anything the document does not state.

import {
  bulletId,
  emptyProfile,
  normaliseTerm,
  PROFILE_SCHEMA_VERSION,
  type ResumeBullet,
  type ResumeCertification,
  type ResumeDate,
  type ResumeEducation,
  type ResumeProfile,
  type ResumeProject,
  type ResumeRole,
  type ResumeSkill,
} from '../schema';
import { parseResumeDate } from '../parse-quality';
import { structuredCompletion } from './client';

/**
 * Output budget.
 *
 * SIZED AGAINST THE ACCOUNT'S TOKENS-PER-MINUTE CEILING, not against how much a
 * resume might need. Groq charges `prompt_tokens + max_completion_tokens` against
 * the TPM allowance UP FRONT, so an oversized budget is not free headroom — it is
 * spent whether or not the model uses it. The measured allowance is 8000 TPM on
 * the on-demand tier, so an 8000 budget consumed the entire minute and returned
 * HTTP 413 before the model ran at all. That was the first live failure.
 *
 * ---------------------------------------------------------------------------
 * RE-MEASURED against `RESUME_EXTRACTION_MODEL`, on a REAL one-page resume
 * rather than a fixture. The previous note here claimed
 * "prompt 421 + reasoning 124 + output 678" and was measured against a model that
 * had since been replaced — see the model-coupling note in ./client.ts. The real
 * numbers were 4x the prompt and 2.3x the output, and every scan truncated.
 *
 *   prompt 1476 + reasoning 63 + output 1123 = 1186 completion
 *
 * A COMPLETE SCAN MAKES THREE CALLS — profile, job description, rewrite — and the
 * provider reserves prompt + max_completion_tokens against the per-minute
 * allowance UP FRONT for each. So what matters is the SUM of the three
 * RESERVATIONS (prompt included), not the headroom on any one call. That is the
 * arithmetic that was wrong before: the three budgets alone summed to 5800, which
 * looked fine, but with real prompts the reservations summed to ~9550 against a
 * ceiling of 8000.
 *
 * Reservations now, with real measured prompts:
 *   profile   1476 prompt + 1600 = 3076   (needs 1186)
 *   jd        1070 prompt + 1300 = 2370   (needs ~690)
 *   rewrite   1200 prompt + 1200 = 2400   (needs ~960)
 *   ----------------------------------
 *   7846 against an 8000/minute ceiling
 *
 * THAT IS ~150 TOKENS OF HEADROOM, WHICH IS NOT ENOUGH. A two-page resume has a
 * larger prompt and a larger profile, and will exceed the ceiling and fail with a
 * rate limit rather than a truncation. The 8000 TPM on-demand tier is the binding
 * constraint on this whole feature and raising it is a prerequisite for promoting
 * the resume analyser, not an optimisation.
 *
 * Raise these only alongside the TPM limit, and raise them together.
 */
const MAX_TOKENS = 1600;

/** Longest resume text accepted, in characters. */
const MAX_RESUME_CHARS = 30_000;

/**
 * The extraction prompt.
 *
 * Two instructions carry disproportionate weight:
 *
 *   DATES ARE COPIED VERBATIM. The model must not normalise "Jan 2024" into
 *   "2024-01". Resume dates are ambiguous by nature and `parseResumeDate` is the
 *   single place that resolves them, shared with the parse-quality gate so the
 *   diagnostics and the profile can never disagree about what a date meant. A
 *   model that silently invents a month makes every tenure calculation wrong.
 *
 *   NOTHING IS INVENTED. Extraction that "improves" a bullet corrupts the
 *   evidence the whole product is built on: the rewrite step is explicitly
 *   forbidden from adding facts, and that guarantee is worthless if the profile it
 *   works from already contains fabrications.
 */
function buildPrompt(resumeText: string): string {
  return `Extract structured data from the resume below.

Return ONLY a JSON object with exactly this shape:
{
  "contact": { "name": string|null, "email": string|null, "phone": string|null, "location": string|null,
               "links": [{ "kind": string, "url": string }] },
  "summary": string|null,
  "skills": [{ "name": string, "category": string|null }],
  "experience": [{ "title": string|null, "company": string|null, "location": string|null,
                   "startDate": string|null, "endDate": string|null, "isCurrent": boolean,
                   "bullets": [string] }],
  "education": [{ "institution": string|null, "degree": string|null, "field": string|null,
                  "startDate": string|null, "endDate": string|null, "score": string|null }],
  "projects": [{ "name": string|null, "description": string|null, "technologies": [string],
                 "link": string|null, "bullets": [string] }],
  "certifications": [{ "name": string|null, "issuer": string|null, "date": string|null }],
  "sectionsFound": [string]
}

RULES

Copy, do not improve
- Transcribe what the resume says. Never invent, embellish, infer or reword.
- Bullets are copied VERBATIM, exactly as written, including any numbers. Do not
  rewrite them, do not fix grammar, do not add metrics.
- If a field is absent from the resume, return null. Never guess.

Dates
- Copy every date EXACTLY as the resume writes it, as a string. "Jan 2024",
  "01/2024", "2021", "Present" — all kept verbatim.
- Do NOT convert dates to any other format. Do not add a month that is not there.
- "isCurrent" is true when the end date says Present, Current, Ongoing or similar.

Skills
- "name" as the resume writes it. "category" is one of language, framework, tool,
  database, cloud, soft, domain — or null if unclear.
- List each skill once.

Sections
- "sectionsFound" lists the section headings the resume actually uses, lowercased,
  in the order they appear.

RESUME
${resumeText}`;
}

interface RawProfile {
  contact?: unknown;
  summary?: unknown;
  skills?: unknown;
  experience?: unknown;
  education?: unknown;
  projects?: unknown;
  certifications?: unknown;
  sectionsFound?: unknown;
}

/**
 * Extract a structured profile from already-extracted resume text.
 *
 * Takes text rather than bytes: document parsing and the parse-quality gate run
 * first, and a document that failed the gate never reaches this function. There is
 * no point spending inference on text we already know is mangled.
 */
export async function extractResumeProfile(input: {
  userId: string;
  resumeText: string;
}): Promise<ResumeProfile> {
  const resumeText = input.resumeText.slice(0, MAX_RESUME_CHARS);

  const raw = await structuredCompletion<RawProfile>({
    userId: input.userId,
    endpoint: 'resume_profile_extract',
    prompt: buildPrompt(resumeText),
    maxCompletionTokens: MAX_TOKENS,
  });

  const experience = asExperience(raw.experience);
  const projects = asProjects(raw.projects);

  return {
    ...emptyProfile(),
    contact: asContact(raw.contact),
    summary: asStringOrNull(raw.summary),
    // Skills are attached to their evidence AFTER roles and projects are built,
    // because `evidenceBulletIds` refers to bullet ids that only exist by then.
    skills: asSkills(raw.skills, [...allBulletsOf(experience), ...allBulletsOf(projects)]),
    experience,
    education: asEducation(raw.education),
    projects,
    certifications: asCertifications(raw.certifications),
    sectionsFound: asStringArray(raw.sectionsFound).map((s) => s.toLowerCase()),
  };
}

/** The schema version this extractor produces, for `resumes.profile_schema_version`. */
export const EXTRACTED_PROFILE_SCHEMA_VERSION = PROFILE_SCHEMA_VERSION;

// -----------------------------------------------------------------------------
// Validation. Model output is untrusted input.
// -----------------------------------------------------------------------------

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Resolve a date string through the shared parser.
 *
 * `parseResumeDate` is the same function the parse-quality gate uses to decide
 * whether a resume's dates are readable, so a date counted as parseable there is
 * resolved identically here.
 */
function asDate(value: unknown): ResumeDate | null {
  const raw = asStringOrNull(value);
  if (!raw) return null;
  return parseResumeDate(raw);
}

function asContact(value: unknown): ResumeProfile['contact'] {
  const base = emptyProfile().contact;
  if (value === null || typeof value !== 'object') return base;
  const row = value as Record<string, unknown>;

  const links: Array<{ kind: string; url: string }> = [];
  if (Array.isArray(row.links)) {
    for (const entry of row.links) {
      if (entry === null || typeof entry !== 'object') continue;
      const link = entry as Record<string, unknown>;
      const url = asStringOrNull(link.url);
      if (!url) continue;
      links.push({ kind: asStringOrNull(link.kind) ?? 'other', url });
    }
  }

  return {
    name: asStringOrNull(row.name),
    email: asStringOrNull(row.email),
    phone: asStringOrNull(row.phone),
    location: asStringOrNull(row.location),
    links,
  };
}

/**
 * Skills, each linked to the bullets that demonstrate it.
 *
 * The link is computed here rather than asked of the model, because it must agree
 * exactly with how requirement coverage searches bullets — and because a model
 * asked to cite evidence will cite bullets that do not mention the skill.
 * `evidenceBulletIds` being empty is meaningful: it is the difference between a
 * skill that is listed and one that is demonstrated, which is what stops a
 * keyword-stuffed resume scoring well.
 */
function asSkills(value: unknown, bullets: ResumeBullet[]): ResumeSkill[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const out: ResumeSkill[] = [];

  for (const entry of value) {
    let name: string | null = null;
    let category: string | null = null;

    if (typeof entry === 'string') {
      name = entry.trim();
    } else if (entry !== null && typeof entry === 'object') {
      const row = entry as Record<string, unknown>;
      name = asStringOrNull(row.name);
      category = asStringOrNull(row.category);
    }
    if (!name) continue;

    const normalised = normaliseTerm(name);
    if (normalised.length === 0 || seen.has(normalised)) continue;
    seen.add(normalised);

    const evidenceBulletIds = bullets
      .filter((bullet) => normaliseTerm(bullet.text).includes(normalised))
      .map((bullet) => bullet.id);

    out.push({ name, normalised, category, evidenceBulletIds });
  }
  return out;
}

function asExperience(value: unknown): ResumeRole[] {
  if (!Array.isArray(value)) return [];
  const out: ResumeRole[] = [];

  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') return;
    const row = entry as Record<string, unknown>;
    const endDate = asDate(row.endDate);
    const rawEnd = asStringOrNull(row.endDate)?.toLowerCase() ?? '';

    out.push({
      title: asStringOrNull(row.title),
      company: asStringOrNull(row.company),
      location: asStringOrNull(row.location),
      startDate: asDate(row.startDate),
      endDate,
      // Trust the model's flag, but also derive it from the date text so a role
      // ending "Present" is current even when the flag is missing. Getting this
      // wrong silently truncates tenure and misfires the experience knockout.
      isCurrent:
        row.isCurrent === true ||
        /present|current|ongoing|till date|to date/.test(rawEnd),
      bullets: asBullets(row.bullets, 'exp', index),
    });
  });
  return out;
}

function asProjects(value: unknown): ResumeProject[] {
  if (!Array.isArray(value)) return [];
  const out: ResumeProject[] = [];

  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') return;
    const row = entry as Record<string, unknown>;
    out.push({
      name: asStringOrNull(row.name),
      description: asStringOrNull(row.description),
      technologies: asStringArray(row.technologies),
      link: asStringOrNull(row.link),
      bullets: asBullets(row.bullets, 'proj', index),
    });
  });
  return out;
}

/**
 * Bullets with stable ids.
 *
 * Ids are assigned here, by position, not by the model. They are the handle the
 * rewrite step uses to say "here is a better version of exp.0.2" and the report
 * uses to render a side-by-side diff, so they must be deterministic — a model
 * inventing its own ids would break every cross-reference in the report.
 */
function asBullets(
  value: unknown,
  scope: 'exp' | 'proj',
  parentIndex: number
): ResumeBullet[] {
  return asStringArray(value).map((text, i) => ({
    id: bulletId(scope, parentIndex, i),
    text,
  }));
}

function allBulletsOf(items: Array<{ bullets: ResumeBullet[] }>): ResumeBullet[] {
  return items.flatMap((item) => item.bullets);
}

function asEducation(value: unknown): ResumeEducation[] {
  if (!Array.isArray(value)) return [];
  const out: ResumeEducation[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    out.push({
      institution: asStringOrNull(row.institution),
      degree: asStringOrNull(row.degree),
      field: asStringOrNull(row.field),
      startDate: asDate(row.startDate),
      endDate: asDate(row.endDate),
      // Verbatim: Indian resumes mix CGPA out of 10, percentages and GPA out of
      // 4, and coercing them to one scale produces nonsense comparisons.
      score: asStringOrNull(row.score),
    });
  }
  return out;
}

function asCertifications(value: unknown): ResumeCertification[] {
  if (!Array.isArray(value)) return [];
  const out: ResumeCertification[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    out.push({
      name: asStringOrNull(row.name),
      issuer: asStringOrNull(row.issuer),
      date: asDate(row.date),
    });
  }
  return out;
}
