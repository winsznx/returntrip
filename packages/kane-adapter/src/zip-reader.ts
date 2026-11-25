import { readFile } from 'node:fs/promises';
import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxEntryUncompressedBytes: number;
  readonly maxCompressionRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2_000,
  maxTotalUncompressedBytes: 50 * 1024 * 1024,
  maxEntryUncompressedBytes: 20 * 1024 * 1024,
  maxCompressionRatio: 100,
};

export interface ZipEntry {
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly crc32: number;
}

export interface EvidencePack {
  /** File entries only; directory records are validated and then omitted. */
  readonly entries: readonly ZipEntry[];
  /** Decompresses one entry and checks its size and CRC-32. */
  read(name: string): Buffer;
}

export type EvidencePackErrorCode = 'NOT_ZIP' | 'UNSUPPORTED' | 'UNSAFE_ENTRY' | 'LIMIT_EXCEEDED' | 'CORRUPT';

export class EvidencePackError extends Error {
  override readonly name = 'EvidencePackError';
  readonly code: EvidencePackErrorCode;

  constructor(code: EvidencePackErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
/** Below this size an entry cannot carry a meaningful bomb, and short text compresses well. */
const RATIO_CHECK_MIN_BYTES = 4 * 1024;

interface CentralRecord extends ZipEntry {
  readonly method: number;
  readonly localHeaderOffset: number;
}

/**
 * Opens a ZIP archive (Kane's `.evidence` pack) for reading without extracting it to disk.
 * Supports stored and deflated entries only, and rejects anything a hostile archive could use:
 * traversal or absolute names, backslashes, symlinks, encryption, ZIP64 archives (Zip64 entry
 * sizes are fine), duplicate names, and entry counts, sizes or compression ratios above `limits`.
 */
export async function readEvidencePack(path: string, limits: Partial<ZipLimits> = {}): Promise<EvidencePack> {
  return parseZip(await readFile(path), { ...DEFAULT_ZIP_LIMITS, ...limits });
}

export function parseZip(archive: Buffer, limits: ZipLimits): EvidencePack {
  const eocd = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);

  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new EvidencePackError('UNSUPPORTED', 'ZIP64 archives are not supported');
  }
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new EvidencePackError('UNSUPPORTED', 'multi-disk archives are not supported');
  }
  if (entryCount > limits.maxEntries) {
    throw new EvidencePackError(
      'LIMIT_EXCEEDED',
      `archive has ${entryCount} entries, limit ${limits.maxEntries}`,
    );
  }
  if (centralOffset + centralSize > eocd) {
    throw new EvidencePackError('CORRUPT', 'central directory lies outside the archive');
  }

  const records = new Map<string, CentralRecord>();
  let totalBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    const { record, next } = readCentralRecord(archive, cursor, centralOffset + centralSize);
    cursor = next;
    if (records.has(record.name)) {
      throw new EvidencePackError('UNSAFE_ENTRY', `duplicate entry name ${JSON.stringify(record.name)}`);
    }
    enforceEntryLimits(record, limits);
    totalBytes += record.size;
    if (totalBytes > limits.maxTotalUncompressedBytes) {
      throw new EvidencePackError(
        'LIMIT_EXCEEDED',
        `archive expands past ${limits.maxTotalUncompressedBytes} bytes in total`,
      );
    }
    if (record.localHeaderOffset >= centralOffset) {
      throw new EvidencePackError(
        'CORRUPT',
        `entry ${JSON.stringify(record.name)} points past its data region`,
      );
    }
    records.set(record.name, record);
  }

  const files = [...records.values()].filter((record) => !record.name.endsWith('/'));
  const entries: ZipEntry[] = files.map(({ name, size, compressedSize, crc32: checksum }) => ({
    name,
    size,
    compressedSize,
    crc32: checksum,
  }));
  const byName = new Map(files.map((record) => [record.name, record]));

  return {
    entries,
    read(name: string): Buffer {
      const record = byName.get(name);
      if (!record) throw new EvidencePackError('CORRUPT', `no entry named ${JSON.stringify(name)}`);
      return readEntryData(archive, record, centralOffset);
    },
  };
}

