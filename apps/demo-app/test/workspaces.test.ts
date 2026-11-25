import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_DIR,
  createWorkspace,
  fetchText,
  makeTempDir,
  type RunningApp,
  removeTempDirs,
  seedWorkspace,
  startApp,
} from './support/ledgerline.ts';

const HEADER = 'voucher_number,amount,check_date,department_name,contract_number,vendor_name\n';
const ALERT = /<div[^>]*role="alert"[^>]*>([^<]*)<\/div>/;
const RECORD_COUNT = /<span id="record-count">([^<]*)<\/span>/;

describe('workspaces and pages', () => {
  let app: RunningApp;

  beforeAll(async () => {
    const dataDir = makeTempDir('pages');
    const csvDir = makeTempDir('csv');

    const hostile = join(csvDir, 'hostile.csv');
    writeFileSync(
      hostile,
      `${HEADER}PV1,1.00,2020,<b>Dept</b>,DV,"<script>alert(""pwned"")</script> Supplies"\n`,
    );
    seedWorkspace(APP_DIR, dataDir, { slug: 'hostile', name: 'Hostile <img src=x>', csvPath: hostile });

    const large = join(csvDir, 'large.csv');
    const rows = Array.from(
      { length: 120 },
      (_, index) => `PV${index + 1},${index + 1}.00,2020,D,DV,Vendor ${index + 1}\n`,
    );
    writeFileSync(large, HEADER + rows.join(''));
    seedWorkspace(APP_DIR, dataDir, { slug: 'large', name: 'Large ledger', csvPath: large });

    app = await startApp(APP_DIR, dataDir);
  }, 30_000);

  afterAll(async () => {
    await app.stop();
    removeTempDirs();
  });

  it('reports health as JSON', async () => {
    // #given a running server
    // #when the health endpoint is requested
    const response = await fetch(`${app.baseUrl}/health`);
    // #then it answers ok
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { status: 'ok' },
    });
  });

  it('creates a workspace and redirects to its slug derived from the name', async () => {
    // #given a name with accents, capitals and punctuation
    // #when the create form is submitted
    const response = await createWorkspace(app.baseUrl, '  Café Núñez: Payments 2024 ');
    // #then the browser is sent to the normalized slug
    expect({ status: response.status, location: response.headers.get('location') }).toEqual({
      status: 303,
      location: '/w/cafe-nunez-payments-2024',
    });
  });

  it('rejects a second workspace that would reuse an existing slug', async () => {
    // #given a workspace called "Quarterly close"
    await createWorkspace(app.baseUrl, 'Quarterly close');
    // #when another workspace with a name that slugifies the same way is created
    const response = await createWorkspace(app.baseUrl, 'QUARTERLY   Close!');
    // #then it is refused with a visible conflict error
    expect({ status: response.status, alert: ALERT.exec(await response.text())?.[1] }).toEqual({
      status: 409,
      alert: 'A workspace already uses the address /w/quarterly-close. Choose a different name.',
    });
  });

  it('rejects a workspace name with no letters or digits', async () => {
    // #given a name made only of punctuation
    // #when the create form is submitted
    const response = await createWorkspace(app.baseUrl, '!!! ---');
    // #then it is refused with a visible validation error
    expect({ status: response.status, alert: ALERT.exec(await response.text())?.[1] }).toEqual({
      status: 422,
      alert: 'Workspace names need at least one letter or number.',
    });
  });

  it('escapes vendor, department and workspace names instead of rendering them as markup', async () => {
    // #given a workspace whose name and rows contain HTML
    // #when its ledger page is rendered
    const page = await fetchText(`${app.baseUrl}/w/hostile`);
    // #then every value appears as escaped text
    expect({
      rawScript: page.includes('<script>'),
      rawImage: page.includes('<img src=x>'),
      rawBold: page.includes('<b>Dept</b>'),
      escapedVendor: page.includes('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt; Supplies'),
      escapedName: page.includes('<h1>Hostile &lt;img src=x&gt;</h1>'),
    }).toEqual({ rawScript: false, rawImage: false, rawBold: false, escapedVendor: true, escapedName: true });
  });

  it('lists every workspace with its record count on the home page', async () => {
    // #given the seeded "Large ledger" workspace with 120 payments
    // #when the home page is rendered
    const page = await fetchText(`${app.baseUrl}/`);
    // #then the row links to the workspace and shows the formatted count
    expect(page).toMatch(/<a class="row-link" href="\/w\/large">Large ledger<\/a>[\s\S]*?120 records/);
  });

  it('shows the total record count with the singular form for one record', async () => {
    // #given a workspace holding exactly one payment
    // #when its page is rendered
    const count = RECORD_COUNT.exec(await fetchText(`${app.baseUrl}/w/hostile`))?.[1];
    // #then the count reads "1 record"
    expect(count).toBe('1 record');
  });

  it('paginates the ledger 50 rows at a time', async () => {
    // #given 120 payments
    // #when the last page is requested
    const page = await fetchText(`${app.baseUrl}/w/large?page=3`);
    // #then it holds the remaining 20 rows and links back to page 2
    expect({
      rows: page.match(/<td class="vendor">/g)?.length,
      indicator: page.includes('Page 3 of 3'),
      previous: page.includes('href="/w/large?page=2">Previous</a>'),
    }).toEqual({ rows: 20, indicator: true, previous: true });
  });

  it('rejects a page number that is not a positive whole number', async () => {
    // #given a malformed page parameter
    // #when the ledger is requested with it
    const response = await fetch(`${app.baseUrl}/w/large?page=0`);
    await response.arrayBuffer();
    // #then the request is refused as bad input
    expect(response.status).toBe(400);
  });

  it('returns 404 for a page past the end of the ledger', async () => {
    // #given 120 payments, which fill three pages
    // #when page 4 is requested
    const response = await fetch(`${app.baseUrl}/w/large?page=4`);
    await response.arrayBuffer();
    // #then the page is not found
    expect(response.status).toBe(404);
  });

  it('returns a 404 page for an unknown workspace', async () => {
    // #given no workspace called "ghost"
    // #when its page is requested
    const response = await fetch(`${app.baseUrl}/w/ghost`);
    // #then a not-found page is rendered
    expect({
      status: response.status,
      heading: (await response.text()).includes('Workspace not found'),
    }).toEqual({
      status: 404,
      heading: true,
    });
  });

  it('answers 405 with an Allow header for unsupported methods', async () => {
    // #given the export route, which only reads
    // #when it receives a DELETE
    const response = await fetch(`${app.baseUrl}/w/large/export.csv`, { method: 'DELETE' });
    await response.arrayBuffer();
    // #then the method is refused and the allowed ones are listed
    expect({ status: response.status, allow: response.headers.get('allow') }).toEqual({
      status: 405,
      allow: 'GET, HEAD',
    });
  });

  it('serves the stylesheet as CSS', async () => {
    // #given the single stylesheet linked from every page
    // #when it is requested
    const response = await fetch(`${app.baseUrl}/assets/app.css`);
    await response.arrayBuffer();
    // #then it is delivered as text/css
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });
});

describe('server lifecycle', () => {
  afterAll(() => {
    removeTempDirs();
  });

  it('exits cleanly on SIGTERM', async () => {
    // #given a running server
    const app = await startApp(APP_DIR, makeTempDir('lifecycle'));
    // #when it receives SIGTERM
    const exitCode = await app.stop();
    // #then it closes the server and database and exits with code 0
    expect(exitCode).toBe(0);
  }, 30_000);
});
