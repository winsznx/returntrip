import { createHash } from 'node:crypto';
import type { DataContract } from '@returntrip/contracts';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with object keys sorted by code unit and arrays kept in order; undefined members are omitted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError(`cannot encode ${typeof value} as canonical JSON`);
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const members = Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${members.join(',')}}`;
}

export function canonicalContractHash(contract: DataContract): string {
  return sha256Hex(canonicalJson(contract));
}
