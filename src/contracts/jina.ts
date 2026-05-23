import { z } from "zod";

import { EnvVarNameSchema, buildEnvelopeSchema } from "./common.js";

export const JinaEmbeddingProfileNameSchema = z.enum(["text", "multimodal"]);
export const JinaEmbeddingTaskSchema = z.enum([
  "retrieval.query",
  "retrieval.passage",
  "text-matching",
  "clustering",
  "classification",
]);
export const JinaEmbeddingTypeSchema = z.enum([
  "float",
  "base64",
  "binary",
  "ubinary",
]);

export const JinaEmbeddingProfileSchema = z.object({
  name: JinaEmbeddingProfileNameSchema,
  embeddingModel: z.string().min(1),
  rerankModel: z.string().min(1),
  queryTask: JinaEmbeddingTaskSchema,
  documentTask: JinaEmbeddingTaskSchema,
  dimensions: z.number().int().positive(),
  normalized: z.boolean(),
  embeddingType: JinaEmbeddingTypeSchema,
  truncate: z.boolean(),
  modality: z.enum(["text", "multimodal"]),
});

export const JinaProviderConfigSchema = z.object({
  apiKeyEnv: EnvVarNameSchema,
  baseUrlEnv: EnvVarNameSchema,
  baseUrl: z.string().min(1),
  embeddingEndpoint: z.string().startsWith("/"),
  rerankEndpoint: z.string().startsWith("/"),
  embeddingProfile: JinaEmbeddingProfileNameSchema,
  embeddingModel: z.string().min(1),
  rerankModel: z.string().min(1),
  embeddingQueryTask: JinaEmbeddingTaskSchema,
  embeddingDocumentTask: JinaEmbeddingTaskSchema,
  embeddingDimensions: z.number().int().positive(),
  embeddingNormalized: z.boolean(),
  embeddingType: JinaEmbeddingTypeSchema,
  embeddingTruncate: z.boolean(),
});

export const JinaTextDocumentSchema = z.object({
  text: z.string().min(1),
});

export const JinaImageDocumentSchema = z.object({
  image: z.string().min(1),
});

export const JinaEmbeddingInputSchema = z.union([
  z.string().min(1),
  JinaTextDocumentSchema,
  JinaImageDocumentSchema,
]);

export const JinaEmbeddingRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([
    JinaEmbeddingInputSchema,
    z.array(JinaEmbeddingInputSchema).nonempty(),
  ]),
  task: JinaEmbeddingTaskSchema,
  dimensions: z.number().int().positive(),
  normalized: z.boolean(),
  embedding_type: JinaEmbeddingTypeSchema,
  truncate: z.boolean(),
});

export const JinaEmbeddingItemSchema = z.object({
  object: z.string().min(1).optional(),
  index: z.number().int().nonnegative(),
  embedding: z.array(z.number()),
});

export const JinaEmbeddingResponseSchema = z.object({
  model: z.string().min(1).optional(),
  object: z.string().min(1).optional(),
  data: z.array(JinaEmbeddingItemSchema),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export const JinaRerankDocumentSchema = z.union([
  z.string(),
  JinaTextDocumentSchema,
  JinaImageDocumentSchema,
]);

export const JinaRerankRequestSchema = z.object({
  model: z.string().min(1),
  query: z.string().min(1),
  documents: z.array(JinaRerankDocumentSchema),
  top_n: z.number().int().positive().optional(),
  return_documents: z.boolean().optional(),
});

export const JinaRerankResultSchema = z.object({
  index: z.number().int().nonnegative(),
  relevance_score: z.number(),
  document: JinaRerankDocumentSchema.optional(),
});

export const JinaRerankResponseSchema = z.object({
  model: z.string().min(1).optional(),
  results: z.array(JinaRerankResultSchema),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export const JinaEmbeddingRequestEnvelopeSchema = buildEnvelopeSchema(
  "provider.jina.embedding_request",
  JinaEmbeddingRequestSchema,
);

export const JinaProviderConfigEnvelopeSchema = buildEnvelopeSchema(
  "provider.jina.config",
  JinaProviderConfigSchema,
);

export const JinaEmbeddingResponseEnvelopeSchema = buildEnvelopeSchema(
  "provider.jina.embedding_response",
  JinaEmbeddingResponseSchema,
);

export const JinaRerankRequestEnvelopeSchema = buildEnvelopeSchema(
  "provider.jina.rerank_request",
  JinaRerankRequestSchema,
);

export const JinaRerankResponseEnvelopeSchema = buildEnvelopeSchema(
  "provider.jina.rerank_response",
  JinaRerankResponseSchema,
);

export type JinaEmbeddingProfileName = z.infer<typeof JinaEmbeddingProfileNameSchema>;
export type JinaEmbeddingProfile = z.infer<typeof JinaEmbeddingProfileSchema>;
export type JinaEmbeddingRequest = z.infer<typeof JinaEmbeddingRequestSchema>;
export type JinaProviderConfig = z.infer<typeof JinaProviderConfigSchema>;
export type JinaEmbeddingItem = z.infer<typeof JinaEmbeddingItemSchema>;
export type JinaEmbeddingResponse = z.infer<typeof JinaEmbeddingResponseSchema>;
export type JinaRerankDocument = z.infer<typeof JinaRerankDocumentSchema>;
export type JinaRerankRequest = z.infer<typeof JinaRerankRequestSchema>;
export type JinaRerankResult = z.infer<typeof JinaRerankResultSchema>;
export type JinaRerankResponse = z.infer<typeof JinaRerankResponseSchema>;
