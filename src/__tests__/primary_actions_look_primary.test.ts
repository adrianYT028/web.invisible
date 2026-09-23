import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// -----------------------------------------------------------------------------
// The action that moves a user forward must not be a ghost button
// -----------------------------------------------------------------------------
//
// This exact mistake shipped three separate times:
//
//   /pricing            the BUY button was `cta-secondary`, so the single most
//                       important control on the page rendered as the quietest
//                       thing on it.
//   /resume             "Save to tracker" was `cta-secondary` and sat below the
//                       whole score breakdown. It is the ONLY way a role reaches
//                       the tracker. Production showed an account with three scans
//                       in one day and zero tracked jobs — three attempts, three
//                       misses — and the tracker was reported as broken when
//                       nothing was broken at all.
//   /account            "Save" and "Cancel" on the key form were both
//                       `cta-secondary`, so completing the task looked identical to
//                       abandoning it.
//
// Each was found by a user rather than by us, because nothing in the codebase had
// an opinion about it. This test gives it one.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES AND DOES NOT CLAIM
//
// It does NOT try to decide which buttons deserve to be primary — that is a
// judgement, and a heuristic would either miss cases or fire on correct ones like
// "Cancel", "Log out" or "Export CSV", which are RIGHTLY secondary.
//
// It asserts a hand-curated list: for each entry, the control carrying that label
// must be `cta-primary`. Adding a new forward action means adding a line here,
// which is the point — it forces the question to be asked once, deliberately,
// instead of being answered by accident.
//
// Asserted against the SOURCE rather than a render, because the failure is a class
// name on an element that renders perfectly well either way. There is no runtime
// behaviour to observe.
// -----------------------------------------------------------------------------

interface ForwardAction {
  file: string;
  /** Text appearing inside the control. */
  label: string;
  /** Why this one has to be prominent. */
  because: string;
}

const FORWARD_ACTIONS: ForwardAction[] = [
  {
    file: 'src/app/resume/ResumeAnalyser.tsx',
    label: 'Save to tracker',
    because: 'the only way a scanned role reaches /jobs',
  },
  {
    file: 'src/app/resume/ResumeAnalyser.tsx',
    label: 'Check the match',
    because: 'runs the scan, which is the point of the page',
  },
  {
    file: 'src/app/account/ApiKeyManager.tsx',
    label: "{isBusy ? 'Saving\\u2026' : 'Save'}",
    because: 'stores the key; was indistinguishable from Cancel',
  },
  {
    file: 'src/app/account/page.tsx',
    label: 'Your services',
    because: 'goes to use the product; was level with Log out',
  },
  {
    file: 'src/components/sections/ServicesOverview.tsx',
    label: 'See pricing',
    because: 'the conversion path out of the section',
  },
  {
    file: 'src/app/auth/desktop/RedirectToDesktop.tsx',
    label: 'Open Unviewable Desktop',
    because: 'the sole control on the page, shown only after auto hand-off failed',
  },
  {
    file: 'src/components/sections/ServicePaywall.tsx',
    label: 'See what full access includes',
    because: 'the way past the paywall',
  },
];

/**
 * Remove comments before searching.
 *
 * Not defensive tidying — the first version of this test failed on `/account`
 * because the explanatory comment ABOVE the button also contains the words "Your
 * services", `indexOf` matched the comment, and the nearest preceding className was
 * a `lede` paragraph. A guard that can be defeated by writing prose about it is
 * worse than none.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every className that encloses an occurrence of `label`.
 *
 * ALL occurrences, not the first. A label legitimately appears more than once — a
 * heading and a button, or two branches of a ternary — and picking one arbitrarily
 * makes the result depend on source order.
 *
 * Walks backwards from each occurrence to the nearest `className="..."`. Elements
 * open before their children, so that className belongs to the enclosing element,
 * or to an ancestor when the control itself carries none — in which case the
 * assertion fails, correctly.
 */
function classNamesEnclosing(source: string, label: string): string[] {
  const clean = stripComments(source);
  const found: string[] = [];
  let from = 0;

  for (;;) {
    const at = clean.indexOf(label, from);
    if (at === -1) break;
    const matches = [...clean.slice(0, at).matchAll(/className="([^"]*)"/g)];
    const last = matches.at(-1);
    if (last) found.push(last[1]);
    from = at + label.length;
  }
  return found;
}

describe('the forward action on each surface is styled as primary', () => {
  for (const action of FORWARD_ACTIONS) {
    it(`${action.file.replace('src/', '')} — "${action.label}"`, () => {
      const source = readFileSync(action.file, 'utf8');

      // A missing label means the control was renamed or removed. Failing here is
      // correct: the entry has to be revisited rather than silently skipped, which
      // is how a guard quietly stops guarding.
      expect(
        source.includes(action.label),
        `"${action.label}" not found in ${action.file}. If it was renamed, update this test.`
      ).toBe(true);

      const classNames = classNamesEnclosing(source, action.label);
      expect(
        classNames.length,
        `no className found enclosing "${action.label}" in ${action.file}`
      ).toBeGreaterThan(0);

      // ANY occurrence being primary is enough: the label may also appear as a
      // heading or in the other branch of a ternary, and only the control matters.
      expect(
        classNames.some((c) => c.includes('cta-primary')),
        `"${action.label}" is ${action.because}, so its control must be cta-primary. ` +
          `Found enclosing classNames: ${classNames.map((c) => `"${c}"`).join(', ')}.`
      ).toBe(true);
    });
  }
});

describe('controls that are RIGHTLY secondary stay secondary', () => {
  // The other half of the rule. Promoting everything is the same failure as
  // promoting nothing: if every control is loud, none of them is.
  const SECONDARY: ForwardAction[] = [
    {
      file: 'src/app/jobs/JobTracker.tsx',
      label: 'Export CSV',
      because: 'an alternative output, not the next step',
    },
    {
      file: 'src/app/account/LogoutButton.tsx',
      label: 'cta cta-secondary',
      because: 'leaving is never the action we are encouraging',
    },
  ];

  for (const action of SECONDARY) {
    it(`${action.file.replace('src/', '')} — "${action.label}"`, () => {
      const source = readFileSync(action.file, 'utf8');
      expect(source.includes(action.label)).toBe(true);
      const classNames = classNamesEnclosing(source, action.label);
      const enclosing = classNames.length > 0 ? classNames : [action.label];
      expect(
        enclosing.some((c) => c.includes('cta-primary')),
        `"${action.label}" is ${action.because} and should stay secondary. ` +
          `Found: ${enclosing.map((c) => `"${c}"`).join(', ')}.`
      ).toBe(false);
    });
  }
});
