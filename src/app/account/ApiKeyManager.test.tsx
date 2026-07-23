/**
 * Component tests for `<ApiKeyManager />` — the `/account` browser surface
 * for the per-user Groq key vault (ai-proxy-key-vault spec).
 *
 * These tests cover the two render states, the Save (POST) and Remove
 * (DELETE) flows against `/api/keys`, and the inline error-code mapping.
 * `global.fetch` is mocked so no real network call is made.
 *
 * Validates: Requirements 2.1, 2.2, 2.3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiKeyManager } from './ApiKeyManager';

/** Build a Response-like object the component's fetch handling expects. */
function fakeResponse(ok: boolean, body: unknown): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe('ApiKeyManager', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('no-key state (hasKey=false)', () => {
    it('renders the prompt, a password input, and a Save button', () => {
      render(<ApiKeyManager hasKey={false} lastFour={null} />);

      expect(
        screen.getByText('Add your Groq key to enable AI features.'),
      ).toBeInTheDocument();

      const input = screen.getByLabelText('Groq API key');
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('type', 'password');

      expect(
        screen.getByRole('button', { name: 'Save' }),
      ).toBeInTheDocument();

      // No masked indicator and no Replace/Remove controls in this state.
      expect(screen.queryByText(/saved:/i)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Remove' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('key-set state (hasKey=true)', () => {
    it('shows only the masked last_four plus Replace/Remove, and no other key characters', () => {
      render(<ApiKeyManager hasKey={true} lastFour="NAcr" />);

      // Masked indicator shows exactly the bullet groups + last_four.
      const masked = screen.getByText('\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 NAcr');
      expect(masked).toBeInTheDocument();

      expect(
        screen.getByRole('button', { name: 'Replace' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Remove' }),
      ).toBeInTheDocument();

      // The no-key prompt and the password input are NOT shown.
      expect(
        screen.queryByText('Add your Groq key to enable AI features.'),
      ).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument();

      // Assert ONLY the last_four leaks: the rendered text contains "NAcr"
      // surrounded only by masking bullets/whitespace, and nothing that
      // looks like a fuller Groq key (e.g. a "gsk_" prefix).
      const bodyText = document.body.textContent ?? '';
      expect(bodyText).toContain('NAcr');
      expect(bodyText).not.toContain('gsk_');
    });
  });

  describe('Save flow', () => {
    it('POSTs to /api/keys with { api_key: <trimmed> } and switches to the key-set state on success', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValueOnce(
        fakeResponse(true, { ok: true, last_four: 'WXYZ' }),
      );

      render(<ApiKeyManager hasKey={false} lastFour={null} />);

      const input = screen.getByLabelText('Groq API key');
      await user.type(input, '  gsk_secret_value_WXYZ  ');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/keys');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        api_key: 'gsk_secret_value_WXYZ',
      });

      // UI now reflects the key-set state with the returned last_four only.
      await waitFor(() =>
        expect(
          screen.getByText('\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 WXYZ'),
        ).toBeInTheDocument(),
      );
      expect(
        screen.getByRole('button', { name: 'Remove' }),
      ).toBeInTheDocument();
    });
  });

  describe('Remove flow', () => {
    it('issues DELETE /api/keys and returns to the no-key state', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValueOnce(fakeResponse(true, { ok: true, has_key: false }));

      render(<ApiKeyManager hasKey={true} lastFour="NAcr" />);

      await user.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/keys');
      expect(init.method).toBe('DELETE');

      // Back to the no-key state: prompt + input reappear.
      await waitFor(() =>
        expect(
          screen.getByText('Add your Groq key to enable AI features.'),
        ).toBeInTheDocument(),
      );
      expect(screen.getByLabelText('Groq API key')).toBeInTheDocument();
    });
  });

  describe('error-code mapping on Save', () => {
    async function submitAndExpectMessage(
      responseBody: unknown,
      expectedMessage: string,
    ) {
      const user = userEvent.setup();
      fetchMock.mockResolvedValueOnce(fakeResponse(false, responseBody));

      render(<ApiKeyManager hasKey={false} lastFour={null} />);

      await user.type(screen.getByLabelText('Groq API key'), 'gsk_bad_key');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(expectedMessage);
    }

    it('maps invalid_groq_key to the invalid-key message', async () => {
      await submitAndExpectMessage(
        { code: 'invalid_groq_key' },
        'That Groq key looks invalid.',
      );
    });

    it('maps validation_unavailable to the validation message', async () => {
      await submitAndExpectMessage(
        { code: 'validation_unavailable' },
        'Couldn\u2019t validate the key right now \u2014 try again.',
      );
    });

    it('maps an unrecognized failure to the generic message', async () => {
      await submitAndExpectMessage(
        { code: 'internal_error' },
        'Something went wrong. Please try again.',
      );
    });
  });
});
