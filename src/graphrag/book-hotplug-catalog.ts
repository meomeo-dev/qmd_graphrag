import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import { SchemaVersion } from "../contracts/common.js";
import { GraphTextUnitIdentityMapSchema } from "../contracts/corpus.js";
import {
  GraphCapabilitySchema,
  type GraphCapability,
} from "../contracts/graph-enhancement.js";
import {
  readYamlUnknownDurable,
  writeYamlFileDurable,
} from "../job-state/durable-state-store.js";
import { readHotplugPackageUnknown } from "./book-hotplug-package-readonly.js";
import {
  validatePublishedBookHotplugPackage,
} from "./book-hotplug-package-validator.js";
import { validateHotplugRuntimeQueryGate } from "./book-hotplug-runtime-gate.js";

const BookManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("qmd_graphrag_book_package"),
  identity: z.object({
    bookId: z.string().min(1),
    sourceHash: z.string().min(1),
    canonicalTitle: z.string().min(1),
    titleSlug: z.string().min(1),
    createdAt: z.string().min(1),
    packageVersion: z.string().min(1),
    packageGeneration: z.string().min(1),
    identityAlgorithmVersion: z.string().min(1),
  }),
  source: z.object({
    sourcePath: z.string().min(1),
    sourceHash: z.string().min(1),
    sourceBytes: z.number().int().nonnegative(),
    sourceKind: z.string().min(1),
  }),
  input: z.object({
    canonicalNormalizedPath: z.string().min(1),
    normalizedHash: z.string().min(1),
    normalizedBytes: z.number().int().nonnegative(),
  }),
  qmd: z.object({
    buildManifestPath: z.string().min(1),
    indexPolicy: z.string().min(1),
    requiredArtifacts: z.array(z.string().min(1)),
    qmdIndexSchema: z.string().min(1).optional(),
    qmdReadyState: z.string().min(1).optional(),
  }),
  graphrag: z.object({
    outputManifestPath: z.string().min(1),
    queryReady: z.boolean(),
    requiredArtifacts: z.array(z.string().min(1)),
    producerRunIds: z.array(z.string().min(1)),
    graphRagArtifactSchema: z.string().min(1).optional(),
    artifactSchema: z.string().min(1).optional(),
    graphRagReadyState: z.string().min(1).optional(),
  }),
  checksums: z.object({
    manifestSha256: z.string().min(1),
  }).passthrough(),
}).passthrough();

const GraphOutputManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  bookId: z.string().min(1),
  sourceHash: z.string().min(1),
  documentId: z.string().min(1),
  contentHash: z.string().min(1),
  stageFingerprints: z.record(z.string(), z.string().min(1)),
  providerFingerprint: z.string().min(1),
}).passthrough();

const QmdBuildManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("qmd_build_manifest"),
  normalizedContentHash: z.string().min(1).optional(),
  normalizationPolicyVersion: z.string().min(1).optional(),
  configHash: z.string().min(1).optional(),
}).passthrough();

type BookManifest = z.infer<typeof BookManifestSchema>;

type ProjectedBook = {
  manifest: BookManifest;
  manifestPath: string;
};

type ProducerRunEvidence = {
  runIds: Set<string>;
  unreadableRunCount: number;
};

type CatalogProjectionStatus = {
  exists: boolean;
  stale: boolean;
};

type QmdProjectionItem = {
  schemaVersion: typeof SchemaVersion;
  bookId: string;
  packageGeneration: string;
  sourceHash: string;
  normalizedHash: string;
  normalizedPath: string;
  qmdReadyState: string;
  qmdIndexPolicy: string;
  qmdIndexSchema: string | null;
  qmdBuildManifestPath: string;
  packageRoot: string;
  manifestSha256: string;
  projectionSource: "book_hotplug_manifest";
  updatedAt: string;
};

function bookRoot(graphVault: string, bookId: string): string {
  return join(graphVault, "books", bookId);
}

function manifestPath(graphVault: string, bookId: string): string {
  return join(bookRoot(graphVault, bookId), "BOOK_MANIFEST.json");
}

function publishReadyPath(graphVault: string, bookId: string): string {
  return join(bookRoot(graphVault, bookId), "PUBLISH_READY.json");
}

