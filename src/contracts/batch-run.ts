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

export const BatchCommandCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["passed", "failed"]),
  attempts: z.number().int().positive(),
  exitCode: z.number().int().nullable(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  errorSummary: z.string().max(1000).optional(),
});

export const BatchItemCheckpointSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  itemId: z.string().min(1),
  runId: z.string().min(1),
  status: BatchItemStatusSchema,
  sourceName: z.string().min(1),
  sourceRelativePath: z.string().min(1),
  sourceHash: z.string().min(1).optional(),
  normalizedPath: z.string().min(1),
  bookId: z.string().min(1).optional(),
  attempts: z.number().int().nonnegative(),
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
  status: z.enum(["running", "completed", "failed"]),
  sourceRootName: z.string().min(1),
  stateRootLocator: z.string().min(1),
  qmdIndexLocator: z.string().min(1),
  configLocator: z.string().min(1),
  totalItems: z.number().int().nonnegative(),
  completedItems: z.number().int().nonnegative(),
  skippedItems: z.number().int().nonnegative().default(0),
  failedItems: z.number().int().nonnegative(),
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
  at: z.string().datetime(),
  message: z.string().max(1000).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

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
export type BatchCommandCheck = z.infer<typeof BatchCommandCheckSchema>;
export type BatchItemCheckpoint = z.infer<typeof BatchItemCheckpointSchema>;
export type BatchRunManifest = z.infer<typeof BatchRunManifestSchema>;
export type BatchEventLog = z.infer<typeof BatchEventLogSchema>;
