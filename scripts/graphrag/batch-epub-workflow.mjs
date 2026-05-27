#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  openSync,
  rmSync,
  renameSync,
  statSync,
  closeSync,
  readSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { parseArgs } from "node:util";

import YAML from "yaml";
import { z } from "zod";

import {
  classifyFailure,
  isLocalArtifactGateFailureText,
} from "./batch-failure-classifier.mjs";
import { hydrateBatchCheckpoint } from "./batch-checkpoint-hydration.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const defaultSourceDir = join(root, "inbox", "软件工程与系统设计经典著作指南");
const timestamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);

const { values } = parseArgs({
  options: {
    "source-dir": { type: "string", default: defaultSourceDir },
    "state-root": { type: "string", default: join(root, "graph_vault") },
    "qmd-index-path": { type: "string", default: join(root, ".qmd", "index.sqlite") },
    config: { type: "string", default: join(root, ".qmd", "index.yml") },
    "python-bin": {
      type: "string",
      default: join(root, ".venv-graphrag", "bin", "python"),
    },
    "run-id": { type: "string", default: `epub-batch-${timestamp}` },
    "log-root": { type: "string", default: join("/tmp", `qmd-epub-batch-${timestamp}`) },
    "project-dotenv": { type: "string", default: join(root, ".env") },
    query: {
      type: "string",
      default: "How does this book explain software design complexity?",
    },
    "max-command-attempts": { type: "string", default: "3" },
    "max-transient-command-attempts": { type: "string", default: "12" },
    "max-resume-passes": { type: "string", default: "24" },
    "retry-base-delay-seconds": { type: "string", default: "30" },
    "retry-max-delay-seconds": { type: "string", default: "300" },
    "retry-budget-seconds": { type: "string", default: "7200" },
    "max-provider-recovery-waits": { type: "string", default: "3" },
    "command-timeout-seconds": { type: "string", default: "21600" },
    "completed-manifest": { type: "string" },
    "heartbeat-interval-seconds": { type: "string", default: "30" },
    "migrate-only": { type: "boolean", default: false },
    "status-json": { type: "boolean", default: false },
    "skip-dotenv": { type: "boolean", default: false },
    "fail-fast": { type: "boolean", default: false },
    verbose: { type: "boolean", default: true },
  },
});

const SchemaVersion = "1.0.0";
const sourceDir = resolve(String(values["source-dir"]));
const stateRoot = resolve(String(values["state-root"]));
const qmdIndexPath = resolve(String(values["qmd-index-path"]));
const configPath = resolve(String(values.config));
const pythonBin = resolve(String(values["python-bin"]));
const runId = String(values["run-id"]);
const logRoot = resolve(String(values["log-root"]));
const projectDotenvPath = resolve(String(values["project-dotenv"]));
const query = String(values.query);
const completedManifestPath = values["completed-manifest"]
  ? resolve(String(values["completed-manifest"]))
  : null;
const maxCommandAttempts = Math.max(
  1,
  Number.parseInt(String(values["max-command-attempts"]), 10) || 3,
);
const maxTransientCommandAttempts = Math.max(
  maxCommandAttempts,
  Number.parseInt(String(values["max-transient-command-attempts"]), 10) || 12,
);
const maxResumePasses = Math.max(
  1,
  Number.parseInt(String(values["max-resume-passes"]), 10) || 24,
);
const retryBaseDelaySeconds = Math.max(
  1,
  Number.parseInt(String(values["retry-base-delay-seconds"]), 10) || 30,
);
const retryMaxDelaySeconds = Math.max(
  retryBaseDelaySeconds,
  Number.parseInt(String(values["retry-max-delay-seconds"]), 10) || 300,
);
const retryBudgetSeconds = Math.max(
  retryMaxDelaySeconds,
  Number.parseInt(String(values["retry-budget-seconds"]), 10) || 7200,
);
const maxProviderRecoveryWaits = Math.max(
  1,
  Number.parseInt(String(values["max-provider-recovery-waits"]), 10) || 3,
);
const maxProviderAuthReopenAttempts = 3;
const commandTimeoutSeconds = Math.max(
  1,
  Number.parseInt(String(values["command-timeout-seconds"]), 10) || 21600,
);
const heartbeatIntervalSeconds = Math.max(
  1,
  Number.parseInt(String(values["heartbeat-interval-seconds"]), 10) || 30,
);
const runnerHost = hostname();
const runnerPid = process.pid;
const runnerSessionId = randomUUID();
const runnerHeartbeatTtlSeconds = Math.max(commandTimeoutSeconds * 2, 3600);
const jsonFileLockStaleMs = 120000;
const failFast = Boolean(values["fail-fast"]);
const migrateOnly = Boolean(values["migrate-only"]);
const statusJson = Boolean(values["status-json"]);
const initialEnvNames = new Set(Object.keys(process.env));
const extraExactRedactions = new Map();

const RepairReasonSchema = z.enum([
  "graph_identity_projection_missing",
  "graph_query_capability_projection_missing",
]);
const RepairedProjectionSchema = z.union([
  z.enum(["document_identity_map", "graph_capability"]),
  z.array(z.enum(["document_identity_map", "graph_capability"]))
    .min(1)
    .max(2),
]);
const RepairMetadataSchema = z.object({
  reopenedFromStatus: z.string().min(1),
  reopenedToStatus: z.literal("pending"),
  reopenedFromRecoveryDecision: z.string().min(1),
  activeCommand: z.string().min(1).optional(),
  repairReason: RepairReasonSchema,
  repairFailureText: z.string().min(1).max(1000),
  repairedProjection: RepairedProjectionSchema,
  repairEvidenceLocator: z.string().min(1),
  reusedProducerRunIds: z.object({
    graph_extract: z.string().min(1),
    community_report: z.string().min(1),
    embed: z.string().min(1),
  }).passthrough(),
  normalCommandChecksRequired: z.literal(true),
  settingsProjectionDecision: z.enum([
    "already_valid",
    "rewritten",
    "rejected_user_owned",
    "rejected_invalid_source",
  ]).optional(),
  settingsProjectionRewritten: z.boolean().optional(),
  settingsProjectionSourceFingerprint: z.string().min(1).optional(),
  settingsProjectionProjectConfigLocator: z.string().min(1).optional(),
  settingsProjectionLocator: z.string().min(1).optional(),
  settingsProjectionEvidenceLocator: z.string().min(1).optional(),
  settingsProjectionReason: z.string().min(1).optional(),
});

const batchRoot = join(stateRoot, "catalog", "batch-runs", runId);
const itemRoot = join(batchRoot, "items");
const eventsPath = join(batchRoot, "events.jsonl");
const manifestPath = join(batchRoot, "manifest.json");
const recoverySummaryPath = join(batchRoot, "recovery-summary.json");
const requiredCommandCheckNames = [
  "qmd-version",
  "qmd-status",
  "qmd-doctor-json",
  "qmd-pull",
  "qmd-update",
  "qmd-embed",
  "qmd-ls-books",
  "qmd-search-json",
  "qmd-search-csv",
  "qmd-search-md",
  "qmd-search-xml",
  "qmd-search-files",
  "qmd-vsearch-json",
  "qmd-query-json",
  "qmd-query-auto-json",
  "qmd-query-graphrag-json",
  "qmd-get-book",
  "qmd-multi-get-json",
  "qmd-collection-list",
  "qmd-collection-show-books",
  "qmd-context-list",
  "qmd-skills-list-json",
  "qmd-skills-get-json",
  "qmd-skills-path-json",
  "qmd-skill-show",
  "qmd-dspy-status-json",
  "qmd-cleanup",
];
const graphQueryCommandCheckNames = [
  "qmd-query-auto-json",
  "qmd-query-graphrag-json",
];
const qmdNativeCommandCheckNames = requiredCommandCheckNames.filter(
  (name) => !graphQueryCommandCheckNames.includes(name),
);
const expectedCommandCheckCount = requiredCommandCheckNames.length;
const expectedQmdNativeCommandCheckCount = qmdNativeCommandCheckNames.length;
const requiredLanceDbTables = [
  "entity_description.lance",
  "community_full_content.lance",
  "text_unit_text.lance",
];

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const JsonValueSchema = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
const BatchItemStatusSchema = z.enum([
  "pending",
  "running",
  "skipped",
  "completed",
  "failed",
]);
const BatchRunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "incomplete",
]);
const BatchFailureKindSchema = z.enum([
  "transient",
  "permanent",
  "data_compatibility",
  "unknown",
]);
const BatchRecoveryDecisionSchema = z.enum([
  "none",
  "retry_same_run_id",
  "continue_pending",
  "stop_until_fixed",
]);
const BatchProjectRelativeLocatorSchema = z.string().min(1).refine(
  (value) => {
    if (value.includes("\0")) return false;
    if (value.startsWith("/") || value.startsWith("\\")) return false;
    if (/^[A-Za-z]:[\\/]/u.test(value)) return false;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
    return !value.split(/[\\/]+/u).some((part) => part === "" || part === "..");
  },
  "path must be project-relative and portable",
);
const BatchCommandCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["passed", "failed"]),
  attempts: z.number().int().positive(),
  exitCode: z.number().int().nullable(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  nextRetryAt: z.string().datetime().optional(),
  retryDelaySeconds: z.number().int().nonnegative().optional(),
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  attemptExhausted: z.boolean().optional(),
  providerStatusCode: z.number().int().positive().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  errorSummary: z.string().max(1000).optional(),
});
const BatchBuildStatusSchema = z.object({
  status: z.enum(["pending", "running", "succeeded", "failed", "stale"]),
  checkedAt: z.string().datetime().optional(),
  stage: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  artifactIds: z.array(z.string().min(1)).default([]),
  evidenceLocator: BatchProjectRelativeLocatorSchema.optional(),
  producerRunId: z.string().min(1).optional(),
  bookId: z.string().min(1).optional(),
  sourceHash: z.string().min(1).optional(),
  normalizedContentHash: z.string().min(1).optional(),
});
const QmdBuildManifestSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  kind: z.literal("qmd_build_manifest"),
  itemId: z.string().min(1),
  runId: z.string().min(1),
  bookId: z.string().min(1),
  sourceName: z.string().min(1),
  sourceRelativePath: BatchProjectRelativeLocatorSchema,
  sourceHash: z.string().min(1),
  normalizedPath: BatchProjectRelativeLocatorSchema,
  normalizedContentHash: z.string().min(1),
  qmdIndexLocator: BatchProjectRelativeLocatorSchema,
  qmdIndexHash: z.string().min(1),
  configLocator: BatchProjectRelativeLocatorSchema,
  configHash: z.string().min(1),
  commandCheckNames: z.array(z.string().min(1)).refine(
    (names) =>
      names.length === expectedQmdNativeCommandCheckCount ||
      names.length === expectedCommandCheckCount,
    "qmd build manifest must name qmd-native checks or the full legacy set",
  ),
  commandCheckFingerprint: z.string().min(1),
  producerRunId: z.string().min(1),
  createdAt: z.string().datetime(),
});
const BookStageSchema = z.enum([
  "ingest",
  "normalize",
  "graph_extract",
  "community_report",
  "embed",
  "query_ready",
]);
const BookJobSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  bookId: z.string().min(1),
  documentId: z.string().min(1),
  sourcePath: BatchProjectRelativeLocatorSchema,
  sourceHash: z.string().min(1),
  normalizedContentHash: z.string().min(1).optional(),
  normalizedPath: BatchProjectRelativeLocatorSchema.optional(),
  normalizationPolicyVersion: z.string().min(1).optional(),
  configFingerprint: z.string().min(1),
  promptFingerprint: z.string().min(1),
  modelFingerprint: z.string().min(1),
  stageFingerprints: z.record(z.string(), z.string().min(1)).optional(),
  providerFingerprint: z.string().min(1).optional(),
  currentStage: BookStageSchema.optional(),
  overallStatus: z.enum(["pending", "running", "partial", "succeeded", "failed"]),
  lastSuccessRunId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});
const BookJobCatalogSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  items: z.array(BookJobSchema),
});
const BookJobStageCheckpointSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  bookId: z.string().min(1),
  stage: BookStageSchema,
  status: z.enum(["pending", "running", "succeeded", "failed", "abandoned"]),
  attemptCount: z.number().int().nonnegative(),
  runId: z.string().min(1).optional(),
  startedAt: z.string().min(1).optional(),
  finishedAt: z.string().min(1).optional(),
  inputFingerprint: z.string().min(1),
  contentHash: z.string().min(1).optional(),
  stageFingerprint: z.string().min(1).optional(),
  providerFingerprint: z.string().min(1).optional(),
  artifactIds: z.array(z.string().min(1)),
  errorSummary: z.string().min(1).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});
const BookJobCheckpointListSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  items: z.array(BookJobStageCheckpointSchema),
});
const BookArtifactManifestSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  artifactId: z.string().min(1),
  bookId: z.string().min(1),
  stage: BookStageSchema,
  kind: z.string().min(1),
  path: BatchProjectRelativeLocatorSchema,
  contentHash: z.string().min(1),
  stageFingerprint: z.string().min(1).optional(),
  providerFingerprint: z.string().min(1).optional(),
  normalizationPolicyVersion: z.string().min(1).optional(),
  producerRunId: z.string().min(1),
  createdAt: z.string().min(1),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});
const BookArtifactManifestListSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  items: z.array(BookArtifactManifestSchema),
});
const GraphRagOutputProducerManifestSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  bookId: z.string().min(1),
  sourceHash: z.string().min(1),
  documentId: z.string().min(1),
  contentHash: z.string().min(1),
  stageFingerprints: z.record(z.string(), z.string().min(1)),
  providerFingerprint: z.string().min(1),
  outputDir: BatchProjectRelativeLocatorSchema,
  producerRunId: z.string().min(1),
  stageProducerRunIds: z.record(z.string(), z.string().min(1)),
});
const GraphRagOutputProducerManifestLegacySchema =
  GraphRagOutputProducerManifestSchema.omit({ outputDir: true }).extend({
    outputDir: z.string().min(1),
    stageProducerRunIds: z.record(z.string(), z.string().min(1)).optional(),
  });
const BatchItemCheckpointBaseSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  itemId: z.string().min(1),
  runId: z.string().min(1),
  status: BatchItemStatusSchema,
  sourceName: z.string().min(1),
  sourceRelativePath: BatchProjectRelativeLocatorSchema,
  sourceIdentityPath: BatchProjectRelativeLocatorSchema,
  sourceHash: z.string().min(1),
  normalizedPath: BatchProjectRelativeLocatorSchema,
  bookId: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  expectedCommandCheckCount: z.number().int().positive().optional(),
  maxCommandAttempts: z.number().int().positive().optional(),
  maxTransientCommandAttempts: z.number().int().positive().optional(),
  maxResumePasses: z.number().int().positive().optional(),
  retryBaseDelaySeconds: z.number().int().positive().optional(),
  retryMaxDelaySeconds: z.number().int().positive().optional(),
  retryBudgetSeconds: z.number().int().positive().optional(),
  maxProviderRecoveryWaits: z.number().int().positive().optional(),
  commandTimeoutSeconds: z.number().int().positive().optional(),
  retryStartedAt: z.string().datetime().optional(),
  runnerSessionId: z.string().min(1).optional(),
  runnerHost: z.string().min(1).optional(),
  runnerPid: z.number().int().positive().optional(),
  runnerHeartbeatAt: z.string().datetime().optional(),
  orphanedRunnerDetectedAt: z.string().datetime().optional(),
  currentCommand: z.string().min(1).optional(),
  activeCommand: z.string().min(1).optional(),
  currentCommandStartedAt: z.string().datetime().optional(),
  nextRetryAt: z.string().datetime().optional(),
  retryDelaySeconds: z.number().int().nonnegative().optional(),
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryExhausted: z.boolean().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  failedStage: z.string().min(1).optional(),
  qmdBuildStatus: BatchBuildStatusSchema.optional(),
  graphBuildStatus: BatchBuildStatusSchema.optional(),
  graphQueryStatus: BatchBuildStatusSchema.optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  failedAt: z.string().datetime().optional(),
  errorSummary: z.string().max(1000).optional(),
  commandChecks: z.array(BatchCommandCheckSchema).default([]),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});
const BatchItemCheckpointInputSchema = BatchItemCheckpointBaseSchema;
const BatchItemCheckpointSchema = BatchItemCheckpointBaseSchema.extend({
  qmdBuildStatus: BatchBuildStatusSchema,
  graphBuildStatus: BatchBuildStatusSchema,
  graphQueryStatus: BatchBuildStatusSchema,
}).superRefine((value, ctx) => {
  if (value.status === "running") {
    for (const field of [
      "runnerSessionId",
      "runnerHost",
      "runnerPid",
      "runnerHeartbeatAt",
    ]) {
      if (value[field] == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `running checkpoint requires ${field}`,
          path: [field],
        });
      }
    }
  }
  if (value.retryExhausted === true && value.failureKind !== "transient" && (
    value.retryable !== false ||
    value.recoveryDecision !== "stop_until_fixed"
  )) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "non-transient retryExhausted checkpoint requires retryable=false " +
        "and recoveryDecision=stop_until_fixed",
      path: ["retryExhausted"],
    });
  }
});
const BatchRunManifestSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  status: BatchRunStatusSchema,
  sourceRootName: z.string().min(1),
  stateRootLocator: BatchProjectRelativeLocatorSchema,
  qmdIndexLocator: BatchProjectRelativeLocatorSchema,
  configLocator: BatchProjectRelativeLocatorSchema,
  totalItems: z.number().int().nonnegative(),
  pendingItems: z.number().int().nonnegative().default(0),
  runningItems: z.number().int().nonnegative().default(0),
  completedItems: z.number().int().nonnegative(),
  skippedItems: z.number().int().nonnegative().default(0),
  importedCompletedItems: z.number().int().nonnegative().default(0),
  failedItems: z.number().int().nonnegative(),
  expectedCommandCheckCount: z.number().int().positive().optional(),
  maxCommandAttempts: z.number().int().positive().optional(),
  maxTransientCommandAttempts: z.number().int().positive().optional(),
  maxResumePasses: z.number().int().positive().optional(),
  retryBaseDelaySeconds: z.number().int().positive().optional(),
  retryMaxDelaySeconds: z.number().int().positive().optional(),
  retryBudgetSeconds: z.number().int().positive().optional(),
  maxProviderRecoveryWaits: z.number().int().positive().optional(),
  commandTimeoutSeconds: z.number().int().positive().optional(),
  heartbeatIntervalSeconds: z.number().int().positive().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  failedAt: z.string().datetime().optional(),
  itemIds: z.array(z.string().min(1)),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});
const BatchEventLogSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  itemId: z.string().min(1).optional(),
  event: z.string().min(1),
  status: BatchItemStatusSchema.optional(),
  command: z.string().min(1).optional(),
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  attemptExhausted: z.boolean().optional(),
  providerStatusCode: z.number().int().positive().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  failedStage: z.string().min(1).optional(),
  at: z.string().datetime(),
  message: z.string().max(1000).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});
const BatchRecoverySummaryItemSchema = z.object({
  itemId: z.string().min(1),
  sourceName: z.string().min(1),
  bookId: z.string().min(1),
  status: BatchItemStatusSchema,
  attempts: z.number().int().nonnegative(),
  qmdBuildStatus: BatchBuildStatusSchema,
  commandCheckStatus: BatchBuildStatusSchema.optional(),
  graphBuildStatus: BatchBuildStatusSchema,
  graphQueryStatus: BatchBuildStatusSchema,
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryExhausted: z.boolean().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  failedStage: z.string().min(1).optional(),
  providerStatusCode: z.number().int().positive().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  nextRetryAt: z.string().datetime().optional(),
  retryDelaySeconds: z.number().int().nonnegative().optional(),
  retryBudgetSeconds: z.number().int().positive().optional(),
  providerRecoveryWaitCount: z.number().int().nonnegative().optional(),
  maxProviderRecoveryWaits: z.number().int().positive().optional(),
  providerRecoveryReason: z.string().min(1).optional(),
  runnerSessionId: z.string().min(1).optional(),
  runnerHost: z.string().min(1).optional(),
  runnerPid: z.number().int().positive().optional(),
  runnerHeartbeatAt: z.string().datetime().optional(),
  orphanedRunnerDetectedAt: z.string().datetime().optional(),
  currentCommand: z.string().min(1).optional(),
  activeCommand: z.string().min(1).optional(),
  currentCommandStartedAt: z.string().datetime().optional(),
  waitingForProviderRecovery: z.boolean().optional(),
  reopenedFromStatus: BatchItemStatusSchema.optional(),
  reopenedToStatus: BatchItemStatusSchema.optional(),
  reopenedFromRecoveryDecision: BatchRecoveryDecisionSchema.optional(),
  repairReason: z.string().min(1).optional(),
  repairFailureText: z.string().max(1000).optional(),
  repairedProjection: JsonValueSchema.optional(),
  repairEvidenceLocator: z.string().min(1).optional(),
  reusedProducerRunIds: z.record(z.string(), z.string().min(1)).optional(),
  normalCommandChecksRequired: z.boolean().optional(),
  settingsProjectionDecision: z.enum([
    "already_valid",
    "rewritten",
    "rejected_user_owned",
    "rejected_invalid_source",
  ]).optional(),
  settingsProjectionRewritten: z.boolean().optional(),
  settingsProjectionSourceFingerprint: z.string().min(1).optional(),
  settingsProjectionProjectConfigLocator: z.string().min(1).optional(),
  settingsProjectionLocator: z.string().min(1).optional(),
  settingsProjectionEvidenceLocator: z.string().min(1).optional(),
  settingsProjectionReason: z.string().min(1).optional(),
  localArtifactGateRepairRequiresRealRebuild: z.boolean().optional(),
  localArtifactGateRepairRebuildStage: z.string().min(1).optional(),
  providerAuthReopenDecision: z.string().min(1).optional(),
  providerAuthReopenEligible: z.boolean().optional(),
  providerAuthReopenReason: z.string().min(1).optional(),
  providerAuthReopenBlockedReason: z.string().min(1).optional(),
  providerAuthConfigChanged: z.boolean().optional(),
  providerAuthFailureFingerprint: z.string().min(1).optional(),
  currentProviderAuthFingerprint: z.string().min(1).optional(),
  lastProviderAuthReopenFingerprint: z.string().min(1).optional(),
  providerAuthConfigReadStatus: z.string().min(1).optional(),
  providerAuthConfigReadError: z.string().min(1).optional(),
  providerAuthRequiredKeys: z.array(z.string().min(1)).optional(),
  providerAuthRequiredEndpoints: z.array(z.string().min(1)).optional(),
  providerAuthRequiredNames: z.array(z.string().min(1)).optional(),
  providerAuthKeyPresence: z.record(z.string(), z.string().min(1)).optional(),
  providerAuthCredentialSources: z.record(z.string(), z.string().min(1)).optional(),
  providerAuthReadinessStatus: z.string().min(1).optional(),
  providerAuthMissingRequiredKeys: z.array(z.string().min(1)).optional(),
  providerAuthShadowedEnvNames: z.array(z.string().min(1)).optional(),
  providerAuthDotenvShadowedEnvNames: z.array(z.string().min(1)).optional(),
  providerAuthRootDotenvFingerprints:
    z.record(z.string(), z.string().min(1)).optional(),
  providerAuthGraphVaultDotenvFingerprints:
    z.record(z.string(), z.string().min(1)).optional(),
  providerAuthRootDotenvPresent: z.boolean().optional(),
  providerAuthGraphVaultDotenvPresent: z.boolean().optional(),
  providerAuthReopenAttemptCount: z.number().int().nonnegative().optional(),
  legacyProviderAuthFingerprintMissing: z.boolean().optional(),
  errorSummary: z.string().max(1000).optional(),
});
const BatchRecoverySummarySchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  generatedAt: z.string().datetime(),
  manifest: z.object({
    status: BatchRunStatusSchema,
    totalItems: z.number().int().nonnegative(),
    pendingItems: z.number().int().nonnegative(),
    runningItems: z.number().int().nonnegative(),
    completedItems: z.number().int().nonnegative(),
    skippedItems: z.number().int().nonnegative(),
    failedItems: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    failedAt: z.string().datetime().optional(),
  }),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  retryPolicy: z.object({
    maxCommandAttempts: z.number().int().positive(),
    maxTransientCommandAttempts: z.number().int().positive(),
    maxResumePasses: z.number().int().positive(),
    retryBaseDelaySeconds: z.number().int().positive(),
    retryMaxDelaySeconds: z.number().int().positive(),
    retryBudgetSeconds: z.number().int().positive(),
    maxProviderRecoveryWaits: z.number().int().positive(),
    commandTimeoutSeconds: z.number().int().positive(),
    heartbeatIntervalSeconds: z.number().int().positive().optional(),
  }),
  recoveryDecision: BatchRecoveryDecisionSchema,
  retryableItemCount: z.number().int().nonnegative(),
  nextRetryAt: z.string().datetime().optional(),
  items: z.array(BatchRecoverySummaryItemSchema),
});

function now() {
  return new Date().toISOString();
}

function epochMs(iso) {
  const value = Date.parse(String(iso ?? ""));
  return Number.isFinite(value) ? value : 0;
}

function isoAfterSeconds(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function jitteredDelaySeconds(seconds, attempt) {
  if (seconds <= 1) return seconds;
  const stableSeed = sha256Text(`${runId}:${attempt}:${Date.now()}`);
  const value = Number.parseInt(stableSeed.slice(0, 8), 16) / 0xffffffff;
  const jitterWindow = Math.max(1, Math.floor(Math.min(seconds * 0.2, 30)));
  return Math.min(retryMaxDelaySeconds, seconds + Math.floor(value * jitterWindow));
}

function withoutUndefined(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => withoutUndefined(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)]),
    );
  }
  return value;
}

function retryDelaySecondsForAttempt(attempt) {
  const exponential = retryBaseDelaySeconds * 2 ** Math.max(0, attempt - 1);
  return jitteredDelaySeconds(Math.min(retryMaxDelaySeconds, exponential), attempt);
}