function packagePathForVaultCatalog(bookId: string, packagePath: string): string {
  if (packagePath.startsWith(`books/${bookId}/`)) return packagePath;
  return `books/${bookId}/${packagePath}`;
}

function qmdProjectionItem(input: ProjectedBook): QmdProjectionItem {
  const bookId = input.manifest.identity.bookId;
  return {
    schemaVersion: SchemaVersion,
    bookId,
    packageGeneration: input.manifest.identity.packageGeneration,
    sourceHash: input.manifest.identity.sourceHash,
    normalizedHash: input.manifest.input.normalizedHash,
    normalizedPath: packagePathForVaultCatalog(
      bookId,
      input.manifest.input.canonicalNormalizedPath,
    ),
    qmdReadyState: input.manifest.qmd.qmdReadyState ?? "unknown",
    qmdIndexPolicy: input.manifest.qmd.indexPolicy,
    qmdIndexSchema: input.manifest.qmd.qmdIndexSchema ?? null,
    qmdBuildManifestPath: input.manifest.qmd.buildManifestPath,
    packageRoot: `books/${bookId}`,
    manifestSha256: input.manifest.checksums.manifestSha256,
    projectionSource: "book_hotplug_manifest",
    updatedAt: input.manifest.identity.createdAt,
  };
}

function removeStaleQmdProjectionRoots(
  graphVault: string,
  expectedBookIds: ReadonlySet<string>,
): string[] {
  const root = join(graphVault, "catalog", "qmd-book-projections");
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".staging") continue;
    if (expectedBookIds.has(entry.name)) continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed.sort((left, right) => left.localeCompare(right));
}

async function readJsonUnknown(path: string): Promise<unknown | null> {
  return readHotplugPackageUnknown(path);
}

async function loadBookManifest(
  graphVault: string,
  bookId: string,
): Promise<BookManifest | null> {
  const path = manifestPath(graphVault, bookId);
  if (!existsSync(path) || !existsSync(publishReadyPath(graphVault, bookId))) {
    return null;
  }
  const boundary = validatePublishedBookHotplugPackage({ graphVault, bookId });
  if (!boundary.ok) return null;
  const parsed = await readJsonUnknown(path);
  if (parsed == null) return null;
  const result = BookManifestSchema.safeParse(parsed);
  if (!result.success) return null;
  if (result.data.graphrag.queryReady) {
    const runtimeGate = await validateHotplugRuntimeQueryGate({ graphVault, bookId });
    if (!runtimeGate.ok) return null;
  }
  return result.data;
}

function hasPublishedPackageCandidate(graphVault: string): boolean {
  const booksDir = join(graphVault, "books");
  if (!existsSync(booksDir)) return false;
  return readdirSync(booksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .some((entry) =>
      existsSync(manifestPath(graphVault, entry.name)) &&
      existsSync(publishReadyPath(graphVault, entry.name))
    );
}

async function loadProjectedBooks(graphVault: string): Promise<ProjectedBook[]> {
  const booksDir = join(graphVault, "books");
  if (!existsSync(booksDir)) return [];
  const entries = readdirSync(booksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const projected = [];
  for (const bookId of entries) {
    const manifest = await loadBookManifest(graphVault, bookId);
    if (manifest == null) continue;
    projected.push({
      manifest,
      manifestPath: manifestPath(graphVault, bookId),
    });
  }
  return projected;
}

function catalogItemBookId(item: unknown): string | null {
  if (item == null || typeof item !== "object") return null;
  const candidate = item as Record<string, unknown>;
  if (typeof candidate.bookId === "string" && candidate.bookId.length > 0) {
    return candidate.bookId;
  }
  if (
    typeof candidate.canonicalBookId === "string" &&
    candidate.canonicalBookId.length > 0
  ) {
    return candidate.canonicalBookId;
  }
  const metadata = candidate.metadata;
  if (metadata != null && typeof metadata === "object") {
    const metadataBookId = (metadata as Record<string, unknown>).bookId;
    if (typeof metadataBookId === "string" && metadataBookId.length > 0) {
      return metadataBookId;
    }
  }
  return null;
}

async function projectionStatus(
  path: string,
  expectedBookIds: ReadonlySet<string>,
): Promise<CatalogProjectionStatus> {
  if (!existsSync(path)) return { exists: false, stale: true };
  const parsed = await readYamlUnknownDurable(path);
  const items = parsed != null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { items?: unknown }).items)
    ? (parsed as { items: unknown[] }).items
    : [];
  const observed = new Set<string>();
  for (const item of items) {
    const bookId = catalogItemBookId(item);
    if (bookId != null) observed.add(bookId);
  }
  for (const bookId of observed) {
    if (!expectedBookIds.has(bookId)) return { exists: true, stale: true };
  }
  if (observed.size !== expectedBookIds.size) {
    return { exists: true, stale: true };
  }
  return { exists: true, stale: false };
}

