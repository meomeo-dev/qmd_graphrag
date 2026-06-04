import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import YAML from "yaml";

import type {
  BookArtifactKind,
  BookArtifactManifest,
  BookJob,
  BookResumePlan,
  BookStage,
} from "../contracts/book-job.js";
import { BookStageOrder } from "../contracts/book-job.js";
import type { CollectionConfig } from "../collections.js";
import type { JsonValue } from "../contracts/common.js";
import {
  buildBookIdFromSourceHash,
  createDeterministicHash,
  createRunId,
  hashFile,
  hashText,
  normalizeBookSlug,
} from "./fingerprint.js";
import {
  chunkDocument,
  createStore,
  extractTitle,
  hashContent,
  insertContent,
  insertDocument,
  upsertStoreCollection,
} from "../store.js";
import {
  GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  GRAPH_EXTRACT_ARTIFACT_KINDS,
  QUERY_READY_ARTIFACT_KINDS,
  hashDirectoryContents,
  hashLanceDbDirectoryContents,
  isCompleteLanceDbDirectory,
  selectValidBookArtifactsByKind,
  validateBookArtifactSet,
} from "./artifact-validation.js";
import {
  FileBookJobStateRepository,
  type StageArtifactRequirementMap,
  type StageFingerprintMap,
} from "./repository.js";
import {
  DurableStateError,
  readJsonFileDurable,
  writeJsonFileDurable,
} from "./durable-json.js";
import { refreshGraphRagOutputJsonSidecars } from "./graphrag-output-durable.js";
import {
  ensureManagedGraphRagSettings,
  type ManagedGraphRagSettingsRepairResult,
} from "../graphrag/settings-projection.js";

const GRAPHRAG_NORMALIZATION_POLICY_VERSION = "graphrag-normalized-markdown-v1";
const QMD_INDEX_LOCK_STALE_MS = 120000;
const QMD_INDEX_LOCK_WAIT_MS = Math.max(QMD_INDEX_LOCK_STALE_MS * 2, 300000);
const QMD_SQLITE_BUSY_RETRY_LIMIT = 8;
const QMD_SQLITE_BUSY_RETRY_BASE_MS = 25;
const QMD_SQLITE_BUSY_RETRY_MAX_MS = 500;
const QMD_INDEX_RELEASE_ON = ["commit", "error", "cancellation", "lease_loss", "timeout"];

const GRAPH_RAG_STAGE_ARTIFACT_REQUIREMENTS: StageArtifactRequirementMap = {
  ingest: ["source_epub"],
  normalize: ["normalized_markdown"],
  graph_extract: GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  community_report: ["graphrag_community_reports_parquet"],
  embed: ["lancedb_index"],
  query_ready: QUERY_READY_ARTIFACT_KINDS,
};

const QUERY_READY_PRODUCER_STAGES = [
  "graph_extract",
  "community_report",
  "embed",
] as const satisfies readonly BookStage[];

const QUERY_READY_PRODUCER_REQUIRED_KINDS = {
  graph_extract: GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  community_report: ["graphrag_community_reports_parquet"],
  embed: ["lancedb_index"],
} as const satisfies Record<
  (typeof QUERY_READY_PRODUCER_STAGES)[number],
  readonly BookArtifactKind[]
>;

export type GraphRagBookWorkspacePaths = {
  stateRootDir: string;
  sourcePath: string;
  sourceIdentityPath?: string;
  normalizedPath: string;
  settingsPath: string;
  promptsDir: string;
  outputDir: string;
  qmdIndexPath?: string;
  projectConfig?: CollectionConfig;
};

export type SyncGraphRagBookWorkspaceInput = GraphRagBookWorkspacePaths & {
  metadata?: Record<string, JsonValue>;
  recordRecoveredStages?: boolean;
};

export type GraphRagBookWorkspaceState = {
  job: BookJob;
  artifacts: BookArtifactManifest[];
  stageFingerprints: Record<BookStage, string>;
  resumePlan: BookResumePlan;
  bootstrapRunId: string;
  settingsProjectionRepair?: ManagedGraphRagSettingsRepairResult;
};

export type GraphRagStageReportHealth = {
  healthy: boolean;
  stage: BookStage;
  logPath: string;
  logStartOffset: number;
  logEndOffset: number;
  reason?: string;
  failureKind?: "transient" | "partial_output";
  evidence?: string[];
};

export type GraphRagTextUnitIdentity = {
  schemaVersion: "1.0.0";
  bookId: string;
  sourceId: string;
  sourceHash: string;
  documentId: string;
  contentHash: string;
  normalizedPath: string;
  graphDocumentId: string;
  graphTextUnitIds: string[];
};

type GraphRagTextUnitIdentityInput = Omit<
  GraphRagTextUnitIdentity,
  "schemaVersion" | "graphDocumentId" | "graphTextUnitIds"
> & {
  outputDir: string;
};

export function graphRagBookInputDir(input: {
  stateRootDir: string;
  bookId: string;
}): string {
  return join(resolve(input.stateRootDir), "books", input.bookId, "input");
}

export function graphRagBookOutputDir(input: {
  stateRootDir: string;
  bookId: string;
}): string {
  return join(
    resolve(input.stateRootDir),
    "books",
    input.bookId,
    "graphrag",
    "output",
  );
}

function graphRagBookOutputLocator(bookId: string): string {
  return `books/${bookId}/graphrag/output`;
}

type GraphRagOutputProducerManifest = {
  schemaVersion: "1.0.0";
  bookId: string;
  sourceHash: string;
  documentId: string;
  contentHash: string;
  stageFingerprints: Record<BookStage, string>;
  providerFingerprint: string;
  outputDir: string;
  producerRunId: string;
  stageProducerRunIds: Partial<Record<BookStage, string>>;
  bookLeaseGeneration?: number;
  bookFencingToken?: string;
};

function stripKnownBookExtension(path: string): string {
  return basename(path).replace(/\.(epub|md|markdown|txt)$/iu, "");
}

function graphRagIndexLogPath(outputDir: string): string {
  return join(resolve(outputDir), "reports", "indexing-engine.log");
}

function graphRagReportLogPath(input: {
  outputDir: string;
  reportDir?: string;
}): string {
  return input.reportDir == null
    ? graphRagIndexLogPath(input.outputDir)
    : join(resolve(input.reportDir), "indexing-engine.log");
}

const GRAPH_RAG_STAGE_TRANSIENT_LOG_PATTERN =
  /concurrency limit exceeded|rate limit|temporarily unavailable|timeout|timed out|service unavailable|gateway timeout|bad gateway|connection reset|socket hang up|econnreset|etimedout|eai_again|HTTP\s+(429|5\d\d)|status\s+code[:\s-]*(429|5\d\d)|openai\.APIError/iu;
const GRAPH_RAG_COMMUNITY_PARTIAL_LOG_PATTERN =
  /Community Report Extraction Error|error generating community report|No report found for community/iu;
const GRAPH_RAG_ACTIONABLE_LOG_LEVEL_PATTERN =
  /(?:\s-\s|\b)(?:WARNING|ERROR|CRITICAL|EXCEPTION)(?:\s-\s|\b)/iu;
const GRAPH_RAG_NON_ACTIONABLE_LOG_LEVEL_PATTERN =
  /(?:\s-\s|\b)(?:DEBUG|INFO)(?:\s-\s|\b)/iu;

function isActionableGraphRagLogLine(line: string): boolean {
  return GRAPH_RAG_ACTIONABLE_LOG_LEVEL_PATTERN.test(line) &&
    !GRAPH_RAG_NON_ACTIONABLE_LOG_LEVEL_PATTERN.test(line);
}

function stageHealthEvidence(text: string, stage: BookStage): GraphRagStageReportHealth {
  const evidence = text
    .split(/\r?\n/u)
    .filter((line) =>
      isActionableGraphRagLogLine(line) &&
      (
        GRAPH_RAG_STAGE_TRANSIENT_LOG_PATTERN.test(line) ||
      (stage === "community_report" &&
          GRAPH_RAG_COMMUNITY_PARTIAL_LOG_PATTERN.test(line))
      )
    )
    .slice(0, 20);

  if (evidence.length === 0) {
    return {
      healthy: true,
      stage,
      logPath: "",
      logStartOffset: 0,
      logEndOffset: 0,
    };
  }

  const transient = evidence.some((line) =>
    GRAPH_RAG_STAGE_TRANSIENT_LOG_PATTERN.test(line)
  );
  return {
    healthy: false,
    stage,
    logPath: "",
    logStartOffset: 0,
    logEndOffset: 0,
    failureKind: transient ? "transient" : "partial_output",
    reason: transient
      ? "provider transient error found in GraphRAG stage report"
      : "partial community report output found in GraphRAG stage report",
    evidence,
  };
}

export async function graphRagIndexLogOffset(
  outputDir: string,
  reportDir?: string,
): Promise<number> {
  try {
    return (await stat(graphRagReportLogPath({ outputDir, reportDir }))).size;
  } catch {
    return 0;
  }
}

