import { type ComparisonEdge, DIFFERENCE_KINDS, type Difference } from '@returntrip/contracts';
import { sha256Hex } from './hash.ts';

const ID_HEX_LENGTH = 16;
const KIND_RANK = new Map(DIFFERENCE_KINDS.map((kind, rank) => [kind, rank]));

export interface DraftDifference extends Omit<Difference, 'id' | 'edge'> {
  /** Key JSON, tuple JSON, or artifact side and row: what the difference is about. */
  readonly identity: string;
  /** Distinguishes repeated differences with the same identity and field. */
  readonly occurrence: number;
  /** Sort position ahead of identity, so row-paired changes read in file order. Defaults to 0. */
  readonly ordinal?: number;
}

/** Assigns stable ids and sorts by kind, position, identity, field and occurrence. */
export function finalizeDifferences(edge: ComparisonEdge, drafts: readonly DraftDifference[]): Difference[] {
  return [...drafts]
    .sort(compareDrafts)
    .map(({ identity, occurrence, ordinal: _ordinal, ...difference }) => ({
      id: differenceId(edge, difference.kind, identity, difference.field, occurrence),
      edge,
      ...difference,
    }));
}

function differenceId(
  edge: ComparisonEdge,
  kind: Difference['kind'],
  identity: string,
  field: string | undefined,
  occurrence: number,
): string {
  return sha256Hex(`${edge}|${kind}|${identity}|${field ?? ''}|${occurrence}`).slice(0, ID_HEX_LENGTH);
}

function compareDrafts(a: DraftDifference, b: DraftDifference): number {
  return (
    (KIND_RANK.get(a.kind) ?? 0) - (KIND_RANK.get(b.kind) ?? 0) ||
    (a.ordinal ?? 0) - (b.ordinal ?? 0) ||
    compareText(a.identity, b.identity) ||
    compareText(a.field ?? '', b.field ?? '') ||
    a.occurrence - b.occurrence
  );
}

/** Code-unit order: locale-independent, so every machine sorts the report identically. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
