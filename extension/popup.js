// -----------------------------------------------------------------------------
// Popup — reads the current tab, lets the user correct it, saves / scores it
// -----------------------------------------------------------------------------
//
// Page content is untrusted. Everything taken from the page is written with
// `.value` or `.textContent`, never innerHTML, so a hostile job page cannot inject
// markup or script into the extension.
// -----------------------------------------------------------------------------

import { API_BASE } from './config.js';
import { extractJobFromPage } from './extract.js';
import { pickJob } from './pick-frame.js';

const $ = (id) => document.getElementById(id);

const views = {
  connect: $('view-connect'),
  empty: $('view-empty'),
  job: $('view-job'),
};

/** Same labels as the website's resume analyser (src/app/resume/ResumeAnalyser.tsx). */
const SUBSCORE_LABELS = {
  parseIntegrity: 'Parse integrity',
  requirementCoverage: 'Requirements',
  keywordAlignment: 'Keywords',
  evidenceQuality: 'Evidence',
  knockoutRisk: 'Knockout risk',
};

let extracted = null;
/** Set after a successful match check, so the saved row carries the score. */
let scanId = null;

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function api(path, method, body) {
  return send({ type: 'api', request: { path, method, body } });
}

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

/**
 * Write a status line. `link` is an optional { href, text } appended as a real
 * anchor, built with DOM APIs rather than an HTML string.
 */
function setStatus(el, text, { error = false, link } = {}) {
  el.textContent = text;
  el.classList.toggle('error', error);
  if (link) {
    el.append(' ');
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.text;
    el.append(a);
  }
}

function busy(buttons, isBusy) {
  for (const b of buttons) b.disabled = isBusy;
}

// --- sign-in ---------------------------------------------------------------

async function renderConnect(state) {
  show('connect');
  $('btn-finish').hidden = !state.pending;
}

$('btn-connect').addEventListener('click', async () => {
  await send({ type: 'connect' });
  // The approval happens in a new tab; this popup closes when focus moves there.
  window.close();
});

$('btn-finish').addEventListener('click', async () => {
  const status = $('connect-status');
  setStatus(status, 'Checking…');
  const result = await send({ type: 'finishConnect' });
  if (result && result.ok) {
    await init();
    return;
  }
  const code = result && result.code;
  if (code === 'not_approved_yet') {
    setStatus(status, 'Not approved yet. Click "Connect extension" in the tab that opened.', {
      error: true,
    });
  } else {
    setStatus(status, 'That sign-in expired. Click "Connect account" to start again.', {
      error: true,
    });
    $('btn-finish').hidden = true;
  }
});

$('btn-signout').addEventListener('click', async () => {
  await send({ type: 'signOut' });
  await init();
});

// --- reading the page ------------------------------------------------------

async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) {
    return { error: 'This page cannot be read. Open a job posting on a website.' };
  }
  // Read every frame we are allowed into: the page itself, plus any embedded job
  // board on the manifest's host list. Frames on other hosts (ads, chat widgets)
  // are skipped by Chrome because the extension has no access to them.
  try {
    const injections = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractJobFromPage,
    });
    const job = pickJob(injections);
    if (job) return { job };
  } catch {
    // Fall through to the page-only read below.
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractJobFromPage,
    });
    return { job: injection && injection.result };
  } catch {
    // Chrome Web Store pages, PDFs and some browser pages refuse injection.
    return { error: 'Chrome does not allow extensions to read this page.' };
  }
}

function fillForm(job) {
  $('f-title').value = job.title || '';
  $('f-company').value = job.company || '';
  $('f-location').value = job.location || '';
  $('f-remote').checked = Boolean(job.isRemote);
  $('f-description').value = job.description || '';
  updateDescCount();

  const missing = !job.title || !job.company;
  let hint = '';
  if (job.usedSelection) hint = 'Using the text you selected as the description.';
  else if (job.fromFrame && !missing) hint = `Read from the embedded ${job.fromFrame} job board.`;
  else if (missing) hint = 'Some details were not found. Fill them in before saving.';
  else hint = 'Check the details, then save.';
  $('extract-hint').textContent = hint;

  // Open the description when it is the part most likely to need fixing.
  $('desc-details').open = !job.description || job.description.length < 200;
}

function updateDescCount() {
  const n = $('f-description').value.trim().length;
  $('desc-count').textContent = n ? `(${n.toLocaleString()} characters)` : '(empty)';
}

$('f-description').addEventListener('input', () => {
  updateDescCount();
  // The score belonged to the old text; do not attach it to a different one.
  scanId = null;
  $('match').hidden = true;
});

function formValues() {
  return {
    title: $('f-title').value.trim(),
    company: $('f-company').value.trim(),
    location: $('f-location').value.trim(),
    isRemote: $('f-remote').checked,
    status: $('f-status').value,
    description: $('f-description').value.trim(),
  };
}

// --- check match -----------------------------------------------------------