export async function checkGraphRagStageReportHealth(input: {
  outputDir: string;
  reportDir?: string;
  stage: BookStage;
  logStartOffset?: number;
}): Promise<GraphRagStageReportHealth> {
  const logPath = graphRagReportLogPath(input);
  let raw = Buffer.alloc(0);
  let logEndOffset = input.logStartOffset ?? 0;
  try {
    raw = await readFile(logPath);
    logEndOffset = raw.length;
  } catch {
    return {
      healthy: true,
      stage: input.stage,
      logPath,
      logStartOffset: input.logStartOffset ?? 0,
      logEndOffset,
    };
  }

  const logStartOffset = Math.max(0, input.logStartOffset ?? 0);
  const segment = raw.subarray(logStartOffset).toString("utf8");
  const health = stageHealthEvidence(segment, input.stage);
  return {
    ...health,
    stage: input.stage,
    logPath,
    logStartOffset,
    logEndOffset,
  };
}

export async function assertGraphRagStageReportHealthy(input: {
  outputDir: string;
  reportDir?: string;
  stage: BookStage;
  logStartOffset?: number;
}): Promise<GraphRagStageReportHealth> {
  const health = await checkGraphRagStageReportHealth(input);
  if (!health.healthy) {
    throw new Error(
      "GraphRAG stage report contains recoverable provider or partial-output " +
        "failure: " +
        JSON.stringify({
          stage: input.stage,
          failureKind: health.failureKind,
          reason: health.reason,
          evidence: health.evidence,
        }),
    );
  }
  return health;
}

function stageOwnedGraphRagOutputPaths(input: {
  outputDir: string;
  stage: BookStage;
}): string[] {
  const outputDir = resolve(input.outputDir);
  if (input.stage === "community_report") {
    return [join(outputDir, "community_reports.parquet")];
  }
  if (input.stage === "embed") {
    return [join(outputDir, "lancedb")];
  }
  if (input.stage === "graph_extract") {
    return [
      join(outputDir, "documents.parquet"),
      join(outputDir, "text_units.parquet"),
      join(outputDir, "entities.parquet"),
      join(outputDir, "relationships.parquet"),
      join(outputDir, "communities.parquet"),
      join(outputDir, "context.json"),
      join(outputDir, "stats.json"),
      join(outputDir, "qmd_graph_text_unit_identity.json"),
    ];
  }
  return [];
}

function outputRelativeLocator(outputDir: string, path: string): string {
  return relative(resolve(outputDir), path).replaceAll("\\", "/");
}

function failedCheckpointNeedsGraphRagOutputCleanup(input: {
  status: string;
  errorSummary?: string;
  metadata?: Record<string, JsonValue>;
}): boolean {
  if (input.status !== "failed") return false;
  const errorSummary = input.errorSummary?.toLowerCase() ?? "";
  const failureKind = String(input.metadata?.failureKind ?? "").toLowerCase();
  return (
    failureKind === "transient" ||
    failureKind === "partial_output" ||
    errorSummary.includes("partial-output") ||
    errorSummary.includes("partial output") ||
    errorSummary.includes("graphrag stage report") ||
    errorSummary.includes("community report extraction error") ||
    errorSummary.includes("no report found for community") ||
    errorSummary.includes("error generating community report") ||
    GRAPH_RAG_STAGE_TRANSIENT_LOG_PATTERN.test(errorSummary)
  );
}

export async function cleanFailedGraphRagStageOutputs(input: {
  outputDir: string;
  stage: BookStage;
  previousCheckpoint?: {
    status: string;
    errorSummary?: string;
    metadata?: Record<string, JsonValue>;
  } | null;
}): Promise<{
  cleaned: boolean;
  deletedLocators: string[];
  reason?: string;
}> {
  if (!failedCheckpointNeedsGraphRagOutputCleanup({
    status: input.previousCheckpoint?.status ?? "",
    errorSummary: input.previousCheckpoint?.errorSummary,
    metadata: input.previousCheckpoint?.metadata,
  })) {
    return { cleaned: false, deletedLocators: [] };
  }

  const deletedLocators: string[] = [];
  for (const path of stageOwnedGraphRagOutputPaths(input)) {
    try {
      await stat(path);
      await rm(path, { recursive: true, force: true });
      deletedLocators.push(outputRelativeLocator(input.outputDir, path));
    } catch {
      // Missing or concurrently removed residual outputs do not block retry.
    }
  }
  return {
    cleaned: true,
    deletedLocators,
    reason: "previous failed GraphRAG producer attempt was retryable",
  };
}

async function parseSettingsFingerprint(
  settingsPath: string,
): Promise<{
  configFingerprint: string;
  modelFingerprint: string;
  providerBoundaryFingerprint: string;
  stageConfigFingerprint: Record<BookStage, string>;
}> {
  const raw = await readFile(settingsPath, "utf8");
  const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
  const completionModels = parsed.completion_models;
  const embeddingModels = parsed.embedding_models;
  const vectorStore = parsed.vector_store;
  const providerBoundary = createDeterministicHash({
    version: "provider_request_boundary_v1",
    completion_models: redactProviderBoundary(completionModels),
    embedding_models: redactProviderBoundary(embeddingModels),
    vector_store: redactProviderBoundary(vectorStore),
    qmd_graphrag: redactProviderBoundary(parsed.qmd_graphrag),
  });

  return {
    configFingerprint: hashText(raw),
    modelFingerprint: createDeterministicHash({
      completion_models: completionModels,
      embedding_models: embeddingModels,
    }),
    providerBoundaryFingerprint: providerBoundary,
    stageConfigFingerprint: {
      ingest: createDeterministicHash({
        input: parsed.input,
        input_storage: parsed.input_storage,
      }),
      normalize: createDeterministicHash({
        input: parsed.input,
        input_storage: parsed.input_storage,
      }),
      graph_extract: createDeterministicHash({
        extract_graph: parsed.extract_graph,
        summarize_descriptions: parsed.summarize_descriptions,
        completion_models: completionModels,
      }),
      community_report: createDeterministicHash({
        community_reports: parsed.community_reports,
        completion_models: completionModels,
      }),
      embed: createDeterministicHash({
        embed_text: parsed.embed_text,
        embedding_models: embeddingModels,
        vector_store: vectorStore,
      }),
      query_ready: createDeterministicHash({
        local_search: parsed.local_search,
        global_search: parsed.global_search,
        drift_search: parsed.drift_search,
        basic_search: parsed.basic_search,
        vector_store: vectorStore,
        completion_models: completionModels,
        embedding_models: embeddingModels,
      }),
    },
  };
}

function deriveStageFingerprints(input: {
  sourceHash: string;
  normalizedContentHash: string;
  promptFingerprintByStage: Record<BookStage, string>;
  stageConfigFingerprint: Record<BookStage, string>;
  providerBoundaryFingerprint: string;
}): Record<BookStage, string> {
  const ingest = createDeterministicHash([
    "ingest",
    input.sourceHash,
    input.stageConfigFingerprint.ingest,
  ]);
  const normalize = createDeterministicHash([
    "normalize",
    input.sourceHash,
    input.normalizedContentHash,
    input.stageConfigFingerprint.normalize,
  ]);
  const graphExtract = createDeterministicHash([
    "graph_extract",
    normalize,
    input.stageConfigFingerprint.graph_extract,
    input.promptFingerprintByStage.graph_extract,
    input.providerBoundaryFingerprint,
  ]);
  const communityReport = createDeterministicHash([
    "community_report",
    graphExtract,
    input.stageConfigFingerprint.community_report,
    input.promptFingerprintByStage.community_report,
    input.providerBoundaryFingerprint,
  ]);
  const embed = createDeterministicHash([
    "embed",
    communityReport,
    input.stageConfigFingerprint.embed,
    input.providerBoundaryFingerprint,
  ]);
  const queryReady = createDeterministicHash([
    "query_ready",
    embed,
    input.stageConfigFingerprint.query_ready,
    input.providerBoundaryFingerprint,
  ]);

  return {
    ingest,
    normalize,
    graph_extract: graphExtract,
    community_report: communityReport,
    embed,
    query_ready: queryReady,
  };
}

function isSensitiveProviderKey(key: string): boolean {
  return /(^|[_-])(api[-_]?key|key|token|authorization|secret|password|credential)([_-]|$)/iu
    .test(key) || key.toUpperCase().endsWith("_KEY");
}

function redactProviderBoundary(input: unknown): unknown {
  if (input == null || typeof input === "boolean" || typeof input === "number") {
    return input;
  }
  if (typeof input === "string") {
    return input.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(input)
      ? "[redacted-path]"
      : input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactProviderBoundary(item));
  }
  if (typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [
          key,
          isSensitiveProviderKey(key)
            ? redactProviderSecretValue(value)
            : redactProviderBoundary(value),
        ]),
    );
  }
  return String(input);
}

function redactProviderSecretValue(value: unknown): unknown {
  if (typeof value === "string") {
    const placeholder = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value);
    return placeholder == null ? "[redacted-secret]" : { env: placeholder[1] };
  }
  return "[redacted-secret]";
}

async function artifactForFile(
  path: string,
  stage: BookStage,
  kind: Parameters<FileBookJobStateRepository["recordArtifacts"]>[1][number]["kind"],
  producerRunId: string,
  stageFingerprint?: string,
  providerFingerprint?: string,
  corpusContentHash?: string,
) {
  const contentHash = kind === "normalized_markdown"
    ? await hashContent(
        await readFile(path, "utf8"),
        GRAPHRAG_NORMALIZATION_POLICY_VERSION,
      )
    : await hashFile(path);

  return {
    stage,
    kind,
    path,
    contentHash,
    producerRunId,
    metadata: {
      ...(stageFingerprint ? { stageFingerprint } : {}),
      ...(providerFingerprint ? { providerFingerprint } : {}),
      ...(corpusContentHash ? { corpusContentHash } : {}),
    },
    stageFingerprint,
    providerFingerprint,
    normalizationPolicyVersion: GRAPHRAG_NORMALIZATION_POLICY_VERSION,
  };
}

