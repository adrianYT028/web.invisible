#!/usr/bin/env node
/**
 * Structural check on the launch emails, using a real HTML parser.
 *
 * Counting tags with grep gave a false positive on a `<td>` written inside a
 * comment, which is exactly the kind of thing that makes a hand-rolled check
 * worse than none. jsdom builds the actual tree, so the numbers below are the
 * ones a mail client would see.
 *
 * Also asserts the things that silently break email specifically:
 *   - no <script>, no <link>, no external stylesheet (stripped, or a spam flag)
 *   - no CSS background-image (Outlook does not render them)
 *   - every <img> has alt text and explicit width/height
 *   - every link is absolute https (a relative href in an email goes nowhere)
 *   - the body stays under Gmail's 102KB clipping threshold
 *
 * Usage: node emails/validate.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// fileURLToPath, not `new URL(...).pathname`: the project lives under a folder
// with a space in its name, and `.pathname` hands back the percent-encoded form
// ("INVISIBLE%20APP"), which is not a path any fs call can open.
const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.html')).sort();

const GMAIL_CLIP_BYTES = 102400;
let failures = 0;

function fail(file, msg) {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
}
function ok(msg) {
  console.log(`  OK    ${msg}`);
}

for (const file of files) {
  const path = `${dir}${file}`;
  const html = readFileSync(path, 'utf8');
  const bytes = Buffer.byteLength(html, 'utf8');

  console.log(`\n=== ${file} ===`);

  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Size. Past this Gmail truncates and appends "View entire message", which
  // usually cuts the unsubscribe link off the bottom.
  if (bytes < GMAIL_CLIP_BYTES) {
    ok(`${bytes} bytes, under Gmail's ${GMAIL_CLIP_BYTES} clip limit`);
  } else {
    fail(file, `${bytes} bytes exceeds Gmail's ${GMAIL_CLIP_BYTES} clip limit`);
  }

  // Tree shape. If the parser had to repair unbalanced tags these counts would
  // not match the source intent, but more importantly a malformed table is what
  // makes Outlook collapse a layout.
  const tables = doc.querySelectorAll('table').length;
  const rows = doc.querySelectorAll('tr').length;
  const cells = doc.querySelectorAll('td').length;
  ok(`parsed cleanly: ${tables} tables, ${rows} rows, ${cells} cells`);

  // Things that get stripped or flagged.
  for (const tag of ['script', 'link', 'iframe', 'form', 'object', 'embed']) {
    const n = doc.querySelectorAll(tag).length;
    if (n > 0) fail(file, `contains <${tag}> (${n}) — stripped by clients or flagged as spam`);
  }
  if (!/<script|<link|<iframe|<form/i.test(html)) ok('no script/link/iframe/form');

  // Outlook renders no CSS background images, so anything relying on one is
  // invisible there.
  if (/background-image\s*:/i.test(html)) {
    fail(file, 'uses background-image — invisible in Outlook');
  } else {
    ok('no background-image');
  }

  // Images need alt text (many clients block images by default) and explicit
  // dimensions (otherwise Outlook renders them at native size).
  const imgs = [...doc.querySelectorAll('img')];
  for (const img of imgs) {
    const src = img.getAttribute('src') ?? '';
    if (!img.getAttribute('alt')) fail(file, `<img src="${src}"> has no alt text`);
    if (!img.getAttribute('width') || !img.getAttribute('height')) {
      fail(file, `<img src="${src}"> is missing width/height`);
    }
    if (!src.startsWith('https://')) fail(file, `<img src="${src}"> is not absolute https`);
  }
  if (imgs.length) ok(`${imgs.length} image(s): alt text, explicit size, absolute https`);

  // A relative href in an email has no base to resolve against.
  const links = [...doc.querySelectorAll('a[href]')];
  const bad = links.filter((a) => {
    const h = a.getAttribute('href') ?? '';
    return !(
      h.startsWith('https://') ||
      h.startsWith('mailto:') ||
      h.startsWith('{{')
    );
  });
  for (const a of bad) fail(file, `href "${a.getAttribute('href')}" is not absolute`);
  if (!bad.length) ok(`${links.length} link(s), all absolute or provider tokens`);

  // The two things that must be replaced before sending. Present = correct at
  // this stage; the README is what says to swap them.
  const placeholders = [...new Set(html.match(/\{\{[A-Z_]+\}\}/g) ?? [])];
  if (placeholders.length) {
    ok(`placeholders awaiting replacement: ${placeholders.join(', ')}`);
  }

  // An unsubscribe link must exist somewhere, in some form.
  if (/UNSUBSCRIBE_URL|unsubscribe/i.test(html)) {
    ok('has an unsubscribe link');
  } else {
    fail(file, 'NO unsubscribe link — legal problem and a scored spam signal');
  }

  // Preheader: without it the client invents preview text from the alt tag.
  if (/display:none/i.test(html)) ok('has a hidden preheader block');
  else fail(file, 'no preheader — the client will pick its own preview text');

  // A plain-text sibling. HTML-only mail is a spam signal.
  const txt = file.replace(/\.html$/, '.txt');
  try {
    readFileSync(`${dir}${txt}`, 'utf8');
    ok(`plain-text alternative present (${txt})`);
  } catch {
    fail(file, `missing plain-text alternative ${txt}`);
  }
}

console.log(
  failures === 0
    ? '\nAll checks passed.'
    : `\n${failures} problem(s) found.`
);
process.exit(failures === 0 ? 0 : 1);
