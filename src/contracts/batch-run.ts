import { z } from "zod";

import {
  JsonValueSchema,
  SchemaVersion,
  buildEnvelopeSchema,
} from "./common.js";

export const BatchItemStatusSchema = z.enum([
  "pending",
  "running",
  "skipped",
  "completed",
  "failed",
]);

export const BatchRunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "incomplete",
]);

export const BatchFailureKindSchema = z.enum([
  "transient",
  "permanent",
  "data_compatibility",
  "unknown",
]);

export const BatchRecoveryDecisionSchema = z.enum([
  "none",
  "retry_same_run_id",
  "continue_pending",
  "stop_until_fixed",
]);

export const BatchBuildStatusSchema = z.object({
  status: z.enum(["pending", "running", "succeeded", "failed", "stale"]),
  checkedAt: z.string().datetime().optional(),
  stage: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  artifactIds: z.array(z.string().min(1)).default([]),
});

export const BatchProjectRelativeLocatorSchema = z.string().min(1).refine(
  (value) => {
    if (value.includes("\0")) return false;
    if (value.startsWith("/") || value.startsWith("\\")) return false;
    if (/^[A-Za-z]:[\\/]/u.test(value)) return false;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
    return !value.split(/[\\/]+/u).some((part) => part === "" || part === "..");
  },
  "path must be project-relative and portable",
);

export const BatchCommandCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["passed", "failed"]),
  attempts: z.number().int().positive(),
  exitCode: z.number().int().nullable(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  nextRetryAt: z.string().datetime().optional(),
  retryDelaySeconds: z.number().int().nonnegative().optional(),
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  attemptExhausted: z.boolean().optional(),
  providerStatusCode: z.number().int().positive().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  errorSummary: z.string().max(1000).optional(),
});

const BatchItemCheckpointObjectSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  itemId: z.string().min(1),
  runId: z.string().min(1),
  status: BatchItemStatusSchema,
  sourceName: z.string().min(1),
  sourceRelativePath: BatchProjectRelativeLocatorSchema,
  sourceIdentityPath: BatchProjectRelativeLocatorSchema,
  sourceHash: z.string().min(1),
  normalizedPath: BatchProjectRelativeLocatorSchema,
  bookId: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  expectedCommandCheckCount: z.number().int().positive().optional(),
  maxCommandAttempts: z.number().int().positive().optional(),
  maxTransientCommandAttempts: z.number().int().positive().optional(),
  maxResumePasses: z.number().int().positive().optional(),
  retryBaseDelaySeconds: z.number().int().positive().optional(),
  retryMaxDelaySeconds: z.number().int().positive().optional(),
  retryBudgetSeconds: z.number().int().positive().optional(),
  maxProviderRecoveryWaits: z.number().int().positive().optional(),
  commandTimeoutSeconds: z.number().int().positive().optional(),
  retryStartedAt: z.string().datetime().optional(),
  runnerSessionId: z.string().min(1).optional(),
  runnerHost: z.string().min(1).optional(),
  runnerPid: z.number().int().positive().optional(),
  runnerHeartbeatAt: z.string().datetime().optional(),
  orphanedRunnerDetectedAt: z.string().datetime().optional(),
  nextRetryAt: z.string().datetime().optional(),
  retryDelaySeconds: z.number().int().nonnegative().optional(),
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryExhausted: z.boolean().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  failedStage: z.string().min(1).optional(),
  qmdBuildStatus: BatchBuildStatusSchema.optional(),
  graphBuildStatus: BatchBuildStatusSchema.optional(),
  graphQueryStatus: BatchBuildStatusSchema.optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  failedAt: z.string().datetime().optional(),
  errorSummary: z.string().max(1000).optional(),
  commandChecks: z.array(BatchCommandCheckSchema).default([]),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

const BatchItemCheckpointPersistedObjectSchema =
  BatchItemCheckpointObjectSchema.extend({
    qmdBuildStatus: BatchBuildStatusSchema,
    graphBuildStatus: BatchBuildStatusSchema,
    graphQueryStatus: BatchBuildStatusSchema,
  });

