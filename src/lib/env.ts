type EnvValue = string | undefined;

function pick(...values: EnvValue[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function required(name: string, value: EnvValue): string {
  if (!value) {
    // During build/prerender, env vars may not be available — return placeholder
    // so static page collection succeeds. At runtime the real values will be present.
    if (typeof window === 'undefined' && process.env.NODE_ENV === 'production') {
      return '';
    }
    throw new Error(
      `Missing env var: ${name}. Add it to .env.local (recommended) or configure it in Vercel Environment Variables.`
    );
  }
  return value;
}

function optional(value: EnvValue): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return undefined;
}

export const env = {
  // -----------------------------------------------------------------
  // Public — safe to ship to the browser bundle (NEXT_PUBLIC_*).
  // -----------------------------------------------------------------
  get supabaseUrl() {
    return required(
      'NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)',
      pick(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_URL)
    );
  },
  get supabaseAnonKey() {
    return required(
      'NEXT_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)',
      pick(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, process.env.SUPABASE_ANON_KEY)
    );
  },
  get siteUrl() {
    // Used for server-side fetches and the unviewable:// redirect base.
    return required(
      'NEXT_PUBLIC_SITE_URL',
      pick(process.env.NEXT_PUBLIC_SITE_URL, 'http://localhost:3000')
    );
  },

  // -----------------------------------------------------------------
  // Server-only — NEVER reference these from a 'use client' component.
  // Reading them in client code at build time will fail Next.js's
  // "secret env var leaked to client bundle" check.
  // -----------------------------------------------------------------
  get supabaseServiceRoleKey() {
    return required(
      'SUPABASE_SERVICE_ROLE_KEY',
      pick(process.env.SUPABASE_SERVICE_ROLE_KEY)
    );
  },
  get desktopAccessTokenSecret() {
    return required(
      'DESKTOP_ACCESS_TOKEN_SECRET',
      pick(process.env.DESKTOP_ACCESS_TOKEN_SECRET)
    );
  },
  get keyVaultSecret() {
    // Master_Key set for the per-user Groq key vault. JSON map of
    // version -> base64 32-byte key. Read ONLY inside
    // src/lib/crypto/key-vault.ts. Never expose to the browser bundle.
    return required('KEY_VAULT_SECRET', pick(process.env.KEY_VAULT_SECRET));
  },
  get keyVaultActiveVersion() {
    // Master_Key_Version used for new encryptions. Defaults to 1.
    return Number(pick(process.env.KEY_VAULT_ACTIVE_VERSION, '1'));
  },
  get groqApiKey() {
    // Optional today (premium/platform path is deferred). Promote to
    // required() once premium ships.
    return optional(process.env.GROQ_API_KEY);
  },
  get kvRestApiUrl() {
    // Optional in dev — ratelimit.ts falls back to in-memory when absent.
    return optional(process.env.KV_REST_API_URL);
  },
  get kvRestApiToken() {
    return optional(process.env.KV_REST_API_TOKEN);
  },

  // -----------------------------------------------------------------
  // Razorpay (pay-to-download, India-only).
  //
  // All three are `optional()` rather than `required()` so the app still
  // boots — and every non-payment route keeps working — when Razorpay is not
  // configured yet. The payment routes check `isRazorpayConfigured()` and
  // return 503 `payment_not_configured` instead of throwing a 500 from a
  // module-level getter. That distinction matters during rollout: a missing
  // key should degrade the checkout button, not the whole site.
  //
  // KEY_SECRET and WEBHOOK_SECRET are DIFFERENT secrets signing DIFFERENT
  // things. See the header comment in src/lib/payments/razorpay.ts.
  // -----------------------------------------------------------------
  get razorpayKeyId() {
    // Public-ish: this value is handed to Razorpay Checkout in the browser.
    // It is returned by /api/payments/razorpay/order rather than exposed as a
    // NEXT_PUBLIC_* var, so there is one fewer build-time value to keep in
    // sync between Vercel and the client bundle.
    return optional(process.env.RAZORPAY_KEY_ID) ?? '';
  },
  get razorpayKeySecret() {
    // Signs the CHECKOUT signature: HMAC("<order_id>|<payment_id>").
    return optional(process.env.RAZORPAY_KEY_SECRET) ?? '';
  },
  get razorpayWebhookSecret() {
    // Signs the WEBHOOK signature: HMAC(raw_request_body).
    return optional(process.env.RAZORPAY_WEBHOOK_SECRET) ?? '';
  },
};

/**
 * Whether order creation and checkout verification can run. The webhook has its
 * own check because it needs only the webhook secret.
 */
export function isRazorpayConfigured(): boolean {
  return env.razorpayKeyId.length > 0 && env.razorpayKeySecret.length > 0;
}

/** Whether inbound webhooks can be verified. */
export function isRazorpayWebhookConfigured(): boolean {
  return env.razorpayWebhookSecret.length > 0;
}
