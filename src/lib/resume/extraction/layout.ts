// -----------------------------------------------------------------------------
// Page geometry — pure layout analysis, no PDF library
// -----------------------------------------------------------------------------
//
// A PDF does not record words, lines, paragraphs, or reading order. It records
// glyphs and the position each one is drawn at. Everything structural about a
// page — that these glyphs form a line, that those two lines belong to different
// columns — has to be inferred from coordinates.
//
// This module does that inference on plain `{ str, x, y, width }` records, which
// keeps it unit-testable from synthetic fixtures with no PDF in the import graph.
// `pdf.ts` is then a thin shell that reads pdfjs and hands the geometry here.

/** One positioned text run. `x`/`y` are PDF user-space, origin bottom-left. */
export interface TextItem {
  str: string;
  /** Left edge. */
  x: number;
  /** Baseline. Larger y is HIGHER on the page. */
  y: number;
  width: number;
}

/** Items sharing a baseline, ordered left to right. */
export interface TextLine {
  /** Representative baseline for the line. */
  y: number;
  items: TextItem[];
}

/**
 * Baselines within this many points count as the same line. Superscripts and
 * subtly different font sizes shift a baseline by a point or two without
 * starting a new visual line.
 */
const LINE_TOLERANCE_PT = 3;

/** x positions within this many points count as the same alignment column. */
const ALIGN_TOLERANCE_PT = 6;

/**
 * Below this many lines, COLUMN inference is guesswork. Distinguishing two
 * independent text flows from a right-aligned date needs enough lines for the
 * exclusive-line ratios below to mean anything.
 */
const MIN_LINES_FOR_COLUMNS = 8;

/**
 * Minimum repeated rows before a table is called.
 *
 * Lower than the column threshold on purpose. Table evidence is self-limiting —
 * it already requires three alignment positions each recurring across four
 * separate lines — so a total-line floor adds nothing except missing genuine
 * five-row tables, which are common on student resumes listing subjects and
 * grades. Used both as the guard and as the row count, so the two cannot drift
 * apart.
 */
const MIN_TABLE_ROWS = 4;

/**
 * Group positioned items into visual lines, top to bottom.
 *
 * Within a line, items are sorted by x. Between lines, larger y comes first
 * because PDF user space puts the origin at the bottom of the page.
 */
export function groupIntoLines(items: TextItem[]): TextLine[] {
  const meaningful = items.filter((item) => item.str.trim().length > 0);
  if (meaningful.length === 0) return [];

  const byYDescending = [...meaningful].sort((a, b) => b.y - a.y);
  const lines: TextLine[] = [];

  for (const item of byYDescending) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(current.y - item.y) <= LINE_TOLERANCE_PT) {
      current.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }

  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

/**
 * Assemble text in best-effort reading order: lines top to bottom, items left to
 * right within each line.
 *
 * For a single-column page this is the true reading order. For a two-column page
 * it interleaves the columns — which is precisely the damage the column warning
 * tells the user about. That is deliberate: silently guessing a column order
 * would hide a real defect and produce a resume the candidate never wrote, and a
 * wrong guess reads as authoritative. Better to reproduce what a parser actually
 * sees and say so.
 */
export function assembleText(lines: TextLine[]): string {
  return lines
    .map((line) => {
      let out = '';
      let previousEnd: number | null = null;
      for (const item of line.items) {
        // Insert a space when there is a real horizontal gap and the adjacent
        // characters would otherwise be glued into one token.
        if (
          previousEnd !== null &&
          item.x - previousEnd > 1 &&
          !out.endsWith(' ') &&
          !item.str.startsWith(' ')
        ) {
          out += ' ';
        }
        out += item.str;
        previousEnd = item.x + item.width;
      }
      return out.trimEnd();
    })
    .join('\n');
}