async function materializeSourceInVault(input: {
  sourcePath: string;
  sourceHash: string;
  stateRootDir: string;
  bookId: string;
}): Promise<string> {
  const extension = extname(input.sourcePath) || ".epub";
  const sourceDir = join(
    resolve(input.stateRootDir),
    "books",
    input.bookId,
    "source",
  );
  const vaultSourcePath = join(sourceDir, `source${extension}`);
  await mkdir(sourceDir, { recursive: true });

  try {
    const existingHash = await hashFile(vaultSourcePath);
    if (existingHash === input.sourceHash) {
      return vaultSourcePath;
    }
  } catch {
    // Missing or unreadable materialized source is replaced below.
  }

  await copyFile(input.sourcePath, vaultSourcePath);
  return vaultSourcePath;
}

async function materializeNormalizedInputInVault(input: {
  normalizedPath: string;
  stateRootDir: string;
  bookId: string;
  normalizationPolicyVersion: string;
}): Promise<{
  path: string;
  content: string;
  contentHash: string;
}> {
  const sourcePath = resolve(input.normalizedPath);
  const inputDir = graphRagBookInputDir({
    stateRootDir: input.stateRootDir,
    bookId: input.bookId,
  });
  const targetPath = join(inputDir, basename(sourcePath));
  const content = await readFile(sourcePath, "utf8");
  const contentHash = await hashContent(
    content,
    input.normalizationPolicyVersion,
  );
  if (resolve(sourcePath) === resolve(targetPath)) {
    return { path: targetPath, content, contentHash };
  }
  await mkdir(inputDir, { recursive: true });
  try {
    const existing = await readFile(targetPath, "utf8");
    const existingHash = await hashContent(
      existing,
      input.normalizationPolicyVersion,
    );
    if (existingHash === contentHash) {
      return { path: targetPath, content: existing, contentHash };
    }
  } catch {
    // Missing or unreadable materialized input is replaced below.
  }
  await writeFile(targetPath, content, "utf8");
  return { path: targetPath, content, contentHash };
}

async function canonicalizeLegacyWorkspaceLayout(input: {
  repo: FileBookJobStateRepository;
  stateRootDir: string;
  sourceIdentityPath: string;
  sourceHash: string;
  bookId: string;
}): Promise<void> {
  const legacyBookId = `${normalizeBookSlug(input.sourceIdentityPath)}-${
    input.sourceHash.slice(0, 12)
  }`;
  await input.repo.remapBookIdentity(legacyBookId, input.bookId);
}

async function maybeArtifactForPath(
  path: string,
  stage: BookStage,
  kind: Parameters<FileBookJobStateRepository["recordArtifacts"]>[1][number]["kind"],
  producerRunId: string,
  stageFingerprint?: string,
  providerFingerprint?: string,
  corpusContentHash?: string,
) {
  try {
    const entry = await stat(path);
    if (!entry.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  return artifactForFile(
    path,
    stage,
    kind,
    producerRunId,
    stageFingerprint,
    providerFingerprint,
    corpusContentHash,
  );
}

async function maybeArtifactForDirectory(
  path: string,
  stage: BookStage,
  kind: Parameters<FileBookJobStateRepository["recordArtifacts"]>[1][number]["kind"],
  producerRunId: string,
  stageFingerprint?: string,
  providerFingerprint?: string,
  corpusContentHash?: string,
) {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    stage,
    kind,
    path,
    contentHash: kind === "lancedb_index"
      ? await hashLanceDbDirectoryContents(path)
      : await hashDirectoryContents(path),
    producerRunId,
    stageFingerprint,
    providerFingerprint,
    normalizationPolicyVersion: GRAPHRAG_NORMALIZATION_POLICY_VERSION,
    metadata: {
      ...(stageFingerprint ? { stageFingerprint } : {}),
      ...(providerFingerprint ? { providerFingerprint } : {}),
      ...(corpusContentHash ? { corpusContentHash } : {}),
    },
  };
}

function normalizeIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter((item) => item.length > 0);
  }
  if (
    typeof value === "object" &&
    value != null &&
    "length" in value &&
    typeof (value as { length?: unknown }).length === "number"
  ) {
    return Array.from(value as ArrayLike<unknown>)
      .map((item) => String(item))
      .filter((item) => item.length > 0);
  }
  if (value == null) return [];
  return [String(value)].filter((item) => item.length > 0);
}

function graphTextUnitIdentitySidecarPath(outputDir: string): string {
  return join(resolve(outputDir), "qmd_graph_text_unit_identity.json");
}

function parseGraphTextUnitIdentitySidecar(
  raw: string,
  expected: GraphRagTextUnitIdentityInput,
): GraphRagTextUnitIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed == null) return null;
  const value = parsed as Record<string, unknown>;
  const graphTextUnitIds = normalizeIdList(value.graphTextUnitIds);
  const graphDocumentId = String(value.graphDocumentId ?? "");
  const mapping: GraphRagTextUnitIdentity = {
    schemaVersion: "1.0.0",
    bookId: String(value.bookId ?? ""),
    sourceId: String(value.sourceId ?? ""),
    sourceHash: String(value.sourceHash ?? ""),
    documentId: String(value.documentId ?? ""),
    contentHash: expected.contentHash,
    normalizedPath: expected.normalizedPath,
    graphDocumentId,
    graphTextUnitIds,
  };
  const matchesIdentity =
    mapping.bookId === expected.bookId &&
    mapping.sourceId === expected.sourceId &&
    mapping.sourceHash === expected.sourceHash &&
    mapping.documentId === expected.documentId &&
    mapping.graphDocumentId.length > 0 &&
    mapping.graphTextUnitIds.length > 0;
  return matchesIdentity ? mapping : null;
}

function selectPythonBin(): string {
  const bundledPython = resolve(process.cwd(), ".venv-graphrag", "bin", "python");
  if (process.env.QMD_GRAPHRAG_PYTHON) return process.env.QMD_GRAPHRAG_PYTHON;
  if (existsSync(bundledPython)) return bundledPython;
  return process.env.PYTHON || "python3";
}

export async function readGraphTextUnitIdentity(input: {
  bookId: string;
  sourceId: string;
  sourceHash: string;
  documentId: string;
  contentHash: string;
  normalizedPath: string;
  outputDir: string;
}): Promise<GraphRagTextUnitIdentity | null> {
  const documentsPath = join(input.outputDir, "documents.parquet");
  const textUnitsPath = join(input.outputDir, "text_units.parquet");
  try {
    await Promise.all([stat(documentsPath), stat(textUnitsPath)]);
  } catch {
    return null;
  }

  return readValidatedGraphTextUnitIdentity(input);
}

async function readValidatedGraphTextUnitIdentity(
  input: GraphRagTextUnitIdentityInput & {
    graphDocumentId?: string;
    graphTextUnitIds?: string[];
  },
): Promise<GraphRagTextUnitIdentity | null> {
  const documentsPath = join(input.outputDir, "documents.parquet");
  const textUnitsPath = join(input.outputDir, "text_units.parquet");
  try {
    await Promise.all([stat(documentsPath), stat(textUnitsPath)]);
  } catch {
    return null;
  }

  const helper = [
    "import json, sys",
    "import pandas as pd",
    "documents_path, text_units_path, document_id, graph_document_id, expected_json, normalized_path = sys.argv[1:7]",
    "documents = pd.read_parquet(documents_path)",
    "text_units = pd.read_parquet(text_units_path)",
    "required_doc_cols = {'id', 'text_unit_ids'}",
    "required_text_unit_cols = {'id', 'document_id'}",
    "if not required_doc_cols.issubset(set(documents.columns)) or not required_text_unit_cols.issubset(set(text_units.columns)):",
    "    print('null')",
    "    raise SystemExit(0)",
    "normalized_title = str(normalized_path).replace('\\\\', '/').split('/')[-1]",
    "def title_basename(value):",
    "    return str(value).replace('\\\\', '/').split('/')[-1]",
    "if graph_document_id:",
    "    matched = documents.loc[documents['id'].astype(str) == str(graph_document_id)]",
    "else:",
    "    matched = documents.loc[documents['id'].astype(str) == str(document_id)]",
    "    if matched.empty and 'title' in documents.columns and normalized_title:",
    "        matched = documents.loc[documents['title'].map(title_basename) == normalized_title]",
    "    if matched.empty and len(documents.index) == 1:",
    "        matched = documents.iloc[[0]]",
    "if matched.empty:",
    "    print('null')",
    "    raise SystemExit(0)",
    "document = matched.iloc[0]",
    "graph_document_id = str(document['id'])",
    "if len(documents.index) > 1:",
    "    if 'title' not in documents.columns or title_basename(document.get('title')) != normalized_title:",
    "        print('null')",
    "        raise SystemExit(0)",
    "def normalize_ids(value):",
    "    if value is None:",
    "        return []",
    "    if hasattr(value, 'tolist'):",
    "        value = value.tolist()",
    "    if isinstance(value, (list, tuple, set)):",
    "        return [str(item) for item in value if item is not None and str(item)]",
    "    if pd.isna(value):",
    "        return []",
    "    return [str(value)] if str(value) else []",
    "document_ids = set(normalize_ids(document['text_unit_ids']))",
    "filtered = text_units.loc[text_units['document_id'].astype(str) == graph_document_id]",
    "scoped_ids = set(str(item) for item in filtered['id'].tolist() if item is not None and str(item))",
    "expected_ids = set(str(item) for item in json.loads(expected_json)) if expected_json else set()",
    "if not document_ids or document_ids != scoped_ids:",
    "    print('null')",
    "    raise SystemExit(0)",
    "if expected_ids and expected_ids != document_ids:",
    "    print('null')",
    "    raise SystemExit(0)",
    "ids = sorted(document_ids)",
    "print(json.dumps({'graphDocumentId': graph_document_id, 'graphTextUnitIds': ids}))",
  ].join("\n");
  const result = spawnSync(selectPythonBin(), [
    "-c",
    helper,
    documentsPath,
    textUnitsPath,
    input.documentId,
    input.graphDocumentId ?? "",
    input.graphTextUnitIds == null
      ? ""
      : JSON.stringify(input.graphTextUnitIds),
    input.normalizedPath,
  ], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || "failed to read GraphRAG text unit identity",
    );
  }
  const parsed = JSON.parse(result.stdout.trim()) as null | {
    graphDocumentId: unknown;
    graphTextUnitIds: unknown;
  };
  if (parsed == null) return null;
  const graphTextUnitIds = normalizeIdList(parsed.graphTextUnitIds);
  if (typeof parsed.graphDocumentId !== "string" || graphTextUnitIds.length === 0) {
    return null;
  }
  return {
    schemaVersion: "1.0.0",
    bookId: input.bookId,
    sourceId: input.sourceId,
    sourceHash: input.sourceHash,
    documentId: input.documentId,
    contentHash: input.contentHash,
    normalizedPath: input.normalizedPath,
    graphDocumentId: parsed.graphDocumentId,
    graphTextUnitIds,
  };
}

