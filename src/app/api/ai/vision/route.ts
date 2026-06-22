import { handleAiProxy } from '@/app/api/ai/_shared';

// Node runtime + dynamic rendering, matching _shared.ts and /api/keys: the
// handler reads server-only secrets (KEY_VAULT_SECRET, GROQ_API_KEY) and must
// never be statically cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// -----------------------------------------------------------------------------
// POST /api/ai/vision — thin wrapper over the shared AI proxy pipeline.
//
// Vision payloads are JSON; the default model extractor reads `payload.model`.
// The `vision` endpoint maps to the `max_vision_per_day` cap column
// (design §3.6). All auth, gating, key resolution, forwarding, and usage
// logging live in `handleAiProxy` (Req 3.1).
// -----------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  return handleAiProxy(request, { endpoint: 'vision' });
}
