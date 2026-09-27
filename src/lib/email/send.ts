import { BUSINESS_INFO } from '@/components/constants/business-info';
import { env, isEmailConfigured } from '@/lib/env';
import { logSafe } from '@/lib/http';

// -----------------------------------------------------------------------------
// Email sending (Resend REST API) and the shared email layout
// -----------------------------------------------------------------------------
//
// No SDK: one fetch call to https://api.resend.com/emails keeps the dependency
// list short. With RESEND_API_KEY / EMAIL_FROM unset nothing is sent and the
// callers treat that as a quiet no-op, so dev and preview deployments never
// email real people.
//
// Every email carries a one-click unsubscribe link (also as the List-Unsubscribe
// header, which Gmail requires for bulk senders) and the business address.
// -----------------------------------------------------------------------------

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
}

export type SendResult = 'sent' | 'not_configured' | 'failed';

export async function sendEmail(message: OutgoingEmail): Promise<SendResult> {
  if (!isEmailConfigured()) return 'not_configured';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.emailFrom,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: {
          'List-Unsubscribe': `<${message.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logSafe('email_send_failed', { status: res.status });
      return 'failed';
    }
    return 'sent';
  } catch {
    logSafe('email_send_failed', { status: 0 });
    return 'failed';
  }
}

/** Escape text for safe inclusion in HTML. Job titles and names are untrusted. */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** A paragraph of body text. `html` must already be escaped. */
export function para(html: string): string {
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:#3A3A38;">${html}</p>`;
}

/** The single primary button. */
export function button(label: string, href: string): string {
  return `<p style="margin:24px 0;"><a href="${esc(href)}" style="display:inline-block;background:#131312;color:#FFFFFF;font-family:${FONT};font-size:15px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:8px;">${esc(label)}</a></p>`;
}

/** Wrap body HTML in the shared layout. */
export function layout(opts: {
  preheader: string;
  heading: string;
  bodyHtml: string;
  unsubscribeUrl: string;
  why: string;
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.heading)}</title></head>
<body style="margin:0;padding:0;background:#EFEEE9;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFEEE9;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#FFFFFF;border-radius:14px;">
<tr><td style="padding:22px 36px;background:#0A0A0B;border-radius:14px 14px 0 0;font-family:${FONT};font-size:13px;letter-spacing:.25em;color:#EDECE8;font-weight:600;">UNVIEWABLE</td></tr>
<tr><td style="padding:32px 36px 12px;">
<h1 style="margin:0 0 18px;font-family:${FONT};font-size:24px;line-height:1.25;color:#131312;">${esc(opts.heading)}</h1>
${opts.bodyHtml}
</td></tr>
<tr><td style="padding:16px 36px 28px;border-top:1px solid #E6E5E0;font-family:${FONT};font-size:12px;line-height:1.6;color:#8A8983;">
${esc(opts.why)} <a href="${esc(opts.unsubscribeUrl)}" style="color:#8A8983;">Unsubscribe</a>.<br>
${esc(BUSINESS_INFO.legalName)} · ${esc(BUSINESS_INFO.operatingAddress)}
</td></tr>
</table></td></tr></table></body></html>`;
}

/** Plain-text footer, matching the HTML one. */
export function textFooter(why: string, unsubscribeUrl: string): string {
  return `\n\n--\n${why}\nUnsubscribe: ${unsubscribeUrl}\n${BUSINESS_INFO.legalName} · ${BUSINESS_INFO.operatingAddress}`;
}
