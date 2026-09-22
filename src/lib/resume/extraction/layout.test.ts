import { describe, expect, it } from 'vitest';

import {
  assembleText,
  detectColumnLayout,
  detectTables,
  groupIntoLines,
  type TextItem,
} from './layout';

// -----------------------------------------------------------------------------
// Page geometry tests
//
// Synthetic coordinates, no PDF fixtures — the point of keeping layout inference
// pure. Page width is 612pt (US Letter) throughout, matching what pdfjs reports.
// -----------------------------------------------------------------------------

const PAGE_WIDTH = 612;

function item(str: string, x: number, y: number, width: number): TextItem {
  return { str, x, y, width };
}

/**
 * A single-column resume: everything starts at the left margin.
 * 12 lines, enough to clear the inference threshold.
 */
function singleColumn(): TextItem[] {
  return Array.from({ length: 12 }, (_, i) =>
    item(`Line ${i} of ordinary resume body text`, 72, 700 - i * 18, 260)
  );
}

/**
 * A single-column resume with right-aligned dates — the layout that a naive
 * "is there an empty middle band" check would wrongly call two-column.
 *
 * Role headers carry a date on the right; bullets underneath are left-only.
 * Crucially, NO line has right-hand content without left-hand content.
 */
function singleColumnWithRightAlignedDates(): TextItem[] {
  const items: TextItem[] = [];
  let y = 700;
  for (let role = 0; role < 3; role++) {
    items.push(item('Backend Engineering Intern, Zenpay', 72, y, 200));
    items.push(item('Jan 2024 - Jun 2024', 430, y, 110));
    y -= 18;
    for (let bullet = 0; bullet < 3; bullet++) {
      items.push(item('Did a thing that had a measurable result', 90, y, 250));
      y -= 18;
    }
  }
  return items;
}

/**
 * A genuine two-column layout: a full-width header, then two independent text
 * flows whose lines do not share baselines.
 */
function twoColumn(): TextItem[] {
  const items: TextItem[] = [
    // Full-width name across the top — must not defeat detection.
    item('AARAV SHARMA', 72, 740, 460),
  ];
  // Left flow.
  for (let i = 0; i < 8; i++) {
    items.push(item('Left column body line', 72, 700 - i * 18, 150));
  }
  // Right flow, deliberately offset so no baseline is shared with the left.
  for (let i = 0; i < 8; i++) {
    items.push(item('Right column body line', 380, 691 - i * 18, 150));
  }
  return items;
}

// -----------------------------------------------------------------------------

describe('groupIntoLines', () => {
  it('groups items sharing a baseline and orders them left to right', () => {
    const lines = groupIntoLines([
      item('second', 200, 700, 40),
      item('first', 72, 700, 40),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0].items.map((i) => i.str)).toEqual(['first', 'second']);
  });

  it('orders lines top to bottom, which is DESCENDING y in PDF space', () => {
    const lines = groupIntoLines([
      item('bottom', 72, 100, 40),
      item('top', 72, 700, 40),
    ]);

    expect(lines.map((l) => l.items[0].str)).toEqual(['top', 'bottom']);
  });

  it('tolerates a baseline shifted by a point or two', () => {
    // Superscripts and mixed font sizes nudge the baseline without starting a
    // new visual line.
    const lines = groupIntoLines([
      item('main', 72, 700, 40),
      item('nudged', 120, 698, 40),
    ]);

    expect(lines).toHaveLength(1);
  });

  it('discards whitespace-only items', () => {
    expect(groupIntoLines([item('   ', 72, 700, 5)])).toEqual([]);
  });
});

