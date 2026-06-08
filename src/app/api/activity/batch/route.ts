import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { isValidUuid } from '@/lib/auth/desktop-tokens';
import { jsonError } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/activity/batch
//
// Bearer-protected. Bulk insert of activity events with idempotency on
// event_id (Property P5). user_id is always set from the verified JWT
// subject (Property P1) — any user_id in the request body is ignored.
//
// Request:  { events: Array<{
//             event_id: string (UUIDv4),
//             event_type: string,
//             event_data: object,
//             occurred_at: string (ISO8601),
//             device_id?: string }> }
// Response: 200 { inserted: number, ignored: number }
// Errors:   400 invalid_input
//           500 internal_error
// -----------------------------------------------------------------------------

interface RawEvent {
  event_id?: unknown;
  event_type?: unknown;
  event_data?: unknown;
  occurred_at?: unknown;
  device_id?: unknown;
}

interface BatchBody {
  events?: RawEvent[];
}

const MAX_BATCH = 200;
const MAX_EVENT_TYPE_LEN = 64;
const MAX_DEVICE_ID_LEN = 64;

export async function POST(req: Request) {
  const userId = req.headers.get('x-uvw-user-id');
  if (!userId) return jsonError(401, 'invalid_access_token');

  let body: BatchBody;
  try {
    body = (await req.json()) as BatchBody;
  } catch {
    return jsonError(400, 'invalid_input', 'Body is not valid JSON.');
  }
  if (!Array.isArray(body.events)) {
    return jsonError(400, 'invalid_input', 'events must be an array.');
  }
  if (body.events.length === 0) {
    return NextResponse.json({ inserted: 0, ignored: 0 });
  }
  if (body.events.length > MAX_BATCH) {
    return jsonError(
      400,
      'invalid_input',
      `Batch size exceeds maximum of ${MAX_BATCH}.`
    );
  }

  const rows: Array<{
    event_id: string;
    user_id: string;
    device_id: string | null;
    event_type: string;
    event_data: unknown;
    occurred_at: string;
  }> = [];

  for (const e of body.events) {
    if (!isValidUuid(e.event_id)) {
      return jsonError(400, 'invalid_input', 'event_id must be a UUIDv4.');
    }
    if (
      typeof e.event_type !== 'string' ||
      e.event_type.length === 0 ||
      e.event_type.length > MAX_EVENT_TYPE_LEN
    ) {
      return jsonError(400, 'invalid_input', 'event_type is malformed.');
    }
    if (typeof e.occurred_at !== 'string' || Number.isNaN(Date.parse(e.occurred_at))) {
      return jsonError(400, 'invalid_input', 'occurred_at must be ISO 8601.');
    }
    let deviceId: string | null = null;
    if (typeof e.device_id === 'string') {
      if (e.device_id.length > MAX_DEVICE_ID_LEN) {
        return jsonError(400, 'invalid_input', 'device_id too long.');
      }
      deviceId = e.device_id;
    }
    const eventData =
      e.event_data && typeof e.event_data === 'object' ? e.event_data : {};

    rows.push({
      event_id: e.event_id,
      user_id: userId, // P1: always from verified token
      device_id: deviceId,
      event_type: e.event_type,
      event_data: eventData,
      occurred_at: new Date(e.occurred_at).toISOString(),
    });
  }

  const admin = supabaseAdmin();

  // Idempotency: ON CONFLICT (event_id) DO NOTHING. Supabase's upsert
  // with ignoreDuplicates=true is exactly that.
  const { data, error } = await admin
    .from('activity_events')
    .upsert(rows, { onConflict: 'event_id', ignoreDuplicates: true })
    .select('event_id');

  if (error) return jsonError(500, 'internal_error', error.message);

  const inserted = data?.length ?? 0;
  const ignored = rows.length - inserted;
  return NextResponse.json({ inserted, ignored });
}
