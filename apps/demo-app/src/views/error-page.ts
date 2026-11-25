import { html } from './html.ts';
import { renderDocument } from './layout.ts';

export function renderErrorPage(error: { readonly title: string; readonly message: string }): string {
  const body = html`
<section class="card error-card">
  <h1>${error.title}</h1>
  <p class="lede">${error.message}</p>
  <p><a class="button button-secondary" href="/">Back to workspaces</a></p>
</section>`;
  return renderDocument({ title: error.title, body });
}
