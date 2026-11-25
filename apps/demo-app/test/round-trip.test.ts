import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPECTED_SOURCE_EXPORT, FIXTURE_PAYMENT_COUNT } from './support/expected.ts';
import {
  APP_DIR,
  FIXTURE_CSV,
  fetchExport,
  makeTempDir,
  type RoundTrip,
  type RunningApp,
  readExactText,
  removeTempDirs,
  runRoundTrip,
  seedWorkspace,
  startApp,
} from './support/ledgerline.ts';

describe('healthy export', () => {
  let app: RunningApp;

  beforeAll(async () => {
    const dataDir = makeTempDir('export');
    seedWorkspace(APP_DIR, dataDir, { slug: 'source', name: 'Source payments', csvPath: FIXTURE_CSV });
    app = await startApp(APP_DIR, dataDir);
  }, 30_000);

  afterAll(async () => {
    await app.stop();
  });

  it('writes the seeded fixture as RFC 4180 CSV with two-decimal amounts and CRLF records', async () => {
    // #given a workspace seeded from the fixture through the trusted seed path
    // #when its CSV export is downloaded
    const body = await readExactText(await fetchExport(app.baseUrl, 'source'));
    // #then the bytes match the canonical export exactly
    expect(body).toBe(EXPECTED_SOURCE_EXPORT);
  });

  it('serves the export as a UTF-8 CSV attachment named after the workspace', async () => {
    // #given the seeded source workspace
    // #when the export is requested
    const response = await fetchExport(app.baseUrl, 'source');
    await response.arrayBuffer();
    // #then the headers describe a downloadable CSV file
    expect({
      status: response.status,
      contentType: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
    }).toEqual({
      status: 200,
      contentType: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="source-payments.csv"',
    });
  });

  it('produces identical bytes when the same data is exported twice', async () => {
    // #given one export already taken
    const first = await readExactText(await fetchExport(app.baseUrl, 'source'));
    // #when the workspace is exported again without changes
    const second = await readExactText(await fetchExport(app.baseUrl, 'source'));
    // #then both downloads are byte-identical
    expect(second).toBe(first);
  });

  it('returns 404 for the export of a workspace that does not exist', async () => {
    // #given no workspace called "missing"
    // #when its export is requested
    const response = await fetchExport(app.baseUrl, 'missing');
    await response.arrayBuffer();
    // #then the server answers not found
    expect(response.status).toBe(404);
  });
});

describe('healthy round trip through export, browser-style upload and re-export', () => {
  let roundTrip: RoundTrip;

  beforeAll(async () => {
    roundTrip = await runRoundTrip(APP_DIR);
  }, 30_000);

  afterAll(() => {
    removeTempDirs();
  });

  it('redirects the upload to the workspace page with the imported count', () => {
    // #given the source export uploaded into a new empty workspace
    // #when the import response is inspected
    const { importStatus, importLocation } = roundTrip;
    // #then it is a post/redirect/get to the ledger carrying the row count
    expect({ importStatus, importLocation }).toEqual({
      importStatus: 303,
      importLocation: `/w/restored-payments?imported=${FIXTURE_PAYMENT_COUNT}`,
    });
  });

  it('shows the success banner as a status message after the redirect', () => {
    // #given the page the browser lands on after importing
    // #when its banner is read
    const banner = /<div[^>]*role="status"[^>]*>([^<]*)<\/div>/.exec(roundTrip.restoredPage)?.[1];
    // #then it announces every imported payment
    expect(banner).toBe(`Import successful: ${FIXTURE_PAYMENT_COUNT} payments`);
  });

  it('re-exports the imported workspace byte-identically to the source export', () => {
    // #given the source export and the export of the workspace it was imported into
    const { sourceExport, restoredExport } = roundTrip;
    // #when the two files are compared byte for byte
    // #then nothing was lost, reordered or reformatted on the way through
    expect(restoredExport).toBe(sourceExport);
  });
});
