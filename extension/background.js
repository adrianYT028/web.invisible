// -----------------------------------------------------------------------------
// Background service worker — sign-in, tokens, and every call to the API
// -----------------------------------------------------------------------------
//
// Sign-in reuses the desktop app's device-code flow:
//   1. Generate a random device_code and device_id here.
//   2. Open /auth/extension?device_code=…&device_id=… in a tab. The user signs in
//      if needed and clicks "Connect extension", which records the code against
//      their account and redirects to /auth/extension/done.
//   3. We see that URL on the tab we opened and redeem the code at
//      /api/desktop/exchange for a refresh token (30 days) and an access token
//      (1 hour). The browser page never sees a token.
//
// All API calls go through here, not the popup, so token refresh lives in one
// place. Calls use `Authorization: Bearer` and `credentials: 'omit'`: the site's
// cookie is never sent, so the server authenticates the extension by its token
// alone (see src/lib/auth/request-user.ts). host_permissions exempt these
// requests from CORS.
//
// MV3 service workers are stopped when idle, so nothing is kept in memory:
// tokens and the pending sign-in live in chrome.storage.local.
// -----------------------------------------------------------------------------

import { API_BASE } from './config.js';

const DONE_URL = `${API_BASE}/auth/extension/done`;
/** A pending sign-in is abandoned after this long (the server code expires at 10 min). */
const PENDING_TTL_MS = 10 * 60 * 1000;
/** Refresh the access token when it has less than this left. */
const REFRESH_MARGIN_MS = 60 * 1000;

// --- storage --------------------------------------------------------------

async function getSession() {
  const { session } = await chrome.storage.local.get('session');
  return session || null;
}

async function setSession(session) {
  await chrome.storage.local.set({ session });
}

async function clearSession() {
  await chrome.storage.local.remove('session');
}

async function getPending() {
  const { pending } = await chrome.storage.local.get('pending');
  if (!pending) return null;
  if (Date.now() - pending.startedAt > PENDING_TTL_MS) {
    await chrome.storage.local.remove('pending');
    return null;
  }
  return pending;
}

// --- helpers --------------------------------------------------------------

/** 32 random bytes as base64url: exactly the 43-char shape the server accepts. */
function newDeviceCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'omit',
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// --- sign-in --------------------------------------------------------------

async function startConnect() {
  const deviceCode = newDeviceCode();
  const deviceId = crypto.randomUUID();
  const url =
    `${API_BASE}/auth/extension?device_code=${encodeURIComponent(deviceCode)}` +
    `&device_id=${encodeURIComponent(deviceId)}`;
  const tab = await chrome.tabs.create({ url });
  await chrome.storage.local.set({
    pending: { deviceCode, deviceId, tabId: tab.id, startedAt: Date.now() },
  });
  return { ok: true };
}

/** Redeem the pending device code. Safe to call repeatedly. */
async function finishConnect() {
  const pending = await getPending();
  if (!pending) return { ok: false, code: 'no_pending_sign_in' };

  const { status, data } = await postJson('/api/desktop/exchange', {
    device_code: pending.deviceCode,
    client: 'extension',
  });

  if (status === 200 && data && data.access_token && data.refresh_token) {
    await setSession({
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      accessExpiresAt: Date.now() + (data.access_token_expires_in || 3600) * 1000,
      email: data.user_email || '',
      plan: data.plan || 'free',
    });
    await chrome.storage.local.remove('pending');
    return { ok: true };
  }

  // Not approved yet: leave the pending sign-in in place so the user can retry.
  if (data && data.code === 'unknown_code') return { ok: false, code: 'not_approved_yet' };

  await chrome.storage.local.remove('pending');
  return { ok: false, code: (data && data.code) || 'exchange_failed' };
}

// Watch for the approval landing page on the tab we opened. Registered at the top
// level so Chrome wakes the worker for it even after it has been stopped.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url || !tab.url.startsWith(DONE_URL)) {
    return;
  }
  const pending = await getPending();
  if (!pending || pending.tabId !== tabId) return;

  if (tab.url.includes('status=error')) {
    await chrome.storage.local.remove('pending');
    return;
  }
  const result = await finishConnect();
  if (result.ok) {
    // Leave the "connected" message on screen briefly, then tidy up the tab.
    setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1500);
  }
});

async function signOut() {
  const session = await getSession();
  await clearSession();
  if (session && session.refreshToken) {
    // Revoke server-side too. Best effort: the local copy is already gone.
    await postJson('/api/desktop/signout', { refresh_token: session.refreshToken }).catch(
      () => {}
    );
  }
  return { ok: true };
}

// --- tokens ---------------------------------------------------------------

async function refreshAccessToken(session) {
  const { status, data } = await postJson('/api/desktop/refresh', {
    refresh_token: session.refreshToken,
  });
  if (status === 200 && data && data.access_token) {
    const next = {
      ...session,
      accessToken: data.access_token,
      accessExpiresAt: Date.now() + (data.access_token_expires_in || 3600) * 1000,
      plan: data.plan || session.plan,
    };
    await setSession(next);
    return next;
  }
  // Revoked (e.g. "sign out all devices" on /account) or expired: sign out
  // locally so the popup offers Connect again instead of failing on every call.
  if (status === 401) await clearSession();
  return null;
}

async function freshSession() {
  let session = await getSession();
  if (!session) return null;
  if (!session.accessToken || session.accessExpiresAt - Date.now() < REFRESH_MARGIN_MS) {
    session = await refreshAccessToken(session);
  }
  return session;
}

/** Authenticated API call. Retries once after a refresh on 401. */
async function api({ path, method = 'GET', body }) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    return { status: 400, data: { code: 'invalid_input' } };
  }
  let session = await freshSession();
  if (!session) return { status: 401, data: { code: 'not_connected' } };

  const send = (token) =>
    fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'omit',
    });

  try {
    let res = await send(session.accessToken);
    if (res.status === 401) {
      session = await refreshAccessToken(session);
      if (!session) return { status: 401, data: { code: 'not_connected' } };
      res = await send(session.accessToken);
    }
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } catch {
    return { status: 0, data: { code: 'network_error' } };
  }
}

// --- popup messages -------------------------------------------------------

const HANDLERS = {
  async state() {
    const session = await getSession();
    const pending = await getPending();
    return {
      connected: Boolean(session),
      email: session ? session.email : '',
      pending: Boolean(pending),
      apiBase: API_BASE,
    };
  },
  connect: startConnect,
  finishConnect,
  signOut,
  api: (message) => api(message.request || {}),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only our own pages (the popup) may drive the worker. Content scripts and web
  // pages never get here without externally_connectable, but check anyway.
  if (sender.id !== chrome.runtime.id || (sender.tab && sender.tab.id !== undefined)) {
    return false;
  }
  const handler = message && HANDLERS[message.type];
  if (!handler) return false;
  Promise.resolve(handler(message))
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, code: 'internal_error' }));
  return true; // keep the channel open for the async response
});
