import { Link } from 'react-router';

import { OutcomeBadge } from '../../components/outcome-badge.tsx';
import { LoadError, Loading } from '../../components/state-message.tsx';
import { loadPublicIndex } from '../../lib/evidence.ts';
import { formatCredits, formatDate, formatDuration } from '../../lib/format.ts';
import { recordedTotals } from '../../lib/recorded.ts';
import type { PublicIndexEntry } from '../../lib/types.ts';
import { useDocumentTitle } from '../../lib/use-document-title.ts';
import { useResource } from '../../lib/use-resource.ts';
import { RecordedTotalsLine } from './recorded-totals.tsx';

export function RecordedRunsPage() {
  useDocumentTitle('Recorded runs');
  const { resource, reload } = useResource('index', (signal) => loadPublicIndex(signal));
  return (
    <div className="shell flex flex-col gap-8 pt-12">
      <div className="flex flex-col gap-3">
        <h1 className="text-[48px] sm:text-[64px]">Recorded runs</h1>
        <p className="max-w-[60ch] text-muted">
          Real runs of ReturnTrip and Kane CLI, saved with their files, hashes and screenshots. Each page is a
          copy of one finished run. Nothing here starts a new one.
        </p>
      </div>
      {resource.status === 'loading' ? <Loading label="Loading recorded runs" /> : null}
      {resource.status === 'error' ? <LoadError error={resource.error} onRetry={reload} /> : null}
      {resource.status === 'ready' ? (
        resource.data.runs.length === 0 ? (
          <p className="text-muted">No runs have been published yet.</p>
        ) : (
          <>
            <RecordedTotalsLine totals={recordedTotals(resource.data.runs)} />
            <RecordedRunsTable runs={resource.data.runs} />
          </>
        )
      ) : null}
    </div>
  );
}

export function RecordedRunsTable({ runs }: { runs: readonly PublicIndexEntry[] }) {
  return (
    <div className="panel scroll-x">
      <table className="data-table min-w-[720px]">
        <caption className="sr-only">Recorded runs, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Recorded</th>
            <th scope="col">Outcome</th>
            <th scope="col">What happened</th>
            <th scope="col" className="text-right!">
              Kane credits
            </th>
            <th scope="col" className="text-right!">
              Wall time
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runId}>
              <td className="whitespace-nowrap">
                <Link className="text-link" to={`/runs/${run.runId}`}>
                  {formatDate(run.recordedAt)}
                </Link>
                <span className="mono mt-1 block text-[12px] text-faint">{run.runId.slice(0, 8)}</span>
              </td>
              <td>
                <OutcomeBadge outcome={run.outcome} small />
              </td>
              <td className="min-w-[18rem]">
                <p>{run.headline ?? 'No headline was recorded.'}</p>
                <p className="mt-1 text-[13px] text-muted">
                  {run.scenario ? `Recreated defect: ${run.scenario}` : 'Unmodified app'}
                  {run.mode === 'repair' ? ', repair allowed' : ', verify only'}
                </p>
              </td>
              <td className="mono text-right whitespace-nowrap">{formatCredits(run.kaneCreditsUsed)}</td>
              <td className="mono text-right whitespace-nowrap">{formatDuration(run.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
