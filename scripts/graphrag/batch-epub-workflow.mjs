#!/usr/bin/env node

import { spawn } from "node:child_process";
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
  fsyncSync,
  closeSync,
  readSync,
  writeSync,
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
    "book-concurrency": { type: "string", default: "2" },
    "openai-provider-concurrency": { type: "string", default: "1" },
    "jina-provider-concurrency": { type: "string", default: "2" },
    "local-cpu-concurrency": { type: "string", default: "2" },
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
const bookConcurrency = Math.max(
  1,
  Number.parseInt(String(values["book-concurrency"]), 10) || 2,
);
const openaiProviderConcurrency = Math.max(
  1,
  Number.parseInt(String(values["openai-provider-concurrency"]), 10) || 1,
);
const jinaProviderConcurrency = Math.max(
  1,
  Number.parseInt(String(values["jina-provider-concurrency"]), 10) || 2,
);
const localCpuConcurrency = Math.max(
  1,
  Number.parseInt(String(values["local-cpu-concurrency"]), 10) || 2,
);
const runnerHost = hostname();
const runnerPid = process.pid;
const runnerSessionId = randomUUID();
const runnerHeartbeatTtlSeconds = Math.max(commandTimeoutSeconds * 2, 3600);
const jsonFileLockStaleMs = 120000;
const configuredJsonFileLockWaitMs = Number.parseInt(
  process.env.QMD_GRAPHRAG_TEST_JSON_FILE_LOCK_WAIT_MS ?? "",
  10,
);
const configuredDurableTempStaleMs = Number.parseInt(
  process.env.QMD_GRAPHRAG_TEST_DURABLE_TEMP_STALE_MS ?? "",
  10,
);
const testHooksEnabled = process.env.QMD_GRAPHRAG_ENABLE_TEST_HOOKS === "1";
const testRenameEnoentOncePattern = testHooksEnabled
  ? process.env.QMD_GRAPHRAG_TEST_RENAME_ENOENT_ONCE_PATTERN ?? ""
  : "";
const testSkipRunnerStartPreflight = testHooksEnabled &&
  process.env.QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT === "1";
const testTempIdOncePattern = testHooksEnabled
  ? process.env.QMD_GRAPHRAG_TEST_TEMP_ID_ONCE_PATTERN ?? ""
  : "";
const testTempIdOnceValue = testHooksEnabled
  ? process.env.QMD_GRAPHRAG_TEST_TEMP_ID_ONCE_VALUE ?? ""
  : "";
const testDirectoryFsyncFailurePattern = testHooksEnabled
  ? process.env.QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_PATTERN ?? ""
  : "";
const testDirectoryFsyncFailureAfterMatches = testHooksEnabled
  ? Math.max(
      0,
      Number.parseInt(
        process.env.QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_AFTER_MATCHES ??
          "0",
        10,
      ) || 0,
    )
  : 0;
const testRenameEnoentAfterMatches = testHooksEnabled
  ? Math.max(
      0,
      Number.parseInt(
        process.env.QMD_GRAPHRAG_TEST_RENAME_ENOENT_AFTER_MATCHES ?? "0",
        10,
      ) || 0,
    )
  : 0;
let testRenameEnoentInjected = false;
let testRenameEnoentMatchCount = 0;
let testTempIdInjected = false;
let testDirectoryFsyncFailureInjected = false;
let testDirectoryFsyncFailureMatchCount = 0;
const jsonFileLockWaitMs = testHooksEnabled &&
  Number.isInteger(configuredJsonFileLockWaitMs) &&
  configuredJsonFileLockWaitMs > 0
  ? configuredJsonFileLockWaitMs
  : Math.max(jsonFileLockStaleMs * 2, 300000);
const durableReleaseOn = ["commit", "error", "cancellation", "lease_loss", "timeout"];
const durableDefaultLaneTimeoutMs = 120000;
const durableTempStaleMs = testHooksEnabled &&
  Number.isInteger(configuredDurableTempStaleMs) &&
  configuredDurableTempStaleMs >= 0
  ? configuredDurableTempStaleMs
  : 24 * 60 * 60 * 1000;
const durableAdapterContract = Object.freeze({
  schemaVersion: "1.0.0",
  boundary: "runner-equivalent-durable-state-store",
  sharedModule: "src/job-state/durable-state-store.ts",
  guarantees: [
    "targetMapping",
    "exclusiveTempCreate",
    "ownerEvidence",
    "checksumCommitMeta",
    "targetGenerationFence",
    "guardedLockRelease",
    "preflightReconcile",
    "localStateFailureProjection",
  ],
});
const statusJsonDurableDiagnostics = [];
const providerRequestStartupScanLimit = 200;
const providerRequestStartupSampleLimit = 10;
const providerSlotAcquireWaitMs = Math.max(jsonFileLockWaitMs, 300000);
const qmdIndexFileLockStaleMs = 120000;
const qmdIndexFileLockWaitMs = Math.max(qmdIndexFileLockStaleMs * 2, 300000);
const failFast = Boolean(values["fail-fast"]);
const migrateOnly = Boolean(values["migrate-only"]);
const statusJson = Boolean(values["status-json"]);
const initialEnvNames = new Set(Object.keys(process.env));
const extraExactRedactions = new Map();
let coordinatorLease = null;
let coordinatorHeartbeatTimer = null;
let eventSequence = 0;
let batchStopRequested = false;
let batchStopReason = null;
let terminationSignalHandling = false;
const activeChildProcesses = new Map();
let durableOperationContext = null;
const heldJsonFileLocks = new Map();

const durableTargetMappingTable = [
  {
    pattern: /^graph_vault\/catalog\/books\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
    preflightScopes: [{ path: "graph_vault/catalog" }],
  },
  {
    pattern: /^graph_vault\/catalog\/runs\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
    preflightScopes: [{ path: "graph_vault/catalog" }],
  },
  {
    pattern: /^graph_vault\/catalog\/sources\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
    preflightScopes: [{ path: "graph_vault/catalog" }],
  },
  {
    pattern: /^graph_vault\/catalog\/document-identity-map\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
    preflightScopes: [{ path: "graph_vault/catalog" }],
  },
  {
    pattern: /^graph_vault\/catalog\/graph-capabilities\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "capabilityCatalog",
    preflightScopes: [{ path: "graph_vault/catalog" }],
  },
  {
    pattern: /^graph_vault\/books\/[^/]+\/(?:job|artifacts|checkpoints)\.yaml$/,
    lane: "checkpointWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
    preflightScopes: [{ path: "graph_vault/books/{bookId}" }],
  },
  {
    pattern: /^graph_vault\/books\/[^/]+\/runs\/[^/]+\.yaml$/,
    lane: "checkpointWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
    preflightScopes: [{ path: "graph_vault/books/{bookId}/runs" }],
  },
  {
    pattern: /^graph_vault\/settings\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "settingsProjection",
    preflightScopes: [{ path: "graph_vault" }],
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/items\/[^/]+\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
    preflightScopes: [{ path: "graph_vault/catalog/batch-runs/{runId}/items" }],
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/manifest\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
    preflightScopes: [{ path: "graph_vault/catalog/batch-runs/{runId}" }],
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/events\.jsonl$/,
    lane: "eventWriterLane",
    durableKind: "jsonl",
    targetMappingOwner: "batchCoordinator",
    preflightScopes: [{ path: "graph_vault/catalog/batch-runs/{runId}" }],
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/status\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
    preflightScopes: [{ path: "graph_vault/catalog/batch-runs/{runId}" }],
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/recovery-summary\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
    preflightScopes: [{ path: "graph_vault/catalog/batch-runs/{runId}" }],
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/coordinator-lock\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
    preflightScopes: [{ path: "graph_vault/catalog/batch-runs/{runId}" }],
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/provider-slots\/[^/]+\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
    preflightScopes: [
      { path: "graph_vault/catalog/batch-runs/{runId}/provider-slots" },
    ],
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/subprocesses\/[^/]+\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
    preflightScopes: [
      { path: "graph_vault/catalog/batch-runs/{runId}/subprocesses" },
    ],
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/book-leases\/[^/]+\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
    preflightScopes: [
      { path: "graph_vault/catalog/batch-runs/{runId}/book-leases" },
    ],
  },
  {
    pattern: /^graph_vault\/catalog\/provider-requests\/[^/]+\.json$/,
    lane: "catalogWriterLane",
    durableKind: "json",
    targetMappingOwner: "providerRequestFingerprint",
    targetFamily: "provider_request_fingerprint",
    startupCriticality: "historical_observation",
    runnerStartPreflightMode: "read_only_capped_diagnostic",
    normalRunnerPrimaryQuarantine: false,
    preflightScopes: [{ path: "graph_vault/catalog/provider-requests" }],
  },
  {
    pattern: /^graph_vault\/catalog\/cost-accounting\.jsonl$/,
    lane: "eventWriterLane",
    durableKind: "jsonl",
    targetMappingOwner: "providerCostAccounting",
    preflightScopes: [{ path: "graph_vault/catalog" }],
  },
  {
    pattern: /^graph_vault\/dspy\/.+\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "dspyPolicyStore",
    preflightScopes: [{ path: "graph_vault/dspy", recursive: true }],
  },
  {
    pattern: /^graph_vault\/dspy\/.+\.json$/,
    lane: "catalogWriterLane",
    durableKind: "json",
    targetMappingOwner: "dspyPolicyStore",
    preflightScopes: [{ path: "graph_vault/dspy", recursive: true }],
  },
  {
    pattern: /^graph_vault\/books\/[^/]+\/qmd\/qmd_build_manifest\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "qmd",
    preflightScopes: [{ path: "graph_vault/books/{bookId}/qmd" }],
  },
  {
    pattern: /^graph_vault\/books\/[^/]+\/output\/qmd_output_manifest\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
    preflightScopes: [
      { path: "graph_vault/books/{bookId}/output", recursive: true },
    ],
  },
  {
    pattern:
      /^graph_vault\/books\/[^/]+\/output\/qmd_graph_text_unit_identity\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
    preflightScopes: [
      { path: "graph_vault/books/{bookId}/output", recursive: true },
    ],
  },
  {
    pattern: /^graph_vault\/books\/[^/]+\/output\/context\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
    preflightScopes: [
      { path: "graph_vault/books/{bookId}/output", recursive: true },
    ],
  },
  {
    pattern: /^graph_vault\/books\/[^/]+\/output\/stats\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
    preflightScopes: [
      { path: "graph_vault/books/{bookId}/output", recursive: true },
    ],
  },
  {
    pattern:
      /^graph_vault\/books\/[^/]+\/output\/lancedb\/[^/]+\.lance\/qmd_row_count\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "artifactValidation",
    preflightScopes: [
      { path: "graph_vault/books/{bookId}/output", recursive: true },
    ],
  },
  {
    pattern: /^graph_vault\/output\/lancedb\/[^/]+\.lance\/qmd_row_count\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "artifactValidation",
    preflightScopes: [{ path: "graph_vault/output", recursive: true }],
  },
  {
    pattern: /(?:^|\/)\.qmd\/index\.sqlite$/,
    lane: "qmdIndexWriterLane",
    durableKind: "sqlite",
    targetMappingOwner: "qmd",
    preflightScopes: [],
  },
  {
    pattern: /(?:^|\/)index\.sqlite$/,
    lane: "qmdIndexWriterLane",
    durableKind: "sqlite",
    targetMappingOwner: "qmd",
    preflightScopes: [],
  },
];

const durableDirectoryFsyncScopeTable = [
  {
    pattern: /^graph_vault$/,
    lane: "catalogWriterLane",
    targetMappingOwner: "settingsProjection",
  },
  {
    pattern: /^graph_vault\/catalog$/,
    lane: "catalogWriterLane",
    targetMappingOwner: "repository",
  },
  {
    pattern: /^graph_vault\/catalog\/provider-requests$/,
    lane: "catalogWriterLane",
    targetMappingOwner: "providerRequestFingerprint",
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+$/,
    lane: "manifestWriterLane",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/items$/,
    lane: "checkpointWriterLane",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/provider-slots$/,
    lane: "manifestWriterLane",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/subprocesses$/,
    lane: "manifestWriterLane",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /^graph_vault\/catalog\/batch-runs\/[^/]+\/book-leases$/,
    lane: "checkpointWriterLane",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /^graph_vault\/books\/[^/]+$/,
    lane: "checkpointWriterLane",
    targetMappingOwner: "repository",
  },
  {
    pattern: /^graph_vault\/books\/[^/]+\/runs$/,
    lane: "checkpointWriterLane",
    targetMappingOwner: "repository",
  },
  {
    pattern: /^graph_vault\/books\/[^/]+\/qmd$/,
    lane: "checkpointWriterLane",
    targetMappingOwner: "qmd",
  },
  {
    pattern: /^graph_vault\/books\/[^/]+\/output(?:\/.*)?$/,
    lane: "checkpointWriterLane",
    targetMappingOwner: "graphOutputProducer",
  },
  {
    pattern: /^graph_vault\/output\/lancedb\/[^/]+\.lance$/,
    lane: "checkpointWriterLane",
    targetMappingOwner: "artifactValidation",
  },
  {
    pattern: /^graph_vault\/dspy(?:\/.*)?$/,
    lane: "catalogWriterLane",
    targetMappingOwner: "dspyPolicyStore",
  },
  {
    pattern: /^\.qmd$/,
    lane: "qmdIndexWriterLane",
    targetMappingOwner: "qmd",
  },
];

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
const batchStatusPath = join(batchRoot, "status.json");
const coordinatorLockPath = join(batchRoot, "coordinator-lock.json");
const providerSlotRoot = join(batchRoot, "provider-slots");
const subprocessRoot = join(batchRoot, "subprocesses");
const bookLeaseRoot = join(batchRoot, "book-leases");
const defaultRequiredCommandCheckNames = [
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
function requiredCommandCheckNamesForRuntime() {
  if (process.env.QMD_GRAPHRAG_ENABLE_TEST_HOOKS !== "1") {
    return defaultRequiredCommandCheckNames;
  }
  const raw = process.env.QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES;
  if (raw == null || raw.trim() === "") return defaultRequiredCommandCheckNames;
  const names = raw.split(",").map((name) => name.trim()).filter(Boolean);
  const uniqueNames = [...new Set(names)];
  const defaultNameSet = new Set(defaultRequiredCommandCheckNames);
  const unknown = uniqueNames.filter((name) => !defaultNameSet.has(name));
  const missingGraphQueries = graphQueryCommandCheckNames.filter((name) =>
    !uniqueNames.includes(name)
  );
  if (
    uniqueNames.length === 0 ||
    uniqueNames.length !== names.length ||
    unknown.length > 0 ||
    missingGraphQueries.length > 0
  ) {
    throw new Error(
      "invalid QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES: " +
        `unknown=${unknown.join(",") || "none"} ` +
        `missingGraphQueries=${missingGraphQueries.join(",") || "none"} ` +
        `duplicates=${uniqueNames.length === names.length ? "none" : "present"}`,
    );
  }
  return uniqueNames;
}
const requiredCommandCheckNames = requiredCommandCheckNamesForRuntime();
const qmdNativeCommandCheckNames = requiredCommandCheckNames.filter(
  (name) => !graphQueryCommandCheckNames.includes(name),
);
const qmdIndexLockedCommandNames = new Set(requiredCommandCheckNames);
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
  "local_state_integrity",
  "local_state_lock_timeout",
  "unknown",
]);
const BatchRecoveryDecisionSchema = z.enum([
  "none",
  "retry_same_run_id",
  "continue_pending",
  "stop_until_fixed",
]);
const StatusJsonDiagnosticRecoveryDecisionSchema = z.union([
  BatchRecoveryDecisionSchema,
  z.literal("metadata_missing_read_only"),
  z.literal("continue_with_diagnostic_unless_catalog_blocked"),
]);
const DurableStateDiagnosticSchema = z.object({
  itemId: z.string().min(1).optional(),
  bookId: z.string().min(1).optional(),
  workerId: z.string().min(1).optional(),
  activeCommand: z.string().min(1).optional(),
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  localFailureClass: z.string().min(1).optional(),
  recoveryDecision: StatusJsonDiagnosticRecoveryDecisionSchema.optional(),
  failedStage: z.string().min(1).optional(),
  targetLocator: z.string().min(1).optional(),
  redactedEvidenceLocator: z.string().min(1).optional(),
  lane: z.string().min(1).optional(),
  targetMappingOwner: z.string().min(1).optional(),
  laneTimeoutMs: z.number().int().positive().optional(),
  releaseOn: z.array(z.string().min(1)).optional(),
  tempId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
  failedSyscall: z.string().min(1).optional(),
  errno: z.string().min(1).optional(),
  renameCause: z.string().min(1).optional(),
  completedPublishRule: z.string().min(1).optional(),
  lockOwnerEvidence: JsonValueSchema.optional(),
  checksumRecoveryDecision: z.string().min(1).optional(),
  fsyncTarget: z.string().min(1).optional(),
  fsyncErrno: z.string().min(1).optional(),
  fsyncPlatform: z.string().min(1).optional(),
  directoryTargetLocator: z.string().min(1).optional(),
  directoryDurableKind: z.string().min(1).optional(),
  primaryDurableKind: z.string().min(1).optional(),
  durableMode: z.string().min(1).optional(),
  primaryTargetLocator: z.string().min(1).optional(),
  sidecarTargetLocator: z.string().min(1).optional(),
  sidecarKind: z.string().min(1).optional(),
  checksumExpected: z.string().min(1).nullable().optional(),
  checksumActual: z.string().min(1).optional(),
  cleanupReason: z.string().min(1).optional(),
  repairAllowed: z.boolean().optional(),
  statusJsonDecision: z.string().min(1).optional(),
  diagnosticClass: z.string().min(1).optional(),
  normalRunnerAction: z.string().min(1).optional(),
  scannedTargetCount: z.number().int().nonnegative().optional(),
  degradedTargetCount: z.number().int().nonnegative().optional(),
  sampleTargetLocators: z.array(z.string().min(1)).optional(),
  scanTruncated: z.boolean().optional(),
  maxRunnerStartScannedTargets: z.number().int().positive().optional(),
  maxRunnerStartReportedSamples: z.number().int().positive().optional(),
  maxRunnerStartMutationCount: z.number().int().nonnegative().optional(),
  evidenceIncomplete: z.boolean().optional(),
  evidenceIncompleteReason: z.string().min(1).optional(),
  unavailableFieldSentinels: z.array(z.string().min(1)).optional(),
  leaseGeneration: z.number().int().positive().optional(),
  bookLeaseGeneration: z.number().int().positive().optional(),
});
const BatchStopInterruptErrorName = "BatchStopInterruptError";
const DurableFailureEnvelopeMarker = "QMD_GRAPHRAG_DURABLE_FAILURE";
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
const LeaseSchema = z.object({
  runnerSessionId: z.string().min(1),
  runnerHost: z.string().min(1),
  runnerPid: z.number().int().positive(),
  generation: z.number().int().positive(),
  fencingToken: z.string().min(1),
  acquiredAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
const CoordinatorLockSchema = LeaseSchema.extend({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  bookConcurrency: z.number().int().positive(),
  openaiProviderConcurrency: z.number().int().positive(),
  jinaProviderConcurrency: z.number().int().positive(),
  localCpuConcurrency: z.number().int().positive(),
});
const ProviderSlotLeaseSchema = LeaseSchema.extend({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  provider: z.enum(["openai", "jina", "local_cpu", "qmd_index_writer"]),
  slotId: z.string().min(1),
  itemId: z.string().min(1).optional(),
  bookId: z.string().min(1).optional(),
  workerId: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  limit: z.number().int().positive(),
  waitMs: z.number().int().nonnegative().optional(),
});
const BookLeaseSchema = LeaseSchema.extend({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  bookId: z.string().min(1),
  itemId: z.string().min(1),
  workerId: z.string().min(1).optional(),
});
const SubprocessRecordSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  subprocessId: z.string().min(1),
  runnerSessionId: z.string().min(1),
  runnerHost: z.string().min(1),
  runnerPid: z.number().int().positive(),
  pid: z.number().int().positive().optional(),
  command: z.string().min(1),
  itemId: z.string().min(1).optional(),
  bookId: z.string().min(1).optional(),
  workerId: z.string().min(1).optional(),
  providerSlotId: z.string().min(1).optional(),
  providerSlotProvider: z.enum([
    "openai",
    "jina",
    "local_cpu",
    "qmd_index_writer",
  ]).optional(),
  providerSlotGeneration: z.number().int().positive().optional(),
  providerSlotFencingToken: z.string().min(1).optional(),
  processGroup: z.boolean(),
  startedAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(),
  status: z.enum(["running", "exited", "killed", "quarantined", "spawn_error"]),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().min(1).nullable().optional(),
  completedAt: z.string().datetime().optional(),
});
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
  localFailureClass: z.string().min(1).optional(),
  targetLocator: z.string().min(1).optional(),
  redactedEvidenceLocator: z.string().min(1).optional(),
  lane: z.string().min(1).optional(),
  targetMappingOwner: z.string().min(1).optional(),
  laneTimeoutMs: z.number().int().positive().optional(),
  releaseOn: z.array(z.string().min(1)).optional(),
  tempId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
  failedSyscall: z.string().min(1).optional(),
  errno: z.string().min(1).optional(),
  renameCause: z.string().min(1).optional(),
  completedPublishRule: z.string().min(1).optional(),
  lockOwnerEvidence: JsonValueSchema.optional(),
  checksumRecoveryDecision: z.string().min(1).optional(),
  fsyncTarget: z.string().min(1).optional(),
  fsyncErrno: z.string().min(1).optional(),
  fsyncPlatform: z.string().min(1).optional(),
  directoryTargetLocator: z.string().min(1).optional(),
  directoryDurableKind: z.string().min(1).optional(),
  primaryDurableKind: z.string().min(1).optional(),
  durableMode: z.string().min(1).optional(),
  primaryTargetLocator: z.string().min(1).optional(),
  sidecarTargetLocator: z.string().min(1).optional(),
  sidecarKind: z.string().min(1).optional(),
  checksumExpected: z.string().min(1).nullable().optional(),
  checksumActual: z.string().min(1).optional(),
  cleanupReason: z.string().min(1).optional(),
  repairAllowed: z.boolean().optional(),
  evidenceIncomplete: z.boolean().optional(),
  evidenceIncompleteReason: z.string().min(1).optional(),
  unavailableFieldSentinels: z.array(z.string().min(1)).optional(),
  runnerSessionId: z.string().min(1).optional(),
  runnerHost: z.string().min(1).optional(),
  runnerPid: z.number().int().positive().optional(),
  workerId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  bookId: z.string().min(1).optional(),
  ownerPid: z.number().int().positive().optional(),
  ownerHost: z.string().min(1).optional(),
  createdAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  leaseGeneration: z.number().int().positive().optional(),
  bookLeaseGeneration: z.number().int().positive().optional(),
  targetGeneration: z.number().int().positive().optional(),
  fencingTokenHash: z.string().min(1).optional(),
  failedStage: z.string().min(1).optional(),
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
  leaseGeneration: z.number().int().positive().optional(),
  fencingToken: z.string().min(1).optional(),
  leaseExpiresAt: z.string().datetime().optional(),
  bookLeaseGeneration: z.number().int().positive().optional(),
  bookFencingToken: z.string().min(1).optional(),
  activeProviderSlots: z.number().int().nonnegative().optional(),
  providerWaitMs: z.number().int().nonnegative().optional(),
  providerSlotGeneration: z.number().int().positive().optional(),
  workerId: z.string().min(1).optional(),
  activeSubprocesses: z.number().int().nonnegative().optional(),
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
  localFailureClass: z.string().min(1).optional(),
  targetLocator: z.string().min(1).optional(),
  redactedEvidenceLocator: z.string().min(1).optional(),
  lane: z.string().min(1).optional(),
  targetMappingOwner: z.string().min(1).optional(),
  laneTimeoutMs: z.number().int().positive().optional(),
  releaseOn: z.array(z.string().min(1)).optional(),
  tempId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
  failedSyscall: z.string().min(1).optional(),
  errno: z.string().min(1).optional(),
  renameCause: z.string().min(1).optional(),
  completedPublishRule: z.string().min(1).optional(),
  lockOwnerEvidence: JsonValueSchema.optional(),
  checksumRecoveryDecision: z.string().min(1).optional(),
  fsyncTarget: z.string().min(1).optional(),
  fsyncErrno: z.string().min(1).optional(),
  fsyncPlatform: z.string().min(1).optional(),
  directoryTargetLocator: z.string().min(1).optional(),
  directoryDurableKind: z.string().min(1).optional(),
  primaryDurableKind: z.string().min(1).optional(),
  durableMode: z.string().min(1).optional(),
  primaryTargetLocator: z.string().min(1).optional(),
  sidecarTargetLocator: z.string().min(1).optional(),
  sidecarKind: z.string().min(1).optional(),
  checksumExpected: z.string().min(1).nullable().optional(),
  checksumActual: z.string().min(1).optional(),
  cleanupReason: z.string().min(1).optional(),
  repairAllowed: z.boolean().optional(),
  evidenceIncomplete: z.boolean().optional(),
  evidenceIncompleteReason: z.string().min(1).optional(),
  unavailableFieldSentinels: z.array(z.string().min(1)).optional(),
  ownerPid: z.number().int().positive().optional(),
  ownerHost: z.string().min(1).optional(),
  createdAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  targetGeneration: z.number().int().positive().optional(),
  fencingTokenHash: z.string().min(1).optional(),
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
      "leaseGeneration",
      "fencingToken",
      "leaseExpiresAt",
      "bookLeaseGeneration",
      "bookFencingToken",
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
  if (value.retryExhausted === true && (
    value.retryable !== false ||
    value.recoveryDecision !== "stop_until_fixed"
  )) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "retryExhausted checkpoint requires retryable=false " +
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
  activeProviderSlots: z.number().int().nonnegative().optional(),
  activeSubprocesses: z.number().int().nonnegative().optional(),
  activeBookLeases: z.number().int().nonnegative().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  failedAt: z.string().datetime().optional(),
  itemIds: z.array(z.string().min(1)),
  durableFailureSummary: z.object({
    failureKind: BatchFailureKindSchema.optional(),
    localFailureClass: z.string().min(1).optional(),
    recoveryDecision: BatchRecoveryDecisionSchema.optional(),
    failedStage: z.string().min(1).optional(),
    targetLocator: z.string().min(1).optional(),
    redactedEvidenceLocator: z.string().min(1).optional(),
    lane: z.string().min(1).optional(),
    targetMappingOwner: z.string().min(1).optional(),
    laneTimeoutMs: z.number().int().positive().optional(),
    releaseOn: z.array(z.string().min(1)).optional(),
    tempId: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
    failedSyscall: z.string().min(1).optional(),
    errno: z.string().min(1).optional(),
    renameCause: z.string().min(1).optional(),
    completedPublishRule: z.string().min(1).optional(),
    lockOwnerEvidence: JsonValueSchema.optional(),
    checksumRecoveryDecision: z.string().min(1).optional(),
    fsyncTarget: z.string().min(1).optional(),
    fsyncErrno: z.string().min(1).optional(),
    fsyncPlatform: z.string().min(1).optional(),
    directoryTargetLocator: z.string().min(1).optional(),
    directoryDurableKind: z.string().min(1).optional(),
    primaryDurableKind: z.string().min(1).optional(),
    durableMode: z.string().min(1).optional(),
    primaryTargetLocator: z.string().min(1).optional(),
    sidecarTargetLocator: z.string().min(1).optional(),
    sidecarKind: z.string().min(1).optional(),
    checksumExpected: z.string().min(1).nullable().optional(),
    checksumActual: z.string().min(1).optional(),
    cleanupReason: z.string().min(1).optional(),
    repairAllowed: z.boolean().optional(),
    evidenceIncomplete: z.boolean().optional(),
    evidenceIncompleteReason: z.string().min(1).optional(),
    unavailableFieldSentinels: z.array(z.string().min(1)).optional(),
  }).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});
const BatchEventLogSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  runnerSessionId: z.string().min(1),
  coordinatorGeneration: z.number().int().positive().optional(),
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
  localFailureClass: z.string().min(1).optional(),
  targetLocator: z.string().min(1).optional(),
  redactedEvidenceLocator: z.string().min(1).optional(),
  lane: z.string().min(1).optional(),
  targetMappingOwner: z.string().min(1).optional(),
  laneTimeoutMs: z.number().int().positive().optional(),
  releaseOn: z.array(z.string().min(1)).optional(),
  tempId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
  failedSyscall: z.string().min(1).optional(),
  errno: z.string().min(1).optional(),
  renameCause: z.string().min(1).optional(),
  completedPublishRule: z.string().min(1).optional(),
  lockOwnerEvidence: JsonValueSchema.optional(),
  checksumRecoveryDecision: z.string().min(1).optional(),
  fsyncTarget: z.string().min(1).optional(),
  fsyncErrno: z.string().min(1).optional(),
  fsyncPlatform: z.string().min(1).optional(),
  directoryTargetLocator: z.string().min(1).optional(),
  directoryDurableKind: z.string().min(1).optional(),
  primaryDurableKind: z.string().min(1).optional(),
  durableMode: z.string().min(1).optional(),
  primaryTargetLocator: z.string().min(1).optional(),
  sidecarTargetLocator: z.string().min(1).optional(),
  sidecarKind: z.string().min(1).optional(),
  checksumExpected: z.string().min(1).nullable().optional(),
  checksumActual: z.string().min(1).optional(),
  cleanupReason: z.string().min(1).optional(),
  repairAllowed: z.boolean().optional(),
  evidenceIncomplete: z.boolean().optional(),
  evidenceIncompleteReason: z.string().min(1).optional(),
  unavailableFieldSentinels: z.array(z.string().min(1)).optional(),
  workerId: z.string().min(1).optional(),
  bookId: z.string().min(1).optional(),
  ownerPid: z.number().int().positive().optional(),
  ownerHost: z.string().min(1).optional(),
  createdAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  leaseGeneration: z.number().int().positive().optional(),
  bookLeaseGeneration: z.number().int().positive().optional(),
  targetGeneration: z.number().int().positive().optional(),
  fencingTokenHash: z.string().min(1).optional(),
  failedStage: z.string().min(1).optional(),
  at: z.string().datetime(),
  message: z.string().max(1000).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});
