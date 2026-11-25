import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ZIP_LIMITS, EvidencePackError, parseZip, readEvidencePack } from '../src/zip-reader.ts';
import { buildZip, type SyntheticEntry } from './support/zip-builder.ts';

// Every archive in this file is SYNTHETIC, built in code by test/support/zip-builder.ts.

function open(entries: readonly SyntheticEntry[]): ReturnType<typeof parseZip> {
  return parseZip(buildZip(entries), DEFAULT_ZIP_LIMITS);
}

function rejection(entries: readonly SyntheticEntry[]): EvidencePackError {
  try {
    open(entries);
  } catch (error) {
    if (error instanceof EvidencePackError) return error;
    throw error;
  }
  throw new Error('archive was accepted');
}

describe('readEvidencePack', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zip-reader-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists and reads stored and deflated entries from disk', async () => {
    // #given a synthetic pack with one stored and one deflated member
    const path = join(dir, 'synthetic.evidence');
    await writeFile(
      path,
      buildZip([
        { name: 'run.yaml', data: 'status: finalized\n', method: 'stored' },
        { name: 'tests/t/logs/0-run.log', data: 'line\n'.repeat(200), method: 'deflate' },
      ]),
    );

    // #when it is opened and both entries are read
    const pack = await readEvidencePack(path);

    // #then the listing and the bytes match what was written
    expect({
      names: pack.entries.map((entry) => entry.name),
      run: pack.read('run.yaml').toString(),
      log: pack.read('tests/t/logs/0-run.log').length,
    }).toEqual({ names: ['run.yaml', 'tests/t/logs/0-run.log'], run: 'status: finalized\n', log: 1000 });
  });

  it('rejects a file that is not a ZIP archive', async () => {
    // #given a plain text file
    const path = join(dir, 'not.evidence');
    await writeFile(path, 'definitely not a zip archive');

    // #when it is opened
    const opening = readEvidencePack(path);

    // #then it fails with NOT_ZIP
    await expect(opening).rejects.toMatchObject({ code: 'NOT_ZIP' });
  });
});

