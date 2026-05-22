import { z } from "zod";

import {
  JsonValueSchema,
  SchemaVersion,
  buildEnvelopeSchema,
} from "./common.js";
import { GraphRagProviderDetailSchema } from "./graphrag.js";

export const QueryRouteSchema = z.enum(["qmd", "graphrag", "auto"]);

export const SelectedQueryRouteSchema = z.enum(["qmd", "graphrag"]);
export const RouteDecisionStatusSchema = z.enum(["selected", "refused"]);

export const QueryIntentClassSchema = z.enum([
  "lookup",
  "source_location",
  "chunk_retrieval",
  "single_document_summary",
  "graph_synthesis",
  "multi_hop_reasoning",
]);

export const QueryCostClassSchema = z.enum(["low", "medium", "high"]);

export const RouteRefusalReasonSchema = z.enum([
  "no_graph_ready_candidate",
  "coverage_below_threshold",
  "intent_not_graph_synthesis",
  "cost_policy_exceeded",
  "graph_upgrade_disabled",
  "capability_missing",
  "provider_unavailable",
]);

export const UnifiedQueryRequestSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  query: z.string().min(1),
  requestedRoute: QueryRouteSchema,
  collections: z.array(z.string().min(1)).optional(),
  method: z.enum(["local", "global", "drift", "basic"]).optional(),
  maxCostClass: QueryCostClassSchema.optional(),
  graphCoverageThreshold: z.number().min(0).max(1).optional(),
  allowGraphUpgrade: z.boolean().optional(),
  explainRoute: z.boolean().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const CandidateDistributionSchema = z.object({
  totalCandidateCount: z.number().int().nonnegative(),
  graphReadyCandidateCount: z.number().int().nonnegative(),
  nonGraphReadyCandidateCount: z.number().int().nonnegative(),
});

export const CandidateRouteDecisionSchema = z.object({
  candidateId: z.string().min(1),
  sourceId: z.string().min(1).nullable(),
  documentId: z.string().min(1).nullable(),
  bookId: z.string().min(1).nullable(),
  isGraphReady: z.boolean(),
  retrievalScore: z.number().nullable(),
  rerankScore: z.number().nullable(),
  selected: z.boolean(),
  selectionReason: z.string().min(1).nullable(),
  refusalReason: RouteRefusalReasonSchema.nullable(),
});

export const QueryRouteDecisionSchema = z.object({
  requestedRoute: QueryRouteSchema,
  selectedRoute: SelectedQueryRouteSchema,
  status: RouteDecisionStatusSchema.default("selected"),
  reasonCode: z.string().min(1),
  intentClass: QueryIntentClassSchema,
  costClass: QueryCostClassSchema,
  maxCostClass: QueryCostClassSchema,
  graphCoverage: z.number().min(0).max(1),
  candidateDistribution: CandidateDistributionSchema,
  selectedSourceIds: z.array(z.string().min(1)),
  selectedDocumentIds: z.array(z.string().min(1)),
  selectedContentHashes: z.array(z.string().min(1)),
  selectedBookIds: z.array(z.string().min(1)),
  candidateEvidenceIds: z.array(z.string().min(1)),
  graphCapabilityIds: z.array(z.string().min(1)),
  graphArtifactIds: z.array(z.string().min(1)),
  candidateDecisions: z.array(CandidateRouteDecisionSchema),
  refusalReasons: z.array(RouteRefusalReasonSchema),
});

export const EvidenceLocatorSchema = z.object({
  path: z.string().min(1).optional(),
  uri: z.string().min(1).optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
});