async function maybeReadGraphIdentity(
  graphVault: string,
  bookId: string,
): Promise<z.infer<typeof GraphTextUnitIdentityMapSchema> | null> {
  const path = join(
    bookRoot(graphVault, bookId),
    "graphrag",
    "output",
    "qmd_graph_text_unit_identity.json",
  );
  if (!existsSync(path)) return null;
  const parsed = await readJsonUnknown(path);
  if (parsed == null) return null;
  const result = GraphTextUnitIdentityMapSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

async function maybeReadGraphOutputManifest(
  graphVault: string,
  bookId: string,
): Promise<z.infer<typeof GraphOutputManifestSchema> | null> {
  const path = join(
    bookRoot(graphVault, bookId),
    "graphrag",
    "output",
    "qmd_output_manifest.json",
  );
  if (!existsSync(path)) return null;
  const parsed = await readJsonUnknown(path);
  if (parsed == null) return null;
  const result = GraphOutputManifestSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

async function maybeReadQmdBuildManifest(
  graphVault: string,
  bookId: string,
): Promise<z.infer<typeof QmdBuildManifestSchema> | null> {
  const path = join(
    bookRoot(graphVault, bookId),
    "qmd",
    "qmd_build_manifest.json",
  );
  if (!existsSync(path)) return null;
  const parsed = await readJsonUnknown(path);
  if (parsed == null) return null;
  const result = QmdBuildManifestSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

async function readProducerRunEvidence(
  graphVault: string,
  bookId: string,
): Promise<ProducerRunEvidence> {
  const runsDir = join(bookRoot(graphVault, bookId), "graphrag", "runs");
  if (!existsSync(runsDir)) {
    return { runIds: new Set<string>(), unreadableRunCount: 0 };
  }
  const runIds = new Set<string>();
  let unreadableRunCount = 0;
  const entries = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  for (const name of entries) {
    let parsed: unknown | null;
    try {
      parsed = await readJsonUnknown(join(runsDir, name));
    } catch {
      unreadableRunCount += 1;
      continue;
    }
    const runId = parsed != null &&
        typeof parsed === "object" &&
        "runId" in parsed &&
        typeof parsed.runId === "string" &&
        parsed.runId.length > 0
      ? parsed.runId
      : null;
    if (runId != null) runIds.add(runId);
  }
  return { runIds, unreadableRunCount };
}

function graphQueryCapability(input: {
  manifest: BookManifest;
  identity: z.infer<typeof GraphTextUnitIdentityMapSchema>;
  artifactIds: readonly string[];
}): GraphCapability {
  return GraphCapabilitySchema.parse({
    schemaVersion: SchemaVersion,
    capabilityId: `${input.manifest.identity.bookId}:graph_query`,
    kind: "graph_query",
    bookId: input.manifest.identity.bookId,
    sourceId: input.identity.sourceId,
    documentId: input.identity.documentId,
    contentHash: input.identity.contentHash,
    ready: input.manifest.graphrag.queryReady,
    readinessSource: "validated_checkpoint_plus_validated_manifest",
    artifactIds: [...input.artifactIds],
    createdAt: input.manifest.identity.createdAt,
    metadata: {
      projectionSource: "book_hotplug_manifest",
      sourceName: input.manifest.identity.canonicalTitle,
    },
  });
}

export async function rebuildCatalogFromBookHotplugPackages(
  graphVaultInput: string,
): Promise<{
  bookCount: number;
  identityCount: number;
  capabilityCount: number;
  capabilities: GraphCapability[];
}> {
  const graphVault = resolve(graphVaultInput);
  const books = await loadProjectedBooks(graphVault);
  const bookItems = [];
  const sourceItems = [];
  const identityItems = [];
  const qmdProjectionItems: QmdProjectionItem[] = [];
  const capabilityItems: GraphCapability[] = [];
  const capabilityCandidates: Array<{
    manifest: BookManifest;
    identity: z.infer<typeof GraphTextUnitIdentityMapSchema>;
  }> = [];

  for (const { manifest } of books) {
    const graphIdentity = await maybeReadGraphIdentity(
      graphVault,
      manifest.identity.bookId,
    );
    const graphOutputManifest = await maybeReadGraphOutputManifest(
      graphVault,
      manifest.identity.bookId,
    );
    const qmdBuildManifest = await maybeReadQmdBuildManifest(
      graphVault,
      manifest.identity.bookId,
    );
    bookItems.push({
      schemaVersion: SchemaVersion,
      bookId: manifest.identity.bookId,
      documentId: graphOutputManifest?.documentId ??
        graphIdentity?.documentId ??
        `doc-${manifest.identity.sourceHash.slice(0, 12)}`,
      sourcePath: manifest.source.sourcePath,
      sourceIdentityPath: manifest.source.sourcePath,
      sourceHash: manifest.identity.sourceHash,
      normalizedContentHash: graphIdentity?.contentHash ??
        graphOutputManifest?.contentHash ??
        qmdBuildManifest?.normalizedContentHash ??
        manifest.input.normalizedHash,
      normalizedPath: packagePathForVaultCatalog(
        manifest.identity.bookId,
        manifest.input.canonicalNormalizedPath,
      ),
      normalizationPolicyVersion:
        qmdBuildManifest?.normalizationPolicyVersion ??
        "graphrag-normalized-markdown-v1",
      configFingerprint: qmdBuildManifest?.configHash ??
        manifest.qmd.qmdIndexSchema ??
        "qmd-book-index-v1",
      promptFingerprint: "book-hotplug-manifest",
      modelFingerprint: manifest.graphrag.artifactSchema ?? "graphrag-output-v1",
      stageFingerprints: graphOutputManifest?.stageFingerprints,
      providerFingerprint: graphOutputManifest?.providerFingerprint,
      overallStatus: manifest.graphrag.queryReady ? "succeeded" : "partial",
      createdAt: manifest.identity.createdAt,
      updatedAt: manifest.identity.createdAt,
      metadata: {
        canonicalTitle: manifest.identity.canonicalTitle,
        titleSlug: manifest.identity.titleSlug,
        packageGeneration: manifest.identity.packageGeneration,
        mountStatus: "mounted",
        qmdReadyState: manifest.qmd.qmdReadyState ?? "unknown",
        graphRagReadyState: manifest.graphrag.graphRagReadyState ?? "unknown",
      },
    });
    sourceItems.push({
      schemaVersion: SchemaVersion,
      sourceId: `sha256:${manifest.identity.sourceHash}`,
      sourceHash: manifest.identity.sourceHash,
      sourceName: manifest.identity.canonicalTitle,
      sourceRelativePath: manifest.source.sourcePath,
      mediaType: manifest.source.sourceKind,
      sizeBytes: manifest.source.sourceBytes,
      createdAt: manifest.identity.createdAt,
      metadata: {
        bookId: manifest.identity.bookId,
        packageGeneration: manifest.identity.packageGeneration,
      },
    });
    qmdProjectionItems.push(qmdProjectionItem({ manifest, manifestPath: "" }));

    if (graphIdentity != null) {
      identityItems.push({
        schemaVersion: SchemaVersion,
        sourceId: graphIdentity.sourceId,
        sourceHash: graphIdentity.sourceHash,
        canonicalBookId: graphIdentity.bookId,
        documentId: graphIdentity.documentId,
        contentHash: graphIdentity.contentHash,
        normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
        normalizedPath: packagePathForVaultCatalog(
          manifest.identity.bookId,
          manifest.input.canonicalNormalizedPath,
        ),
        chunkIds: [],
        graphDocumentId: graphIdentity.graphDocumentId,
        graphTextUnitIds: graphIdentity.graphTextUnitIds,
        metadata: {
          qmdCorpusRegistered: true,
          projectionSource: "book_hotplug_manifest",
          legacyGraphIdentityNormalizedPath: graphIdentity.normalizedPath,
        },
      });
      capabilityCandidates.push({ manifest, identity: graphIdentity });
    }
  }

  await writeYamlFileDurable(join(graphVault, "catalog", "books.yaml"), {
    schemaVersion: SchemaVersion,
    items: bookItems,
  });
  await writeYamlFileDurable(join(graphVault, "catalog", "sources.yaml"), {
    schemaVersion: SchemaVersion,
    items: sourceItems,
  });
  await writeYamlFileDurable(
    join(graphVault, "catalog", "document-identity-map.yaml"),
    {
      schemaVersion: SchemaVersion,
      items: identityItems,
    },
  );

  for (const { manifest, identity } of capabilityCandidates) {
    const runEvidence = await readProducerRunEvidence(
      graphVault,
      manifest.identity.bookId,
    );
    const hasAllProducerRuns = runEvidence.unreadableRunCount === 0 &&
      manifest.graphrag.producerRunIds.every((runId) =>
        runEvidence.runIds.has(runId)
      );
    const queryReadyLineage = hasAllProducerRuns
      ? await (await import("./capability-catalog.js")).projectQueryReadyLineage(
        graphVault,
        manifest.identity.bookId,
      )
      : null;
    if (queryReadyLineage == null) continue;
    capabilityItems.push(graphQueryCapability({
      manifest,
      identity,
      artifactIds: queryReadyLineage.artifactIds,
    }));
  }

  const sortedCapabilityItems = capabilityItems.sort((left, right) =>
    left.capabilityId.localeCompare(right.capabilityId)
  );
  await writeYamlFileDurable(join(graphVault, "catalog", "graph-capabilities.yaml"), {
    schemaVersion: SchemaVersion,
    items: sortedCapabilityItems,
  });
  const expectedBookIds = new Set(
    books.map((book) => book.manifest.identity.bookId),
  );
  const removedStaleProjectionRoots = removeStaleQmdProjectionRoots(
    graphVault,
    expectedBookIds,
  );
  await writeYamlFileDurable(join(graphVault, "catalog", "qmd-projection.yaml"), {
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_qmd_projection_catalog",
    projectionSource: "book_hotplug_manifest",
    removedStaleProjectionRoots,
    items: qmdProjectionItems.sort((left, right) =>
      left.bookId.localeCompare(right.bookId)
    ),
  });

  return {
    bookCount: bookItems.length,
    identityCount: identityItems.length,
    capabilityCount: sortedCapabilityItems.length,
    capabilities: sortedCapabilityItems,
  };
}

export async function ensureCatalogProjectionFromBookHotplugPackages(
  graphVaultInput: string,
): Promise<void> {
  const graphVault = resolve(graphVaultInput);
  const projectionPaths = [
    join(graphVault, "catalog", "books.yaml"),
    join(graphVault, "catalog", "sources.yaml"),
    join(graphVault, "catalog", "document-identity-map.yaml"),
    join(graphVault, "catalog", "graph-capabilities.yaml"),
    join(graphVault, "catalog", "qmd-projection.yaml"),
  ];
  const books = await loadProjectedBooks(graphVault);
  if (books.length === 0) {
    if (hasPublishedPackageCandidate(graphVault)) {
      await rebuildCatalogFromBookHotplugPackages(graphVault);
    }
    return;
  }
  const expectedBookIds = new Set(
    books.map((book) => book.manifest.identity.bookId),
  );
  const expectedCapabilityBookIds = new Set(
    books
      .filter((book) => book.manifest.graphrag.queryReady)
      .map((book) => book.manifest.identity.bookId),
  );
  const statuses = await Promise.all(
    projectionPaths.map((path) => projectionStatus(
      path,
      path.endsWith("graph-capabilities.yaml")
        ? expectedCapabilityBookIds
        : expectedBookIds,
    )),
  );
  if (statuses.every((status) => status.exists && !status.stale)) return;
  await rebuildCatalogFromBookHotplugPackages(graphVault);
}
