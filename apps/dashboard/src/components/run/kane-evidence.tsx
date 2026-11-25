import { useRef, useState } from 'react';

import type { EvidenceSource, FileRef, Screenshot } from '../../lib/evidence.ts';
import { formatBytes, formatCredits, formatDuration } from '../../lib/format.ts';
import { KANE_OUTCOME_LABELS, STAGE_LABELS, stageTone } from '../../lib/outcomes.ts';
import type { AttemptReport, StageReport } from '../../lib/types.ts';
import { Icon } from '../icons.tsx';

interface StageEntry {
  readonly key: string;
  readonly stage: StageReport;
  /** A later record for the same stage exists in this attempt: this try was repeated. */
  readonly retried: boolean;
  readonly tryIndex: number;
  /** Screenshots belong to the last try of a stage; a published bundle keys them by stage only. */
}

export function stageEntries(attempt: AttemptReport): StageEntry[] {
  const seen = new Map<string, number>();
  return attempt.stages.map((stage, index) => {
    const tryIndex = seen.get(stage.stage) ?? 0;
    seen.set(stage.stage, tryIndex + 1);
    const later = attempt.stages.slice(index + 1).some((other) => other.stage === stage.stage);
    return { key: `${stage.stage}-${tryIndex}`, stage, retried: later, tryIndex };
  });
}

