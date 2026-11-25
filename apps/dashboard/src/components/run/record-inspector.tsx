import { useState } from 'react';

import { type CsvTable, parseCsv } from '../../lib/csv.ts';
import { groupDifferences, type RecordGroup } from '../../lib/differences.ts';
import {
  type EvidenceSource,
  edgeArtifacts,
  fetchText,
  findFile,
  KIND_LABELS,
  kindsPresent,
} from '../../lib/evidence.ts';
import { formatCount, plural } from '../../lib/format.ts';
import { comparisonFor, describeEdge, EDGE_LABELS, EDGES } from '../../lib/run-model.ts';
import type { AttemptReport, ComparisonEdge, DifferenceKind } from '../../lib/types.ts';
import { useResource } from '../../lib/use-resource.ts';
import { Icon } from '../icons.tsx';
import { LoadError, Loading } from '../state-message.tsx';

const PAGE_SIZE = 25;
const MAX_ROWS_PER_SIDE = 3;

interface RowContext {
  readonly expected: CsvTable | null;
  readonly observed: CsvTable | null;
}

async function loadRowContext(
  source: EvidenceSource,
  edge: ComparisonEdge,
  attempt: number,
  signal: AbortSignal,
): Promise<RowContext> {
  const sides = edgeArtifacts(edge, attempt);
  const read = async (side: { kind: string; attempt: number }): Promise<CsvTable | null> => {
    const file = findFile(source, side.kind, side.attempt);
    return file ? parseCsv(await fetchText(file.href, signal)) : null;
  };
  const [expected, observed] = await Promise.all([read(sides.expected), read(sides.observed)]);
  return { expected, observed };
}

