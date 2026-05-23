import { z } from "zod";

import {
  EnvVarNameSchema,
  JsonValueSchema,
  SchemaVersion,
  buildEnvelopeSchema,
  type JsonValue,
} from "./common.js";

export const OpenAIResponsesProviderConfigSchema = z.object({
  apiKeyEnv: EnvVarNameSchema,
  baseUrlEnv: EnvVarNameSchema,
  endpoint: z.literal("/responses"),
  stream: z.literal(true),
  model: z.string().min(1),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  strictStructuredOutput: z.literal(true),
});

export const OpenAIResponsesReasoningSchema = z.object({
  effort: z.enum(["low", "medium", "high"]).optional(),
});

export type StrictJsonSchemaNodeValue = {
  type?: string | string[];
  description?: string;
  enum?: JsonValue[];
  const?: JsonValue;
  properties?: Record<string, StrictJsonSchemaNodeValue>;
  required?: string[];
  items?: StrictJsonSchemaNodeValue | StrictJsonSchemaNodeValue[];
  anyOf?: StrictJsonSchemaNodeValue[];
  oneOf?: StrictJsonSchemaNodeValue[];
  allOf?: StrictJsonSchemaNodeValue[];
  $defs?: Record<string, StrictJsonSchemaNodeValue>;
  additionalProperties?: false;
};

export const StrictJsonSchemaNodeSchema: z.ZodType<StrictJsonSchemaNodeValue> =
  z.lazy(() =>
    z.object({
      type: z.union([z.string(), z.array(z.string())]).optional(),
      description: z.string().optional(),
      enum: z.array(JsonValueSchema).optional(),
      const: JsonValueSchema.optional(),
      properties: z.record(z.string(), StrictJsonSchemaNodeSchema).optional(),
      required: z.array(z.string()).optional(),
      items: z.union([
        StrictJsonSchemaNodeSchema,
        z.array(StrictJsonSchemaNodeSchema),
      ]).optional(),
      anyOf: z.array(StrictJsonSchemaNodeSchema).optional(),
      oneOf: z.array(StrictJsonSchemaNodeSchema).optional(),
      allOf: z.array(StrictJsonSchemaNodeSchema).optional(),
      $defs: z.record(z.string(), StrictJsonSchemaNodeSchema).optional(),
      additionalProperties: z.literal(false).optional(),
    }).superRefine((value, context) => {
      const type = value.type;
      const objectLike = type === "object"
        || (Array.isArray(type) && type.includes("object"))
        || value.properties !== undefined;

      if (objectLike && value.additionalProperties !== false) {
        context.addIssue({
          code: "custom",
          message: "object schemas must set additionalProperties to false",
          path: ["additionalProperties"],
        });
      }
    }),
  );

export const OpenAIStructuredOutputSchemaSchema = z.object({
  name: z.string().min(1),
  strict: z.literal(true),
  schema: StrictJsonSchemaNodeSchema,
});

export const OpenAIResponsesRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([
    z.string().min(1),
    z.array(JsonValueSchema).nonempty(),
    JsonValueSchema,
  ]),
  stream: z.literal(true),
  reasoning: OpenAIResponsesReasoningSchema.optional(),
  text: z.object({
    format: OpenAIStructuredOutputSchemaSchema,
  }).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const OpenAIResponsesResponseSchema = z.object({
  id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  outputText: z.string().optional(),
  usage: z.record(z.string(), JsonValueSchema).optional(),
  raw: JsonValueSchema.optional(),
});

export const OpenAIResponsesStreamEventSchema = z.object({
  type: z.string().min(1),
  sequence: z.number().int().nonnegative().optional(),
  textDelta: z.string().optional(),
  responseId: z.string().min(1).optional(),
  usage: z.record(z.string(), JsonValueSchema).optional(),
  raw: JsonValueSchema.optional(),
});

const ProviderCostIdentitySchema = z.object({
  sourceId: z.string().min(1).nullable(),
  documentId: z.string().min(1).nullable(),
  bookId: z.string().min(1).nullable(),
  contentHash: z.string().min(1).nullable(),
});

export const ProviderCostLineageModeSchema = z.enum([
  "corpus_artifact",
  "graph_artifact",
  "multi_document_query",
  "transient_query",
]);

