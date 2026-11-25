import { displayPath, parseUnifiedDiff } from '../../lib/diff.ts';
import { type EvidenceSource, type FileRef, fetchText } from '../../lib/evidence.ts';
import { formatDuration, formatRatio, formatUsd, shortHash } from '../../lib/format.ts';
import { comparisonFor, describeEdge } from '../../lib/run-model.ts';
import type { AttemptReport, RepairEntry, RunReport } from '../../lib/types.ts';
import { useResource } from '../../lib/use-resource.ts';
import { Icon } from '../icons.tsx';
import { LoadError, Loading } from '../state-message.tsx';

const REPAIR_STATUS: Readonly<Record<string, string>> = {
  patch: 'Patch proposed',
  no_patch: 'No patch proposed',
  denied: 'Agent declined',
  timeout: 'Timed out',
  agent_error: 'Agent error',
};

/** The patch the final attempt ran on, or the last patch that passed validation. */
export function acceptedRepair(report: RunReport): RepairEntry | null {
  const finalPatch = report.attempts.at(-1)?.patchSha256 ?? null;
  const applied = report.repairs.filter((repair) => repair.reason === null && repair.patchSha256 !== null);
  return applied.find((repair) => repair.patchSha256 === finalPatch) ?? applied.at(-1) ?? null;
}

function patchFile(source: EvidenceSource, repair: RepairEntry | null): FileRef | null {
  const patches = source.files().filter((file) => file.kind === 'patch');
  if (!repair) return null;
  return (
    patches.find((file) => file.sha256 === repair.patchSha256) ??
    patches.find((file) => file.name === `repair-${repair.attempt}.patch`) ??
    null
  );
}

export function RepairPanel({ report, source }: { report: RunReport; source: EvidenceSource }) {
  if (report.repairs.length === 0) return null;
  const accepted = acceptedRepair(report);
  const patch = patchFile(source, accepted);
  const first = report.attempts[0];
  const last = report.attempts.at(-1);

  return (
    <section aria-labelledby="repair-heading" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 id="repair-heading" className="text-[34px] sm:text-[44px]">
          The repair
        </h2>
        <p className="max-w-[62ch] text-muted">
          Claude Code read the evidence above and patched a disposable copy of the app. The contract and the
          trusted source were locked. Kane then ran the same journey again on the patched copy. Nothing was
          merged or deployed.
        </p>
      </div>

      {first && last && first !== last ? <BeforeAfter first={first} last={last} /> : null}

      <ol className="flex flex-col gap-3">
        {report.repairs.map((repair) => (
          <li key={`${repair.attempt}-${repair.createdAt}`}>
            <RepairAttempt repair={repair} accepted={repair === accepted} />
          </li>
        ))}
      </ol>

      {accepted ? (
        patch ? (
          <PatchView file={patch} />
        ) : (
          <p className="text-muted">The patch file for this repair is not part of this record.</p>
        )
      ) : (
        <p className="text-muted">No patch passed validation, so there is no patch to show.</p>
      )}
    </section>
  );
}

function Verdict({ attempt, label }: { attempt: AttemptReport; label: string }) {
  const summary = comparisonFor(attempt, 'source_reexport');
  const ok = summary?.isEquivalent ?? false;
  return (
    <div className={`panel flex flex-col gap-3 p-5 ${ok ? 'tone-ok' : 'tone-bad'}`}>
      <p className="text-[14px] text-muted">{label}</p>
      {summary ? (
        <>
          <p
            className="font-display text-[44px] leading-none font-extrabold"
            style={{ color: 'var(--tone)' }}
          >
            {formatRatio(summary.matchedIdenticalOccurrences, summary.expectedRows)}
          </p>
          <p className="flex items-start gap-2">
            <Icon name={ok ? 'check' : 'cross'} size={18} className="mt-0.5 shrink-0" />
            <span>{describeEdge(summary)}</span>
          </p>
        </>
      ) : (
        <p className="text-muted">This attempt did not reach a comparison.</p>
      )}
    </div>
  );
}

function BeforeAfter({ first, last }: { first: AttemptReport; last: AttemptReport }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Verdict
        attempt={first}
        label={`Before: attempt ${first.number}, trusted source vs export after restore`}
      />
      <Verdict attempt={last} label={`After: attempt ${last.number}, same journey on the patched copy`} />
    </div>
  );
}

