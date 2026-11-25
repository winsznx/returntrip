import { type EvidenceSource, type FileRef, fetchJson } from '../../lib/evidence.ts';
import { formatBytes, shortHash } from '../../lib/format.ts';
import type { RunReport } from '../../lib/types.ts';
import { useResource } from '../../lib/use-resource.ts';
import { Icon } from '../icons.tsx';

const FILE_LABELS: Readonly<Record<string, string>> = {
  source: 'Trusted source',
  export: 'First export, as captured',
  'restore-upload': 'Restore upload record',
  reexport: 'Export after restore, as captured',
  patch: "Claude Code's patch, written from this attempt's evidence",
};

const ORDER = ['source', 'export', 'restore-upload', 'reexport', 'patch'];

interface RestoreUpload {
  readonly sha256: string;
  readonly byteLength: number;
  readonly fileName: string;
  readonly exportSha256: string | null;
}

export function FilesPanel({ report, source }: { report: RunReport; source: EvidenceSource }) {
  const files = [...source.files()].sort(
    (a, b) => a.attempt - b.attempt || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind),
  );
  const attempts = [...new Set(files.map((file) => file.attempt))];
  return (
    <section aria-labelledby="files-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 id="files-heading" className="text-[34px] sm:text-[44px]">
          Files and hashes
        </h2>
        <p className="max-w-[62ch] text-muted">
          A capture proxy recorded the real bytes each export sent to the browser. The restore check proves
          Kane uploaded exactly those bytes, not a file it made up.
        </p>
      </div>
      {files.length === 0 ? <p className="text-muted">No files were captured for this run.</p> : null}
      {attempts.map((attempt) => (
        <div key={attempt} className="flex flex-col gap-3">
          <h3 className="font-sans text-[15px] font-semibold text-muted">
            {attempt === 0 ? 'Inputs' : `Attempt ${attempt}`}
          </h3>
          <ul className="panel divide-y divide-line">
            {files
              .filter((file) => file.attempt === attempt)
              .map((file) => (
                <li key={file.href} className="flex flex-col gap-2 px-4 py-4">
                  <FileRow file={file} />
                  {file.kind === 'restore-upload' ? (
                    <Lineage file={file} exportFile={findExport(files, attempt)} />
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      ))}
      <p className="text-[14px] text-muted">
        Config hash <span className="mono text-text">{shortHash(report.hashes.config, 16)}</span>, contract
        hash <span className="mono text-text">{shortHash(report.hashes.contract, 16)}</span>, source hash{' '}
        <span className="mono text-text">{shortHash(report.hashes.source, 16)}</span>.
      </p>
    </section>
  );
}

function findExport(files: readonly FileRef[], attempt: number): FileRef | null {
  return files.find((file) => file.kind === 'export' && file.attempt === attempt) ?? null;
}

function FileRow({ file }: { file: FileRef }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{FILE_LABELS[file.kind] ?? file.kind}</p>
        <p className="mono mt-1 text-[13px] break-all text-muted">
          sha256 <span className="text-text">{file.sha256}</span>
        </p>
      </div>
      <a className="btn btn-small" href={file.href} download={file.name}>
        <Icon name="download" size={16} />
        <span className="mono">{file.name}</span>
        <span className="text-muted">{formatBytes(file.byteLength)}</span>
      </a>
    </div>
  );
}

function Lineage({ file, exportFile }: { file: FileRef; exportFile: FileRef | null }) {
  const { resource } = useResource(file.href, (signal) => fetchJson<RestoreUpload>(file.href, signal));
  if (resource.status !== 'ready') return null;
  const upload = resource.data;
  const matchesRecord = upload.exportSha256 !== null && upload.sha256 === upload.exportSha256;
  const matchesCapture = exportFile ? upload.sha256 === exportFile.sha256 : null;
  const proven = matchesRecord && matchesCapture !== false;
  return (
    <p className={`flex items-start gap-2 text-[14px] ${proven ? 'text-ok' : 'text-bad'}`}>
      <Icon name={proven ? 'check' : 'cross'} size={16} className="mt-0.5 shrink-0" />
      <span>
        Uploaded file sha256 <span className="mono">{shortHash(upload.sha256, 16)}</span>{' '}
        {proven ? '=' : 'differs from'} captured export sha256{' '}
        <span className="mono">{shortHash(upload.exportSha256, 16)}</span>
        <span className="text-muted">
          {' '}
          ({formatBytes(upload.byteLength)}, uploaded as <span className="mono">{upload.fileName}</span>)
        </span>
      </span>
    </p>
  );
}

export function LimitsPanel({ limitations }: { limitations: readonly string[] }) {
  return (
    <section aria-labelledby="limits-heading" className="flex flex-col gap-5">
      <h2 id="limits-heading" className="text-[34px] sm:text-[44px]">
        What this run does not prove
      </h2>
      <ul className="flex max-w-[72ch] flex-col gap-3">
        {limitations.map((limit) => (
          <li key={limit} className="border-l-2 border-line-strong pl-4 text-muted">
            {limit}
          </li>
        ))}
      </ul>
    </section>
  );
}
