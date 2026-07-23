import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Build-lint smoke: server secrets stay server-side (task 7.9, Req 3.10).
//
// A static scan over the source tree that enforces three hard rules from the
// design (§"Trust Zones", §3.1/§3.2):
//
//   1. The crypto core (src/lib/crypto/key-vault.ts) — the only reader of the
//      Master_Key — is NOT reachable, directly or transitively, from any
//      'use client' component. Importing it into a client bundle would ship a
//      path to KEY_VAULT_SECRET to the browser.
//   2. `process.env.KEY_VAULT_SECRET` is referenced only by the crypto core
//      and the central env accessor.
//   3. `process.env.GROQ_API_KEY` is referenced only by the env accessor and
//      the Groq client module — never anywhere a client bundle could reach.
//
// This is a source-tree scan (no bundler needed), so it runs fast and catches a
// regression the moment a client component reaches for a server secret.
// -----------------------------------------------------------------------------

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_VAULT = path.join(SRC, 'lib', 'crypto', 'key-vault.ts');
const ENV_FILE = path.join(SRC, 'lib', 'env.ts');
const GROQ_DIR = path.join(SRC, 'lib', 'groq');

const norm = (p: string) => p.split(path.sep).join('/');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const ALL_FILES = listSourceFiles(SRC);

// Resolve an import specifier from a source file to an on-disk source file, or
// null for bare/external modules and unresolved paths.
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) {
    base = path.join(SRC, spec.slice(2));
  } else if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else {
    return null; // bare module (react, next, ...)
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (ALL_FILES.includes(c)) return c;
  }
  return null;
}

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[1] ?? m[2];
    const resolved = spec ? resolveImport(file, spec) : null;
    if (resolved) specs.push(resolved);
  }
  return specs;
}

function isClientFile(file: string): boolean {
  const text = readFileSync(file, 'utf8');
  // The 'use client' directive must be the first statement; checking the first
  // ~400 chars for the directive literal is sufficient and robust to a leading
  // license/comment block.
  return /(^|\n)\s*['"]use client['"]\s*;?/.test(text.slice(0, 400));
}

describe('server secrets stay server-side (static scan)', () => {
  it('key-vault.ts is not reachable from any "use client" import graph (Req 3.10)', () => {
    const clientFiles = ALL_FILES.filter(
      (f) => !/\.(test|spec)\.tsx?$/.test(f) && isClientFile(f)
    );

    const violations: string[] = [];
    for (const client of clientFiles) {
      const seen = new Set<string>();
      const stack = [client];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        if (cur === KEY_VAULT && cur !== client) {
          violations.push(`${norm(client)} -> reaches key-vault.ts`);
          break;
        }
        for (const dep of importsOf(cur)) {
          if (!seen.has(dep)) stack.push(dep);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('process.env.KEY_VAULT_SECRET is referenced only by the crypto core and env accessor', () => {
    const allowed = new Set([KEY_VAULT, ENV_FILE].map(norm));
    const offenders = ALL_FILES.filter((f) => !/\.(test|spec)\.tsx?$/.test(f))
      .filter((f) => readFileSync(f, 'utf8').includes('process.env.KEY_VAULT_SECRET'))
      .map(norm)
      .filter((f) => !allowed.has(f));

    expect(offenders).toEqual([]);
  });

  it('process.env.GROQ_API_KEY is confined to the env accessor and src/lib/groq/', () => {
    const groqDir = norm(GROQ_DIR);
    const offenders = ALL_FILES.filter((f) => !/\.(test|spec)\.tsx?$/.test(f))
      .filter((f) => readFileSync(f, 'utf8').includes('process.env.GROQ_API_KEY'))
      .map(norm)
      .filter((f) => f !== norm(ENV_FILE) && !f.startsWith(`${groqDir}/`));

    expect(offenders).toEqual([]);
  });
});