function elapsedRetrySeconds(checkpoint) {
  const start = epochMs(checkpoint.retryStartedAt);
  if (start === 0) return 0;
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

function transientBudgetAvailable(checkpoint) {
  return elapsedRetrySeconds(checkpoint) < retryBudgetSeconds;
}

function retryBudgetExhausted(checkpoint) {
  return !transientBudgetAvailable(checkpoint);
}

function providerRecoveryWaitCount(checkpoint) {
  return Math.min(
    maxProviderRecoveryWaits,
    Number(checkpoint?.metadata?.providerRecoveryWaitCount ?? 0),
  );
}

function providerRecoveryWaitAvailable(checkpoint) {
  return providerRecoveryWaitCount(checkpoint) < maxProviderRecoveryWaits;
}

function nextProviderRecoveryWaitCount(checkpoint) {
  return Math.min(
    maxProviderRecoveryWaits,
    providerRecoveryWaitCount(checkpoint) + 1,
  );
}

function providerRecoveryReasonFromFailureText(text) {
  const message = String(text ?? "").toLowerCase();
  if (message.includes("kind=responses_output_none")) {
    return "responses_output_none";
  }
  return undefined;
}

function checkpointFailureText(checkpoint) {
  return [...new Set([
    checkpoint?.errorSummary,
    checkpoint?.metadata?.providerRecoveryEvidenceSummary,
    ...(checkpoint?.commandChecks ?? [])
      .filter((check) => check.status === "failed")
      .map((check) => check.errorSummary),
  ].filter(Boolean))].join("\n");
}

function isLegacyResponsesOutputNoneSummary(text) {
  const message = String(text ?? "").toLowerCase();
  return message.includes("graphrag index workflow failed") &&
    message.includes("\"workflow\":\"extract_graph\"") &&
    message.includes("'nonetype' object is not iterable");
}

function hasLegacyResponsesOutputNoneAdapterEvidence(text) {
  const message = String(text ?? "").toLowerCase();
  return message.includes("typeerror: 'nonetype' object is not iterable") &&
    message.includes("_completed_response_output_text") &&
    (
      message.includes("response.output_text") ||
      message.includes("getattr(response, \"output_text\"")
    ) &&
    message.includes("graphrag_responses_completion.py");
}

function legacyResponsesOutputNoneLogPath(item, checkpoint) {
  const summaryStage = isLegacyResponsesOutputNoneSummary(
    checkpointFailureText(checkpoint),
  )
    ? "graph_extract"
    : undefined;
  const graphStatus = checkpoint?.graphBuildStatus;
  const stage = summaryStage ?? (
    graphStatus?.stage === "graph_extract" ||
    graphStatus?.reason === "real_graphrag_stage_failed:graph_extract"
    ? "graph_extract"
    : checkpoint?.metadata?.graphWorkflow === "extract_graph"
      ? "graph_extract"
      : undefined
  );
  if (stage !== "graph_extract") return null;
  const bookId = checkpoint?.bookId ?? item?.bookId;
  if (!bookId) return null;
  return join(logRoot, "graphrag-reports", bookId, stage, "indexing-engine.log");
}

function legacyResponsesOutputNoneEvidence(item, checkpoint) {
  const failureText = checkpointFailureText(checkpoint);
  if (!isLegacyResponsesOutputNoneSummary(failureText)) return null;
  const logPath = legacyResponsesOutputNoneLogPath(item, checkpoint);
  if (!logPath || !existsSync(logPath)) return null;
  let logText = "";
  try {
    logText = readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  if (!hasLegacyResponsesOutputNoneAdapterEvidence(logText)) return null;
  return {
    evidenceText:
      "Responses API transient error kind=responses_output_none " +
      "status_code=unknown: completed response output was null",
    evidenceLocator: relative(root, logPath),
  };
}

function recoverLegacyResponsesOutputNoneCheckpoint(item, checkpoint) {
  if (
    checkpoint?.status !== "failed" ||
    checkpoint.failureKind !== "unknown" ||
    checkpoint.retryable !== false ||
    checkpoint.recoveryDecision !== "stop_until_fixed"
  ) {
    return checkpoint;
  }
  const evidence = legacyResponsesOutputNoneEvidence(item, checkpoint);
  if (evidence == null) return checkpoint;
  const commandChecks = (checkpoint.commandChecks ?? []).map((check) =>
    check.status === "failed"
      ? {
          ...check,
          errorSummary: [
            check.errorSummary,
            evidence.evidenceText,
          ].filter(Boolean).join("\n"),
          failureKind: "transient",
          retryable: true,
          attemptExhausted: false,
          recoveryDecision: "retry_same_run_id",
        }
      : check
  );
  return {
    ...checkpoint,
    errorSummary: [
      checkpoint.errorSummary,
      evidence.evidenceText,
    ].filter(Boolean).join("\n"),
    failureKind: "transient",
    retryable: true,
    retryExhausted: false,
    recoveryDecision: "retry_same_run_id",
    commandChecks,
    metadata: {
      ...(checkpoint.metadata ?? {}),
      reclassifiedByCurrentFailureClassifier: true,
      originalFailureKind: checkpoint.failureKind,
      originalRecoveryDecision: checkpoint.recoveryDecision,
      providerRecoveryReason: "responses_output_none",
      providerFailureCode: "responses_output_none",
      providerRecoveryEvidenceLocator: evidence.evidenceLocator,
      providerRecoveryEvidenceSummary: evidence.evidenceText,
    },
  };
}

function checkpointHasLocalArtifactGateFailure(checkpoint) {
  return isLocalArtifactGateFailureText(checkpointFailureText(checkpoint));
}

function checkpointHasProviderStatusCode(checkpoint) {
  if (Number.isInteger(checkpoint?.providerStatusCode)) return true;
  return (checkpoint?.commandChecks ?? []).some((check) =>
    check.status === "failed" && Number.isInteger(check.providerStatusCode)
  );
}

function checkpointProviderStatusCodes(checkpoint) {
  return [...new Set([
    Number.isInteger(checkpoint?.providerStatusCode)
      ? checkpoint.providerStatusCode
      : null,
    ...(checkpoint?.commandChecks ?? [])
      .filter((check) => check.status === "failed")
      .map((check) => check.providerStatusCode)
      .filter(Number.isInteger),
  ].filter(Number.isInteger))];
}

function checkpointClassifiedFailure(checkpoint) {
  const failure = classifyFailure(checkpointFailureText(checkpoint));
  if (failure.failureKind !== "unknown") return failure;
  return {
    failureKind: checkpoint?.failureKind ?? "unknown",
    retryable: checkpoint?.retryable ?? false,
  };
}

function canRepairLocalArtifactGate(checkpoint) {
  if (
    checkpoint?.status !== "failed" ||
    checkpoint.retryable !== false ||
    checkpoint.recoveryDecision !== "stop_until_fixed"
  ) {
    return false;
  }
  if (checkpoint.metadata?.localArtifactGateRepairRequiresRealRebuild === true) {
    return false;
  }
  if (!checkpointHasLocalArtifactGateFailure(checkpoint)) return false;
  const failure = checkpointClassifiedFailure(checkpoint);
  if (failure.providerStatusCode != null || checkpointHasProviderStatusCode(checkpoint)) {
    return false;
  }
  if (
    failure.failureKind === "transient" ||
    failure.failureKind === "data_compatibility"
  ) {
    return false;
  }
  return checkpoint.failureKind !== "transient" &&
    checkpoint.failureKind !== "data_compatibility";
}

function checkpointHasDataCompatibilityFailure(checkpoint) {
  return checkpoint?.failureKind === "data_compatibility" ||
    checkpointClassifiedFailure(checkpoint).failureKind === "data_compatibility";
}

function checkpointHasUnrecoverableProviderAuthFailure(checkpoint) {
  if (checkpointProviderStatusCodes(checkpoint).some((code) =>
    code === 401 || code === 403
  )) {
    return true;
  }
  const failureText = checkpointFailureText(checkpoint).toLowerCase();
  return [
    "invalid api key",
    "invalid_api_key",
    "unauthorized",
    "forbidden",
    "authentication",
  ].some((token) => failureText.includes(token));
}

function envValueFingerprint(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return sha256Text(value).slice(0, 12);
}

function providerAuthConfig() {
  let config = {};
  let configReadStatus = "loaded";
  let configReadError;
  try {
    config = loadProjectConfigForSettingsProjection();
    validateSettingsProjectionSourceConfig(config);
  } catch (error) {
    config = {};
    configReadStatus = "invalid";
    configReadError = error instanceof Error ? error.message : String(error);
  }
  const openai = config?.providers?.openai ?? {};
  const jina = config?.providers?.jina ?? {};
  const openaiBaseUrlEnv = openai.base_url_env ?? "OPENAI_BASE_URL";
  const requiredEndpointNames = [openaiBaseUrlEnv];
  return {
    providerConfigFingerprint: deterministicHash({
      providers: config?.providers ?? {},
      models: config?.models ?? {},
      graphrag: config?.graphrag ?? {},
      query: config?.query ?? {},
      configReadStatus,
    }).slice(0, 24),
    configReadStatus,
    configReadError,
    requiredKeyNames: [...new Set([
      openai.api_key_env ?? "OPENAI_API_KEY",
      jina.api_key_env ?? "JINA_API_KEY",
    ])].sort(),
    requiredEndpointNames: [...new Set(requiredEndpointNames)].sort(),
    observedEnvNames: [...new Set([
      openai.api_key_env ?? "OPENAI_API_KEY",
      openaiBaseUrlEnv,
      jina.api_key_env ?? "JINA_API_KEY",
      jina.base_url_env ?? "JINA_API_BASE",
    ])].sort(),
  };
}

function providerAuthSourceForKey(key, value, rootEnv, vaultEnv) {
  const rootValue = rootEnv[key];
  const vaultValue = vaultEnv[key];
  const rootHasValue = typeof rootValue === "string" && rootValue.trim() !== "";
  const vaultHasValue = typeof vaultValue === "string" && vaultValue.trim() !== "";
  const hasValue = typeof value === "string" && value.trim() !== "";
  const processHadInitialValue = initialEnvNames.has(key);
  if (!hasValue) {
    if (rootHasValue || vaultHasValue) return "dotenv_not_loaded";
    return "missing";
  }
  const matchesRoot = rootHasValue && value === rootValue;
  const matchesVault = vaultHasValue && value === vaultValue;
  if (processHadInitialValue && vaultHasValue && !matchesVault) {
    return "process_env_shadows_dotenv";
  }
  if (processHadInitialValue && vaultHasValue && matchesVault) {
    return "process_env_matches_graph_vault_dotenv";
  }
  if (processHadInitialValue && rootHasValue && !matchesRoot) {
    return "process_env_shadows_dotenv";
  }
  if (processHadInitialValue && rootHasValue && matchesRoot) {
    return "process_env_matches_project_dotenv";
  }
  if (processHadInitialValue) return "process_env";
  if (matchesRoot && matchesVault) return "project_and_graph_vault_dotenv";
  if (matchesVault && rootHasValue) return "graph_vault_dotenv_shadows_project_dotenv";
  if (matchesVault) return "graph_vault_dotenv";
  if (matchesRoot) return "project_dotenv";
  if (rootHasValue || vaultHasValue) return "process_env_shadows_dotenv";
  return "process_env";
}

function providerAuthContext() {
  const rootEnv = parseDotenvFile(projectDotenvPath);
  const vaultEnv = parseDotenvFile(join(stateRoot, ".env"));
  const config = providerAuthConfig();
  const envFingerprints = {};
  const keyPresence = {};
  const credentialSources = {};
  const shadowedEnvNames = [];
  const dotenvShadowedEnvNames = [];
  const rootDotenvFingerprints = {};
  const graphVaultDotenvFingerprints = {};
  for (const key of config.observedEnvNames) {
    const value = process.env[key];
    const rootFingerprint = envValueFingerprint(rootEnv[key]);
    const vaultFingerprint = envValueFingerprint(vaultEnv[key]);
    if (rootFingerprint != null) rootDotenvFingerprints[key] = rootFingerprint;
    if (vaultFingerprint != null) graphVaultDotenvFingerprints[key] = vaultFingerprint;
    const fingerprint = envValueFingerprint(value);
    const present = fingerprint != null;
    envFingerprints[key] = present ? fingerprint : "missing";
    keyPresence[key] = present ? "present" : "missing";
    const source = providerAuthSourceForKey(key, value, rootEnv, vaultEnv);
    credentialSources[key] = source;
    if (source === "process_env_shadows_dotenv") shadowedEnvNames.push(key);
    if (source === "graph_vault_dotenv_shadows_project_dotenv") {
      dotenvShadowedEnvNames.push(key);
    }
  }
  const requiredNames = [
    ...new Set([
      ...config.requiredKeyNames,
      ...config.requiredEndpointNames,
    ]),
  ].sort();
  const missingRequiredNames = requiredNames
    .filter((key) => keyPresence[key] !== "present");
  const readinessStatus = config.configReadStatus !== "loaded"
    ? "provider_auth_config_unreadable"
    : missingRequiredNames.length > 0
    ? "missing_required_keys"
    : shadowedEnvNames.length > 0
      ? "process_env_shadows_dotenv"
      : "ready";
  return withoutUndefined({
    readinessStatus,
    ready: readinessStatus === "ready",
    currentProviderAuthFingerprint: deterministicHash({
      providerConfigFingerprint: config.providerConfigFingerprint,
      envFingerprints,
    }).slice(0, 24),
    providerConfigFingerprint: config.providerConfigFingerprint,
    providerAuthConfigReadStatus: config.configReadStatus,
    providerAuthConfigReadError: config.configReadError
      ? redacted(config.configReadError)
      : undefined,
    requiredKeyNames: config.requiredKeyNames,
    requiredEndpointNames: config.requiredEndpointNames,
    requiredNames,
    observedEnvNames: config.observedEnvNames,
    keyPresence,
    credentialSources,
    missingRequiredKeys: missingRequiredNames,
    shadowedEnvNames,
    dotenvShadowedEnvNames,
    rootDotenvFingerprints,
    graphVaultDotenvFingerprints,
    configLocator: relative(root, configPath),
    rootDotenvPresent: existsSync(projectDotenvPath),
    graphVaultDotenvPresent: existsSync(join(stateRoot, ".env")),
  });
}

function providerAuthMetadataFromContext(context) {
  return withoutUndefined({
    currentProviderAuthFingerprint: context.currentProviderAuthFingerprint,
    providerAuthConfigFingerprint: context.providerConfigFingerprint,
    providerAuthConfigReadStatus: context.providerAuthConfigReadStatus,
    providerAuthConfigReadError: context.providerAuthConfigReadError,
    providerAuthRequiredKeys: context.requiredKeyNames,
    providerAuthRequiredEndpoints: context.requiredEndpointNames,
    providerAuthRequiredNames: context.requiredNames,
    providerAuthKeyPresence: context.keyPresence,
    providerAuthCredentialSources: context.credentialSources,
    providerAuthReadinessStatus: context.readinessStatus,
    providerAuthMissingRequiredKeys: context.missingRequiredKeys,
    providerAuthShadowedEnvNames: context.shadowedEnvNames,
    providerAuthDotenvShadowedEnvNames: context.dotenvShadowedEnvNames,
    providerAuthRootDotenvFingerprints: context.rootDotenvFingerprints,
    providerAuthGraphVaultDotenvFingerprints: context.graphVaultDotenvFingerprints,
    providerAuthRootDotenvPresent: context.rootDotenvPresent,
    providerAuthGraphVaultDotenvPresent: context.graphVaultDotenvPresent,
    providerAuthConfigLocator: context.configLocator,
  });
}

function providerAuthStatusCode(checkpoint) {
  return checkpointProviderStatusCodes(checkpoint)
    .find((code) => code === 401 || code === 403) ??
    checkpointProviderStatusCodes(checkpoint)[0];
}

function providerAuthReopenFingerprints(checkpoint) {
  const values = checkpoint?.metadata?.providerAuthReopenedFingerprints;
  return Array.isArray(values)
    ? values.filter((value) => typeof value === "string" && value.length > 0)
    : [];
}

function providerAuthReopenAttemptCount(checkpoint) {
  return Math.max(
    providerAuthReopenFingerprints(checkpoint).length,
    Number(checkpoint?.metadata?.providerAuthReopenAttemptCount ?? 0) || 0,
  );
}

function providerAuthFailureFingerprint(checkpoint) {
  const metadata = checkpoint?.metadata ?? {};
  for (const key of [
    "providerAuthFailureFingerprint",
    "lastProviderAuthFailureFingerprint",
    "failureProviderFingerprint",
  ]) {
    if (typeof metadata[key] === "string" && metadata[key].length > 0) {
      return metadata[key];
    }
  }
  return undefined;
}

function providerAuthReopenDecision(checkpoint, context = providerAuthContext()) {
  const candidate = checkpoint?.status === "failed" &&
    checkpoint.retryable === false &&
    checkpoint.recoveryDecision === "stop_until_fixed" &&
    checkpointHasUnrecoverableProviderAuthFailure(checkpoint);
  if (!candidate) return { candidate: false, reopen: false };
  const failureFingerprint = providerAuthFailureFingerprint(checkpoint);
  const currentFingerprint = context.currentProviderAuthFingerprint;
  const reopenedFingerprints = providerAuthReopenFingerprints(checkpoint);
  const attemptCount = providerAuthReopenAttemptCount(checkpoint);
  const configChanged = failureFingerprint == null
    ? undefined
    : failureFingerprint !== currentFingerprint;
  const base = {
    candidate: true,
    context,
    failureFingerprint,
    currentFingerprint,
    configChanged,
    providerStatusCode: providerAuthStatusCode(checkpoint),
    attemptCount,
    legacyProviderAuthFingerprintMissing: failureFingerprint == null,
  };
  if (!context.ready) {
    return {
      ...base,
      reopen: false,
      decision: "blocked_provider_auth_not_ready",
      reason: context.readinessStatus,
    };
  }
  if (currentFingerprint == null) {
    return {
      ...base,
      reopen: false,
      decision: "blocked_current_provider_auth_fingerprint_missing",
      reason: "current_provider_auth_fingerprint_missing",
    };
  }
  if (attemptCount >= maxProviderAuthReopenAttempts) {
    return {
      ...base,
      reopen: false,
      decision: "blocked_provider_auth_reopen_attempt_limit",
      reason: "provider_auth_reopen_attempt_limit",
    };
  }
  if (failureFingerprint != null && failureFingerprint === currentFingerprint) {
    return {
      ...base,
      reopen: false,
      decision: "blocked_provider_auth_fingerprint_unchanged",
      reason: "current_provider_auth_fingerprint_matches_failure",
    };
  }
  if (reopenedFingerprints.includes(currentFingerprint)) {
    return {
      ...base,
      reopen: false,
      decision: "blocked_provider_auth_fingerprint_already_reopened",
      reason: "current_provider_auth_fingerprint_already_reopened",
    };
  }
  return {
    ...base,
    reopen: true,
    decision: failureFingerprint == null
      ? "reopen_legacy_provider_auth_key_present"
      : "reopen_provider_auth_config_changed",
    reason: failureFingerprint == null
      ? "legacy_provider_auth_failure_key_present"
      : "provider_auth_config_changed_key_present",
  };
}

function providerAuthSummaryProjection(checkpoint) {
  const metadata = checkpoint?.metadata ?? {};
  const hasProviderAuthHistory =
    metadata.providerAuthReopenDecision != null ||
    metadata.providerAuthFailureDetected === true ||
    metadata.providerAuthFailureFingerprint != null ||
    metadata.lastProviderAuthReopenFingerprint != null ||
    metadata.providerAuthReopenedAt != null;
  if (!hasProviderAuthHistory && !checkpointHasUnrecoverableProviderAuthFailure(checkpoint)) {
    return {};
  }
  const decision = providerAuthReopenDecision(checkpoint);
  if (!decision.candidate) {
    return withoutUndefined({
      providerAuthFailureFingerprint: metadata.providerAuthFailureFingerprint,
      lastProviderAuthReopenFingerprint: metadata.lastProviderAuthReopenFingerprint,
      providerAuthReopenAttemptCount:
        providerAuthReopenAttemptCount(checkpoint),
      legacyProviderAuthFingerprintMissing:
        metadata.legacyProviderAuthFingerprintMissing,
    });
  }
  return withoutUndefined({
    providerAuthReopenDecision: decision.decision,
    providerAuthReopenEligible: decision.reopen,
    providerAuthReopenReason: decision.reopen ? decision.reason : undefined,
    providerAuthReopenBlockedReason: decision.reopen ? undefined : decision.reason,
    providerAuthConfigChanged: decision.configChanged,
    providerAuthFailureFingerprint: decision.failureFingerprint,
    currentProviderAuthFingerprint: decision.currentFingerprint,
    lastProviderAuthReopenFingerprint: metadata.lastProviderAuthReopenFingerprint,
    providerAuthRequiredKeys: decision.context?.requiredKeyNames,
    providerAuthRequiredEndpoints: decision.context?.requiredEndpointNames,
    providerAuthRequiredNames: decision.context?.requiredNames,
    providerAuthKeyPresence: decision.context?.keyPresence,
    providerAuthCredentialSources: decision.context?.credentialSources,
    providerAuthReadinessStatus: decision.context?.readinessStatus,
    providerAuthConfigReadStatus: decision.context?.providerAuthConfigReadStatus,
    providerAuthConfigReadError: decision.context?.providerAuthConfigReadError,
    providerAuthMissingRequiredKeys: decision.context?.missingRequiredKeys,
    providerAuthShadowedEnvNames: decision.context?.shadowedEnvNames,
    providerAuthDotenvShadowedEnvNames: decision.context?.dotenvShadowedEnvNames,
    providerAuthRootDotenvFingerprints: decision.context?.rootDotenvFingerprints,
    providerAuthGraphVaultDotenvFingerprints:
      decision.context?.graphVaultDotenvFingerprints,
    providerAuthRootDotenvPresent: decision.context?.rootDotenvPresent,
    providerAuthGraphVaultDotenvPresent: decision.context?.graphVaultDotenvPresent,
    providerAuthReopenAttemptCount: decision.attemptCount,
    legacyProviderAuthFingerprintMissing:
      decision.legacyProviderAuthFingerprintMissing,
  });
}

function providerAuthFailureMetadata(commandCheck) {
  const providerAuthFailure =
    commandCheck?.providerStatusCode === 401 ||
    commandCheck?.providerStatusCode === 403 ||
    checkpointHasUnrecoverableProviderAuthFailure({
      ...commandCheck,
      status: "failed",
      commandChecks: commandCheck ? [commandCheck] : [],
      errorSummary: commandCheck?.errorSummary,
    });
  if (!providerAuthFailure) return {};
  const context = providerAuthContext();
  return {
    providerAuthFailureDetected: true,
    providerAuthFailureFingerprint: context.currentProviderAuthFingerprint,
    providerAuthFailureFingerprintSource: "current_runtime_provider_auth_context",
    providerAuthFailureProviderStatusCode: commandCheck?.providerStatusCode,
    providerAuthFailureStage: commandCheck?.name,
    providerAuthFailureRecordedAt: now(),
    providerAuthReopenDecision: "blocked_provider_auth_fingerprint_unchanged",
    providerAuthReopenEligible: false,
    providerAuthReopenReason: undefined,
    providerAuthReopenBlockedReason:
      "current_provider_auth_fingerprint_matches_failure",
    providerAuthConfigChanged: false,
    ...providerAuthMetadataFromContext(context),
  };
}

function reopenProviderAuthCheckpoint(item, checkpoint, decision) {
  const reopenedAt = now();
  const reopenedFingerprints = [
    ...new Set([
      ...providerAuthReopenFingerprints(checkpoint),
      decision.currentFingerprint,
    ].filter(Boolean)),
  ];
  const nextReopenAttemptCount = Math.max(
    providerAuthReopenAttemptCount(checkpoint) + 1,
    reopenedFingerprints.length,
  );
  const metadata = {
    ...(checkpoint.metadata ?? {}),
    providerAuthFailureFingerprint:
      checkpoint.metadata?.providerAuthFailureFingerprint ??
      decision.failureFingerprint,
    providerAuthReopenDecision: decision.decision,
    providerAuthReopenEligible: true,
    providerAuthReopenReason: decision.reason,
    providerAuthReopenBlockedReason: undefined,
    providerAuthConfigChanged: decision.configChanged ?? true,
    currentProviderAuthFingerprint: decision.currentFingerprint,
    lastProviderAuthReopenFingerprint: decision.currentFingerprint,
    providerAuthReopenedFingerprints: reopenedFingerprints,
    providerAuthReopenAttemptCount: nextReopenAttemptCount,
    providerAuthReopenedAt: reopenedAt,
    legacyProviderAuthFingerprintMissing:
      decision.legacyProviderAuthFingerprintMissing,
    originalFailureKind: checkpoint.failureKind,
    originalProviderStatusCode: decision.providerStatusCode,
    originalFailedStage: checkpoint.failedStage,
    reopenedFromStatus: checkpoint.status,
    reopenedToStatus: "pending",
    reopenedFromRecoveryDecision:
      checkpoint.recoveryDecision ?? "stop_until_fixed",
    normalCommandChecksRequired: true,
    waitingForProviderRecovery: false,
    ...providerAuthMetadataFromContext(decision.context),
  };
  event({
    itemId: item.itemId,
    event: "item_provider_auth_reopened",
    status: "pending",
    failureKind: checkpoint.failureKind ?? "permanent",
    retryable: false,
    recoveryDecision: "continue_pending",
    failedStage: checkpoint.failedStage,
    providerStatusCode: decision.providerStatusCode,
    message: checkpoint.errorSummary,
    metadata: {
      providerAuthReopenDecision: decision.decision,
      providerAuthReopenReason: decision.reason,
      reopenedFromStatus: checkpoint.status,
      reopenedToStatus: "pending",
      reopenedFromRecoveryDecision:
        checkpoint.recoveryDecision ?? "stop_until_fixed",
      providerAuthConfigChanged: decision.configChanged ?? true,
      providerAuthFailureFingerprint: decision.failureFingerprint,
      currentProviderAuthFingerprint: decision.currentFingerprint,
      providerAuthReopenAttemptCount: nextReopenAttemptCount,
      legacyProviderAuthFingerprintMissing:
        decision.legacyProviderAuthFingerprintMissing,
      ...providerAuthMetadataFromContext(decision.context),
    },
  });
  return {
    ...checkpoint,
    status: "pending",
    failedAt: undefined,
    errorSummary: undefined,
    failureKind: undefined,
    retryable: undefined,
    retryExhausted: undefined,
    recoveryDecision: "continue_pending",
    failedStage: undefined,
    activeCommand: checkpoint.activeCommand ?? checkpoint.currentCommand ??
      checkpoint.failedStage,
    currentCommand: undefined,
    currentCommandStartedAt: undefined,
    nextRetryAt: undefined,
    retryDelaySeconds: undefined,
    runnerSessionId: undefined,
    runnerHost: undefined,
    runnerPid: undefined,
    runnerHeartbeatAt: now(),
    commandChecks: [],
    metadata,
  };
}

function applyProviderAuthReopenPass(items, checkpoints) {
  let reopenedCount = 0;
  const context = providerAuthContext();
  for (const item of items) {
    const checkpoint = checkpoints.get(item.itemId);
    const decision = providerAuthReopenDecision(checkpoint, context);
    if (!decision.candidate) continue;
    if (!decision.reopen) {
      event({
        itemId: item.itemId,
        event: "item_provider_auth_reopen_blocked",
        status: "failed",
        failureKind: checkpoint.failureKind ?? "permanent",
        retryable: false,
        recoveryDecision: "stop_until_fixed",
        failedStage: checkpoint.failedStage,
        providerStatusCode: decision.providerStatusCode,
        message: checkpoint.errorSummary,
        metadata: {
          providerAuthReopenDecision: decision.decision,
          providerAuthReopenBlockedReason: decision.reason,
          providerAuthConfigChanged: decision.configChanged,
          providerAuthFailureFingerprint: decision.failureFingerprint,
          currentProviderAuthFingerprint: decision.currentFingerprint,
          providerAuthReopenAttemptCount: decision.attemptCount,
          legacyProviderAuthFingerprintMissing:
            decision.legacyProviderAuthFingerprintMissing,
          ...providerAuthMetadataFromContext(context),
        },
      });
      continue;
    }
    const reopened = lockedReadWriteTypedJson(
      itemPath(item),
      BatchItemCheckpointSchema,
      (loaded) => {
        const current = loaded ?? checkpoint;
        if (
          current.status !== checkpoint.status ||
          current.attempts !== checkpoint.attempts ||
          current.failedAt !== checkpoint.failedAt ||
          current.recoveryDecision !== checkpoint.recoveryDecision ||
          current.runnerSessionId !== checkpoint.runnerSessionId ||
          current.runnerHeartbeatAt !== checkpoint.runnerHeartbeatAt
        ) {
          throw new Error(
            `checkpoint changed before provider auth reopen; refusing duplicate runner for ${item.itemId}`,
          );
        }
        const currentDecision = providerAuthReopenDecision(current, context);
        if (!currentDecision.reopen) {
          throw new Error(
            `provider auth reopen became ineligible while locked for ${item.itemId}: ` +
            `${currentDecision.decision ?? "not_candidate"}`,
          );
        }
        const activeItem = runtimeItemForCheckpoint(item, current);
        return withBuildStatusSnapshot(
          activeItem,
          reopenProviderAuthCheckpoint(activeItem, current, currentDecision),
        );
      },
    );
    checkpoints.set(item.itemId, reopened);
    reopenedCount += 1;
  }
  return reopenedCount;
}

function parseRepairMetadata(metadata) {
  return RepairMetadataSchema.parse(withoutUndefined(metadata));
}

function deterministicHash(input) {
  const normalize = (value) => {
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "string"
    ) {
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (typeof value === "object" && value != null) {
      return Object.fromEntries(Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalize(entryValue)]));
    }
    return String(value);
  };
  return createHash("sha256")
    .update(JSON.stringify(normalize(input)))
    .digest("hex");
}

