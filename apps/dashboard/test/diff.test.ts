import { describe, expect, it } from 'vitest';

import { displayPath, parseUnifiedDiff } from '../src/lib/diff.ts';

const SIGN_FLIP_FIX = [
  'diff --git a/src/import/import-payments.ts b/src/import/import-payments.ts',
  'index 0a6622d..4e56623 100644',
  '--- a/src/import/import-payments.ts',
  '+++ b/src/import/import-payments.ts',
  '@@ -98,8 +98,7 @@ function toPayment(cells: readonly string[], rowNumber: number): RowOutcome {',
  '     ok: true,',
  '     payment: {',
  '       voucherNumber: emptyToNull(voucherNumber),',
  '-      // Ledger convention: incomes are positive, payments out are negative.',
  '-      amountCents: -amountCents,',
  '+      amountCents,',
  '       checkDate,',
  '       departmentName: emptyToNull(departmentName),',
  '       contractNumber,',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('reads a git patch into one file with numbered lines', () => {
    // #given
    const text = SIGN_FLIP_FIX;
    // #when
    const [file, ...rest] = parseUnifiedDiff(text);
    // #then
    expect(rest).toHaveLength(0);
    expect(file && displayPath(file)).toBe('src/import/import-payments.ts');
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(2);
    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines).toHaveLength(9);
    expect(lines[3]).toMatchObject({ type: 'remove', oldNumber: 101, newNumber: null });
    expect(lines[5]).toMatchObject({
      type: 'add',
      text: '      amountCents,',
      oldNumber: null,
      newNumber: 101,
    });
    expect(lines[6]).toMatchObject({ type: 'context', oldNumber: 103, newNumber: 102 });
  });

  it('keeps a removed line that starts with "--" inside a hunk', () => {
    // #given
    const text = [
      '--- a/notes.sql',
      '+++ b/notes.sql',
      '@@ -1,2 +1,1 @@',
      '--- a SQL comment',
      ' select 1;',
    ].join('\n');
    // #when
    const [file] = parseUnifiedDiff(text);
    // #then
    expect(file?.hunks[0]?.lines.map((line) => [line.type, line.text])).toEqual([
      ['remove', '-- a SQL comment'],
      ['context', 'select 1;'],
    ]);
  });

  it('splits several files and marks created ones by their new path', () => {
    // #given
    const text = [
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1 @@',
      '+export {};',
      '--- a/old.ts',
      '+++ b/old.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '\\ No newline at end of file',
    ].join('\n');
    // #when
    const files = parseUnifiedDiff(text);
    // #then
    expect(files.map(displayPath)).toEqual(['new.ts', 'old.ts']);
    expect(files[0]?.oldPath).toBeNull();
    expect(files[1]?.hunks[0]?.lines.at(-1)?.type).toBe('note');
  });

  it('returns nothing for text that is not a diff', () => {
    // #given
    const text = 'no changes';
    // #when
    const files = parseUnifiedDiff(text);
    // #then
    expect(files).toEqual([]);
  });
});
