import { z } from "zod";

import {
  BridgeEnvironmentSchema,
  QueryExpansionItemSchema,
  SchemaVersion,
  buildEnvelopeSchema,
} from "./common.js";

export const DspyOptimizerSchema = z.enum(["gepa"]);
export const DspyAutoModeSchema = z.enum(["light", "medium", "heavy"]);

export const DspyQueryPromptOptimizationRequestSchema = z.object({
  optimizer: DspyOptimizerSchema,
  trainsetPath: z.string().min(1),
  valsetPath: z.string().min(1).optional(),
  model: z.string().min(1),
  reflectionModel: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  reflectionMaxTokens: z.number().int().positive().optional(),
  auto: DspyAutoModeSchema.optional(),
  maxFullEvals: z.number().int().positive().optional(),
  maxMetricCalls: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  valLimit: z.number().int().positive().optional(),
  savePromptPath: z.string().min(1).optional(),
  emitPath: z.string().min(1).optional(),
  environment: BridgeEnvironmentSchema.optional(),
});

export const DspyGeneratedExpansionRecordSchema = z.object({
  query: z.string().min(1),
  output: z.array(QueryExpansionItemSchema),
});

export const DspyQueryPromptOptimizationResponseSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  optimizer: DspyOptimizerSchema,
  command: z.array(z.string().min(1)),
  savedPromptPath: z.string().optional(),
  emitPath: z.string().optional(),
  stdoutTail: z.array(z.string()),
});

export const DspyOptimizationEnvelopeSchema = buildEnvelopeSchema(
  "dspy.optimize_query_prompt",
  DspyQueryPromptOptimizationRequestSchema,
);

export const DspyOptimizationResponseEnvelopeSchema = buildEnvelopeSchema(
  "dspy.optimized_query_prompt_artifact",
  DspyQueryPromptOptimizationResponseSchema,
);

export const DspyGeneratedExpansionRecordEnvelopeSchema = buildEnvelopeSchema(
  "dspy.generated_expansion_record",
  DspyGeneratedExpansionRecordSchema,
);

export type DspyOptimizer = z.infer<typeof DspyOptimizerSchema>;
export type DspyAutoMode = z.infer<typeof DspyAutoModeSchema>;
export type DspyQueryPromptOptimizationRequest = z.infer<
  typeof DspyQueryPromptOptimizationRequestSchema
>;
export type DspyQueryPromptOptimizationResponse = z.infer<
  typeof DspyQueryPromptOptimizationResponseSchema
>;
export type DspyGeneratedExpansionRecord = z.infer<
  typeof DspyGeneratedExpansionRecordSchema
>;
