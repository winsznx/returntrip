import { WORKSPACE_NAME_MAX_LENGTH, type WorkspaceSummary } from '../domain/workspace.ts';
import { formatCount, formatCreatedAt } from './format.ts';
import { html, type SafeHtml } from './html.ts';
import { type Banner, renderBanner, renderDocument } from './layout.ts';

export interface WorkspacesPageModel {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly banner?: Banner;
  readonly draftName?: string;
}

export function renderWorkspacesPage(model: WorkspacesPageModel): string {
  const body = html`
<div class="page-head">
  <div>
    <h1>Workspaces</h1>
    <p class="lede">Each workspace keeps its own payment ledger. Move payments between workspaces with a CSV export and import.</p>
  </div>
</div>
${renderBanner(model.banner)}
<div class="split">
  <section class="card" aria-labelledby="workspace-list-heading">
    <div class="card-head">
      <h2 id="workspace-list-heading">All workspaces</h2>
      <p class="card-meta">${formatCount(model.workspaces.length, 'workspace', 'workspaces')}</p>
    </div>
    ${model.workspaces.length === 0 ? renderEmptyList() : renderWorkspaceTable(model.workspaces)}
  </section>
  <section class="card" aria-labelledby="create-workspace-heading">
    <div class="card-head"><h2 id="create-workspace-heading">New workspace</h2></div>
    <form class="form" method="post" action="/workspaces">
      <div class="field">
        <label for="workspace-name">Workspace name</label>
        <input id="workspace-name" name="name" type="text" required maxlength="${WORKSPACE_NAME_MAX_LENGTH}"
          autocomplete="off" aria-describedby="workspace-name-hint" value="${model.draftName ?? ''}">
        <p id="workspace-name-hint" class="hint">Also sets the address, so "City Payments 2024" lives at /w/city-payments-2024.</p>
      </div>
      <button class="button button-primary" type="submit">Create workspace</button>
    </form>
  </section>
</div>`;
  return renderDocument({ title: 'Workspaces', body });
}

function renderEmptyList(): SafeHtml {
  return html`<p class="empty-state">No workspaces yet. Create the first one to start a ledger.</p>`;
}

function renderWorkspaceTable(workspaces: readonly WorkspaceSummary[]): SafeHtml {
  const rows = workspaces.map(
    (workspace) => html`<tr>
      <th scope="row"><a class="row-link" href="/w/${workspace.slug}">${workspace.name}</a></th>
      <td class="mono muted">/w/${workspace.slug}</td>
      <td class="num">${formatCount(workspace.recordCount, 'record', 'records')}</td>
      <td class="muted">${formatCreatedAt(workspace.createdAt)}</td>
    </tr>`,
  );
  return html`<div class="table-scroll">
    <table class="table">
      <thead><tr><th scope="col">Name</th><th scope="col">Address</th><th scope="col" class="num">Records</th><th scope="col">Created</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}
