// -----------------------------------------------------------------------------
// pickJob — choose the best reading when a page has several frames
// -----------------------------------------------------------------------------
//
// Many company careers pages show the actual posting inside an <iframe> served
// by their job board (Greenhouse, Lever, Workable...). The popup runs the
// extractor in every frame it is allowed into (the page itself via activeTab,
// plus the job-board hosts listed in manifest.json host_permissions) and hands
// the results here.
//
// The frame that looks most like a job posting wins. If that is an embedded
// board, the URL saved to the tracker is still the page the user was on (that is
// the link they will want to come back to), the dedup id comes from the board
// (it is the stable one), and any field the board lacks, typically the company
// name, is borrowed from the surrounding page.
// -----------------------------------------------------------------------------

/** Job boards that are usually embedded. Mirrors manifest.json host_permissions. */
const JOB_BOARD_HOST =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|workable\.com|recruitee\.com|breezy\.hr|bamboohr\.com|teamtailor\.com|zohorecruit\.(com|in)|keka\.com|darwinbox\.in|freshteam\.com)$/i;

export function scoreJob(job) {
  if (!job) return -1;
  const description = job.description || '';
  if (!job.title && description.length < 80) return -1;
  let score = 0;
  if (job.foundStructuredData) score += 4;
  if (job.title) score += 2;
  if (job.company) score += 2;
  if (job.location) score += 1;
  score += Math.min(description.length / 1500, 3);
  // An embedded board is the posting itself; the page around it is usually a
  // generic "Careers" shell whose <h1> would otherwise look like a job title.
  if (!job.isTopFrame && JOB_BOARD_HOST.test(job.host || '')) score += 3;
  return score;
}

/**
 * @param {Array<{ frameId: number, result: object }>} injections
 *   What chrome.scripting.executeScript({ allFrames: true }) resolves to.
 * @returns {object | null} the chosen job, with `fromFrame` set to the board's
 *   host when it came from an embedded frame.
 */
export function pickJob(injections) {
  const readings = (injections || [])
    .filter((i) => i && i.result && typeof i.result === 'object')
    .map((i) => ({ ...i.result, isTopFrame: i.frameId === 0 || i.result.isTopFrame }));
  if (readings.length === 0) return null;

  const top = readings.find((r) => r.isTopFrame) || null;
  let best = null;
  let bestScore = -1;
  for (const reading of readings) {
    const s = scoreJob(reading);
    if (s > bestScore) {
      best = reading;
      bestScore = s;
    }
  }
  if (!best) return top;
  if (best.isTopFrame || !top) return { ...best, fromFrame: best.isTopFrame ? '' : best.host };

  return {
    ...best,
    company: best.company || top.company,
    location: best.location || top.location,
    url: top.url || best.url,
    fromFrame: best.host,
  };
}