export const ProviderCostAccountingSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  sourceId: ProviderCostIdentitySchema.shape.sourceId,
  documentId: ProviderCostIdentitySchema.shape.documentId,
  bookId: ProviderCostIdentitySchema.shape.bookId,
  contentHash: ProviderCostIdentitySchema.shape.contentHash,
  lineageMode: ProviderCostLineageModeSchema,
  stage: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  requestCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  tokenCountStatus: z.enum(["reported", "estimated", "unknown"]),
  embeddingCount: z.number().int().nonnegative(),
  embeddingCountStatus: z.enum(["reported", "estimated", "unknown"]),
  cacheHit: z.boolean(),
  runId: z.string().min(1),
  requestArtifactId: z.string().min(1),
  artifactIds: z.array(z.string().min(1)),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
}).superRefine((value, context) => {
  const hasCorpusIdentity =
    value.sourceId != null ||
    value.documentId != null ||
    value.bookId != null ||
    value.contentHash != null;
  const identityRequired =
    value.lineageMode === "corpus_artifact" ||
    value.lineageMode === "graph_artifact";

  if (identityRequired && !hasCorpusIdentity) {
    context.addIssue({
      code: "custom",
      message: "artifact lineage requires at least one corpus identity",
      path: ["lineageMode"],
    });
  }
  if (value.lineageMode === "transient_query" && hasCorpusIdentity) {
    context.addIssue({
      code: "custom",
      message: "transient_query lineage must not claim corpus identity",
      path: ["lineageMode"],
    });
  }
  if (!value.artifactIds.includes(value.requestArtifactId)) {
    context.addIssue({
      code: "custom",
      message: "artifactIds must include requestArtifactId",
      path: ["artifactIds"],
    });
  }
});

export const ProviderRequestFingerprintSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  artifactId: z.string().min(1),
  kind: z.literal("provider_request_fingerprint"),
  provider: z.string().min(1),
  stage: z.string().min(1),
  model: z.string().min(1),
  requestFingerprint: z.string().min(1),
  createdAt: z.string().min(1),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const OpenAIResponsesProviderConfigEnvelopeSchema = buildEnvelopeSchema(
  "provider.openai_responses.config",
  OpenAIResponsesProviderConfigSchema,
);

export const OpenAIResponsesRequestEnvelopeSchema = buildEnvelopeSchema(
  "provider.openai_responses.request",
  OpenAIResponsesRequestSchema,
);

export const OpenAIResponsesResponseEnvelopeSchema = buildEnvelopeSchema(
  "provider.openai_responses.response",
  OpenAIResponsesResponseSchema,
);

export const OpenAIResponsesStreamEventEnvelopeSchema = buildEnvelopeSchema(
  "provider.openai_responses.stream_event",
  OpenAIResponsesStreamEventSchema,
);

export const OpenAIStructuredOutputSchemaEnvelopeSchema = buildEnvelopeSchema(
  "provider.openai_responses.structured_output_schema",
  OpenAIStructuredOutputSchemaSchema,
);

export const ProviderCostAccountingEnvelopeSchema = buildEnvelopeSchema(
  "provider.cost_accounting",
  ProviderCostAccountingSchema,
);

export const ProviderRequestFingerprintEnvelopeSchema = buildEnvelopeSchema(
  "provider.request_fingerprint",
  ProviderRequestFingerprintSchema,
);

export type OpenAIResponsesProviderConfig = z.infer<
  typeof OpenAIResponsesProviderConfigSchema
>;
export type OpenAIResponsesReasoning = z.infer<
  typeof OpenAIResponsesReasoningSchema
>;
export type StrictJsonSchemaNode = z.infer<typeof StrictJsonSchemaNodeSchema>;
export type OpenAIStructuredOutputSchema = z.infer<
  typeof OpenAIStructuredOutputSchemaSchema
>;
export type OpenAIResponsesRequest = z.infer<
  typeof OpenAIResponsesRequestSchema
>;
export type OpenAIResponsesResponse = z.infer<
  typeof OpenAIResponsesResponseSchema
>;
export type OpenAIResponsesStreamEvent = z.infer<
  typeof OpenAIResponsesStreamEventSchema
>;
export type ProviderCostLineageMode = z.infer<
  typeof ProviderCostLineageModeSchema
>;
export type ProviderCostAccounting = z.infer<
  typeof ProviderCostAccountingSchema
>;
export type ProviderRequestFingerprint = z.infer<
  typeof ProviderRequestFingerprintSchema
>;
