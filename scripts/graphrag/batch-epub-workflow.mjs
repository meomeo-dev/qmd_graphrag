#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  openSync,
  statSync,
  closeSync,
  readSync,
  writeFileSync,
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

import { classifyFailure } from "./batch-failure-classifier.mjs";
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
    "command-timeout-seconds": { type: "string", default: "5400" },
    "completed-manifest": { type: "string" },
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
const commandTimeoutSeconds = Math.max(
  1,
  Number.parseInt(String(values["command-timeout-seconds"]), 10) || 5400,
);
const runnerHost = hostname();
const runnerPid = process.pid;
const runnerSessionId = randomUUID();
const runnerHeartbeatTtlSeconds = Math.max(commandTimeoutSeconds * 2, 3600);
const failFast = Boolean(values["fail-fast"]);
const migrateOnly = Boolean(values["migrate-only"]);
const statusJson = Boolean(values["status-json"]);

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
  stageProducerRunIds: z.record(z.string(), z.string().min(1)).optional(),
});
const BatchItemCheckpointSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  itemId: z.string().min(1),
  runId: z.string().min(1),
  status: BatchItemStatusSchema,
  sourceName: z.string().min(1),
  sourceRelativePath: BatchProjectRelativeLocatorSchema,
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
  commandTimeoutSeconds: z.number().int().positive().optional(),
  retryStartedAt: z.string().datetime().optional(),
  runnerSessionId: z.string().min(1).optional(),
  runnerHost: z.string().min(1).optional(),
  runnerPid: z.number().int().positive().optional(),
  runnerHeartbeatAt: z.string().datetime().optional(),
  orphanedRunnerDetectedAt: z.string().datetime().optional(),
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
  commandTimeoutSeconds: z.number().int().positive().optional(),
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
  graphBuildStatus: BatchBuildStatusSchema,
  graphQueryStatus: BatchBuildStatusSchema,
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryExhausted: z.boolean().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  failedStage: z.string().min(1).optional(),
  providerStatusCode: z.number().int().positive().optional(),
  nextRetryAt: z.string().datetime().optional(),
  retryDelaySeconds: z.number().int().nonnegative().optional(),
  retryBudgetSeconds: z.number().int().positive().optional(),
  runnerSessionId: z.string().min(1).optional(),
  runnerHost: z.string().min(1).optional(),
  runnerPid: z.number().int().positive().optional(),
  runnerHeartbeatAt: z.string().datetime().optional(),
  orphanedRunnerDetectedAt: z.string().datetime().optional(),
  waitingForProviderRecovery: z.boolean().optional(),
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
    commandTimeoutSeconds: z.number().int().positive(),
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
  const start = epochMs(checkpoint.retryStartedAt ?? checkpoint.startedAt);
  if (start === 0) return 0;
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

function transientBudgetAvailable(checkpoint) {
  return elapsedRetrySeconds(checkpoint) < retryBudgetSeconds;
}

function retryBudgetExhausted(checkpoint) {
  return !transientBudgetAvailable(checkpoint);
}

function checkpointFailureText(checkpoint) {
  return [
    checkpoint?.errorSummary,
    ...(checkpoint?.commandChecks ?? [])
      .filter((check) => check.status === "failed")
      .map((check) => check.errorSummary),
  ].filter(Boolean).join("\n");
}

