#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Funnel report — how many people did each step, last 7 and 30 days.
//
//   node scripts/funnel-report.mjs                 # uses .env.local
//   node scripts/funnel-report.mjs .env.production # any env file
//
// Reads `funnel_events` (migration 023) with the service-role key. Prints counts
// of events and of distinct users per event. Nothing personal is printed.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const envFile = process.argv[2] ?? '.env.local';
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);

const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(`Missing Supabase URL or service-role key in ${envFile}`);
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

// The order people move through the product.
const STEPS = [
  'signup',
  'resume_uploaded',
  'resume_scanned',
  'job_saved',
  'extension_connected',
  'interview_started',
  'linkedin_generated',
  'resume_exported',
  'checkout_started',
  'payment_captured',
];

async function fetchSince(days) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('funnel_events')
      .select('event, user_id, props')
      .gte('created_at', since)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

function summarise(rows) {
  const out = new Map();
  for (const r of rows) {
    const s = out.get(r.event) ?? { events: 0, users: new Set(), payments: new Set() };
    s.events += 1;
    if (r.user_id) s.users.add(r.user_id);
    if (r.event === 'payment_captured' && r.props?.payment_id) s.payments.add(r.props.payment_id);
    out.set(r.event, s);
  }
  return out;
}

const [week, month] = await Promise.all([fetchSince(7), fetchSince(30)]);
const w = summarise(week);
const m = summarise(month);

const pad = (v, n) => String(v).padEnd(n);
console.log(`\nFunnel (${envFile})\n`);
console.log(pad('step', 22), pad('7d users', 10), pad('7d events', 11), pad('30d users', 11), '30d events');
for (const step of [...STEPS, ...[...m.keys()].filter((k) => !STEPS.includes(k))]) {
  const a = w.get(step);
  const b = m.get(step);
  const events = (s) => (s ? (step === 'payment_captured' ? s.payments.size : s.events) : 0);
  console.log(pad(step, 22), pad(a?.users.size ?? 0, 10), pad(events(a), 11), pad(b?.users.size ?? 0, 11), events(b));
}
const extSaves = month.filter((r) => r.event === 'job_saved' && r.props?.source === 'extension').length;
console.log(`\nJobs saved from the extension (30d): ${extSaves}\n`);
