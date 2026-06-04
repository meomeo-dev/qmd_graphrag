import { z } from "zod";

import {
  BridgeEnvironmentSchema,
  JsonValueSchema,
  SchemaVersion,
  buildEnvelopeSchema,
} from "./common.js";

export const GraphRagSearchMethodSchema = z.enum([
  "local",
  "global",
  "drift",
  "basic",
]);

export const GraphRagCapabilityScopeSchema = z.object({
  selectedBookIds: z.array(z.string().min(1)).nonempty(),
  graphCapabilityIds: z.array(z.string().min(1)).nonempty(),
  sourceIds: z.array(z.string().min(1)).nonempty(),
  documentIds: z.array(z.string().min(1)).nonempty(),
  contentHashes: z.array(z.string().min(1)).nonempty(),
  artifactIds: z.array(z.string().min(1)).nonempty(),
});

export const GraphRagIndexMethodSchema = z.enum([
  "standard",
  "fast",
  "standard-update",
  "fast-update",
]);

export const GraphRagWorkflowNameSchema = z.enum([
  "load_input_documents",
  "create_base_text_units",
  "create_final_documents",
  "extract_graph",
  "extract_graph_nlp",
  "finalize_graph",
  "extract_covariates",
  "prune_graph",
  "create_communities",
  "create_final_text_units",
  "create_community_reports",
  "create_community_reports_text",
  "generate_text_embeddings",
]);

export const GraphRagQueryRequestSchema = z.object({
  rootDir: z.string().min(1),
  dataDir: z.string().min(1).optional(),
  reportDir: z.string().min(1).optional(),
  method: GraphRagSearchMethodSchema,
  query: z.string().min(1),
  responseType: z.string().min(1),
  capabilityScope: GraphRagCapabilityScopeSchema,
  communityLevel: z.number().int().positive().optional(),
  dynamicCommunitySelection: z.boolean().optional(),
  includeRuntimeMetrics: z.boolean().optional(),
  verbose: z.boolean().optional(),
  environment: BridgeEnvironmentSchema.optional(),
});

export const GraphRagIndexScopeSchema = z.object({
  bookId: z.string().min(1),
  sourceId: z.string().min(1),
  documentId: z.string().min(1),
  contentHash: z.string().min(1),
  artifactIds: z.array(z.string().min(1)).default([]),
});

export const GraphRagWorkflowResultSchema = z.object({
  workflow: z.string().min(1),
  hasError: z.boolean(),
  errorMessage: z.string().optional(),
  resultSummary: z.string().optional(),
  stateKeys: z.array(z.string()),
});

export const GraphRagIndexRequestSchema = z.object({
  rootDir: z.string().min(1),
  inputDir: z.string().min(1).optional(),
  dataDir: z.string().min(1).optional(),
  reportDir: z.string().min(1),
  method: GraphRagIndexMethodSchema,
  indexScope: GraphRagIndexScopeSchema.optional(),
  verbose: z.boolean().optional(),
  skipValidation: z.boolean().optional(),
  workflows: z.array(GraphRagWorkflowNameSchema).nonempty().optional(),
  environment: BridgeEnvironmentSchema.optional(),
});

export const GraphRagEvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  graphCapabilityId: z.string().min(1),
  sourceId: z.string().min(1),
  documentId: z.string().min(1),
  bookId: z.string().min(1),
  contentHash: z.string().min(1),
  chunkId: z.string().min(1).nullable().optional(),
  graphTextUnitId: z.string().min(1),
  artifactId: z.string().min(1),
  locator: z.object({
    path: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
  }).nullable().optional(),
  quote: z.string().nullable().optional(),
  score: z.number().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const GraphRagQueryRuntimeStageSchema = z.object({
  name: z.string().min(1),
  durationMs: z.number().nonnegative(),
  status: z.enum(["succeeded", "failed"]),
});

export const GraphRagQueryModelMetricsSchema = z.object({
  model: z.string().min(1),
  attemptedRequestCount: z.number().int().nonnegative(),
  successfulResponseCount: z.number().int().nonnegative(),
  failedResponseCount: z.number().int().nonnegative(),
  requestsWithRetries: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  streamingResponseCount: z.number().int().nonnegative(),
  loggedComputeDurationMs: z.number().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheHitRate: z.number().nonnegative(),
});

