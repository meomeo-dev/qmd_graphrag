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

export const GraphRagIndexMethodSchema = z.enum([
  "standard",
  "fast",
  "standard-update",
  "fast-update",
]);

export const GraphRagQueryRequestSchema = z.object({
  rootDir: z.string().min(1),
  dataDir: z.string().min(1).optional(),
  method: GraphRagSearchMethodSchema,
  query: z.string().min(1),
  responseType: z.string().min(1),
  communityLevel: z.number().int().positive().optional(),
  dynamicCommunitySelection: z.boolean().optional(),
  verbose: z.boolean().optional(),
  environment: BridgeEnvironmentSchema.optional(),
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
  method: GraphRagIndexMethodSchema,
  verbose: z.boolean().optional(),
  environment: BridgeEnvironmentSchema.optional(),
});

export const GraphRagQueryResponseSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  method: GraphRagSearchMethodSchema,
  responseText: z.string(),
  contextData: JsonValueSchema.optional(),
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

export const GraphRagIndexEnvelopeSchema = buildEnvelopeSchema(
  "graphrag.index",
  GraphRagIndexRequestSchema,
);

export type GraphRagSearchMethod = z.infer<typeof GraphRagSearchMethodSchema>;
export type GraphRagIndexMethod = z.infer<typeof GraphRagIndexMethodSchema>;
export type GraphRagQueryRequest = z.infer<typeof GraphRagQueryRequestSchema>;
export type GraphRagQueryResponse = z.infer<typeof GraphRagQueryResponseSchema>;
export type GraphRagIndexRequest = z.infer<typeof GraphRagIndexRequestSchema>;
export type GraphRagIndexResponse = z.infer<typeof GraphRagIndexResponseSchema>;
export type GraphRagWorkflowResult = z.infer<typeof GraphRagWorkflowResultSchema>;

