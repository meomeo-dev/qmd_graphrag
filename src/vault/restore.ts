import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import YAML from "yaml";

import { SchemaVersion } from "../contracts/common.js";
import {
  BookArtifactManifestListSchema,
  type BookArtifactManifest,
  BookJobCatalogSchema,
  BookJobCheckpointListSchema,
  type BookStage,
} from "../contracts/book-job.js";
import {
  DocumentIdentityMapSchema,
  SourceDocumentSchema,
  type DocumentIdentityMap,
} from "../contracts/corpus.js";
import {
  GraphCapabilitySchema,
  type GraphCapability,
} from "../contracts/graph-enhancement.js";
import {
  VaultRestoreReportSchema,
  VaultRestoreRequestSchema,
  type VaultRestoreReport,
  type VaultRestoreRequest,
} from "../contracts/vault.js";
import {
  loadExplicitCapabilityCatalog,
  loadGraphCapabilities,
} from "../graphrag/capability-catalog.js";
import {
  sanitizeVaultMetadata,
  sanitizeVaultText,
} from "./metadata.js";
import {
  createStore,
  extractTitle,
  hashContent,
  insertContent,
  insertDocument,
  upsertStoreCollection,
} from "../store.js";
import { resolveVaultRelativePath } from "./path.js";
import {
  GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  QUERY_READY_ARTIFACT_KINDS,
  validateBookArtifactSet,
} from "../job-state/artifact-validation.js";

const QUERY_READY_PRODUCER_REQUIRED_KINDS = {
  graph_extract: GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  community_report: ["graphrag_community_reports_parquet"],
  embed: ["lancedb_index"],
} as const satisfies Record<
  "graph_extract" | "community_report" | "embed",
  readonly BookArtifactManifest["kind"][]
>;

const QUERY_READY_LINEAGE_ARTIFACT_KINDS = [
  ...GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  ...QUERY_READY_ARTIFACT_KINDS,
] as const satisfies readonly BookArtifactManifest["kind"][];

