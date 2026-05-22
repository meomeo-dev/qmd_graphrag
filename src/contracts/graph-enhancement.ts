import { z } from "zod";

import {
  JsonValueSchema,
  SchemaVersion,
  buildEnvelopeSchema,
} from "./common.js";
import { VaultRelativePathSchema } from "./corpus.js";

export const GraphCapabilityKindSchema = z.enum([
  "graph_query",
  "local_search",
  "global_search",
  "drift_search",
  "community_reports",
]);

export const GraphEnhancementStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "not_ready",
]);

export const GraphEnhancementRequestSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  requestId: z.string().min(1),
  sourceId: z.string().min(1),
  documentId: z.string().min(1),
  bookId: z.string().min(1),
  contentHash: z.string().min(1),
  graphVault: z.string().min(1),
  normalizedInputPath: VaultRelativePathSchema,
  methods: z.array(z.enum(["local", "global", "drift", "basic"])).nonempty(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const GraphEnhancementStateSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  bookId: z.string().min(1),
  sourceId: z.string().min(1),
  documentId: z.string().min(1),
  contentHash: z.string().min(1),
  status: GraphEnhancementStatusSchema,
  checkpointIds: z.array(z.string().min(1)),
  artifactIds: z.array(z.string().min(1)),
  capabilityIds: z.array(z.string().min(1)),
  updatedAt: z.string().min(1),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const GraphCapabilitySchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  capabilityId: z.string().min(1),
  kind: GraphCapabilityKindSchema,
  bookId: z.string().min(1),
  sourceId: z.string().min(1),
  documentId: z.string().min(1),
  contentHash: z.string().min(1),
  method: z.enum(["local", "global", "drift", "basic"]).optional(),
  ready: z.boolean(),
  readinessSource: z.literal("validated_checkpoint_plus_validated_manifest"),
  artifactIds: z.array(z.string().min(1)),
  createdAt: z.string().min(1),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const GraphCapabilityCatalogSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  items: z.array(GraphCapabilitySchema),
});

export const GraphEnhancementRequestEnvelopeSchema = buildEnvelopeSchema(
  "graph_enhancement.request",
  GraphEnhancementRequestSchema,
);

export const GraphEnhancementStateEnvelopeSchema = buildEnvelopeSchema(
  "graph_enhancement.state",
  GraphEnhancementStateSchema,
);

export const GraphCapabilityEnvelopeSchema = buildEnvelopeSchema(
  "graph_enhancement.capability",
  GraphCapabilitySchema,
);

export const GraphCapabilityCatalogEnvelopeSchema = buildEnvelopeSchema(
  "graph_enhancement.capability_catalog",
  GraphCapabilityCatalogSchema,
);

export type GraphCapabilityKind = z.infer<typeof GraphCapabilityKindSchema>;
export type GraphEnhancementStatus = z.infer<
  typeof GraphEnhancementStatusSchema
>;
export type GraphEnhancementRequest = z.infer<
  typeof GraphEnhancementRequestSchema
>;
export type GraphEnhancementState = z.infer<
  typeof GraphEnhancementStateSchema
>;
export type GraphCapability = z.infer<typeof GraphCapabilitySchema>;
export type GraphCapabilityCatalog = z.infer<
  typeof GraphCapabilityCatalogSchema
>;
