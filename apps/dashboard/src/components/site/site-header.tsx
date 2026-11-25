import { Link, NavLink } from 'react-router';

import { MODE } from '../../mode.ts';
import { SITE } from '../../site.ts';
import { Icon } from '../icons.tsx';
import { Wordmark } from './logo.tsx';

const navClass = ({ isActive }: { isActive: boolean }): string =>
  `inline-flex min-h-11 items-center px-1 text-[15px] hover:text-text ${isActive ? 'text-text' : 'text-muted'}`;

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-ink/90 backdrop-blur supports-[backdrop-filter]:bg-ink/75 sticky top-0 z-40">
      <div className="shell flex min-h-16 items-center justify-between gap-4">
        <Link to="/" className="rounded-md" aria-label="ReturnTrip home">
          <Wordmark />
        </Link>
        {MODE === 'public' ? <PublicNav /> : <LocalNav />}
      </div>
    </header>
  );
}

function PublicNav() {
  return (
    <nav aria-label="Main" className="flex items-center gap-4 sm:gap-7">
      <a
        href={`${import.meta.env.BASE_URL}#how`}
        className="hidden min-h-11 items-center text-[15px] text-muted hover:text-text md:inline-flex"
      >
        How it works
      </a>
      {SITE.repoUrl ? (
        <a
          href={`${import.meta.env.BASE_URL}#install`}
          className="hidden min-h-11 items-center text-[15px] text-muted hover:text-text md:inline-flex"
        >
          Install
        </a>
      ) : null}
      <NavLink to="/runs" className={navClass}>
        Runs
      </NavLink>
      {SITE.repoUrl ? (
        <a href={SITE.repoUrl} className="btn btn-small" rel="noreferrer" target="_blank">
          <Icon name="github" size={16} />
          <span>GitHub</span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : null}
    </nav>
  );
}

function LocalNav() {
  return (
    <nav aria-label="Main" className="flex items-center gap-5">
      <NavLink to="/" end className={navClass}>
        Projects
      </NavLink>
      <NavLink to="/runs" className={navClass}>
        Runs
      </NavLink>
      <span className="hidden rounded-full border border-line px-3 py-1 text-[13px] text-muted sm:inline">
        Local, 127.0.0.1 only
      </span>
    </nav>
  );
}
