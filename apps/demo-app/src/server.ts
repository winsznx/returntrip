import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type LedgerStore, openLedgerStore } from './db.ts';
import { draftWorkspace, isValidSlug, type Workspace } from './domain/workspace.ts';
import { exportFileName, exportPaymentsCsv } from './export/export-payments.ts';
import { readForm } from './http/read-form.ts';
import {
  redirectSeeOther,
  sendAsset,
  sendAttachment,
  sendHtml,
  sendJson,
  sendMethodNotAllowed,
} from './http/respond.ts';
import { importPayments } from './import/import-payments.ts';
import { renderErrorPage } from './views/error-page.ts';
import { formatCount } from './views/format.ts';
import type { Banner } from './views/layout.ts';
import { renderWorkspacePage } from './views/workspace-page.ts';
import { renderWorkspacesPage } from './views/workspaces-page.ts';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4311;
const PAGE_SIZE = 50;
const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
// Multipart framing (boundaries, part headers) on top of the file itself.
const MAX_IMPORT_REQUEST_BYTES = MAX_IMPORT_FILE_BYTES + 64 * 1024;
const MAX_WORKSPACE_FORM_BYTES = 16 * 1024;
const SHUTDOWN_GRACE_MS = 5_000;
const PAGE_PARAM = /^[1-9]\d{0,8}$/;
const COUNT_PARAM = /^\d{1,9}$/;
const WORKSPACE_ROUTE = /^\/w\/([^/]+)(\/import|\/export\.csv)?$/;

interface AppContext {
  readonly store: LedgerStore;
  readonly stylesheet: Buffer;
}

