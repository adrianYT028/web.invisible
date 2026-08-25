import type { AiEndpoint } from '@/lib/ai/models';

// -----------------------------------------------------------------------------
// Server-side prompt policy.
//
// WHY THIS EXISTS
//   The desktop client hardcodes its prompts in the compiled binary:
//     - chat:   ai_service.cpp:497 pushes {"system", config_.systemPrompt},
//               defined in ai_service.h:31-40
//     - vision: ai_service.cpp:759 embeds guidance in the USER text and sends
//               NO system message at all
//   Fixing prompt quality by editing C++ means a rebuild, a re-signed
//   installer, a new release row, and every existing user staying broken until
//   they update. Rewriting the payload here fixes every already-installed copy
//   on the next request.
//
//   This follows the precedent already set in _shared.ts, which rewrites
//   `payload.model` and injects `reasoning_effort` for exactly the same reason.
//
// WHAT USER FEEDBACK THIS ADDRESSES
//   2. "code output has random comments, hard to read and copy cleanly"
//      -> the old prompts never mentioned comments at all.
//   3. "doesn't give the optimal solution that passes all test cases first try"
//      -> the old prompts never mentioned efficiency, edge cases, or tests,
//         and chat ran at temperature 0.7.
//   4. "for MCQs give the correct option first in bold, explanation optional"
//      -> chat said nothing about MCQs; vision said "state the correct option
//         and explain why", which forces an explanation and never asked for
//         bold.
//
// KEEPING THIS IN SYNC
//   When a future desktop build ships better prompts of its own, bump
//   PROMPT_POLICY_VERSION and teach `shouldReplaceSystemMessage` to recognise
//   the newer client prompt so we stop overriding it.
// -----------------------------------------------------------------------------

/** Bump when the policy text changes, so logs can be correlated to behaviour. */
export const PROMPT_POLICY_VERSION = 2;

/**
 * Distinctive fragment of the legacy client system prompt (ai_service.h:31).
 * Used to detect "this is the old hardcoded prompt, safe to replace" rather
 * than blindly stomping whatever the client sent.
 */
const LEGACY_SYSTEM_PROMPT_MARKER = 'expert interview and meeting assistant';

/**
 * Chat requests default to temperature 0.7 (ai_service.h:24). That is a
 * reasonable creative-writing default and a poor one for the work this product
 * actually does: coding answers and multiple-choice questions have a single
 * correct output, and sampling entropy is what produces the "not the optimal
 * solution" complaint. The vision path already uses 0.3.
 *
 * We clamp rather than force: a client asking for something LOWER (more
 * deterministic) keeps its value.
 */
export const MAX_DETERMINISTIC_TEMPERATURE = 0.3;

/**
 * The policy. Written for a user who is mid-interview and can only glance at
 * the overlay, so every rule optimises for "readable and usable in seconds".
 */
export const SYSTEM_PROMPT_POLICY = `You are Unviewable, a real-time interview and meeting assistant. The user is live in an interview, exam, or meeting right now and can only glance at your answer. Optimise for an answer they can read and act on in seconds.

ANSWER FIRST
- Lead with the answer itself. Do not restate the question, describe the input, or narrate what you are about to do.
- No preamble ("Sure", "Great question", "Let me help"), no sign-off, no "hope this helps".

MULTIPLE CHOICE QUESTIONS
- First line is the correct option in bold, including its letter and text. Example: **B) 42**
- Then at most ONE short sentence of justification, and only when the reason is not self-evident. If the answer speaks for itself, give the bold option alone and stop.
- Do not walk through why each other option is wrong unless explicitly asked.

CODE
- Give ONE complete, correct, ready-to-run solution inside a single fenced code block.
- Write NO comments inside the code. The user copies it directly and comments get in the way. The only exception is a genuinely non-obvious algorithmic step, which may carry at most one short comment. Never annotate obvious lines, never add section banners, never leave TODO, placeholder, or "example usage" comments.
- Deliver the OPTIMAL solution on the first attempt: the best practical time and space complexity, not a brute force you intend to refine later.
- Assume a full hidden test suite, not just the sample case. Handle edge cases correctly: empty input, single element, duplicates, already-sorted input, negative numbers, integer overflow, and null or missing values.
- Use clear, conventional names so the code reads without commentary.
- After the code block you may add ONE line stating time and space complexity. Nothing else.
- Do not offer alternative approaches unless asked.

EVERYTHING ELSE
- Be direct and concrete. Prefer specific values, names, and numbers over general description.
- Keep lines short and scannable. Avoid dense paragraphs.
- If the question is ambiguous, answer the most likely interpretation rather than asking for clarification.`;

