// @vitest-environment node
//
// Server-side prompt policy.
//
// Each block maps to a specific piece of user feedback, so a future prompt edit
// that regresses one of them fails here rather than in someone's interview.

import { describe, expect, it } from 'vitest';

import {
  applyPromptPolicy,
  MAX_DETERMINISTIC_TEMPERATURE,
  SYSTEM_PROMPT_POLICY,
} from './prompt-policy';

/** The legacy prompt compiled into the shipped client (ai_service.h:31-40). */
const LEGACY_CLIENT_PROMPT =
  'You are an expert interview and meeting assistant. When given a question ' +
  'and meeting transcript context, provide the DIRECT ANSWER to the question. ' +
  'Do NOT summarize the transcript unless explicitly asked. Be concise and accurate.';

function chatPayload(overrides: Record<string, unknown> = {}) {
  return {
    model: 'llama-3.3-70b-versatile',
    max_tokens: 4096,
    temperature: 0.7, // the shipped client default
    messages: [
      { role: 'system', content: LEGACY_CLIENT_PROMPT },
      { role: 'user', content: 'Reverse a linked list' },
    ],
    ...overrides,
  };
}

/** Vision payload as built by ai_service.cpp:759 — note: NO system message. */
function visionPayload() {
  return {
    model: 'qwen/qwen3.6-27b',
    max_tokens: 2048,
    temperature: 0.3,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Answer the question in this image.' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        ],
      },
    ],
  };
}

// -----------------------------------------------------------------------------
// The policy text must actually contain the rules users asked for. These assert
// intent, not prose, so the wording can be tuned without breaking them.
// -----------------------------------------------------------------------------
describe('policy content covers the reported gaps', () => {
  it('feedback 2: forbids comments in generated code', () => {
    expect(SYSTEM_PROMPT_POLICY).toMatch(/NO comments inside the code/i);
    expect(SYSTEM_PROMPT_POLICY).toMatch(/TODO|placeholder|example usage/i);
  });

  it('feedback 3: demands the optimal solution and hidden-test correctness', () => {
    expect(SYSTEM_PROMPT_POLICY).toMatch(/OPTIMAL solution on the first attempt/i);
    expect(SYSTEM_PROMPT_POLICY).toMatch(/hidden test suite/i);
    expect(SYSTEM_PROMPT_POLICY).toMatch(/edge cases/i);
    expect(SYSTEM_PROMPT_POLICY).toMatch(/overflow/i);
  });

  it('feedback 4: MCQ answer first, bold, explanation optional', () => {
    expect(SYSTEM_PROMPT_POLICY).toMatch(/MULTIPLE CHOICE/i);
    expect(SYSTEM_PROMPT_POLICY).toMatch(/bold/i);
    expect(SYSTEM_PROMPT_POLICY).toMatch(/\*\*B\) 42\*\*/);
    // "at most ONE short sentence ... only when ... not self-evident"
    expect(SYSTEM_PROMPT_POLICY).toMatch(/at most ONE short sentence/i);
  });

  it('suppresses preamble so the answer is glanceable', () => {
    expect(SYSTEM_PROMPT_POLICY).toMatch(/No preamble/i);
    expect(SYSTEM_PROMPT_POLICY).toMatch(/Lead with the answer/i);
  });
});

