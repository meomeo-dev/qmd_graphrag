import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  type BookArtifactKind,
  BookArtifactManifestListSchema,
  BookJobCheckpointListSchema,
  BookJobRunCatalogSchema,
  BookJobRunRecordSchema,
  type BookArtifactManifest,
  type BookJob,
  type BookJobRunRecord,
  type BookJobStageCheckpoint,
  type BookStage,
} from "../contracts/book-job.js";
import { DocumentIdentityCatalogSchema } from "../contracts/corpus.js";
import type { DocumentIdentityMap } from "../contracts/corpus.js";
import {
  GraphCapabilityCatalogSchema,
  GraphCapabilitySchema,
  type GraphCapability,
} from "../contracts/graph-enhancement.js";
import { SchemaVersion } from "../contracts/common.js";
import type { QmdRetrievalCandidate } from "../contracts/qmd-query.js";
import {
  GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  QUERY_READY_ARTIFACT_KINDS,
  validateBookArtifactSet,
} from "../job-state/artifact-validation.js";
import {
  readYamlUnknownDurable,
  readYamlUnknownDurableUnlocked,
  updateYamlUnknownDurable,
} from "../job-state/durable-state-store.js";
import { sanitizeVaultMetadata } from "../vault/metadata.js";
import {
  ensureCatalogProjectionFromBookHotplugPackages,
  rebuildCatalogFromBookHotplugPackages,
} from "./book-hotplug-catalog.js";
import { readHotplugPackageUnknown } from "./book-hotplug-package-readonly.js";
import {
  listPublishedHotplugBookIds,
  projectHotplugBookJob,
  projectHotplugDocumentIdentity,
} from "./book-hotplug-package-projection.js";
import { validateHotplugRuntimeQueryGate } from "./book-hotplug-runtime-gate.js";
import {
  loadBookJobFromCatalog,
  loadBookJobFromState,
  loadCatalogBookJobs,
  loadScopedBookJobsFromState,
  hasPublishedScopedBookPackage,
  projectDocumentIdentityFromBookState,
} from "./book-state-reader.js";
import {
  resolveBookManifestPath,
  resolveBookPublishReadyPath,
  resolveBookRunDir,
  resolveBookStateFile,
  rewriteLegacyGraphArtifactPath,
} from "./book-package-layout.js";

const QUERY_READY_PRODUCER_REQUIRED_KINDS = {
  graph_extract: GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  community_report: ["graphrag_community_reports_parquet"],
  embed: ["lancedb_index"],
} as const satisfies Record<
  "graph_extract" | "community_report" | "embed",
  readonly string[]
>;

const QUERY_READY_LINEAGE_ARTIFACT_KINDS = [
  ...GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  ...QUERY_READY_ARTIFACT_KINDS,
] as const satisfies readonly BookArtifactKind[];

const QUERY_READY_PRODUCER_STAGES = [
  "graph_extract",
  "community_report",
  "embed",
] as const satisfies readonly BookStage[];

type QueryReadyProducerStage = (typeof QUERY_READY_PRODUCER_STAGES)[number];

type CheckpointCandidate = Pick<
  BookJobStageCheckpoint,
  | "bookId"
  | "stage"
  | "status"
  | "runId"
  | "startedAt"
  | "finishedAt"
  | "inputFingerprint"
  | "contentHash"
  | "stageFingerprint"
  | "providerFingerprint"
  | "artifactIds"
  | "metadata"
>;

export type QueryReadyLineageProjection = {
  artifactIds: string[];
  artifacts: BookArtifactManifest[];
  book: BookJob;
  expectedProducerRunIds: Partial<Record<BookStage, string>>;
};

