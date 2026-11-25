import type { BrowserStage, RunEventInput, RunEventPayload, RunEventType } from '@returntrip/contracts';
import type { RunRecord, RunStore } from '@returntrip/storage';

import type { LoadedConfig } from './config-loader.ts';
import { RunStop } from './errors.ts';
import type { EngineDeps } from './ports.ts';

const DEFAULT_STAGE_CREDIT_ESTIMATE = 30;

export interface EngineOptions {
  readonly headless: boolean;
  /** Directory for disposable target copies and data; defaults under the store root. */
  readonly workRoot?: string;
  readonly log?: (line: string) => void;
}

/** Everything one run needs, plus the budget it is spending against. */
export class RunContext {
  readonly store: RunStore;
  readonly loaded: LoadedConfig;
  readonly deps: EngineDeps;
  readonly options: EngineOptions;
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly workDir: string;
  attempt = 0;
  #creditsUsed = 0;
  #agentUsd = 0;
  #largestStageCost = 0;

  constructor(input: {
    store: RunStore;
    loaded: LoadedConfig;
    deps: EngineDeps;
    options: EngineOptions;
    signal: AbortSignal;
    run: RunRecord;
    workDir: string;
  }) {
    this.store = input.store;
    this.loaded = input.loaded;
    this.deps = input.deps;
    this.options = input.options;
    this.signal = input.signal;
    this.runId = input.run.id;
    this.workDir = input.workDir;
  }

  get config(): LoadedConfig['config'] {
    return this.loaded.config;
  }

  get creditsUsed(): number {
    return this.#creditsUsed;
  }

  get agentUsd(): number {
    return this.#agentUsd;
  }

  emit<T extends RunEventType>(type: T, payload: RunEventPayload<T>): void {
    // TypeScript can't narrow a generic key into the distributive union, so the pairing is asserted here
    // and checked at runtime by RunEventSchema inside appendEvent.
    this.store.appendEvent(this.runId, { type, attempt: this.attempt, payload } as RunEventInput);
  }

  log(line: string): void {
    this.options.log?.(line);
  }

  throwIfCanceled(): void {
    if (this.signal.aborted) throw new RunStop('CANCELED', 'CANCELED', 'The run was canceled.');
  }

  /** Refuses to start a browser stage the remaining credit budget might not cover. */
  reserveCredits(stage: BrowserStage): void {
    const cap = this.config.limits.maxKaneCredits;
    const estimate = Math.max(this.#largestStageCost, DEFAULT_STAGE_CREDIT_ESTIMATE);
    if (this.#creditsUsed + estimate > cap) {
      throw new RunStop(
        'BUDGET_EXCEEDED',
        'KANE_CREDITS',
        `Stopped before the ${stage} step: ${this.#creditsUsed.toFixed(1)} of ${cap} Kane credits used, and the next step can cost about ${estimate.toFixed(0)}.`,
      );
    }
  }

  chargeCredits(credits: number | null): void {
    if (credits === null) return;
    this.#creditsUsed += credits;
    this.#largestStageCost = Math.max(this.#largestStageCost, credits);
    this.#publishBudget();
  }

  chargeAgent(usd: number | null): void {
    if (usd === null) return;
    this.#agentUsd += usd;
    this.#publishBudget();
  }

  #publishBudget(): void {
    this.store.updateRun(this.runId, { kaneCreditsUsed: this.#creditsUsed, agentUsd: this.#agentUsd });
    this.emit('budget.updated', {
      kaneCreditsUsed: this.#creditsUsed,
      kaneCreditsCap: this.config.limits.maxKaneCredits,
      agentUsd: this.#agentUsd,
    });
  }
}