export const GraphRagQueryRuntimeAggregateSchema = z.object({
  modelCount: z.number().int().nonnegative(),
  attemptedRequestCount: z.number().int().nonnegative(),
  successfulResponseCount: z.number().int().nonnegative(),
  failedResponseCount: z.number().int().nonnegative(),
  requestsWithRetries: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  streamingResponseCount: z.number().int().nonnegative(),
  loggedComputeDurationMs: z.number().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  unattributedWallDurationMs: z.number().nonnegative(),
});

export const GraphRagQueryRuntimeMetricsSchema = z.object({
  kind: z.literal("graphrag_query_runtime_metrics"),
  scope: z.enum(["current_invocation", "unavailable"]),
  totalDurationMs: z.number().nonnegative(),
  stages: z.array(GraphRagQueryRuntimeStageSchema).max(16),
  modelMetrics: z.array(GraphRagQueryModelMetricsSchema).max(32),
  aggregate: GraphRagQueryRuntimeAggregateSchema,
});

export const GraphRagProviderDetailSchema = z.object({
  provider: z.literal("graphrag"),
  method: GraphRagSearchMethodSchema,
  runtimeMetrics: GraphRagQueryRuntimeMetricsSchema.optional(),
});

export const GraphRagQueryResponseSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  method: GraphRagSearchMethodSchema,
  responseText: z.string(),
  evidence: z.array(GraphRagEvidenceSchema).nonempty(),
  providerDetail: GraphRagProviderDetailSchema.optional(),
});

export const GraphRagIndexResponseSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  method: GraphRagIndexMethodSchema,
  outputs: z.array(GraphRagWorkflowResultSchema),
});

export const GraphRagQueryEnvelopeSchema = buildEnvelopeSchema(
  "graphrag.query",
  GraphRagQueryRequestSchema,
);

export const GraphRagQueryResponseEnvelopeSchema = buildEnvelopeSchema(
  "graphrag.query_response",
  GraphRagQueryResponseSchema,
);

export const GraphRagEvidenceEnvelopeSchema = buildEnvelopeSchema(
  "graphrag.evidence",
  GraphRagEvidenceSchema,
);

export const GraphRagProviderDetailEnvelopeSchema = buildEnvelopeSchema(
  "graphrag.provider_detail",
  GraphRagProviderDetailSchema,
);

export const GraphRagIndexEnvelopeSchema = buildEnvelopeSchema(
  "graphrag.index",
  GraphRagIndexRequestSchema,
);

export const GraphRagIndexResponseEnvelopeSchema = buildEnvelopeSchema(
  "graphrag.index_response",
  GraphRagIndexResponseSchema,
);

export type GraphRagSearchMethod = z.infer<typeof GraphRagSearchMethodSchema>;
export type GraphRagCapabilityScope = z.infer<
  typeof GraphRagCapabilityScopeSchema
>;
export type GraphRagIndexMethod = z.infer<typeof GraphRagIndexMethodSchema>;
export type GraphRagWorkflowName = z.infer<typeof GraphRagWorkflowNameSchema>;
export type GraphRagQueryRequest = z.infer<typeof GraphRagQueryRequestSchema>;
export type GraphRagQueryResponse = z.infer<typeof GraphRagQueryResponseSchema>;
export type GraphRagIndexScope = z.infer<typeof GraphRagIndexScopeSchema>;
export type GraphRagEvidence = z.infer<typeof GraphRagEvidenceSchema>;
export type GraphRagQueryRuntimeStage = z.infer<
  typeof GraphRagQueryRuntimeStageSchema
>;
export type GraphRagQueryModelMetrics = z.infer<
  typeof GraphRagQueryModelMetricsSchema
>;
export type GraphRagQueryRuntimeAggregate = z.infer<
  typeof GraphRagQueryRuntimeAggregateSchema
>;
export type GraphRagQueryRuntimeMetrics = z.infer<
  typeof GraphRagQueryRuntimeMetricsSchema
>;
export type GraphRagProviderDetail = z.infer<typeof GraphRagProviderDetailSchema>;
export type GraphRagIndexRequest = z.infer<typeof GraphRagIndexRequestSchema>;
export type GraphRagIndexResponse = z.infer<typeof GraphRagIndexResponseSchema>;
export type GraphRagWorkflowResult = z.infer<typeof GraphRagWorkflowResultSchema>;