export function RecordInspector({ source, attempt }: { source: EvidenceSource; attempt: AttemptReport }) {
  const [edge, setEdge] = useState<ComparisonEdge>('source_reexport');
  const [kind, setKind] = useState<DifferenceKind | ''>('');
  const [field, setField] = useState('');
  const [offset, setOffset] = useState(0);

  const summary = comparisonFor(attempt, edge);
  const broken = summary !== null && !summary.isEquivalent;
  const queryKey = `${source.runId}|${attempt.number}|${edge}|${kind}|${field}|${offset}`;
  const { resource, reload } = useResource(broken ? queryKey : null, (signal) =>
    source.differences(
      {
        attempt: attempt.number,
        edge,
        offset,
        limit: PAGE_SIZE,
        ...(kind ? { kind } : {}),
        ...(field ? { field } : {}),
      },
      signal,
    ),
  );
  const context = useResource(broken ? `${source.runId}|${attempt.number}|${edge}|rows` : null, (signal) =>
    loadRowContext(source, edge, attempt.number, signal),
  );

  const chooseEdge = (next: ComparisonEdge): void => {
    setEdge(next);
    setKind('');
    setField('');
    setOffset(0);
  };

  const labels = EDGE_LABELS[edge];
  const kinds = kindsPresent(summary);
  const fields = summary?.changedFields ?? [];

  return (
    <section aria-labelledby="inspector-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <h2 id="inspector-heading" className="text-[34px] sm:text-[44px]">
            Record by record
          </h2>
          <p className="max-w-[62ch] text-muted">
            Every record in the {labels.observed.toLowerCase()} is checked against the{' '}
            {labels.expected.toLowerCase()}. Values are shown exactly as the files hold them.
          </p>
        </div>
        <fieldset>
          <legend className="sr-only">Comparison</legend>
          <div className="segmented">
            {EDGES.map((item) => {
              const itemSummary = comparisonFor(attempt, item);
              return (
                <button
                  key={item}
                  type="button"
                  aria-pressed={item === edge}
                  onClick={() => chooseEdge(item)}
                >
                  {EDGE_LABELS[item].expected} vs {EDGE_LABELS[item].observed.toLowerCase()}
                  {itemSummary && !itemSummary.isEquivalent ? (
                    <>
                      <span className="ml-2 text-bad" aria-hidden="true">
                        ●
                      </span>
                      <span className="sr-only">, has differences</span>
                    </>
                  ) : null}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>

      {summary === null ? (
        <p className="panel px-5 py-6 text-muted">This comparison did not run in this attempt.</p>
      ) : summary.isEquivalent ? (
        <div className="panel tone-ok flex items-start gap-3 px-5 py-6">
          <Icon name="check" size={22} className="mt-0.5 shrink-0 text-ok" />
          <div>
            <p className="font-semibold text-ok">{describeEdge(summary)}</p>
            <p className="mt-1 text-muted">
              No differences on this comparison, so there is nothing to inspect. Every value, row count and
              duplicate came back as expected.
            </p>
          </div>
        </div>
      ) : (
        <>
          <p className="panel tone-bad px-5 py-4 font-semibold text-bad">{describeEdge(summary)}</p>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1.5 text-[14px] text-muted">
              Kind
              <select
                className="field-select"
                value={kind}
                onChange={(event) => {
                  const value = event.target.value;
                  setKind(kinds.find((item) => item === value) ?? '');
                  setOffset(0);
                }}
              >
                <option value="">All kinds</option>
                {kinds.map((item) => (
                  <option key={item} value={item}>
                    {KIND_LABELS[item]}
                  </option>
                ))}
              </select>
            </label>
            {fields.length > 0 ? (
              <label className="flex flex-col gap-1.5 text-[14px] text-muted">
                Field
                <select
                  className="field-select"
                  value={field}
                  onChange={(event) => {
                    setField(event.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">All fields</option>
                  {fields.map((item) => (
                    <option key={item.field} value={item.field}>
                      {item.field} ({formatCount(item.rows)})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          {resource.status === 'loading' ? <Loading label="Loading differences" /> : null}
          {resource.status === 'error' ? <LoadError error={resource.error} onRetry={reload} /> : null}
          {resource.status === 'ready' ? (
            <>
              <PageStatus
                offset={offset}
                shown={resource.data.differences.length}
                total={resource.data.total}
              />
              {resource.data.sample ? (
                <p className="text-[14px] text-muted">
                  This recorded run publishes the first {formatCount(resource.data.sample.size)} of{' '}
                  {plural(resource.data.sample.edgeTotal, 'difference')} on this comparison. The full list
                  stays in the run store of the machine that recorded it.
                </p>
              ) : null}
              <ol className="flex flex-col gap-4">
                {groupDifferences(resource.data.differences).map((group) => (
                  <li key={group.key}>
                    <RecordCard
                      group={group}
                      edge={edge}
                      context={context.resource.status === 'ready' ? context.resource.data : null}
                    />
                  </li>
                ))}
              </ol>
              <Pager
                offset={offset}
                total={resource.data.total}
                available={resource.data.sample ? resource.data.sample.size : resource.data.total}
                onChange={setOffset}
              />
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function PageStatus({ offset, shown, total }: { offset: number; shown: number; total: number }) {
  if (total === 0) return <p className="text-muted">No differences match these filters.</p>;
  return (
    <p className="text-[14px] text-muted" aria-live="polite">
      Showing {formatCount(offset + 1)} to {formatCount(offset + shown)} of {plural(total, 'difference')}
    </p>
  );
}

function Pager({
  offset,
  total,
  available,
  onChange,
}: {
  offset: number;
  total: number;
  available: number;
  onChange: (offset: number) => void;
}) {
  const limit = Math.min(total, available);
  if (limit <= PAGE_SIZE) return null;
  return (
    <nav aria-label="Difference pages" className="flex items-center gap-3">
      <button
        type="button"
        className="btn btn-small"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(offset - PAGE_SIZE, 0))}
      >
        Previous
      </button>
      <button
        type="button"
        className="btn btn-small"
        disabled={offset + PAGE_SIZE >= limit}
        onClick={() => onChange(offset + PAGE_SIZE)}
      >
        Next
      </button>
    </nav>
  );
}

function rowsAt(
  table: CsvTable | null,
  refs: readonly number[],
): { ref: number; cells: readonly string[] }[] {
  if (!table) return [];
  return refs.slice(0, MAX_ROWS_PER_SIDE).flatMap((ref) => {
    const cells = table.rows[ref - 1];
    return cells ? [{ ref, cells }] : [];
  });
}

function RecordCard({
  group,
  edge,
  context,
}: {
  group: RecordGroup;
  edge: ComparisonEdge;
  context: RowContext | null;
}) {
  const labels = EDGE_LABELS[edge];
  const first = group.differences[0];
  if (!first) return null;
  const changedFields = new Set(group.differences.flatMap((item) => (item.field ? [item.field] : [])));
  const expectedRows = rowsAt(context?.expected ?? null, first.expectedRowRefs);
  const observedRows = rowsAt(context?.observed ?? null, first.observedRowRefs);
  const header = context?.expected?.header ?? context?.observed?.header ?? null;
  const tone = group.kind === 'ORDER_CHANGED' ? 'tone-warn' : 'tone-bad';

  return (
    <article className="panel overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <span className={`badge badge-small ${tone}`}>{KIND_LABELS[group.kind]}</span>
        {changedFields.size > 0 ? (
          <span className="mono text-[14px]">{[...changedFields].join(', ')}</span>
        ) : null}
        <span className="text-[13px] text-muted">
          <RowRefs label={labels.expected} refs={first.expectedRowRefs} />
          {first.expectedRowRefs.length > 0 && first.observedRowRefs.length > 0 ? ', ' : null}
          <RowRefs label={labels.observed} refs={first.observedRowRefs} />
        </span>
      </header>

      {header && (expectedRows.length > 0 || observedRows.length > 0) ? (
        <div className="scroll-x">
          <table className="data-table">
            <caption className="sr-only">
              {labels.expected} and {labels.observed} rows for this difference
            </caption>
            <thead>
              <tr>
                <th scope="col">Side</th>
                {header.map((name) => (
                  <th key={name} scope="col" className={changedFields.has(name) ? 'text-text' : undefined}>
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {expectedRows.map((row) => (
                <RowLine
                  key={`e${row.ref}`}
                  side={`${labels.expected}, row ${formatCount(row.ref)}`}
                  header={header}
                  cells={row.cells}
                  changed={changedFields}
                  variant="expected"
                />
              ))}
              {observedRows.map((row) => (
                <RowLine
                  key={`o${row.ref}`}
                  side={`${labels.observed}, row ${formatCount(row.ref)}`}
                  header={header}
                  cells={row.cells}
                  changed={changedFields}
                  variant="observed"
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <FieldTable group={group} expectedLabel={labels.expected} observedLabel={labels.observed} />
      )}
      {group.kind !== 'FIELD_CHANGED' ? (
        <p className="border-t border-line px-4 py-3 text-[13px] text-muted">
          <span className="mono break-all">{first.message}</span>
        </p>
      ) : null}
    </article>
  );
}

function RowRefs({ label, refs }: { label: string; refs: readonly number[] }) {
  if (refs.length === 0) return null;
  const shown = refs.slice(0, 5).map((ref) => formatCount(ref));
  const more = refs.length > shown.length ? ` and ${formatCount(refs.length - shown.length)} more` : '';
  return (
    <>
      {label} {refs.length === 1 ? 'row' : 'rows'} <span className="mono text-text">{shown.join(', ')}</span>
      {more}
    </>
  );
}

function RowLine({
  side,
  header,
  cells,
  changed,
  variant,
}: {
  side: string;
  header: readonly string[];
  cells: readonly string[];
  changed: ReadonlySet<string>;
  variant: 'expected' | 'observed';
}) {
  return (
    <tr>
      <th scope="row" className="text-[13px]! font-medium! whitespace-nowrap">
        {side}
      </th>
      {header.map((name, index) => {
        const isChanged = changed.has(name);
        const className = isChanged
          ? variant === 'observed'
            ? 'changed-cell'
            : 'font-semibold text-text'
          : 'text-muted';
        return (
          <td key={name} className={`mono whitespace-pre ${className}`}>
            <RawValue value={cells[index] ?? null} />
          </td>
        );
      })}
    </tr>
  );
}

function FieldTable({
  group,
  expectedLabel,
  observedLabel,
}: {
  group: RecordGroup;
  expectedLabel: string;
  observedLabel: string;
}) {
  const withValues = group.differences.filter(
    (item) => item.expectedRaw !== undefined || item.observedRaw !== undefined,
  );
  if (withValues.length === 0) return null;
  return (
    <div className="scroll-x">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">{expectedLabel}</th>
            <th scope="col">{observedLabel}</th>
          </tr>
        </thead>
        <tbody>
          {withValues.map((item) => (
            <tr key={item.id}>
              <th scope="row" className="mono text-text!">
                {item.field ?? 'record'}
              </th>
              <td className="mono whitespace-pre font-semibold">
                <RawValue value={item.expectedRaw ?? null} />
              </td>
              <td className="mono whitespace-pre changed-cell">
                <RawValue value={item.observedRaw ?? null} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** CSV values are rendered as text nodes only. An empty cell is marked so it can't be mistaken for a space. */
export function RawValue({ value }: { value: string | null }) {
  if (value === null) return <span className="text-faint italic">absent</span>;
  if (value === '') return <span className="text-faint italic">empty</span>;
  return <>{value}</>;
}
