import { describe, expect, it } from 'vitest';

import {
  PROVIDER_IDS,
  allProviders,
  authHeaders,
  endpointUrl,
  endpointsFor,
  findProvider,
  isProviderId,
  keyPrefixLooksRight,
  requireProvider,
  supportsEndpoint,
  validateUrl,
  type ProviderId,
} from './providers';

const ENDPOINTS = ['chat', 'vision', 'transcribe'] as const;

describe('isProviderId', () => {
  it('accepts every registered provider', () => {
    for (const id of PROVIDER_IDS) expect(isProviderId(id)).toBe(true);
  });

  // A stored key whose provider we cannot resolve is a credential we can never
  // use, so unknown ids must be rejected rather than defaulted.
  it('rejects anything else', () => {
    expect(isProviderId('anthropic')).toBe(false);
    expect(isProviderId('gemini')).toBe(false);
    expect(isProviderId('Groq')).toBe(false);
    expect(isProviderId('')).toBe(false);
    expect(isProviderId(null)).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
    expect(isProviderId(1)).toBe(false);
  });

  // Anthropic is absent ON PURPOSE: its native API is not OpenAI-shaped and the
  // shipped desktop binaries parse replies by scanning for `"content":`, which a
  // content-block response does not contain. It belongs here only alongside a
  // translation adapter.
  it('does not yet claim to support Anthropic', () => {
    expect(findProvider('anthropic')).toBeNull();
  });
});

describe('findProvider / requireProvider', () => {
  it('returns the definition for a known id', () => {
    expect(findProvider('groq')?.label).toBe('Groq');
    expect(findProvider('openai')?.label).toBe('OpenAI');
    expect(findProvider('openrouter')?.label).toBe('OpenRouter');
  });

  it('returns null rather than throwing for an unknown id', () => {
    expect(findProvider('nope')).toBeNull();
  });

  it('throws when a validated id is somehow absent', () => {
    expect(() => requireProvider('nope' as ProviderId)).toThrow(/unknown provider/);
  });
});

