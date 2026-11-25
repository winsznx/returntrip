import { type ComponentType, lazy, Suspense, useEffect, useRef } from 'react';
import { Link, Outlet, Route, Routes, useLocation } from 'react-router';

import { SiteHeader } from './components/site/site-header.tsx';
import { ErrorText, Loading } from './components/state-message.tsx';
import { useDocumentTitle } from './lib/use-document-title.ts';

interface ModePages {
  readonly Home: ComponentType;
  readonly Runs: ComponentType;
  readonly Run: ComponentType;
  readonly Footer: ComponentType | null;
}

/*
 * The mode test is written inline, not through MODE, so the bundler sees a literal comparison
 * after env replacement and drops the other mode's pages: the local dashboard never ships the
 * public site, and the reverse.
 */
const PAGES: ModePages =
  import.meta.env.VITE_RT_MODE === 'public'
    ? {
        Home: lazy(() => import('./pages/public/landing-page.tsx').then((m) => ({ default: m.LandingPage }))),
        Runs: lazy(() =>
          import('./pages/public/recorded-runs-page.tsx').then((m) => ({ default: m.RecordedRunsPage })),
        ),
        Run: lazy(() =>
          import('./pages/public/recorded-run-page.tsx').then((m) => ({ default: m.RecordedRunPage })),
        ),
        Footer: lazy(() =>
          import('./components/site/site-footer.tsx').then((m) => ({ default: m.SiteFooter })),
        ),
      }
    : {
        Home: lazy(() =>
          import('./pages/local/projects-page.tsx').then((m) => ({ default: m.ProjectsPage })),
        ),
        Runs: lazy(() => import('./pages/local/history-page.tsx').then((m) => ({ default: m.HistoryPage }))),
        Run: lazy(() => import('./pages/local/live-run-page.tsx').then((m) => ({ default: m.LiveRunPage }))),
        Footer: null,
      };

/** Client-side navigation keeps the old scroll position unless told otherwise; new pages start at the top. */
function useScrollToTopOnNavigate(): void {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    if (!window.location.hash) window.scrollTo(0, 0);
  }, [pathname]);
}

function Layout({ sessionError }: { sessionError: unknown }) {
  useScrollToTopOnNavigate();
  const { Footer } = PAGES;
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      {sessionError ? (
        <div className="border-b border-line bg-warn-wash" role="alert">
          <p className="shell py-3 text-warn">
            <ErrorText error={sessionError} />
          </p>
        </div>
      ) : null}
      <main id="main" tabIndex={-1} className="outline-none">
        <Suspense
          fallback={
            <div className="shell">
              <Loading label="Loading" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
      {Footer ? (
        <Suspense fallback={null}>
          <Footer />
        </Suspense>
      ) : (
        <div className="h-24" />
      )}
    </>
  );
}

function NotFound() {
  useDocumentTitle('Not found');
  return (
    <div className="shell flex flex-col gap-4 pt-16">
      <h1 className="text-[48px]">Nothing at this address.</h1>
      <p className="text-muted">
        <Link className="text-link" to="/">
          Go to the start
        </Link>{' '}
        or{' '}
        <Link className="text-link" to="/runs">
          open the runs
        </Link>
        .
      </p>
    </div>
  );
}

export function App({ sessionError }: { sessionError: unknown }) {
  const { Home, Runs, Run } = PAGES;
  return (
    <Routes>
      <Route element={<Layout sessionError={sessionError} />}>
        <Route index element={<Home />} />
        <Route path="runs" element={<Runs />} />
        <Route path="runs/:id" element={<Run />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
