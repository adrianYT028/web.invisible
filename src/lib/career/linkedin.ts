import { structuredCompletion } from '@/lib/resume/ai/client';
import { verifyNoNewFacts } from '@/lib/resume/ai/verify-no-new-facts';
import type { ResumeProfile } from '@/lib/resume/schema';

import { clip, profileForPrompt, type CareerProfile } from './shared';

// -----------------------------------------------------------------------------
// LinkedIn headline + About, written only from what the resume already says
// -----------------------------------------------------------------------------
//
// Same guarantee as the resume rewrite: every sentence is checked with
// `verifyNoNewFacts` against the WHOLE resume text. Any sentence that adds a
// number, company, tool or other named thing the resume does not contain is
// removed before the user sees it, and the response says how many were removed.
// -----------------------------------------------------------------------------

/** LinkedIn's own limits: headline 220 characters, About 2,600. */
export const HEADLINE_MAX = 220;
export const ABOUT_MAX = 2600;

/** Headline + About + skills as JSON, at low reasoning effort. */
const MAX_TOKENS = 1600;

export interface LinkedInDraft {
  headline: string;
  about: string;
  topSkills: string[];
  /** Sentences dropped because they claimed something the resume does not. */
  removed: number;
  targetRole: string | null;
}

interface ModelOutput {
  headline?: unknown;
  about?: unknown;
  topSkills?: unknown;
}

function buildPrompt(profile: ResumeProfile, targetRole: string | null): string {
  return `You write LinkedIn profiles for students and early-career job seekers in India.

Write a LinkedIn headline and About section for this person, using ONLY facts in the resume below.

Hard rules:
- Never add a number, percentage, company, tool, technology, award or outcome that is not in the resume.
- Do not invent experience. If they are a student, say so plainly.
- Plain, confident, first person ("I"). No emojis, no hashtags, no buzzwords like "passionate", "rockstar" or "ninja".
- Headline: at most 200 characters. Format like "Role/what they do | 2-3 key skills | what they are looking for".
- About: 3 short paragraphs, 120-220 words total. 1) who they are and what they work on, 2) the strongest 2-3 things they have actually done, from the resume, 3) what they are looking for next.
- topSkills: the 5 most relevant skills, copied exactly as written in the resume.
${targetRole ? `- They are aiming for: ${targetRole}. Emphasise the resume facts most relevant to that, without inventing any.\n` : ''}
Reply with JSON only:
{"headline": string, "about": string, "topSkills": string[]}

Resume:
${profileForPrompt(profile)}`;
}

/**
 * Ordinary profile words that start a headline segment or sentence ("Looking
 * for…", "Aspiring…"). The fact check reads a capitalised word as a possible
 * named thing, so without these every honest headline would fail. None of them
 * is a fact that could be invented.
 */
const PROFILE_WORDS = [
  'looking', 'seeking', 'open', 'aspiring', 'student', 'students', 'intern', 'internship',
  'internships', 'fresher', 'graduate', 'undergraduate', 'final', 'year', 'final-year',
  'currently', 'passionate', 'curious', 'eager', 'interested', 'focused', 'building',
  'learning', 'working', 'engineer', 'engineering', 'developer', 'analyst', 'designer',
  'software', 'web', 'full', 'stack', 'full-stack', 'frontend', 'backend', 'data',
  'science', 'computer', 'roles', 'role', 'opportunities', 'my', 'me', 'next', 'outside',
  'when', 'today', 'right', 'now', 'hi', 'hello', 'recently', 'previously',
];

/**
 * The profile, widened for checking prose rather than a single bullet: the
 * user's degree, field, college and certifications are facts they already claim,
 * so naming them in a LinkedIn sentence is not an invention. Added as pseudo
 * skills (each whole name and each word), which is what `verifyNoNewFacts`
 * reads as "already claimed". Used only for the check, never shown.
 */
export function withKnownTerms(profile: ResumeProfile): ResumeProfile {
  const extra = new Set<string>(PROFILE_WORDS);
  const add = (value: string | null | undefined) => {
    if (!value) return;
    extra.add(value);
    for (const w of value.split(/[\s,()/|]+/)) if (w) extra.add(w);
  };
  for (const e of profile.education) {
    add(e.degree);
    add(e.field);
    add(e.institution);
  }
  for (const c of profile.certifications) {
    add(c.name);
    add(c.issuer);
  }
  for (const r of profile.experience) add(r.location);
  add(profile.contact.location);
  return {
    ...profile,
    skills: [
      ...profile.skills,
      ...[...extra].map((name) => ({
        name,
        normalised: name.toLowerCase(),
        category: null,
        evidenceBulletIds: [],
      })),
    ],
  };
}

/** Split text into sentences, keeping paragraph breaks. */
function sentences(paragraph: string): string[] {
  return paragraph.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

export async function generateLinkedInDraft(
  userId: string,
  source: CareerProfile,
  targetRole: string | null
): Promise<LinkedInDraft> {
  const out = await structuredCompletion<ModelOutput>({
    userId,
    endpoint: 'linkedin_optimise',
    prompt: buildPrompt(source.profile, targetRole),
    maxCompletionTokens: MAX_TOKENS,
  });

  let removed = 0;
  const checkProfile = withKnownTerms(source.profile);
  const passes = (text: string) => {
    const ok = verifyNoNewFacts(source.text, text, checkProfile).ok;
    if (!ok) removed += 1;
    return ok;
  };

  // Headline: if it fails the check, fall back to one built from resume facts.
  let headline = clip(out.headline, HEADLINE_MAX);
  if (!headline || !passes(headline)) {
    const role = source.profile.experience[0]?.title ?? (source.profile.education[0]?.degree ? `${source.profile.education[0].degree} student` : 'Student');
    const skills = source.profile.skills.slice(0, 3).map((s) => s.name).join(', ');
    headline = clip([role, skills].filter(Boolean).join(' | '), HEADLINE_MAX);
  }

  // About: keep only the sentences that pass, paragraph by paragraph.
  const rawAbout = typeof out.about === 'string' ? out.about : '';
  const paragraphs = rawAbout
    .split(/\n\s*\n|\n/)
    .map((p) => sentences(p).filter(passes).join(' '))
    .filter((p) => p.length > 0);
  const about = clip(paragraphs.join('\n\n'), ABOUT_MAX);

  // Skills: only ones the resume actually lists.
  const listed = new Map(source.profile.skills.map((s) => [s.name.toLowerCase(), s.name]));
  const topSkills = (Array.isArray(out.topSkills) ? out.topSkills : [])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => listed.get(s.trim().toLowerCase()))
    .filter((s): s is string => Boolean(s))
    .slice(0, 5);

  return { headline, about, topSkills, removed, targetRole };
}
