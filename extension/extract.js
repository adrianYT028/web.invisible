// -----------------------------------------------------------------------------
// extractJobFromPage — read the job posting on the current tab
// -----------------------------------------------------------------------------
//
// Injected with chrome.scripting.executeScript({ func }), which serialises the
// function's SOURCE into the page. So this function must be completely
// self-contained: no imports, no references to anything outside its own body.
// Helpers are declared inside it for that reason.
//
// It only ever runs when the user clicks the extension icon (the `activeTab`
// permission), never in the background, and it only READS the page.
//
// Strategy, most to least reliable:
//   1. Site-specific selectors for the boards Indian students use most, which
//      reflect the job currently on screen (LinkedIn is a single-page app, so
//      page-level metadata can describe a different job than the visible one).
//   2. schema.org JobPosting JSON-LD, which Google for Jobs requires, so most
//      career sites (Greenhouse, Lever, Workday, Naukri, Internshala...) emit it.
//   3. Generic fallbacks: <h1>, og:title, og:site_name, <main>/<article> text.
//   A text selection of 200+ characters overrides the description, for pages
//   where none of the above finds the right block.
//
// The user reviews and can edit every field in the popup before anything is
// saved, so a partial result is still useful.
// -----------------------------------------------------------------------------

export function extractJobFromPage() {
  const MAX_DESCRIPTION = 20000;
  const MAX_FIELD = 300;

  function tidyLine(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  // Keeps paragraph breaks (useful for a job description) but collapses runs of
  // spaces and blank lines.
  function tidyBlock(value) {
    if (typeof value !== 'string') return '';
    return value
      .split('\n')
      .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function textOf(el) {
    if (!el) return '';
    const text = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    return text || '';
  }

  function first(selectors) {
    for (const selector of selectors) {
      let el = null;
      try {
        el = document.querySelector(selector);
      } catch {
        continue;
      }
      const text = tidyLine(textOf(el));
      if (text) return text;
    }
    return '';
  }

  function firstBlock(selectors) {
    for (const selector of selectors) {
      let el = null;
      try {
        el = document.querySelector(selector);
      } catch {
        continue;
      }
      const text = tidyBlock(textOf(el));
      if (text.length > 80) return text;
    }
    return '';
  }

  function meta(property) {
    const el =
      document.querySelector(`meta[property="${property}"]`) ||
      document.querySelector(`meta[name="${property}"]`);
    return tidyLine(el ? el.getAttribute('content') : '');
  }

  // JSON-LD descriptions are HTML. DOMParser builds an inert document: scripts do
  // not run and images do not load, unlike assigning innerHTML on a live element.
  function htmlToText(html) {
    if (typeof html !== 'string' || !html) return '';
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
      doc
        .querySelectorAll('p, li, div, h1, h2, h3, h4, h5, h6, tr')
        .forEach((el) => el.append('\n'));
      return tidyBlock(doc.body ? doc.body.textContent : '');
    } catch {
      return tidyBlock(html.replace(/<[^>]+>/g, ' '));
    }
  }

  function findPosting(node, depth) {
    if (!node || depth > 8) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findPosting(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof node !== 'object') return null;
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes('JobPosting')) return node;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        const found = findPosting(value, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function readJsonLd() {
    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]'
    )) {
      try {
        const found = findPosting(JSON.parse(script.textContent || ''), 0);
        if (found) return found;
      } catch {
        // Malformed JSON-LD is common; try the next block.
      }
    }
    return null;
  }

  function nameOf(value) {
    if (!value) return '';
    if (typeof value === 'string') return tidyLine(value);
    if (typeof value === 'object') return tidyLine(value.name || '');
    return '';
  }

  function locationOf(jobLocation) {
    const places = Array.isArray(jobLocation) ? jobLocation : [jobLocation];
    const parts = [];
    for (const place of places) {
      if (!place) continue;
      const address = typeof place === 'object' ? place.address || place : place;
      if (typeof address === 'string') {
        parts.push(tidyLine(address));
        continue;
      }
      const bits = [
        address.addressLocality,
        address.addressRegion,
        nameOf(address.addressCountry),
      ]
        .map((b) => (typeof b === 'string' ? tidyLine(b) : ''))
        .filter(Boolean);
      // Drop repeated components ("Bengaluru, Bengaluru, IN").
      const unique = bits.filter((b, i) => bits.indexOf(b) === i);
      if (unique.length) parts.push(unique.join(', '));
    }
    return parts.filter((p, i) => p && parts.indexOf(p) === i).join(' / ');
  }

  // --- site-specific selectors ---------------------------------------------
  // Class names on these sites change without notice, so each field lists
  // several candidates and prefers stable attributes where the site has them.
  const host = location.hostname.replace(/^www\./, '');
  const SITES = [
    {
      match: /(^|\.)linkedin\.com$/,
      title: [
        '.job-details-jobs-unified-top-card__job-title',
        '.jobs-unified-top-card__job-title',
        '.top-card-layout__title',
        // No bare 'h1' here: LinkedIn's current layout has no job-title <h1>,
        // and other <h1>s on the page are not the role. The tab title is used
        // instead (see parsePageTitle below).
      ],
      company: [
        '.job-details-jobs-unified-top-card__company-name',
        '.jobs-unified-top-card__company-name',
        '.topcard__org-name-link',
        '.top-card-layout__second-subline a',
      ],
      location: [
        '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
        '.job-details-jobs-unified-top-card__bullet',
        '.jobs-unified-top-card__bullet',
        '.topcard__flavor--bullet',
      ],
      description: [
        '#job-details',
        '.jobs-description__content',
        '.jobs-box__html-content',
        '.show-more-less-html__markup',
        '.description__text',
      ],
    },
    {
      match: /(^|\.)naukri\.com$/,
      title: ['[class*="jd-header-title"]', 'h1'],
      company: ['[class*="jd-header-comp-name"] a', '[class*="jd-header-comp-name"]'],
      location: ['[class*="jhc__location"]', '[class*="location"] a'],
      description: ['[class*="job-desc-container"]', '[class*="dang-inner-html"]', '[class*="job-desc"]'],
    },
    {
      match: /(^|\.)internshala\.com$/,
      title: ['.individual_internship_header .profile', '.heading_4_5.profile', '.profile'],
      company: ['.individual_internship_header .company_name a', '.company_name a', '.company-name'],
      location: ['#location_names', '.location_link', '.locations'],
      description: ['.internship_details', '.text-container'],
    },
    {
      match: /(^|\.)greenhouse\.io$/,
      title: ['.app-title', '[class*="job__title"] h1', 'h1.section-header', 'h1'],
      company: ['.company-name'],
      location: ['.location', '.job__location'],
      description: ['#content', '.job__description'],
    },
    {
      match: /(^|\.)lever\.co$/,
      title: ['.posting-headline h2'],
      company: [],
      location: ['.posting-categories .location', '.sort-by-location'],
      description: ['[data-qa="job-description"]', '.posting-page .content', '.section-wrapper.page-full-width'],
    },
    {
      match: /(^|\.)indeed\.[a-z.]+$/,
      title: ['[data-testid="jobsearch-JobInfoHeader-title"]', '.jobsearch-JobInfoHeader-title', 'h1'],
      company: ['[data-testid="inlineHeader-companyName"]', '[data-company-name]'],
      location: ['[data-testid="inlineHeader-companyLocation"]', '[data-testid="job-location"]'],
      description: ['#jobDescriptionText'],
    },
  ];

  const site = SITES.find((s) => s.match.test(host));
  const fromSite = site
    ? {
        title: first(site.title),
        company: first(site.company),
        location: first(site.location),
        description: firstBlock(site.description),
      }
    : { title: '', company: '', location: '', description: '' };

  // --- JSON-LD ---------------------------------------------------------------
  const posting = readJsonLd();
  const fromLd = posting
    ? {
        title: tidyLine(posting.title || ''),
        company: nameOf(posting.hiringOrganization),
        location: locationOf(posting.jobLocation),
        description: htmlToText(posting.description),
        remote:
          posting.jobLocationType === 'TELECOMMUTE' ||
          (Array.isArray(posting.jobLocationType) &&
            posting.jobLocationType.includes('TELECOMMUTE')),
        identifier:
          typeof posting.identifier === 'object' && posting.identifier
            ? tidyLine(String(posting.identifier.value || ''))
            : tidyLine(String(posting.identifier || '')),
      }
    : { title: '', company: '', location: '', description: '', remote: false, identifier: '' };

  // --- the tab title ---------------------------------------------------------
  // Job boards put the role and company in the tab title, and it survives their
  // redesigns far better than class names do. LinkedIn in particular keeps it
  // in sync with the job selected in its single-page app:
  //   "Technology Architect | Accenture in India | LinkedIn"
  //   "(3) Data Analyst | Globex | LinkedIn"            (notification count)
  //   "Globex hiring Data Analyst in Pune, Maharashtra, India | LinkedIn"
  //   "SDE 1 - Initech - Naukri.com" / "SDE 1 at Initech"
  const SITE_NAMES =
    /^(linkedin|indeed(\.com)?|naukri(\.com)?|internshala|glassdoor|wellfound|foundit|monster|instahyre|cutshort|unstop|jobs?|careers?)$/i;

  function parsePageTitle(raw) {
    const text = tidyLine(raw).replace(/^\(\d+\+?\)\s*/, '');
    if (!text) return { title: '', company: '', location: '' };

    const parts = text
      .split(/\s+[|–—·]\s+|\s+-\s+/)
      .map((p) => p.trim())
      .filter((p) => p && !SITE_NAMES.test(p));

    // "Company hiring Role in Place"
    const hiring = (parts[0] || '').match(/^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+(.+))?$/i);
    if (hiring) {
      return { title: hiring[2], company: hiring[1], location: hiring[3] || '' };
    }
    // "Role at Company"
    if (parts.length === 1) {
      const at = parts[0].match(/^(.+?)\s+at\s+(.+)$/i);
      if (at) return { title: at[1], company: at[2], location: '' };
      return { title: parts[0], company: '', location: '' };
    }
    return { title: parts[0] || '', company: parts[1] || '', location: '' };
  }

  const fromTitle = parsePageTitle(document.title || meta('og:title'));

  // --- LinkedIn: find fields by their visible text -----------------------------
  // LinkedIn obfuscates class names and changes them often, so rely on what the
  // reader sees instead.
  const isLinkedIn = /(^|\.)linkedin\.com$/.test(host);

  // The top card has a line like
  //   "Bengaluru, Karnataka, India · 2 weeks ago · Over 100 people clicked apply"
  // and the location is the part before the first " · ".
  function linkedInLocation(skip) {
    const skipped = skip.filter(Boolean).map((s) => s.toLowerCase());
    const candidates = document.querySelectorAll('span, div, p');
    const limit = Math.min(candidates.length, 4000);
    for (let i = 0; i < limit; i += 1) {
      const text = tidyLine(candidates[i].textContent);
      if (text.length > 220 || !text.includes(' · ')) continue;
      if (!/(ago|applicant|clicked apply|reposted|promoted|over \d+)/i.test(text)) continue;
      // A wider container may also carry the company ("Accenture · Bengaluru…"),
      // so take the first segment that is neither the company, the role, nor
      // the "2 weeks ago" / applicant-count parts.
      for (const segment of text.split(' · ')) {
        const place = segment.trim();
        if (!place || place.length > 100) continue;
        if (skipped.includes(place.toLowerCase())) continue;
        if (/(ago|applicant|clicked|reposted|promoted|over \d+|people)/i.test(place)) continue;
        return place;
      }
    }
    return '';
  }

  // The description sits under an "About the job" heading.
  function linkedInDescription() {
    const headings = document.querySelectorAll('h1, h2, h3, h4, span, strong');
    for (const heading of headings) {
      if (!/^about the job$/i.test(tidyLine(heading.textContent))) continue;
      let container = heading.parentElement;
      // Climb until the container holds more than the heading itself.
      for (let depth = 0; container && depth < 4; depth += 1) {
        const text = tidyBlock(textOf(container));
        if (text.length > 200) return text.replace(/^about the job\s*/i, '');
        container = container.parentElement;
      }
    }
    return '';
  }

  if (isLinkedIn) {
    fromSite.title = fromSite.title || fromTitle.title;
    // LinkedIn names regional pages "Accenture in India"; the tracker wants the
    // employer. The user can still edit it in the popup.
    fromSite.company = (fromSite.company || fromTitle.company).replace(/\s+in\s+India$/i, '');
    fromSite.location =
      fromSite.location ||
      fromTitle.location ||
      linkedInLocation([fromSite.company, fromSite.title]);
    fromSite.description = fromSite.description || linkedInDescription();
  }

  // --- generic fallbacks -----------------------------------------------------
  const fromPage = {
    title: first(['h1']) || fromTitle.title,
    company: fromTitle.company || meta('og:site_name'),
    description: firstBlock(['main', 'article', '[role="main"]']),
  };

  let selection = '';
  try {
    selection = tidyBlock(String(window.getSelection ? window.getSelection() : ''));
  } catch {
    selection = '';
  }
  const usedSelection = selection.length >= 200;

  const title = fromSite.title || fromLd.title || fromPage.title;
  const company = fromSite.company || fromLd.company || fromPage.company;
  const jobLocation = fromSite.location || fromLd.location;
  const description = usedSelection
    ? selection
    : fromSite.description || fromLd.description || fromPage.description;

  // --- a stable id for de-duplication --------------------------------------
  // The tracker rejects a second save with the same (source, external_id), so
  // this must be the same every time the same posting is opened, whatever
  // tracking parameters the link carried.
  function externalIdFor(url) {
    const params = url.searchParams;
    if (/linkedin\.com$/.test(host)) {
      const id = params.get('currentJobId') || (url.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d+)/) || [])[1];
      if (id) return `linkedin:${id}`;
    }
    if (/indeed\./.test(host) && (params.get('jk') || params.get('vjk'))) {
      return `indeed:${params.get('jk') || params.get('vjk')}`;
    }
    // Every id-bearing parameter, in a fixed order. Embedded Greenhouse boards
    // (boards.greenhouse.io/embed/job_app?for=acme&token=123) share one path for
    // every job, so the id lives only in the query and dropping it would make
    // all of a company's jobs look like the same posting.
    const ID_PARAMS = ['for', 'token', 'gh_jid', 'jobId', 'job_id', 'jid'];
    const query = ID_PARAMS.filter((k) => params.get(k))
      .map((k) => `${k}=${params.get(k)}`)
      .join('&');
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${path}${query ? `?${query}` : ''}`;
  }

  let externalId = '';
  try {
    externalId = externalIdFor(new URL(location.href));
  } catch {
    externalId = '';
  }

  const remoteText = `${jobLocation} ${title}`;
  return {
    title: title.slice(0, MAX_FIELD),
    company: company.slice(0, MAX_FIELD),
    location: jobLocation.slice(0, MAX_FIELD),
    isRemote: fromLd.remote || /\b(remote|work from home|wfh)\b/i.test(remoteText),
    description: description.slice(0, MAX_DESCRIPTION),
    url: location.href.slice(0, 2000),
    externalId: externalId.slice(0, MAX_FIELD),
    usedSelection,
    foundStructuredData: Boolean(posting),
    // Lets the popup tell a job board embedded in an <iframe> from the page
    // around it. Comparing window references is allowed across origins.
    isTopFrame: window.top === window,
    host,
  };
}
