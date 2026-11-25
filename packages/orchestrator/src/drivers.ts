import { createCaptureProxy } from '@returntrip/artifact-capture';
import { getKaneBalance, getKaneVersion, runKaneObjective } from '@returntrip/kane-adapter';
import { getClaudeVersion, runClaudeRepair } from '@returntrip/repair-agent';

import type { BrowserDriver, CaptureDriver, EngineDeps, RepairDriver } from './ports.ts';

export function kaneDriver(options: { headless: boolean; kaneBin?: string }): BrowserDriver {
  const bin = options.kaneBin;
  return {
    name: 'kane-cli',
    version: () => getKaneVersion(bin),
    balance: () => getKaneBalance(bin),
    async run(input) {
      const outcome = await runKaneObjective({
        objective: input.objective,
        url: input.url,
        timeoutMs: input.timeoutMs,
        headless: options.headless,
        cwd: input.cwd,
        logDir: input.logDir,
        signal: input.signal,
        onProgress: input.onProgress,
        ...(bin ? { kaneBin: bin } : {}),
      });
      return { result: outcome.result, stdoutPath: outcome.stdoutPath, stderrPath: outcome.stderrPath };
    },
  };
}

export function proxyCaptureDriver(): CaptureDriver {
  return {
    async start(input) {
      const proxy = await createCaptureProxy({
        upstream: input.upstream,
        capture: input.capture,
        artifactDir: input.artifactDir,
      });
      return {
        origin: proxy.origin,
        expectExport: (stage, workspace) => {
          const pending = proxy.expectExport({ stage, workspace });
          return {
            wait: async (timeoutMs) => {
              const file = await pending.wait(timeoutMs);
              return {
                path: file.path,
                sha256: file.sha256,
                byteLength: file.byteLength,
                contentType: file.contentType,
                contentDisposition: file.contentDisposition,
                status: file.status,
                capturedAt: file.capturedAt,
              };
            },
            cancel: () => pending.cancel(),
          };
        },
        expectRestore: (stage, workspace) => {
          const pending = proxy.expectRestore({ stage, workspace });
          return {
            wait: async (timeoutMs) => {
              const upload = await pending.wait(timeoutMs);
              return {
                sha256: upload.sha256,
                byteLength: upload.byteLength,
                fileName: upload.fileName,
                wholeBody: upload.wholeBody,
              };
            },
            cancel: () => pending.cancel(),
          };
        },
        requestLog: () => proxy.requestLog(),
        close: () => proxy.close(),
      };
    },
  };
}

export function claudeRepairDriver(options: { claudeBin?: string } = {}): RepairDriver {
  return {
    version: () => getClaudeVersion(options.claudeBin),
    async repair(input) {
      const outcome = await runClaudeRepair({
        dir: input.dir,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
        maxBudgetUsd: input.maxBudgetUsd,
        logDir: input.logDir,
        signal: input.signal,
        ...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
      });
      return { result: outcome.result, rawPath: outcome.rawPath };
    },
  };
}

export function realDeps(options: { headless: boolean; kaneBin?: string; claudeBin?: string }): EngineDeps {
  return {
    browser: kaneDriver(options),
    capture: proxyCaptureDriver(),
    repair: claudeRepairDriver(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
  };
}
