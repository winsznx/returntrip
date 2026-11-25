import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getKaneVersion, parseKaneBalance, parseKaneVersion } from '../src/cli-info.ts';

describe('parseKaneVersion', () => {
  it('reads the bare version kane-cli 0.10.9 prints', () => {
    // #given the exact `kane-cli --version` output observed on 0.10.9
    const output = '0.10.9\n';

    // #when it is parsed
    const version = parseKaneVersion(output);

    // #then the version is returned
    expect(version).toBe('0.10.9');
  });

  it('keeps a prerelease suffix', () => {
    // #given a prefixed prerelease version
    const output = 'kane-cli v0.11.0-beta.2\n';

    // #when it is parsed
    const version = parseKaneVersion(output);

    // #then the suffix survives
    expect(version).toBe('0.11.0-beta.2');
  });

  it('returns null when no version is present', () => {
    // #given unrelated output
    const output = 'command not recognized\n';

    // #when it is parsed
    const version = parseKaneVersion(output);

    // #then nothing is guessed
    expect(version).toBeNull();
  });
});

describe('parseKaneBalance', () => {
  it('reads the balance line kane-cli 0.10.9 prints', () => {
    // #given the exact `kane-cli balance` output observed on 0.10.9
    const output = 'Available credits: 11119.5297\n';

    // #when it is parsed
    const balance = parseKaneBalance(output);

    // #then the decimal balance is returned
    expect(balance).toBe(11119.5297);
  });

  it('ignores a skill update notice around the balance', () => {
    // #given a notice before and after the balance line, with CRLF endings
    const output =
      'Skill update available: 1.2.0 -> 1.3.0\r\nAvailable credits: 42\r\nSkill update available, run kane-cli install skill\r\n';

    // #when it is parsed
    const balance = parseKaneBalance(output);

    // #then only the balance is read
    expect(balance).toBe(42);
  });

  it('returns null when logged out', () => {
    // #given output without a balance line
    const output = 'Not logged in. Run kane-cli login.\n';

    // #when it is parsed
    const balance = parseKaneBalance(output);

    // #then the balance is unknown rather than zero
    expect(balance).toBeNull();
  });

  it('returns null for a balance line that is not a number', () => {
    // #given a malformed balance
    const output = 'Available credits: unlimited\n';

    // #when it is parsed
    const balance = parseKaneBalance(output);

    // #then it is rejected
    expect(balance).toBeNull();
  });
});

describe('getKaneVersion', () => {
  it('rejects when the binary cannot be started', async () => {
    // #given a binary path that does not exist
    const missing = join(import.meta.dirname, 'no-such-kane-cli');

    // #when the version is requested
    const request = getKaneVersion(missing);

    // #then the spawn failure surfaces
    await expect(request).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