function projectConfigFingerprintFromYamlText(text) {
  const parsed = YAML.parse(text) ?? {};
  const config = parsed && typeof parsed === "object" ? parsed : {};
  return deterministicHash({
    models: config.models ?? {},
    providers: config.providers ?? {},
    embedding: config.embedding ?? {},
    graphrag: config.graphrag ?? {},
    query: config.query ?? {},
  });
}

function loadProjectConfigForSettingsProjection() {
  if (!existsSync(configPath)) return { collections: {} };
  const parsed = YAML.parse(readFileSync(configPath, "utf8")) ?? {};
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a YAML object`);
  }
  return parsed;
}

function settingsProjectionSourceFingerprintFromConfigText(configText) {
  try {
    return projectConfigFingerprintFromYamlText(configText);
  } catch {
    return deterministicHash({
      invalidSourceBytesSha256: createHash("sha256")
        .update(String(configText ?? ""))
        .digest("hex"),
    });
  }
}

function settingsProjectionSourceFingerprintFromConfig() {
  if (!existsSync(configPath)) {
    return deterministicHash({
      models: {},
      providers: {},
      embedding: {},
      graphrag: {},
      query: {},
    });
  }
  return settingsProjectionSourceFingerprintFromConfigText(
    readFileSync(configPath, "utf8"),
  );
}

function validateSettingsProjectionSourceConfig(config) {
  const responseApi = config?.providers?.openai?.response_api ?? {};
  if (
    responseApi.endpoint !== undefined &&
    responseApi.endpoint !== "/responses"
  ) {
    throw new Error("OpenAI Responses API endpoint must be /responses");
  }
  if (responseApi.stream !== undefined && responseApi.stream !== true) {
    throw new Error("OpenAI Responses API stream transport must be enabled");
  }
  if (
    responseApi.strict_structured_output !== undefined &&
    responseApi.strict_structured_output !== true
  ) {
    throw new Error("OpenAI Responses API structured output must be strict");
  }
  const profileName = config?.providers?.jina?.embedding_profile;
  if (
    profileName !== undefined &&
    profileName !== "text" &&
    profileName !== "multimodal"
  ) {
    throw new Error(
      "providers.jina.embedding_profile must be one of: text, multimodal",
    );
  }
  const concurrentRequests = config?.graphrag?.concurrent_requests;
  if (
    concurrentRequests !== undefined &&
    (!Number.isInteger(concurrentRequests) || concurrentRequests < 1)
  ) {
    throw new Error("graphrag.concurrent_requests must be a positive integer");
  }
}

function invalidSettingsProjectionSourceMetadata() {
  return withoutUndefined({
    settingsProjectionDecision: "rejected_invalid_source",
    settingsProjectionRewritten: false,
    settingsProjectionSourceFingerprint: settingsProjectionSourceFingerprintFromConfig(),
    settingsProjectionProjectConfigLocator: configPath,
    settingsProjectionLocator: resolve(stateRoot, "settings.yaml"),
    settingsProjectionEvidenceLocator: configPath,
    settingsProjectionReason: "settings_projection_rejected_invalid_source",
  });
}

function userOwnedSettingsProjectionMetadata() {
  return withoutUndefined({
    settingsProjectionDecision: "rejected_user_owned",
    settingsProjectionRewritten: false,
    settingsProjectionSourceFingerprint: settingsProjectionSourceFingerprintFromConfig(),
    settingsProjectionProjectConfigLocator: configPath,
    settingsProjectionLocator: resolve(stateRoot, "settings.yaml"),
    settingsProjectionEvidenceLocator: resolve(stateRoot, "settings.yaml"),
    settingsProjectionReason:
      "settings_projection_rejected_user_owned_or_invalid",
  });
}

function settingsProjectionSourceConfigIsInvalid() {
  try {
    validateSettingsProjectionSourceConfig(loadProjectConfigForSettingsProjection());
    return false;
  } catch {
    return true;
  }
}

function isSettingsProjectionCommand(name) {
  return String(name ?? "").startsWith("resume-book-") ||
    String(name ?? "").startsWith("repair-local-artifact-gate-");
}

function settingsProjectionMetadata(resume) {
  const repair = resume?.settingsProjectionRepair;
  if (repair == null || typeof repair !== "object") return {};
  return withoutUndefined({
    settingsProjectionDecision: repair.decision,
    settingsProjectionRewritten: repair.rewritten,
    settingsProjectionSourceFingerprint: repair.sourceFingerprint,
    settingsProjectionProjectConfigLocator: configPath,
    settingsProjectionLocator: repair.settingsPath,
    settingsProjectionEvidenceLocator: repair.evidenceLocator,
    settingsProjectionReason: repair.reason,
  });
}

function settingsProjectionRejectionMetadataFromText(text, commandName) {
  const message = String(text ?? "");
  const normalized = message.toLowerCase();
  if (
    isSettingsProjectionCommand(commandName) &&
    settingsProjectionSourceConfigIsInvalid()
  ) {
    return invalidSettingsProjectionSourceMetadata();
  }
  if (
    normalized.includes("responses api") ||
    normalized.includes("graphrag.concurrent_requests") ||
    normalized.includes("failed to parse") ||
    normalized.includes("providers.jina.embedding_profile")
  ) {
    return invalidSettingsProjectionSourceMetadata();
  }
  if (normalized.includes("managed projection")) {
    return userOwnedSettingsProjectionMetadata();
  }
  return {};
}

function rejectedSettingsProjectionMetadata(error) {
  const message = error instanceof Error ? error.message : String(error);
  return settingsProjectionRejectionMetadataFromText(
    message,
    error?.commandCheck?.name,
  );
}

function checkpointHasTransientFailure(checkpoint) {
  const failure = classifyFailure(checkpointFailureText(checkpoint));
  if (failure.failureKind !== "unknown") {
    return failure.failureKind === "transient" && failure.retryable === true;
  }
  if (checkpoint?.failureKind === "transient") return true;
  return failure.failureKind === "transient" && failure.retryable === true;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningCheckpointIsOrphaned(checkpoint) {
  if (checkpoint.status !== "running") return false;
  if (
    checkpoint.runnerSessionId == null ||
    checkpoint.runnerHost == null ||
    checkpoint.runnerPid == null ||
    checkpoint.runnerHeartbeatAt == null
  ) {
    return true;
  }
  const heartbeatAt = epochMs(checkpoint.runnerHeartbeatAt);
  if (heartbeatAt === 0) return true;
  const heartbeatAgeMs = Date.now() - heartbeatAt;
  if (heartbeatAgeMs > runnerHeartbeatTtlSeconds * 1000) return true;
  if (checkpoint.runnerHost === runnerHost) {
    if (checkpoint.runnerSessionId === runnerSessionId) return false;
    return !processAlive(checkpoint.runnerPid);
  }
  // Remote process liveness cannot be verified safely from this host. A fresh
  // remote heartbeat still owns the item; stale leases are recovered above.
  return false;
}

function activeRunningBookCheckpoint(item, checkpoints) {
  for (const checkpoint of checkpoints.values()) {
    if (
      checkpoint.itemId !== item.itemId &&
      checkpoint.bookId === item.bookId &&
      checkpoint.status === "running" &&
      !runningCheckpointIsOrphaned(checkpoint)
    ) {
      return checkpoint;
    }
  }
  return undefined;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function slugify(name) {
  return name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-")
    .slice(0, 72)
    .replace(/^-|-$/g, "") || "book";
}

const UrlCredentialKeyPattern =
  /^(?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|auth|sig|signature|secret|password|credential|client[_-]?secret)$/iu;

function redactUrlCredentials(message) {
  return String(message).replace(
    /\bhttps?:\/\/[^\s"'`),\]}]+/giu,
    (url) => url
      .replace(/\/\/[^/?#\s@]+@/u, "//[REDACTED]@")
      .replace(/([?&;])([^=#&;\s]+)=([^&#;\s]*)/gu, (match, sep, key) =>
        UrlCredentialKeyPattern.test(key)
          ? `${sep}${key}=[REDACTED]`
          : match
      ),
  );
}

function redacted(message) {
  return redactUrlCredentials(redactExactEnvValues(String(message)))
    .split(root).join("[PROJECT_ROOT]")
    .replace(
      /(?:\/Users|\/home|\/var|\/tmp|\/private|\/Volumes|\/mnt|\/opt|\/srv|\/data)\/[^\s"'`),\]}]+/g,
      "[ABS_PATH]",
    )
    .replace(/[A-Za-z]:\\[^\s"'`),\]}]+/g, "[ABS_PATH]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(OPENAI_API_KEY|JINA_API_KEY)=\S+/g, "$1=[REDACTED]")
    .replace(/(OPENAI_BASE_URL|JINA_API_BASE)=\S+/g, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
    .slice(0, 1000);
}

function redactLog(text) {
  return redactUrlCredentials(redactExactEnvValues(String(text)))
    .split(root).join("[PROJECT_ROOT]")
    .replace(
      /(?:\/Users|\/home|\/var|\/tmp|\/private|\/Volumes|\/mnt|\/opt|\/srv|\/data)\/[^\s"'`),\]}]+/g,
      "[ABS_PATH]",
    )
    .replace(/[A-Za-z]:\\[^\s"'`),\]}]+/g, "[ABS_PATH]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(OPENAI_API_KEY|JINA_API_KEY)=\S+/g, "$1=[REDACTED]")
    .replace(/(OPENAI_BASE_URL|JINA_API_BASE)=\S+/g, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]");
}

function redactExactEnvValues(text) {
  let output = String(text);
  const envSecrets = Object.keys(process.env)
    .filter((key) =>
      /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|BASE_URL|API_BASE)/iu.test(key),
    )
    .map((key) => ({ key, value: process.env[key] }))
    .filter((item) => item.value && item.value.length >= 4);
  const dotenvSecrets = Array.from(extraExactRedactions.entries())
    .map(([key, value]) => ({ key, value }))
    .filter((item) => item.value && item.value.length >= 4);
  const secrets = [...envSecrets, ...dotenvSecrets]
    .sort((a, b) => b.value.length - a.value.length);
  for (const { key, value } of secrets) {
    output = output.split(value).join(`[REDACTED:${key}]`);
  }
  return output;
}

function redactJsonValue(value) {
  if (typeof value === "string") return redacted(value);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item));
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [
          key,
          redactJsonValue(item),
        ]),
    );
  }
  return value;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureDirs() {
  if (statusJson) {
    requirePath(stateRoot, "state root");
    const relativeLogRoot = relative(stateRoot, logRoot);
    const isInsideStateRoot =
      relativeLogRoot === "" ||
      (!relativeLogRoot.startsWith(`..${sep}`) &&
        relativeLogRoot !== ".." &&
        !isAbsolute(relativeLogRoot));
    if (isInsideStateRoot) {
      throw new Error("--log-root must be outside graph_vault");
    }
    if (existsSync(logRoot)) {
      const realStateRoot = realpathSync(stateRoot);
      const realLogRoot = realpathSync(logRoot);
      const relativeRealLogRoot = relative(realStateRoot, realLogRoot);
      const isReallyInsideStateRoot =
        relativeRealLogRoot === "" ||
        (!relativeRealLogRoot.startsWith(`..${sep}`) &&
          relativeRealLogRoot !== ".." &&
          !isAbsolute(relativeRealLogRoot));
      if (isReallyInsideStateRoot) {
        throw new Error("--log-root must be outside graph_vault");
      }
    }
    return;
  }
  mkdirSync(stateRoot, { recursive: true });
  const relativeLogRoot = relative(stateRoot, logRoot);
  const isInsideStateRoot =
    relativeLogRoot === "" ||
    (!relativeLogRoot.startsWith(`..${sep}`) &&
      relativeLogRoot !== ".." &&
      !isAbsolute(relativeLogRoot));
  if (isInsideStateRoot) {
    throw new Error("--log-root must be outside graph_vault");
  }
  mkdirSync(logRoot, { recursive: true });
  const realStateRoot = realpathSync(stateRoot);
  const realLogRoot = realpathSync(logRoot);
  const relativeRealLogRoot = relative(realStateRoot, realLogRoot);
  const isReallyInsideStateRoot =
    relativeRealLogRoot === "" ||
    (!relativeRealLogRoot.startsWith(`..${sep}`) &&
      relativeRealLogRoot !== ".." &&
      !isAbsolute(relativeRealLogRoot));
  if (isReallyInsideStateRoot) {
    throw new Error("--log-root must be outside graph_vault");
  }
  mkdirSync(batchRoot, { recursive: true });
  mkdirSync(itemRoot, { recursive: true });
  mkdirSync(join(stateRoot, "input"), { recursive: true });
}

function parseDotenvText(text) {
  const parsed = {};
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const separator = body.indexOf("=");
    if (separator <= 0) continue;
    const key = body.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }
    let value = body.slice(separator + 1).trim();
    const quote = value[0];
    if (
      (quote === "\"" || quote === "'") &&
      value.endsWith(quote) &&
      value.length >= 2
    ) {
      value = value.slice(1, -1);
    } else {
      const commentIndex = value.search(/\s#/u);
      if (commentIndex >= 0) value = value.slice(0, commentIndex).trimEnd();
    }
    parsed[key] = value;
  }
  return parsed;
}

function parseDotenvFile(path) {
  if (!existsSync(path)) return {};
  const parsed = parseDotenvText(readFileSync(path, "utf8"));
  registerExactRedactionsForEnv(parsed);
  return parsed;
}

function registerExactRedactionsForEnv(parsed) {
  for (const [key, value] of Object.entries(parsed)) {
    if (
      value &&
      value.length >= 4 &&
      /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|BASE_URL|API_BASE)/iu
        .test(key)
    ) {
      extraExactRedactions.set(key, value);
    }
  }
}

function loadDotenv() {
  if (values["skip-dotenv"]) return;
  for (const dotenvPath of [projectDotenvPath, join(stateRoot, ".env")]) {
    const parsed = parseDotenvFile(dotenvPath);
    const authoritative = dotenvPath === join(stateRoot, ".env");
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] == null || (
        authoritative && !initialEnvNames.has(key)
      )) {
        process.env[key] = value;
      }
    }
  }
}

function event(payload) {
  const sanitizedPayload = {
    ...payload,
    message: payload?.message ? redacted(payload.message) : undefined,
    metadata: payload?.metadata == null
      ? undefined
      : redactJsonValue(payload.metadata),
  };
  const item = BatchEventLogSchema.parse({
    schemaVersion: SchemaVersion,
    runId,
    at: now(),
    ...withoutUndefined(sanitizedPayload),
  });
  if (statusJson) return item;
  writeFileSync(eventsPath, JSON.stringify(item) + "\n", {
    flag: "a",
    encoding: "utf8",
  });
  if (values.verbose && !statusJson) {
    const parts = [item.event, item.itemId, item.command, item.status]
      .filter(Boolean)
      .join(" ");
    process.stdout.write(`${parts}\n`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, text, "utf8");
  renameSync(temporaryPath, path);
}

function lockPathFor(path) {
  return `${path}.lock`;
}

function removeStaleJsonLock(path) {
  try {
    const lockPath = path;
    const entry = statSync(lockPath);
    if (Date.now() - entry.mtimeMs > jsonFileLockStaleMs) {
      unlinkSync(lockPath);
    }
  } catch {
    // Missing or concurrently removed locks are expected under contention.
  }
}

function withJsonFileLock(path, callback) {
  const lockPath = lockPathFor(path);
  for (;;) {
    let fd = null;
    try {
      mkdirSync(dirname(path), { recursive: true });
      fd = openSync(lockPath, "wx");
      return callback();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      removeStaleJsonLock(lockPath);
      sleep(25);
    } finally {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // Best-effort cleanup only; the stale lock sweeper handles leftovers.
        }
        try {
          unlinkSync(lockPath);
        } catch {
          // Another process may have already removed a stale lock.
        }
      }
    }
  }
}

