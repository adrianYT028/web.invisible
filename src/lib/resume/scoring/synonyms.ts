// -----------------------------------------------------------------------------
// Skill aliases — one concept, many spellings
// -----------------------------------------------------------------------------
//
// Without this, keyword scoring measures whether a candidate happens to spell a
// technology the same way the job posting does. "ReactJS" vs "React.js" vs
// "React" is not a skills gap, and penalising it would make the score a test of
// coincidence.
//
// This is a curated map, and it is deliberately small and shallow. The real
// answer is a maintained taxonomy — ESCO is the standard, and the research on
// resume-to-job matching maps both sides into a shared skill space rather than
// keeping a hand-written list. That is the right destination and this is not
// pretending to be it. What this list must do is cover the aliases common enough
// that missing them would visibly mis-score an Indian student resume against a
// typical software posting.
//
// EDITING RULES:
//   - Key is the alias, value is the canonical form. Both are passed through
//     `normaliseTerm`, so write them the way a human would; '.js' suffixes and
//     punctuation are handled for you.
//   - Prefer the LONGER, unambiguous form as canonical ('machine learning', not
//     'ml') so the report shows the user a term they will recognise.
//   - Do NOT merge things that are genuinely different. 'git' is not 'github',
//     and 'java' is emphatically not 'javascript' — that particular conflation
//     would wrongly mark a Java developer as matching a frontend role.

import { normaliseTerm } from '../schema';

/**
 * alias → canonical.
 *
 * Note that `normaliseTerm` already strips a `.js` suffix, so 'react.js',
 * 'reactjs' and 'react' converge before reaching this map; entries here handle
 * only what normalisation cannot.
 */
const ALIASES: Record<string, string> = {
  // Languages
  js: 'javascript',
  ecmascript: 'javascript',
  ts: 'typescript',
  py: 'python',
  'c sharp': 'c#',
  csharp: 'c#',
  'c plus plus': 'c++',
  cpp: 'c++',
  golang: 'go',

  // Datastores
  postgres: 'postgresql',
  psql: 'postgresql',
  pg: 'postgresql',
  mongo: 'mongodb',
  'ms sql': 'sql server',
  mssql: 'sql server',
  'elastic search': 'elasticsearch',

  // Platforms and infrastructure
  k8s: 'kubernetes',
  'amazon web services': 'aws',
  'google cloud platform': 'gcp',
  'google cloud': 'gcp',
  'microsoft azure': 'azure',
  'ci cd': 'ci/cd',
  'continuous integration': 'ci/cd',
  'infrastructure as code': 'iac',

  // Concepts
  ml: 'machine learning',
  dl: 'deep learning',
  ai: 'artificial intelligence',
  nlp: 'natural language processing',
  cv: 'computer vision',
  oop: 'object oriented programming',
  'object oriented': 'object oriented programming',
  dsa: 'data structures and algorithms',
  'data structures': 'data structures and algorithms',
  'rest api': 'rest',
  restful: 'rest',
  'rest apis': 'rest',
  api: 'rest',
  tdd: 'test driven development',
  'unit testing': 'testing',
  'automated testing': 'testing',

  // Frameworks.
  //
  // Both the spaced and the run-together forms are listed. `normaliseTerm` strips
  // a DOTTED '.js' suffix, so 'React.js' already converges on 'react' — but
  // 'ReactJS' has no dot and normalises to 'reactjs', which nothing else catches.
  // Every '*JS' framework therefore needs its run-together spelling here
  // explicitly. A regex stripping a trailing 'js' is not the answer: it would
  // reduce the language 'js' itself to an empty string.
  'react js': 'react',
  reactjs: 'react',
  'react native': 'react native',
  'node js': 'node',
  nodejs: 'node',
  'next js': 'next',
  nextjs: 'next',
  'vue js': 'vue',
  vuejs: 'vue',
  'express js': 'express',
  expressjs: 'express',
  angularjs: 'angular',
  'angular js': 'angular',
  'spring boot': 'spring',
  'dot net': '.net',
  dotnet: '.net',
  'tailwind css': 'tailwind',
  'sci kit learn': 'scikit-learn',
  sklearn: 'scikit-learn',

  // Practices
  scrum: 'agile',
  kanban: 'agile',
  'version control': 'git',
};

/** Precomputed reverse index: canonical → every alias that maps to it. */
const CANONICAL_TO_ALIASES: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    const key = normaliseTerm(canonical);
    const list = map.get(key) ?? [];
    list.push(normaliseTerm(alias));
    map.set(key, list);
  }
  return map;
})();

/**
 * The canonical form of a term.
 *
 * Unknown terms pass through normalised, which is the correct default: an
 * unrecognised skill is still a skill, and dropping it would silently shrink the
 * keyword denominator and inflate the score.
 */
export function canonicalTerm(raw: string): string {
  const normalised = normaliseTerm(raw);
  return ALIASES[normalised] ? normaliseTerm(ALIASES[normalised]) : normalised;
}

/** Whether two terms name the same thing. */
export function termsMatch(a: string, b: string): boolean {
  return canonicalTerm(a) === canonicalTerm(b);
}

/**
 * Every spelling worth searching a resume for, given one term.
 *
 * Includes the canonical form and all known aliases, so a posting asking for
 * "machine learning" still matches a resume that only ever wrote "ML".
 */
export function searchVariants(raw: string): string[] {
  const canonical = canonicalTerm(raw);
  const variants = new Set<string>([canonical, normaliseTerm(raw)]);
  for (const alias of CANONICAL_TO_ALIASES.get(canonical) ?? []) {
    variants.add(alias);
  }
  return [...variants].filter((v) => v.length > 0);
}

/**
 * Characters that may form part of a technology name, and therefore may NOT act
 * as a term boundary.
 *
 * `+` and `#` are the load-bearing entries. Treating them as boundaries — which
 * `\b` and a naive "not alphanumeric" rule both do — makes 'c++' report a mention
 * of 'c', so a posting asking for C would match a resume that only knows C++.
 * They are different languages and different candidates.
 */
const TERM_CHARS = 'a-z0-9+#';

/**
 * Whether `haystack` contains `term` as a whole term.
 *
 * `haystack` must already be normalised. Boundaries use explicit lookarounds
 * rather than `\b`, because `\b` is defined against word characters and 'c++'
 * ends in a non-word character — `\bc\+\+\b` does not mean what it appears to.
 *
 * The boundary matters in both directions: a plain substring check finds 'go'
 * inside 'mongodb' and 'r' inside almost everything.
 */
export function containsTerm(haystack: string, term: string): boolean {
  if (term.length === 0) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?<![${TERM_CHARS}])${escaped}(?![${TERM_CHARS}])`
  ).test(haystack);
}

/** Whether the haystack mentions the term under any known spelling. */
export function mentionsTerm(haystack: string, term: string): boolean {
  return searchVariants(term).some((variant) => containsTerm(haystack, variant));
}
