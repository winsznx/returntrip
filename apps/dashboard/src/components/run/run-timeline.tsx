import type { TimelineItem } from '../../lib/events.ts';
import { formatCredits, formatDuration, formatElapsed, shortHash } from '../../lib/format.ts';

const KIND_LABELS: Readonly<Record<TimelineItem['kind'], string>> = {
  phase: 'Step',
  stage: 'Kane',
  progress: 'Kane',
  capture: 'Captured',
  comparison: 'Compared',
  repair: 'Patch',
  rejection: 'Rejected',
  build: 'Build',
  warning: 'Warning',
  finish: 'Result',
};

const DOT_TONE: Readonly<Record<TimelineItem['tone'], string>> = {
  ok: 'bg-ok',
  bad: 'bg-bad',
  warn: 'bg-warn',
  neutral: 'bg-line-strong',
};

export function RunTimeline({ items, emptyText }: { items: readonly TimelineItem[]; emptyText: string }) {
  return (
    <section aria-labelledby="timeline-heading" className="flex flex-col gap-5">
      <h2 id="timeline-heading" className="text-[34px] sm:text-[44px]">
        What happened, in order
      </h2>
      {items.length === 0 ? (
        <p className="text-muted">{emptyText}</p>
      ) : (
        <ol className="relative flex flex-col border-l border-line pl-0">
          {items.map((item) => (
            <li
              key={item.key}
              className="relative grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 py-2.5 pl-5 sm:grid-cols-[5.5rem_7rem_minmax(0,1fr)]"
            >
              <span
                className={`absolute top-[18px] -left-[5px] h-[9px] w-[9px] rounded-full ${DOT_TONE[item.tone]}`}
                aria-hidden="true"
              />
              <span className="mono pt-0.5 text-[13px] text-faint">
                <span className="sr-only">at </span>
                {formatElapsed(item.elapsedMs)}
              </span>
              <span className="hidden pt-0.5 text-[13px] text-muted sm:block">{KIND_LABELS[item.kind]}</span>
              <div className="col-start-2 min-w-0 sm:col-start-3">
                <p className={item.kind === 'finish' ? 'font-semibold' : undefined}>{item.text}</p>
                <TimelineMeta item={item} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TimelineMeta({ item }: { item: TimelineItem }) {
  const parts: string[] = [];
  if (item.kind === 'stage') {
    parts.push(`${formatCredits(item.creditsUsed ?? null)} credits`);
    if (item.durationMs !== undefined) parts.push(formatDuration(item.durationMs));
  }
  if (item.kind === 'build' && item.durationMs !== undefined) parts.push(formatDuration(item.durationMs));
  if (item.sha256) parts.push(`sha256 ${shortHash(item.sha256)}`);
  if (parts.length === 0) return null;
  return <p className="mono mt-0.5 text-[13px] text-muted">{parts.join(', ')}</p>;
}
