import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { EvidenceVerdict } from '@returntrip/contracts';

/** ReturnTrip's stage policy, shipped with this package. */
export const STAGE_POLICY_PATH = fileURLToPath(new URL('../policies/returntrip-stage.yaml', import.meta.url));

interface VerdictJson {
  readonly result?: unknown;
  readonly policies?: readonly { readonly id?: unknown }[];
  readonly verdicts?: readonly {
    readonly gates?: readonly {
      readonly id?: unknown;
      readonly status?: unknown;
      readonly severity?: unknown;
    }[];
  }[];
}

function ids(
  gates: NonNullable<NonNullable<VerdictJson['verdicts']>[number]['gates']>,
  status: string,
): string[] {
  return gates
    .filter((gate) => gate.status === status && typeof gate.id === 'string')
    .map((gate) => String(gate.id));
}

/** Parses `kane-cli evidence verdict --json` output. Anything unexpected is an errored verdict. */
export function parseVerdict(stdout: string, policy: string): EvidenceVerdict {
  const errored: EvidenceVerdict = {
    policy,
    result: 'errored',
    failedGates: [],
    warnedGates: [],
    erroredGates: [],
  };
  const line = stdout
    .split('\n')
    .map((text) => text.trim())
    .reverse()
    .find((text) => text.startsWith('{'));
  if (!line) return errored;
  let parsed: VerdictJson;
  try {
    parsed = JSON.parse(line) as VerdictJson;
  } catch {
    return errored;
  }
  const result = parsed.result;
  if (result !== 'pass' && result !== 'fail' && result !== 'errored') return errored;
  const gates = parsed.verdicts?.[0]?.gates ?? [];
  return {
    policy: typeof parsed.policies?.[0]?.id === 'string' ? parsed.policies[0].id : policy,
    result,
    failedGates: ids(gates, 'fail'),
    warnedGates: ids(gates, 'warn'),
    erroredGates: ids(gates, 'errored'),
  };
}

/**
 * Has Kane judge one of its own sealed evidence packs against a policy. Kane writes the verdict
 * beside the pack, so call this on Kane's original pack, before copying it into a run.
 */
export async function judgeEvidencePack(options: {
  readonly packPath: string;
  readonly policyPath?: string;
  readonly kaneBin?: string;
  readonly timeoutMs?: number;
}): Promise<EvidenceVerdict> {
  const policyPath = options.policyPath ?? STAGE_POLICY_PATH;
  const child = spawn(
    options.kaneBin ?? 'kane-cli',
    ['evidence', 'verdict', options.packPath, '--policy', policyPath, '--json'],
    {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KANE_CLI_USER_AGENT: 'returntrip' },
    },
  );
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    if (stdout.length < 1024 * 1024) stdout += chunk;
  });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
  } catch {
    return {
      policy: 'returntrip-stage',
      result: 'errored',
      failedGates: [],
      warnedGates: [],
      erroredGates: [],
    };
  } finally {
    clearTimeout(timer);
  }
  return parseVerdict(stdout, 'returntrip-stage');
}
