import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import { type BookJob, BookJobSchema } from "../contracts/book-job.js";
import { SchemaVersion } from "../contracts/common.js";
import {
  type DocumentIdentityMap,
  DocumentIdentityMapSchema,
  GraphTextUnitIdentityMapSchema,
} from "../contracts/corpus.js";
import { readHotplugPackageUnknown } from "./book-hotplug-package-readonly.js";
import {
  validatePublishedBookHotplugPackage,
} from "./book-hotplug-package-validator.js";
import { validateHotplugRuntimeQueryGate } from "./book-hotplug-runtime-gate.js";
import {
  resolveBookManifestPath,
  resolveBookPublishReadyPath,
  resolveBookRoot,
} from "./book-package-layout.js";

const HotplugBookManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("qmd_graphrag_book_package"),
  identity: z.object({
    bookId: z.string().min(1),
    sourceHash: z.string().min(1),
    canonicalTitle: z.string().min(1),
    titleSlug: z.string().min(1),
    createdAt: z.string().min(1),
    packageGeneration: z.string().min(1),
  }).passthrough(),
  source: z.object({
    sourcePath: z.string().min(1),
    sourceHash: z.string().min(1),
  }).passthrough(),
  input: z.object({
    canonicalNormalizedPath: z.string().min(1),
    normalizedHash: z.string().min(1),
  }).passthrough(),
  qmd: z.object({
    qmdIndexSchema: z.string().min(1).optional(),
    qmdReadyState: z.string().min(1).optional(),
  }).passthrough().optional(),
  graphrag: z.object({
    queryReady: z.boolean(),
    graphRagReadyState: z.string().min(1).optional(),
    graphRagArtifactSchema: z.string().min(1).optional(),
    artifactSchema: z.string().min(1).optional(),
  }).passthrough(),
}).passthrough();

const HotplugGraphOutputManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  bookId: z.string().min(1),
  sourceHash: z.string().min(1),
  documentId: z.string().min(1),
  contentHash: z.string().min(1),
  stageFingerprints: z.record(z.string(), z.string().min(1)),
  providerFingerprint: z.string().min(1),
}).passthrough();

const HotplugQmdBuildManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("qmd_build_manifest"),
  normalizedContentHash: z.string().min(1).optional(),
  normalizationPolicyVersion: z.string().min(1).optional(),
  configHash: z.string().min(1).optional(),
}).passthrough();

type HotplugBookManifest = z.infer<typeof HotplugBookManifestSchema>;
type HotplugGraphOutputManifest =
  z.infer<typeof HotplugGraphOutputManifestSchema>;
type HotplugGraphIdentity = z.infer<typeof GraphTextUnitIdentityMapSchema>;
type HotplugQmdBuildManifest = z.infer<typeof HotplugQmdBuildManifestSchema>;

function packagePathForVaultCatalog(bookId: string, packagePath: string): string {
  if (packagePath.startsWith(`books/${bookId}/`)) return packagePath;
  return `books/${bookId}/${packagePath}`;
}

async function readPackageJson(path: string): Promise<unknown | null> {
  return readHotplugPackageUnknown(path);
}

async function readBookManifest(
  graphVault: string,
  bookId: string,
): Promise<HotplugBookManifest | null> {
  const manifestPath = resolveBookManifestPath(graphVault, bookId);
  const publishReadyPath = resolveBookPublishReadyPath(graphVault, bookId);
  if (!existsSync(manifestPath) || !existsSync(publishReadyPath)) return null;
  const boundary = validatePublishedBookHotplugPackage({ graphVault, bookId });
  if (!boundary.ok) return null;
  const result = HotplugBookManifestSchema.safeParse(
    await readPackageJson(manifestPath),
  );
  if (!result.success) return null;
  if (result.data.graphrag.queryReady) {
    const runtimeGate = await validateHotplugRuntimeQueryGate({ graphVault, bookId });
    if (!runtimeGate.ok) return null;
  }
  return result.data;
}

async function readGraphIdentity(
  graphVault: string,
  bookId: string,
): Promise<HotplugGraphIdentity | null> {
  const path = join(
    resolveBookRoot(graphVault, bookId),
    "graphrag",
    "output",
    "qmd_graph_text_unit_identity.json",
  );
  if (!existsSync(path)) return null;
  const result = GraphTextUnitIdentityMapSchema.safeParse(
    await readPackageJson(path),
  );
  return result.success ? result.data : null;
}

async function readGraphOutputManifest(
  graphVault: string,
  bookId: string,
): Promise<HotplugGraphOutputManifest | null> {
  const path = join(
    resolveBookRoot(graphVault, bookId),
    "graphrag",
    "output",
    "qmd_output_manifest.json",
  );
  if (!existsSync(path)) return null;
  const result = HotplugGraphOutputManifestSchema.safeParse(
    await readPackageJson(path),
  );
  return result.success ? result.data : null;
}

