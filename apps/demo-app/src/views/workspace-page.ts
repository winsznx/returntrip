import type { Payment } from '../domain/payment.ts';
import type { Workspace } from '../domain/workspace.ts';
import { formatCount, formatMoney } from './format.ts';
import { html, type SafeHtml } from './html.ts';
import { type Banner, renderBanner, renderDocument } from './layout.ts';

export interface WorkspacePageModel {
  readonly workspace: Workspace;
  readonly recordCount: number;
  readonly payments: readonly Payment[];
  readonly page: number;
  readonly pageCount: number;
  readonly pageSize: number;
  readonly banner?: Banner;
}

export function renderWorkspacePage(model: WorkspacePageModel): string {
  const { workspace } = model;
  const base = `/w/${workspace.slug}`;
  const body = html`
<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/">Workspaces</a><span aria-hidden="true">/</span><span aria-current="page">${workspace.name}</span>
</nav>
<div class="page-head">
  <div>
    <h1>${workspace.name}</h1>
    <p class="lede"><span id="record-count">${formatCount(model.recordCount, 'record', 'records')}</span>
      <span class="dot" aria-hidden="true"></span><span class="mono">${base}</span></p>
  </div>
  <div class="actions">
    <a class="button button-secondary" href="${base}/export.csv">Export CSV</a>
  </div>
</div>
${renderBanner(model.banner)}
<section class="card upload" aria-labelledby="upload-heading">
  <div class="card-head"><h2 id="upload-heading">Add payments from a file</h2></div>
  <form class="form form-inline" method="post" action="${base}/import" enctype="multipart/form-data">
    <div class="field">
      <label for="csv-file">CSV file</label>
      <input id="csv-file" name="file" type="file" accept=".csv,text/csv" required aria-describedby="csv-file-hint">
      <p id="csv-file-hint" class="hint">UTF-8, up to 10 MiB, with the same header as an export. Every row is checked first; if one is invalid, nothing is added.</p>
    </div>
    <button class="button button-primary" type="submit">Import</button>
  </form>
</section>
<section class="card ledger" aria-labelledby="payments-heading">
  <div class="card-head">
    <h2 id="payments-heading">Payments</h2>
    <p class="card-meta">${describeRange(model)}</p>
  </div>
  ${model.payments.length === 0 ? renderEmptyLedger() : renderPaymentTable(model.payments)}
  ${renderPagination(base, model.page, model.pageCount)}
</section>`;
  return renderDocument({ title: workspace.name, body });
}

function describeRange(model: WorkspacePageModel): string {
  if (model.recordCount === 0) {
    return 'Nothing recorded yet';
  }
  const first = (model.page - 1) * model.pageSize + 1;
  const last = first + model.payments.length - 1;
  return `Showing ${first.toLocaleString('en-US')}–${last.toLocaleString('en-US')} of ${model.recordCount.toLocaleString('en-US')}`;
}

function renderEmptyLedger(): SafeHtml {
  return html`<p class="empty-state">No payments yet. Import a CSV file to add some.</p>`;
}

function renderPaymentTable(payments: readonly Payment[]): SafeHtml {
  const rows = payments.map(
    (payment) => html`<tr>
      <td class="mono">${payment.voucherNumber ?? html`<span class="none">None</span>`}</td>
      <td class="num mono${payment.amountCents < 0n ? ' negative' : ''}">${formatMoney(payment.amountCents)}</td>
      <td class="mono">${payment.checkDate}</td>
      <td>${payment.departmentName ?? html`<span class="none">None</span>`}</td>
      <td class="mono">${payment.contractNumber}</td>
      <td class="vendor">${payment.vendorName}</td>
    </tr>`,
  );
  return html`<div class="table-scroll ledger-scroll">
    <table class="table payments">
      <thead><tr>
        <th scope="col">Voucher</th>
        <th scope="col" class="num">Amount</th>
        <th scope="col">Check date</th>
        <th scope="col">Department</th>
        <th scope="col">Contract</th>
        <th scope="col">Vendor</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderPagination(base: string, page: number, pageCount: number): SafeHtml {
  if (pageCount <= 1) {
    return html``;
  }
  const previous =
    page > 1
      ? html`<a class="button button-quiet" rel="prev" href="${base}?page=${page - 1}">Previous</a>`
      : html`<span class="button button-quiet is-disabled" aria-disabled="true">Previous</span>`;
  const next =
    page < pageCount
      ? html`<a class="button button-quiet" rel="next" href="${base}?page=${page + 1}">Next</a>`
      : html`<span class="button button-quiet is-disabled" aria-disabled="true">Next</span>`;
  return html`<nav class="pagination" aria-label="Pagination">
    ${previous}<span class="page-indicator">Page ${page} of ${pageCount}</span>${next}
  </nav>`;
}
