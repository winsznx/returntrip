import type { EdgeSummary } from '@returntrip/contracts';

import type { RunReport } from './report.ts';

const EDGE_TITLE: Readonly<Record<EdgeSummary['edge'], string>> = {
  source_export: 'Trusted source → first export',
  export_reexport: 'First export → export after restore',
  source_reexport: 'Trusted source → export after restore',
};

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function rate(summary: EdgeSummary): string {
  return summary.preservationRate === null
    ? 'n/a'
    : `${summary.matchedIdenticalOccurrences} / ${summary.expectedRows}`;
}

function seconds(ms: number | null): string {
  return ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`;
}

/** A human-readable report holding the same facts as report.json, nothing more. */
export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [
    `# ReturnTrip run ${report.runId}`,
    '',
    `**${report.outcome ?? 'UNFINISHED'}**: ${report.headline ?? ''}`,
    '',
  ];
  if (report.scenario) {
    lines.push(
      `> ${report.scenario.disclosure} (${report.scenario.name}${report.scenario.reference ? `, ${report.scenario.reference}` : ''})`,
      '',
    );
  }
  lines.push(
    '| | |',
    '|---|---|',
    `| Project | ${cell(report.project)} |`,
    `| Mode | ${report.mode} |`,
    `| Started | ${report.startedAt} |`,
    `| Duration | ${seconds(report.durationMs)} |`,
    `| Kane CLI | ${cell(report.kane.version)}, ${report.kane.creditsUsed.toFixed(1)} of ${report.kane.creditsCap} credits |`,
    `| Repair agent | ${report.agent.versions.length > 0 ? `Claude Code ${report.agent.versions.join(', ')} (${report.agent.models.join(', ') || 'model not reported'}), $${report.agent.usd.toFixed(2)}` : 'not used'} |`,
    `| Source sha256 | \`${report.hashes.source}\` |`,
    `| Contract sha256 | \`${report.hashes.contract}\` |`,
    '',
  );

  for (const attempt of report.attempts) {
    lines.push(
      `## Attempt ${attempt.number} (${attempt.kind}${attempt.patchSha256 ? `, patch ${attempt.patchSha256.slice(0, 12)}` : ''})`,
      '',
    );
    if (attempt.stages.length > 0) {
      lines.push('| Kane stage | Result | Credits | Time | What Kane said |', '|---|---|---|---|---|');
      for (const stage of attempt.stages) {
        lines.push(
          `| ${stage.stage} | ${stage.outcome} | ${stage.creditsUsed === null ? 'unknown' : stage.creditsUsed.toFixed(1)} | ${seconds(stage.durationMs)} | ${cell(stage.oneLiner)} |`,
        );
      }
      lines.push('');
    }
    if (attempt.comparisons.length > 0) {
      lines.push(
        '| Comparison | Same | Preserved | Missing | Extra | Changed rows | Fields changed |',
        '|---|---|---|---|---|---|---|',
      );
      for (const summary of attempt.comparisons) {
        lines.push(
          `| ${EDGE_TITLE[summary.edge]} | ${summary.isEquivalent ? 'yes' : 'no'} | ${rate(summary)} | ${summary.missingOccurrences + summary.missingKeyCount} | ${summary.excessOccurrences + summary.unexpectedKeyCount} | ${summary.changedKeyCount} | ${cell(summary.changedFields.map((f) => `${f.field} (${f.rows})`).join(', ') || '-')} |`,
        );
      }
      lines.push('');
    }
  }

  if (report.repairs.length > 0) {
    lines.push(
      '## Repair attempts',
      '',
      '| # | Result | Files | Lines | Cost | Cause or reason |',
      '|---|---|---|---|---|---|',
    );
    for (const repair of report.repairs) {
      lines.push(
        `| ${repair.attempt} | ${repair.status}${repair.reason ? ' (rejected)' : ''} | ${cell(repair.files.join(', ') || '-')} | ${repair.linesChanged} | ${repair.costUsd === null ? 'n/a' : `$${repair.costUsd.toFixed(2)}`} | ${cell(repair.reason ?? repair.cause)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Timeline', '');
  for (const entry of report.timeline) lines.push(`- \`+${seconds(entry.elapsedMs)}\` ${entry.text}`);
  lines.push('', '## Limits', '');
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  lines.push('', '## Evidence', '', '| Kind | Attempt | File | sha256 | Bytes |', '|---|---|---|---|---|');
  for (const entry of report.manifest) {
    lines.push(
      `| ${entry.kind} | ${entry.attempt} | \`${entry.path}\` | \`${entry.sha256.slice(0, 16)}…\` | ${entry.byteLength} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