/**
 * Whether the page appears to use a multi-column layout.
 *
 * Looks for a vertical gutter: a band of x positions that almost no text crosses,
 * with substantial independent content on both sides.
 *
 * THE HARD CASE, and the reason this is not just "is there an empty band":
 *
 *   Backend Engineering Intern                        Jan 2024 - Jun 2024
 *
 * A single-column resume with right-aligned dates also has an empty middle band
 * and content on both sides of it. Treating that as two columns would fire the
 * most alarming warning in the product at a large share of perfectly good
 * resumes.
 *
 * The discriminator is EXCLUSIVE lines. In a genuine two-column layout each side
 * is an independent text flow, so many lines have content on one side only. With
 * right-aligned dates, every right-hand item shares its line with left-hand
 * text, so right-exclusive lines are close to zero.
 *
 * A full-width header above the columns is handled by the crossing tolerance:
 * one or two spanning lines out of many stays under the threshold.
 */
export function detectColumnLayout(
  items: TextItem[],
  pageWidth: number
): boolean {
  if (pageWidth <= 0) return false;
  const lines = groupIntoLines(items);
  if (lines.length < MIN_LINES_FOR_COLUMNS) return false;

  // Candidate gutters live in the middle of the page. A split at 10% or 90%
  // separates a margin, not a column.
  const from = pageWidth * 0.25;
  const to = pageWidth * 0.75;
  const step = Math.max(pageWidth * 0.02, 1);

  for (let split = from; split <= to; split += step) {
    let crossing = 0;
    let leftOnly = 0;
    let rightOnly = 0;

    for (const line of lines) {
      let spans = false;
      let hasLeft = false;
      let hasRight = false;

      for (const item of line.items) {
        const start = item.x;
        const end = item.x + item.width;
        if (start < split && end > split) {
          spans = true;
          break;
        }
        if (end <= split) hasLeft = true;
        else hasRight = true;
      }

      if (spans) crossing++;
      else if (hasLeft && !hasRight) leftOnly++;
      else if (hasRight && !hasLeft) rightOnly++;
    }

    const crossingFraction = crossing / lines.length;
    const rightOnlyFraction = rightOnly / lines.length;

    if (
      crossingFraction <= 0.15 &&
      // Both sides must be independent flows, not one side plus annotations.
      leftOnly >= 3 &&
      rightOnly >= 3 &&
      rightOnlyFraction >= 0.15
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Whether the page appears to contain a table.
 *
 * Deliberately conservative. Detecting tables from glyph positions alone is
 * unreliable — ruling lines are drawn as unrelated vector operations, and a
 * resume's ordinary two-tab layout is geometrically similar to a two-column
 * table. Since the payoff is a warning rather than a correction, under-reporting
 * is the right failure mode: a spurious "your tables are breaking parsing" on a
 * clean resume costs more trust than a missed genuine one.
 *
 * So the bar is a repeated ROW shape: several lines that each carry items at
 * three or more shared alignment positions. Two shared positions are normal
 * (bullet text plus a right-aligned date) and are not enough.
 */
export function detectTables(items: TextItem[]): boolean {
  const lines = groupIntoLines(items);
  if (lines.length < MIN_TABLE_ROWS) return false;

  // Alignment positions that recur across at least four different lines.
  const bucketLineCounts = new Map<number, Set<number>>();
  for (const [lineIndex, line] of lines.entries()) {
    for (const item of line.items) {
      const bucket = Math.round(item.x / ALIGN_TOLERANCE_PT);
      const set = bucketLineCounts.get(bucket) ?? new Set<number>();
      set.add(lineIndex);
      bucketLineCounts.set(bucket, set);
    }
  }

  const recurring = new Set(
    [...bucketLineCounts.entries()]
      .filter(([, lineIndexes]) => lineIndexes.size >= MIN_TABLE_ROWS)
      .map(([bucket]) => bucket)
  );
  if (recurring.size < 3) return false;

  // How many lines look like a row with three or more populated cells.
  let rowLike = 0;
  for (const line of lines) {
    const bucketsOnLine = new Set(
      line.items
        .map((item) => Math.round(item.x / ALIGN_TOLERANCE_PT))
        .filter((bucket) => recurring.has(bucket))
    );
    if (bucketsOnLine.size >= 3) rowLike++;
  }

  return rowLike >= MIN_TABLE_ROWS;
}
