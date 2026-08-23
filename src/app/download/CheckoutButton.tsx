'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// -----------------------------------------------------------------------------
// CheckoutButton — Razorpay Checkout for the one-time download license.
//
// Flow:
//   1. POST /api/payments/razorpay/order  -> { order_id, key_id, amount_paise }
//      The AMOUNT IS DECIDED SERVER-SIDE. Nothing about the price is sent from
//      here, so a tampered client cannot ask for a cheaper order.
//   2. Open Razorpay Checkout with that order_id.
//   3. On success, POST /api/payments/razorpay/verify with the returned triple
//      for instant unlock, then router.refresh() so the server component
//      re-renders with the entitlement and shows the download.
//
// The webhook is the real authority on entitlement (see the webhook route).
// If step 3 never runs — closed tab, dead network, blocked script — the user
// still gets access; they just have to reload. That is why the dismiss handler
// tells them to refresh rather than declaring the payment lost.
// -----------------------------------------------------------------------------

const RAZORPAY_SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpaySuccessResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open: () => void;
  on: (event: string, handler: (payload: unknown) => void) => void;
}

interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  prefill?: { email?: string };
  theme?: { color?: string };
  handler: (response: RazorpaySuccessResponse) => void;
  modal?: { ondismiss?: () => void };
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

/** Inject the Checkout script once and resolve when it is usable. */
function loadRazorpayCheckout(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);

  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${RAZORPAY_SCRIPT_SRC}"]`
    );
    if (existing) {
      existing.addEventListener('load', () => resolve(Boolean(window.Razorpay)));
      existing.addEventListener('error', () => resolve(false));
      return;
    }

    const script = document.createElement('script');
    script.src = RAZORPAY_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

interface OrderResponse {
  order_id: string;
  key_id: string;
  amount_paise: number;
  currency: string;
  prefill_email: string | null;
}

export function CheckoutButton({
  label,
  priceDisclosure,
}: {
  label: string;
  priceDisclosure: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Warm the script on mount so the first click opens Checkout immediately
  // instead of stalling on a network fetch.
  useEffect(() => {
    void loadRazorpayCheckout();
  }, []);

  const handleClick = useCallback(async () => {
    setError(null);
    setStatus(null);
    setBusy(true);

    try {
      const orderRes = await fetch('/api/payments/razorpay/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (orderRes.status === 409) {
        // Already owns it (e.g. paid in another tab). Just re-render.
        router.refresh();
        return;
      }

      if (!orderRes.ok) {
        const body = (await orderRes.json().catch(() => null)) as
          | { message?: string }
          | null;
        setError(
          body?.message ??
            'We could not start the payment. Please try again in a moment.'
        );
        return;
      }

      const order = (await orderRes.json()) as OrderResponse;

      const ready = await loadRazorpayCheckout();
      if (!ready || !window.Razorpay) {
        setError(
          'Could not load the payment window. Check your connection or any ad blocker, then try again.'
        );
        return;
      }

      const rzp = new window.Razorpay({
        key: order.key_id,
        amount: order.amount_paise,
        currency: order.currency,
        name: 'Unviewable',
        description: 'Unviewable for Windows — lifetime download license',
        order_id: order.order_id,
        prefill: order.prefill_email ? { email: order.prefill_email } : undefined,
        theme: { color: '#0A0A0B' },
        handler: (response) => {
          // Fire and forget into an async confirm; Razorpay's handler is sync.
          void (async () => {
            if (mounted.current) setStatus('Confirming your payment…');
            try {
              const verifyRes = await fetch('/api/payments/razorpay/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(response),
              });

              if (verifyRes.ok) {
                // Server component re-reads the entitlement and swaps in the
                // download panel.
                router.refresh();
                return;
              }

              // Payment succeeded but our confirm did not. The webhook will
              // still grant access, so this is a wait-and-reload, not a loss.
              if (mounted.current) {
                setStatus(null);
                setError(
                  'Payment received. We are still confirming it — reload this page in a few seconds to get your download.'
                );
              }
            } catch {
              if (mounted.current) {
                setStatus(null);
                setError(
                  'Payment received. We are still confirming it — reload this page in a few seconds to get your download.'
                );
              }
            }
          })();
        },
        modal: {
          ondismiss: () => {
            if (mounted.current) {
              setBusy(false);
              setStatus(null);
            }
          },
        },
      });

      rzp.on('payment.failed', () => {
        if (mounted.current) {
          setBusy(false);
          setStatus(null);
          setError('That payment did not go through. You have not been charged.');
        }
      });

      rzp.open();
    } catch {
      if (mounted.current) {
        setError('Something went wrong starting the payment. Please try again.');
      }
    } finally {
      // Checkout is now an overlay; ondismiss/handler manage state from here.
      if (mounted.current) setBusy(false);
    }
  }, [router]);

  return (
    <div className="account-actions">
      <button
        type="button"
        className="cta cta-primary"
        onClick={handleClick}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? 'Opening payment…' : label}
      </button>

      <p className="checkout-price-note">{priceDisclosure}</p>

      {status ? (
        <p role="status" aria-live="polite">
          {status}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="checkout-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default CheckoutButton;
