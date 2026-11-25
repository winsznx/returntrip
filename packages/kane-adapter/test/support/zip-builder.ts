import { crc32, deflateRawSync } from 'node:zlib';

/**
 * SYNTHETIC ZIP writer for tests. It can produce archives no honest tool would, such as
 * traversal names, symlink entries or lying size fields, to exercise the reader's defenses.
 */
export interface SyntheticEntry {
  readonly name: string;
  readonly data?: Buffer | string;
  readonly method?: 'stored' | 'deflate';
  /** Unix mode placed in the upper 16 bits of the external attributes. */
  readonly unixMode?: number;
  /** Overrides the uncompressed size written to both headers. */
  readonly declaredSize?: number;
  readonly utf8Flag?: boolean;
}

export function buildZip(entries: readonly SyntheticEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const deflate = (entry.method ?? 'deflate') === 'deflate';
    const payload = deflate ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name, 'utf8');
    const size = entry.declaredSize ?? data.length;
    const flags = entry.utf8Flag === false ? 0 : 0x0800;
    const method = deflate ? 8 : 0;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}
