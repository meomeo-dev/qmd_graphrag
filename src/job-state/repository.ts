import {
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";

import {
  BookArtifactManifestListSchema,
  BookArtifactManifestSchema,
  BookJobCatalogSchema,
  BookJobStageCheckpointSchema,
  BookJobCheckpointListSchema,
  BookJobRunCatalogSchema,
  BookJobRunCatalogEntrySchema,
  BookJobRunRecordSchema,
  BookJobSchema,
  BookResumePlanSchema,
  BookStageOrder,
  type BookArtifactKind,
  type BookArtifactManifest,
  type BookArtifactManifestList,
  type BookJob,
  type BookJobCatalog,
  type BookJobCheckpointList,
  type BookJobRunCatalog,
  type BookJobRunRecord,
  type BookJobStageCheckpoint,
  type BookResumePlan,
  type BookResumeStageState,
  type BookStage,
  type StageCheckpointStatus,
} from "../contracts/book-job.js";
import { SchemaVersion, type JsonValue } from "../contracts/common.js";
import {
  DocumentIdentityMapSchema,
  DocumentIdentityCatalogSchema,
  GraphTextUnitIdentityMapSchema,
  SourceDocumentSchema,
  SourceDocumentCatalogSchema,
  type DocumentIdentityCatalog,
  type GraphTextUnitIdentityMap,
  type SourceDocumentCatalog,
} from "../contracts/corpus.js";
import {
  buildBookIdFromSourceHash,
  buildDocumentId,
  createDeterministicHash,
  createRunId,
  hashFile,
  toIsoTimestamp,
} from "./fingerprint.js";
import {
  readYamlFileDurable,
  readYamlFileDurableUnlocked,
  updateYamlFileDurable,
  updateYamlUnknownDurable,
  writeYamlFileDurable,
  writeYamlFileDurableUnlocked,
} from "./durable-state-store.js";
import {
  GraphEnhancementRequestSchema,
  GraphEnhancementStateSchema,
  type GraphEnhancementRequest,
  type GraphEnhancementState,
} from "../contracts/graph-enhancement.js";
import { recordGraphCapability } from "../graphrag/capability-catalog.js";
import {
  assertBookArtifactPath,
  assertBookPackageInputPath,
  assertBookPackageSourcePath,
} from "../graphrag/book-package-path-policy.js";
import {
  hasAbsolutePathSyntax,
  isPortableVaultRelativePath,
  normalizePortableVaultRelativePath,
} from "../vault/path.js";
import {
  GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  GRAPH_EXTRACT_ARTIFACT_KINDS,
  QUERY_READY_ARTIFACT_KINDS,
  selectValidBookArtifactsByKind,
  validateArtifact,
  validateBookArtifactSet,
} from "./artifact-validation.js";
import {
  sanitizeVaultMetadata,
  sanitizeVaultText,
} from "../vault/metadata.js";
import {
  isDocumentIdentityMatch,
  selectDocumentIdentityForFencedWrite,
} from "./document-identity-selection.js";

const EMPTY_BOOK_CATALOG: BookJobCatalog = {
  schemaVersion: SchemaVersion,
  items: [],
};

const EMPTY_RUN_CATALOG: BookJobRunCatalog = {
  schemaVersion: SchemaVersion,
  items: [],
};

const EMPTY_CHECKPOINT_LIST: BookJobCheckpointList = {
  schemaVersion: SchemaVersion,
  items: [],
};

const EMPTY_ARTIFACT_LIST: BookArtifactManifestList = {
  schemaVersion: SchemaVersion,
  items: [],
};

const EMPTY_SOURCE_DOCUMENT_CATALOG: SourceDocumentCatalog = {
  schemaVersion: SchemaVersion,
  items: [],
};

const EMPTY_DOCUMENT_IDENTITY_CATALOG: DocumentIdentityCatalog = {
  schemaVersion: SchemaVersion,
  items: [],
};

const NormalizationPolicyVersion = "graphrag-normalized-markdown-v1";

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

const SINGLETON_ARTIFACT_KINDS = new Set<BookArtifactKind>([
  "source_epub",
  "normalized_markdown",
  "graphrag_documents_parquet",
  "graphrag_text_units_parquet",
  "graphrag_entities_parquet",
  "graphrag_relationships_parquet",
  "graphrag_communities_parquet",
  "graphrag_context_json",
  "graphrag_stats_json",
  "graphrag_community_reports_parquet",
  "lancedb_index",
  "index_log",
  "query_snapshot",
]);

const HIGH_COST_STAGES = new Set<BookStage>([
  "graph_extract",
  "community_report",
  "embed",
  "query_ready",
]);

function buildDefaultStageFingerprints(input: {
  configFingerprint: string;
  promptFingerprint: string;
  modelFingerprint: string;
  normalizationPolicyVersion: string;
}): StageFingerprintMap {
  return Object.fromEntries(
    BookStageOrder.map((stage) => [
      stage,
      createDeterministicHash([
        "stage",
        stage,
        input.configFingerprint,
        input.promptFingerprint,
        input.modelFingerprint,
        input.normalizationPolicyVersion,
      ]),
    ]),
  ) as StageFingerprintMap;
}

function buildDefaultProviderFingerprint(input: {
  configFingerprint: string;
  modelFingerprint: string;
}): string {
  return createDeterministicHash([
    "provider",
    input.configFingerprint,
    input.modelFingerprint,
  ]);
}

export type RegisterBookSourceInput = {
  sourcePath: string;
  sourceIdentityPath?: string;
  canonicalSourcePath?: string;
  normalizedPath?: string;
  normalizedContentHash?: string;
  normalizationPolicyVersion?: string;
  configFingerprint: string;
  promptFingerprint: string;
  modelFingerprint: string;
  stageFingerprints?: StageFingerprintMap;
  providerFingerprint?: string;
  metadata?: Record<string, JsonValue>;
};

export type RecordArtifactInput = {
  artifactId?: string;
  stage: BookStage;
  kind: BookArtifactKind;
  path: string;
  contentHash: string;
  stageFingerprint?: string;
  providerFingerprint?: string;
  normalizationPolicyVersion?: string;
  producerRunId: string;
  metadata?: Record<string, JsonValue>;
};

export type RecordGraphTextUnitIdentityInput = GraphTextUnitIdentityMap;

export type RecordDocumentChunksInput = {
  documentId: string;
  contentHash: string;
  chunkIds: string[];
};

export type RecordQmdCorpusRegistrationInput = {
  documentId: string;
  contentHash: string;
  collection: string;
  relativePath: string;
  metadata?: Record<string, JsonValue>;
};

export type StartStageInput = {
  bookId: string;
  stage: BookStage;
  runId: string;
  inputFingerprint: string;
  contentHash?: string;
  stageFingerprint?: string;
  providerFingerprint?: string;
  metadata?: Record<string, JsonValue>;
};

export type CompleteStageInput = {
  bookId: string;
  stage: BookStage;
  runId: string;
  inputFingerprint: string;
  contentHash?: string;
  stageFingerprint?: string;
  providerFingerprint?: string;
  artifactIds?: string[];
  metadata?: Record<string, JsonValue>;
};

export type FailStageInput = {
  bookId: string;
  stage: BookStage;
  runId: string;
  inputFingerprint: string;
  errorSummary: string;
  contentHash?: string;
  stageFingerprint?: string;
  providerFingerprint?: string;
  artifactIds?: string[];
  metadata?: Record<string, JsonValue>;
};

export type StageFingerprintMap = Partial<Record<BookStage, string>>;

export type StageArtifactRequirementMap = Partial<
  Record<BookStage, readonly BookArtifactKind[]>
>;

export type BuildGraphEnhancementRequestInput = {
  bookId: string;
  requestId?: string;
  methods?: Array<"local" | "global" | "drift" | "basic">;
  graphVault?: string;
  metadata?: Record<string, JsonValue>;
};

type WriteStageCheckpointInput = {
  bookId: string;
  stage: BookStage;
  runId: string;
  inputFingerprint: string;
  status: StageCheckpointStatus;
  contentHash?: string;
  stageFingerprint?: string;
  providerFingerprint?: string;
  artifactIds?: string[];
  errorSummary?: string;
  metadata?: Record<string, JsonValue>;
};

type BatchBookLease = {
  runId: string;
  bookId: string;
  generation: number;
  fencingToken: string;
  runnerSessionId: string;
  runnerHost: string;
  runnerPid: number;
  expiresAt: string;
};

type BookJobRunCatalogEntry = BookJobRunCatalog["items"][number];

const MaxAbandonRunningRunRecords = 50;

function stageIndex(stage: BookStage): number {
  return BookStageOrder.indexOf(stage);
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function readYamlFile<T>(
  path: string,
  schema: { parse(input: unknown): T },
  fallback: T,
): Promise<T> {
  return readYamlFileDurable(path, schema, fallback);
}

async function readYamlFileUnlocked<T>(
  path: string,
  schema: { parse(input: unknown): T },
  fallback: T,
): Promise<T> {
  return readYamlFileDurableUnlocked(path, schema, fallback);
}

async function readBookJobCatalogFile(path: string): Promise<BookJobCatalog> {
  return updateYamlUnknownDurable(
    path,
    () => readYamlFileUnlocked(
      path,
      BookJobCatalogSchema,
      EMPTY_BOOK_CATALOG,
    ),
    (current) => current,
  );
}

async function writeYamlFile(path: string, value: unknown): Promise<void> {
  await writeYamlFileDurable(path, value);
}

async function writeYamlFileUnlocked(
  path: string,
  value: unknown,
): Promise<void> {
  await writeYamlFileDurableUnlocked(path, value);
}

async function updateYamlFile<T>(
  path: string,
  schema: { parse(input: unknown): T },
  fallback: T,
  update: (current: T) => T | Promise<T>,
): Promise<T> {
  return updateYamlFileDurable(path, schema, fallback, update);
}

async function updateBookJobCatalogFile(
  path: string,
  update: (current: BookJobCatalog) => BookJobCatalog | Promise<BookJobCatalog>,
): Promise<BookJobCatalog> {
  return updateYamlUnknownDurable(
    path,
    () => readYamlFileUnlocked(
      path,
      BookJobCatalogSchema,
      EMPTY_BOOK_CATALOG,
    ),
    update,
  );
}

function dedupeArtifacts(
  items: BookArtifactManifest[],
): BookArtifactManifest[] {
  const byLogicalKey = new Map<string, BookArtifactManifest>();
  for (const item of items) {
    const logicalKey = createArtifactLogicalKey(item);
    const existing = byLogicalKey.get(logicalKey);
    if (
      existing == null ||
      item.createdAt.localeCompare(existing.createdAt) >= 0
    ) {
      byLogicalKey.set(logicalKey, item);
    }
  }
  return [...byLogicalKey.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function createArtifactLogicalKey(input: {
  bookId: string;
  stage: BookStage;
  kind: BookArtifactKind;
  contentHash: string;
  stageFingerprint?: string;
  providerFingerprint?: string;
  metadata?: Record<string, JsonValue>;
}): string {
  const stageFingerprint =
    input.stageFingerprint ?? metadataString(input.metadata, "stageFingerprint");
  const providerFingerprint =
    input.providerFingerprint ?? metadataString(input.metadata, "providerFingerprint");
  return createDeterministicHash([
    input.bookId,
    input.stage,
    input.kind,
    input.contentHash,
    stageFingerprint ?? null,
    providerFingerprint ?? null,
  ]);
}

function createArtifactId(input: {
  bookId: string;
  stage: BookStage;
  kind: BookArtifactKind;
  contentHash: string;
  stageFingerprint?: string;
  providerFingerprint?: string;
  metadata?: Record<string, JsonValue>;
}): string {
  return createArtifactLogicalKey(input);
}

function assertHighCostFingerprint(input: {
  subject: string;
  stage: BookStage;
  contentHash?: string;
  stageFingerprint?: string;
  providerFingerprint?: string;
}): void {
  if (!HIGH_COST_STAGES.has(input.stage)) return;
  const missing = [
    input.contentHash ? null : "contentHash",
    input.stageFingerprint ? null : "stageFingerprint",
    input.providerFingerprint ? null : "providerFingerprint",
  ].filter((item): item is string => item != null);
  if (missing.length === 0) return;
  throw new Error(
    `${input.subject} for high-cost stage ${input.stage} requires ${missing.join(", ")}`,
  );
}

function mergeJobMetadata(
  existing?: Record<string, JsonValue>,
  incoming?: Record<string, JsonValue>,
): Record<string, JsonValue> | undefined {
  const metadata: Record<string, JsonValue> = sanitizeVaultMetadata({
    ...(existing ?? {}),
    ...(incoming ?? {}),
  }) ?? {};
  delete metadata.workspaceRoot;
  delete metadata.originalSourcePath;
  for (const key of Object.keys(metadata)) {
    if (metadata[key] === undefined) {
      delete metadata[key];
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function preserveMetadataKeys(
  metadata: Record<string, JsonValue> | undefined,
  preserved: Record<string, JsonValue> | undefined,
  keys: readonly string[],
): Record<string, JsonValue> | undefined {
  if (metadata == null || preserved == null) return metadata;
  const next = { ...metadata };
  for (const key of keys) {
    if (preserved[key] !== undefined) {
      next[key] = preserved[key];
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function mergeStringLists(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])];
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function sameDocumentContentIdentity(
  item: DocumentIdentityCatalog["items"][number],
  input: {
    sourceId: string;
    sourceHash: string;
    documentId: string;
    contentHash: string;
  },
): boolean {
  return item.sourceId === input.sourceId &&
    item.sourceHash === input.sourceHash &&
    item.documentId === input.documentId &&
    item.contentHash === input.contentHash;
}

function mergeDocumentIdentityMaps(
  left: DocumentIdentityCatalog["items"][number],
  right: DocumentIdentityCatalog["items"][number],
): DocumentIdentityCatalog["items"][number] {
  const leftGraphCount = left.graphTextUnitIds?.length ?? 0;
  const rightGraphCount = right.graphTextUnitIds?.length ?? 0;
  const graphSource = leftGraphCount >= rightGraphCount ? left : right;
  const mergedMetadata = mergeJobMetadata(left.metadata, right.metadata);
  const preservedMetadata = preserveMetadataKeys(
    mergedMetadata,
    left.metadata,
    [
      "qmdCorpusRegistered",
      "qmdCollection",
      "qmdRelativePath",
      "qmdChunkCount",
      "graphDocumentId",
      "graphTextUnitCount",
    ],
  );
  return DocumentIdentityMapSchema.parse({
    ...left,
    normalizedPath: left.normalizedPath ?? right.normalizedPath,
    chunkIds: mergeStringLists(left.chunkIds, right.chunkIds) ?? [],
    ...(graphSource.graphDocumentId
      ? { graphDocumentId: graphSource.graphDocumentId }
      : {}),
    ...(graphSource.graphTextUnitIds
      ? { graphTextUnitIds: graphSource.graphTextUnitIds }
      : {}),
    aliases: mergeStringLists(left.aliases, [
      ...(right.aliases ?? []),
      right.normalizedPath ?? "",
      left.normalizedPath ?? "",
    ].filter((item) => item.length > 0)),
    metadata: preservedMetadata,
  });
}

function dedupeDocumentIdentityMaps(
  items: DocumentIdentityCatalog["items"],
): DocumentIdentityCatalog["items"] {
  const byIdentity = new Map<string, DocumentIdentityCatalog["items"][number]>();
  for (const item of items) {
    const key = [
      item.canonicalBookId ?? "",
      item.sourceId,
      item.sourceHash,
      item.documentId,
      item.contentHash,
    ].join("\0");
    const existing = byIdentity.get(key);
    byIdentity.set(
      key,
      existing == null ? item : mergeDocumentIdentityMaps(existing, item),
    );
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.documentId.localeCompare(right.documentId),
  );
}

function metadataString(
  metadata: Record<string, JsonValue> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function upsertCheckpoint(
  items: BookJobStageCheckpoint[],
  checkpoint: BookJobStageCheckpoint,
): BookJobStageCheckpoint[] {
  const existing = items.filter((item) => item.stage !== checkpoint.stage);
  existing.push(checkpoint);
  return existing.sort((left, right) =>
    stageIndex(left.stage) - stageIndex(right.stage),
  );
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readBatchBookLease(path: string): BatchBookLease | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BatchBookLease;
    if (
      typeof parsed.runId === "string" &&
      typeof parsed.bookId === "string" &&
      typeof parsed.fencingToken === "string" &&
      typeof parsed.runnerSessionId === "string" &&
      typeof parsed.runnerHost === "string" &&
      Number.isInteger(parsed.runnerPid) &&
      Number.isInteger(parsed.generation) &&
      typeof parsed.expiresAt === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function checkpointTimestamp(checkpoint: BookJobStageCheckpoint): string {
  return checkpoint.finishedAt ?? checkpoint.startedAt ?? "";
}

function buildResumePlan(
  bookId: string,
  checkpoints: BookJobStageCheckpoint[],
  fingerprints: StageFingerprintMap,
  artifactValidity: Map<BookStage, ArtifactStageValidity>,
): BookResumePlan {
  const checkpointByStage = new Map(
    checkpoints.map((checkpoint) => [checkpoint.stage, checkpoint]),
  );
  const stageStates: BookResumeStageState[] = [];
  const staleStages = new Set<BookStage>();
  const completedStages: BookStage[] = [];
  let nextStage: BookStage | null = null;

  for (const stage of BookStageOrder) {
    const checkpoint = checkpointByStage.get(stage) ?? null;
    const expectedFingerprint = fingerprints[stage];
    const actualFingerprint = checkpoint?.inputFingerprint;

    let state: BookResumeStageState;
    if (checkpoint == null) {
      state = {
        stage,
        checkpointStatus: null,
        expectedFingerprint,
        actualFingerprint,
        isSatisfied: false,
        reason: "missing",
      };
    } else if (checkpoint.status === "failed") {
      state = {
        stage,
        checkpointStatus: checkpoint.status,
        runId: checkpoint.runId,
        expectedFingerprint,
        actualFingerprint,
        isSatisfied: false,
        reason: "failed",
      };
    } else if (checkpoint.status !== "succeeded") {
      state = {
        stage,
        checkpointStatus: checkpoint.status,
        runId: checkpoint.runId,
        expectedFingerprint,
        actualFingerprint,
        isSatisfied: false,
        reason: "pending",
      };
    } else if (
      expectedFingerprint != null &&
      checkpoint.inputFingerprint !== expectedFingerprint
    ) {
      staleStages.add(stage);
      state = {
        stage,
        checkpointStatus: checkpoint.status,
        runId: checkpoint.runId,
        expectedFingerprint,
        actualFingerprint,
        isSatisfied: false,
        reason: "stale",
      };
    } else if (
      HIGH_COST_STAGES.has(stage) &&
      checkpoint.metadata?.bootstrap === true
    ) {
      staleStages.add(stage);
      state = {
        stage,
        checkpointStatus: checkpoint.status,
        runId: checkpoint.runId,
        expectedFingerprint,
        actualFingerprint,
        isSatisfied: false,
        reason: "stale",
      };
    } else {
      const validity = artifactValidity.get(stage);
      if (validity != null && !validity.isSatisfied) {
        state = {
          stage,
          checkpointStatus: checkpoint.status,
          runId: checkpoint.runId,
          expectedFingerprint,
          actualFingerprint,
          isSatisfied: false,
          reason: "artifact_missing",
          missingArtifactIds: validity.missingArtifactIds,
          missingArtifactKinds: validity.missingArtifactKinds,
          invalidArtifacts: validity.invalidArtifacts,
        };
        stageStates.push(state);
        if (nextStage == null) {
          nextStage = stage;
        }
        continue;
      }

      completedStages.push(stage);
      state = {
        stage,
        checkpointStatus: checkpoint.status,
        runId: checkpoint.runId,
        expectedFingerprint,
        actualFingerprint,
        isSatisfied: true,
        reason: "ready",
      };
    }

    stageStates.push(state);
    if (nextStage == null && !state.isSatisfied) {
      nextStage = stage;
    }
  }

  if (nextStage != null) {
    for (const stage of BookStageOrder) {
      if (stageIndex(stage) > stageIndex(nextStage)) {
        const checkpoint = checkpointByStage.get(stage);
        if (checkpoint?.status === "succeeded") {
          staleStages.add(stage);
        }
      }
    }
  }

  return BookResumePlanSchema.parse({
    schemaVersion: SchemaVersion,
    bookId,
    nextStage,
    canQuery: nextStage === null,
    staleStages: [...staleStages],
    completedStages,
    stageStates,
  });
}

function isRealGraphQueryProducerCheckpoint(
  checkpoint: BookJobStageCheckpoint | undefined,
): checkpoint is BookJobStageCheckpoint & { runId: string } {
  return checkpoint?.status === "succeeded" &&
    checkpoint.metadata?.bootstrap !== true &&
    typeof checkpoint.runId === "string" &&
    checkpoint.runId.length > 0;
}

function producerRunIdsForQueryReady(
  checkpointByStage: ReadonlyMap<BookStage, BookJobStageCheckpoint>,
): Partial<Record<BookStage, string>> | undefined {
  const graphExtract = checkpointByStage.get("graph_extract");
  const communityReport = checkpointByStage.get("community_report");
  const embed = checkpointByStage.get("embed");
  if (
    !isRealGraphQueryProducerCheckpoint(graphExtract) ||
    !isRealGraphQueryProducerCheckpoint(communityReport) ||
    !isRealGraphQueryProducerCheckpoint(embed)
  ) {
    return undefined;
  }
  return {
    graph_extract: graphExtract.runId,
    community_report: communityReport.runId,
    embed: embed.runId,
  };
}

function expectedCheckpointContentHash(
  job: BookJob | null | undefined,
  stage: BookStage,
): string | undefined {
  if (job == null) return undefined;
  if (stage === "ingest") return job.sourceHash;
  return job.normalizedContentHash ?? job.sourceHash;
}

function filterArtifactIdsByKinds(
  artifactIds: readonly string[],
  artifacts: readonly BookArtifactManifest[],
  kinds: readonly BookArtifactKind[],
): string[] {
  const kindSet = new Set<BookArtifactKind>(kinds);
  return artifactIds.filter((artifactId) => {
    const artifact = artifacts.find((candidate) =>
      candidate.artifactId === artifactId
    );
    return artifact != null && kindSet.has(artifact.kind);
  });
}

type ArtifactStageValidity = {
  isSatisfied: boolean;
  artifactIds: string[];
  missingArtifactIds: string[];
  missingArtifactKinds: BookArtifactKind[];
  invalidArtifacts: Array<{
    artifactId: string;
    kind: BookArtifactKind;
    path: string;
    reason: string;
  }>;
};

function runRecordToStageCheckpoint(
  record: BookJobRunRecord,
  job: BookJob | null,
): BookJobStageCheckpoint | null {
  const contentHash = expectedCheckpointContentHash(job, record.stage);
  const stageFingerprint =
    metadataString(record.metadata, "stageFingerprint") ??
    job?.stageFingerprints?.[record.stage] ??
    record.inputFingerprint;
  const providerFingerprint =
    metadataString(record.metadata, "providerFingerprint") ??
    job?.providerFingerprint;
  try {
    return BookJobStageCheckpointSchema.parse({
      schemaVersion: SchemaVersion,
      bookId: record.bookId,
      stage: record.stage,
      status: record.status,
      attemptCount: record.attemptCount,
      runId: record.runId,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      inputFingerprint: record.inputFingerprint,
      contentHash,
      stageFingerprint,
      providerFingerprint,
      artifactIds: record.artifactIds,
      errorSummary: record.errorSummary,
      metadata: record.metadata,
    });
  } catch {
    return null;
  }
}

function checkpointCandidateKey(checkpoint: BookJobStageCheckpoint): string {
  return [
    checkpoint.stage,
    checkpoint.runId ?? "",
    checkpoint.status,
    checkpoint.inputFingerprint,
    checkpoint.startedAt ?? "",
    checkpoint.finishedAt ?? "",
  ].join("\0");
}

function sortNewestCheckpoints(
  checkpoints: readonly BookJobStageCheckpoint[],
): BookJobStageCheckpoint[] {
  return [...checkpoints].sort((left, right) =>
    checkpointTimestamp(right).localeCompare(checkpointTimestamp(left)),
  );
}

function runCatalogEntryTimestamp(entry: BookJobRunCatalogEntry): string {
  return entry.finishedAt ?? entry.startedAt;
}

function sortNewestRunCatalogEntries(
  entries: readonly BookJobRunCatalogEntry[],
): BookJobRunCatalogEntry[] {
  return [...entries].sort((left, right) =>
    runCatalogEntryTimestamp(right).localeCompare(runCatalogEntryTimestamp(left))
  );
}

function checkpointRunIds(
  checkpoints: readonly BookJobStageCheckpoint[],
): string[] {
  const runIds = new Set<string>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.runId != null) {
      runIds.add(checkpoint.runId);
    }
  }
  return [...runIds];
}

function currentCheckpointBlocksRecoveredCandidate(
  checkpoint: BookJobStageCheckpoint | undefined,
): boolean {
  return checkpoint != null &&
    HIGH_COST_STAGES.has(checkpoint.stage) &&
    checkpoint.status !== "succeeded";
}

export class FileBookJobStateRepository {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  get catalogDir(): string {
    return join(this.rootDir, "catalog");
  }

  get booksDir(): string {
    return join(this.rootDir, "books");
  }

  async ensureLayout(): Promise<void> {
    await ensureDir(this.catalogDir);
    await ensureDir(this.booksDir);
    await ensureDir(join(this.catalogDir, "runs"));
  }

  private assertBatchBookLease(bookId: string): void {
    const runId = process.env.QMD_GRAPHRAG_RUN_ID;
    const sessionId = process.env.QMD_GRAPHRAG_RUNNER_SESSION_ID;
    const expectedGeneration = parsePositiveInt(
      process.env.QMD_GRAPHRAG_BOOK_LEASE_GENERATION,
    );
    const expectedToken = process.env.QMD_GRAPHRAG_BOOK_FENCING_TOKEN;
    if (
      runId == null ||
      sessionId == null ||
      expectedGeneration == null ||
      expectedToken == null ||
      expectedToken === ""
    ) {
      return;
    }
    const leasePath = join(
      this.rootDir,
      "catalog",
      "batch-runs",
      runId,
      "book-leases",
      `${bookId}.json`,
    );
    const lease = readBatchBookLease(leasePath);
    if (
      lease == null ||
      lease.runId !== runId ||
      lease.bookId !== bookId ||
      lease.runnerSessionId !== sessionId ||
      lease.generation !== expectedGeneration ||
      lease.fencingToken !== expectedToken ||
      Date.parse(lease.expiresAt) <= Date.now()
    ) {
      throw new Error(`book lease fencing rejected stage write: ${bookId}`);
    }
  }

  assertCurrentBatchBookLease(bookId: string): void {
    this.assertBatchBookLease(bookId);
  }

  private async assertBatchBookLeaseForDocument(
    documentId: string,
    contentHash?: string,
  ): Promise<void> {
    const runId = process.env.QMD_GRAPHRAG_RUN_ID;
    const sessionId = process.env.QMD_GRAPHRAG_RUNNER_SESSION_ID;
    const expectedGeneration = parsePositiveInt(
      process.env.QMD_GRAPHRAG_BOOK_LEASE_GENERATION,
    );
    const expectedToken = process.env.QMD_GRAPHRAG_BOOK_FENCING_TOKEN;
    const currentBookId = process.env.QMD_GRAPHRAG_BOOK_ID;
    if (
      runId == null ||
      sessionId == null ||
      expectedGeneration == null ||
      expectedToken == null ||
      expectedToken === ""
    ) {
      return;
    }
    const catalog = await readYamlFile(
      this.documentIdentityCatalogPath(),
      DocumentIdentityCatalogSchema,
      EMPTY_DOCUMENT_IDENTITY_CATALOG,
    );
    const identity = selectDocumentIdentityForFencedWrite({
      catalog,
      documentId,
      contentHash,
      currentBookId,
    });
    if (identity == null || identity.canonicalBookId == null) {
      throw new Error(`document identity not found for fenced write: ${documentId}`);
    }
    this.assertBatchBookLease(identity.canonicalBookId);
  }

  async registerBookSource(input: RegisterBookSourceInput): Promise<BookJob> {
    await this.ensureLayout();
    const sourcePath = resolve(input.sourcePath);
    const sourceIdentityPath = input.sourceIdentityPath ?? basename(sourcePath);
    const sourceHash = await hashFile(sourcePath);
    const now = toIsoTimestamp();
    const bookId = buildBookIdFromSourceHash(sourceIdentityPath, sourceHash);
    this.assertBatchBookLease(bookId);
    const existing = await this.getBookJob(bookId);
    const normalizedPath = input.normalizedPath != null
      ? assertBookPackageInputPath(input.normalizedPath, bookId)
      : input.metadata?.normalizedPath != null
        ? assertBookPackageInputPath(String(input.metadata.normalizedPath), bookId)
        : existing?.normalizedPath;
    const contentHash = input.normalizedContentHash
      ?? existing?.normalizedContentHash
      ?? sourceHash;
    const documentId = buildDocumentId({
      sourceId: `sha256:${sourceHash}`,
      contentHash,
      normalizationPolicyVersion:
        input.normalizationPolicyVersion ??
        existing?.normalizationPolicyVersion ??
        NormalizationPolicyVersion,
    });
    const existingSourcePath = existing?.sourcePath;
    const canonicalSourcePath = input.canonicalSourcePath
      ? await this.materializeSource(
        sourcePath,
        sourceHash,
        bookId,
        assertBookPackageSourcePath(
          input.canonicalSourcePath,
          bookId,
        ),
      )
      : await this.resolveReusableSourcePath(
        sourcePath,
        sourceHash,
        bookId,
        existingSourcePath,
      );

    const normalizationPolicyVersion =
      input.normalizationPolicyVersion ??
      existing?.normalizationPolicyVersion ??
      NormalizationPolicyVersion;
    const stageFingerprints = {
      ...buildDefaultStageFingerprints({
        configFingerprint: input.configFingerprint,
        promptFingerprint: input.promptFingerprint,
        modelFingerprint: input.modelFingerprint,
        normalizationPolicyVersion,
      }),
      ...(existing?.stageFingerprints ?? {}),
      ...(input.stageFingerprints ?? {}),
    };
    const providerFingerprint =
      input.providerFingerprint ??
      existing?.providerFingerprint ??
      buildDefaultProviderFingerprint({
        configFingerprint: input.configFingerprint,
        modelFingerprint: input.modelFingerprint,
      });
    const job = BookJobSchema.parse({
      schemaVersion: SchemaVersion,
      bookId,
      documentId,
      sourcePath: canonicalSourcePath,
      sourceIdentityPath,
      sourceHash,
      normalizedContentHash: input.normalizedContentHash ?? existing?.normalizedContentHash,
      normalizedPath,
      normalizationPolicyVersion,
      configFingerprint: input.configFingerprint,
      promptFingerprint: input.promptFingerprint,
      modelFingerprint: input.modelFingerprint,
      stageFingerprints,
      providerFingerprint,
      currentStage: existing?.currentStage,
      overallStatus: existing?.overallStatus ?? "pending",
      lastSuccessRunId: existing?.lastSuccessRunId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      metadata: mergeJobMetadata(existing?.metadata, {
        ...input.metadata,
        ...(normalizedPath ? { normalizedPath } : {}),
      }),
    });

    await this.upsertBookJob(job);
    await this.upsertSourceDocument(
      job,
      sourceIdentityPath,
      this.absoluteFromRoot(job.sourcePath),
      now,
    );
    await this.upsertDocumentIdentityMap(job);
    await this.removeMatchingLegacyBookRoots(job);
    return job;
  }

  private async materializeSource(
    sourcePath: string,
    sourceHash: string,
    bookId: string,
    targetPathOverride?: string,
  ): Promise<string> {
    const extension = extname(sourcePath) || ".epub";
    const targetRelativePath = targetPathOverride
      ?? normalizePortableVaultRelativePath(
        join("books", bookId, "source", `source${extension}`),
      );
    const targetPath = this.absoluteFromRoot(targetRelativePath);
    await ensureDir(dirname(targetPath));

    try {
      if ((await hashFile(targetPath)) === sourceHash) {
        return targetRelativePath;
      }
    } catch {
      // Missing or unreadable materialized source is replaced below.
    }

    await copyFile(sourcePath, targetPath);
    return targetRelativePath;
  }

  private async resolveReusableSourcePath(
    sourcePath: string,
    sourceHash: string,
    bookId: string,
    existingSourcePath: string | undefined,
  ): Promise<string> {
    const expectedPrefix = `books/${bookId}/source/`;
    if (
      existingSourcePath &&
      isPortableVaultRelativePath(existingSourcePath) &&
      normalizePortableVaultRelativePath(existingSourcePath).startsWith(expectedPrefix)
    ) {
      try {
        if ((await hashFile(this.absoluteFromRoot(existingSourcePath))) === sourceHash) {
          return existingSourcePath;
        }
      } catch {
        // Missing or stale package source locator is rematerialized below.
      }
    }
    return this.materializeSource(sourcePath, sourceHash, bookId);
  }

  private async upsertSourceDocument(
    job: BookJob,
    sourceIdentityPath: string,
    sourcePath: string,
    now: string,
  ): Promise<void> {
    const sourceId = `sha256:${job.sourceHash}`;
    const metadataSourceName = typeof job.metadata?.sourceName === "string"
      ? job.metadata.sourceName
      : undefined;
    const source = SourceDocumentSchema.parse({
      schemaVersion: SchemaVersion,
      sourceId,
      sourceHash: job.sourceHash,
      sourceName: metadataSourceName ?? sourceIdentityPath,
      sourceRelativePath: job.sourcePath,
      locator: {
        relativePath: job.sourcePath,
      },
      mediaType: sourceIdentityPath.toLowerCase().endsWith(".epub")
        ? "application/epub+zip"
        : undefined,
      sizeBytes: (await stat(sourcePath)).size,
      createdAt: now,
      metadata: mergeJobMetadata(job.metadata, {
        bookId: job.bookId,
        sourceIdentityPath: job.sourceIdentityPath,
      }),
    });

    await updateYamlFile(
      this.sourceDocumentCatalogPath(),
      SourceDocumentCatalogSchema,
      EMPTY_SOURCE_DOCUMENT_CATALOG,
      (catalog) => {
        const items = catalog.items.filter((item) =>
          item.metadata?.bookId === job.bookId ||
          item.sourceId !== sourceId ||
          item.sourceHash !== job.sourceHash
        ).filter((item) =>
          item.metadata?.bookId !== job.bookId
        );
        items.push(source);
        items.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
        return { schemaVersion: SchemaVersion, items };
      },
    );
  }

  private async upsertDocumentIdentityMap(job: BookJob): Promise<void> {
    const sourceId = `sha256:${job.sourceHash}`;
    const normalizedPath = job.normalizedPath;
    const contentHash = job.normalizedContentHash ?? job.sourceHash;
    await updateYamlFile(
      this.documentIdentityCatalogPath(),
      DocumentIdentityCatalogSchema,
      EMPTY_DOCUMENT_IDENTITY_CATALOG,
      (catalog) => {
        const matchingIdentities = catalog.items.filter((item) =>
          sameDocumentContentIdentity(item, {
            sourceId,
            sourceHash: job.sourceHash,
            documentId: job.documentId,
            contentHash,
          })
        );
        const existingIdentity = matchingIdentities.find((item) =>
          item.canonicalBookId === job.bookId
        ) ?? matchingIdentities[0];
        const preservesContentIdentity =
          existingIdentity?.sourceId === sourceId &&
          existingIdentity.sourceHash === job.sourceHash &&
          existingIdentity.contentHash === contentHash;
        const aliases = [
          ...(existingIdentity?.aliases ?? []),
          existingIdentity?.normalizedPath ?? null,
          job.sourceIdentityPath,
          metadataString(job.metadata, "sourceIdentityPath") ?? null,
          metadataString(job.metadata, "sourceName") ?? null,
          normalizedPath,
        ].filter((value): value is string => !!value);
        const metadata = mergeJobMetadata(
          preservesContentIdentity ? existingIdentity.metadata : undefined,
          {
            ...job.metadata,
            bookId: job.bookId,
            sourceIdentityPath: job.sourceIdentityPath,
            normalizedPath: normalizedPath ?? null,
          },
        );
        const preservedProjectionMetadata = preserveMetadataKeys(
          metadata,
          preservesContentIdentity ? existingIdentity.metadata : undefined,
          [
            "qmdCorpusRegistered",
            "qmdCollection",
            "qmdRelativePath",
            "qmdChunkCount",
            "graphDocumentId",
            "graphTextUnitCount",
          ],
        );
        const identity = DocumentIdentityMapSchema.parse({
          schemaVersion: SchemaVersion,
          sourceId,
          sourceHash: job.sourceHash,
          canonicalBookId: job.bookId,
          documentId: job.documentId,
          contentHash,
          normalizationPolicyVersion:
            job.normalizationPolicyVersion ?? NormalizationPolicyVersion,
          normalizedPath,
          chunkIds: preservesContentIdentity ? existingIdentity.chunkIds : [],
          ...(preservesContentIdentity && existingIdentity.graphDocumentId
            ? { graphDocumentId: existingIdentity.graphDocumentId }
            : {}),
          ...(preservesContentIdentity && existingIdentity.graphTextUnitIds
            ? { graphTextUnitIds: existingIdentity.graphTextUnitIds }
            : {}),
          aliases: [...new Set(aliases)],
          metadata: preservedProjectionMetadata,
        });
        const items = catalog.items.filter((item) =>
          !sameDocumentContentIdentity(item, {
            sourceId,
            sourceHash: job.sourceHash,
            documentId: job.documentId,
            contentHash,
          })
        );
        const mergedIdentity = matchingIdentities.reduce(
          (current, item) => mergeDocumentIdentityMaps(current, {
            ...item,
            canonicalBookId: job.bookId,
          }),
          identity,
        );
        items.push(DocumentIdentityMapSchema.parse({
          ...mergedIdentity,
          canonicalBookId: job.bookId,
          metadata: mergeJobMetadata(mergedIdentity.metadata, {
            bookId: job.bookId,
            sourceIdentityPath: job.sourceIdentityPath,
            normalizedPath: normalizedPath ?? null,
          }),
        }));
        items.sort((left, right) =>
          left.documentId.localeCompare(right.documentId)
        );
        return { schemaVersion: SchemaVersion, items };
      },
    );
  }

  async recordGraphTextUnitIdentity(
    input: RecordGraphTextUnitIdentityInput,
  ): Promise<void> {
    await this.ensureLayout();
    const parsed = GraphTextUnitIdentityMapSchema.parse(input);
    this.assertBatchBookLease(parsed.bookId);
    await updateYamlFile(
      this.documentIdentityCatalogPath(),
      DocumentIdentityCatalogSchema,
      EMPTY_DOCUMENT_IDENTITY_CATALOG,
      (catalog) => {
        const items = catalog.items.map((item) => {
          const matchesIdentity =
            item.canonicalBookId === parsed.bookId &&
            item.sourceId === parsed.sourceId &&
            item.sourceHash === parsed.sourceHash &&
            item.documentId === parsed.documentId &&
            item.contentHash === parsed.contentHash;
          if (!matchesIdentity) return item;
          return DocumentIdentityMapSchema.parse({
            ...item,
            normalizedPath: parsed.normalizedPath,
            graphDocumentId: parsed.graphDocumentId,
            graphTextUnitIds: parsed.graphTextUnitIds,
            metadata: mergeJobMetadata(item.metadata, {
              graphDocumentId: parsed.graphDocumentId,
              graphTextUnitCount: parsed.graphTextUnitIds.length,
            }),
          });
        });
        const matched = items.some((item) =>
          item.canonicalBookId === parsed.bookId &&
          item.sourceId === parsed.sourceId &&
          item.sourceHash === parsed.sourceHash &&
          item.documentId === parsed.documentId &&
          item.contentHash === parsed.contentHash &&
          item.graphDocumentId === parsed.graphDocumentId
        );
        if (!matched) {
          throw new Error(
            `document identity not found for graph text units: ${
              parsed.documentId
            }`,
          );
        }
        return { schemaVersion: SchemaVersion, items };
      },
    );
  }

  async recordDocumentChunks(input: RecordDocumentChunksInput): Promise<void> {
    await this.ensureLayout();
    await this.assertBatchBookLeaseForDocument(input.documentId, input.contentHash);
    const currentBookId = process.env.QMD_GRAPHRAG_BOOK_ID;
    if (input.chunkIds.length === 0) {
      throw new Error(`document chunks cannot be empty: ${input.documentId}`);
    }
    await updateYamlFile(
      this.documentIdentityCatalogPath(),
      DocumentIdentityCatalogSchema,
      EMPTY_DOCUMENT_IDENTITY_CATALOG,
      (catalog) => {
        let matched = false;
        const items = catalog.items.map((item) => {
          const matchesIdentity = isDocumentIdentityMatch(item, {
            documentId: input.documentId,
            contentHash: input.contentHash,
            currentBookId,
          });
          if (!matchesIdentity) return item;
          matched = true;
          return DocumentIdentityMapSchema.parse({
            ...item,
            chunkIds: input.chunkIds,
            metadata: mergeJobMetadata(item.metadata, {
              qmdChunkCount: input.chunkIds.length,
            }),
          });
        });
        if (!matched) {
          throw new Error(
            `document identity not found for chunks: ${input.documentId}`,
          );
        }
        return { schemaVersion: SchemaVersion, items };
      },
    );
  }

  async recordQmdCorpusRegistration(
    input: RecordQmdCorpusRegistrationInput,
  ): Promise<void> {
    await this.ensureLayout();
    await this.assertBatchBookLeaseForDocument(input.documentId, input.contentHash);
    const currentBookId = process.env.QMD_GRAPHRAG_BOOK_ID;
    const relativePath = normalizePortableVaultRelativePath(input.relativePath);
    await updateYamlFile(
      this.documentIdentityCatalogPath(),
      DocumentIdentityCatalogSchema,
      EMPTY_DOCUMENT_IDENTITY_CATALOG,
      (catalog) => {
        let matched = false;
        const items = catalog.items.map((item) => {
          const matchesIdentity = isDocumentIdentityMatch(item, {
            documentId: input.documentId,
            contentHash: input.contentHash,
            currentBookId,
          });
          if (!matchesIdentity) return item;
          matched = true;
          return DocumentIdentityMapSchema.parse({
            ...item,
            metadata: mergeJobMetadata(item.metadata, {
              qmdCorpusRegistered: true,
              qmdCollection: input.collection,
              qmdRelativePath: relativePath,
              ...(input.metadata ?? {}),
            }),
          });
        });
        if (!matched) {
          throw new Error(
            `document identity not found for qmd corpus registration: ${
              input.documentId
            }`,
          );
        }
        return { schemaVersion: SchemaVersion, items };
      },
    );
  }

  async upsertBookJob(job: BookJob): Promise<BookJob> {
    await this.ensureLayout();
    const parsed = BookJobSchema.parse({
      ...job,
      sourcePath: assertBookPackageSourcePath(job.sourcePath, job.bookId),
      sourceIdentityPath: job.sourceIdentityPath,
      normalizedPath: job.normalizedPath == null
        ? undefined
        : assertBookPackageInputPath(job.normalizedPath, job.bookId),
      metadata: sanitizeVaultMetadata(job.metadata),
    });
    this.assertBatchBookLease(parsed.bookId);
    await writeYamlFile(this.bookJobPath(parsed.bookId), parsed);

    await updateBookJobCatalogFile(this.bookCatalogPath(), (catalog) => {
      const items = catalog.items.filter((item) =>
        item.bookId === parsed.bookId ||
        item.sourceHash !== parsed.sourceHash ||
        item.documentId !== parsed.documentId ||
        (item.normalizedContentHash ?? item.sourceHash) !==
          (parsed.normalizedContentHash ?? parsed.sourceHash)
      ).filter((item) => item.bookId !== parsed.bookId);
      items.push(parsed);
      items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { schemaVersion: SchemaVersion, items };
    });

    return parsed;
  }

  async getBookJob(bookId: string): Promise<BookJob | null> {
    return readYamlFile(
      this.bookJobPath(bookId),
      BookJobSchema,
      null,
    );
  }

  private async removeMatchingLegacyBookRoots(job: BookJob): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.booksDir);
    } catch {
      return;
    }
    const catalog = await readBookJobCatalogFile(this.bookCatalogPath());
    const catalogBookIds = new Set(catalog.items.map((item) => item.bookId));
    const contentHash = job.normalizedContentHash ?? job.sourceHash;
    for (const entry of entries) {
      if (entry === job.bookId) continue;
      if (!entry.startsWith("book-")) continue;
      if (catalogBookIds.has(entry)) continue;
      const legacyJob = await readYamlFile(
        this.bookJobPath(entry),
        BookJobSchema,
        null,
      );
      if (
        legacyJob == null ||
        legacyJob.sourceHash !== job.sourceHash ||
        legacyJob.documentId !== job.documentId ||
        (legacyJob.normalizedContentHash ?? legacyJob.sourceHash) !== contentHash
      ) {
        continue;
      }
      await rm(this.bookDir(entry), { recursive: true, force: true });
    }
  }

  async buildGraphEnhancementRequest(
    input: BuildGraphEnhancementRequestInput,
  ): Promise<GraphEnhancementRequest> {
    const job = await this.getBookJob(input.bookId);
    if (job == null) {
      throw new Error(`graph enhancement request requires book state: ${input.bookId}`);
    }
    if (job.normalizedPath == null) {
      throw new Error(
        `graph enhancement request requires normalizedPath: ${input.bookId}`,
      );
    }
    return GraphEnhancementRequestSchema.parse({
      schemaVersion: SchemaVersion,
      requestId: input.requestId ?? createRunId("graph-enhancement-request"),
      sourceId: `sha256:${job.sourceHash}`,
      documentId: job.documentId,
      bookId: job.bookId,
      contentHash: job.normalizedContentHash ?? job.sourceHash,
      graphVault: input.graphVault ?? ".",
      normalizedInputPath: job.normalizedPath,
      methods: input.methods ?? ["local", "global", "drift", "basic"],
      metadata: sanitizeVaultMetadata({
        sourcePath: job.sourcePath,
        ...input.metadata,
      }),
    });
  }

  async getGraphEnhancementState(bookId: string): Promise<GraphEnhancementState> {
    const job = await this.getBookJob(bookId);
    if (job == null) {
      throw new Error(`graph enhancement state requires book state: ${bookId}`);
    }
    const checkpoints = await this.listStageCheckpoints(bookId);
    const artifacts = await this.listArtifacts(bookId);
    const succeededStages = new Set(
      checkpoints
        .filter((checkpoint) => checkpoint.status === "succeeded")
        .map((checkpoint) => checkpoint.stage),
    );
    const failedStages = new Set(
      checkpoints
        .filter((checkpoint) => checkpoint.status === "failed")
        .map((checkpoint) => checkpoint.stage),
    );
    const queryReady = checkpoints.find((checkpoint) =>
      checkpoint.stage === "query_ready" && checkpoint.status === "succeeded"
    );
    const queryReadyValidated = queryReady == null
      ? false
      : await this.isValidatedQueryReadyState(job, queryReady.artifactIds, artifacts);
    const artifactIds = queryReadyValidated ? queryReady!.artifactIds : artifacts.map(
      (artifact) => artifact.artifactId,
    );
    const capabilityIds = !queryReadyValidated
      ? []
      : [
          `${job.bookId}:graph_query`,
          `${job.bookId}:local_search`,
          `${job.bookId}:global_search`,
          `${job.bookId}:drift_search`,
          `${job.bookId}:community_reports`,
        ];
    const status = queryReadyValidated
      ? "succeeded"
      : failedStages.size > 0
        ? "failed"
        : checkpoints.some((checkpoint) => checkpoint.status === "running")
          ? "running"
          : succeededStages.size > 0
            ? "not_ready"
            : "pending";

    return GraphEnhancementStateSchema.parse({
      schemaVersion: SchemaVersion,
      bookId: job.bookId,
      sourceId: `sha256:${job.sourceHash}`,
      documentId: job.documentId,
      contentHash: job.normalizedContentHash ?? job.sourceHash,
      status,
      checkpointIds: checkpoints.map((checkpoint) =>
        [
          checkpoint.bookId,
          checkpoint.stage,
          checkpoint.inputFingerprint,
        ].join(":"),
      ),
      artifactIds,
      capabilityIds,
      updatedAt: job.updatedAt,
      metadata: sanitizeVaultMetadata({
        currentStage: job.currentStage ?? null,
        completedStageCount: succeededStages.size,
      }),
    });
  }

  async listBookJobs(): Promise<BookJob[]> {
    const catalog = await readBookJobCatalogFile(this.bookCatalogPath());
    return catalog.items;
  }

  async listStageCheckpoints(bookId: string): Promise<BookJobStageCheckpoint[]> {
    const list = await readYamlFile(
      this.stageCheckpointPath(bookId),
      BookJobCheckpointListSchema,
      EMPTY_CHECKPOINT_LIST,
    );
    const job = await this.getBookJob(bookId);
    return list.items.filter((checkpoint) =>
      checkpoint.bookId === bookId &&
      checkpoint.contentHash === expectedCheckpointContentHash(job, checkpoint.stage)
    );
  }

  async getStageCheckpoint(
    bookId: string,
    stage: BookStage,
  ): Promise<BookJobStageCheckpoint | null> {
    const checkpoints = await this.listStageCheckpoints(bookId);
    return checkpoints.find((item) => item.stage === stage) ?? null;
  }

  private async queryReadyProducerRunIds(
    bookId: string,
  ): Promise<Partial<Record<BookStage, string>> | undefined> {
    const job = await this.getBookJob(bookId);
    const currentCheckpoints = await this.listStageCheckpoints(bookId);
    const effective = await this.buildEffectiveResumeState(
      bookId,
      currentCheckpoints,
      job?.stageFingerprints ?? {},
      QUERY_READY_PRODUCER_REQUIRED_KINDS,
    );
    return producerRunIdsForQueryReady(
      new Map(effective.checkpoints.map((checkpoint) => [
        checkpoint.stage,
        checkpoint,
      ])),
    );
  }

  private async validateQueryReadyProducerStages(
    job: BookJob,
    artifacts: readonly BookArtifactManifest[],
  ): Promise<void> {
    const currentCheckpoints = await this.listStageCheckpoints(job.bookId);
    const effective = await this.buildEffectiveResumeState(
      job.bookId,
      currentCheckpoints,
      job.stageFingerprints ?? {},
      QUERY_READY_PRODUCER_REQUIRED_KINDS,
    );
    const checkpointByStage = new Map(
      effective.checkpoints.map((checkpoint) => [checkpoint.stage, checkpoint]),
    );
    const checkpoints = QUERY_READY_PRODUCER_STAGES.map((stage) => ({
      stage,
      checkpoint: checkpointByStage.get(stage),
    }));
    const validityByStage = effective.artifactValidity;
    const missingStages = checkpoints
      .filter(({ checkpoint }) =>
        !isRealGraphQueryProducerCheckpoint(checkpoint)
      )
      .map(({ stage }) => stage);
    if (missingStages.length > 0) {
      throw new Error(
        "query_ready checkpoint requires completed GraphRAG producer stages: " +
          missingStages.join(","),
      );
    }

    for (const { stage } of checkpoints) {
      const validity = validityByStage.get(stage);
      if (validity?.isSatisfied) continue;
      throw new Error(
        "query_ready checkpoint requires valid GraphRAG producer evidence: " +
          JSON.stringify({
            stage,
            missingArtifactIds: validity?.missingArtifactIds ?? [],
            missingArtifactKinds: validity?.missingArtifactKinds ??
              QUERY_READY_PRODUCER_REQUIRED_KINDS[stage],
            invalidArtifacts: validity?.invalidArtifacts ?? [],
          }),
      );
    }
  }

  private async queryReadyLineageArtifactIds(
    job: BookJob,
    queryReadyArtifactIds: readonly string[],
  ): Promise<string[]> {
    const artifacts = await this.listArtifacts(job.bookId);
    const currentCheckpoints = await this.listStageCheckpoints(job.bookId);
    const effective = await this.buildEffectiveResumeState(
      job.bookId,
      currentCheckpoints,
      job.stageFingerprints ?? {},
      {
        ...QUERY_READY_PRODUCER_REQUIRED_KINDS,
        query_ready: QUERY_READY_ARTIFACT_KINDS,
      },
    );
    const lineageArtifactIds = [
      ...QUERY_READY_PRODUCER_STAGES.flatMap((stage) =>
        effective.artifactValidity.get(stage)?.artifactIds ?? []
      ),
      ...filterArtifactIdsByKinds(
        queryReadyArtifactIds,
        artifacts,
        QUERY_READY_ARTIFACT_KINDS,
      ),
    ];
    return [...new Set(lineageArtifactIds)];
  }

  private async validateQueryReadyArtifacts(input: {
    job: BookJob;
    artifactIds: readonly string[];
    artifacts: readonly BookArtifactManifest[];
  }): Promise<void> {
    const expectedProducerRunIds = await this.queryReadyProducerRunIds(
      input.job.bookId,
    );
    if (expectedProducerRunIds == null) {
      throw new Error(
        "query_ready checkpoint requires completed GraphRAG producer stages: " +
          QUERY_READY_PRODUCER_STAGES.join(","),
      );
    }
    const validation = await validateBookArtifactSet({
      graphVault: this.rootDir,
      bookId: input.job.bookId,
      artifactIds: input.artifactIds,
      artifacts: input.artifacts,
      requiredKinds: QUERY_READY_ARTIFACT_KINDS,
      allowedKinds: QUERY_READY_ARTIFACT_KINDS,
      requireBookScopedGraphOutput: true,
      expectedProducerRunIds,
      expectedStageFingerprints: input.job.stageFingerprints,
      expectedProviderFingerprint: input.job.providerFingerprint,
      expectedCorpusContentHash:
        input.job.normalizedContentHash ?? input.job.sourceHash,
    });
    if (!validation.isSatisfied) {
      throw new Error(
        "query_ready checkpoint requires valid GraphRAG query artifacts: " +
          JSON.stringify({
            missingArtifactIds: validation.missingArtifactIds,
            missingArtifactKinds: validation.missingArtifactKinds,
            invalidArtifacts: validation.invalidArtifacts,
          }),
      );
    }
  }

  async startStage(input: StartStageInput): Promise<BookJobStageCheckpoint> {
    return this.writeStageCheckpoint({
      ...input,
      status: "running",
    });
  }

  async completeStage(
    input: CompleteStageInput,
  ): Promise<BookJobStageCheckpoint> {
    return this.writeStageCheckpoint({
      ...input,
      status: "succeeded",
    });
  }

  async failStage(input: FailStageInput): Promise<BookJobStageCheckpoint> {
    return this.writeStageCheckpoint({
      ...input,
      status: "failed",
    });
  }

  async listArtifacts(
    bookId: string,
    stage?: BookStage,
  ): Promise<BookArtifactManifest[]> {
    const list = await readYamlFile(
      this.artifactManifestPath(bookId),
      BookArtifactManifestListSchema,
      EMPTY_ARTIFACT_LIST,
    );
    if (stage == null) {
      return list.items;
    }
    return list.items.filter((item) => item.stage === stage);
  }

  async recordArtifacts(
    bookId: string,
    inputs: RecordArtifactInput[],
  ): Promise<BookArtifactManifest[]> {
    await this.ensureLayout();
    this.assertBatchBookLease(bookId);
    const existing = await this.listArtifacts(bookId);
    const job = await this.getBookJob(bookId);
    const now = toIsoTimestamp();

    const recorded = inputs.map((input) => {
      const artifactPath = assertBookArtifactPath(
        this.relativeToRoot(input.path),
        bookId,
        input.kind,
      );
      const stageFingerprint =
        input.stageFingerprint ??
        metadataString(input.metadata, "stageFingerprint") ??
        job?.stageFingerprints?.[input.stage];
      const providerFingerprint =
        input.providerFingerprint ??
        metadataString(input.metadata, "providerFingerprint") ??
        job?.providerFingerprint;
      const corpusContentHash =
        input.kind.startsWith("graphrag_") || input.kind === "lancedb_index"
          ? job?.normalizedContentHash ?? job?.sourceHash
          : undefined;
      const metadata = sanitizeVaultMetadata({
        ...(input.metadata ?? {}),
        ...(corpusContentHash ? { corpusContentHash } : {}),
      });
      assertHighCostFingerprint({
        subject: "artifact",
        stage: input.stage,
        contentHash: input.contentHash,
        stageFingerprint,
        providerFingerprint,
      });
      const artifactId = createArtifactId({
        bookId,
        stage: input.stage,
        kind: input.kind,
        contentHash: input.contentHash,
        stageFingerprint,
        providerFingerprint,
        metadata,
      });
      return BookArtifactManifestSchema.parse({
        schemaVersion: SchemaVersion,
        artifactId: input.artifactId ?? artifactId,
        bookId,
        stage: input.stage,
        kind: input.kind,
        path: artifactPath,
        contentHash: input.contentHash,
        stageFingerprint,
        providerFingerprint,
        normalizationPolicyVersion:
          input.normalizationPolicyVersion ??
          metadataString(input.metadata, "normalizationPolicyVersion"),
        producerRunId: input.producerRunId,
        createdAt: now,
        metadata,
      });
    });

    const singletonKeys = new Set(
      recorded
        .filter((item) => SINGLETON_ARTIFACT_KINDS.has(item.kind))
        .map((item) => createArtifactLogicalKey(item)),
    );
    const retained = [];
    for (const item of existing) {
      if (singletonKeys.has(createArtifactLogicalKey(item))) {
        continue;
      }
      const validation = await validateArtifact(this.rootDir, item);
      if (validation.valid) {
        retained.push(item);
      }
    }
    const merged = dedupeArtifacts([...retained, ...recorded]);
    await writeYamlFile(this.artifactManifestPath(bookId), {
      schemaVersion: SchemaVersion,
      items: merged,
    });

    return recorded;
  }

  relativePath(path: string): string {
    return this.relativeToRoot(path);
  }

  async appendRunRecord(record: BookJobRunRecord): Promise<BookJobRunRecord> {
    await this.ensureLayout();
    const parsed = BookJobRunRecordSchema.parse({
      ...record,
      errorSummary: sanitizeVaultText(record.errorSummary),
      metadata: sanitizeVaultMetadata(record.metadata),
    });
    this.assertBatchBookLease(parsed.bookId);
    await writeYamlFile(this.runRecordPath(parsed.bookId, parsed.runId), parsed);

    await updateYamlFile(
      this.runCatalogPath(),
      BookJobRunCatalogSchema,
      EMPTY_RUN_CATALOG,
      (catalog) => {
        const item = BookJobRunCatalogEntrySchema.parse({
          schemaVersion: SchemaVersion,
          runId: parsed.runId,
          bookId: parsed.bookId,
          stage: parsed.stage,
          status: parsed.status,
          startedAt: parsed.startedAt,
          finishedAt: parsed.finishedAt,
        });
        const items = catalog.items.filter((entry) =>
          entry.runId !== parsed.runId
        );
        items.push(item);
        items.sort((left, right) =>
          right.startedAt.localeCompare(left.startedAt)
        );
        return { schemaVersion: SchemaVersion, items };
      },
    );
    return parsed;
  }

  async listRunRecords(bookId: string): Promise<BookJobRunRecord[]> {
    const catalog = await this.readRunCatalog();
    const runs = catalog.items.filter((item) => item.bookId === bookId);
    const result: Array<BookJobRunRecord | null> = [];
    for (const item of runs) {
      result.push(await this.readRunRecord(bookId, item.runId));
    }
    return result.filter((item): item is BookJobRunRecord => item != null);
  }

  async getResumePlan(
    bookId: string,
    fingerprints: StageFingerprintMap,
    artifactRequirements: StageArtifactRequirementMap = {},
  ): Promise<BookResumePlan> {
    const checkpoints = await this.listStageCheckpoints(bookId);
    const effective = await this.buildEffectiveResumeState(
      bookId,
      checkpoints,
      fingerprints,
      artifactRequirements,
    );
    return buildResumePlan(
      bookId,
      effective.checkpoints,
      fingerprints,
      effective.artifactValidity,
    );
  }

  private async buildArtifactValidity(
    bookId: string,
    checkpoints: BookJobStageCheckpoint[],
    requirements: StageArtifactRequirementMap,
  ): Promise<Map<BookStage, ArtifactStageValidity>> {
    const job = await this.getBookJob(bookId);
    const stagesToValidate = new Set<BookStage>();
    for (const stage of Object.keys(requirements) as BookStage[]) {
      stagesToValidate.add(stage);
    }
    for (const checkpoint of checkpoints) {
      if (checkpoint.artifactIds.length > 0) {
        stagesToValidate.add(checkpoint.stage);
      }
    }

    if (stagesToValidate.size === 0) {
      return new Map();
    }

    const artifacts = await this.listArtifacts(bookId);
    const result = new Map<BookStage, ArtifactStageValidity>();
    const checkpointByStage = new Map(
      checkpoints.map((item) => [item.stage, item]),
    );

    for (const checkpoint of checkpoints) {
      if (!stagesToValidate.has(checkpoint.stage)) {
        continue;
      }

      const requiredKinds = requirements[checkpoint.stage] ?? [];
      const queryReadyProducerRunIds = checkpoint.stage === "query_ready"
        ? producerRunIdsForQueryReady(checkpointByStage)
        : undefined;
      const candidateArtifactIds = this.artifactIdsForCheckpointCandidate({
        checkpoint,
        artifacts,
        requiredKinds,
        queryReadyProducerRunIds,
      });
      const candidateArtifacts = artifacts.filter((artifact) =>
        candidateArtifactIds.includes(artifact.artifactId)
      );
      const validationInput = {
        graphVault: this.rootDir,
        bookId,
        artifacts: candidateArtifacts,
        requiredKinds,
        allowedKinds: checkpoint.stage === "query_ready"
          ? QUERY_READY_ARTIFACT_KINDS
          : requiredKinds.length > 0
            ? requiredKinds
            : undefined,
        requireBookScopedGraphOutput: checkpoint.stage === "query_ready" ||
          requiredKinds.some((kind) =>
            kind === "graphrag_community_reports_parquet" ||
            kind === "lancedb_index" ||
            kind.startsWith("graphrag_")
          ),
        expectedProducerRunIds: checkpoint.stage === "query_ready"
          ? queryReadyProducerRunIds ?? {
              graph_extract: "__missing_query_ready_producer__",
              community_report: "__missing_query_ready_producer__",
              embed: "__missing_query_ready_producer__",
            }
          : checkpoint.runId == null || !HIGH_COST_STAGES.has(checkpoint.stage)
            ? undefined
            : { [checkpoint.stage]: checkpoint.runId },
        expectedStageFingerprints: job?.stageFingerprints,
        expectedProviderFingerprint: job?.providerFingerprint,
        expectedCorpusContentHash: job == null
          ? undefined
          : job.normalizedContentHash ?? job.sourceHash,
      };
      let artifactValidation;
      let selectedArtifactIds: string[];
      if (requiredKinds.length === 0) {
        artifactValidation = await validateBookArtifactSet({
            ...validationInput,
            artifactIds: candidateArtifactIds,
          });
        selectedArtifactIds = artifactValidation.validArtifacts.map(
          (artifact) => artifact.artifactId,
        );
      } else {
        artifactValidation = await selectValidBookArtifactsByKind(validationInput);
        selectedArtifactIds = artifactValidation.artifactIds;
      }

      result.set(checkpoint.stage, {
        isSatisfied: artifactValidation.isSatisfied,
        artifactIds: selectedArtifactIds,
        missingArtifactIds: artifactValidation.missingArtifactIds,
        missingArtifactKinds: artifactValidation.missingArtifactKinds,
        invalidArtifacts: artifactValidation.invalidArtifacts,
      });
    }

    return result;
  }

  private async buildCheckpointCandidates(
    bookId: string,
    currentCheckpoints: readonly BookJobStageCheckpoint[],
    job: BookJob | null,
  ): Promise<BookJobStageCheckpoint[]> {
    const candidates = [...currentCheckpoints];
    for (const run of await this.listRunRecordsByIds(
      bookId,
      checkpointRunIds(currentCheckpoints),
    )) {
      if (run.bookId !== bookId) continue;
      const checkpoint = runRecordToStageCheckpoint(run, job);
      if (checkpoint != null) {
        candidates.push(checkpoint);
      }
    }

    const byKey = new Map<string, BookJobStageCheckpoint>();
    for (const checkpoint of candidates) {
      if (checkpoint.bookId !== bookId) continue;
      const expectedContentHash = expectedCheckpointContentHash(job, checkpoint.stage);
      if (
        expectedContentHash != null &&
        checkpoint.contentHash !== expectedContentHash
      ) {
        continue;
      }
      byKey.set(checkpointCandidateKey(checkpoint), checkpoint);
    }
    return sortNewestCheckpoints([...byKey.values()]);
  }

  private artifactIdsForCheckpointCandidate(input: {
    checkpoint: BookJobStageCheckpoint;
    artifacts: readonly BookArtifactManifest[];
    requiredKinds: readonly BookArtifactKind[];
    queryReadyProducerRunIds?: Partial<Record<BookStage, string>>;
  }): string[] {
    const requiredKindSet = new Set<BookArtifactKind>(input.requiredKinds);
    if (input.checkpoint.stage === "query_ready") {
      const communityReportRunId = input.queryReadyProducerRunIds?.community_report;
      const embedRunId = input.queryReadyProducerRunIds?.embed;
      return input.artifacts
        .filter((artifact) =>
          artifact.bookId === input.checkpoint.bookId &&
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
        )
        .map((artifact) => artifact.artifactId);
    }
    if (
      input.checkpoint.runId == null ||
      !HIGH_COST_STAGES.has(input.checkpoint.stage)
    ) {
      return input.checkpoint.artifactIds.filter((artifactId) => {
        if (requiredKindSet.size === 0) return true;
        const artifact = input.artifacts.find((candidate) =>
          candidate.artifactId === artifactId
        );
        return artifact != null && requiredKindSet.has(artifact.kind);
      });
    }

    return input.artifacts
      .filter((artifact) =>
        artifact.bookId === input.checkpoint.bookId &&
        artifact.stage === input.checkpoint.stage &&
        artifact.producerRunId === input.checkpoint.runId &&
        (requiredKindSet.size === 0 || requiredKindSet.has(artifact.kind))
      )
      .map((artifact) => artifact.artifactId);
  }

  private async validateStageCheckpointCandidate(input: {
    bookId: string;
    job: BookJob | null;
    checkpoint: BookJobStageCheckpoint;
    artifacts: readonly BookArtifactManifest[];
    requirements: StageArtifactRequirementMap;
    checkpointByStage?: ReadonlyMap<BookStage, BookJobStageCheckpoint>;
  }): Promise<ArtifactStageValidity> {
    const requiredKinds = input.requirements[input.checkpoint.stage] ?? [];
    const artifactIds = this.artifactIdsForCheckpointCandidate({
      checkpoint: input.checkpoint,
      artifacts: input.artifacts,
      requiredKinds,
      queryReadyProducerRunIds: input.checkpoint.stage === "query_ready"
        ? producerRunIdsForQueryReady(input.checkpointByStage ?? new Map())
        : undefined,
    });
    const queryReadyProducerRunIds = input.checkpoint.stage === "query_ready"
      ? producerRunIdsForQueryReady(input.checkpointByStage ?? new Map())
      : undefined;
    const candidateArtifacts = input.artifacts.filter((artifact) =>
      artifactIds.includes(artifact.artifactId)
    );
    const validationInput = {
      graphVault: this.rootDir,
      bookId: input.bookId,
      artifacts: candidateArtifacts,
      requiredKinds,
      allowedKinds: input.checkpoint.stage === "query_ready"
        ? QUERY_READY_ARTIFACT_KINDS
        : requiredKinds.length > 0
          ? requiredKinds
          : undefined,
      requireBookScopedGraphOutput: input.checkpoint.stage === "query_ready" ||
        requiredKinds.some((kind) =>
          kind === "graphrag_community_reports_parquet" ||
          kind === "lancedb_index" ||
          kind.startsWith("graphrag_")
        ),
      expectedProducerRunIds: input.checkpoint.stage === "query_ready"
        ? queryReadyProducerRunIds ?? {
            graph_extract: "__missing_query_ready_producer__",
            community_report: "__missing_query_ready_producer__",
            embed: "__missing_query_ready_producer__",
          }
        : input.checkpoint.runId == null || !HIGH_COST_STAGES.has(input.checkpoint.stage)
          ? undefined
          : { [input.checkpoint.stage]: input.checkpoint.runId },
      expectedStageFingerprints: input.job?.stageFingerprints,
      expectedProviderFingerprint: input.job?.providerFingerprint,
      expectedCorpusContentHash: input.job == null
        ? undefined
        : input.job.normalizedContentHash ?? input.job.sourceHash,
    };
    let artifactValidation;
    let selectedArtifactIds: string[];
    if (requiredKinds.length === 0) {
      artifactValidation = await validateBookArtifactSet({
          ...validationInput,
          artifactIds,
        });
      selectedArtifactIds = artifactValidation.validArtifacts.map(
        (artifact) => artifact.artifactId,
      );
    } else {
      artifactValidation = await selectValidBookArtifactsByKind(validationInput);
      selectedArtifactIds = artifactValidation.artifactIds;
    }

    return {
      isSatisfied: artifactValidation.isSatisfied,
      artifactIds: selectedArtifactIds,
      missingArtifactIds: artifactValidation.missingArtifactIds,
      missingArtifactKinds: artifactValidation.missingArtifactKinds,
      invalidArtifacts: artifactValidation.invalidArtifacts,
    };
  }

  private checkpointMatchesExpectedFingerprint(
    checkpoint: BookJobStageCheckpoint,
    fingerprints: StageFingerprintMap,
  ): boolean {
    const expectedFingerprint = fingerprints[checkpoint.stage];
    return expectedFingerprint == null ||
      checkpoint.inputFingerprint === expectedFingerprint;
  }

  private isCandidateMetadataUsable(
    checkpoint: BookJobStageCheckpoint,
  ): boolean {
    return !(
      HIGH_COST_STAGES.has(checkpoint.stage) &&
      checkpoint.metadata?.bootstrap === true
    );
  }

  private async selectUsableSucceededCheckpoint(input: {
    bookId: string;
    stage: BookStage;
    candidates: readonly BookJobStageCheckpoint[];
    fingerprints: StageFingerprintMap;
    requirements: StageArtifactRequirementMap;
    artifacts: readonly BookArtifactManifest[];
    job: BookJob | null;
    checkpointByStage: ReadonlyMap<BookStage, BookJobStageCheckpoint>;
  }): Promise<{
    checkpoint: BookJobStageCheckpoint;
    validity: ArtifactStageValidity;
  } | null> {
    const stageCandidates = sortNewestCheckpoints(
      input.candidates.filter((checkpoint) =>
        checkpoint.stage === input.stage &&
        checkpoint.status === "succeeded" &&
        this.checkpointMatchesExpectedFingerprint(checkpoint, input.fingerprints) &&
        this.isCandidateMetadataUsable(checkpoint)
      ),
    );
    for (const checkpoint of stageCandidates) {
      const validity = await this.validateStageCheckpointCandidate({
        bookId: input.bookId,
        job: input.job,
        checkpoint,
        artifacts: input.artifacts,
        requirements: input.requirements,
        checkpointByStage: input.checkpointByStage,
      });
      if (validity.isSatisfied) {
        return { checkpoint, validity };
      }
    }
    return null;
  }

  private async buildEffectiveResumeState(
    bookId: string,
    currentCheckpoints: BookJobStageCheckpoint[],
    fingerprints: StageFingerprintMap,
    requirements: StageArtifactRequirementMap,
  ): Promise<{
    checkpoints: BookJobStageCheckpoint[];
    artifactValidity: Map<BookStage, ArtifactStageValidity>;
  }> {
    const job = await this.getBookJob(bookId);
    const artifacts = await this.listArtifacts(bookId);
    const candidates = await this.buildCheckpointCandidates(
      bookId,
      currentCheckpoints,
      job,
    );
    const effectiveByStage = new Map(
      currentCheckpoints.map((checkpoint) => [checkpoint.stage, checkpoint]),
    );
    const validity = new Map<BookStage, ArtifactStageValidity>();

    for (const stage of BookStageOrder.filter((item) => item !== "query_ready")) {
      if (currentCheckpointBlocksRecoveredCandidate(effectiveByStage.get(stage))) {
        continue;
      }
      const usable = await this.selectUsableSucceededCheckpoint({
        bookId,
        stage,
        candidates,
        fingerprints,
        requirements,
        artifacts,
        job,
        checkpointByStage: effectiveByStage,
      });
      if (usable == null) continue;
      effectiveByStage.set(stage, usable.checkpoint);
      validity.set(stage, usable.validity);
    }

    if (!currentCheckpointBlocksRecoveredCandidate(effectiveByStage.get("query_ready"))) {
      const queryReadyUsable = await this.selectUsableSucceededCheckpoint({
        bookId,
        stage: "query_ready",
        candidates,
        fingerprints,
        requirements,
        artifacts,
        job,
        checkpointByStage: effectiveByStage,
      });
      if (queryReadyUsable != null) {
        effectiveByStage.set("query_ready", queryReadyUsable.checkpoint);
        validity.set("query_ready", queryReadyUsable.validity);
      }
    }

    const checkpoints = [...effectiveByStage.values()].sort((left, right) =>
      stageIndex(left.stage) - stageIndex(right.stage),
    );
    const diagnosticValidity = await this.buildArtifactValidity(
      bookId,
      checkpoints,
      requirements,
    );
    for (const [stage, stageValidity] of diagnosticValidity) {
      if (!validity.has(stage)) {
        validity.set(stage, stageValidity);
      }
    }
    return { checkpoints, artifactValidity: validity };
  }

  private async repairCheckpointRunRecordStageConsistency(
    bookId: string,
    checkpoints: readonly BookJobStageCheckpoint[],
  ): Promise<void> {
    const seenRunIds = new Set<string>();
    for (const checkpoint of checkpoints) {
      const runId = checkpoint.runId;
      if (runId == null || seenRunIds.has(runId)) {
        continue;
      }
      seenRunIds.add(runId);
      const record = await readYamlFile(
        this.runRecordPath(bookId, runId),
        BookJobRunRecordSchema,
        null,
      );
      if (record != null && record.stage === checkpoint.stage) {
        continue;
      }
      const repaired = BookJobRunRecordSchema.parse({
        schemaVersion: SchemaVersion,
        runId,
        bookId,
        stage: checkpoint.stage,
        status: checkpoint.status,
        attemptCount: checkpoint.attemptCount,
        startedAt: checkpoint.startedAt ?? checkpoint.finishedAt ?? toIsoTimestamp(),
        finishedAt: checkpoint.finishedAt,
        inputFingerprint: checkpoint.inputFingerprint,
        artifactIds: checkpoint.artifactIds,
        errorSummary: checkpoint.errorSummary,
        metadata: sanitizeVaultMetadata({
          ...(checkpoint.metadata ?? {}),
          repairedFromCheckpoint: true,
          ...(record?.stage != null ? { previousRunRecordStage: record.stage } : {}),
        }),
      });
      await this.appendRunRecord(repaired);
    }
  }

  private async writeStageCheckpoint(
    input: WriteStageCheckpointInput,
  ): Promise<BookJobStageCheckpoint> {
    await this.ensureLayout();
    this.assertBatchBookLease(input.bookId);
    const existing = await this.getStageCheckpoint(input.bookId, input.stage);
    const now = toIsoTimestamp();
    const job = await this.getBookJob(input.bookId);
    const artifactIds = input.artifactIds ??
      (input.status === "running" || input.status === "failed"
        ? []
        : existing?.artifactIds ?? []);
    const stageArtifacts = artifactIds.length === 0
      ? []
      : (await this.listArtifacts(input.bookId)).filter((artifact) =>
          artifactIds.includes(artifact.artifactId) && artifact.stage === input.stage
        );
    const firstStageArtifact = stageArtifacts[0];
    const expectedContentHash = expectedCheckpointContentHash(job, input.stage);
    if (
      input.contentHash != null &&
      expectedContentHash != null &&
      input.contentHash !== expectedContentHash
    ) {
      throw new Error(
        "stage checkpoint contentHash does not match registered book content: " +
          JSON.stringify({
            bookId: input.bookId,
            stage: input.stage,
            expectedContentHash,
            actualContentHash: input.contentHash,
          }),
      );
    }
    const checkpointContentHash =
      input.contentHash ??
      expectedContentHash ??
      firstStageArtifact?.contentHash;
    const checkpointStageFingerprint =
      input.stageFingerprint ??
      firstStageArtifact?.stageFingerprint ??
      job?.stageFingerprints?.[input.stage] ??
      input.inputFingerprint;
    const checkpointProviderFingerprint =
      input.providerFingerprint ??
      firstStageArtifact?.providerFingerprint ??
      job?.providerFingerprint;
    assertHighCostFingerprint({
      subject: "checkpoint",
      stage: input.stage,
      contentHash: checkpointContentHash,
      stageFingerprint: checkpointStageFingerprint,
      providerFingerprint: checkpointProviderFingerprint,
    });
    const checkpoint = BookJobStageCheckpointSchema.parse({
      schemaVersion: SchemaVersion,
      bookId: input.bookId,
      stage: input.stage,
      status: input.status,
      attemptCount:
        input.status === "running"
          ? (existing?.attemptCount ?? 0) + 1
          : (existing?.attemptCount ?? 1),
      runId: input.runId,
      startedAt:
        input.status === "running" ? now : (existing?.startedAt ?? now),
      finishedAt: input.status === "running" ? undefined : now,
      inputFingerprint: input.inputFingerprint,
      contentHash: checkpointContentHash,
      stageFingerprint: checkpointStageFingerprint,
      providerFingerprint: checkpointProviderFingerprint,
      artifactIds,
      errorSummary: sanitizeVaultText(input.errorSummary),
      metadata: sanitizeVaultMetadata(input.metadata),
    });

    if (input.stage === "query_ready" && input.status === "succeeded") {
      if (job == null) {
        throw new Error(
          `query_ready checkpoint requires registered book state: ${input.bookId}`,
        );
      }
      const artifacts = await this.listArtifacts(input.bookId);
      await this.validateQueryReadyProducerStages(job, artifacts);
      await this.validateQueryReadyArtifacts({
        job,
        artifactIds: checkpoint.artifactIds,
        artifacts,
      });
      await this.validateQueryReadyGraphIdentity(job);
    }

    const checkpoints = await this.listStageCheckpoints(input.bookId);
    await writeYamlFile(this.stageCheckpointPath(input.bookId), {
      schemaVersion: SchemaVersion,
      items: upsertCheckpoint(checkpoints, checkpoint),
    });

    if (job != null) {
      const overallStatus =
        input.status === "failed"
          ? "failed"
          : input.stage === "query_ready" && input.status === "succeeded"
            ? "succeeded"
            : input.status === "succeeded"
              ? "partial"
              : "running";
      await this.upsertBookJob({
        ...job,
        currentStage: input.stage,
        overallStatus,
        lastSuccessRunId:
          input.status === "succeeded" ? input.runId : job.lastSuccessRunId,
        updatedAt: now,
      });
    }

    await this.appendRunRecord({
      schemaVersion: SchemaVersion,
      runId: input.runId,
      bookId: input.bookId,
      stage: input.stage,
      status: input.status,
      attemptCount: checkpoint.attemptCount,
      startedAt: checkpoint.startedAt ?? now,
      finishedAt: checkpoint.finishedAt,
      inputFingerprint: input.inputFingerprint,
      artifactIds: checkpoint.artifactIds,
      errorSummary: checkpoint.errorSummary,
      metadata: checkpoint.metadata,
    });

    if (input.status === "succeeded") {
      await this.abandonRunningStageRuns({
        bookId: input.bookId,
        stage: input.stage,
        exceptRunId: input.runId,
        finishedAt: now,
      });
    }

    if (input.stage === "query_ready" && input.status === "succeeded" && job != null) {
      await this.publishGraphCapabilities(job, checkpoint, now);
    }

    return checkpoint;
  }

  private async abandonRunningStageRuns(input: {
    bookId: string;
    stage: BookStage;
    exceptRunId: string;
    finishedAt: string;
  }): Promise<void> {
    const runs = await this.listRunCatalogEntries(
      input.bookId,
      (entry) =>
        entry.stage === input.stage &&
        entry.status === "running" &&
        entry.runId !== input.exceptRunId,
      MaxAbandonRunningRunRecords,
    );
    for (const run of runs) {
      await this.appendRunRecord({
        schemaVersion: SchemaVersion,
        runId: run.runId,
        bookId: input.bookId,
        stage: input.stage,
        status: "abandoned",
        attemptCount: 0,
        startedAt: run.startedAt,
        finishedAt: input.finishedAt,
        inputFingerprint: "unknown-catalog-running-abandoned",
        artifactIds: [],
        errorSummary: "run superseded by successful stage completion",
        metadata: {
          supersededByRunId: input.exceptRunId,
          abandonedFromCatalogEntry: true,
        },
      });
    }
  }

  private async publishGraphCapabilities(
    job: BookJob,
    checkpoint: BookJobStageCheckpoint,
    createdAt: string,
  ): Promise<void> {
    const lineageArtifactIds = await this.queryReadyLineageArtifactIds(
      job,
      checkpoint.artifactIds,
    );
    const base = {
      schemaVersion: SchemaVersion,
      bookId: job.bookId,
      sourceId: `sha256:${job.sourceHash}`,
      documentId: job.documentId,
      contentHash: job.normalizedContentHash ?? job.sourceHash,
      ready: true,
      readinessSource: "validated_checkpoint_plus_validated_manifest" as const,
      artifactIds: lineageArtifactIds,
      createdAt,
    };

    for (const capability of [
      {
        ...base,
        capabilityId: `${job.bookId}:graph_query`,
        kind: "graph_query" as const,
      },
      {
        ...base,
        capabilityId: `${job.bookId}:local_search`,
        kind: "local_search" as const,
        method: "local" as const,
      },
      {
        ...base,
        capabilityId: `${job.bookId}:global_search`,
        kind: "global_search" as const,
        method: "global" as const,
      },
      {
        ...base,
        capabilityId: `${job.bookId}:drift_search`,
        kind: "drift_search" as const,
        method: "drift" as const,
      },
      {
        ...base,
        capabilityId: `${job.bookId}:community_reports`,
        kind: "community_reports" as const,
      },
    ]) {
      this.assertCurrentBatchBookLease(job.bookId);
      await recordGraphCapability(this.rootDir, capability, {
        beforeCommit: () => this.assertCurrentBatchBookLease(job.bookId),
        afterCommit: () => this.assertCurrentBatchBookLease(job.bookId),
      });
      this.assertCurrentBatchBookLease(job.bookId);
    }
  }

  async publishQueryReadyGraphCapabilities(bookId: string): Promise<void> {
    const job = await this.getBookJob(bookId);
    if (job == null) {
      throw new Error(`query_ready capability publish requires book state: ${bookId}`);
    }
    const checkpoint = (await this.listStageCheckpoints(bookId)).find((item) =>
      item.stage === "query_ready" && item.status === "succeeded"
    );
    if (checkpoint == null) {
      throw new Error(
        `query_ready capability publish requires succeeded checkpoint: ${bookId}`,
      );
    }
    const artifacts = await this.listArtifacts(bookId);
    await this.validateQueryReadyProducerStages(job, artifacts);
    await this.validateQueryReadyArtifacts({
      job,
      artifactIds: checkpoint.artifactIds,
      artifacts,
    });
    await this.validateQueryReadyGraphIdentity(job);
    await this.publishGraphCapabilities(job, checkpoint, toIsoTimestamp());
  }

  private async validateQueryReadyGraphIdentity(job: BookJob): Promise<void> {
    const contentHash = job.normalizedContentHash ?? job.sourceHash;
    const catalog = await readYamlFile(
      this.documentIdentityCatalogPath(),
      DocumentIdentityCatalogSchema,
      EMPTY_DOCUMENT_IDENTITY_CATALOG,
    );
    const identity = catalog.items.find((item) =>
      item.canonicalBookId === job.bookId &&
      item.documentId === job.documentId &&
      item.contentHash === contentHash
    );
    if (
      identity == null ||
      identity.metadata?.qmdCorpusRegistered !== true ||
      typeof identity.graphDocumentId !== "string" ||
      identity.graphDocumentId.length === 0 ||
      !Array.isArray(identity.graphTextUnitIds) ||
      identity.graphTextUnitIds.length === 0
    ) {
      throw new Error(
        "query_ready checkpoint requires qmd corpus registration and graph document identity: " +
          JSON.stringify({
            bookId: job.bookId,
            documentId: job.documentId,
            contentHash,
            missing: {
              qmdCorpusRegistered: identity?.metadata?.qmdCorpusRegistered !== true,
              graphDocumentId: identity?.graphDocumentId == null,
              graphTextUnitIds: (identity?.graphTextUnitIds ?? []).length === 0,
            },
          }),
      );
    }
  }

  private bookDir(bookId: string): string {
    return join(this.booksDir, bookId);
  }

  private bookCatalogPath(): string {
    return join(this.catalogDir, "books.yaml");
  }

  private sourceDocumentCatalogPath(): string {
    return join(this.catalogDir, "sources.yaml");
  }

  private documentIdentityCatalogPath(): string {
    return join(this.catalogDir, "document-identity-map.yaml");
  }

  private runCatalogPath(): string {
    return join(this.catalogDir, "runs.yaml");
  }

  private async readRunCatalog(): Promise<BookJobRunCatalog> {
    return readYamlFile(
      this.runCatalogPath(),
      BookJobRunCatalogSchema,
      EMPTY_RUN_CATALOG,
    );
  }

  private bookJobPath(bookId: string): string {
    return join(this.bookDir(bookId), "state", "job.yaml");
  }

  private stageCheckpointPath(bookId: string): string {
    return join(this.bookDir(bookId), "state", "checkpoints.yaml");
  }

  private artifactManifestPath(bookId: string): string {
    return join(this.bookDir(bookId), "state", "artifacts.yaml");
  }

  private runRecordPath(bookId: string, runId: string): string {
    return join(
      this.bookDir(bookId),
      "graphrag",
      "runs",
      `${runId}.yaml`,
    );
  }

  private async readRunRecord(
    bookId: string,
    runId: string,
  ): Promise<BookJobRunRecord | null> {
    return readYamlFile(
      this.runRecordPath(bookId, runId),
      BookJobRunRecordSchema,
      null,
    );
  }

  private async listRunRecordsByIds(
    bookId: string,
    runIds: readonly string[],
  ): Promise<BookJobRunRecord[]> {
    const result: BookJobRunRecord[] = [];
    for (const runId of new Set(runIds)) {
      const record = await this.readRunRecord(bookId, runId);
      if (record?.bookId === bookId) {
        result.push(record);
      }
    }
    return result;
  }

  private async listRunCatalogEntries(
    bookId: string,
    predicate: (entry: BookJobRunCatalogEntry) => boolean,
    maxRecords: number,
  ): Promise<BookJobRunCatalogEntry[]> {
    const catalog = await this.readRunCatalog();
    return sortNewestRunCatalogEntries(
      catalog.items.filter((entry) => entry.bookId === bookId && predicate(entry)),
    ).slice(0, maxRecords);
  }

  private absoluteFromRoot(path: string): string {
    const portablePath = normalizePortableVaultRelativePath(path);
    const absolutePath = resolve(this.rootDir, portablePath);
    const relativePath = relative(this.rootDir, absolutePath);
    if (!isPortableVaultRelativePath(relativePath)) {
      throw new Error(`vault-relative path escapes graph_vault: ${path}`);
    }
    return absolutePath;
  }

  private relativeToRoot(path: string): string {
    if (!hasAbsolutePathSyntax(path)) {
      return normalizePortableVaultRelativePath(path);
    }
    if (!path.startsWith("/")) {
      throw new Error(`artifact path must resolve inside graph_vault: ${path}`);
    }
    const absolutePath = resolve(path);
    const relativePath = relative(this.rootDir, absolutePath) || ".";
    if (!isPortableVaultRelativePath(relativePath)) {
      throw new Error(`artifact path must resolve inside graph_vault: ${path}`);
    }
    return normalizePortableVaultRelativePath(relativePath);
  }

  private async isValidatedQueryReadyState(
    job: BookJob,
    artifactIds: readonly string[],
    artifacts: readonly BookArtifactManifest[],
  ): Promise<boolean> {
    try {
      await this.validateQueryReadyProducerStages(job, artifacts);
      await this.validateQueryReadyArtifacts({ job, artifactIds, artifacts });
    } catch {
      return false;
    }
    try {
      await this.validateQueryReadyGraphIdentity(job);
      return true;
    } catch {
      return false;
    }
  }
}
