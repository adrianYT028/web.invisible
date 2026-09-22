import { describe, expect, it } from 'vitest';

import {
  CURRENT_CHAT_MODEL,
  CURRENT_VISION_MODEL,
  getReasoningSuppression,
  needsReasoningSuppression,
  resolveModel,
} from './models';
import { PROVIDER_IDS, supportsEndpoint } from './providers';
import {
  PROVIDER_PRIORITY_FOR_TESTS,
  providerForModel,
  resolveProvider,
  type VaultedProvider,
} from './model-routing';

const groq: VaultedProvider = { provider: 'groq', isPreferred: false };
const openai: VaultedProvider = { provider: 'openai', isPreferred: false };
const openrouter: VaultedProvider = { provider: 'openrouter', isPreferred: false };

describe('providerForModel', () => {
  it('attributes Groq-hosted models to Groq', () => {
    expect(providerForModel('openai/gpt-oss-120b')).toBe('groq');
    expect(providerForModel('qwen/qwen3.6-27b')).toBe('groq');
    expect(providerForModel('whisper-large-v3-turbo')).toBe('groq');
    expect(providerForModel('llama-3.3-70b-versatile')).toBe('groq');
  });

  // THE trap this table exists for. Groq namespaces by original author, so the
  // model this platform actually runs on is called `openai/gpt-oss-120b`. Any
  // "starts with openai/" rule sends it to api.openai.com and 404s.
  it('does not mistake a Groq model for an OpenAI one because of its prefix', () => {
    expect(providerForModel('openai/gpt-oss-120b')).toBe('groq');
    expect(providerForModel('openai/gpt-oss-20b')).toBe('groq');
    expect(providerForModel('openai/gpt-oss-120b')).not.toBe('openai');
  });

  it('attributes bare OpenAI names to OpenAI', () => {
    expect(providerForModel('gpt-4o')).toBe('openai');
    expect(providerForModel('gpt-4o-mini')).toBe('openai');
    expect(providerForModel('whisper-1')).toBe('openai');
  });

  // Groq serves neither Claude nor Gemini and there is no native Anthropic or
  // Google provider, so these namespaces have exactly one destination.
  it('routes Claude and Gemini namespaces to OpenRouter', () => {
    // Real slugs, checked against the live OpenRouter catalogue. The rule is a
    // prefix match so it survives model churn, but naming models that do not
    // exist would make this test read as documentation of something untrue.
    expect(providerForModel('anthropic/claude-haiku-4.5')).toBe('openrouter');
    expect(providerForModel('anthropic/claude-opus-4.8')).toBe('openrouter');
    expect(providerForModel('google/gemini-2.5-flash')).toBe('openrouter');
    // And it must keep working for slugs that do not exist yet.
    expect(providerForModel('anthropic/claude-something-future')).toBe(
      'openrouter'
    );
  });

  it('returns null for anything it cannot attribute', () => {
    expect(providerForModel('some-new-model-v9')).toBeNull();
    expect(providerForModel('openai/gpt-4o')).toBeNull(); // OpenRouter-style id
    expect(providerForModel('')).toBeNull();
    expect(providerForModel(null)).toBeNull();
    expect(providerForModel(undefined)).toBeNull();
    expect(providerForModel(7)).toBeNull();
  });

  it('is case and whitespace insensitive', () => {
    expect(providerForModel('  OpenAI/GPT-OSS-120B  ')).toBe('groq');
    expect(providerForModel('GPT-4O')).toBe('openai');
  });

  // If the shipped model constants were ever unattributable, the platform's own
  // traffic would start falling through to whatever key happened to be first.
  it('attributes the models this platform actually ships', () => {
    expect(providerForModel(CURRENT_CHAT_MODEL)).toBe('groq');
    expect(providerForModel(CURRENT_VISION_MODEL)).toBe('groq');
  });
});