export const EvidenceRefSchema = z.object({
  evidenceId: z.string().min(1),
  graphCapabilityId: z.string().min(1).nullable(),
  sourceId: z.string().min(1).nullable(),
  documentId: z.string().min(1).nullable(),
  contentHash: z.string().min(1).nullable(),
  chunkId: z.string().min(1).nullable(),
  bookId: z.string().min(1).nullable(),
  graphTextUnitId: z.string().min(1).nullable(),
  artifactId: z.string().min(1).nullable(),
  locator: EvidenceLocatorSchema.nullable(),
  quote: z.string().optional(),
  score: z.number().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const UnifiedAnswerSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  query: z.string().min(1),
  routeDecision: QueryRouteDecisionSchema,
  answerText: z.string(),
  evidence: z.array(EvidenceRefSchema),
  providerDetail: GraphRagProviderDetailSchema.optional(),
  elapsedMs: z.number().nonnegative().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const QueryStageSchema = z.enum([
  "route",
  "qmd_retrieval",
  "graph_capability",
  "graphrag_query",
  "provider",
  "answer",
]);

export const GraphCapabilityErrorSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  route: z.literal("graphrag"),
  provider: z.string().min(1).nullable(),
  capability: z.literal("graph_query"),
  code: z.literal("capability_missing"),
  retryable: z.literal(false),
  queriedScope: z.literal("graph_enhanced_subset"),
  sourceId: z.string().min(1).nullable(),
  documentId: z.string().min(1).nullable(),
  bookId: z.string().min(1).nullable(),
  redactedMessage: z.string().min(1),
});

export const TypedQueryErrorSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  route: QueryRouteSchema,
  stage: QueryStageSchema,
  provider: z.string().min(1).nullable(),
  capability: z.string().min(1).nullable(),
  code: z.string().min(1),
  retryable: z.boolean(),
  redactedMessage: z.string().min(1),
  graphCapabilityError: GraphCapabilityErrorSchema.optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const UnifiedQueryRequestEnvelopeSchema = buildEnvelopeSchema(
  "unified_query.request",
  UnifiedQueryRequestSchema,
);

export const QueryRouteDecisionEnvelopeSchema = buildEnvelopeSchema(
  "unified_query.route_decision",
  QueryRouteDecisionSchema,
);

export const CandidateRouteDecisionEnvelopeSchema = buildEnvelopeSchema(
  "unified_query.candidate_route_decision",
  CandidateRouteDecisionSchema,
);

export const EvidenceRefEnvelopeSchema = buildEnvelopeSchema(
  "unified_query.evidence_ref",
  EvidenceRefSchema,
);

export const UnifiedAnswerEnvelopeSchema = buildEnvelopeSchema(
  "unified_query.answer",
  UnifiedAnswerSchema,
);

export const GraphCapabilityErrorEnvelopeSchema = buildEnvelopeSchema(
  "unified_query.graph_capability_error",
  GraphCapabilityErrorSchema,
);

export const TypedQueryErrorEnvelopeSchema = buildEnvelopeSchema(
  "unified_query.error",
  TypedQueryErrorSchema,
);

export type QueryRoute = z.infer<typeof QueryRouteSchema>;
export type SelectedQueryRoute = z.infer<typeof SelectedQueryRouteSchema>;
export type RouteDecisionStatus = z.infer<typeof RouteDecisionStatusSchema>;
export type QueryIntentClass = z.infer<typeof QueryIntentClassSchema>;
export type QueryCostClass = z.infer<typeof QueryCostClassSchema>;
export type RouteRefusalReason = z.infer<typeof RouteRefusalReasonSchema>;
export type UnifiedQueryRequest = z.infer<typeof UnifiedQueryRequestSchema>;
export type CandidateDistribution = z.infer<
  typeof CandidateDistributionSchema
>;
export type CandidateRouteDecision = z.infer<
  typeof CandidateRouteDecisionSchema
>;
export type QueryRouteDecision = z.infer<typeof QueryRouteDecisionSchema>;
export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type UnifiedAnswer = z.infer<typeof UnifiedAnswerSchema>;
export type QueryStage = z.infer<typeof QueryStageSchema>;
export type GraphCapabilityError = z.infer<typeof GraphCapabilityErrorSchema>;
export type TypedQueryError = z.infer<typeof TypedQueryErrorSchema>;
