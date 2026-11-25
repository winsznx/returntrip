import { outcomeMeta } from '../lib/outcomes.ts';
import { Icon } from './icons.tsx';

export function OutcomeBadge({
  outcome,
  active = false,
  small = false,
}: {
  outcome: string | null;
  active?: boolean;
  small?: boolean;
}) {
  const meta = outcomeMeta(outcome, active);
  return (
    <span className={`badge tone-${meta.tone}${small ? ' badge-small' : ''}`}>
      <Icon name={meta.icon} size={small ? 14 : 16} />
      {meta.label}
    </span>
  );
}
