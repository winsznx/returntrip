import { describe, expect, it } from 'vitest';
import { compareArtifacts } from '../src/index.ts';
import { PAYMENTS_CONTRACT, parseText, toCsv } from './helpers.ts';

const ROWS = 50_000;
/*
 * Budget is on CPU time, not wall time: on a shared machine the scheduler can stretch wall time
 * arbitrarily, while CPU time tracks the work the comparator actually does.
 */
const CPU_BUDGET_MS = 5_000;
const WALL_TIMEOUT_MS = 120_000;

function paymentsCsv(rowCount: number, transform: (amount: string) => string = (amount) => amount): string {
  const header = PAYMENTS_CONTRACT.fields.map((field) => field.name);
  const rows: string[][] = [];
  for (let index = 0; index < rowCount; index++) {
    const cents = (index * 7919) % 10_000_000;
    const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    rows.push([
      index % 5 === 0 ? '' : `PV${String(index).padStart(11, '0')}`,
      transform(amount),
      index % 3 === 0 ? String(2000 + (index % 26)) : `0${1 + (index % 9)}/1${index % 9}/2023`,
      index % 4 === 0 ? '' : 'DEPARTMENT OF FINANCE',
      index % 2 === 0 ? 'DV' : String(10_000 + index),
      `VENDOR ${index % 997}, LLC`,
    ]);
  }
  return toCsv([header, ...rows], '\r\n');
}

describe('performance', () => {
  it(
    `parses and compares two ${ROWS.toLocaleString('en-US')}-row artifacts within budget`,
    () => {
      // #given a source and an export with every non-zero amount negated, the worst case for pairing
      const source = paymentsCsv(ROWS);
      const flipped = paymentsCsv(ROWS, (amount) => `-${amount}`);

      // #when
      const startedWall = performance.now();
      const startedCpu = process.cpuUsage();
      const result = compareArtifacts(
        parseText(source, PAYMENTS_CONTRACT, 'source'),
        parseText(flipped, PAYMENTS_CONTRACT, 'export'),
        PAYMENTS_CONTRACT,
        'source_export',
      );
      const wallMs = performance.now() - startedWall;
      const { user, system } = process.cpuUsage(startedCpu);
      const cpuMs = (user + system) / 1000;
      console.info(
        `csv-comparator: 2 x ${ROWS} rows x 6 columns parsed and compared in ` +
          `${cpuMs.toFixed(0)} ms CPU (${wallMs.toFixed(0)} ms wall)`,
      );

      // #then
      expect({ changedRows: result.summary.changedKeyCount, withinBudget: cpuMs < CPU_BUDGET_MS }).toEqual({
        changedRows: ROWS - 1,
        withinBudget: true,
      });
    },
    WALL_TIMEOUT_MS,
  );
});
