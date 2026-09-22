import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  FAILURE_REASONS,
  numbered,
  outcomeLabel,
  prepCsvFilename,
  prepRunToCsv,
  type ExportablePrepItem,
} from './prep-csv';

// -----------------------------------------------------------------------------
// Prep-run CSV export
//
// The serialiser is a pure function, so every case here is a plain object — no
// database, no fixtures. What is actually being defended:
//
//   1. A tailored bullet is NEVER emitted without a reason beside it. That is the
//      last human check against a rewrite that overstates scope, which the
//      mechanical verifier explicitly cannot catch.
//   2. `resume_scans.report` is untrusted jsonb and must not be able to put the
//      string "undefined" into a cell someone pastes into a job application.
//   3. Formula injection, because every field here comes from a third-party job
//      board or a language model.
// -----------------------------------------------------------------------------

function item(overrides: Partial<ExportablePrepItem> = {}): ExportablePrepItem {
  return {
    status: 'done',
    error: null,
    match_score: 74,
    email_subject: 'Backend intern application',
    email_body: 'Hello,\n\nI saw the opening.',
    contact_hint: 'careers@zenpay.example',
    completed_at: '2026-08-25T09:30:00.000Z',
    job_postings: {
      title: 'Backend Engineering Intern',
      location: 'Bengaluru',
      is_remote: false,
      url: 'https://jobs.example/zenpay/backend-intern',
      job_companies: { name: 'Zenpay Technologies' },
    },
    resume_scans: { report: {} },
    ...overrides,
  };
}

function rewrite(overrides: Record<string, unknown> = {}) {
  return {
    sourceBulletId: 'b1',
    original: 'Responsible for the reconciliation job',
    rewritten: 'Rebuilt the payment reconciliation job in Python',
    rationale: 'Leads with the action and names the language.',
    addedNoNewFacts: true,
    ...overrides,
  };
}