function dedupeBookJobs(books: readonly BookJob[]): BookJob[] {
  const byBookId = new Map<string, BookJob>();
  for (const book of books) {
    if (!byBookId.has(book.bookId)) byBookId.set(book.bookId, book);
  }
  return [...byBookId.values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
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

function artifactIdsForProducerStage(input: {
  artifacts: readonly BookArtifactManifest[];
  bookId: string;
  stage: QueryReadyProducerStage;
  producerRunId: string;
  requiredKinds: readonly BookArtifactKind[];
}): string[] {
  const requiredKindSet = new Set<BookArtifactKind>(input.requiredKinds);
  return input.artifacts
    .filter((artifact) =>
      artifact.bookId === input.bookId &&
      artifact.stage === input.stage &&
      artifact.producerRunId === input.producerRunId &&
      requiredKindSet.has(artifact.kind)
    )
    .map((artifact) => artifact.artifactId);
}

function artifactIdsForQueryReadyGate(input: {
  artifacts: readonly BookArtifactManifest[];
  bookId: string;
  expectedProducerRunIds: Partial<Record<BookStage, string>>;
}): string[] {
  return [
    input.expectedProducerRunIds.community_report == null
      ? []
      : artifactIdsForProducerStage({
          artifacts: input.artifacts,
          bookId: input.bookId,
          stage: "community_report",
          producerRunId: input.expectedProducerRunIds.community_report,
          requiredKinds: QUERY_READY_PRODUCER_REQUIRED_KINDS.community_report,
        }),
    input.expectedProducerRunIds.embed == null
      ? []
      : artifactIdsForProducerStage({
          artifacts: input.artifacts,
          bookId: input.bookId,
          stage: "embed",
          producerRunId: input.expectedProducerRunIds.embed,
          requiredKinds: QUERY_READY_PRODUCER_REQUIRED_KINDS.embed,
        }),
  ].flat();
}

function expectedContentHash(book: BookJob): string {
  return book.normalizedContentHash ?? book.sourceHash;
}

function metadataString(
  metadata: BookJobRunRecord["metadata"] | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function checkpointTimestamp(checkpoint: CheckpointCandidate): string {
  return checkpoint.finishedAt ?? checkpoint.startedAt ?? "";
}

function currentCheckpointBlocksRecoveredCandidate(
  checkpoint: CheckpointCandidate | undefined,
): boolean {
  return checkpoint != null &&
    checkpoint.status !== "succeeded";
}

function runRecordToCheckpointCandidate(
  record: BookJobRunRecord,
  book: BookJob,
): CheckpointCandidate {
  return {
    bookId: record.bookId,
    stage: record.stage,
    status: record.status,
    runId: record.runId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    inputFingerprint: record.inputFingerprint,
    contentHash: expectedContentHash(book),
    stageFingerprint: metadataString(record.metadata, "stageFingerprint") ??
      record.inputFingerprint,
    providerFingerprint: metadataString(record.metadata, "providerFingerprint") ??
      book.providerFingerprint,
    artifactIds: record.artifactIds,
    metadata: record.metadata,
  };
}

async function loadRunRecordCandidates(
  graphVault: string,
  book: BookJob,
): Promise<CheckpointCandidate[]> {
  const runDir = resolveBookRunDir(graphVault, book.bookId);
  const records: Array<BookJobRunRecord | null> = [];
  if (existsSync(runDir)) {
    const runFiles = readdirSync(runDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    for (const runFile of runFiles) {
      const raw = await readPackageYaml(join(runDir, runFile));
      const result = BookJobRunRecordSchema.safeParse(raw);
      records.push(
        result.success && result.data.bookId === book.bookId
          ? result.data
          : null,
      );
    }
  }
  if (records.some((record) => record != null)) {
    return records
      .filter((record): record is BookJobRunRecord => record != null)
      .map((record) => runRecordToCheckpointCandidate(record, book));
  }

  const catalogRaw = await readYaml(join(graphVault, "catalog", "runs.yaml"));
  const catalogResult = BookJobRunCatalogSchema.safeParse(catalogRaw);
  if (!catalogResult.success) return [];

  for (const item of catalogResult.data.items.filter((entry) =>
    entry.bookId === book.bookId
  )) {
    const raw = await readPackageYaml(
      join(resolveBookRunDir(graphVault, book.bookId), `${item.runId}.yaml`),
    );
    const result = BookJobRunRecordSchema.safeParse(raw);
    records.push(result.success ? result.data : null);
  }
  return records
    .filter((record): record is BookJobRunRecord => record != null)
    .map((record) => runRecordToCheckpointCandidate(record, book));
}

async function loadCheckpointCandidates(
  graphVault: string,
  book: BookJob,
): Promise<CheckpointCandidate[] | null> {
  const checkpointsRaw = await readPackageYaml(
    resolveBookStateFile(graphVault, book.bookId, "checkpoints.yaml"),
  );
  const checkpointsResult = BookJobCheckpointListSchema.safeParse(checkpointsRaw);
  if (!checkpointsResult.success) return null;
  return [
    ...checkpointsResult.data.items,
    ...await loadRunRecordCandidates(graphVault, book),
  ].sort((left, right) =>
    checkpointTimestamp(right).localeCompare(checkpointTimestamp(left)),
  );
}

async function loadCurrentCheckpointCandidates(
  graphVault: string,
  bookId: string,
): Promise<CheckpointCandidate[] | null> {
  const checkpointsRaw = await readPackageYaml(
    resolveBookStateFile(graphVault, bookId, "checkpoints.yaml"),
  );
  const checkpointsResult = BookJobCheckpointListSchema.safeParse(checkpointsRaw);
  if (!checkpointsResult.success) return null;
  return checkpointsResult.data.items;
}

function checkpointMatchesBook(
  checkpoint: CheckpointCandidate,
  book: BookJob,
  options: { requireRunId?: boolean } = {},
): boolean {
  const stageFingerprint = book.stageFingerprints?.[checkpoint.stage];
  if (stageFingerprint == null || book.providerFingerprint == null) return false;
  return checkpoint.bookId === book.bookId &&
    checkpoint.status === "succeeded" &&
    checkpoint.metadata?.bootstrap !== true &&
    (options.requireRunId === false || checkpoint.runId != null) &&
    checkpoint.contentHash === expectedContentHash(book) &&
    checkpoint.stageFingerprint === stageFingerprint &&
    checkpoint.providerFingerprint === book.providerFingerprint;
}

async function selectProducerCheckpoint(input: {
  graphVault: string;
  book: BookJob;
  artifacts: readonly BookArtifactManifest[];
  candidates: readonly CheckpointCandidate[];
  stage: QueryReadyProducerStage;
}): Promise<CheckpointCandidate | null> {
  for (const checkpoint of input.candidates) {
    if (
      checkpoint.stage !== input.stage ||
      !checkpointMatchesBook(checkpoint, input.book)
    ) {
      continue;
    }
    const requiredKinds = QUERY_READY_PRODUCER_REQUIRED_KINDS[input.stage];
    const artifactIds = artifactIdsForProducerStage({
      artifacts: input.artifacts,
      bookId: input.book.bookId,
      stage: input.stage,
      producerRunId: checkpoint.runId!,
      requiredKinds,
    });
    const validation = await validateBookArtifactSet({
      graphVault: input.graphVault,
      bookId: input.book.bookId,
      artifactIds,
      artifacts: input.artifacts,
      requiredKinds,
      allowedKinds: requiredKinds,
      requireBookScopedGraphOutput: true,
      expectedProducerRunIds: { [input.stage]: checkpoint.runId },
      expectedStageFingerprints: input.book.stageFingerprints,
      expectedProviderFingerprint: input.book.providerFingerprint,
      expectedCorpusContentHash: expectedContentHash(input.book),
    });
    if (validation.isSatisfied) return checkpoint;
  }
  return null;
}

async function selectQueryReadyCheckpoint(input: {
  graphVault: string;
  book: BookJob;
  artifacts: readonly BookArtifactManifest[];
  candidates: readonly CheckpointCandidate[];
  expectedProducerRunIds: Partial<Record<BookStage, string>>;
}): Promise<CheckpointCandidate | null> {
  for (const checkpoint of input.candidates) {
    if (
      checkpoint.stage !== "query_ready" ||
      !checkpointMatchesBook(checkpoint, input.book, { requireRunId: false })
    ) {
      continue;
    }
    const validation = await validateBookArtifactSet({
      graphVault: input.graphVault,
      bookId: input.book.bookId,
      artifactIds: artifactIdsForQueryReadyGate({
        artifacts: input.artifacts,
        bookId: input.book.bookId,
        expectedProducerRunIds: input.expectedProducerRunIds,
      }),
      artifacts: input.artifacts,
      requiredKinds: QUERY_READY_ARTIFACT_KINDS,
      allowedKinds: QUERY_READY_ARTIFACT_KINDS,
      requireBookScopedGraphOutput: true,
      expectedProducerRunIds: input.expectedProducerRunIds,
      expectedStageFingerprints: input.book.stageFingerprints,
      expectedProviderFingerprint: input.book.providerFingerprint,
      expectedCorpusContentHash: expectedContentHash(input.book),
    });
    if (validation.isSatisfied) return checkpoint;
  }
  return null;
}

export type ResolveGraphCapabilitiesInput = {
  graphVault: string;
  bookIds?: readonly (string | null | undefined)[];
  documentIds?: readonly (string | null | undefined)[];
  sourceIds?: readonly (string | null | undefined)[];
};

type CapabilityScope = {
  bookIds: ReadonlySet<string>;
  documentIds: ReadonlySet<string>;
  sourceIds: ReadonlySet<string>;
};

type QueryReadyLineageCache = Map<
  string,
  Promise<QueryReadyLineageProjection | null>
>;

async function loadBookForQueryReadyLineage(
  graphVault: string,
  bookId: string,
): Promise<BookJob | null> {
  const hotplugBook = await projectHotplugBookJob(graphVault, bookId);
  if (hotplugBook != null) return hotplugBook;
  const stateBook = await loadBookJobFromState(graphVault, bookId);
  if (stateBook != null) return stateBook;
  return loadBookJobFromCatalog(graphVault, bookId);
}

async function readYaml(path: string): Promise<unknown | null> {
  return readYamlUnknownDurable(path);
}

async function readPackageYaml(path: string): Promise<unknown | null> {
  return readHotplugPackageUnknown(path);
}

async function readYamlUnlocked(path: string): Promise<unknown | null> {
  return readYamlUnknownDurableUnlocked(path);
}

async function updateYamlFileDurable<T>(
  path: string,
  readCurrent: () => Promise<T>,
  update: (current: T) => T | Promise<T>,
): Promise<T> {
  return updateYamlUnknownDurable(path, readCurrent, update);
}

function normalizeIdentitySet(
  values: readonly (string | null | undefined)[] | undefined,
): Set<string> {
  return new Set((values ?? []).filter((value): value is string => !!value));
}

function matchesRequestedScope(
  capability: GraphCapability,
  bookIds: ReadonlySet<string>,
  documentIds: ReadonlySet<string>,
  sourceIds: ReadonlySet<string>,
): boolean {
  const hasScope = bookIds.size > 0 || documentIds.size > 0 || sourceIds.size > 0;
  if (!hasScope) return true;
  return bookIds.has(capability.bookId) ||
    documentIds.has(capability.documentId) ||
    sourceIds.has(capability.sourceId);
}

function bookMatchesRequestedScope(
  book: BookJob,
  scope: CapabilityScope,
): boolean {
  const hasScope = scope.bookIds.size > 0 ||
    scope.documentIds.size > 0 ||
    scope.sourceIds.size > 0;
  if (!hasScope) return true;
  return scope.bookIds.has(book.bookId) ||
    scope.documentIds.has(book.documentId) ||
    scope.sourceIds.has(`sha256:${book.sourceHash}`);
}

function methodCapabilities(
  base: Omit<GraphCapability, "capabilityId" | "kind" | "method">,
): GraphCapability[] {
  return [
    GraphCapabilitySchema.parse({
      ...base,
      capabilityId: `${base.bookId}:graph_query`,
      kind: "graph_query",
    }),
    GraphCapabilitySchema.parse({
      ...base,
      capabilityId: `${base.bookId}:local_search`,
      kind: "local_search",
      method: "local",
    }),
    GraphCapabilitySchema.parse({
      ...base,
      capabilityId: `${base.bookId}:global_search`,
      kind: "global_search",
      method: "global",
    }),
    GraphCapabilitySchema.parse({
      ...base,
      capabilityId: `${base.bookId}:drift_search`,
      kind: "drift_search",
      method: "drift",
    }),
    GraphCapabilitySchema.parse({
      ...base,
      capabilityId: `${base.bookId}:community_reports`,
      kind: "community_reports",
    }),
  ];
}

async function hasQueryReadyHotplugPackage(graphVault: string): Promise<boolean> {
  const booksDir = join(graphVault, "books");
  if (!existsSync(booksDir)) return false;
  const bookIds = readdirSync(booksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  for (const bookId of bookIds) {
    if (!existsSync(resolveBookPublishReadyPath(graphVault, bookId))) continue;
    const manifest = await readPackageYaml(
      resolveBookManifestPath(graphVault, bookId),
    );
    if (
      manifest != null &&
      typeof manifest === "object" &&
      (manifest as { kind?: unknown }).kind === "qmd_graphrag_book_package" &&
      (manifest as { graphrag?: { queryReady?: unknown } }).graphrag
        ?.queryReady === true
    ) {
      return true;
    }
  }
  return false;
}

export async function projectQueryReadyLineage(
  graphVault: string,
  bookId: string,
): Promise<QueryReadyLineageProjection | null> {
  const runtimeGate = await validateHotplugRuntimeQueryGate({ graphVault, bookId });
  if (!runtimeGate.ok) return null;
  const book = await loadBookForQueryReadyLineage(graphVault, bookId);
  if (
    book == null ||
    book.stageFingerprints == null ||
    book.providerFingerprint == null
  ) {
    return null;
  }

  const artifactsRaw = await readPackageYaml(
    resolveBookStateFile(graphVault, bookId, "artifacts.yaml"),
  );
  if (artifactsRaw == null) return null;
  const artifactsResult = BookArtifactManifestListSchema.safeParse(artifactsRaw);
  if (!artifactsResult.success) return null;
  const artifacts = artifactsResult.data.items.map((artifact) => ({
    ...artifact,
    path: rewriteLegacyGraphArtifactPath(bookId, artifact.path),
  }));
  const currentCheckpoints = await loadCurrentCheckpointCandidates(graphVault, bookId);
  if (currentCheckpoints == null) return null;
  const candidates = await loadCheckpointCandidates(graphVault, book);
  if (candidates == null) return null;
  const currentByStage = new Map(
    currentCheckpoints
      .filter((checkpoint) =>
        checkpoint.bookId === bookId &&
        QUERY_READY_PRODUCER_STAGES.includes(
          checkpoint.stage as QueryReadyProducerStage,
        )
      )
      .map((checkpoint) => [checkpoint.stage, checkpoint]),
  );
  if (
    QUERY_READY_PRODUCER_STAGES.some((stage) =>
      currentCheckpointBlocksRecoveredCandidate(currentByStage.get(stage))
    )
  ) {
    return null;
  }

  const producerCheckpoints = await Promise.all(
    QUERY_READY_PRODUCER_STAGES.map(async (stage) => ({
      stage,
      checkpoint: await selectProducerCheckpoint({
        graphVault,
        book,
        artifacts,
        candidates,
        stage,
      }),
    })),
  );
  if (producerCheckpoints.some((item) => item.checkpoint == null)) {
    return null;
  }
  const expectedProducerRunIds = Object.fromEntries(
    producerCheckpoints.map(({ stage, checkpoint }) => [
      stage,
      checkpoint?.runId,
    ]),
  ) as Partial<Record<BookStage, string>>;
  const queryReadyCheckpoint = await selectQueryReadyCheckpoint({
    graphVault,
    book,
    artifacts,
    candidates,
    expectedProducerRunIds,
  });
  if (queryReadyCheckpoint == null) return null;

  const artifactIds = [
    ...QUERY_READY_PRODUCER_STAGES.flatMap((stage) =>
      artifactIdsForProducerStage({
        artifacts,
        bookId,
        stage,
        producerRunId: expectedProducerRunIds[stage]!,
        requiredKinds: QUERY_READY_PRODUCER_REQUIRED_KINDS[stage],
      })
    ),
    ...artifactIdsForQueryReadyGate({
      artifacts,
      bookId,
      expectedProducerRunIds,
    }),
  ];

  const validation = await validateBookArtifactSet({
    graphVault,
    bookId,
    artifactIds: uniqueStrings(artifactIds),
    artifacts,
    requiredKinds: QUERY_READY_LINEAGE_ARTIFACT_KINDS,
    allowedKinds: QUERY_READY_LINEAGE_ARTIFACT_KINDS,
    requireBookScopedGraphOutput: true,
    expectedProducerRunIds,
    expectedStageFingerprints: book.stageFingerprints,
    expectedProviderFingerprint: book.providerFingerprint,
    expectedCorpusContentHash: expectedContentHash(book),
  });
  if (!validation.isSatisfied) return null;

  return {
    artifactIds: uniqueStrings(artifactIds),
    artifacts,
    book,
    expectedProducerRunIds,
  };
}

function queryReadyLineageProjection(
  graphVault: string,
  bookId: string,
  cache?: QueryReadyLineageCache,
): Promise<QueryReadyLineageProjection | null> {
  if (cache == null) return projectQueryReadyLineage(graphVault, bookId);
  const cached = cache.get(bookId);
  if (cached != null) return cached;
  const projected = projectQueryReadyLineage(graphVault, bookId);
  cache.set(bookId, projected);
  return projected;
}

async function validateQueryReadyArtifacts(
  graphVault: string,
  bookId: string,
  artifactIds: readonly string[],
  cache?: QueryReadyLineageCache,
): Promise<boolean> {
  const projection = await queryReadyLineageProjection(graphVault, bookId, cache);
  if (projection == null) return false;
  return isSubsetOf(artifactIds, projection.artifactIds);
}

async function loadQueryReadyLineageArtifactIds(
  graphVault: string,
  bookId: string,
  cache?: QueryReadyLineageCache,
): Promise<string[] | null> {
  return (await queryReadyLineageProjection(graphVault, bookId, cache))
    ?.artifactIds ?? null;
}

function isSubsetOf(
  values: readonly string[],
  allowedValues: readonly string[],
): boolean {
  const allowed = new Set(allowedValues);
  return values.every((value) => allowed.has(value));
}

export async function loadExplicitCapabilityCatalog(
  graphVault: string,
): Promise<GraphCapability[]> {
  const catalogPath = join(graphVault, "catalog", "graph-capabilities.yaml");
  const parsed = await readYaml(catalogPath);
  if (parsed == null) return [];
  return GraphCapabilityCatalogSchema.parse(parsed).items;
}

async function filterValidatedCapabilities(
  graphVault: string,
  capabilities: readonly GraphCapability[],
  scope: CapabilityScope,
  lineageCache?: QueryReadyLineageCache,
): Promise<GraphCapability[]> {
  const identityRaw = await readYaml(
    join(graphVault, "catalog", "document-identity-map.yaml"),
  );
  const identities = identityRaw == null
    ? []
    : DocumentIdentityCatalogSchema.parse(identityRaw).items;
  const result: GraphCapability[] = [];
  for (const capability of capabilities) {
    if (!capability.ready) continue;
    if (
      !matchesRequestedScope(
        capability,
        scope.bookIds,
        scope.documentIds,
        scope.sourceIds,
      )
    ) {
      continue;
    }
    if (!capabilityHasGraphIdentity(capability, identities)) {
      continue;
    }
    const lineageArtifactIds = await loadQueryReadyLineageArtifactIds(
      graphVault,
      capability.bookId,
      lineageCache,
    );
    if (
      lineageArtifactIds == null ||
      !isSubsetOf(capability.artifactIds, lineageArtifactIds)
    ) {
      continue;
    }
    if (!(await validateQueryReadyArtifacts(
      graphVault,
      capability.bookId,
      lineageArtifactIds,
      lineageCache,
    ))) {
      continue;
    }
    result.push(GraphCapabilitySchema.parse({
      ...capability,
      artifactIds: lineageArtifactIds,
      metadata: sanitizeVaultMetadata({
        ...(capability.metadata ?? {}),
        lineageProjectionSource: "validated_checkpoint_plus_validated_manifest",
      }),
    }));
  }
  return result;
}

function capabilityHasGraphIdentity(
  capability: GraphCapability,
  identities: readonly DocumentIdentityMap[],
): boolean {
  const identity = identities.find((item) =>
    item.canonicalBookId === capability.bookId &&
    item.documentId === capability.documentId &&
    item.contentHash === capability.contentHash &&
    item.sourceId === capability.sourceId
  );
  return identity?.graphDocumentId != null &&
    identity.metadata?.qmdCorpusRegistered === true &&
    identity.graphTextUnitIds != null &&
    identity.graphTextUnitIds.length > 0;
}

async function deriveCapabilitiesFromBookState(
  graphVault: string,
  scope: CapabilityScope,
  lineageCache?: QueryReadyLineageCache,
): Promise<GraphCapability[]> {
  const scopedBookIds = scope.bookIds.size > 0
    ? [...scope.bookIds]
    : await listPublishedHotplugBookIds(graphVault);
  const hotplugBooks = (
    await Promise.all(scopedBookIds.map((bookId) =>
      projectHotplugBookJob(graphVault, bookId)
    ))
  ).filter((book): book is BookJob => book != null);
  const scopedStateBooks = await loadScopedBookJobsFromState(
    graphVault,
    scope.bookIds,
  );
  const catalogBooks = hotplugBooks.length > 0
    ? []
    : await loadCatalogBookJobs(graphVault);
  const books = dedupeBookJobs([
    ...hotplugBooks,
    ...scopedStateBooks,
    ...catalogBooks,
  ]);
  const identityRaw = await readYaml(
    join(graphVault, "catalog", "document-identity-map.yaml"),
  );
  const catalogIdentities = identityRaw == null
    ? []
    : DocumentIdentityCatalogSchema.parse(identityRaw).items;
  const hotplugIdentities = new Map(
    (await Promise.all(books.map((book) =>
      projectHotplugDocumentIdentity(graphVault, book.bookId)
    )))
      .filter((identity): identity is DocumentIdentityMap => identity != null)
      .map((identity) => [identity.canonicalBookId, identity]),
  );
  const stateIdentities = new Map(
    (await Promise.all(books.map((book) =>
      projectDocumentIdentityFromBookState(graphVault, book)
    )))
      .filter((identity): identity is DocumentIdentityMap => identity != null)
      .map((identity) => [identity.canonicalBookId, identity]),
  );
  const capabilities: GraphCapability[] = [];

  for (const book of books) {
    if (!bookMatchesRequestedScope(book, scope)) continue;
    const lineageArtifactIds = await loadQueryReadyLineageArtifactIds(
      graphVault,
      book.bookId,
      lineageCache,
    );
    if (lineageArtifactIds == null) continue;
    if (!(await validateQueryReadyArtifacts(
      graphVault,
      book.bookId,
      lineageArtifactIds,
      lineageCache,
    ))) {
      continue;
    }

    const expectedContentHash = book.normalizedContentHash ?? book.sourceHash;
    const expectedSourceId = `sha256:${book.sourceHash}`;
    const identity = hotplugIdentities.get(book.bookId) ??
      stateIdentities.get(book.bookId) ??
      catalogIdentities.find((item) =>
        item.canonicalBookId === book.bookId &&
        item.sourceId === expectedSourceId &&
        item.sourceHash === book.sourceHash &&
        item.documentId === book.documentId &&
        item.contentHash === expectedContentHash
      );
    if (
      identity == null ||
      identity.metadata?.qmdCorpusRegistered !== true ||
      identity.graphDocumentId == null ||
      identity.graphTextUnitIds == null ||
      identity.graphTextUnitIds.length === 0
    ) {
      continue;
    }
    const contentHash = identity.contentHash;
    const sourceId = identity.sourceId;
    const documentId = identity.documentId;
    const sourceName = typeof book.metadata?.sourceName === "string"
      ? book.metadata.sourceName
      : undefined;
    const projectionSource = hotplugIdentities.has(book.bookId)
      ? "book_hotplug_manifest"
      : stateIdentities.has(book.bookId)
        ? "book_state_identity"
      : "book_state";

    capabilities.push(...methodCapabilities({
      schemaVersion: SchemaVersion,
      bookId: book.bookId,
      sourceId,
      documentId,
      contentHash,
      ready: true,
      readinessSource: "validated_checkpoint_plus_validated_manifest",
      artifactIds: lineageArtifactIds,
      createdAt: new Date(0).toISOString(),
      metadata: sanitizeVaultMetadata({
        projectionSource,
        ...(sourceName ? { sourceName } : {}),
      }),
    }));
  }

  return capabilities;
}

function filterCapabilitiesByScope(
  capabilities: readonly GraphCapability[],
  scope: CapabilityScope,
): GraphCapability[] {
  return capabilities
    .filter((capability) => capability.ready)
    .filter((capability) =>
      matchesRequestedScope(capability, scope.bookIds, scope.documentIds, scope.sourceIds)
    );
}

async function loadGraphCapabilitiesFromProjection(
  graphVault: string,
  scope: CapabilityScope,
): Promise<GraphCapability[]> {
  const explicit = await loadExplicitCapabilityCatalog(graphVault);
  const lineageCache: QueryReadyLineageCache = new Map();
  const [derived, validatedExplicit] = await Promise.all([
    deriveCapabilitiesFromBookState(graphVault, scope, lineageCache),
    filterValidatedCapabilities(graphVault, explicit, scope, lineageCache),
  ]);
  const byCapabilityId = new Map<string, GraphCapability>();
  for (const capability of derived) {
    byCapabilityId.set(capability.capabilityId, capability);
  }
  const derivedSemanticKeys = new Set(derived.map(capabilitySemanticKey));
  for (const capability of validatedExplicit) {
    if (
      byCapabilityId.has(capability.capabilityId) ||
      derivedSemanticKeys.has(capabilitySemanticKey(capability))
    ) {
      continue;
    }
    byCapabilityId.set(capability.capabilityId, capability);
  }
  const capabilities = [...byCapabilityId.values()];

  return filterCapabilitiesByScope(capabilities, scope);
}

export async function loadGraphCapabilities(
  input: ResolveGraphCapabilitiesInput,
): Promise<GraphCapability[]> {
  const graphVault = resolve(input.graphVault);
  const bookIds = normalizeIdentitySet(input.bookIds);
  const documentIds = normalizeIdentitySet(input.documentIds);
  const sourceIds = normalizeIdentitySet(input.sourceIds);
  const scope = { bookIds, documentIds, sourceIds };
  if (
    bookIds.size === 0 ||
    hasPublishedScopedBookPackage(graphVault, bookIds)
  ) {
    await ensureCatalogProjectionFromBookHotplugPackages(graphVault);
  }
  const capabilities = await loadGraphCapabilitiesFromProjection(graphVault, scope);
  if (capabilities.length > 0 || !(await hasQueryReadyHotplugPackage(graphVault))) {
    return capabilities;
  }
  const rebuilt = await rebuildCatalogFromBookHotplugPackages(graphVault);
  const rebuiltCapabilities = filterCapabilitiesByScope(rebuilt.capabilities, scope);
  if (rebuiltCapabilities.length > 0) return rebuiltCapabilities;
  return loadGraphCapabilitiesFromProjection(graphVault, scope);
}

export async function loadGraphQueryCapabilities(
  input: ResolveGraphCapabilitiesInput,
): Promise<GraphCapability[]> {
  return (await loadGraphCapabilities(input)).filter(
    (capability) => capability.kind === "graph_query",
  );
}

export async function recordGraphCapability(
  graphVault: string,
  capability: GraphCapability,
  options: {
    beforeCommit?: () => void | Promise<void>;
    afterCommit?: () => void | Promise<void>;
  } = {},
): Promise<GraphCapability[]> {
  const root = resolve(graphVault);
  const catalogPath = join(root, "catalog", "graph-capabilities.yaml");
  const parsedCapability = GraphCapabilitySchema.parse(capability);
  const sanitizedCapability = GraphCapabilitySchema.parse({
    ...parsedCapability,
    metadata: sanitizeVaultMetadata(parsedCapability.metadata),
  });
  const catalog = await updateYamlFileDurable(
    catalogPath,
    async () => {
      const parsed = await readYamlUnlocked(catalogPath);
      if (parsed == null) {
        return GraphCapabilityCatalogSchema.parse({
          schemaVersion: SchemaVersion,
          items: [],
        });
      }
      return GraphCapabilityCatalogSchema.parse(parsed);
    },
    async (existingCatalog) => {
      const items = [
        ...existingCatalog.items.filter((item) =>
          item.capabilityId !== sanitizedCapability.capabilityId
        ),
        sanitizedCapability,
      ].sort((left, right) =>
        left.capabilityId.localeCompare(right.capabilityId)
      );
      const nextCatalog = GraphCapabilityCatalogSchema.parse({
        schemaVersion: SchemaVersion,
        items,
      });

      await options.beforeCommit?.();
      await mkdir(join(root, "catalog"), { recursive: true });
      return nextCatalog;
    },
  );
  await options.afterCommit?.();
  return catalog.items;
}

function capabilitySemanticKey(capability: GraphCapability): string {
  return [
    capability.bookId,
    capability.kind,
    capability.method ?? "",
  ].join("\0");
}

function candidateMatchesCapability(input: {
  candidate: QmdRetrievalCandidate;
  capability: GraphCapability;
  uniqueContentHashes: ReadonlySet<string>;
}): boolean {
  const { candidate, capability, uniqueContentHashes } = input;
  if (candidate.documentId != null && candidate.documentId === capability.documentId) {
    return true;
  }
  if (candidate.sourceId != null && candidate.sourceId === capability.sourceId) {
    return true;
  }
  if (
    candidate.contentHash != null &&
    uniqueContentHashes.has(candidate.contentHash) &&
    candidate.contentHash === capability.contentHash
  ) {
    return true;
  }
  return false;
}

export async function resolveCandidateGraphCapabilities(input: {
  graphVault: string;
  bookIds?: readonly (string | null | undefined)[];
  candidates: readonly QmdRetrievalCandidate[];
}): Promise<Map<string, GraphCapability[]>> {
  const capabilities = await loadGraphQueryCapabilities({
    graphVault: input.graphVault,
    bookIds: input.bookIds,
  });
  const contentHashCounts = new Map<string, number>();
  for (const capability of capabilities) {
    contentHashCounts.set(
      capability.contentHash,
      (contentHashCounts.get(capability.contentHash) ?? 0) + 1,
    );
  }
  const uniqueContentHashes = new Set(
    [...contentHashCounts.entries()]
      .filter(([, count]) => count === 1)
      .map(([contentHash]) => contentHash),
  );
  const byCandidateId = new Map<string, GraphCapability[]>();

  for (const candidate of input.candidates) {
    const matches = capabilities.filter((capability) =>
      candidateMatchesCapability({
        candidate,
        capability,
        uniqueContentHashes,
      }),
    );
    if (matches.length > 0) {
      byCandidateId.set(candidate.candidateId, matches);
    }
  }

  return byCandidateId;
}
