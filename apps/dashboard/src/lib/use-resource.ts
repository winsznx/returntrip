import { useCallback, useEffect, useEffectEvent, useState } from 'react';

export type Resource<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly data: T };

interface Settled<T> {
  readonly key: string;
  readonly version: number;
  readonly resource: Resource<T>;
}

/**
 * Loads data for a key and aborts the request when the key changes or the component unmounts.
 * A result is shown only for the key that asked for it, so a slow old response never replaces a
 * newer one. A null key loads nothing.
 */
export function useResource<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
): { resource: Resource<T>; reload: () => void } {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [version, setVersion] = useState(0);
  const run = useEffectEvent((signal: AbortSignal) => load(signal));

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    run(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setSettled({ key, version, resource: { status: 'ready', data } });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setSettled({ key, version, resource: { status: 'error', error } });
      },
    );
    return () => controller.abort();
  }, [key, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const current = settled && settled.key === key ? settled.resource : null;
  return { resource: current ?? { status: 'loading' }, reload };
}
