import { structuredCompletion } from '@/lib/resume/ai/client';

import { clip, profileForPrompt, type CareerProfile } from './shared';

// -----------------------------------------------------------------------------
// Mock interview practice: questions for a role, feedback on each answer
// -----------------------------------------------------------------------------
//
// This is PRACTICE before the interview, on the website. Questions come from the
// job (when there is one) and the user's own resume, so they sound like what
// this employer would actually ask. Feedback is kind, specific and short, and
// the "stronger answer" only uses facts from the resume, with [brackets] where
// the user must fill in a real example of their own.
// -----------------------------------------------------------------------------

export const QUESTIONS_PER_SESSION = 5;
const QUESTIONS_MAX_TOKENS = 1400;
const FEEDBACK_MAX_TOKENS = 1300;
const MAX_JD_IN_PROMPT = 5000;
export const MAX_ANSWER_CHARS = 4000;

export type QuestionKind = 'about_you' | 'behavioural' | 'role' | 'technical';

export interface InterviewQuestion {
  id: string;
  kind: QuestionKind;
  question: string;
  /** One line on what a good answer covers, shown after answering. */
  tip: string;
}

export interface InterviewSession {
  role: string;
  company: string | null;
  questions: InterviewQuestion[];
}

export interface AnswerFeedback {
  /** 1 (needs a lot of work) to 5 (strong). */
  score: number;
  strengths: string[];
  improve: string[];
  betterAnswer: string;
}

const KINDS: QuestionKind[] = ['about_you', 'behavioural', 'role', 'technical'];

function questionsPrompt(input: {
  role: string;
  company: string | null;
  jdText: string | null;
  resume: CareerProfile | null;
}): string {
  return `You are an experienced interviewer at an Indian company hiring for an entry-level or internship role.

Write exactly ${QUESTIONS_PER_SESSION} interview questions for this candidate, in the order an interview would go:
1 "about_you" question (e.g. tell me about yourself), 2 "behavioural" questions (a real situation: teamwork, a problem, a deadline),
1 "role" question (why this role/company, or about the work itself), and 1 "technical" question matched to the role and the candidate's skills.

Rules:
- Make them specific to the role${input.jdText ? ' and the job description' : ''}${input.resume ? ' and to things on the candidate\'s resume (mention a project or skill by name where it fits)' : ''}.
- One clear question each, under 30 words. No multi-part questions.
- "tip": one short sentence on what a strong answer includes.

Reply with JSON only:
{"questions": [{"kind": "about_you"|"behavioural"|"role"|"technical", "question": string, "tip": string}]}

Role: ${input.role}${input.company ? ` at ${input.company}` : ''}
${input.jdText ? `\nJob description:\n${input.jdText.slice(0, MAX_JD_IN_PROMPT)}\n` : ''}${input.resume ? `\nCandidate resume:\n${profileForPrompt(input.resume.profile, 4000)}` : '\nNo resume available: keep questions general for the role.'}`;
}

export async function generateQuestions(
  userId: string,
  input: { role: string; company: string | null; jdText: string | null; resume: CareerProfile | null }
): Promise<InterviewSession> {
  const out = await structuredCompletion<{ questions?: unknown }>({
    userId,
    endpoint: 'interview_questions',
    prompt: questionsPrompt(input),
    maxCompletionTokens: QUESTIONS_MAX_TOKENS,
  });

  const raw = Array.isArray(out.questions) ? out.questions : [];
  const questions: InterviewQuestion[] = raw
    .map((q, i) => {
      const item = (q ?? {}) as Record<string, unknown>;
      const kind = KINDS.includes(item.kind as QuestionKind) ? (item.kind as QuestionKind) : 'role';
      return {
        id: `q${i + 1}`,
        kind,
        question: clip(item.question, 300),
        tip: clip(item.tip, 240),
      };
    })
    .filter((q) => q.question.length > 10)
    .slice(0, QUESTIONS_PER_SESSION);

  // A fallback so a thin model reply never leaves the user with nothing.
  if (questions.length === 0) {
    questions.push(
      { id: 'q1', kind: 'about_you', question: 'Tell me about yourself.', tip: 'Two minutes: who you are, what you have built, and why this role.' },
      { id: 'q2', kind: 'behavioural', question: 'Tell me about a time you solved a difficult problem.', tip: 'Situation, what you did, and the result.' },
      { id: 'q3', kind: 'role', question: `Why do you want to work as a ${input.role}?`, tip: 'Connect your experience to what the role needs.' }
    );
  }

  return { role: input.role, company: input.company, questions };
}

function feedbackPrompt(
  session: InterviewSession,
  question: InterviewQuestion,
  answer: string,
  resume: CareerProfile | null
): string {
  return `You are a supportive interview coach for a student or fresher in India. Give honest, specific feedback on one practice answer.

Scoring (1-5): 1 = off-topic or a few words, 2 = vague with no example, 3 = relevant but generic, 4 = clear with a specific example, 5 = specific, structured (situation, action, result) and tied to the role.

Rules:
- "strengths": 1-3 short points about what is genuinely good. If nothing is, say what they got right in intent.
- "improve": 1-3 short, practical fixes.
- "betterAnswer": a stronger version of THEIR answer in first person, 80-150 words. Use only facts from their answer or their resume. Never invent a company, number, project, award or result. Where a real example or number is needed and they did not give one, write a placeholder in square brackets like [a project you built] or [the result, with a number if you have one].
- Plain, kind English. No emojis.

Reply with JSON only:
{"score": number, "strengths": string[], "improve": string[], "betterAnswer": string}

Role: ${session.role}${session.company ? ` at ${session.company}` : ''}
Question: ${question.question}
Their answer: ${answer}
${resume ? `\nTheir resume:\n${profileForPrompt(resume.profile, 3500)}` : ''}`;
}

export async function scoreAnswer(
  userId: string,
  session: InterviewSession,
  question: InterviewQuestion,
  answer: string,
  resume: CareerProfile | null
): Promise<AnswerFeedback> {
  const out = await structuredCompletion<Record<string, unknown>>({
    userId,
    endpoint: 'interview_feedback',
    prompt: feedbackPrompt(session, question, answer.slice(0, MAX_ANSWER_CHARS), resume),
    maxCompletionTokens: FEEDBACK_MAX_TOKENS,
  });

  const list = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .map((s) => clip(s, 240))
      .filter(Boolean)
      .slice(0, 3);
  const score = Math.min(5, Math.max(1, Math.round(Number(out.score) || 1)));

  return {
    score,
    strengths: list(out.strengths),
    improve: list(out.improve),
    betterAnswer: clip(out.betterAnswer, 1500),
  };
}
