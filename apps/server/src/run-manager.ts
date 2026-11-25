import { createHash, randomBytes } from 'node:crypto';

import type { RunMode } from '@returntrip/contracts';
import { type EngineDeps, executeRun, type LoadedConfig, loadConfig } from '@returntrip/orchestrator';
import type { RunRecord, RunStore } from '@returntrip/storage';

export interface Project {
  readonly id: string;
  readonly loaded: LoadedConfig;
}

export function projectId(configPath: string): string {
  return createHash('sha256').update(configPath).digest('hex').slice(0, 12);
}

interface Authorization {
  readonly projectId: string;
  readonly expiresAt: number;
}

/**
 * Owns the runs this server started. Projects are fixed at startup from the configs the user passed
 * to `returntrip ui`; the HTTP API can only refer to them by id, never by path.
 */
export class RunManager {
  readonly #store: RunStore;
  readonly #deps: EngineDeps;
  readonly #headless: boolean;
  readonly #projects = new Map<string, Project>();
  readonly #active = new Map<string, AbortController>();
  readonly #authorizations = new Map<string, Authorization>();
  readonly #idempotency = new Map<string, { runId: string; fingerprint: string }>();

  constructor(store: RunStore, deps: EngineDeps, headless: boolean) {
    this.#store = store;
    this.#deps = deps;
    this.#headless = headless;
  }

  static async create(
    store: RunStore,
    deps: EngineDeps,
    configPaths: readonly string[],
    headless: boolean,
  ): Promise<RunManager> {
    const manager = new RunManager(store, deps, headless);
    for (const path of configPaths) {
      const loaded = await loadConfig(path);
      manager.#projects.set(projectId(loaded.configPath), { id: projectId(loaded.configPath), loaded });
    }
    store.reconcileInterrupted((runId) => manager.#active.has(runId));
    return manager;
  }

  projects(): Project[] {
    return [...this.#projects.values()];
  }

  project(id: string): Project | null {
    return this.#projects.get(id) ?? null;
  }

  async revalidate(id: string): Promise<Project> {
    const current = this.#projects.get(id);
    if (!current) throw new Error('unknown project');
    const loaded = await loadConfig(current.loaded.configPath);
    const next = { id, loaded };
    this.#projects.set(id, next);
    return next;
  }

  isActive(runId: string): boolean {
    return this.#active.has(runId);
  }

  activeFor(projectIdValue: string): string | null {
    const project = this.#projects.get(projectIdValue);
    if (!project) return null;
    return this.#store.activeRuns().find((run) => run.project === project.loaded.config.project)?.id ?? null;
  }

  /** A short-lived, single-use consent for one repair on one project. */
  authorizeRepair(projectIdValue: string): string {
    const token = randomBytes(18).toString('base64url');
    this.#authorizations.set(token, { projectId: projectIdValue, expiresAt: Date.now() + 10 * 60_000 });
    return token;
  }

  #consume(token: string | undefined, projectIdValue: string): boolean {
    if (!token) return false;
    const authorization = this.#authorizations.get(token);
    this.#authorizations.delete(token);
    return Boolean(
      authorization && authorization.projectId === projectIdValue && authorization.expiresAt > Date.now(),
    );
  }

  /**
   * Starts a run in the background and resolves once its record exists. Idempotency keys make
   * a double-clicked button start one run, not two.
   */
  async start(input: {
    projectId: string;
    mode: RunMode;
    authorization?: string;
    fromRunId?: string;
    idempotencyKey?: string;
  }): Promise<{ run: RunRecord } | { error: string; status: 400 | 403 | 404 | 409 }> {
    const project = this.#projects.get(input.projectId);
    if (!project) return { error: 'unknown project', status: 404 };
    const fingerprint = JSON.stringify([input.projectId, input.mode, input.fromRunId ?? null]);
    if (input.idempotencyKey) {
      const seen = this.#idempotency.get(input.idempotencyKey);
      if (seen) {
        if (seen.fingerprint !== fingerprint)
          return { error: 'idempotency key reused with a different request', status: 409 };
        const run = this.#store.getRun(seen.runId);
        if (run) return { run };
      }
    }
    if (this.activeFor(input.projectId))
      return { error: 'this project already has an active run', status: 409 };
    if (input.mode === 'repair' && !this.#consume(input.authorization, input.projectId)) {
      return { error: 'repair needs a fresh authorization', status: 403 };
    }

    const controller = new AbortController();
    const created = new Promise<RunRecord>((resolve, reject) => {
      executeRun({
        store: this.#store,
        loaded: project.loaded,
        mode: input.mode,
        deps: this.#deps,
        options: { headless: this.#headless },
        signal: controller.signal,
        ...(input.fromRunId ? { fromRunId: input.fromRunId } : {}),
        onCreated: (run) => {
          this.#active.set(run.id, controller);
          if (input.idempotencyKey)
            this.#idempotency.set(input.idempotencyKey, { runId: run.id, fingerprint });
          resolve(run);
        },
      })
        .then((run) => {
          this.#active.delete(run.id);
        })
        .catch((error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
    try {
      return { run: await created };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), status: 409 };
    }
  }

  cancel(runId: string): boolean {
    const controller = this.#active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async shutdown(): Promise<void> {
    for (const controller of this.#active.values()) controller.abort();
  }
}
