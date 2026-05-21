import { z } from "zod";

export const JinaRerankDocumentSchema = z.union([
  z.string(),
  z.object({
    text: z.string().min(1),
  }),
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

export type JinaRerankDocument = z.infer<typeof JinaRerankDocumentSchema>;
export type JinaRerankRequest = z.infer<typeof JinaRerankRequestSchema>;
export type JinaRerankResult = z.infer<typeof JinaRerankResultSchema>;
export type JinaRerankResponse = z.infer<typeof JinaRerankResponseSchema>;
