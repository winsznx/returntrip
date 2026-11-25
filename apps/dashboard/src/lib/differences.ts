import type { Difference, DifferenceKind } from './types.ts';

/** Field changes on the same pair of rows are one record to a reader, so they render together. */
export interface RecordGroup {
  readonly key: string;
  readonly kind: DifferenceKind;
  readonly differences: readonly Difference[];
}

export function groupDifferences(differences: readonly Difference[]): RecordGroup[] {
  const groups: { key: string; kind: DifferenceKind; differences: Difference[] }[] = [];
  for (const difference of differences) {
    const last = groups.at(-1);
    const pair = `${difference.expectedRowRefs.join(',')}|${difference.observedRowRefs.join(',')}`;
    if (
      last &&
      difference.kind === 'FIELD_CHANGED' &&
      last.kind === 'FIELD_CHANGED' &&
      last.key.endsWith(`:${pair}`)
    ) {
      last.differences.push(difference);
      continue;
    }
    groups.push({ key: `${difference.id}:${pair}`, kind: difference.kind, differences: [difference] });
  }
  return groups;
}
