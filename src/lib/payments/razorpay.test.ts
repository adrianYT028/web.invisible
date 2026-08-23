// @vitest-environment node
//
// Signature verification and webhook parsing.
//
// The webhook endpoint is UNAUTHENTICATED — Razorpay sends no cookie and no
// bearer token, so the HMAC signature is the only thing standing between a
// stranger and a free licence. These tests are the guard on that boundary.
//
// They also pin the distinction that breaks this integration most often:
//   webhook signature  = HMAC(raw body,               WEBHOOK_SECRET)
//   checkout signature = HMAC("order_id|payment_id",  KEY_SECRET)
// Swapping the two secrets fails every time, and the symptom ("Razorpay isn't
// sending webhooks") points away from the real cause.
//
// The module reads secrets through env.ts lazy getters and memoizes
// registerSecret() calls, so each test loads a FRESH module via vi.resetModules
// after setting env.

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY_ID = 'rzp_test_abc123';
const KEY_SECRET = 'key_secret_do_not_use_in_prod';
const WEBHOOK_SECRET = 'webhook_secret_do_not_use_in_prod';

type RazorpayModule = typeof import('./razorpay');

async function loadRazorpay(): Promise<RazorpayModule> {
  process.env.RAZORPAY_KEY_ID = KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  vi.resetModules();
  return import('./razorpay');
}

