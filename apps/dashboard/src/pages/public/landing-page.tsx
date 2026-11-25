import { type ReactNode, useEffect } from 'react';
import { Link } from 'react-router';

import { CopyButton } from '../../components/copy-button.tsx';
import { Icon } from '../../components/icons.tsx';
import { OutcomeBadge } from '../../components/outcome-badge.tsx';
import { RawValue } from '../../components/run/record-inspector.tsx';
import { DiffView } from '../../components/run/repair-panel.tsx';
import { LoadError, Loading } from '../../components/state-message.tsx';
import { evidenceUrl, fetchText, loadPublicIndex, loadPublicRun } from '../../lib/evidence.ts';
import {
  formatBytes,
  formatCount,
  formatCredits,
  formatDate,
  formatDuration,
  formatRatio,
  formatUsd,
  plural,
  shortHash,
} from '../../lib/format.ts';
import { pickRecordedRuns, type RecordedTotals, recordedTotals } from '../../lib/recorded.ts';
import { comparisonFor, describeEdge, EDGE_LABELS, EDGES } from '../../lib/run-model.ts';
import type { Difference, PublicIndexEntry, PublicRun, StageReport } from '../../lib/types.ts';
import { useDocumentTitle } from '../../lib/use-document-title.ts';
import { useResource } from '../../lib/use-resource.ts';
import { SITE } from '../../site.ts';
import { RecordedRunsTable } from './recorded-runs-page.tsx';
import { RecordedTotalsLine } from './recorded-totals.tsx';

interface LandingData {
  readonly runs: readonly PublicIndexEntry[];
  readonly healthy: PublicRun | null;
  readonly defect: PublicRun | null;
  readonly realApp: PublicRun | null;
  readonly patch: string | null;
}

async function loadLanding(signal: AbortSignal): Promise<LandingData> {
  const index = await loadPublicIndex(signal);
  const picks = pickRecordedRuns(index.runs);
  const [healthy, defect, realApp] = await Promise.all([
    picks.healthy ? loadPublicRun(picks.healthy.runId, signal) : Promise.resolve(null),
    picks.defect ? loadPublicRun(picks.defect.runId, signal) : Promise.resolve(null),
    picks.realApp ? loadPublicRun(picks.realApp.runId, signal) : Promise.resolve(null),
  ]);
  const patchFile = defect?.files.find((file) => file.kind === 'patch');
  const patch =
    defect && patchFile
      ? await fetchText(evidenceUrl(`${defect.report.runId}/${patchFile.file}`), signal)
      : null;
  return { runs: index.runs, healthy, defect, realApp, patch };
}

const INSTALL_COMMANDS = [
  'npm install -g @testmuai/kane-cli && kane-cli login --oauth',
  `git clone ${SITE.repoUrl} && cd returntrip`,
  'pnpm install && pnpm build',
  'node apps/cli/bin/returntrip.js verify --config examples/payment-roundtrip/returntrip.yaml',
];

export function LandingPage() {
  useDocumentTitle('ReturnTrip');
  const { resource, reload } = useResource('landing', loadLanding);
  const ready = resource.status === 'ready';
  // Section anchors only exist once the recorded runs have loaded, after the browser tried to scroll.
  useEffect(() => {
    if (!ready || !window.location.hash) return;
    document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView();
  }, [ready]);
  if (resource.status === 'loading') {
    return (
      <div className="shell">
        <Loading label="Loading recorded runs" />
      </div>
    );
  }
  if (resource.status === 'error') {
    return (
      <div className="shell">
        <LoadError error={resource.error} onRetry={reload} />
      </div>
    );
  }
  const data = resource.data;
  const hero = data.defect ?? data.healthy;
  return (
    <>
      <Hero run={hero} />
      <Problem />
      <HowItWorks run={data.healthy} />
      <ClosedLoop run={data.defect} patch={data.patch} />
      {data.realApp ? <RealApp run={data.realApp} /> : null}
      <RecordedRuns runs={data.runs} totals={recordedTotals(data.runs)} />
      <Install />
      <Limits limitations={data.healthy?.report.limitations ?? data.defect?.report.limitations ?? []} />
      <CallToAction />
    </>
  );
}

