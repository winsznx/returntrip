import { formatCount } from './format.ts';
import type { RunEvent, RunPhase, RunReport } from './types.ts';

/**
 * Adds one event to an ordered list. The server can resend events after a reconnect, and a
 * reconnect can deliver a gap-filling event after a later one, so this dedupes by seq and keeps
 * seq order. Returns the same array when nothing changed, so React can skip a render.
 */
export function mergeEvent(events: readonly RunEvent[], incoming: RunEvent): readonly RunEvent[] {
  const last = events.at(-1);
  if (!last || incoming.seq > last.seq) return [...events, incoming];
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const seq = events[mid]?.seq ?? 0;
    if (seq < incoming.seq) low = mid + 1;
    else high = mid;
  }
  if (events[low]?.seq === incoming.seq) return events;
  return [...events.slice(0, low), incoming, ...events.slice(low)];
}

export function mergeEvents(events: readonly RunEvent[], incoming: readonly RunEvent[]): readonly RunEvent[] {
  return incoming.reduce<readonly RunEvent[]>(mergeEvent, events);
}

/** The highest seq with no gap below it: the safe resume point for Last-Event-ID. */
export function resumeSeq(events: readonly RunEvent[]): number {
  return events.at(-1)?.seq ?? -1;
}

export interface LiveSummary {
  readonly phase: RunPhase | null;
  readonly phaseMessage: string | null;
  readonly attempt: number;
  readonly finished: Extract<RunEvent, { type: 'run.finished' }>['payload'] | null;
  readonly kaneCreditsUsed: number | null;
  readonly kaneCreditsCap: number | null;
}

/** What the live header needs, read from the events alone. */
export function summarizeEvents(events: readonly RunEvent[]): LiveSummary {
  let phase: RunPhase | null = null;
  let phaseMessage: string | null = null;
  let attempt = 0;
  let finished: LiveSummary['finished'] = null;
  let kaneCreditsUsed: number | null = null;
  let kaneCreditsCap: number | null = null;
  for (const event of events) {
    attempt = Math.max(attempt, event.attempt);
    if (event.type === 'phase.changed') {
      phase = event.payload.phase;
      phaseMessage = event.payload.message;
    } else if (event.type === 'budget.updated') {
      kaneCreditsUsed = event.payload.kaneCreditsUsed;
      kaneCreditsCap = event.payload.kaneCreditsCap;
    } else if (event.type === 'run.finished') {
      finished = event.payload;
      phase = 'FINISHED';
    }
  }
  return { phase, phaseMessage, attempt, finished, kaneCreditsUsed, kaneCreditsCap };
}

/** Events after which the stored report has new facts worth refetching. */
export function changesReport(event: RunEvent): boolean {
  return (
    event.type === 'browser.finished' ||
    event.type === 'artifact.captured' ||
    event.type === 'comparison.completed' ||
    event.type === 'repair.patch' ||
    event.type === 'repair.rejected' ||
    event.type === 'build.finished' ||
    event.type === 'run.finished'
  );
}

export type TimelineKind =
  | 'phase'
  | 'stage'
  | 'progress'
  | 'capture'
  | 'comparison'
  | 'repair'
  | 'rejection'
  | 'build'
  | 'warning'
  | 'finish';

export interface TimelineItem {
  readonly key: string;
  readonly elapsedMs: number;
  readonly utc: string;
  readonly kind: TimelineKind;
  readonly text: string;
  readonly tone: 'ok' | 'bad' | 'warn' | 'neutral';
  readonly attempt: number | null;
  readonly stage?: string;
  readonly creditsUsed?: number | null;
  readonly durationMs?: number;
  readonly sha256?: string;
}

const EDGE_WORDS: Readonly<Record<string, string>> = {
  source_export: 'Trusted source to first export',
  export_reexport: 'First export to export after restore',
  source_reexport: 'Trusted source to export after restore',
};

/** Structured timeline from live events; mirrors the server's describeEvent wording. */
export function timelineFromEvents(events: readonly RunEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const event of events) {
    const base = { key: `e${event.seq}`, elapsedMs: event.elapsedMs, utc: event.utc, attempt: event.attempt };
    switch (event.type) {
      case 'phase.changed':
        items.push({ ...base, kind: 'phase', text: event.payload.message, tone: 'neutral' });
        break;
      case 'browser.finished':
        items.push({
          ...base,
          kind: 'stage',
          stage: event.payload.stage,
          text: `Kane ${event.payload.stage}: ${event.payload.outcome}${event.payload.oneLiner ? `, ${event.payload.oneLiner}` : ''}`,
          tone:
            event.payload.outcome === 'passed' ? 'ok' : event.payload.outcome === 'failed' ? 'bad' : 'warn',
          creditsUsed: event.payload.creditsUsed,
          durationMs: event.payload.durationMs,
        });
        break;
      case 'artifact.captured':
        items.push({
          ...base,
          kind: 'capture',
          text: `Captured ${event.payload.kind} (${formatCount(event.payload.byteLength)} bytes)`,
          tone: 'neutral',
          sha256: event.payload.sha256,
        });
        break;
      case 'comparison.completed':
        items.push({
          ...base,
          kind: 'comparison',
          text: `${EDGE_WORDS[event.payload.edge] ?? event.payload.edge}: ${event.payload.headline}`,
          tone: event.payload.isEquivalent ? 'ok' : 'bad',
        });
        break;
      case 'repair.patch':
        items.push({
          ...base,
          kind: 'repair',
          text: `Patch changed ${event.payload.filesChanged.join(', ')} (${event.payload.linesChanged} lines): ${event.payload.cause}`,
          tone: 'neutral',
          sha256: event.payload.patchSha256,
        });
        break;
      case 'repair.rejected':
        items.push({
          ...base,
          kind: 'rejection',
          text: `Patch rejected: ${event.payload.reason}`,
          tone: 'bad',
        });
        break;
      case 'build.finished':
        items.push({
          ...base,
          kind: 'build',
          text: event.payload.ok ? 'Rebuilt the patched app' : 'The patched app failed to build',
          tone: event.payload.ok ? 'ok' : 'bad',
          durationMs: event.payload.durationMs,
        });
        break;
      case 'warning':
        items.push({ ...base, kind: 'warning', text: `Warning: ${event.payload.message}`, tone: 'warn' });
        break;
      case 'run.finished':
        items.push({
          ...base,
          kind: 'finish',
          text: `${event.payload.outcome}: ${event.payload.headline}`,
          tone: finishTone(event.payload.outcome),
        });
        break;
      default:
        break;
    }
  }
  return items;
}

