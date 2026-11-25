import { formatDate } from '../../lib/format.ts';
import type { RunReport } from '../../lib/types.ts';
import { Icon } from '../icons.tsx';

/** "github.com/we-promise/sure/pull/4754" reads as "we-promise/sure #4754". */
export function referenceLabel(url: string): string {
  const match = /github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/.exec(url);
  return match ? `${match[1]} #${match[2]}` : url.replace(/^https?:\/\//, '');
}

export function ScenarioBadge({ scenario }: { scenario: NonNullable<RunReport['scenario']> }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="badge badge-small tone-warn">
        <Icon name="alert" size={14} />
        {scenario.disclosure}
      </span>
      {scenario.reference ? (
        <a className="text-link text-[14px]" href={scenario.reference} rel="noreferrer" target="_blank">
          Based on {referenceLabel(scenario.reference)}
        </a>
      ) : null}
    </span>
  );
}

/** Stays on screen while scrolling: this is a saved run, and nothing on the page starts one. */
export function RecordedBanner({
  recordedAt,
  scenario,
}: {
  recordedAt: string;
  scenario: RunReport['scenario'];
}) {
  return (
    <div className="sticky top-16 z-30 border-b border-line bg-raised/95 backdrop-blur">
      <div className="shell flex min-h-12 flex-wrap items-center gap-x-5 gap-y-2 py-2">
        <p className="inline-flex items-center gap-2 text-[14px] font-semibold">
          <span className="h-2 w-2 rounded-full bg-route" aria-hidden="true" />
          Recorded run · {formatDate(recordedAt)}
        </p>
        {scenario ? <ScenarioBadge scenario={scenario} /> : null}
      </div>
    </div>
  );
}
