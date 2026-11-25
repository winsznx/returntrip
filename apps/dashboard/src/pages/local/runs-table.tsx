import { Link } from 'react-router';

import { OutcomeBadge } from '../../components/outcome-badge.tsx';
import { formatCredits, formatDateTime, formatDuration } from '../../lib/format.ts';
import type { ApiRun } from '../../lib/types.ts';

function wallTime(run: ApiRun): string {
  if (!run.finishedAt) return 'running';
  return formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt));
}

export function RunsTable({ runs }: { runs: readonly ApiRun[] }) {
  return (
    <div className="panel scroll-x">
      <table className="data-table min-w-180">
        <caption className="sr-only">Runs, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Outcome</th>
            <th scope="col">Project and result</th>
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
            <tr key={run.id}>
              <td className="whitespace-nowrap">
                <Link className="text-link" to={`/runs/${run.id}`}>
                  {formatDateTime(run.startedAt)}
                </Link>
                <span className="mono mt-1 block text-[12px] text-faint">{run.id.slice(0, 8)}</span>
              </td>
              <td>
                <OutcomeBadge outcome={run.outcome} active={run.status === 'active'} small />
              </td>
              <td className="min-w-[18rem]">
                <p className="font-semibold">
                  {run.project}
                  <span className="ml-2 text-[13px] font-normal text-muted">
                    {run.mode === 'repair' ? 'verify and repair' : 'verify only'}
                  </span>
                </p>
                <p className="mt-1 text-[14px] text-muted">
                  {run.headline ??
                    (run.status === 'active'
                      ? `In progress: ${run.phase.toLowerCase().replaceAll('_', ' ')}`
                      : 'No headline')}
                </p>
              </td>
              <td className="mono text-right whitespace-nowrap">{formatCredits(run.kaneCreditsUsed)}</td>
              <td className="mono text-right whitespace-nowrap">{wallTime(run)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