function lockedReadWriteTypedJson(path, schema, callback) {
  if (statusJson) return callback(undefined);
  return withJsonFileLock(path, () => {
    const current = existsSync(path) ? schema.parse(readJson(path)) : undefined;
    const next = schema.parse(withoutUndefined(callback(current)));
    writeJsonAtomic(path, JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}

function writeTypedJson(path, schema, value) {
  const parsed = schema.parse(withoutUndefined(value));
  if (statusJson) return parsed;
  withJsonFileLock(path, () => {
    writeJsonAtomic(path, JSON.stringify(parsed, null, 2) + "\n");
  });
  return parsed;
}

function repairOnlyBlockedLoopObserved(itemId) {
  if (!existsSync(eventsPath)) return false;
  return readFileSync(eventsPath, "utf8")
    .split(/\r?\n/u)
    .some((line) => {
      if (!line.trim()) return false;
      try {
        const item = JSON.parse(line);
        return item.itemId === itemId &&
          item.event === "local_artifact_gate_repair_pass_completed" &&
          item.metadata?.resumeStatus === "blocked" &&
          typeof item.metadata?.command === "string" &&
          item.metadata.command.startsWith("repair-local-artifact-gate-");
      } catch {
        return false;
      }
    });
}

function loadCatalogBySourceHash() {
  const catalogPath = join(stateRoot, "catalog", "books.yaml");
  if (!existsSync(catalogPath)) return new Map();
  const catalog = YAML.parse(readFileSync(catalogPath, "utf8")) ?? {};
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  return new Map(items
    .filter((item) => typeof item.sourceHash === "string")
    .map((item) => [
      `${item.sourceHash}:${String(
        item.sourceIdentityPath ?? item.metadata?.sourceIdentityPath ??
          item.sourcePath ?? "",
      ).normalize("NFKC").toLowerCase()}`,
      item,
    ]));
}

function catalogKey(sourceHash, sourceIdentityPath) {
  return `${sourceHash}:${String(sourceIdentityPath).normalize("NFKC").toLowerCase()}`;
}

function normalizedPathFor(sourcePath, sourceHash, sourceIdentityPath, catalogByHash) {
  const catalogItem = catalogByHash.get(catalogKey(sourceHash, sourceIdentityPath));
  if (typeof catalogItem?.normalizedPath === "string") {
    return join(stateRoot, catalogItem.normalizedPath);
  }
  const stem = basename(sourcePath, ".epub");
  return join(stateRoot, "input", `${slugify(stem)}-${sourceHash.slice(0, 10)}.md`);
}

function loadCompletedSeed() {
  if (completedManifestPath == null || !existsSync(completedManifestPath)) {
    return new Map();
  }
  const raw = readJson(completedManifestPath);
  if (!Array.isArray(raw)) {
    throw new Error(`completed manifest must be an array: ${completedManifestPath}`);
  }
  return new Map(raw
    .filter((item) => typeof item.source === "string")
    .map((item) => [item.source, item]));
}

function itemIdFor(sourceHash, sourceRelativePath) {
  return `item-${sourceHash.slice(0, 12)}-${sha256Text(sourceRelativePath).slice(0, 8)}`;
}

function defaultBookIdFor(sourceHash, sourceRelativePath = "") {
  const pathHash = sha256Text(String(sourceRelativePath).normalize("NFKC").toLowerCase());
  return `book-${sourceHash.slice(0, 12)}-${pathHash.slice(0, 8)}`;
}

function discoverItems() {
  const catalogByHash = loadCatalogBySourceHash();
  return readdirSync(sourceDir)
    .filter((name) => name.toLowerCase().endsWith(".epub"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const sourcePath = join(sourceDir, name);
      const sourceHash = sha256File(sourcePath);
      const sourceRelativePath = relative(root, sourcePath);
      const catalogItem = catalogByHash.get(catalogKey(sourceHash, sourceRelativePath));
      const normalizedPath = normalizedPathFor(
        sourcePath,
        sourceHash,
        sourceRelativePath,
        catalogByHash,
      );
      return {
        itemId: itemIdFor(sourceHash, sourceRelativePath),
        sourceName: name,
        sourcePath,
        sourceHash,
        normalizedPath,
        normalizedRel: relative(root, normalizedPath),
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        bookId: typeof catalogItem?.bookId === "string"
          ? catalogItem.bookId
          : defaultBookIdFor(sourceHash, sourceRelativePath),
      };
    });
}

function makeManifest(items) {
  return {
    schemaVersion: SchemaVersion,
    runId,
    status: "running",
    sourceRootName: basename(sourceDir),
    stateRootLocator: relative(root, stateRoot),
    qmdIndexLocator: relative(root, qmdIndexPath),
    configLocator: relative(root, configPath),
    totalItems: items.length,
    pendingItems: items.length,
    runningItems: 0,
    completedItems: 0,
    skippedItems: 0,
    importedCompletedItems: 0,
    failedItems: 0,
    expectedCommandCheckCount,
    maxCommandAttempts,
    maxTransientCommandAttempts,
    maxResumePasses,
    retryBaseDelaySeconds,
    retryMaxDelaySeconds,
    retryBudgetSeconds,
    maxProviderRecoveryWaits,
    commandTimeoutSeconds,
    heartbeatIntervalSeconds,
    startedAt: now(),
    updatedAt: now(),
    itemIds: items.map((item) => item.itemId),
    metadata: {
      logRootName: basename(logRoot),
    },
  };
}

function loadManifest(items) {
  if (existsSync(manifestPath)) {
    const manifest = BatchRunManifestSchema.parse(readJson(manifestPath));
    manifest.sourceRootName = basename(sourceDir);
    manifest.stateRootLocator = relative(root, stateRoot);
    manifest.qmdIndexLocator = relative(root, qmdIndexPath);
    manifest.configLocator = relative(root, configPath);
    manifest.totalItems = items.length;
    manifest.itemIds = items.map((item) => item.itemId);
    manifest.expectedCommandCheckCount = expectedCommandCheckCount;
    manifest.maxCommandAttempts = maxCommandAttempts;
    manifest.maxTransientCommandAttempts = maxTransientCommandAttempts;
    manifest.maxResumePasses = maxResumePasses;
    manifest.retryBaseDelaySeconds = retryBaseDelaySeconds;
    manifest.retryMaxDelaySeconds = retryMaxDelaySeconds;
    manifest.retryBudgetSeconds = retryBudgetSeconds;
    manifest.maxProviderRecoveryWaits = maxProviderRecoveryWaits;
    manifest.commandTimeoutSeconds = commandTimeoutSeconds;
    manifest.heartbeatIntervalSeconds = heartbeatIntervalSeconds;
    return manifest;
  }
  if (statusJson) {
    throw new Error(`missing batch manifest for --status-json: ${manifestPath}`);
  }
  const manifest = makeManifest(items);
  return writeTypedJson(manifestPath, BatchRunManifestSchema, manifest);
}

function itemPath(item) {
  return join(itemRoot, `${item.itemId}.json`);
}

function defaultCheckpoint(item, completedSeed = new Map()) {
  const seed = completedSeed.get(item.sourceName);
  const seedHash = typeof seed?.sourceHash === "string" ? seed.sourceHash : undefined;
  const seedMatches = seed && (seedHash == null || seedHash === item.sourceHash);
  return {
    schemaVersion: SchemaVersion,
    itemId: item.itemId,
    runId,
    status: seedMatches && migrateOnly ? "skipped" : "pending",
    sourceName: item.sourceName,
    sourceRelativePath: item.sourceRelativePath,
    sourceIdentityPath: item.sourceIdentityPath,
    sourceHash: item.sourceHash,
    normalizedPath: item.normalizedRel,
    bookId: item.bookId,
    attempts: 0,
    expectedCommandCheckCount,
    maxCommandAttempts,
    maxTransientCommandAttempts,
    maxResumePasses,
    retryBaseDelaySeconds,
    retryMaxDelaySeconds,
    retryBudgetSeconds,
    maxProviderRecoveryWaits,
    commandTimeoutSeconds,
    heartbeatIntervalSeconds,
    recoveryDecision: "none",
    commandChecks: [],
    metadata: seedMatches
      ? {
          seededFromCompletedManifest: basename(completedManifestPath),
          seedMatchMode: seedHash == null ? "source_name_only" : "source_name_and_hash",
          importedCompletedMode: migrateOnly ? "skip_for_migration" : "audit_only",
        }
      : undefined,
  };
}

function hydrateCheckpoint(item, checkpoint) {
  const hydrated = hydrateBatchCheckpoint({
    item,
    checkpoint,
    expectedCommandCheckCount,
    maxCommandAttempts,
    maxTransientCommandAttempts,
    maxResumePasses,
    retryBaseDelaySeconds,
    retryMaxDelaySeconds,
    retryBudgetSeconds,
    maxProviderRecoveryWaits,
    commandTimeoutSeconds,
    defaultBookId: defaultBookIdFor(item.sourceHash, item.sourceRelativePath),
    repairOnlyBlockedLoopObserved: repairOnlyBlockedLoopObserved(item.itemId),
  });
  return withoutUndefined({
    ...hydrated,
    errorSummary: hydrated.errorSummary ? redacted(hydrated.errorSummary) : undefined,
    qmdBuildStatus: hydrated.qmdBuildStatus == null
      ? undefined
      : redactJsonValue(hydrated.qmdBuildStatus),
    graphBuildStatus: hydrated.graphBuildStatus == null
      ? undefined
      : redactJsonValue(hydrated.graphBuildStatus),
    graphQueryStatus: hydrated.graphQueryStatus == null
      ? undefined
      : redactJsonValue(hydrated.graphQueryStatus),
    metadata: hydrated.metadata == null ? undefined : redactJsonValue(hydrated.metadata),
    commandChecks: (hydrated.commandChecks ?? []).map((check) => ({
      ...check,
      errorSummary: check.errorSummary ? redacted(check.errorSummary) : undefined,
    })),
  });
}

function evidenceItemForCheckpoint(item, checkpoint) {
  return {
    ...item,
    sourceIdentityPath: typeof checkpoint?.sourceIdentityPath === "string"
      ? checkpoint.sourceIdentityPath
      : item.sourceIdentityPath,
    sourceHash: typeof checkpoint?.sourceHash === "string"
      ? checkpoint.sourceHash
      : item.sourceHash,
    bookId: typeof checkpoint?.bookId === "string" ? checkpoint.bookId : item.bookId,
    normalizedPath: typeof checkpoint?.normalizedPath === "string"
      ? checkpoint.normalizedPath
      : item.normalizedPath,
  };
}

function absoluteRuntimePath(path) {
  return isAbsolute(path) ? path : join(root, path);
}

function runtimeItemForCheckpoint(item, checkpoint) {
  const checkpointItem = evidenceItemForCheckpoint(item, checkpoint);
  return {
    ...checkpointItem,
    sourcePath: item.sourcePath,
    normalizedPath: absoluteRuntimePath(checkpointItem.normalizedPath),
    normalizedRel: relative(root, absoluteRuntimePath(checkpointItem.normalizedPath)),
  };
}

function loadCheckpoint(item, completedSeed) {
  const path = itemPath(item);
  if (!existsSync(path)) {
    if (statusJson) {
      return BatchItemCheckpointSchema.parse(withBuildStatusSnapshot(
        item,
        defaultCheckpoint(item, completedSeed),
      ));
    }
    const checkpoint = defaultCheckpoint(item, completedSeed);
    return writeTypedJson(
      path,
      BatchItemCheckpointSchema,
      withBuildStatusSnapshot(item, checkpoint),
    );
  }
  const hydrated = hydrateCheckpoint(item, readJson(path));
  const hydratedEvidenceItem = evidenceItemForCheckpoint(item, hydrated);
  if (migrateOnly) {
    const checkpoint = recoverProviderTransientCheckpoint(item,
      recoverLegacyResponsesOutputNoneCheckpoint(item,
        downgradeCompletedIfClosedLoopInvalid(
          hydratedEvidenceItem,
          hydrated,
        ),
      ),
    );
    const checkpointEvidenceItem = evidenceItemForCheckpoint(item, checkpoint);
    if (statusJson) {
      return BatchItemCheckpointSchema.parse(
        withCheckpointPersistenceInvariants(
          withBuildStatusSnapshot(checkpointEvidenceItem, checkpoint),
        ),
      );
    }
    return writeTypedJson(
      path,
      BatchItemCheckpointSchema,
      withCheckpointPersistenceInvariants(
        withBuildStatusSnapshot(checkpointEvidenceItem, checkpoint),
      ),
    );
  }
  const checkpoint = recoverProviderTransientCheckpoint(item,
    recoverLegacyResponsesOutputNoneCheckpoint(item,
      recoverOrphanedRunningCheckpoint(item, downgradeCompletedIfClosedLoopInvalid(
        hydratedEvidenceItem,
        hydrated,
      )),
    ),
  );
  const checkpointEvidenceItem = evidenceItemForCheckpoint(item, checkpoint);
  if (statusJson) {
    return BatchItemCheckpointSchema.parse(
      withCheckpointPersistenceInvariants(
        withBuildStatusSnapshot(checkpointEvidenceItem, checkpoint),
      ),
    );
  }
  return writeTypedJson(
    path,
    BatchItemCheckpointSchema,
    withCheckpointPersistenceInvariants(
      withBuildStatusSnapshot(checkpointEvidenceItem, checkpoint),
    ),
  );
}

function withBuildStatusSnapshot(item, checkpoint) {
  return {
    ...checkpoint,
    qmdBuildStatus: redactJsonValue(qmdBuildEvidence(item)),
    graphBuildStatus: redactJsonValue(graphBuildEvidence(item)),
    graphQueryStatus: redactJsonValue(graphQueryEvidence(checkpoint)),
  };
}

function withCheckpointPersistenceInvariants(checkpoint) {
  if (checkpoint.status === "running") return checkpoint;
  return {
    ...checkpoint,
    currentCommand: undefined,
    activeCommand: checkpoint.activeCommand ?? checkpoint.currentCommand,
    currentCommandStartedAt: undefined,
  };
}

function saveCheckpoint(item, checkpoint) {
  return writeTypedJson(
    itemPath(item),
    BatchItemCheckpointSchema,
    withCheckpointPersistenceInvariants(withBuildStatusSnapshot(item, checkpoint)),
  );
}

function appendCommandCheckCheckpoint(item, checkpoint, check) {
  if (statusJson) return checkpoint;
  const nextChecks = [
    ...(checkpoint.commandChecks ?? [])
      .filter((item) => item.name !== check.name),
    check,
  ];
  const updated = {
    ...checkpoint,
    commandChecks: nextChecks,
    runnerHeartbeatAt: now(),
    activeCommand: check.name,
  };
  saveCheckpoint(item, updated);
  return updated;
}

function heartbeatMonitorScript() {
  return String.raw`
const fs = require("node:fs");

const [
  checkpointPath,
  stopPath,
  runnerSessionId,
  runnerHost,
  runnerPidText,
  command,
  commandStartedAt,
  intervalMsText,
] = process.argv.slice(1);
const runnerPid = Number.parseInt(runnerPidText, 10);
const intervalMs = Math.max(100, Number.parseInt(intervalMsText, 10) || 30000);
const lockStaleMs = 120000;
let lifelineAlive = true;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

try {
  const lifeline = fs.createReadStream(null, { fd: 3, autoClose: false });
  const stop = () => {
    lifelineAlive = false;
    process.exit(0);
  };
  lifeline.on("end", stop);
  lifeline.on("close", stop);
  lifeline.on("error", stop);
  lifeline.resume();
} catch {
  lifelineAlive = false;
}

function readCheckpoint() {
  try {
    return JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  } catch {
    return null;
  }
}

function parentAlive() {
  if (!lifelineAlive) return false;
  if (!Number.isInteger(runnerPid) || runnerPid <= 0) return false;
  try {
    process.kill(runnerPid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeJsonAtomic(path, text) {
  const temporaryPath = path + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(temporaryPath, text, "utf8");
  fs.renameSync(temporaryPath, path);
}

function withCheckpointLock(callback) {
  const lockPath = checkpointPath + ".lock";
  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, "wx");
      return callback();
    } catch (error) {
      if (error && error.code !== "EEXIST") throw error;
      try {
        const entry = fs.statSync(lockPath);
        if (Date.now() - entry.mtimeMs > lockStaleMs) fs.unlinkSync(lockPath);
      } catch {
        // Missing or concurrently removed locks are expected under contention.
      }
      sleep(25);
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }
    }
  }
}

function writeHeartbeat() {
  if (fs.existsSync(stopPath) || !parentAlive()) return false;
  return withCheckpointLock(() => {
    if (fs.existsSync(stopPath) || !parentAlive()) return false;
    const checkpoint = readCheckpoint();
    if (checkpoint == null) return true;
    if (
      checkpoint.status !== "running" ||
      checkpoint.runnerSessionId !== runnerSessionId ||
      checkpoint.runnerHost !== runnerHost ||
      checkpoint.runnerPid !== runnerPid
    ) {
      return false;
    }
    const updated = {
      ...checkpoint,
      runnerHeartbeatAt: new Date().toISOString(),
      currentCommand: command,
      activeCommand: command,
      currentCommandStartedAt: commandStartedAt,
    };
    writeJsonAtomic(checkpointPath, JSON.stringify(updated, null, 2) + "\n");
    return true;
  });
}

if (!writeHeartbeat()) process.exit(0);
const timer = setInterval(() => {
  if (!writeHeartbeat()) {
    clearInterval(timer);
    process.exit(0);
  }
}, intervalMs);
`;
}

function startCommandHeartbeatMonitor(item, command, commandStartedAt) {
  if (statusJson) return null;
  const intervalMs = heartbeatIntervalSeconds * 1000;
  const safeCommand = command.replace(/[^A-Za-z0-9_.-]/gu, "_");
  const stopPath = join(
    logRoot,
    `${item.itemId}-${safeCommand}-${runnerSessionId}.heartbeat-stop`,
  );
  rmSync(stopPath, { force: true });
  const monitor = spawn(process.execPath, [
    "-e",
    heartbeatMonitorScript(),
    itemPath(item),
    stopPath,
    runnerSessionId,
    runnerHost,
    String(runnerPid),
    command,
    commandStartedAt,
    String(intervalMs),
  ], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const lifeline = monitor.stdio[3];
  lifeline?.unref?.();
  monitor.unref();
  return {
    stop() {
      try {
        writeFileSync(stopPath, "stop\n", "utf8");
      } catch {
        // Best-effort only; closing the lifeline below is the primary shutdown.
      }
      try {
        lifeline?.destroy?.();
      } catch {
        // Closing the parent side of the pipe releases the monitor lifeline.
      }
    },
  };
}

function clearCommandHeartbeat(item, command) {
  if (statusJson || !existsSync(itemPath(item))) return;
  try {
    withJsonFileLock(itemPath(item), () => {
      const checkpoint = BatchItemCheckpointSchema.parse(readJson(itemPath(item)));
      if (
        checkpoint.status !== "running" ||
        checkpoint.runnerSessionId !== runnerSessionId ||
        checkpoint.runnerHost !== runnerHost ||
        checkpoint.runnerPid !== runnerPid ||
        checkpoint.currentCommand !== command
      ) {
        return;
      }
      const cleaned = BatchItemCheckpointSchema.parse(withoutUndefined({
        ...withBuildStatusSnapshot(item, checkpoint),
        runnerHeartbeatAt: now(),
        currentCommand: undefined,
        activeCommand: checkpoint.activeCommand ?? checkpoint.currentCommand,
        currentCommandStartedAt: undefined,
      }));
      writeJsonAtomic(itemPath(item), JSON.stringify(cleaned, null, 2) + "\n");
    });
  } catch {
    return;
  }
}

function readYamlFileIfExists(path) {
  if (!existsSync(path)) return null;
  return YAML.parse(readFileSync(path, "utf8")) ?? null;
}

function readYamlSchemaIfExists(path, schema) {
  const raw = readYamlFileIfExists(path);
  return raw == null ? null : schema.parse(raw);
}

function readJsonSchemaIfExists(path, schema) {
  if (!existsSync(path)) return null;
  const parsed = schema.safeParse(readJson(path));
  return parsed.success ? parsed.data : null;
}

function readGraphOutputProducerManifest(path) {
  if (!existsSync(path)) return null;
  const raw = readJson(path);
  const current = GraphRagOutputProducerManifestSchema.safeParse(raw);
  if (current.success) return current.data;
  const legacy = GraphRagOutputProducerManifestLegacySchema.safeParse(raw);
  return legacy.success ? legacy.data : null;
}

const graphStageArtifactKinds = {
  graph_extract: [
    "graphrag_documents_parquet",
    "graphrag_text_units_parquet",
    "graphrag_entities_parquet",
    "graphrag_relationships_parquet",
    "graphrag_communities_parquet",
    "graphrag_context_json",
    "graphrag_stats_json",
  ],
  community_report: ["graphrag_community_reports_parquet"],
  embed: ["lancedb_index"],
  query_ready: ["graphrag_community_reports_parquet", "lancedb_index"],
};
const graphProducerStages = ["graph_extract", "community_report", "embed"];
const graphCompletionStages = [
  "graph_extract",
  "community_report",
  "embed",
  "query_ready",
];
const graphIdentityStages = [
  "ingest",
  "normalize",
  ...graphCompletionStages,
];

function checkpointArtifactIds(checkpoint) {
  return Array.isArray(checkpoint?.artifactIds)
    ? checkpoint.artifactIds.map(String)
    : [];
}

function graphRagBookOutputLocator(bookId) {
  return `books/${bookId}/output`;
}

function qmdBuildManifestLocator(item) {
  return `books/${item.bookId}/qmd/qmd_build_manifest.json`;
}

function qmdBuildManifestPath(item) {
  return join(stateRoot, qmdBuildManifestLocator(item));
}

function qmdBuildArtifactId(item, normalizedContentHash) {
  return stableHash({
    kind: "qmd_build_manifest",
    runId,
    itemId: item.itemId,
    bookId: item.bookId,
    sourceHash: item.sourceHash,
    normalizedContentHash,
  });
}

function normalizeForStableHash(input) {
  if (
    input === null ||
    typeof input === "boolean" ||
    typeof input === "number" ||
    typeof input === "string"
  ) {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => normalizeForStableHash(item));
  }
  if (input instanceof Date) {
    return input.toISOString();
  }
  if (typeof input === "object" && input != null) {
    return Object.fromEntries(
      Object.entries(input)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, normalizeForStableHash(value)]),
    );
  }
  return String(input);
}

function stableHash(input) {
  return createHash("sha256")
    .update(JSON.stringify(normalizeForStableHash(input)))
    .digest("hex");
}

function hashFilePayload(rootDir, files) {
  return files.map((path) => ({
    hash: sha256File(path),
    path: path.slice(rootDir.length + 1),
  }));
}

function listFilesRecursive(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(entryPath));
      continue;
    }
    if (entry.isFile()) files.push(entryPath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function hashDirectoryContents(rootDir) {
  return stableHash(hashFilePayload(rootDir, listFilesRecursive(rootDir)));
}

function readLanceRowCount(tableDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(tableDir, "qmd_row_count.json"), "utf8"));
    if (typeof parsed === "number") return parsed;
    if (parsed && typeof parsed === "object" && typeof parsed.rowCount === "number") {
      return parsed.rowCount;
    }
  } catch {
    return null;
  }
  return null;
}

function validateLanceDbDirectory(path) {
  try {
    if (!statSync(path).isDirectory()) return "lancedb_path_not_directory";
    for (const tableName of requiredLanceDbTables) {
      const tableDir = join(path, tableName);
      if (!statSync(tableDir).isDirectory()) {
        return `${tableName}:lancedb_table_not_directory`;
      }
      const dataDir = join(tableDir, "data");
      const dataFiles = readdirSync(dataDir).filter((item) => item.endsWith(".lance"));
      if (dataFiles.length === 0) return `${tableName}:lancedb_table_missing_data`;
      const nonEmpty = dataFiles.some((fileName) => {
        try {
          const entry = statSync(join(dataDir, fileName));
          return entry.isFile() && entry.size > 0;
        } catch {
          return false;
        }
      });
      if (!nonEmpty) return `${tableName}:lancedb_table_has_no_non_empty_fragments`;
      const rowCount = readLanceRowCount(tableDir);
      if (rowCount == null || rowCount <= 0) {
        return `${tableName}:lancedb_table_missing_positive_row_count`;
      }
    }
    return null;
  } catch {
    return "lancedb_path_missing_or_unreadable";
  }
}

function hashLanceDbDirectoryContents(rootDir) {
  const files = [];
  for (const tableName of requiredLanceDbTables) {
    const tableDir = join(rootDir, tableName);
    const dataDir = join(tableDir, "data");
    const dataFiles = readdirSync(dataDir);
    files.push(
      ...dataFiles
        .filter((item) => item.endsWith(".lance"))
        .map((item) => join(dataDir, item)),
      join(tableDir, "qmd_row_count.json"),
    );
  }
  return stableHash(hashFilePayload(rootDir, files.sort((left, right) =>
    left.localeCompare(right)
  )));
}

function isParquetArtifact(kind) {
  return typeof kind === "string" &&
    kind.startsWith("graphrag_") &&
    kind.endsWith("_parquet");
}

function validateParquetFile(path, size) {
  if (size < 12) return "parquet_file_too_small";
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    const footer = Buffer.alloc(4);
    readSync(fd, header, 0, 4, 0);
    readSync(fd, footer, 0, 4, size - 4);
    if (header.toString("ascii") !== "PAR1" || footer.toString("ascii") !== "PAR1") {
      return "parquet_magic_mismatch";
    }
    const footerLengthBytes = Buffer.alloc(4);
    readSync(fd, footerLengthBytes, 0, 4, size - 8);
    const footerLength = footerLengthBytes.readUInt32LE(0);
    if (footerLength <= 0 || footerLength > size - 12) {
      return "parquet_footer_length_invalid";
    }
    const rowCount = readParquetRowCount(path);
    if (rowCount == null) return "parquet_metadata_unreadable";
    if (rowCount <= 0) return "parquet_row_count_empty";
    return null;
  } finally {
    closeSync(fd);
  }
}

function readParquetRowCount(path) {
  try {
    const file = readFileSync(path);
    const footerLength = file.readUInt32LE(file.length - 8);
    const footer = file.subarray(file.length - 8 - footerLength, file.length - 8);
    return readParquetFooterNumRows(footer);
  } catch {
    return null;
  }
}

function readParquetFooterNumRows(buffer) {
  const reader = createCompactReader(buffer);
  let previousFieldId = 0;
  while (!reader.eof()) {
    const header = reader.readByte();
    const type = header & 0x0f;
    if (type === 0) return null;
    const delta = header >> 4;
    const fieldId = delta === 0
      ? reader.readZigZagVarint()
      : previousFieldId + delta;
    previousFieldId = fieldId;
    if (fieldId === 3 && type === 6) {
      return reader.readZigZagVarint();
    }
    reader.skip(type);
  }
  return null;
}

function createCompactReader(buffer) {
  let offset = 0;
  const readByte = () => {
    if (offset >= buffer.length) {
      throw new Error("parquet compact metadata ended unexpectedly");
    }
    return buffer[offset++];
  };
  const readVarint = () => {
    let shift = 0;
    let value = 0;
    for (;;) {
      const byte = readByte();
      value += (byte & 0x7f) * (2 ** shift);
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 63) throw new Error("parquet compact varint too large");
    }
  };
  const readZigZagVarint = () => {
    const value = readVarint();
    return Math.floor(value / 2) ^ -(value % 2);
  };
  const skip = (type) => {
    switch (type) {
      case 1:
      case 2:
      case 0:
        return;
      case 3:
        offset += 1;
        return;
      case 4:
      case 5:
      case 6:
        readVarint();
        return;
      case 7:
        offset += 8;
        return;
      case 8: {
        const length = readVarint();
        offset += length;
        return;
      }
      case 9:
      case 10: {
        const header = readByte();
        const elementType = header & 0x0f;
        const inlineSize = header >> 4;
        const size = inlineSize === 15 ? readVarint() : inlineSize;
        for (let index = 0; index < size; index += 1) skip(elementType);
        return;
      }
      case 11: {
        const size = readVarint();
        if (size === 0) return;
        const types = readByte();
        const keyType = types >> 4;
        const valueType = types & 0x0f;
        for (let index = 0; index < size; index += 1) {
          skip(keyType);
          skip(valueType);
        }
        return;
      }
      case 12: {
        let previousFieldId = 0;
        for (;;) {
          const header = readByte();
          const fieldType = header & 0x0f;
          if (fieldType === 0) return;
          const delta = header >> 4;
          previousFieldId = delta === 0
            ? readZigZagVarint()
            : previousFieldId + delta;
          skip(fieldType);
        }
      }
      default:
        throw new Error(`unsupported parquet compact type: ${type}`);
    }
  };
  return {
    eof: () => offset >= buffer.length,
    readByte,
    readZigZagVarint,
    skip,
  };
}

function validateArtifactContent(artifact, bookId) {
  if (!artifact || artifact.bookId !== bookId || typeof artifact.path !== "string") {
    return "artifact_identity_mismatch";
  }
  const artifactPath = join(stateRoot, artifact.path);
  try {
    const entry = statSync(artifactPath);
    const vaultRealPath = realpathSync(stateRoot);
    const artifactRealPath = realpathSync(artifactPath);
    if (
      artifactRealPath !== vaultRealPath &&
      !artifactRealPath.startsWith(`${vaultRealPath}${sep}`)
    ) {
      return "realpath_outside_graph_vault";
    }

    if (artifact.kind === "lancedb_index") {
      const lanceReason = validateLanceDbDirectory(artifactPath);
      if (lanceReason) return lanceReason;
    }

    const actualHash = artifact.kind === "lancedb_index"
      ? hashLanceDbDirectoryContents(artifactPath)
      : entry.isDirectory()
        ? hashDirectoryContents(artifactPath)
        : sha256File(artifactPath);
    if (actualHash !== artifact.contentHash) {
      return "content_hash_mismatch";
    }

    if (isParquetArtifact(artifact.kind) && (!entry.isFile() || entry.size === 0)) {
      return "parquet_file_empty_or_not_file";
    }
    if (isParquetArtifact(artifact.kind)) {
      const parquetReason = validateParquetFile(artifactPath, entry.size);
      if (parquetReason) return parquetReason;
    }
    if (
      artifact.kind === "graphrag_context_json" ||
      artifact.kind === "graphrag_stats_json"
    ) {
      const parsed = JSON.parse(readFileSync(artifactPath, "utf8"));
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "json_artifact_not_object";
      }
    }
    return null;
  } catch {
    return "path_missing_or_unreadable";
  }
}

function readGraphJob(item) {
  const catalog = readYamlSchemaIfExists(
    join(stateRoot, "catalog", "books.yaml"),
    BookJobCatalogSchema,
  );
  const jobs = catalog?.items ?? [];
  return jobs.find((job) =>
    job?.bookId === item.bookId && job?.sourceHash === item.sourceHash
  ) ?? null;
}

function expectedArtifactStage(stage, artifact) {
  if (stage !== "query_ready") return stage;
  return artifact?.stage === "community_report" || artifact?.stage === "embed"
    ? artifact.stage
    : undefined;
}

function sortedCurrentArtifacts(artifacts) {
  return [...artifacts].sort((left, right) => {
    const created = String(right?.createdAt ?? "")
      .localeCompare(String(left?.createdAt ?? ""));
    return created === 0
      ? String(left?.artifactId ?? "").localeCompare(String(right?.artifactId ?? ""))
      : created;
  });
}

function stageCandidateArtifacts({
  item,
  stage,
  checkpoint,
  artifacts,
  requiredKinds,
  expectedProducerRunId,
  producer,
}) {
  const requiredKindSet = new Set(requiredKinds);
  if (stage === "query_ready") {
    return artifacts.filter((artifact) =>
      artifact?.bookId === item.bookId &&
      requiredKindSet.has(artifact.kind) &&
      (artifact.stage === "community_report" || artifact.stage === "embed")
    );
  }
  if (graphProducerStages.includes(stage)) {
    return artifacts.filter((artifact) =>
      artifact?.bookId === item.bookId &&
      artifact.stage === stage &&
      requiredKindSet.has(artifact.kind)
    );
  }
  const artifactIds = new Set(checkpointArtifactIds(checkpoint));
  return artifacts.filter((artifact) =>
    artifact?.bookId === item.bookId &&
    artifactIds.has(artifact.artifactId) &&
    (requiredKindSet.size === 0 || requiredKindSet.has(artifact.kind))
  );
}

function selectValidStageArtifacts({
  item,
  stage,
  artifacts,
  requiredKinds,
  expectedStageFingerprints,
  expectedProviderFingerprint,
  expectedCorpusContentHash,
  expectedProducerRunId,
  producer,
}) {
  const validByKind = new Map();
  const invalidReasons = [];
  for (const artifact of artifacts) {
    const artifactStage = expectedArtifactStage(stage, artifact);
    const invalidReason = validateArtifactContent(artifact, item.bookId);
    if (invalidReason != null) {
      invalidReasons.push(`stage_artifact_invalid:${invalidReason}`);
      continue;
    }
    if (artifactStage == null) {
      invalidReasons.push(`stage_artifact_stage_mismatch:${stage}`);
      continue;
    }
    if (stage !== "query_ready") {
      if (
        expectedProducerRunId != null &&
        artifact.producerRunId !== expectedProducerRunId
      ) {
        invalidReasons.push(`stage_artifact_producer_run_mismatch:${stage}`);
        continue;
      }
    } else {
      const expectedRunId = producer?.stageProducerRunIds?.[artifactStage];
      if (expectedRunId == null || artifact.producerRunId !== expectedRunId) {
        invalidReasons.push(`stage_artifact_producer_run_mismatch:${stage}`);
        continue;
      }
    }
    if (
      expectedStageFingerprints != null &&
      artifact.stageFingerprint !== expectedStageFingerprints[artifactStage]
    ) {
      invalidReasons.push(`stage_artifact_fingerprint_mismatch:${stage}`);
      continue;
    }
    if (
      expectedProviderFingerprint != null &&
      artifact.providerFingerprint !== expectedProviderFingerprint
    ) {
      invalidReasons.push(`stage_artifact_provider_mismatch:${stage}`);
      continue;
    }
    if (
      expectedCorpusContentHash != null &&
      (artifact.kind.startsWith("graphrag_") || artifact.kind === "lancedb_index") &&
      artifact.metadata?.corpusContentHash !== expectedCorpusContentHash
    ) {
      invalidReasons.push(`stage_artifact_corpus_mismatch:${stage}`);
      continue;
    }
    const isBookScoped = stage === "embed"
      ? artifact.path === `books/${item.bookId}/output/lancedb`
      : artifact.path.startsWith(`books/${item.bookId}/output/`);
    if (!isBookScoped) {
      invalidReasons.push("stage_artifact_not_book_scoped");
      continue;
    }
    const items = validByKind.get(artifact.kind) ?? [];
    items.push(artifact);
    validByKind.set(artifact.kind, items);
  }

  const selected = [];
  for (const kind of requiredKinds) {
    const candidates = validByKind.get(kind) ?? [];
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: invalidReasons[0] ?? `stage_artifact_kind_missing:${kind}`,
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
      };
    }
    selected.push(sortedCurrentArtifacts(candidates)[0]);
  }
  return {
    ok: true,
    artifactIds: selected.map((artifact) => artifact.artifactId),
  };
}