async function readQmdBuildManifest(
  graphVault: string,
  bookId: string,
): Promise<HotplugQmdBuildManifest | null> {
  const path = join(
    resolveBookRoot(graphVault, bookId),
    "qmd",
    "qmd_build_manifest.json",
  );
  if (!existsSync(path)) return null;
  const result = HotplugQmdBuildManifestSchema.safeParse(
    await readPackageJson(path),
  );
  return result.success ? result.data : null;
}

export async function listPublishedHotplugBookIds(
  graphVaultInput: string,
): Promise<string[]> {
  const graphVault = resolve(graphVaultInput);
  const booksDir = join(graphVault, "books");
  if (!existsSync(booksDir)) return [];
  return readdirSync(booksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((bookId) =>
      existsSync(resolveBookManifestPath(graphVault, bookId)) &&
      existsSync(resolveBookPublishReadyPath(graphVault, bookId))
    )
    .sort((left, right) => left.localeCompare(right));
}

export async function projectHotplugBookJob(
  graphVaultInput: string,
  bookId: string,
): Promise<BookJob | null> {
  const graphVault = resolve(graphVaultInput);
  const manifest = await readBookManifest(graphVault, bookId);
  if (manifest == null) return null;
  const graphOutput = await readGraphOutputManifest(graphVault, bookId);
  const graphIdentity = await readGraphIdentity(graphVault, bookId);
  const qmdBuild = await readQmdBuildManifest(graphVault, bookId);
  const contentHash = graphIdentity?.contentHash ??
    graphOutput?.contentHash ??
    qmdBuild?.normalizedContentHash ??
    manifest.input.normalizedHash;
  const documentId = graphOutput?.documentId ??
    graphIdentity?.documentId ??
    `doc-${manifest.identity.sourceHash.slice(0, 12)}`;
  const parsed = BookJobSchema.safeParse({
    schemaVersion: SchemaVersion,
    bookId: manifest.identity.bookId,
    documentId,
    sourcePath: manifest.source.sourcePath,
    sourceIdentityPath: manifest.source.sourcePath,
    sourceHash: manifest.identity.sourceHash,
    normalizedContentHash: contentHash,
    normalizedPath: manifest.input.canonicalNormalizedPath,
    normalizationPolicyVersion:
      qmdBuild?.normalizationPolicyVersion ??
      "graphrag-normalized-markdown-v1",
    configFingerprint: qmdBuild?.configHash ??
      manifest.qmd?.qmdIndexSchema ??
      "qmd-book-index-v1",
    promptFingerprint: "book-hotplug-manifest",
    modelFingerprint: manifest.graphrag.artifactSchema ??
      manifest.graphrag.graphRagArtifactSchema ??
      "graphrag-output-v1",
    stageFingerprints: graphOutput?.stageFingerprints,
    providerFingerprint: graphOutput?.providerFingerprint,
    overallStatus: manifest.graphrag.queryReady ? "succeeded" : "partial",
    createdAt: manifest.identity.createdAt,
    updatedAt: manifest.identity.createdAt,
    metadata: {
      canonicalTitle: manifest.identity.canonicalTitle,
      titleSlug: manifest.identity.titleSlug,
      packageGeneration: manifest.identity.packageGeneration,
      mountStatus: "mounted",
      qmdReadyState: manifest.qmd?.qmdReadyState ?? "unknown",
      graphRagReadyState: manifest.graphrag.graphRagReadyState ?? "unknown",
      projectionSource: "book_hotplug_manifest",
    },
  });
  return parsed.success ? parsed.data : null;
}

export async function projectHotplugDocumentIdentity(
  graphVaultInput: string,
  bookId: string,
): Promise<DocumentIdentityMap | null> {
  const graphVault = resolve(graphVaultInput);
  const manifest = await readBookManifest(graphVault, bookId);
  if (manifest == null) return null;
  const identity = await readGraphIdentity(graphVault, bookId);
  if (identity == null) return null;
  const parsed = DocumentIdentityMapSchema.safeParse({
    schemaVersion: SchemaVersion,
    sourceId: identity.sourceId,
    sourceHash: identity.sourceHash,
    canonicalBookId: identity.bookId,
    documentId: identity.documentId,
    contentHash: identity.contentHash,
    normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
    normalizedPath: packagePathForVaultCatalog(
      manifest.identity.bookId,
      manifest.input.canonicalNormalizedPath,
    ),
    chunkIds: [],
    graphDocumentId: identity.graphDocumentId,
    graphTextUnitIds: identity.graphTextUnitIds,
    metadata: {
      qmdCorpusRegistered: true,
      projectionSource: "book_hotplug_manifest",
      legacyGraphIdentityNormalizedPath: identity.normalizedPath,
    },
  });
  return parsed.success ? parsed.data : null;
}