async function readGraphTextUnitIdentitySidecar(
  input: GraphRagTextUnitIdentityInput,
): Promise<GraphRagTextUnitIdentity | null> {
  let parsed: unknown;
  try {
    parsed = await readJsonFileDurable(graphTextUnitIdentitySidecarPath(input.outputDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
  const mapping = parseGraphTextUnitIdentitySidecar(JSON.stringify(parsed), input);
  if (mapping == null) {
    return null;
  }
  const validated = await readValidatedGraphTextUnitIdentity({
    ...input,
    graphDocumentId: mapping.graphDocumentId,
    graphTextUnitIds: mapping.graphTextUnitIds,
  });
  if (validated == null) {
    throw new Error(
      `GraphRAG document identity sidecar evidence is invalid for query_ready: ${
        input.documentId
      }`,
    );
  }
  return validated;
}

async function recordGraphTextUnitIdentityIfAvailable(input: {
  repo: FileBookJobStateRepository;
  job: BookJob;
  normalizedPath: string;
  outputDir: string;
  required: boolean;
}): Promise<void> {
  const identityInput: GraphRagTextUnitIdentityInput = {
    bookId: input.job.bookId,
    sourceId: `sha256:${input.job.sourceHash}`,
    sourceHash: input.job.sourceHash,
    documentId: input.job.documentId,
    contentHash: input.job.normalizedContentHash ?? input.job.sourceHash,
    normalizedPath: input.normalizedPath,
    outputDir: input.outputDir,
  };
  let mapping: GraphRagTextUnitIdentity | null;
  try {
    // The sidecar is a cache; recovered current Parquet output must win.
    mapping = await readGraphTextUnitIdentity(identityInput) ??
      await readGraphTextUnitIdentitySidecar(identityInput);
  } catch (error) {
    if (!input.required) return;
    throw error;
  }
  if (mapping == null) {
    if (!input.required) return;
    throw new Error(
      `GraphRAG document identity is missing for query_ready: ${input.job.documentId}`,
    );
  }
  await input.repo.recordGraphTextUnitIdentity(mapping);
  await writeJsonFileDurable(
    graphTextUnitIdentitySidecarPath(input.outputDir),
    JSON.stringify(mapping, null, 2),
  );
}

async function recordDocumentChunks(input: {
  repo: FileBookJobStateRepository;
  job: BookJob;
  normalizedPath: string;
}): Promise<void> {
  let text: string;
  try {
    text = await readFile(input.normalizedPath, "utf8");
  } catch {
    return;
  }

  const chunks = chunkDocument(text);
  const chunkIds = chunks.map((chunk, seq) =>
    `chunk-${createDeterministicHash({
      documentId: input.job.documentId,
      contentHash: input.job.normalizedContentHash ?? input.job.sourceHash,
      chunkStrategy: "qmd-default-v1",
      seq,
      pos: chunk.pos,
      length: chunk.text.length,
    }).slice(0, 12)}`,
  );
  await input.repo.recordDocumentChunks({
    documentId: input.job.documentId,
    contentHash: input.job.normalizedContentHash ?? input.job.sourceHash,
    chunkIds,
  });
}

export async function registerQmdCorpusDocument(input: {
  repo: FileBookJobStateRepository;
  qmdIndexPath: string;
  stateRootDir: string;
  job: BookJob;
  normalizedPath: string;
}): Promise<void> {
  const content = await readFile(input.normalizedPath, "utf8");
  const contentHash = await hashContent(
    content,
    input.job.normalizationPolicyVersion,
  );
  if (contentHash !== input.job.normalizedContentHash) {
    throw new Error(
      `qmd corpus content hash differs from graph identity: ${input.job.documentId}`,
    );
  }

  await mkdir(dirname(input.qmdIndexPath), { recursive: true });
  await withQmdIndexFileLock(input.qmdIndexPath, async () => {
    input.repo.assertCurrentBatchBookLease(input.job.bookId);
    const result = await withSqliteBusyRetry(
      "qmd-corpus-registration",
      input.job.bookId,
      async () => {
        const store = createStore(input.qmdIndexPath);
        try {
          input.repo.assertCurrentBatchBookLease(input.job.bookId);
          upsertStoreCollection(store.db, "books", {
            path: join(resolve(input.stateRootDir), "books"),
            pattern: "**/input/*.md",
            context: {
              "/": "Normalized books available to qmd and GraphRAG.",
            },
          });
          const now = new Date().toISOString();
          const normalizedRelativePath =
            input.job.normalizedPath?.startsWith("books/")
              ? input.job.normalizedPath.slice("books/".length)
              : input.job.normalizedPath?.startsWith("input/")
                ? input.job.normalizedPath.slice("input/".length)
                : input.job.normalizedPath ?? basename(input.normalizedPath);
          insertContent(store.db, contentHash, content, now);
          insertDocument(
            store.db,
            "books",
            normalizedRelativePath,
            extractTitle(content, normalizedRelativePath),
            contentHash,
            now,
            now,
          );
          return normalizedRelativePath;
        } finally {
          store.close();
        }
      },
    );
    input.repo.assertCurrentBatchBookLease(input.job.bookId);
    await input.repo.recordQmdCorpusRegistration({
      documentId: input.job.documentId,
      contentHash,
      collection: "books",
      relativePath: result.value,
      metadata: {
        sqliteBusyRetryCount: result.retryCount,
        sqliteBusyWaitMs: result.waitMs,
        sqliteBusyFinalClassification: result.finalClassification,
      },
    });
  });
}

function classifySqliteBusyError(error: unknown): "busy" | "locked" | null {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string"
    ? candidate.code.toUpperCase()
    : "";
  const message = String(candidate?.message ?? "").toLowerCase();
  if (code.includes("SQLITE_BUSY") || message.includes("database is busy")) {
    return "busy";
  }
  if (
    code.includes("SQLITE_LOCKED") ||
    message.includes("database is locked") ||
    message.includes("database table is locked")
  ) {
    return "locked";
  }
  return null;
}

async function withSqliteBusyRetry<T>(
  operation: string,
  bookId: string,
  callback: () => Promise<T> | T,
): Promise<{
  value: T;
  retryCount: number;
  waitMs: number;
  finalClassification: "none" | "busy" | "locked";
}> {
  let retryCount = 0;
  let waitMs = 0;
  let finalClassification: "none" | "busy" | "locked" = "none";
  for (;;) {
    try {
      const value = await callback();
      if (retryCount > 0) {
        writeSqliteBusyRetryMetric({
          operation,
          bookId,
          retryCount,
          waitMs,
          finalClassification,
          exhausted: false,
        });
      }
      return { value, retryCount, waitMs, finalClassification };
    } catch (error) {
      const classification = classifySqliteBusyError(error);
      if (classification == null) throw error;
      finalClassification = classification;
      if (retryCount >= QMD_SQLITE_BUSY_RETRY_LIMIT) {
        writeSqliteBusyRetryMetric({
          operation,
          bookId,
          retryCount,
          waitMs,
          finalClassification,
          exhausted: true,
        });
        throw error;
      }
      retryCount += 1;
      const delayMs = Math.min(
        QMD_SQLITE_BUSY_RETRY_MAX_MS,
        QMD_SQLITE_BUSY_RETRY_BASE_MS * (2 ** (retryCount - 1)),
      );
      waitMs += delayMs;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, delayMs));
    }
  }
}

function writeSqliteBusyRetryMetric(input: {
  operation: string;
  bookId: string;
  retryCount: number;
  waitMs: number;
  finalClassification: "busy" | "locked" | "none";
  exhausted: boolean;
}): void {
  const root = process.env.QMD_GRAPHRAG_GRAPH_VAULT;
  const runId = process.env.QMD_GRAPHRAG_RUN_ID;
  if (root == null || runId == null || root.trim() === "" || runId.trim() === "") {
    return;
  }
  const metricPath = join(
    resolve(root),
    "catalog",
    "batch-runs",
    runId,
    "qmd-sqlite-retry-metrics.jsonl",
  );
  try {
    const line = JSON.stringify({
      schemaVersion: "1.0.0",
      at: new Date().toISOString(),
      ...input,
    }) + "\n";
    writeFileSync(metricPath, line, { encoding: "utf8", flag: "a" });
  } catch {
    // Metrics must not change qmd corpus commit semantics.
  }
}

async function waitForQmdIndexLock() {
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));
}

