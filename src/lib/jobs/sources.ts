// -----------------------------------------------------------------------------
// Job sources — public ATS job boards
// -----------------------------------------------------------------------------
//
// Three platforms, all verified against live data rather than assumed:
//
//   greenhouse  boards-api.greenhouse.io   full JD text included
//   lever       api.lever.co               full JD text included
//   ashby       jobs.ashbyhq.com GraphQL   titles + locations, JD needs a second call
//
// WHY ONLY THESE THREE
//   SmartRecruiters and Workable still answer 200 but return zero postings for
//   every tenant tried, including ones that certainly use them — those endpoints
//   are gated now. Workday needs a per-tenant POST with a site name that is not
//   discoverable. Naukri and LinkedIn have no public API.
//
// WHY NOT SCRAPE THE BIG BOARDS
//   Not a legal argument — a reliability one. Scraped feeds sit behind bot
//   detection, so they break on someone else's deploy schedule, need rotating
//   proxies to stay up, and become permanent maintenance. A job board that is
//   empty two days a week is worse than a smaller one that always works. The
//   licensed route (Adzuna) is the non-fragile way to widen coverage.
//
// COVERAGE IS A FUNCTION OF THE COMPANY LIST, NOT THE PLATFORM
//   A guessed list of 48 Indian companies found 7 on these platforms. That is a
//   property of the guess, not the ceiling: thousands of tenants exist. The
//   registry in migration 013 is the thing to grow.

export type JobSource = 'greenhouse' | 'lever' | 'ashby';

/** One posting, normalised across every platform. */
export interface FetchedPosting {
  source: JobSource;
  /** The platform's own id. Unique within (source, company). */
  externalId: string;
  companySlug: string;
  companyName: string | null;
  title: string;
  location: string | null;
  isRemote: boolean;
  /** Apply link, shown to the user. */
  url: string;
  /** Plain-text description. Empty when the platform needs a second call. */
  description: string;
  postedAt: string | null;
}

export interface FetchResult {
  postings: FetchedPosting[];
  /** Set when the whole fetch failed, so a sync can record it per company. */
  error: string | null;
}

const TIMEOUT_MS = 20_000;

/**
 * Strip HTML to readable text.
 *
 * Greenhouse and Lever return HTML descriptions. The match engine reads plain
 * text, and the parse-quality lesson applies here too: block boundaries must
 * become newlines, or every requirement runs into the next one and the extractor
 * sees one wall of prose.
 */
