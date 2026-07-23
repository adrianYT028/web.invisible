// @vitest-environment node
//
// Unit tests for the Groq client wrapper (task 4.3) of the ai-proxy-key-vault
// feature. Exercises src/lib/groq/client.ts:
//
//   validateGroqKey(key)                     — Req 1.3, 1.4, 1.5
//   forwardToGroq(endpoint, payload, key, s) — Req 3.6, 3.7
//
// Runs in the `node` environment (see docblock) because the module targets a
// server-side `fetch` and has no DOM dependency. The global `fetch` is stubbed
// per test so no real network call is ever made.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardToGroq, validateGroqKey, type GroqEndpoint } from './client';

const MODELS_URL = 'https://api.groq.com/openai/v1/models';
const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** A minimal Response-like stub for validateGroqKey (reads only `.status`). */
function statusResponse(status: number) {
  return { status } as unknown as Response;
}

/** A minimal Response-like stub for forwardToGroq (reads `.status` + bytes). */
function bytesResponse(status: number, bytes: ArrayBuffer) {
  return {
    status,
    arrayBuffer: async () => bytes,
  } as unknown as Response;
}

/** Encode a JSON value to an ArrayBuffer, as an upstream body would arrive. */
function jsonBytes(value: unknown): ArrayBuffer {
  const u8 = new TextEncoder().encode(JSON.stringify(value));
  // Return a standalone ArrayBuffer slice.
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/** An abort-style rejection like a `fetch` aborted by an AbortController. */
function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// -----------------------------------------------------------------------------
// validateGroqKey
// -----------------------------------------------------------------------------

describe('validateGroqKey', () => {
  it('returns { ok: true } on 200 and calls GET /models with a bearer header (Req 1.3)', async () => {
    const fetchMock = vi.fn(async () => statusResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await validateGroqKey('gsk_test_key');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(MODELS_URL);
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer gsk_test_key',
    });
    // A signal is attached for the 10s timeout.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns invalid_key on 401 (Req 1.4)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse(401)));
    expect(await validateGroqKey('bad')).toEqual({
      ok: false,
      reason: 'invalid_key',
    });
  });

  it('returns invalid_key on 403 (Req 1.4)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse(403)));
    expect(await validateGroqKey('bad')).toEqual({
      ok: false,
      reason: 'invalid_key',
    });
  });

  it('returns unavailable on a 5xx upstream error (Req 1.5)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse(503)));
    expect(await validateGroqKey('k')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('returns unavailable on a network throw (Req 1.5)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network failure');
      })
    );
    expect(await validateGroqKey('k')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('returns unavailable when the request aborts (timeout) (Req 1.5)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abortError();
      })
    );
    expect(await validateGroqKey('k')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('maps the 10s AbortController timeout to unavailable (Req 1.3/1.5)', async () => {
    vi.useFakeTimers();

    // fetch that only settles when its signal aborts — mirroring a real hung
    // request that the 10s timer eventually cancels.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(abortError()));
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = validateGroqKey('k');
    // Advance past the 10s validation timeout so the AbortController fires.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
    // The signal we aborted is the one handed to fetch.
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// forwardToGroq
// -----------------------------------------------------------------------------

describe('forwardToGroq', () => {
  it('attaches Authorization: Bearer <apiKey> and forwards the caller signal (Req 3.6/3.7)', async () => {
    const respBytes = jsonBytes({ ok: true });
    const fetchMock = vi.fn(async () => bytesResponse(200, respBytes));
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    await forwardToGroq('chat', { model: 'x' }, 'gsk_forward', controller.signal);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer gsk_forward' });
    // The caller owns the 60s timeout: its exact signal instance is forwarded.
    expect(init.signal).toBe(controller.signal);
    expect(init.method).toBe('POST');
  });

  it.each<[GroqEndpoint, string]>([
    ['chat', CHAT_URL],
    ['vision', CHAT_URL],
    ['transcribe', TRANSCRIBE_URL],
  ])('posts %s to the correct upstream URL (Req 3.6)', async (endpoint, url) => {
    const fetchMock = vi.fn(async () => bytesResponse(200, jsonBytes({})));
    vi.stubGlobal('fetch', fetchMock);

    await forwardToGroq(endpoint, { a: 1 }, 'k', new AbortController().signal);

    expect(fetchMock.mock.calls[0][0]).toBe(url);
  });

  it('JSON-encodes plain-object payloads with a JSON content type (Req 3.6)', async () => {
    const fetchMock = vi.fn(async () => bytesResponse(200, jsonBytes({})));
    vi.stubGlobal('fetch', fetchMock);

    const payload = { model: 'llama', messages: [{ role: 'user' }] };
    await forwardToGroq('chat', payload, 'k', new AbortController().signal);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify(payload));
  });

  it('passes an already-encoded body (FormData) through without a JSON content type', async () => {
    const fetchMock = vi.fn(async () => bytesResponse(200, jsonBytes({})));
    vi.stubGlobal('fetch', fetchMock);

    const form = new FormData();
    form.append('file', 'audio-bytes');
    await forwardToGroq('transcribe', form, 'k', new AbortController().signal);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(form);
    // fetch infers the multipart Content-Type — we must not force JSON.
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('returns { status, body, usage } and passes response bytes through verbatim (Req 3.6)', async () => {
    const upstream = { id: 'abc', choices: [{ text: 'hi' }] };
    const respBytes = jsonBytes(upstream);
    vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(200, respBytes)));

    const result = await forwardToGroq(
      'chat',
      {},
      'k',
      new AbortController().signal
    );

    expect(result.status).toBe(200);
    // Verbatim: the exact bytes round-trip back to the original object.
    const decoded = JSON.parse(new TextDecoder().decode(result.body));
    expect(decoded).toEqual(upstream);
    expect(new Uint8Array(result.body)).toEqual(new Uint8Array(respBytes));
  });

  it('propagates a non-200 upstream status verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(429, jsonBytes({}))));
    const result = await forwardToGroq(
      'chat',
      {},
      'k',
      new AbortController().signal
    );
    expect(result.status).toBe(429);
  });

  it('parses token usage when present (Req 3.8 accounting)', async () => {
    const bytes = jsonBytes({
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
    vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(200, bytes)));

    const result = await forwardToGroq(
      'chat',
      {},
      'k',
      new AbortController().signal
    );

    expect(result.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    });
  });

  it('defaults missing individual usage counts to 0', async () => {
    const bytes = jsonBytes({ usage: { prompt_tokens: 5 } });
    vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(200, bytes)));

    const result = await forwardToGroq(
      'chat',
      {},
      'k',
      new AbortController().signal
    );

    expect(result.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it('returns usage: null when the response carries no usage object', async () => {
    const bytes = jsonBytes({ choices: [{ text: 'no usage here' }] });
    vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(200, bytes)));

    const result = await forwardToGroq(
      'chat',
      {},
      'k',
      new AbortController().signal
    );

    expect(result.usage).toBeNull();
  });

  it('returns usage: null for a non-JSON (e.g. streaming) body', async () => {
    const bytes = new TextEncoder().encode('data: {"delta":"hi"}\n\n').buffer;
    vi.stubGlobal('fetch', vi.fn(async () => bytesResponse(200, bytes)));

    const result = await forwardToGroq(
      'chat',
      {},
      'k',
      new AbortController().signal
    );

    expect(result.usage).toBeNull();
  });

  it('rejects when the caller aborts the passed signal (60s timeout owned by caller) (Req 3.7)', async () => {
    // A hung upstream that only settles on abort — the caller's AbortController
    // is responsible for cancelling it.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(abortError()));
          })
      )
    );

    const controller = new AbortController();
    const pending = forwardToGroq('chat', {}, 'k', controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
