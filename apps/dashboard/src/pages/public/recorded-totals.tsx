import { formatCredits, formatDuration, plural } from '../../lib/format.ts';
import type { RecordedTotals } from '../../lib/recorded.ts';

/** The proof line: counts with their denominators, and misses stated even when zero. */
export function RecordedTotalsLine({ totals }: { totals: RecordedTotals }) {
  const facts: { value: string; label: string }[] = [];
  if (totals.healthy.attempted > 0) {
    facts.push({
      value: `${totals.healthy.verified} / ${totals.healthy.attempted}`,
      label: 'healthy runs verified',
    });
  }
  if (totals.defects.attempted > 0) {
    facts.push({
      value: `${totals.defects.detected} / ${totals.defects.attempted}`,
      label: `recreated defects caught, ${plural(totals.defects.missed, 'miss', 'misses')}`,
    });
  }
  if (totals.realApp.attempted > 0) {
    facts.push({
      value: `${totals.realApp.caught} + ${totals.realApp.clean} / ${totals.realApp.attempted}`,
      label: 'real-app runs: bug caught + clean after the fix, of all attempts',
    });
  }
  if (totals.repairs.attempted > 0) {
    facts.push({
      value: `${totals.repairs.verified} / ${totals.repairs.attempted}`,
      label: 'repairs verified by a rerun',
    });
  }
  facts.push({ value: formatCredits(totals.kaneCredits), label: 'Kane credits spent in total' });
  facts.push({ value: formatDuration(totals.durationMs), label: 'of wall time in total' });

  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-line bg-line md:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
      {facts.map((fact) => (
        <div key={fact.label} className="flex flex-col gap-1 bg-raised px-5 py-4">
          <dt className="order-2 text-[14px] text-muted">{fact.label}</dt>
          <dd className="order-1 font-display text-[36px] leading-none font-extrabold">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