function checkpointHasTransientFailure(checkpoint) {
  if (checkpoint?.failureKind === "transient") return true;
  const failure = classifyFailure(checkpointFailureText(checkpoint));
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
  const heartbeatAgeSeconds =
    Math.max(0, Math.floor((Date.now() - epochMs(checkpoint.runnerHeartbeatAt)) / 1000));
  if (heartbeatAgeSeconds > runnerHeartbeatTtlSeconds) return true;
  if (checkpoint.runnerHost !== runnerHost) return false;
  if (checkpoint.runnerSessionId === runnerSessionId) return false;
  return !processAlive(checkpoint.runnerPid);
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

function redacted(message) {
  return redactExactEnvValues(String(message))
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
  return redactExactEnvValues(String(text))
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
  const secrets = Object.keys(process.env)
    .filter((key) =>
      /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|BASE_URL|API_BASE)/iu.test(key),
    )
    .map((key) => ({ key, value: process.env[key] }))
    .filter((item) => item.value && item.value.length >= 4)
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
      Object.entries(value).map(([key, item]) => [
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

function loadDotenv() {
  if (values["skip-dotenv"]) return;
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const separator = body.indexOf("=");
    if (separator <= 0) continue;
    const key = body.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || process.env[key] != null) {
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
    process.env[key] = value;
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

function writeTypedJson(path, schema, value) {
  const parsed = schema.parse(withoutUndefined(value));
  if (statusJson) return parsed;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return parsed;
}

function loadCatalogBySourceHash() {
  const catalogPath = join(stateRoot, "catalog", "books.yaml");
  if (!existsSync(catalogPath)) return new Map();
  const catalog = YAML.parse(readFileSync(catalogPath, "utf8")) ?? {};
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  return new Map(items
    .filter((item) => typeof item.sourceHash === "string")
    .map((item) => [item.sourceHash, item]));
}

function normalizedPathFor(sourcePath, sourceHash, catalogByHash) {
  const catalogItem = catalogByHash.get(sourceHash);
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

function defaultBookIdFor(sourceHash) {
  return `book-${sourceHash.slice(0, 12)}`;
}

function discoverItems() {
  const catalogByHash = loadCatalogBySourceHash();
  return readdirSync(sourceDir)
    .filter((name) => name.toLowerCase().endsWith(".epub"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const sourcePath = join(sourceDir, name);
      const sourceHash = sha256File(sourcePath);
      const catalogItem = catalogByHash.get(sourceHash);
      const normalizedPath = normalizedPathFor(sourcePath, sourceHash, catalogByHash);
      const sourceRelativePath = relative(root, sourcePath);
      return {
        itemId: itemIdFor(sourceHash, sourceRelativePath),
        sourceName: name,
        sourcePath,
        sourceHash,
        normalizedPath,
        normalizedRel: relative(root, normalizedPath),
        sourceRelativePath,
        bookId: typeof catalogItem?.bookId === "string"
          ? catalogItem.bookId
          : defaultBookIdFor(sourceHash),
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
    commandTimeoutSeconds,
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
    manifest.commandTimeoutSeconds = commandTimeoutSeconds;
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
  const shouldSkip = seed && (seedHash == null || seedHash === item.sourceHash);
  if (shouldSkip) {
    return {
      schemaVersion: SchemaVersion,
      itemId: item.itemId,
      runId,
      status: "skipped",
      sourceName: item.sourceName,
      sourceRelativePath: item.sourceRelativePath,
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
      commandTimeoutSeconds,
      recoveryDecision: "none",
      commandChecks: [],
      metadata: {
        seededFromCompletedManifest: basename(completedManifestPath),
        seedMatchMode: seedHash == null ? "source_name_only" : "source_name_and_hash",
      },
    };
  }
  return {
    schemaVersion: SchemaVersion,
    itemId: item.itemId,
    runId,
    status: "pending",
    sourceName: item.sourceName,
    sourceRelativePath: item.sourceRelativePath,
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
    commandTimeoutSeconds,
    recoveryDecision: "none",
    commandChecks: [],
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
    commandTimeoutSeconds,
    defaultBookId: defaultBookIdFor(item.sourceHash),
  });
  return {
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
  };
}

function loadCheckpoint(item, completedSeed) {
  const path = itemPath(item);
  if (!existsSync(path)) {
    if (statusJson) {
      return BatchItemCheckpointSchema.parse(defaultCheckpoint(item, completedSeed));
    }
    const checkpoint = defaultCheckpoint(item, completedSeed);
    return writeTypedJson(path, BatchItemCheckpointSchema, checkpoint);
  }
  const hydrated = hydrateCheckpoint(item, readJson(path));
  const checkpoint = recoverProviderTransientCheckpoint(item,
    recoverOrphanedRunningCheckpoint(item, downgradeCompletedIfClosedLoopInvalid(
      item,
      hydrated,
    )),
  );
  return writeTypedJson(path, BatchItemCheckpointSchema, checkpoint);
}

function saveCheckpoint(item, checkpoint) {
  return writeTypedJson(itemPath(item), BatchItemCheckpointSchema, checkpoint);
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
    return null;
  } finally {
    closeSync(fd);
  }
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

  const artifactIds = checkpointArtifactIds(checkpoint);
  if (artifactIds.length === 0) {
    return {
      ok: false,
      reason: "stage_artifact_missing",
      artifactIds,
    };
  }

  const stageArtifacts = [];
  for (const artifactId of artifactIds) {
    const artifact = artifacts.find((candidate) =>
      String(candidate?.artifactId) === artifactId
    );
    const invalidReason = validateArtifactContent(artifact, item.bookId);
    if (invalidReason != null) {
      return {
        ok: false,
        reason: `stage_artifact_invalid:${invalidReason}`,
        artifactIds,
      };
    }
    stageArtifacts.push(artifact);
  }
  if (stageArtifacts.length !== artifactIds.length) {
    return {
      ok: false,
      reason: "stage_artifact_missing",
      artifactIds,
    };
  }
  const artifactKinds = new Set(stageArtifacts.map((artifact) => artifact.kind));
  const missingKind = graphStageArtifactKinds[stage].find((kind) =>
    !artifactKinds.has(kind)
  );
  if (missingKind) {
    return {
      ok: false,
      reason: `stage_artifact_kind_missing:${missingKind}`,
      artifactIds,
    };
  }

  const invalidArtifactStage = stageArtifacts.find((artifact) =>
    expectedArtifactStage(stage, artifact) == null
  );
  if (invalidArtifactStage) {
    return {
      ok: false,
      reason: `stage_artifact_stage_mismatch:${stage}`,
      artifactIds,
    };
  }

  const invalidArtifactProducer = stageArtifacts.find((artifact) => {
    const artifactStage = expectedArtifactStage(stage, artifact);
    if (artifactStage == null) return true;
    if (stage !== "query_ready") {
      if (expectedProducerRunId != null) {
        return artifact.producerRunId !== expectedProducerRunId;
      }
      return artifact.producerRunId !== checkpoint.runId;
    }
    const expectedRunId = producer?.stageProducerRunIds?.[artifactStage];
    return expectedRunId == null || artifact.producerRunId !== expectedRunId;
  });
  if (invalidArtifactProducer) {
    return {
      ok: false,
      reason: `stage_artifact_producer_run_mismatch:${stage}`,
      artifactIds,
    };
  }

  if (expectedStageFingerprints != null) {
    const invalidArtifactFingerprint = stageArtifacts.find((artifact) => {
      const artifactStage = expectedArtifactStage(stage, artifact);
      return artifactStage == null ||
        artifact.stageFingerprint !== expectedStageFingerprints[artifactStage];
    });
    if (invalidArtifactFingerprint) {
      return {
        ok: false,
        reason: `stage_artifact_fingerprint_mismatch:${stage}`,
        artifactIds,
      };
    }
  }

  if (expectedProviderFingerprint != null) {
    const invalidArtifactProvider = stageArtifacts.find((artifact) =>
      artifact.providerFingerprint !== expectedProviderFingerprint
    );
    if (invalidArtifactProvider) {
      return {
        ok: false,
        reason: `stage_artifact_provider_mismatch:${stage}`,
        artifactIds,
      };
    }
  }

  if (expectedCorpusContentHash != null) {
    const invalidArtifactCorpus = stageArtifacts.find((artifact) =>
      (artifact.kind.startsWith("graphrag_") || artifact.kind === "lancedb_index") &&
      artifact.metadata?.corpusContentHash !== expectedCorpusContentHash
    );
    if (invalidArtifactCorpus) {
      return {
        ok: false,
        reason: `stage_artifact_corpus_mismatch:${stage}`,
        artifactIds,
      };
    }
  }

  const invalidPath = stageArtifacts.find((artifact) =>
    stage === "embed"
      ? artifact.path !== `books/${item.bookId}/output/lancedb`
      : !artifact.path.startsWith(`books/${item.bookId}/output/`)
  );
  if (invalidPath) {
    return {
      ok: false,
      reason: "stage_artifact_not_book_scoped",
      artifactIds,
    };
  }

  return { ok: true, artifactIds };
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
  const producer = readJsonSchemaIfExists(
    producerManifestPath,
    GraphRagOutputProducerManifestSchema,
  );
  const job = readGraphJob(item);
  const expectedStageFingerprints = job?.stageFingerprints ?? producer?.stageFingerprints;
  const expectedProviderFingerprint = job?.providerFingerprint ??
    producer?.providerFingerprint;
  const expectedCorpusContentHash = job?.normalizedContentHash ?? job?.sourceHash ??
    producer?.contentHash;

  for (const stage of graphCompletionStages) {
    const stageEvidence = validateGraphStageEvidence({
      item,
      stage,
      checkpoint: checkpoints.find((checkpoint) => checkpoint?.stage === stage),
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

function qmdBuildEvidence(checkpoint) {
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
      reason: "qmd_build_check_missing",
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
        ? "qmd_build_check_unexpected"
        : "qmd_build_check_set_incomplete",
      artifactIds: [],
    };
  }
  return {
    status: "succeeded",
    checkedAt,
    stage: "qmd-query-json",
    artifactIds: [],
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

function downgradeCompletedIfClosedLoopInvalid(item, checkpoint) {
  if (checkpoint.status !== "completed") return checkpoint;
  const qmdBuildStatus = qmdBuildEvidence(checkpoint);
  const graphBuildStatus = graphBuildEvidence(item);
  const graphQueryStatus = graphQueryEvidence(checkpoint);
  if (
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
  const reopenStatus = graphBuildStatus.status !== "succeeded"
    ? graphBuildStatus
    : qmdBuildStatus.status !== "succeeded"
      ? qmdBuildStatus
      : graphQueryStatus;
  event({
    itemId: item.itemId,
    event: "item_completed_reopened",
    status: "pending",
    recoveryDecision: "continue_pending",
    failedStage: reopenStatus.stage,
    metadata: {
      qmdBuildStatus,
      graphBuildStatus,
      graphQueryStatus,
    },
  });
  return {
    ...checkpoint,
    status: "pending",
    completedAt: undefined,
    recoveryDecision: "continue_pending",
    failedStage: reopenStatus.stage,
    qmdBuildStatus,
    graphBuildStatus,
    graphQueryStatus,
    metadata: {
      ...(checkpoint.metadata ?? {}),
      reopenedFromCompleted: true,
      reopenReason: reopenStatus.reason,
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
    !checkpointHasTransientFailure(checkpoint)
  ) {
    return checkpoint;
  }

  const delaySeconds = checkpoint.nextRetryAt != null
    ? Math.max(
        0,
        Math.ceil((epochMs(checkpoint.nextRetryAt) - Date.now()) / 1000),
      )
    : providerRecoveryDelaySeconds(checkpoint);
  const nextRetryAt = checkpoint.nextRetryAt ?? isoAfterSeconds(delaySeconds);
  const recovered = {
    ...checkpoint,
    status: "pending",
    failedAt: undefined,
    failureKind: "transient",
    retryable: true,
    retryExhausted: false,
    recoveryDecision: "retry_same_run_id",
    retryStartedAt: checkpoint.retryStartedAt ?? checkpoint.startedAt ?? now(),
    nextRetryAt,
    retryDelaySeconds: delaySeconds,
    runnerHeartbeatAt: now(),
    metadata: {
      ...(checkpoint.metadata ?? {}),
      waitingForProviderRecovery: true,
      providerRecoveryWaitStartedAt:
        checkpoint.metadata?.providerRecoveryWaitStartedAt ?? now(),
      providerRecoveryReason: checkpoint.retryExhausted === true
        ? "legacy_retry_exhausted_transient"
        : retryBudgetExhausted(checkpoint)
          ? "retry_budget_window_elapsed"
          : "transient_failure_recovered",
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
    },
  });
  return recovered;
}

function updateManifest(manifest, checkpoints) {
  manifest.totalItems = checkpoints.length;
  manifest.itemIds = checkpoints.map((item) => item.itemId);
  const pending = checkpoints.filter((item) => item.status === "pending").length;
  const running = checkpoints.filter((item) => item.status === "running").length;
  const completed = checkpoints.filter((item) => item.status === "completed").length;
  const skipped = checkpoints.filter((item) => item.status === "skipped").length;
  const failed = checkpoints.filter((item) => item.status === "failed").length;
  manifest.pendingItems = pending;
  manifest.runningItems = running;
  manifest.completedItems = completed;
  manifest.skippedItems = skipped;
  manifest.importedCompletedItems = skipped;
  manifest.failedItems = failed;
  manifest.expectedCommandCheckCount = expectedCommandCheckCount;
  manifest.maxCommandAttempts = maxCommandAttempts;
  manifest.maxTransientCommandAttempts = maxTransientCommandAttempts;
  manifest.maxResumePasses = maxResumePasses;
  manifest.retryBaseDelaySeconds = retryBaseDelaySeconds;
  manifest.retryMaxDelaySeconds = retryMaxDelaySeconds;
  manifest.retryBudgetSeconds = retryBudgetSeconds;
  manifest.commandTimeoutSeconds = commandTimeoutSeconds;
  manifest.updatedAt = now();
  if (failed > 0) {
    manifest.status = "failed";
    manifest.failedAt = manifest.failedAt ?? now();
    delete manifest.completedAt;
  } else if (completed === manifest.totalItems) {
    manifest.status = "completed";
    manifest.completedAt = manifest.completedAt ?? now();
    delete manifest.failedAt;
  } else if (pending === 0 && running === 0) {
    manifest.status = "incomplete";
    delete manifest.completedAt;
    delete manifest.failedAt;
  } else {
    manifest.status = "running";
    delete manifest.completedAt;
    delete manifest.failedAt;
  }
  const parsed = writeTypedJson(manifestPath, BatchRunManifestSchema, manifest);
  writeRecoverySummary(parsed, checkpoints);
  return parsed;
}

function buildRecoverySummary(manifest, checkpoints) {
  const items = checkpoints.map((item) => {
    const qmdStatus = qmdBuildEvidence(item);
    const graphStatus = graphBuildEvidence(item);
    const graphQueryStatus = graphQueryEvidence(item);
    const failedCommand = (item.commandChecks ?? []).find((check) =>
      check.status === "failed"
    );
    return withoutUndefined({
      itemId: item.itemId,
      sourceName: item.sourceName,
      bookId: item.bookId,
      status: item.status,
      attempts: item.attempts,
      qmdBuildStatus: redactJsonValue(qmdStatus),
      graphBuildStatus: redactJsonValue(graphStatus),
      graphQueryStatus: redactJsonValue(graphQueryStatus),
      failureKind: item.failureKind,
      retryable: item.retryable,
      retryExhausted: item.retryExhausted,
      recoveryDecision: item.recoveryDecision,
      failedStage: item.failedStage,
      providerStatusCode: failedCommand?.providerStatusCode,
      nextRetryAt: item.nextRetryAt,
      retryDelaySeconds: item.retryDelaySeconds,
      retryBudgetSeconds: item.retryBudgetSeconds,
      runnerSessionId: item.runnerSessionId,
      runnerHost: item.runnerHost,
      runnerPid: item.runnerPid,
      runnerHeartbeatAt: item.runnerHeartbeatAt,
      orphanedRunnerDetectedAt: item.orphanedRunnerDetectedAt,
      waitingForProviderRecovery:
        item.metadata?.waitingForProviderRecovery === true,
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
      commandTimeoutSeconds,
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
  if (checkpoints.some((item) =>
    item.status !== "completed" &&
    item.status !== "skipped" &&
    (item.retryable === true || item.recoveryDecision === "retry_same_run_id")
  )) {
    return "retry_same_run_id";
  }
  if (checkpoints.some((item) => item.status === "pending" || item.status === "running")) {
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
    const failureKind =
      sanitized.failureKind ?? check?.failureKind ?? checkpoint.failureKind ??
      inferredFailure.failureKind;
    const retryable =
      sanitized.retryable ?? check?.retryable ?? checkpoint.retryable ??
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
        recoveryDecision: "stop_until_fixed",
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
  const migrateDir = (reportsDir, sourceLocatorPrefix) => {
    if (!existsSync(reportsDir)) return;
    mkdirSync(targetDir, { recursive: true });
    for (const name of readdirSync(reportsDir)) {
      const source = join(reportsDir, name);
      const target = join(targetDir, `${Date.now()}-${name}`);
      renameSync(source, target);
      event({
        event: "raw_log_migrated",
        metadata: {
          sourceLocator: `${sourceLocatorPrefix}/${name}`,
          targetLogRootName: basename(logRoot),
          targetFileName: basename(target),
        },
      });
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
  return { command: join(root, "bin", "qmd"), args: [] };
}

function resumeRunnerArgs() {
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
    const result = spawnSync(command, args, {
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
    const retryDelaySeconds = failure?.retryAfterSeconds ??
      retryDelaySecondsForAttempt(attempt);
    const shouldRetry =
      result.status !== 0 &&
      Boolean(failure?.retryable) &&
      attempt < attempts &&
      (!options.allowTransientBudget || transientBudgetAvailable(options.checkpoint));
    const recoveryDecision = shouldRetry
      ? "retry_same_run_id"
      : "stop_until_fixed";
    const nextRetryAt = shouldRetry ? isoAfterSeconds(retryDelaySeconds) : undefined;
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
    event({
      itemId: item.itemId,
      event: "command_retry_exhausted",
      command: name,
      failureKind: last.check.failureKind,
      retryable: last.check.retryable,
      retryAfterSeconds: last.check.retryAfterSeconds,
      attemptExhausted: true,
      providerStatusCode: last.check.providerStatusCode,
      recoveryDecision: "stop_until_fixed",
      failedStage: name,
      message: last.check.errorSummary,
      metadata: {
        nextRetryAt: last.check.nextRetryAt,
        retryDelaySeconds: last.check.retryDelaySeconds,
        maxAttempts: attempts,
        retryBudgetSeconds,
        commandTimeoutSeconds,
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

function runGraphResume(item, checkpoint) {
  requirePath(pythonBin, "GraphRAG Python");
  let lastResult = null;
  for (let pass = 1; pass <= maxResumePasses; pass += 1) {
    const result = runCommand(item, `resume-book-${pass}`, process.execPath, [
      ...resumeRunnerArgs(),
      "--state-root",
      stateRoot,
      "--source-path",
      item.sourcePath,
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
      throw Object.assign(new Error(message), { commandCheck: result.check });
    }
    event({
      itemId: item.itemId,
      event: "resume_pass_completed",
      status: resume.status === "ready" ? "completed" : "running",
      metadata: {
        pass,
        resumeStatus: resume.status,
        nextStage: resume.nextStage,
      },
    });
    if (resume.status === "ready" && resume.nextStage == null) return resume.bookId;
  }

  throw Object.assign(
    new Error(`resume-book did not reach ready after ${maxResumePasses} passes`),
    { commandCheck: lastResult?.check },
  );
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

function runCliChecks(item) {
  const checks = [];
  const record = (result) => checks.push(result.check);
  record(qmd(item, "qmd-version", ["--version"]));
  record(qmd(item, "qmd-status", ["status"]));
  record(qmd(item, "qmd-doctor-json", ["doctor", "--json"]));
  record(qmd(item, "qmd-pull", ["pull"]));
  record(qmd(item, "qmd-update", ["update"]));
  record(qmd(item, "qmd-embed", ["embed", "--max-docs-per-batch", "1"], maxCommandAttempts));
  record(qmd(item, "qmd-ls-books", ["ls", "books"]));
  record(qmd(item, "qmd-search-json", ["search", "--json", "software design complexity"]));
  record(qmd(item, "qmd-search-csv", ["search", "--csv", "software design complexity"]));
  record(qmd(item, "qmd-search-md", ["search", "--md", "software design complexity"]));
  record(qmd(item, "qmd-search-xml", ["search", "--xml", "software design complexity"]));
  record(qmd(item, "qmd-search-files", ["search", "--files", "software design complexity"]));
  record(qmd(item, "qmd-vsearch-json", ["vsearch", "--json", "software design complexity"], maxCommandAttempts));
  record(qmd(item, "qmd-query-json", ["query", "--json", query], maxCommandAttempts));
  record(qmd(item, "qmd-query-auto-json", ["query", "--mode", "auto", "--json", query], maxCommandAttempts));
  record(qmd(
    item,
    "qmd-query-graphrag-json",
    ["query", "--graphrag", "--graph-book-id", item.bookId, "--json", query],
    maxCommandAttempts,
  ));
  record(qmd(item, "qmd-get-book", ["get", `qmd://books/${basename(item.normalizedPath)}`, "-l", "5"]));
  record(qmd(item, "qmd-multi-get-json", ["multi-get", "books/*.md", "-l", "1", "--json"]));
  record(qmd(item, "qmd-collection-list", ["collection", "list"]));
  record(qmd(item, "qmd-collection-show-books", ["collection", "show", "books"]));
  record(qmd(item, "qmd-context-list", ["context", "list"]));
  record(qmd(item, "qmd-skills-list-json", ["skills", "list", "--json"]));
  record(qmd(item, "qmd-skills-get-json", ["skills", "get", "qmd", "--json"]));
  record(qmd(item, "qmd-skills-path-json", ["skills", "path", "qmd", "--json"]));
  record(qmd(item, "qmd-skill-show", ["skill", "show"]));
  record(qmd(item, "qmd-dspy-status-json", ["dspy", "status", "--json"]));
  record(qmd(item, "qmd-cleanup", ["cleanup"]));
  validateCommandChecks(checks);
  return checks;
}

function runItem(item, checkpoint) {
  normalizeEpubToMarkdown(item);
  const resolvedBookId = runGraphResume(item, checkpoint) ?? checkpoint.bookId;
  const resolvedItem = { ...item, bookId: resolvedBookId };
  const commandChecks = runCliChecks(resolvedItem);
  const qmdBuildStatus = qmdBuildEvidence({ commandChecks });
  const graphBuildStatus = graphBuildEvidence(resolvedItem);
  const graphQueryStatus = graphQueryEvidence({ commandChecks });
  if (qmdBuildStatus.status !== "succeeded") {
    throw Object.assign(new Error(`qmd build did not succeed: ${qmdBuildStatus.reason}`), {
      commandCheck: commandChecks.find((check) => check.name === qmdBuildStatus.stage),
    });
  }
  if (graphBuildStatus.status !== "succeeded") {
    throw Object.assign(
      new Error(`GraphRAG build did not succeed: ${graphBuildStatus.reason}`),
      {
        commandCheck: {
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
        },
      },
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
  };
  saveCheckpoint(item, completed);
  event({ itemId: item.itemId, event: "item_completed", status: "completed" });
  return completed;
}

function buildRecoverableTransientCheckpoint({ item, running, commandCheck, error }) {
  const retryDelaySeconds =
    commandCheck?.retryDelaySeconds ?? retryDelaySecondsForAttempt(running.attempts);
  const nextRetryAt = commandCheck?.nextRetryAt ?? isoAfterSeconds(retryDelaySeconds);
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
    retryStartedAt: running.retryStartedAt ?? running.startedAt ?? now(),
    nextRetryAt,
    retryDelaySeconds,
    runnerHeartbeatAt: now(),
    commandChecks: commandCheck
      ? [...(running.commandChecks ?? []), commandCheck]
      : (running.commandChecks ?? []),
    metadata: {
      ...(running.metadata ?? {}),
      waitingForProviderRecovery: true,
      lastRetryableFailureAt: now(),
      retryBudgetSeconds,
      sourceName: item.sourceName,
    },
  };
}

function markItemRunning(item, checkpoint, checkpoints, manifest) {
  const startedAt = now();
  const running = {
    ...checkpoint,
    status: "running",
    attempts: checkpoint.attempts + 1,
    startedAt: checkpoint.startedAt ?? startedAt,
    retryStartedAt: checkpoint.retryStartedAt ?? startedAt,
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
    runnerSessionId,
    runnerHost,
    runnerPid,
    runnerHeartbeatAt: startedAt,
  };
  saveCheckpoint(item, running);
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

function waitForNextRetryWindow(items, checkpoints) {
  const waiting = items
    .map((item) => ({ item, checkpoint: checkpoints.get(item.itemId) }))
    .filter(({ checkpoint }) =>
      checkpoint?.status === "pending" &&
      checkpoint.retryable === true &&
      retryWindowDelayMs(checkpoint) > 0
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
  manifest = updateManifest(manifest, Array.from(checkpoints.values()));
  if (statusJson) {
    printStatusAndExit(manifest, Array.from(checkpoints.values()));
    return;
  }
  if (migrateOnly) {
    migrateEventLog(Array.from(checkpoints.values()));
    migrateGraphVaultRawLogs();
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
  while (processedInPass) {
    processedInPass = false;
    let deferredForRetryWindow = false;
    for (const item of items) {
      const checkpoint = checkpoints.get(item.itemId);
      if (checkpoint?.status === "completed") {
        event({ itemId: item.itemId, event: "item_skip_completed", status: "completed" });
        continue;
      }
      if (checkpoint?.status === "skipped") {
        event({
          itemId: item.itemId,
          event: "item_skipped",
          status: "skipped",
          metadata: checkpoint.metadata,
        });
        continue;
      }
      if (checkpoint?.status === "failed" && checkpoint.retryable === false) {
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
        continue;
      }
      if (checkpoint?.status === "failed" && checkpoint.retryable === true) {
        const recovered = recoverProviderTransientCheckpoint(item, checkpoint);
        if (recovered !== checkpoint) {
          saveCheckpoint(item, recovered);
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
        const recovered = recoverProviderTransientCheckpoint(item, checkpoint);
        saveCheckpoint(item, recovered);
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
        const retryWindowDelay = retryWindowDelayMs(starting);
        if (retryWindowDelay > 0) {
          eventRetryWindowDeferred(item, starting, retryWindowDelay);
          deferredForRetryWindow = true;
          continue;
        }
        const running = markItemRunning(item, starting, checkpoints, manifest);
        const completed = runItem(item, running);
        checkpoints.set(item.itemId, completed);
        manifest = updateManifest(manifest, Array.from(checkpoints.values()));
        processedInPass = true;
      } catch (error) {
        const running = existsSync(itemPath(item))
          ? loadCheckpoint(item, completedSeed)
          : checkpoint ?? defaultCheckpoint(item, completedSeed);
        const commandCheck = error?.commandCheck;
        const failureKind = commandCheck?.failureKind ?? "unknown";
        const retryable = commandCheck?.retryable ?? false;
        const canRecoverInThisRun =
          retryable && failureKind === "transient" && transientBudgetAvailable(running);
        if (canRecoverInThisRun && !failFast) {
          const recoverable = buildRecoverableTransientCheckpoint({
            item,
            running,
            commandCheck,
            error,
          });
          saveCheckpoint(item, recoverable);
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
          continue;
        }
        const recoverableProviderFailure =
          retryable && failureKind === "transient" && !failFast;
        const providerRecoveryDelay = recoverableProviderFailure
          ? providerRecoveryDelaySeconds(running)
          : undefined;
        const failed = recoverableProviderFailure ? {
          ...running,
          status: "pending",
          failedAt: undefined,
          errorSummary: redacted(error instanceof Error ? error.message : String(error)),
          failureKind: "transient",
          retryable: true,
          retryExhausted: false,
          recoveryDecision: "retry_same_run_id",
          failedStage: commandCheck?.name,
          retryStartedAt: running.retryStartedAt ?? running.startedAt ?? now(),
          nextRetryAt: isoAfterSeconds(providerRecoveryDelay),
          retryDelaySeconds: providerRecoveryDelay,
          runnerHeartbeatAt: now(),
          metadata: {
            ...(running.metadata ?? {}),
            waitingForProviderRecovery: true,
            providerRecoveryWaitStartedAt: now(),
            providerRecoveryReason: "transient_retry_budget_window_elapsed",
            retryBudgetSeconds,
            sourceName: item.sourceName,
          },
        } : {
          ...running,
          status: "failed",
          failedAt: now(),
          errorSummary: redacted(error instanceof Error ? error.message : String(error)),
          failureKind,
          retryable: false,
          retryExhausted: Boolean(commandCheck?.attemptExhausted) ||
            (retryable && failureKind === "transient"),
          recoveryDecision: "stop_until_fixed",
          failedStage: commandCheck?.name,
          nextRetryAt: undefined,
          retryDelaySeconds: undefined,
          runnerHeartbeatAt: now(),
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
        saveCheckpoint(item, failed);
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
              }
            : undefined,
        });
        if (failFast) throw error;
        processedInPass = true;
      }
    }
    if (!processedInPass && deferredForRetryWindow) {
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
