import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { Icon } from '../../components/icons.tsx';
import { ScenarioBadge } from '../../components/run/recorded-banner.tsx';
import { RunPage } from '../../components/run/run-page.tsx';
import { ErrorText, LoadError, Loading } from '../../components/state-message.tsx';
import { api, hasCsrf } from '../../lib/api.ts';
import {
  changesReport,
  type LiveSummary,
  summarizeEvents,
  timelineFromEvents,
  timelineFromReport,
} from '../../lib/events.ts';
import { localSource } from '../../lib/evidence.ts';
import { formatCount, formatCredits, formatElapsed } from '../../lib/format.ts';
import { outcomeMeta } from '../../lib/outcomes.ts';
import type { RunDetail, RunEvent } from '../../lib/types.ts';
import { useDocumentTitle } from '../../lib/use-document-title.ts';
import { useResource } from '../../lib/use-resource.ts';
import { type StreamState, useRunStream } from '../../lib/use-run-stream.ts';

const REFRESH_DELAY_MS = 400;

export function LiveRunPage() {
  const { id = '' } = useParams();
  return <LiveRun key={id} runId={id} />;
}

function LiveRun({ runId }: { runId: string }) {
  const { resource, reload } = useResource(runId, (signal) => api.run(runId, signal));
  const detail = resource.status === 'ready' ? resource.data : null;
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Events arrive in bursts (a replay on connect, a stage finishing), so the snapshot refetch is coalesced.
  const scheduleRefresh = (): void => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      reload();
    }, REFRESH_DELAY_MS);
  };
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const { events, state } = useRunStream(runId, {
    onEvent: (event: RunEvent) => {
      if (changesReport(event)) scheduleRefresh();
    },
    onResync: scheduleRefresh,
    isActive: () => detail?.active ?? true,
  });

  useDocumentTitle(detail ? `${detail.report.project} run ${runId.slice(0, 8)}` : 'Run');

  if (resource.status === 'loading') {
    return (
      <div className="shell">
        <Loading label="Loading the run" />
      </div>
    );
  }
  if (resource.status === 'error') {
    return (
      <div className="shell">
        <LoadError error={resource.error} onRetry={reload}>
          <p className="mt-2">
            <Link className="text-link" to="/runs">
              Back to all runs
            </Link>
          </p>
        </LoadError>
      </div>
    );
  }
  return <LiveRunView detail={resource.data} events={events} stream={state} onChanged={reload} />;
}

function LiveRunView({
  detail,
  events,
  stream,
  onChanged,
}: {
  detail: RunDetail;
  events: readonly RunEvent[];
  stream: StreamState;
  onChanged: () => void;
}) {
  const summary = useMemo(() => summarizeEvents(events), [events]);
  const active = detail.active && summary.finished === null;
  const source = useMemo(() => localSource(detail.report), [detail.report]);
  const timeline = useMemo(
    () => (events.length > 0 ? timelineFromEvents(events) : timelineFromReport(detail.report)),
    [events, detail.report],
  );
  const report =
    summary.finished && detail.report.outcome === null
      ? { ...detail.report, outcome: summary.finished.outcome, headline: summary.finished.headline }
      : detail.report;

  return (
    <RunPage
      report={report}
      source={source}
      active={active}
      timeline={timeline}
      banner={
        report.scenario ? (
          <div className="sticky top-16 z-30 border-b border-line bg-raised/95 backdrop-blur">
            <div className="shell flex min-h-12 items-center py-2">
              <ScenarioBadge scenario={report.scenario} />
            </div>
          </div>
        ) : null
      }
      status={
        <LiveStatus detail={detail} summary={summary} events={events} stream={stream} active={active} />
      }
      actions={<RunActions detail={detail} active={active} onChanged={onChanged} />}
    />
  );
}

const STREAM_LABELS: Readonly<Record<StreamState, string>> = {
  connecting: 'Connecting to the event stream',
  live: 'Live',
  reconnecting: 'Connection lost, reconnecting',
  ended: 'Stream closed',
};

function useElapsed(startedAt: string, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return Math.max(now - Date.parse(startedAt), 0);
}