export function createLedgerServer(context: AppContext): Server {
  return createServer((req, res) => {
    const startedAt = performance.now();
    res.on('finish', () => {
      const elapsed = (performance.now() - startedAt).toFixed(1);
      console.log(`${req.method} ${req.url} ${res.statusCode} ${elapsed}ms`);
    });
    route(context, req, res).catch((error: unknown) => {
      console.error(error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendHtml(
        res,
        500,
        renderErrorPage({
          title: 'Something went wrong',
          message: 'The request failed. Nothing was changed.',
        }),
      );
    });
  });
}

async function route(context: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // Node already omits the body for HEAD responses, so HEAD can share the GET handlers.
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const path = url.pathname;

  if (path === '/health') {
    return method === 'GET'
      ? sendJson(res, 200, { status: 'ok' })
      : sendMethodNotAllowed(res, ['GET', 'HEAD']);
  }
  if (path === '/assets/app.css') {
    return method === 'GET'
      ? sendAsset(res, 'text/css; charset=utf-8', context.stylesheet)
      : sendMethodNotAllowed(res, ['GET', 'HEAD']);
  }
  if (path === '/') {
    return method === 'GET' ? showWorkspaces(context, res) : sendMethodNotAllowed(res, ['GET', 'HEAD']);
  }
  if (path === '/workspaces') {
    return method === 'POST' ? createWorkspace(context, req, res) : sendMethodNotAllowed(res, ['POST']);
  }

  const match = WORKSPACE_ROUTE.exec(path);
  const slug = match?.[1];
  if (match === null || slug === undefined || !isValidSlug(slug)) {
    return sendNotFound(res);
  }
  const workspace = context.store.findWorkspace(slug);
  if (workspace === undefined) {
    return sendHtml(
      res,
      404,
      renderErrorPage({ title: 'Workspace not found', message: `There is no workspace at /w/${slug}.` }),
    );
  }

  switch (match[2]) {
    case undefined:
      return method === 'GET'
        ? showWorkspace(context, res, workspace, url.searchParams)
        : sendMethodNotAllowed(res, ['GET', 'HEAD']);
    case '/import':
      return method === 'POST'
        ? importIntoWorkspace(context, req, res, workspace)
        : sendMethodNotAllowed(res, ['POST']);
    case '/export.csv':
      return method === 'GET'
        ? sendAttachment(res, {
            contentType: 'text/csv; charset=utf-8',
            fileName: exportFileName(workspace.slug),
            body: exportPaymentsCsv(context.store, workspace.id),
          })
        : sendMethodNotAllowed(res, ['GET', 'HEAD']);
    default:
      return sendNotFound(res);
  }
}

function showWorkspaces(context: AppContext, res: ServerResponse): void {
  sendHtml(res, 200, renderWorkspacesPage({ workspaces: context.store.listWorkspaces() }));
}

async function createWorkspace(
  context: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readForm(req, MAX_WORKSPACE_FORM_BYTES);
  if (!body.ok) {
    return sendBadRequest(res, 'The workspace form could not be read.');
  }
  const rawName = body.form.get('name');
  const draft = draftWorkspace(typeof rawName === 'string' ? rawName : '');
  const rejectWith = (status: number, message: string): void =>
    sendHtml(
      res,
      status,
      renderWorkspacesPage({
        workspaces: context.store.listWorkspaces(),
        banner: { kind: 'error', message },
        draftName: typeof rawName === 'string' ? rawName : '',
      }),
    );

  if (!draft.ok) {
    return rejectWith(422, draft.error);
  }
  const created = context.store.createWorkspace({ slug: draft.slug, name: draft.name });
  if (!created.ok) {
    return rejectWith(409, `A workspace already uses the address /w/${draft.slug}. Choose a different name.`);
  }
  redirectSeeOther(res, `/w/${created.workspace.slug}`);
}

function showWorkspace(
  context: AppContext,
  res: ServerResponse,
  workspace: Workspace,
  query: URLSearchParams,
): void {
  const pageParam = query.get('page');
  if (pageParam !== null && !PAGE_PARAM.test(pageParam)) {
    sendBadRequest(res, 'The page number must be a whole number of 1 or more.');
    return;
  }
  const page = pageParam === null ? 1 : Number(pageParam);
  const recordCount = context.store.countPayments(workspace.id);
  const pageCount = Math.max(1, Math.ceil(recordCount / PAGE_SIZE));
  if (page > pageCount) {
    sendHtml(
      res,
      404,
      renderErrorPage({
        title: 'Page not found',
        message: `${workspace.name} has ${pageCount} ${pageCount === 1 ? 'page' : 'pages'} of payments.`,
      }),
    );
    return;
  }

  const importedParam = query.get('imported');
  const banner: Banner | undefined =
    importedParam !== null && COUNT_PARAM.test(importedParam)
      ? {
          kind: 'success',
          message: `Import successful: ${formatCount(Number(importedParam), 'payment', 'payments')}`,
        }
      : undefined;

  sendHtml(res, 200, renderLedger(context, workspace, { page, banner }));
}

async function importIntoWorkspace(
  context: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  workspace: Workspace,
): Promise<void> {
  const rejectWith = (status: number, message: string): void =>
    sendHtml(res, status, renderLedger(context, workspace, { page: 1, banner: { kind: 'error', message } }));

  const body = await readForm(req, MAX_IMPORT_REQUEST_BYTES);
  if (!body.ok) {
    return body.reason === 'too-large'
      ? rejectWith(413, 'Import failed: the file is larger than 10 MiB.')
      : rejectWith(400, 'Import failed: the upload could not be read. Choose the file again and retry.');
  }
  const file = body.form.get('file');
  if (!(file instanceof File) || (file.size === 0 && file.name === '')) {
    return rejectWith(400, 'Import failed: choose a CSV file to import.');
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return rejectWith(413, 'Import failed: the file is larger than 10 MiB.');
  }

  const outcome = importPayments(context.store, workspace.id, new Uint8Array(await file.arrayBuffer()));
  if (!outcome.ok) {
    return rejectWith(422, `Import failed: ${outcome.error}`);
  }
  redirectSeeOther(res, `/w/${workspace.slug}?imported=${outcome.imported}`);
}

function renderLedger(
  context: AppContext,
  workspace: Workspace,
  view: { readonly page: number; readonly banner: Banner | undefined },
): string {
  const recordCount = context.store.countPayments(workspace.id);
  return renderWorkspacePage({
    workspace,
    recordCount,
    payments: context.store.listPayments(workspace.id, {
      limit: PAGE_SIZE,
      offset: (view.page - 1) * PAGE_SIZE,
    }),
    page: view.page,
    pageCount: Math.max(1, Math.ceil(recordCount / PAGE_SIZE)),
    pageSize: PAGE_SIZE,
    ...(view.banner === undefined ? {} : { banner: view.banner }),
  });
}

function sendNotFound(res: ServerResponse): void {
  sendHtml(res, 404, renderErrorPage({ title: 'Page not found', message: 'Nothing lives at this address.' }));
}

function sendBadRequest(res: ServerResponse, message: string): void {
  sendHtml(res, 400, renderErrorPage({ title: 'Bad request', message }));
}

function readPort(value: string | undefined): number {
  if (value === undefined || value === '') {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got "${value}"`);
  }
  return port;
}

function main(): void {
  const dataDir = process.env.DATA_DIR;
  if (dataDir === undefined || dataDir === '') {
    console.error('DATA_DIR is required, e.g. DATA_DIR=./data node src/server.ts');
    process.exitCode = 1;
    return;
  }
  const port = readPort(process.env.PORT);
  const store = openLedgerStore(dataDir);
  const stylesheet = readFileSync(new URL('../public/app.css', import.meta.url));
  const server = createLedgerServer({ store, stylesheet });

  server.listen(port, HOST, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;
    console.log(`Ledgerline listening on http://${HOST}:${boundPort}`);
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`${signal} received, closing server`);
    server.close(() => {
      store.close();
      console.log('Ledgerline stopped');
    });
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (import.meta.main) {
  main();
}
