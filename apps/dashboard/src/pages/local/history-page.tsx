import { useState } from 'react';

import { LoadError, Loading } from '../../components/state-message.tsx';
import { api } from '../../lib/api.ts';
import { useDocumentTitle } from '../../lib/use-document-title.ts';
import { useResource } from '../../lib/use-resource.ts';
import { RunsTable } from './runs-table.tsx';

const PAGE_SIZE = 25;

export function HistoryPage() {
  useDocumentTitle('Runs');
  // The API pages forward with an opaque cursor, so going back means remembering the cursors used.
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const { resource, reload } = useResource(`runs|${cursor ?? ''}`, (signal) =>
    api.runs({ cursor, limit: PAGE_SIZE }, signal),
  );

  return (
    <div className="shell flex flex-col gap-8 pt-12">
      <div className="flex flex-col gap-3">
        <h1 className="text-[48px] sm:text-[64px]">Runs</h1>
        <p className="max-w-[60ch] text-muted">Every run in this store, newest first.</p>
      </div>
      {resource.status === 'loading' ? <Loading label="Loading runs" /> : null}
      {resource.status === 'error' ? <LoadError error={resource.error} onRetry={reload} /> : null}
      {resource.status === 'ready' ? (
        resource.data.runs.length === 0 && cursors.length === 1 ? (
          <p className="text-muted">No runs yet. Start one from Projects.</p>
        ) : (
          <>
            <RunsTable runs={resource.data.runs} />
            <nav aria-label="Run pages" className="flex items-center gap-3">
              <button
                type="button"
                className="btn btn-small"
                disabled={cursors.length === 1}
                onClick={() => setCursors((stack) => stack.slice(0, -1))}
              >
                Newer
              </button>
              <button
                type="button"
                className="btn btn-small"
                disabled={!resource.data.nextCursor}
                onClick={() => {
                  const next = resource.data.nextCursor;
                  if (next) setCursors((stack) => [...stack, next]);
                }}
              >
                Older
              </button>
              <span className="text-[14px] text-muted">Page {cursors.length}</span>
            </nav>
          </>
        )
      ) : null}
    </div>
  );
}
