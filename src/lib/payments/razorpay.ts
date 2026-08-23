import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '@/lib/env';
import { registerSecret } from '@/lib/http';

// -----------------------------------------------------------------------------
// Razorpay integration — Orders API + signature verification.
//
// No SDK on purpose. The `razorpay` npm package is a thin wrapper over two REST
// calls and an HMAC, and pulling it in would be the only runtime dependency in
// this repo that touches money. We already call Groq with raw `fetch` and do
// AES-256-GCM with `node:crypto` in key-vault.ts; this follows that precedent
// and keeps the audit surface to one readable file.
//
// ===== THE TWO SECRETS ARE NOT INTERCHANGEABLE =====
//
// Razorpay signs two different things with two different keys, and swapping
// them is the single most common way this integration silently breaks:
//
//   1. WEBHOOK signature   -> HMAC-SHA256(raw_request_body, WEBHOOK_SECRET)
//      Arrives as the `X-Razorpay-Signature` header on server-to-server
//      webhook POSTs. Signed with the secret you set when creating the webhook
//      in the Razorpay dashboard.
//
//   2. CHECKOUT signature  -> HMAC-SHA256("<order_id>|<payment_id>", KEY_SECRET)
//      Returned to the BROWSER by Razorpay Checkout on success. Signed with
//      your API key secret, NOT the webhook secret.
//
// Using KEY_SECRET to check a webhook (or vice versa) fails every time, and the
// failure looks like "Razorpay isn't sending webhooks" rather than a key
// mismatch. The two functions below are named to make the distinction
// impossible to miss at the call site.
// -----------------------------------------------------------------------------

const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';

/** Order creation is a fast call; don't hold a serverless invocation open. */
const ORDER_TIMEOUT_MS = 15_000;

export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly providerCode?: string
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

let secretsRegistered = false;

/**
 * Teach `logSafe` about our Razorpay secrets so they are redacted (and, in dev,
 * throw) if they ever reach a log line. Mirrors what key-vault.ts does for the
 * master key.
 */
function registerRazorpaySecrets(): void {
  if (secretsRegistered) return;
  registerSecret(env.razorpayKeySecret);
  registerSecret(env.razorpayWebhookSecret);
  secretsRegistered = true;
}