function processAlive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || pid == null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readQmdIndexLockOwner(lockPath: string): {
  pid?: number;
  runnerSessionId?: string;
  operationId?: string;
  generation?: number;
  fencingTokenHash?: string;
} {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as {
      pid?: number;
      runnerSessionId?: string;
      operationId?: string;
      generation?: number;
      fencingTokenHash?: string;
    };
    return parsed ?? {};
  } catch {
    return {};
  }
}

function qmdIndexLockOwnerExpired(
  owner: Record<string, unknown>,
  mtimeMs: number,
): boolean {
  const expiresAt = typeof owner.expiresAt === "string"
    ? Date.parse(owner.expiresAt)
    : NaN;
  return Number.isFinite(expiresAt)
    ? Date.now() > expiresAt
    : Date.now() - mtimeMs > QMD_INDEX_LOCK_STALE_MS;
}

function qmdIndexLockHasRecoveryFence(owner: Record<string, unknown>): boolean {
  return Number.isInteger(owner.generation) &&
    typeof owner.fencingTokenHash === "string" &&
    owner.fencingTokenHash.length > 0 &&
    typeof owner.runnerSessionId === "string" &&
    owner.runnerSessionId.length > 0 &&
    typeof owner.operationId === "string" &&
    owner.operationId.length > 0;
}

function qmdIndexLockOwnedBy(
  lockPath: string,
  expected: Record<string, unknown>,
): boolean {
  const current = readQmdIndexLockOwner(lockPath);
  return current.operationId === expected.operationId &&
    current.runnerSessionId === expected.runnerSessionId &&
    current.generation === expected.generation &&
    current.fencingTokenHash === expected.fencingTokenHash;
}

function releaseQmdIndexLock(lockPath: string, owner: Record<string, unknown>): void {
  if (!qmdIndexLockOwnedBy(lockPath, owner)) return;
  unlinkSync(lockPath);
  fsyncQmdIndexLockDirectory(dirname(lockPath), lockPath, owner);
}

function removeStaleQmdIndexLock(lockPath: string, mtimeMs: number): void {
  const owner = readQmdIndexLockOwner(lockPath);
  if (!qmdIndexLockOwnerExpired(owner, mtimeMs)) return;
  if (!qmdIndexLockHasRecoveryFence(owner)) return;
  if (processAlive(owner.pid)) return;
  unlinkSync(lockPath);
  fsyncQmdIndexLockDirectory(dirname(lockPath), lockPath, owner);
}

function qmdIndexLockTimeoutError(
  qmdIndexPath: string,
  lockPath: string,
  lockOwnerEvidence: Record<string, unknown>,
): DurableStateError {
  return new DurableStateError(
    `timed out waiting for qmd index lock: ${lockPath}`,
    {
      failureKind: "local_state_lock_timeout",
      localFailureClass: "durable_state_lock_timeout",
      evidence: {
        targetLocator: qmdIndexPath,
        redactedEvidenceLocator: basename(qmdIndexPath),
        lockPath,
        lane: "qmdIndexWriterLane",
        targetMappingOwner: "qmd",
        durableKind: "sqlite",
        laneTimeoutMs: QMD_INDEX_LOCK_STALE_MS,
        releaseOn: QMD_INDEX_RELEASE_ON,
        lockOwnerEvidence,
        durableMode: "strict",
        completedPublishRule: "forbidden",
      },
    },
  );
}

async function withQmdIndexFileLock<T>(
  qmdIndexPath: string,
  callback: () => Promise<T>,
): Promise<T> {
  const lockPath = `${qmdIndexPath}.lock`;
  const startedAt = Date.now();
  const runnerSessionId = process.env.QMD_GRAPHRAG_RUNNER_SESSION_ID ??
    `process-${process.pid}`;
  const generation = Number.parseInt(
    process.env.QMD_GRAPHRAG_BOOK_LEASE_GENERATION ?? "",
    10,
  ) || 1;
  const fencingToken = process.env.QMD_GRAPHRAG_BOOK_FENCING_TOKEN ??
    process.env.QMD_GRAPHRAG_ITEM_FENCING_TOKEN ??
    "";
  const fencingTokenHash = fencingToken.length > 0
    ? hashText(fencingToken)
    : hashText(["qmd-index-lock", runnerSessionId, qmdIndexPath, generation].join(":"));
  for (;;) {
    let fd: number | null = null;
    const owner = {
      pid: process.pid,
      ownerPid: process.pid,
      runnerSessionId,
      runId: process.env.QMD_GRAPHRAG_RUN_ID,
      runnerHost: process.env.QMD_GRAPHRAG_RUNNER_HOST,
      ownerHost: process.env.QMD_GRAPHRAG_RUNNER_HOST,
      targetLocator: qmdIndexPath,
      lockPath,
      lane: "qmdIndexWriterLane",
      targetMappingOwner: "qmd",
      durableKind: "sqlite",
      laneTimeoutMs: QMD_INDEX_LOCK_STALE_MS,
      releaseOn: QMD_INDEX_RELEASE_ON,
      generation,
      fencingTokenHash,
      operationId: `qmd-index-lock-${randomUUID()}`,
      itemId: process.env.QMD_GRAPHRAG_ITEM_ID,
      bookId: process.env.QMD_GRAPHRAG_BOOK_ID,
      workerId: process.env.QMD_GRAPHRAG_WORKER_ID,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + QMD_INDEX_LOCK_STALE_MS).toISOString(),
      durableMode: "strict",
    };
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
      fsyncSync(fd);
      if (!qmdIndexLockOwnedBy(lockPath, owner)) {
        throw qmdIndexLockTimeoutError(qmdIndexPath, lockPath, {
          expected: owner,
          current: readQmdIndexLockOwner(lockPath),
        });
      }
      const result = await callback();
      if (!qmdIndexLockOwnedBy(lockPath, owner)) {
        throw qmdIndexLockTimeoutError(qmdIndexPath, lockPath, {
          expected: owner,
          current: readQmdIndexLockOwner(lockPath),
        });
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        const entry = await stat(lockPath);
        removeStaleQmdIndexLock(lockPath, entry.mtimeMs);
      } catch (error) {
        if (error instanceof DurableStateError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Missing or concurrently removed locks are expected under contention.
      }
      if (Date.now() - startedAt > QMD_INDEX_LOCK_WAIT_MS) {
        throw qmdIndexLockTimeoutError(
          qmdIndexPath,
          lockPath,
          readQmdIndexLockOwner(lockPath),
        );
      }
      await waitForQmdIndexLock();
    } finally {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          // Best-effort cleanup only.
        }
        releaseQmdIndexLock(lockPath, owner);
      }
    }
  }
}

async function writeLanceDbRowCountSidecars(root: string): Promise<void> {
  for (const tableName of [
    "entity_description.lance",
    "community_full_content.lance",
    "text_unit_text.lance",
  ]) {
    const tableDir = join(root, tableName);
    try {
      await stat(tableDir);
    } catch {
      continue;
    }
    const rowCount = await readLanceDbRowCount(tableDir);
    if (rowCount == null) continue;
    await writeJsonFileDurable(
      join(tableDir, "qmd_row_count.json"),
      JSON.stringify({ schemaVersion: "1.0.0", rowCount }, null, 2),
    );
  }
}

async function readLanceDbRowCount(tableDir: string): Promise<number | null> {
  const helper = [
    "import json, sys",
    "import lancedb",
    "table_dir = sys.argv[1]",
    "db_uri, table_name = table_dir.rsplit('/', 1)",
    "db = lancedb.connect(db_uri)",
    "names = [table_name[:-6] if table_name.endswith('.lance') else table_name, table_name]",
    "table = None",
    "for name in dict.fromkeys(names):",
    "    try:",
    "        table = db.open_table(name)",
    "        break",
    "    except Exception:",
    "        pass",
    "if table is None:",
    "    raise ValueError(f'LanceDB table not found: {table_name}')",
    "print(json.dumps({'rowCount': int(table.count_rows())}))",
  ].join("\n");
  const result = spawnSync(selectPythonBin(), ["-c", helper, tableDir], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { rowCount?: unknown };
    return typeof parsed.rowCount === "number" ? parsed.rowCount : null;
  } catch {
    return null;
  }
}

