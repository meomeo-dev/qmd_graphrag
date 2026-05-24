import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";

import YAML from "yaml";

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
  BookStageSchema,
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
  buildBookId,
  buildBookIdFromSourceHash,
  buildDocumentId,
  createDeterministicHash,
  createRunId,
  hashFile,
  normalizeBookSlug,
  toIsoTimestamp,
} from "./fingerprint.js";
import {
  GraphEnhancementRequestSchema,
  GraphEnhancementStateSchema,
  type GraphEnhancementRequest,
  type GraphEnhancementState,
} from "../contracts/graph-enhancement.js";
import { recordGraphCapability } from "../graphrag/capability-catalog.js";
import {
  hasAbsolutePathSyntax,
  isPortableVaultRelativePath,
  normalizePortableVaultRelativePath,
} from "../vault/path.js";
import {
  QUERY_READY_ARTIFACT_KINDS,
  validateBookArtifactSet,
} from "./artifact-validation.js";
import {
  sanitizeVaultMetadata,
  sanitizeVaultText,
} from "../vault/metadata.js";

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
  try {
    const raw = await readFile(path, "utf8");
    const parsed = YAML.parse(raw);
    return schema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function migrateLegacyBookJob(value: unknown): BookJob {
  const raw = value as Record<string, unknown>;
  const normalizedPath = typeof raw.normalizedPath === "string"
    ? raw.normalizedPath
    : typeof (raw.metadata as Record<string, unknown> | undefined)?.normalizedPath === "string"
      ? String((raw.metadata as Record<string, unknown>).normalizedPath)
      : typeof raw.sourcePath === "string"
        ? raw.sourcePath
        : "unknown";
  const contentHash = typeof raw.normalizedContentHash === "string"
    ? raw.normalizedContentHash
    : String(raw.sourceHash ?? "");
  return BookJobSchema.parse({
    ...raw,
    documentId: typeof raw.documentId === "string" && raw.documentId
      ? raw.documentId
      : buildDocumentId({
          sourceId: `sha256:${String(raw.sourceHash ?? "")}`,
          contentHash,
          normalizationPolicyVersion:
            typeof raw.normalizationPolicyVersion === "string"
              ? raw.normalizationPolicyVersion
              : NormalizationPolicyVersion,
        }),
    normalizedPath: typeof raw.normalizedPath === "string"
      ? normalizePortableVaultRelativePath(raw.normalizedPath)
      : undefined,
  });
}

async function readBookJobCatalogFile(path: string): Promise<BookJobCatalog> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = YAML.parse(raw) as { items?: unknown[] } | null;
    const items = (parsed?.items ?? []).map((item) => migrateLegacyBookJob(item));
    return BookJobCatalogSchema.parse({
      schemaVersion: SchemaVersion,
      items,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_BOOK_CATALOG;
    }
    throw error;
  }
}

