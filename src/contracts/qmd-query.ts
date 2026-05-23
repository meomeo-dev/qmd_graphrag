import { z } from "zod";

import {
  JsonValueSchema,
  QueryKindSchema,
  SchemaVersion,
  buildEnvelopeSchema,
} from "./common.js";

export const QmdQuerySearchSchema = z.object({
  type: QueryKindSchema,
  query: z.string().min(1),
  line: z.number().int().positive().optional(),
});

export const QmdQueryRequestSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  query: z.string().min(1),
  searches: z.array(QmdQuerySearchSchema).optional(),
  collections: z.array(z.string().min(1)).optional(),
  intent: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
  candidateLimit: z.number().int().positive().optional(),
  minScore: z.number().optional(),
  rerank: z.boolean().optional(),
  explain: z.boolean().optional(),
});

export const QmdRetrievalCandidateSchema = z.object({
  candidateId: z.string().min(1),
  sourceId: z.string().min(1).nullable(),
  documentId: z.string().min(1).nullable(),
  contentHash: z.string().min(1).nullable().optional(),
  chunkId: z.string().min(1).nullable(),
  collection: z.string().min(1).optional(),
  path: z.string().min(1),
  title: z.string().optional(),
  snippet: z.string().optional(),
  source: z.enum(["fts", "vec", "hybrid"]).optional(),
  retrievalScore: z.number(),
  rerankScore: z.number().nullable().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const QmdSearchResultSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  query: z.string().min(1),
  results: z.array(QmdRetrievalCandidateSchema),
  elapsedMs: z.number().nonnegative().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const ContentVectorEmbeddingRecordSchema = z.object({
  contentHash: z.string().min(1),
  chunkSeq: z.number().int().nonnegative(),
  chunkPos: z.number().int().nonnegative(),
  model: z.string().min(1),
  embedFingerprint: z.string().min(1),
  totalChunks: z.number().int().positive(),
  embeddedAt: z.string().datetime(),
});

export const QmdQueryRequestEnvelopeSchema = buildEnvelopeSchema(
  "qmd.query.request",
  QmdQueryRequestSchema,
);

export const QmdRetrievalCandidateEnvelopeSchema = buildEnvelopeSchema(
  "qmd.retrieval.candidate",
  QmdRetrievalCandidateSchema,
);

export const QmdSearchResultEnvelopeSchema = buildEnvelopeSchema(
  "qmd.search.result",
  QmdSearchResultSchema,
);

export const ContentVectorEmbeddingRecordEnvelopeSchema = buildEnvelopeSchema(
  "qmd.content_vector.embedding_record",
  ContentVectorEmbeddingRecordSchema,
);

export type QmdQuerySearch = z.infer<typeof QmdQuerySearchSchema>;
export type QmdQueryRequest = z.infer<typeof QmdQueryRequestSchema>;
export type QmdRetrievalCandidate = z.infer<
  typeof QmdRetrievalCandidateSchema
>;
export type QmdSearchResult = z.infer<typeof QmdSearchResultSchema>;
export type ContentVectorEmbeddingRecord = z.infer<
  typeof ContentVectorEmbeddingRecordSchema
>;