function RepairAttempt({ repair, accepted }: { repair: RepairEntry; accepted: boolean }) {
  const rejected = repair.reason !== null;
  return (
    <article className="panel flex flex-col gap-4 p-5">
      <header className="flex flex-wrap items-center gap-3">
        <h3 className="font-display text-[24px] font-bold">Repair {repair.attempt}</h3>
        <span className={`badge badge-small ${rejected ? 'tone-bad' : 'tone-ok'}`}>
          <Icon name={rejected ? 'cross' : 'check'} size={14} />
          {rejected
            ? 'Rejected'
            : repair.status === 'patch'
              ? 'Patch accepted'
              : (REPAIR_STATUS[repair.status] ?? repair.status)}
        </span>
        {accepted ? (
          <span className="text-[14px] text-muted">This patch is the one verified below.</span>
        ) : null}
      </header>
      {repair.cause ? (
        <p>
          <span className="text-muted">Cause, as Claude Code stated it: </span>
          {repair.cause}
        </p>
      ) : null}
      {repair.reason ? (
        <p className="text-bad">
          <span className="font-semibold">Why it was rejected: </span>
          {repair.reason}
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[14px] md:grid-cols-5">
        <div className="col-span-2 md:col-span-2">
          <dt className="text-faint">Files</dt>
          <dd className="mono break-all">{repair.files.length > 0 ? repair.files.join(', ') : 'none'}</dd>
        </div>
        <div>
          <dt className="text-faint">Lines changed</dt>
          <dd className="mono">{repair.linesChanged}</dd>
        </div>
        <div>
          <dt className="text-faint">Cost</dt>
          <dd className="mono">{formatUsd(repair.costUsd)}</dd>
        </div>
        <div>
          <dt className="text-faint">Time</dt>
          <dd className="mono">{formatDuration(repair.durationMs)}</dd>
        </div>
        <div className="col-span-2 md:col-span-3">
          <dt className="text-faint">Models</dt>
          <dd className="mono break-all">
            {repair.models.length > 0 ? repair.models.join(', ') : 'not reported'}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-faint">Patch sha256</dt>
          <dd className="mono">{shortHash(repair.patchSha256, 16)}</dd>
        </div>
      </dl>
    </article>
  );
}

function PatchView({ file }: { file: FileRef }) {
  const { resource, reload } = useResource(file.href, (signal) => fetchText(file.href, signal));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-[28px] font-bold">The accepted patch</h3>
        <a className="btn btn-small" href={file.href} download={file.name}>
          <Icon name="download" size={16} />
          Download {file.name}
        </a>
      </div>
      {resource.status === 'loading' ? <Loading label="Loading the patch" /> : null}
      {resource.status === 'error' ? <LoadError error={resource.error} onRetry={reload} /> : null}
      {resource.status === 'ready' ? <DiffView text={resource.data} /> : null}
    </div>
  );
}

export function DiffView({ text }: { text: string }) {
  const files = parseUnifiedDiff(text);
  if (files.length === 0) return <p className="text-muted">The patch is empty.</p>;
  return (
    <div className="flex flex-col gap-4">
      {files.map((file) => (
        <div key={displayPath(file)} className="panel overflow-hidden">
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-raised-2 px-4 py-2.5">
            <span className="mono text-[14px] break-all">{displayPath(file)}</span>
            <span className="mono text-[13px] text-ok">+{file.additions}</span>
            <span className="mono text-[13px] text-bad">-{file.deletions}</span>
          </p>
          <div className="scroll-x bg-sunken">
            <div className="min-w-max">
              {file.hunks.map((hunk) => (
                <div key={hunk.header}>
                  <p className="mono px-4 py-1 text-[13px] text-route">{hunk.header}</p>
                  {hunk.lines.map((line) => (
                    <div
                      key={line.id}
                      className={`diff-line ${line.type === 'add' ? 'diff-add' : line.type === 'remove' ? 'diff-remove' : ''}`}
                    >
                      <span>{line.oldNumber ?? ''}</span>
                      <span>{line.newNumber ?? ''}</span>
                      <span aria-hidden="true">
                        {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                      </span>
                      <pre>
                        {line.type === 'add' ? <span className="sr-only">Added: </span> : null}
                        {line.type === 'remove' ? <span className="sr-only">Removed: </span> : null}
                        {line.text}
                      </pre>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