function validateGraphStageEvidence({
  item,
  stage,
  checkpoint,
  artifacts,
  expectedStageFingerprints,
  expectedProviderFingerprint,
  expectedCorpusContentHash,
  expectedProducerRunId,
  producer,
}) {
  if (
    checkpoint?.stage !== stage ||
    checkpoint?.status !== "succeeded" ||
    checkpoint?.metadata?.bootstrap === true
  ) {
    const checkpointStatus = checkpoint?.status;
    return {
      ok: false,
      failed: checkpointStatus === "failed",
      reason: checkpoint?.metadata?.bootstrap === true
        ? "bootstrap_stage_requires_real_rebuild"
        : checkpointStatus === "failed"
          ? `real_graphrag_stage_failed:${stage}`
          : "real_graphrag_stage_missing",
      artifactIds: checkpointArtifactIds(checkpoint),
    };
  }

  if (checkpoint.bookId !== item.bookId) {
    return {
      ok: false,
      reason: `stage_checkpoint_book_mismatch:${stage}`,
      artifactIds: checkpointArtifactIds(checkpoint),
    };
  }

  if (
    expectedCorpusContentHash != null &&
    checkpoint.contentHash !== expectedCorpusContentHash
  ) {
    return {
      ok: false,
      reason: `stage_checkpoint_content_mismatch:${stage}`,
      artifactIds: checkpointArtifactIds(checkpoint),
    };
  }

  if (
    expectedStageFingerprints != null &&
    (
      checkpoint.inputFingerprint !== expectedStageFingerprints[stage] ||
      checkpoint.stageFingerprint !== expectedStageFingerprints[stage]
    )
  ) {
    return {
      ok: false,
      reason: `stage_fingerprint_mismatch:${stage}`,
      artifactIds: checkpointArtifactIds(checkpoint),
    };
  }

  if (
    expectedProviderFingerprint != null &&
    checkpoint.providerFingerprint !== expectedProviderFingerprint
  ) {
    return {
      ok: false,
      reason: `provider_fingerprint_mismatch:${stage}`,
      artifactIds: checkpointArtifactIds(checkpoint),
    };
  }

  if (expectedProducerRunId != null && checkpoint.runId !== expectedProducerRunId) {
    return {
      ok: false,
      reason: `graph_output_producer_run_mismatch:${stage}`,
      artifactIds: checkpointArtifactIds(checkpoint),
    };
  }

  const requiredKinds = graphStageArtifactKinds[stage];
  const stageArtifacts = stageCandidateArtifacts({
    item,
    stage,
    checkpoint,
    artifacts,
    requiredKinds,
    expectedProducerRunId,
    producer,
  });
  if (stageArtifacts.length === 0) {
    return {
      ok: false,
      reason: "stage_artifact_missing",
      artifactIds: checkpointArtifactIds(checkpoint),
    };
  }

  return selectValidStageArtifacts({
    item,
    stage,
    artifacts: stageArtifacts,
    requiredKinds,
    expectedStageFingerprints,
    expectedProviderFingerprint,
    expectedCorpusContentHash,
    expectedProducerRunId,
    producer,
  });
}

function graphBuildEvidence(item) {
  const checkedAt = now();
  const checkpointCatalog = readYamlSchemaIfExists(
    join(stateRoot, "books", item.bookId, "checkpoints.yaml"),
    BookJobCheckpointListSchema,
  );
  const artifactCatalog = readYamlSchemaIfExists(
    join(stateRoot, "books", item.bookId, "artifacts.yaml"),
    BookArtifactManifestListSchema,
  );
  const checkpoints = checkpointCatalog?.items ?? [];
  const artifacts = artifactCatalog?.items ?? [];
  const producerManifestPath = join(
    stateRoot,
    "books",
    item.bookId,
    "output",
    "qmd_output_manifest.json",
  );
  const producer = readGraphOutputProducerManifest(producerManifestPath);
  const job = readGraphJob(item);
  const expectedStageFingerprints = job?.stageFingerprints ?? producer?.stageFingerprints;
  const expectedProviderFingerprint = job?.providerFingerprint ??
    producer?.providerFingerprint;
  const expectedCorpusContentHash = job?.normalizedContentHash ?? job?.sourceHash ??
    producer?.contentHash;

  for (const stage of graphCompletionStages) {
    const checkpoint = checkpoints.find((checkpoint) => checkpoint?.stage === stage);
    const stageEvidence = validateGraphStageEvidence({
      item,
      stage,
      checkpoint,
      artifacts,
      expectedStageFingerprints,
      expectedProviderFingerprint,
      expectedCorpusContentHash,
      expectedProducerRunId: graphProducerStages.includes(stage)
        ? producer?.stageProducerRunIds?.[stage]
        : undefined,
      producer,
    });
    if (!stageEvidence.ok) {
      return {
        status: stageEvidence.failed === true
          ? "failed"
          : checkpoint?.status === "running"
            ? "running"
          : stageEvidence.reason === "real_graphrag_stage_missing"
            ? "pending"
            : "stale",
        checkedAt,
        stage,
        reason: stageEvidence.reason,
        artifactIds: stageEvidence.artifactIds,
      };
    }
  }

  const expectedOutputLocator = graphRagBookOutputLocator(item.bookId);
  const expectedContentHash = job?.normalizedContentHash ?? job?.sourceHash;
  const missingStageProducerRun = graphProducerStages.find((stage) =>
    typeof producer?.stageProducerRunIds?.[stage] !== "string"
  );
  const mismatchedStageProducerRun = graphProducerStages.find((stage) => {
    const stageCheckpoint = checkpoints.find((checkpoint) =>
      checkpoint?.stage === stage && checkpoint?.status === "succeeded"
    );
    return producer?.stageProducerRunIds?.[stage] !== stageCheckpoint?.runId;
  });
  const missingStageFingerprint = graphIdentityStages.find((stage) =>
    typeof producer?.stageFingerprints?.[stage] !== "string" ||
    (expectedStageFingerprints != null &&
      producer.stageFingerprints[stage] !== expectedStageFingerprints[stage])
  );
  if (
    job == null ||
    producer?.bookId !== item.bookId ||
    producer?.sourceHash !== item.sourceHash ||
    producer?.documentId !== job.documentId ||
    producer?.contentHash !== expectedContentHash ||
    producer?.providerFingerprint !== expectedProviderFingerprint ||
    producer?.outputDir !== expectedOutputLocator ||
    missingStageProducerRun != null ||
    mismatchedStageProducerRun != null ||
    missingStageFingerprint != null
  ) {
    return {
      status: "stale",
      checkedAt,
      stage: "query_ready",
      reason: job == null
        ? "graph_job_identity_missing"
        : missingStageProducerRun != null
          ? `graph_output_producer_stage_missing:${missingStageProducerRun}`
          : mismatchedStageProducerRun != null
            ? `graph_output_producer_run_mismatch:${mismatchedStageProducerRun}`
            : missingStageFingerprint != null
              ? `graph_output_producer_fingerprint_mismatch:${missingStageFingerprint}`
              : "graph_output_producer_manifest_missing_or_mismatched",
      artifactIds: checkpointArtifactIds(
        checkpoints.find((checkpoint) => checkpoint?.stage === "query_ready"),
      ),
    };
  }

  const queryReady = checkpoints.find((checkpoint) =>
    checkpoint?.stage === "query_ready" && checkpoint?.status === "succeeded"
  );
  return {
    status: "succeeded",
    checkedAt,
    stage: "query_ready",
    artifactIds: checkpointArtifactIds(queryReady),
  };
}

