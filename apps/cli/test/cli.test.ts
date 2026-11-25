import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sampleRows, suggestFields } from '../src/commands/init.ts';
import { main } from '../src/main.ts';
import type { Output } from '../src/render.ts';

function capture(): Output & { lines: string[]; stdout: string[] } {
  const lines: string[] = [];
  const stdout: string[] = [];
  return { lines, stdout, info: (line) => lines.push(line), data: (text) => stdout.push(text) };
}

describe('suggestFields', () => {
  it('suggests decimal, date and nullable string types from sample values', () => {
    // #given
    const [header = [], ...rows] = sampleRows(
      'voucher,amount,check_date,vendor\r\n,19038,03/02/2022,"SMITH, JOHN"\r\nPV1,17104.23,2009,ACME\r\n',
      10,
    );

    // #when
    const fields = suggestFields(header, rows).map((f) => [f.name, f.type, f.nullable, f.scale, f.formats]);

    // #then
    expect(fields).toEqual([
      ['voucher', 'string', true, undefined, undefined],
      ['amount', 'decimal', false, 2, undefined],
      ['check_date', 'date', false, undefined, ['MM/DD/YYYY', 'YYYY']],
      ['vendor', 'string', false, undefined, undefined],
    ]);
  });

  it('keeps identifier-like integer columns as strings', () => {
    // #given
    const header = ['record_id', 'quantity'];
    const rows = [
      ['007', '3'],
      ['010', '12'],
    ];

    // #when
    const types = suggestFields(header, rows).map((f) => f.type);

    // #then
    expect(types).toEqual(['string', 'integer']);
  });
});

describe('returntrip CLI', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'returntrip-cli-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a config that pins the source hash and refuses to overwrite it', async () => {
    // #given
    const source = join(dir, 'payments.csv');
    await writeFile(source, 'id,amount\r\nA,1.50\r\n');
    const args = ['node', 'returntrip', 'init', '--source', source, '--origin', 'http://127.0.0.1:3000/'];
    const out = join(dir, 'returntrip.yaml');

    // #when
    const first = await main([...args, '--out', out, '--yes'], capture());
    const second = await main([...args, '--out', out, '--yes'], capture());

    // #then
    expect({ first, second, pinned: (await readFile(out, 'utf8')).includes('sha256: ') }).toEqual({
      first: 0,
      second: 6,
      pinned: true,
    });
  });

  it('exits with INVALID_CONFIG for a missing config', async () => {
    // #given
    const output = capture();

    // #when
    const code = await main(
      ['node', 'returntrip', 'verify', '--config', join(dir, 'nope.yaml'), '--json'],
      output,
    );

    // #then
    expect({ code, json: JSON.parse(output.stdout.join('')).outcome }).toEqual({
      code: 6,
      json: 'INVALID_CONFIG',
    });
  });

  it('rejects --json together with --events', async () => {
    // #given
    const output = capture();

    // #when
    const code = await main(['node', 'returntrip', 'verify', '--json', '--events'], output);

    // #then
    expect(code).toBe(6);
  });

  it('refuses a repair without approval when not attached to a terminal', async () => {
    // #given
    const config = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'examples',
      'payment-roundtrip',
      'scenarios',
      'sign-flip.yaml',
    );
    const output = capture();

    // #when
    const code = await main(
      ['node', 'returntrip', 'repair', '--config', config, '--store', join(dir, 'store')],
      output,
    );

    // #then
    expect({ code, asked: output.lines.some((line) => line.includes('--yes')) }).toEqual({
      code: 6,
      asked: true,
    });
  });

  it('lists no runs in an empty store', async () => {
    // #given
    const output = capture();

    // #when
    const code = await main(
      ['node', 'returntrip', 'runs', 'list', '--store', join(dir, 'store'), '--json'],
      output,
    );

    // #then
    expect({ code, runs: JSON.parse(output.stdout.join('')).runs }).toEqual({ code: 0, runs: [] });
  });
});
