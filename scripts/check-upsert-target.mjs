#!/usr/bin/env node
/**
 * Checks that an upsert's ON CONFLICT target actually has a matching unique
 * constraint, in a given project, WITHOUT writing a row.
 *
 * HOW IT AVOIDS WRITING
 *   Postgres resolves the ON CONFLICT specification while PLANNING the statement,
 *   before any row is evaluated. So a deliberately invalid row (a NULL in a NOT
 *   NULL column) produces:
 *
 *     42P10  "there is no unique or exclusion constraint matching the ON
 *             CONFLICT specification"   -> the constraint is MISSING
 *     23502  "null value in column ... violates not-null constraint"
 *                                       -> the constraint EXISTS, and planning
 *                                          got past it
 *
 *   Either way the transaction aborts and nothing is inserted.
 *
 * WHY THIS IS WORTH A SCRIPT
 *   `.upsert(..., { onConflict: 'a,b' })` against a table with no unique index on
 *   (a, b) fails at runtime only, with a 500 and no clue. It has already happened
 *   once in production here — saving an API key broke because the upsert
 *   conflicted on `user_id` while the table was keyed on (user_id, provider).
 *
 * Usage:
 *   node scripts/check-upsert-target.mjs <env-file> <table> <col,col> <notNullCol>
 */

import { readFileSync } from 'node:fs';

const [, , envFile, table, conflictCols, notNullCol] = process.argv;
if (!envFile || !table || !conflictCols || !notNullCol) {
  console.error(
    'usage: node scripts/check-upsert-target.mjs <env-file> <table> <col,col> <notNullCol>'
  );
  process.exit(2);
}

const env = {};
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const project = new URL(url).hostname.split('.')[0];

const res = await fetch(
  `${url}/rest/v1/${table}?on_conflict=${encodeURIComponent(conflictCols)}`,
  {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    // The NOT NULL column set to null: guarantees the statement aborts.
    body: JSON.stringify([{ [notNullCol]: null }]),
  }
);

const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { raw: text };
}

console.log(`project   ${project}`);
console.log(`table     ${table}`);
console.log(`conflict  (${conflictCols})`);
console.log(`http      ${res.status}`);
console.log(`code      ${body.code ?? '-'}`);
console.log(`message   ${body.message ?? body.raw ?? '-'}`);
if (body.details) console.log(`details   ${body.details}`);

console.log('');
if (body.code === '42P10' || /no unique or exclusion constraint/i.test(text)) {
  console.log(`RESULT: MISSING. There is no unique constraint on (${conflictCols}).`);
  console.log('        Any .upsert() with this onConflict target returns a 500.');
  process.exit(1);
}
if (body.code === '23502' || /violates not-null/i.test(text)) {
  console.log(`RESULT: PRESENT. The unique constraint on (${conflictCols}) exists.`);
  console.log('        Planning got past ON CONFLICT and failed on the null, as designed.');
  process.exit(0);
}
if (res.ok) {
  console.log('RESULT: UNEXPECTED — the insert SUCCEEDED. A row may have been written.');
  console.log('        Check the table and remove it.');
  process.exit(1);
}
console.log('RESULT: inconclusive. Read the error above.');
process.exit(1);
