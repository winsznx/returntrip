import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RepairAgentResult } from '@returntrip/contracts';
import { execArgv, minimalEnv } from '@returntrip/target-runtime';

import { REPAIR_OUTPUT_SCHEMA } from './prompt.ts';

/** Read and edit only; no shell, no web, no MCP servers, no user settings, file tools confined to cwd. */
export const RESTRICTED_TOOLS = ['Read', 'Edit', 'Glob', 'Grep'] as const;

export interface ClaudeRepairOptions {
  readonly dir: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly maxBudgetUsd: number;
  readonly logDir: string;
  readonly claudeBin?: string;
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
}

export interface ClaudeRepairOutcome {
  readonly result: RepairAgentResult;
  readonly fixed: boolean | null;
  readonly permissionDenials: number;
  readonly rawPath: string;
}

export function claudeArgv(
  options: Pick<ClaudeRepairOptions, 'claudeBin' | 'maxBudgetUsd' | 'maxTurns'>,
): string[] {
  return [
    options.claudeBin ?? 'claude',
    '-p',
    '--restricted',
    '--tools',
    RESTRICTED_TOOLS.join(','),
    '--permission-mode',
    'acceptEdits',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(REPAIR_OUTPUT_SCHEMA),
    '--max-turns',
    String(options.maxTurns ?? 40),
    '--max-budget-usd',
    String(options.maxBudgetUsd),
  ];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function getClaudeVersion(claudeBin = 'claude'): Promise<string | null> {
  try {
    const result = await execArgv([claudeBin, '--version'], {
      cwd: process.cwd(),
      env: minimalEnv(),
      timeoutMs: 15_000,
    });
    return /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Parses Claude Code's `--output-format json` result object. Unknown shapes are agent errors. */
export function parseClaudeResult(
  stdout: string,
  meta: { durationMs: number; agentVersion: string | null; exitCode: number | null; timedOut: boolean },
): Omit<ClaudeRepairOutcome, 'rawPath'> {
  const base = {
    filesChanged: [] as string[],
    durationMs: meta.durationMs,
    agentVersion: meta.agentVersion,
  };
  if (meta.timedOut) {
    return {
      result: {
        ...base,
        status: 'timeout',
        cause: null,
        costUsd: null,
        models: [],
        turns: null,
        error: 'agent timed out',
      },
      fixed: null,
      permissionDenials: 0,
    };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = record(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));
  } catch {
    parsed = null;
  }
  if (parsed?.type !== 'result') {
    return {
      result: {
        ...base,
        status: 'agent_error',
        cause: null,
        costUsd: null,
        models: [],
        turns: null,
        error: `unreadable agent output (exit ${meta.exitCode ?? 'signal'})`,
      },
      fixed: null,
      permissionDenials: 0,
    };
  }
  const models = Object.keys(record(parsed.modelUsage) ?? {}).sort();
  const costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
  const turns = typeof parsed.num_turns === 'number' ? parsed.num_turns : null;
  const denials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials.length : 0;
  const structured = record(parsed.structured_output);
  const cause = typeof structured?.cause === 'string' ? structured.cause : null;
  const files = Array.isArray(structured?.files_changed)
    ? structured.files_changed.filter((file): file is string => typeof file === 'string')
    : [];
  const fixed = typeof structured?.fixed === 'boolean' ? structured.fixed : null;

  if (parsed.is_error === true || parsed.subtype !== 'success' || !structured) {
    return {
      result: {
        ...base,
        status: 'agent_error',
        cause,
        costUsd,
        models,
        turns,
        error: `agent finished with ${String(parsed.subtype ?? 'unknown')}`,
      },
      fixed,
      permissionDenials: denials,
    };
  }
  return {
    result: {
      ...base,
      status: fixed === false ? 'no_patch' : 'patch',
      cause,
      filesChanged: files,
      costUsd,
      models,
      turns,
      error: null,
    },
    fixed,
    permissionDenials: denials,
  };
}

/**
 * Runs Claude Code headless in the target copy. The prompt goes over stdin so it never appears in
 * the process list. The agent's own claims are recorded but never trusted: the patch is validated
 * and the fix is re-verified by Kane separately.
 */
export async function runClaudeRepair(options: ClaudeRepairOptions): Promise<ClaudeRepairOutcome> {
  const agentVersion = await getClaudeVersion(options.claudeBin);
  const rawPath = join(options.logDir, 'agent-output.json');
  const execution = await execArgv(claudeArgv(options), {
    cwd: options.dir,
    env: minimalEnv(),
    timeoutMs: options.timeoutMs,
    stdin: options.prompt,
    maxCaptureBytes: 8 * 1024 * 1024,
    logPath: join(options.logDir, 'agent.log'),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await writeFile(rawPath, execution.stdout, { mode: 0o600 });
  const parsed = parseClaudeResult(execution.stdout, {
    durationMs: execution.durationMs,
    agentVersion,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
  });
  return { ...parsed, rawPath };
}