function migrateGraphOutputProducerManifests() {
  for (const item of discoverItems()) {
    const manifestPath = join(
      stateRoot,
      "books",
      item.bookId,
      "output",
      "qmd_output_manifest.json",
    );
    if (!existsSync(manifestPath)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed?.outputDir !== "string") continue;
    const expectedLocator = graphRagBookOutputLocator(item.bookId);
    if (parsed.outputDir === expectedLocator) continue;
    const resolvedOutputDir = resolve(parsed.outputDir);
    const expectedOutputDir = resolve(
      stateRoot,
      "books",
      item.bookId,
      "output",
    );
    if (resolvedOutputDir !== expectedOutputDir) continue;
    parsed.outputDir = expectedLocator;
    writeFileSync(manifestPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    event({
      itemId: item.itemId,
      event: "graph_output_manifest_migrated",
      status: "pending",
      metadata: {
        manifestLocator: `graph_vault/${expectedLocator}/qmd_output_manifest.json`,
        outputDir: expectedLocator,
      },
    });
  }
}

function qmdCommandCheckEvidence(checkpoint) {
  const checkedAt = now();
  const checks = (checkpoint.commandChecks ?? [])
    .filter((check) => qmdNativeCommandCheckNames.includes(check.name));
  const names = new Set(checks.map((check) => check.name));
  const failed = checks.find((check) => check.status !== "passed");
  if (failed) {
    return {
      status: "failed",
      checkedAt,
      stage: failed.name,
      reason: "qmd_command_check_failed",
      artifactIds: [],
    };
  }
  const missing = qmdNativeCommandCheckNames.find((name) => !names.has(name));
  if (missing) {
    return {
      status: "pending",
      checkedAt,
      stage: missing,
      reason: "qmd_command_check_missing",
      artifactIds: [],
    };
  }
  const unexpected = checks.find((check) =>
    !qmdNativeCommandCheckNames.includes(check.name)
  );
  if (
    unexpected ||
    checks.length !== expectedQmdNativeCommandCheckCount ||
    names.size !== expectedQmdNativeCommandCheckCount
  ) {
    return {
      status: "pending",
      checkedAt,
      stage: unexpected?.name ?? "qmd-command-checks",
      reason: unexpected
        ? "qmd_command_check_unexpected"
        : "qmd_command_check_set_incomplete",
      artifactIds: [],
    };
  }
  return {
    status: "succeeded",
    checkedAt,
    stage: "qmd-command-checks",
    artifactIds: [],
  };
}

function readQmdBuildManifest(item) {
  return readJsonSchemaIfExists(qmdBuildManifestPath(item), QmdBuildManifestSchema);
}

function writeQmdBuildManifest(item, commandChecks) {
  const commandCheckStatus = qmdCommandCheckEvidence({ commandChecks });
  if (commandCheckStatus.status !== "succeeded") {
    throw Object.assign(
      new Error(
        `qmd-native command checks did not complete: ${commandCheckStatus.reason}`,
      ),
      {
        commandCheck: commandChecks.find((check) =>
          check.name === commandCheckStatus.stage
        ),
      },
    );
  }
  if (!existsSync(item.normalizedPath)) {
    throw Object.assign(
      new Error("qmd build input missing: normalized markdown not found"),
      {
        commandCheck: {
          name: "qmd-build",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 0,
          startedAt: now(),
          completedAt: now(),
          failureKind: "permanent",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary: "normalized markdown missing",
        },
      },
    );
  }
  if (!existsSync(qmdIndexPath)) {
    throw Object.assign(new Error("qmd build index missing"), {
      commandCheck: {
        name: "qmd-build",
        status: "failed",
        attempts: 1,
        exitCode: 1,
        stdoutBytes: 0,
        stderrBytes: 0,
        startedAt: now(),
        completedAt: now(),
        failureKind: "permanent",
        retryable: false,
        attemptExhausted: true,
        recoveryDecision: "stop_until_fixed",
        errorSummary: "qmd index missing",
      },
    });
  }
  const manifest = {
    schemaVersion: SchemaVersion,
    kind: "qmd_build_manifest",
    itemId: item.itemId,
    runId,
    bookId: item.bookId,
    sourceName: item.sourceName,
    sourceRelativePath: item.sourceRelativePath,
    sourceHash: item.sourceHash,
    normalizedPath: relative(root, item.normalizedPath),
    normalizedContentHash: sha256File(item.normalizedPath),
    qmdIndexLocator: relative(root, qmdIndexPath),
    qmdIndexHash: sha256File(qmdIndexPath),
    configLocator: relative(root, configPath),
    configHash: sha256File(configPath),
    commandCheckNames: qmdNativeCommandCheckNames,
    commandCheckFingerprint: stableHash(qmdNativeCommandCheckNames),
    producerRunId: runnerSessionId,
    createdAt: now(),
  };
  return writeTypedJson(
    qmdBuildManifestPath(item),
    QmdBuildManifestSchema,
    manifest,
  );
}

function qmdBuildEvidence(item) {
  const checkedAt = now();
  const evidenceLocator = qmdBuildManifestLocator(item);
  const manifest = readQmdBuildManifest(item);
  if (manifest == null) {
    return {
      status: "pending",
      checkedAt,
      stage: "qmd-build",
      reason: "qmd_build_manifest_missing",
      artifactIds: [],
      evidenceLocator,
    };
  }
  const normalizedPath = isAbsolute(item.normalizedPath)
    ? item.normalizedPath
    : join(root, item.normalizedPath);
  const expectedNormalizedLocator = relative(root, normalizedPath);
  const expectedQmdIndexLocator = relative(root, qmdIndexPath);
  const expectedConfigLocator = relative(root, configPath);
  const normalizedExists = existsSync(normalizedPath);
  const indexExists = existsSync(qmdIndexPath);
  const configExists = existsSync(configPath);
  const commandNames = Array.isArray(manifest.commandCheckNames)
    ? manifest.commandCheckNames
    : [];
  const commandNamesMatch =
    (
      commandNames.length === expectedQmdNativeCommandCheckCount &&
      new Set(commandNames).size === expectedQmdNativeCommandCheckCount &&
      qmdNativeCommandCheckNames.every((name) => commandNames.includes(name))
    ) ||
    (
      commandNames.length === expectedCommandCheckCount &&
      new Set(commandNames).size === expectedCommandCheckCount &&
      requiredCommandCheckNames.every((name) => commandNames.includes(name))
    );
  const expectedCommandFingerprints = new Set([
    stableHash(qmdNativeCommandCheckNames),
    stableHash(requiredCommandCheckNames),
  ]);
  const mismatch = [
    manifest.runId === runId ? null : "run_id_mismatch",
    manifest.itemId === item.itemId ? null : "item_id_mismatch",
    manifest.bookId === item.bookId ? null : "book_id_mismatch",
    manifest.sourceRelativePath === item.sourceRelativePath
      ? null
      : "source_path_mismatch",
    manifest.sourceHash === item.sourceHash ? null : "source_hash_mismatch",
    manifest.normalizedPath === expectedNormalizedLocator
      ? null
      : "normalized_path_mismatch",
    normalizedExists ? null : "normalized_file_missing",
    normalizedExists && manifest.normalizedContentHash === sha256File(normalizedPath)
      ? null
      : normalizedExists ? "normalized_content_hash_mismatch" : null,
    manifest.qmdIndexLocator === expectedQmdIndexLocator
      ? null
      : "qmd_index_locator_mismatch",
    indexExists ? null : "qmd_index_missing",
    manifest.configLocator === expectedConfigLocator
      ? null
      : "config_locator_mismatch",
    configExists ? null : "config_missing",
    commandNamesMatch ? null : "command_check_names_mismatch",
    expectedCommandFingerprints.has(manifest.commandCheckFingerprint)
      ? null
      : "command_check_fingerprint_mismatch",
  ].find(Boolean);
  const artifactId = qmdBuildArtifactId(
    item,
    manifest.normalizedContentHash ?? "missing",
  );
  if (mismatch != null) {
    return {
      status: "stale",
      checkedAt,
      stage: "qmd-build",
      reason: `qmd_build_manifest_invalid:${mismatch}`,
      artifactIds: [artifactId],
      evidenceLocator,
      producerRunId: manifest.producerRunId,
      bookId: manifest.bookId,
      sourceHash: manifest.sourceHash,
      normalizedContentHash: manifest.normalizedContentHash,
    };
  }
  return {
    status: "succeeded",
    checkedAt,
    stage: "qmd-build",
    artifactIds: [artifactId],
    evidenceLocator,
    producerRunId: manifest.producerRunId,
    bookId: manifest.bookId,
    sourceHash: manifest.sourceHash,
    normalizedContentHash: manifest.normalizedContentHash,
  };
}

function graphQueryEvidence(checkpoint) {
  const checkedAt = now();
  const checks = (checkpoint.commandChecks ?? [])
    .filter((check) => graphQueryCommandCheckNames.includes(check.name));
  const names = new Set(checks.map((check) => check.name));
  const failed = checks.find((check) => check.status !== "passed");
  if (failed) {
    return {
      status: "failed",
      checkedAt,
      stage: failed.name,
      reason: "graph_query_command_check_failed",
      artifactIds: [],
    };
  }
  const missing = graphQueryCommandCheckNames.find((name) => !names.has(name));
  if (missing) {
    return {
      status: "pending",
      checkedAt,
      stage: missing,
      reason: "graph_query_check_missing",
      artifactIds: [],
    };
  }
  if (
    checks.length !== graphQueryCommandCheckNames.length ||
    names.size !== graphQueryCommandCheckNames.length
  ) {
    return {
      status: "pending",
      checkedAt,
      stage: "graph-query-command-checks",
      reason: "graph_query_check_set_incomplete",
      artifactIds: [],
    };
  }
  return {
    status: "succeeded",
    checkedAt,
    stage: "qmd-query-graphrag-json",
    artifactIds: [],
  };
}

function commandCheckSetEvidence(checkpoint) {
  const checkedAt = now();
  const commandChecks = checkpoint.commandChecks ?? [];
  const names = commandChecks.map((check) => check.name);
  const unique = new Set(names);
  const missing = requiredCommandCheckNames.filter((name) => !unique.has(name));
  const unexpected = names.filter((name) => !requiredCommandCheckNames.includes(name));
  const failed = commandChecks.find((check) => check.status !== "passed");
  if (
    commandChecks.length === expectedCommandCheckCount &&
    unique.size === expectedCommandCheckCount &&
    missing.length === 0 &&
    unexpected.length === 0 &&
    failed == null
  ) {
    return {
      status: "succeeded",
      checkedAt,
      stage: "command-checks",
      artifactIds: [],
    };
  }
  return {
    status: failed != null ? "failed" : "pending",
    checkedAt,
    stage: failed?.name ?? unexpected[0] ?? missing[0] ?? "command-checks",
    reason: failed != null
      ? "command_check_failed"
      : unexpected.length > 0
        ? "command_check_unexpected"
        : missing.length > 0
          ? "command_check_missing"
          : "command_check_set_incomplete",
    artifactIds: [],
  };
}

function reopenRecoveryFromStatus(reopenStatus) {
  if (reopenStatus.status !== "failed") {
    return {
      recoveryDecision: "continue_pending",
      failureKind: undefined,
      retryable: undefined,
      retryExhausted: undefined,
      nextRetryAt: undefined,
      retryDelaySeconds: undefined,
    };
  }
  const failedCheck = reopenStatus.stage == null
    ? null
    : reopenStatus.commandChecks?.find((check) =>
      check.name === reopenStatus.stage && check.status === "failed"
    );
  if (
    failedCheck?.failureKind === "transient" &&
    failedCheck.retryable === true
  ) {
    return {
      recoveryDecision: "retry_same_run_id",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      nextRetryAt: failedCheck.nextRetryAt,
      retryDelaySeconds: failedCheck.retryDelaySeconds,
      retryBudgetSeconds,
      waitingForProviderRecovery: true,
    };
  }
  const classified = classifyFailure(
    [
      reopenStatus.reason,
      failedCheck?.errorSummary,
    ].filter(Boolean).join("\n"),
  );
  if (classified.failureKind === "transient" && classified.retryable === true) {
    return {
      recoveryDecision: "retry_same_run_id",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      nextRetryAt: failedCheck?.nextRetryAt,
      retryDelaySeconds: failedCheck?.retryDelaySeconds,
      retryBudgetSeconds,
      waitingForProviderRecovery: true,
    };
  }
  return {
    recoveryDecision: "continue_pending",
    failureKind: failedCheck?.failureKind,
    retryable: failedCheck?.retryable,
    retryExhausted: undefined,
    nextRetryAt: undefined,
    retryDelaySeconds: undefined,
    retryBudgetSeconds: undefined,
    waitingForProviderRecovery: false,
  };
}

function downgradeCompletedIfClosedLoopInvalid(item, checkpoint) {
  if (checkpoint.status !== "completed") return checkpoint;
  const commandCheckStatus = commandCheckSetEvidence(checkpoint);
  const qmdBuildStatus = qmdBuildEvidence(item);
  const graphBuildStatus = graphBuildEvidence(item);
  const graphQueryStatus = graphQueryEvidence(checkpoint);
  if (
    commandCheckStatus.status === "succeeded" &&
    qmdBuildStatus.status === "succeeded" &&
    graphBuildStatus.status === "succeeded" &&
    graphQueryStatus.status === "succeeded"
  ) {
    return {
      ...checkpoint,
      qmdBuildStatus,
      graphBuildStatus,
      graphQueryStatus,
    };
  }
  const reopenStatus = commandCheckStatus.status !== "succeeded"
    ? commandCheckStatus
    : qmdBuildStatus.status !== "succeeded"
      ? qmdBuildStatus
    : graphBuildStatus.status !== "succeeded"
      ? graphBuildStatus
      : graphQueryStatus;
  const reopenRecovery = reopenRecoveryFromStatus({
    ...reopenStatus,
    commandChecks: checkpoint.commandChecks ?? [],
  });
  event({
    itemId: item.itemId,
    event: "item_completed_reopened",
    status: "pending",
    recoveryDecision: reopenRecovery.recoveryDecision,
    failureKind: reopenRecovery.failureKind,
    retryable: reopenRecovery.retryable,
    attemptExhausted: reopenRecovery.retryExhausted,
    failedStage: reopenStatus.stage,
    metadata: {
      qmdBuildStatus,
      graphBuildStatus,
      graphQueryStatus,
      commandCheckStatus,
    },
  });
  return {
    ...checkpoint,
    status: "pending",
    completedAt: undefined,
    recoveryDecision: reopenRecovery.recoveryDecision,
    failureKind: reopenRecovery.failureKind,
    retryable: reopenRecovery.retryable,
    retryExhausted: reopenRecovery.retryExhausted,
    failedStage: reopenStatus.stage,
    nextRetryAt: reopenRecovery.nextRetryAt,
    retryDelaySeconds: reopenRecovery.retryDelaySeconds,
    retryBudgetSeconds: reopenRecovery.retryBudgetSeconds,
    qmdBuildStatus,
    graphBuildStatus,
    graphQueryStatus,
    metadata: {
      ...(checkpoint.metadata ?? {}),
      reopenedFromCompleted: true,
      reopenReason: reopenStatus.reason,
      commandCheckStatus,
      ...(reopenRecovery.waitingForProviderRecovery == null
        ? {}
        : { waitingForProviderRecovery: reopenRecovery.waitingForProviderRecovery }),
    },
  };
}

function recoverOrphanedRunningCheckpoint(item, checkpoint) {
  if (!runningCheckpointIsOrphaned(checkpoint)) return checkpoint;
  const detectedAt = now();
  const recovered = {
    ...checkpoint,
    status: "pending",
    failedAt: undefined,
    errorSummary: checkpoint.errorSummary ?? "runner process is not alive",
    failureKind: "transient",
    retryable: true,
    retryExhausted: false,
    recoveryDecision: "retry_same_run_id",
    failedStage: checkpoint.failedStage ?? "runner_orphaned",
    nextRetryAt: undefined,
    retryDelaySeconds: undefined,
    orphanedRunnerDetectedAt: detectedAt,
    metadata: {
      ...(checkpoint.metadata ?? {}),
      orphanedRunnerRecovered: true,
      orphanedRunnerHost: checkpoint.runnerHost ?? "unknown",
      orphanedRunnerPid: checkpoint.runnerPid ?? "unknown",
      orphanedRunnerDetectedAt: detectedAt,
    },
  };
  event({
    itemId: item.itemId,
    event: "item_running_recovered",
    status: "pending",
    message: recovered.errorSummary,
    failureKind: recovered.failureKind,
    retryable: true,
    recoveryDecision: "retry_same_run_id",
    failedStage: recovered.failedStage,
    metadata: {
      runnerHost: checkpoint.runnerHost,
      runnerPid: checkpoint.runnerPid,
      runnerHeartbeatAt: checkpoint.runnerHeartbeatAt,
      orphanedRunnerDetectedAt: detectedAt,
    },
  });
  return recovered;
}

function checkpointIsRecoveredRunnerOrphan(checkpoint) {
  return checkpoint?.metadata?.orphanedRunnerRecovered === true &&
    checkpoint.failedStage === "runner_orphaned" &&
    checkpoint.metadata?.waitingForProviderRecovery !== true;
}

function providerRecoveryDelaySeconds(checkpoint) {
  const lastAttempt = Math.max(
    1,
    checkpoint?.attempts ?? checkpoint?.commandChecks?.at(-1)?.attempts ?? 1,
  );
  const nextAttempt = Math.max(lastAttempt + 1, maxTransientCommandAttempts + 1);
  return retryDelaySecondsForAttempt(nextAttempt);
}

function recoverProviderTransientCheckpoint(item, checkpoint) {
  if (
    !["failed", "pending"].includes(checkpoint.status) ||
    !checkpointHasTransientFailure(checkpoint) ||
    checkpointIsRecoveredRunnerOrphan(checkpoint)
  ) {
    return checkpoint;
  }
  if (
    checkpoint.metadata?.waitingForProviderRecovery === true &&
    (
      !providerRecoveryWaitAvailable(checkpoint) ||
      (
        checkpoint.status === "pending" &&
        checkpoint.failureKind === "transient" &&
        checkpoint.retryable === true &&
        checkpoint.recoveryDecision === "retry_same_run_id" &&
        checkpoint.nextRetryAt != null
      )
    )
  ) {
    return checkpoint;
  }

  const existingWaitCount = providerRecoveryWaitCount(checkpoint);
  const waitCount = existingWaitCount > 0
    ? existingWaitCount
    : nextProviderRecoveryWaitCount(checkpoint);
  const delaySeconds = checkpoint.nextRetryAt != null
    ? Math.max(
        0,
        Math.ceil((epochMs(checkpoint.nextRetryAt) - Date.now()) / 1000),
      )
    : providerRecoveryDelaySeconds(checkpoint);
  const nextRetryAt = checkpoint.nextRetryAt ?? isoAfterSeconds(delaySeconds);
  const retryStartedAt = checkpoint.retryStartedAt ?? checkpoint.failedAt ?? now();
  const retryProbe = { ...checkpoint, retryStartedAt };
  const providerRecoveryReason =
    checkpoint.metadata?.providerRecoveryReason ??
    providerRecoveryReasonFromFailureText(checkpointFailureText(checkpoint)) ??
    (
      checkpoint.retryExhausted === true
        ? "legacy_retry_exhausted_transient"
        : retryBudgetExhausted(retryProbe)
          ? "retry_budget_window_elapsed"
          : "transient_failure_recovered"
    );
  const recovered = {
    ...checkpoint,
    status: "pending",
    failedAt: undefined,
    failureKind: "transient",
    retryable: true,
    retryExhausted: false,
    recoveryDecision: "retry_same_run_id",
    retryStartedAt,
    nextRetryAt,
    retryDelaySeconds: delaySeconds,
    runnerHeartbeatAt: now(),
    metadata: {
      ...(checkpoint.metadata ?? {}),
      waitingForProviderRecovery: true,
      providerRecoveryWaitStartedAt:
        checkpoint.metadata?.providerRecoveryWaitStartedAt ?? now(),
      providerRecoveryReason,
      providerRecoveryWaitCount: waitCount,
      maxProviderRecoveryWaits,
    },
  };
  event({
    itemId: item.itemId,
    event: "item_provider_recovery_wait",
    status: "pending",
    message: recovered.errorSummary,
    failureKind: "transient",
    retryable: true,
    attemptExhausted: false,
    recoveryDecision: "retry_same_run_id",
    failedStage: recovered.failedStage,
    metadata: {
      nextRetryAt,
      retryDelaySeconds: delaySeconds,
      retryBudgetSeconds,
      elapsedRetrySeconds: elapsedRetrySeconds(recovered),
      providerRecoveryWaitCount: waitCount,
      maxProviderRecoveryWaits,
    },
  });
  return recovered;
}

function recoverProviderTransientCheckpoints(items, checkpoints) {
  let recoveredCount = 0;
  for (const item of items) {
    const checkpoint = checkpoints.get(item.itemId);
    if (checkpoint == null) continue;
    const activeItem = runtimeItemForCheckpoint(item, checkpoint);
    const recovered = recoverProviderTransientCheckpoint(activeItem, checkpoint);
    if (recovered === checkpoint) continue;
    saveCheckpoint(activeItem, recovered);
    checkpoints.set(item.itemId, recovered);
    recoveredCount += 1;
  }
  return recoveredCount;
}

function updateManifest(manifest, checkpoints) {
  manifest.totalItems = checkpoints.length;
  manifest.itemIds = checkpoints.map((item) => item.itemId);
  const pending = checkpoints.filter((item) => item.status === "pending").length;
  const running = checkpoints.filter((item) => item.status === "running").length;
  const completed = checkpoints.filter((item) => item.status === "completed").length;
  const skipped = checkpoints.filter((item) => item.status === "skipped").length;
  const failed = checkpoints.filter((item) => item.status === "failed").length;
  const importedCompleted = checkpoints.filter((item) =>
    item.metadata?.seededFromCompletedManifest != null
  ).length;
  manifest.pendingItems = pending;
  manifest.runningItems = running;
  manifest.completedItems = completed;
  manifest.skippedItems = skipped;
  manifest.importedCompletedItems = importedCompleted;
  manifest.failedItems = failed;
  manifest.expectedCommandCheckCount = expectedCommandCheckCount;
  manifest.maxCommandAttempts = maxCommandAttempts;
  manifest.maxTransientCommandAttempts = maxTransientCommandAttempts;
  manifest.maxResumePasses = maxResumePasses;
  manifest.retryBaseDelaySeconds = retryBaseDelaySeconds;
  manifest.retryMaxDelaySeconds = retryMaxDelaySeconds;
  manifest.retryBudgetSeconds = retryBudgetSeconds;
  manifest.maxProviderRecoveryWaits = maxProviderRecoveryWaits;
  manifest.commandTimeoutSeconds = commandTimeoutSeconds;
  manifest.heartbeatIntervalSeconds = heartbeatIntervalSeconds;
  manifest.updatedAt = now();
  const providerWaitLimitReached =
    running === 0 &&
    checkpoints.some((item) =>
      item.status === "pending" &&
      item.failureKind === "transient" &&
      item.retryable === true &&
      item.recoveryDecision === "retry_same_run_id" &&
      item.metadata?.providerRecoveryWaitLimitReached === true
    );
  if (failed > 0) {
    manifest.status = "failed";
    manifest.failedAt = manifest.failedAt ?? now();
    delete manifest.completedAt;
  } else if (completed === manifest.totalItems) {
    manifest.status = "completed";
    manifest.completedAt = manifest.completedAt ?? now();
    delete manifest.failedAt;
  } else if ((pending === 0 && running === 0) || providerWaitLimitReached) {
    manifest.status = "incomplete";
    delete manifest.completedAt;
    delete manifest.failedAt;
  } else {
    manifest.status = "running";
    delete manifest.completedAt;
    delete manifest.failedAt;
  }
  const parsed = BatchRunManifestSchema.parse(withoutUndefined(manifest));
  if (!statusJson) {
    writeTypedJson(manifestPath, BatchRunManifestSchema, parsed);
    writeRecoverySummary(parsed, checkpoints);
  }
  return parsed;
}

function persistFailFastInterruptedManifest(manifest, checkpoints, reason) {
  const refreshed = updateManifest(manifest, checkpoints);
  const hasFailedItem = checkpoints.some((item) => item.status === "failed");
  if (hasFailedItem) return refreshed;
  const interrupted = BatchRunManifestSchema.parse(withoutUndefined({
    ...refreshed,
    status: "incomplete",
    completedAt: undefined,
    failedAt: undefined,
    updatedAt: now(),
    metadata: {
      ...(refreshed.metadata ?? {}),
      interruptedByFailFast: true,
      interruptedReason: reason,
    },
  }));
  if (!statusJson) {
    writeTypedJson(manifestPath, BatchRunManifestSchema, interrupted);
    writeRecoverySummary(interrupted, checkpoints);
  }
  return interrupted;
}

function buildRecoverySummary(manifest, checkpoints) {
  const items = checkpoints.map((item) => {
    const qmdStatus = qmdBuildEvidence(item);
    const commandCheckStatus = commandCheckSetEvidence(item);
    const graphStatus = graphBuildEvidence(item);
    const graphQueryStatus = graphQueryEvidence(item);
    const failedCommands = (item.commandChecks ?? [])
      .filter((check) => check.status === "failed");
    const failedCommand = failedCommands.at(-1);
    const waitingForProviderRecovery =
      item.status === "pending" &&
      item.failureKind === "transient" &&
      item.retryable === true &&
      item.recoveryDecision === "retry_same_run_id" &&
      item.metadata?.waitingForProviderRecovery === true;
    return withoutUndefined({
      itemId: item.itemId,
      sourceName: item.sourceName,
      bookId: item.bookId,
      status: item.status,
      attempts: item.attempts,
      qmdBuildStatus: redactJsonValue(qmdStatus),
      commandCheckStatus: redactJsonValue(commandCheckStatus),
      graphBuildStatus: redactJsonValue(graphStatus),
      graphQueryStatus: redactJsonValue(graphQueryStatus),
      failureKind: item.failureKind,
      retryable: item.retryable,
      retryExhausted: item.retryExhausted,
      recoveryDecision: item.recoveryDecision,
      failedStage: item.failedStage,
      providerStatusCode: failedCommand?.providerStatusCode,
      retryAfterSeconds: failedCommand?.retryAfterSeconds,
      nextRetryAt: item.nextRetryAt,
      retryDelaySeconds: item.retryDelaySeconds,
      retryBudgetSeconds: item.retryBudgetSeconds,
      providerRecoveryWaitCount: waitingForProviderRecovery
        ? providerRecoveryWaitCount(item)
        : undefined,
      maxProviderRecoveryWaits: waitingForProviderRecovery
        ? Number(item.metadata?.maxProviderRecoveryWaits ?? maxProviderRecoveryWaits)
        : undefined,
      providerRecoveryReason: waitingForProviderRecovery
        ? item.metadata?.providerRecoveryReason
        : undefined,
      runnerSessionId: item.runnerSessionId,
      runnerHost: item.runnerHost,
      runnerPid: item.runnerPid,
      runnerHeartbeatAt: item.runnerHeartbeatAt,
      orphanedRunnerDetectedAt: item.orphanedRunnerDetectedAt,
      currentCommand: item.currentCommand,
      activeCommand: item.activeCommand ?? item.currentCommand,
      currentCommandStartedAt: item.currentCommandStartedAt,
      waitingForProviderRecovery,
      reopenedFromStatus: item.metadata?.reopenedFromStatus,
      reopenedToStatus: item.metadata?.reopenedToStatus,
      reopenedFromRecoveryDecision: item.metadata?.reopenedFromRecoveryDecision,
      repairReason: item.metadata?.repairReason,
      repairFailureText: item.metadata?.repairFailureText,
      repairedProjection: item.metadata?.repairedProjection,
      repairEvidenceLocator: item.metadata?.repairEvidenceLocator,
      reusedProducerRunIds: item.metadata?.reusedProducerRunIds,
      normalCommandChecksRequired: item.metadata?.normalCommandChecksRequired,
      settingsProjectionDecision: item.metadata?.settingsProjectionDecision,
      settingsProjectionRewritten: item.metadata?.settingsProjectionRewritten,
      settingsProjectionSourceFingerprint:
        item.metadata?.settingsProjectionSourceFingerprint,
      settingsProjectionProjectConfigLocator:
        item.metadata?.settingsProjectionProjectConfigLocator,
      settingsProjectionLocator: item.metadata?.settingsProjectionLocator,
      settingsProjectionEvidenceLocator:
        item.metadata?.settingsProjectionEvidenceLocator,
      settingsProjectionReason: item.metadata?.settingsProjectionReason,
      localArtifactGateRepairRequiresRealRebuild:
        item.metadata?.localArtifactGateRepairRequiresRealRebuild,
      localArtifactGateRepairRebuildStage:
        item.metadata?.localArtifactGateRepairRebuildStage,
      ...providerAuthSummaryProjection(item),
      errorSummary: item.errorSummary ? redacted(item.errorSummary) : undefined,
    });
  });
  const counts = items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  const retryableItems = items.filter((item) =>
    item.retryable === true && item.status !== "completed"
  );
  return BatchRecoverySummarySchema.parse(withoutUndefined({
    schemaVersion: SchemaVersion,
    runId,
    generatedAt: now(),
    manifest: {
      status: manifest.status,
      totalItems: manifest.totalItems,
      pendingItems: manifest.pendingItems,
      runningItems: manifest.runningItems,
      completedItems: manifest.completedItems,
      skippedItems: manifest.skippedItems,
      failedItems: manifest.failedItems,
      updatedAt: manifest.updatedAt,
      completedAt: manifest.completedAt,
      failedAt: manifest.failedAt,
    },
    counts,
    retryPolicy: {
      maxCommandAttempts,
      maxTransientCommandAttempts,
      maxResumePasses,
      retryBaseDelaySeconds,
      retryMaxDelaySeconds,
      retryBudgetSeconds,
      maxProviderRecoveryWaits,
      commandTimeoutSeconds,
      heartbeatIntervalSeconds,
    },
    recoveryDecision: recoveryDecisionForBatch(checkpoints),
    retryableItemCount: retryableItems.length,
    nextRetryAt: retryableItems
      .map((item) => item.nextRetryAt)
      .filter(Boolean)
      .sort()[0],
    items,
  }));
}

function writeRecoverySummary(manifest, checkpoints) {
  const summary = buildRecoverySummary(manifest, checkpoints);
  writeTypedJson(recoverySummaryPath, BatchRecoverySummarySchema, summary);
  return summary;
}

function printStatusAndExit(manifest, checkpoints) {
  process.stdout.write(
    JSON.stringify(buildRecoverySummary(manifest, checkpoints), null, 2) + "\n",
  );
}

function recoveryDecisionForBatch(checkpoints) {
  if (checkpoints.some((item) => shouldStopBatchBeforeProcessing(item))) {
    return "stop_until_fixed";
  }
  if (checkpoints.some((item) =>
    item.status !== "completed" &&
    (item.retryable === true || item.recoveryDecision === "retry_same_run_id")
  )) {
    return "retry_same_run_id";
  }
  if (checkpoints.some((item) =>
    item.status === "pending" ||
    item.status === "running" ||
    item.status === "skipped" ||
    canRepairLocalArtifactGate(item)
  )) {
    return "continue_pending";
  }
  if (checkpoints.some((item) => item.status === "failed")) {
    return "stop_until_fixed";
  }
  return "none";
}

function migrateEventLog(checkpoints) {
  if (!existsSync(eventsPath)) return;
  const byItemId = new Map(checkpoints.map((item) => [item.itemId, item]));
  const lines = readFileSync(eventsPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  const migrated = lines.map((line) => {
    const item = BatchEventLogSchema.parse(JSON.parse(line));
    const sanitized = BatchEventLogSchema.parse({
      ...item,
      message: item.message ? redacted(item.message) : undefined,
      metadata: item.metadata == null ? undefined : redactJsonValue(item.metadata),
    });
    const checkpoint = item.itemId ? byItemId.get(item.itemId) : undefined;
    const check = checkpoint?.commandChecks?.find((value) =>
      value.status === "failed" && (!sanitized.command || value.name === sanitized.command),
    );
    const isFailureEvent = [
      "command_failed",
      "command_retry_exhausted",
      "item_failed",
    ].includes(sanitized.event);
    if (!isFailureEvent || !checkpoint) return sanitized;
    const inferredFailure = classifyFailure(
      [sanitized.message, check?.errorSummary, checkpoint.errorSummary]
        .filter(Boolean)
        .join("\n"),
    );
    const knownFailure = inferredFailure.failureKind !== "unknown";
    const failureKind = knownFailure
      ? inferredFailure.failureKind
      : sanitized.failureKind ?? check?.failureKind ?? checkpoint.failureKind ??
        inferredFailure.failureKind;
    const retryable = knownFailure
      ? inferredFailure.retryable
      : sanitized.retryable ?? check?.retryable ?? checkpoint.retryable ??
        inferredFailure.retryable;
    const failedStage = sanitized.failedStage ?? check?.name ?? checkpoint.failedStage;
    const attemptExhausted = sanitized.attemptExhausted ??
      (sanitized.event === "command_failed" &&
        typeof sanitized.metadata?.attempt === "number"
        ? sanitized.metadata.attempt >= (check?.attempts ?? maxCommandAttempts)
        : check?.attemptExhausted ?? checkpoint.retryExhausted);
    return BatchEventLogSchema.parse({
      ...sanitized,
      failureKind,
      retryable,
      retryAfterSeconds: sanitized.retryAfterSeconds ?? check?.retryAfterSeconds,
      attemptExhausted,
      providerStatusCode: sanitized.providerStatusCode ?? check?.providerStatusCode,
      recoveryDecision:
        failureKind === "transient" && retryable
          ? "retry_same_run_id"
          : sanitized.event === "command_retry_exhausted"
            ? "stop_until_fixed"
            : attemptExhausted === true
              ? "stop_until_fixed"
              : sanitized.recoveryDecision ??
                (retryable ? "retry_same_run_id" : "stop_until_fixed"),
      failedStage,
    });
  });
  const exhaustedEvents = new Set(migrated
    .filter((item) => item.event === "command_retry_exhausted")
    .map((item) => `${item.itemId ?? ""}:${item.command ?? ""}`));
  for (const checkpoint of checkpoints) {
    if (checkpoint.status !== "failed") continue;
    for (const check of checkpoint.commandChecks ?? []) {
      if (check.status !== "failed" || !check.attemptExhausted) continue;
      const key = `${checkpoint.itemId}:${check.name}`;
      if (exhaustedEvents.has(key)) continue;
      const recoveryDecision = check.retryable ?? checkpoint.retryable
        ? "retry_same_run_id"
        : "stop_until_fixed";
      migrated.push(BatchEventLogSchema.parse({
        schemaVersion: SchemaVersion,
        runId,
        itemId: checkpoint.itemId,
        event: "command_retry_exhausted",
        command: check.name,
        failureKind: check.failureKind ?? checkpoint.failureKind,
        retryable: check.retryable ?? checkpoint.retryable,
        retryAfterSeconds: check.retryAfterSeconds,
        attemptExhausted: true,
        providerStatusCode: check.providerStatusCode,
        recoveryDecision,
        failedStage: check.name,
        at: checkpoint.failedAt ?? check.completedAt ?? now(),
        message: check.errorSummary ?? checkpoint.errorSummary,
        metadata: { migratedFromCheckpoint: true },
      }));
      exhaustedEvents.add(key);
    }
  }
  writeFileSync(
    eventsPath,
    migrated.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );
}

function migrateGraphVaultRawLogs() {
  const targetDir = join(logRoot, "graph_vault_reports");
  const migratedAt = Date.now();
  const migrateEntry = (source, target, sourceLocator) => {
    const stat = statSync(source);
    if (stat.isDirectory()) {
      for (const child of readdirSync(source)) {
        migrateEntry(
          join(source, child),
          join(target, child),
          `${sourceLocator}/${child}`,
        );
      }
      rmSync(source, { recursive: true, force: true });
      return;
    }
    if (!stat.isFile()) return;
    mkdirSync(dirname(target), { recursive: true });
    const rawLog = readFileSync(source, "utf8");
    writeFileSync(target, redactLog(rawLog), "utf8");
    unlinkSync(source);
    event({
      event: "raw_log_migrated",
      metadata: {
        sourceLocator,
        targetLogRootName: basename(logRoot),
        targetFileName: relative(targetDir, target),
      },
    });
  };
  const migrateDir = (reportsDir, sourceLocatorPrefix) => {
    if (!existsSync(reportsDir)) return;
    mkdirSync(targetDir, { recursive: true });
    for (const name of readdirSync(reportsDir)) {
      const source = join(reportsDir, name);
      const target = join(targetDir, `${migratedAt}-${name}`);
      migrateEntry(source, target, `${sourceLocatorPrefix}/${name}`);
    }
  };
  migrateDir(join(stateRoot, "reports"), "graph_vault/reports");
  for (const item of discoverItems()) {
    migrateDir(
      join(stateRoot, "books", item.bookId, "output", "reports"),
      `graph_vault/books/${item.bookId}/output/reports`,
    );
  }
}

function assertNoBookScopedRawReports() {
  const residuals = [];
  for (const item of discoverItems()) {
    const reportsDir = join(stateRoot, "books", item.bookId, "output", "reports");
    if (!existsSync(reportsDir)) continue;
    const residualNames = readdirSync(reportsDir);
    if (residualNames.length === 0) continue;
    residuals.push({
      bookId: item.bookId,
      sourceName: item.sourceName,
      residualCount: residualNames.length,
    });
    event({
      event: "raw_log_residual_detected",
      metadata: {
        sourceLocator: `graph_vault/books/${item.bookId}/output/reports`,
        logCount: residualNames.length,
      },
    });
  }
  if (residuals.length > 0) {
    throw new Error(
      "book-scoped raw GraphRAG logs remain inside graph_vault: " +
        JSON.stringify(residuals),
    );
  }
}

function qmdRunner() {
  if (
    process.env.QMD_GRAPHRAG_ENABLE_TEST_HOOKS === "1" &&
    initialEnvNames.has("QMD_GRAPHRAG_ENABLE_TEST_HOOKS") &&
    process.env.QMD_GRAPHRAG_TEST_QMD_RUNNER === "1" &&
    initialEnvNames.has("QMD_GRAPHRAG_TEST_QMD_RUNNER") &&
    initialEnvNames.has("QMD_GRAPHRAG_QMD_RUNNER") &&
    process.env.QMD_GRAPHRAG_QMD_RUNNER
  ) {
    return { command: process.execPath, args: [process.env.QMD_GRAPHRAG_QMD_RUNNER] };
  }
  return { command: join(root, "bin", "qmd"), args: [] };
}

function resumeRunnerArgs() {
  if (
    process.env.QMD_GRAPHRAG_ENABLE_TEST_HOOKS === "1" &&
    initialEnvNames.has("QMD_GRAPHRAG_ENABLE_TEST_HOOKS") &&
    process.env.QMD_GRAPHRAG_TEST_RESUME_RUNNER === "1" &&
    initialEnvNames.has("QMD_GRAPHRAG_TEST_RESUME_RUNNER") &&
    initialEnvNames.has("QMD_GRAPHRAG_RESUME_RUNNER") &&
    process.env.QMD_GRAPHRAG_RESUME_RUNNER
  ) {
    return [process.env.QMD_GRAPHRAG_RESUME_RUNNER];
  }
  const scriptPath = join(root, "scripts", "graphrag", "resume-book-workspace.mjs");
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const useSourceRuntime = existsSync(join(root, ".git")) && existsSync(tsxCli);
  return useSourceRuntime
    ? ["--import", "tsx", scriptPath]
    : [scriptPath];
}

function runCommand(item, name, command, args, options = {}) {
  const baseAttempts = options.attempts ?? 1;
  const attempts = options.allowTransientBudget
    ? Math.max(baseAttempts, maxTransientCommandAttempts)
    : baseAttempts;
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = now();
    event({
      itemId: item.itemId,
      event: "command_start",
      command: name,
      metadata: { attempt },
    });
    const heartbeatMonitor = startCommandHeartbeatMonitor(item, name, startedAt);
    let result;
    try {
      result = spawnSync(command, args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
        shell: process.platform === "win32",
        timeout: commandTimeoutSeconds * 1000,
        env: {
          ...process.env,
          INDEX_PATH: qmdIndexPath,
          QMD_CONFIG_DIR: dirname(configPath),
          QMD_GRAPH_VAULT: stateRoot,
          QMD_DOCTOR_DEVICE_PROBE: "0",
          ...(options.env ?? {}),
        },
      });
    } finally {
      heartbeatMonitor?.stop();
      clearCommandHeartbeat(item, name);
    }
    const completedAt = now();
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    writeFileSync(join(logRoot, `${item.itemId}-${name}.out`), redactLog(stdout));
    writeFileSync(join(logRoot, `${item.itemId}-${name}.err`), redactLog(stderr));
    const timeoutMessage =
      result.error?.code === "ETIMEDOUT"
        ? `command timed out after ${commandTimeoutSeconds} seconds`
        : "";
    const failureText = timeoutMessage || stderr || stdout || result.error?.message || "";
    const failure = result.status === 0 ? null : classifyFailure(failureText);
    const projectionFailureMetadata =
      settingsProjectionRejectionMetadataFromText(failureText, name);
    const retryDelaySeconds = failure?.retryAfterSeconds ??
      retryDelaySecondsForAttempt(attempt);
    const shouldRetry =
      result.status !== 0 &&
      Boolean(failure?.retryable) &&
      attempt < attempts &&
      (!options.allowTransientBudget || transientBudgetAvailable(options.checkpoint));
    const recoveryDecision = failure?.retryable
      ? "retry_same_run_id"
      : "stop_until_fixed";
    const nextRetryAt = failure?.retryable
      ? isoAfterSeconds(retryDelaySeconds)
      : undefined;
    const check = {
      name,
      status: result.status === 0 ? "passed" : "failed",
      attempts: attempt,
      exitCode: result.status,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      startedAt,
      completedAt,
      ...(result.status === 0
        ? {}
        : {
            ...failure,
            nextRetryAt,
            retryDelaySeconds,
            attemptExhausted: !shouldRetry,
            recoveryDecision,
            errorSummary: redacted(failureText),
          }),
    };
    last = { check, stdout, stderr, result };
    if (result.status === 0) {
      event({ itemId: item.itemId, event: "command_ok", command: name });
      return last;
    }
    event({
      itemId: item.itemId,
      event: "command_failed",
      command: name,
      message: check.errorSummary,
      failureKind: check.failureKind,
      retryable: check.retryable,
      retryAfterSeconds: check.retryAfterSeconds,
        attemptExhausted: check.attemptExhausted,
        providerStatusCode: check.providerStatusCode,
        recoveryDecision: check.recoveryDecision ??
          (check.retryable ? "retry_same_run_id" : "stop_until_fixed"),
        failedStage: name,
        metadata: {
          attempt,
          exitCode: result.status,
          maxAttempts: attempts,
          retryBudgetSeconds,
          commandTimeoutSeconds,
          retryDelaySeconds: check.retryDelaySeconds,
          elapsedRetrySeconds: options.checkpoint
            ? elapsedRetrySeconds(options.checkpoint)
            : undefined,
          nextRetryAt,
          ...projectionFailureMetadata,
        },
      });
    if (!shouldRetry) break;
    const delayMs = retryDelaySeconds * 1000;
    event({
      itemId: item.itemId,
      event: "command_retry_scheduled",
      command: name,
      failureKind: check.failureKind,
      retryable: check.retryable,
      retryAfterSeconds: check.retryAfterSeconds,
      recoveryDecision: "retry_same_run_id",
      metadata: {
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        nextRetryAt,
        retryBudgetSeconds,
        commandTimeoutSeconds,
      },
    });
    if (options.allowTransientBudget) {
      throw Object.assign(new Error(check.errorSummary), { commandCheck: check });
    }
    sleep(delayMs);
  }
  const summary = last?.check?.errorSummary ?? `${name} failed`;
  if (last?.check?.status === "failed") {
    const exhaustedRecoveryDecision = last.check.retryable
      ? "retry_same_run_id"
      : "stop_until_fixed";
    const exhaustedEvent = {
      itemId: item.itemId,
      event: "command_attempt_budget_exhausted",
      command: name,
      failureKind: last.check.failureKind,
      retryable: last.check.retryable,
      retryAfterSeconds: last.check.retryAfterSeconds,
      attemptExhausted: true,
      providerStatusCode: last.check.providerStatusCode,
      recoveryDecision: exhaustedRecoveryDecision,
      failedStage: name,
      message: last.check.errorSummary,
      metadata: {
        nextRetryAt: last.check.nextRetryAt,
        retryDelaySeconds: last.check.retryDelaySeconds,
        maxAttempts: attempts,
        retryBudgetSeconds,
        commandTimeoutSeconds,
        ...settingsProjectionRejectionMetadataFromText(
          last.check.errorSummary,
          name,
        ),
      },
    };
    event(exhaustedEvent);
    event({
      ...exhaustedEvent,
      event: "command_retry_exhausted",
      metadata: {
        ...exhaustedEvent.metadata,
        compatibilityEvent: "command_attempt_budget_exhausted",
      },
    });
  }
  throw Object.assign(new Error(summary), { commandCheck: last?.check });
}

function qmd(item, name, args, attempts = 1) {
  const runner = qmdRunner();
  return runCommand(item, name, runner.command, [...runner.args, ...args], {
    attempts,
  });
}

function parseResumeOutput(stdout) {
  const text = stdout.trim();
  if (!text) throw new Error("resume-book produced empty stdout");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("\n{");
    if (start >= 0) return JSON.parse(text.slice(start + 1));
    throw new Error("resume-book stdout did not contain a JSON object");
  }
}

function requirePath(path, label) {
  if (!existsSync(path)) {
    throw new Error(`missing ${label}: ${path}`);
  }
}

