import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Icon } from '../../components/icons.tsx';
import { ScenarioBadge } from '../../components/run/recorded-banner.tsx';
import { ErrorText, LoadError, Loading, RelaunchHint } from '../../components/state-message.tsx';
import { api, hasCsrf } from '../../lib/api.ts';
import { formatCount, formatDuration, shortHash } from '../../lib/format.ts';
import type { ProjectSummary } from '../../lib/types.ts';
import { useDocumentTitle } from '../../lib/use-document-title.ts';
import { useResource } from '../../lib/use-resource.ts';
import { RunsTable } from './runs-table.tsx';

export function ProjectsPage() {
  useDocumentTitle('Projects');
  const projects = useResource('projects', (signal) => api.projects(signal));
  const recent = useResource('recent-runs', (signal) => api.runs({ limit: 5 }, signal));
  const canAct = hasCsrf();

  return (
    <div className="shell flex flex-col gap-12 pt-12">
      <div className="flex flex-col gap-3">
        <h1 className="text-[48px] sm:text-[64px]">Projects</h1>
        <p className="max-w-[60ch] text-muted">
          Each project is a config passed to <span className="mono text-text">returntrip ui</span>. Verify
          runs the round trip and never edits code. Repair asks first, then lets Claude Code patch a
          disposable copy.
        </p>
      </div>

      {!canAct ? (
        <p className="panel tone-warn flex items-start gap-3 p-4 text-warn" role="status">
          <Icon name="alert" size={18} className="mt-0.5 shrink-0" />
          <span>
            You can read runs, but starting or stopping one needs a fresh session. <RelaunchHint />
          </span>
        </p>
      ) : null}

      {projects.resource.status === 'loading' ? <Loading label="Loading projects" /> : null}
      {projects.resource.status === 'error' ? (
        <LoadError error={projects.resource.error} onRetry={projects.reload} />
      ) : null}
      {projects.resource.status === 'ready' ? (
        projects.resource.data.projects.length === 0 ? (
          <div className="panel p-6">
            <p className="font-semibold">No projects are loaded.</p>
            <p className="mt-2 text-muted">
              Start the dashboard with a config:{' '}
              <span className="mono text-text">returntrip ui --config returntrip.yaml</span>. To write one,
              run <span className="mono text-text">returntrip init --source your-data.csv</span>.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-6">
            {projects.resource.data.projects.map((project) => (
              <li key={project.id}>
                <ProjectCard project={project} canAct={canAct} onChanged={projects.reload} />
              </li>
            ))}
          </ul>
        )
      ) : null}

      <section aria-labelledby="recent-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="recent-heading" className="text-[34px] sm:text-[44px]">
            Recent runs
          </h2>
          <Link className="text-link" to="/runs">
            All runs
          </Link>
        </div>
        {recent.resource.status === 'loading' ? <Loading label="Loading runs" /> : null}
        {recent.resource.status === 'error' ? (
          <LoadError error={recent.resource.error} onRetry={recent.reload} />
        ) : null}
        {recent.resource.status === 'ready' ? (
          recent.resource.data.runs.length === 0 ? (
            <p className="text-muted">No runs yet. Verify a project above to start the first one.</p>
          ) : (
            <RunsTable runs={recent.resource.data.runs} />
          )
        ) : null}
      </section>
    </div>
  );
}

type Pending = 'verify' | 'repair' | 'validate' | null;