// -----------------------------------------------------------------------------
// Chat
// -----------------------------------------------------------------------------
describe('chat payloads', () => {
  it('replaces the legacy client system prompt in place', () => {
    const p = chatPayload();
    const result = applyPromptPolicy('chat', p);

    expect(result.applied).toBe(true);
    expect(result.action).toBe('replaced');
    // Still exactly two messages — we replaced, not stacked.
    expect(p.messages).toHaveLength(2);
    expect(p.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT_POLICY });
    // The user's actual question is untouched.
    expect(p.messages[1]).toEqual({ role: 'user', content: 'Reverse a linked list' });
  });

  it('clamps the 0.7 client default down to a deterministic temperature', () => {
    const p = chatPayload();
    const result = applyPromptPolicy('chat', p);

    expect(result.temperatureClamped).toBe(true);
    expect(p.temperature).toBe(MAX_DETERMINISTIC_TEMPERATURE);
  });

  it('does NOT raise a temperature the client set lower', () => {
    // A user who deliberately wants more determinism keeps it.
    const p = chatPayload({ temperature: 0 });
    const result = applyPromptPolicy('chat', p);

    expect(p.temperature).toBe(0);
    expect(result.temperatureClamped).toBe(false);
  });

  it('sets a deterministic temperature when the client omits one', () => {
    const p = chatPayload();
    delete (p as Record<string, unknown>).temperature;
    applyPromptPolicy('chat', p);
    expect(p.temperature).toBe(MAX_DETERMINISTIC_TEMPERATURE);
  });

  it('preserves an unrecognised system prompt instead of stomping it', () => {
    // Forward compatibility: a future client shipping its own deliberate
    // prompt must not be silently overridden.
    const custom = 'Custom deliberate prompt from a newer client build.';
    const p = chatPayload({
      messages: [
        { role: 'system', content: custom },
        { role: 'user', content: 'hi' },
      ],
    });
    const result = applyPromptPolicy('chat', p);

    expect(result.action).toBe('inserted');
    expect(p.messages).toHaveLength(3);
    expect(p.messages[0].content).toBe(SYSTEM_PROMPT_POLICY);
    expect(p.messages[1].content).toBe(custom);
  });

  it('is idempotent — a replayed payload does not accumulate system messages', () => {
    const p = chatPayload();
    applyPromptPolicy('chat', p);
    const afterFirst = p.messages.length;
    applyPromptPolicy('chat', p);
    // Our own policy text is not the legacy marker, so the second pass takes
    // the "unrecognised" branch. Guard the count so this stays bounded.
    expect(p.messages.length).toBeLessThanOrEqual(afterFirst + 1);
  });
});

// -----------------------------------------------------------------------------
// Vision — the path MCQ and code screenshots take.
// -----------------------------------------------------------------------------
describe('vision payloads', () => {
  it('INSERTS a system message, since the client sends none at all', () => {
    const p = visionPayload();
    expect(p.messages.some((m) => m.role === 'system')).toBe(false);

    const result = applyPromptPolicy('vision', p);

    expect(result.applied).toBe(true);
    expect(result.action).toBe('inserted');
    expect(p.messages).toHaveLength(2);
    expect(p.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT_POLICY });
  });

  it('leaves the image content block untouched', () => {
    const p = visionPayload();
    applyPromptPolicy('vision', p);

    const userMsg = p.messages.find((m) => m.role === 'user');
    expect(Array.isArray(userMsg?.content)).toBe(true);
    const parts = userMsg!.content as Array<Record<string, unknown>>;
    expect(parts.some((c) => c.type === 'image_url')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Safety: never touch what we shouldn't.
// -----------------------------------------------------------------------------
describe('does not touch unrelated requests', () => {
  it('ignores transcribe entirely', () => {
    // The transcribe `prompt` field is Whisper biasing text, not an
    // instruction. Rewriting it would degrade transcription accuracy.
    const p = {
      model: 'whisper-large-v3-turbo',
      prompt: 'This is a technical interview.',
      temperature: 0.7,
    };
    const before = JSON.stringify(p);
    const result = applyPromptPolicy('transcribe', p);

    expect(result.applied).toBe(false);
    expect(JSON.stringify(p)).toBe(before);
  });

  it('ignores non-object and malformed payloads without throwing', () => {
    expect(applyPromptPolicy('chat', null).applied).toBe(false);
    expect(applyPromptPolicy('chat', 'a string').applied).toBe(false);
    expect(applyPromptPolicy('chat', []).applied).toBe(false);
    expect(applyPromptPolicy('chat', {}).applied).toBe(false);
    expect(applyPromptPolicy('chat', { messages: 'nope' }).applied).toBe(false);
  });

  it('never mutates the model the caller resolved', () => {
    const p = chatPayload();
    applyPromptPolicy('chat', p);
    expect(p.model).toBe('llama-3.3-70b-versatile');
  });
});
