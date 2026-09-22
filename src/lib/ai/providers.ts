// -----------------------------------------------------------------------------
// Provider registry — where a request goes, and how it is authenticated
// -----------------------------------------------------------------------------
//
// Before this module, Groq was hardcoded in five places: a base-URL constant in
// `src/lib/groq/client.ts`, a second copy in `src/lib/resume/ai/client.ts`, the
// `Bearer` header, the key-validation probe, and the single `GROQ_API_KEY`
// accessor. Supporting a user's own OpenAI or OpenRouter key means those all
// become a function of which provider the request is for.
//
// ---------------------------------------------------------------------------
// WHY EVERY PROVIDER HERE IS OPENAI-SHAPED
//
// The desktop app is a shipped C++ binary that cannot be updated in the field.
// It builds OpenAI-shaped request bodies by string concatenation and — the part
// that constrains everything — parses responses by scanning for `"content":`
// (`ParseChatResponse` in src/ai_service.cpp) and `"text":` for transcription.
// The proxy returns the upstream body VERBATIM.
//
// So a provider can be added here with configuration alone if and only if it
// speaks the OpenAI Chat Completions shape in both directions. Groq, OpenAI and
// OpenRouter all do.
//
// Anthropic's native API does NOT: it uses `/v1/messages`, an `x-api-key` header,
// a required `anthropic-version` header, a separate top-level `system` field, a
// different image content block, and it replies with a `content` ARRAY of typed
// blocks. Installed desktop builds would find no `"content":"…"` string in that
// and surface an empty answer. Anthropic therefore needs a request/response
// translation adapter, not a registry entry, and is deliberately absent until
// that exists. Claude is reachable today through `openrouter`.
//
// Anthropic does publish an OpenAI-compatibility layer, but their own
// documentation describes it as intended for testing and comparing models rather
// than as a production solution, so it is not a foundation to put a paid product
// on. See https://platform.claude.com/docs/en/api/openai-sdk
//
// ---------------------------------------------------------------------------
// CAPABILITY IS PER PROVIDER PER ENDPOINT
//
// This is the part that must reach the UI. `transcribe` is not something every
// provider has: OpenRouter is chat/vision only and has no audio transcription
// endpoint whatsoever. A user whose only key is OpenRouter can use chat and
// vision and will get a hard failure on voice. Telling them that when they save
// the key is honest; letting them find out mid-interview is not.

import type { AiEndpoint } from './models';

export const PROVIDER_IDS = Object.freeze([
  'groq',
  'openai',
  'openrouter',
] as const);

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** How the provider's credential is attached to an outbound request. */
export type AuthScheme =
  /** `Authorization: Bearer <key>` — every provider here, today. */
  | 'bearer';

export interface ProviderDefinition {
  id: ProviderId;
  /** Shown in the account UI. */
  label: string;
  /** Origin + version prefix. No trailing slash. */
  baseUrl: string;
  authScheme: AuthScheme;
  /**
   * Path per endpoint, appended to `baseUrl`. An endpoint absent from this map
   * is NOT SUPPORTED by the provider — that absence is the capability model, so
   * a missing path can never be mistaken for a default.
   */
  paths: Partial<Record<AiEndpoint, string>>;
  /**
   * A cheap GET used to prove a key works before it is stored. Must be
   * idempotent, free, and — critically — must actually REQUIRE the credential.
   *
   * Do not assume `/models` satisfies that. OpenRouter serves its model list
   * publicly and returns 200 for a bogus key, so pointing the probe there would
   * mean storing whatever the user typed and only discovering it was wrong on
   * their first real request. Each entry below was checked against the live API
   * with both no key and an invalid key; both must be rejected.
   */
  validatePath: string;
  /** Where a user gets a key. Rendered as a link in the UI. */
  consoleUrl: string;
  /** Placeholder/help text. NOT used for validation — see keyPrefix. */
  keyHint: string;
  /**
   * Known prefix of this provider's keys, when it has a stable one.
   *
   * Used only to catch the obvious paste-in-the-wrong-box mistake and to give a
   * better message than a failed liveness probe. It is NEVER the sole check: a
   * provider can change its format, so the authoritative test is always the live
   * call to `validatePath`. Null means "no reliable prefix, do not guess".
   */
  keyPrefix: string | null;
}

