import { z } from 'zod';

/** argv array, never a shell string. Tokens may contain `{placeholder}` values the runtime fills. */
const Argv = z.array(z.string().min(1)).min(1);

const LoopbackOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash
  );
}, 'must be a bare loopback origin such as http://127.0.0.1:4310');

const RelativePath = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'), {
    message: 'must be a relative path inside the application directory',
  });

export const FIELD_TYPES = ['string', 'decimal', 'integer', 'date', 'boolean'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FieldSpecSchema = z.strictObject({
  name: z.string().min(1).max(128),
  type: z.enum(FIELD_TYPES),
  nullable: z.boolean().default(false),
  /** Raw cell values treated as null. Empty string is only null when listed here. */
  nullMarkers: z.array(z.string()).max(8).default([]),
  /** decimal only: maximum fractional digits. Excess non-zero digits are a schema error, never rounded. */
  scale: z.number().int().min(0).max(30).optional(),
  /** date only: accepted lexical formats, tried in order. */
  formats: z
    .array(z.enum(['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY']))
    .min(1)
    .optional(),
  /** boolean only: accepted lexemes. */
  trueValues: z.array(z.string()).min(1).optional(),
  falseValues: z.array(z.string()).min(1).optional(),
  trim: z.boolean().default(false),
  unicodeNormalization: z.enum(['none', 'NFC']).default('none'),
});
export type FieldSpec = z.output<typeof FieldSpecSchema>;

export const DataContractSchema = z
  .strictObject({
    version: z.literal(1),
    encoding: z.literal('utf8'),
    delimiter: z.enum([',', ';', '\t']).default(','),
    identity: z.discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('multiset') }),
      z.strictObject({ mode: z.literal('uniqueKey'), fields: z.array(z.string().min(1)).min(1) }),
    ]),
    order: z.enum(['ignore', 'strict']).default('ignore'),
    extraColumns: z.enum(['reject', 'ignoreDeclaredOnly']).default('reject'),
    ignoredColumns: z.array(z.string().min(1)).default([]),
    fields: z.array(FieldSpecSchema).min(1).max(256),
  })
  .superRefine((contract, ctx) => {
    const names = contract.fields.map((field) => field.name);
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name))
        ctx.addIssue({ code: 'custom', message: `duplicate field "${name}"`, path: ['fields'] });
      seen.add(name);
    }
    if (contract.identity.mode === 'uniqueKey') {
      for (const key of contract.identity.fields) {
        if (!seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            message: `identity field "${key}" is not declared`,
            path: ['identity'],
          });
        }
      }
      if (new Set(contract.identity.fields).size !== contract.identity.fields.length) {
        ctx.addIssue({ code: 'custom', message: 'identity fields must be unique', path: ['identity'] });
      }
    }
    contract.fields.forEach((field, index) => {
      if (field.scale !== undefined && field.type !== 'decimal') {
        ctx.addIssue({
          code: 'custom',
          message: 'scale applies to decimal fields only',
          path: ['fields', index],
        });
      }
      if (field.formats && field.type !== 'date') {
        ctx.addIssue({
          code: 'custom',
          message: 'formats applies to date fields only',
          path: ['fields', index],
        });
      }
      if (field.type === 'date' && !field.formats) {
        ctx.addIssue({
          code: 'custom',
          message: 'date fields must declare formats',
          path: ['fields', index],
        });
      }
      if (field.type === 'boolean' && (!field.trueValues || !field.falseValues)) {
        ctx.addIssue({
          code: 'custom',
          message: 'boolean fields must declare trueValues and falseValues',
          path: ['fields', index],
        });
      }
      if (contract.ignoredColumns.includes(field.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `"${field.name}" is both declared and ignored`,
          path: ['fields', index],
        });
      }
    });
  });
export type DataContract = z.output<typeof DataContractSchema>;

export const LifecycleSchema = z.strictObject({
  /** Optional build step, run in the target copy before start. */
  build: Argv.optional(),
  /** Loads the trusted source into the source workspace, independent of the importer under test. */
  seed: Argv.optional(),
  start: Argv,
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()).default({}),
  healthPath: z.string().startsWith('/').default('/health'),
  startupTimeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
});

/**
 * A controlled defect applied to the disposable copy before the run. Lives outside the repair
 * scope, so the agent can't fix a scenario by deleting it.
 */
export const ScenarioSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  patch: z.string().min(1),
  /** Shown wherever the run is displayed, e.g. "Recreated defect on a controlled demo app". */
  disclosure: z.string().min(10).max(200),
  reference: z.url().optional(),
});
export type ScenarioConfig = z.output<typeof ScenarioSchema>;

