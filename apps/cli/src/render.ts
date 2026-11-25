import type { Difference, RunEvent, RunOutcome } from '@returntrip/contracts';
import pc from 'picocolors';

export interface Output {
  /** Progress and human text. Always stderr, so stdout stays clean for --json and --events. */
  info(line: string): void;
  /** Machine output. */
  data(text: string): void;
}

export const consoleOutput: Output = {
  info: (line) => process.stderr.write(`${line}\n`),
  data: (text) => process.stdout.write(text),
};

const OUTCOME_STYLE: Readonly<Record<RunOutcome, (text: string) => string>> = {
  VERIFIED: pc.green,
  REPAIRED_VERIFIED: pc.green,
  DATA_MISMATCH: pc.red,
  REPAIR_UNRESOLVED: pc.red,
  EXECUTION_FAILED: pc.yellow,
  INCONCLUSIVE: pc.yellow,
  INVALID_CONFIG: pc.yellow,
  BUDGET_EXCEEDED: pc.yellow,
  CANCELED: pc.dim,
};

export function outcomeBadge(outcome: RunOutcome): string {
  return OUTCOME_STYLE[outcome](pc.bold(outcome.replace('_', ' ')));
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One line per meaningful event, in plain words. Passing browser steps fold into a dim sub-line. */
export function renderEvent(event: RunEvent): string | null {
  const at = pc.dim(`+${seconds(event.elapsedMs).padStart(6)}`);
  switch (event.type) {
    case 'phase.changed':
      return `${at} ${pc.cyan('›')} ${event.payload.message}`;
    case 'browser.progress':
      return event.payload.status === 'running'
        ? null
        : `${at}   ${pc.dim(`${event.payload.status === 'failed' ? pc.red('✗') : '·'} ${event.payload.remark}`)}`;
    case 'browser.finished': {
      const ok = event.payload.outcome === 'passed';
      const credits =
        event.payload.creditsUsed === null
          ? 'credits unknown'
          : `${event.payload.creditsUsed.toFixed(1)} credits`;
      return `${at} ${ok ? pc.green('✓') : pc.red('✗')} Kane ${event.payload.stage} ${event.payload.outcome} ${pc.dim(`(${credits}, ${seconds(event.payload.durationMs)})`)}${event.payload.oneLiner && !ok ? `: ${event.payload.oneLiner}` : ''}`;
    }
    case 'artifact.captured':
      return `${at} ${pc.green('✓')} Captured ${event.payload.kind} ${pc.dim(`${event.payload.byteLength.toLocaleString('en-US')} bytes, sha256 ${event.payload.sha256.slice(0, 12)}`)}`;
    case 'comparison.completed':
      return `${at} ${event.payload.isEquivalent ? pc.green('✓') : pc.red('✗')} ${event.payload.edge.replace('_', ' → ')}: ${event.payload.headline}`;
    case 'repair.patch':
      return `${at} ${pc.magenta('✎')} Patch ${pc.dim(event.payload.patchSha256.slice(0, 12))} on ${event.payload.filesChanged.join(', ')} (${event.payload.linesChanged} lines): ${event.payload.cause}`;
    case 'repair.rejected':
      return `${at} ${pc.yellow('!')} Patch rejected: ${event.payload.reason}`;
    case 'build.finished':
      return `${at} ${event.payload.ok ? pc.green('✓') : pc.red('✗')} Build ${event.payload.ok ? 'passed' : 'failed'} ${pc.dim(seconds(event.payload.durationMs))}`;
    case 'warning':
      return `${at} ${pc.yellow('!')} ${event.payload.message}`;
    default:
      return null;
  }
}

function clip(value: string | null | undefined, width: number): string {
  if (value === null || value === undefined) return pc.dim('(null)');
  const visible = JSON.stringify(value).slice(1, -1);
  return visible.length > width ? `${visible.slice(0, width - 1)}…` : visible;
}

/** A short expected-vs-observed table; the full list lives in the report and dashboard. */
export function renderDifferences(differences: readonly Difference[], total: number): string[] {
  if (differences.length === 0) return [];
  const lines = [pc.bold(`  First ${differences.length} of ${total.toLocaleString('en-US')} differences:`)];
  for (const difference of differences) {
    const where = `row ${difference.expectedRowRefs[0] ?? '?'}`;
    if (difference.kind === 'FIELD_CHANGED') {
      lines.push(
        `    ${pc.dim(where.padEnd(9))} ${difference.field ?? ''}: ${pc.green(clip(difference.expectedRaw, 32))} → ${pc.red(clip(difference.observedRaw, 32))}`,
      );
    } else {
      lines.push(
        `    ${pc.dim(where.padEnd(9))} ${difference.kind.toLowerCase().replaceAll('_', ' ')}: ${difference.message}`,
      );
    }
  }
  return lines;
}