// -----------------------------------------------------------------------------
// Payload shapes
// -----------------------------------------------------------------------------

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asMessageArray(payload: Record<string, unknown>): ChatMessage[] | null {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return null;
  return messages as ChatMessage[];
}

/**
 * Whether an existing system message is the legacy hardcoded client prompt and
 * can therefore be replaced outright.
 */
function shouldReplaceSystemMessage(content: unknown): boolean {
  return (
    typeof content === 'string' &&
    content.toLowerCase().includes(LEGACY_SYSTEM_PROMPT_MARKER)
  );
}

export interface PromptPolicyResult {
  /** Whether the payload was modified. */
  applied: boolean;
  /** What happened, for structured logging. */
  action: 'replaced' | 'inserted' | 'none';
  /** Whether the temperature was clamped down. */
  temperatureClamped: boolean;
}

/**
 * Apply the prompt policy to an outbound chat/vision payload, in place.
 *
 * Only touches `chat` and `vision`. `transcribe` is multipart audio with no
 * prompt to govern, and its `prompt` field is Whisper biasing text, not an
 * instruction — rewriting it would corrupt transcription accuracy.
 *
 * Behaviour:
 *   - An existing system message that matches the legacy client prompt is
 *     REPLACED (chat).
 *   - No system message present -> ours is INSERTED at the front (vision, and
 *     any future client that omits one).
 *   - A system message we do not recognise is left alone and ours is prepended,
 *     so a future client with its own deliberate prompt is not silently
 *     overridden.
 */
export function applyPromptPolicy(
  endpoint: AiEndpoint,
  payload: unknown
): PromptPolicyResult {
  const none: PromptPolicyResult = {
    applied: false,
    action: 'none',
    temperatureClamped: false,
  };

  if (endpoint !== 'chat' && endpoint !== 'vision') return none;
  if (!isRecord(payload)) return none;

  const messages = asMessageArray(payload);
  if (!messages) return none;

  const systemIndex = messages.findIndex((m) => m?.role === 'system');

  // Two outcomes only:
  //   replaced - the existing system message is the legacy client prompt, so
  //              swap it out and keep the message count the same.
  //   inserted - either there is no system message (vision, which sends none,
  //              and is why screenshot answers ignored the formatting rules),
  //              or there is one we do not recognise and must not stomp
  //              (a future client shipping its own deliberate prompt). Both
  //              cases prepend ours and leave anything existing in place.
  let action: 'replaced' | 'inserted';
  if (
    systemIndex >= 0 &&
    shouldReplaceSystemMessage(messages[systemIndex]?.content)
  ) {
    messages[systemIndex] = { role: 'system', content: SYSTEM_PROMPT_POLICY };
    action = 'replaced';
  } else {
    messages.unshift({ role: 'system', content: SYSTEM_PROMPT_POLICY });
    action = 'inserted';
  }

  // Clamp sampling entropy for deterministic work (feedback item 3).
  let temperatureClamped = false;
  const temp = payload.temperature;
  if (typeof temp === 'number' && Number.isFinite(temp)) {
    if (temp > MAX_DETERMINISTIC_TEMPERATURE) {
      payload.temperature = MAX_DETERMINISTIC_TEMPERATURE;
      temperatureClamped = true;
    }
  } else if (temp === undefined) {
    payload.temperature = MAX_DETERMINISTIC_TEMPERATURE;
    temperatureClamped = true;
  }

  // Reaching here always means the policy was installed, either by replacing
  // or by inserting, so `applied` is unconditionally true.
  return { applied: true, action, temperatureClamped };
}