async function collectWorkspaceArtifacts(
  paths: GraphRagBookWorkspacePaths,
  vaultSourcePath: string,
  producerRunId: string,
  stageFingerprints: Record<BookStage, string>,
  providerFingerprint: string,
  expectedOutputProducer: GraphRagOutputProducerManifest | null,
  corpusContentHash: string,
) {
  const normalizedPath = resolve(paths.normalizedPath);
  const outputDir = resolve(paths.outputDir);
  const stageRunId = (stage: BookStage) => `${producerRunId}-${stage}`;
  const outputRunId = (stage: BookStage) => {
    if (expectedOutputProducer?.stageProducerRunIds != null) {
      return expectedOutputProducer.stageProducerRunIds[stage] ?? stageRunId(stage);
    }
    return expectedOutputProducer?.producerRunId ?? stageRunId(stage);
  };

  const canUseGraphOutput = expectedOutputProducer != null;
  const artifacts = await Promise.all([
    artifactForFile(
      vaultSourcePath,
      "ingest",
      "source_epub",
      stageRunId("ingest"),
      stageFingerprints.ingest,
      providerFingerprint,
    ),
    maybeArtifactForPath(
      normalizedPath,
      "normalize",
      "normalized_markdown",
      stageRunId("normalize"),
      stageFingerprints.normalize,
      providerFingerprint,
    ),
    canUseGraphOutput
      ? maybeArtifactForPath(
          join(outputDir, "documents.parquet"),
          "graph_extract",
          "graphrag_documents_parquet",
          outputRunId("graph_extract"),
          stageFingerprints.graph_extract,
          providerFingerprint,
          corpusContentHash,
        )
      : null,
    canUseGraphOutput
      ? maybeArtifactForPath(
          join(outputDir, "text_units.parquet"),
          "graph_extract",
          "graphrag_text_units_parquet",
          outputRunId("graph_extract"),
          stageFingerprints.graph_extract,
          providerFingerprint,
          corpusContentHash,
        )
      : null,
    canUseGraphOutput
      ? maybeArtifactForPath(
          join(outputDir, "entities.parquet"),
          "graph_extract",
          "graphrag_entities_parquet",
          outputRunId("graph_extract"),
          stageFingerprints.graph_extract,
          providerFingerprint,
          corpusContentHash,
        )
      : null,
    canUseGraphOutput
      ? maybeArtifactForPath(
          join(outputDir, "relationships.parquet"),
          "graph_extract",
          "graphrag_relationships_parquet",
          outputRunId("graph_extract"),
          stageFingerprints.graph_extract,
          providerFingerprint,
          corpusContentHash,
        )
      : null,
    canUseGraphOutput
      ? maybeArtifactForPath(
          join(outputDir, "communities.parquet"),
          "graph_extract",
          "graphrag_communities_parquet",
          outputRunId("graph_extract"),
          stageFingerprints.graph_extract,
          providerFingerprint,
          corpusContentHash,
        )
      : null,
    canUseGraphOutput
      ? maybeArtifactForPath(
          join(outputDir, "context.json"),
          "graph_extract",
          "graphrag_context_json",
          outputRunId("graph_extract"),
          stageFingerprints.graph_extract,
          providerFingerprint,
          corpusContentHash,
        )
      : null,
    canUseGraphOutput
      ? maybeArtifactForPath(
          join(outputDir, "stats.json"),
          "graph_extract",
          "graphrag_stats_json",
          outputRunId("graph_extract"),
          stageFingerprints.graph_extract,
          providerFingerprint,
          corpusContentHash,
        )
      : null,
    canUseGraphOutput
      ? maybeArtifactForPath(
          join(outputDir, "community_reports.parquet"),
          "community_report",
          "graphrag_community_reports_parquet",
          outputRunId("community_report"),
          stageFingerprints.community_report,
          providerFingerprint,
          corpusContentHash,
        )
      : null,
    canUseGraphOutput
      ? isCompleteLanceDbDirectory(join(outputDir, "lancedb")).then((isComplete) =>
          isComplete
            ? maybeArtifactForDirectory(
                join(outputDir, "lancedb"),
                "embed",
                "lancedb_index",
                outputRunId("embed"),
                stageFingerprints.embed,
                providerFingerprint,
                corpusContentHash,
              )
            : null
        )
      : null,
  ]);

  return artifacts.filter((item) => item != null);
}

async function readOutputProducerManifest(
  outputDir: string,
): Promise<GraphRagOutputProducerManifest | null> {
  const manifestPath = join(outputDir, "qmd_output_manifest.json");
  try {
    const parsed = await readJsonFileDurable(
      manifestPath,
    ) as Partial<GraphRagOutputProducerManifest>;
    if (
      parsed.schemaVersion !== "1.0.0" ||
      typeof parsed.bookId !== "string" ||
      typeof parsed.sourceHash !== "string" ||
      typeof parsed.documentId !== "string" ||
      typeof parsed.contentHash !== "string" ||
      typeof parsed.providerFingerprint !== "string" ||
      typeof parsed.outputDir !== "string" ||
      typeof parsed.producerRunId !== "string" ||
      parsed.stageProducerRunIds == null ||
      parsed.stageFingerprints == null
    ) {
      return null;
    }
    return parsed as GraphRagOutputProducerManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof DurableStateError) throw error;
    return null;
  }
}

function outputProducerMatches(input: {
  manifest: GraphRagOutputProducerManifest | null;
  bookId: string;
  sourceHash: string;
  documentId: string;
  contentHash: string;
  stageFingerprints: Record<BookStage, string>;
  providerFingerprint: string;
  outputDir: string;
}): boolean {
  const manifest = input.manifest;
  if (manifest == null) return false;
  const expectedLocator = graphRagBookOutputLocator(input.bookId);
  return manifest.bookId === input.bookId &&
    manifest.sourceHash === input.sourceHash &&
    manifest.documentId === input.documentId &&
    manifest.contentHash === input.contentHash &&
    manifest.providerFingerprint === input.providerFingerprint &&
    manifest.outputDir === expectedLocator &&
    BookStageOrder.every((stage) =>
      manifest.stageFingerprints?.[stage] === input.stageFingerprints[stage]
    );
}

