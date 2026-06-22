import { handleAiProxy } from '@/app/api/ai/_shared';

// Node runtime + dynamic rendering, matching _shared.ts and /api/keys: the
// handler reads server-only secrets (KEY_VAULT_SECRET, GROQ_API_KEY) and must
// never be statically cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// -----------------------------------------------------------------------------
// POST /api/ai/transcribe — thin wrapper over the shared AI proxy pipeline.
//
// Transcribe payloads are multipart/FormData (audio file + fields); the default
// model extractor reads the `model` field from the FormData. The `transcribe`
// endpoint maps to the `max_transcription_minutes_per_day` cap column
// (design §3.6). All auth, gating, key resolution, forwarding, and usage
// logging live in `handleAiProxy` (Req 3.1).
// -----------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  return handleAiProxy(request, { endpoint: 'transcribe' });
}