export const BatchItemCheckpointSchema =
  BatchItemCheckpointPersistedObjectSchema.superRefine((value, ctx) => {
    if (value.status === "running") {
      for (const field of [
        "runnerSessionId",
        "runnerHost",
        "runnerPid",
        "runnerHeartbeatAt",
      ] as const) {
        if (value[field] == null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `running checkpoint requires ${field}`,
            path: [field],
          });
        }
      }
    }
    if (value.retryExhausted === true && value.failureKind !== "transient" && (
      value.retryable !== false ||
      value.recoveryDecision !== "stop_until_fixed"
    )) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "non-transient retryExhausted checkpoint requires retryable=false " +
          "and recoveryDecision=stop_until_fixed",
        path: ["retryExhausted"],
      });
    }
  });

export const BatchRunManifestSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  status: BatchRunStatusSchema,
  sourceRootName: z.string().min(1),
  stateRootLocator: BatchProjectRelativeLocatorSchema,
  qmdIndexLocator: BatchProjectRelativeLocatorSchema,
  configLocator: BatchProjectRelativeLocatorSchema,
  totalItems: z.number().int().nonnegative(),
  pendingItems: z.number().int().nonnegative().default(0),
  runningItems: z.number().int().nonnegative().default(0),
  completedItems: z.number().int().nonnegative(),
  skippedItems: z.number().int().nonnegative().default(0),
  importedCompletedItems: z.number().int().nonnegative().default(0),
  failedItems: z.number().int().nonnegative(),
  expectedCommandCheckCount: z.number().int().positive().optional(),
  maxCommandAttempts: z.number().int().positive().optional(),
  maxTransientCommandAttempts: z.number().int().positive().optional(),
  maxResumePasses: z.number().int().positive().optional(),
  retryBaseDelaySeconds: z.number().int().positive().optional(),
  retryMaxDelaySeconds: z.number().int().positive().optional(),
  retryBudgetSeconds: z.number().int().positive().optional(),
  maxProviderRecoveryWaits: z.number().int().positive().optional(),
  commandTimeoutSeconds: z.number().int().positive().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  failedAt: z.string().datetime().optional(),
  itemIds: z.array(z.string().min(1)),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const BatchEventLogSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  itemId: z.string().min(1).optional(),
  event: z.string().min(1),
  status: BatchItemStatusSchema.optional(),
  command: z.string().min(1).optional(),
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  attemptExhausted: z.boolean().optional(),
  providerStatusCode: z.number().int().positive().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  failedStage: z.string().min(1).optional(),
  at: z.string().datetime(),
  message: z.string().max(1000).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const BatchRecoverySummaryItemSchema = z.object({
  itemId: z.string().min(1),
  sourceName: z.string().min(1),
  bookId: z.string().min(1),
  status: BatchItemStatusSchema,
  attempts: z.number().int().nonnegative(),
  qmdBuildStatus: BatchBuildStatusSchema,
  graphBuildStatus: BatchBuildStatusSchema,
  graphQueryStatus: BatchBuildStatusSchema,
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryExhausted: z.boolean().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  failedStage: z.string().min(1).optional(),
  providerStatusCode: z.number().int().positive().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  nextRetryAt: z.string().datetime().optional(),
  retryDelaySeconds: z.number().int().nonnegative().optional(),
  retryBudgetSeconds: z.number().int().positive().optional(),
  providerRecoveryWaitCount: z.number().int().nonnegative().optional(),
  maxProviderRecoveryWaits: z.number().int().positive().optional(),
  providerRecoveryReason: z.string().min(1).optional(),
  runnerSessionId: z.string().min(1).optional(),
  runnerHost: z.string().min(1).optional(),
  runnerPid: z.number().int().positive().optional(),
  runnerHeartbeatAt: z.string().datetime().optional(),
  orphanedRunnerDetectedAt: z.string().datetime().optional(),
  waitingForProviderRecovery: z.boolean().optional(),
  errorSummary: z.string().max(1000).optional(),
});