const LegacyBatchEventLogSchema = BatchEventLogSchema.partial({
  eventId: true,
  sequence: true,
  runnerSessionId: true,
  coordinatorGeneration: true,
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
  localFailureClass: z.string().min(1).optional(),
  targetLocator: z.string().min(1).optional(),
  redactedEvidenceLocator: z.string().min(1).optional(),
  lane: z.string().min(1).optional(),
  targetMappingOwner: z.string().min(1).optional(),
  laneTimeoutMs: z.number().int().positive().optional(),
  releaseOn: z.array(z.string().min(1)).optional(),
  tempId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
  failedSyscall: z.string().min(1).optional(),
  errno: z.string().min(1).optional(),
  renameCause: z.string().min(1).optional(),
  completedPublishRule: z.string().min(1).optional(),
  lockOwnerEvidence: JsonValueSchema.optional(),
  checksumRecoveryDecision: z.string().min(1).optional(),
  fsyncTarget: z.string().min(1).optional(),
  fsyncErrno: z.string().min(1).optional(),
  fsyncPlatform: z.string().min(1).optional(),
  directoryTargetLocator: z.string().min(1).optional(),
  directoryDurableKind: z.string().min(1).optional(),
  primaryDurableKind: z.string().min(1).optional(),
  durableMode: z.string().min(1).optional(),
  primaryTargetLocator: z.string().min(1).optional(),
  sidecarTargetLocator: z.string().min(1).optional(),
  sidecarKind: z.string().min(1).optional(),
  checksumExpected: z.string().min(1).nullable().optional(),
  checksumActual: z.string().min(1).optional(),
  cleanupReason: z.string().min(1).optional(),
  repairAllowed: z.boolean().optional(),
  evidenceIncomplete: z.boolean().optional(),
  evidenceIncompleteReason: z.string().min(1).optional(),
  unavailableFieldSentinels: z.array(z.string().min(1)).optional(),
  failedStage: z.string().min(1).optional(),
  ownerPid: z.number().int().positive().optional(),
  ownerHost: z.string().min(1).optional(),
  createdAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  targetGeneration: z.number().int().positive().optional(),
  fencingTokenHash: z.string().min(1).optional(),
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
  workerId: z.string().min(1).optional(),
  leaseGeneration: z.number().int().positive().optional(),
  fencingToken: z.string().min(1).optional(),
  leaseExpiresAt: z.string().datetime().optional(),
  bookLeaseGeneration: z.number().int().positive().optional(),
  bookFencingToken: z.string().min(1).optional(),
  activeProviderSlots: z.number().int().nonnegative().optional(),
  providerWaitMs: z.number().int().nonnegative().optional(),
  providerSlotGeneration: z.number().int().positive().optional(),
  activeSubprocesses: z.number().int().nonnegative().optional(),
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
    activeProviderSlots: z.number().int().nonnegative().optional(),
    activeSubprocesses: z.number().int().nonnegative().optional(),
    activeBookLeases: z.number().int().nonnegative().optional(),
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
  durableStateFailures: z.array(DurableStateDiagnosticSchema).optional(),
  durableTempDiagnostics: z.array(DurableStateDiagnosticSchema).optional(),
  durableLockDiagnostics: z.array(DurableStateDiagnosticSchema).optional(),
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
  if (checkpoint.leaseExpiresAt != null && epochMs(checkpoint.leaseExpiresAt) <= Date.now()) {
    return true;
  }
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function randomToken(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function temporaryPathFor(path) {
  return `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
}

function durableChecksumMetaPath(path) {
  return `${durableChecksumPath(path)}.meta.json`;
}

function durableLocator(path) {
  const normalized = resolve(path);
  const stateRelative = relative(stateRoot, normalized).split(sep).join("/");
  if (
    stateRelative !== "" &&
    stateRelative !== ".." &&
    !stateRelative.startsWith("../")
  ) {
    return `graph_vault/${stateRelative}`;
  }
  if (stateRelative === "") return "graph_vault";
  const qmdRoot = dirname(qmdIndexPath);
  const qmdRelative = relative(qmdRoot, normalized).split(sep).join("/");
  if (
    qmdRelative !== "" &&
    qmdRelative !== ".." &&
    !qmdRelative.startsWith("../")
  ) {
    return `.qmd/${qmdRelative}`;
  }
  if (qmdRelative === "") return ".qmd";
  return relative(root, normalized).split(sep).join("/");
}

function readDurableChecksum(path) {
  try {
    return readFileSync(durableChecksumPath(path), "utf8").trim();
  } catch {
    return undefined;
  }
}

function durableOperationEvidence(path, kind, extra = {}) {
  const operationId = randomUUID();
  const tempId = testTempIdFor(path) ?? `${process.pid}-${Date.now()}-${operationId}`;
  const mapping = durableTargetMapping(path, kind);
  const context = durableOperationContext ?? {};
  const leaseGeneration =
    context.leaseGeneration ??
    context.bookLeaseGeneration ??
    coordinatorLease?.generation ??
    undefined;
  const fencingToken =
    context.fencingToken ??
    context.bookFencingToken ??
    coordinatorLease?.fencingToken;
  const fencingTokenHash = fencingToken == null
    ? context.fencingTokenHash ?? sha256Text([
        "runner-durable-fence",
        runnerSessionId,
        runId,
        relative(root, path),
        String(leaseGeneration ?? "no-lease"),
      ].join(":"))
    : sha256Text(fencingToken);
  return withoutUndefined({
    tempId,
    operationId,
    targetLocator: relative(root, path),
    absoluteTargetLocator: path,
    kind,
    ...mapping,
    runnerSessionId,
    runnerHost,
    runnerPid,
    runId,
    workerId: context.workerId ?? process.env.QMD_GRAPHRAG_WORKER_ID,
    itemId: context.itemId ?? process.env.QMD_GRAPHRAG_ITEM_ID,
    bookId: context.bookId ?? process.env.QMD_GRAPHRAG_BOOK_ID,
    ownerPid: runnerPid,
    ownerHost: runnerHost,
    createdAt: now(),
    expiresAt: context.expiresAt ?? leaseExpiresAt(),
    leaseGeneration,
    bookLeaseGeneration: context.bookLeaseGeneration,
    targetGeneration: context.targetGeneration ?? leaseGeneration,
    targetChecksumBefore: readDurableChecksum(path) ?? null,
    fencingTokenHash,
    durableMode: "strict",
    durableAdapterContract,
    ...extra,
  });
}

function testTempIdFor(path) {
  if (
    testTempIdInjected ||
    testTempIdOncePattern === "" ||
    testTempIdOnceValue === ""
  ) {
    return undefined;
  }
  const target = relative(root, path);
  if (!target.includes(testTempIdOncePattern)) return undefined;
  testTempIdInjected = true;
  return testTempIdOnceValue;
}

function withDurableOperationContext(context, callback) {
  const previous = durableOperationContext;
  durableOperationContext = withoutUndefined({
    ...(previous ?? {}),
    ...(context ?? {}),
  });
  try {
    return callback();
  } finally {
    durableOperationContext = previous;
  }
}

function durableContextFromValue(value) {
  if (value == null || typeof value !== "object") return {};
  const fencingToken =
    value.fencingToken ??
    value.bookFencingToken ??
    value.providerSlotFencingToken ??
    value.metadata?.itemFencingToken ??
    value.metadata?.bookFencingToken;
  return withoutUndefined({
    itemId: value.itemId,
    bookId: value.bookId,
    workerId: value.workerId ?? value.metadata?.workerId,
    leaseGeneration:
      value.leaseGeneration ??
      value.generation ??
      value.metadata?.leaseGeneration,
    bookLeaseGeneration:
      value.bookLeaseGeneration ??
      value.metadata?.bookLeaseGeneration,
    targetGeneration:
      value.leaseGeneration ??
      value.generation ??
      value.bookLeaseGeneration ??
      value.providerSlotGeneration,
    fencingToken,
    expiresAt: value.leaseExpiresAt ?? value.expiresAt,
  });
}

function durableTargetMapping(path, kind) {
  const relativePath = durableLocator(path);
  if (kind === "directory-fsync") {
    return durableDirectoryFsyncMapping(relativePath, path);
  }
  const mappingPath = primaryTargetRelativePathForMapping(relativePath);
  const mapped = durableTargetMappingTable.find(({ pattern }) =>
    pattern.test(mappingPath)
  );
  if (mapped == null && isProductionDurableTarget(mappingPath, kind)) {
    throw new DurableStateError(
      `durable target mapping missing: ${relativePath}`,
      {
        localFailureClass: "durable_target_mapping_missing",
        evidence: {
          targetLocator: relativePath,
          durableKind: kind,
          durableMode: "strict",
          completedPublishRule: "forbidden",
          redactedEvidenceLocator: basename(path),
        },
      },
    );
  }
  const durableKind = kind === "lock"
    ? "json-lock"
    : kind === "sqlite-lock"
      ? "sqlite"
      : mapped?.durableKind ?? kind;
  return withoutUndefined({
    targetMappingRule: mapped == null ? "nonProductionDefault" : "explicit",
    targetMappingPattern: mapped?.pattern.source,
    lane: mapped?.lane ?? inferDurableLane(relativePath),
    targetMappingOwner:
      mapped?.targetMappingOwner ?? inferDurableOwner(relativePath),
    durableKind,
    targetFamily: mapped?.targetFamily,
    startupCriticality: mapped?.startupCriticality,
    runnerStartPreflightMode: mapped?.runnerStartPreflightMode,
    normalRunnerPrimaryQuarantine: mapped?.normalRunnerPrimaryQuarantine,
    laneTimeoutMs: durableDefaultLaneTimeoutMs,
    releaseOn: durableReleaseOn,
  });
}

function durableDirectoryFsyncMapping(relativePath, path) {
  const mapped = durableDirectoryFsyncScopeTable.find(({ pattern }) =>
    pattern.test(relativePath)
  );
  if (mapped == null && isProductionDurableTarget(relativePath, "directory-fsync")) {
    throw new DurableStateError(
      `durable directory target mapping missing: ${relativePath}`,
      {
        localFailureClass: "durable_target_mapping_missing",
        evidence: {
          directoryTargetLocator: relativePath,
          fsyncTarget: relativePath,
          directoryDurableKind: "directory",
          durableMode: "strict",
          completedPublishRule: "forbidden",
          redactedEvidenceLocator: basename(path),
        },
      },
    );
  }
  return withoutUndefined({
    targetMappingRule: mapped == null ? "nonProductionDefault" : "directoryScope",
    targetMappingPattern: mapped?.pattern.source,
    lane: mapped?.lane ?? inferDurableLane(relativePath),
    targetMappingOwner:
      mapped?.targetMappingOwner ?? inferDurableOwner(relativePath),
    durableKind: "directory",
    directoryDurableKind: "directory",
    laneTimeoutMs: durableDefaultLaneTimeoutMs,
    releaseOn: durableReleaseOn,
  });
}

function isProductionDurableTarget(relativePath, kind) {
  if (relativePath.startsWith("graph_vault/")) return true;
  if (relativePath.startsWith(".qmd/") || relativePath.includes("/.qmd/")) {
    return true;
  }
  return kind === "sqlite-lock" ||
    relativePath.endsWith("index.sqlite") ||
    relativePath.endsWith("index.sqlite.lock");
}

function primaryTargetRelativePathForMapping(relativePath) {
  if (relativePath.endsWith(".sha256.meta.json")) {
    return relativePath.slice(0, -".sha256.meta.json".length);
  }
  if (relativePath.endsWith(".sha256")) {
    return relativePath.slice(0, -".sha256".length);
  }
  return relativePath;
}

function inferDurableLane(relativePath) {
  if (relativePath.includes("/batch-runs/") && relativePath.includes("/items/")) {
    return "checkpointWriterLane";
  }
  if (
    relativePath.includes("/batch-runs/") &&
    relativePath.includes("/book-leases/")
  ) {
    return "checkpointWriterLane";
  }
  if (relativePath.includes("/books/")) return "checkpointWriterLane";
  if (relativePath.endsWith("/settings.yaml")) return "catalogWriterLane";
  if (relativePath.includes("/catalog/batch-runs/")) return "manifestWriterLane";
  if (relativePath.includes("/catalog/")) return "catalogWriterLane";
  if (relativePath.endsWith(".qmd/index.sqlite") ||
    relativePath.endsWith("index.sqlite")) {
    return "qmdIndexWriterLane";
  }
  return "durableStateStoreLane";
}

function inferDurableOwner(relativePath) {
  if (relativePath.endsWith("/settings.yaml")) return "settingsProjection";
  if (relativePath.includes("/graph-capabilities.yaml")) return "capabilityCatalog";
  if (relativePath.endsWith(".qmd/index.sqlite") ||
    relativePath.endsWith("index.sqlite")) {
    return "qmd";
  }
  if (relativePath.includes("/batch-runs/")) return "batchCoordinator";
  if (relativePath.includes("/dspy/")) return "dspyPolicyStore";
  return "repository";
}

function localDurableEvidence(input) {
  return withoutUndefined({
    failureKind: input.failureKind ?? "local_state_integrity",
    retryable: input.retryable,
    localFailureClass: input.localFailureClass,
    recoveryDecision: input.recoveryDecision,
    activeCommand: input.activeCommand,
    targetLocator: input.targetLocator,
    redactedEvidenceLocator: input.redactedEvidenceLocator,
    lane: input.lane,
    targetMappingOwner: input.targetMappingOwner,
    laneTimeoutMs: input.laneTimeoutMs,
    releaseOn: input.releaseOn,
    tempId: input.tempId,
    operationId: input.operationId,
    failedStage: input.failedStage,
    failedSyscall: input.failedSyscall,
    errno: input.errno,
    renameCause: input.renameCause,
    completedPublishRule: input.completedPublishRule,
    lockOwnerEvidence: input.lockOwnerEvidence,
    checksumRecoveryDecision: input.checksumRecoveryDecision,
    fsyncTarget: input.fsyncTarget,
    fsyncErrno: input.fsyncErrno,
    fsyncPlatform: input.fsyncPlatform,
    directoryTargetLocator: input.directoryTargetLocator,
    directoryDurableKind: input.directoryDurableKind,
    primaryDurableKind: input.primaryDurableKind,
    durableMode: input.durableMode,
    primaryTargetLocator: input.primaryTargetLocator,
    sidecarTargetLocator: input.sidecarTargetLocator,
    sidecarKind: input.sidecarKind,
    checksumExpected: input.checksumExpected,
    checksumActual: input.checksumActual,
    cleanupReason: input.cleanupReason,
    repairAllowed: input.repairAllowed,
    statusJsonDecision: input.statusJsonDecision,
    diagnosticClass: input.diagnosticClass,
    normalRunnerAction: input.normalRunnerAction,
    scannedTargetCount: input.scannedTargetCount,
    degradedTargetCount: input.degradedTargetCount,
    sampleTargetLocators: input.sampleTargetLocators,
    scanTruncated: input.scanTruncated,
    maxRunnerStartScannedTargets: input.maxRunnerStartScannedTargets,
    maxRunnerStartReportedSamples: input.maxRunnerStartReportedSamples,
    maxRunnerStartMutationCount: input.maxRunnerStartMutationCount,
    evidenceIncomplete: input.evidenceIncomplete,
    evidenceIncompleteReason: input.evidenceIncompleteReason,
    unavailableFieldSentinels: input.unavailableFieldSentinels,
    runnerSessionId: input.runnerSessionId,
    runnerHost: input.runnerHost,
    runnerPid: input.runnerPid,
    workerId: input.workerId,
    itemId: input.itemId,
    bookId: input.bookId,
    ownerPid: input.ownerPid,
    ownerHost: input.ownerHost,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    leaseGeneration: input.leaseGeneration,
    bookLeaseGeneration: input.bookLeaseGeneration,
    targetGeneration: input.targetGeneration,
    fencingTokenHash: input.fencingTokenHash,
  });
}

class DurableStateError extends Error {
  constructor(message, input) {
    super(message);
    this.name = "DurableStateError";
    this.failureKind = input.failureKind ?? "local_state_integrity";
    this.localFailureClass = input.localFailureClass;
    this.retryable = false;
    this.recoveryDecision = "stop_until_fixed";
    this.failedStage = input.failedStage ?? "durable_state";
    this.evidence = localDurableEvidence({
      failureKind: this.failureKind,
      localFailureClass: this.localFailureClass,
      ...(input.evidence ?? {}),
    });
    if (input.cause != null) this.cause = input.cause;
  }
}

function durableEvidenceFromError(error) {
  if (error instanceof DurableStateError) return error.evidence;
  if (
    error != null &&
    typeof error === "object" &&
    "localFailureClass" in error
  ) {
    return localDurableEvidence({
      failureKind: error.failureKind,
      localFailureClass: error.localFailureClass,
      ...(error.evidence ?? {}),
    });
  }
  return {};
}

function durableProjection(source) {
  if (source == null || typeof source !== "object") return {};
  const metadata = source.metadata != null && typeof source.metadata === "object"
    ? source.metadata
    : {};
  const field = (name) =>
    Object.hasOwn(source, name) && source[name] !== undefined
      ? source[name]
      : metadata[name];
  return localDurableEvidence({
    failureKind: field("failureKind"),
    retryable: field("retryable"),
    localFailureClass: field("localFailureClass"),
    recoveryDecision: field("recoveryDecision"),
    activeCommand: field("activeCommand"),
    targetLocator: field("targetLocator"),
    redactedEvidenceLocator:
      field("redactedEvidenceLocator"),
    lane: field("lane"),
    targetMappingOwner: field("targetMappingOwner"),
    laneTimeoutMs: field("laneTimeoutMs"),
    releaseOn: field("releaseOn"),
    tempId: field("tempId"),
    operationId: field("operationId"),
    failedStage: field("failedStage"),
    failedSyscall: field("failedSyscall"),
    errno: field("errno"),
    renameCause: field("renameCause"),
    completedPublishRule:
      field("completedPublishRule"),
    lockOwnerEvidence: field("lockOwnerEvidence"),
    checksumRecoveryDecision:
      field("checksumRecoveryDecision"),
    fsyncTarget: field("fsyncTarget"),
    fsyncErrno: field("fsyncErrno"),
    fsyncPlatform: field("fsyncPlatform"),
    directoryTargetLocator:
      field("directoryTargetLocator"),
    directoryDurableKind:
      field("directoryDurableKind"),
    primaryDurableKind:
      field("primaryDurableKind"),
    durableMode: field("durableMode"),
    primaryTargetLocator:
      field("primaryTargetLocator"),
    sidecarTargetLocator:
      field("sidecarTargetLocator"),
    sidecarKind: field("sidecarKind"),
    checksumExpected: field("checksumExpected"),
    checksumActual: field("checksumActual"),
    cleanupReason: field("cleanupReason"),
    repairAllowed: field("repairAllowed"),
    statusJsonDecision: field("statusJsonDecision"),
    diagnosticClass: field("diagnosticClass"),
    normalRunnerAction: field("normalRunnerAction"),
    scannedTargetCount: field("scannedTargetCount"),
    degradedTargetCount: field("degradedTargetCount"),
    sampleTargetLocators: field("sampleTargetLocators"),
    scanTruncated: field("scanTruncated"),
    maxRunnerStartScannedTargets: field("maxRunnerStartScannedTargets"),
    maxRunnerStartReportedSamples: field("maxRunnerStartReportedSamples"),
    maxRunnerStartMutationCount: field("maxRunnerStartMutationCount"),
    evidenceIncomplete:
      field("evidenceIncomplete"),
    evidenceIncompleteReason:
      field("evidenceIncompleteReason"),
    unavailableFieldSentinels:
      field("unavailableFieldSentinels"),
    runnerSessionId: field("runnerSessionId"),
    runnerHost: field("runnerHost"),
    runnerPid: field("runnerPid"),
    workerId: field("workerId"),
    itemId: field("itemId"),
    bookId: field("bookId"),
    ownerPid: field("ownerPid"),
    ownerHost: field("ownerHost"),
    createdAt: field("createdAt"),
    expiresAt: field("expiresAt"),
    leaseGeneration: field("leaseGeneration"),
    bookLeaseGeneration:
      field("bookLeaseGeneration"),
    targetGeneration: field("targetGeneration"),
    fencingTokenHash: field("fencingTokenHash"),
  });
}

function durableFailureForError(error, fallbackTarget) {
  if (error instanceof DurableStateError) {
    return {
      failureKind: error.failureKind,
      retryable: false,
      localFailureClass: error.localFailureClass,
      recoveryDecision: error.recoveryDecision,
      failedStage: error.failedStage,
      ...durableEvidenceFromError(error),
    };
  }
  const classified = classifyFailure(error instanceof Error ? error.message : String(error));
  if (
    classified.failureKind === "local_state_integrity" ||
    classified.failureKind === "local_state_lock_timeout"
  ) {
    return {
      ...classified,
      retryable: false,
      recoveryDecision: "stop_until_fixed",
      failedStage: "durable_state",
      targetLocator: fallbackTarget == null ? undefined : relative(root, fallbackTarget),
      redactedEvidenceLocator: fallbackTarget == null
        ? undefined
        : basename(fallbackTarget),
    };
  }
  return {};
}

function parseDurableFailureEnvelope(text, commandName, item) {
  const lines = String(text ?? "").split(/\r?\n/u);
  for (const line of lines) {
    if (!line.includes(DurableFailureEnvelopeMarker)) continue;
    const jsonStart = line.indexOf("{");
    if (jsonStart < 0) {
      return incompleteSubprocessDurableFailure(commandName, item, [
        "json_object",
      ]);
    }
    try {
      const payload = JSON.parse(line.slice(jsonStart));
      return normalizeDurableFailureEnvelope(payload, commandName, item);
    } catch {
      return incompleteSubprocessDurableFailure(commandName, item, [
        "parseable_json",
      ]);
    }
  }
  return null;
}

function isDurableSubprocessCommand(commandName) {
  return String(commandName).startsWith("resume-book-") ||
    String(commandName).startsWith("repair-local-artifact-gate-");
}

function confirmedLocalDurableFailure(failure) {
  return failure?.failureKind === "local_state_integrity" ||
    failure?.failureKind === "local_state_lock_timeout";
}

function missingDurableSubprocessEnvelopeFailure(commandName, item, failure) {
  if (!isDurableSubprocessCommand(commandName)) return null;
  if (!confirmedLocalDurableFailure(failure)) return null;
  return incompleteSubprocessDurableFailure(commandName, item, ["envelope"]);
}

function normalizeDurableFailureEnvelope(payload, commandName, item) {
  if (payload == null || typeof payload !== "object") {
    return incompleteSubprocessDurableFailure(commandName, item, ["payload"]);
  }
  const evidence = payload.evidence != null && typeof payload.evidence === "object"
    ? payload.evidence
    : {};
  const source = { ...evidence, ...payload };
  const missing = durableEnvelopeMissingFields(source);
  const normalized = localDurableEvidence({
    failureKind: source.failureKind ?? "local_state_integrity",
    retryable: source.retryable,
    localFailureClass: source.localFailureClass,
    recoveryDecision: source.recoveryDecision ?? "stop_until_fixed",
    activeCommand: commandName,
    failedStage: commandName,
    targetLocator: source.targetLocator,
    redactedEvidenceLocator: source.redactedEvidenceLocator,
    lane: source.lane,
    targetMappingOwner: source.targetMappingOwner,
    laneTimeoutMs: source.laneTimeoutMs,
    releaseOn: source.releaseOn,
    tempId: source.tempId,
    operationId: source.operationId,
    failedSyscall: source.failedSyscall,
    errno: source.errno,
    renameCause: source.renameCause,
    completedPublishRule: source.completedPublishRule ?? "forbidden",
    lockOwnerEvidence: source.lockOwnerEvidence,
    checksumRecoveryDecision: source.checksumRecoveryDecision,
    cleanupReason: source.cleanupReason,
    fsyncTarget: source.fsyncTarget,
    fsyncErrno: source.fsyncErrno,
    fsyncPlatform: source.fsyncPlatform,
    directoryTargetLocator: source.directoryTargetLocator,
    directoryDurableKind: source.directoryDurableKind,
    primaryDurableKind: source.primaryDurableKind,
    durableMode: source.durableMode,
    primaryTargetLocator: source.primaryTargetLocator,
    sidecarTargetLocator: source.sidecarTargetLocator,
    sidecarKind: source.sidecarKind,
    checksumExpected: source.checksumExpected,
    checksumActual: source.checksumActual,
    evidenceIncomplete: source.evidenceIncomplete,
    evidenceIncompleteReason: source.evidenceIncompleteReason,
    unavailableFieldSentinels: source.unavailableFieldSentinels,
    repairAllowed: source.repairAllowed,
    runnerSessionId: source.runnerSessionId,
    runnerHost: source.runnerHost,
    runnerPid: source.runnerPid,
    workerId: source.workerId ?? item.workerId,
    itemId: source.itemId ?? item.itemId,
    bookId: source.bookId ?? item.bookId,
    ownerPid: source.ownerPid,
    ownerHost: source.ownerHost,
    createdAt: source.createdAt,
    expiresAt: source.expiresAt,
    leaseGeneration: source.leaseGeneration ?? item.bookLeaseGeneration,
    bookLeaseGeneration: source.bookLeaseGeneration ?? item.bookLeaseGeneration,
    targetGeneration: source.targetGeneration,
    fencingTokenHash: source.fencingTokenHash,
  });
  if (missing.length === 0) {
    return {
      ...normalized,
      failureKind: normalized.failureKind ?? "local_state_integrity",
      localFailureClass: normalized.localFailureClass ??
        "durable_subprocess_evidence_incomplete",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
      failedStage: commandName,
      completedPublishRule: normalized.completedPublishRule ?? "forbidden",
    };
  }
  return {
    ...incompleteSubprocessDurableFailure(commandName, item, missing),
    ...withoutUndefined(normalized),
    retryable: false,
    recoveryDecision: "stop_until_fixed",
    failedStage: commandName,
    localFailureClass: "durable_subprocess_evidence_incomplete",
    completedPublishRule: "forbidden",
    evidenceIncomplete: true,
    evidenceIncompleteReason: `missing:${missing.join(",")}`,
    unavailableFieldSentinels: missing,
  };
}

function durableEnvelopeMissingFields(source) {
  const required = [
    "schemaVersion",
    "marker",
    "status",
    "failureKind",
    "localFailureClass",
    "retryable",
    "recoveryDecision",
    "failedStage",
    "tempId",
    "operationId",
    "failedSyscall",
    "errno",
    "renameCause",
    "lane",
    "targetMappingOwner",
    "itemId",
    "bookId",
    "workerId",
    "leaseGeneration",
    "completedPublishRule",
  ];
  const missing = required.filter((field) =>
    source[field] == null || source[field] === ""
  );
  if (
    (source.targetLocator == null || source.targetLocator === "") &&
    (
      source.redactedEvidenceLocator == null ||
      source.redactedEvidenceLocator === ""
    )
  ) {
    missing.push("targetLocator_or_redactedEvidenceLocator");
  }
  if (source.marker !== DurableFailureEnvelopeMarker) missing.push("marker");
  if (source.status !== "failed") missing.push("status");
  if (source.schemaVersion !== SchemaVersion) missing.push("schemaVersion");
  if (source.retryable !== false) missing.push("retryable");
  if (source.recoveryDecision !== "stop_until_fixed") {
    missing.push("recoveryDecision");
  }
  return [...new Set(missing)];
}

function incompleteSubprocessDurableFailure(commandName, item, missing) {
  const unavailable = [...new Set(missing)];
  return {
    failureKind: "local_state_integrity",
    localFailureClass: "durable_subprocess_evidence_incomplete",
    retryable: false,
    recoveryDecision: "stop_until_fixed",
    failedStage: commandName,
    activeCommand: commandName,
    targetLocator: "unavailable",
    redactedEvidenceLocator: `${item.itemId}-${commandName}.err`,
    tempId: "unavailable",
    operationId: "unavailable",
    failedSyscall: "unavailable",
    errno: "unavailable",
    renameCause: "unavailable",
    completedPublishRule: "forbidden",
    itemId: item.itemId,
    bookId: item.bookId,
    workerId: item.workerId,
    leaseGeneration: item.bookLeaseGeneration,
    evidenceIncomplete: true,
    evidenceIncompleteReason: `missing:${unavailable.join(",")}`,
    unavailableFieldSentinels: unavailable,
  };
}

function emitDurableFailureEvent(eventName, error, metadata = {}) {
  if (statusJson) return null;
  const failure = durableFailureForError(error, metadata.absoluteTargetLocator);
  const payload = {
    event: eventName,
    status: "failed",
    failureKind: failure.failureKind ?? "local_state_integrity",
    retryable: false,
    recoveryDecision: "stop_until_fixed",
    failedStage: "durable_state",
    message: error instanceof Error ? error.message : String(error),
    ...durableProjection(failure),
    metadata: {
      ...durableProjection(failure),
      ...metadata,
    },
  };
  try {
    return event(payload);
  } catch {
    return null;
  }
}

function isDurableTempEntry(path, entry) {
  if (entry.endsWith(".owner.json")) return false;
  return entry.startsWith(`${basename(path)}.tmp-`) ||
    (entry.startsWith(`${basename(path)}.`) && entry.endsWith(".tmp"));
}

function isDurableAuxiliaryJsonEntry(entry) {
  return isDurableAuxiliaryPath(entry) && entry.endsWith(".json");
}

function isDurableAuxiliaryPath(path) {
  const name = basename(path);
  return name.endsWith(".owner.json") ||
    name.endsWith(".sha256") ||
    name.endsWith(".sha256.meta.json") ||
    name.endsWith(".lock") ||
    name.includes(".tmp-") ||
    name.includes(".corrupt-");
}

function isDurablePrimaryJsonEntry(entry) {
  return entry.endsWith(".json") && !isDurableAuxiliaryJsonEntry(entry);
}

function isDurablePrimaryYamlEntry(entry) {
  return entry.endsWith(".yaml") && !isDurableAuxiliaryPath(entry);
}

function stableRecoveredToken(prefix, parts) {
  return `${prefix}-${sha256Text(JSON.stringify(parts)).slice(0, 24)}`;
}

function durableChecksumPath(path) {
  return `${path}.sha256`;
}

function leaseExpiresAt() {
  return isoAfterSeconds(runnerHeartbeatTtlSeconds);
}

function fileExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function countJsonFiles(path) {
  try {
    return readdirSync(path).filter(isDurablePrimaryJsonEntry).length;
  } catch {
    return 0;
  }
}

function directoryFsyncEvidence(path, operation = undefined) {
  const directoryTargetLocator = durableLocator(path);
  if (operation == null) {
    return durableOperationEvidence(path, "directory-fsync", {
      directoryTargetLocator,
      fsyncTarget: directoryTargetLocator,
    });
  }
  const directoryMapping = durableTargetMapping(path, "directory-fsync");
  const primaryTargetLocator =
    operation.primaryTargetLocator ?? operation.targetLocator;
  const primaryDurableKind =
    operation.primaryDurableKind ?? operation.durableKind ?? operation.kind;
  return withoutUndefined({
    ...operation,
    lane: operation.lane ?? directoryMapping.lane,
    targetMappingOwner:
      operation.targetMappingOwner ?? directoryMapping.targetMappingOwner,
    targetMappingPattern:
      operation.targetMappingPattern ?? directoryMapping.targetMappingPattern,
    directoryTargetLocator,
    directoryDurableKind: "directory",
    primaryTargetLocator,
    primaryDurableKind,
    fsyncTarget: directoryTargetLocator,
    targetMappingRule:
      operation.targetMappingRule === "nonProductionDefault"
        ? operation.targetMappingRule
        : "derivedDirectoryFsync",
  });
}

function fsyncErrnoSentinel(errno) {
  return errno == null || errno === "" ||
    ["unknown", "unsupported", "unavailable", "platform_no_errno"]
      .includes(String(errno));
}

function fsyncDirectory(path, operation = undefined) {
  if (statusJson) return;
  let fd = null;
  const fsyncOperation = directoryFsyncEvidence(path, operation);
  try {
    maybeInjectDirectoryFsyncFailure(path, fsyncOperation);
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const fsyncErrno = error?.code ?? "unknown";
    throw new DurableStateError(`durable directory fsync failed: ${durableLocator(path)}`, {
      localFailureClass: "durable_directory_fsync_uncertain",
      cause: error,
      evidence: {
        ...fsyncOperation,
        fsyncTarget: fsyncOperation.fsyncTarget,
        fsyncErrno,
        fsyncPlatform: process.platform,
        unavailableFieldSentinels:
          fsyncErrnoSentinel(fsyncErrno) ? ["fsyncErrno"] : undefined,
        durableMode: "strict",
        completedPublishRule: "forbidden",
        redactedEvidenceLocator: basename(path),
      },
    });
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort only.
      }
    }
  }
}

function maybeInjectDirectoryFsyncFailure(path, operation = undefined) {
  if (
    testDirectoryFsyncFailureInjected ||
    testDirectoryFsyncFailurePattern === ""
  ) {
    return;
  }
  const candidates = [
    durableLocator(path),
    operation?.directoryTargetLocator,
    operation?.targetLocator,
    operation?.primaryTargetLocator,
    operation?.sidecarTargetLocator,
    operation?.fsyncTarget,
  ].filter((value) => typeof value === "string" && value.length > 0);
  if (!candidates.some((target) =>
    target.includes(testDirectoryFsyncFailurePattern)
  )) {
    return;
  }
  testDirectoryFsyncFailureMatchCount += 1;
  if (
    testDirectoryFsyncFailureMatchCount <=
      testDirectoryFsyncFailureAfterMatches
  ) {
    return;
  }
  testDirectoryFsyncFailureInjected = true;
  const error = new Error("injected directory fsync failure");
  error.code = "EIO";
  throw error;
}

function durableFileFsyncError(path, error, operation) {
  return new DurableStateError(`durable file fsync failed: ${durableLocator(path)}`, {
    localFailureClass: "durable_fsync_failed",
    cause: error,
    evidence: {
      ...operation,
      fsyncTarget: durableLocator(path),
      fsyncErrno: error?.code ?? "unknown",
      fsyncPlatform: process.platform,
      durableMode: "strict",
      completedPublishRule: "forbidden",
      redactedEvidenceLocator: basename(path),
    },
  });
}

function writeFileDurable(path, text, options = {}) {
  if (statusJson) return;
  const operation = options.operation ?? durableOperationEvidence(path, "file");
  mkdirSync(dirname(path), { recursive: true });
  let fd = null;
  try {
    fd = openSync(path, options.flag ?? "w");
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    if (error?.code === "EEXIST") throw error;
    throw durableFileFsyncError(path, error, operation);
  } finally {
    if (fd != null) closeSync(fd);
  }
  if (options.fsyncParent !== false) fsyncDirectory(dirname(path), operation);
}

class AsyncSemaphore {
  constructor(limit, name) {
    this.limit = Math.max(1, limit);
    this.name = name;
    this.active = 0;
    this.queue = [];
  }

  async acquire(metadata = {}) {
    const requestedAt = Date.now();
    if (this.active < this.limit && this.queue.length === 0) {
      this.active += 1;
    } else {
      await new Promise((resolveAcquire) => {
        this.queue.push(resolveAcquire);
      });
    }
    let released = false;
    const waitMs = Date.now() - requestedAt;
    if (waitMs > 0 || metadata.eventOnImmediate === true) {
      event({
        itemId: metadata.itemId,
        event: `${this.name}_slot_acquired`,
        status: metadata.status,
        command: metadata.command,
        metadata: withoutUndefined({
          provider: metadata.provider ?? this.name,
          workerId: metadata.workerId,
          bookId: metadata.bookId,
          command: metadata.command,
          waitMs,
          activeSlots: this.active,
          queuedSlots: this.queue.length,
          limit: this.limit,
        }),
      });
    }
    return {
      waitMs,
      release: () => {
        if (released) return;
        released = true;
        const activeAfterRelease = Math.max(0, this.active - 1);
        event({
          itemId: metadata.itemId,
          event: `${this.name}_slot_released`,
          status: metadata.status,
          command: metadata.command,
          metadata: withoutUndefined({
            provider: metadata.provider ?? this.name,
            workerId: metadata.workerId,
            bookId: metadata.bookId,
            command: metadata.command,
            activeSlots: activeAfterRelease,
            queuedSlots: this.queue.length,
            limit: this.limit,
          }),
        });
        this.active = activeAfterRelease;
        this.drain();
      },
    };
  }

  drain() {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      this.active += 1;
      next();
    }
  }
}

function providerSlotProviderName(name) {
  if (name === "openai_provider") return "openai";
  if (name === "jina_provider") return "jina";
  if (name === "local_cpu") return "local_cpu";
  if (name === "qmd_index_writer") return "qmd_index_writer";
  return name;
}

function providerSlotPath(slotId) {
  return join(providerSlotRoot, `${slotId}.json`);
}

function readProviderSlotLeases() {
  try {
    return readdirSync(providerSlotRoot)
      .filter(isDurablePrimaryJsonEntry)
      .filter((name) => !name.endsWith(".registry.json"))
      .map((name) => readTypedJsonIfExists(
        join(providerSlotRoot, name),
        ProviderSlotLeaseSchema,
      ))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function providerSlotLeaseLive(lease) {
  if (lease == null) return false;
  if (epochMs(lease.expiresAt) <= Date.now()) return false;
  if (lease.runnerHost === runnerHost) return processAlive(lease.runnerPid);
  return true;
}

function activeProviderSlotLeases() {
  return readProviderSlotLeases().filter((lease) => providerSlotLeaseLive(lease));
}

function recoverProviderSlotLeaseUnderRegistryLock(lease, reason) {
  const path = providerSlotPath(lease.slotId);
  const current = readTypedJsonIfExists(path, ProviderSlotLeaseSchema);
  if (
    current == null ||
    current.runnerSessionId !== lease.runnerSessionId ||
    current.generation !== lease.generation ||
    current.fencingToken !== lease.fencingToken
  ) {
    return false;
  }
  rmSync(path, { force: true });
  fsyncDirectory(providerSlotRoot);
  event({
    event: "provider_slot_lease_recovered",
    status: "pending",
    command: lease.command,
    metadata: {
      itemId: lease.itemId,
      bookId: lease.bookId,
      workerId: lease.workerId,
      provider: lease.provider,
      slotId: lease.slotId,
      generation: lease.generation,
      previousRunnerSessionId: lease.runnerSessionId,
      reason,
    },
  });
  return true;
}

function recoverStaleProviderSlotLeases(provider) {
  for (const lease of readProviderSlotLeases().filter((item) =>
    item.provider === provider
  )) {
    const expired = epochMs(lease.expiresAt) <= Date.now();
    const deadSameHost = lease.runnerHost === runnerHost &&
      !processAlive(lease.runnerPid);
    if (!expired && !deadSameHost) continue;
    recoverProviderSlotLeaseUnderRegistryLock(
      lease,
      expired ? "expired" : "dead_same_host_runner",
    );
  }
}

function activeSubprocessRecords() {
  try {
    return readdirSync(subprocessRoot)
      .filter(isDurablePrimaryJsonEntry)
      .map((name) => readTypedJsonIfExists(
        join(subprocessRoot, name),
        SubprocessRecordSchema,
      ))
      .filter(Boolean)
      .filter((record) => record.status === "running");
  } catch {
    return [];
  }
}

function bookLeasePath(bookId) {
  return join(bookLeaseRoot, `${bookId}.json`);
}

function bookLeaseLive(lease) {
  if (lease == null) return false;
  if (epochMs(lease.expiresAt) <= Date.now()) return false;
  if (lease.runnerHost === runnerHost) return processAlive(lease.runnerPid);
  return true;
}

function readBookLeases() {
  try {
    return readdirSync(bookLeaseRoot)
      .filter(isDurablePrimaryJsonEntry)
      .map((name) => readTypedJsonIfExists(join(bookLeaseRoot, name), BookLeaseSchema))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function activeBookLeases() {
  return readBookLeases().filter((lease) => bookLeaseLive(lease));
}

function acquireBookLease(item, workerId) {
  if (statusJson) return null;
  assertCoordinatorLease();
  const path = bookLeasePath(item.bookId);
  return withJsonFileLock(path, () => {
    const current = readTypedJsonIfExistsUnlocked(path, BookLeaseSchema);
    if (bookLeaseLive(current) && current.runnerSessionId !== runnerSessionId) {
      throw new Error(
        `book ${item.bookId} already has a live worker lease: ` +
          `session=${current.runnerSessionId} item=${current.itemId}`,
      );
    }
    const acquiredAt = now();
    const lease = BookLeaseSchema.parse({
      schemaVersion: SchemaVersion,
      runId,
      bookId: item.bookId,
      itemId: item.itemId,
      workerId,
      runnerSessionId,
      runnerHost,
      runnerPid,
      generation: (current?.generation ?? 0) + 1,
      fencingToken: randomToken("book-fence"),
      acquiredAt,
      heartbeatAt: acquiredAt,
      expiresAt: leaseExpiresAt(),
    });
    writeJsonAtomicWithValue(path, lease);
    event({
      itemId: item.itemId,
      event: "book_lease_acquired",
      status: "running",
      metadata: {
        bookId: item.bookId,
        workerId,
        generation: lease.generation,
        fencingToken: lease.fencingToken,
        expiresAt: lease.expiresAt,
      },
    });
    return lease;
  });
}

function refreshBookLease(lease) {
  if (statusJson || lease == null) return lease;
  const path = bookLeasePath(lease.bookId);
  return withJsonFileLock(path, () => {
    const current = readTypedJsonIfExistsUnlocked(path, BookLeaseSchema);
    if (
      current?.runnerSessionId !== lease.runnerSessionId ||
      current?.generation !== lease.generation ||
      current?.fencingToken !== lease.fencingToken
    ) {
      throw new Error(`book lease lost for ${lease.bookId}`);
    }
    const updated = BookLeaseSchema.parse({
      ...current,
      heartbeatAt: now(),
      expiresAt: leaseExpiresAt(),
    });
    writeJsonAtomicWithValue(path, updated);
    return updated;
  });
}

function releaseBookLease(lease, status = "running") {
  if (statusJson || lease == null) return;
  const path = bookLeasePath(lease.bookId);
  withJsonFileLock(path, () => {
    const current = readTypedJsonIfExistsUnlocked(path, BookLeaseSchema);
    if (
      current?.runnerSessionId === lease.runnerSessionId &&
      current?.generation === lease.generation &&
      current?.fencingToken === lease.fencingToken
    ) {
      rmSync(path, { force: true });
      fsyncDirectory(dirname(path));
      event({
        itemId: lease.itemId,
        event: "book_lease_released",
        status,
        metadata: {
          bookId: lease.bookId,
          workerId: lease.workerId,
          generation: lease.generation,
          fencingToken: lease.fencingToken,
        },
      });
    }
  });
}

function subprocessRecordPath(subprocessId) {
  return join(subprocessRoot, `${subprocessId}.json`);
}

function writeSubprocessRecord(record) {
  if (statusJson) return record;
  return writeTypedJson(
    subprocessRecordPath(record.subprocessId),
    SubprocessRecordSchema,
    record,
  );
}

function updateSubprocessRecord(subprocessId, callback) {
  if (statusJson) return null;
  const path = subprocessRecordPath(subprocessId);
  return lockedReadWriteTypedJson(path, SubprocessRecordSchema, (current) =>
    callback(current)
  );
}

function qmdIndexFileLockPath() {
  return `${qmdIndexPath}.lock`;
}

function readQmdIndexFileLockOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) ?? {};
  } catch {
    return {};
  }
}

function qmdIndexLockOwnerExpired(owner, entry) {
  const expiryMs = epochMs(owner?.expiresAt);
  return expiryMs > 0
    ? Date.now() > expiryMs
    : Date.now() - entry.mtimeMs > qmdIndexFileLockStaleMs;
}

function qmdIndexLockHasRecoveryFence(owner) {
  return Number.isInteger(owner?.generation) &&
    typeof owner?.fencingTokenHash === "string" &&
    owner.fencingTokenHash.length > 0 &&
    typeof owner?.runnerSessionId === "string" &&
    owner.runnerSessionId.length > 0 &&
    typeof owner?.operationId === "string" &&
    owner.operationId.length > 0;
}

function removeStaleQmdIndexFileLock(lockPath) {
  try {
    const entry = statSync(lockPath);
    if (Date.now() - entry.mtimeMs <= qmdIndexFileLockStaleMs) return false;
    const owner = readQmdIndexFileLockOwner(lockPath);
    if (!qmdIndexLockOwnerExpired(owner, entry)) return false;
    if (!qmdIndexLockHasRecoveryFence(owner)) return false;
    if (processAlive(owner.pid)) return false;
    unlinkSync(lockPath);
    fsyncDirectory(dirname(lockPath), owner);
    event({
      event: "qmd_index_file_lock_recovered",
      status: "pending",
      metadata: {
        lockPath: relative(root, lockPath),
        previousPid: owner.pid,
        previousRunnerSessionId: owner.runnerSessionId,
        lockOwnerEvidence: redactJsonValue(owner),
        recoveryDecision: "stale_lock_removed",
      },
    });
    return true;
  } catch (error) {
    if (error instanceof DurableStateError) throw error;
    return false;
  }
}

function qmdIndexLockOwnedBy(lockPath, expected) {
  const current = readQmdIndexFileLockOwner(lockPath);
  return current.operationId === expected.operationId &&
    current.runnerSessionId === expected.runnerSessionId &&
    current.generation === expected.generation &&
    current.fencingTokenHash === expected.fencingTokenHash;
}

function releaseQmdIndexFileLock(lockPath, owner) {
  if (!qmdIndexLockOwnedBy(lockPath, owner)) return false;
  unlinkSync(lockPath);
  fsyncDirectory(dirname(lockPath), owner);
  return true;
}

async function withQmdIndexFileLock(callback, metadata = {}) {
  if (statusJson) return await callback();
  const lockPath = qmdIndexFileLockPath();
  const startedAt = Date.now();
  for (;;) {
    let fd = null;
    try {
      mkdirSync(dirname(qmdIndexPath), { recursive: true });
      fd = openSync(lockPath, "wx");
      const mapping = durableTargetMapping(qmdIndexPath, "sqlite-lock");
      const generation = coordinatorLease?.generation ?? 1;
      const fencingTokenHash = coordinatorLease?.fencingToken == null
        ? sha256Text([
            "qmd-index",
            runnerSessionId,
            runId,
            String(generation),
          ].join(":"))
        : sha256Text(coordinatorLease.fencingToken);
      const owner = {
        pid: runnerPid,
        ownerPid: runnerPid,
        runnerSessionId,
        runId,
        runnerHost,
        ownerHost: runnerHost,
        targetLocator: relative(root, qmdIndexPath),
        lockPath: relative(root, lockPath),
        ...mapping,
        generation,
        fencingTokenHash,
        operationId: randomToken("qmd-index-lock"),
        command: metadata.command,
        itemId: metadata.itemId,
        bookId: metadata.bookId,
        workerId: metadata.workerId,
        acquiredAt: now(),
        heartbeatAt: now(),
        expiresAt: new Date(Date.now() + qmdIndexFileLockStaleMs).toISOString(),
        durableMode: "strict",
        durableAdapterContract,
      };
      writeSync(fd, JSON.stringify(owner) + "\n");
      fsyncSync(fd);
      event({
        itemId: metadata.itemId,
        event: "qmd_index_file_lock_acquired",
        status: metadata.status,
        command: metadata.command,
        metadata: {
          bookId: metadata.bookId,
          workerId: metadata.workerId,
          waitMs: Date.now() - startedAt,
          generation: owner.generation,
          fencingTokenHash: owner.fencingTokenHash,
          operationId: owner.operationId,
          lane: owner.lane,
          targetMappingOwner: owner.targetMappingOwner,
          durableKind: owner.durableKind,
          laneTimeoutMs: owner.laneTimeoutMs,
          releaseOn: owner.releaseOn,
          ...durableProjection(owner),
        },
      });
      try {
        return await callback();
      } finally {
        try {
          closeSync(fd);
        } catch {
          // Best-effort cleanup only.
        }
        fd = null;
        const released = releaseQmdIndexFileLock(lockPath, owner);
        event({
          itemId: metadata.itemId,
          event: "qmd_index_file_lock_released",
          status: metadata.status,
          command: metadata.command,
          metadata: {
            bookId: metadata.bookId,
            workerId: metadata.workerId,
            released,
            generation: owner.generation,
            fencingTokenHash: owner.fencingTokenHash,
            operationId: owner.operationId,
            lane: owner.lane,
            targetMappingOwner: owner.targetMappingOwner,
            durableKind: owner.durableKind,
            laneTimeoutMs: owner.laneTimeoutMs,
            releaseOn: owner.releaseOn,
            ...durableProjection(owner),
          },
        });
      }
    } catch (error) {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // Best-effort cleanup only.
        }
      }
      if (error?.code !== "EEXIST") throw error;
      removeStaleQmdIndexFileLock(lockPath);
      if (Date.now() - startedAt > qmdIndexFileLockWaitMs) {
        const lockOwnerEvidence = readQmdIndexFileLockOwner(lockPath);
        const mapping = durableTargetMapping(qmdIndexPath, "sqlite-lock");
        const durableError = new DurableStateError(
          `timed out waiting for qmd index file lock: ${relative(root, lockPath)}`,
          {
            failureKind: "local_state_lock_timeout",
            localFailureClass: "durable_state_lock_timeout",
            evidence: {
              targetLocator: relative(root, qmdIndexPath),
              redactedEvidenceLocator: basename(qmdIndexPath),
              lockPath: relative(root, lockPath),
              ...mapping,
              lockOwnerEvidence: redactJsonValue(lockOwnerEvidence),
              durableMode: "strict",
              completedPublishRule: "forbidden",
            },
          },
        );
        emitDurableFailureEvent("durable_lock_timeout", durableError, {
          targetLocator: relative(root, qmdIndexPath),
        });
        throw durableError;
      }
      await delay(25);
    }
  }
}

function terminateProcessTree(child, signal) {
  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to direct child termination below.
  }
  try {
    child.kill(signal);
  } catch {
    // Process may have already exited.
  }
}

function terminatePid(pid, processGroup, signal) {
  try {
    if (pid && processGroup && process.platform !== "win32") {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // Fall back to direct pid termination below.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Process may have already exited.
  }
}

function requestBatchStop(reason) {
  if (batchStopRequested) return;
  batchStopRequested = true;
  batchStopReason = batchStopReason ?? reason;
  event({
    event: "batch_stop_requested",
    status: "failed",
    recoveryDecision: "stop_until_fixed",
    metadata: {
      reason,
      activeSubprocesses: activeChildProcesses.size,
    },
  });
}

function terminateActiveSubprocesses(reason, signal = "SIGTERM") {
  if (activeChildProcesses.size === 0) return;
  event({
    event: "batch_active_subprocesses_terminating",
    status: "failed",
    recoveryDecision: "stop_until_fixed",
    metadata: {
      reason,
      signal,
      activeSubprocesses: activeChildProcesses.size,
    },
  });
  for (const child of activeChildProcesses.values()) {
    terminateProcessTree(child, signal);
  }
}

function handleTerminationSignal(signal) {
  if (terminationSignalHandling) return;
  terminationSignalHandling = true;
  const reason = `runner_signal_${signal}`;
  process.exitCode = 1;
  try {
    requestBatchStop(reason);
  } catch (error) {
    console.error(redactLog(
      error instanceof Error ? error.stack ?? error.message : String(error),
    ));
  }
  try {
    terminateActiveSubprocesses(reason, "SIGTERM");
  } catch (error) {
    console.error(redactLog(
      error instanceof Error ? error.stack ?? error.message : String(error),
    ));
  }
  setTimeout(() => {
    try {
      terminateActiveSubprocesses(`${reason}_kill_timeout`, "SIGKILL");
    } catch (error) {
      console.error(redactLog(
        error instanceof Error ? error.stack ?? error.message : String(error),
      ));
    }
  }, 750).unref();
  setTimeout(() => {
    try {
      releaseCoordinatorLock();
    } catch (error) {
      console.error(redactLog(
        error instanceof Error ? error.stack ?? error.message : String(error),
      ));
    }
    process.exit(1);
  }, 1500).unref();
}

function installTerminationSignalHandlers() {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => handleTerminationSignal(signal));
  }
}

function batchStopInterruptError(command) {
  const error = new Error(
    `batch stop requested before command: ${batchStopReason ?? "unknown"}`,
  );
  error.name = BatchStopInterruptErrorName;
  error.batchStopInterrupt = true;
  error.commandCheck = {
    name: command,
    status: "failed",
    attempts: 1,
    exitCode: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    startedAt: now(),
    completedAt: now(),
    failureKind: "transient",
    retryable: true,
    attemptExhausted: false,
    recoveryDecision: "continue_pending",
    errorSummary: "batch stop requested by coordinator",
  };
  return error;
}

function isBatchStopInterrupt(error) {
  return error != null &&
    typeof error === "object" &&
    error.batchStopInterrupt === true;
}

function buildProviderSlotLease(semaphore, metadata, waitMs) {
  if (statusJson) return null;
  const provider = providerSlotProviderName(metadata.provider ?? semaphore.name);
  const slotId = randomToken(`${provider}-slot`);
  const issuedAt = now();
  return ProviderSlotLeaseSchema.parse({
    schemaVersion: SchemaVersion,
    runId,
    provider,
    slotId,
    itemId: metadata.itemId,
    bookId: metadata.bookId,
    workerId: metadata.workerId,
    command: metadata.command,
    limit: semaphore.limit,
    waitMs,
    runnerSessionId,
    runnerHost,
    runnerPid,
    generation: coordinatorLease?.generation ?? 1,
    fencingToken: randomToken("provider-fence"),
    acquiredAt: issuedAt,
    heartbeatAt: issuedAt,
    expiresAt: leaseExpiresAt(),
  });
}

async function acquireProviderSlotLease(semaphore, metadata, waitMs) {
  if (statusJson) return null;
  const provider = providerSlotProviderName(metadata.provider ?? semaphore.name);
  const startedAt = Date.now();
  for (;;) {
    const acquired = await withJsonFileLockAsync(
      providerSlotRegistryLockPath(provider),
      async () => {
        recoverStaleProviderSlotLeases(provider);
        const active = activeProviderSlotLeases().filter((lease) =>
          lease.provider === provider
        );
        if (active.length >= semaphore.limit) return null;
        const lease = buildProviderSlotLease(
          semaphore,
          metadata,
          Date.now() - startedAt + waitMs,
        );
        writeJsonAtomicWithValue(providerSlotPath(lease.slotId), lease);
        return lease;
      },
    );
    if (acquired != null) {
      event({
        itemId: metadata.itemId,
        event: "provider_slot_lease_acquired",
        status: metadata.status,
        command: metadata.command,
        metadata: {
          slotId: acquired.slotId,
          provider,
          workerId: metadata.workerId,
          bookId: metadata.bookId,
          limit: semaphore.limit,
          waitMs: acquired.waitMs,
          fencingToken: acquired.fencingToken,
          generation: acquired.generation,
          durableCapacityGate: true,
        },
      });
      return acquired;
    }
    if (Date.now() - startedAt > providerSlotAcquireWaitMs) {
      throw new Error(
        `timed out waiting for durable provider slot: ${provider}`,
      );
    }
    await delay(100);
  }
}

function releaseProviderSlotLease(lease, metadata = {}) {
  if (lease == null || statusJson) return;
  withJsonFileLock(providerSlotRegistryLockPath(lease.provider), () => {
    const path = providerSlotPath(lease.slotId);
    const current = readTypedJsonIfExists(path, ProviderSlotLeaseSchema);
    if (
      current == null ||
      current.runnerSessionId !== lease.runnerSessionId ||
      current.generation !== lease.generation ||
      current.fencingToken !== lease.fencingToken
    ) {
      event({
        itemId: metadata.itemId ?? lease.itemId,
        event: "provider_slot_lease_release_rejected",
        status: metadata.status,
        command: metadata.command ?? lease.command,
        metadata: {
          slotId: lease.slotId,
          provider: lease.provider,
          workerId: lease.workerId,
          bookId: lease.bookId,
          generation: lease.generation,
          fencingToken: lease.fencingToken,
        },
      });
      return;
    }
    rmSync(path, { force: true });
    fsyncDirectory(providerSlotRoot);
    event({
      itemId: metadata.itemId ?? lease.itemId,
      event: "provider_slot_lease_released",
      status: metadata.status,
      command: metadata.command ?? lease.command,
      metadata: {
        slotId: lease.slotId,
        provider: lease.provider,
        workerId: lease.workerId,
        bookId: lease.bookId,
        generation: lease.generation,
        fencingToken: lease.fencingToken,
      },
    });
  });
}

const localCpuSlots = new AsyncSemaphore(localCpuConcurrency, "local_cpu");
const openaiProviderSlots = new AsyncSemaphore(
  openaiProviderConcurrency,
  "openai_provider",
);
const jinaProviderSlots = new AsyncSemaphore(jinaProviderConcurrency, "jina_provider");
const qmdIndexWriterLane = new AsyncSemaphore(1, "qmd_index_writer");

async function withSemaphore(semaphore, metadata, callback) {
  const lease = await semaphore.acquire(metadata);
  const providerSlotLease = await acquireProviderSlotLease(
    semaphore,
    metadata,
    lease.waitMs,
  );
  try {
    return await callback({ ...lease, providerSlotLease });
  } finally {
    releaseProviderSlotLease(providerSlotLease, metadata);
    lease.release();
  }
}

function providerSemaphoreForCommand(name) {
  if (name === "qmd-query-json" || name === "qmd-query-auto-json") {
    return { semaphore: openaiProviderSlots, provider: "openai" };
  }
  if (name === "qmd-query-graphrag-json") {
    return { semaphore: openaiProviderSlots, provider: "openai" };
  }
  if (name === "qmd-vsearch-json" || name === "qmd-embed") {
    return { semaphore: jinaProviderSlots, provider: "jina" };
  }
  return null;
}

function providerSemaphoreForResumeStage(checkpoint) {
  const stage = checkpoint?.graphBuildStatus?.stage ?? checkpoint?.failedStage;
  if (stage === "embed") return { semaphore: jinaProviderSlots, provider: "jina" };
  if (stage === "graph_extract" || stage === "community_report") {
    return { semaphore: openaiProviderSlots, provider: "openai" };
  }
  return { semaphore: openaiProviderSlots, provider: "openai" };
}

function providerSemaphoreForResumeNextStage(nextStage) {
  if (nextStage === "embed") return { semaphore: jinaProviderSlots, provider: "jina" };
  if (nextStage === "graph_extract" || nextStage === "community_report") {
    return { semaphore: openaiProviderSlots, provider: "openai" };
  }
  return { semaphore: openaiProviderSlots, provider: "openai" };
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
  if (payload?.itemId != null && payload?.status !== "running") {
    assertEventItemFence(payload);
  }
  eventSequence += 1;
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
    eventId: randomToken("evt"),
    sequence: eventSequence,
    runnerSessionId,
    coordinatorGeneration: coordinatorLease?.generation,
    at: now(),
    ...withoutUndefined(sanitizedPayload),
  });
  if (statusJson) return item;
  withJsonFileLock(eventsPath, () => {
    withDurableOperationContext(durableContextFromValue(item), () => {
      writeFileDurable(eventsPath, JSON.stringify(item) + "\n", {
        flag: "a",
        fsyncParent: false,
      });
    });
  });
  if (values.verbose && !statusJson) {
    const parts = [item.event, item.itemId, item.command, item.status]
      .filter(Boolean)
      .join(" ");
    process.stdout.write(`${parts}\n`);
  }
}

function assertEventItemFence(payload) {
  if (statusJson) return;
  const current = readTypedJsonIfExists(
    join(itemRoot, `${payload.itemId}.json`),
    BatchItemCheckpointSchema,
  );
  if (payload?.event === "item_running_recovered") {
    if (current?.status === "running" && runningCheckpointIsOrphaned(current)) return;
  }
  if (current?.status !== "running") {
    assertTerminalEventFinalizationFence(current, payload);
    return;
  }
  if (current.runnerSessionId !== runnerSessionId) {
    throw new Error(
      `item event fencing rejected stale event for ${payload.itemId}`,
    );
  }
  if (current.leaseExpiresAt != null && epochMs(current.leaseExpiresAt) <= Date.now()) {
    throw new Error(`item event lease expired before event: ${payload.itemId}`);
  }
  const currentLease = readTypedJsonIfExists(
    bookLeasePath(current.bookId),
    BookLeaseSchema,
  );
  if (
    currentLease == null ||
    currentLease.runnerSessionId !== runnerSessionId ||
    currentLease.generation !== current.bookLeaseGeneration ||
    currentLease.fencingToken !== current.bookFencingToken
  ) {
    throw new Error(
      `item event book fencing rejected stale event for ${payload.itemId}`,
    );
  }
}

function terminalFinalizationFenceFromCheckpoint(checkpoint) {
  const fence = checkpoint?.metadata?.terminalFinalization;
  if (fence == null || typeof fence !== "object" || Array.isArray(fence)) return null;
  const required = [
    "token",
    "runnerSessionId",
    "bookId",
    "bookLeaseGeneration",
    "bookFencingToken",
    "itemFencingToken",
    "completedFromStatus",
    "providerSlotFence",
  ];
  for (const field of required) {
    if (typeof fence[field] !== "string" && field !== "bookLeaseGeneration") {
      return null;
    }
  }
  if (!Number.isInteger(fence.bookLeaseGeneration)) return null;
  if (
    fence.activeProviderSlotsAtFinalization != null &&
    !Number.isInteger(fence.activeProviderSlotsAtFinalization)
  ) {
    return null;
  }
  return fence;
}

function assertTerminalEventFinalizationFence(current, payload) {
  if (payload?.event !== "item_completed" && payload?.event !== "item_worker_completed") {
    return;
  }
  const fence = terminalFinalizationFenceFromCheckpoint(current);
  if (fence == null) {
    throw new Error(`missing terminal finalization fence for event: ${payload.itemId}`);
  }
  const payloadFence = payload.metadata?.terminalFinalization;
  if (
    payloadFence == null ||
    payloadFence.token !== fence.token ||
    payloadFence.runnerSessionId !== runnerSessionId ||
    payloadFence.bookId !== fence.bookId ||
    payloadFence.bookLeaseGeneration !== fence.bookLeaseGeneration ||
    payloadFence.bookFencingToken !== fence.bookFencingToken ||
    payloadFence.itemFencingToken !== fence.itemFencingToken
  ) {
    throw new Error(`terminal event fencing rejected stale event for ${payload.itemId}`);
  }
}

function activeProviderSlotLeasesForItem(itemId) {
  return activeProviderSlotLeases().filter((lease) =>
    lease.itemId === itemId &&
    lease.runnerSessionId === runnerSessionId
  );
}

function assertNoActiveProviderSlotLeasesForTerminal(checkpoint) {
  const active = activeProviderSlotLeasesForItem(checkpoint.itemId);
  if (active.length > 0) {
    throw new Error(
      `terminal completion blocked by active provider slot: ${checkpoint.itemId}`,
    );
  }
}

function buildTerminalFinalizationFence(checkpoint) {
  assertNoActiveProviderSlotLeasesForTerminal(checkpoint);
  if (
    checkpoint.runnerSessionId !== runnerSessionId ||
    checkpoint.bookLeaseGeneration == null ||
    checkpoint.bookFencingToken == null ||
    checkpoint.fencingToken == null
  ) {
    throw new Error(
      `terminal completion missing item/book fencing: ${checkpoint.itemId}`,
    );
  }
  return {
    token: randomToken("item-finalize"),
    runnerSessionId,
    bookId: checkpoint.bookId,
    bookLeaseGeneration: checkpoint.bookLeaseGeneration,
    bookFencingToken: checkpoint.bookFencingToken,
    itemFencingToken: checkpoint.fencingToken,
    completedFromStatus: checkpoint.status,
    providerSlotFence: "no_active_provider_slot",
    activeProviderSlotsAtFinalization: 0,
    finalizedAt: now(),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonSidecar(path, value, operation = durableOperationEvidence(path, "json-sidecar")) {
  writeFileDurable(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    fsyncParent: false,
    operation,
  });
}

function primaryDurableKindForPath(path) {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".jsonl")) return "jsonl";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".sqlite")) return "sqlite";
  return "file";
}

function checksumSidecarWriteEvidence(primaryPath, checksumPath, value = {}) {
  return {
    primaryTargetLocator: relative(root, primaryPath),
    primaryDurableKind: primaryDurableKindForPath(primaryPath),
    sidecarTargetLocator: relative(root, checksumPath),
    sidecarKind: "checksum",
    checksum: value?.checksum,
    checksumExpected: value?.checksumExpected ?? value?.checksum,
    checksumActual: value?.checksumActual ?? value?.checksum,
    checksumRecoveryDecision: value?.checksumRecoveryDecision,
    repairAllowed: value?.repairAllowed ?? true,
  };
}

function checksumMetaWriteEvidence(path, value) {
  const primaryPath = path.endsWith(".sha256.meta.json")
    ? path.slice(0, -".sha256.meta.json".length)
    : undefined;
  if (primaryPath == null) return {};
  const hasExpected = Object.hasOwn(value ?? {}, "checksumExpected");
  return {
    primaryTargetLocator: relative(root, primaryPath),
    primaryDurableKind: primaryDurableKindForPath(primaryPath),
    sidecarTargetLocator: relative(root, path),
    sidecarKind: "checksum_meta",
    checksum: value?.checksum,
    checksumExpected: hasExpected ? value.checksumExpected : value?.checksum ?? null,
    checksumActual: value?.checksumActual ?? value?.checksum,
    checksumRecoveryDecision: value?.checksumRecoveryDecision,
    repairAllowed: value?.repairAllowed ?? true,
  };
}

function writeJsonAtomicSidecar(path, value, extra = {}) {
  const operation = durableOperationEvidence(path, "json-sidecar", {
    ...checksumMetaWriteEvidence(path, value),
    ...extra,
  });
  const temporaryPath = `${path}.tmp-${operation.tempId}`;
  const ownerPath = `${temporaryPath}.owner.json`;
  try {
    writeJsonSidecar(ownerPath, operation, operation);
    writeFileDurable(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      fsyncParent: false,
      operation,
    });
    renameWithDurableEvidence(temporaryPath, path, operation);
    rmSync(ownerPath, { force: true });
    fsyncDirectory(dirname(path), operation);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    rmSync(ownerPath, { force: true });
    throw classifyDurableWriteError(error, operation);
  }
}

function readChecksumMeta(path) {
  try {
    return JSON.parse(readFileSync(durableChecksumMetaPath(path), "utf8"));
  } catch {
    return null;
  }
}

function readChecksumMetaState(path) {
  const metaPath = durableChecksumMetaPath(path);
  if (!existsSync(metaPath)) return { status: "missing", meta: null };
  try {
    return { status: "present", meta: JSON.parse(readFileSync(metaPath, "utf8")) };
  } catch (error) {
    return { status: "invalid", meta: null, error };
  }
}

function recordStatusJsonDurableDiagnostic(input) {
  if (!statusJson) return null;
  const diagnostic = DurableStateDiagnosticSchema.parse(withoutUndefined({
    failureKind: input.failureKind ?? "local_state_integrity",
    localFailureClass: input.localFailureClass,
    recoveryDecision: input.recoveryDecision,
    failedStage: input.failedStage ?? "status-json",
    ...durableProjection(input),
  }));
  const key = JSON.stringify([
    diagnostic.targetLocator,
    diagnostic.sidecarTargetLocator,
    diagnostic.localFailureClass,
    diagnostic.checksumRecoveryDecision,
    diagnostic.statusJsonDecision,
  ]);
  if (!statusJsonDurableDiagnostics.some((item) => item.key === key)) {
    statusJsonDurableDiagnostics.push({ key, diagnostic });
  }
  return diagnostic;
}

function statusJsonDurableDiagnosticList() {
  return statusJsonDurableDiagnostics.map((item) => item.diagnostic);
}

function durableDiagnosticKey(diagnostic) {
  return JSON.stringify([
    diagnostic.itemId,
    diagnostic.bookId,
    diagnostic.activeCommand,
    diagnostic.targetLocator,
    diagnostic.sidecarTargetLocator,
    diagnostic.localFailureClass,
    diagnostic.checksumRecoveryDecision,
    diagnostic.statusJsonDecision,
  ]);
}

function durableStateFailureDiagnosticsForItems(items) {
  return items
    .filter((item) =>
      item.localFailureClass != null ||
      item.failureKind === "local_state_integrity" ||
      item.failureKind === "local_state_lock_timeout" ||
      item.commandChecks?.some((check) =>
        check.localFailureClass != null ||
        check.failureKind === "local_state_integrity" ||
        check.failureKind === "local_state_lock_timeout"
      )
    )
    .map((item) => {
      const failedCommand = (item.commandChecks ?? [])
        .filter((check) => check.status === "failed")
        .at(-1);
      const durable = durableProjection(failedCommand ?? item);
      return DurableStateDiagnosticSchema.parse(withoutUndefined({
        ...durable,
        itemId: item.itemId,
        bookId: item.bookId,
        activeCommand: failedCommand?.name ?? item.activeCommand ??
          item.currentCommand ?? item.failedStage,
        failureKind: failedCommand?.failureKind ?? item.failureKind ??
          durable.failureKind,
        retryable: failedCommand?.retryable ?? item.retryable ??
          durable.retryable,
        localFailureClass: failedCommand?.localFailureClass ??
          item.localFailureClass ?? durable.localFailureClass,
        recoveryDecision: failedCommand?.recoveryDecision ??
          item.recoveryDecision ?? durable.recoveryDecision,
        failedStage: failedCommand?.failedStage ?? item.failedStage ??
          durable.failedStage,
      }));
    });
}

function mergedDurableStateFailures(items) {
  const merged = new Map();
  for (const diagnostic of [
    ...statusJsonDurableDiagnosticList(),
    ...durableStateFailureDiagnosticsForItems(items),
  ]) {
    const key = durableDiagnosticKey(diagnostic);
    if (!merged.has(key)) merged.set(key, diagnostic);
  }
  return Array.from(merged.values());
}

function inspectDurableSerializedTargetReadOnly(path, text, kind) {
  const checksumPath = durableChecksumPath(path);
  const expected = existsSync(checksumPath)
    ? readFileSync(checksumPath, "utf8").trim()
    : null;
  const actual = sha256Text(text);
  const mapping = durableTargetMapping(path, kind);
  const primaryTargetLocator = relative(root, path);
  const checksumMetaLocator = relative(root, durableChecksumMetaPath(path));
  const directoryTargetLocator = relative(root, dirname(path)).split(sep).join("/");
  const directoryMapping = durableTargetMapping(dirname(path), "directory-fsync");
  const baseDiagnostic = {
    ...mapping,
    lane: mapping.lane ?? directoryMapping.lane,
    targetMappingOwner:
      mapping.targetMappingOwner ?? directoryMapping.targetMappingOwner,
    targetLocator: primaryTargetLocator,
    directoryTargetLocator,
    directoryDurableKind: "directory",
    primaryDurableKind: mapping.durableKind,
    primaryTargetLocator,
    sidecarTargetLocator: checksumMetaLocator,
    sidecarKind: "checksum_meta",
    checksumExpected: expected,
    checksumActual: actual,
    repairAllowed: false,
    completedPublishRule: "forbidden",
    fsyncTarget: directoryTargetLocator,
    fsyncPlatform: process.platform,
    fsyncErrno: "not_attempted_read_only",
    unavailableFieldSentinels: ["fsyncErrno"],
    durableMode: "read_only_observer",
  };
  if (expected == null) {
    recordStatusJsonDurableDiagnostic({
      ...baseDiagnostic,
      sidecarTargetLocator: relative(root, checksumPath),
      sidecarKind: "checksum",
      localFailureClass: "durable_checksum_missing",
      recoveryDecision: "stop_until_fixed",
      statusJsonDecision: "fail_closed_projection",
      diagnosticClass: "checksum_missing",
      checksumRecoveryDecision: "target_new_checksum_missing",
    });
    return;
  }
  if (expected !== actual) {
    recordStatusJsonDurableDiagnostic({
      ...baseDiagnostic,
      localFailureClass: "durable_checksum_mismatch",
      recoveryDecision: "stop_until_fixed",
      statusJsonDecision: "fail_closed_projection",
      diagnosticClass: "checksum_mismatch",
      checksumRecoveryDecision: "stop_until_fixed",
    });
    return;
  }
  const metaPath = durableChecksumMetaPath(path);
  if (!existsSync(metaPath)) {
    recordStatusJsonDurableDiagnostic({
      ...baseDiagnostic,
      localFailureClass: "durable_checksum_meta_missing",
      recoveryDecision: "metadata_missing_read_only",
      statusJsonDecision: "read_only_degraded",
      diagnosticClass: "checksum_meta_missing",
      checksumRecoveryDecision: "metadata_missing_read_only",
    });
    return;
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    recordStatusJsonDurableDiagnostic({
      ...baseDiagnostic,
      localFailureClass: "durable_checksum_meta_invalid",
      recoveryDecision: "stop_until_fixed",
      statusJsonDecision: "fail_closed_projection",
      diagnosticClass: "checksum_meta_invalid",
      checksumRecoveryDecision: "stop_until_fixed",
    });
    return;
  }
  if (checksumMetaIsInvalid(path, actual, meta)) {
    recordStatusJsonDurableDiagnostic({
      ...baseDiagnostic,
      localFailureClass: "durable_checksum_meta_conflict",
      recoveryDecision: "stop_until_fixed",
      statusJsonDecision: "fail_closed_projection",
      diagnosticClass: "checksum_meta_conflict",
      checksumRecoveryDecision: "stop_until_fixed",
    });
  }
}

function readDurableYamlReadOnly(path) {
  const text = readFileSync(path, "utf8");
  const parsed = YAML.parse(text) ?? null;
  inspectDurableSerializedTargetReadOnly(path, text, "yaml");
  return parsed;
}

function readDurableJsonReadOnly(path) {
  const text = readFileSync(path, "utf8");
  const parsed = JSON.parse(text);
  inspectDurableSerializedTargetReadOnly(path, text, "json");
  return parsed;
}

function checksumCommitEvidenceMatches(path, checksum, meta) {
  if (meta == null || meta.checksum !== checksum) return false;
  if (meta.operationId == null || meta.runnerSessionId == null) return false;
  if (meta.fencingTokenHash == null || meta.targetGeneration == null) return false;
  if (
    meta.commitState !== "target_rename_pending" &&
    meta.checksumRecoveryDecision !== "target_rename_pending"
  ) {
    return false;
  }
  return meta.absoluteTargetLocator === path ||
    meta.targetLocator === relative(root, path) ||
    basename(String(meta.targetLocator ?? "")) === basename(path);
}

function checksumMetaIsInvalid(path, checksum, meta) {
  return meta != null && meta.checksum !== checksum;
}

function checksumMetaSidecarEvidence(path, checksum, decision, extra = {}) {
  const hasExpected = Object.hasOwn(extra, "checksumExpected");
  return durableOperationEvidence(durableChecksumMetaPath(path), "json-sidecar", {
    ...extra,
    primaryTargetLocator: relative(root, path),
    sidecarTargetLocator: relative(root, durableChecksumMetaPath(path)),
    sidecarKind: "checksum_meta",
    checksum,
    checksumExpected: hasExpected ? extra.checksumExpected : checksum,
    checksumActual: extra.checksumActual ?? checksum,
    checksumRecoveryDecision: extra.checksumRecoveryDecision ?? decision,
    repairAllowed: extra.repairAllowed ?? true,
  });
}

function eventDurableChecksumMetaBackfilled(path, checksum, decision) {
  const evidence = checksumMetaSidecarEvidence(path, checksum, decision);
  event({
    event: "durable_checksum_meta_backfilled",
    status: "pending",
    checksumRecoveryDecision: decision,
    ...durableProjection(evidence),
    metadata: {
      ...durableProjection(evidence),
      locator: relative(root, path),
      checksum,
      checksumRecoveryDecision: decision,
    },
  });
}

function writeCommittedChecksumMeta(path, checksum, decision) {
  writeJsonAtomicSidecar(
    durableChecksumMetaPath(path),
    {
      ...committedChecksumMeta(path, checksum, decision),
      checksumExpected: checksum,
      checksumActual: checksum,
      repairAllowed: true,
    },
  );
  eventDurableChecksumMetaBackfilled(path, checksum, decision);
}

function quarantineChecksumMetaSidecar(path, checksum, meta, decision, reason) {
  const metaPath = durableChecksumMetaPath(path);
  if (!existsSync(metaPath)) return;
  const operation = checksumMetaSidecarEvidence(path, checksum, decision, {
    localFailureClass: reason === "invalid"
      ? "durable_checksum_meta_invalid"
      : "durable_checksum_meta_conflict",
    checksumExpected: reason === "invalid" ? null : meta?.checksum,
    completedPublishRule: "forbidden",
  });
  const quarantinePath = `${metaPath}.corrupt-${Date.now()}`;
  try {
    renameWithDurableEvidence(metaPath, quarantinePath, operation);
    fsyncDirectory(dirname(metaPath), operation);
  } catch (error) {
    const durableError = classifyDurableWriteError(error, operation);
    emitDurableFailureEvent("durable_replace_failed", durableError, {
      targetLocator: relative(root, metaPath),
    });
    throw durableError;
  }
  event({
    event: "durable_checksum_meta_sidecar_quarantined",
    status: "failed",
    failureKind: "local_state_integrity",
    retryable: false,
    recoveryDecision: "stop_until_fixed",
    checksumRecoveryDecision: decision,
    ...durableProjection(operation),
    metadata: {
      ...durableProjection(operation),
      locator: relative(root, path),
      quarantineLocator: relative(root, quarantinePath),
      checksum,
      previousChecksum: meta?.checksum,
      reason,
    },
  });
}

function repairChecksumMetaSidecar(path, checksum, meta, decision, reason) {
  quarantineChecksumMetaSidecar(path, checksum, meta, decision, reason);
  writeCommittedChecksumMeta(path, checksum, decision);
}

function checksumMetaIsPending(meta) {
  return meta?.commitState === "target_rename_pending" ||
    meta?.checksumRecoveryDecision === "target_rename_pending";
}

function committedChecksumMeta(path, checksum, decision) {
  return durableOperationEvidence(path, "checksum", {
    checksum,
    checksumPath: relative(root, durableChecksumPath(path)),
    checksumRecoveryDecision: decision,
    commitState: "committed",
    committedAt: now(),
  });
}

function renameWithDurableEvidence(from, to, operation) {
  try {
    if (shouldInjectRenameEnoent(to, operation)) {
      unlinkSync(from);
    }
    renameSync(from, to);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new DurableStateError(
        `local_state_integrity durable_temp_rename_enoent: ${relative(root, to)}`,
        {
          localFailureClass: "durable_temp_rename_enoent",
          cause: error,
          evidence: {
            ...operation,
            targetLocator: relative(root, to),
            failedSyscall: "rename",
            errno: "ENOENT",
            renameCause: inferRenameEnoentCause(from, to, operation),
            completedPublishRule: "forbidden",
            redactedEvidenceLocator: basename(to),
          },
        },
      );
    }
    throw error;
  }
}

function inferRenameEnoentCause(from, to, operation) {
  const tempExists = existsSync(from);
  const targetExists = existsSync(to);
  const currentChecksum = readDurableChecksum(to);
  if (
    currentChecksum != null &&
    operation?.targetChecksumBefore != null &&
    currentChecksum !== operation.targetChecksumBefore
  ) {
    return "generation_advanced";
  }
  if (operation?.tempCreateCollision === true) return "temp_collision";
  if (
    operation?.cleanupReason === "live_temp_deleted" ||
    operation?.cleanupReason === "owner_alive"
  ) {
    return "reconciler_mistaken_deletion";
  }
  if (
    operation?.fencingTokenMismatch === true ||
    operation?.staleWriter === true ||
    operation?.leaseGenerationChanged === true
  ) {
    return "concurrent_takeover";
  }
  if (!tempExists && targetExists) return "generation_advanced";
  return "filesystem_or_external_mutation";
}

function shouldInjectRenameEnoent(to, operation) {
  if (testRenameEnoentInjected || testRenameEnoentOncePattern === "") return false;
  const target = relative(root, to);
  if (!target.includes(testRenameEnoentOncePattern)) return false;
  const sidecarPattern = testRenameEnoentOncePattern.includes(".sha256.meta.json");
  if (operation?.kind === "json-sidecar" && !sidecarPattern) return false;
  if (operation?.kind !== "json" && operation?.kind !== "json-sidecar") return false;
  if (!target.endsWith(".json")) return false;
  testRenameEnoentMatchCount += 1;
  if (testRenameEnoentMatchCount <= testRenameEnoentAfterMatches) {
    return false;
  }
  testRenameEnoentInjected = true;
  return true;
}

function classifyDurableWriteError(error, operation) {
  if (error instanceof DurableStateError) return error;
  if (error?.code === "EEXIST") {
    return new DurableStateError(
      `local_state_integrity durable_temp_create_collision: ${operation.targetLocator}`,
      {
        localFailureClass: "durable_temp_create_collision",
        cause: error,
        evidence: {
          ...operation,
          errno: "EEXIST",
          completedPublishRule: "forbidden",
          redactedEvidenceLocator: basename(String(operation.absoluteTargetLocator ?? "")),
        },
      },
    );
  }
  return error;
}

function writeJsonAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  JSON.parse(text);
  const checksum = sha256Text(text);
  const operation = durableOperationEvidence(path, "json");
  const commitEvidence = { ...operation, checksum };
  const temporaryPath = `${path}.tmp-${operation.tempId}`;
  const ownerPath = `${temporaryPath}.owner.json`;
  const checksumPath = durableChecksumPath(path);
  const checksumOperation = durableOperationEvidence(checksumPath, "checksum", {
    ...checksumSidecarWriteEvidence(path, checksumPath, {
      checksum,
      checksumRecoveryDecision: "committed",
    }),
    checksum,
    checksumRecoveryDecision: "committed",
    tempId: `${operation.tempId}-checksum`,
  });
  const checksumTemporaryPath = `${checksumPath}.tmp-${checksumOperation.tempId}`;
  const checksumOwnerPath = `${checksumTemporaryPath}.owner.json`;
  let tempCreated = false;
  let checksumTempCreated = false;
  try {
    writeJsonSidecar(ownerPath, commitEvidence, operation);
    writeFileDurable(temporaryPath, text, {
      flag: "wx",
      fsyncParent: false,
      operation,
    });
    tempCreated = true;
    writeJsonAtomicSidecar(durableChecksumMetaPath(path), {
      ...commitEvidence,
      checksumRecoveryDecision: "target_rename_pending",
      commitState: "target_rename_pending",
    });
    renameWithDurableEvidence(temporaryPath, path, operation);
    const checksumMeta = {
      ...commitEvidence,
      checksum,
      checksumPath: relative(root, checksumPath),
      checksumRecoveryDecision: "committed",
      commitState: "committed",
      committedAt: now(),
    };
    writeJsonSidecar(checksumOwnerPath, checksumOperation, checksumOperation);
    writeFileDurable(checksumTemporaryPath, `${checksum}\n`, {
      flag: "wx",
      fsyncParent: false,
      operation: checksumOperation,
    });
    checksumTempCreated = true;
    renameWithDurableEvidence(checksumTemporaryPath, checksumPath, checksumOperation);
    writeJsonAtomicSidecar(durableChecksumMetaPath(path), checksumMeta);
    rmSync(ownerPath, { force: true });
    rmSync(checksumOwnerPath, { force: true });
    fsyncDirectory(dirname(path), checksumOperation);
  } catch (error) {
    if (tempCreated) rmSync(temporaryPath, { force: true });
    rmSync(ownerPath, { force: true });
    if (checksumTempCreated) rmSync(checksumTemporaryPath, { force: true });
    rmSync(checksumOwnerPath, { force: true });
    const durableError = classifyDurableWriteError(error, operation);
    emitDurableFailureEvent("durable_replace_failed", durableError, {
      targetLocator: relative(root, path),
    });
    throw durableError;
  }
}

function writeJsonlAtomic(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  const text = lines.join("\n") + "\n";
  for (const line of lines) JSON.parse(line);
  const operation = durableOperationEvidence(path, "jsonl");
  const temporaryPath = `${path}.tmp-${operation.tempId}`;
  const ownerPath = `${temporaryPath}.owner.json`;
  try {
    writeJsonSidecar(ownerPath, operation, operation);
    writeFileDurable(temporaryPath, text, {
      flag: "wx",
      fsyncParent: false,
      operation,
    });
    renameWithDurableEvidence(temporaryPath, path, operation);
    rmSync(ownerPath, { force: true });
    fsyncDirectory(dirname(path), operation);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    rmSync(ownerPath, { force: true });
    const durableError = classifyDurableWriteError(error, operation);
    emitDurableFailureEvent("durable_replace_failed", durableError, {
      targetLocator: relative(root, path),
    });
    throw durableError;
  }
}

function readJsonSidecar(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function durableTempOwnerEvidence(owner) {
  if (owner == null || typeof owner !== "object") return undefined;
  return redactJsonValue({
    ...localDurableEvidence({
      localFailureClass: owner.localFailureClass,
      targetLocator: owner.targetLocator,
      redactedEvidenceLocator: owner.redactedEvidenceLocator,
      lane: owner.lane,
      targetMappingOwner: owner.targetMappingOwner,
      laneTimeoutMs: owner.laneTimeoutMs,
      releaseOn: owner.releaseOn,
      tempId: owner.tempId,
      operationId: owner.operationId,
      failedSyscall: owner.failedSyscall,
      errno: owner.errno,
      renameCause: owner.renameCause,
      completedPublishRule: owner.completedPublishRule,
      checksumRecoveryDecision: owner.checksumRecoveryDecision,
      fsyncTarget: owner.fsyncTarget,
      fsyncErrno: owner.fsyncErrno,
      fsyncPlatform: owner.fsyncPlatform,
      durableMode: owner.durableMode,
    }),
    runnerSessionId: owner.runnerSessionId,
    runId: owner.runId,
    workerId: owner.workerId,
    itemId: owner.itemId,
    bookId: owner.bookId,
    leaseGeneration: owner.leaseGeneration,
    ownerPid: owner.ownerPid ?? owner.pid,
    ownerHost: owner.ownerHost ?? owner.host,
    createdAt: owner.createdAt,
    expiresAt: owner.expiresAt,
    fencingTokenHash: owner.fencingTokenHash,
    targetGeneration: owner.targetGeneration,
    targetChecksumBefore: owner.targetChecksumBefore,
  });
}

function durableTempCleanupDecision(temporaryPath, temporaryStat) {
  const owner = readJsonSidecar(`${temporaryPath}.owner.json`);
  const ownerTarget = String(owner?.absoluteTargetLocator ?? "");
  const ownerRelativeTarget = String(owner?.targetLocator ?? "");
  const tempTarget = durableTempTargetPath(temporaryPath);
  const targetMatches =
    tempTarget != null &&
    (
      ownerTarget === tempTarget ||
      ownerRelativeTarget === relative(root, tempTarget)
    );
  const ownerPid = Number.parseInt(String(owner?.ownerPid ?? owner?.pid ?? ""), 10);
  const ownerHost = String(owner?.ownerHost ?? owner?.host ?? "");
  const staleAgeMs = Math.max(0, Date.now() - temporaryStat.mtimeMs);
  const ownerCreatedAtMs = epochMs(owner?.createdAt);
  const ownerLocal = ownerHost === "" || ownerHost === runnerHost;
  const ownerAlive = ownerLocal && processAlive(ownerPid);
  const ownerExpiryMs = epochMs(owner?.expiresAt);
  const leaseExpired = ownerExpiryMs > 0 && Date.now() > ownerExpiryMs;
  if (staleAgeMs <= durableTempStaleMs) {
    return {
      remove: false,
      reason: "fresh_temp_below_stale_ttl",
      staleAgeMs,
      lockOwnerEvidence: durableTempOwnerEvidence(owner),
    };
  }
  if (owner == null || ownerCreatedAtMs <= 0) {
    return {
      remove: false,
      reason: "owner_evidence_missing_or_invalid",
      staleAgeMs,
      lockOwnerEvidence: durableTempOwnerEvidence(owner),
    };
  }
  if (!targetMatches) {
    return {
      remove: false,
      reason: "owner_target_mismatch",
      staleAgeMs,
      lockOwnerEvidence: durableTempOwnerEvidence(owner),
    };
  }
  if (
    !Number.isInteger(owner?.leaseGeneration) ||
    !Number.isInteger(owner?.targetGeneration) ||
    typeof owner?.fencingTokenHash !== "string" ||
    owner.fencingTokenHash.length === 0 ||
    typeof owner?.targetChecksumBefore !== "string"
  ) {
    return {
      remove: false,
      reason: "owner_generation_or_fencing_missing",
      staleAgeMs,
      lockOwnerEvidence: durableTempOwnerEvidence(owner),
    };
  }
  const currentTargetChecksum = tempTarget == null
    ? undefined
    : readDurableChecksum(tempTarget);
  if (currentTargetChecksum !== owner.targetChecksumBefore) {
    return {
      remove: false,
      reason: "target_generation_advanced",
      staleAgeMs,
      lockOwnerEvidence: durableTempOwnerEvidence(owner),
    };
  }
  if (ownerAlive && !leaseExpired) {
    return {
      remove: false,
      reason: "owner_alive",
      staleAgeMs,
      lockOwnerEvidence: durableTempOwnerEvidence(owner),
    };
  }
  if (!ownerLocal && !leaseExpired) {
    return {
      remove: false,
      reason: "remote_owner_unproven",
      staleAgeMs,
      lockOwnerEvidence: durableTempOwnerEvidence(owner),
    };
  }
  return {
    remove: true,
    reason: owner == null
      ? "orphan_temp_without_owner"
      : leaseExpired
        ? "owner_lease_expired"
        : "owner_dead_stale_temp",
    staleAgeMs,
    lockOwnerEvidence: durableTempOwnerEvidence(owner),
  };
}

function durableTempTargetPath(temporaryPath) {
  const checksumMarker = ".sha256.tmp-";
  const checksumIndex = temporaryPath.lastIndexOf(checksumMarker);
  if (checksumIndex >= 0) {
    return temporaryPath.slice(0, checksumIndex + ".sha256".length);
  }
  const marker = ".tmp-";
  const index = temporaryPath.lastIndexOf(marker);
  return index >= 0 ? temporaryPath.slice(0, index) : null;
}

function tempOwnerEvidence(temporaryPath) {
  const owner = readJsonSidecar(`${temporaryPath}.owner.json`);
  return durableTempOwnerEvidence(owner);
}

function tempOwnerProjection(temporaryPath) {
  const owner = readJsonSidecar(`${temporaryPath}.owner.json`);
  if (owner == null) return {};
  return localDurableEvidence({
    localFailureClass: owner.localFailureClass,
    targetLocator: owner.targetLocator,
    redactedEvidenceLocator: owner.redactedEvidenceLocator,
    lane: owner.lane,
    targetMappingOwner: owner.targetMappingOwner,
    laneTimeoutMs: owner.laneTimeoutMs,
    releaseOn: owner.releaseOn,
    tempId: owner.tempId,
    operationId: owner.operationId,
    failedStage: owner.failedStage,
    failedSyscall: owner.failedSyscall,
    errno: owner.errno,
    renameCause: owner.renameCause,
    completedPublishRule: owner.completedPublishRule,
    checksumRecoveryDecision: owner.checksumRecoveryDecision,
    fsyncTarget: owner.fsyncTarget,
    fsyncErrno: owner.fsyncErrno,
    fsyncPlatform: owner.fsyncPlatform,
    durableMode: owner.durableMode,
  });
}

function durablePreflightDecisionForTemp(temporaryPath) {
  let temporaryStat;
  try {
    temporaryStat = statSync(temporaryPath);
  } catch {
    return null;
  }
  const decision = durableTempCleanupDecision(temporaryPath, temporaryStat);
  if (decision.remove) return null;
  const ownerProjection = tempOwnerProjection(temporaryPath);
  return {
    localFailureClass: "durable_preflight_unresolved_temp",
    reason: decision.reason,
    targetLocator: relative(root, temporaryPath),
    redactedEvidenceLocator: basename(temporaryPath),
    ...ownerProjection,
    lockOwnerEvidence: decision.lockOwnerEvidence,
    cleanupReason: decision.reason,
  };
}

function durablePreflightDecisionForLock(lockPath) {
  try {
    const entry = statSync(lockPath);
    const owner = readJsonLockOwner(lockPath);
    const expiredAndDead = jsonLockOwnerExpired(owner, entry) &&
      !processAlive(owner.pid);
    if (expiredAndDead && jsonLockOwnerHasRecoveryFence(owner)) return null;
    return {
      localFailureClass: "durable_preflight_live_lock",
      reason: expiredAndDead
        ? "stale_lock_recovery_fence_missing"
        : "lock_owner_live_or_unexpired",
      targetLocator: owner.targetLocator ?? relative(root, lockPath),
      redactedEvidenceLocator: basename(lockPath),
      lane: owner.lane,
      targetMappingOwner: owner.targetMappingOwner,
      laneTimeoutMs: owner.laneTimeoutMs,
      releaseOn: owner.releaseOn,
      operationId: owner.operationId,
      lockOwnerEvidence: redactJsonValue(owner),
    };
  } catch {
    return null;
  }
}

function durablePreflightDecisionForPrimaryJson(path) {
  try {
    reconcileDurableJsonTarget(path);
    return null;
  } catch (error) {
    if (error instanceof DurableStateError) {
      return {
        localFailureClass:
          error.localFailureClass ?? "durable_preflight_checksum_blocked",
        reason: "durable_json_reconcile_failed",
        ...durableProjection(error.evidence),
        targetLocator: error.evidence?.targetLocator ?? relative(root, path),
        redactedEvidenceLocator: error.evidence?.redactedEvidenceLocator ??
          basename(path),
      };
    }
    return {
      localFailureClass: "durable_preflight_checksum_blocked",
      reason: "durable_json_reconcile_failed",
      targetLocator: relative(root, path),
      redactedEvidenceLocator: basename(path),
      checksumRecoveryDecision: "stop_until_fixed",
    };
  }
}

function durablePreflightDecisionForPrimaryYaml(path) {
  try {
    reconcileDurableYamlTarget(path);
    return null;
  } catch (error) {
    if (error instanceof DurableStateError) {
      return {
        localFailureClass:
          error.localFailureClass ?? "durable_preflight_checksum_blocked",
        reason: "durable_yaml_reconcile_failed",
        ...durableProjection(error.evidence),
        targetLocator: error.evidence?.targetLocator ?? relative(root, path),
        redactedEvidenceLocator: error.evidence?.redactedEvidenceLocator ??
          basename(path),
      };
    }
    return {
      localFailureClass: "durable_preflight_checksum_blocked",
      reason: "durable_yaml_reconcile_failed",
      targetLocator: relative(root, path),
      redactedEvidenceLocator: basename(path),
      checksumRecoveryDecision: "stop_until_fixed",
    };
  }
}

function providerRequestDiagnosticBase(path) {
  const mapping = durableTargetMapping(path, "json");
  const primaryTargetLocator = relative(root, path);
  const directoryTargetLocator = relative(root, dirname(path)).split(sep).join("/");
  return {
    ...mapping,
    targetLocator: primaryTargetLocator,
    primaryTargetLocator,
    redactedEvidenceLocator: basename(path),
    directoryTargetLocator,
    directoryDurableKind: "directory",
    primaryDurableKind: "json",
    failedStage: "runner_start",
    failureKind: "local_state_integrity",
    retryable: false,
    recoveryDecision: "continue_with_diagnostic_unless_catalog_blocked",
    statusJsonDecision: "read_only_capped_diagnostic",
    diagnosticClass: "provider_request_durable_degraded",
    checksumRecoveryDecision: "read_only_capped_diagnostic",
    normalRunnerAction: "no_primary_quarantine",
    repairAllowed: false,
    completedPublishRule: "allowed_with_diagnostic",
    durableMode: "read_only_capped_diagnostic",
  };
}

function providerRequestReadOnlyDiagnostic(path) {
  try {
    const text = readFileSync(path, "utf8");
    JSON.parse(text);
    const expected = existsSync(durableChecksumPath(path))
      ? readFileSync(durableChecksumPath(path), "utf8").trim()
      : null;
    const actual = sha256Text(text);
    const base = providerRequestDiagnosticBase(path);
    if (expected == null) {
      return {
        ...base,
        localFailureClass: "durable_checksum_missing",
        checksumExpected: null,
        checksumActual: actual,
      };
    }
    if (expected !== actual) {
      return {
        ...base,
        localFailureClass: "durable_checksum_mismatch",
        checksumExpected: expected,
        checksumActual: actual,
      };
    }
    const metaState = readChecksumMetaState(path);
    if (metaState.status === "missing") {
      return {
        ...base,
        localFailureClass: "durable_checksum_meta_missing",
        checksumExpected: expected,
        checksumActual: actual,
      };
    }
    if (metaState.status === "invalid") {
      return {
        ...base,
        localFailureClass: "durable_checksum_meta_invalid",
        checksumExpected: expected,
        checksumActual: actual,
      };
    }
    if (checksumMetaIsInvalid(path, actual, metaState.meta)) {
      return {
        ...base,
        localFailureClass: "durable_checksum_meta_conflict",
        checksumExpected: metaState.meta?.checksum ?? expected,
        checksumActual: actual,
      };
    }
  } catch (error) {
    return {
      ...providerRequestDiagnosticBase(path),
      localFailureClass: "durable_target_invalid",
      checksumExpected: null,
      checksumActual: undefined,
      evidenceIncomplete: true,
      evidenceIncompleteReason: error instanceof SyntaxError
        ? "invalid_json"
        : "read_only_inspection_failed",
    };
  }
  return null;
}

function providerRequestSummaryDiagnostic(diagnostics, scanned, truncated) {
  if (diagnostics.length === 0) return null;
  const first = diagnostics[0];
  return {
    ...first,
    scannedTargetCount: scanned,
    degradedTargetCount: diagnostics.length,
    sampleTargetLocators: diagnostics
      .slice(0, providerRequestStartupSampleLimit)
      .map((item) => item.targetLocator),
    scanTruncated: truncated,
    maxRunnerStartScannedTargets: providerRequestStartupScanLimit,
    maxRunnerStartReportedSamples: providerRequestStartupSampleLimit,
    maxRunnerStartMutationCount: 0,
  };
}

function scanProviderRequestDiagnostics(directory) {
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return { diagnostics: [], scanned: 0, truncated: false };
  }
  const primaryJsonEntries = entries
    .filter((entry) => entry.isFile() && isDurablePrimaryJsonEntry(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const targets = primaryJsonEntries.slice(0, providerRequestStartupScanLimit);
  const diagnostics = [];
  for (const entry of targets) {
    const diagnostic = providerRequestReadOnlyDiagnostic(join(directory, entry.name));
    if (diagnostic != null) diagnostics.push(diagnostic);
  }
  return {
    diagnostics,
    scanned: targets.length,
    truncated: primaryJsonEntries.length > targets.length,
  };
}

function durablePreflightDecisionForQmdIndexLock() {
  const lockPath = qmdIndexFileLockPath();
  try {
    const entry = statSync(lockPath);
    const owner = readQmdIndexFileLockOwner(lockPath);
    const expiredAndDead = qmdIndexLockOwnerExpired(owner, entry) &&
      !processAlive(owner.pid);
    if (expiredAndDead && qmdIndexLockHasRecoveryFence(owner)) return null;
    return {
      localFailureClass: "durable_preflight_live_lock",
      reason: expiredAndDead
        ? "stale_lock_recovery_fence_missing"
        : "lock_owner_live_or_unexpired",
      targetLocator: owner.targetLocator ?? relative(root, qmdIndexPath),
      redactedEvidenceLocator: basename(lockPath),
      lane: owner.lane,
      targetMappingOwner: owner.targetMappingOwner,
      laneTimeoutMs: owner.laneTimeoutMs,
      releaseOn: owner.releaseOn,
      operationId: owner.operationId,
      lockOwnerEvidence: redactJsonValue(owner),
    };
  } catch {
    return null;
  }
}

function durablePreflightScanDirectory(directory, options = {}, depth = 0) {
  const blockers = [];
  if (options.providerRequestReadOnly === true) {
    const scan = scanProviderRequestDiagnostics(directory);
    const summary = providerRequestSummaryDiagnostic(
      scan.diagnostics,
      scan.scanned,
      scan.truncated,
    );
    if (summary != null) {
      options.providerRequestDiagnostics?.push(summary);
    }
    return blockers;
  }
  const includeTemps = options.includeTemps !== false;
  const recursive = options.recursive === true;
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 8;
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return blockers;
  }
  for (const entry of entries.filter((entry) => entry.name.endsWith(".lock"))) {
    const path = join(directory, entry.name);
    const blocker = durablePreflightDecisionForLock(path);
    if (blocker != null) blockers.push(blocker);
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive && depth < maxDepth && !entry.name.includes(".corrupt-")) {
        blockers.push(...durablePreflightScanDirectory(path, options, depth + 1));
      }
      continue;
    }
    if (entry.name.endsWith(".owner.json") || entry.name.endsWith(".lock")) continue;
    if (includeTemps && entry.name.includes(".tmp-")) {
      const blocker = durablePreflightDecisionForTemp(path);
      if (blocker != null) blockers.push(blocker);
      continue;
    }
    if (isDurablePrimaryJsonEntry(entry.name)) {
      const blocker = durablePreflightDecisionForPrimaryJson(path);
      if (blocker != null) blockers.push(blocker);
      continue;
    }
    if (isDurablePrimaryYamlEntry(entry.name)) {
      const blocker = durablePreflightDecisionForPrimaryYaml(path);
      if (blocker != null) blockers.push(blocker);
    }
  }
  return blockers;
}

function isProviderRequestPreflightMapping(mapping) {
  return mapping.targetFamily === "provider_request_fingerprint" ||
    mapping.targetMappingOwner === "providerRequestFingerprint";
}

function durablePreflightTargets(item = undefined) {
  const targets = [];
  for (const mapping of durableTargetMappingTable) {
    if (!Array.isArray(mapping.preflightScopes)) {
      throw new DurableStateError(
        `durable target preflight scope missing: ${mapping.pattern.source}`,
        {
          localFailureClass: "durable_target_mapping_missing",
          evidence: {
            targetMappingPattern: mapping.pattern.source,
            targetMappingOwner: mapping.targetMappingOwner,
            lane: mapping.lane,
            durableKind: mapping.durableKind,
            durableMode: "strict",
            completedPublishRule: "forbidden",
          },
        },
      );
    }
    for (const scope of mapping.preflightScopes) {
      const entry = durablePreflightTargetFromScope(scope, item);
      if (entry != null && isProviderRequestPreflightMapping(mapping)) {
        entry.providerRequestReadOnly = true;
      }
      if (entry != null) targets.push(entry);
    }
  }
  return uniqueDurablePreflightTargets(targets);
}

function durablePreflightTargetsForItems(items) {
  const targets = [...durablePreflightTargets(undefined)];
  for (const item of items) {
    targets.push(...durablePreflightTargets(item));
  }
  return uniqueDurablePreflightTargets(targets);
}

function uniqueDurablePreflightTargets(targets) {
  const unique = new Map();
  for (const target of targets) {
    const entry = typeof target === "string" ? { directory: target } : target;
    const current = unique.get(entry.directory);
    unique.set(entry.directory, {
      ...current,
      ...entry,
      recursive: Boolean(current?.recursive || entry.recursive),
    });
  }
  return Array.from(unique.values());
}

function durablePreflightTargetFromScope(scope, item = undefined) {
  const scopePath = typeof scope === "string" ? scope : scope?.path;
  if (typeof scopePath !== "string" || scopePath.length === 0) return null;
  const replacements = {
    runId,
    bookId: item?.bookId,
    itemId: item?.itemId,
  };
  let resolved = scopePath;
  for (const [key, value] of Object.entries(replacements)) {
    if (resolved.includes(`{${key}}`)) {
      if (value == null || value === "") return null;
      resolved = resolved.split(`{${key}}`).join(value);
    }
  }
  return {
    directory: durablePreflightScopeDirectory(resolved),
    recursive: Boolean(scope?.recursive),
    maxDepth: scope?.maxDepth,
  };
}

function durablePreflightScopeDirectory(scopePath) {
  if (scopePath === "graph_vault") return stateRoot;
  if (scopePath.startsWith("graph_vault/")) {
    return join(stateRoot, scopePath.slice("graph_vault/".length));
  }
  return join(root, scopePath);
}

function durablePreflight(stage, item = undefined, options = {}) {
  if (statusJson) return;
  const blockers = [];
  const targets = Array.isArray(options.targets)
    ? options.targets
    : durablePreflightTargets(item);
  for (const target of targets) {
    blockers.push(...durablePreflightScanDirectory(target.directory, {
      ...options,
      recursive: Boolean(options.recursive || target.recursive),
      providerRequestReadOnly: Boolean(
        options.providerRequestReadOnly || target.providerRequestReadOnly
      ),
      providerRequestDiagnostics: options.providerRequestDiagnostics,
    }));
  }
  const qmdIndexLockBlocker = durablePreflightDecisionForQmdIndexLock();
  if (qmdIndexLockBlocker != null) blockers.push(qmdIndexLockBlocker);
  if (blockers.length === 0) return;
  const first = blockers[0];
  const durableError = new DurableStateError(
    `durable preflight blocked ${stage}: ${first.targetLocator}`,
    {
      localFailureClass: first.localFailureClass,
      evidence: {
        ...first,
        failedStage: stage,
        durableMode: "strict",
        completedPublishRule: "forbidden",
      },
    },
  );
  event({
    itemId: item?.itemId,
    event: "durable_preflight_blocked",
    status: "failed",
    failureKind: "local_state_integrity",
    retryable: false,
    recoveryDecision: "stop_until_fixed",
    failedStage: stage,
    message: durableError.message,
    ...durableProjection(durableError.evidence),
    metadata: {
      ...durableProjection(durableError.evidence),
      blockerCount: blockers.length,
      firstBlockerReason: first.reason,
      cleanupReason: first.cleanupReason,
    },
  });
  throw durableError;
}

function backfillDurableChecksum(path, checksum, decision, eventName) {
  const checksumPath = durableChecksumPath(path);
  const operation = durableOperationEvidence(checksumPath, "checksum", {
    ...checksumSidecarWriteEvidence(path, checksumPath, {
      checksum,
      checksumRecoveryDecision: decision,
    }),
    checksum,
    checksumRecoveryDecision: decision,
  });
  const temporaryPath = `${checksumPath}.tmp-${operation.tempId}`;
  const ownerPath = `${temporaryPath}.owner.json`;
  let tempCreated = false;
  try {
    writeJsonSidecar(ownerPath, operation, operation);
    writeFileDurable(temporaryPath, `${checksum}\n`, {
      flag: "wx",
      fsyncParent: false,
      operation,
    });
    tempCreated = true;
    renameWithDurableEvidence(temporaryPath, checksumPath, operation);
    writeJsonAtomicSidecar(durableChecksumMetaPath(path), operation);
    rmSync(ownerPath, { force: true });
    fsyncDirectory(dirname(path), operation);
    event({
      event: eventName,
      status: "pending",
      ...durableProjection(operation),
      metadata: {
        ...durableProjection(operation),
        locator: relative(root, path),
        checksum,
        checksumRecoveryDecision: decision,
      },
    });
  } catch (error) {
    if (tempCreated) rmSync(temporaryPath, { force: true });
    rmSync(ownerPath, { force: true });
    const durableError = classifyDurableWriteError(error, operation);
    emitDurableFailureEvent("durable_replace_failed", durableError, {
      targetLocator: relative(root, checksumPath),
    });
    throw durableError;
  }
}

function quarantineDurableTarget(path, kind, reason, cause, extra = {}) {
  const operation = durableOperationEvidence(path, `${kind}-quarantine`, {
    localFailureClass: reason === "checksum_mismatch"
      ? "durable_checksum_mismatch"
      : "durable_target_invalid",
    checksumRecoveryDecision: "stop_until_fixed",
    ...extra,
  });
  const quarantinePath = `${path}.corrupt-${Date.now()}`;
  try {
    renameWithDurableEvidence(path, quarantinePath, operation);
    fsyncDirectory(dirname(path), operation);
  } catch (error) {
    const durableError = classifyDurableWriteError(error, operation);
    emitDurableFailureEvent("durable_replace_failed", durableError, {
      targetLocator: relative(root, path),
    });
    throw durableError;
  }
  const targetLabel = kind === "json" ? "JSON" : "YAML";
  const reasonLabel = reason === "checksum_mismatch"
    ? "checksum mismatch"
    : reason;
  const durableError = new DurableStateError(`invalid durable ${targetLabel} target: ${
    relative(root, path)
  } (${reasonLabel})`, {
    localFailureClass: operation.localFailureClass,
    cause,
    evidence: {
      ...operation,
      quarantineLocator: relative(root, quarantinePath),
      redactedEvidenceLocator: basename(path),
    },
  });
  event({
    event: `durable_${kind}_target_quarantined`,
    status: "failed",
    failureKind: "local_state_integrity",
    retryable: false,
    recoveryDecision: "stop_until_fixed",
    failedStage: "durable_state",
    message: durableError.message,
    ...durableProjection(durableError.evidence),
    metadata: {
      ...durableProjection(durableError.evidence),
      locator: relative(root, path),
      quarantineLocator: relative(root, quarantinePath),
      reason,
    },
  });
  throw durableError;
}

function reconcileDurableJsonTarget(path) {
  if (statusJson) return;
  if (isDurableAuxiliaryPath(path)) return;
  withJsonFileLock(path, () => reconcileDurableJsonTargetUnlocked(path));
}

function reconcileDurableJsonTargetUnlocked(path) {
  const directory = dirname(path);
  try {
    for (const entry of readdirSync(directory)) {
      if (
        isDurableTempEntry(path, entry) ||
        isDurableTempEntry(durableChecksumPath(path), entry)
      ) {
        const temporaryPath = join(directory, entry);
        const temporaryStat = statSync(temporaryPath);
        const decision = durableTempCleanupDecision(temporaryPath, temporaryStat);
        if (!decision.remove) continue;
        const ownerProjection = tempOwnerProjection(temporaryPath);
        rmSync(temporaryPath, { force: true });
        rmSync(`${temporaryPath}.owner.json`, { force: true });
        fsyncDirectory(directory);
        event({
          event: "durable_json_temp_reconciled",
          status: "pending",
          localFailureClass: "durable_stale_temp_reconciled",
          targetLocator: relative(root, temporaryPath),
          ...ownerProjection,
          metadata: {
            locator: relative(root, temporaryPath),
            lockOwnerEvidence: decision.lockOwnerEvidence,
            recoveryDecision: "stale_temp_removed",
            cleanupReason: decision.reason,
            staleAgeMs: Math.floor(decision.staleAgeMs),
          },
        });
      }
    }
  } catch {
    return;
  }
  if (!existsSync(path)) return;
  try {
    const text = readFileSync(path, "utf8");
    JSON.parse(text);
    const expected = existsSync(durableChecksumPath(path))
      ? readFileSync(durableChecksumPath(path), "utf8").trim()
      : null;
    const actual = sha256Text(text);
    const metaState = readChecksumMetaState(path);
    const meta = metaState.meta;
    if (expected != null && expected !== actual) {
      if (checksumCommitEvidenceMatches(path, actual, meta)) {
        backfillDurableChecksum(
          path,
          actual,
          "target_new_checksum_old",
          "durable_json_checksum_backfilled",
        );
        return;
      }
      throw Object.assign(new Error("checksum_mismatch"), {
        checksumExpected: expected,
        checksumActual: actual,
      });
    }
    if (expected == null) {
      if (!checksumCommitEvidenceMatches(path, actual, meta)) {
        throw Object.assign(new Error("checksum_mismatch"), {
          checksumExpected: null,
          checksumActual: actual,
        });
      }
      backfillDurableChecksum(
        path,
        actual,
        "target_new_checksum_missing",
        "durable_json_checksum_backfilled",
      );
    } else if (checksumMetaIsPending(meta)) {
      if (!checksumCommitEvidenceMatches(path, actual, meta)) {
        throw Object.assign(new Error("checksum_mismatch"), {
          checksumExpected: meta?.checksum,
          checksumActual: actual,
        });
      }
      if (meta?.checksum !== actual) {
        backfillDurableChecksum(
          path,
          actual,
          "abandoned_pending_commit_recovered",
          "durable_json_checksum_backfilled",
        );
      } else {
        writeJsonAtomicSidecar(
          durableChecksumMetaPath(path),
          committedChecksumMeta(path, actual, "pending_meta_committed"),
        );
        event({
          event: "durable_json_checksum_meta_committed",
          status: "pending",
          checksumRecoveryDecision: "pending_meta_committed",
          metadata: {
            locator: relative(root, path),
            checksum: actual,
            checksumRecoveryDecision: "pending_meta_committed",
          },
        });
      }
    } else if (metaState.status === "invalid") {
      repairChecksumMetaSidecar(
        path,
        actual,
        meta,
        "checksum_meta_sidecar_repaired",
        "invalid",
      );
    } else if (checksumMetaIsInvalid(path, actual, meta)) {
      repairChecksumMetaSidecar(
        path,
        actual,
        meta,
        "checksum_meta_sidecar_repaired",
        "conflict",
      );
    } else if (metaState.status === "missing") {
      writeCommittedChecksumMeta(path, actual, "metadata_backfilled");
    }
  } catch (error) {
    if (error instanceof DurableStateError) throw error;
    quarantineDurableTarget(path, "json", error?.message ?? "invalid", error, {
      checksumExpected: error?.checksumExpected,
      checksumActual: error?.checksumActual,
      checksumRecoveryDecision: error?.message === "checksum_mismatch"
        ? "stop_until_fixed"
        : undefined,
    });
  }
}

function reconcileDurableYamlTarget(path) {
  if (statusJson) return;
  if (isDurableAuxiliaryPath(path)) return;
  withJsonFileLock(path, () => reconcileDurableYamlTargetUnlocked(path));
}

function reconcileDurableYamlTargetUnlocked(path) {
  const directory = dirname(path);
  try {
    for (const entry of readdirSync(directory)) {
      if (
        isDurableTempEntry(path, entry) ||
        isDurableTempEntry(durableChecksumPath(path), entry)
      ) {
        const temporaryPath = join(directory, entry);
        const temporaryStat = statSync(temporaryPath);
        const decision = durableTempCleanupDecision(temporaryPath, temporaryStat);
        if (!decision.remove) continue;
        const ownerProjection = tempOwnerProjection(temporaryPath);
        rmSync(temporaryPath, { force: true });
        rmSync(`${temporaryPath}.owner.json`, { force: true });
        fsyncDirectory(directory);
        event({
          event: "durable_yaml_temp_reconciled",
          status: "pending",
          localFailureClass: "durable_stale_temp_reconciled",
          targetLocator: relative(root, temporaryPath),
          ...ownerProjection,
          metadata: {
            locator: relative(root, temporaryPath),
            lockOwnerEvidence: decision.lockOwnerEvidence,
            recoveryDecision: "stale_temp_removed",
            cleanupReason: decision.reason,
            staleAgeMs: Math.floor(decision.staleAgeMs),
          },
        });
      }
    }
  } catch {
    return;
  }
  if (!existsSync(path)) return;
  try {
    const text = readFileSync(path, "utf8");
    YAML.parse(text);
    const expected = existsSync(durableChecksumPath(path))
      ? readFileSync(durableChecksumPath(path), "utf8").trim()
      : null;
    const actual = sha256Text(text);
    const metaState = readChecksumMetaState(path);
    const meta = metaState.meta;
    if (expected != null && expected !== actual) {
      if (checksumCommitEvidenceMatches(path, actual, meta)) {
        backfillDurableChecksum(
          path,
          actual,
          "target_new_checksum_old",
          "durable_yaml_checksum_backfilled",
        );
        return;
      }
      throw Object.assign(new Error("checksum_mismatch"), {
        checksumExpected: expected,
        checksumActual: actual,
      });
    }
    if (expected == null) {
      if (!checksumCommitEvidenceMatches(path, actual, meta)) {
        throw Object.assign(new Error("checksum_mismatch"), {
          checksumExpected: null,
          checksumActual: actual,
        });
      }
      backfillDurableChecksum(
        path,
        actual,
        "target_new_checksum_missing",
        "durable_yaml_checksum_backfilled",
      );
    } else if (checksumMetaIsPending(meta)) {
      if (!checksumCommitEvidenceMatches(path, actual, meta)) {
        throw Object.assign(new Error("checksum_mismatch"), {
          checksumExpected: meta?.checksum,
          checksumActual: actual,
        });
      }
      if (meta?.checksum !== actual) {
        backfillDurableChecksum(
          path,
          actual,
          "abandoned_pending_commit_recovered",
          "durable_yaml_checksum_backfilled",
        );
      } else {
        writeJsonAtomicSidecar(
          durableChecksumMetaPath(path),
          committedChecksumMeta(path, actual, "pending_meta_committed"),
        );
        event({
          event: "durable_yaml_checksum_meta_committed",
          status: "pending",
          checksumRecoveryDecision: "pending_meta_committed",
          metadata: {
            locator: relative(root, path),
            checksum: actual,
            checksumRecoveryDecision: "pending_meta_committed",
          },
        });
      }
    } else if (metaState.status === "invalid") {
      repairChecksumMetaSidecar(
        path,
        actual,
        meta,
        "checksum_meta_sidecar_repaired",
        "invalid",
      );
    } else if (checksumMetaIsInvalid(path, actual, meta)) {
      repairChecksumMetaSidecar(
        path,
        actual,
        meta,
        "checksum_meta_sidecar_repaired",
        "conflict",
      );
    } else if (metaState.status === "missing") {
      writeCommittedChecksumMeta(path, actual, "metadata_backfilled");
    }
  } catch (error) {
    if (error instanceof DurableStateError) throw error;
    quarantineDurableTarget(path, "yaml", error?.message ?? "invalid", error, {
      checksumExpected: error?.checksumExpected,
      checksumActual: error?.checksumActual,
      checksumRecoveryDecision: error?.message === "checksum_mismatch"
        ? "stop_until_fixed"
        : undefined,
    });
  }
}

function reconcileDurableRunFiles() {
  if (statusJson) return;
  reconcileDurableJsonTarget(manifestPath);
  reconcileDurableJsonTarget(recoverySummaryPath);
  reconcileDurableJsonTarget(coordinatorLockPath);
  for (const directory of [itemRoot, providerSlotRoot, subprocessRoot, bookLeaseRoot]) {
    try {
      for (const entry of readdirSync(directory)) {
        if (!isDurablePrimaryJsonEntry(entry)) continue;
        reconcileDurableJsonTarget(join(directory, entry));
      }
    } catch {
      // A missing directory is expected before the first run creates it.
    }
  }
}

function lockPathFor(path) {
  return `${path}.lock`;
}

function providerSlotRegistryLockPath(provider) {
  return join(providerSlotRoot, `${provider}.registry.json`);
}

function readJsonLockOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) ?? {};
  } catch {
    return {};
  }
}

function jsonLockOwnerExpired(owner, entry) {
  const expiryMs = epochMs(owner?.expiresAt);
  return expiryMs > 0
    ? Date.now() > expiryMs
    : Date.now() - entry.mtimeMs > jsonFileLockStaleMs;
}

function jsonLockOwnerHasRecoveryFence(owner) {
  return Number.isInteger(owner?.generation) &&
    typeof owner?.fencingTokenHash === "string" &&
    owner.fencingTokenHash.length > 0 &&
    typeof owner?.runnerSessionId === "string" &&
    owner.runnerSessionId.length > 0 &&
    typeof owner?.operationId === "string" &&
    owner.operationId.length > 0;
}

function removeStaleJsonLock(path) {
  try {
    const lockPath = path;
    const entry = statSync(lockPath);
    if (Date.now() - entry.mtimeMs > jsonFileLockStaleMs) {
      const owner = readJsonLockOwner(lockPath);
      if (!jsonLockOwnerExpired(owner, entry)) return;
      if (!jsonLockOwnerHasRecoveryFence(owner)) return;
      if (processAlive(owner.pid)) return;
      unlinkSync(lockPath);
      fsyncDirectory(dirname(lockPath));
      event({
        event: "durable_lock_recovered",
        status: "pending",
        localFailureClass: "durable_stale_lock_recovered",
        targetLocator: owner.targetLocator ?? relative(root, lockPath),
        lane: owner.lane,
        targetMappingOwner: owner.targetMappingOwner,
        laneTimeoutMs: owner.laneTimeoutMs,
        releaseOn: owner.releaseOn,
        operationId: owner.operationId,
        lockOwnerEvidence: redactJsonValue(owner),
        durableMode: "strict",
        metadata: {
          lockPath: relative(root, lockPath),
          lockOwnerEvidence: redactJsonValue(owner),
          recoveryDecision: "stale_lock_removed",
        },
      });
    }
  } catch {
    // Missing or concurrently removed locks are expected under contention.
  }
}

function staleJsonLockWithoutRecoveryFenceError(path, lockPath, mapping) {
  let entry;
  try {
    entry = statSync(lockPath);
  } catch {
    return null;
  }
  const lockOwnerEvidence = readJsonLockOwner(lockPath);
  const expiredAndDead = jsonLockOwnerExpired(lockOwnerEvidence, entry) &&
    !processAlive(lockOwnerEvidence.pid);
  if (!expiredAndDead || jsonLockOwnerHasRecoveryFence(lockOwnerEvidence)) {
    return null;
  }
  return new DurableStateError(
    `durable preflight blocked stale lock without recovery fence: ${
      relative(root, lockPath)
    }`,
    {
      failureKind: "local_state_integrity",
      localFailureClass: "durable_preflight_live_lock",
      failedStage: "runner_start",
      evidence: {
        targetLocator: lockOwnerEvidence.targetLocator ?? relative(root, path),
        redactedEvidenceLocator: basename(lockPath),
        ...mapping,
        operationId: lockOwnerEvidence.operationId,
        lockOwnerEvidence: redactJsonValue(lockOwnerEvidence),
        durableMode: "strict",
        completedPublishRule: "forbidden",
      },
    },
  );
}

function assertJsonLockStillOwned(lockPath, expected) {
  const current = readJsonLockOwner(lockPath);
  if (
    current.operationId === expected.operationId &&
    current.runnerSessionId === expected.runnerSessionId &&
    current.generation === expected.generation &&
    current.fencingTokenHash === expected.fencingTokenHash
  ) {
    return;
  }
  throw new DurableStateError(
    `durable lock fencing rejected: ${relative(root, lockPath)}`,
    {
      localFailureClass: "stale_writer_commit_rejected",
      evidence: {
        targetLocator: expected.targetLocator,
        redactedEvidenceLocator: basename(lockPath),
        lane: expected.lane,
        targetMappingOwner: expected.targetMappingOwner,
        laneTimeoutMs: expected.laneTimeoutMs,
        releaseOn: expected.releaseOn,
        operationId: expected.operationId,
        lockOwnerEvidence: {
          expected,
          current,
        },
        durableMode: "strict",
        completedPublishRule: "forbidden",
      },
    },
  );
}

function jsonLockOwnedBy(lockPath, expected) {
  const current = readJsonLockOwner(lockPath);
  return current.operationId === expected.operationId &&
    current.runnerSessionId === expected.runnerSessionId &&
    current.generation === expected.generation &&
    current.fencingTokenHash === expected.fencingTokenHash;
}

function releaseJsonFileLock(lockPath, owner) {
  try {
    if (!jsonLockOwnedBy(lockPath, owner)) return;
    unlinkSync(lockPath);
    fsyncDirectory(dirname(lockPath));
  } catch {
    // Missing or concurrently removed locks are handled by stale lock recovery.
  }
}

function enterHeldJsonFileLock(path) {
  const count = heldJsonFileLocks.get(path) ?? 0;
  heldJsonFileLocks.set(path, count + 1);
}

function exitHeldJsonFileLock(path) {
  const count = heldJsonFileLocks.get(path) ?? 0;
  if (count <= 1) {
    heldJsonFileLocks.delete(path);
  } else {
    heldJsonFileLocks.set(path, count - 1);
  }
}

function jsonFileLockHeldByCurrentStack(path) {
  return (heldJsonFileLocks.get(path) ?? 0) > 0;
}

function withJsonFileLock(path, callback) {
  const lockPath = lockPathFor(path);
  const startedAt = Date.now();
  for (;;) {
    let fd = null;
    const mapping = durableTargetMapping(path, "lock");
    const owner = {
      pid: runnerPid,
      runnerSessionId,
      runnerHost,
      runId,
      targetLocator: relative(root, path),
      lockPath: relative(root, lockPath),
      ...mapping,
      generation: coordinatorLease?.generation ?? 1,
      fencingTokenHash: coordinatorLease?.fencingToken == null
        ? sha256Text([
            "json-lock",
            runnerSessionId,
            runId,
            relative(root, path),
            String(coordinatorLease?.generation ?? 1),
          ].join(":"))
        : sha256Text(coordinatorLease.fencingToken),
      operationId: randomToken("json-lock"),
      acquiredAt: now(),
      heartbeatAt: now(),
      expiresAt: new Date(Date.now() + jsonFileLockStaleMs).toISOString(),
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify(owner) + "\n");
      fsyncSync(fd);
      assertJsonLockStillOwned(lockPath, owner);
      enterHeldJsonFileLock(path);
      try {
        const result = callback();
        assertJsonLockStillOwned(lockPath, owner);
        return result;
      } finally {
        exitHeldJsonFileLock(path);
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      removeStaleJsonLock(lockPath);
      const staleLockError = staleJsonLockWithoutRecoveryFenceError(
        path,
        lockPath,
        mapping,
      );
      if (staleLockError != null) throw staleLockError;
      if (Date.now() - startedAt > jsonFileLockWaitMs) {
        const lockOwnerEvidence = readJsonLockOwner(lockPath);
        const durableError = new DurableStateError(
          `timed out waiting for json file lock: ${relative(root, lockPath)}`,
          {
            failureKind: "local_state_lock_timeout",
            localFailureClass: "durable_state_lock_timeout",
            evidence: {
              targetLocator: relative(root, path),
              redactedEvidenceLocator: basename(path),
              ...mapping,
              lockOwnerEvidence,
              durableMode: "strict",
            },
          },
        );
        emitDurableFailureEvent("durable_lock_timeout", durableError, {
          targetLocator: relative(root, path),
        });
        throw durableError;
      }
      sleep(25);
    } finally {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // Best-effort cleanup only; the stale lock sweeper handles leftovers.
        }
        releaseJsonFileLock(lockPath, owner);
      }
    }
  }
}

async function withJsonFileLockAsync(path, callback) {
  const lockPath = lockPathFor(path);
  const startedAt = Date.now();
  for (;;) {
    let fd = null;
    const mapping = durableTargetMapping(path, "lock");
    const owner = {
      pid: runnerPid,
      runnerSessionId,
      runnerHost,
      runId,
      targetLocator: relative(root, path),
      lockPath: relative(root, lockPath),
      ...mapping,
      generation: coordinatorLease?.generation ?? 1,
      fencingTokenHash: coordinatorLease?.fencingToken == null
        ? sha256Text([
            "json-lock",
            runnerSessionId,
            runId,
            relative(root, path),
            String(coordinatorLease?.generation ?? 1),
          ].join(":"))
        : sha256Text(coordinatorLease.fencingToken),
      operationId: randomToken("json-lock"),
      acquiredAt: now(),
      heartbeatAt: now(),
      expiresAt: new Date(Date.now() + jsonFileLockStaleMs).toISOString(),
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify(owner) + "\n");
      fsyncSync(fd);
      assertJsonLockStillOwned(lockPath, owner);
      enterHeldJsonFileLock(path);
      try {
        const result = await callback();
        assertJsonLockStillOwned(lockPath, owner);
        return result;
      } finally {
        exitHeldJsonFileLock(path);
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      removeStaleJsonLock(lockPath);
      const staleLockError = staleJsonLockWithoutRecoveryFenceError(
        path,
        lockPath,
        mapping,
      );
      if (staleLockError != null) throw staleLockError;
      if (Date.now() - startedAt > jsonFileLockWaitMs) {
        const lockOwnerEvidence = readJsonLockOwner(lockPath);
        const durableError = new DurableStateError(
          `timed out waiting for json file lock: ${relative(root, lockPath)}`,
          {
            failureKind: "local_state_lock_timeout",
            localFailureClass: "durable_state_lock_timeout",
            evidence: {
              targetLocator: relative(root, path),
              redactedEvidenceLocator: basename(path),
              ...mapping,
              lockOwnerEvidence,
              durableMode: "strict",
            },
          },
        );
        emitDurableFailureEvent("durable_lock_timeout", durableError, {
          targetLocator: relative(root, path),
        });
        throw durableError;
      }
      await delay(25);
    } finally {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // Best-effort cleanup only; the stale lock sweeper handles leftovers.
        }
        releaseJsonFileLock(lockPath, owner);
      }
    }
  }
}

function lockedReadWriteTypedJson(path, schema, callback) {
  if (statusJson) return callback(undefined);
  return withJsonFileLock(path, () => {
    const current = existsSync(path) ? schema.parse(readJson(path)) : undefined;
    const next = schema.parse(withoutUndefined(callback(current)));
    writeJsonAtomicWithValue(path, next);
    return next;
  });
}

function writeTypedJson(path, schema, value) {
  const parsed = schema.parse(withoutUndefined(value));
  if (statusJson) return parsed;
  withJsonFileLock(path, () => {
    writeJsonAtomicWithValue(path, parsed);
  });
  return parsed;
}

function writeJsonAtomicWithValue(path, value) {
  const parsed = withoutUndefined(value);
  withDurableOperationContext(durableContextFromValue(parsed), () => {
    writeJsonAtomic(path, JSON.stringify(parsed, null, 2) + "\n");
  });
}

function readTypedJsonIfExists(path, schema) {
  if (isDurableAuxiliaryPath(path)) return null;
  if (!existsSync(path)) return null;
  if (statusJson) {
    try {
      return schema.parse(readDurableJsonReadOnly(path));
    } catch {
      return null;
    }
  }
  if (jsonFileLockHeldByCurrentStack(path)) {
    return readTypedJsonIfExistsUnlocked(path, schema);
  }
  try {
    reconcileDurableJsonTarget(path);
    return schema.parse(readJson(path));
  } catch {
    return null;
  }
}

function readTypedJsonIfExistsUnlocked(path, schema) {
  if (isDurableAuxiliaryPath(path)) return null;
  if (!existsSync(path)) return null;
  if (statusJson) {
    try {
      return schema.parse(readDurableJsonReadOnly(path));
    } catch {
      return null;
    }
  }
  try {
    reconcileDurableJsonTargetUnlocked(path);
    return schema.parse(readJson(path));
  } catch {
    return null;
  }
}

function readExistingEventSequence() {
  if (statusJson || !existsSync(eventsPath)) return 0;
  let maxSequence = 0;
  let lineCount = 0;
  for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    lineCount += 1;
    try {
      const parsed = JSON.parse(line);
      if (Number.isInteger(parsed.sequence)) {
        maxSequence = Math.max(maxSequence, parsed.sequence);
      }
    } catch {
      continue;
    }
  }
  return Math.max(maxSequence, lineCount);
}

function eventRecoveryToken(prefix, parsed, lineIndex) {
  return stableRecoveredToken(prefix, [
    runId,
    lineIndex,
    parsed.eventId ?? null,
    parsed.sequence ?? null,
    parsed.event,
    parsed.itemId ?? null,
    parsed.command ?? null,
    parsed.at,
    sha256Text(JSON.stringify(redactJsonValue(parsed))),
  ]);
}

function normalizeEventLogLines(lines) {
  const normalized = [];
  const seenEventIds = new Set();
  let recovered = false;
  const diagnostics = [];
  let lineIndex = 0;
  for (const line of lines) {
    lineIndex += 1;
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = LegacyBatchEventLogSchema.parse(JSON.parse(line));
    } catch {
      recovered = true;
      break;
    }
    const duplicateEventId =
      typeof parsed.eventId === "string" && seenEventIds.has(parsed.eventId);
    const sequence = normalized.length + 1;
    const normalizedEvent = BatchEventLogSchema.parse({
      ...parsed,
      eventId: duplicateEventId || parsed.eventId == null
        ? eventRecoveryToken("evt-recovered", parsed, lineIndex)
        : parsed.eventId,
      sequence,
      runnerSessionId: parsed.runnerSessionId ?? runnerSessionId,
      message: parsed.message ? redacted(parsed.message) : undefined,
      metadata: parsed.metadata == null ? undefined : redactJsonValue(parsed.metadata),
    });
    if (
      duplicateEventId ||
      parsed.eventId == null ||
      parsed.sequence !== sequence ||
      parsed.runnerSessionId == null
    ) {
      recovered = true;
      diagnostics.push(withoutUndefined({
        lineIndex,
        previousEventId: parsed.eventId,
        recoveredEventId: normalizedEvent.eventId,
        previousSequence: parsed.sequence,
        recoveredSequence: sequence,
        duplicateEventId,
        missingEventId: parsed.eventId == null,
        missingRunnerSessionId: parsed.runnerSessionId == null,
      }));
    }
    seenEventIds.add(normalizedEvent.eventId);
    normalized.push(normalizedEvent);
  }
  return {
    recovered,
    diagnostics,
    lines: normalized.map((item) => JSON.stringify(item)),
  };
}

function recoverEventLogTail() {
  if (statusJson || !existsSync(eventsPath)) return false;
  const text = readFileSync(eventsPath, "utf8");
  const normalized = normalizeEventLogLines(text.split(/\r?\n/u));
  const recovered = normalized.recovered;
  if (!recovered) return false;
  writeJsonlAtomic(eventsPath, normalized.lines);
  eventSequence = readExistingEventSequence();
  event({
    event: "partial_event_tail_recovered",
    status: "running",
    metadata: {
      retainedEventCount: normalized.lines.length,
      normalizedEventLog: true,
      diagnostics: normalized.diagnostics,
    },
  });
  if (normalized.diagnostics.length > 0) {
    event({
      event: "event_log_normalized",
      status: "pending",
      metadata: {
        retainedEventCount: normalized.lines.length,
        diagnostics: normalized.diagnostics,
      },
    });
  }
  return true;
}

function readCoordinatorLock() {
  if (!existsSync(coordinatorLockPath)) return null;
  try {
    return CoordinatorLockSchema.parse(readJson(coordinatorLockPath));
  } catch {
    return null;
  }
}

function recoverCoordinatorRuntimeArtifacts() {
  if (statusJson) return;
  for (const provider of ["openai", "jina", "local_cpu", "qmd_index_writer"]) {
    withJsonFileLock(providerSlotRegistryLockPath(provider), () => {
      recoverStaleProviderSlotLeases(provider);
    });
  }
  for (const record of activeSubprocessRecords()) {
    const sameHost = record.runnerHost === runnerHost;
    const liveChild = sameHost && processAlive(record.pid);
    const parentAlive = sameHost && processAlive(record.runnerPid);
    if (sameHost && liveChild && !parentAlive) {
      terminatePid(record.pid, record.processGroup, "SIGTERM");
      sleep(250);
      if (processAlive(record.pid)) terminatePid(record.pid, record.processGroup, "SIGKILL");
      const killed = !processAlive(record.pid);
      updateSubprocessRecord(record.subprocessId, (current) => ({
        ...(current ?? record),
        heartbeatAt: now(),
        status: killed ? "killed" : "quarantined",
        signal: killed ? "ORPHAN_TERMINATED" : "ORPHAN_QUARANTINED",
        completedAt: now(),
      }));
      event({
        event: killed
          ? "subprocess_orphan_terminated"
          : "subprocess_orphan_quarantined",
        status: killed ? "pending" : "failed",
        recoveryDecision: killed ? "continue_pending" : "stop_until_fixed",
        command: record.command,
        metadata: {
          itemId: record.itemId,
          subprocessId: record.subprocessId,
          pid: record.pid,
          workerId: record.workerId,
          bookId: record.bookId,
          providerSlotId: record.providerSlotId,
        },
      });
      if (!killed) {
        requestBatchStop("live_orphan_subprocess_quarantined");
      }
      continue;
    }
    if (!sameHost || !processAlive(record.pid)) {
      const status = sameHost ? "killed" : "quarantined";
      const signal = sameHost ? "ORPHAN_RECOVERED" : "REMOTE_ORPHAN_QUARANTINED";
      updateSubprocessRecord(record.subprocessId, (current) => ({
        ...(current ?? record),
        heartbeatAt: now(),
        status,
        signal,
        completedAt: now(),
      }));
      event({
        event: sameHost
          ? "subprocess_orphan_recovered"
          : "subprocess_orphan_quarantined",
        status: sameHost ? "pending" : "failed",
        recoveryDecision: sameHost ? "continue_pending" : "stop_until_fixed",
        command: record.command,
        metadata: {
          itemId: record.itemId,
          subprocessId: record.subprocessId,
          pid: record.pid,
          workerId: record.workerId,
          bookId: record.bookId,
          providerSlotId: record.providerSlotId,
          runnerHost: record.runnerHost,
          reason: sameHost ? "dead_child" : "remote_unknown",
        },
      });
      if (!sameHost) {
        requestBatchStop("remote_orphan_subprocess_quarantined");
      }
    }
  }
}

function coordinatorLockLive(lock) {
  if (lock == null) return false;
  if (lock.runnerHost === runnerHost && processAlive(lock.runnerPid)) return true;
  if (epochMs(lock.expiresAt) <= Date.now()) return false;
  if (lock.runnerHost === runnerHost) return false;
  return true;
}

function newCoordinatorLease(previous) {
  const acquiredAt = now();
  return CoordinatorLockSchema.parse({
    schemaVersion: SchemaVersion,
    runId,
    runnerSessionId,
    runnerHost,
    runnerPid,
    generation: (previous?.generation ?? 0) + 1,
    fencingToken: randomToken("coordinator-fence"),
    acquiredAt,
    heartbeatAt: acquiredAt,
    expiresAt: leaseExpiresAt(),
    bookConcurrency,
    openaiProviderConcurrency,
    jinaProviderConcurrency,
    localCpuConcurrency,
  });
}

function acquireCoordinatorLock() {
  if (statusJson) return null;
  return withJsonFileLock(coordinatorLockPath, () => {
    const current = readCoordinatorLock();
    if (coordinatorLockLive(current)) {
      throw new Error(
        `run ${runId} already has a live coordinator: ` +
          `session=${current.runnerSessionId} pid=${current.runnerPid} ` +
          `host=${current.runnerHost} expiresAt=${current.expiresAt}`,
      );
    }
    const lease = newCoordinatorLease(current);
    writeJsonAtomicWithValue(coordinatorLockPath, lease);
    coordinatorLease = lease;
    recoverCoordinatorRuntimeArtifacts();
    return lease;
  });
}

function assertCoordinatorLease() {
  if (statusJson || coordinatorLease == null) return;
  const current = readCoordinatorLock();
  if (
    current?.runnerSessionId !== coordinatorLease.runnerSessionId ||
    current?.generation !== coordinatorLease.generation ||
    current?.fencingToken !== coordinatorLease.fencingToken
  ) {
    throw new Error(`coordinator lease lost for run ${runId}`);
  }
}

function heartbeatCoordinatorLock() {
  if (statusJson || coordinatorLease == null) return;
  withJsonFileLock(coordinatorLockPath, () => {
    const current = readCoordinatorLock();
    if (
      current?.runnerSessionId !== coordinatorLease.runnerSessionId ||
      current?.generation !== coordinatorLease.generation ||
      current?.fencingToken !== coordinatorLease.fencingToken
    ) {
      coordinatorLease = null;
      throw new Error(`coordinator lease lost for run ${runId}`);
    }
    const updated = CoordinatorLockSchema.parse({
      ...current,
      heartbeatAt: now(),
      expiresAt: leaseExpiresAt(),
    });
    writeJsonAtomicWithValue(coordinatorLockPath, updated);
    coordinatorLease = updated;
  });
}

function startCoordinatorHeartbeat() {
  if (statusJson || coordinatorLease == null) return;
  const intervalMs = Math.max(1000, heartbeatIntervalSeconds * 1000);
  coordinatorHeartbeatTimer = setInterval(() => {
    try {
      heartbeatCoordinatorLock();
    } catch (error) {
      console.error(redactLog(
        error instanceof Error ? error.stack ?? error.message : String(error),
      ));
      process.exitCode = 1;
      clearInterval(coordinatorHeartbeatTimer);
      coordinatorHeartbeatTimer = null;
    }
  }, intervalMs);
  coordinatorHeartbeatTimer.unref?.();
}

function releaseCoordinatorLock() {
  if (statusJson || coordinatorLease == null) return;
  const lease = coordinatorLease;
  if (coordinatorHeartbeatTimer != null) {
    clearInterval(coordinatorHeartbeatTimer);
    coordinatorHeartbeatTimer = null;
  }
  try {
    withJsonFileLock(coordinatorLockPath, () => {
      const current = readCoordinatorLock();
      if (
        current?.runnerSessionId === lease.runnerSessionId &&
        current?.generation === lease.generation &&
        current?.fencingToken === lease.fencingToken
      ) {
        rmSync(coordinatorLockPath, { force: true });
        fsyncDirectory(dirname(coordinatorLockPath));
      }
    });
  } finally {
    coordinatorLease = null;
  }
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
  const catalog = statusJson
    ? readDurableYamlReadOnly(catalogPath) ?? {}
    : withJsonFileLock(catalogPath, () => {
        return readDurableYamlAfterReconcileUnlocked(catalogPath) ?? {};
      });
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

function discoverItemsWithDurableFailureEvent() {
  try {
    return discoverItems();
  } catch (error) {
    if (!statusJson && error instanceof DurableStateError) {
      eventSequence = readExistingEventSequence();
      emitDurableFailureEvent("durable_replace_failed", error);
    }
    throw error;
  }
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
    activeProviderSlots: 0,
    activeSubprocesses: 0,
    activeBookLeases: 0,
    startedAt: now(),
    updatedAt: now(),
    itemIds: items.map((item) => item.itemId),
    metadata: {
      logRootName: basename(logRoot),
    },
  };
}

function loadManifest(items) {
  reconcileDurableJsonTarget(manifestPath);
  if (existsSync(manifestPath)) {
    let manifest;
    try {
      manifest = BatchRunManifestSchema.parse(
        statusJson ? readDurableJsonReadOnly(manifestPath) : readJson(manifestPath),
      );
    } catch (error) {
      if (statusJson) throw error;
      const quarantinePath = `${manifestPath}.corrupt-${Date.now()}`;
      const operation = durableOperationEvidence(manifestPath, "json-quarantine", {
        localFailureClass: "durable_target_invalid",
        checksumRecoveryDecision: "stop_until_fixed",
      });
      try {
        renameWithDurableEvidence(manifestPath, quarantinePath, operation);
        fsyncDirectory(dirname(manifestPath), operation);
      } catch (renameError) {
        const durableError = classifyDurableWriteError(renameError, operation);
        emitDurableFailureEvent("durable_replace_failed", durableError, {
          targetLocator: relative(root, manifestPath),
        });
        throw durableError;
      }
      event({
        event: "manifest_rebuilt",
        status: "pending",
        metadata: {
          reason: "invalid_manifest_schema",
          quarantineLocator: relative(root, quarantinePath),
        },
      });
      const rebuilt = makeManifest(items);
      return writeTypedJson(manifestPath, BatchRunManifestSchema, rebuilt);
    }
    const previousTotalItems = manifest.totalItems;
    const previousItemIds = [...manifest.itemIds];
    manifest.sourceRootName = basename(sourceDir);
    manifest.stateRootLocator = relative(root, stateRoot);
    manifest.qmdIndexLocator = relative(root, qmdIndexPath);
    manifest.configLocator = relative(root, configPath);
    const itemIds = items.map((item) => item.itemId);
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
    manifest.activeProviderSlots = activeProviderSlotLeases().length;
    manifest.activeSubprocesses = activeSubprocessRecords().length;
    manifest.activeBookLeases = activeBookLeases().length;
    const mismatch = previousTotalItems !== items.length ||
      previousItemIds.length !== itemIds.length ||
      previousItemIds.some((itemId, index) => itemId !== itemIds[index]);
    if (mismatch && !statusJson) {
      event({
        event: "manifest_rebuilt",
        status: "pending",
        metadata: {
          reason: "manifest_item_projection_mismatch",
          previousTotalItems,
          rebuiltTotalItems: items.length,
        },
      });
      return writeTypedJson(
        manifestPath,
        BatchRunManifestSchema,
        { ...makeManifest(items), startedAt: manifest.startedAt },
      );
    }
    manifest.totalItems = items.length;
    manifest.itemIds = itemIds;
    return manifest;
  }
  if (statusJson) {
    throw new Error(`missing batch manifest for --status-json: ${manifestPath}`);
  }
  const manifest = makeManifest(items);
  return writeTypedJson(manifestPath, BatchRunManifestSchema, manifest);
}

function writeStartupRecoveryManifest(manifest, update = {}) {
  if (statusJson) return manifest;
  const current = manifest.metadata?.startupRecovery ?? {};
  const startupRecovery = withoutUndefined({
    ...current,
    runId,
    stage: "runner_start",
    scopeCount: update.scopeCount ?? current.scopeCount ?? 0,
    targetCount: update.targetCount ?? current.targetCount ?? 0,
    mutationCount: update.mutationCount ?? current.mutationCount ?? 0,
    firstSample: update.firstSample ?? current.firstSample,
    lastSample: update.lastSample ?? current.lastSample,
    decision: update.decision ?? current.decision ?? "created_before_preflight",
    explicitRepairHint: update.explicitRepairHint ?? current.explicitRepairHint ??
      "use explicit repair or migrate-only for provider request durable repairs",
    providerRequestDiagnostics: update.providerRequestDiagnostics ??
      current.providerRequestDiagnostics,
    updatedAt: now(),
  });
  const next = {
    ...manifest,
    updatedAt: now(),
    metadata: withoutUndefined({
      ...(manifest.metadata ?? {}),
      startupRecovery,
    }),
  };
  return writeTypedJson(manifestPath, BatchRunManifestSchema, next);
}

function updateManifestWithProviderRequestDiagnostics(manifest, diagnostics) {
  if (statusJson || diagnostics.length === 0) return manifest;
  const samples = diagnostics.flatMap((item) => item.sampleTargetLocators ?? []);
  return writeStartupRecoveryManifest(manifest, {
    targetCount: diagnostics.reduce(
      (total, item) => Math.max(total, item.scannedTargetCount ?? 0),
      0,
    ),
    mutationCount: 0,
    firstSample: samples[0],
    lastSample: samples.at(-1),
    decision: "continue_with_provider_request_diagnostic",
    providerRequestDiagnostics: diagnostics.map((item) =>
      DurableStateDiagnosticSchema.parse(withoutUndefined(item))
    ),
  });
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
  const hydrated = hydrateCheckpoint(
    item,
    statusJson ? readDurableJsonReadOnly(path) : readJson(path),
  );
  if (hydrated.status === "running") {
    hydrated.leaseGeneration = hydrated.leaseGeneration ??
      hydrated.metadata?.leaseGeneration ?? 1;
    hydrated.fencingToken = hydrated.fencingToken ??
      hydrated.metadata?.fencingToken ?? randomToken("legacy-item-fence");
    hydrated.leaseExpiresAt = hydrated.leaseExpiresAt ?? leaseExpiresAt();
    hydrated.bookLeaseGeneration = hydrated.bookLeaseGeneration ??
      hydrated.metadata?.bookLeaseGeneration ?? hydrated.leaseGeneration;
    hydrated.bookFencingToken = hydrated.bookFencingToken ??
      hydrated.metadata?.bookFencingToken ?? randomToken("legacy-book-fence");
  }
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
    runnerSessionId: undefined,
    runnerHost: undefined,
    runnerPid: undefined,
    currentCommand: undefined,
    activeCommand: checkpoint.activeCommand ?? checkpoint.currentCommand,
    currentCommandStartedAt: undefined,
    leaseGeneration: undefined,
    fencingToken: undefined,
    leaseExpiresAt: undefined,
    bookLeaseGeneration: undefined,
    bookFencingToken: undefined,
  };
}

function assertBookLeaseForCheckpoint(checkpoint, expectedStatus = undefined) {
  assertCoordinatorLease();
  if (
    expectedStatus != null &&
    checkpoint.status !== expectedStatus
  ) {
    throw new Error(
      `checkpoint status changed before fenced write: ${checkpoint.itemId}`,
    );
  }
  const currentLease = readTypedJsonIfExists(
    bookLeasePath(checkpoint.bookId),
    BookLeaseSchema,
  );
  if (currentLease == null) {
    throw new Error(`missing book lease for checkpoint: ${checkpoint.bookId}`);
  }
  if (
    currentLease.runnerSessionId !== runnerSessionId ||
    currentLease.fencingToken !== checkpoint.bookFencingToken ||
    currentLease.generation !== checkpoint.bookLeaseGeneration
  ) {
    throw new Error(`book lease is owned by another runner: ${checkpoint.bookId}`);
  }
}

function assertItemCheckpointFence(current, next, expectedStatus = undefined) {
  if (current == null) return;
  if (
    expectedStatus != null &&
    next.status !== expectedStatus
  ) {
    throw new Error(
      `checkpoint status changed before fenced write: ${next.itemId}`,
    );
  }
  if (next.status !== "running" && next.fencingToken == null) return;
  const fencedFields = [
    "runnerSessionId",
    "runnerHost",
    "runnerPid",
    "leaseGeneration",
    "fencingToken",
    "bookLeaseGeneration",
    "bookFencingToken",
  ];
  for (const field of fencedFields) {
    if (next[field] == null) continue;
    if (current[field] !== next[field]) {
      throw new Error(
        `item checkpoint fencing rejected stale write for ${next.itemId}: ${field}`,
      );
    }
  }
  if (
    current.status === "running" &&
    next.status !== "running" &&
    current.runnerSessionId !== runnerSessionId
  ) {
    throw new Error(
      `item checkpoint terminal write is owned by another runner: ${next.itemId}`,
    );
  }
  if (
    current.status === "running" &&
    current.leaseExpiresAt != null &&
    epochMs(current.leaseExpiresAt) <= Date.now()
  ) {
    throw new Error(`item checkpoint lease expired before write: ${next.itemId}`);
  }
}

function mergeCurrentItemLeaseProjection(current, snapshot) {
  if (
    current == null ||
    snapshot.status !== "running" ||
    current.status !== "running" ||
    current.runnerSessionId !== snapshot.runnerSessionId ||
    current.runnerHost !== snapshot.runnerHost ||
    current.runnerPid !== snapshot.runnerPid ||
    current.leaseGeneration !== snapshot.leaseGeneration ||
    current.fencingToken !== snapshot.fencingToken ||
    current.bookLeaseGeneration !== snapshot.bookLeaseGeneration ||
    current.bookFencingToken !== snapshot.bookFencingToken
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    runnerHeartbeatAt: epochMs(current.runnerHeartbeatAt) >
      epochMs(snapshot.runnerHeartbeatAt)
      ? current.runnerHeartbeatAt
      : snapshot.runnerHeartbeatAt,
    leaseExpiresAt: epochMs(current.leaseExpiresAt) >
      epochMs(snapshot.leaseExpiresAt)
      ? current.leaseExpiresAt
      : snapshot.leaseExpiresAt,
  };
}

function saveCheckpoint(item, checkpoint, options = {}) {
  if (checkpoint.status === "running" || options.requireBookLease === true) {
    assertBookLeaseForCheckpoint(checkpoint, options.expectedStatus);
  } else {
    assertCoordinatorLease();
  }
  const path = itemPath(item);
  return lockedReadWriteTypedJson(path, BatchItemCheckpointSchema, (current) => {
    const snapshot = withBuildStatusSnapshot(item, checkpoint);
    assertItemCheckpointFence(current, snapshot, options.expectedStatus);
    return withCheckpointPersistenceInvariants(
      mergeCurrentItemLeaseProjection(current, snapshot),
    );
  });
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

function startCommandHeartbeatMonitor(item, command, commandStartedAt) {
  if (statusJson) return null;
  const intervalMs = heartbeatIntervalSeconds * 1000;
  let stopped = false;
  let failure = null;
  const writeHeartbeat = () => {
    if (stopped || failure != null || !existsSync(itemPath(item))) return false;
    try {
      return withJsonFileLock(itemPath(item), () => {
        if (stopped || failure != null || !existsSync(itemPath(item))) return false;
        const checkpoint = BatchItemCheckpointSchema.parse(readJson(itemPath(item)));
        if (
          checkpoint.status !== "running" ||
          checkpoint.runnerSessionId !== runnerSessionId ||
          checkpoint.runnerHost !== runnerHost ||
          checkpoint.runnerPid !== runnerPid
        ) {
          return false;
        }
        const updated = BatchItemCheckpointSchema.parse({
          ...checkpoint,
          runnerHeartbeatAt: now(),
          currentCommand: command,
          activeCommand: command,
          currentCommandStartedAt: commandStartedAt,
        });
        writeJsonAtomicWithValue(itemPath(item), updated);
        return true;
      });
    } catch (error) {
      emitDurableFailureEvent("durable_replace_failed", error, {
        targetLocator: relative(root, itemPath(item)),
      });
      failure = error;
      return false;
    }
  };
  writeHeartbeat();
  const timer = setInterval(() => {
    if (!writeHeartbeat()) clearInterval(timer);
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    assertHealthy() {
      if (failure != null) throw failure;
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
        leaseExpiresAt: new Date(
          Date.now() + Math.max(
            heartbeatIntervalSeconds * 3000,
            runnerHeartbeatTtlSeconds * 1000,
          ),
        ).toISOString(),
        currentCommand: undefined,
        activeCommand: checkpoint.activeCommand ?? checkpoint.currentCommand,
        currentCommandStartedAt: undefined,
      }));
      writeJsonAtomicWithValue(itemPath(item), cleaned);
    });
  } catch (error) {
    emitDurableFailureEvent("durable_replace_failed", error, {
      targetLocator: relative(root, itemPath(item)),
    });
    throw error;
  }
}

function readYamlFileIfExists(path) {
  if (!existsSync(path)) return null;
  if (statusJson) return readDurableYamlReadOnly(path);
  return withJsonFileLock(path, () => {
    return readDurableYamlAfterReconcileUnlocked(path);
  });
}

function readDurableYamlAfterReconcileUnlocked(path) {
  reconcileDurableYamlTargetUnlocked(path);
  const text = readFileSync(path, "utf8");
  return YAML.parse(text) ?? null;
}

function readYamlSchemaIfExists(path, schema) {
  const raw = readYamlFileIfExists(path);
  return raw == null ? null : schema.parse(raw);
}

function readJsonSchemaIfExists(path, schema) {
  if (!existsSync(path)) return null;
  if (!statusJson) reconcileDurableJsonTarget(path);
  const parsed = schema.safeParse(
    statusJson ? readDurableJsonReadOnly(path) : readJson(path),
  );
  return parsed.success ? parsed.data : null;
}

function readGraphOutputProducerManifest(path) {
  if (!existsSync(path)) return null;
  if (!statusJson) reconcileDurableJsonTarget(path);
  const raw = statusJson ? readDurableJsonReadOnly(path) : readJson(path);
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
  const rowCountPath = join(tableDir, "qmd_row_count.json");
  if (!existsSync(rowCountPath)) return null;
  if (!statusJson) reconcileDurableJsonTarget(rowCountPath);
  const parsed = statusJson
    ? readDurableJsonReadOnly(rowCountPath)
    : JSON.parse(readFileSync(rowCountPath, "utf8"));
  if (typeof parsed === "number") return parsed;
  if (parsed && typeof parsed === "object" && typeof parsed.rowCount === "number") {
    return parsed.rowCount;
  }
  return null;
}

function isDurableTargetError(error) {
  return error instanceof Error &&
    (
      error.message.startsWith("invalid durable JSON target:") ||
      error.message.startsWith("invalid durable YAML target:") ||
      error.message.includes("durable json checksum_mismatch") ||
      error.message.includes("durable yaml checksum_mismatch") ||
      error.message.includes("durable checksum_mismatch")
    );
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
  } catch (error) {
    if (isDurableTargetError(error)) throw error;
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
  } catch (error) {
    if (isDurableTargetError(error)) throw error;
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
      parsed = readGraphOutputProducerManifest(manifestPath);
    } catch {
      continue;
    }
    if (parsed == null || typeof parsed.outputDir !== "string") continue;
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
    const migrated = GraphRagOutputProducerManifestSchema.parse({
      ...parsed,
      outputDir: expectedLocator,
    });
    writeTypedJson(
      manifestPath,
      GraphRagOutputProducerManifestSchema,
      migrated,
    );
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
      process.env.QMD_GRAPHRAG_ENABLE_TEST_HOOKS === "1" &&
      commandNames.length === defaultRequiredCommandCheckNames.length &&
      new Set(commandNames).size === defaultRequiredCommandCheckNames.length &&
      defaultRequiredCommandCheckNames.every((name) => commandNames.includes(name))
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
  if (process.env.QMD_GRAPHRAG_ENABLE_TEST_HOOKS === "1") {
    expectedCommandFingerprints.add(stableHash(defaultRequiredCommandCheckNames));
  }
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
  const durableFields = durableProjection(failed ?? checkpoint);
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
    ...durableFields,
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
  const previousCounts = {
    pendingItems: manifest.pendingItems,
    runningItems: manifest.runningItems,
    completedItems: manifest.completedItems,
    skippedItems: manifest.skippedItems,
    importedCompletedItems: manifest.importedCompletedItems,
    failedItems: manifest.failedItems,
  };
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
  manifest.activeProviderSlots = activeProviderSlotLeases().length;
  manifest.activeSubprocesses = activeSubprocessRecords().length;
  manifest.activeBookLeases = activeBookLeases().length;
  manifest.updatedAt = now();
  const durableFailure = [...checkpoints]
    .reverse()
    .find((item) =>
      item.failureKind === "local_state_integrity" ||
      item.failureKind === "local_state_lock_timeout" ||
      durableProjection(item).localFailureClass != null
    );
  manifest.durableFailureSummary = durableFailure == null
    ? undefined
    : withoutUndefined({
        ...durableProjection(durableFailure),
        recoveryDecision: durableFailure.recoveryDecision,
        failedStage: durableFailure.failedStage,
      });
  const expectedCounts = {
    pendingItems: pending,
    runningItems: running,
    completedItems: completed,
    skippedItems: skipped,
    importedCompletedItems: importedCompleted,
    failedItems: failed,
  };
  const mismatchedCounts = Object.entries(expectedCounts)
    .filter(([field, expected]) => previousCounts[field] !== expected)
    .map(([field]) => field);
  if (mismatchedCounts.length > 0 && !statusJson) {
    event({
      event: "manifest_rebuilt",
      status: "pending",
      metadata: {
        reason: "manifest_checkpoint_projection_mismatch",
        mismatchedCounts,
      },
    });
  }
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
  const activeSlotsByItem = new Map();
  for (const lease of activeProviderSlotLeases()) {
    if (lease.itemId == null) continue;
    const current = activeSlotsByItem.get(lease.itemId) ?? {
      activeProviderSlots: 0,
      providerWaitMs: 0,
      providerSlotGeneration: lease.generation,
    };
    current.activeProviderSlots += 1;
    if (lease.waitMs != null) {
      current.providerWaitMs = Math.max(
        current.providerWaitMs ?? 0,
        lease.waitMs,
      );
    }
    current.providerSlotGeneration = Math.max(
      current.providerSlotGeneration ?? 0,
      lease.generation,
    );
    activeSlotsByItem.set(lease.itemId, current);
  }
  const activeSubprocessesByItem = new Map();
  for (const record of activeSubprocessRecords()) {
    if (record.itemId == null) continue;
    activeSubprocessesByItem.set(
      record.itemId,
      (activeSubprocessesByItem.get(record.itemId) ?? 0) + 1,
    );
  }
  const items = checkpoints.map((item) => {
    const slotSummary = activeSlotsByItem.get(item.itemId);
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
      workerId: item.workerId ?? item.metadata?.workerId,
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
      ...durableProjection(failedCommand ?? item),
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
      leaseGeneration: failedCommand?.leaseGeneration ?? item.leaseGeneration,
      fencingToken: item.fencingToken,
      leaseExpiresAt: item.leaseExpiresAt,
      bookLeaseGeneration:
        failedCommand?.bookLeaseGeneration ?? item.bookLeaseGeneration,
      bookFencingToken: item.bookFencingToken,
      activeProviderSlots: slotSummary?.activeProviderSlots,
      providerWaitMs: slotSummary?.providerWaitMs,
      providerSlotGeneration: slotSummary?.providerSlotGeneration,
      activeSubprocesses: activeSubprocessesByItem.get(item.itemId),
      orphanedRunnerDetectedAt: item.orphanedRunnerDetectedAt,
      currentCommand: item.status === "running" ? item.currentCommand : undefined,
      activeCommand: item.activeCommand ?? item.currentCommand,
      currentCommandStartedAt: item.status === "running"
        ? item.currentCommandStartedAt
        : undefined,
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
  const durableStateFailures = mergedDurableStateFailures(items);
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
      activeProviderSlots: manifest.activeProviderSlots,
      activeSubprocesses: manifest.activeSubprocesses,
      activeBookLeases: manifest.activeBookLeases,
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
    durableStateFailures: durableStateFailures.length > 0
      ? durableStateFailures
      : undefined,
    durableTempDiagnostics: durableStateFailures
      .filter((item) => String(item.localFailureClass ?? "").includes("temp")),
    durableLockDiagnostics: durableStateFailures
      .filter((item) => String(item.localFailureClass ?? "").includes("lock")),
    items,
  }));
}

function writeRecoverySummary(manifest, checkpoints) {
  const summary = buildRecoverySummary(manifest, checkpoints);
  writeTypedJson(recoverySummaryPath, BatchRecoverySummarySchema, summary);
  writeTypedJson(batchStatusPath, BatchRecoverySummarySchema, summary);
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
  let legacySequence = 0;
  const seenEventIds = new Set();
  const diagnostics = [];
  const migrated = lines.map((line) => {
    legacySequence += 1;
    const item = LegacyBatchEventLogSchema.parse(JSON.parse(line));
    const duplicateEventId =
      typeof item.eventId === "string" && seenEventIds.has(item.eventId);
    const eventId = duplicateEventId || item.eventId == null
      ? eventRecoveryToken("evt-migrated", item, legacySequence)
      : item.eventId;
    if (
      duplicateEventId ||
      item.eventId == null ||
      item.sequence !== legacySequence ||
      item.runnerSessionId == null
    ) {
      diagnostics.push(withoutUndefined({
        lineIndex: legacySequence,
        previousEventId: item.eventId,
        migratedEventId: eventId,
        previousSequence: item.sequence,
        migratedSequence: legacySequence,
        duplicateEventId,
        missingEventId: item.eventId == null,
        missingRunnerSessionId: item.runnerSessionId == null,
      }));
    }
    const sanitized = BatchEventLogSchema.parse({
      ...item,
      eventId,
      sequence: legacySequence,
      runnerSessionId: item.runnerSessionId ?? runnerSessionId,
      message: item.message ? redacted(item.message) : undefined,
      metadata: item.metadata == null ? undefined : redactJsonValue(item.metadata),
    });
    seenEventIds.add(sanitized.eventId);
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
        eventId: stableRecoveredToken("evt-migrated", [
          runId,
          checkpoint.itemId,
          check.name,
          check.completedAt,
          check.errorSummary,
        ]),
        sequence: migrated.length + 1,
        runnerSessionId,
        coordinatorGeneration: coordinatorLease?.generation,
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
  const sequenced = migrated.map((item, index) =>
    BatchEventLogSchema.parse({ ...item, sequence: index + 1 })
  );
  if (diagnostics.length > 0) {
    sequenced.push(BatchEventLogSchema.parse({
      schemaVersion: SchemaVersion,
      runId,
      eventId: stableRecoveredToken("evt-migrated", [
        runId,
        "event-log-normalized",
        diagnostics,
      ]),
      sequence: sequenced.length + 1,
      runnerSessionId,
      coordinatorGeneration: coordinatorLease?.generation,
      event: "event_log_normalized",
      status: "pending",
      at: now(),
      metadata: { diagnostics },
    }));
  }
  writeJsonlAtomic(
    eventsPath,
    sequenced.map((item) => JSON.stringify(item)),
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

function spawnCommand(command, args, options) {
  return new Promise((resolveResult) => {
    const subprocessId = randomToken("subprocess");
    const startedAt = now();
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: options.shell,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      const record = {
        schemaVersion: SchemaVersion,
        runId,
        subprocessId,
        runnerSessionId,
        runnerHost,
        runnerPid,
        command: options.name ?? command,
        itemId: options.itemId,
        bookId: options.bookId,
        workerId: options.workerId,
        providerSlotId: options.providerSlotLease?.slotId,
        providerSlotProvider: options.providerSlotLease?.provider,
        providerSlotGeneration: options.providerSlotLease?.generation,
        providerSlotFencingToken: options.providerSlotLease?.fencingToken,
        processGroup: process.platform !== "win32",
        startedAt,
        heartbeatAt: now(),
        status: "spawn_error",
        completedAt: now(),
      };
      writeSubprocessRecord(record);
      resolveResult({ status: 1, stdout: "", stderr: "", error });
      return;
    }
    const baseRecord = {
      schemaVersion: SchemaVersion,
      runId,
      subprocessId,
      runnerSessionId,
      runnerHost,
      runnerPid,
      pid: child.pid,
      command: options.name ?? command,
      itemId: options.itemId,
      bookId: options.bookId,
      workerId: options.workerId,
      providerSlotId: options.providerSlotLease?.slotId,
      providerSlotProvider: options.providerSlotLease?.provider,
      providerSlotGeneration: options.providerSlotLease?.generation,
      providerSlotFencingToken: options.providerSlotLease?.fencingToken,
      processGroup: process.platform !== "win32",
      startedAt,
      heartbeatAt: startedAt,
      status: "running",
    };
    writeSubprocessRecord(baseRecord);
    if (child.pid != null) activeChildProcesses.set(subprocessId, child);
    const maxBuffer = options.maxBuffer ?? 128 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let bufferExceeded = false;
    let spawnError = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      setTimeout(() => {
        terminateProcessTree(child, "SIGKILL");
      }, 2000).unref();
    }, options.timeoutMs);
    timeout.unref();
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeChildProcesses.delete(subprocessId);
      const failedBeforeExitCode = timedOut || bufferExceeded || spawnError != null;
      resolveResult({
        status: status ?? (failedBeforeExitCode ? 1 : 0),
        stdout,
        stderr,
        error: timedOut
          ? Object.assign(new Error("command timed out"), { code: "ETIMEDOUT" })
          : bufferExceeded
            ? Object.assign(new Error("command output exceeded maxBuffer"), {
                code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
              })
            : spawnError,
      });
    };
    child.stdout?.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) stdout += chunk.toString();
      if (stdoutBytes > maxBuffer && !child.killed) {
        bufferExceeded = true;
        terminateProcessTree(child, "SIGTERM");
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) stderr += chunk.toString();
      if (stderrBytes > maxBuffer && !child.killed) {
        bufferExceeded = true;
        terminateProcessTree(child, "SIGTERM");
      }
    });
    child.once("error", (error) => {
      spawnError = error;
      activeChildProcesses.delete(subprocessId);
      updateSubprocessRecord(subprocessId, (current) => ({
        ...(current ?? baseRecord),
        status: "spawn_error",
        completedAt: now(),
      }));
      finish(1);
    });
    child.once("close", (code, signal) => {
      activeChildProcesses.delete(subprocessId);
      updateSubprocessRecord(subprocessId, (current) => ({
        ...(current ?? baseRecord),
        heartbeatAt: now(),
        status: timedOut || bufferExceeded || signal != null ? "killed" : "exited",
        exitCode: code,
        signal,
        completedAt: now(),
      }));
      finish(code);
    });
  });
}

async function runCommand(item, name, command, args, options = {}) {
  const baseAttempts = options.attempts ?? 1;
  const attempts = options.allowTransientBudget
    ? Math.max(baseAttempts, maxTransientCommandAttempts)
    : baseAttempts;
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = now();
    if (batchStopRequested) {
      throw batchStopInterruptError(name);
    }
    event({
      itemId: item.itemId,
      event: "command_start",
      command: name,
      metadata: { attempt },
    });
    const heartbeatMonitor = startCommandHeartbeatMonitor(item, name, startedAt);
    let result;
    try {
      result = await spawnCommand(command, args, {
        cwd: root,
        maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
        shell: process.platform === "win32",
        timeoutMs: commandTimeoutSeconds * 1000,
        name,
        itemId: item.itemId,
        bookId: item.bookId,
        workerId: options.workerId,
        providerSlotLease: options.providerSlotLease,
        env: {
          ...process.env,
          INDEX_PATH: qmdIndexPath,
          QMD_CONFIG_DIR: dirname(configPath),
          QMD_GRAPH_VAULT: stateRoot,
          QMD_DOCTOR_DEVICE_PROBE: "0",
          QMD_GRAPHRAG_RUN_ID: runId,
          QMD_GRAPHRAG_ITEM_ID: item.itemId,
          QMD_GRAPHRAG_BOOK_ID: item.bookId,
          QMD_GRAPHRAG_COMMAND_NAME: name,
          QMD_GRAPHRAG_WORKER_ID: options.workerId ?? "",
          QMD_GRAPHRAG_RUNNER_SESSION_ID: runnerSessionId,
          QMD_GRAPHRAG_RUNNER_HOST: runnerHost,
          QMD_GRAPHRAG_RUNNER_PID: String(runnerPid),
          QMD_GRAPHRAG_SUBPROCESS_REGISTRY_DIR: subprocessRoot,
          QMD_GRAPHRAG_BOOK_LEASE_GENERATION:
            item.bookLeaseGeneration == null ? "" : String(item.bookLeaseGeneration),
          QMD_GRAPHRAG_BOOK_FENCING_TOKEN: item.bookFencingToken ?? "",
          QMD_GRAPHRAG_ITEM_FENCING_TOKEN: item.fencingToken ?? "",
          QMD_GRAPHRAG_PROVIDER_SLOT_ID: options.providerSlotLease?.slotId ?? "",
          QMD_GRAPHRAG_PROVIDER_SLOT_PROVIDER:
            options.providerSlotLease?.provider ?? "",
          QMD_GRAPHRAG_PROVIDER_SLOT_GENERATION:
            options.providerSlotLease?.generation == null
              ? ""
              : String(options.providerSlotLease.generation),
          QMD_GRAPHRAG_PROVIDER_SLOT_FENCING_TOKEN:
            options.providerSlotLease?.fencingToken ?? "",
          ...(options.env ?? {}),
        },
      });
      heartbeatMonitor?.assertHealthy?.();
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
    const envelopeText = [stdout, stderr].filter(Boolean).join("\n");
    const envelopeFailure = result.status === 0
      ? null
      : parseDurableFailureEnvelope(envelopeText, name, {
          ...item,
          workerId: options.workerId,
        });
    const legacyFailure = result.status === 0 || envelopeFailure != null
      ? null
      : classifyFailure(failureText);
    const missingEnvelopeFailure = result.status === 0 || envelopeFailure != null
      ? null
      : missingDurableSubprocessEnvelopeFailure(name, {
          ...item,
          workerId: options.workerId,
        }, legacyFailure);
    const failure = result.status === 0
      ? null
      : envelopeFailure ?? missingEnvelopeFailure ?? legacyFailure;
    const durableFailure = result.status === 0 || envelopeFailure != null
      ? {}
      : durableFailureForError(result.error, itemPath(item));
    const projectionFailureMetadata =
      settingsProjectionRejectionMetadataFromText(failureText, name);
    const localRetryMetadata = failure?.localRetryClass == null
      ? {}
      : {
          localRetryClass: failure.localRetryClass,
          localRetryBudget: "bounded_command_attempts",
        };
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
            ...durableFailure,
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
        ...durableProjection(check),
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
          ...durableProjection(check),
          ...localRetryMetadata,
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
        ...localRetryMetadata,
      },
    });
    if (options.allowTransientBudget) {
      throw Object.assign(new Error(check.errorSummary), { commandCheck: check });
    }
    await delay(delayMs);
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
        ...durableProjection(last.check),
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

async function qmd(item, name, args, attempts = 1, options = {}) {
  const runner = qmdRunner();
  const execute = (lease = {}) => runCommand(item, name, runner.command, [
    ...runner.args,
    ...args,
  ], {
    attempts,
    env: options.env,
    workerId: options.workerId,
    providerSlotLease: lease.providerSlotLease,
  });
  const provider = providerSemaphoreForCommand(name);
  const writerWrapped = (lease = {}) => qmdIndexLockedCommandNames.has(name)
    ? withSemaphore(qmdIndexWriterLane, {
      itemId: item.itemId,
      bookId: item.bookId,
      command: name,
      status: "running",
      workerId: options.workerId,
    }, () => withQmdIndexFileLock(
      () => execute(lease),
      {
        itemId: item.itemId,
        bookId: item.bookId,
        command: name,
        status: "running",
        workerId: options.workerId,
      },
    ))
    : execute(lease);
  if (provider == null) return writerWrapped();
  return withSemaphore(provider.semaphore, {
    itemId: item.itemId,
    bookId: item.bookId,
    command: name,
    provider: provider.provider,
    status: "running",
    workerId: options.workerId,
  }, writerWrapped);
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

async function normalizeEpubToMarkdown(item, options = {}) {
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
  await withSemaphore(localCpuSlots, {
    itemId: item.itemId,
    bookId: item.bookId,
    command: "normalize-epub",
    status: "running",
    workerId: options.workerId,
  }, (lease) => runCommand(item, "normalize-epub", pythonBin, [
      "-c",
      script,
      item.sourcePath,
      item.normalizedPath,
    ], {
      workerId: options.workerId,
      providerSlotLease: lease.providerSlotLease,
    }));
}

async function runGraphResume(item, checkpoint, options = {}) {
  requirePath(pythonBin, "GraphRAG Python");
  let lastResult = null;
  let nextStageHint = checkpoint?.graphBuildStatus?.stage ?? checkpoint?.failedStage;
  for (let pass = 1; pass <= maxResumePasses; pass += 1) {
    const name = options.repairLocalArtifactGateOnly
      ? `repair-local-artifact-gate-${pass}`
      : `resume-book-${pass}`;
    const commandItem = {
      ...item,
      leaseGeneration: checkpoint?.leaseGeneration,
      fencingToken: checkpoint?.fencingToken,
      bookLeaseGeneration: checkpoint?.bookLeaseGeneration,
      bookFencingToken: checkpoint?.bookFencingToken,
    };
    durablePreflight("before_resume_book", commandItem);
    const provider = nextStageHint == null
      ? providerSemaphoreForResumeStage(checkpoint)
      : providerSemaphoreForResumeNextStage(nextStageHint);
    const qmdIndexWriteStage = ["ingest", "normalize", "query_ready"]
      .includes(String(nextStageHint ?? checkpoint?.graphBuildStatus?.stage ?? ""));
    const runResumeCommand = (lease) => runCommand(commandItem, name, process.execPath, [
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
      workerId: options.workerId,
      providerSlotLease: lease.providerSlotLease,
    });
    const result = await withSemaphore(provider.semaphore, {
      itemId: commandItem.itemId,
      bookId: commandItem.bookId,
      command: name,
      provider: provider.provider,
      status: "running",
      workerId: options.workerId,
    }, (lease) => qmdIndexWriteStage
      ? withSemaphore(qmdIndexWriterLane, {
        itemId: commandItem.itemId,
        bookId: commandItem.bookId,
        command: name,
        status: "running",
        workerId: options.workerId,
      }, () => runResumeCommand(lease))
      : runResumeCommand(lease));
    lastResult = result;
    checkpoint = {
      ...checkpoint,
      bookLeaseGeneration: result?.check?.bookLeaseGeneration ??
        checkpoint?.bookLeaseGeneration,
      bookFencingToken: result?.check?.bookFencingToken ??
        checkpoint?.bookFencingToken,
      leaseGeneration: result?.check?.leaseGeneration ??
        checkpoint?.leaseGeneration,
      fencingToken: result?.check?.fencingToken ?? checkpoint?.fencingToken,
    };

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
        providerSlotProvider: provider.provider,
        ...settingsProjectionMetadata(resume),
      },
    });
    nextStageHint = resume.nextStage;
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

async function repairLocalArtifactGate(item, checkpoint, options = {}) {
  const repairResult = await runGraphResume(item, checkpoint, {
    repairLocalArtifactGateOnly: true,
    workerId: options.workerId,
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

async function runCliChecks(item, checkpoint, options = {}) {
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
  const recordQmd = async (name, args, attempts = 1) => {
    if (!requiredCommandCheckNames.includes(name)) return;
    if (seen.has(name)) return;
    record(await qmd(item, name, args, attempts, {
      workerId: options.workerId,
    }));
  };
  await recordQmd("qmd-version", ["--version"]);
  await recordQmd("qmd-status", ["status"]);
  await recordQmd("qmd-doctor-json", ["doctor", "--json"]);
  await recordQmd("qmd-pull", ["pull"]);
  await recordQmd("qmd-update", ["update"]);
  await recordQmd(
    "qmd-embed",
    ["embed", "--max-docs-per-batch", "1"],
    maxCommandAttempts,
  );
  await recordQmd("qmd-ls-books", ["ls", "books"]);
  await recordQmd("qmd-search-json", ["search", "--json", "software design complexity"]);
  await recordQmd("qmd-search-csv", ["search", "--csv", "software design complexity"]);
  await recordQmd("qmd-search-md", ["search", "--md", "software design complexity"]);
  await recordQmd("qmd-search-xml", ["search", "--xml", "software design complexity"]);
  await recordQmd("qmd-search-files", ["search", "--files", "software design complexity"]);
  await recordQmd(
    "qmd-vsearch-json",
    ["vsearch", "--json", "software design complexity"],
    maxCommandAttempts,
  );
  await recordQmd("qmd-query-json", ["query", "--json", query], maxCommandAttempts);
  await recordQmd(
    "qmd-get-book",
    ["get", `qmd://books/${basename(item.normalizedPath)}`, "-l", "5"],
  );
  await recordQmd("qmd-multi-get-json", ["multi-get", "books/*.md", "-l", "1", "--json"]);
  await recordQmd("qmd-collection-list", ["collection", "list"]);
  await recordQmd("qmd-collection-show-books", ["collection", "show", "books"]);
  await recordQmd("qmd-context-list", ["context", "list"]);
  await recordQmd("qmd-skills-list-json", ["skills", "list", "--json"]);
  await recordQmd("qmd-skills-get-json", ["skills", "get", "qmd", "--json"]);
  await recordQmd("qmd-skills-path-json", ["skills", "path", "qmd", "--json"]);
  await recordQmd("qmd-skill-show", ["skill", "show"]);
  await recordQmd("qmd-dspy-status-json", ["dspy", "status", "--json"]);
  await recordQmd("qmd-cleanup", ["cleanup"]);
  writeQmdBuildManifest(item, checks);
  activeCheckpoint = saveCheckpoint(item, {
    ...activeCheckpoint,
    commandChecks: checks,
  });
  await recordQmd(
    "qmd-query-auto-json",
    ["query", "--mode", "auto", "--json", query],
    maxCommandAttempts,
  );
  await recordQmd(
    "qmd-query-graphrag-json",
    ["query", "--graphrag", "--graph-book-id", item.bookId, "--json", query],
    maxCommandAttempts,
  );
  validateCommandChecks(checks);
  return checks;
}

async function runItem(item, checkpoint, options = {}) {
  await normalizeEpubToMarkdown(item, { workerId: options.workerId });
  const resumeResult = await runGraphResume(item, checkpoint, {
    workerId: options.workerId,
  });
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
  const commandChecks = await runCliChecks(resolvedItem, checkpoint, {
    workerId: options.workerId,
  });
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
  const terminalFinalization = buildTerminalFinalizationFence(checkpoint);
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
      terminalFinalization,
    },
  };
  saveCheckpoint(resolvedItem, completed, {
    requireBookLease: true,
    expectedStatus: "completed",
  });
  event({
    itemId: item.itemId,
    event: "item_completed",
    status: "completed",
    metadata: { terminalFinalization },
  });
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

function buildInterruptedCheckpoint({ running, error }) {
  const commandCheck = error?.commandCheck;
  return {
    ...running,
    status: "pending",
    failedAt: undefined,
    errorSummary: redacted(error instanceof Error ? error.message : String(error)),
    failureKind: undefined,
    retryable: undefined,
    retryExhausted: undefined,
    recoveryDecision: "continue_pending",
    failedStage: commandCheck?.name ?? running.currentCommand ?? running.failedStage,
    nextRetryAt: undefined,
    retryDelaySeconds: undefined,
    runnerHeartbeatAt: now(),
    activeCommand: commandCheck?.name ?? running.currentCommand ?? running.activeCommand,
    commandChecks: commandCheck
      ? [...(running.commandChecks ?? []), commandCheck]
      : (running.commandChecks ?? []),
    metadata: {
      ...(running.metadata ?? {}),
      waitingForProviderRecovery: false,
      interruptedByBatchStop: true,
      batchStopReason: batchStopReason ?? "unknown",
    },
  };
}

function markItemRunning(item, checkpoint, checkpoints, manifest, workerId) {
  durablePreflight("before_claim", item);
  const startedAt = now();
  const bookLease = acquireBookLease(item, workerId);
  const itemFencingToken = randomToken("item-fence");
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
        leaseGeneration: coordinatorLease?.generation ?? 1,
        fencingToken: itemFencingToken,
        leaseExpiresAt: leaseExpiresAt(),
        bookLeaseGeneration: bookLease?.generation ?? 1,
        bookFencingToken: bookLease?.fencingToken ?? randomToken("book-fence"),
        metadata: {
          ...(current.metadata ?? {}),
          waitingForProviderRecovery: false,
          workerId,
          coordinatorGeneration: coordinatorLease?.generation ?? 1,
          itemFencingToken,
          bookLeaseGeneration: bookLease?.generation,
          bookFencingToken: bookLease?.fencingToken,
        },
      });
    },
  );
  checkpoints.set(item.itemId, running);
  updateManifest(manifest, Array.from(checkpoints.values()));
  event({ itemId: item.itemId, event: "item_start", status: "running" });
  return { running, bookLease };
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
      status: "failed",
      failedAt: now(),
      nextRetryAt: undefined,
      retryDelaySeconds: undefined,
      retryable: false,
      retryExhausted: true,
      recoveryDecision: "stop_until_fixed",
      retryBudgetSeconds: checkpoint.retryBudgetSeconds ?? retryBudgetSeconds,
      metadata: {
        ...(checkpoint.metadata ?? {}),
        waitingForProviderRecovery: false,
        providerRecoveryReason: "provider_recovery_wait_limit_reached",
        providerRecoveryWaitCount: providerRecoveryWaitCount(checkpoint),
        maxProviderRecoveryWaits,
        retryBudgetSeconds,
        providerRecoveryWaitLimitReached: true,
        providerRecoveryExcludedFromRun: true,
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
    recoveryDecision: "stop_until_fixed",
    metadata: {
      limitedItemCount: limited.length,
      maxProviderRecoveryWaits,
      nextRetryAt,
      retryPolicy: "retry_exhausted_excluded_until_operator_review",
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
    ...durableProjection(checkpoint),
    failedStage: checkpoint.failedStage,
    message: checkpoint.errorSummary,
    metadata: {
      policy: "stop_current_runner_until_fixed",
      stopReason,
      ...durableProjection(checkpoint),
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

function updateManifestState(manifestState, checkpoints) {
  manifestState.manifest = updateManifest(
    manifestState.manifest,
    Array.from(checkpoints.values()),
  );
  return manifestState.manifest;
}

function persistBatchStopManifest(manifest, checkpoints, reason) {
  const stopped = BatchRunManifestSchema.parse(withoutUndefined({
    ...manifest,
    status: "failed",
    failedAt: now(),
    completedAt: undefined,
    updatedAt: now(),
    metadata: {
      ...(manifest.metadata ?? {}),
      batchStopRequested: true,
      batchStopReason: reason,
    },
  }));
  writeTypedJson(manifestPath, BatchRunManifestSchema, stopped);
  writeRecoverySummary(stopped, checkpoints);
  return stopped;
}

async function handleRunItemFailure({
  error,
  item,
  activeItem,
  checkpoint,
  checkpoints,
  completedSeed,
  manifestState,
  stopLoggedThisRun,
}) {
  const running = existsSync(itemPath(item))
    ? loadCheckpoint(activeItem, completedSeed)
    : checkpoint ?? defaultCheckpoint(item, completedSeed);
  let activeRuntimeItem = runtimeItemForCheckpoint(item, running);
  const commandCheck = error?.commandCheck;
  const durableFailure = durableFailureForError(error, itemPath(item));
  const commandDurableProjection = durableProjection(commandCheck);
  const errorDurableProjection = durableProjection(durableFailure);
  const durableFields = {
    ...errorDurableProjection,
    ...commandDurableProjection,
  };
  if (isBatchStopInterrupt(error)) {
    const interrupted = buildInterruptedCheckpoint({ running, error });
    saveCheckpoint(activeRuntimeItem, interrupted);
    checkpoints.set(item.itemId, interrupted);
    updateManifestState(manifestState, checkpoints);
    event({
      itemId: item.itemId,
      event: "item_interrupted_by_batch_stop",
      status: "pending",
      recoveryDecision: "continue_pending",
      failedStage: interrupted.failedStage,
      message: interrupted.errorSummary,
      metadata: {
        batchStopReason: batchStopReason ?? "unknown",
        activeCommand: interrupted.activeCommand,
      },
    });
    return { processed: true, stopAfterNonTransientFailure: false };
  }
  const failureKind =
    commandCheck?.failureKind ??
    durableFields.failureKind ??
    "unknown";
  const retryable = commandCheck?.retryable ?? false;
  const canRecoverInThisRun =
    retryable && failureKind === "transient" && transientBudgetAvailable(running);
  if (canRecoverInThisRun) {
    const recoverable = buildRecoverableTransientCheckpoint({
      item: activeRuntimeItem,
      running,
      commandCheck,
      error,
    });
    saveCheckpoint(activeRuntimeItem, recoverable);
    checkpoints.set(item.itemId, recoverable);
    updateManifestState(manifestState, checkpoints);
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
    if (failFast) {
      manifestState.manifest = persistFailFastInterruptedManifest(
        manifestState.manifest,
        Array.from(checkpoints.values()),
        "recoverable_transient_failure",
      );
      markBatchFailureHandled(error);
      throw error;
    }
    return { processed: true, stopAfterNonTransientFailure: false };
  }

  const recoverableProviderFailure =
    retryable &&
    failureKind === "transient";
  const providerRecoveryWaitStillAvailable =
    recoverableProviderFailure && providerRecoveryWaitAvailable(running);
  if (recoverableProviderFailure && !providerRecoveryWaitStillAvailable) {
    const waitCount = providerRecoveryWaitCount(running);
    const limited = {
      ...running,
      status: "failed",
      failedAt: now(),
      errorSummary: redacted(error instanceof Error
        ? error.message
        : String(error)),
      failureKind: "transient",
      retryable: false,
      retryExhausted: true,
      recoveryDecision: "stop_until_fixed",
      ...durableFields,
      failedStage: commandCheck?.name,
      retryStartedAt: running.retryStartedAt ?? commandCheck?.completedAt ?? now(),
      nextRetryAt: undefined,
      retryDelaySeconds: undefined,
      retryBudgetSeconds,
      runnerHeartbeatAt: now(),
      metadata: {
        ...(running.metadata ?? {}),
        waitingForProviderRecovery: false,
        providerRecoveryWaitStartedAt:
          running.metadata?.providerRecoveryWaitStartedAt ?? now(),
        providerRecoveryReason: "provider_recovery_wait_limit_reached",
        providerRecoveryWaitCount: waitCount,
          maxProviderRecoveryWaits,
          retryBudgetSeconds,
          sourceName: activeRuntimeItem.sourceName,
          providerRecoveryWaitLimitReached: true,
          providerRecoveryExcludedFromRun: true,
          ...durableFields,
        },
      };
    if (commandCheck) {
      limited.commandChecks = [
        ...(limited.commandChecks ?? []),
        commandCheck.status === "failed"
          ? {
              ...commandCheck,
              retryable: false,
              recoveryDecision: "stop_until_fixed",
              attemptExhausted: true,
            }
          : commandCheck,
      ];
    }
    saveCheckpoint(activeRuntimeItem, limited);
    checkpoints.set(item.itemId, limited);
    updateManifestState(manifestState, checkpoints);
    event({
      itemId: item.itemId,
      event: "item_provider_recovery_wait_limit_reached",
      status: "failed",
      message: limited.errorSummary,
      failureKind: "transient",
      retryable: false,
      attemptExhausted: true,
      providerStatusCode: commandCheck?.providerStatusCode,
      retryAfterSeconds: commandCheck?.retryAfterSeconds,
      recoveryDecision: "stop_until_fixed",
      failedStage: limited.failedStage,
      ...durableFields,
      metadata: {
        retryBudgetSeconds,
        providerRecoveryWaitCount: waitCount,
        maxProviderRecoveryWaits,
        retryPolicy: "retry_exhausted_excluded_until_operator_review",
        ...durableFields,
      },
    });
    return { processed: true, stopAfterNonTransientFailure: true };
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
        status: "failed",
        failedAt: now(),
        errorSummary: redacted(
          error instanceof Error ? error.message : String(error),
        ),
        failureKind: "transient",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        ...durableFields,
        failedStage: commandCheck?.name ?? durableFields.failedStage,
        retryStartedAt:
          running.retryStartedAt ?? commandCheck?.completedAt ?? now(),
        nextRetryAt: undefined,
        retryDelaySeconds: undefined,
        runnerHeartbeatAt: now(),
        activeCommand: commandCheck?.name ?? running.activeCommand ??
          running.currentCommand ?? running.failedStage,
        metadata: {
          ...(running.metadata ?? {}),
          waitingForProviderRecovery: false,
          providerRecoveryWaitStartedAt: now(),
          providerRecoveryReason: providerRecoveryWaitStillAvailable
            ? "transient_retry_budget_window_elapsed"
            : "provider_recovery_wait_limit_reached",
          providerRecoveryWaitCount: recoveryWaitCount,
          maxProviderRecoveryWaits,
          retryBudgetSeconds,
          providerRecoveryExcludedFromRun: true,
          sourceName: activeRuntimeItem.sourceName,
          ...durableFields,
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
        ...durableFields,
        failedStage: commandCheck?.name ?? durableFields.failedStage,
        nextRetryAt: undefined,
        retryDelaySeconds: undefined,
        runnerHeartbeatAt: now(),
        activeCommand: commandCheck?.name ?? running.activeCommand ??
          running.currentCommand ?? running.failedStage,
        metadata: {
          ...(running.metadata ?? {}),
          ...projectionRejectionMetadata,
          ...authFailureMetadata,
          ...durableFields,
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
  saveCheckpoint(activeRuntimeItem, failed);
  checkpoints.set(item.itemId, failed);
  updateManifestState(manifestState, checkpoints);
  event({
    itemId: item.itemId,
    event: recoverableProviderFailure ? "item_provider_recovery_wait" : "item_failed",
    status: failed.status,
    message: failed.errorSummary,
    failureKind: failed.failureKind,
    retryable: failed.retryable,
    attemptExhausted: failed.retryExhausted,
    providerStatusCode: commandCheck?.providerStatusCode,
    retryAfterSeconds: commandCheck?.retryAfterSeconds,
    recoveryDecision: failed.recoveryDecision,
    ...durableProjection(failed),
    failedStage: failed.failedStage,
    metadata: recoverableProviderFailure
      ? {
          retryBudgetSeconds,
          elapsedRetrySeconds: elapsedRetrySeconds(failed),
          providerRecoveryWaitCount: recoveryWaitCount,
          maxProviderRecoveryWaits,
          waitLimitReached: !providerRecoveryWaitStillAvailable,
          retryPolicy: "retry_exhausted_excluded_until_operator_review",
          ...durableProjection(failed),
        }
      : {
          activeCommand: failed.activeCommand,
          command: commandCheck?.name,
          ...projectionRejectionMetadata,
          ...authFailureMetadata,
          ...durableProjection(failed),
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
    manifestState.manifest = persistFailFastInterruptedManifest(
      manifestState.manifest,
      Array.from(checkpoints.values()),
      recoverableProviderFailure
        ? "provider_recovery_wait"
        : "command_failure",
    );
    markBatchFailureHandled(error);
    throw error;
  }
  if (shouldStopBatchAfterFailure(failed)) {
    if (!stopLoggedThisRun.has(failed.itemId)) {
      emitBatchStoppedAfterNonTransientFailure(failed);
      stopLoggedThisRun.add(failed.itemId);
    }
    return { processed: true, stopAfterNonTransientFailure: true };
  }
  return { processed: true, stopAfterNonTransientFailure: false };
}

function markBatchFailureHandled(error) {
  if (error && typeof error === "object") {
    error.batchFailureHandled = true;
  }
}

function batchFailureWasHandled(error) {
  return error != null &&
    typeof error === "object" &&
    error.batchFailureHandled === true;
}

async function runClaimedBatchItem({
  item,
  activeItem,
  running,
  bookLease,
  checkpoints,
  completedSeed,
  manifestState,
  stopLoggedThisRun,
  workerId,
}) {
  event({
    itemId: item.itemId,
    event: "item_worker_start",
    status: "running",
    metadata: { workerId, bookConcurrency },
  });
  let activeBookLease = refreshBookLease(bookLease);
  try {
    const completed = await runItem(activeItem, running, { workerId });
    checkpoints.set(item.itemId, completed);
    updateManifestState(manifestState, checkpoints);
    event({
      itemId: item.itemId,
      event: "item_worker_completed",
      status: "completed",
      metadata: {
        workerId,
        bookConcurrency,
        terminalFinalization: completed.metadata?.terminalFinalization,
      },
    });
    releaseBookLease(activeBookLease, "completed");
    return { processed: true, stopAfterNonTransientFailure: false };
  } catch (error) {
    const result = await handleRunItemFailure({
      error,
      item,
      activeItem,
      checkpoint: running,
      checkpoints,
      completedSeed,
      manifestState,
      stopLoggedThisRun,
    });
    markBatchFailureHandled(error);
    event({
      itemId: item.itemId,
      event: "item_worker_stopped",
      status: checkpoints.get(item.itemId)?.status,
      recoveryDecision: checkpoints.get(item.itemId)?.recoveryDecision,
      metadata: {
        workerId,
        bookConcurrency,
        stopAfterNonTransientFailure: result.stopAfterNonTransientFailure,
      },
    });
    releaseBookLease(activeBookLease, checkpoints.get(item.itemId)?.status ?? "failed");
    return result;
  }
}

async function runWorkerPool({
  candidates,
  checkpoints,
  completedSeed,
  manifestState,
  stopLoggedThisRun,
  nextWorkerId,
}) {
  let candidateIndex = 0;
  let activeCount = 0;
  const results = [];
  let rejectedError;
  let stopAfterNonTransientFailure = false;
  let processed = false;

  return await new Promise((resolvePool, rejectPool) => {
    const settleIfDone = () => {
      if (activeCount !== 0) return;
      if (
        (candidateIndex >= candidates.length || stopAfterNonTransientFailure) &&
        rejectedError == null
      ) {
        resolvePool({ processed, stopAfterNonTransientFailure, results });
      } else if (rejectedError != null) {
        rejectPool(rejectedError);
      }
    };

    const launchMore = () => {
      while (
        activeCount < bookConcurrency &&
        candidateIndex < candidates.length &&
        !stopAfterNonTransientFailure &&
        rejectedError == null
      ) {
        const candidate = candidates[candidateIndex];
        candidateIndex += 1;
        let running;
        let workerId;
        try {
          const current = checkpoints.get(candidate.item.itemId) ??
            defaultCheckpoint(candidate.item, completedSeed);
          if (current.status !== "pending") continue;
          const activeItem = runtimeItemForCheckpoint(candidate.item, current);
          if (activeRunningBookCheckpoint(activeItem, checkpoints) != null) {
            event({
              itemId: candidate.item.itemId,
              event: "item_book_running_observed",
              status: "pending",
              recoveryDecision: "continue_pending",
              metadata: {
                bookId: activeItem.bookId,
                workerPoolDeferred: true,
              },
            });
            continue;
          }
          workerId = nextWorkerId();
          const claim = markItemRunning(
            activeItem,
            current,
            checkpoints,
            manifestState.manifest,
            workerId,
          );
          running = claim.running;
          event({
            itemId: candidate.item.itemId,
            event: "item_worker_queued",
            status: "running",
            metadata: {
              workerId,
              bookConcurrency,
              candidateIndex,
              remainingCandidates: candidates.length - candidateIndex,
            },
          });
          activeCount += 1;
          runClaimedBatchItem({
            item: candidate.item,
            activeItem,
            running,
            bookLease: claim.bookLease,
            checkpoints,
            completedSeed,
            manifestState,
            stopLoggedThisRun,
            workerId,
          }).then((result) => {
            results.push(result);
            processed = processed || result.processed;
            stopAfterNonTransientFailure = stopAfterNonTransientFailure ||
              result.stopAfterNonTransientFailure;
            if (result.stopAfterNonTransientFailure) {
              requestBatchStop("worker_stop_until_fixed");
              terminateActiveSubprocesses("worker_stop_until_fixed");
            }
          }, (error) => {
            rejectedError = error;
            requestBatchStop("worker_pool_error");
            terminateActiveSubprocesses("worker_pool_error");
          }).finally(() => {
            activeCount -= 1;
            if (rejectedError != null) {
              settleIfDone();
              return;
            }
            launchMore();
            settleIfDone();
          });
        } catch (error) {
          rejectedError = error;
          break;
        }
      }
      settleIfDone();
    };

    try {
      launchMore();
    } catch (error) {
      rejectPool(error);
    }
  });
}

async function waitForNextRetryWindow(items, checkpoints) {
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
  await delay(delayMs);
  return true;
}

async function main() {
  loadDotenv();
  ensureDirs();
  requirePath(sourceDir, "source directory");
  requirePath(configPath, "qmd config");
  const items = discoverItemsWithDurableFailureEvent();
  if (items.length === 0) {
    throw new Error(`no EPUB files found in ${sourceDir}`);
  }
  eventSequence = readExistingEventSequence();
  let manifest;
  if (!statusJson) {
    acquireCoordinatorLock();
    manifest = loadManifest(items);
    manifest = writeStartupRecoveryManifest(manifest, {
      scopeCount: durablePreflightTargetsForItems(items).length,
      targetCount: 0,
      mutationCount: 0,
      decision: "created_before_preflight",
    });
    if (!testSkipRunnerStartPreflight) {
      const providerRequestDiagnostics = [];
      durablePreflight("runner_start", undefined, {
        targets: durablePreflightTargetsForItems(items),
        providerRequestDiagnostics,
      });
      manifest = updateManifestWithProviderRequestDiagnostics(
        manifest,
        providerRequestDiagnostics,
      );
    }
    reconcileDurableRunFiles();
    startCoordinatorHeartbeat();
    recoverEventLogTail();
    event({
      event: "coordinator_lock_acquired",
      status: "running",
      metadata: {
        runnerSessionId,
        runnerHost,
        runnerPid,
        generation: coordinatorLease?.generation,
        fencingToken: coordinatorLease?.fencingToken,
        expiresAt: coordinatorLease?.expiresAt,
      },
    });
  } else {
    manifest = loadManifest(items);
    const providerRequestDiagnostics = [];
    for (const target of durablePreflightTargetsForItems(items)) {
      if (!target.providerRequestReadOnly) continue;
      durablePreflightScanDirectory(target.directory, {
        providerRequestReadOnly: true,
        providerRequestDiagnostics,
      });
    }
    for (const diagnostic of providerRequestDiagnostics) {
      recordStatusJsonDurableDiagnostic(diagnostic);
    }
  }
  const completedSeed = loadCompletedSeed();
  const checkpoints = new Map(items.map((item) => [
    item.itemId,
    loadCheckpoint(item, completedSeed),
  ]));
  if (!statusJson) migrateGraphOutputProducerManifests();
  manifest = updateManifest(manifest, Array.from(checkpoints.values()));
  if (!statusJson && batchStopRequested) {
    manifest = persistBatchStopManifest(
      manifest,
      Array.from(checkpoints.values()),
      batchStopReason ?? "batch_stop_requested",
    );
    event({
      event: "batch_incomplete",
      recoveryDecision: "stop_until_fixed",
      metadata: {
        pendingItems: manifest.pendingItems,
        runningItems: manifest.runningItems,
        completedItems: manifest.completedItems,
        skippedItems: manifest.skippedItems,
        failedItems: manifest.failedItems,
        batchStopReason: batchStopReason ?? "batch_stop_requested",
      },
    });
    process.exitCode = 1;
    return;
  }
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

  const manifestState = { manifest };
  let workerSequence = 1;
  event({
    event: "batch_runner_configured",
    metadata: {
      runnerSessionId,
      runnerHost,
      runnerPid,
      bookConcurrency,
      openaiProviderConcurrency,
      jinaProviderConcurrency,
      localCpuConcurrency,
    },
  });

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
      manifestState.manifest = manifest;
      writeRecoverySummary(manifest, Array.from(checkpoints.values()));
      processedInPass = true;
    }
    const recoveredProviderTransientCount =
      recoverProviderTransientCheckpoints(items, checkpoints);
    if (recoveredProviderTransientCount > 0) {
      manifest = updateManifest(manifest, Array.from(checkpoints.values()));
      manifestState.manifest = manifest;
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
    const runnableCandidates = [];
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
            const repaired = await repairLocalArtifactGate(activeItem, checkpoint);
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
            const durableFields = {
              ...durableProjection(durableFailureForError(
                error,
                itemPath(activeItem ?? item),
              )),
              ...durableProjection(error?.commandCheck),
            };
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
              ...durableFields,
              failedStage: "repair-local-artifact-gate",
              activeCommand,
              runnerHeartbeatAt: now(),
              metadata: {
                ...(checkpoint.metadata ?? {}),
                ...projectionRejectionMetadata,
                localArtifactGateRepairFailed: true,
                ...durableFields,
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
              ...durableProjection(failed),
              failedStage: "repair-local-artifact-gate",
              message: failed.errorSummary,
              metadata: {
                activeCommand,
                command: commandCheck?.name,
                ...projectionRejectionMetadata,
                ...durableProjection(failed),
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
        if (bookConcurrency > 1) {
          runnableCandidates.push({ item });
          event({
            itemId: item.itemId,
            event: "item_worker_candidate",
            status: "pending",
            metadata: {
              bookConcurrency,
              candidateCount: runnableCandidates.length,
            },
          });
          continue;
        }
        const workerId = `worker-${workerSequence}`;
        workerSequence += 1;
        const claim = markItemRunning(
          activeItem,
          starting,
          checkpoints,
          manifest,
          workerId,
        );
        const running = claim.running;
        manifestState.manifest = manifest;
        const result = await runClaimedBatchItem({
          item,
          activeItem,
          running,
          bookLease: claim.bookLease,
          checkpoints,
          completedSeed,
          manifestState,
          stopLoggedThisRun,
          workerId,
        });
        manifest = manifestState.manifest;
        processedInPass = result.processed || processedInPass;
        if (result.stopAfterNonTransientFailure) {
          stopAfterNonTransientFailure = true;
          requestBatchStop("single_worker_stop_until_fixed");
          terminateActiveSubprocesses("single_worker_stop_until_fixed");
          break;
        }
      } catch (error) {
        if (batchFailureWasHandled(error)) throw error;
        const result = await handleRunItemFailure({
          error,
          item,
          activeItem,
          checkpoint,
          checkpoints,
          completedSeed,
          manifestState,
          stopLoggedThisRun,
        });
        manifest = manifestState.manifest;
        processedInPass = result.processed || processedInPass;
        if (result.stopAfterNonTransientFailure) {
          stopAfterNonTransientFailure = true;
          requestBatchStop("single_worker_failure_stop_until_fixed");
          terminateActiveSubprocesses("single_worker_failure_stop_until_fixed");
          break;
        }
      }
    }
    if (runnableCandidates.length > 0) {
      event({
        event: "batch_worker_pool_start",
        status: "running",
        metadata: {
          bookConcurrency,
          candidateCount: runnableCandidates.length,
          itemIds: runnableCandidates.map((candidate) => candidate.item.itemId),
        },
      });
      const poolResult = await runWorkerPool({
        candidates: runnableCandidates,
        checkpoints,
        completedSeed,
        manifestState,
        stopLoggedThisRun,
        nextWorkerId: () => {
          const workerId = `worker-${workerSequence}`;
          workerSequence += 1;
          return workerId;
        },
      });
      manifest = manifestState.manifest;
      processedInPass = processedInPass || poolResult.processed;
      stopAfterNonTransientFailure = stopAfterNonTransientFailure ||
        poolResult.stopAfterNonTransientFailure;
      if (poolResult.stopAfterNonTransientFailure) {
        requestBatchStop("worker_pool_stop_until_fixed");
        terminateActiveSubprocesses("worker_pool_stop_until_fixed");
      }
      event({
        event: "batch_worker_pool_settled",
        status: stopAfterNonTransientFailure ? "failed" : "running",
        recoveryDecision: stopAfterNonTransientFailure
          ? "stop_until_fixed"
          : "continue_pending",
        metadata: {
          bookConcurrency,
          candidateCount: runnableCandidates.length,
          processedWorkerCount: poolResult.results.length,
          stopAfterNonTransientFailure,
        },
      });
    }
    if (stopAfterNonTransientFailure) break;
    if (!processedInPass && deferredForRetryWindow) {
      if (providerRecoveryWaitLimitReached(items, checkpoints)) {
        eventProviderRecoveryWaitLimit(items, checkpoints);
        break;
      }
      processedInPass = await waitForNextRetryWindow(items, checkpoints);
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
  installTerminationSignalHandlers();
  await main();
} catch (error) {
  console.error(redactLog(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 1;
} finally {
  releaseCoordinatorLock();
}