describe('registry shape', () => {
  it('lists every provider in declaration order', () => {
    expect(allProviders().map((p) => p.id)).toEqual([...PROVIDER_IDS]);
  });

  it('gives every provider a label, console link and key hint', () => {
    for (const p of allProviders()) {
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.consoleUrl).toMatch(/^https:\/\//);
      expect(p.keyHint.trim().length).toBeGreaterThan(0);
    }
  });

  // A base URL with a trailing slash would produce `//chat/completions`. Some
  // providers tolerate that and some 404, which is exactly the kind of bug that
  // shows up for one provider only.
  it('has no trailing slash on any base URL', () => {
    for (const p of allProviders()) {
      expect(p.baseUrl.endsWith('/')).toBe(false);
      expect(p.baseUrl).toMatch(/^https:\/\//);
    }
  });

  it('starts every path with a slash', () => {
    for (const p of allProviders()) {
      for (const path of Object.values(p.paths)) {
        expect(path?.startsWith('/')).toBe(true);
      }
    }
  });

  it('can serve chat from every provider', () => {
    // Chat is the baseline. A provider that cannot do chat has no use here.
    for (const id of PROVIDER_IDS) expect(supportsEndpoint(id, 'chat')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The capability matrix — the part that has to reach the UI
// -----------------------------------------------------------------------------

describe('per-endpoint capability', () => {
  it('supports transcription on Groq and OpenAI', () => {
    expect(supportsEndpoint('groq', 'transcribe')).toBe(true);
    expect(supportsEndpoint('openai', 'transcribe')).toBe(true);
  });

  // OpenRouter brokers chat models and exposes no audio transcription endpoint.
  // A user whose only key is OpenRouter must be told this when they save it.
  it('does NOT support transcription on OpenRouter', () => {
    expect(supportsEndpoint('openrouter', 'transcribe')).toBe(false);
    expect(endpointUrl('openrouter', 'transcribe')).toBeNull();
  });

  it('reports the endpoint list each provider can serve', () => {
    expect([...endpointsFor('groq')].sort()).toEqual([
      'chat',
      'transcribe',
      'vision',
    ]);
    expect([...endpointsFor('openrouter')].sort()).toEqual(['chat', 'vision']);
  });

  it('treats vision as chat-with-an-image, not a distinct endpoint', () => {
    for (const id of PROVIDER_IDS) {
      if (!supportsEndpoint(id, 'vision')) continue;
      expect(endpointUrl(id, 'vision')).toBe(endpointUrl(id, 'chat'));
    }
  });
});

describe('endpointUrl', () => {
  it('builds the documented URLs', () => {
    expect(endpointUrl('groq', 'chat')).toBe(
      'https://api.groq.com/openai/v1/chat/completions'
    );
    expect(endpointUrl('groq', 'transcribe')).toBe(
      'https://api.groq.com/openai/v1/audio/transcriptions'
    );
    expect(endpointUrl('openai', 'chat')).toBe(
      'https://api.openai.com/v1/chat/completions'
    );
    expect(endpointUrl('openrouter', 'chat')).toBe(
      'https://openrouter.ai/api/v1/chat/completions'
    );
  });

  // The Groq URL must not drift: it is what every already-shipped desktop build
  // is effectively relying on through the proxy.
  it('keeps the Groq chat URL byte-identical to the hardcoded original', () => {
    expect(endpointUrl('groq', 'chat')).toBe(
      'https://api.groq.com/openai/v1/chat/completions'
    );
  });

  it('returns null for an unknown provider', () => {
    expect(endpointUrl('anthropic' as ProviderId, 'chat')).toBeNull();
  });

  it('never produces a doubled slash', () => {
    for (const id of PROVIDER_IDS) {
      for (const endpoint of ENDPOINTS) {
        const url = endpointUrl(id, endpoint);
        if (url === null) continue;
        expect(url.slice('https://'.length)).not.toContain('//');
      }
    }
  });
});

describe('validateUrl', () => {
  it('points at a free authenticated GET', () => {
    expect(validateUrl('groq')).toBe('https://api.groq.com/openai/v1/models');
    expect(validateUrl('openai')).toBe('https://api.openai.com/v1/models');
  });

  // Verified against the live API: GET https://openrouter.ai/api/v1/models
  // returns 200 with NO credential and 200 with a made-up one — the catalogue is
  // public. Probing there would have stored whatever string the user typed and
  // deferred the failure to their first real request. `/key` 401s for both.
  //
  // The general lesson this pins: a validation probe must require the credential.
  // `/models` being the conventional choice does not make it a check.
  it('does not probe OpenRouter at its PUBLIC models endpoint', () => {
    expect(validateUrl('openrouter')).toBe('https://openrouter.ai/api/v1/key');
    expect(validateUrl('openrouter')).not.toContain('/models');
  });

  it('never probes a POST-only endpoint', () => {
    for (const id of PROVIDER_IDS) {
      const url = validateUrl(id);
      expect(url).not.toContain('/chat/completions');
      expect(url).not.toContain('/audio/');
    }
  });
});

describe('authHeaders', () => {
  it('uses bearer auth for every current provider', () => {
    for (const id of PROVIDER_IDS) {
      expect(authHeaders(id, 'test-key')).toEqual({
        Authorization: 'Bearer test-key',
      });
    }
  });

  it('does not leak the key into any other header', () => {
    const headers = authHeaders('openai', 'sk-secret');
    expect(Object.keys(headers)).toEqual(['Authorization']);
  });
});

describe('keyPrefixLooksRight', () => {
  it('accepts a correctly shaped key', () => {
    expect(keyPrefixLooksRight('groq', 'gsk_abc123')).toBe(true);
    expect(keyPrefixLooksRight('openai', 'sk-abc123')).toBe(true);
    expect(keyPrefixLooksRight('openai', 'sk-proj-abc123')).toBe(true);
    expect(keyPrefixLooksRight('openrouter', 'sk-or-v1-abc')).toBe(true);
  });

  // The mistake this exists to catch: right key, wrong box.
  it('catches a key pasted under the wrong provider', () => {
    expect(keyPrefixLooksRight('groq', 'sk-abc123')).toBe(false);
    expect(keyPrefixLooksRight('openai', 'gsk_abc123')).toBe(false);
    expect(keyPrefixLooksRight('openrouter', 'sk-abc123')).toBe(false);
  });

  // An OpenRouter key also satisfies OpenAI's looser `sk-` prefix. That is
  // acceptable precisely because this is a hint: the live probe is what decides.
  it('is only a hint, and overlapping prefixes are tolerated', () => {
    expect(keyPrefixLooksRight('openai', 'sk-or-v1-abc')).toBe(true);
  });
});
