import {
  COMPARISON_EDGES,
  type ComparisonEdge,
  type DataContract,
  type EdgeComparison,
} from '@returntrip/contracts';
import { compareArtifacts } from './compare.ts';
import { baselineIdentityDefects, keyFieldIndexes } from './compare-unique-key.ts';
import type { CompareOptions, ParsedArtifact, RoundTripArtifacts, RoundTripVerdict } from './types.ts';

export interface RoundTripComparison {
  readonly edges: readonly EdgeComparison[];
  readonly verdict: RoundTripVerdict;
}

/**
 * Compares all three required edges. `invalid` means the trusted source itself failed the contract,
 * so no edge can prove anything; a defective export or re-export is the product failing, `mismatch`.
 * Every edge must pass for `equivalent`: a clean source→re-export cannot hide a broken export.
 */
export function compareRoundTrip(
  artifacts: RoundTripArtifacts,
  contract: DataContract,
  options: CompareOptions = {},
): RoundTripComparison {
  const { source, exported, reexported } = artifacts;
  assertRole(source, 'source');
  assertRole(exported, 'export');
  assertRole(reexported, 'reexport');

  const sides: Readonly<Record<ComparisonEdge, readonly [ParsedArtifact, ParsedArtifact]>> = {
    source_export: [source, exported],
    export_reexport: [exported, reexported],
    source_reexport: [source, reexported],
  };
  const edges = COMPARISON_EDGES.map((edge) => {
    const [expected, observed] = sides[edge];
    return compareArtifacts(expected, observed, contract, edge, options);
  });

  const verdict: RoundTripVerdict = !isTrustedBaseline(source, contract)
    ? 'invalid'
    : edges.every((edge) => edge.summary.isEquivalent)
      ? 'equivalent'
      : 'mismatch';
  return { edges, verdict };
}

function isTrustedBaseline(source: ParsedArtifact, contract: DataContract): boolean {
  if (!source.comparable || source.schemaErrors.length > 0) return false;
  if (contract.identity.mode === 'multiset') return true;
  const keyIndexes = keyFieldIndexes(contract, contract.identity.fields);
  return baselineIdentityDefects(source, keyIndexes, 'trusted source').length === 0;
}

function assertRole(artifact: ParsedArtifact, role: ParsedArtifact['artifact']): void {
  if (artifact.artifact !== role) {
    throw new Error(`expected the ${role} artifact, got one parsed as ${artifact.artifact}`);
  }
}
