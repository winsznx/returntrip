import { type ReactNode, useState } from 'react';

import type { TimelineItem } from '../../lib/events.ts';
import type { EvidenceSource } from '../../lib/evidence.ts';
import { defaultAttempt } from '../../lib/run-model.ts';
import type { RunReport } from '../../lib/types.ts';
import { FilesPanel, LimitsPanel } from './files-panel.tsx';
import { KaneEvidence } from './kane-evidence.tsx';
import { RecordInspector } from './record-inspector.tsx';
import { RepairPanel } from './repair-panel.tsx';
import { AttemptPicker, RecordCountStrip, RunHeader } from './run-summary.tsx';
import { RunTimeline } from './run-timeline.tsx';

export interface RunPageProps {
  readonly report: RunReport;
  readonly source: EvidenceSource;
  readonly active: boolean;
  readonly timeline: readonly TimelineItem[];
  /** Persistent label above everything, such as "Recorded run". */
  readonly banner?: ReactNode;
  /** Live state for an active run. */
  readonly status?: ReactNode;
  /** Run controls; absent on recorded runs. */
  readonly actions?: ReactNode;
}

/** One run, top to bottom: verdict, counts, records, timeline, Kane evidence, repair, files, limits. */
export function RunPage({ report, source, active, timeline, banner, status, actions }: RunPageProps) {
  const [chosen, setChosen] = useState<number | null>(null);
  const selectedNumber = chosen ?? defaultAttempt(report)?.number ?? null;
  const attempt = report.attempts.find((item) => item.number === selectedNumber);
  const sections = [
    { id: 'records', label: 'Records' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'kane', label: 'Kane evidence' },
    ...(report.repairs.length > 0 ? [{ id: 'repair', label: 'Repair' }] : []),
    { id: 'files', label: 'Files' },
    { id: 'limits', label: 'Limits' },
  ];

  return (
    <>
      {banner}
      <div className="shell flex flex-col gap-16 pb-8">
        <div className="flex flex-col gap-6">
          <RunHeader report={report} active={active} status={status} />
          {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
          <nav aria-label="Run sections" className="scroll-x -mx-1">
            <ul className="flex gap-1 px-1 text-[14px] whitespace-nowrap">
              {sections.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="inline-flex min-h-9 items-center rounded-md px-2.5 text-muted hover:bg-raised hover:text-text"
                  >
                    {section.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="flex flex-col gap-8">
          <AttemptPicker attempts={report.attempts} selected={selectedNumber ?? 0} onSelect={setChosen} />
          <RecordCountStrip attempt={attempt} />
        </div>

        <div id="records" className="scroll-mt-28">
          {attempt ? (
            <RecordInspector key={`${report.runId}-${attempt.number}`} source={source} attempt={attempt} />
          ) : (
            <p className="text-muted">No attempt has started yet.</p>
          )}
        </div>

        <div id="timeline" className="scroll-mt-28">
          <RunTimeline
            items={timeline}
            emptyText={active ? 'Waiting for the first event.' : 'No events were recorded.'}
          />
        </div>

        <div id="kane" className="scroll-mt-28">
          {attempt ? <KaneEvidence source={source} attempt={attempt} /> : null}
        </div>

        {report.repairs.length > 0 ? (
          <div id="repair" className="scroll-mt-28">
            <RepairPanel report={report} source={source} />
          </div>
        ) : null}

        <div id="files" className="scroll-mt-28">
          <FilesPanel report={report} source={source} />
        </div>

        <div id="limits" className="scroll-mt-28">
          <LimitsPanel limitations={report.limitations} />
        </div>
      </div>
    </>
  );
}
