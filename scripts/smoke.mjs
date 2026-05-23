// Smoke test for the production build (task 9.2 / 6.11).
// Probes every public route and prints the HTTP status. Exits non-zero on any non-200/non-redirect.

const routes = [
  '/',
  '/downloads',
  '/feedback',
  '/guides/setup',
  '/guides/usage',
  '/login',
  '/login/reset',
  '/account', // unauthed → expects a 307/308 redirect to /login?redirectedFrom=%2Faccount
];

const base = 'http://localhost:3000';
const acceptable = new Set([200, 301, 302, 307, 308]);
let failed = 0;

for (const route of routes) {
  const t0 = Date.now();
  try {
    const res = await fetch(base + route, { redirect: 'manual' });
    const ms = Date.now() - t0;
    const ok = acceptable.has(res.status);
    const status = ok ? 'OK' : 'FAIL';
    const loc = res.headers.get('location') ?? '';
    console.log(`${status.padEnd(4)} ${String(res.status).padEnd(4)} ${String(ms).padStart(5)}ms  ${route}${loc ? `  → ${loc}` : ''}`);
    if (!ok) failed++;
  } catch (err) {
    console.log(`FAIL  ERR  ?ms  ${route}  ${err.message}`);
    failed++;
  }
}

if (failed) {
  console.log(`\n${failed} route(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll routes responded with an acceptable status code.');
}