function findEndOfCentralDirectory(archive: Buffer): number {
  if (archive.length < EOCD_SIZE)
    throw new EvidencePackError('NOT_ZIP', 'file is too small to be a ZIP archive');
  const lowest = Math.max(0, archive.length - EOCD_SIZE - MAX_COMMENT);
  for (let offset = archive.length - EOCD_SIZE; offset >= lowest; offset -= 1) {
    if (archive.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + EOCD_SIZE + commentLength === archive.length) return offset;
  }
  throw new EvidencePackError('NOT_ZIP', 'end of central directory record not found');
}

function readCentralRecord(
  archive: Buffer,
  offset: number,
  centralEnd: number,
): { record: CentralRecord; next: number } {
  if (offset + CENTRAL_HEADER_SIZE > centralEnd || archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
    throw new EvidencePackError('CORRUPT', `bad central directory header at offset ${offset}`);
  }
  const flags = archive.readUInt16LE(offset + 8);
  const method = archive.readUInt16LE(offset + 10);
  const checksum = archive.readUInt32LE(offset + 16);
  const nameLength = archive.readUInt16LE(offset + 28);
  const extraLength = archive.readUInt16LE(offset + 30);
  const commentLength = archive.readUInt16LE(offset + 32);
  const externalAttributes = archive.readUInt32LE(offset + 38);
  const nameStart = offset + CENTRAL_HEADER_SIZE;
  const next = nameStart + nameLength + extraLength + commentLength;
  if (next > centralEnd)
    throw new EvidencePackError('CORRUPT', `central directory entry at ${offset} overruns`);
  const { size, compressedSize, localHeaderOffset } = resolveZip64Sizes(
    archive.subarray(nameStart + nameLength, nameStart + nameLength + extraLength),
    {
      size: archive.readUInt32LE(offset + 24),
      compressedSize: archive.readUInt32LE(offset + 20),
      localHeaderOffset: archive.readUInt32LE(offset + 42),
    },
  );

  const name = decodeName(archive.subarray(nameStart, nameStart + nameLength), flags);
  assertSafeName(name);
  if (flags & FLAG_ENCRYPTED)
    throw new EvidencePackError('UNSUPPORTED', `entry ${JSON.stringify(name)} is encrypted`);
  if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
    throw new EvidencePackError(
      'UNSUPPORTED',
      `entry ${JSON.stringify(name)} uses compression method ${method}`,
    );
  }
  // The upper 16 bits hold the Unix mode whichever host wrote the archive; honor any symlink bit.
  if (((externalAttributes >>> 16) & S_IFMT) === S_IFLNK) {
    throw new EvidencePackError('UNSAFE_ENTRY', `entry ${JSON.stringify(name)} is a symbolic link`);
  }
  if (method === METHOD_STORED && compressedSize !== size) {
    throw new EvidencePackError('CORRUPT', `stored entry ${JSON.stringify(name)} has mismatched sizes`);
  }
  return {
    record: { name, size, compressedSize, crc32: checksum, method, localHeaderOffset },
    next,
  };
}

const ZIP64_EXTRA_ID = 0x0001;
const ZIP64_MARKER = 0xffffffff;

/**
 * Some writers (rubyzip, for one) mark every size as 0xFFFFFFFF and put the real values in the
 * Zip64 extended information extra field, in a fixed order: uncompressed size, compressed size,
 * local header offset, each present only when its 32-bit field holds the marker.
 */
export function resolveZip64Sizes(
  extra: Buffer,
  fields: { size: number; compressedSize: number; localHeaderOffset: number },
): { size: number; compressedSize: number; localHeaderOffset: number } {
  const needs = [fields.size, fields.compressedSize, fields.localHeaderOffset].some(
    (v) => v === ZIP64_MARKER,
  );
  if (!needs) return fields;
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    const body = extra.subarray(at + 4, at + 4 + length);
    if (body.length !== length) break;
    if (id === ZIP64_EXTRA_ID) {
      let cursor = 0;
      const take = (current: number): number => {
        if (current !== ZIP64_MARKER) return current;
        if (cursor + 8 > body.length)
          throw new EvidencePackError('CORRUPT', 'Zip64 extra field is too short');
        const value = body.readBigUInt64LE(cursor);
        cursor += 8;
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new EvidencePackError('LIMIT_EXCEEDED', 'Zip64 value is larger than this reader supports');
        }
        return Number(value);
      };
      return {
        size: take(fields.size),
        compressedSize: take(fields.compressedSize),
        localHeaderOffset: take(fields.localHeaderOffset),
      };
    }
    at += 4 + length;
  }
  throw new EvidencePackError('CORRUPT', 'entry declares Zip64 sizes but has no Zip64 extra field');
}