/** Split a CSV document into rows of cells, honouring quoted newlines. */
function parseCsv(csv: string): string[][] {
  const body = csv.startsWith('\uFEFF') ? csv.slice(1) : csv;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function cellsByHeader(csv: string, rowIndex = 1): Record<string, string> {
  const rows = parseCsv(csv);
  const header = rows[0];
  const row = rows[rowIndex] ?? [];
  const out: Record<string, string> = {};
  header.forEach((name, i) => {
    out[name] = row[i] ?? '';
  });
  return out;
}

// -----------------------------------------------------------------------------

describe('prepRunToCsv — structure', () => {
  it('emits a header even for a run with no items', () => {
    const rows = parseCsv(prepRunToCsv([]));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('Company');
    expect(rows[0]).toContain('Tailored bullet');
    expect(rows[0]).toContain('Why the change');
  });

  it('writes one row per job, not one per rewritten bullet', () => {
    const csv = prepRunToCsv([
      item({
        resume_scans: {
          report: {
            rewrite: [
              rewrite(),
              rewrite({ sourceBulletId: 'b2', original: 'Wrote tests', rewritten: 'Wrote integration tests for the refund path' }),
              rewrite({ sourceBulletId: 'b3', original: 'Fixed latency', rewritten: 'Cut median API latency' }),
            ],
          },
        },
      }),
    ]);

    // Header + exactly one data row, despite three rewrites.
    expect(parseCsv(csv)).toHaveLength(2);
  });

  it('keeps every cell aligned with the header', () => {
    const rows = parseCsv(prepRunToCsv([item(), item()]));

    for (const row of rows) expect(row).toHaveLength(rows[0].length);
  });

  it('carries the fields the user asked for', () => {
    const cells = cellsByHeader(prepRunToCsv([item()]));

    expect(cells['Company']).toBe('Zenpay Technologies');
    expect(cells['Role']).toBe('Backend Engineering Intern');
    expect(cells['Link']).toBe('https://jobs.example/zenpay/backend-intern');
    expect(cells['Match score']).toBe('74');
    expect(cells['Prepared on']).toBe('2026-08-25');
  });

  it('is Excel-safe: BOM and CRLF', () => {
    const csv = prepRunToCsv([item()]);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('\r\n');
  });
});

describe('prepRunToCsv — the rewrite columns', () => {
  it('pairs each tailored bullet with its reason, numbered to match', () => {
    const cells = cellsByHeader(
      prepRunToCsv([
        item({
          resume_scans: {
            report: {
              rewrite: [
                rewrite({ original: 'Did A', rewritten: 'Shipped A', rationale: 'Stronger verb.' }),
                rewrite({ original: 'Did B', rewritten: 'Shipped B', rationale: 'Names the outcome.' }),
              ],
            },
          },
        }),
      ])
    );

    expect(cells['Original bullet']).toBe('1. Did A\n2. Did B');
    expect(cells['Tailored bullet']).toBe('1. Shipped A\n2. Shipped B');
    expect(cells['Why the change']).toBe('1. Stronger verb.\n2. Names the outcome.');
  });

  it('does not number a lone bullet', () => {
    const cells = cellsByHeader(
      prepRunToCsv([
        item({ resume_scans: { report: { rewrite: [rewrite()] } } }),
      ])
    );

    expect(cells['Tailored bullet']).toBe(
      'Rebuilt the payment reconciliation job in Python'
    );
  });

  // THE INVARIANT THIS FILE EXISTS FOR. A rewritten bullet in a spreadsheet with
  // no reason next to it is a suggestion with no check on it, at the exact moment
  // the user is about to paste it into an application.
  it('NEVER emits a tailored bullet without a reason', () => {
    const cases: unknown[] = [
      [rewrite({ rationale: '' })],
      [rewrite({ rationale: '   ' })],
      [rewrite({ rationale: null })],
      [rewrite({ rationale: undefined })],
      [rewrite({ rationale: 42 })],
      [rewrite(), rewrite({ sourceBulletId: 'b2', original: 'Did B', rewritten: 'Shipped B', rationale: '' })],
    ];

    for (const rewrites of cases) {
      const cells = cellsByHeader(
        prepRunToCsv([item({ resume_scans: { report: { rewrite: rewrites } } })])
      );

      const tailored = cells['Tailored bullet'];
      const why = cells['Why the change'];
      expect(tailored.length).toBeGreaterThan(0);
      // Same number of entries on both sides, and no entry is blank.
      const tailoredLines = tailored.split('\n');
      const whyLines = why.split('\n');
      expect(whyLines).toHaveLength(tailoredLines.length);
      for (const line of whyLines) expect(line.trim().length).toBeGreaterThan(0);
    }
  });

  it('says so explicitly when no reason was recorded', () => {
    const cells = cellsByHeader(
      prepRunToCsv([
        item({ resume_scans: { report: { rewrite: [rewrite({ rationale: '' })] } } }),
      ])
    );

    expect(cells['Why the change']).toMatch(/no reason was recorded/i);
    expect(cells['Why the change']).toMatch(/check it against your own record/i);
  });

  // `addedNoNewFacts: false` is the model admitting it added something, on a
  // suggestion the mechanical verifier passed anyway. The two disagree, so the
  // human is told which one to look at.
  it('flags a rewrite the model would not vouch for', () => {
    const cells = cellsByHeader(
      prepRunToCsv([
        item({
          resume_scans: {
            report: { rewrite: [rewrite({ addedNoNewFacts: false })] },
          },
        }),
      ])
    );

    expect(cells['Why the change']).toContain('[CHECK THIS ONE]');
    // The original reason survives the flag rather than being replaced by it.
    expect(cells['Why the change']).toContain('Leads with the action');
  });

  it('does not flag a rewrite the model vouched for', () => {
    const cells = cellsByHeader(
      prepRunToCsv([
        item({ resume_scans: { report: { rewrite: [rewrite()] } } }),
      ])
    );

    expect(cells['Why the change']).not.toContain('[CHECK THIS ONE]');
  });

  it('exports the genuine gaps, which are the honest counterpart to a rewrite', () => {
    const cells = cellsByHeader(
      prepRunToCsv([
        item({
          resume_scans: {
            report: { genuineGaps: ['No Kubernetes experience', 'No Go'] },
          },
        }),
      ])
    );

    expect(cells['Gaps to close']).toBe('1. No Kubernetes experience\n2. No Go');
  });
});

describe('prepRunToCsv — untrusted jsonb', () => {
  // Every one of these shapes is reachable: `report` is `jsonb not null default
  // '{}'`, and rows written by earlier schema versions are still in the table.
  it('survives a report that is missing, empty, or the wrong type', () => {
    const reports: unknown[] = [
      undefined,
      null,
      {},
      { rewrite: null },
      { rewrite: 'not an array' },
      { rewrite: [] },
      { rewrite: [null, 3, 'text', []] },
      { rewrite: [{}] },
      { genuineGaps: 'not an array' },
      { genuineGaps: [null, 7, {}] },
      [],
      'a string report',
      42,
    ];

    for (const report of reports) {
      const csv = prepRunToCsv([item({ resume_scans: { report } })]);
      const cells = cellsByHeader(csv);

      expect(cells['Tailored bullet']).toBe('');
      expect(cells['Why the change']).toBe('');
      expect(csv).not.toContain('undefined');
      expect(csv).not.toContain('[object Object]');
      // The row is still a row: the job facts survive a useless report.
      expect(cells['Company']).toBe('Zenpay Technologies');
    }
  });

  it('drops a rewrite that has no original to compare against', () => {
    const cells = cellsByHeader(
      prepRunToCsv([
        item({
          resume_scans: {
            report: {
              rewrite: [
                rewrite({ original: '' }),
                rewrite({ rewritten: '' }),
                rewrite({ original: 'Did A', rewritten: 'Shipped A' }),
              ],
            },
          },
        }),
      ])
    );

    // Only the complete pair survives, and it is therefore unnumbered.
    expect(cells['Original bullet']).toBe('Did A');
    expect(cells['Tailored bullet']).toBe('Shipped A');
  });

  it('survives a missing posting and a null scan', () => {
    const cells = cellsByHeader(
      prepRunToCsv([
        item({ job_postings: null, resume_scans: null, match_score: null }),
      ])
    );

    expect(cells['Company']).toBe('');
    expect(cells['Link']).toBe('');
    expect(cells['Match score']).toBe('');
    expect(cells['Remote']).toBe('No');
  });
});

describe('prepRunToCsv — outcomes', () => {
  it('keeps failed and skipped items as rows, with a readable reason', () => {
    const csv = prepRunToCsv([
      item(),
      item({ status: 'skipped', error: 'no_description', match_score: null }),
      item({ status: 'failed', error: 'parse_quality_too_low', match_score: null }),
    ]);

    const rows = parseCsv(csv);
    expect(rows).toHaveLength(4);
    expect(cellsByHeader(csv, 1)['Outcome']).toBe('Ready');
    expect(cellsByHeader(csv, 2)['Outcome']).toMatch(/no job description/i);
    expect(cellsByHeader(csv, 3)['Outcome']).toMatch(/could not be read/i);
  });

  it('names an unmapped error rather than collapsing it to "failed"', () => {
    expect(outcomeLabel('failed', 'weird_provider_code')).toContain(
      'weird_provider_code'
    );
  });

  // DRIFT GUARD. The first live export of real data rendered "Failed — truncated",
  // a raw provider code, because AiExtractionError's union had grown past the
  // translation map. Asserting the map by hand would have missed it the same way,
  // so the expected set is re-derived from the source instead.
  it('translates every error code the pipeline can actually write', () => {
    const prepSource = readFileSync('src/lib/jobs/prep.ts', 'utf8');
    const clientSource = readFileSync('src/lib/resume/ai/client.ts', 'utf8');

    // `prepareItem` assigns `err.code` straight through for an AiExtractionError,
    // so every member of that union can reach prep_items.error.
    const union = /readonly code:\s*((?:\s*\|\s*'[a-z_]+')+)/.exec(clientSource);
    expect(union, 'AiExtractionError code union not found').not.toBeNull();
    const aiCodes = [...union![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(aiCodes.length).toBeGreaterThan(3);

    // Literal codes written to the error column by the prep pipeline itself.
    const literal = [...prepSource.matchAll(/error:\s*'([a-z_]+)'/g)].map(
      (m) => m[1]
    );
    const gate = /ParseGateError\s*\?\s*'([a-z_]+)'/.exec(prepSource)?.[1];
    const fallback = /:\s*'(internal_error)';/.exec(prepSource)?.[1];

    // Codes that never reach an ITEM: startPrepRun returns these to the caller
    // instead of writing them to prep_items.error.
    const runLevelOnly = new Set(['no_resume', 'no_postings']);

    const expected = [
      ...aiCodes,
      ...literal,
      ...(gate ? [gate] : []),
      ...(fallback ? [fallback] : []),
    ].filter((code) => !runLevelOnly.has(code));

    const unmapped = [...new Set(expected)].filter(
      (code) => !(code in FAILURE_REASONS)
    );
    expect(unmapped, `unmapped error codes: ${unmapped.join(', ')}`).toEqual([]);

    // And every mapped code reads as advice rather than as an identifier.
    for (const [code, text] of Object.entries(FAILURE_REASONS)) {
      expect(text, code).toMatch(/^(Failed|Skipped) — [a-z]/);
      expect(text, code).not.toContain('_');
    }
  });

  it('truncates an unmapped error, which is written by a provider', () => {
    const label = outcomeLabel('failed', 'x'.repeat(500));

    expect(label.length).toBeLessThan(120);
  });

  it('reports an unfinished item honestly instead of guessing', () => {
    expect(outcomeLabel('queued', null)).toBe('Queued');
    expect(outcomeLabel('running', null)).toBe('Running');
  });
});

describe('prepRunToCsv — contact split', () => {
  it('puts a real address in "Email to"', () => {
    const cells = cellsByHeader(
      prepRunToCsv([item({ contact_hint: 'careers@zenpay.example' })])
    );

    expect(cells['Email to']).toBe('careers@zenpay.example');
    expect(cells['Contact notes']).toBe('');
  });

  // `contact_hint` holds guidance prose when the posting published no address.
  // Putting that in an "Email to" column would produce a mail merge to nothing.
  it('puts guidance prose in "Contact notes", not in "Email to"', () => {
    const cells = cellsByHeader(
      prepRunToCsv([
        item({ contact_hint: 'Apply through the form on their careers page' }),
      ])
    );

    expect(cells['Email to']).toBe('');
    expect(cells['Contact notes']).toMatch(/careers page/);
  });

  it('leaves both blank when the posting named nobody', () => {
    const cells = cellsByHeader(prepRunToCsv([item({ contact_hint: null })]));

    expect(cells['Email to']).toBe('');
    expect(cells['Contact notes']).toBe('');
  });
});

describe('prepRunToCsv — spreadsheet safety', () => {
  // Every field here is authored by a job board or a language model, so a cell
  // beginning with `=` is a live formula in the user's own spreadsheet.
  it('neutralises formulas in job-board and model text', () => {
    const csv = prepRunToCsv([
      item({
        job_postings: {
          title: '=HYPERLINK("http://evil/","Click")',
          location: '@SUM(A1)',
          is_remote: true,
          url: 'https://jobs.example/x',
          job_companies: { name: '+1234' },
        },
        email_subject: '-lead',
        resume_scans: {
          report: { rewrite: [rewrite({ rewritten: '=cmd|calc' })] },
        },
      }),
    ]);

    expect(csv).not.toContain('"=HYPERLINK');
    expect(csv).not.toContain('"@SUM');
    expect(csv).not.toContain('"+1234');
    expect(csv).not.toContain('"-lead');
    expect(csv).not.toContain('"=cmd');

    // Still readable once the guard apostrophe is consumed by the spreadsheet.
    const cells = cellsByHeader(csv);
    expect(cells['Role']).toBe('\'=HYPERLINK("http://evil/","Click")');
  });

  it('keeps a multi-line email body inside one cell', () => {
    const cells = cellsByHeader(
      prepRunToCsv([item({ email_body: 'Hello,\n\nTwo paragraphs.\n\nRegards' })])
    );

    expect(cells['Email body']).toBe('Hello,\n\nTwo paragraphs.\n\nRegards');
  });
});

describe('numbered', () => {
  it('drops blanks so numbering never skips', () => {
    expect(numbered(['a', '', '  ', 'b'])).toBe('1. a\n2. b');
  });

  it('returns an empty string for nothing at all', () => {
    expect(numbered([])).toBe('');
    expect(numbered(['', '   '])).toBe('');
  });
});

describe('prepCsvFilename', () => {
  it('is dated and carries a run discriminator', () => {
    expect(
      prepCsvFilename(
        '7f3a9c21-4b5e-4d8a-9f10-2c3d4e5f6a7b',
        new Date('2026-08-25T12:00:00Z')
      )
    ).toBe('unviewable-prep-7f3a9c21-2026-08-25.csv');
  });

  // Two runs on the same day must not collide, or the browser writes
  // "… (1).csv" and someone applies from yesterday's shortlist.
  it('differs between two runs on the same day', () => {
    const day = new Date('2026-08-25T12:00:00Z');

    expect(prepCsvFilename('aaaaaaaa-1111-4111-8111-111111111111', day)).not.toBe(
      prepCsvFilename('bbbbbbbb-2222-4222-8222-222222222222', day)
    );
  });

  // The filename lands in a Content-Disposition header, so a quote or a newline
  // in it is header injection rather than a cosmetic problem.
  it('cannot inject into the Content-Disposition header', () => {
    const name = prepCsvFilename('a"b\r\nX-Evil: 1', new Date('2026-08-25T12:00:00Z'));

    expect(name).not.toContain('"');
    expect(name).not.toContain('\r');
    expect(name).not.toContain('\n');
    expect(name).toMatch(/^unviewable-prep-[a-z0-9-]*-2026-08-25\.csv$/);
  });
});