async function writeYamlFile(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const yaml = YAML.stringify(value, {
    indent: 2,
    lineWidth: 88,
  });
  await writeFile(tempPath, yaml, "utf8");
  await rename(tempPath, path);
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

function stripKnownSourceExtension(path: string): string {
  return path.replace(/\.(epub|md|markdown|txt)$/iu, "");
}

function archiveSafeTimestamp(): string {
  return toIsoTimestamp().replace(/[:.]/gu, "-");
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

function canonicalizeArtifact(
  artifact: BookArtifactManifest,
  bookId: string,
  oldBookId?: string,
): BookArtifactManifest {
  const canonicalPath = oldBookId == null
    ? artifact.path
    : artifact.path.replaceAll(`books/${oldBookId}/`, `books/${bookId}/`);
  const canonical = { ...artifact, bookId, path: canonicalPath };
  return {
    ...canonical,
    artifactId: createArtifactId(canonical),
  };
}

function migrateLegacyArtifactManifest(
  value: unknown,
  bookId: string,
): BookArtifactManifest {
  const raw = value as Record<string, unknown>;
  const metadata = raw.metadata as Record<string, unknown> | undefined;
  const stage = BookStageSchema.parse(raw.stage);
  const contentHash = String(raw.contentHash ?? "");
  const stageFingerprint =
    typeof raw.stageFingerprint === "string"
      ? raw.stageFingerprint
      : typeof metadata?.stageFingerprint === "string"
        ? metadata.stageFingerprint
      : HIGH_COST_STAGES.has(stage)
        ? createDeterministicHash(["legacy-stage", bookId, stage, contentHash])
        : undefined;
  const providerFingerprint =
    typeof raw.providerFingerprint === "string"
      ? raw.providerFingerprint
      : typeof metadata?.providerFingerprint === "string"
        ? metadata.providerFingerprint
      : HIGH_COST_STAGES.has(stage)
        ? createDeterministicHash(["legacy-provider", bookId, stage])
        : undefined;
  return BookArtifactManifestSchema.parse({
    ...raw,
    bookId: typeof raw.bookId === "string" ? raw.bookId : bookId,
    stageFingerprint,
    providerFingerprint,
  });
}

function migrateLegacyArtifactManifestList(
  value: unknown,
  bookId: string,
): BookArtifactManifestList {
  const raw = value as Record<string, unknown>;
  const items = Array.isArray(raw.items) ? raw.items : [];
  return BookArtifactManifestListSchema.parse({
    schemaVersion: SchemaVersion,
    items: items.map((item) => migrateLegacyArtifactManifest(item, bookId)),
  });
}

function migrateLegacyStageCheckpoint(
  value: unknown,
  input: {
    bookId: string;
    artifacts?: readonly BookArtifactManifest[];
    job?: BookJob | null;
  },
): BookJobStageCheckpoint {
  const raw = value as Record<string, unknown>;
  const stage = BookStageSchema.parse(raw.stage);
  const artifactIds = Array.isArray(raw.artifactIds)
    ? raw.artifactIds.map(String)
    : [];
  const stageArtifacts = (input.artifacts ?? []).filter((artifact) =>
    artifact.stage === stage && artifactIds.includes(artifact.artifactId)
  );
  const firstArtifact = stageArtifacts[0];
  const contentHash = typeof raw.contentHash === "string"
    ? raw.contentHash
    : firstArtifact?.contentHash ?? input.job?.normalizedContentHash ?? input.job?.sourceHash;
  const stageFingerprint = typeof raw.stageFingerprint === "string"
    ? raw.stageFingerprint
    : firstArtifact?.stageFingerprint ??
      input.job?.stageFingerprints?.[stage] ??
      (HIGH_COST_STAGES.has(stage) && contentHash
        ? createDeterministicHash(["legacy-stage", input.bookId, stage, contentHash])
        : undefined);
  const providerFingerprint = typeof raw.providerFingerprint === "string"
    ? raw.providerFingerprint
    : firstArtifact?.providerFingerprint ??
      input.job?.providerFingerprint ??
      (HIGH_COST_STAGES.has(stage)
        ? createDeterministicHash(["legacy-provider", input.bookId, stage])
        : undefined);
  return BookJobStageCheckpointSchema.parse({
    ...raw,
    bookId: typeof raw.bookId === "string" ? raw.bookId : input.bookId,
    contentHash,
    stageFingerprint,
    providerFingerprint,
    artifactIds,
  });
}

function migrateLegacyStageCheckpointList(
  value: unknown,
  input: {
    bookId: string;
    artifacts?: readonly BookArtifactManifest[];
    job?: BookJob | null;
  },
): BookJobCheckpointList {
  const raw = value as Record<string, unknown>;
  const items = Array.isArray(raw.items) ? raw.items : [];
  return BookJobCheckpointListSchema.parse({
    schemaVersion: SchemaVersion,
    items: items.map((item) => migrateLegacyStageCheckpoint(item, input)),
  });
}

function remapArtifactIds(
  artifactIds: string[],
  artifactIdMap: Map<string, string>,
): string[] {
  return artifactIds.map((artifactId) => artifactIdMap.get(artifactId) ?? artifactId);
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

function checkpointRank(checkpoint: BookJobStageCheckpoint): number {
  if (checkpoint.status === "succeeded") return 4;
  if (checkpoint.status === "running") return 3;
  if (checkpoint.status === "failed") return 2;
  return 1;
}

function checkpointTimestamp(checkpoint: BookJobStageCheckpoint): string {
  return checkpoint.finishedAt ?? checkpoint.startedAt ?? "";
}

function latestCheckpointByStage(
  checkpoints: BookJobStageCheckpoint[],
): BookJobStageCheckpoint[] {
  const byStage = new Map<BookStage, BookJobStageCheckpoint>();
  for (const checkpoint of checkpoints) {
    const existing = byStage.get(checkpoint.stage);
    if (
      existing == null ||
      checkpointRank(checkpoint) > checkpointRank(existing) ||
      (
        checkpointRank(checkpoint) === checkpointRank(existing) &&
        checkpointTimestamp(checkpoint) > checkpointTimestamp(existing)
      )
    ) {
      byStage.set(checkpoint.stage, checkpoint);
    }
  }
  return [...byStage.values()].sort((left, right) =>
    stageIndex(left.stage) - stageIndex(right.stage),
  );
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
        expectedFingerprint,
        actualFingerprint,
        isSatisfied: false,
        reason: "failed",
      };
    } else if (checkpoint.status !== "succeeded") {
      state = {
        stage,
        checkpointStatus: checkpoint.status,
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
          expectedFingerprint,
          actualFingerprint,
          isSatisfied: false,
          reason: "artifact_missing",
          missingArtifactIds: validity.missingArtifactIds,
          missingArtifactKinds: validity.missingArtifactKinds,
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

type ArtifactStageValidity = {
  isSatisfied: boolean;
  missingArtifactIds: string[];
  missingArtifactKinds: BookArtifactKind[];
};

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

  async registerBookSource(input: RegisterBookSourceInput): Promise<BookJob> {
    await this.ensureLayout();
    const sourcePath = resolve(input.sourcePath);
    const sourceIdentityPath = input.sourceIdentityPath ?? basename(sourcePath);
    const sourceHash = await hashFile(sourcePath);
    const now = toIsoTimestamp();
    const bookId = buildBookIdFromSourceHash(sourceIdentityPath, sourceHash);
    await this.migrateLegacyBookId(
      sourcePath,
      sourceIdentityPath,
      sourceHash,
      bookId,
    );
    await this.migrateBookDirectorySourceHashAliases(sourceHash, bookId);
    await this.migrateBookCatalogSourceHashAliases(sourceHash, bookId);
    const existing = await this.getBookJob(bookId);
    const normalizedPath = input.normalizedPath != null
      ? normalizePortableVaultRelativePath(input.normalizedPath)
      : input.metadata?.normalizedPath != null
        ? normalizePortableVaultRelativePath(String(input.metadata.normalizedPath))
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
        normalizePortableVaultRelativePath(input.canonicalSourcePath),
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
        join("sources", bookId, `source${extension}`),
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
    if (existingSourcePath && isPortableVaultRelativePath(existingSourcePath)) {
      try {
        if ((await hashFile(this.absoluteFromRoot(existingSourcePath))) === sourceHash) {
          return existingSourcePath;
        }
      } catch {
        // Missing or stale legacy source locator is rematerialized below.
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
      }),
    });

    const catalog = await readYamlFile(
      this.sourceDocumentCatalogPath(),
      SourceDocumentCatalogSchema,
      EMPTY_SOURCE_DOCUMENT_CATALOG,
    );
    const items = catalog.items.filter((item) => item.sourceId !== sourceId);
    items.push(source);
    items.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    await writeYamlFile(this.sourceDocumentCatalogPath(), {
      schemaVersion: SchemaVersion,
      items,
    });
  }

  private async upsertDocumentIdentityMap(job: BookJob): Promise<void> {
    const sourceId = `sha256:${job.sourceHash}`;
    const normalizedPath = job.normalizedPath;
    const catalog = await readYamlFile(
      this.documentIdentityCatalogPath(),
      DocumentIdentityCatalogSchema,
      EMPTY_DOCUMENT_IDENTITY_CATALOG,
    );
    const existingIdentity = catalog.items.find((item) =>
      item.documentId === job.documentId
    );
    const aliases = [
      ...(existingIdentity?.aliases ?? []),
      existingIdentity?.normalizedPath ?? null,
      metadataString(job.metadata, "sourceIdentityPath") ?? null,
      metadataString(job.metadata, "sourceName") ?? null,
      normalizedPath,
    ].filter((value): value is string => !!value);
    const contentHash = job.normalizedContentHash ?? job.sourceHash;
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
      chunkIds: [],
      aliases: [...new Set(aliases)],
      metadata: mergeJobMetadata(job.metadata, {
        bookId: job.bookId,
        normalizedPath: normalizedPath ?? null,
      }),
    });

    const items = catalog.items.filter((item) =>
      item.documentId !== identity.documentId
    );
    items.push(identity);
    items.sort((left, right) => left.documentId.localeCompare(right.documentId));
    await writeYamlFile(this.documentIdentityCatalogPath(), {
      schemaVersion: SchemaVersion,
      items,
    });
  }

  async recordGraphTextUnitIdentity(
    input: RecordGraphTextUnitIdentityInput,
  ): Promise<void> {
    await this.ensureLayout();
    const parsed = GraphTextUnitIdentityMapSchema.parse(input);
    const catalog = await readYamlFile(
      this.documentIdentityCatalogPath(),
      DocumentIdentityCatalogSchema,
      EMPTY_DOCUMENT_IDENTITY_CATALOG,
    );
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
        `document identity not found for graph text units: ${parsed.documentId}`,
      );
    }
    await writeYamlFile(this.documentIdentityCatalogPath(), {
      schemaVersion: SchemaVersion,
      items,
    });
  }

  async remapBookIdentity(oldBookId: string, newBookId: string): Promise<void> {
    await this.ensureLayout();
    if (oldBookId === newBookId) return;

    const oldDir = this.bookDir(oldBookId);
    const newDir = this.bookDir(newBookId);
    let oldExists = false;
    try {
      await stat(oldDir);
      oldExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (!oldExists) {
      await this.rewriteLegacyCatalogReferences(oldBookId, newBookId);
      await this.removeLegacyBookCatalogEntries(oldBookId, newBookId);
      return;
    }

    let newExists = false;
    try {
      await stat(newDir);
      newExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (newExists) {
      await this.mergeLegacyBookDirectory(oldBookId, newBookId);
      await this.archiveLegacyBookDirectory(oldBookId, newBookId);
    } else {
      await rename(oldDir, newDir);
      await this.rewriteLegacyBookState(newBookId, oldBookId);
    }
    await this.canonicalizeLegacySourceDirectory(oldBookId, newBookId);
    await this.rewriteLegacyCatalogReferences(oldBookId, newBookId);
    await this.removeLegacyBookCatalogEntries(oldBookId, newBookId);
  }

  private async mergeLegacyBookDirectory(
    oldBookId: string,
    newBookId: string,
  ): Promise<void> {
    const oldArtifacts = await readYamlFile(
      this.artifactManifestPath(oldBookId),
      { parse: (value) => migrateLegacyArtifactManifestList(value, oldBookId) },
      EMPTY_ARTIFACT_LIST,
    );
    const newArtifacts = await readYamlFile(
      this.artifactManifestPath(newBookId),
      BookArtifactManifestListSchema,
      EMPTY_ARTIFACT_LIST,
    );
    const artifactIdMap = new Map<string, string>();
    const canonicalOldArtifacts = oldArtifacts.items.map((artifact) => {
      const canonical = canonicalizeArtifact(artifact, newBookId, oldBookId);
      artifactIdMap.set(artifact.artifactId, canonical.artifactId);
      return canonical;
    });
    await writeYamlFile(this.artifactManifestPath(newBookId), {
      schemaVersion: SchemaVersion,
      items: dedupeArtifacts([...newArtifacts.items, ...canonicalOldArtifacts]),
    });

    const oldCheckpoints = await readYamlFile(
      this.stageCheckpointPath(oldBookId),
      {
        parse: (value) => migrateLegacyStageCheckpointList(value, {
          bookId: oldBookId,
          artifacts: oldArtifacts.items,
        }),
      },
      EMPTY_CHECKPOINT_LIST,
    );
    const newCheckpoints = await readYamlFile(
      this.stageCheckpointPath(newBookId),
      BookJobCheckpointListSchema,
      EMPTY_CHECKPOINT_LIST,
    );
    const mergedCheckpoints = [...newCheckpoints.items];
    for (const checkpoint of oldCheckpoints.items) {
      mergedCheckpoints.push(BookJobStageCheckpointSchema.parse({
        ...checkpoint,
        bookId: newBookId,
        artifactIds: remapArtifactIds(checkpoint.artifactIds, artifactIdMap),
      }));
    }
    await writeYamlFile(this.stageCheckpointPath(newBookId), {
      schemaVersion: SchemaVersion,
      items: latestCheckpointByStage(mergedCheckpoints),
    });

    await this.mergeLegacyRunRecords(oldBookId, newBookId, artifactIdMap);
    await this.rewriteLegacyRunRecords(newBookId, artifactIdMap);
  }

  private async archiveLegacyBookDirectory(
    oldBookId: string,
    newBookId: string,
  ): Promise<void> {
    const legacyDir = this.bookDir(oldBookId);
    try {
      await stat(legacyDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    const archiveDir = join(
      this.rootDir,
      "archive",
      "legacy-books",
      `${oldBookId}-to-${newBookId}-${archiveSafeTimestamp()}`,
    );
    await ensureDir(dirname(archiveDir));
    await rename(legacyDir, archiveDir);
  }

  private async canonicalizeLegacySourceDirectory(
    oldBookId: string,
    newBookId: string,
  ): Promise<void> {
    const legacyDir = join(this.rootDir, "sources", oldBookId);
    const stableDir = join(this.rootDir, "sources", newBookId);
    try {
      await stat(legacyDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    try {
      await stat(stableDir);
      const archiveDir = join(
        this.rootDir,
        "archive",
        "legacy-sources",
        `${oldBookId}-to-${newBookId}-${archiveSafeTimestamp()}`,
      );
      await ensureDir(dirname(archiveDir));
      await rename(legacyDir, archiveDir);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await ensureDir(dirname(stableDir));
    await rename(legacyDir, stableDir);
  }

  private async mergeLegacyRunRecords(
    oldBookId: string,
    newBookId: string,
    artifactIdMap: Map<string, string>,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(join(this.bookDir(oldBookId), "runs"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    await ensureDir(join(this.bookDir(newBookId), "runs"));
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".yaml"))
        .map(async (entry) => {
          const sourcePath = join(this.bookDir(oldBookId), "runs", entry);
          const record = await readYamlFile(
            sourcePath,
            BookJobRunRecordSchema,
            null,
          );
          if (record == null) {
            return;
          }
          await writeYamlFile(join(this.bookDir(newBookId), "runs", entry), {
            ...record,
            bookId: newBookId,
            artifactIds: remapArtifactIds(record.artifactIds, artifactIdMap),
          });
        }),
    );
  }

  private async migrateBookCatalogSourceHashAliases(
    sourceHash: string,
    currentBookId: string,
  ): Promise<void> {
    const catalog = await readBookJobCatalogFile(this.bookCatalogPath());
    for (const item of catalog.items) {
      if (item.sourceHash === sourceHash && item.bookId !== currentBookId) {
        await this.remapBookIdentity(item.bookId, currentBookId);
      }
    }
  }

  private async migrateBookDirectorySourceHashAliases(
    sourceHash: string,
    currentBookId: string,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.booksDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === currentBookId) {
        continue;
      }

      let job: BookJob;
      try {
        const raw = await readFile(this.bookJobPath(entry.name), "utf8");
        job = migrateLegacyBookJob(YAML.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }

      if (job.sourceHash === sourceHash) {
        await this.remapBookIdentity(entry.name, currentBookId);
      }
    }
  }

  async recordDocumentChunks(input: RecordDocumentChunksInput): Promise<void> {
    await this.ensureLayout();
    if (input.chunkIds.length === 0) {
      throw new Error(`document chunks cannot be empty: ${input.documentId}`);
    }
    const catalog = await readYamlFile(
      this.documentIdentityCatalogPath(),
      DocumentIdentityCatalogSchema,
      EMPTY_DOCUMENT_IDENTITY_CATALOG,
    );
    let matched = false;
    const items = catalog.items.map((item) => {
      const matchesIdentity =
        item.documentId === input.documentId &&
        item.contentHash === input.contentHash;
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
      throw new Error(`document identity not found for chunks: ${input.documentId}`);
    }
    await writeYamlFile(this.documentIdentityCatalogPath(), {
      schemaVersion: SchemaVersion,
      items,
    });
  }

  async recordQmdCorpusRegistration(
    input: RecordQmdCorpusRegistrationInput,
  ): Promise<void> {
    await this.ensureLayout();
    const relativePath = normalizePortableVaultRelativePath(input.relativePath);
    const catalog = await readYamlFile(
      this.documentIdentityCatalogPath(),
      DocumentIdentityCatalogSchema,
      EMPTY_DOCUMENT_IDENTITY_CATALOG,
    );
    let matched = false;
    const items = catalog.items.map((item) => {
      const matchesIdentity =
        item.documentId === input.documentId &&
        item.contentHash === input.contentHash;
      if (!matchesIdentity) return item;
      matched = true;
      return DocumentIdentityMapSchema.parse({
        ...item,
        metadata: mergeJobMetadata(item.metadata, {
          qmdCorpusRegistered: true,
          qmdCollection: input.collection,
          qmdRelativePath: relativePath,
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
    await writeYamlFile(this.documentIdentityCatalogPath(), {
      schemaVersion: SchemaVersion,
      items,
    });
  }

  async upsertBookJob(job: BookJob): Promise<BookJob> {
    await this.ensureLayout();
    const parsed = BookJobSchema.parse({
      ...job,
      sourcePath: normalizePortableVaultRelativePath(job.sourcePath),
      normalizedPath: job.normalizedPath == null
        ? undefined
        : normalizePortableVaultRelativePath(job.normalizedPath),
      metadata: sanitizeVaultMetadata(job.metadata),
    });
    await writeYamlFile(this.bookJobPath(parsed.bookId), parsed);

    const catalog = await readBookJobCatalogFile(this.bookCatalogPath());
    const items = catalog.items.filter((item) => item.bookId !== parsed.bookId);
    items.push(parsed);
    items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    await writeYamlFile(this.bookCatalogPath(), {
      schemaVersion: SchemaVersion,
      items,
    });

    return parsed;
  }

  async getBookJob(bookId: string): Promise<BookJob | null> {
    try {
      const raw = await readFile(this.bookJobPath(bookId), "utf8");
      return migrateLegacyBookJob(YAML.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
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
    let list: BookJobCheckpointList;
    try {
      list = await readYamlFile(
        this.stageCheckpointPath(bookId),
        BookJobCheckpointListSchema,
        EMPTY_CHECKPOINT_LIST,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        const [artifacts, job] = await Promise.all([
          this.listArtifacts(bookId),
          this.getBookJob(bookId),
        ]);
        const raw = YAML.parse(
          await readFile(this.stageCheckpointPath(bookId), "utf8"),
        );
        list = migrateLegacyStageCheckpointList(raw, {
          bookId,
          artifacts,
          job,
        });
      } else {
        throw error;
      }
    }
    await this.repairCheckpointRunRecordStageConsistency(bookId, list.items);
    return list.items;
  }

  async getStageCheckpoint(
    bookId: string,
    stage: BookStage,
  ): Promise<BookJobStageCheckpoint | null> {
    const checkpoints = await this.listStageCheckpoints(bookId);
    return checkpoints.find((item) => item.stage === stage) ?? null;
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
    let list: BookArtifactManifestList;
    try {
      list = await readYamlFile(
        this.artifactManifestPath(bookId),
        BookArtifactManifestListSchema,
        EMPTY_ARTIFACT_LIST,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        const raw = YAML.parse(
          await readFile(this.artifactManifestPath(bookId), "utf8"),
        );
        list = migrateLegacyArtifactManifestList(raw, bookId);
      } else {
        throw error;
      }
    }
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
    const existing = await this.listArtifacts(bookId);
    const job = await this.getBookJob(bookId);
    const now = toIsoTimestamp();

    const recorded = inputs.map((input) => {
      const artifactPath = this.relativeToRoot(input.path);
      const stageFingerprint =
        input.stageFingerprint ??
        metadataString(input.metadata, "stageFingerprint") ??
        job?.stageFingerprints?.[input.stage];
      const providerFingerprint =
        input.providerFingerprint ??
        metadataString(input.metadata, "providerFingerprint") ??
        job?.providerFingerprint;
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
        metadata: input.metadata,
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
        metadata: sanitizeVaultMetadata(input.metadata),
      });
    });

    const singletonKeys = new Set(
      recorded
        .filter((item) => SINGLETON_ARTIFACT_KINDS.has(item.kind))
        .map((item) => createArtifactLogicalKey(item)),
    );
    const retained = existing.filter(
      (item) => !singletonKeys.has(createArtifactLogicalKey(item)),
    );
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
    await writeYamlFile(this.runRecordPath(parsed.bookId, parsed.runId), parsed);

    const catalog = await readYamlFile(
      this.runCatalogPath(),
      BookJobRunCatalogSchema,
      EMPTY_RUN_CATALOG,
    );
    const item = BookJobRunCatalogEntrySchema.parse({
      schemaVersion: SchemaVersion,
      runId: parsed.runId,
      bookId: parsed.bookId,
      stage: parsed.stage,
      status: parsed.status,
      startedAt: parsed.startedAt,
      finishedAt: parsed.finishedAt,
    });
    const items = catalog.items.filter((entry) => entry.runId !== parsed.runId);
    items.push(item);
    items.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    await writeYamlFile(this.runCatalogPath(), {
      schemaVersion: SchemaVersion,
      items,
    });
    return parsed;
  }

  async listRunRecords(bookId: string): Promise<BookJobRunRecord[]> {
    const catalog = await readYamlFile(
      this.runCatalogPath(),
      BookJobRunCatalogSchema,
      EMPTY_RUN_CATALOG,
    );
    const runs = catalog.items.filter((item) => item.bookId === bookId);
    const result = await Promise.all(
      runs.map((item) =>
        readYamlFile(
          this.runRecordPath(bookId, item.runId),
          BookJobRunRecordSchema,
          null,
        ),
      ),
    );
    return result.filter((item): item is BookJobRunRecord => item != null);
  }

  async getResumePlan(
    bookId: string,
    fingerprints: StageFingerprintMap,
    artifactRequirements: StageArtifactRequirementMap = {},
  ): Promise<BookResumePlan> {
    const checkpoints = await this.listStageCheckpoints(bookId);
    const artifactValidity = await this.buildArtifactValidity(
      bookId,
      checkpoints,
      artifactRequirements,
    );
    return buildResumePlan(bookId, checkpoints, fingerprints, artifactValidity);
  }

  private async migrateLegacyBookId(
    sourcePath: string,
    sourceIdentityPath: string,
    sourceHash: string,
    currentBookId: string,
  ): Promise<void> {
    for (const legacyBookId of this.legacyBookIdCandidates(
      sourcePath,
      sourceIdentityPath,
      sourceHash,
    )) {
      if (legacyBookId === currentBookId) {
        continue;
      }
      const legacyDir = this.bookDir(legacyBookId);
      try {
        await stat(legacyDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }

      await this.remapBookIdentity(legacyBookId, currentBookId);
    }
  }

  private legacyBookIdCandidates(
    sourcePath: string,
    sourceIdentityPath: string,
    sourceHash: string,
  ): string[] {
    const sourceIdentityWithoutKnownExtension =
      stripKnownSourceExtension(sourceIdentityPath);
    const sourceIdentityWithoutTrailingDotSegment =
      sourceIdentityWithoutKnownExtension.replace(/\.[^.]*$/, "");
    return [
      buildBookId(sourcePath),
      buildBookId(sourceIdentityPath),
      buildBookId(sourceIdentityWithoutKnownExtension),
      buildBookId(sourceIdentityWithoutTrailingDotSegment),
      `book-${sourceHash.slice(0, 12)}`,
      `${normalizeBookSlug(sourcePath)}-${sourceHash.slice(0, 12)}`,
      `${normalizeBookSlug(sourceIdentityPath)}-${sourceHash.slice(0, 12)}`,
      `${normalizeBookSlug(sourceIdentityWithoutKnownExtension)}-${sourceHash.slice(
        0,
        12,
      )}`,
      `${normalizeBookSlug(sourceIdentityWithoutTrailingDotSegment)}-${sourceHash.slice(
        0,
        12,
      )}`,
    ];
  }

  private async rewriteLegacyBookState(
    bookId: string,
    oldBookId: string,
  ): Promise<void> {
    const artifacts = await readYamlFile(
      this.artifactManifestPath(bookId),
      { parse: (value) => migrateLegacyArtifactManifestList(value, bookId) },
      EMPTY_ARTIFACT_LIST,
    );
    const artifactIdMap = new Map<string, string>();
    const canonicalArtifacts = artifacts.items.map((artifact) => {
      const canonical = canonicalizeArtifact(artifact, bookId, oldBookId);
      artifactIdMap.set(artifact.artifactId, canonical.artifactId);
      return canonical;
    });
    await writeYamlFile(this.artifactManifestPath(bookId), {
      schemaVersion: SchemaVersion,
      items: dedupeArtifacts(canonicalArtifacts),
    });

    const job = await readYamlFile(this.bookJobPath(bookId), BookJobSchema, null);
    if (job != null) {
      await writeYamlFile(this.bookJobPath(bookId), {
        ...job,
        bookId,
        metadata: mergeJobMetadata(job.metadata),
      });
    }

    const checkpoints = await readYamlFile(
      this.stageCheckpointPath(bookId),
      {
        parse: (value) => migrateLegacyStageCheckpointList(value, {
          bookId,
          artifacts: canonicalArtifacts,
          job,
        }),
      },
      EMPTY_CHECKPOINT_LIST,
    );
    await writeYamlFile(this.stageCheckpointPath(bookId), {
      schemaVersion: SchemaVersion,
      items: checkpoints.items.map((checkpoint) => ({
        ...checkpoint,
        bookId,
        artifactIds: remapArtifactIds(checkpoint.artifactIds, artifactIdMap),
      })),
    });

    await this.rewriteLegacyRunRecords(bookId, artifactIdMap);
    await this.removeLegacyBookCatalogEntries(oldBookId, bookId);

    const catalog = await readYamlFile(
      this.runCatalogPath(),
      BookJobRunCatalogSchema,
      EMPTY_RUN_CATALOG,
    );
    if (catalog.items.some((item) => item.bookId === oldBookId)) {
      await writeYamlFile(this.runCatalogPath(), {
        schemaVersion: SchemaVersion,
        items: catalog.items.map((item) =>
          item.bookId === oldBookId ? { ...item, bookId } : item,
        ),
      });
    }
  }

  private async rewriteLegacyCatalogReferences(
    oldBookId: string,
    newBookId: string,
  ): Promise<void> {
    const sources = await readYamlFile(
      this.sourceDocumentCatalogPath(),
      SourceDocumentCatalogSchema,
      EMPTY_SOURCE_DOCUMENT_CATALOG,
    );
    if (sources.items.some((item) => item.metadata?.bookId === oldBookId)) {
      await writeYamlFile(this.sourceDocumentCatalogPath(), {
        schemaVersion: SchemaVersion,
        items: sources.items.map((item) => ({
          ...item,
          metadata: mergeJobMetadata(item.metadata, { bookId: newBookId }),
        })),
      });
    }

    const identities = await readYamlFile(
      this.documentIdentityCatalogPath(),
      DocumentIdentityCatalogSchema,
      EMPTY_DOCUMENT_IDENTITY_CATALOG,
    );
    if (identities.items.some((item) => item.canonicalBookId === oldBookId)) {
      await writeYamlFile(this.documentIdentityCatalogPath(), {
        schemaVersion: SchemaVersion,
        items: identities.items.map((item) =>
          item.canonicalBookId === oldBookId
            ? DocumentIdentityMapSchema.parse({
                ...item,
                canonicalBookId: newBookId,
                metadata: mergeJobMetadata(item.metadata, { bookId: newBookId }),
              })
            : item,
        ),
      });
    }

    await this.rewriteRunCatalogBookId(oldBookId, newBookId);
  }

  private async rewriteLegacyRunRecords(
    bookId: string,
    artifactIdMap: Map<string, string>,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(join(this.bookDir(bookId), "runs"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".yaml"))
        .map(async (entry) => {
          const path = join(this.bookDir(bookId), "runs", entry);
          const record = await readYamlFile(path, BookJobRunRecordSchema, null);
          if (record == null) {
            return;
          }
          await writeYamlFile(path, {
            ...record,
            bookId,
            artifactIds: remapArtifactIds(record.artifactIds, artifactIdMap),
          });
        }),
    );
  }

  private async rewriteRunCatalogBookId(
    oldBookId: string,
    newBookId: string,
  ): Promise<void> {
    const catalog = await readYamlFile(
      this.runCatalogPath(),
      BookJobRunCatalogSchema,
      EMPTY_RUN_CATALOG,
    );
    if (!catalog.items.some((item) => item.bookId === oldBookId)) {
      return;
    }

    await writeYamlFile(this.runCatalogPath(), {
      schemaVersion: SchemaVersion,
      items: catalog.items.map((item) =>
        item.bookId === oldBookId ? { ...item, bookId: newBookId } : item,
      ),
    });
  }

  private async removeLegacyBookCatalogEntries(
    oldBookId: string,
    newBookId: string,
  ): Promise<void> {
    const catalog = await readBookJobCatalogFile(this.bookCatalogPath());
    const items = catalog.items.filter((item) => item.bookId !== oldBookId);
    if (items.length !== catalog.items.length) {
      await writeYamlFile(this.bookCatalogPath(), {
        schemaVersion: SchemaVersion,
        items,
      });
    }
  }

  private async buildArtifactValidity(
    bookId: string,
    checkpoints: BookJobStageCheckpoint[],
    requirements: StageArtifactRequirementMap,
  ): Promise<Map<BookStage, ArtifactStageValidity>> {
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

    for (const checkpoint of checkpoints) {
      if (!stagesToValidate.has(checkpoint.stage)) {
        continue;
      }

      const requiredKinds = requirements[checkpoint.stage] ?? [];
      const artifactValidation = await validateBookArtifactSet({
        graphVault: this.rootDir,
        bookId,
        artifactIds: checkpoint.artifactIds,
        artifacts,
        requiredKinds,
      });

      result.set(checkpoint.stage, {
        isSatisfied: artifactValidation.isSatisfied,
        missingArtifactIds: artifactValidation.missingArtifactIds,
        missingArtifactKinds: artifactValidation.missingArtifactKinds,
      });
    }

    return result;
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
      const recordPath = this.runRecordPath(bookId, runId);
      const record = await readYamlFile(
        recordPath,
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
    const existing = await this.getStageCheckpoint(input.bookId, input.stage);
    const now = toIsoTimestamp();
    const job = await this.getBookJob(input.bookId);
    const artifactIds = input.artifactIds ?? existing?.artifactIds ?? [];
    const stageArtifacts = artifactIds.length === 0
      ? []
      : (await this.listArtifacts(input.bookId)).filter((artifact) =>
          artifactIds.includes(artifact.artifactId) && artifact.stage === input.stage
        );
    const firstStageArtifact = stageArtifacts[0];
    const checkpointContentHash =
      input.contentHash ??
      firstStageArtifact?.contentHash ??
      job?.normalizedContentHash ??
      job?.sourceHash;
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
      const validation = await validateBookArtifactSet({
        graphVault: this.rootDir,
        bookId: input.bookId,
        artifactIds: checkpoint.artifactIds,
        artifacts,
        requiredKinds: QUERY_READY_ARTIFACT_KINDS,
      });
      if (!validation.isSatisfied) {
        throw new Error(
          "query_ready checkpoint requires valid GraphRAG query artifacts: " +
            JSON.stringify({
              missingArtifactIds: validation.missingArtifactIds,
              missingArtifactKinds: validation.missingArtifactKinds,
            }),
        );
      }
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
    const runs = await this.listRunRecords(input.bookId);
    for (const run of runs) {
      if (
        run.stage !== input.stage ||
        run.status !== "running" ||
        run.runId === input.exceptRunId
      ) {
        continue;
      }
      await this.appendRunRecord({
        ...run,
        status: "abandoned",
        finishedAt: input.finishedAt,
        errorSummary: "run superseded by successful stage completion",
        metadata: {
          ...(run.metadata ?? {}),
          supersededByRunId: input.exceptRunId,
        },
      });
    }
  }

  private async publishGraphCapabilities(
    job: BookJob,
    checkpoint: BookJobStageCheckpoint,
    createdAt: string,
  ): Promise<void> {
    const base = {
      schemaVersion: SchemaVersion,
      bookId: job.bookId,
      sourceId: `sha256:${job.sourceHash}`,
      documentId: job.documentId,
      contentHash: job.normalizedContentHash ?? job.sourceHash,
      ready: true,
      readinessSource: "validated_checkpoint_plus_validated_manifest" as const,
      artifactIds: checkpoint.artifactIds,
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
      await recordGraphCapability(this.rootDir, capability);
    }
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

  private bookJobPath(bookId: string): string {
    return join(this.bookDir(bookId), "job.yaml");
  }

  private stageCheckpointPath(bookId: string): string {
    return join(this.bookDir(bookId), "checkpoints.yaml");
  }

  private artifactManifestPath(bookId: string): string {
    return join(this.bookDir(bookId), "artifacts.yaml");
  }

  private runRecordPath(bookId: string, runId: string): string {
    return join(this.bookDir(bookId), "runs", `${runId}.yaml`);
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
    const validation = await validateBookArtifactSet({
      graphVault: this.rootDir,
      bookId: job.bookId,
      artifactIds,
      artifacts,
      requiredKinds: QUERY_READY_ARTIFACT_KINDS,
    });
    if (!validation.isSatisfied) return false;
    try {
      await this.validateQueryReadyGraphIdentity(job);
      return true;
    } catch {
      return false;
    }
  }
}