export async function writeGraphRagOutputProducerManifest(input: {
  outputDir: string;
  repo?: FileBookJobStateRepository;
  bookId: string;
  sourceHash: string;
  documentId: string;
  contentHash: string;
  stageFingerprints: Record<BookStage, string>;
  providerFingerprint: string;
  producerRunId: string;
  stage?: BookStage;
}): Promise<void> {
  input.repo?.assertCurrentBatchBookLease(input.bookId);
  const previous = await readOutputProducerManifest(input.outputDir);
  const previousMatches = outputProducerMatches({
    manifest: previous,
    bookId: input.bookId,
    sourceHash: input.sourceHash,
    documentId: input.documentId,
    contentHash: input.contentHash,
    stageFingerprints: input.stageFingerprints,
    providerFingerprint: input.providerFingerprint,
    outputDir: input.outputDir,
  });
  const stageProducerRunIds = {
    ...(previousMatches ? previous?.stageProducerRunIds ?? {} : {}),
    ...(input.stage ? { [input.stage]: input.producerRunId } : {}),
  };
  const manifest: GraphRagOutputProducerManifest = {
    schemaVersion: "1.0.0",
    bookId: input.bookId,
    sourceHash: input.sourceHash,
    documentId: input.documentId,
    contentHash: input.contentHash,
    stageFingerprints: input.stageFingerprints,
    providerFingerprint: input.providerFingerprint,
    outputDir: graphRagBookOutputLocator(input.bookId),
    producerRunId: input.producerRunId,
    stageProducerRunIds,
    ...currentBatchBookLeaseFenceMetadata(),
  };
  await mkdir(input.outputDir, { recursive: true });
  input.repo?.assertCurrentBatchBookLease(input.bookId);
  await writeJsonFileDurable(
    join(input.outputDir, "qmd_output_manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

export async function refreshGraphRagStageOutputDurableSidecars(input: {
  outputDir: string;
  repo?: FileBookJobStateRepository;
  bookId: string;
  stage: BookStage;
  producerRunId: string;
}) {
  return refreshGraphRagOutputJsonSidecars({
    outputDir: input.outputDir,
    repo: input.repo,
    bookId: input.bookId,
    stage: input.stage,
    producerRunId: input.producerRunId,
    reason: "stage_success",
  });
}

function currentBatchBookLeaseFenceMetadata(): {
  bookLeaseGeneration?: number;
  bookFencingToken?: string;
} {
  const generation = Number.parseInt(
    process.env.QMD_GRAPHRAG_BOOK_LEASE_GENERATION ?? "",
    10,
  );
  const token = process.env.QMD_GRAPHRAG_BOOK_FENCING_TOKEN;
  if (
    token == null ||
    token === "" ||
    !Number.isInteger(generation) ||
    generation <= 0
  ) {
    return {};
  }
  return {
    bookLeaseGeneration: generation,
    bookFencingToken: token,
  };
}

function fsyncQmdIndexLockDirectory(
  path: string,
  lockPath: string,
  owner: Record<string, unknown>,
): void {
  let fd: number | null = null;
  try {
    maybeInjectQmdIndexDirectoryFsyncFailure(path, lockPath);
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const fsyncErrno = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new DurableStateError(`durable directory fsync failed: ${path}`, {
      localFailureClass: "durable_directory_fsync_uncertain",
      cause: error as Error,
      evidence: {
        targetLocator: owner.targetLocator,
        lockPath,
        directoryTargetLocator: path,
        directoryDurableKind: "directory",
        primaryTargetLocator: owner.targetLocator,
        primaryDurableKind: "sqlite",
        lane: "qmdIndexWriterLane",
        targetMappingOwner: "qmd",
        durableKind: "sqlite-lock",
        laneTimeoutMs: QMD_INDEX_LOCK_STALE_MS,
        releaseOn: QMD_INDEX_RELEASE_ON,
        fsyncTarget: path,
        fsyncErrno,
        fsyncPlatform: process.platform,
        unavailableFieldSentinels: fsyncErrnoSentinel(fsyncErrno)
          ? ["fsyncErrno"]
          : undefined,
        lockOwnerEvidence: owner,
        durableMode: "strict",
        completedPublishRule: "forbidden",
        redactedEvidenceLocator: basename(lockPath),
      },
    });
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function fsyncErrnoSentinel(errno: string): boolean {
  return errno === "" ||
    ["unknown", "unsupported", "unavailable", "platform_no_errno"]
      .includes(errno);
}

function maybeInjectQmdIndexDirectoryFsyncFailure(
  path: string,
  lockPath: string,
): void {
  if (process.env.QMD_GRAPHRAG_ENABLE_TEST_HOOKS !== "1") return;
  const pattern = process.env
    .QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_PATTERN ?? "";
  if (pattern === "") return;
  if (!path.includes(pattern) && !lockPath.includes(pattern)) return;
  const error = new Error("injected qmd index directory fsync failure") as
    Error & { code?: string };
  error.code = "EIO";
  throw error;
}

function groupArtifactsByStage(artifacts: BookArtifactManifest[]) {
  const grouped = new Map<BookStage, BookArtifactManifest[]>();
  for (const artifact of artifacts) {
    const items = grouped.get(artifact.stage) ?? [];
    items.push(artifact);
    grouped.set(artifact.stage, items);
  }
  return grouped;
}

function hasKinds(
  artifacts: BookArtifactManifest[],
  kinds: readonly BookArtifactKind[],
): boolean {
  const artifactKinds = new Set(artifacts.map((artifact) => artifact.kind));
  return kinds.every((kind) => artifactKinds.has(kind));
}

async function bootstrapRecoveredStages(input: {
  repo: FileBookJobStateRepository;
  bookId: string;
  stageFingerprints: StageFingerprintMap;
  artifacts: BookArtifactManifest[];
  bootstrapRunId: string;
  highCostStages: boolean;
}) {
  const byStage = groupArtifactsByStage(input.artifacts);
  const existing = new Map(
    (await input.repo.listStageCheckpoints(input.bookId)).map((item) => [
      item.stage,
      item,
    ]),
  );

  const maybeComplete = async (
    stage: BookStage,
    shouldComplete: boolean,
    artifactIds = (byStage.get(stage) ?? []).map((artifact) => artifact.artifactId),
  ) => {
    if (!shouldComplete) {
      return;
    }
    const checkpoint = existing.get(stage);
    const expectedFingerprint =
      input.stageFingerprints[stage] ?? createDeterministicHash([stage]);
    const isReusableSucceededCheckpoint =
      checkpoint?.status === "succeeded" &&
      checkpoint.inputFingerprint === expectedFingerprint &&
      checkpoint.metadata?.bootstrap !== true &&
      artifactIds.every((artifactId) => checkpoint.artifactIds.includes(artifactId));

    if (isReusableSucceededCheckpoint) {
      return;
    }
    const runId = `${input.bootstrapRunId}-${stage}`;
    await input.repo.completeStage({
      bookId: input.bookId,
      stage,
      runId,
      inputFingerprint: expectedFingerprint,
      stageFingerprint: input.stageFingerprints[stage],
      providerFingerprint: input.artifacts.find((artifact) =>
        artifactIds.includes(artifact.artifactId)
      )?.providerFingerprint,
      artifactIds,
      metadata: {
        bootstrap: true,
        bootstrapRootRunId: input.bootstrapRunId,
      },
    });
  };

  await maybeComplete("ingest", (byStage.get("ingest")?.length ?? 0) > 0);
  await maybeComplete("normalize", (byStage.get("normalize")?.length ?? 0) > 0);
  if (input.highCostStages) {
    await maybeComplete(
      "graph_extract",
      hasKinds(
        byStage.get("graph_extract") ?? [],
        GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
      ),
    );
    await maybeComplete(
      "community_report",
      hasKinds(byStage.get("community_report") ?? [], [
        "graphrag_community_reports_parquet",
      ]),
    );
    await maybeComplete("embed", hasKinds(byStage.get("embed") ?? [], ["lancedb_index"]));
    await maybeComplete(
      "query_ready",
      hasKinds(byStage.get("graph_extract") ?? [], GRAPH_EXTRACT_CORE_ARTIFACT_KINDS) &&
      hasKinds(byStage.get("community_report") ?? [], [
        "graphrag_community_reports_parquet",
      ]) && hasKinds(byStage.get("embed") ?? [], ["lancedb_index"]),
      [
        ...(byStage.get("community_report") ?? []),
        ...(byStage.get("embed") ?? []),
      ].map((artifact) => artifact.artifactId),
    );
  }
}

function artifactsForProducerRun(
  artifacts: readonly BookArtifactManifest[],
  stage: BookStage,
  producerRunId: string,
): BookArtifactManifest[] {
  return artifacts.filter((artifact) =>
    artifact.stage === stage && artifact.producerRunId === producerRunId
  );
}

function gateArtifactsForProducerRun(
  artifacts: readonly BookArtifactManifest[],
  stage: BookStage,
  producerRunId: string,
  requiredKinds: readonly BookArtifactKind[],
): BookArtifactManifest[] {
  const requiredKindSet = new Set<BookArtifactKind>(requiredKinds);
  return artifactsForProducerRun(artifacts, stage, producerRunId)
    .filter((artifact) => requiredKindSet.has(artifact.kind));
}

function gateArtifactsForStageReadiness(input: {
  artifacts: readonly BookArtifactManifest[];
  stage: BookStage;
  producerRunId: string;
  requiredKinds: readonly BookArtifactKind[];
  expectedProducerRunIds?: Partial<Record<BookStage, string>>;
}): BookArtifactManifest[] {
  if (input.stage !== "query_ready") {
    return gateArtifactsForProducerRun(
      input.artifacts,
      input.stage,
      input.producerRunId,
      input.requiredKinds,
    );
  }
  const requiredKindSet = new Set<BookArtifactKind>(input.requiredKinds);
  const communityReportRunId = input.expectedProducerRunIds?.community_report;
  const embedRunId = input.expectedProducerRunIds?.embed;
  return input.artifacts.filter((artifact) =>
    requiredKindSet.has(artifact.kind) &&
    (
      (
        artifact.stage === "community_report" &&
        artifact.producerRunId === communityReportRunId
      ) ||
      (
        artifact.stage === "embed" &&
        artifact.producerRunId === embedRunId
      )
    )
  );
}

async function assertQueryReadyProducerArtifacts(input: {
  stateRootDir: string;
  bookId: string;
  artifacts: readonly BookArtifactManifest[];
  expectedProducerRunIds: Partial<Record<BookStage, string>>;
  expectedStageFingerprints?: Partial<Record<BookStage, string>>;
  expectedProviderFingerprint?: string;
  expectedCorpusContentHash?: string;
}): Promise<void> {
  for (const stage of QUERY_READY_PRODUCER_STAGES) {
    const producerRunId = input.expectedProducerRunIds[stage];
    if (producerRunId == null) {
      throw new Error(
        "query_ready artifact readiness requires completed GraphRAG " +
          `producer run id for ${stage}`,
      );
    }
    if (input.expectedStageFingerprints?.[stage] == null) {
      throw new Error(
        "query_ready artifact readiness requires producer lineage " +
          `fingerprint for ${stage}`,
      );
    }
    const requiredKinds = QUERY_READY_PRODUCER_REQUIRED_KINDS[stage];
    const producerArtifacts = gateArtifactsForProducerRun(
      input.artifacts,
      stage,
      producerRunId,
      requiredKinds,
    );
    const validation = await validateBookArtifactSet({
      graphVault: input.stateRootDir,
      bookId: input.bookId,
      artifactIds: producerArtifacts.map((artifact) => artifact.artifactId),
      artifacts: input.artifacts,
      requiredKinds,
      allowedKinds: requiredKinds,
      requireBookScopedGraphOutput: true,
      expectedProducerRunIds: { [stage]: producerRunId },
      expectedStageFingerprints: input.expectedStageFingerprints,
      expectedProviderFingerprint: input.expectedProviderFingerprint,
      expectedCorpusContentHash: input.expectedCorpusContentHash,
    });
    if (!validation.isSatisfied) {
      throw new Error(
        "query_ready producer did not produce valid book-scoped artifacts: " +
          JSON.stringify({
            bookId: input.bookId,
            stage,
            producerRunId,
            missingArtifactIds: validation.missingArtifactIds,
            missingArtifactKinds: validation.missingArtifactKinds,
            invalidArtifacts: validation.invalidArtifacts,
          }),
      );
    }
  }
}

export async function assertGraphRagStageArtifactsReady(input: {
  stateRootDir: string;
  bookId: string;
  stage: BookStage;
  producerRunId: string;
  artifacts: readonly BookArtifactManifest[];
  expectedProducerRunIds?: Partial<Record<BookStage, string>>;
  expectedStageFingerprints?: Partial<Record<BookStage, string>>;
  expectedProviderFingerprint?: string;
  expectedCorpusContentHash?: string;
}): Promise<string[]> {
  const requiredKinds = GRAPH_RAG_STAGE_ARTIFACT_REQUIREMENTS[input.stage] ?? [];
  const expectedProducerRunIds = input.stage === "query_ready"
    ? input.expectedProducerRunIds
    : { [input.stage]: input.producerRunId };
  if (input.stage === "query_ready") {
    if (
      expectedProducerRunIds?.graph_extract == null ||
      expectedProducerRunIds?.community_report == null ||
      expectedProducerRunIds?.embed == null
    ) {
      throw new Error(
        "query_ready artifact readiness requires completed GraphRAG producer run ids",
      );
    }
    if (
      input.expectedStageFingerprints?.graph_extract == null ||
      input.expectedStageFingerprints?.community_report == null ||
      input.expectedStageFingerprints?.embed == null ||
      input.expectedProviderFingerprint == null ||
      input.expectedCorpusContentHash == null
    ) {
      throw new Error(
        "query_ready artifact readiness requires producer lineage fingerprints",
      );
    }
    await assertQueryReadyProducerArtifacts({
      stateRootDir: input.stateRootDir,
      bookId: input.bookId,
      artifacts: input.artifacts,
      expectedProducerRunIds,
      expectedStageFingerprints: input.expectedStageFingerprints,
      expectedProviderFingerprint: input.expectedProviderFingerprint,
      expectedCorpusContentHash: input.expectedCorpusContentHash,
    });
  }
  const stageArtifacts = gateArtifactsForStageReadiness({
    artifacts: input.artifacts,
    stage: input.stage,
    producerRunId: input.producerRunId,
    requiredKinds,
    expectedProducerRunIds,
  });
  const validation = await selectValidBookArtifactsByKind({
    graphVault: input.stateRootDir,
    bookId: input.bookId,
    artifacts: stageArtifacts,
    requiredKinds,
    allowedKinds: requiredKinds,
    requireBookScopedGraphOutput: input.stage === "query_ready" ||
      requiredKinds.some((kind) =>
        kind === "graphrag_community_reports_parquet" ||
        kind === "lancedb_index" ||
        kind.startsWith("graphrag_")
      ),
    expectedProducerRunIds,
    expectedStageFingerprints: input.expectedStageFingerprints,
    expectedProviderFingerprint: input.expectedProviderFingerprint,
    expectedCorpusContentHash: input.expectedCorpusContentHash,
  });
  if (!validation.isSatisfied) {
    throw new Error(
      "GraphRAG stage did not produce valid book-scoped artifacts: " +
        JSON.stringify({
          bookId: input.bookId,
          stage: input.stage,
          producerRunId: input.producerRunId,
          missingArtifactIds: validation.missingArtifactIds,
          missingArtifactKinds: validation.missingArtifactKinds,
          invalidArtifacts: validation.invalidArtifacts,
        }),
    );
  }
  return validation.artifactIds;
}

export async function syncGraphRagBookWorkspace(
  input: SyncGraphRagBookWorkspaceInput,
): Promise<GraphRagBookWorkspaceState> {
  const repo = new FileBookJobStateRepository(input.stateRootDir);
  const sourcePath = resolve(input.sourcePath);
  const sourceIdentityPath = input.sourceIdentityPath ?? basename(sourcePath);
  const incomingNormalizedPath = resolve(input.normalizedPath);
  const bootstrapRunId = createRunId("bootstrap");
  const settingsPath = resolve(input.settingsPath);

  const settingsProjectionRepair = input.projectConfig == null
    ? undefined
    : await ensureManagedGraphRagSettings({
      config: input.projectConfig,
      settingsPath,
    });

  const [sourceHash, incomingNormalizedContent, promptFingerprint, settings] =
    await Promise.all([
      hashFile(sourcePath),
      readFile(incomingNormalizedPath, "utf8"),
      hashDirectoryContents(resolve(input.promptsDir)),
      parseSettingsFingerprint(settingsPath),
    ]);
  const normalizedContentHash = await hashContent(
    incomingNormalizedContent,
    GRAPHRAG_NORMALIZATION_POLICY_VERSION,
  );
  const bookId = buildBookIdFromSourceHash(sourceIdentityPath, sourceHash);
  await canonicalizeLegacyWorkspaceLayout({
    repo,
    stateRootDir: input.stateRootDir,
    sourceIdentityPath,
    sourceHash,
    bookId,
  });
  const normalizedInput = await materializeNormalizedInputInVault({
    normalizedPath: incomingNormalizedPath,
    stateRootDir: input.stateRootDir,
    bookId,
    normalizationPolicyVersion: GRAPHRAG_NORMALIZATION_POLICY_VERSION,
  });
  const normalizedPath = normalizedInput.path;
  if (normalizedInput.contentHash !== normalizedContentHash) {
    throw new Error(
      `materialized normalized input hash mismatch: ${bookId}`,
    );
  }

  const promptFingerprintByStage: Record<BookStage, string> = {
    ingest: createDeterministicHash(["ingest", "no-prompt"]),
    normalize: createDeterministicHash(["normalize", "no-prompt"]),
    graph_extract: createDeterministicHash([
      promptFingerprint,
      "extract_graph.txt",
      "summarize_descriptions.txt",
    ]),
    community_report: createDeterministicHash([
      promptFingerprint,
      "community_report_graph.txt",
      "community_report_text.txt",
    ]),
    embed: createDeterministicHash(["embed", "no-prompt"]),
    query_ready: createDeterministicHash([
      promptFingerprint,
      "local_search_system_prompt.txt",
      "global_search_map_system_prompt.txt",
      "global_search_reduce_system_prompt.txt",
      "global_search_knowledge_system_prompt.txt",
      "drift_search_system_prompt.txt",
      "drift_search_reduce_prompt.txt",
      "basic_search_system_prompt.txt",
    ]),
  };

  const stageFingerprints = deriveStageFingerprints({
    sourceHash,
    normalizedContentHash,
    promptFingerprintByStage,
    stageConfigFingerprint: settings.stageConfigFingerprint,
    providerBoundaryFingerprint: settings.providerBoundaryFingerprint,
  });
  const vaultSourcePath = await materializeSourceInVault({
    sourcePath,
    sourceHash,
    stateRootDir: input.stateRootDir,
    bookId,
  });
  const job = await repo.registerBookSource({
    sourcePath,
    sourceIdentityPath,
    canonicalSourcePath: repo.relativePath(vaultSourcePath),
    normalizedPath: repo.relativePath(normalizedPath),
    normalizedContentHash,
    normalizationPolicyVersion: GRAPHRAG_NORMALIZATION_POLICY_VERSION,
    configFingerprint: settings.configFingerprint,
    promptFingerprint,
    modelFingerprint: settings.modelFingerprint,
    stageFingerprints,
    providerFingerprint: settings.providerBoundaryFingerprint,
    metadata: {
      sourceIdentityPath,
      sourcePath: repo.relativePath(vaultSourcePath),
      sourceName: stripKnownBookExtension(sourceIdentityPath),
      providerBoundaryFingerprint: settings.providerBoundaryFingerprint,
      ...(input.metadata ?? {}),
    },
  });

  await recordDocumentChunks({
    repo,
    job,
    normalizedPath,
  });
  if (input.qmdIndexPath != null) {
    await registerQmdCorpusDocument({
      repo,
      qmdIndexPath: input.qmdIndexPath,
      stateRootDir: input.stateRootDir,
      job,
      normalizedPath,
    });
  }

  const outputDir = graphRagBookOutputDir({
    stateRootDir: input.stateRootDir,
    bookId: job.bookId,
  });
  await writeLanceDbRowCountSidecars(join(outputDir, "lancedb"));
  const outputProducerManifest = await readOutputProducerManifest(outputDir);
  const expectedOutputProducer = outputProducerMatches({
    manifest: outputProducerManifest,
    bookId: job.bookId,
    sourceHash,
    documentId: job.documentId,
    contentHash: normalizedContentHash,
    stageFingerprints,
    providerFingerprint: settings.providerBoundaryFingerprint,
    outputDir,
  })
    ? outputProducerManifest
    : null;

  const artifacts = await collectWorkspaceArtifacts(
    { ...input, normalizedPath, outputDir },
    vaultSourcePath,
    bootstrapRunId,
    stageFingerprints,
    settings.providerBoundaryFingerprint,
    expectedOutputProducer,
    normalizedContentHash,
  );
  const recordedArtifacts = await repo.recordArtifacts(job.bookId, artifacts);
  const byStage = groupArtifactsByStage(recordedArtifacts);
  const hasQueryReadyArtifacts = hasKinds(byStage.get("community_report") ?? [], [
    "graphrag_community_reports_parquet",
  ]) && hasKinds(byStage.get("embed") ?? [], ["lancedb_index"]);
  if (hasQueryReadyArtifacts && input.qmdIndexPath == null) {
    throw new Error(
      "qmd corpus registration is required before publishing query_ready capability",
    );
  }
  await recordGraphTextUnitIdentityIfAvailable({
    repo,
    job,
    normalizedPath: repo.relativePath(normalizedPath),
    outputDir,
    required: hasQueryReadyArtifacts,
  });

  if (input.recordRecoveredStages !== false) {
    await bootstrapRecoveredStages({
      repo,
      bookId: job.bookId,
      stageFingerprints,
      artifacts: recordedArtifacts,
      bootstrapRunId,
      highCostStages: false,
    });
  }

  const resumePlan = await repo.getResumePlan(
    job.bookId,
    stageFingerprints,
    GRAPH_RAG_STAGE_ARTIFACT_REQUIREMENTS,
  );
  return {
    job,
    artifacts: await repo.listArtifacts(job.bookId),
    stageFingerprints,
    resumePlan,
    bootstrapRunId,
    settingsProjectionRepair,
  };
}
