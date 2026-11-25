export const COMPARISON_EDGES = ['source_export', 'export_reexport', 'source_reexport'] as const;
export type ComparisonEdge = (typeof COMPARISON_EDGES)[number];

export const EDGE_LABELS: Readonly<Record<ComparisonEdge, { expected: string; observed: string }>> = {
  source_export: { expected: 'trusted source', observed: 'first export' },
  export_reexport: { expected: 'first export', observed: 'export after restore' },
  source_reexport: { expected: 'trusted source', observed: 'export after restore' },
};

export const DIFFERENCE_KINDS = [
  'MISSING_KEY',
  'UNEXPECTED_KEY',
  'MISSING_OCCURRENCE',
  'EXCESS_OCCURRENCE',
  'DUPLICATE_KEY',
  'FIELD_CHANGED',
  'SCHEMA_INVALID',
  'ORDER_CHANGED',
] as const;
export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number];

export interface Difference {
  /** Stable across reruns on the same inputs: hash of edge, kind, key/tuple and field. */
  readonly id: string;
  readonly edge: ComparisonEdge;
  readonly kind: DifferenceKind;
  readonly key?: readonly string[];
  readonly field?: string;
  readonly expectedRaw?: string | null;
  readonly observedRaw?: string | null;
  readonly expectedCanonical?: string | null;
  readonly observedCanonical?: string | null;
  readonly expectedCount?: number;
  readonly observedCount?: number;
  /** 1-based data row numbers (header excluded) in each artifact. */
  readonly expectedRowRefs: readonly number[];
  readonly observedRowRefs: readonly number[];
  readonly message: string;
}

export interface EdgeSummary {
  readonly edge: ComparisonEdge;
  readonly isEquivalent: boolean;
  readonly expectedRows: number;
  readonly observedRows: number;
  readonly matchedIdenticalOccurrences: number;
  readonly missingKeyCount: number;
  readonly unexpectedKeyCount: number;
  readonly missingOccurrences: number;
  readonly excessOccurrences: number;
  readonly duplicateKeyCount: number;
  readonly changedKeyCount: number;
  readonly changedFieldCount: number;
  readonly schemaErrorCount: number;
  readonly orderMismatch: boolean;
  /** matchedIdenticalOccurrences / expectedRows, null when expectedRows is 0 or the artifact was invalid. */
  readonly preservationRate: number | null;
  /** Fields that differ, with how many rows each affects. Drives the one-line headline. */
  readonly changedFields: readonly { readonly field: string; readonly rows: number }[];
}

export interface EdgeComparison {
  readonly summary: EdgeSummary;
  readonly differences: readonly Difference[];
}

export interface ArtifactSchemaError {
  readonly artifact: 'source' | 'export' | 'reexport';
  readonly row: number | null;
  readonly column: string | null;
  readonly message: string;
}
