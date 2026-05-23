import { z } from "zod";

import {
  BridgeEnvironmentSchema,
  EnvVarNameSchema,
  JsonValueSchema,
  QueryExpansionItemSchema,
  RedactedTextSchema,
  SchemaVersion,
  buildEnvelopeSchema,
} from "./common.js";
import { VaultRelativePathSchema } from "./corpus.js";
import { OpenAIResponsesProviderConfigSchema } from "./provider.js";

export { EnvVarNameSchema, RedactedTextSchema } from "./common.js";
export { VaultRelativePathSchema } from "./corpus.js";

export const DspyOptimizerSchema = z.enum(["gepa"]);
export const DspyAutoModeSchema = z.enum(["light", "medium", "heavy"]);
export const DspyProgramNameSchema = z.enum(["query_expansion"]);
export const DspyRuntimeProjectionSchema = z.enum([
  "optimized_prompt",
  "generated_expansion_records",
]);
export const DspyPromotionStatusSchema = z.enum([
  "candidate",
  "promoted",
  "rejected",
  "disabled",
  "rolled_back",
]);
export const DspyRunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const DspyGateVerdictSchema = z.enum([
  "promote",
  "reject",
  "disable",
  "rollback",
]);
export const DspyPolicyProviderSchema = z.enum(["builtin", "dspy", "disabled"]);
export const QueryExpansionFailureActionSchema = z.enum([
  "fallback_to_builtin_expander",
  "strict_refuse",
]);
export const QueryExpansionFailureReasonSchema = z.enum([
  "pointer_missing",
  "decision_missing",
  "policy_unavailable",
  "artifact_missing",
  "generated_expansion_missing",
  "artifact_stale",
  "runtime_output_schema_invalid",
  "runtime_error",
]);
export const DspyExpansionFailureReasonSchema = z.union([
  QueryExpansionFailureReasonSchema,
  z.literal("artifact_invalid"),
]);
export const DspyArtifactRequestModeSchema = z.enum([
  "online_policy",
  "batch_search_only",
]);
export const DspyArtifactPromotabilitySchema = z.enum([
  "promotable",
  "non_promotable",
]);

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
  provider: OpenAIResponsesProviderConfigSchema.default({
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    endpoint: "/responses",
    stream: true,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    strictStructuredOutput: true,
  }),
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
  stdoutTail: z.array(RedactedTextSchema),
});

export const DspyOptimizationRequestSummarySchema = z.strictObject({
  optimizer: DspyOptimizerSchema,
  model: RedactedTextSchema,
  reflectionModel: RedactedTextSchema.optional(),
  trainsetHash: z.string().min(1),
  valsetHash: z.string().min(1).optional(),
  auto: DspyAutoModeSchema.optional(),
  maxMetricCalls: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  valLimit: z.number().int().positive().optional(),
});

export const DspyOptimizationResponseSummarySchema = z.strictObject({
  optimizer: DspyOptimizerSchema,
  command: z.array(RedactedTextSchema),
  savedPromptPath: VaultRelativePathSchema.optional(),
  emitPath: VaultRelativePathSchema.optional(),
  stdoutTail: z.array(RedactedTextSchema),
});

export const QueryExpansionFailurePolicySchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  defaultAction: QueryExpansionFailureActionSchema,
  reasonActions: z.record(z.string(), QueryExpansionFailureActionSchema)
    .superRefine((value, ctx) => {
      const allowed = new Set(QueryExpansionFailureReasonSchema.options);
      const nativeFallbackReasons = new Set([
        "pointer_missing",
        "decision_missing",
        "policy_unavailable",
      ]);
      for (const key of Object.keys(value)) {
        if (key === "artifact_invalid") {
          ctx.addIssue({
            code: "custom",
            message: "artifact_invalid is fail-closed and is not configurable",
          });
          continue;
        }
        if (
          nativeFallbackReasons.has(key) &&
          value[key] === "strict_refuse"
        ) {
          ctx.addIssue({
            code: "custom",
            message: `${key} must preserve native qmd fallback behavior`,
          });
          continue;
        }
        if (!allowed.has(key as z.infer<typeof QueryExpansionFailureReasonSchema>)) {
          ctx.addIssue({
            code: "custom",
            message: `unknown query expansion failure reason: ${key}`,
          });
        }
      }
    })
    .optional(),
  strictSchema: z.boolean().default(true),
});

