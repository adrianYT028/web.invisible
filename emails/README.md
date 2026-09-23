# Launch emails

Two emails, because there are two audiences and one message would be wrong for
one of them.

| File | Send to | Count |
|---|---|---|
| `01-paying-customers.*` | people who already paid ₹99 | 10 |
| `02-free-accounts.*` | accounts with a confirmed email, no purchase | 82 |

Counts from `node scripts/audience-segments.mjs .env.local.production-backup`.
Re-run it before sending; it prints counts only, never addresses.

## Why two

Email 01 sells nothing. Those 10 bought when ₹99 covered only the desktop app,
and migration 021 put them on the full plan, so they own all four services
already. Sending them a "₹99 for everything" email reads as being charged twice
for something they were just given. That is a support ticket and a refund
request, not a campaign.

Email 02 is the one that sells, and it leads with the free daily resume scan
rather than the price. The free plan gets one upload and one scan a day by
design (migration 011) precisely so the value is visible before anyone pays.

## Subject lines

**01 — paying customers**
- `Your ₹99 now covers three more tools` ← use this
- `You already own the three new tools`

**02 — free accounts**
- `Why your resume keeps getting filtered out` ← use this
- `Three new tools on your Unviewable account`

Avoid `FREE`, `!`, and ALL CAPS in the subject. On a domain with no sending
history those are what push a first campaign into spam.

## Two placeholders you MUST replace

Both files contain `{{POSTAL_ADDRESS}}` and `{{UNSUBSCRIBE_URL}}`.

- **`{{UNSUBSCRIBE_URL}}`** — every provider injects this for you. In Resend it
  is `{{{RESEND_UNSUBSCRIBE_URL}}}`, in Brevo `{{ unsubscribe }}`. Use the
  provider's token rather than a hand-written link, so the provider records the
  opt-out and never mails that address again. A hand-rolled link that does not
  actually suppress the address is worse than none.
- **`{{POSTAL_ADDRESS}}`** — a real postal address. Not optional: bulk mail
  without a physical address and a working opt-out is both a legal problem in
  most jurisdictions and a scored spam signal at Gmail.

`src/components/constants/business-info.ts` still has `TODO` in
`registeredAddress`, so there is no address to paste yet. That has to be filled
in for the Razorpay activation review anyway — do it once, use it in both places.

## Sending

Free tiers cover 92 recipients comfortably: Resend is 3,000/month and 100/day,
Brevo is 300/day.

1. Verify `unviewable.online` in the provider and add the SPF and DKIM DNS
   records it gives you. **Do not skip this.** Sending as
   `unviewable.online` without DKIM, or sending from a `gmail.com` address to a
   list, lands in spam and teaches mailbox providers to distrust the domain.
2. Send with BOTH parts: the `.html` and the matching `.txt`. HTML-only is a
   spam signal, and the text part is what shows in clients with images off.
3. Send 01 to the 10 first. Wait a day. Then 02 to the 82.

   Two reasons, and the second matters more. A domain with no sending history
   that suddenly emits 92 messages looks exactly like a compromised account. And
   if something in the email is wrong, 10 people see it instead of 92.

4. Set the reply-to to a mailbox someone actually reads. Both emails invite a
   reply, and an invitation to reply into a black hole is worse than no
   invitation.

## Before you send

- [ ] Sign in on production and click through `/services`, `/resume`, `/jobs`,
      `/prep`. The deploy is verified from outside — pages resolve and gate
      correctly — but the signed-in path has not been walked on production. 92
      people should not be the ones to find a broken page.
- [ ] Send both to yourself first. Check Gmail, and check on a phone.
- [ ] Click every link in the received copy. There are 4.
- [ ] Confirm the logo renders. It is hotlinked from
      `https://www.unviewable.online/logo.png`; if that path ever moves, every
      email already sent breaks.
- [ ] Two screenshots in `/guides/setup` still show the old "paste your key into
      the terminal" flow and contradict the text beside them. Neither email links
      to that page, but a curious reader will find it.

## Notes on the markup

- Tables and inline styles throughout. Outlook ignores `<style>` blocks, so
  every rule that matters is on the element; the `<style>` block holds only the
  mobile padding overrides and is safe to lose.
- Buttons carry `bgcolor` on the `<td>` as well as CSS on the anchor. Worst case
  in a hostile client it degrades to a solid dark rectangle with readable text,
  rather than invisible light text on white.
- No background images, no web fonts, no `<script>`. All three are either
  stripped or unreliable across clients.
- 600px wide, which is the safe maximum for the Outlook reading pane.
- The hidden preheader block controls the grey preview text next to the subject
  line. Without it clients pick their own, usually the logo's alt text.