function LiveStatus({
  detail,
  summary,
  events,
  stream,
  active,
}: {
  detail: RunDetail;
  summary: LiveSummary;
  events: readonly RunEvent[];
  stream: StreamState;
  active: boolean;
}) {
  const elapsed = useElapsed(detail.run.startedAt, active);
  const step = active ? currentKaneStep(events) : null;
  const announcement = summary.finished
    ? `Run finished: ${outcomeMeta(summary.finished.outcome).label}. ${summary.finished.headline}`
    : (summary.phaseMessage ?? '');
  const streamTone = stream === 'live' ? 'text-ok' : stream === 'reconnecting' ? 'text-warn' : 'text-muted';

  return (
    <div className="flex flex-col gap-3">
      <p className="sr-only-live" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px]">
        {active || stream !== 'ended' ? (
          <span className={`inline-flex items-center gap-2 ${streamTone}`}>
            <span className="live-dot" data-pulse={stream === 'live' && active} aria-hidden="true" />
            {STREAM_LABELS[stream]}
          </span>
        ) : null}
        {active ? (
          <>
            <span className="text-muted">
              Elapsed <span className="mono text-text">{formatElapsed(elapsed)}</span>
            </span>
            <span className="text-muted">
              Attempt{' '}
              <span className="mono text-text">{Math.max(summary.attempt, detail.run.activeAttempt)}</span>
            </span>
            <span className="text-muted">
              Kane credits{' '}
              <span className="mono text-text">
                {formatCredits(summary.kaneCreditsUsed ?? detail.run.kaneCreditsUsed)} of{' '}
                {formatCount(summary.kaneCreditsCap ?? detail.run.budget.maxKaneCredits)}
              </span>
            </span>
          </>
        ) : null}
      </div>
      {active ? (
        <div className="panel flex flex-col gap-1 px-4 py-3">
          <p className="font-semibold">{summary.phaseMessage ?? 'Waiting for the engine.'}</p>
          {step ? (
            <p className="text-[14px] text-muted">
              Kane, {step.stage} step {step.step}: <span className="text-text">{step.remark}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The latest Kane step of a stage that has started and not yet finished. */
function currentKaneStep(
  events: readonly RunEvent[],
): { stage: string; step: number; remark: string } | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!event) continue;
    if (event.type === 'browser.finished') return null;
    if (event.type === 'browser.progress') {
      return { stage: event.payload.stage, step: event.payload.step, remark: event.payload.remark };
    }
    if (event.type === 'browser.started')
      return { stage: event.payload.stage, step: 0, remark: 'Kane is starting.' };
  }
  return null;
}

type Action = 'cancel' | 'replay' | 'delete';

function RunActions({
  detail,
  active,
  onChanged,
}: {
  detail: RunDetail;
  active: boolean;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<Action | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const runId = detail.run.id;
  const canAct = hasCsrf();

  const act = async (action: Action, work: () => Promise<void>): Promise<void> => {
    setPending(action);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link className="btn btn-small" to="/runs">
          <Icon name="arrow-left" size={16} />
          All runs
        </Link>
        {active ? (
          <button
            type="button"
            className="btn btn-small btn-danger"
            disabled={!canAct || pending !== null || cancelRequested}
            onClick={() =>
              void act('cancel', async () => {
                await api.cancel(runId);
                setCancelRequested(true);
                onChanged();
              })
            }
          >
            <Icon name="stop" size={16} />
            {cancelRequested ? 'Canceling' : 'Cancel run'}
          </button>
        ) : null}
        {!active && detail.run.mode === 'verify' ? (
          <button
            type="button"
            className="btn btn-small"
            disabled={!canAct || pending !== null}
            onClick={() =>
              void act('replay', async () => {
                const started = await api.replay(runId);
                navigate(`/runs/${started.runId}`);
              })
            }
          >
            <Icon name="play" size={14} />
            {pending === 'replay' ? 'Starting' : 'Replay'}
          </button>
        ) : null}
        <a className="btn btn-small" href={api.reportUrl(runId, 'markdown')} target="_blank" rel="noreferrer">
          <Icon name="file" size={16} />
          Report
        </a>
        <a className="btn btn-small" href={api.reportUrl(runId, 'json')} target="_blank" rel="noreferrer">
          <Icon name="file" size={16} />
          Report JSON
        </a>
        {!active ? (
          <button
            type="button"
            className="btn btn-small btn-danger sm:ml-auto"
            disabled={!canAct || pending !== null}
            aria-expanded={confirmDelete}
            onClick={() => setConfirmDelete((open) => !open)}
          >
            Delete run
          </button>
        ) : null}
      </div>
      {confirmDelete && !active ? (
        <section
          className="panel tone-bad flex flex-wrap items-center gap-3 px-4 py-3"
          aria-label="Confirm delete"
        >
          <p className="text-[15px]">Delete this run and every file it captured? This cannot be undone.</p>
          <button
            type="button"
            className="btn btn-small btn-danger"
            disabled={pending !== null}
            onClick={() =>
              void act('delete', async () => {
                await api.remove(runId);
                navigate('/runs');
              })
            }
          >
            {pending === 'delete' ? 'Deleting' : 'Delete for good'}
          </button>
          <button type="button" className="btn btn-small" onClick={() => setConfirmDelete(false)}>
            Keep it
          </button>
        </section>
      ) : null}
      {!canAct ? (
        <p className="text-[14px] text-muted">
          Run controls need a session from the printed link. Reading this run works without one.
        </p>
      ) : null}
      {error ? (
        <p className="text-warn" role="alert">
          <ErrorText error={error} />
        </p>
      ) : null}
    </div>
  );
}
