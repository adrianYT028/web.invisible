import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for GET /api/prep/[id]/export.
 *
 * The serialiser is covered exhaustively in src/lib/jobs/prep-csv.test.ts, so
 * nothing here re-tests column content. What only a route test can reach:
 *
 *   1. A run belonging to SOMEONE ELSE is a 404, not a file. This is the one
 *      genuinely dangerous failure mode — an export that leaked another user's
 *      resume content and the contact addresses attached to it.
 *   2. Both queries are scoped by `user_id`. RLS does not protect these reads
 *      because they go through the service-role client, so the `.eq` is the only
 *      thing standing between users.
 *   3. The download headers. Without `Content-Disposition` the CSV renders as text
 *      in the tab instead of saving, which makes the whole feature a no-op.
 *   4. No entitlement gate, matching the tracker export and GET /api/prep/[id].
 */

/** Every filter applied, so the tests can assert the queries were scoped. */
const filters: { table: string; column: string; value: unknown }[] = [];

const state = {
  /** The row `prep_run_progress` returns. Null models "not yours, or missing". */
  run: null as { run_id: string; status: string } | null,
  items: [] as unknown[],
  itemsError: null as { message: string } | null,
  user: { id: 'user-1' } as { id: string } | null,
  selectedColumns: '' as string,
};

vi.mock('@/lib/http', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/http')>();
  return { ...actual, logSafe: () => {} };
});

vi.mock('@/lib/supabase/route', () => ({
  createSupabaseRouteClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
    },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const chain = {
        select(columns: string) {
          if (table === 'prep_items') state.selectedColumns = columns;
          return chain;
        },
        eq(column: string, value: unknown) {
          filters.push({ table, column, value });
          return chain;
        },
        order() {
          // Terminal for prep_items: resolves to the item rows.
          return Promise.resolve(
            state.itemsError
              ? { data: null, error: state.itemsError }
              : { data: state.items, error: null }
          );
        },
        maybeSingle: async () => ({ data: state.run, error: null }),
      };
      return chain;
    },
  }),
}));

const { GET } = await import('./route');

const RUN_ID = '7f3a9c21-4b5e-4d8a-9f10-2c3d4e5f6a7b';

function request(id: string = RUN_ID) {
  return GET(new Request(`http://localhost/api/prep/${id}/export`), {
    params: Promise.resolve({ id }),
  });
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    status: 'done',
    error: null,
    match_score: 74,
    email_subject: 'Backend intern application',
    email_body: 'Hello',
    contact_hint: 'careers@zenpay.example',
    completed_at: '2026-08-25T09:30:00.000Z',
    job_postings: {
      title: 'Backend Engineering Intern',
      location: 'Bengaluru',
      is_remote: false,
      url: 'https://jobs.example/x',
      job_companies: { name: 'Zenpay Technologies' },
    },
    resume_scans: { report: {} },
    ...overrides,
  };
}

beforeEach(() => {
  filters.length = 0;
  state.run = { run_id: RUN_ID, status: 'done' };
  state.items = [item()];
  state.itemsError = null;
  state.user = { id: 'user-1' };
  state.selectedColumns = '';
});

describe('GET /api/prep/[id]/export — access', () => {
  it('refuses an anonymous caller', async () => {
    state.user = null;

    const res = await request();

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'not_authenticated' });
  });

  // THE ONE THAT MATTERS. `prep_run_progress` returns nothing when the run is not
  // the caller's, and that must produce a 404 rather than an empty-but-successful
  // download — a 200 would mean the ownership check had stopped being load-bearing.
  it('404s a run that is not the caller’s, and reads no items', async () => {
    state.run = null;

    const res = await request();

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'job_not_found' });
    expect(filters.some((f) => f.table === 'prep_items')).toBe(false);
  });

  it('scopes BOTH queries to the caller, since RLS does not apply to the admin client', async () => {
    await request();

    const scoped = (table: string) =>
      filters.filter((f) => f.table === table && f.column === 'user_id');

    expect(scoped('prep_run_progress')).toEqual([
      { table: 'prep_run_progress', column: 'user_id', value: 'user-1' },
    ]);
    expect(scoped('prep_items')).toEqual([
      { table: 'prep_items', column: 'user_id', value: 'user-1' },
    ]);
  });

  it('reads only the requested run', async () => {
    await request();

    expect(
      filters.filter((f) => f.table === 'prep_items' && f.column === 'run_id')
    ).toEqual([{ table: 'prep_items', column: 'run_id', value: RUN_ID }]);
  });

  // Deliberately open, like /api/jobs/export and GET /api/prep/[id]: the run was
  // already paid for at POST time and nothing new is produced here.
  it('does not require an entitlement', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/app/api/prep/[id]/export/route.ts', 'utf8')
    );

    expect(source).not.toContain('requireService');
    // And the reason is recorded, so a future reader does not "fix" it.
    expect(source).toMatch(/NOT ENTITLEMENT-GATED/);
  });
});

describe('GET /api/prep/[id]/export — the download', () => {
  it('sends a CSV as an attachment with a dated, run-specific filename', async () => {
    const res = await request();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');

    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="/);
    // The run discriminator, so two runs on one day cannot collide.
    expect(disposition).toContain('unviewable-prep-7f3a9c21-');
    expect(disposition).toMatch(/\d{4}-\d{2}-\d{2}\.csv"$/);
  });

  // A file containing resume content and third-party contact addresses must not
  // sit in a shared or browser cache.
  it('forbids caching', async () => {
    const res = await request();

    expect(res.headers.get('cache-control')).toBe('no-store, private');
  });

  it('returns the run as a real CSV body', async () => {
    const body = await (await request()).text();

    expect(body).toContain('Company');
    expect(body).toContain('Zenpay Technologies');
    expect(body).toContain('Tailored bullet');
  });

  // Asserted on the BYTES, not on `.text()`: the fetch spec strips a leading BOM
  // when decoding, so reading the response as a string cannot see it. The bytes are
  // what Excel reads, and without EF BB BF it guesses the system codepage and
  // mangles any rupee sign or accented name in the sheet.
  it('puts a UTF-8 BOM on the wire for Excel', async () => {
    const bytes = new Uint8Array(await (await request()).arrayBuffer());

    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('selects the joins the tailored bullets depend on', async () => {
    await request();

    // Without the resume_scans embed the rewrite columns are silently always
    // empty, which no assertion on the CSV body would catch.
    expect(state.selectedColumns).toContain('resume_scans(report)');
    expect(state.selectedColumns).toContain('job_companies(name)');
    expect(state.selectedColumns).toContain('contact_hint');
    expect(state.selectedColumns).toContain('completed_at');
  });

  it('exports an unfinished run rather than refusing it', async () => {
    state.run = { run_id: RUN_ID, status: 'running' };
    state.items = [item(), item({ status: 'queued', match_score: null })];

    const res = await request();

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Queued');
  });

  it('still produces a header-only file for a run with no items', async () => {
    state.items = [];

    const body = await (await request()).text();

    expect(body).toContain('Company');
    expect(body.trim().split('\r\n')).toHaveLength(1);
  });

  it('500s on a read failure instead of sending a truncated sheet', async () => {
    state.itemsError = { message: 'connection reset' };

    const res = await request();

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'internal_error' });
  });
});