function SectionHeading({ id, title, children }: { id: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex max-w-[46rem] flex-col gap-4">
      <h2 id={id} className="text-[44px] sm:text-[64px]">
        {title}
      </h2>
      {children ? <div className="text-[17px] text-muted">{children}</div> : null}
    </div>
  );
}

/* ---------- hero ---------- */

function restoreShot(run: PublicRun): { src: string; remark: string | null } | null {
  const shots = run.screenshots.filter((shot) => shot.attempt === 1 && shot.stage === 'restore');
  const last = shots.at(-1);
  if (!last) return null;
  const stage = run.report.attempts[0]?.stages.findLast((item) => item.stage === 'restore');
  return {
    src: evidenceUrl(`${run.report.runId}/${last.file}`),
    remark: stage?.steps.at(-1)?.remark ?? null,
  };
}

function importAssertion(run: PublicRun): StageReport['assertions'][number] | null {
  const stage = run.report.attempts[0]?.stages.findLast((item) => item.stage === 'restore');
  return stage?.assertions.find((item) => item.condition?.includes('Import successful')) ?? null;
}

function Hero({ run }: { run: PublicRun | null }) {
  return (
    <section aria-labelledby="hero-heading" className="relative overflow-hidden border-b border-line">
      <div className="shell flex flex-col gap-10 pt-14 pb-16 sm:pt-20">
        <div className="flex max-w-[52rem] flex-col gap-6">
          <h1
            id="hero-heading"
            className="text-[40px] min-[420px]:text-[48px] sm:text-[80px] lg:text-[104px]"
          >
            &ldquo;Import successful.&rdquo; Now prove it.
          </h1>
          <p className="max-w-[40rem] text-[18px] text-muted sm:text-[20px]">
            You export your app's data, import it back, and the app says it worked. ReturnTrip has Kane CLI do
            that round trip in a real browser, then checks every record that came back against a trusted
            source.
          </p>
          <div className="flex flex-wrap gap-3">
            <a className="btn btn-primary" href={SITE.demoUrl} rel="noreferrer" target="_blank">
              <Icon name="play" size={16} />
              Watch the demo
            </a>
            {run ? (
              <Link className="btn" to={`/runs/${run.report.runId}`}>
                Open the recorded run
              </Link>
            ) : null}
          </div>
        </div>
        {run ? <HeroEvidence run={run} /> : null}
      </div>
    </section>
  );
}

