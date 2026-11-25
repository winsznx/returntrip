import { html, type SafeHtml } from './html.ts';

export type Banner = { readonly kind: 'success' | 'error'; readonly message: string };

const LOGO = html`<svg class="brand-mark" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
  <rect x="2" y="2" width="20" height="20" rx="6" class="brand-mark-bg" />
  <path d="M7 7v10h10" class="brand-mark-axis" />
  <path d="M9.5 14l2.5-2.5 2 2 3-3.5" class="brand-mark-trend" />
</svg>`;

export function renderDocument(page: { readonly title: string; readonly body: SafeHtml }): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title} · Ledgerline</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/">${LOGO}<span>Ledgerline</span></a>
    <nav aria-label="Primary"><a class="nav-link" href="/">Workspaces</a></nav>
  </div>
</header>
<main id="main" class="shell">
${page.body}
</main>
<footer class="footer"><div class="shell">Ledgerline stores every amount as exact cents.</div></footer>
</body>
</html>
`.value;
}

export function renderBanner(banner: Banner | undefined): SafeHtml {
  if (banner === undefined) {
    return html``;
  }
  return banner.kind === 'success'
    ? html`<div class="banner banner-success" role="status">${banner.message}</div>`
    : html`<div class="banner banner-error" role="alert">${banner.message}</div>`;
}
