import type { ReactNode } from 'react';

import { ApiError, errorMessage } from '../lib/api.ts';

export function Loading({ label }: { label: string }) {
  return (
    <p className="py-10 text-muted" role="status">
      {label}
    </p>
  );
}

/** The one fix for a missing or expired local session, shown the same way everywhere. */
export function RelaunchHint() {
  return (
    <>
      Open the link printed by{' '}
      <code className="mono rounded bg-sunken px-1.5 py-0.5 text-text">returntrip ui</code>.
    </>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.needsLink) return <RelaunchHint />;
  return <>{errorMessage(error)}</>;
}

export function LoadError({
  error,
  onRetry,
  children,
}: {
  error: unknown;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  const needsLink = error instanceof ApiError && error.needsLink;
  return (
    <div className="panel tone-warn my-6 p-5" role="alert">
      <p className="font-semibold text-warn">
        <ErrorText error={error} />
      </p>
      {needsLink ? (
        <p className="mt-2 text-muted">
          The dashboard only answers to a browser that opened that link, and the link keeps working while the
          CLI is running.
        </p>
      ) : null}
      {children}
      {onRetry && !needsLink ? (
        <button type="button" className="btn btn-small mt-4" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