const PROVIDER_DEFINITIONS: Readonly<Record<ProviderId, ProviderDefinition>> =
  Object.freeze({
    groq: {
      id: 'groq',
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      authScheme: 'bearer',
      paths: {
        chat: '/chat/completions',
        // Vision is chat with an image content block, not a separate endpoint.
        vision: '/chat/completions',
        transcribe: '/audio/transcriptions',
      },
      validatePath: '/models',
      consoleUrl: 'https://console.groq.com/keys',
      keyHint: 'gsk_…',
      keyPrefix: 'gsk_',
    },
    openai: {
      id: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      authScheme: 'bearer',
      paths: {
        chat: '/chat/completions',
        vision: '/chat/completions',
        transcribe: '/audio/transcriptions',
      },
      validatePath: '/models',
      consoleUrl: 'https://platform.openai.com/api-keys',
      keyHint: 'sk-…',
      // Covers `sk-`, `sk-proj-` and the other sub-forms.
      keyPrefix: 'sk-',
    },
    openrouter: {
      id: 'openrouter',
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      authScheme: 'bearer',
      paths: {
        chat: '/chat/completions',
        vision: '/chat/completions',
        // NO transcribe. OpenRouter brokers chat models; it exposes no audio
        // transcription endpoint. Omitted rather than pointed somewhere hopeful.
      },
      // NOT `/models`. OpenRouter serves its model catalogue PUBLICLY: a GET
      // with no credential returns 200, and so does a GET with a made-up key.
      // Using it as the liveness probe would have accepted any string a user
      // typed and stored it as a valid key, with the failure only surfacing later
      // on a real chat request. `/key` returns the authenticated key's own
      // metadata and 401s for anything invalid. Verified against the live API.
      validatePath: '/key',
      consoleUrl: 'https://openrouter.ai/keys',
      keyHint: 'sk-or-…',
      keyPrefix: 'sk-or-',
    },
  });

/** Narrowing helper for values from a request body or a database column. */
export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    (PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/** Look up a provider, or null when the id is not one we can call. */
export function findProvider(id: unknown): ProviderDefinition | null {
  return isProviderId(id) ? PROVIDER_DEFINITIONS[id] : null;
}

/**
 * Look up a provider, throwing when absent.
 *
 * For call sites that have already validated the id and would otherwise have to
 * handle an impossible null.
 */
export function requireProvider(id: ProviderId): ProviderDefinition {
  const provider = PROVIDER_DEFINITIONS[id];
  if (!provider) {
    throw new Error(`providers: unknown provider "${id}"`);
  }
  return provider;
}

/** Every provider, in declaration order, for rendering the account UI. */
export function allProviders(): readonly ProviderDefinition[] {
  return PROVIDER_IDS.map((id) => PROVIDER_DEFINITIONS[id]);
}

/** Whether this provider can serve this endpoint at all. */
export function supportsEndpoint(
  id: ProviderId,
  endpoint: AiEndpoint
): boolean {
  return PROVIDER_DEFINITIONS[id]?.paths[endpoint] !== undefined;
}

/** Which endpoints this provider can serve. Drives the capability copy in the UI. */
export function endpointsFor(id: ProviderId): readonly AiEndpoint[] {
  const paths = PROVIDER_DEFINITIONS[id]?.paths ?? {};
  return (Object.keys(paths) as AiEndpoint[]).filter(
    (endpoint) => paths[endpoint] !== undefined
  );
}

/**
 * The absolute URL for a provider + endpoint, or null when unsupported.
 *
 * Returning null rather than a best guess is the point: an unsupported endpoint
 * must fail as "this provider cannot do that", not as a 404 from a URL we
 * invented.
 */
export function endpointUrl(
  id: ProviderId,
  endpoint: AiEndpoint
): string | null {
  const provider = PROVIDER_DEFINITIONS[id];
  if (!provider) return null;
  const path = provider.paths[endpoint];
  return path === undefined ? null : `${provider.baseUrl}${path}`;
}

/** The absolute URL used to prove a key is live before storing it. */
export function validateUrl(id: ProviderId): string {
  const provider = requireProvider(id);
  return `${provider.baseUrl}${provider.validatePath}`;
}

/**
 * Outbound auth headers for a provider.
 *
 * A function rather than a template string so adding a provider that needs more
 * than one header — Anthropic requires `x-api-key` AND `anthropic-version` — is
 * a change here and nowhere else.
 */
export function authHeaders(
  id: ProviderId,
  apiKey: string
): Record<string, string> {
  const provider = requireProvider(id);
  switch (provider.authScheme) {
    case 'bearer':
      return { Authorization: `Bearer ${apiKey}` };
    default: {
      // Exhaustiveness: adding an AuthScheme without handling it fails to compile
      // rather than silently sending an unauthenticated request.
      const unreachable: never = provider.authScheme;
      throw new Error(`providers: unhandled auth scheme ${String(unreachable)}`);
    }
  }
}

/**
 * Whether a key looks like it belongs to the provider it is being saved under.
 *
 * A HINT, not authorisation. Returns true whenever the provider has no reliable
 * prefix, so this can only ever catch an obvious mistake (an OpenAI key pasted
 * into the Groq box) and never reject a valid key from a provider that changed
 * its format. The real check is the live call to `validateUrl`.
 */
export function keyPrefixLooksRight(id: ProviderId, apiKey: string): boolean {
  const provider = requireProvider(id);
  if (provider.keyPrefix === null) return true;
  return apiKey.startsWith(provider.keyPrefix);
}
