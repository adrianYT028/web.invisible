// Regenerates dev-schema.sql from supabase/migrations/*.sql.
//
// Run from the project root:  node supabase/setup/build-dev-schema.mjs
//
// The output is a single transaction. On a FRESH project that is strictly safer
// than pasting 18 files one at a time: if any statement fails, the whole thing
// rolls back and you are left with an empty database rather than a half-built
// schema that later migrations then fail against in confusing ways.
//
// Regenerate this whenever a migration is added, so the dev-setup path cannot
// drift from the real migration history.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'supabase/migrations';
const OUT = 'supabase/setup/dev-schema.sql';

const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort(); // numeric prefixes make lexical sort correct

const parts = [
  `-- GENERATED FILE — do not edit by hand.`,
  `-- Source: ${DIR}/*.sql   Regenerate: node supabase/setup/build-dev-schema.mjs`,
  `-- Generated: ${new Date().toISOString().slice(0, 10)}`,
  `--`,
  `-- Every migration, in order, as one transaction. Paste into the Supabase SQL`,
  `-- Editor of a NEW, EMPTY project and run once.`,
  `--`,
  `-- This does NOT create the two Storage buckets. Those cannot be made from SQL`,
  `-- and are step 4 of supabase/setup/README.md. Uploads fail without them.`,
  ``,
  `begin;`,
  ``,
];

for (const name of files) {
  const sql = readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n');
  parts.push(
    `-- ${'='.repeat(74)}`,
    `-- ${name}`,
    `-- ${'='.repeat(74)}`,
    ``,
    sql.trimEnd(),
    ``,
    ``
  );
}

parts.push(`commit;`, ``);

const out = parts.join('\n');
writeFileSync(OUT, out, 'utf8');

console.log(`wrote ${OUT}`);
console.log(`  migrations: ${files.length}`);
console.log(`  size:       ${(out.length / 1024).toFixed(1)} KB`);
console.log(`  order:      ${files.join(', ')}`);