export const CorpusSnapshotRefSchema = z.strictObject({
  snapshotId: z.string().min(1),
  fingerprint: z.string().min(1),
});

export const QmdIndexSnapshotRefSchema = z.strictObject({
  snapshotId: z.string().min(1),
  fingerprint: z.string().min(1),
});

export const DspyFingerprintSetSchema = z.strictObject({
  modelFingerprint: z.string().min(1),
  providerFingerprint: z.string().min(1),
  retrievalConfigFingerprint: z.string().min(1),
  corpusSnapshotFingerprint: z.string().min(1),
  indexSnapshotFingerprint: z.string().min(1),
  retrieverFingerprint: z.string().min(1),
  rerankerFingerprint: z.string().min(1),
  schemaFingerprint: z.string().min(1),
});

export const DspyOptimizationRunSchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  optimizer: DspyOptimizerSchema,
  programName: DspyProgramNameSchema,
  signatureVersion: z.string().min(1),
  status: DspyRunStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  requestFingerprint: z.string().min(1),
  responseFingerprint: z.string().min(1).optional(),
  requestSummary: DspyOptimizationRequestSummarySchema,
  responseSummary: DspyOptimizationResponseSummarySchema.optional(),
  artifactId: z.string().min(1).optional(),
  failureReason: RedactedTextSchema.optional(),
  runDir: VaultRelativePathSchema.optional(),
  logDir: VaultRelativePathSchema.optional(),
  maxMetricCalls: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().positive().optional(),
  budgetOverflowReason: RedactedTextSchema.optional(),
});

export const DspyOptimizationArtifactSchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  artifactId: z.string().min(1),
  optimizer: DspyOptimizerSchema,
  programName: DspyProgramNameSchema,
  signatureVersion: z.string().min(1),
  runtimeProjection: DspyRuntimeProjectionSchema,
  requestMode: DspyArtifactRequestModeSchema,
  promotability: DspyArtifactPromotabilitySchema,
  promotionStatus: DspyPromotionStatusSchema,
  createdAt: z.string().datetime(),
  artifactHash: z.string().min(1),
  promptArtifactPath: VaultRelativePathSchema.optional(),
  promptArtifactHash: z.string().min(1).optional(),
  compiledProgramPath: VaultRelativePathSchema.optional(),
  compiledProgramHash: z.string().min(1).optional(),
  generatedExpansionPath: VaultRelativePathSchema.optional(),
  generatedExpansionHash: z.string().min(1).optional(),
  providerCallLedgerPath: VaultRelativePathSchema,
  corpusSnapshot: CorpusSnapshotRefSchema.optional(),
  qmdIndexSnapshot: QmdIndexSnapshotRefSchema.optional(),
  fingerprints: DspyFingerprintSetSchema,
  metricVersion: z.string().min(1),
  trainsetHash: z.string().min(1),
  valsetHash: z.string().min(1).optional(),
  testsetHash: z.string().min(1).optional(),
  seed: z.number().int().optional(),
  maxPromptTokens: z.number().int().positive().optional(),
  maxExpansionItems: z.number().int().positive(),
  providerEnvRefs: z.array(EnvVarNameSchema).default([]),
  stdoutTail: z.array(RedactedTextSchema).default([]),
});

export const DspyExpansionPolicySchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  policyId: z.string().min(1),
  provider: z.literal("dspy"),
  decisionId: z.string().min(1),
  artifactId: z.string().min(1),
  artifactHash: z.string().min(1),
  runtimeProjection: DspyRuntimeProjectionSchema,
  promptArtifactPath: VaultRelativePathSchema.optional(),
  generatedExpansionPath: VaultRelativePathSchema.optional(),
  fingerprints: DspyFingerprintSetSchema,
  failurePolicy: QueryExpansionFailurePolicySchema,
  maxExpansionItems: z.number().int().positive(),
});

export const DspyPolicyPointerSchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  pointerId: z.string().min(1),
  provider: DspyPolicyProviderSchema,
  active: z.boolean(),
  currentDecisionId: z.string().min(1).optional(),
  currentDecisionPath: VaultRelativePathSchema.optional(),
  failurePolicy: QueryExpansionFailurePolicySchema,
  updatedAt: z.string().datetime(),
});

export const DspyPointerLockErrorSchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  code: z.literal("dspy_pointer_lock_unavailable"),
  pointerPath: VaultRelativePathSchema,
  lockPath: VaultRelativePathSchema,
  redactedMessage: RedactedTextSchema,
});

export const DspyEvaluationDatasetSchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  datasetId: z.string().min(1),
  datasetPath: VaultRelativePathSchema.optional(),
  trainsetPath: VaultRelativePathSchema.optional(),
  valsetPath: VaultRelativePathSchema.optional(),
  testsetPath: VaultRelativePathSchema.optional(),
  trainsetHash: z.string().min(1).optional(),
  valsetHash: z.string().min(1).optional(),
  testsetHash: z.string().min(1).optional(),
  queryCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export const DspyEvaluationReportSchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  reportId: z.string().min(1),
  artifactId: z.string().min(1),
  artifactHash: z.string().min(1),
  datasetId: z.string().min(1).optional(),
  metricVersion: z.string().min(1),
  createdAt: z.string().datetime(),
  schemaValidity: z.boolean(),
  promotability: z.enum(["promotable", "not_promotable"]),
  totalRecords: z.number().int().nonnegative(),
  validRecords: z.number().int().nonnegative(),
  invalidRecords: z.number().int().nonnegative(),
  metrics: z.record(z.string(), JsonValueSchema),
  failureReason: RedactedTextSchema.optional(),
});

export const DspyPromotionDecisionSchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  decisionId: z.string().min(1),
  artifactId: z.string().min(1),
  artifactHash: z.string().min(1),
  artifactPath: VaultRelativePathSchema,
  reportId: z.string().min(1),
  reportHash: z.string().min(1),
  reportPath: VaultRelativePathSchema,
  previousDecisionId: z.string().min(1).nullable(),
  previousPointerState: DspyPolicyPointerSchema.nullable(),
  historyEntryId: z.string().min(1),
  decisionReason: RedactedTextSchema,
  promotionStatus: DspyPromotionStatusSchema,
  gateVerdict: DspyGateVerdictSchema,
  decidedAt: z.string().datetime(),
});

export const DspyPromotionHistoryEntrySchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  historyEntryId: z.string().min(1),
  eventType: DspyGateVerdictSchema,
  pointerBefore: DspyPolicyPointerSchema.nullable(),
  pointerAfter: DspyPolicyPointerSchema.nullable(),
  decisionId: z.string().min(1).optional(),
  actor: z.string().min(1),
  createdAt: z.string().datetime(),
  recoveryMarker: z.string().min(1).optional(),
});

export const DspyQueryExpansionProgramInputSchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  query: z.string().min(1),
  intent: z.string().min(1).optional(),
  conversationContext: z.string().min(1).optional(),
  policyId: z.string().min(1),
  fingerprints: DspyFingerprintSetSchema,
});

export const DspyQueryExpansionProgramOutputSchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  output: z.array(QueryExpansionItemSchema),
});

