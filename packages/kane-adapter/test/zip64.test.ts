import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_ZIP_LIMITS, EvidencePackError, parseZip } from '../src/index.ts';
import { resolveZip64Sizes } from '../src/zip-reader.ts';

const SURE_EXPORT = join(import.meta.dirname, 'fixtures', 'sure', 'sure-44aad3a-family-export.zip');

describe('Zip64 entry sizes', () => {
  it('reads a real Sure family export whose entries use Zip64 sizes', async () => {
    // #given a zip written by rubyzip with every size marked 0xFFFFFFFF
    const archive = await readFile(SURE_EXPORT);

    // #when
    const pack = parseZip(archive, DEFAULT_ZIP_LIMITS);
    const csv = pack.read('transactions.csv').toString('utf8');

    // #then
    expect({
      header: csv.split('\n')[0],
      rows: csv.trim().split('\n').length - 1,
      size: pack.entries.find((entry) => entry.name === 'transactions.csv')?.size,
    }).toEqual({
      header: 'date,account_name,amount,name,category,tags,notes,currency',
      rows: 250,
      size: 19097,
    });
  });

  it('takes only the marked fields from the Zip64 extra field, in order', () => {
    // #given an extra field holding uncompressed 100 and compressed 40, with the offset in 32 bits
    const extra = Buffer.alloc(4 + 16);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(100n, 4);
    extra.writeBigUInt64LE(40n, 12);

    // #when
    const sizes = resolveZip64Sizes(extra, {
      size: 0xffffffff,
      compressedSize: 0xffffffff,
      localHeaderOffset: 7,
    });

    // #then
    expect(sizes).toEqual({ size: 100, compressedSize: 40, localHeaderOffset: 7 });
  });

  it('rejects marked sizes with no Zip64 extra field', () => {
    // #given
    const extra = Buffer.alloc(0);

    // #when
    const resolve = (): unknown =>
      resolveZip64Sizes(extra, { size: 0xffffffff, compressedSize: 10, localHeaderOffset: 0 });

    // #then
    expect(resolve).toThrow(EvidencePackError);
  });
});