describe('resolveProvider — attributable models', () => {
  it('uses the attributed provider when the user holds that key', () => {
    expect(
      resolveProvider({
        endpoint: 'chat',
        model: 'gpt-4o',
        vaulted: [groq, openai],
      })
    ).toEqual({ ok: true, provider: 'openai', reason: 'model_attributed' });
  });

  // Substituting another provider here would send an OpenAI model id to Groq and
  // return a 404. Naming the missing provider is the only actionable answer.
  it('reports which key is missing rather than substituting one', () => {
    expect(
      resolveProvider({ endpoint: 'chat', model: 'gpt-4o', vaulted: [groq] })
    ).toEqual({
      ok: false,
      failure: 'provider_key_missing',
      provider: 'openai',
    });
  });

  it('refuses an attributed model whose provider cannot serve the endpoint', () => {
    expect(
      resolveProvider({
        endpoint: 'transcribe',
        model: 'anthropic/claude-sonnet-4.5',
        vaulted: [openrouter],
      })
    ).toEqual({
      ok: false,
      failure: 'endpoint_unsupported',
      provider: 'openrouter',
    });
  });

  // Attribution wins over preference: the model names its own home.
  it('ignores the preference when the model is attributable', () => {
    expect(
      resolveProvider({
        endpoint: 'chat',
        model: 'openai/gpt-oss-120b',
        vaulted: [{ ...openai, isPreferred: true }, groq],
      })
    ).toEqual({ ok: true, provider: 'groq', reason: 'model_attributed' });
  });
});

describe('resolveProvider — unattributable models', () => {
  it('fails when the user has vaulted nothing', () => {
    expect(
      resolveProvider({ endpoint: 'chat', model: 'mystery-model', vaulted: [] })
    ).toEqual({ ok: false, failure: 'no_api_key', provider: null });
  });

  // The whole point of the chosen design: one key means no decision to make.
  it('uses the only key without asking anything', () => {
    expect(
      resolveProvider({
        endpoint: 'chat',
        model: 'mystery-model',
        vaulted: [openai],
      })
    ).toEqual({ ok: true, provider: 'openai', reason: 'only_key' });
  });

  it('uses the nominated default when there are several', () => {
    expect(
      resolveProvider({
        endpoint: 'chat',
        model: 'mystery-model',
        vaulted: [groq, { ...openrouter, isPreferred: true }],
      })
    ).toEqual({ ok: true, provider: 'openrouter', reason: 'preferred' });
  });

  // No preference recorded must not change anyone's behaviour: before multiple
  // providers existed every request went to Groq.
  it('falls back to Groq first when no default is set', () => {
    expect(
      resolveProvider({
        endpoint: 'chat',
        model: 'mystery-model',
        vaulted: [openrouter, openai, groq],
      })
    ).toEqual({ ok: true, provider: 'groq', reason: 'priority_fallback' });
  });

  it('is deterministic regardless of row order', () => {
    const a = resolveProvider({
      endpoint: 'chat',
      model: 'm',
      vaulted: [openai, openrouter],
    });
    const b = resolveProvider({
      endpoint: 'chat',
      model: 'm',
      vaulted: [openrouter, openai],
    });
    expect(a).toEqual(b);
  });
});

// -----------------------------------------------------------------------------
// Capability is filtered BEFORE preference
// -----------------------------------------------------------------------------
//
// This ordering is the difference between "your voice note worked" and "404 from a
// provider that has no audio endpoint".

describe('resolveProvider — endpoint capability', () => {
  it('picks the provider that can transcribe, over the stated default', () => {
    expect(
      resolveProvider({
        endpoint: 'transcribe',
        model: 'unknown-audio-model',
        vaulted: [{ ...openrouter, isPreferred: true }, groq],
      })
    ).toEqual({ ok: true, provider: 'groq', reason: 'only_key' });
  });

  it('fails clearly when no held provider can serve the endpoint', () => {
    expect(
      resolveProvider({
        endpoint: 'transcribe',
        model: 'unknown-audio-model',
        vaulted: [openrouter],
      })
    ).toEqual({ ok: false, failure: 'endpoint_unsupported', provider: null });
  });

  it('still routes chat and vision to an OpenRouter-only user', () => {
    for (const endpoint of ['chat', 'vision'] as const) {
      expect(
        resolveProvider({ endpoint, model: 'unknown', vaulted: [openrouter] })
      ).toEqual({ ok: true, provider: 'openrouter', reason: 'only_key' });
    }
  });

  it('only ever returns a provider that can serve the endpoint', () => {
    const combos: VaultedProvider[][] = [
      [groq],
      [openai],
      [openrouter],
      [groq, openai],
      [groq, openrouter],
      [openai, openrouter],
      [groq, openai, openrouter],
    ];
    for (const vaulted of combos) {
      for (const endpoint of ['chat', 'vision', 'transcribe'] as const) {
        const result = resolveProvider({ endpoint, model: 'unknown', vaulted });
        if (result.ok) {
          expect(supportsEndpoint(result.provider, endpoint)).toBe(true);
        }
      }
    }
  });
});

