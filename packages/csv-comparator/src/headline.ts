import type { EdgeSummary } from '@returntrip/contracts';

const NAMED_FIELD_LIMIT = 2;

/** One plain-English sentence built only from the summary's own counts. */
export function headline(summary: EdgeSummary): string {
  const expected = formatCount(summary.expectedRows);
  const nothingCompared =
    summary.matchedIdenticalOccurrences === 0 &&
    summary.missingOccurrences === 0 &&
    summary.excessOccurrences === 0 &&
    summary.changedKeyCount === 0;
  if (summary.schemaErrorCount > 0 && summary.preservationRate === null && nothingCompared) {
    return `Could not compare: ${plural(summary.schemaErrorCount, 'schema error')} in the artifacts`;
  }
  if (summary.isEquivalent) {
    return summary.expectedRows === 0
      ? 'Both artifacts have no data rows'
      : `All ${expected} of ${expected} rows came back unchanged`;
  }

  const issues: string[] = [];
  if (summary.missingOccurrences > 0) issues.push(`${plural(summary.missingOccurrences, 'row')} missing`);
  if (summary.excessOccurrences > 0) issues.push(plural(summary.excessOccurrences, 'extra row'));
  if (summary.duplicateKeyCount > 0) issues.push(plural(summary.duplicateKeyCount, 'duplicated key'));
  if (summary.schemaErrorCount > 0) issues.push(plural(summary.schemaErrorCount, 'schema error'));
  if (summary.orderMismatch) issues.push('rows in a different order');

  if (summary.changedFields.length > 0) {
    const returned = formatCount(summary.matchedIdenticalOccurrences + summary.changedKeyCount);
    const extra = issues.length > 0 ? `, plus ${joinList(issues)}` : '';
    return `${returned} of ${expected} rows came back, but ${describeChanges(summary.changedFields)}${extra}`;
  }
  return capitalize(
    `${joinList(issues)}, ${formatCount(summary.matchedIdenticalOccurrences)} of ${expected} preserved`,
  );
}

function describeChanges(changedFields: EdgeSummary['changedFields']): string {
  const named = changedFields
    .slice(0, NAMED_FIELD_LIMIT)
    .map(({ field, rows }, index) => `${field}${index === 0 ? ' changed' : ''} in ${plural(rows, 'row')}`);
  const unnamed = changedFields.length - named.length;
  if (unnamed > 0) named.push(plural(unnamed, 'other field'));
  return joinList(named);
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/** Thousands separators without Intl, so output is identical on every runtime and locale. */
export function formatCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