$('btn-match').addEventListener('click', async () => {
  const status = $('job-status');
  const buttons = [$('btn-match'), $('btn-save')];
  const values = formValues();

  if (values.description.length < 80) {
    $('desc-details').open = true;
    setStatus(
      status,
      'The job description is too short to score. Select it on the page and reopen the extension.',
      { error: true }
    );
    return;
  }

  busy(buttons, true);
  setStatus(status, 'Finding your latest resume…');

  try {
    const latest = await api('/api/resume/latest', 'GET');
    if (handleAuthLoss(latest)) return;
    if (latest.status !== 200) {
      setStatus(status, 'Could not load your resume. Try again.', { error: true });
      return;
    }
    if (!latest.data || !latest.data.resume) {
      setStatus(status, 'Upload a resume first.', {
        error: true,
        link: { href: `${API_BASE}/resume`, text: 'Open resume analyser' },
      });
      return;
    }

    setStatus(status, `Scoring against ${latest.data.resume.fileName}… this takes up to a minute.`);
    const scan = await api('/api/resume/scan', 'POST', {
      resumeId: latest.data.resume.id,
      jdText: values.description,
    });
    if (handleAuthLoss(scan)) return;

    if (scan.status === 200 && scan.data) {
      scanId = scan.data.scanId || null;
      renderMatch(scan.data);
      setStatus(
        status,
        scan.data.reused ? 'Already scored before, so this used no quota.' : 'Scored.',
        { link: { href: `${API_BASE}/resume`, text: 'See the full report' } }
      );
      return;
    }
    setStatus(status, scanErrorMessage(scan), {
      error: true,
      link:
        scan.data && scan.data.code === 'parse_quality_too_low'
          ? { href: `${API_BASE}/resume`, text: 'Fix it on the site' }
          : undefined,
    });
  } finally {
    busy(buttons, false);
  }
});

function renderMatch(result) {
  $('match').hidden = false;
  $('match-score').textContent = String(result.overallScore ?? '–');
  const list = $('match-subscores');
  list.replaceChildren();
  for (const [key, label] of Object.entries(SUBSCORE_LABELS)) {
    const value = result.subScores ? result.subScores[key] : undefined;
    if (typeof value !== 'number') continue;
    const li = document.createElement('li');
    li.append(`${label}: `);
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    li.append(strong);
    list.append(li);
  }
}

function scanErrorMessage({ status, data }) {
  const code = data && data.code;
  switch (code) {
    case 'quota_exceeded':
      return `You have used today's ${data.cap ?? ''} scans. Try again tomorrow.`.replace('  ', ' ');
    case 'analysis_busy':
      return 'The analyser is busy. Try again in a minute.';
    case 'parse_quality_too_low':
      return 'Your resume could not be read well enough to score.';
    case 'resume_not_found':
      return 'That resume is no longer available. Upload it again on the site.';
    case 'invalid_input':
      return (data && data.message) || 'The job description is too short to score.';
    case 'network_error':
      return 'Could not reach Unviewable. Check your connection.';
    default:
      return status === 0 || status >= 500
        ? 'Scoring is unavailable right now. Try again shortly.'
        : (data && data.message) || 'Could not score this job.';
  }
}

// --- save ------------------------------------------------------------------

$('view-job').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('job-status');
  const buttons = [$('btn-match'), $('btn-save')];
  const values = formValues();

  if (!values.title || !values.company) {
    setStatus(status, 'Add the role and the company first.', { error: true });
    (values.title ? $('f-company') : $('f-title')).focus();
    return;
  }

  busy(buttons, true);
  setStatus(status, 'Saving…');
  try {
    const res = await api('/api/jobs', 'POST', {
      source: 'extension',
      external_id: extracted && extracted.externalId ? extracted.externalId : undefined,
      company: values.company,
      job_title: values.title,
      location: values.location || undefined,
      is_remote: values.isRemote,
      url: extracted ? extracted.url : undefined,
      jd_text: values.description || undefined,
      status: values.status,
      scan_id: scanId || undefined,
    });
    if (handleAuthLoss(res)) return;

    const tracker = { href: `${API_BASE}/jobs`, text: 'Open tracker' };
    if (res.status === 201) {
      setStatus(status, 'Saved to your tracker.', { link: tracker });
      $('btn-save').textContent = 'Saved';
      return; // leave Save disabled so a double click cannot re-post
    }
    if (res.status === 409) {
      setStatus(status, 'This job is already in your tracker.', { link: tracker });
      return;
    }
    if (res.status === 402) {
      const full = res.data && res.data.code === 'tracker_full';
      setStatus(
        status,
        full
          ? `Your free tracker is full (${res.data.cap ?? 50} jobs). Remove old ones or get full access.`
          : 'Saving jobs needs full access.',
        {
          error: true,
          link: full
            ? { href: `${API_BASE}/jobs`, text: 'Open tracker' }
            : { href: `${API_BASE}/pricing`, text: 'See pricing' },
        }
      );
    } else {
      setStatus(status, (res.data && res.data.message) || 'Could not save this job. Try again.', {
        error: true,
      });
    }
    busy(buttons, false);
  } catch {
    setStatus(status, 'Could not save this job. Try again.', { error: true });
    busy(buttons, false);
  }
});

/** A 401 after refresh means the session is gone (revoked or expired). */
function handleAuthLoss(res) {
  if (res && res.status === 401) {
    init();
    return true;
  }
  return false;
}

// --- boot ------------------------------------------------------------------

async function init() {
  const state = await send({ type: 'state' });
  $('link-tracker').href = `${API_BASE}/jobs`;
  $('who').textContent = state.connected ? state.email : '';
  $('btn-signout').hidden = !state.connected;

  if (!state.connected) {
    await renderConnect(state);
    return;
  }

  const { job, error } = await readActiveTab();
  if (error || !job) {
    $('empty-reason').textContent = error || 'Nothing readable was found on this page.';
    show('empty');
    return;
  }
  extracted = job;
  fillForm(job);
  show('job');
  ($('f-title').value ? $('btn-save') : $('f-title')).focus();
}

init();