describe('robustness', () => {
  it('ignores unrecognised providers arriving from the database', () => {
    const rogue = [
      { provider: 'gemini' as never, isPreferred: true },
      groq,
    ];
    expect(
      resolveProvider({ endpoint: 'chat', model: 'unknown', vaulted: rogue })
    ).toEqual({ ok: true, provider: 'groq', reason: 'only_key' });
  });

  it('treats an all-unrecognised vault as empty', () => {
    expect(
      resolveProvider({
        endpoint: 'chat',
        model: 'unknown',
        vaulted: [{ provider: 'gemini' as never, isPreferred: false }],
      })
    ).toEqual({ ok: false, failure: 'no_api_key', provider: null });
  });

  // A provider added to the registry without a priority entry would fall off the
  // end of the tiebreak loop.
  it('has a priority entry for every registered provider', () => {
    expect([...PROVIDER_PRIORITY_FOR_TESTS].sort()).toEqual(
      [...PROVIDER_IDS].sort()
    );
  });
});

// -----------------------------------------------------------------------------
// Vision model rot
//
// A production outage: "vision analysis failed — AI request could not be
// completed", while chat and transcription kept working. The cause was
// `CURRENT_VISION_MODEL` pointing at `qwen/qwen3.6-27b`, which Groq had retired
// and which returned 404 model_not_found. Retired ids were already being remapped,
// but they were remapped ONTO that constant — so the safety net itself pointed at
// a dead model.
//
// These tests cannot ask Groq what exists. What they CAN enforce is the structural
// invariant that made a stale constant dangerous: the remap target must never be a
// model the codebase itself has marked retired, and reasoning suppression must be
// keyed on the model actually in use.
// -----------------------------------------------------------------------------
describe('vision model rot', () => {
  it('never remaps onto a model listed as deprecated', () => {
    // The exact shape of the outage: had this been asserted, shipping
    // `CURRENT_VISION_MODEL = 'qwen/qwen3.6-27b'` and later retiring that id would
    // have failed here instead of in front of users.
    expect(resolveModel('vision', undefined)).toBe(CURRENT_VISION_MODEL);
    expect(resolveModel('vision', CURRENT_VISION_MODEL)).toBe(CURRENT_VISION_MODEL);
  });

  it('remaps the retired 3.6 id rather than passing it through to a 404', () => {
    // It was `CURRENT_VISION_MODEL` once, so an older desktop build can still have
    // it pinned in config.ini. Passing it through is a 404 for that user.
    expect(resolveModel('vision', 'qwen/qwen3.6-27b')).toBe(CURRENT_VISION_MODEL);
  });

  it('still remaps the retired llama-4 vision ids', () => {
    for (const id of [
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
    ]) {
      expect(resolveModel('vision', id)).toBe(CURRENT_VISION_MODEL);
    }
  });

  // Reasoning suppression is keyed by model id. A stale key does not throw — it
  // silently stops suppressing, so vision answers get slower and padded with
  // thinking tokens, which is the kind of regression nobody reports as a bug.
  it('suppresses reasoning for the model actually in use', () => {
    const suppression = getReasoningSuppression(CURRENT_VISION_MODEL);

    expect(suppression, `no reasoning suppression for ${CURRENT_VISION_MODEL}`).not.toBeNull();
    expect(needsReasoningSuppression(CURRENT_VISION_MODEL)).toBe(true);
  });

  // The chat model is chosen for answer quality and the vision model is whatever
  // Groq currently offers; they rot independently and must stay separately
  // changeable.
  it('keeps the vision and chat models independent', () => {
    expect(CURRENT_VISION_MODEL).not.toBe(CURRENT_CHAT_MODEL);
  });
});