async function readYaml(path: string): Promise<unknown | null> {
  try {
    return YAML.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseCatalogItems<T>(
  value: unknown,
  schema: { parse(input: unknown): T },
): T[] {
  const items = (value as { items?: unknown[] } | null)?.items ?? [];
  return items.map((item) => schema.parse(item));
}

function getMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : null;
}

function identityNormalizedPath(identity: DocumentIdentityMap): string | null {
  if (typeof identity.normalizedPath === "string" && identity.normalizedPath) {
    return identity.normalizedPath;
  }
  return getMetadataString(
    identity.metadata as Record<string, unknown> | undefined,
    "normalizedPath",
  );
}

function ensureCapabilityMirror(store: ReturnType<typeof createStore>): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS qmd_graph_capabilities (
      capability_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      book_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      method TEXT,
      ready INTEGER NOT NULL,
      readiness_source TEXT NOT NULL,
      artifact_ids TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

function identityByDocumentId(
  identities: DocumentIdentityMap[],
): Map<string, DocumentIdentityMap> {
  return new Map(identities.map((identity) => [identity.documentId, identity]));
}

function validateCapabilityForRestore(
  capability: GraphCapability,
  identitiesByDocumentId: Map<string, DocumentIdentityMap>,
  restoredDocumentHashes: Map<string, string>,
): string | null {
  const identity = identitiesByDocumentId.get(capability.documentId);
  if (identity == null) {
    return "capability documentId is missing from document identity map";
  }
  const restoredContentHash = restoredDocumentHashes.get(capability.documentId);
  if (restoredContentHash == null) {
    return "capability documentId was not restored into qmd index";
  }
  if (restoredContentHash !== identity.contentHash) {
    return "restored document contentHash differs from document identity map";
  }
  if (capability.sourceId !== identity.sourceId) {
    return "capability sourceId differs from document identity map";
  }
  if (capability.bookId !== identity.canonicalBookId) {
    return "capability bookId differs from document identity map";
  }
  if (capability.contentHash !== identity.contentHash) {
    return "capability contentHash differs from document identity map";
  }
  return null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function filterArtifactIdsByKinds(
  artifactIds: readonly string[],
  artifacts: readonly BookArtifactManifest[],
  kinds: readonly BookArtifactManifest["kind"][],
): string[] {
  const kindSet = new Set<BookArtifactManifest["kind"]>(kinds);
  return artifactIds.filter((artifactId) => {
    const artifact = artifacts.find((candidate) =>
      candidate.artifactId === artifactId
    );
    return artifact != null && kindSet.has(artifact.kind);
  });
}

async function missingCapabilityPortablePaths(
  graphVault: string,
  identities: readonly DocumentIdentityMap[],
  capabilities: readonly GraphCapability[],
): Promise<string[]> {
  const missing: string[] = [];
  const graphIdentities = identities.filter((identity) =>
    identity.graphDocumentId != null &&
    (identity.graphTextUnitIds?.length ?? 0) > 0
  );

  if (graphIdentities.length === 0 && capabilities.length === 0) return missing;

  if (!(await pathExists(join(graphVault, "catalog", "books.yaml")))) {
    missing.push("catalog/books.yaml");
  } else {
    const booksRaw = await readYaml(join(graphVault, "catalog", "books.yaml"));
    try {
      BookJobCatalogSchema.parse(booksRaw);
    } catch {
      missing.push("catalog/books.yaml");
    }
  }

  const bookIds = [
    ...new Set([
      ...graphIdentities
        .map((identity) => identity.canonicalBookId)
        .filter((bookId): bookId is string => !!bookId),
      ...capabilities.map((capability) => capability.bookId),
    ]),
  ];

  for (const bookId of bookIds) {
    const checkpointsPath = `books/${bookId}/checkpoints.yaml`;
    const artifactsPath = `books/${bookId}/artifacts.yaml`;
    const checkpointsRaw = await readYaml(join(graphVault, checkpointsPath));
    const artifactsRaw = await readYaml(join(graphVault, artifactsPath));

    try {
      BookJobCheckpointListSchema.parse(checkpointsRaw);
    } catch {
      missing.push(checkpointsPath);
    }
    try {
      BookArtifactManifestListSchema.parse(artifactsRaw);
    } catch {
      missing.push(artifactsPath);
    }
  }

  if (capabilities.length === 0 && graphIdentities.length > 0) {
    missing.push("catalog/graph-capabilities.yaml");
  }

  return [...new Set(missing)];
}

function capabilityIdentityFailure(
  capability: GraphCapability,
  identities: readonly DocumentIdentityMap[],
): string | null {
  const identity = identities.find((item) =>
    item.canonicalBookId === capability.bookId &&
    item.documentId === capability.documentId &&
    item.contentHash === capability.contentHash &&
    item.sourceId === capability.sourceId
  );
  if (identity == null) {
    return "capability identity is missing from document identity map";
  }
  if (identity.graphDocumentId == null) {
    return "capability identity is missing graphDocumentId";
  }
  if ((identity.graphTextUnitIds?.length ?? 0) === 0) {
    return "capability identity is missing graphTextUnitIds";
  }
  if (identity.metadata?.qmdCorpusRegistered !== true) {
    return "capability identity is not registered in qmd corpus";
  }
  return null;
}

async function projectValidatedCapabilityForRestore(
  graphVault: string,
  capability: GraphCapability,
  identities: readonly DocumentIdentityMap[],
): Promise<{ capability?: GraphCapability; failure?: string }> {
  if (!capability.ready) return { failure: "capability is not ready" };
  const identityFailure = capabilityIdentityFailure(capability, identities);
  if (identityFailure != null) return { failure: identityFailure };

  const booksRaw = await readYaml(join(graphVault, "catalog", "books.yaml"));
  const booksResult = BookJobCatalogSchema.safeParse(booksRaw);
  if (!booksResult.success) {
    return { failure: "catalog/books.yaml is missing or invalid" };
  }
  const book = booksResult.data.items.find((item) =>
    item.bookId === capability.bookId
  );
  if (book == null) {
    return { failure: "capability bookId is missing from book catalog" };
  }
  if (book.documentId !== capability.documentId) {
    return { failure: "capability documentId differs from book catalog" };
  }

  const lineageArtifactIds = await loadQueryReadyLineageArtifactIdsForRestore(
    graphVault,
    capability.bookId,
  );
  if (lineageArtifactIds == null) {
    return { failure: "query_ready lineage checkpoint is missing or invalid" };
  }
  if (!capability.artifactIds.every((artifactId) =>
    lineageArtifactIds.includes(artifactId)
  )) {
    return {
      failure: "capability artifactIds are not covered by query_ready lineage",
    };
  }
  if (!(await validateQueryReadyArtifactsForRestore(
    graphVault,
    capability.bookId,
    lineageArtifactIds,
  ))) {
    return { failure: "capability artifacts are missing or invalid" };
  }
  return {
    capability: GraphCapabilitySchema.parse({
      ...capability,
      artifactIds: lineageArtifactIds,
      metadata: sanitizeVaultMetadata({
        ...(capability.metadata ?? {}),
        lineageProjectionSource: "validated_checkpoint_plus_validated_manifest",
      }),
    }),
  };
}

async function capabilitySourceMaterialFailure(
  graphVault: string,
  capability: GraphCapability,
  identities: readonly DocumentIdentityMap[],
): Promise<string | null> {
  return (await projectValidatedCapabilityForRestore(
    graphVault,
    capability,
    identities,
  )).failure ?? null;
}

async function loadQueryReadyLineageArtifactIdsForRestore(
  graphVault: string,
  bookId: string,
): Promise<string[] | null> {
  const checkpointsRaw = await readYaml(
    join(graphVault, "books", bookId, "checkpoints.yaml"),
  );
  const checkpointsResult =
    BookJobCheckpointListSchema.safeParse(checkpointsRaw);
  if (!checkpointsResult.success) return null;
  const checkpointByStage = new Map(
    checkpointsResult.data.items
      .filter((checkpoint) => checkpoint.status === "succeeded")
      .map((checkpoint) => [checkpoint.stage, checkpoint]),
  );
  const artifactsRaw = await readYaml(
    join(graphVault, "books", bookId, "artifacts.yaml"),
  );
  const artifactsResult = BookArtifactManifestListSchema.safeParse(artifactsRaw);
  if (!artifactsResult.success) return null;
  const artifacts = artifactsResult.data.items;
  const ids = [
    ...filterArtifactIdsByKinds(
      checkpointByStage.get("graph_extract")?.artifactIds ?? [],
      artifacts,
      QUERY_READY_PRODUCER_REQUIRED_KINDS.graph_extract,
    ),
    ...filterArtifactIdsByKinds(
      checkpointByStage.get("community_report")?.artifactIds ?? [],
      artifacts,
      QUERY_READY_PRODUCER_REQUIRED_KINDS.community_report,
    ),
    ...filterArtifactIdsByKinds(
      checkpointByStage.get("embed")?.artifactIds ?? [],
      artifacts,
      QUERY_READY_PRODUCER_REQUIRED_KINDS.embed,
    ),
    ...filterArtifactIdsByKinds(
      checkpointByStage.get("query_ready")?.artifactIds ?? [],
      artifacts,
      QUERY_READY_ARTIFACT_KINDS,
    ),
  ];
  return ids.length > 0 ? uniqueStrings(ids) : null;
}

async function validateQueryReadyArtifactsForRestore(
  graphVault: string,
  bookId: string,
  artifactIds: readonly string[],
): Promise<boolean> {
  const booksRaw = await readYaml(join(graphVault, "catalog", "books.yaml"));
  const booksResult = BookJobCatalogSchema.safeParse(booksRaw);
  if (!booksResult.success) return false;
  const book = booksResult.data.items.find((item) => item.bookId === bookId);
  if (
    book == null ||
    book.stageFingerprints == null ||
    book.providerFingerprint == null
  ) {
    return false;
  }

  const checkpointsRaw = await readYaml(
    join(graphVault, "books", bookId, "checkpoints.yaml"),
  );
  const checkpointsResult =
    BookJobCheckpointListSchema.safeParse(checkpointsRaw);
  if (!checkpointsResult.success) return false;
  const checkpointByStage = new Map(
    checkpointsResult.data.items
      .filter((checkpoint) => checkpoint.status === "succeeded")
      .map((checkpoint) => [checkpoint.stage, checkpoint]),
  );
  const graphExtractRunId = checkpointByStage.get("graph_extract")?.runId;
  const communityReportRunId = checkpointByStage.get("community_report")?.runId;
  const embedRunId = checkpointByStage.get("embed")?.runId;
  if (
    graphExtractRunId == null ||
    communityReportRunId == null ||
    embedRunId == null
  ) {
    return false;
  }
  const expectedProducerRunIds: Partial<Record<BookStage, string>> = {
    graph_extract: graphExtractRunId,
    community_report: communityReportRunId,
    embed: embedRunId,
  };
  const expectedContentHash = book.normalizedContentHash ?? book.sourceHash;
  for (const stage of [
    "graph_extract",
    "community_report",
    "embed",
    "query_ready",
  ] as const) {
    const checkpoint = checkpointByStage.get(stage);
    if (
      checkpoint == null ||
      checkpoint.contentHash !== expectedContentHash ||
      checkpoint.stageFingerprint !== book.stageFingerprints[stage] ||
      checkpoint.providerFingerprint !== book.providerFingerprint
    ) {
      return false;
    }
  }

  const artifactsRaw = await readYaml(
    join(graphVault, "books", bookId, "artifacts.yaml"),
  );
  const artifactsResult = BookArtifactManifestListSchema.safeParse(artifactsRaw);
  if (!artifactsResult.success) return false;
  const artifacts = artifactsResult.data.items;
  const byId = new Map(artifacts.map((artifact) => [
    artifact.artifactId,
    artifact,
  ]));
  const artifactIdsExist = artifactIds.every((artifactId) => {
    const artifact = byId.get(artifactId);
    return artifact != null && artifact.bookId === bookId;
  });
  if (!artifactIdsExist) return false;
  for (const stage of ["graph_extract", "community_report", "embed"] as const) {
    const checkpoint = checkpointByStage.get(stage);
    if (checkpoint == null || checkpoint.runId == null) return false;
    const producerValidation = await validateBookArtifactSet({
      graphVault,
      bookId,
      artifactIds: filterArtifactIdsByKinds(
        checkpoint.artifactIds,
        artifacts as BookArtifactManifest[],
        QUERY_READY_PRODUCER_REQUIRED_KINDS[stage],
      ),
      artifacts: artifacts as BookArtifactManifest[],
      requiredKinds: QUERY_READY_PRODUCER_REQUIRED_KINDS[stage],
      allowedKinds: QUERY_READY_PRODUCER_REQUIRED_KINDS[stage],
      requireBookScopedGraphOutput: true,
      expectedProducerRunIds: { [stage]: checkpoint.runId },
      expectedStageFingerprints: book.stageFingerprints,
      expectedProviderFingerprint: book.providerFingerprint,
      expectedCorpusContentHash: expectedContentHash,
    });
    if (!producerValidation.isSatisfied) return false;
  }
  const queryReadyCheckpoint = checkpointByStage.get("query_ready");
  if (queryReadyCheckpoint == null) return false;
  const queryReadyValidation = await validateBookArtifactSet({
    graphVault,
    bookId,
    artifactIds: queryReadyCheckpoint.artifactIds,
    artifacts: artifacts as BookArtifactManifest[],
    requiredKinds: QUERY_READY_ARTIFACT_KINDS,
    allowedKinds: QUERY_READY_ARTIFACT_KINDS,
    requireBookScopedGraphOutput: true,
    expectedProducerRunIds,
    expectedStageFingerprints: book.stageFingerprints,
    expectedProviderFingerprint: book.providerFingerprint,
    expectedCorpusContentHash: expectedContentHash,
  });
  if (!queryReadyValidation.isSatisfied) return false;

  const lineageValidation = await validateBookArtifactSet({
    graphVault,
    bookId,
    artifactIds,
    artifacts: artifacts as BookArtifactManifest[],
    requiredKinds: QUERY_READY_LINEAGE_ARTIFACT_KINDS,
    allowedKinds: QUERY_READY_LINEAGE_ARTIFACT_KINDS,
    requireBookScopedGraphOutput: true,
    expectedProducerRunIds,
    expectedStageFingerprints: book.stageFingerprints,
    expectedProviderFingerprint: book.providerFingerprint,
    expectedCorpusContentHash: expectedContentHash,
  });
  return lineageValidation.isSatisfied;
}

async function readRawGraphCapabilityItems(
  graphVault: string,
): Promise<unknown[]> {
  const parsed = await readYaml(
    join(graphVault, "catalog", "graph-capabilities.yaml"),
  );
  if (parsed == null) return [];
  const items = (parsed as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

function mergeCapabilities(
  capabilities: readonly GraphCapability[],
): GraphCapability[] {
  const byId = new Map<string, GraphCapability>();
  for (const capability of capabilities) {
    byId.set(capability.capabilityId, capability);
  }
  return [...byId.values()];
}

async function filterRestorableExplicitCapabilities(input: {
  graphVault: string;
  capabilities: readonly GraphCapability[];
  identities: readonly DocumentIdentityMap[];
}): Promise<GraphCapability[]> {
  const result: GraphCapability[] = [];
  for (const capability of input.capabilities) {
    const projection = await projectValidatedCapabilityForRestore(
        input.graphVault,
        capability,
        input.identities,
    );
    if (projection.capability != null) {
      result.push(projection.capability);
    }
  }
  return result;
}

export async function restoreFromVault(
  request: VaultRestoreRequest,
): Promise<VaultRestoreReport> {
  const parsed = VaultRestoreRequestSchema.parse(request);
  const graphVault = resolve(parsed.graphVault);
  const requiredPaths = [
    "input",
    "catalog/sources.yaml",
    "catalog/document-identity-map.yaml",
  ];
  const missingRequiredPaths: string[] = [];

  for (const relativePath of requiredPaths) {
    if (!(await pathExists(join(graphVault, relativePath)))) {
      missingRequiredPaths.push(relativePath);
    }
  }

  const sourcesRaw = await readYaml(join(graphVault, "catalog", "sources.yaml"));
  const identityRaw = await readYaml(
    join(graphVault, "catalog", "document-identity-map.yaml"),
  );
  const sourceDocuments = sourcesRaw == null
    ? []
    : parseCatalogItems(sourcesRaw, SourceDocumentSchema);
  const documentIdentities = identityRaw == null
    ? []
    : parseCatalogItems(identityRaw, DocumentIdentityMapSchema);
  const rawCapabilityItems = await readRawGraphCapabilityItems(graphVault);
  const explicitCapabilities: GraphCapability[] = [];
  const rawCapabilityFailures: Array<{
    itemId: string;
    redactedMessage: string;
  }> = [];
  for (const [index, item] of rawCapabilityItems.entries()) {
    const result = GraphCapabilitySchema.safeParse(item);
    if (!result.success) {
      rawCapabilityFailures.push({
        itemId:
          typeof (item as { capabilityId?: unknown } | null)?.capabilityId === "string"
            ? String((item as { capabilityId: string }).capabilityId)
            : `graph-capability:${index}`,
        redactedMessage: "graph capability catalog item is invalid",
      });
      continue;
    }
    explicitCapabilities.push(result.data);
  }
  const [derivedCapabilities, validatedExplicitCapabilities] = await Promise.all([
    loadGraphCapabilities({ graphVault }),
    loadExplicitCapabilityCatalog(graphVault)
      .then((items) => filterRestorableExplicitCapabilities({
        graphVault,
        capabilities: items,
        identities: documentIdentities,
      }))
      .catch(() => []),
  ]);
  const restorableCapabilities = mergeCapabilities([
    ...derivedCapabilities,
    ...validatedExplicitCapabilities,
  ]);
  const capabilitiesForPathAudit = explicitCapabilities.length > 0
    ? explicitCapabilities
    : restorableCapabilities;
  const capabilityAuditPaths = await missingCapabilityPortablePaths(
    graphVault,
    documentIdentities,
    capabilitiesForPathAudit,
  );
  for (const relativePath of capabilityAuditPaths) {
    if (!missingRequiredPaths.includes(relativePath)) {
      missingRequiredPaths.push(relativePath);
    }
  }
  const documentIdentitiesByDocumentId = identityByDocumentId(documentIdentities);
  let restoredDocumentCount = 0;
  let restoredCapabilityCount = 0;
  const restoredDocumentHashes = new Map<string, string>();
  const restoredCapabilityIds: string[] = [];
  const failedItems: Array<{
    itemId: string;
    stage: string;
    redactedMessage: string;
  }> = [];
  const capabilityAuditFailures: string[] = [];

  for (const failure of rawCapabilityFailures) {
    capabilityAuditFailures.push(failure.redactedMessage);
    failedItems.push({
      itemId: failure.itemId,
      stage: "audit_capability",
      redactedMessage: failure.redactedMessage,
    });
  }

  for (const capability of explicitCapabilities) {
    const failure = await capabilitySourceMaterialFailure(
      graphVault,
      capability,
      documentIdentities,
    );
    if (failure == null) continue;
    capabilityAuditFailures.push(failure);
    failedItems.push({
      itemId: capability.capabilityId,
      stage: "audit_capability",
      redactedMessage: failure,
    });
  }

  const documentsPortable = requiredPaths.every(
    (path) => !missingRequiredPaths.includes(path),
  );
  const capabilitiesPortable =
    capabilityAuditPaths.length === 0 && capabilityAuditFailures.length === 0;

  if (parsed.mode === "restore" && documentsPortable) {
    if (!parsed.targetIndexPath) {
      throw new Error("restore mode requires targetIndexPath");
    }

    const store = createStore(parsed.targetIndexPath);
    try {
      upsertStoreCollection(store.db, "books", {
        path: join(graphVault, "input"),
        pattern: "**/*.md",
        context: {
          "/": "Restored graph_vault normalized books.",
        },
      });

      const now = new Date().toISOString();
      for (const identity of documentIdentities) {
        const normalizedPath = identityNormalizedPath(identity);
        if (normalizedPath == null) {
          failedItems.push({
            itemId: identity.documentId,
            stage: "restore_document",
            redactedMessage: "document identity is missing metadata.normalizedPath",
          });
          continue;
        }

        const absolutePath = resolveVaultRelativePath(graphVault, normalizedPath);
        if (absolutePath == null) {
          failedItems.push({
            itemId: identity.documentId,
            stage: "restore_document",
            redactedMessage: "normalizedPath must be vault-relative",
          });
          continue;
        }
        let content: string;
        try {
          content = await readFile(absolutePath, "utf8");
        } catch (error) {
          failedItems.push({
            itemId: identity.documentId,
            stage: "restore_document",
            redactedMessage: sanitizeVaultText(
              error instanceof Error ? error.message : String(error),
            ) ?? "restore document failed",
          });
          continue;
        }

        const contentHash = await hashContent(
          content,
          identity.normalizationPolicyVersion,
        );
        if (contentHash !== identity.contentHash) {
          failedItems.push({
            itemId: identity.documentId,
            stage: "restore_document",
            redactedMessage: "restored content hash differs from identity map contentHash",
          });
          continue;
        }

        const title = extractTitle(content, normalizedPath);
        const relativeInputPath = normalizedPath.startsWith("input/")
          ? normalizedPath.slice("input/".length)
          : normalizedPath;
        insertContent(store.db, identity.contentHash, content, now);
        insertDocument(
          store.db,
          "books",
          relativeInputPath,
          title,
          identity.contentHash,
          now,
          now,
        );
        restoredDocumentCount++;
        restoredDocumentHashes.set(identity.documentId, identity.contentHash);
      }

      ensureCapabilityMirror(store);
      const upsertCapability = store.db.prepare(`
        INSERT INTO qmd_graph_capabilities (
          capability_id,
          kind,
          book_id,
          source_id,
          document_id,
          content_hash,
          method,
          ready,
          readiness_source,
          artifact_ids,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(capability_id) DO UPDATE SET
          kind = excluded.kind,
          book_id = excluded.book_id,
          source_id = excluded.source_id,
          document_id = excluded.document_id,
          content_hash = excluded.content_hash,
          method = excluded.method,
          ready = excluded.ready,
          readiness_source = excluded.readiness_source,
          artifact_ids = excluded.artifact_ids,
          created_at = excluded.created_at
      `);
      for (const capability of restorableCapabilities) {
        const validationError = validateCapabilityForRestore(
          capability,
          documentIdentitiesByDocumentId,
          restoredDocumentHashes,
        );
        if (validationError != null) {
          failedItems.push({
            itemId: capability.capabilityId,
            stage: "restore_capability",
            redactedMessage: validationError,
          });
          continue;
        }

        upsertCapability.run(
          capability.capabilityId,
          capability.kind,
          capability.bookId,
          capability.sourceId,
          capability.documentId,
          capability.contentHash,
          capability.method ?? null,
          capability.ready ? 1 : 0,
          capability.readinessSource,
          JSON.stringify(capability.artifactIds),
          capability.createdAt,
        );
        restoredCapabilityCount++;
        restoredCapabilityIds.push(capability.capabilityId);
      }
    } finally {
      store.close();
    }
  }

  const report = VaultRestoreReportSchema.parse({
    schemaVersion: SchemaVersion,
    graphVault,
    mode: parsed.mode,
    portable: documentsPortable && capabilitiesPortable,
    documentsPortable,
    capabilitiesPortable,
    sourceDocumentCount: sourceDocuments.length,
    documentIdentityCount: documentIdentities.length,
    graphCapabilityCount: restorableCapabilities.length,
    restoredDocumentCount,
    restoredCapabilityCount,
    restoredCapabilityIds,
    failedItems,
    missingRequiredPaths,
    metadata: sanitizeVaultMetadata({
      targetIndexPath: parsed.targetIndexPath ?? null,
    }),
  });
  await appendRestoreAuditReport(graphVault, report);
  return report;
}

async function appendRestoreAuditReport(
  graphVault: string,
  report: VaultRestoreReport,
): Promise<void> {
  const catalogDir = join(graphVault, "catalog");
  await mkdir(catalogDir, { recursive: true });
  const portableReport = VaultRestoreReportSchema.parse({
    ...report,
    graphVault: ".",
    failedItems: report.failedItems.map((item) => ({
      ...item,
      redactedMessage:
        sanitizeVaultText(item.redactedMessage) ?? "restore item failed",
    })),
    metadata: sanitizeVaultMetadata(report.metadata),
  });
  await appendFile(
    join(catalogDir, "restore-audits.jsonl"),
    `${JSON.stringify(portableReport)}\n`,
    "utf8",
  );
}
