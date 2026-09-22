import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import {
  DOWNLOAD_LICENSE_PRODUCT,
  FULL_ACCESS_PRODUCT,
} from '@/lib/payments/pricing';

import { CheckoutButton } from './CheckoutButton';

/**
 * Tests for the checkout entry point.
 *
 * The behaviour that matters here is WHICH product is ordered and what is NOT
 * sent. The route derives the amount server-side precisely so a client cannot
 * choose it; if this component ever started sending a price, that protection
 * would be gone and no status code would reveal it.
 */

interface RazorpayCtorOptions {
  amount: number;
  description: string;
  order_id: string;
  handler: (r: unknown) => void;
  modal?: { ondismiss?: () => void };
}

let lastRazorpayOptions: RazorpayCtorOptions | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

function orderOk(body: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      order_id: 'order_1',
      key_id: 'rzp_test',
      amount_paise: 35282,
      currency: 'INR',
      product: FULL_ACCESS_PRODUCT,
      product_label: 'Unviewable full access',
      prefill_email: 'a@b.c',
      ...body,
    }),
  } as unknown as Response;
}

/** The parsed JSON body of the Nth fetch call. */
function sentBody(index = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  lastRazorpayOptions = null;
  refresh.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'Razorpay',
    class {
      constructor(options: RazorpayCtorOptions) {
        lastRazorpayOptions = options;
      }
      on() {}
      open() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('CheckoutButton', () => {
  it('orders the desktop licence by default, preserving the original contract', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(orderOk());

    render(<CheckoutButton label="Pay" priceDisclosure="₹99 + GST" />);
    await user.click(screen.getByRole('button', { name: 'Pay' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/payments/razorpay/order');
    expect(sentBody()).toEqual({ product: DOWNLOAD_LICENSE_PRODUCT });
  });

  it('orders the bundle when asked to', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(orderOk());

    render(
      <CheckoutButton
        label="Pay"
        priceDisclosure="₹299 + GST"
        product={FULL_ACCESS_PRODUCT}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Pay' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody()).toEqual({ product: FULL_ACCESS_PRODUCT });
  });

  // The load-bearing assertion. A client-supplied amount is the classic
  // pay-what-you-want hole; the route accepts a product NAME and nothing else.
  it('never sends a price, an amount, or a currency', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(orderOk());

    render(
      <CheckoutButton
        label="Pay"
        priceDisclosure="₹299 + GST"
        product={FULL_ACCESS_PRODUCT}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Pay' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = sentBody();
    expect(Object.keys(body)).toEqual(['product']);
    for (const forbidden of [
      'amount',
      'amount_paise',
      'price',
      'base_amount_paise',
      'total_amount_paise',
      'currency',
      'gst_bps',
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('takes the payment-sheet description from the server, not a hardcoded string', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(orderOk());

    render(
      <CheckoutButton
        label="Pay"
        priceDisclosure="x"
        product={FULL_ACCESS_PRODUCT}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Pay' }));

    await waitFor(() => expect(lastRazorpayOptions).not.toBeNull());
    // Otherwise a bundle purchase would be shown to the customer, and recorded on
    // their card statement, under the desktop licence's description.
    expect(lastRazorpayOptions?.description).toBe('Unviewable full access');
    expect(lastRazorpayOptions?.amount).toBe(35282);
  });

  it('prefers an explicit description over the server label', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(orderOk());

    render(
      <CheckoutButton
        label="Pay"
        priceDisclosure="x"
        product={FULL_ACCESS_PRODUCT}
        description="Chosen by the caller"
      />
    );
    await user.click(screen.getByRole('button', { name: 'Pay' }));

    await waitFor(() => expect(lastRazorpayOptions).not.toBeNull());
    expect(lastRazorpayOptions?.description).toBe('Chosen by the caller');
  });

  // 409 means the server refused a duplicate purchase. That is not an error to
  // show the user — they already own it, so re-render and let the page say so.
  it('treats "already purchased" as a refresh, not a failure', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ code: 'already_purchased' }),
    } as unknown as Response);

    render(<CheckoutButton label="Pay" priceDisclosure="x" />);
    await user.click(screen.getByRole('button', { name: 'Pay' }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("surfaces the server's message when the order cannot be created", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        code: 'unknown_product',
        message: 'That is not something we sell.',
      }),
    } as unknown as Response);

    render(<CheckoutButton label="Pay" priceDisclosure="x" product="nope" />);
    await user.click(screen.getByRole('button', { name: 'Pay' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'That is not something we sell.'
      );
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('notifies the caller after a confirmed purchase', async () => {
    const user = userEvent.setup();
    const onPurchased = vi.fn();
    fetchMock
      .mockResolvedValueOnce(orderOk())
      // the /verify call
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as unknown as Response);

    render(
      <CheckoutButton
        label="Pay"
        priceDisclosure="x"
        product={FULL_ACCESS_PRODUCT}
        onPurchased={onPurchased}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Pay' }));
    await waitFor(() => expect(lastRazorpayOptions).not.toBeNull());

    // Razorpay calls this synchronously on success.
    lastRazorpayOptions?.handler({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'sig',
    });

    await waitFor(() => expect(onPurchased).toHaveBeenCalledTimes(1));
    expect(refresh).toHaveBeenCalled();
  });

  // The webhook is the authority, so a failed client confirm is a wait-and-reload
  // rather than a lost payment. Saying "payment failed" here would be false.
  it('does not claim the payment was lost when the confirm call fails', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(orderOk())
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) } as unknown as Response);

    render(
      <CheckoutButton
        label="Pay"
        priceDisclosure="x"
        product={FULL_ACCESS_PRODUCT}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Pay' }));
    await waitFor(() => expect(lastRazorpayOptions).not.toBeNull());

    lastRazorpayOptions?.handler({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'sig',
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Payment received/);
    });
    expect(screen.getByRole('alert')).not.toHaveTextContent(/did not go through/);
  });
});
