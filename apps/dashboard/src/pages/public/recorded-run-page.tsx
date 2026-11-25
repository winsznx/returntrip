import { useMemo } from 'react';
import { Link, useParams } from 'react-router';

import { Icon } from '../../components/icons.tsx';
import { RecordedBanner } from '../../components/run/recorded-banner.tsx';
import { RunPage } from '../../components/run/run-page.tsx';
import { LoadError, Loading } from '../../components/state-message.tsx';
import { timelineFromReport } from '../../lib/events.ts';
import { evidenceUrl, loadPublicRun, recordedSource } from '../../lib/evidence.ts';
import type { PublicRun } from '../../lib/types.ts';
import { useDocumentTitle } from '../../lib/use-document-title.ts';
import { useResource } from '../../lib/use-resource.ts';

export function RecordedRunPage() {
  const { id = '' } = useParams();
  const { resource, reload } = useResource(id, (signal) => loadPublicRun(id, signal));
  useDocumentTitle(resource.status === 'ready' ? `Recorded run ${id.slice(0, 8)}` : 'Recorded run');

  if (resource.status === 'loading')
    return (
      <div className="shell">
        <Loading label="Loading the recorded run" />
      </div>
    );
  if (resource.status === 'error') {
    return (
      <div className="shell">
        <LoadError error={resource.error} onRetry={reload}>
          <p className="mt-2 text-muted">
            <Link className="text-link" to="/runs">
              See all recorded runs
            </Link>
          </p>
        </LoadError>
      </div>
    );
  }
  return <RecordedRun run={resource.data} />;
}

function RecordedRun({ run }: { run: PublicRun }) {
  const source = useMemo(() => recordedSource(run), [run]);
  const timeline = useMemo(() => timelineFromReport(run.report), [run]);
  return (
    <RunPage
      report={run.report}
      source={source}
      active={false}
      timeline={timeline}
      banner={<RecordedBanner recordedAt={run.recordedAt} scenario={run.report.scenario} />}
      actions={
        <>
          <Link className="btn btn-small" to="/runs">
            <Icon name="arrow-left" size={16} />
            All recorded runs
          </Link>
          <a className="btn btn-small" href={evidenceUrl(`${run.report.runId}/run.json`)} download>
            <Icon name="download" size={16} />
            Run record (JSON)
          </a>
          {run.commit ? (
            <span className="text-[14px] text-muted">
              ReturnTrip commit <span className="mono text-text">{run.commit.slice(0, 12)}</span>
            </span>
          ) : null}
        </>
      }
    />
  );
}
