/**
 * Component tests for `<ApiKeyManager />` — the `/account` browser surface for
 * the per-user key vault (ai-proxy-key-vault spec), now one row per provider.
 *
 * Covers the per-provider render states, the Save (POST) / Remove (DELETE) /
 * Make-default (PATCH) flows against `/api/keys`, the capability copy, and the
 * inline error-code mapping. `global.fetch` is mocked so no real network call is
 * made.
 *
 * Validates: Requirements 2.1, 2.2, 2.3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiKeyManager, type SavedKey } from './ApiKeyManager';

/** Build a Response-like object the component's fetch handling expects. */
function fakeResponse(ok: boolean, body: unknown): Response {
  return { ok, json: async () => body } as unknown as Response;
}

const groqSaved: SavedKey = {
  provider: 'groq',
  lastFour: 'NAcr',
  isPreferred: false,
};
const openaiSaved: SavedKey = {
  provider: 'openai',
  lastFour: 'WXYZ',
  isPreferred: false,
};

/** The row element for one provider. */
function row(provider: string): HTMLElement {
  const el = document.querySelector(`[data-provider="${provider}"]`);
  if (!el) throw new Error(`no row for provider ${provider}`);
  return el as HTMLElement;
}

function buttonIn(provider: string, action: string): HTMLElement {
  const el = row(provider).querySelector(`[data-action="${action}"]`);
  if (!el) throw new Error(`no ${action} in ${provider} row`);
  return el as HTMLElement;
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

  describe('rendering', () => {
    it('renders a row for every provider the proxy can route to', () => {
      render(<ApiKeyManager saved={[]} />);
      for (const provider of ['groq', 'openai', 'openrouter']) {
        expect(row(provider)).toBeInTheDocument();
      }
    });

    it('shows an Add control and no Remove when a provider is not connected', () => {
      render(<ApiKeyManager saved={[]} />);
      expect(buttonIn('groq', 'add-key')).toBeInTheDocument();
      expect(
        row('groq').querySelector('[data-action="remove-key"]')
      ).toBeNull();
      expect(
        screen.getByText('Add at least one key to enable AI features.')
      ).toBeInTheDocument();
    });

    it('shows only the masked last four for a saved key, plus Replace/Remove', () => {
      render(<ApiKeyManager saved={[groqSaved]} />);

      expect(screen.getByTestId('saved-groq')).toHaveTextContent(
        '\u2022\u2022\u2022\u2022 NAcr'
      );
      expect(buttonIn('groq', 'replace-key')).toBeInTheDocument();
      expect(buttonIn('groq', 'remove-key')).toBeInTheDocument();
    });

    // The security contract: nothing beyond last_four is ever in the DOM.
    it('never renders key characters beyond the last four', () => {
      render(<ApiKeyManager saved={[groqSaved]} />);
      const html = document.body.innerHTML;
      expect(html).not.toContain('gsk_');
      expect(html).not.toContain('key_ciphertext');
    });

    it('marks the default when one is set', () => {
      render(
        <ApiKeyManager
          saved={[{ ...groqSaved, isPreferred: true }, openaiSaved]}
        />
      );
      expect(row('groq')).toHaveTextContent('(default)');
      expect(row('openai')).not.toHaveTextContent('(default)');
    });
  });

  // Providers are not interchangeable, and the one that differs is the one a
  // user is most likely to pick for Claude access.
  describe('capability copy', () => {
    it('says Groq and OpenAI handle voice', () => {
      render(<ApiKeyManager saved={[]} />);
      for (const provider of ['groq', 'openai']) {
        expect(row(provider)).toHaveTextContent('Voice');
        expect(row(provider)).not.toHaveTextContent('no voice transcription');
      }
    });

    it('warns that OpenRouter cannot transcribe', () => {
      render(<ApiKeyManager saved={[]} />);
      expect(row('openrouter')).toHaveTextContent('no voice transcription');
      expect(row('openrouter')).toHaveTextContent('Questions');
      expect(row('openrouter')).toHaveTextContent('Screenshots');
    });
  });

  describe('saving a key', () => {
    it('POSTs the key with its provider and shows the new last four', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValueOnce(
        fakeResponse(true, { ok: true, provider: 'openai', last_four: 'WXYZ' })
      );

      render(<ApiKeyManager saved={[]} />);
      await user.click(buttonIn('openai', 'add-key'));
      await user.type(screen.getByLabelText('OpenAI API key'), 'sk-abcdWXYZ');
      await user.click(buttonIn('openai', 'save-key'));

      await waitFor(() => {
        expect(screen.getByTestId('saved-openai')).toBeInTheDocument();
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/keys');
      expect(init?.method).toBe('POST');
      // The provider must travel with the key — without it the server defaults
      // to Groq and the key is stored, and later spent, against the wrong one.
      expect(JSON.parse(init.body as string)).toEqual({
        api_key: 'sk-abcdWXYZ',
        provider: 'openai',
      });
    });

    it('offers a link to the provider console while the form is open', async () => {
      const user = userEvent.setup();
      render(<ApiKeyManager saved={[]} />);
      await user.click(buttonIn('openrouter', 'add-key'));

      const link = row('openrouter').querySelector('a');
      expect(link).toHaveAttribute('href', 'https://openrouter.ai/keys');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    });

    it('keeps the Save control disabled until something is typed', async () => {
      const user = userEvent.setup();
      render(<ApiKeyManager saved={[]} />);
      await user.click(buttonIn('groq', 'add-key'));

      expect(buttonIn('groq', 'save-key')).toBeDisabled();
      await user.type(screen.getByLabelText('Groq API key'), 'gsk_x');
      expect(buttonIn('groq', 'save-key')).toBeEnabled();
    });

    it('uses the password input type so the key is not shoulder-readable', async () => {
      const user = userEvent.setup();
      render(<ApiKeyManager saved={[]} />);
      await user.click(buttonIn('groq', 'add-key'));
      expect(screen.getByLabelText('Groq API key')).toHaveAttribute(
        'type',
        'password'
      );
    });
  });

  describe('removing a key', () => {
    it('scopes the DELETE to one provider', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValueOnce(
        fakeResponse(true, { ok: true, provider: 'groq', has_key: false })
      );

      render(<ApiKeyManager saved={[groqSaved, openaiSaved]} />);
      await user.click(buttonIn('groq', 'remove-key'));

      await waitFor(() => {
        expect(screen.queryByTestId('saved-groq')).not.toBeInTheDocument();
      });

      // Unscoped, this would have wiped every key the user had.
      expect(fetchMock.mock.calls[0][0]).toBe('/api/keys?provider=groq');
      expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
      // The other provider's key is untouched.
      expect(screen.getByTestId('saved-openai')).toBeInTheDocument();
    });
  });

  describe('choosing a default', () => {
    // With one key there is nothing to choose — the proxy simply uses it.
    it('offers no default control with a single key', () => {
      render(<ApiKeyManager saved={[groqSaved]} />);
      expect(
        row('groq').querySelector('[data-action="make-default"]')
      ).toBeNull();
    });

    it('offers it on the non-default rows once two keys are saved', () => {
      render(
        <ApiKeyManager
          saved={[{ ...groqSaved, isPreferred: true }, openaiSaved]}
        />
      );
      expect(buttonIn('openai', 'make-default')).toBeInTheDocument();
      // Not on the row that is already the default.
      expect(
        row('groq').querySelector('[data-action="make-default"]')
      ).toBeNull();
    });

    it('PATCHes the choice and moves the marker', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValueOnce(
        fakeResponse(true, { ok: true, preferred: 'openai' })
      );

      render(<ApiKeyManager saved={[groqSaved, openaiSaved]} />);
      await user.click(buttonIn('openai', 'make-default'));

      await waitFor(() => {
        expect(row('openai')).toHaveTextContent('(default)');
      });
      expect(row('groq')).not.toHaveTextContent('(default)');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/keys');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({ provider: 'openai' });
    });

    it('nudges the user to pick when two keys are saved and none is default', () => {
      render(<ApiKeyManager saved={[groqSaved, openaiSaved]} />);
      expect(screen.getByText(/Pick a default/)).toBeInTheDocument();
      // The escape must be rendered, not printed literally.
      expect(document.body.innerHTML).not.toContain('u2019');
    });
  });

  describe('errors', () => {
    it("prefers the server's specific message over the generic one", async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValueOnce(
        fakeResponse(false, {
          code: 'invalid_groq_key',
          message:
            'That does not look like a openai key — check you picked the right provider.',
        })
      );

      render(<ApiKeyManager saved={[]} />);
      await user.click(buttonIn('openai', 'add-key'));
      await user.type(screen.getByLabelText('OpenAI API key'), 'gsk_wrongbox');
      await user.click(buttonIn('openai', 'save-key'));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          /check you picked the right provider/
        );
      });
    });

    it('falls back to a friendly message for a bare code', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValueOnce(
        fakeResponse(false, { code: 'validation_unavailable' })
      );

      render(<ApiKeyManager saved={[]} />);
      await user.click(buttonIn('groq', 'add-key'));
      await user.type(screen.getByLabelText('Groq API key'), 'gsk_abcd');
      await user.click(buttonIn('groq', 'save-key'));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          /Couldn\u2019t validate the key right now/
        );
      });
    });

    it('reports a network failure without losing the form', async () => {
      const user = userEvent.setup();
      fetchMock.mockRejectedValueOnce(new Error('offline'));

      render(<ApiKeyManager saved={[]} />);
      await user.click(buttonIn('groq', 'add-key'));
      await user.type(screen.getByLabelText('Groq API key'), 'gsk_abcd');
      await user.click(buttonIn('groq', 'save-key'));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/Network error/);
      });
      expect(screen.getByLabelText('Groq API key')).toBeInTheDocument();
    });

    // An error on one provider must not be reported against another.
    it('shows the error only on the row that failed', async () => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValueOnce(
        fakeResponse(false, { code: 'invalid_groq_key' })
      );

      render(<ApiKeyManager saved={[]} />);
      await user.click(buttonIn('openai', 'add-key'));
      await user.type(screen.getByLabelText('OpenAI API key'), 'sk-bad');
      await user.click(buttonIn('openai', 'save-key'));

      await waitFor(() => {
        expect(row('openai').querySelector('[role="alert"]')).not.toBeNull();
      });
      expect(row('groq').querySelector('[role="alert"]')).toBeNull();
    });
  });
});
