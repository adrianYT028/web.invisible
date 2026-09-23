#!/usr/bin/env node
/**
 * Compares one table's columns between two Supabase projects, by reading the
 * OpenAPI document PostgREST publishes at the API root.
 *
 * Written because a column present in dev and absent in prod produces exactly
 * one symptom — a 500 from the route that writes it — and no amount of local
 * testing finds it. The previous production bug of this shape was an upsert whose
 * ON CONFLICT target had no matching unique constraint, which failed the same
 * silent way.
 *
 * Usage: node scripts/diff-schema.mjs <table> [<table> ...]
 */

import { readFileSync } from 'node:fs';

const tables = process.argv.slice(2);
if (tables.length === 0) {
  console.error('usage: node scripts/diff-schema.mjs <table> [<table> ...]');
  process.exit(2);
}

function loadEnv(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

async function spec(envFile) {
  const env = loadEnv(envFile);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' },
  });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return { project: new URL(url).hostname.split('.')[0], doc: await res.json() };
}

const [dev, prod] = await Promise.all([
  spec('.env.local'),
  spec('.env.local.production-backup'),
]);

console.log(`dev  = ${dev.project}`);
console.log(`prod = ${prod.project}`);

let problems = 0;

for (const table of tables) {
  const d = dev.doc.definitions?.[table];
  const p = prod.doc.definitions?.[table];

  console.log(`\n=== ${table} ===`);

  if (!d) { console.log('  MISSING IN DEV'); problems += 1; continue; }
  if (!p) { console.log('  MISSING IN PROD  <-- this is the bug'); problems += 1; continue; }

  const dCols = new Set(Object.keys(d.properties ?? {}));
  const pCols = new Set(Object.keys(p.properties ?? {}));

  const onlyDev = [...dCols].filter((c) => !pCols.has(c));
  const onlyProd = [...pCols].filter((c) => !dCols.has(c));

  if (onlyDev.length === 0 && onlyProd.length === 0) {
    console.log(`  columns match (${dCols.size})`);
  }
  for (const c of onlyDev) {
    console.log(`  IN DEV, NOT IN PROD: ${c}   <-- a write to this column 500s in prod`);
    problems += 1;
  }
  for (const c of onlyProd) {
    console.log(`  in prod, not in dev: ${c}   (dev is behind; harmless for prod)`);
  }

  // Type and nullability drift. A column that is NOT NULL in prod but nullable in
  // dev accepts a row locally and rejects the identical row in production.
  for (const c of [...dCols].filter((x) => pCols.has(x))) {
    const dp = d.properties[c];
    const pp = p.properties[c];
    if (dp.format !== pp.format) {
      console.log(`  TYPE DIFFERS on ${c}: dev=${dp.format} prod=${pp.format}`);
      problems += 1;
    }
  }

  const dReq = new Set(d.required ?? []);
  const pReq = new Set(p.required ?? []);
  for (const c of [...pReq].filter((x) => !dReq.has(x))) {
    console.log(`  REQUIRED IN PROD, OPTIONAL IN DEV: ${c}   <-- prod rejects rows dev accepts`);
    problems += 1;
  }
}

console.log(
  problems === 0
    ? '\nNo schema drift found on these tables.'
    : `\n${problems} difference(s) found.`
);
