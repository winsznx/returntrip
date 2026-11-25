import type { ReactNode } from 'react';

import {
  formatCount,
  formatCredits,
  formatDateTime,
  formatDuration,
  formatRatio,
  formatUsd,
} from '../../lib/format.ts';
import { outcomeMeta } from '../../lib/outcomes.ts';
import { attemptLabel, type RecordCounts, recordCounts } from '../../lib/run-model.ts';
import type { AttemptReport, RunReport } from '../../lib/types.ts';
import { OutcomeBadge } from '../outcome-badge.tsx';

export function RunHeader({
  report,
  active,
  status,
}: {
  report: RunReport;
  active: boolean;
  /** Live state line for an active local run. */
  status?: ReactNode;
}) {
  const meta = outcomeMeta(report.outcome, active);
  const headline = report.headline ?? (active ? 'The run is in progress.' : meta.meaning);
  return (
    <header className="flex flex-col gap-5 pt-8">
      <div className="flex flex-wrap items-center gap-3">
        <OutcomeBadge outcome={report.outcome} active={active} />
        <span className="min-w-0 basis-full text-[15px] text-muted sm:basis-auto">{meta.meaning}</span>
      </div>
      <h1
        className={
          headline.length > 120
            ? 'max-w-[48ch] text-[28px] sm:text-[34px]'
            : headline.length > 70
              ? 'max-w-[36ch] text-[32px] sm:text-[42px]'
              : 'max-w-[22ch] text-[40px] sm:text-[56px]'
        }
      >
        {headline}
      </h1>
      {status}
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 border-y border-line py-5 text-[14px] sm:grid-cols-3 lg:grid-cols-6">
        <Fact term="Project">{report.project}</Fact>
        <Fact term="Mode">{report.mode === 'repair' ? 'Verify and repair' : 'Verify only'}</Fact>
        <Fact term="Started">{formatDateTime(report.startedAt)}</Fact>
        <Fact term="Wall time">
          {report.durationMs === null ? 'still running' : formatDuration(report.durationMs)}
        </Fact>
        <Fact term="Kane credits">
          <span className="mono">
            {formatCredits(report.kane.creditsUsed)} of {formatCount(report.kane.creditsCap)}
          </span>
        </Fact>
        <Fact term="Kane CLI">
          <span className="mono">{report.kane.version ?? 'unknown'}</span>
        </Fact>
        {report.mode === 'repair' ? (
          <Fact term="Claude Code spend">
            <span className="mono">{formatUsd(report.agent.usd)}</span>
          </Fact>
        ) : null}
        <Fact term="Run ID" wide>
          <span className="mono break-all">{report.runId}</span>
        </Fact>
        {report.baseRevision ? (
          <Fact term="App revision">
            <span className="mono">{report.baseRevision.slice(0, 12)}</span>
          </Fact>
        ) : null}
      </dl>
    </header>
  );
}

function Fact({ term, wide = false, children }: { term: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? 'col-span-2 min-w-0 sm:col-span-1' : 'min-w-0'}>
      <dt className="text-faint">{term}</dt>
      <dd className="mt-1 font-medium text-text">{children}</dd>
    </div>
  );
}

export function AttemptPicker({
  attempts,
  selected,
  onSelect,
}: {
  attempts: readonly AttemptReport[];
  selected: number;
  onSelect: (attempt: number) => void;
}) {
  if (attempts.length < 2) return null;
  return (
    <fieldset className="flex flex-wrap items-center gap-3">
      <legend className="sr-only">Attempt</legend>
      <span className="text-[14px] text-muted" aria-hidden="true">
        Showing
      </span>
      <div className="segmented">
        {attempts.map((attempt) => (
          <button
            key={attempt.number}
            type="button"
            aria-pressed={attempt.number === selected}
            onClick={() => onSelect(attempt.number)}
          >
            {attemptLabel(attempt)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Source, first export and restored export as three stops on the route, never assumed equal. */
export function RecordCountStrip({ attempt }: { attempt: AttemptReport | undefined }) {
  const counts: RecordCounts = recordCounts(attempt);
  const stops = [
    { label: 'Trusted source', value: counts.source },
    { label: 'First export', value: counts.firstExport },
    { label: 'Export after restore', value: counts.afterRestore },
  ];
  const broken = counts.source !== null && counts.preserved !== null && counts.preserved < counts.source;
  return (
    <section aria-labelledby="counts-heading" className="flex flex-col gap-6">
      <h2 id="counts-heading" className="sr-only">
        Record counts
      </h2>
      <ol className="route" style={{ '--stops': 3 }}>
        {stops.map((stop) => (
          <li key={stop.label} className="route-stop">
            <span className="route-dot" />
            <span className="font-display text-[40px] leading-none font-extrabold sm:text-[56px]">
              {stop.value === null ? 'n/a' : formatCount(stop.value)}
            </span>
            <span className="text-[14px] text-muted">{stop.label}</span>
          </li>
        ))}
      </ol>
      <div
        className={`panel flex flex-wrap items-baseline gap-x-6 gap-y-2 px-5 py-4 ${broken ? 'tone-bad' : 'tone-ok'}`}
      >
        {counts.preserved !== null && counts.source !== null ? (
          <>
            <p
              className="font-display text-[32px] leading-none font-extrabold"
              style={{ color: 'var(--tone)' }}
            >
              {formatRatio(counts.preserved, counts.source)}
            </p>
            <p className="text-[15px] text-muted">
              records identical to the trusted source after export, restore and export again
            </p>
            {counts.unexpected !== null ? (
              <p className="text-[15px] text-muted sm:ml-auto">
                <span className="mono text-text">{formatCount(counts.unexpected)}</span> unexpected{' '}
                {counts.unexpected === 1 ? 'record' : 'records'}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-[15px] text-muted">This attempt has not reached a comparison yet.</p>
        )}
      </div>
    </section>
  );
}