export const ApplicationSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('managed'),
    directory: z.string().min(1),
    lifecycle: LifecycleSchema,
    repairPaths: z.array(RelativePath).min(1),
    protectedPaths: z.array(RelativePath).default([]),
    scenario: ScenarioSchema.optional(),
  }),
  z.strictObject({
    mode: z.literal('attached'),
    origin: LoopbackOrigin,
    lifecycle: z
      .strictObject({
        seed: Argv.optional(),
        healthPath: z.string().startsWith('/').default('/health'),
      })
      .default({ healthPath: '/health' }),
  }),
]);
export type ApplicationConfig = z.output<typeof ApplicationSchema>;

export const SourceSchema = z.strictObject({
  kind: z.literal('manifestCsv'),
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'run `returntrip init` to pin the source hash'),
  provenance: z.string().min(1),
});

/**
 * Plain-English Kane objectives. `{placeholders}` are typed values filled by ReturnTrip:
 * {sourceUrl} {destinationUrl} {destinationName} {restoreFile} {expectedRows}.
 */
export const JourneySchema = z.strictObject({
  sourceWorkspace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  /**
   * A destination the seed prepared, for apps where Kane can't create one. Without it, each
   * attempt gets a fresh generated workspace name.
   */
  destinationWorkspace: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .optional(),
  workspaceUrl: z.string().min(1),
  /** Kane variables file (relative to the config) for test credentials, passed as --variables-file. */
  variablesFile: z.string().min(1).optional(),
  export: z.string().min(10).max(2_000),
  createDestination: z.string().min(10).max(2_000),
  restore: z.string().min(10).max(2_000),
  reexport: z.string().min(10).max(2_000),
});
export type JourneyConfig = z.output<typeof JourneySchema>;

export const CaptureSchema = z.strictObject({
  mode: z.literal('responseProxy'),
  /**
   * Route pattern on the target. `:workspace` marks the workspace segment; without one, any
   * matching transfer inside a stage's window counts, so the stage window alone attributes it.
   */
  route: z.string().startsWith('/'),
  method: z.enum(['GET', 'POST']).default('GET'),
  contentTypes: z.array(z.string().min(1)).min(1).default(['text/csv']),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024 * 1024)
    .default(10 * 1024 * 1024),
  /**
   * Restore upload route. When set, the proxy hashes the uploaded file part so lineage is
   * proven from bytes: what the browser uploaded must equal what the export produced.
   */
  restoreRoute: z.string().startsWith('/').optional(),
  restoreMethod: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  restoreFileField: z.string().min(1).default('file'),
  /** `identical` accepts a repeat of the same transfer (some apps download twice per click). */
  duplicates: z.enum(['reject', 'identical']).default('reject'),
  /** Pull one file out of a zip export; the archive is kept alongside as evidence. */
  extract: z.strictObject({ format: z.literal('zip'), entry: z.string().min(1).max(256) }).optional(),
});
export type CaptureConfig = z.output<typeof CaptureSchema>;

export const LimitsSchema = z.strictObject({
  browserRunTimeoutMs: z.number().int().min(10_000).max(1_800_000).default(240_000),
  overallTimeoutMs: z.number().int().min(60_000).max(14_400_000).default(3_600_000),
  maxRepairAttempts: z.number().int().min(1).max(5).default(3),
  maxBrowserRetries: z.number().int().min(0).max(3).default(1),
  maxRows: z.number().int().min(1).max(1_000_000).default(50_000),
  maxKaneCredits: z.number().positive().max(100_000),
});

export const RepairSchema = z.strictObject({
  enabled: z.boolean().default(false),
  agent: z.literal('claude-code').default('claude-code'),
  maxChangedFiles: z.number().int().min(1).max(50).default(20),
  maxChangedLines: z.number().int().min(1).max(5_000).default(1_000),
  agentTimeoutMs: z.number().int().min(30_000).max(1_800_000).default(600_000),
  maxAgentBudgetUsd: z.number().positive().max(50).default(5),
});

export const ReturnTripConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    application: ApplicationSchema,
    source: SourceSchema,
    contract: DataContractSchema,
    journey: JourneySchema,
    capture: CaptureSchema,
    limits: LimitsSchema,
    repair: RepairSchema.default({
      enabled: false,
      agent: 'claude-code',
      maxChangedFiles: 20,
      maxChangedLines: 1_000,
      agentTimeoutMs: 600_000,
      maxAgentBudgetUsd: 5,
    }),
  })
  .superRefine((config, ctx) => {
    if (config.repair.enabled && config.application.mode !== 'managed') {
      ctx.addIssue({
        code: 'custom',
        message: 'repair needs a managed application; attached targets are verification-only',
        path: ['repair', 'enabled'],
      });
    }
  });
export type ReturnTripConfig = z.output<typeof ReturnTripConfigSchema>;
