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
  "unknown",
]);

export const BatchRecoveryDecisionSchema = z.enum([
  "none",
  "retry_same_run_id",
  "continue_pending",
  "stop_until_fixed",
]);

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
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  attemptExhausted: z.boolean().optional(),
  providerStatusCode: z.number().int().positive().optional(),
  errorSummary: z.string().max(1000).optional(),
});

export const BatchItemCheckpointSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  itemId: z.string().min(1),
  runId: z.string().min(1),
  status: BatchItemStatusSchema,
  sourceName: z.string().min(1),
  sourceRelativePath: BatchProjectRelativeLocatorSchema,
  sourceHash: z.string().min(1),
  normalizedPath: BatchProjectRelativeLocatorSchema,
  bookId: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  expectedCommandCheckCount: z.number().int().positive().optional(),
  maxCommandAttempts: z.number().int().positive().optional(),
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryExhausted: z.boolean().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  failedStage: z.string().min(1).optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  failedAt: z.string().datetime().optional(),
  errorSummary: z.string().max(1000).optional(),
  commandChecks: z.array(BatchCommandCheckSchema).default([]),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
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

export const BatchItemCheckpointInputSchema = BatchItemCheckpointSchema.extend({
  sourceHash: z.string().min(1).optional(),
  bookId: z.string().min(1).optional(),
});

export function parseBatchItemCheckpoint(
  value: unknown,
  defaults: { sourceHash: string; bookId: string },
) {
  const parsed = BatchItemCheckpointInputSchema.parse(value);
  return BatchItemCheckpointSchema.parse({
    ...parsed,
    sourceHash: parsed.sourceHash ?? defaults.sourceHash,
    bookId: parsed.bookId ?? defaults.bookId,
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

export type BatchItemStatus = z.infer<typeof BatchItemStatusSchema>;
export type BatchRunStatus = z.infer<typeof BatchRunStatusSchema>;
export type BatchFailureKind = z.infer<typeof BatchFailureKindSchema>;
export type BatchRecoveryDecision = z.infer<typeof BatchRecoveryDecisionSchema>;
export type BatchProjectRelativeLocator = z.infer<
  typeof BatchProjectRelativeLocatorSchema
>;
export type BatchCommandCheck = z.infer<typeof BatchCommandCheckSchema>;
export type BatchItemCheckpointInput = z.infer<typeof BatchItemCheckpointInputSchema>;
export type BatchItemCheckpoint = z.infer<typeof BatchItemCheckpointSchema>;
export type BatchRunManifest = z.infer<typeof BatchRunManifestSchema>;
export type BatchEventLog = z.infer<typeof BatchEventLogSchema>;
