import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_DIR,
  createWorkspace,
  fetchExport,
  fetchText,
  makeTempDir,
  type RunningApp,
  readExactText,
  removeTempDirs,
  startApp,
  uploadCsv,
} from './support/ledgerline.ts';

const HEADER = 'voucher_number,amount,check_date,department_name,contract_number,vendor_name\r\n';
const VALID_ROW = 'PV1,10.00,01/02/2024,DEPT OF FINANCE,DV,ACME\r\n';
const ALERT = /<div[^>]*role="alert"[^>]*>([^<]*)<\/div>/;
const RECORD_COUNT = /<span id="record-count">([^<]*)<\/span>/;

describe('import validation', () => {
  let app: RunningApp;
  let workspaceCounter = 0;
  let slug: string;

  beforeAll(async () => {
    app = await startApp(APP_DIR, makeTempDir('validation'));
  }, 30_000);

  beforeEach(async () => {
    workspaceCounter += 1;
    slug = `target-${workspaceCounter}`;
    await createWorkspace(app.baseUrl, `Target ${workspaceCounter}`);
  });

  afterAll(async () => {
    await app.stop();
    removeTempDirs();
  });

  const alertFor = async (response: Response): Promise<string | undefined> =>
    ALERT.exec(await response.text())?.[1]?.replaceAll('&quot;', '"');

  it('rejects a header whose columns are out of order and names the problem', async () => {
    // #given a header with vendor_name and department_name swapped
    const swapped = 'voucher_number,amount,check_date,vendor_name,contract_number,department_name\r\n';
    // #when it is uploaded
    const response = await uploadCsv(app.baseUrl, slug, swapped + VALID_ROW);
    // #then the import is refused with an alert describing the column order
    expect({ status: response.status, alert: await alertFor(response) }).toEqual({
      status: 422,
      alert:
        'Import failed: The header columns are out of order. Expected header: voucher_number,amount,check_date,department_name,contract_number,vendor_name',
    });
  });

  it('persists nothing when the header is rejected', async () => {
    // #given an upload whose header is missing the vendor_name column
    const missingVendor =
      'voucher_number,amount,check_date,department_name,contract_number\r\nPV1,1.00,2020,D,C\r\n';
    await uploadCsv(app.baseUrl, slug, missingVendor);
    // #when the workspace is exported afterwards
    const exported = await readExactText(await fetchExport(app.baseUrl, slug));
    // #then it holds only the header row
    expect(exported).toBe(HEADER);
  });

  it('names a missing column in the alert', async () => {
    // #given a header without vendor_name
    const csv = 'voucher_number,amount,check_date,department_name,contract_number\r\n';
    // #when it is uploaded
    const alert = await alertFor(await uploadCsv(app.baseUrl, slug, csv));
    // #then the alert points at that column
    expect(alert).toContain('missing column "vendor_name"');
  });

  it('rolls back every row when a later row is invalid', async () => {
    // #given two valid rows followed by one with a three-decimal amount
    const csv = `${HEADER}${VALID_ROW}${VALID_ROW}PV3,1.005,01/02/2024,D,DV,ACME\r\n`;
    // #when the file is uploaded and the ledger is reloaded
    const response = await uploadCsv(app.baseUrl, slug, csv);
    const count = RECORD_COUNT.exec(await fetchText(`${app.baseUrl}/w/${slug}`))?.[1];
    // #then the upload fails and none of the valid rows were kept
    expect({ status: response.status, count }).toEqual({ status: 422, count: '0 records' });
  });

  it('reports the spreadsheet row number of an invalid amount', async () => {
    // #given a file whose second payment row has a comma-formatted amount
    const csv = `${HEADER}${VALID_ROW}PV2,"1,000.00",01/02/2024,D,DV,ACME\r\n`;
    // #when it is uploaded
    const alert = await alertFor(await uploadCsv(app.baseUrl, slug, csv));
    // #then the alert names row 3, counting the header as row 1
    expect(alert).toContain('Row 3: amount "1,000.00" is not valid');
  });

  it('rejects a check date that is not a real calendar day', async () => {
    // #given February 30th
    const csv = `${HEADER}PV1,1.00,02/30/2024,D,DV,ACME\r\n`;
    // #when it is uploaded
    const alert = await alertFor(await uploadCsv(app.baseUrl, slug, csv));
    // #then the alert explains the accepted date formats
    expect(alert).toContain('check date "02/30/2024" must be a real date written MM/DD/YYYY');
  });

  it('rejects a row with the wrong number of fields', async () => {
    // #given a row with five fields under a six-column header
    const csv = `${HEADER}PV1,1.00,2020,D,DV\r\n`;
    // #when it is uploaded
    const alert = await alertFor(await uploadCsv(app.baseUrl, slug, csv));
    // #then the alert reports the field count
    expect(alert).toBe('Import failed: Row 2 has 5 fields; expected 6.');
  });

  it('rejects CSV with an unterminated quoted field', async () => {
    // #given a vendor name whose opening quote is never closed
    const csv = `${HEADER}PV1,1.00,2020,D,DV,"ACME\r\n`;
    // #when it is uploaded
    const alert = await alertFor(await uploadCsv(app.baseUrl, slug, csv));
    // #then the alert reports a CSV syntax error with its line
    expect(alert).toBe('Import failed: The file is not valid CSV: Quoted field is never closed on line 2.');
  });

  it('rejects a file that is not UTF-8', async () => {
    // #given Latin-1 bytes for "Café"
    const latin1 = new Uint8Array([...new TextEncoder().encode(`${HEADER}PV1,1.00,2020,D,DV,Caf`), 0xe9]);
    // #when it is uploaded
    const alert = await alertFor(await uploadCsv(app.baseUrl, slug, latin1));
    // #then the alert asks for a UTF-8 file
    expect(alert).toContain('not UTF-8 text');
  });

  it('rejects a header-only file instead of reporting an empty success', async () => {
    // #given an export of an empty workspace
    // #when it is uploaded
    const alert = await alertFor(await uploadCsv(app.baseUrl, slug, HEADER));
    // #then the alert says there were no payment rows
    expect(alert).toBe('Import failed: The file has a header but no payment rows.');
  });

  it('asks for a file when the form is submitted without one', async () => {
    // #given a multipart form with no file part
    const form = new FormData();
    form.set('note', 'no file chosen');
    // #when it is posted to the import route
    const response = await fetch(`${app.baseUrl}/w/${slug}/import`, { method: 'POST', body: form });
    // #then the alert asks the user to choose a file
    expect({ status: response.status, alert: await alertFor(response) }).toEqual({
      status: 400,
      alert: 'Import failed: choose a CSV file to import.',
    });
  });

  it('refuses uploads larger than 10 MiB', async () => {
    // #given a file just over the limit
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1).fill(0x41);
    // #when it is uploaded
    const response = await uploadCsv(app.baseUrl, slug, oversized);
    // #then the server answers payload too large without importing anything
    expect({ status: response.status, alert: await alertFor(response) }).toEqual({
      status: 413,
      alert: 'Import failed: the file is larger than 10 MiB.',
    });
  });

  it('accepts a file saved with a UTF-8 byte order mark', async () => {
    // #given a valid file prefixed with a BOM, as spreadsheet apps write it
    const csv = `﻿${HEADER}${VALID_ROW}`;
    // #when it is uploaded
    const response = await uploadCsv(app.baseUrl, slug, csv);
    // #then the import succeeds
    expect(response.headers.get('location')).toBe(`/w/${slug}?imported=1`);
  });

  it('returns 404 when importing into a workspace that does not exist', async () => {
    // #given no workspace called "nowhere"
    // #when a valid file is uploaded to it
    const response = await uploadCsv(app.baseUrl, 'nowhere', HEADER + VALID_ROW);
    await response.arrayBuffer();
    // #then the server answers not found
    expect(response.status).toBe(404);
  });
});