function HeroEvidence({ run }: { run: PublicRun }) {
  const shot = restoreShot(run);
  const assertion = importAssertion(run);
  const first = run.report.attempts[0];
  const last = run.report.attempts.at(-1);
  const summary = comparisonFor(first, 'source_reexport');
  const kane = first?.stages.findLast((item) => item.stage === 'restore');
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <figure className="panel m-0 flex flex-col overflow-hidden">
        <p className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 text-[14px]">
          <span className="font-semibold">What the app told Kane</span>
          <span className="whitespace-nowrap text-muted">Restore, attempt 1</span>
        </p>
        {shot ? (
          <a href={shot.src} target="_blank" rel="noreferrer" className="group relative block bg-white">
            {/* Crops Kane's 1920x1080 frame to the page header, the success banner and the first rows. */}
            <span className="block aspect-[750/600] overflow-hidden">
              <img
                src={shot.src}
                alt={`Kane's screenshot of the app after the restore. ${shot.remark ?? ''}`}
                width={1920}
                height={1080}
                className="block h-auto max-w-none"
                style={{ width: '256%', marginLeft: '-50.4%', marginTop: '-10.7%' }}
              />
            </span>
            <span className="absolute right-3 bottom-3 rounded-md bg-ink/85 px-2.5 py-1 text-[13px] text-text group-hover:bg-ink">
              Full screenshot
              <span className="sr-only"> (opens in a new tab)</span>
            </span>
          </a>
        ) : (
          <p className="px-4 py-10 text-muted">This run has no published screenshot.</p>
        )}
        <figcaption className="mt-auto flex flex-col gap-1 border-t border-line px-4 py-3 text-[14px]">
          {assertion ? (
            <span>
              Kane's check: <span className="mono">{assertion.condition}</span>, observed{' '}
              <span className="mono text-ok">{assertion.observed}</span>
            </span>
          ) : null}
          {kane ? (
            <span className="mono text-[13px] text-muted">
              kane-cli {kane.kaneVersion ?? 'unknown'}, {formatCredits(kane.creditsUsed)} credits,{' '}
              {formatDuration(kane.durationMs)}
            </span>
          ) : null}
        </figcaption>
      </figure>

      <div className={`panel flex flex-col ${summary && !summary.isEquivalent ? 'tone-bad' : 'tone-ok'}`}>
        <p className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 text-[14px]">
          <span className="font-semibold">What ReturnTrip found</span>
          <span className="whitespace-nowrap text-muted">{formatDate(run.recordedAt)}</span>
        </p>
        {summary ? (
          <div className="flex flex-1 flex-col gap-5 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <OutcomeBadge outcome={summary.isEquivalent ? 'VERIFIED' : 'DATA_MISMATCH'} />
              {run.report.scenario ? (
                <span className="text-[13px] text-warn">{run.report.scenario.disclosure}</span>
              ) : null}
            </div>
            <div>
              <p
                className="font-display text-[64px] leading-[0.9] font-extrabold"
                style={{ color: 'var(--tone)' }}
              >
                {formatRatio(summary.matchedIdenticalOccurrences, summary.expectedRows)}
              </p>
              <p className="mt-2 text-muted">records came back identical to the trusted source</p>
            </div>
            {summary.isEquivalent ? (
              <HeroHashes run={run} />
            ) : (
              <HeroDifferences
                items={run.differences['1']?.source_reexport?.items ?? []}
                total={run.differences['1']?.source_reexport?.total ?? 0}
              />
            )}
            {last && first && last !== first ? <AfterRepair run={run} /> : null}
          </div>
        ) : (
          <p className="p-5 text-muted">This run did not reach a comparison.</p>
        )}
      </div>
    </div>
  );
}

function HeroHashes({ run }: { run: PublicRun }) {
  const exportFile = run.files.find((file) => file.kind === 'export' && file.attempt === 1);
  const reexportFile = run.files.find((file) => file.kind === 'reexport' && file.attempt === 1);
  const first = run.report.attempts[0];
  return (
    <ul className="flex flex-col gap-2.5 text-[15px]">
      {EDGES.map((edge) => {
        const summary = comparisonFor(first, edge);
        if (!summary) return null;
        return (
          <li key={edge} className="flex items-start gap-2">
            <Icon
              name={summary.isEquivalent ? 'check' : 'cross'}
              size={18}
              className="mt-0.5 shrink-0 text-ok"
            />
            <span>
              <span className="mono">
                {formatRatio(summary.matchedIdenticalOccurrences, summary.expectedRows)}
              </span>{' '}
              <span className="text-muted">
                {EDGE_LABELS[edge].expected.toLowerCase()} vs {EDGE_LABELS[edge].observed.toLowerCase()}
              </span>
            </span>
          </li>
        );
      })}
      {exportFile && reexportFile && exportFile.sha256 === reexportFile.sha256 ? (
        <li className="flex items-start gap-2">
          <Icon name="check" size={18} className="mt-0.5 shrink-0 text-ok" />
          <span>
            <span className="text-muted">Both exports are the same bytes, sha256 </span>
            <span className="mono">{shortHash(exportFile.sha256)}</span>
          </span>
        </li>
      ) : null}
    </ul>
  );
}

