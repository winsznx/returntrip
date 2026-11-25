import { describe, expect, it } from 'vitest';
import { canonicalContractHash, canonicalJson } from '../src/index.ts';
import { makeContract, PAYMENTS_CONTRACT } from './helpers.ts';

describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    // #given
    const value = { b: [3, { y: 1, x: 2 }], a: 'é' };

    // #when
    const encoded = canonicalJson(value);

    // #then
    expect(encoded).toBe('{"a":"é","b":[3,{"x":2,"y":1}]}');
  });

  it('omits undefined members the way JSON does', () => {
    // #given
    const value = { a: undefined, b: null };

    // #when
    const encoded = canonicalJson(value);

    // #then
    expect(encoded).toBe('{"b":null}');
  });

  it('throws for values JSON cannot represent', () => {
    // #given
    const value = { fn: (): void => undefined };

    // #when
    const run = (): string => canonicalJson([value.fn]);

    // #then
    expect(run).toThrow(TypeError);
  });
});

describe('canonicalContractHash', () => {
  it('ignores object key order', () => {
    // #given the same contract with members declared in reverse order
    const reversed = Object.fromEntries(Object.entries(PAYMENTS_CONTRACT).reverse());
    const rebuilt = makeContract(PAYMENTS_CONTRACT.fields, reversed);

    // #when
    const hashes = [canonicalContractHash(PAYMENTS_CONTRACT), canonicalContractHash(rebuilt)];

    // #then
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('changes when field order changes, because tuples are positional', () => {
    // #given
    const reordered = makeContract([...PAYMENTS_CONTRACT.fields].reverse());

    // #when
    const hashes = [canonicalContractHash(PAYMENTS_CONTRACT), canonicalContractHash(reordered)];

    // #then
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('is a 64-character hex sha256', () => {
    // #given
    const contract = PAYMENTS_CONTRACT;

    // #when
    const hash = canonicalContractHash(contract);

    // #then
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