export const BatchRecoverySummarySchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  generatedAt: z.string().datetime(),
  manifest: z.object({
    status: BatchRunStatusSchema,
    totalItems: z.number().int().nonnegative(),
    pendingItems: z.number().int().nonnegative(),
    runningItems: z.number().int().nonnegative(),
    completedItems: z.number().int().nonnegative(),
    skippedItems: z.number().int().nonnegative(),
    failedItems: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    failedAt: z.string().datetime().optional(),
  }),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  retryPolicy: z.object({
    maxCommandAttempts: z.number().int().positive(),
    maxTransientCommandAttempts: z.number().int().positive(),
    maxResumePasses: z.number().int().positive(),
    retryBaseDelaySeconds: z.number().int().positive(),
    retryMaxDelaySeconds: z.number().int().positive(),
    retryBudgetSeconds: z.number().int().positive(),
    maxProviderRecoveryWaits: z.number().int().positive(),
    commandTimeoutSeconds: z.number().int().positive(),
  }),
  recoveryDecision: BatchRecoveryDecisionSchema,
  retryableItemCount: z.number().int().nonnegative(),
  nextRetryAt: z.string().datetime().optional(),
  items: z.array(BatchRecoverySummaryItemSchema),
});

export const BatchItemCheckpointInputSchema = BatchItemCheckpointObjectSchema.extend({
  sourceIdentityPath: BatchProjectRelativeLocatorSchema.optional(),
  sourceHash: z.string().min(1).optional(),
  bookId: z.string().min(1).optional(),
});

export function parseBatchItemCheckpoint(
  value: unknown,
  defaults: { sourceHash: string; bookId: string; sourceIdentityPath: string },
) {
  const parsed = BatchItemCheckpointInputSchema.parse(value);
  return BatchItemCheckpointSchema.parse({
    ...parsed,
    sourceIdentityPath: parsed.sourceIdentityPath ?? defaults.sourceIdentityPath,
    sourceHash: parsed.sourceHash ?? defaults.sourceHash,
    bookId: parsed.bookId ?? defaults.bookId,
    qmdBuildStatus: parsed.qmdBuildStatus ?? { status: "pending" },
    graphBuildStatus: parsed.graphBuildStatus ?? { status: "pending" },
    graphQueryStatus: parsed.graphQueryStatus ?? { status: "pending" },
  });
}

export const BatchRunManifestEnvelopeSchema = buildEnvelopeSchema(
  "qmd.batch_run.manifest",
  BatchRunManifestSchema,
);

export const BatchItemCheckpointEnvelopeSchema = buildEnvelopeSchema(
  "qmd.batch_run.item_checkpoint",
  BatchItemCheckpointSchema,
);

export const BatchEventLogEnvelopeSchema = buildEnvelopeSchema(
  "qmd.batch_run.event_log",
  BatchEventLogSchema,
);

export const BatchRecoverySummaryEnvelopeSchema = buildEnvelopeSchema(
  "qmd.batch_run.recovery_summary",
  BatchRecoverySummarySchema,
);

export type BatchItemStatus = z.infer<typeof BatchItemStatusSchema>;
export type BatchRunStatus = z.infer<typeof BatchRunStatusSchema>;
export type BatchFailureKind = z.infer<typeof BatchFailureKindSchema>;
export type BatchRecoveryDecision = z.infer<typeof BatchRecoveryDecisionSchema>;
export type BatchBuildStatus = z.infer<typeof BatchBuildStatusSchema>;
export type BatchProjectRelativeLocator = z.infer<
  typeof BatchProjectRelativeLocatorSchema
>;
export type BatchCommandCheck = z.infer<typeof BatchCommandCheckSchema>;
export type BatchItemCheckpointInput = z.infer<typeof BatchItemCheckpointInputSchema>;
export type BatchItemCheckpoint = z.infer<typeof BatchItemCheckpointSchema>;
export type BatchRunManifest = z.infer<typeof BatchRunManifestSchema>;
export type BatchEventLog = z.infer<typeof BatchEventLogSchema>;
export type BatchRecoverySummaryItem = z.infer<
  typeof BatchRecoverySummaryItemSchema
>;
export type BatchRecoverySummary = z.infer<typeof BatchRecoverySummarySchema>;