export const DspyMetricSpecSchema = z.strictObject({
  schemaVersion: z.literal(SchemaVersion),
  metricVersion: z.string().min(1),
  name: z.string().min(1),
  description: RedactedTextSchema,
  maxMetricCalls: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().positive().optional(),
  maxExpansionItems: z.number().int().positive(),
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

export const DspyOptimizationRunEnvelopeSchema = buildEnvelopeSchema(
  "dspy.optimization_run",
  DspyOptimizationRunSchema,
);

export const DspyOptimizationArtifactEnvelopeSchema = buildEnvelopeSchema(
  "dspy.optimization_artifact",
  DspyOptimizationArtifactSchema,
);

export const DspyExpansionPolicyEnvelopeSchema = buildEnvelopeSchema(
  "dspy.expansion_policy",
  DspyExpansionPolicySchema,
);

export const DspyPolicyPointerEnvelopeSchema = buildEnvelopeSchema(
  "dspy.policy_pointer",
  DspyPolicyPointerSchema,
);

export const DspyPointerLockErrorEnvelopeSchema = buildEnvelopeSchema(
  "dspy.pointer_lock_error",
  DspyPointerLockErrorSchema,
);

export const DspyEvaluationDatasetEnvelopeSchema = buildEnvelopeSchema(
  "dspy.evaluation_dataset",
  DspyEvaluationDatasetSchema,
);

export const DspyEvaluationReportEnvelopeSchema = buildEnvelopeSchema(
  "dspy.evaluation_report",
  DspyEvaluationReportSchema,
);

export const DspyPromotionDecisionEnvelopeSchema = buildEnvelopeSchema(
  "dspy.promotion_decision",
  DspyPromotionDecisionSchema,
);

export const DspyPromotionHistoryEntryEnvelopeSchema = buildEnvelopeSchema(
  "dspy.promotion_history_entry",
  DspyPromotionHistoryEntrySchema,
);

export const DspyQueryExpansionProgramInputEnvelopeSchema = buildEnvelopeSchema(
  "dspy.query_expansion_program_input",
  DspyQueryExpansionProgramInputSchema,
);

export const DspyQueryExpansionProgramOutputEnvelopeSchema = buildEnvelopeSchema(
  "dspy.query_expansion_program_output",
  DspyQueryExpansionProgramOutputSchema,
);

export const DspyMetricSpecEnvelopeSchema = buildEnvelopeSchema(
  "dspy.metric_spec",
  DspyMetricSpecSchema,
);

export type DspyOptimizer = z.infer<typeof DspyOptimizerSchema>;
export type DspyAutoMode = z.infer<typeof DspyAutoModeSchema>;
export type DspyRuntimeProjection = z.infer<typeof DspyRuntimeProjectionSchema>;
export type DspyPromotionStatus = z.infer<typeof DspyPromotionStatusSchema>;
export type QueryExpansionFailureAction = z.infer<
  typeof QueryExpansionFailureActionSchema
>;
export type QueryExpansionFailureReason = z.infer<
  typeof QueryExpansionFailureReasonSchema
>;
export type DspyExpansionFailureReason = z.infer<
  typeof DspyExpansionFailureReasonSchema
>;
export type QueryExpansionFailurePolicy = z.infer<
  typeof QueryExpansionFailurePolicySchema
>;
export type DspyQueryPromptOptimizationRequest = z.infer<
  typeof DspyQueryPromptOptimizationRequestSchema
>;
export type DspyQueryPromptOptimizationResponse = z.infer<
  typeof DspyQueryPromptOptimizationResponseSchema
>;
export type DspyOptimizationRequestSummary = z.infer<
  typeof DspyOptimizationRequestSummarySchema
>;
export type DspyOptimizationResponseSummary = z.infer<
  typeof DspyOptimizationResponseSummarySchema
>;
export type DspyGeneratedExpansionRecord = z.infer<
  typeof DspyGeneratedExpansionRecordSchema
>;
export type DspyFingerprintSet = z.infer<typeof DspyFingerprintSetSchema>;
export type DspyOptimizationRun = z.infer<typeof DspyOptimizationRunSchema>;
export type DspyOptimizationArtifact = z.infer<
  typeof DspyOptimizationArtifactSchema
>;
export type DspyExpansionPolicy = z.infer<typeof DspyExpansionPolicySchema>;
export type DspyPolicyPointer = z.infer<typeof DspyPolicyPointerSchema>;
export type DspyPointerLockError = z.infer<typeof DspyPointerLockErrorSchema>;
export type DspyEvaluationDataset = z.infer<typeof DspyEvaluationDatasetSchema>;
export type DspyEvaluationReport = z.infer<typeof DspyEvaluationReportSchema>;
export type DspyPromotionDecision = z.infer<
  typeof DspyPromotionDecisionSchema
>;
export type DspyPromotionHistoryEntry = z.infer<
  typeof DspyPromotionHistoryEntrySchema
>;
export type DspyQueryExpansionProgramInput = z.infer<
  typeof DspyQueryExpansionProgramInputSchema
>;
export type DspyQueryExpansionProgramOutput = z.infer<
  typeof DspyQueryExpansionProgramOutputSchema
>;
export type DspyMetricSpec = z.infer<typeof DspyMetricSpecSchema>;
