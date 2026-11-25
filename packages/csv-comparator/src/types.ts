import type { ArtifactSchemaError } from '@returntrip/contracts';

export type ArtifactName = ArtifactSchemaError['artifact'];

export type LineEndings = 'crlf' | 'lf' | 'mixed' | 'none';

export interface ParseOptions {
  readonly artifact: ArtifactName;
  readonly maxRows: number;
  /** UTF-8 byte limit per cell. Defaults to 64 KiB. */
  readonly maxFieldBytes?: number;
}

export interface CanonicalRow {
  /** 1-based data row number, header excluded. */
  readonly rowNumber: number;
  /** Raw cell text of the declared fields, keyed by field name. */
  readonly raw: Readonly<Record<string, string>>;
  /** Canonical values in declared-field order; null is a declared null, never an empty string. */
  readonly canonical: readonly (string | null)[];
  /** JSON encoding of `canonical`: unambiguous and usable as a grouping key. */
  readonly tupleKey: string;
}

export interface ParsedArtifact {
  readonly artifact: ArtifactName;
  readonly sha256: string;
  readonly byteLength: number;
  readonly bom: boolean;
  readonly lineEndings: LineEndings;
  /** Header cells exactly as they appear in the file, including dropped columns. */
  readonly header: readonly string[];
  /** Data rows read, valid and invalid. This is the denominator; invalid rows never leave it. */
  readonly rowCount: number;
  /** Rows whose every declared cell canonicalized, in file order. */
  readonly rows: readonly CanonicalRow[];
  readonly invalidRowCount: number;
  readonly schemaErrors: readonly ArtifactSchemaError[];
  /**
   * False when a structural defect (encoding, quoting, header, row limit) means the rows cannot be
   * trusted as a whole. Row-level defects leave the artifact comparable with those rows excluded.
   */
  readonly comparable: boolean;
  /** Hash of the contract the artifact was parsed against; comparison refuses mismatched contracts. */
  readonly contractHash: string;
}

export interface CompareOptions {
  /**
   * Multiset mode only. After exact matches cancel, pair the i-th residual missing row with the
   * i-th residual excess row and report FIELD_CHANGED, when both residual counts and both artifact
   * row counts are equal. Defaults to true.
   */
  readonly pairResidualsByOrder?: boolean;
}

export interface RoundTripArtifacts {
  readonly source: ParsedArtifact;
  readonly exported: ParsedArtifact;
  readonly reexported: ParsedArtifact;
}

export type RoundTripVerdict = 'equivalent' | 'mismatch' | 'invalid';