function signWebhook(rawBody: string, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function signCheckout(
  orderId: string,
  paymentId: string,
  secret = KEY_SECRET
): string {
  return createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`, 'utf8')
    .digest('hex');
}

beforeEach(() => {
  // logSafe throws in non-production when a value looks like a secret; these
  // tests never log, but keep the env explicit.
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  vi.resetModules();
});

// -----------------------------------------------------------------------------
// Webhook signature
// -----------------------------------------------------------------------------
describe('verifyWebhookSignature', () => {
  const body = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1' } } },
  });

  it('accepts a correctly signed body', async () => {
    const { verifyWebhookSignature } = await loadRazorpay();
    expect(verifyWebhookSignature(body, signWebhook(body))).toBe(true);
  });

  it('rejects a tampered body under the original signature', async () => {
    const { verifyWebhookSignature } = await loadRazorpay();
    const signature = signWebhook(body);

    // The exact attack this protects against: replay a real signature with an
    // amount or order id swapped out.
    const tampered = body.replace('pay_1', 'pay_attacker');
    expect(verifyWebhookSignature(tampered, signature)).toBe(false);
  });

  it('rejects a body signed with the CHECKOUT secret', async () => {
    // i.e. someone wired KEY_SECRET into the webhook by mistake.
    const { verifyWebhookSignature } = await loadRazorpay();
    expect(verifyWebhookSignature(body, signWebhook(body, KEY_SECRET))).toBe(
      false
    );
  });

  it('rejects a missing, empty, or malformed signature header', async () => {
    const { verifyWebhookSignature } = await loadRazorpay();
    expect(verifyWebhookSignature(body, null)).toBe(false);
    expect(verifyWebhookSignature(body, '')).toBe(false);
    expect(verifyWebhookSignature(body, 'not-hex')).toBe(false);
    // Correct length but wrong content.
    expect(verifyWebhookSignature(body, 'a'.repeat(64))).toBe(false);
    // Truncated digest — must not pass on a prefix match.
    expect(verifyWebhookSignature(body, signWebhook(body).slice(0, 32))).toBe(
      false
    );
  });

  it('tolerates surrounding whitespace in the header', async () => {
    const { verifyWebhookSignature } = await loadRazorpay();
    expect(verifyWebhookSignature(body, `  ${signWebhook(body)}  `)).toBe(true);
  });

  it('accepts an uppercase hex digest', async () => {
    const { verifyWebhookSignature } = await loadRazorpay();
    expect(verifyWebhookSignature(body, signWebhook(body).toUpperCase())).toBe(
      true
    );
  });

  it('is byte-exact: re-serialised JSON does NOT verify', async () => {
    // This is why the route must use request.text() and never request.json().
    // Round-tripping through JSON.parse/stringify reorders keys and drops
    // whitespace, producing a different digest for semantically equal data.
    const { verifyWebhookSignature } = await loadRazorpay();
    const spaced = '{ "event" : "payment.captured" }';
    const signature = signWebhook(spaced);
    const reserialised = JSON.stringify(JSON.parse(spaced));

    expect(verifyWebhookSignature(spaced, signature)).toBe(true);
    expect(verifyWebhookSignature(reserialised, signature)).toBe(false);
  });

  it('fails closed when no webhook secret is configured', async () => {
    process.env.RAZORPAY_KEY_ID = KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    vi.resetModules();
    const { verifyWebhookSignature } = await import('./razorpay');

    // An unconfigured secret must never mean "accept everything".
    expect(verifyWebhookSignature(body, signWebhook(body))).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Checkout signature
// -----------------------------------------------------------------------------
describe('verifyCheckoutSignature', () => {
  const orderId = 'order_abc';
  const paymentId = 'pay_xyz';

  it('accepts the signature Razorpay Checkout returns', async () => {
    const { verifyCheckoutSignature } = await loadRazorpay();
    expect(
      verifyCheckoutSignature({
        orderId,
        paymentId,
        signature: signCheckout(orderId, paymentId),
      })
    ).toBe(true);
  });

  it('rejects a signature for a different order or payment', async () => {
    const { verifyCheckoutSignature } = await loadRazorpay();
    const signature = signCheckout(orderId, paymentId);

    expect(
      verifyCheckoutSignature({ orderId: 'order_other', paymentId, signature })
    ).toBe(false);
    expect(
      verifyCheckoutSignature({ orderId, paymentId: 'pay_other', signature })
    ).toBe(false);
  });

  it('rejects a signature made with the WEBHOOK secret', async () => {
    const { verifyCheckoutSignature } = await loadRazorpay();
    expect(
      verifyCheckoutSignature({
        orderId,
        paymentId,
        signature: signCheckout(orderId, paymentId, WEBHOOK_SECRET),
      })
    ).toBe(false);
  });

  it('is not fooled by moving the delimiter between the two ids', async () => {
    // HMAC("a|bc") must differ from HMAC("ab|c") — otherwise a crafted id pair
    // could reuse another order's signature.
    const { verifyCheckoutSignature } = await loadRazorpay();
    const signature = signCheckout('order_ab', 'c');
    expect(
      verifyCheckoutSignature({ orderId: 'order_a', paymentId: 'bc', signature })
    ).toBe(false);
  });

  it('rejects empty inputs', async () => {
    const { verifyCheckoutSignature } = await loadRazorpay();
    expect(
      verifyCheckoutSignature({ orderId: '', paymentId, signature: 'abc' })
    ).toBe(false);
    expect(
      verifyCheckoutSignature({ orderId, paymentId: '', signature: 'abc' })
    ).toBe(false);
    expect(verifyCheckoutSignature({ orderId, paymentId, signature: '' })).toBe(
      false
    );
  });
});

// -----------------------------------------------------------------------------
// Webhook body parsing — narrowing, not casting.
// -----------------------------------------------------------------------------
describe('parseWebhookBody', () => {
  it('extracts the payment entity from a captured event', async () => {
    const { parseWebhookBody } = await loadRazorpay();
    const parsed = parseWebhookBody(
      JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_1',
              order_id: 'order_1',
              amount: 11682,
              currency: 'INR',
              status: 'captured',
              notes: { user_id: 'user-uuid', product: 'download_license' },
            },
          },
        },
      })
    );

    expect(parsed?.event).toBe('payment.captured');
    expect(parsed?.payment).toEqual({
      id: 'pay_1',
      orderId: 'order_1',
      amountPaise: 11682,
      currency: 'INR',
      status: 'captured',
      errorDescription: null,
      notes: { user_id: 'user-uuid', product: 'download_license' },
    });
  });

  it('returns null for non-JSON or a non-object envelope', async () => {
    const { parseWebhookBody } = await loadRazorpay();
    expect(parseWebhookBody('not json')).toBeNull();
    expect(parseWebhookBody('[]')).toBeNull();
    expect(parseWebhookBody('"a string"')).toBeNull();
    expect(parseWebhookBody('null')).toBeNull();
    expect(parseWebhookBody('{}')).toBeNull(); // no event
  });

  it('keeps the event but nulls the payment when the entity is unusable', async () => {
    const { parseWebhookBody } = await loadRazorpay();

    // Present-but-empty payload: the route acknowledges and ignores these.
    expect(parseWebhookBody('{"event":"payment.captured"}')).toEqual({
      event: 'payment.captured',
      payment: null,
    });

    // Entity with no id is not identifiable.
    const noId = parseWebhookBody(
      JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { order_id: 'order_1' } } },
      })
    );
    expect(noId?.payment).toBeNull();
  });

  it('coerces a non-integer amount to null rather than trusting it', async () => {
    const { parseWebhookBody } = await loadRazorpay();
    const parsed = parseWebhookBody(
      JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: { entity: { id: 'pay_1', order_id: 'o1', amount: 116.82 } },
        },
      })
    );
    // A float amount means paise were mishandled upstream; refuse to believe it
    // so the amount-mismatch check cannot be bypassed with 116.82 vs 11682.
    expect(parsed?.payment?.amountPaise).toBeNull();
  });

  it('drops non-string note values', async () => {
    const { parseWebhookBody } = await loadRazorpay();
    const parsed = parseWebhookBody(
      JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_1',
              notes: {
                user_id: 'good',
                nested: { evil: true },
                arr: [1, 2],
                num: 5,
              },
            },
          },
        },
      })
    );
    // Only the string survives — downstream code treats notes as a flat map.
    expect(parsed?.payment?.notes).toEqual({ user_id: 'good' });
  });

  it('captures the failure reason on a failed event', async () => {
    const { parseWebhookBody } = await loadRazorpay();
    const parsed = parseWebhookBody(
      JSON.stringify({
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_2',
              order_id: 'order_2',
              status: 'failed',
              error_description: 'Payment was declined by the bank',
            },
          },
        },
      })
    );
    expect(parsed?.event).toBe('payment.failed');
    expect(parsed?.payment?.errorDescription).toBe(
      'Payment was declined by the bank'
    );
  });
});
