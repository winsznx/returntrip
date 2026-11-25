import { z } from 'zod';

import { COMPARISON_EDGES } from './comparison.ts';
import { RUN_OUTCOMES, RUN_PHASES } from './outcome.ts';

const BrowserStageEnum = z.enum(['export', 'create-destination', 'restore', 'reexport']);
const ArtifactKindEnum = z.enum(['source', 'export', 'reexport']);

const envelope = {
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  attempt: z.number().int().min(0),
  utc: z.string().datetime(),
  elapsedMs: z.number().nonnegative(),
};

export const RunEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...envelope,
    type: z.literal('run.created'),
    payload: z.object({ mode: z.enum(['verify', 'repair']), project: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('phase.changed'),
    payload: z.object({ phase: z.enum(RUN_PHASES), message: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('browser.started'),
    payload: z.object({ stage: BrowserStageEnum, objective: z.string(), url: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('browser.progress'),
    payload: z.object({
      stage: BrowserStageEnum,
      step: z.number().int(),
      status: z.string(),
      remark: z.string(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('browser.finished'),
    payload: z.object({
      stage: BrowserStageEnum,
      outcome: z.enum(['passed', 'failed', 'infra_error', 'unknown', 'canceled']),
      reasonCode: z.string().nullable(),
      oneLiner: z.string().nullable(),
      creditsUsed: z.number().nullable(),
      durationMs: z.number(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('artifact.captured'),
    payload: z.object({
      kind: ArtifactKindEnum,
      artifactId: z.string(),
      sha256: z.string(),
      byteLength: z.number().int(),
      rows: z.number().int().nullable(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('comparison.completed'),
    payload: z.object({
      edge: z.enum(COMPARISON_EDGES),
      isEquivalent: z.boolean(),
      expectedRows: z.number().int(),
      observedRows: z.number().int(),
      matched: z.number().int(),
      headline: z.string(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('repair.started'),
    payload: z.object({ repairAttempt: z.number().int(), maxAttempts: z.number().int() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('repair.patch'),
    payload: z.object({
      repairAttempt: z.number().int(),
      patchSha256: z.string(),
      filesChanged: z.array(z.string()),
      linesChanged: z.number().int(),
      cause: z.string(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('repair.rejected'),
    payload: z.object({ repairAttempt: z.number().int(), reason: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('build.finished'),
    payload: z.object({ ok: z.boolean(), durationMs: z.number() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('budget.updated'),
    payload: z.object({ kaneCreditsUsed: z.number(), kaneCreditsCap: z.number(), agentUsd: z.number() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('warning'),
    payload: z.object({ code: z.string(), message: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('run.finished'),
    payload: z.object({
      outcome: z.enum(RUN_OUTCOMES),
      headline: z.string(),
      failureCode: z.string().nullable(),
    }),
  }),
]);

export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent['type'];
export type RunEventPayload<T extends RunEventType> = Extract<RunEvent, { type: T }>['payload'];

/** What a producer supplies; the store adds the envelope (seq, utc, elapsed). */
export type RunEventInput = {
  [K in RunEventType]: { readonly type: K; readonly attempt: number; readonly payload: RunEventPayload<K> };
}[RunEventType];
