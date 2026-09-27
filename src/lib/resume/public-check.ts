import { normaliseTerm } from '@/lib/resume/schema';
import { mentionsTerm } from '@/lib/resume/scoring/synonyms';

// -----------------------------------------------------------------------------
// Keyword gap for the free, no-login ATS checker
// -----------------------------------------------------------------------------
//
// Deterministic and AI-free on purpose: the public checker must cost nothing to
// run. It is deliberately simpler than the real match score (which uses AI to
// read the job's actual requirements) and the page says so. It answers one
// plain question: which words does this job repeat that your resume never uses?
// -----------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    'a about above after all also an and any are as at be been being both but by can could did do does ' +
    'each etc for from get had has have having he her here his how i if in into is it its just like may ' +
    'more most must no not of on one only or other our out over own per same she should so some such than ' +
    'that the their them then there these they this those through to too under until up us very was we ' +
    'well were what when where which while who why will with within without would you your ' +
    // Job-posting filler that says nothing about skills.
    'ability able apply applicant applicants apply candidate candidates company role roles job jobs team ' +
    'teams work working year years experience strong good great excellent knowledge skills skill required ' +
    'requirements preferred responsibilities responsible including include includes new using use based ' +
    'etc across looking join help opportunity position day days time full part plus benefits salary ' +
    'understanding familiarity proficiency proficient solid hands minimum least degree related field ' +
    'environment ensure support develop development build building ' +
    // Job-title words: capitalised in postings, but they are the role, not a skill.
    'data analyst analysts engineer engineers developer developers intern interns ' +
    'internship manager associate executive trainee junior senior lead specialist ' +
    'consultant designer officer assistant graduate fresher freshers hiring india'
  ).split(/\s+/)
);

/** Tech-looking tokens: node.js, c++, c#, s3, ci/cd, SQL, TypeScript. */
function looksTechnical(word: string): boolean {
  return /[+#./\d]/.test(word) || /^[A-Z]{2,}$/.test(word) || /[a-z][A-Z]/.test(word);
}

/**
 * Capitalised mid-sentence words are usually product and tool names in a job
 * post ("Python", "Tableau", "Excel", "Figma"), so they count on one mention.
 * The first word of a sentence is excluded: that capital is just grammar.
 */
function capitalisedMidSentence(jdText: string): Set<string> {
  const out = new Set<string>();
  for (const m of jdText.matchAll(/(?<![.!?:\n]\s)(?<!^)\b([A-Z][a-z]{2,}[A-Za-z]*)\b/gm)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

export interface KeywordGap {
  /** Frequent job terms the resume never mentions, most frequent first. */
  missing: string[];
  /** Frequent job terms the resume does mention. */
  matched: string[];
}

export function keywordGap(jdText: string, resumeText: string, max = 25): KeywordGap {
  const counts = new Map<string, { display: string; n: number; technical: boolean }>();
  const words = jdText.match(/[A-Za-z][A-Za-z0-9+#./-]*[A-Za-z0-9+#]|[A-Za-z]/g) ?? [];
  const namesTools = capitalisedMidSentence(jdText);

  for (const raw of words) {
    const word = raw.replace(/[./-]+$/, '');
    const key = word.toLowerCase();
    if (key.length < 2 || STOPWORDS.has(key)) continue;
    const technical = looksTechnical(word) || namesTools.has(key);
    // Plain short words are too generic to be useful unless they look technical.
    if (!technical && key.length < 4) continue;
    const entry = counts.get(key) ?? { display: word, n: 0, technical };
    entry.n += 1;
    entry.technical = entry.technical || technical;
    counts.set(key, entry);
  }

  const terms = [...counts.values()]
    // A technical term matters on one mention; a plain word must repeat.
    .filter((t) => t.technical || t.n >= 2)
    .sort((a, b) => Number(b.technical) - Number(a.technical) || b.n - a.n)
    .slice(0, max);

  // `mentionsTerm` expects a normalised haystack (see containsTerm in synonyms.ts).
  const haystack = normaliseTerm(resumeText);
  const missing: string[] = [];
  const matched: string[] = [];
  for (const t of terms) {
    (mentionsTerm(haystack, t.display) ? matched : missing).push(t.display);
  }
  return { missing, matched };
}