describe('parseZip defenses', () => {
  it('omits directory records from the entry list', () => {
    // #given an archive with an explicit directory record
    const entries: SyntheticEntry[] = [{ name: 'coverage/' }, { name: 'coverage/.keep' }];

    // #when it is parsed
    const pack = open(entries);

    // #then only the file is listed
    expect(pack.entries.map((entry) => entry.name)).toEqual(['coverage/.keep']);
  });

  it.each([
    ['../escape.txt', 'parent traversal'],
    ['tests/../../escape.txt', 'nested traversal'],
    ['tests/./x', 'a "." segment'],
    ['tests//x', 'an empty segment'],
  ])('rejects %s (%s)', (name) => {
    // #given an entry whose name walks out of the archive root
    const entries: SyntheticEntry[] = [{ name, data: 'x' }];

    // #when it is parsed
    const error = rejection(entries);

    // #then it is refused as unsafe
    expect(error.code).toBe('UNSAFE_ENTRY');
  });

  it.each(['/etc/passwd', 'C:/Windows/win.ini'])('rejects the absolute path %s', (name) => {
    // #given an entry with an absolute name
    const entries: SyntheticEntry[] = [{ name, data: 'x' }];

    // #when it is parsed
    const error = rejection(entries);

    // #then it is refused as unsafe
    expect([error.code, error.message.includes('absolute')]).toEqual(['UNSAFE_ENTRY', true]);
  });

  it('rejects a backslash in an entry name', () => {
    // #given a Windows-style traversal
    const entries: SyntheticEntry[] = [{ name: '..\\escape.txt', data: 'x' }];

    // #when it is parsed
    const error = rejection(entries);

    // #then it is refused
    expect(error.message).toContain('backslash');
  });

  it('rejects a symbolic link entry', () => {
    // #given an entry whose Unix mode marks it as a symlink to /etc/passwd
    const entries: SyntheticEntry[] = [
      { name: 'link', data: '/etc/passwd', unixMode: 0o120777, method: 'stored' },
    ];

    // #when it is parsed
    const error = rejection(entries);

    // #then it is refused
    expect(error.message).toContain('symbolic link');
  });

  it('rejects duplicate entry names', () => {
    // #given the same name twice with different content
    const entries: SyntheticEntry[] = [
      { name: 'run.yaml', data: 'a' },
      { name: 'run.yaml', data: 'b' },
    ];

    // #when it is parsed
    const error = rejection(entries);

    // #then it is refused, since a reader could pick either
    expect(error.message).toContain('duplicate');
  });

  it('rejects more than 2,000 entries', () => {
    // #given 2,001 empty files
    const entries: SyntheticEntry[] = Array.from({ length: 2_001 }, (_, index) => ({
      name: `f/${index}`,
      method: 'stored' as const,
    }));

    // #when it is parsed
    const error = rejection(entries);

    // #then the entry limit is enforced before anything is read
    expect(error.code).toBe('LIMIT_EXCEEDED');
  });

  it('accepts exactly 2,000 entries', () => {
    // #given 2,000 empty files
    const entries: SyntheticEntry[] = Array.from({ length: 2_000 }, (_, index) => ({
      name: `f/${index}`,
      method: 'stored' as const,
    }));

    // #when it is parsed
    const pack = open(entries);

    // #then all are listed
    expect(pack.entries).toHaveLength(2_000);
  });

  it('rejects an entry above the per-entry size limit', () => {
    // #given a 21 MiB stored entry
    const entries: SyntheticEntry[] = [
      { name: 'big.bin', data: Buffer.alloc(21 * 1024 * 1024), method: 'stored' },
    ];

    // #when it is parsed
    const error = rejection(entries);

    // #then it is refused by size
    expect([error.code, error.message.includes('expands to')]).toEqual(['LIMIT_EXCEEDED', true]);
  });

  it('rejects archives above the total uncompressed limit', () => {
    // #given three 19 MiB entries, each under the per-entry limit
    const entries: SyntheticEntry[] = [0, 1, 2].map((index) => ({
      name: `part-${index}.bin`,
      data: Buffer.alloc(19 * 1024 * 1024, index),
      method: 'stored' as const,
    }));

    // #when it is parsed
    const error = rejection(entries);

    // #then the 50 MiB total limit applies
    expect(error.message).toContain('in total');
  });

  it('rejects a compression ratio above 100', () => {
    // #given 4 MiB of zeros, which deflates to a few KiB
    const entries: SyntheticEntry[] = [{ name: 'bomb.bin', data: Buffer.alloc(4 * 1024 * 1024) }];

    // #when it is parsed
    const error = rejection(entries);

    // #then it is refused as a likely bomb
    expect(error.message).toContain('compression ratio');
  });

  it('refuses to inflate past the declared size', () => {
    // #given a deflated entry that lies about being only 10 bytes long
    const pack = open([{ name: 'liar.txt', data: 'x'.repeat(5_000), declaredSize: 10 }]);

    // #when it is read
    const read = (): Buffer => pack.read('liar.txt');

    // #then inflation stops and the entry is reported corrupt
    expect(read).toThrow(expect.objectContaining({ code: 'CORRUPT' }));
  });

  it('detects a CRC-32 mismatch', () => {
    // #given an archive whose stored payload is flipped after the CRC was written
    const archive = buildZip([{ name: 'a.txt', data: 'hello', method: 'stored' }]);
    archive[30 + 'a.txt'.length] = 'j'.charCodeAt(0);
    const pack = parseZip(archive, DEFAULT_ZIP_LIMITS);

    // #when it is read
    const read = (): Buffer => pack.read('a.txt');

    // #then the checksum failure is reported
    expect(read).toThrow('CRC-32');
  });

  it('rejects non-ASCII names that are not flagged as UTF-8', () => {
    // #given a name encoded without the UTF-8 flag
    const entries: SyntheticEntry[] = [{ name: 'café.txt', data: 'x', utf8Flag: false }];

    // #when it is parsed
    const error = rejection(entries);

    // #then the ambiguous encoding is refused
    expect(error.code).toBe('UNSAFE_ENTRY');
  });

  it('honors caller limits stricter than the defaults', () => {
    // #given three files and a limit of two
    const archive = buildZip([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);

    // #when it is parsed with that limit
    const parse = (): unknown => parseZip(archive, { ...DEFAULT_ZIP_LIMITS, maxEntries: 2 });

    // #then it is refused
    expect(parse).toThrow('limit 2');
  });
});