function normalizeEpubToMarkdown(item) {
  if (existsSync(item.normalizedPath)) return;
  mkdirSync(dirname(item.normalizedPath), { recursive: true });
  const script = String.raw`
import html
import posixpath
import re
import sys
import zipfile
from html.parser import HTMLParser
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

source_path, output_path = sys.argv[1:3]

class MarkdownExtractor(HTMLParser):
    block_tags = {
        "address", "article", "aside", "blockquote", "br", "dd", "div", "dl",
        "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5",
        "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
        "table", "tr", "ul",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.stack = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        self.stack.append(tag)
        if tag in {"script", "style", "noscript"}:
            self.skip += 1
            return
        if tag in self.block_tags:
            self.parts.append("\n")
        if tag == "li":
            self.parts.append("- ")
        if re.fullmatch(r"h[1-6]", tag):
            self.parts.append("#" * int(tag[1]) + " ")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in {"script", "style", "noscript"} and self.skip:
            self.skip -= 1
        if tag in self.block_tags:
            self.parts.append("\n")
        if self.stack:
            self.stack.pop()

    def handle_data(self, data):
        if self.skip:
            return
        text = re.sub(r"\s+", " ", html.unescape(data)).strip()
        if text:
            self.parts.append(text + " ")

    def markdown(self):
        text = "".join(self.parts)
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip() + "\n"

def xml_text(root, xpath, ns):
    item = root.find(xpath, ns)
    if item is None or item.text is None:
        raise ValueError(f"missing EPUB metadata: {xpath}")
    return item.text

def read_epub_html(zf):
    container = ET.fromstring(zf.read("META-INF/container.xml"))
    ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
    opf_path = container.find(".//c:rootfile", ns).attrib["full-path"]
    opf_dir = str(PurePosixPath(opf_path).parent)
    if opf_dir == ".":
        opf_dir = ""
    package = ET.fromstring(zf.read(opf_path))
    ns = {"opf": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
    title = xml_text(package, ".//dc:title", ns)
    manifest = {
        item.attrib["id"]: item.attrib
        for item in package.findall(".//opf:manifest/opf:item", ns)
        if "id" in item.attrib and "href" in item.attrib
    }
    output = [f"# {title}\n"]
    for itemref in package.findall(".//opf:spine/opf:itemref", ns):
        item = manifest.get(itemref.attrib.get("idref", ""))
        if not item:
            continue
        media_type = item.get("media-type", "")
        if "html" not in media_type and "xhtml" not in media_type:
            continue
        href = posixpath.normpath(posixpath.join(opf_dir, item["href"]))
        data = zf.read(href)
        parser = MarkdownExtractor()
        parser.feed(data.decode("utf-8", errors="replace"))
        section = parser.markdown()
        if section:
            output.append(section)
    return "\n\n".join(output)

with zipfile.ZipFile(source_path) as zf:
    markdown = read_epub_html(zf)

with open(output_path, "w", encoding="utf-8") as handle:
    handle.write(markdown)
`;
  runCommand(item, "normalize-epub", pythonBin, [
    "-c",
    script,
    item.sourcePath,
    item.normalizedPath,
  ]);
}

