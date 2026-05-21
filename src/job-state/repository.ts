import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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
  buildBookId,
  buildBookIdFromSourceHash,
  createDeterministicHash,
  hashFile,
  normalizeBookSlug,
  toIsoTimestamp,
} from "./fingerprint.js";

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

const SINGLETON_ARTIFACT_KINDS = new Set<BookArtifactKind>(["source_epub"]);

export type RegisterBookSourceInput = {
  sourcePath: string;
  sourceIdentityPath?: string;
  canonicalSourcePath?: string;
  normalizedContentHash?: string;
  configFingerprint: string;
  promptFingerprint: string;
  modelFingerprint: string;
  metadata?: Record<string, JsonValue>;
};

export type RecordArtifactInput = {
  artifactId?: string;
  stage: BookStage;
  kind: BookArtifactKind;
  path: string;
  contentHash: string;
  producerRunId: string;
  metadata?: Record<string, JsonValue>;
};

export type StartStageInput = {
  bookId: string;
  stage: BookStage;
  runId: string;
  inputFingerprint: string;
  metadata?: Record<string, JsonValue>;
};

export type CompleteStageInput = {
  bookId: string;
  stage: BookStage;
  runId: string;
  inputFingerprint: string;
  artifactIds?: string[];
  metadata?: Record<string, JsonValue>;
};

export type FailStageInput = {
  bookId: string;
  stage: BookStage;
  runId: string;
  inputFingerprint: string;
  errorSummary: string;
  artifactIds?: string[];
  metadata?: Record<string, JsonValue>;
};

export type StageFingerprintMap = Partial<Record<BookStage, string>>;

export type StageArtifactRequirementMap = Partial<
  Record<BookStage, readonly BookArtifactKind[]>
>;

type WriteStageCheckpointInput = {
  bookId: string;
  stage: BookStage;
  runId: string;
  inputFingerprint: string;
  status: StageCheckpointStatus;
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
    if (!byLogicalKey.has(logicalKey)) {
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
  path: string;
  contentHash: string;
}): string {
  return createDeterministicHash([
    input.bookId,
    input.stage,
    input.kind,
    input.path,
    input.contentHash,
  ]);
}

function stripKnownSourceExtension(path: string): string {
  return path.replace(/\.(epub|md|markdown|txt)$/iu, "");
}

function createArtifactId(input: {
  bookId: string;
  stage: BookStage;
  kind: BookArtifactKind;
  path: string;
  contentHash: string;
}): string {
  return createArtifactLogicalKey(input);
}

