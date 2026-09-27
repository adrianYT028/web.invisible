'use server';

import { redirect } from 'next/navigation';

import {
  isValidDeviceCode,
  isValidUuid,
  sha256Hex,
} from '@/lib/auth/desktop-tokens';
import { logSafe } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

/**
 * Approve a desktop-app sign-in.
 *
 * SECURITY FIX (2026-09). This page used to record the device code as a side
 * effect of simply LOADING /auth/desktop?device_code=X. The code in that URL is
 * chosen by whoever built the link, so an attacker could generate a code, send a
 * signed-in user the link, and then redeem the code at /api/desktop/exchange to
 * get desktop tokens for the victim's account.
 *
 * Approval is now this server action, run only when the user clicks the button.
 * Next.js rejects server-action POSTs from other origins, and the session
 * cookie is SameSite=Lax, so a forged cross-site submission is unauthenticated.
 * The desktop app itself is unchanged: it still opens this page and still
 * receives the unviewable:// callback, one click later.
 */
export async function approveDesktop(formData: FormData): Promise<void> {
  const deviceCode = formData.get('device_code');
  const deviceId = formData.get('device_id');
  if (!isValidDeviceCode(deviceCode) || !isValidUuid(deviceId)) {
    redirect('/login');
  }

  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    const ret = encodeURIComponent(
      `/auth/desktop?device_code=${deviceCode}&device_id=${deviceId}`
    );
    redirect(`/login?redirectedFrom=${ret}`);
  }

  const { error } = await supabaseAdmin()
    .from('desktop_link_codes')
    .insert({
      user_id: user.id,
      device_code_hash: sha256Hex(deviceCode as string),
      device_id: deviceId,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
  // 23505: already approved (double click). The desktop can still redeem it.
  if (error && error.code !== '23505') {
    logSafe('desktop_link_insert_failed', { user_id: user.id, error: error.message });
  }

  redirect(`/auth/desktop/open?device_code=${encodeURIComponent(deviceCode as string)}`);
}
