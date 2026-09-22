// -----------------------------------------------------------------------------
// Finding who to contact — from what the posting already publishes
// -----------------------------------------------------------------------------
//
// This reads the job description the company wrote and pulls out the contact
// details THEY chose to put in it. Nothing is looked up, enriched, guessed, or
// stored about anyone who did not publish their own address in a job ad.
//
// That boundary is deliberate and it is also the practical choice. The
// alternatives all fail:
//
//   Guessing first.last@company.com produces mostly invalid addresses, and a high
//   bounce rate on a student's own mailbox is the fastest way to get their real
//   applications filtered as spam.
//
//   Buying or scraping employee lists means holding contact details for thousands
//   of people who never heard of the product — a liability that grows with usage
//   and belongs to whoever stores it.
//
// So: use the address the company published, and when there isn't one, say so and
// tell the candidate where to look. "No contact published, apply through the form"
// is a true and useful answer.

/** A contact route surfaced from a posting. */
export interface PostingContact {
  /** An address the posting published, or null. */
  email: string | null;
  /** A person named as the contact, when the posting names one. */
  name: string | null;
  /**
   * What the candidate should do, in plain words. Always populated, including
   * when no address was found.
   */
  guidance: string;
  /** How the address was obtained. Never anything other than these two. */
  provenance: 'published_in_posting' | 'none';
}

/**
 * Addresses that are a person's individual mailbox rather than a role account.
 *
 * Role accounts (careers@, jobs@, hr@) exist to receive exactly this kind of
 * message. An individual address published in a posting is also fair to use, but
 * it is worth telling the candidate which kind they have, because the tone differs.
 */
const ROLE_ACCOUNT = /^(careers?|jobs?|hiring|recruit(ing|ment)?|hr|people|talent|apply|applications?|resume|cv|join|work)@/i;

/**
 * Addresses that are never a hiring contact.
 *
 * Job descriptions routinely contain a press address, a privacy contact for the
 * GDPR notice, or an accessibility line. Mailing those about a job wastes the
 * candidate's one shot and annoys someone who cannot help.
 */
const NOT_A_HIRING_CONTACT =
  /^(privacy|legal|dpo|dataprotection|gdpr|press|media|pr|info|support|help|sales|billing|invoice|security|abuse|postmaster|webmaster|noreply|no-reply|donotreply|accessibility|compliance)@/i;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/**
 * Extract the best hiring contact a posting publishes.
 *
 * Prefers a role account over an individual: a role account is unambiguously
 * intended for applicants, whereas an individual address in a long JD may belong
 * to someone mentioned for another reason.
 */
export function findPostingContact(input: {
  description: string;
  companyName: string | null;
}): PostingContact {
  const { description, companyName } = input;
  const company = companyName ?? 'the company';

  const found = [...(description.match(EMAIL_RE) ?? [])]
    .map((e) => e.trim().replace(/[.,;:)]+$/, ''))
    .filter((e) => !NOT_A_HIRING_CONTACT.test(e));

  // Deduplicate case-insensitively; postings often repeat an address.
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const email of found) {
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(email);
  }

  const roleAccount = unique.find((e) => ROLE_ACCOUNT.test(e));
  const chosen = roleAccount ?? unique[0] ?? null;

  if (!chosen) {
    return {
      email: null,
      name: null,
      provenance: 'none',
      guidance: `This posting does not publish a contact address. Apply through the form first, then look for the ${company} hiring manager or recruiter for this team on LinkedIn and message them there — a short note referencing the specific role works better than a cold email to a generic inbox.`,
    };
  }

  const isRole = ROLE_ACCOUNT.test(chosen);
  return {
    email: chosen,
    name: isRole ? null : nameFromEmail(chosen),
    provenance: 'published_in_posting',
    guidance: isRole
      ? `${company} published ${chosen} in this posting for applicants. Apply through the form as well — a mail alone is rarely enough.`
      : `${chosen} is named in the posting itself. Keep it short and specific; this is somebody's personal inbox, not a queue.`,
  };
}

/**
 * A plausible first name from an address local part, for the greeting.
 *
 * Returns null unless the shape is clearly a name — this only ever chooses
 * between "Hi Priya" and "Hello", so a wrong guess is worse than no guess.
 */
export function nameFromEmail(email: string): string | null {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._-]/)[0] ?? '';
  if (first.length < 2 || first.length > 15) return null;
  if (!/^[a-z]+$/i.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * A Gmail compose deep link, pre-filled.
 *
 * The send happens from the USER'S OWN mailbox, which is the whole design. It
 * means their real address is the sender, replies reach them, and the platform
 * never operates a bulk sending domain that would be blacklisted inside a month.
 * It also needs no OAuth scope and no security review.
 */
export function gmailComposeUrl(input: {
  to: string;
  subject: string;
  body: string;
}): string {
  const params = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to: input.to,
    su: input.subject,
    body: input.body,
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

/** A `mailto:` fallback for anyone not using Gmail in a browser. */
export function mailtoUrl(input: {
  to: string;
  subject: string;
  body: string;
}): string {
  const params = new URLSearchParams({
    subject: input.subject,
    body: input.body,
  });
  return `mailto:${encodeURIComponent(input.to)}?${params.toString()}`;
}