function canonicalizeArtifact(
  artifact: BookArtifactManifest,
  bookId: string,
): BookArtifactManifest {
  const canonical = { ...artifact, bookId };
  return {
    ...canonical,
    artifactId: createArtifactId(canonical),
  };
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
  const metadata: Record<string, JsonValue> = {
    ...(existing ?? {}),
    ...(incoming ?? {}),
  };
  delete metadata.workspaceRoot;
  delete metadata.originalSourcePath;

  return Object.keys(metadata).length > 0 ? metadata : undefined;
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
    const sourceIdentityPath = input.sourceIdentityPath ?? sourcePath;
    const sourceHash = await hashFile(sourcePath);
    const now = toIsoTimestamp();
    const bookId = buildBookIdFromSourceHash(sourceIdentityPath, sourceHash);
    await this.migrateLegacyBookId(
      sourcePath,
      sourceIdentityPath,
      sourceHash,
      bookId,
    );
    const existing = await this.getBookJob(bookId);
    const canonicalSourcePath =
      input.canonicalSourcePath ?? existing?.sourcePath ?? sourcePath;

    const job = BookJobSchema.parse({
      schemaVersion: SchemaVersion,
      bookId,
      sourcePath: canonicalSourcePath,
      sourceHash,
      normalizedContentHash:
        input.normalizedContentHash ?? existing?.normalizedContentHash,
      configFingerprint: input.configFingerprint,
      promptFingerprint: input.promptFingerprint,
      modelFingerprint: input.modelFingerprint,
      currentStage: existing?.currentStage,
      overallStatus: existing?.overallStatus ?? "pending",
      lastSuccessRunId: existing?.lastSuccessRunId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      metadata: mergeJobMetadata(existing?.metadata, input.metadata),
    });

    await this.upsertBookJob(job);
    return job;
  }

  async upsertBookJob(job: BookJob): Promise<BookJob> {
    await this.ensureLayout();
    const parsed = BookJobSchema.parse(job);
    await writeYamlFile(this.bookJobPath(parsed.bookId), parsed);

    const catalog = await readYamlFile(
      this.bookCatalogPath(),
      BookJobCatalogSchema,
      EMPTY_BOOK_CATALOG,
    );
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
    const job = await readYamlFile(
      this.bookJobPath(bookId),
      BookJobSchema,
      null,
    );
    return job;
  }

  async listBookJobs(): Promise<BookJob[]> {
    const catalog = await readYamlFile(
      this.bookCatalogPath(),
      BookJobCatalogSchema,
      EMPTY_BOOK_CATALOG,
    );
    return catalog.items;
  }

  async listStageCheckpoints(bookId: string): Promise<BookJobStageCheckpoint[]> {
    const list = await readYamlFile(
      this.stageCheckpointPath(bookId),
      BookJobCheckpointListSchema,
      EMPTY_CHECKPOINT_LIST,
    );
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
    const existing = await this.listArtifacts(bookId);
    const now = toIsoTimestamp();

    const recorded = inputs.map((input) => {
      const artifactPath = this.relativeToRoot(input.path);
      const artifactId = createArtifactId({
        bookId,
        stage: input.stage,
        kind: input.kind,
        path: artifactPath,
        contentHash: input.contentHash,
      });
      return BookArtifactManifestSchema.parse({
        schemaVersion: SchemaVersion,
        artifactId: input.artifactId ?? artifactId,
        bookId,
        stage: input.stage,
        kind: input.kind,
        path: artifactPath,
        contentHash: input.contentHash,
        producerRunId: input.producerRunId,
        createdAt: now,
        metadata: input.metadata,
      });
    });

    const singletonKeys = new Set(
      recorded
        .filter((item) => SINGLETON_ARTIFACT_KINDS.has(item.kind))
        .map((item) => `${item.stage}:${item.kind}`),
    );
    const retained = existing.filter(
      (item) => !singletonKeys.has(`${item.stage}:${item.kind}`),
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
    const parsed = BookJobRunRecordSchema.parse(record);
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
    const currentDir = this.bookDir(currentBookId);
    try {
      await stat(currentDir);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

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

      await rename(legacyDir, currentDir);
      await this.rewriteLegacyBookState(currentBookId, legacyBookId);
      return;
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
      BookArtifactManifestListSchema,
      EMPTY_ARTIFACT_LIST,
    );
    const artifactIdMap = new Map<string, string>();
    const canonicalArtifacts = artifacts.items.map((artifact) => {
      const canonical = canonicalizeArtifact(artifact, bookId);
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
      BookJobCheckpointListSchema,
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

  private async removeLegacyBookCatalogEntries(
    oldBookId: string,
    newBookId: string,
  ): Promise<void> {
    const catalog = await readYamlFile(
      this.bookCatalogPath(),
      BookJobCatalogSchema,
      EMPTY_BOOK_CATALOG,
    );
    const items = catalog.items.filter(
      (item) => item.bookId !== oldBookId && item.bookId !== newBookId,
    );
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

    const artifactById = new Map(
      (await this.listArtifacts(bookId)).map((artifact) => [
        artifact.artifactId,
        artifact,
      ]),
    );
    const result = new Map<BookStage, ArtifactStageValidity>();

    for (const checkpoint of checkpoints) {
      if (!stagesToValidate.has(checkpoint.stage)) {
        continue;
      }

      const missingArtifactIds: string[] = [];
      const artifacts = await Promise.all(
        checkpoint.artifactIds.map(async (artifactId) => {
          const artifact = artifactById.get(artifactId);
          if (artifact == null) {
            missingArtifactIds.push(artifactId);
            return null;
          }
          if (!(await this.artifactPathExists(artifact.path))) {
            missingArtifactIds.push(artifactId);
            return null;
          }
          return artifact;
        }),
      );

      const availableKinds = new Set(
        artifacts
          .filter((artifact): artifact is BookArtifactManifest => artifact != null)
          .map((artifact) => artifact.kind),
      );
      const requiredKinds = requirements[checkpoint.stage] ?? [];
      const missingArtifactKinds = requiredKinds.filter(
        (kind) => !availableKinds.has(kind),
      );

      result.set(checkpoint.stage, {
        isSatisfied:
          missingArtifactIds.length === 0 && missingArtifactKinds.length === 0,
        missingArtifactIds: [...new Set(missingArtifactIds)],
        missingArtifactKinds,
      });
    }

    return result;
  }

  private async artifactPathExists(path: string): Promise<boolean> {
    try {
      await stat(isAbsolute(path) ? path : resolve(this.rootDir, path));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async writeStageCheckpoint(
    input: WriteStageCheckpointInput,
  ): Promise<BookJobStageCheckpoint> {
    await this.ensureLayout();
    const existing = await this.getStageCheckpoint(input.bookId, input.stage);
    const now = toIsoTimestamp();
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
      artifactIds: input.artifactIds ?? existing?.artifactIds ?? [],
      errorSummary: input.errorSummary,
      metadata: input.metadata,
    });

    const checkpoints = await this.listStageCheckpoints(input.bookId);
    await writeYamlFile(this.stageCheckpointPath(input.bookId), {
      schemaVersion: SchemaVersion,
      items: upsertCheckpoint(checkpoints, checkpoint),
    });

    const job = await this.getBookJob(input.bookId);
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

    return checkpoint;
  }

  private bookDir(bookId: string): string {
    return join(this.booksDir, bookId);
  }

  private bookCatalogPath(): string {
    return join(this.catalogDir, "books.yaml");
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

  private relativeToRoot(path: string): string {
    const absolutePath = resolve(path);
    return relative(this.rootDir, absolutePath) || ".";
  }
}
