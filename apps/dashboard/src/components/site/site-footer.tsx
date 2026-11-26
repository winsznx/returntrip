import { disclaimer } from '../../../../../examples/payment-roundtrip/provenance.json';
import { SITE } from '../../site.ts';
import { Wordmark } from './logo.tsx';

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-line bg-sunken">
      <div className="shell grid grid-cols-1 gap-10 py-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex flex-col gap-4">
          <Wordmark />
          <p className="max-w-sm text-muted">Prove your app gives back the data it exported.</p>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[15px]">
            {SITE.repoUrl ? (
              <li>
                <a className="text-link" href={SITE.repoUrl} rel="noreferrer" target="_blank">
                  Source on GitHub
                </a>
              </li>
            ) : null}
            {SITE.demoUrl ? (
              <li>
                <a className="text-link" href={SITE.demoUrl} rel="noreferrer" target="_blank">
                  Demo video
                </a>
              </li>
            ) : null}
          </ul>
        </div>
        <div className="flex flex-col gap-4 text-[14px] text-muted">
          <p>
            Data:{' '}
            <a className="text-link" href={SITE.datasetUrl} rel="noreferrer" target="_blank">
              City of Chicago Payments (s4vu-giwb)
            </a>
            , the City&rsquo;s official dataset. Every row is verified against its official export.
          </p>
          <p className="text-faint">{disclaimer}</p>
        </div>
      </div>
    </footer>
  );
}