export function KaneEvidence({ source, attempt }: { source: EvidenceSource; attempt: AttemptReport }) {
  const entries = stageEntries(attempt);
  const [viewing, setViewing] = useState<{ shot: Screenshot; caption: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const open = (shot: Screenshot, caption: string): void => {
    setViewing({ shot, caption });
    dialog.current?.showModal();
  };

  return (
    <section aria-labelledby="kane-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 id="kane-heading" className="text-[34px] sm:text-[44px]">
          What Kane saw
        </h2>
        <p className="max-w-[62ch] text-muted">
          Kane CLI drove a real Chrome through each stage. Its own pass or fail is shown as Kane reported it.
          The data verdict above comes from ReturnTrip's comparison, not from these checks.
        </p>
      </div>
      {entries.length === 0 ? (
        <p className="text-muted">No browser stage has finished in this attempt yet.</p>
      ) : null}
      <div className="flex flex-col gap-3">
        {entries.map((entry) => (
          <StagePanel
            key={entry.key}
            entry={entry}
            shots={source.screenshots(attempt.number, entry.stage.stage, entry.tryIndex)}
            pack={source.evidencePacks(attempt.number, entry.stage.stage)[entry.tryIndex] ?? null}
            local={source.kind === 'local'}
            onOpen={open}
          />
        ))}
      </div>
      <dialog
        ref={dialog}
        className="shot-dialog m-auto"
        aria-label={viewing?.caption ?? 'Screenshot'}
        onClose={() => setViewing(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') dialog.current?.close();
        }}
      >
        {viewing ? (
          <figure className="m-0">
            <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
              <figcaption className="text-[14px] text-muted">{viewing.caption}</figcaption>
              <button type="button" className="btn btn-small" onClick={() => dialog.current?.close()}>
                <Icon name="close" size={16} />
                Close
              </button>
            </div>
            <img src={viewing.shot.src} alt={viewing.caption} className="block h-auto w-full" />
          </figure>
        ) : null}
      </dialog>
    </section>
  );
}

function StagePanel({
  entry,
  shots,
  pack,
  local,
  onOpen,
}: {
  entry: StageEntry;
  shots: readonly Screenshot[];
  pack: FileRef | null;
  local: boolean;
  onOpen: (shot: Screenshot, caption: string) => void;
}) {
  const { stage } = entry;
  const tone = stageTone(stage.outcome);
  const label = STAGE_LABELS[stage.stage] ?? stage.stage;
  return (
    <details className="panel group" open={stage.stage === 'restore' && !entry.retried}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4 [&::-webkit-details-marker]:hidden">
        <span className="font-display text-[24px] leading-none font-bold">{label}</span>
        <span className={`badge badge-small tone-${tone}`}>{KANE_OUTCOME_LABELS[stage.outcome]}</span>
        {entry.retried ? <span className="badge badge-small tone-warn">Retried</span> : null}
        {entry.tryIndex > 0 ? <span className="text-[13px] text-muted">Try {entry.tryIndex + 1}</span> : null}
        <span className="mono text-[13px] text-muted sm:ml-auto">
          {formatCredits(stage.creditsUsed)} credits, {formatDuration(stage.durationMs)}
        </span>
        <span className="text-[13px] text-route group-open:hidden">Show</span>
        <span className="hidden text-[13px] text-route group-open:inline">Hide</span>
      </summary>
      <div className="flex flex-col gap-5 border-t border-line px-4 py-5">
        {stage.oneLiner ? (
          <p>
            <span className="text-muted">Kane's summary: </span>
            {stage.oneLiner}
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[14px] sm:grid-cols-4">
          <div>
            <dt className="text-faint">Reason code</dt>
            <dd className="mono break-all">{stage.reasonCode ?? 'none'}</dd>
          </div>
          <div>
            <dt className="text-faint">Wall time</dt>
            <dd className="mono">{formatDuration(stage.durationMs)}</dd>
          </div>
          <div>
            <dt className="text-faint">Kane's agent time</dt>
            <dd className="mono">
              {stage.vendorDurationSec === null
                ? 'not reported'
                : formatDuration(stage.vendorDurationSec * 1000)}
            </dd>
          </div>
          <div>
            <dt className="text-faint">Kane CLI</dt>
            <dd className="mono">{stage.kaneVersion ?? 'unknown'}</dd>
          </div>
        </dl>

        {stage.steps.length > 0 ? (
          <div>
            <h3 className="mb-2 font-sans text-[15px] font-semibold">Steps</h3>
            <ol className="flex flex-col gap-1.5">
              {stage.steps.map((step) => (
                <li key={step.index} className="flex gap-3 text-[14px]">
                  <span
                    className={`mono w-6 shrink-0 ${step.status === 'failed' ? 'text-bad' : 'text-faint'}`}
                  >
                    {step.index}
                  </span>
                  <span className={step.status === 'failed' ? 'text-bad' : undefined}>
                    {step.status === 'failed' ? <span className="sr-only">Failed: </span> : null}
                    {step.remark}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {stage.assertions.length > 0 ? (
          <div>
            <h3 className="mb-2 font-sans text-[15px] font-semibold">Kane's assertions</h3>
            <div className="scroll-x rounded-lg border border-line">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Condition</th>
                    <th scope="col">Expected</th>
                    <th scope="col">Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {stage.assertions.map((assertion) => (
                    <tr key={assertion.name}>
                      <td className="min-w-[16rem]">{assertion.condition ?? assertion.name}</td>
                      <td className="mono">{assertion.expected ?? 'none'}</td>
                      <td
                        className={`mono ${assertion.observed === assertion.expected ? 'text-ok' : 'text-bad'}`}
                      >
                        {assertion.observed ?? 'none'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {shots.length > 0 ? (
          <div>
            <h3 className="mb-2 font-sans text-[15px] font-semibold">Screenshots</h3>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {shots.map((shot) => {
                const remark = stage.steps[shot.position - 1]?.remark;
                const caption = `${label}, screenshot ${shot.position}${remark ? `: ${remark}` : ''}`;
                return (
                  <li key={shot.src}>
                    <button
                      type="button"
                      className="block w-full overflow-hidden rounded-md border border-line bg-sunken text-left hover:border-muted"
                      onClick={() => onOpen(shot, caption)}
                    >
                      <img
                        src={shot.src}
                        alt={caption}
                        loading="lazy"
                        className="aspect-video w-full object-cover object-top"
                      />
                      <span className="block truncate px-2 py-1.5 text-[12px] text-muted">
                        {shot.position}. {remark ?? 'Screenshot'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {local ? (
          pack ? (
            <a className="btn btn-small self-start" href={pack.href} download>
              <Icon name="download" size={16} />
              Kane evidence pack ({formatBytes(pack.byteLength)})
            </a>
          ) : (
            <p className="text-[14px] text-muted">Kane did not leave an evidence pack for this stage.</p>
          )
        ) : null}
      </div>
    </details>
  );
}