function ProjectCard({
  project,
  canAct,
  onChanged,
}: {
  project: ProjectSummary;
  canAct: boolean;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<unknown>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const busy = pending !== null || project.activeRunId !== null;

  const act = async (kind: Exclude<Pending, null>, work: () => Promise<void>): Promise<void> => {
    setPending(kind);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(caught);
      onChanged();
    } finally {
      setPending(null);
    }
  };

  const verify = (): Promise<void> =>
    act('verify', async () => {
      const started = await api.startRun({ projectId: project.id, mode: 'verify' });
      navigate(`/runs/${started.runId}`);
    });

  const repair = (): Promise<void> =>
    act('repair', async () => {
      const { authorization } = await api.authorizeRepair(project.id);
      const started = await api.startRun({ projectId: project.id, mode: 'repair', authorization });
      navigate(`/runs/${started.runId}`);
    });

  const validate = (): Promise<void> =>
    act('validate', async () => {
      const result = await api.validate(project.id);
      setValidation(
        result.ok ? `The config is valid. Config hash ${shortHash(result.configHash, 16)}.` : result.message,
      );
    });

  return (
    <article className="panel flex flex-col gap-6 p-5 sm:p-6" aria-labelledby={`project-${project.id}`}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id={`project-${project.id}`} className="text-[34px]">
            {project.name}
          </h2>
          {project.scenario ? <ScenarioBadge scenario={project.scenario} /> : null}
        </div>
        <p className="mono text-[13px] break-all text-muted">{project.configPath}</p>
      </header>

      {project.activeRunId ? (
        <p className="flex flex-wrap items-center gap-3 rounded-lg border border-route-deep bg-raised-2 px-4 py-3">
          <span className="live-dot text-route" data-pulse="true" aria-hidden="true" />
          <span>A run is in progress for this project.</span>
          <Link className="text-link" to={`/runs/${project.activeRunId}`}>
            Open the active run
          </Link>
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-[14px] md:grid-cols-4">
        <div className="col-span-2">
          <dt className="text-faint">Fields checked</dt>
          <dd className="mono mt-1">{project.fields.map((field) => field.name).join(', ')}</dd>
        </div>
        <div>
          <dt className="text-faint">Records matched by</dt>
          <dd className="mt-1">
            {project.identity === 'multiset' ? 'Whole record, duplicates counted' : 'Key fields'}
          </dd>
        </div>
        <div>
          <dt className="text-faint">Trusted source</dt>
          <dd className="mono mt-1">sha256 {shortHash(project.sourceSha256)}</dd>
        </div>
        <div>
          <dt className="text-faint">Kane credit cap</dt>
          <dd className="mono mt-1">{formatCount(project.limits.maxKaneCredits)}</dd>
        </div>
        <div>
          <dt className="text-faint">Per-stage timeout</dt>
          <dd className="mono mt-1">{formatDuration(project.limits.browserRunTimeoutMs)}</dd>
        </div>
        <div>
          <dt className="text-faint">App</dt>
          <dd className="mt-1">{project.mode === 'managed' ? 'Started by ReturnTrip' : 'Already running'}</dd>
        </div>
        <div>
          <dt className="text-faint">Repair</dt>
          <dd className="mt-1">
            {project.repairEnabled
              ? `Up to ${project.limits.maxRepairAttempts} attempts`
              : 'Off in this config'}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canAct || busy}
          onClick={() => void verify()}
        >
          {pending === 'verify' ? 'Starting' : 'Verify'}
        </button>
        {project.repairEnabled ? (
          <button
            type="button"
            className="btn"
            disabled={!canAct || busy}
            aria-expanded={consentOpen}
            aria-controls={`consent-${project.id}`}
            onClick={() => setConsentOpen((open) => !open)}
          >
            Repair
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-small"
          disabled={!canAct || pending !== null}
          onClick={() => void validate()}
        >
          {pending === 'validate' ? 'Checking' : 'Check config'}
        </button>
      </div>

      {consentOpen && project.repairEnabled ? (
        <RepairConsent
          project={project}
          starting={pending === 'repair'}
          disabled={!canAct || busy}
          onAllow={() => void repair()}
          onClose={() => setConsentOpen(false)}
        />
      ) : null}

      {validation ? (
        <p className="text-[14px] text-muted" role="status">
          {validation}
        </p>
      ) : null}
      {error ? (
        <p className="text-warn" role="alert">
          <ErrorText error={error} />
        </p>
      ) : null}
    </article>
  );
}

function RepairConsent({
  project,
  starting,
  disabled,
  onAllow,
  onClose,
}: {
  project: ProjectSummary;
  starting: boolean;
  disabled: boolean;
  onAllow: () => void;
  onClose: () => void;
}) {
  return (
    <section
      id={`consent-${project.id}`}
      aria-labelledby={`consent-heading-${project.id}`}
      className="flex flex-col gap-4 rounded-lg border border-line-strong bg-sunken p-5"
    >
      <h3 id={`consent-heading-${project.id}`} className="text-[28px]">
        Before Claude Code edits anything
      </h3>
      <p className="text-muted">
        ReturnTrip first runs the normal round trip. Only if records come back different does Claude Code get
        the evidence and patch a disposable copy of the app. Kane then reruns the same journey on that copy.
      </p>
      <div>
        <p className="font-semibold">Claude Code may change files only under:</p>
        <ul className="mono mt-2 flex flex-wrap gap-2 text-[14px]">
          {project.repairPaths.map((path) => (
            <li key={path} className="rounded-md border border-line bg-raised px-2 py-1">
              {path}
            </li>
          ))}
        </ul>
      </div>
      <ul className="flex flex-col gap-1.5 text-[15px]">
        <li>
          At most <span className="mono">{project.limits.maxRepairAttempts}</span> repair attempts.
        </li>
        <li>
          Kane may spend up to <span className="mono">{formatCount(project.limits.maxKaneCredits)}</span>{' '}
          credits on this run, reruns included.
        </li>
        <li>
          Claude Code's spend cap is <span className="mono">repair.maxAgentBudgetUsd</span> in this config.
        </li>
        <li>The trusted source and the contract stay locked. Nothing is merged, pushed or deployed.</li>
      </ul>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary" disabled={disabled} onClick={onAllow}>
          {starting ? 'Starting' : 'Allow and start repair'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Not now
        </button>
      </div>
    </section>
  );
}
