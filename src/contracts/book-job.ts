import { z } from "zod";

import { JsonValueSchema, SchemaVersion } from "./common.js";

export const BookStageOrder = [
  "ingest",
  "normalize",
  "graph_extract",
  "community_report",
  "embed",
  "query_ready",
] as const;

export const BookStageSchema = z.enum(BookStageOrder);

export const BookJobStatusSchema = z.enum([
  "pending",
  "running",
  "partial",
  "succeeded",
  "failed",
]);

export const StageCheckpointStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "abandoned",
]);

export const BookArtifactKindSchema = z.enum([
  "source_epub",
  "normalized_markdown",
  "graphrag_documents_parquet",
  "graphrag_text_units_parquet",
  "graphrag_entities_parquet",
  "graphrag_relationships_parquet",
  "graphrag_communities_parquet",
  "graphrag_community_reports_parquet",
  "graphrag_context_json",
  "graphrag_stats_json",
  "lancedb_index",
  "index_log",
  "query_snapshot",
]);

export const BookJobSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  bookId: z.string().min(1),
  sourcePath: z.string().min(1),
  sourceHash: z.string().min(1),
  normalizedContentHash: z.string().min(1).optional(),
  configFingerprint: z.string().min(1),
  promptFingerprint: z.string().min(1),
  modelFingerprint: z.string().min(1),
  currentStage: BookStageSchema.optional(),
  overallStatus: BookJobStatusSchema,
  lastSuccessRunId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const BookJobStageCheckpointSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  bookId: z.string().min(1),
  stage: BookStageSchema,
  status: StageCheckpointStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  runId: z.string().min(1).optional(),
  startedAt: z.string().min(1).optional(),
  finishedAt: z.string().min(1).optional(),
  inputFingerprint: z.string().min(1),
  artifactIds: z.array(z.string().min(1)),
  errorSummary: z.string().min(1).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const BookArtifactManifestSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  artifactId: z.string().min(1),
  bookId: z.string().min(1),
  stage: BookStageSchema,
  kind: BookArtifactKindSchema,
  path: z.string().min(1),
  contentHash: z.string().min(1),
  producerRunId: z.string().min(1),
  createdAt: z.string().min(1),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const BookJobRunRecordSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  bookId: z.string().min(1),
  stage: BookStageSchema,
  status: StageCheckpointStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1).optional(),
  inputFingerprint: z.string().min(1),
  artifactIds: z.array(z.string().min(1)),
  errorSummary: z.string().min(1).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const BookJobCatalogSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  items: z.array(BookJobSchema),
});

export const BookJobCheckpointListSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  items: z.array(BookJobStageCheckpointSchema),
});

export const BookArtifactManifestListSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  items: z.array(BookArtifactManifestSchema),
});

export const BookJobRunCatalogEntrySchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  bookId: z.string().min(1),
  stage: BookStageSchema,
  status: StageCheckpointStatusSchema,
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1).optional(),
});

export const BookJobRunCatalogSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  items: z.array(BookJobRunCatalogEntrySchema),
});

export const BookResumeStageStateSchema = z.object({
  stage: BookStageSchema,
  checkpointStatus: StageCheckpointStatusSchema.nullable(),
  expectedFingerprint: z.string().min(1).optional(),
  actualFingerprint: z.string().min(1).optional(),
  isSatisfied: z.boolean(),
  reason: z.enum([
    "missing",
    "pending",
    "failed",
    "stale",
    "artifact_missing",
    "ready",
  ]),
  missingArtifactIds: z.array(z.string().min(1)).optional(),
  missingArtifactKinds: z.array(BookArtifactKindSchema).optional(),
});

export const BookResumePlanSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  bookId: z.string().min(1),
  nextStage: BookStageSchema.nullable(),
  canQuery: z.boolean(),
  staleStages: z.array(BookStageSchema),
  completedStages: z.array(BookStageSchema),
  stageStates: z.array(BookResumeStageStateSchema),
});

export type BookStage = z.infer<typeof BookStageSchema>;
export type BookJobStatus = z.infer<typeof BookJobStatusSchema>;
export type StageCheckpointStatus = z.infer<
  typeof StageCheckpointStatusSchema
>;
export type BookArtifactKind = z.infer<typeof BookArtifactKindSchema>;
export type BookJob = z.infer<typeof BookJobSchema>;
export type BookJobStageCheckpoint = z.infer<
  typeof BookJobStageCheckpointSchema
>;
export type BookArtifactManifest = z.infer<typeof BookArtifactManifestSchema>;
export type BookJobRunRecord = z.infer<typeof BookJobRunRecordSchema>;
export type BookJobCatalog = z.infer<typeof BookJobCatalogSchema>;
export type BookJobCheckpointList = z.infer<
  typeof BookJobCheckpointListSchema
>;
export type BookArtifactManifestList = z.infer<
  typeof BookArtifactManifestListSchema
>;
export type BookJobRunCatalogEntry = z.infer<
  typeof BookJobRunCatalogEntrySchema
>;
export type BookJobRunCatalog = z.infer<typeof BookJobRunCatalogSchema>;
export type BookResumeStageState = z.infer<typeof BookResumeStageStateSchema>;
export type BookResumePlan = z.infer<typeof BookResumePlanSchema>;