function finishTone(outcome: string): TimelineItem['tone'] {
  if (outcome === 'VERIFIED' || outcome === 'REPAIRED_VERIFIED') return 'ok';
  if (outcome === 'DATA_MISMATCH' || outcome === 'REPAIR_UNRESOLVED') return 'bad';
  return outcome === 'CANCELED' ? 'neutral' : 'warn';
}

const STAGE_LINE = /^Kane (export|create-destination|restore|reexport): (\w+)(?:, (.*))?$/;
const CAPTURE_LINE = /^Captured (\w[\w-]*) \((\d+) bytes, sha256 ([0-9a-f]+)\)$/;
const COMPARISON_LINE = /^(source to export|export to reexport|source to reexport): (.*)$/;
const PATCH_LINE = /^Patch ([0-9a-f]+) changed (.*)$/;
const FINISH_LINE = /^([A-Z_]+): (.*)$/;

const COMPARISON_EDGE: Readonly<Record<string, string>> = {
  'source to export': 'source_export',
  'export to reexport': 'export_reexport',
  'source to reexport': 'source_reexport',
};

/**
 * Structured timeline from a stored report, whose timeline is plain text. Kane stage lines are
 * matched to the attempt stage reports in order, which is the order the engine runs them.
 */
export function timelineFromReport(report: RunReport): TimelineItem[] {
  const stageQueue = new Map<string, { attempt: number; creditsUsed: number | null; durationMs: number }[]>();
  for (const attempt of report.attempts) {
    for (const stage of attempt.stages) {
      const queue = stageQueue.get(stage.stage) ?? [];
      queue.push({ attempt: attempt.number, creditsUsed: stage.creditsUsed, durationMs: stage.durationMs });
      stageQueue.set(stage.stage, queue);
    }
  }
  let currentAttempt: number | null = report.attempts[0]?.number ?? null;
  return report.timeline.map((entry, index): TimelineItem => {
    const base = { key: `t${index}`, elapsedMs: entry.elapsedMs, utc: entry.utc };
    const stage = STAGE_LINE.exec(entry.text);
    if (stage) {
      const [, name = '', outcome = ''] = stage;
      const measured = stageQueue.get(name)?.shift();
      if (measured) currentAttempt = measured.attempt;
      return {
        ...base,
        kind: 'stage',
        stage: name,
        text: entry.text,
        tone: outcome === 'passed' ? 'ok' : outcome === 'failed' ? 'bad' : 'warn',
        attempt: measured?.attempt ?? currentAttempt,
        creditsUsed: measured?.creditsUsed ?? null,
        ...(measured ? { durationMs: measured.durationMs } : {}),
      };
    }
    const capture = CAPTURE_LINE.exec(entry.text);
    if (capture) {
      return {
        ...base,
        kind: 'capture',
        text: `Captured ${capture[1]} (${formatCount(Number(capture[2]))} bytes)`,
        tone: 'neutral',
        attempt: currentAttempt,
        sha256: capture[3] ?? '',
      };
    }
    const comparison = COMPARISON_LINE.exec(entry.text);
    if (comparison) {
      const edge = COMPARISON_EDGE[comparison[1] ?? ''] ?? '';
      const summary = report.attempts
        .find((attempt) => attempt.number === currentAttempt)
        ?.comparisons.find((item) => item.edge === edge);
      return {
        ...base,
        kind: 'comparison',
        text: `${EDGE_WORDS[edge] ?? comparison[1]}: ${comparison[2]}`,
        tone: summary ? (summary.isEquivalent ? 'ok' : 'bad') : 'neutral',
        attempt: currentAttempt,
      };
    }
    const patch = PATCH_LINE.exec(entry.text);
    if (patch) {
      return {
        ...base,
        kind: 'repair',
        text: `Patch changed ${patch[2]}`,
        tone: 'neutral',
        attempt: currentAttempt,
        sha256: patch[1] ?? '',
      };
    }
    if (entry.text.startsWith('Patch rejected:'))
      return { ...base, kind: 'rejection', text: entry.text, tone: 'bad', attempt: currentAttempt };
    if (entry.text === 'Rebuilt the patched app')
      return { ...base, kind: 'build', text: entry.text, tone: 'ok', attempt: currentAttempt };
    if (entry.text === 'The patched app failed to build')
      return { ...base, kind: 'build', text: entry.text, tone: 'bad', attempt: currentAttempt };
    if (entry.text.startsWith('Warning:'))
      return { ...base, kind: 'warning', text: entry.text, tone: 'warn', attempt: currentAttempt };
    const finish = FINISH_LINE.exec(entry.text);
    if (finish && index === report.timeline.length - 1) {
      return { ...base, kind: 'finish', text: entry.text, tone: finishTone(finish[1] ?? ''), attempt: null };
    }
    return { ...base, kind: 'phase', text: entry.text, tone: 'neutral', attempt: currentAttempt };
  });
}