export function htmlToPlainText(html: string): string {
  // DECODE ENTITIES FIRST. Greenhouse returns its description ENTITY-ENCODED:
  // the raw value is `&lt;div class=&quot;content-intro&quot;&gt;`, not literal
  // `<div ...>`. Stripping tags before decoding therefore matches nothing, and the
  // decode step then TURNS the entities into visible tags — so the "plain text"
  // handed to the match engine was raw HTML markup. Order is the whole fix.
  const decoded = decodeEntities(html);

  return (
    decoded
      // Block boundaries become newlines so section headings stay on their own
      // line; without this every requirement runs into the next one.
      .replace(/<\/(p|div|li|h[1-6]|tr|table|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      // Decode again: entities inside the text were double-encoded, so the first
      // pass only removed the outer layer.
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** HTML entities, named and numeric. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&ldquo;/gi, '\u201C')
    .replace(/&rdquo;/gi, '\u201D')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    // &amp; LAST, so "&amp;lt;" becomes "&lt;" rather than being decoded twice
    // into a stray "<".
    .replace(/&amp;/gi, '&');
}

/**
 * Whether a location string means remote.
 *
 * Checked as whole words: "Remote" is remote, but a location containing
 * "Bengaluru" plus the word "remotely" in a title is not something to guess at.
 */
export function looksRemote(location: string | null): boolean {
  if (!location) return false;
  return /\b(remote|anywhere|work from home|wfh|distributed)\b/i.test(location);
}

/**
 * Whether a location is in India.
 *
 * Used to score relevance for the launch market. Matches the country plus the
 * cities that carry most Indian tech hiring, including both spellings of
 * Bengaluru and Gurugram — a posting written "Bangalore" is the same place.
 */
export function isIndiaLocation(location: string | null): boolean {
  if (!location) return false;
  return /\b(india|bengaluru|bangalore|mumbai|delhi|ncr|gurgaon|gurugram|noida|hyderabad|pune|chennai|kolkata|ahmedabad|jaipur|indore|kochi|coimbatore|trivandrum|thiruvananthapuram|bhubaneswar|chandigarh)\b/i.test(
    location
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Greenhouse
// -----------------------------------------------------------------------------

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  content?: string;
  company_name?: string;
  first_published?: string;
  updated_at?: string;
  location?: { name?: string };
}

/**
 * Fetch a Greenhouse board.
 *
 * `content=true` returns the full HTML description in the SAME request, which
 * matters: without it each posting needs its own call, and a 500-job board would
 * be 500 requests.
 */
export async function fetchGreenhouse(slug: string): Promise<FetchResult> {
  try {
    const data = await fetchJson<{ jobs?: GhJob[] }>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`
    );
    const postings = (data.jobs ?? []).map((j): FetchedPosting => {
      const location = j.location?.name?.trim() || null;
      return {
        source: 'greenhouse',
        externalId: String(j.id),
        companySlug: slug,
        companyName: j.company_name?.trim() || null,
        title: j.title?.trim() ?? '',
        location,
        isRemote: looksRemote(location),
        url: j.absolute_url,
        description: j.content ? htmlToPlainText(j.content) : '',
        postedAt: j.first_published ?? j.updated_at ?? null,
      };
    });
    return { postings: postings.filter((p) => p.title.length > 0), error: null };
  } catch (err) {
    return { postings: [], error: message(err) };
  }
}

// -----------------------------------------------------------------------------
// Lever
// -----------------------------------------------------------------------------

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
  createdAt?: number;
  categories?: { location?: string; commitment?: string };
  workplaceType?: string;
}

export async function fetchLever(slug: string): Promise<FetchResult> {
  try {
    const data = await fetchJson<LeverPosting[]>(
      `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`
    );
    if (!Array.isArray(data)) return { postings: [], error: 'unexpected_shape' };

    const postings = data.map((p): FetchedPosting => {
      const location = p.categories?.location?.trim() || null;
      return {
        source: 'lever',
        externalId: p.id,
        companySlug: slug,
        companyName: null,
        title: p.text?.trim() ?? '',
        location,
        // Lever states this explicitly, so it is preferred over guessing from text.
        isRemote:
          p.workplaceType?.toLowerCase() === 'remote' || looksRemote(location),
        url: p.hostedUrl || p.applyUrl || '',
        description: p.descriptionPlain?.trim() ?? '',
        postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      };
    });
    return { postings: postings.filter((p) => p.title.length > 0), error: null };
  } catch (err) {
    return { postings: [], error: message(err) };
  }
}

// -----------------------------------------------------------------------------
// Ashby
// -----------------------------------------------------------------------------

/**
 * Ashby's public board query.
 *
 * ONLY fields that exist on `JobPostingBriefsWithIdsAndTeamId`. Asking for
 * `publishedDate` fails GraphQL validation for the WHOLE query —
 * "Cannot query field publishedDate" — which returns an errors array and no data,
 * so every company silently reported zero jobs. A single wrong field name costs
 * the entire board, so add one only after checking it against the live schema.
 */
const ASHBY_QUERY = `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
  jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
    jobPostings { id title locationName employmentType }
  }
}`;

interface AshbyPosting {
  id: string;
  title: string;
  locationName?: string;
}

/**
 * Fetch an Ashby board.
 *
 * Ashby's public board returns titles and locations but NOT descriptions, so
 * `description` is empty and the match engine has nothing to score against until
 * the user opens the posting. Recorded honestly rather than faked from the title:
 * a scan against an invented description would produce a confident wrong number.
 */
export async function fetchAshby(slug: string): Promise<FetchResult> {
  try {
    const data = await fetchJson<{
      data?: { jobBoard?: { jobPostings?: AshbyPosting[] } | null };
    }>('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationName: 'ApiJobBoardWithTeams',
        variables: { organizationHostedJobsPageName: slug },
        query: ASHBY_QUERY,
      }),
    });

    const board = data.data?.jobBoard;
    // A missing board is a wrong slug, not a transport failure.
    if (!board) return { postings: [], error: 'unknown_board' };

    const postings = (board.jobPostings ?? []).map((p): FetchedPosting => {
      const location = p.locationName?.trim() || null;
      return {
        source: 'ashby',
        externalId: p.id,
        companySlug: slug,
        companyName: null,
        title: p.title?.trim() ?? '',
        location,
        isRemote: looksRemote(location),
        url: `https://jobs.ashbyhq.com/${slug}/${p.id}`,
        description: '',
        // Ashby's brief listing carries no publish date. Left null rather than
        // defaulting to now, which would make every posting look brand new.
        postedAt: null,
      };
    });
    return { postings: postings.filter((p) => p.title.length > 0), error: null };
  } catch (err) {
    return { postings: [], error: message(err) };
  }
}

/** Fetch one company's board from whichever platform hosts it. */
export function fetchBoard(source: JobSource, slug: string): Promise<FetchResult> {
  switch (source) {
    case 'greenhouse':
      return fetchGreenhouse(slug);
    case 'lever':
      return fetchLever(slug);
    case 'ashby':
      return fetchAshby(slug);
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 120);
  return 'unknown_error';
}
