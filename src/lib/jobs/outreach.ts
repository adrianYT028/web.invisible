// -----------------------------------------------------------------------------
// Cold email drafting
// -----------------------------------------------------------------------------
//
// Writes one short email for one job, grounded in the match report that was just
// produced for it.
//
// THE SAME ANTI-FABRICATION RULE AS THE RESUME REWRITE, FOR A SHARPER REASON.
// A resume exaggeration is discovered at interview; an email exaggeration is the
// first thing a stranger ever reads about the candidate, and it is the reason the
// reply never comes. So the draft may only reference requirements the scan marked
// `met`, with the bullets that evidenced them — never a gap, never an invented
// metric, never enthusiasm dressed as experience.
//
// The output is a DRAFT. It is stored, shown to the user, and opened in their own
// mail client. The platform sends nothing: a shared domain doing student cold
// outreach is blacklisted within weeks, and after that none of their mail lands
// anywhere.

import { logSafe } from '@/lib/http';
import { structuredCompletion } from '@/lib/resume/ai/client';
import type { MatchReport, ResumeProfile } from '@/lib/resume/schema';

/**
 * Output budget.
 *
 * An email is short. Sized against the same per-minute allowance the rest of the
 * pipeline shares — see the budget table in src/lib/resume/ai/extract-profile.ts.
 * Preparing one job runs a job-description extraction, a rewrite, and this, so
 * this one has to stay small.
 */
const MAX_TOKENS = 1100;

/** Longest body we will keep. A cold email past this does not get read. */
const MAX_BODY_CHARS = 1400;
const MAX_SUBJECT_CHARS = 120;

export interface OutreachDraft {
  subject: string;
  body: string;
}

function buildPrompt(input: {
  profile: ResumeProfile;
  report: MatchReport;
  jobTitle: string;
  company: string;
  recipientName: string | null;
}): string {
  const { profile, report, jobTitle, company, recipientName } = input;

  // Only requirements the scan actually credited, with their evidence. This is
  // what keeps the email true: it can only talk about things the resume proved.
  const met = report.requirements
    .filter((r) => r.status === 'met')
    .slice(0, 4)
    .map((r) => r.text);

  const bulletById = new Map<string, string>();
  for (const role of profile.experience) {
    for (const b of role.bullets) bulletById.set(b.id, b.text);
  }
  for (const project of profile.projects) {
    for (const b of project.bullets) bulletById.set(b.id, b.text);
  }

  const evidence = report.requirements
    .filter((r) => r.status === 'met')
    .flatMap((r) => r.evidenceBulletIds)
    .slice(0, 4)
    .map((id) => bulletById.get(id))
    .filter((t): t is string => typeof t === 'string');

  const greeting = recipientName
    ? `The recipient is called ${recipientName}.`
    : 'You do not know the recipient\u2019s name, so open with "Hello" and no name.';

  return `Write a short cold email from a candidate applying for a job.

Return ONLY a JSON object of this exact shape:
{ "subject": string, "body": string }

THE ABSOLUTE RULE
Everything you claim must come from the EVIDENCE below. Do not invent, estimate,
or embellish any achievement, number, employer, technology, or outcome. Do not
claim familiarity with anything not listed. Do not reference the requirements the
candidate does NOT meet.

If the evidence is thin, write a shorter email. A short honest email gets replies;
an inflated one is the reason they do not.

STYLE
- Under 120 words in the body. Nobody reads more from a stranger.
- Plain sentences. No "I am writing to express my keen interest". No "passionate".
  No "synergy". No exclamation marks.
- Structure: one line on why this role, one or two on the single most relevant
  thing they have actually done, one closing line asking for a short conversation.
- ${greeting}
- Sign off with "Best," and then the candidate's first name on its own line.
- No placeholders. No [square brackets]. No "insert here". The draft must be
  sendable as written.
- Do not mention a resume attachment; the candidate decides that.

SUBJECT
Specific and plain. Reference the role. Under 70 characters. Not "Application" and
not a sales-style hook.

ROLE
${jobTitle} at ${company}

CANDIDATE
Name: ${profile.contact.name ?? 'unknown'}

REQUIREMENTS THIS CANDIDATE GENUINELY MEETS
${met.length > 0 ? met.map((r) => `- ${r}`).join('\n') : '- (none identified — keep the email very short and ask about the role)'}

EVIDENCE FROM THEIR RESUME (verbatim; the only facts you may use)
${evidence.length > 0 ? evidence.map((e) => `- ${e}`).join('\n') : '- (no strong bullets available)'}`;
}

interface RawDraft {
  subject?: unknown;
  body?: unknown;
}

/**
 * Draft one outreach email.
 *
 * Returns null rather than throwing when the model output is unusable: an email is
 * an enhancement to a prepared job, so its absence must not fail the item that
 * already carries a match report and a tailored rewrite.
 */
export async function draftOutreachEmail(input: {
  userId: string;
  profile: ResumeProfile;
  report: MatchReport;
  jobTitle: string;
  company: string;
  recipientName: string | null;
}): Promise<OutreachDraft | null> {
  const raw = await structuredCompletion<RawDraft>({
    userId: input.userId,
    endpoint: 'resume_outreach',
    prompt: buildPrompt(input),
    maxCompletionTokens: MAX_TOKENS,
  });

  const subject =
    typeof raw.subject === 'string' ? raw.subject.trim().slice(0, MAX_SUBJECT_CHARS) : '';
  const body = typeof raw.body === 'string' ? raw.body.trim().slice(0, MAX_BODY_CHARS) : '';

  if (subject.length === 0 || body.length === 0) return null;

  // A draft containing a placeholder is worse than no draft: the user sends it
  // without noticing and the recipient reads "[Your Name]".
  if (hasPlaceholder(subject) || hasPlaceholder(body)) {
    logSafe('outreach_placeholder_rejected', { userId: input.userId });
    return null;
  }

  return { subject, body };
}

/**
 * Whether text still contains an unfilled placeholder.
 *
 * Covers the bracket conventions models reach for, plus the literal instruction
 * words. A false positive costs one draft; a false negative gets sent to a real
 * hiring manager.
 */
export function hasPlaceholder(text: string): boolean {
  if (/\[[^\]]{2,40}\]/.test(text)) return true;
  if (/\{\{?[^}]{2,40}\}?\}/.test(text)) return true;
  if (/<[A-Za-z ]{2,30}>/.test(text)) return true;
  if (/\b(insert|your name here|company name here|xxx+|tbd|lorem ipsum)\b/i.test(text)) {
    return true;
  }
  return false;
}