function HeroDifferences({ items, total }: { items: readonly Difference[]; total: number }) {
  const changes = items.filter((item) => item.kind === 'FIELD_CHANGED').slice(0, 4);
  if (changes.length === 0) {
    return <p className="text-muted">{formatCount(total)} differences were recorded on this comparison.</p>;
  }
  const field = changes[0]?.field;
  const oneField = changes.every((item) => item.field === field);
  return (
    <div className="flex flex-col gap-2">
      {oneField && field ? (
        <p className="text-[14px] text-muted">
          Field <span className="mono text-text">{field}</span>
        </p>
      ) : null}
      <div className="scroll-x rounded-lg border border-line">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Row</th>
              {oneField ? null : <th scope="col">Field</th>}
              <th scope="col">Trusted source</th>
              <th scope="col">Came back as</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((item) => (
              <tr key={item.id}>
                <td className="mono text-muted">{item.expectedRowRefs[0] ?? ''}</td>
                {oneField ? null : <td className="mono">{item.field}</td>}
                <td className="mono whitespace-pre">
                  <RawValue value={item.expectedRaw ?? null} />
                </td>
                <td className="mono changed-cell whitespace-pre">
                  <RawValue value={item.observedRaw ?? null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[13px] text-muted">
        First {changes.length} of {formatCount(total)} differences on this comparison.
      </p>
    </div>
  );
}

function AfterRepair({ run }: { run: PublicRun }) {
  const last = run.report.attempts.at(-1);
  const summary = comparisonFor(last, 'source_reexport');
  if (!last || !summary) return null;
  return (
    <p
      className={`mt-auto flex items-start gap-2 border-t border-line pt-4 ${summary.isEquivalent ? 'text-ok' : 'text-bad'}`}
    >
      <Icon name={summary.isEquivalent ? 'repaired' : 'cross'} size={18} className="mt-0.5 shrink-0" />
      <span>
        After Claude Code's patch, Kane ran the same journey again:{' '}
        <span className="mono whitespace-nowrap">
          {formatRatio(summary.matchedIdenticalOccurrences, summary.expectedRows)}
        </span>{' '}
        identical.
      </span>
    </p>
  );
}

/* ---------- real app ---------- */

function RealApp({ run }: { run: PublicRun }) {
  const shot = restoreShot(run);
  const attempt = run.report.attempts[0];
  const summary = comparisonFor(attempt, 'source_reexport');
  const firstExport = comparisonFor(attempt, 'source_export');
  const differences = run.differences['1']?.source_reexport;
  return (
    <section aria-labelledby="real-app-heading" className="shell pt-24 sm:pt-32">
      <SectionHeading id="real-app-heading" title="Then we pointed it at the real app.">
        <p>
          Sure, the open-source finance app from the pull request above, running unmodified from its own
          published image at the commit before the fix. Kane logged in, exported the family data, imported{' '}
          <span className="mono text-text">transactions.csv</span> into an empty family through Sure's
          five-step wizard, kept the default settings, and exported again.
        </p>
      </SectionHeading>
      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        {shot ? (
          <figure className="panel overflow-hidden">
            <img
              src={shot.src}
              alt="Kane's screenshot of Sure after the import: Import successful"
              className="w-full"
            />
            <figcaption className="border-t border-line px-5 py-3 text-[14px] text-muted">
              Kane's own screenshot of Sure after the import.
            </figcaption>
          </figure>
        ) : null}
        <div className="panel flex flex-col gap-5 p-6">
          <OutcomeBadge outcome={run.report.outcome ?? 'INCONCLUSIVE'} />
          {summary ? (
            <p className="font-display text-[44px] leading-none font-extrabold text-bad">
              {formatRatio(summary.matchedIdenticalOccurrences, summary.expectedRows)}
              <span className="mt-2 block font-sans text-[17px] font-normal text-muted">
                transactions came back identical. The first export was{' '}
                {firstExport?.isEquivalent ? 'clean' : 'already different'}, so the change happened on the way
                back in.
              </span>
            </p>
          ) : null}
          {differences ? <HeroDifferences items={differences.items} total={differences.total} /> : null}
          <p className="text-[15px] text-muted">
            This is the bug Sure fixed in pull request #4754, caught from the outside, with no access to
            Sure's code.
          </p>
          <Link className="text-link text-[15px]" to={`/runs/${run.report.runId}`}>
            Open the recorded Sure run
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ---------- problem ---------- */

function Problem() {
  return (
    <section aria-labelledby="problem-heading" className="shell pt-24 sm:pt-32">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-20">
        <div className="flex flex-col gap-8">
          <h2 id="problem-heading" className="text-[44px] sm:text-[64px]">
            The app said it worked. The money went the wrong way.
          </h2>
          <figure className="m-0 border-l-4 border-bad pl-6">
            <blockquote className="m-0 font-display text-[28px] leading-[1.15] font-semibold sm:text-[36px]">
              &ldquo;Re-importing Sure's own transactions.csv export flips every amount, so expenses come back
              as income.&rdquo;
            </blockquote>
            <figcaption className="mt-4 text-[15px] text-muted">
              <a className="text-link" href={SITE.anchorPrUrl} rel="noreferrer" target="_blank">
                Sure pull request #4754
              </a>
              , an open source personal finance app
            </figcaption>
          </figure>
        </div>
        <div className="flex flex-col gap-6 text-[17px] text-muted lg:pt-4">
          <p>
            Nothing crashed. The file was the app's own export. The import screen said success. The only way
            to catch it was to compare what came back with what went out.
          </p>
          <p>
            A browser test can tell you whether its own check was right. It can't tell you which data is
            right. In our preflight, a page showed 3 records where the check expected 5, and Kane's triage
            called it a <span className="mono text-text">test_data_issue</span>: a fair call for a browser
            test, and the reason the data verdict has to come from a trusted source.
          </p>
          <p className="text-text">
            So Kane drives the browser, and ReturnTrip's comparator decides whether the data came back.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ---------- how it works ---------- */

function stageOf(run: PublicRun | null, name: string): StageReport | undefined {
  return run?.report.attempts[0]?.stages.findLast((stage) => stage.stage === name);
}

function HowItWorks({ run }: { run: PublicRun | null }) {
  const exportStage = stageOf(run, 'export');
  const createStage = stageOf(run, 'create-destination');
  const restoreStage = stageOf(run, 'restore');
  const reexportStage = stageOf(run, 'reexport');
  const exportFile = run?.files.find((file) => file.kind === 'export' && file.attempt === 1);
  const sourceFile = run?.files.find((file) => file.kind === 'source');
  const first = run?.report.attempts[0];
  const total = comparisonFor(first, 'source_reexport');

  const steps: { title: string; body: string; facts: string[] }[] = [
    {
      title: 'Kane exports',
      body: 'Kane opens your app, checks the record count on the page, and clicks Export. A capture proxy keeps the exact bytes the app sent.',
      facts: [
        ...(exportFile
          ? [`${formatBytes(exportFile.byteLength)} captured, sha256 ${shortHash(exportFile.sha256)}`]
          : []),
        ...(exportStage
          ? [`${formatCredits(exportStage.creditsUsed)} credits, ${formatDuration(exportStage.durationMs)}`]
          : []),
      ],
    },
    {
      title: 'Kane restores into an empty workspace',
      body: 'Kane creates a new, empty workspace and uploads that same file. ReturnTrip checks the upload byte for byte against the captured export.',
      facts: [
        ...(createStage && restoreStage
          ? [
              `${formatCredits((createStage.creditsUsed ?? 0) + (restoreStage.creditsUsed ?? 0))} credits, ${formatDuration(createStage.durationMs + restoreStage.durationMs)}`,
            ]
          : []),
        ...(restoreStage?.oneLiner ? [`Kane: ${restoreStage.oneLiner}`] : []),
      ],
    },
    {
      title: 'Kane exports again',
      body: 'Kane exports the restored workspace. ReturnTrip compares the trusted source, the first export and the second export, every record and every field.',
      facts: [
        ...(reexportStage
          ? [
              `${formatCredits(reexportStage.creditsUsed)} credits, ${formatDuration(reexportStage.durationMs)}`,
            ]
          : []),
        ...(total
          ? [`${formatRatio(total.matchedIdenticalOccurrences, total.expectedRows)} records identical`]
          : []),
      ],
    },
  ];

  return (
    <section id="how" aria-labelledby="how-heading" className="shell scroll-mt-20 pt-24 sm:pt-32">
      <SectionHeading id="how-heading" title="Out and back, in a real browser.">
        <p>
          The trusted source is data you already know is right.{' '}
          {sourceFile && total ? (
            <>
              In the recorded run it is {formatCount(total.expectedRows)} real City of Chicago payments,
              sha256 <span className="mono text-text">{shortHash(sourceFile.sha256)}</span>.
            </>
          ) : null}
        </p>
      </SectionHeading>

      <ol className="mt-14 grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-0">
        {steps.map((step, index) => (
          <li key={step.title} className="relative flex flex-col gap-4 md:pr-8">
            <div className="flex items-center gap-0" aria-hidden="true">
              <span className="z-10 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-4 border-route bg-ink font-display text-[22px] font-extrabold text-route">
                {index + 1}
              </span>
              {index < steps.length - 1 ? (
                <span className="hidden h-1 flex-1 bg-route md:-mr-8 md:block" />
              ) : null}
            </div>
            <h3 className="text-[30px] sm:text-[34px]">
              <span className="sr-only">Step {index + 1}: </span>
              {step.title}
            </h3>
            <p className="text-muted">{step.body}</p>
            {step.facts.length > 0 ? (
              <ul className="flex flex-col gap-1 text-[13px] text-text">
                {step.facts.map((fact) => (
                  <li key={fact} className={fact.startsWith('Kane: ') ? 'text-[14px] text-muted' : 'mono'}>
                    {fact}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="mt-10 hidden md:block" aria-hidden="true">
        <div className="ml-[22px] h-10 w-2/3 rounded-b-2xl border-2 border-t-0 border-dashed border-route" />
      </div>
      <p className="mt-4 flex items-start gap-2 text-[17px] md:mt-3">
        <Icon name="repaired" size={20} className="mt-1 shrink-0 text-route" />
        <span>
          The data comes back to where it started and is checked there. Kane's pass or fail is kept as
          evidence, but only the comparison decides the verdict.
        </span>
      </p>
    </section>
  );
}

/* ---------- closed loop ---------- */

function ClosedLoop({ run, patch }: { run: PublicRun | null; patch: string | null }) {
  const repairs = run?.report.repairs ?? [];
  const accepted = repairs.filter((repair) => repair.reason === null).at(-1) ?? null;
  const first = run?.report.attempts[0];
  const last = run?.report.attempts.at(-1);
  const before = comparisonFor(first, 'source_reexport');
  const after = first !== last ? comparisonFor(last, 'source_reexport') : null;

  const parts = [
    {
      title: 'The evidence',
      body: 'Claude Code gets the exact record differences, the Kane steps and the files. Nothing is summarized away.',
    },
    {
      title: 'A patch on a copy',
      body: 'It edits a disposable copy of the app, only inside the paths you approved, within an attempt and spend cap. The trusted source and the contract stay locked.',
    },
    {
      title: 'The same journey again',
      body: 'Kane reruns export, restore and export on the patched copy. Only a clean comparison counts as fixed. You get a .patch file to review. Nothing is merged or deployed.',
    },
  ];

  return (
    <section aria-labelledby="loop-heading" className="shell pt-24 sm:pt-32">
      <SectionHeading
        id="loop-heading"
        title="When data breaks, Claude Code fixes a copy. Kane proves the fix."
      />
      <div className="mt-12 grid grid-cols-1 gap-px overflow-hidden rounded-[10px] border border-line bg-line md:grid-cols-3">
        {parts.map((part) => (
          <div key={part.title} className="flex flex-col gap-3 bg-raised p-6">
            <h3 className="text-[28px]">{part.title}</h3>
            <p className="text-muted">{part.body}</p>
          </div>
        ))}
      </div>

      {run && before && after ? (
        <div className="mt-10 flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <OutcomeBadge outcome={run.report.outcome} />
            {run.report.scenario ? (
              <span className="text-[14px] text-warn">{run.report.scenario.disclosure}</span>
            ) : null}
            <Link className="text-link text-[15px]" to={`/runs/${run.report.runId}`}>
              Open this run
            </Link>
          </div>
          <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            <LoopFact
              term="Before the patch"
              value={formatRatio(before.matchedIdenticalOccurrences, before.expectedRows)}
              tone="bad"
            />
            <LoopFact
              term="After the patch"
              value={formatRatio(after.matchedIdenticalOccurrences, after.expectedRows)}
              tone={after.isEquivalent ? 'ok' : 'bad'}
            />
            {accepted ? (
              <LoopFact
                term="Files and lines changed"
                value={`${plural(accepted.files.length, 'file')}, ${plural(accepted.linesChanged, 'line')}`}
              />
            ) : null}
            <LoopFact term="Claude Code spend" value={formatUsd(run.report.agent.usd)} />
          </dl>
          {accepted?.cause ? (
            <p className="max-w-[62ch] text-[17px]">
              <span className="text-muted">Cause, as Claude Code stated it: </span>
              {accepted.cause}
            </p>
          ) : null}
          {patch ? <DiffView text={patch} /> : null}
          <p className="text-[15px] text-muted">{describeEdge(after)}</p>
        </div>
      ) : null}
    </section>
  );
}

function LoopFact({ term, value, tone }: { term: string; value: string; tone?: 'ok' | 'bad' }) {
  return (
    <div className="flex flex-col gap-1 bg-raised px-5 py-4">
      <dt className="order-2 text-[14px] text-muted">{term}</dt>
      <dd
        className={`order-1 font-display text-[36px] leading-none font-extrabold ${tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}

/* ---------- recorded runs ---------- */

function RecordedRuns({ runs, totals }: { runs: readonly PublicIndexEntry[]; totals: RecordedTotals }) {
  return (
    <section aria-labelledby="runs-heading" className="shell pt-24 sm:pt-32">
      <SectionHeading id="runs-heading" title="Recorded runs, misses included.">
        <p>
          Every number here comes from a saved run you can open: Kane credits, wall time, outcome. Recreated
          defects are labeled as such.
        </p>
      </SectionHeading>
      <div className="mt-10 flex flex-col gap-6">
        <RecordedTotalsLine totals={totals} />
        <RecordedRunsTable runs={runs.slice(0, 6)} />
        {runs.length > 6 ? (
          <Link className="text-link self-start" to="/runs">
            See all {formatCount(runs.length)} recorded runs
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/* ---------- install ---------- */

function Install() {
  const script = INSTALL_COMMANDS.join('\n');
  return (
    <section id="install" aria-labelledby="install-heading" className="shell scroll-mt-20 pt-24 sm:pt-32">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
        <SectionHeading id="install-heading" title="Run it yourself in four commands.">
          <p>
            You need Node 24 or newer, pnpm, Chrome and a Kane CLI account. Repair also needs Claude Code. The
            demo config runs the same Chicago payments journey shown on this page.
          </p>
          <p className="mt-4">
            Run <span className="mono text-text">returntrip doctor</span> first. It checks your setup and
            spends nothing.
          </p>
        </SectionHeading>
        <div className="panel overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <span className="text-[14px] text-muted">Terminal</span>
            <CopyButton text={script} label="Copy all four commands" />
          </div>
          <ol className="scroll-x flex flex-col gap-3 bg-sunken p-4">
            {INSTALL_COMMANDS.map((command, index) => (
              <li key={command} className="mono flex gap-3 text-[14px] whitespace-pre">
                <span className="text-faint select-none" aria-hidden="true">
                  {index + 1}
                </span>
                <code>{command}</code>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ---------- limits ---------- */

function Limits({ limitations }: { limitations: readonly string[] }) {
  if (limitations.length === 0) return null;
  return (
    <section aria-labelledby="limits-heading" className="shell pt-24 sm:pt-32">
      <SectionHeading id="limits-heading" title="What it does not prove." />
      <ul className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
        {limitations.map((limit) => (
          <li key={limit} className="border-l-2 border-line-strong pl-5 text-[17px] text-muted">
            {limit}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------- call to action ---------- */

function CallToAction() {
  return (
    <section aria-labelledby="cta-heading" className="shell pt-24 sm:pt-32">
      <div className="flex flex-col gap-6 rounded-[14px] border border-route-deep bg-raised px-6 py-12 sm:px-12">
        <h2 id="cta-heading" className="max-w-[18ch] text-[44px] sm:text-[64px]">
          Check what comes back before your users do.
        </h2>
        <div className="flex flex-wrap gap-3">
          <a className="btn btn-primary" href={SITE.demoUrl} rel="noreferrer" target="_blank">
            <Icon name="play" size={16} />
            Watch the demo
          </a>
          <a className="btn" href={SITE.repoUrl} rel="noreferrer" target="_blank">
            <Icon name="github" size={16} />
            Get the code on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