describe('assembleText', () => {
  it('inserts a space across a horizontal gap', () => {
    const lines = groupIntoLines([
      item('Aarav', 72, 700, 40),
      item('Sharma', 200, 700, 40),
    ]);

    expect(assembleText(lines)).toBe('Aarav Sharma');
  });

  it('does not double a space that is already there', () => {
    const lines = groupIntoLines([
      item('Aarav ', 72, 700, 40),
      item('Sharma', 200, 700, 40),
    ]);

    expect(assembleText(lines)).toBe('Aarav Sharma');
  });

  it('separates lines with newlines so headings stay on their own line', () => {
    // The parse-quality gate finds sections by inspecting whole short lines, so
    // losing line boundaries here would make every resume look structureless.
    const lines = groupIntoLines([
      item('EXPERIENCE', 72, 700, 80),
      item('Backend Intern', 72, 680, 80),
    ]);

    expect(assembleText(lines)).toBe('EXPERIENCE\nBackend Intern');
  });

  it('interleaves a two-column page rather than guessing a reading order', () => {
    // Deliberate. Guessing wrong would silently fabricate sentences the
    // candidate never wrote; reproducing what a parser sees lets us warn instead.
    const lines = groupIntoLines([
      item('Left text', 72, 700, 60),
      item('Right text', 380, 700, 60),
    ]);

    expect(assembleText(lines)).toBe('Left text Right text');
  });
});

describe('detectColumnLayout', () => {
  it('does not flag a single-column resume', () => {
    expect(detectColumnLayout(singleColumn(), PAGE_WIDTH)).toBe(false);
  });

  it('does NOT flag a single-column resume with right-aligned dates', () => {
    // The most important negative in this file. This layout has an empty middle
    // band and content on both sides of it, so a gutter-only check would fire
    // the product's most alarming warning at a very common, perfectly good
    // resume. What rules it out is that no line has right-hand content alone.
    expect(
      detectColumnLayout(singleColumnWithRightAlignedDates(), PAGE_WIDTH)
    ).toBe(false);
  });

  it('flags a genuine two-column layout', () => {
    expect(detectColumnLayout(twoColumn(), PAGE_WIDTH)).toBe(true);
  });

  it('is not defeated by a full-width header above the columns', () => {
    // `twoColumn` already includes a spanning name line; assert the intent
    // explicitly so a future tightening of the crossing threshold cannot
    // silently break the common real-world case.
    const items = twoColumn();
    expect(items.some((i) => i.width > PAGE_WIDTH * 0.6)).toBe(true);
    expect(detectColumnLayout(items, PAGE_WIDTH)).toBe(true);
  });

  it('declines to guess when there are too few lines', () => {
    const items = [
      item('Left', 72, 700, 100),
      item('Right', 380, 680, 100),
      item('Left', 72, 660, 100),
      item('Right', 380, 640, 100),
    ];
    expect(detectColumnLayout(items, PAGE_WIDTH)).toBe(false);
  });

  it('returns false for a nonsensical page width instead of throwing', () => {
    expect(detectColumnLayout(twoColumn(), 0)).toBe(false);
  });

  it('handles an empty page', () => {
    expect(detectColumnLayout([], PAGE_WIDTH)).toBe(false);
  });
});

describe('detectTables', () => {
  it('does not flag a single-column resume', () => {
    expect(detectTables(singleColumn())).toBe(false);
  });

  it('does not flag two recurring alignments', () => {
    // Bullet text plus a right-aligned date is two shared positions, which is
    // ordinary resume formatting and must not read as a table.
    expect(detectTables(singleColumnWithRightAlignedDates())).toBe(false);
  });

  it('flags a repeated three-cell row shape', () => {
    const items: TextItem[] = [];
    for (let row = 0; row < 6; row++) {
      const y = 700 - row * 18;
      items.push(item('Subject', 72, y, 60));
      items.push(item('Grade', 240, y, 40));
      items.push(item('Year', 400, y, 40));
    }
    // Padding so the line count clears the inference threshold via real rows.
    expect(detectTables(items)).toBe(true);
  });

  it('declines to guess when there are too few lines', () => {
    const items: TextItem[] = [];
    for (let row = 0; row < 3; row++) {
      const y = 700 - row * 18;
      items.push(item('A', 72, y, 40));
      items.push(item('B', 240, y, 40));
      items.push(item('C', 400, y, 40));
    }
    expect(detectTables(items)).toBe(false);
  });
});