function basicAuthHeader(): string {
  const encoded = Buffer.from(
    `${env.razorpayKeyId}:${env.razorpayKeySecret}`,
    'utf8'
  ).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Constant-time hex-digest comparison.
 *
 * `timingSafeEqual` THROWS when the two buffers differ in length, so the length
 * check must come first — and it must not be a data-dependent early return on
 * content. Comparing lowercase hex of a fixed-width digest means a length
 * mismatch only ever indicates a malformed header, never a near-miss guess.
 */
function safeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a.toLowerCase(), 'hex');
  const bufB = Buffer.from(b.toLowerCase(), 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// -----------------------------------------------------------------------------
// Orders API
// -----------------------------------------------------------------------------

export interface CreateOrderInput {
  /** Total to charge, in integer paise (GST-inclusive total from pricing.ts). */
  amountPaise: number;
  /** Always 'INR' for the India-only launch. */
  currency: 'INR';
  /** Our idempotent receipt string; Razorpay echoes it back. Max 40 chars. */
  receipt: string;
  /** Free-form metadata. Never put secrets here — it is visible in dashboards. */
  notes?: Record<string, string>;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: string;
}

/**
 * Create a Razorpay order.
 *
 * The returned `id` is what the browser hands to Razorpay Checkout. We persist
 * it on the `payments` row BEFORE opening checkout so the webhook always has a
 * row to reconcile against, even if the user closes the tab mid-payment.
 */
export async function createRazorpayOrder(
  input: CreateOrderInput
): Promise<RazorpayOrder> {
  registerRazorpaySecrets();

  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new RazorpayError(
      `Invalid order amount: ${input.amountPaise} (must be positive integer paise)`
    );
  }
  // Razorpay caps `receipt` at 40 characters and rejects the order otherwise.
  if (input.receipt.length > 40) {
    throw new RazorpayError(
      `Receipt too long: ${input.receipt.length} chars (Razorpay max is 40)`
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORDER_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${RAZORPAY_API_BASE}/orders`, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes ?? {},
        // Auto-capture: we sell a digital download, so there is no reason to
        // authorize now and capture later. `payment.captured` is the single
        // webhook event that grants entitlement.
        payment_capture: 1,
      }),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new RazorpayError(
      aborted
        ? `Razorpay did not respond within ${ORDER_TIMEOUT_MS}ms`
        : 'Could not reach Razorpay'
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  if (!response.ok) {
    // Razorpay errors look like { error: { code, description, ... } }.
    let providerCode: string | undefined;
    let description: string | undefined;
    try {
      const parsed = JSON.parse(text) as {
        error?: { code?: string; description?: string };
      };
      providerCode = parsed.error?.code;
      description = parsed.error?.description;
    } catch {
      // Non-JSON error body; fall through with the status only.
    }
    throw new RazorpayError(
      description ?? `Razorpay order creation failed (HTTP ${response.status})`,
      response.status,
      providerCode
    );
  }

  let order: RazorpayOrder;
  try {
    order = JSON.parse(text) as RazorpayOrder;
  } catch {
    throw new RazorpayError('Razorpay returned a malformed order response');
  }

  if (typeof order.id !== 'string' || order.id.length === 0) {
    throw new RazorpayError('Razorpay order response is missing an id');
  }

  // Defense in depth: if Razorpay ever echoes back a different amount than we
  // asked for, refuse to proceed rather than opening a checkout that charges
  // something we did not record on the payments row.
  if (order.amount !== input.amountPaise) {
    throw new RazorpayError(
      `Razorpay order amount mismatch: asked ${input.amountPaise}, got ${order.amount}`
    );
  }

  return order;
}

// -----------------------------------------------------------------------------
// Signature verification
// -----------------------------------------------------------------------------

/**
 * Verify a server-to-server webhook.
 *
 * `rawBody` MUST be the exact bytes Razorpay sent, read via `await
 * request.text()`. Calling `request.json()` first and re-stringifying changes
 * key order and whitespace, which changes the digest, which rejects every
 * legitimate webhook. This is the bug to look for if deliveries start failing.
 *
 * Signed with WEBHOOK_SECRET (not KEY_SECRET).
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null
): boolean {
  registerRazorpaySecrets();

  if (!signatureHeader) return false;
  const secret = env.razorpayWebhookSecret;
  if (!secret) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return safeHexEqual(expected, signatureHeader.trim());
}

/**
 * Verify the signature Razorpay Checkout hands back to the BROWSER on success.
 *
 * Signed with KEY_SECRET (not WEBHOOK_SECRET) over `"<order_id>|<payment_id>"`.
 *
 * A valid signature here proves the browser really completed a payment against
 * our order, which is good enough to unlock the UI immediately. It is NOT the
 * authority on entitlement — the webhook is, because a client can simply never
 * call back. Both paths converge on the same idempotent grant.
 */
export function verifyCheckoutSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  registerRazorpaySecrets();

  const secret = env.razorpayKeySecret;
  if (!secret) return false;
  if (!input.orderId || !input.paymentId || !input.signature) return false;

  const expected = createHmac('sha256', secret)
    .update(`${input.orderId}|${input.paymentId}`, 'utf8')
    .digest('hex');
  return safeHexEqual(expected, input.signature.trim());
}

// -----------------------------------------------------------------------------
// Webhook payload parsing
// -----------------------------------------------------------------------------

/** The only events we act on. Anything else is acknowledged and ignored. */
export type HandledWebhookEvent =
  | 'payment.captured'
  | 'payment.failed'
  | 'refund.processed';

export interface WebhookPaymentEntity {
  id: string;
  orderId: string | null;
  amountPaise: number | null;
  currency: string | null;
  status: string | null;
  errorDescription: string | null;
  /**
   * Order notes, propagated by Razorpay onto the payment entity. We set
   * `user_id` at order creation so the webhook can still identify the buyer if
   * our own `payments` row is missing (i.e. the order was created but the
   * insert that followed it failed). String values only.
   */
  notes: Record<string, string> | null;
}

export interface ParsedWebhook {
  event: string;
  payment: WebhookPaymentEntity | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Structurally validate a webhook body instead of casting it.
 *
 * The body is attacker-influenced data even after the signature check passes
 * (a leaked webhook secret, or a replayed body), so every field is narrowed
 * rather than trusted. Returns `null` if the envelope is unrecognisable.
 */
export function parseWebhookBody(rawBody: string): ParsedWebhook | null {
  let root: unknown;
  try {
    root = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const obj = asRecord(root);
  if (!obj) return null;

  const event = str(obj.event);
  if (!event) return null;

  const payload = asRecord(obj.payload);
  const paymentEntity = payload ? asRecord(asRecord(payload.payment)?.entity) : null;

  let payment: WebhookPaymentEntity | null = null;
  if (paymentEntity) {
    const id = str(paymentEntity.id);
    if (id) {
      // Keep only string-valued notes so a hostile/odd payload cannot smuggle
      // an object or array into code that expects a flat string map.
      let notes: Record<string, string> | null = null;
      const notesRecord = asRecord(paymentEntity.notes);
      if (notesRecord) {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(notesRecord)) {
          if (typeof v === 'string') flat[k] = v;
        }
        notes = Object.keys(flat).length > 0 ? flat : null;
      }

      payment = {
        id,
        orderId: str(paymentEntity.order_id),
        amountPaise:
          typeof paymentEntity.amount === 'number' &&
          Number.isSafeInteger(paymentEntity.amount)
            ? paymentEntity.amount
            : null,
        currency: str(paymentEntity.currency),
        status: str(paymentEntity.status),
        errorDescription: str(paymentEntity.error_description),
        notes,
      };
    }
  }

  return { event, payment };
}