function runGraphResume(item, checkpoint, options = {}) {
  requirePath(pythonBin, "GraphRAG Python");
  let lastResult = null;
  for (let pass = 1; pass <= maxResumePasses; pass += 1) {
    const name = options.repairLocalArtifactGateOnly
      ? `repair-local-artifact-gate-${pass}`
      : `resume-book-${pass}`;
    const result = runCommand(item, name, process.execPath, [
      ...resumeRunnerArgs(),
      "--state-root",
      stateRoot,
      "--source-path",
      item.sourcePath,
      "--source-identity-path",
      item.sourceIdentityPath,
      "--normalized-path",
      item.normalizedPath,
      "--qmd-index-path",
      qmdIndexPath,
      "--config",
      configPath,
      "--python-bin",
      pythonBin,
      "--report-root",
      join(logRoot, "graphrag-reports"),
      "--working-directory",
      root,
      "--query",
      query,
      "--query-method",
      "local",
      ...(options.repairLocalArtifactGateOnly
        ? ["--repair-local-artifact-gate-only"]
        : []),
    ], {
      attempts: maxCommandAttempts,
      allowTransientBudget: true,
      checkpoint,
    });
    lastResult = result;

    let resume;
    try {
      resume = parseResumeOutput(result.stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureText = [message, result.check?.errorSummary]
        .filter(Boolean)
        .join("\n");
      throw Object.assign(new Error(failureText), { commandCheck: result.check });
    }
    event({
      itemId: item.itemId,
      event: options.repairLocalArtifactGateOnly
        ? "local_artifact_gate_repair_pass_completed"
        : "resume_pass_completed",
      status: resume.status === "ready" ? "completed" : "running",
      metadata: {
        pass,
        command: name,
        resumeStatus: resume.status,
        nextStage: resume.nextStage,
        ...settingsProjectionMetadata(resume),
      },
    });
    if (
      (resume.status === "ready" && resume.nextStage == null) ||
      (options.repairLocalArtifactGateOnly && resume.status === "repaired")
    ) {
      return options.repairLocalArtifactGateOnly
        ? { status: "repaired", bookId: resume.bookId, resume }
        : { status: "ready", bookId: resume.bookId, resume };
    }
    if (options.repairLocalArtifactGateOnly && resume.status === "blocked") {
      return { status: "blocked", bookId: resume.bookId, resume };
    }
  }

  throw Object.assign(
    new Error(`resume-book did not reach ready after ${maxResumePasses} passes`),
    { commandCheck: lastResult?.check },
  );
}

function repairLocalArtifactGate(item, checkpoint) {
  const repairResult = runGraphResume(item, checkpoint, {
    repairLocalArtifactGateOnly: true,
  });
  const repairFailureText = redacted(checkpointFailureText(checkpoint));
  const projectionMetadata = settingsProjectionMetadata(repairResult.resume);
  const repairMetadataCandidate = {
    reopenedFromStatus: checkpoint.status,
    reopenedToStatus: "pending",
    reopenedFromRecoveryDecision: checkpoint.recoveryDecision ?? "stop_until_fixed",
    activeCommand: checkpoint.activeCommand ?? checkpoint.currentCommand ??
      checkpoint.failedStage,
    repairReason: repairResult.resume?.repairReason,
    repairFailureText,
    repairedProjection: repairResult.resume?.repairedProjection,
    repairEvidenceLocator: repairResult.resume?.repairEvidenceLocator,
    reusedProducerRunIds: repairResult.resume?.reusedProducerRunIds,
    normalCommandChecksRequired: true,
    ...projectionMetadata,
  };
  let repairMetadata = null;
  try {
    repairMetadata = parseRepairMetadata(repairMetadataCandidate);
  } catch (error) {
    if (repairResult?.status !== "blocked") {
      const reason = redacted(error instanceof Error
        ? error.message
        : String(error));
      event({
        itemId: item.itemId,
        event: "item_local_artifact_gate_repair_blocked",
        status: "pending",
        failureKind: checkpoint.failureKind ?? "permanent",
        retryable: false,
        recoveryDecision: "continue_pending",
        failedStage: checkpoint.failedStage,
        message: reason,
        metadata: {
          repairOnly: true,
          repairedLocalArtifactGate: false,
          resumeStatus: repairResult?.resume?.status,
          reason,
        },
      });
      return {
        ...checkpoint,
        status: "pending",
        bookId: repairResult.bookId ?? checkpoint.bookId,
        failedAt: undefined,
        errorSummary: reason,
        failureKind: checkpoint.failureKind ?? "permanent",
        retryable: false,
        retryExhausted: undefined,
        recoveryDecision: "continue_pending",
        failedStage: checkpoint.failedStage ?? "repair-local-artifact-gate",
        activeCommand: checkpoint.activeCommand ?? checkpoint.currentCommand ??
          checkpoint.failedStage,
        nextRetryAt: undefined,
        retryDelaySeconds: undefined,
        runnerHeartbeatAt: now(),
        commandChecks: [],
        metadata: {
          ...(checkpoint.metadata ?? {}),
          localArtifactGateRepairCompleted: undefined,
          localArtifactGateRepairBlocked: true,
          localArtifactGateRepairBlockedReason: reason,
          waitingForProviderRecovery: false,
        },
      };
    }
  }
  if (repairResult?.status === "blocked") {
    const reason = redacted(repairResult.resume?.reason ?? "repair blocked");
    const requiresRealRebuild =
      repairResult.resume?.requiresRealRebuild === true;
    const rebuildStage = typeof repairResult.resume?.rebuildStage === "string"
      ? repairResult.resume.rebuildStage
      : typeof repairResult.resume?.nextStage === "string"
        ? repairResult.resume.nextStage
        : undefined;
    const recoveryFailureKind = checkpoint.failureKind ?? "permanent";
    const recoveryFailedStage = rebuildStage ?? checkpoint.failedStage ??
      "repair-local-artifact-gate";
    event({
      itemId: item.itemId,
      event: "item_local_artifact_gate_repair_blocked",
      status: "pending",
      failureKind: recoveryFailureKind,
      retryable: false,
      recoveryDecision: "continue_pending",
      failedStage: recoveryFailedStage,
      message: reason,
      metadata: {
        repairOnly: true,
        repairedLocalArtifactGate: false,
        requiresRealRebuild,
        rebuildStage,
        resumeStatus: repairResult.resume?.status,
        reason,
        ...(repairMetadata ?? {}),
      },
    });
    return {
      ...checkpoint,
      status: "pending",
      bookId: repairResult.bookId ?? checkpoint.bookId,
      failedAt: undefined,
      errorSummary: reason,
      failureKind: recoveryFailureKind,
      retryable: false,
      retryExhausted: undefined,
      recoveryDecision: "continue_pending",
      failedStage: recoveryFailedStage,
      activeCommand: checkpoint.activeCommand ?? checkpoint.currentCommand ??
        checkpoint.failedStage,
      nextRetryAt: undefined,
      retryDelaySeconds: undefined,
      runnerHeartbeatAt: now(),
      commandChecks: [],
      metadata: {
        ...(checkpoint.metadata ?? {}),
        ...(repairMetadata ?? {}),
        localArtifactGateRepairCompleted: undefined,
        localArtifactGateRepairBlocked: requiresRealRebuild ? undefined : true,
        localArtifactGateRepairBlockedReason: requiresRealRebuild ? undefined : reason,
        localArtifactGateRepairRequiresRealRebuild: requiresRealRebuild,
        localArtifactGateRepairRebuildStage: rebuildStage,
        waitingForProviderRecovery: false,
      },
    };
  }
  event({
    itemId: item.itemId,
    event: "item_local_artifact_gate_repair_reopened",
    status: "pending",
    failureKind: checkpoint.failureKind ?? "permanent",
    retryable: false,
    recoveryDecision: "continue_pending",
    failedStage: checkpoint.failedStage,
    message: repairFailureText,
    metadata: {
      repairOnly: true,
      repairedLocalArtifactGate: true,
      resumeStatus: repairResult?.resume?.status,
      ...repairMetadata,
    },
  });
  return {
    ...checkpoint,
    status: "pending",
    bookId: repairResult?.bookId ?? checkpoint.bookId,
    failedAt: undefined,
    errorSummary: undefined,
    failureKind: undefined,
    retryable: undefined,
    retryExhausted: undefined,
    recoveryDecision: "continue_pending",
    failedStage: undefined,
    activeCommand: checkpoint.activeCommand ?? checkpoint.currentCommand ??
      checkpoint.failedStage,
    nextRetryAt: undefined,
    retryDelaySeconds: undefined,
    runnerHeartbeatAt: now(),
    commandChecks: [],
    metadata: {
      ...(checkpoint.metadata ?? {}),
      ...repairMetadata,
      localArtifactGateRepairBlocked: undefined,
      localArtifactGateRepairBlockedReason: undefined,
      localArtifactGateRepairCompleted: true,
      waitingForProviderRecovery: false,
    },
  };
}

function parseBookIdFromResume(item) {
  for (let pass = 8; pass >= 1; pass -= 1) {
    const path = join(logRoot, `${item.itemId}-resume-book-${pass}.out`);
    if (!existsSync(path)) continue;
    try {
      const parsed = parseResumeOutput(readFileSync(path, "utf8"));
      if (typeof parsed.bookId === "string") return parsed.bookId;
    } catch {
      continue;
    }
  }
  return undefined;
}

function validateCommandChecks(commandChecks) {
  const names = commandChecks.map((check) => check.name);
  const unique = new Set(names);
  const missing = requiredCommandCheckNames.filter((name) => !unique.has(name));
  const unexpected = names.filter((name) => !requiredCommandCheckNames.includes(name));
  const failed = commandChecks.filter((check) => check.status !== "passed");
  if (
    commandChecks.length !== expectedCommandCheckCount ||
    unique.size !== expectedCommandCheckCount ||
    missing.length ||
    unexpected.length ||
    failed.length
  ) {
    throw new Error(
      `invalid command check set: expected=${expectedCommandCheckCount} ` +
      `actual=${commandChecks.length} missing=${missing.join(",") || "none"} ` +
      `unexpected=${unexpected.join(",") || "none"} failed=${failed.length}`,
    );
  }
}

function runCliChecks(item, checkpoint) {
  const reusableChecks = (checkpoint.commandChecks ?? []).filter((check) =>
    check.status === "passed" && requiredCommandCheckNames.includes(check.name)
  );
  let activeCheckpoint = {
    ...checkpoint,
    commandChecks: reusableChecks,
  };
  if (reusableChecks.length !== (checkpoint.commandChecks ?? []).length) {
    activeCheckpoint = saveCheckpoint(item, activeCheckpoint);
  }
  const checks = [...reusableChecks];
  const seen = new Set(checks.map((check) => check.name));
  const record = (result) => {
    checks.push(result.check);
    seen.add(result.check.name);
    activeCheckpoint = appendCommandCheckCheckpoint(
      item,
      activeCheckpoint,
      result.check,
    );
  };
  const recordQmd = (name, args, attempts = 1) => {
    if (seen.has(name)) return;
    record(qmd(item, name, args, attempts));
  };
  recordQmd("qmd-version", ["--version"]);
  recordQmd("qmd-status", ["status"]);
  recordQmd("qmd-doctor-json", ["doctor", "--json"]);
  recordQmd("qmd-pull", ["pull"]);
  recordQmd("qmd-update", ["update"]);
  recordQmd(
    "qmd-embed",
    ["embed", "--max-docs-per-batch", "1"],
    maxCommandAttempts,
  );
  recordQmd("qmd-ls-books", ["ls", "books"]);
  recordQmd("qmd-search-json", ["search", "--json", "software design complexity"]);
  recordQmd("qmd-search-csv", ["search", "--csv", "software design complexity"]);
  recordQmd("qmd-search-md", ["search", "--md", "software design complexity"]);
  recordQmd("qmd-search-xml", ["search", "--xml", "software design complexity"]);
  recordQmd("qmd-search-files", ["search", "--files", "software design complexity"]);
  recordQmd(
    "qmd-vsearch-json",
    ["vsearch", "--json", "software design complexity"],
    maxCommandAttempts,
  );
  recordQmd("qmd-query-json", ["query", "--json", query], maxCommandAttempts);
  recordQmd(
    "qmd-get-book",
    ["get", `qmd://books/${basename(item.normalizedPath)}`, "-l", "5"],
  );
  recordQmd("qmd-multi-get-json", ["multi-get", "books/*.md", "-l", "1", "--json"]);
  recordQmd("qmd-collection-list", ["collection", "list"]);
  recordQmd("qmd-collection-show-books", ["collection", "show", "books"]);
  recordQmd("qmd-context-list", ["context", "list"]);
  recordQmd("qmd-skills-list-json", ["skills", "list", "--json"]);
  recordQmd("qmd-skills-get-json", ["skills", "get", "qmd", "--json"]);
  recordQmd("qmd-skills-path-json", ["skills", "path", "qmd", "--json"]);
  recordQmd("qmd-skill-show", ["skill", "show"]);
  recordQmd("qmd-dspy-status-json", ["dspy", "status", "--json"]);
  recordQmd("qmd-cleanup", ["cleanup"]);
  writeQmdBuildManifest(item, checks);
  activeCheckpoint = saveCheckpoint(item, {
    ...activeCheckpoint,
    commandChecks: checks,
  });
  recordQmd(
    "qmd-query-auto-json",
    ["query", "--mode", "auto", "--json", query],
    maxCommandAttempts,
  );
  recordQmd(
    "qmd-query-graphrag-json",
    ["query", "--graphrag", "--graph-book-id", item.bookId, "--json", query],
    maxCommandAttempts,
  );
  validateCommandChecks(checks);
  return checks;
}

function runItem(item, checkpoint) {
  normalizeEpubToMarkdown(item);
  const resumeResult = runGraphResume(item, checkpoint);
  const resolvedBookId = resumeResult?.bookId ?? checkpoint.bookId;
  const projectionMetadata = settingsProjectionMetadata(resumeResult?.resume);
  const resolvedItem = {
    ...item,
    sourceIdentityPath: checkpoint.sourceIdentityPath ?? item.sourceIdentityPath,
    sourceHash: checkpoint.sourceHash ?? item.sourceHash,
    normalizedPath: checkpoint.normalizedPath
      ? absoluteRuntimePath(checkpoint.normalizedPath)
      : item.normalizedPath,
    normalizedRel: checkpoint.normalizedPath
      ? relative(root, absoluteRuntimePath(checkpoint.normalizedPath))
      : item.normalizedRel,
    bookId: checkpoint.bookId ?? resolvedBookId,
  };
  if (
    resumeResult?.bookId != null &&
    checkpoint.bookId != null &&
    resumeResult.bookId !== checkpoint.bookId
  ) {
    throw Object.assign(new Error(
      `GraphRAG resume book id mismatch: expected ${checkpoint.bookId} ` +
      `got ${resumeResult.bookId}`,
    ), {
      commandCheck: {
        name: "resume-book",
        status: "failed",
        attempts: 1,
        exitCode: 1,
        stdoutBytes: 0,
        stderrBytes: 0,
        startedAt: now(),
        completedAt: now(),
        failureKind: "permanent",
        retryable: false,
        attemptExhausted: true,
        recoveryDecision: "stop_until_fixed",
        errorSummary: "GraphRAG resume book id mismatch",
      },
    });
  }
  const commandChecks = runCliChecks(resolvedItem, checkpoint);
  const qmdBuildStatus = qmdBuildEvidence(resolvedItem);
  const graphBuildStatus = graphBuildEvidence(resolvedItem);
  const graphQueryStatus = graphQueryEvidence({ commandChecks });
  if (qmdBuildStatus.status !== "succeeded") {
    throw Object.assign(new Error(`qmd build did not succeed: ${qmdBuildStatus.reason}`), {
      commandCheck: {
        name: qmdBuildStatus.stage ?? "qmd-build",
        status: "failed",
        attempts: 1,
        exitCode: 1,
        stdoutBytes: 0,
        stderrBytes: 0,
        startedAt: qmdBuildStatus.checkedAt ?? now(),
        completedAt: now(),
        failureKind: "permanent",
        retryable: false,
        attemptExhausted: true,
        recoveryDecision: "stop_until_fixed",
        errorSummary: qmdBuildStatus.reason ?? "qmd build evidence missing",
      },
    });
  }
  if (graphBuildStatus.status !== "succeeded") {
    const graphBuildCommandCheck = {
      name: graphBuildStatus.stage ?? "graphrag-build",
      status: "failed",
      attempts: 1,
      exitCode: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
      startedAt: graphBuildStatus.checkedAt ?? now(),
      completedAt: now(),
      failureKind: "permanent",
      retryable: false,
      attemptExhausted: true,
      errorSummary: graphBuildStatus.reason,
    };
    throw Object.assign(
      new Error(`GraphRAG build did not succeed: ${graphBuildStatus.reason}`),
      { commandCheck: graphBuildCommandCheck },
    );
  }
  if (graphQueryStatus.status !== "succeeded") {
    throw Object.assign(
      new Error(`GraphRAG query check did not succeed: ${graphQueryStatus.reason}`),
      {
        commandCheck: commandChecks.find((check) =>
          check.name === graphQueryStatus.stage
        ),
      },
    );
  }
  const completed = {
    ...checkpoint,
    status: "completed",
    bookId: resolvedBookId,
    completedAt: now(),
    failedAt: undefined,
    errorSummary: undefined,
    failureKind: undefined,
    retryable: undefined,
    retryExhausted: undefined,
    recoveryDecision: "none",
    failedStage: undefined,
    qmdBuildStatus,
    graphBuildStatus,
    graphQueryStatus,
    commandChecks,
    runnerHeartbeatAt: now(),
    metadata: {
      ...(checkpoint.metadata ?? {}),
      ...projectionMetadata,
    },
  };
  saveCheckpoint(resolvedItem, completed);
  event({ itemId: item.itemId, event: "item_completed", status: "completed" });
  return completed;
}

function buildRecoverableTransientCheckpoint({ item, running, commandCheck, error }) {
  const retryDelaySeconds =
    commandCheck?.retryDelaySeconds ?? retryDelaySecondsForAttempt(running.attempts);
  const nextRetryAt = commandCheck?.nextRetryAt ?? isoAfterSeconds(retryDelaySeconds);
  const retryStartedAt = running.retryStartedAt ?? commandCheck?.completedAt ?? now();
  return {
    ...running,
    status: "pending",
    failedAt: undefined,
    errorSummary: redacted(error instanceof Error ? error.message : String(error)),
    failureKind: commandCheck?.failureKind ?? "transient",
    retryable: true,
    retryExhausted: false,
    recoveryDecision: "retry_same_run_id",
    failedStage: commandCheck?.name,
    retryStartedAt,
    nextRetryAt,
    retryDelaySeconds,
    runnerHeartbeatAt: now(),
    commandChecks: commandCheck
      ? [...(running.commandChecks ?? []), commandCheck]
      : (running.commandChecks ?? []),
    metadata: {
      ...(running.metadata ?? {}),
      waitingForProviderRecovery: true,
      providerRecoveryReason: "transient_failure_recovered",
      lastRetryableFailureAt: now(),
      retryBudgetSeconds,
      maxProviderRecoveryWaits,
      sourceName: item.sourceName,
    },
  };
}

function markItemRunning(item, checkpoint, checkpoints, manifest) {
  const startedAt = now();
  const running = lockedReadWriteTypedJson(
    itemPath(item),
    BatchItemCheckpointSchema,
    (loaded) => {
      const current = loaded ??
        BatchItemCheckpointSchema.parse(withBuildStatusSnapshot(item, checkpoint));
      if (
        current.status !== checkpoint.status ||
        current.attempts !== checkpoint.attempts ||
        current.completedAt !== checkpoint.completedAt ||
        current.failedAt !== checkpoint.failedAt ||
        current.runnerSessionId !== checkpoint.runnerSessionId ||
        current.runnerHeartbeatAt !== checkpoint.runnerHeartbeatAt
      ) {
        throw new Error(
          `checkpoint changed before item start; refusing duplicate runner for ${item.itemId}`,
        );
      }
      return withBuildStatusSnapshot(item, {
        ...current,
        status: "running",
        attempts: current.attempts + 1,
        startedAt: current.startedAt ?? startedAt,
        retryStartedAt: current.retryStartedAt,
        nextRetryAt: undefined,
        retryDelaySeconds: undefined,
        failedAt: undefined,
        errorSummary: undefined,
        failureKind: undefined,
        retryable: undefined,
        retryExhausted: undefined,
        recoveryDecision: "none",
        failedStage: undefined,
        expectedCommandCheckCount,
        maxCommandAttempts,
        maxTransientCommandAttempts,
        maxResumePasses,
        retryBaseDelaySeconds,
        retryMaxDelaySeconds,
        retryBudgetSeconds,
        maxProviderRecoveryWaits,
        commandTimeoutSeconds,
        runnerSessionId,
        runnerHost,
        runnerPid,
        runnerHeartbeatAt: startedAt,
        metadata: {
          ...(current.metadata ?? {}),
          waitingForProviderRecovery: false,
        },
      });
    },
  );
  checkpoints.set(item.itemId, running);
  updateManifest(manifest, Array.from(checkpoints.values()));
  event({ itemId: item.itemId, event: "item_start", status: "running" });
  return running;
}

function retryWindowDelayMs(checkpoint) {
  if (checkpoint?.nextRetryAt == null) return 0;
  return Math.max(0, epochMs(checkpoint.nextRetryAt) - Date.now());
}

function eventRetryWindowDeferred(item, checkpoint, delayMs) {
  if (delayMs <= 0) return;
  event({
    itemId: item.itemId,
    event: "item_retry_window_deferred",
    status: "pending",
    failureKind: checkpoint.failureKind,
    retryable: checkpoint.retryable,
    recoveryDecision: checkpoint.recoveryDecision,
    failedStage: checkpoint.failedStage,
    metadata: {
      nextRetryAt: checkpoint.nextRetryAt,
      delayMs,
      retryDelaySeconds: checkpoint.retryDelaySeconds,
      retryBudgetSeconds,
    },
  });
}

function providerRecoveryWaitLimitReached(items, checkpoints) {
  return items.some((item) => {
    const checkpoint = checkpoints.get(item.itemId);
    return checkpoint?.status === "pending" &&
      checkpoint.retryable === true &&
      checkpoint.failureKind === "transient" &&
      checkpoint.metadata?.waitingForProviderRecovery === true &&
      !providerRecoveryWaitAvailable(checkpoint);
  });
}

function eventProviderRecoveryWaitLimit(items, checkpoints) {
  const limited = items
    .map((item) => ({ item, checkpoint: checkpoints.get(item.itemId) }))
    .filter(({ checkpoint }) =>
      checkpoint?.status === "pending" &&
      checkpoint.retryable === true &&
      checkpoint.failureKind === "transient" &&
      checkpoint.metadata?.waitingForProviderRecovery === true &&
      !providerRecoveryWaitAvailable(checkpoint)
    );
  if (limited.length === 0) return false;
  for (const { item, checkpoint } of limited) {
    const activeItem = runtimeItemForCheckpoint(item, checkpoint);
    const updated = {
      ...checkpoint,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      retryBudgetSeconds: checkpoint.retryBudgetSeconds ?? retryBudgetSeconds,
      metadata: {
        ...(checkpoint.metadata ?? {}),
        waitingForProviderRecovery: true,
        providerRecoveryReason: "provider_recovery_wait_limit_reached",
        providerRecoveryWaitCount: providerRecoveryWaitCount(checkpoint),
        maxProviderRecoveryWaits,
        retryBudgetSeconds,
        providerRecoveryWaitLimitReached: true,
      },
    };
    saveCheckpoint(activeItem, updated);
    checkpoints.set(item.itemId, updated);
  }
  const nextRetryAt = limited
    .map(({ checkpoint }) => checkpoint.nextRetryAt)
    .filter(Boolean)
    .sort()[0];
  event({
    event: "batch_provider_recovery_wait_limit",
    status: "pending",
    recoveryDecision: "retry_same_run_id",
    metadata: {
      limitedItemCount: limited.length,
      maxProviderRecoveryWaits,
      nextRetryAt,
      retryPolicy: "exit_current_runner_recover_same_run_id",
    },
  });
  return true;
}

function shouldStopBatchAfterFailure(checkpoint) {
  return checkpoint?.status === "failed" &&
    checkpoint.retryable === false &&
    checkpoint.recoveryDecision === "stop_until_fixed";
}

function shouldStopBatchBeforeProcessing(checkpoint) {
  if (canRepairLocalArtifactGate(checkpoint)) return false;
  return shouldStopBatchAfterFailure(checkpoint);
}

function emitBatchStoppedAfterNonTransientFailure(checkpoint) {
  const stopReason = checkpointHasDataCompatibilityFailure(checkpoint)
    ? "data_compatibility"
    : checkpointHasUnrecoverableProviderAuthFailure(checkpoint)
      ? "provider_auth"
      : "non_transient";
  const stoppedEventBase = {
    itemId: checkpoint.itemId,
    status: "failed",
    failureKind: checkpoint.failureKind ?? "unknown",
    retryable: false,
    recoveryDecision: "stop_until_fixed",
    failedStage: checkpoint.failedStage,
    message: checkpoint.errorSummary,
    metadata: {
      policy: "stop_current_runner_until_fixed",
      stopReason,
    },
  };
  if (stopReason === "data_compatibility") {
    event({
      ...stoppedEventBase,
      event: "batch_stopped_after_data_compatibility_failure",
    });
  }
  event({
    ...stoppedEventBase,
    event: "batch_stopped_after_non_transient_failure",
    metadata: {
      ...stoppedEventBase.metadata,
      ...(stopReason === "data_compatibility"
        ? { compatibilityEvent: "batch_stopped_after_data_compatibility_failure" }
        : {}),
    },
  });
}

function waitForNextRetryWindow(items, checkpoints) {
  const waiting = items
    .map((item) => ({ item, checkpoint: checkpoints.get(item.itemId) }))
    .filter(({ checkpoint }) =>
      checkpoint?.status === "pending" &&
      checkpoint.retryable === true &&
      retryWindowDelayMs(checkpoint) > 0 &&
      providerRecoveryWaitAvailable(checkpoint)
    )
    .sort((a, b) => epochMs(a.checkpoint.nextRetryAt) - epochMs(b.checkpoint.nextRetryAt));
  const next = waiting[0];
  if (!next) return false;
  const delayMs = retryWindowDelayMs(next.checkpoint);
  event({
    itemId: next.item.itemId,
    event: "batch_wait_retry_window",
    status: "pending",
    failureKind: next.checkpoint.failureKind,
    retryable: next.checkpoint.retryable,
    recoveryDecision: next.checkpoint.recoveryDecision,
    failedStage: next.checkpoint.failedStage,
    metadata: {
      waitingItemCount: waiting.length,
      nextRetryAt: next.checkpoint.nextRetryAt,
      delayMs,
      retryDelaySeconds: next.checkpoint.retryDelaySeconds,
      retryBudgetSeconds,
    },
  });
  sleep(delayMs);
  return true;
}

function main() {
  loadDotenv();
  ensureDirs();
  requirePath(sourceDir, "source directory");
  requirePath(configPath, "qmd config");
  const items = discoverItems();
  if (items.length === 0) {
    throw new Error(`no EPUB files found in ${sourceDir}`);
  }
  let manifest = loadManifest(items);
  const completedSeed = loadCompletedSeed();
  const checkpoints = new Map(items.map((item) => [
    item.itemId,
    loadCheckpoint(item, completedSeed),
  ]));
  if (!statusJson) migrateGraphOutputProducerManifests();
  manifest = updateManifest(manifest, Array.from(checkpoints.values()));
  if (statusJson) {
    printStatusAndExit(manifest, Array.from(checkpoints.values()));
    return;
  }
  if (migrateOnly) {
    migrateEventLog(Array.from(checkpoints.values()));
    migrateGraphVaultRawLogs();
    assertNoBookScopedRawReports();
    const summary = writeRecoverySummary(
      manifest,
      Array.from(checkpoints.values()),
    );
    event({
      event: "batch_state_migrated",
      recoveryDecision: recoveryDecisionForBatch(Array.from(checkpoints.values())),
      metadata: {
        pendingItems: manifest.pendingItems,
        runningItems: manifest.runningItems,
        completedItems: manifest.completedItems,
        skippedItems: manifest.skippedItems,
        failedItems: manifest.failedItems,
        retryableItemCount: summary.retryableItemCount,
      },
    });
    return;
  }

  let processedInPass = true;
  const repairBlockedThisRun = new Set();
  const stopLoggedThisRun = new Set();
  let stopAfterNonTransientFailure = false;
  while (processedInPass) {
    processedInPass = false;
    let deferredForRetryWindow = false;
    const providerAuthReopenedCount =
      applyProviderAuthReopenPass(items, checkpoints);
    if (providerAuthReopenedCount > 0) {
      manifest = updateManifest(manifest, Array.from(checkpoints.values()));
      writeRecoverySummary(manifest, Array.from(checkpoints.values()));
      processedInPass = true;
    }
    const recoveredProviderTransientCount =
      recoverProviderTransientCheckpoints(items, checkpoints);
    if (recoveredProviderTransientCount > 0) {
      manifest = updateManifest(manifest, Array.from(checkpoints.values()));
      writeRecoverySummary(manifest, Array.from(checkpoints.values()));
      processedInPass = true;
    }
    const stopCheckpoint = items
      .map((item) => checkpoints.get(item.itemId))
      .find((checkpoint) => shouldStopBatchBeforeProcessing(checkpoint));
    if (stopCheckpoint) {
      if (!stopLoggedThisRun.has(stopCheckpoint.itemId)) {
        emitBatchStoppedAfterNonTransientFailure(stopCheckpoint);
        stopLoggedThisRun.add(stopCheckpoint.itemId);
      }
      stopAfterNonTransientFailure = true;
      break;
    }
    for (const item of items) {
      if (repairBlockedThisRun.has(item.itemId)) {
        event({
          itemId: item.itemId,
          event: "item_local_artifact_gate_repair_blocked_skip",
          status: "pending",
          recoveryDecision: "continue_pending",
          metadata: {
            reason: "repair blocked earlier in this runner invocation",
          },
        });
        continue;
      }
      let checkpoint = checkpoints.get(item.itemId);
      let activeItem = runtimeItemForCheckpoint(item, checkpoint);
      if (
        shouldStopBatchAfterFailure(checkpoint) &&
        !canRepairLocalArtifactGate(checkpoint)
      ) {
        const recovered = recoverProviderTransientCheckpoint(activeItem, checkpoint);
        if (recovered !== checkpoint) {
          saveCheckpoint(activeItem, recovered);
          checkpoints.set(item.itemId, recovered);
          manifest = updateManifest(manifest, Array.from(checkpoints.values()));
          processedInPass = true;
          continue;
        }
        if (!stopLoggedThisRun.has(checkpoint.itemId)) {
          emitBatchStoppedAfterNonTransientFailure(checkpoint);
          stopLoggedThisRun.add(checkpoint.itemId);
        }
        stopAfterNonTransientFailure = true;
        break;
      }
      if (checkpoint?.status === "completed") {
        event({ itemId: item.itemId, event: "item_skip_completed", status: "completed" });
        continue;
      }
      if (checkpoint?.status === "skipped") {
        if (migrateOnly) {
          event({
            itemId: item.itemId,
            event: "item_skipped",
            status: "skipped",
            metadata: checkpoint.metadata,
          });
          continue;
        }
        checkpoint = {
          ...checkpoint,
          status: "pending",
          recoveryDecision: "continue_pending",
          metadata: {
            ...(checkpoint.metadata ?? {}),
            reopenedSkippedForRealBuild: true,
          },
        };
        activeItem = runtimeItemForCheckpoint(item, checkpoint);
        saveCheckpoint(activeItem, checkpoint);
        checkpoints.set(item.itemId, checkpoint);
        manifest = updateManifest(manifest, Array.from(checkpoints.values()));
        event({
          itemId: item.itemId,
          event: "item_skipped_reopened",
          status: "pending",
          recoveryDecision: "continue_pending",
          metadata: checkpoint.metadata,
        });
      }
      if (checkpoint?.status === "failed" && checkpoint.retryable === false) {
        const recovered = recoverProviderTransientCheckpoint(activeItem, checkpoint);
        if (recovered !== checkpoint) {
          saveCheckpoint(activeItem, recovered);
          checkpoints.set(item.itemId, recovered);
          manifest = updateManifest(manifest, Array.from(checkpoints.values()));
          processedInPass = true;
          continue;
        }
        if (canRepairLocalArtifactGate(checkpoint)) {
          event({
            itemId: item.itemId,
            event: "item_local_artifact_gate_repair",
            status: "running",
            failureKind: checkpoint.failureKind ?? "permanent",
            retryable: false,
            recoveryDecision: "continue_pending",
            failedStage: checkpoint.failedStage,
            message: checkpoint.errorSummary,
          });
          try {
            activeItem = runtimeItemForCheckpoint(item, checkpoint);
            const repaired = repairLocalArtifactGate(activeItem, checkpoint);
            saveCheckpoint(activeItem, repaired);
            checkpoints.set(item.itemId, repaired);
            manifest = updateManifest(manifest, Array.from(checkpoints.values()));
            if (repaired.metadata?.localArtifactGateRepairBlocked === true) {
              repairBlockedThisRun.add(item.itemId);
              event({
                itemId: item.itemId,
                event: "item_local_artifact_gate_repair_blocked_skip",
                status: "pending",
                recoveryDecision: "continue_pending",
                metadata: {
                  reason: repaired.metadata?.localArtifactGateRepairBlockedReason ??
                    "repair blocked earlier in this runner invocation",
                },
              });
            } else {
              processedInPass = true;
            }
          } catch (error) {
            const projectionRejectionMetadata =
              rejectedSettingsProjectionMetadata(error);
            const activeCommand =
              error?.commandCheck?.name ?? checkpoint.activeCommand ??
                checkpoint.currentCommand ?? checkpoint.failedStage ??
                "repair-local-artifact-gate";
            const failed = {
              ...checkpoint,
              status: "failed",
              failedAt: now(),
              errorSummary: redacted(error instanceof Error
                ? error.message
                : String(error)),
              failureKind: "permanent",
              retryable: false,
              retryExhausted: true,
              recoveryDecision: "stop_until_fixed",
              failedStage: "repair-local-artifact-gate",
              activeCommand,
              runnerHeartbeatAt: now(),
              metadata: {
                ...(checkpoint.metadata ?? {}),
                ...projectionRejectionMetadata,
                localArtifactGateRepairFailed: true,
                waitingForProviderRecovery: false,
              },
            };
            const commandCheck = error?.commandCheck;
            if (commandCheck) {
              failed.commandChecks = [
                ...(failed.commandChecks ?? []),
                commandCheck.status === "failed"
                  ? {
                      ...commandCheck,
                      recoveryDecision: commandCheck.recoveryDecision ??
                        failed.recoveryDecision,
                    }
                  : commandCheck,
              ];
            }
            saveCheckpoint(activeItem, failed);
            checkpoints.set(item.itemId, failed);
            manifest = updateManifest(manifest, Array.from(checkpoints.values()));
            event({
              itemId: item.itemId,
              event: "item_local_artifact_gate_repair_failed",
              status: "failed",
              failureKind: "permanent",
              retryable: false,
              recoveryDecision: "stop_until_fixed",
              failedStage: "repair-local-artifact-gate",
              message: failed.errorSummary,
              metadata: {
                activeCommand,
                command: commandCheck?.name,
                ...projectionRejectionMetadata,
              },
            });
            continue;
          }
          continue;
        } else {
          event({
            itemId: item.itemId,
            event: "item_failed_not_retryable",
            status: "failed",
            failureKind: checkpoint.failureKind ?? "unknown",
            retryable: false,
            recoveryDecision: "stop_until_fixed",
            failedStage: checkpoint.failedStage,
            message: checkpoint.errorSummary,
          });
          if (shouldStopBatchAfterFailure(checkpoint)) {
            if (!stopLoggedThisRun.has(checkpoint.itemId)) {
              emitBatchStoppedAfterNonTransientFailure(checkpoint);
              stopLoggedThisRun.add(checkpoint.itemId);
            }
            stopAfterNonTransientFailure = true;
            break;
          }
          continue;
        }
      }
      if (checkpoint?.status === "failed" && checkpoint.retryable === true) {
        activeItem = runtimeItemForCheckpoint(item, checkpoint);
        const recovered = recoverProviderTransientCheckpoint(activeItem, checkpoint);
        if (recovered !== checkpoint) {
          saveCheckpoint(activeItem, recovered);
          checkpoints.set(item.itemId, recovered);
          manifest = updateManifest(manifest, Array.from(checkpoints.values()));
          continue;
        }
        event({
          itemId: item.itemId,
          event: "item_retry_same_run_id",
          status: "running",
          failureKind: checkpoint.failureKind ?? "transient",
          retryable: true,
          recoveryDecision: "retry_same_run_id",
          failedStage: checkpoint.failedStage,
        });
      }
      if (
        checkpoint?.status === "pending" &&
        checkpoint.retryable === true &&
        checkpoint.failureKind === "transient" &&
        checkpoint.retryExhausted === true
      ) {
        activeItem = runtimeItemForCheckpoint(item, checkpoint);
        const recovered = recoverProviderTransientCheckpoint(activeItem, checkpoint);
        saveCheckpoint(activeItem, recovered);
        checkpoints.set(item.itemId, recovered);
        manifest = updateManifest(manifest, Array.from(checkpoints.values()));
        continue;
      }
      if (checkpoint?.status === "running") {
        event({
          itemId: item.itemId,
          event: "item_running_observed",
          status: "running",
          recoveryDecision: "continue_pending",
          metadata: {
            runnerSessionId: checkpoint.runnerSessionId,
            runnerHost: checkpoint.runnerHost,
            runnerPid: checkpoint.runnerPid,
            runnerHeartbeatAt: checkpoint.runnerHeartbeatAt,
            runnerHeartbeatTtlSeconds,
          },
        });
        continue;
      }

      try {
        const starting = checkpoint ?? defaultCheckpoint(item, completedSeed);
        activeItem = runtimeItemForCheckpoint(item, starting);
        const retryWindowDelay = retryWindowDelayMs(starting);
        if (retryWindowDelay > 0) {
          eventRetryWindowDeferred(activeItem, starting, retryWindowDelay);
          deferredForRetryWindow = true;
          continue;
        }
        const activeBook = activeRunningBookCheckpoint(activeItem, checkpoints);
        if (activeBook != null) {
          event({
            itemId: item.itemId,
            event: "item_book_running_observed",
            status: "pending",
            recoveryDecision: "continue_pending",
            metadata: {
              activeItemId: activeBook.itemId,
              bookId: activeItem.bookId,
              runnerSessionId: activeBook.runnerSessionId,
              runnerHost: activeBook.runnerHost,
              runnerPid: activeBook.runnerPid,
              runnerHeartbeatAt: activeBook.runnerHeartbeatAt,
            },
          });
          deferredForRetryWindow = true;
          continue;
        }
        const running = markItemRunning(activeItem, starting, checkpoints, manifest);
        const completed = runItem(activeItem, running);
        checkpoints.set(item.itemId, completed);
        manifest = updateManifest(manifest, Array.from(checkpoints.values()));
        processedInPass = true;
      } catch (error) {
        const running = existsSync(itemPath(item))
          ? loadCheckpoint(activeItem, completedSeed)
          : checkpoint ?? defaultCheckpoint(item, completedSeed);
        activeItem = runtimeItemForCheckpoint(item, running);
        const commandCheck = error?.commandCheck;
        const failureKind = commandCheck?.failureKind ?? "unknown";
        const retryable = commandCheck?.retryable ?? false;
        const canRecoverInThisRun =
          retryable && failureKind === "transient" && transientBudgetAvailable(running);
        if (canRecoverInThisRun) {
          const recoverable = buildRecoverableTransientCheckpoint({
            item: activeItem,
            running,
            commandCheck,
            error,
          });
          saveCheckpoint(activeItem, recoverable);
          checkpoints.set(item.itemId, recoverable);
          manifest = updateManifest(manifest, Array.from(checkpoints.values()));
          event({
            itemId: item.itemId,
            event: "item_retry_deferred",
            status: "pending",
            message: recoverable.errorSummary,
            failureKind: recoverable.failureKind,
            retryable: true,
            attemptExhausted: false,
            providerStatusCode: commandCheck?.providerStatusCode,
            retryAfterSeconds: commandCheck?.retryAfterSeconds,
            recoveryDecision: "retry_same_run_id",
            failedStage: recoverable.failedStage,
            metadata: {
              nextRetryAt: recoverable.nextRetryAt,
              retryDelaySeconds: recoverable.retryDelaySeconds,
              retryBudgetSeconds,
              elapsedRetrySeconds: elapsedRetrySeconds(recoverable),
            },
          });
          processedInPass = true;
          if (failFast) {
            manifest = persistFailFastInterruptedManifest(
              manifest,
              Array.from(checkpoints.values()),
              "recoverable_transient_failure",
            );
            throw error;
          }
          continue;
        }
        const recoverableProviderFailure =
          retryable &&
          failureKind === "transient";
        const providerRecoveryWaitStillAvailable =
          recoverableProviderFailure && providerRecoveryWaitAvailable(running);
        if (recoverableProviderFailure && !providerRecoveryWaitStillAvailable) {
          const waitCount = providerRecoveryWaitCount(running);
          const delaySeconds = providerRecoveryDelaySeconds(running);
          const nextRetryAt = running.nextRetryAt ?? isoAfterSeconds(delaySeconds);
          const limited = {
            ...running,
            status: "pending",
            failedAt: undefined,
            errorSummary: redacted(error instanceof Error
              ? error.message
              : String(error)),
            failureKind: "transient",
            retryable: true,
            retryExhausted: false,
            recoveryDecision: "retry_same_run_id",
            failedStage: commandCheck?.name,
            retryStartedAt: running.retryStartedAt ?? commandCheck?.completedAt ?? now(),
            nextRetryAt,
            retryDelaySeconds: delaySeconds,
            retryBudgetSeconds,
            runnerHeartbeatAt: now(),
            metadata: {
              ...(running.metadata ?? {}),
              waitingForProviderRecovery: true,
              providerRecoveryWaitStartedAt:
                running.metadata?.providerRecoveryWaitStartedAt ?? now(),
              providerRecoveryReason: "provider_recovery_wait_limit_reached",
              providerRecoveryWaitCount: waitCount,
              maxProviderRecoveryWaits,
              retryBudgetSeconds,
              sourceName: activeItem.sourceName,
              providerRecoveryWaitLimitReached: true,
            },
          };
          if (commandCheck) {
            limited.commandChecks = [
              ...(limited.commandChecks ?? []),
              commandCheck.status === "failed"
                ? {
                    ...commandCheck,
                    recoveryDecision: "retry_same_run_id",
                    attemptExhausted: true,
                  }
                : commandCheck,
            ];
          }
          saveCheckpoint(activeItem, limited);
          checkpoints.set(item.itemId, limited);
          manifest = updateManifest(manifest, Array.from(checkpoints.values()));
          event({
            itemId: item.itemId,
            event: "item_provider_recovery_wait_limit_reached",
            status: "pending",
            message: limited.errorSummary,
            failureKind: "transient",
            retryable: true,
            attemptExhausted: true,
            providerStatusCode: commandCheck?.providerStatusCode,
            retryAfterSeconds: commandCheck?.retryAfterSeconds,
            recoveryDecision: "retry_same_run_id",
            failedStage: limited.failedStage,
            metadata: {
              nextRetryAt,
              retryDelaySeconds: delaySeconds,
              retryBudgetSeconds,
              providerRecoveryWaitCount: waitCount,
              maxProviderRecoveryWaits,
              retryPolicy: "scheduler_resume_same_run_after_provider_wait_limit",
            },
          });
          stopAfterNonTransientFailure = true;
          break;
        }
        const providerRecoveryDelay = recoverableProviderFailure
          ? providerRecoveryDelaySeconds(running)
          : undefined;
        const recoveryWaitCount = recoverableProviderFailure
          ? nextProviderRecoveryWaitCount(running)
          : undefined;
        const projectionRejectionMetadata =
          rejectedSettingsProjectionMetadata(error);
        const authFailureMetadata = providerAuthFailureMetadata(commandCheck);
        const failed = recoverableProviderFailure
          ? {
              ...running,
              status: "pending",
              failedAt: undefined,
              errorSummary: redacted(
                error instanceof Error ? error.message : String(error),
              ),
              failureKind: "transient",
              retryable: true,
              retryExhausted: false,
              recoveryDecision: "retry_same_run_id",
              failedStage: commandCheck?.name,
              retryStartedAt:
                running.retryStartedAt ?? commandCheck?.completedAt ?? now(),
              nextRetryAt: isoAfterSeconds(providerRecoveryDelay),
              retryDelaySeconds: providerRecoveryDelay,
              runnerHeartbeatAt: now(),
              activeCommand: commandCheck?.name ?? running.activeCommand ??
                running.currentCommand ?? running.failedStage,
              metadata: {
                ...(running.metadata ?? {}),
                waitingForProviderRecovery: true,
                providerRecoveryWaitStartedAt: now(),
                providerRecoveryReason: providerRecoveryWaitStillAvailable
                  ? "transient_retry_budget_window_elapsed"
                  : "provider_recovery_wait_limit_reached",
                providerRecoveryWaitCount: recoveryWaitCount,
                maxProviderRecoveryWaits,
                retryBudgetSeconds,
                sourceName: activeItem.sourceName,
              },
            }
          : {
              ...running,
              status: "failed",
              failedAt: now(),
              errorSummary: redacted(
                error instanceof Error ? error.message : String(error),
              ),
              failureKind,
              retryable: false,
              retryExhausted: Boolean(commandCheck?.attemptExhausted) ||
                (retryable && failureKind === "transient"),
              recoveryDecision: "stop_until_fixed",
              failedStage: commandCheck?.name,
              nextRetryAt: undefined,
              retryDelaySeconds: undefined,
              runnerHeartbeatAt: now(),
              activeCommand: commandCheck?.name ?? running.activeCommand ??
                running.currentCommand ?? running.failedStage,
              metadata: {
                ...(running.metadata ?? {}),
                ...projectionRejectionMetadata,
                ...authFailureMetadata,
                waitingForProviderRecovery: false,
              },
            };
        if (commandCheck) {
          failed.commandChecks = [
            ...(failed.commandChecks ?? []),
            commandCheck.status === "failed"
              ? {
                  ...commandCheck,
                  recoveryDecision: commandCheck.recoveryDecision ??
                    failed.recoveryDecision,
                }
              : commandCheck,
          ];
        }
        saveCheckpoint(activeItem, failed);
        checkpoints.set(item.itemId, failed);
        manifest = updateManifest(manifest, Array.from(checkpoints.values()));
        event({
          itemId: item.itemId,
          event: recoverableProviderFailure ? "item_provider_recovery_wait" : "item_failed",
          status: failed.status,
          message: failed.errorSummary,
          failureKind: failed.failureKind,
          retryable: failed.retryable,
          attemptExhausted: recoverableProviderFailure ? false : failed.retryExhausted,
          providerStatusCode: commandCheck?.providerStatusCode,
          retryAfterSeconds: commandCheck?.retryAfterSeconds,
          recoveryDecision: failed.recoveryDecision,
          failedStage: failed.failedStage,
          metadata: recoverableProviderFailure
            ? {
                nextRetryAt: failed.nextRetryAt,
                retryDelaySeconds: failed.retryDelaySeconds,
                retryBudgetSeconds,
                elapsedRetrySeconds: elapsedRetrySeconds(failed),
                providerRecoveryWaitCount: recoveryWaitCount,
                maxProviderRecoveryWaits,
                waitLimitReached: !providerRecoveryWaitStillAvailable,
              }
            : {
                activeCommand: failed.activeCommand,
                command: commandCheck?.name,
                ...projectionRejectionMetadata,
                ...authFailureMetadata,
              },
        });
        if (
          !recoverableProviderFailure &&
          authFailureMetadata.providerAuthFailureDetected === true
        ) {
          event({
            itemId: item.itemId,
            event: "item_provider_auth_refailed",
            status: "failed",
            message: failed.errorSummary,
            failureKind: failed.failureKind,
            retryable: false,
            attemptExhausted: failed.retryExhausted,
            providerStatusCode: commandCheck?.providerStatusCode,
            recoveryDecision: "stop_until_fixed",
            failedStage: failed.failedStage,
            metadata: {
              activeCommand: failed.activeCommand,
              command: commandCheck?.name,
              providerAuthReopenAttemptCount:
                providerAuthReopenAttemptCount(failed),
              ...authFailureMetadata,
            },
          });
        }
        if (failFast) {
          manifest = persistFailFastInterruptedManifest(
            manifest,
            Array.from(checkpoints.values()),
            recoverableProviderFailure
              ? "provider_recovery_wait"
              : "command_failure",
          );
          throw error;
        }
        if (shouldStopBatchAfterFailure(failed)) {
          if (!stopLoggedThisRun.has(failed.itemId)) {
            emitBatchStoppedAfterNonTransientFailure(failed);
            stopLoggedThisRun.add(failed.itemId);
          }
          stopAfterNonTransientFailure = true;
          break;
        }
        processedInPass = true;
      }
    }
    if (stopAfterNonTransientFailure) break;
    if (!processedInPass && deferredForRetryWindow) {
      if (providerRecoveryWaitLimitReached(items, checkpoints)) {
        eventProviderRecoveryWaitLimit(items, checkpoints);
        break;
      }
      processedInPass = waitForNextRetryWindow(items, checkpoints);
    }
  }

  migrateGraphVaultRawLogs();
  assertNoBookScopedRawReports();
  manifest = updateManifest(manifest, Array.from(checkpoints.values()));
  const summary = writeRecoverySummary(manifest, Array.from(checkpoints.values()));
  if (manifest.status === "completed") {
    event({ event: "batch_completed", status: "completed" });
    return;
  }
  const finalCheckpoints = Array.from(checkpoints.values());
  event({
    event: "batch_incomplete",
    recoveryDecision: recoveryDecisionForBatch(finalCheckpoints),
    metadata: {
      pendingItems: manifest.pendingItems,
      runningItems: manifest.runningItems,
      completedItems: manifest.completedItems,
      skippedItems: manifest.skippedItems,
      failedItems: manifest.failedItems,
      retryableItemCount: summary.retryableItemCount,
      nextRetryAt: summary.nextRetryAt,
    },
  });
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(redactLog(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 1;
}