function decodeName(bytes: Buffer, flags: number): string {
  const isAscii = bytes.every((byte) => byte < 0x80);
  if (!isAscii && !(flags & FLAG_UTF8)) {
    throw new EvidencePackError('UNSAFE_ENTRY', 'entry name is neither ASCII nor flagged UTF-8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EvidencePackError('UNSAFE_ENTRY', 'entry name is not valid UTF-8');
  }
}

function assertSafeName(name: string): void {
  const reject = (why: string): never => {
    throw new EvidencePackError('UNSAFE_ENTRY', `entry ${JSON.stringify(name)} ${why}`);
  };
  if (name === '') reject('has an empty name');
  if (name.includes('\0')) reject('contains a NUL byte');
  if (name.includes('\\')) reject('contains a backslash');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) reject('is an absolute path');
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  for (const segment of segments) {
    if (segment === '..') reject('traverses outside the archive');
    if (segment === '' || segment === '.') reject('has an empty or "." path segment');
  }
}

function enforceEntryLimits(record: CentralRecord, limits: ZipLimits): void {
  if (record.size > limits.maxEntryUncompressedBytes) {
    throw new EvidencePackError(
      'LIMIT_EXCEEDED',
      `entry ${JSON.stringify(record.name)} expands to ${record.size} bytes, limit ${limits.maxEntryUncompressedBytes}`,
    );
  }
  if (
    record.size >= RATIO_CHECK_MIN_BYTES &&
    record.size / Math.max(1, record.compressedSize) > limits.maxCompressionRatio
  ) {
    throw new EvidencePackError(
      'LIMIT_EXCEEDED',
      `entry ${JSON.stringify(record.name)} compression ratio exceeds ${limits.maxCompressionRatio}`,
    );
  }
}

function readEntryData(archive: Buffer, record: CentralRecord, dataRegionEnd: number): Buffer {
  const offset = record.localHeaderOffset;
  if (offset + LOCAL_HEADER_SIZE > dataRegionEnd || archive.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new EvidencePackError('CORRUPT', `bad local header for ${JSON.stringify(record.name)}`);
  }
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const localName = archive.subarray(offset + LOCAL_HEADER_SIZE, offset + LOCAL_HEADER_SIZE + nameLength);
  if (!localName.equals(Buffer.from(record.name, 'utf8'))) {
    throw new EvidencePackError(
      'CORRUPT',
      `local and central names differ for ${JSON.stringify(record.name)}`,
    );
  }
  const dataStart = offset + LOCAL_HEADER_SIZE + nameLength + extraLength;
  const dataEnd = dataStart + record.compressedSize;
  if (dataEnd > dataRegionEnd) {
    throw new EvidencePackError('CORRUPT', `data for ${JSON.stringify(record.name)} overruns the archive`);
  }
  const raw = archive.subarray(dataStart, dataEnd);

  let data: Buffer;
  if (record.method === METHOD_STORED) {
    data = Buffer.from(raw);
  } else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, record.size) });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new EvidencePackError('CORRUPT', `cannot inflate ${JSON.stringify(record.name)}: ${why}`);
    }
  }
  if (data.length !== record.size) {
    throw new EvidencePackError(
      'CORRUPT',
      `entry ${JSON.stringify(record.name)} size does not match its header`,
    );
  }
  if (crc32(data) !== record.crc32) {
    throw new EvidencePackError('CORRUPT', `entry ${JSON.stringify(record.name)} fails its CRC-32 check`);
  }
  return data;
}
