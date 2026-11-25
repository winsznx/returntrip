import { useEffect, useEffectEvent, useState } from 'react';

import { api } from './api.ts';
import { mergeEvent, resumeSeq } from './events.ts';
import type { RunEvent } from './types.ts';

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'ended';

/** Exhaustive by type: adding an event type to the contract fails the build until it is listed here. */
const EVENT_TYPES: Readonly<Record<RunEvent['type'], true>> = {
  'run.created': true,
  'phase.changed': true,
  'browser.started': true,
  'browser.progress': true,
  'browser.finished': true,
  'artifact.captured': true,
  'comparison.completed': true,
  'repair.started': true,
  'repair.patch': true,
  'repair.rejected': true,
  'build.finished': true,
  'budget.updated': true,
  warning: true,
  'run.finished': true,
};

const MAX_BACKOFF_MS = 15_000;

function parseEvent(data: unknown): RunEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== 'object' || value === null) return null;
    const candidate = value as { seq?: unknown; type?: unknown };
    if (typeof candidate.seq !== 'number' || typeof candidate.type !== 'string') return null;
    if (!Object.hasOwn(EVENT_TYPES, candidate.type)) return null;
    return value as RunEvent;
  } catch {
    return null;
  }
}

/**
 * Follows a run's event stream. The server replays stored events first, then live ones. On a
 * dropped connection this reconnects with backoff from the last seq it holds, merges by seq so a
 * replayed event is never shown twice, and asks the caller to refetch the authoritative snapshot.
 * The stream is closed after run.finished, since EventSource would otherwise reconnect forever.
 */
export function useRunStream(
  runId: string,
  callbacks: { onEvent: (event: RunEvent) => void; onResync: () => void; isActive: () => boolean },
): { events: readonly RunEvent[]; state: StreamState } {
  const [events, setEvents] = useState<readonly RunEvent[]>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const handleEvent = useEffectEvent((event: RunEvent) => callbacks.onEvent(event));
  const handleResync = useEffectEvent(() => callbacks.onResync());
  const stillActive = useEffectEvent(() => callbacks.isActive());

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let finished = false;
    let disposed = false;
    let held: readonly RunEvent[] = [];

    const receive = (message: MessageEvent): void => {
      const event = parseEvent(message.data);
      if (!event) return;
      const merged = mergeEvent(held, event);
      if (merged === held) return;
      held = merged;
      setEvents(merged);
      handleEvent(event);
      if (event.type === 'run.finished') {
        finished = true;
        source?.close();
        setState('ended');
      }
    };

    const connect = (): void => {
      if (disposed) return;
      const next = new EventSource(api.eventsUrl(runId, resumeSeq(held)));
      source = next;
      for (const type of Object.keys(EVENT_TYPES)) next.addEventListener(type, receive);
      next.addEventListener('open', () => {
        if (failures > 0) handleResync();
        failures = 0;
        setState('live');
      });
      next.addEventListener('error', () => {
        next.close();
        if (disposed || finished) return;
        // A run that ended without a run.finished event (an interrupted engine) has nothing more to send.
        if (!stillActive()) {
          setState('ended');
          return;
        }
        failures += 1;
        setState('reconnecting');
        const delay = Math.min(1000 * 2 ** (failures - 1), MAX_BACKOFF_MS);
        retry = setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [runId]);

  return { events, state };
}
