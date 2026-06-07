import { join, resolve } from "node:path";

import { z } from "zod";

import { SchemaVersion } from "../../contracts/common.js";
import {
  readYamlUnknownDurable,
  writeYamlFileDurable,
} from "../../job-state/durable-state-store.js";
import { readHotplugPackageUnknown } from "../book-hotplug-package-readonly.js";
import {
  BookshelfGraphManifestSchema,
  BookshelfQualityGateSchema,
} from "./bookshelf-graph-contracts.js";
import {
  LibraryGraphManifestSchema,
  LibraryQualityGateSchema,
} from "./library-graph-contracts.js";
import {
  assertSafeUpperScopeId,
  packageLocator,
  readQueryReadyPackage,
  type UpperScopeKind,
} from "./upper-package-paths.js";

const ProjectionSource = "upper_package_manifest" as const;

const ProjectionAuthoritySchema = z.object({
  packageRoot: z.string().min(1),
  currentPath: z.string().min(1),
  manifestPath: z.string().min(1),
  manifestSha256: z.string().min(1),
  qualityGatePath: z.string().min(1),
  publishReadyPath: z.string().min(1),
  readinessProof: z.literal("package_local_current_publish_ready_quality_gate"),
  catalogIsAuthority: z.literal(false),
});

const ProjectionArtifactSchema = z.object({
  semanticUnits: z.string().min(1),
  semanticEdges: z.string().min(1),
  communities: z.string().min(1),
  communityReports: z.string().min(1),
  evidenceMap: z.string().min(1),
  semanticUnitEmbeddings: z.string().min(1),
});

export const BookshelfCatalogProjectionSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  kind: z.literal("qmd_graphrag_bookshelf_catalog_projection"),
  projectionSource: z.literal(ProjectionSource),
  scopeKind: z.literal("bookshelf"),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  readyState: z.literal("bookshelf_query_ready"),
  queryReady: z.literal(true),
  projectedAt: z.string().min(1),
  authority: ProjectionAuthoritySchema,
  membership: z.object({
    membershipGeneration: z.string().min(1),
    memberCount: z.number().int().positive(),
    memberBookIds: z.array(z.string().min(1)).min(1),
  }),
  artifacts: ProjectionArtifactSchema,
  fixedQueryBudget: z.object({
    maxSemanticUnits: z.number().int().positive(),
    maxBooksForDeepening: z.number().int().nonnegative(),
    maxMemberCommunityRefs: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(),
  }),
  qualityGate: z.object({
    path: z.string().min(1),
    checkedAt: z.string().min(1),
    checkIds: z.array(z.string().min(1)).min(1),
  }),
});

export const LibraryCatalogProjectionSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  kind: z.literal("qmd_graphrag_library_catalog_projection"),
  projectionSource: z.literal(ProjectionSource),
  scopeKind: z.literal("library"),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  readyState: z.literal("library_query_ready"),
  queryReady: z.literal(true),
  projectedAt: z.string().min(1),
  authority: ProjectionAuthoritySchema,
  membership: z.object({
    membershipGeneration: z.string().min(1),
    bookshelfCount: z.number().int().positive(),
    directBookCount: z.number().int().nonnegative(),
    expandedMaterializedBookshelfIds: z.array(z.string().min(1)).min(1),
  }),
  artifacts: ProjectionArtifactSchema,
  fixedQueryBudget: z.object({
    maxSemanticUnits: z.number().int().positive(),
    maxBookshelves: z.number().int().nonnegative(),
    maxShelfCommunityRefs: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(),
  }),
  qualityGate: z.object({
    path: z.string().min(1),
    checkedAt: z.string().min(1),
    checkIds: z.array(z.string().min(1)).min(1),
  }),
});

export const UpperCatalogProjectionSchema = z.union([
  BookshelfCatalogProjectionSchema,
  LibraryCatalogProjectionSchema,
]);

export type BookshelfCatalogProjection =
  z.infer<typeof BookshelfCatalogProjectionSchema>;
export type LibraryCatalogProjection =
  z.infer<typeof LibraryCatalogProjectionSchema>;
export type UpperCatalogProjection =
  z.infer<typeof UpperCatalogProjectionSchema>;

export type RebuildUpperCatalogProjectionInput = {
  graphVault: string;
  scopeKind: UpperScopeKind;
  scopeId: string;
  now?: () => string;
};

function scopeRootRelative(scopeKind: UpperScopeKind, scopeId: string): string {
  return scopeKind === "bookshelf"
    ? `bookshelves/${scopeId}`
    : `library/${scopeId}`;
}

function projectionPath(input: {
  graphVault: string;
  scopeKind: UpperScopeKind;
  scopeId: string;
}): string {
  assertSafeUpperScopeId(input.scopeKind, input.scopeId);
  const catalogRoot = input.scopeKind === "bookshelf"
    ? "bookshelves"
    : "library";
  return join(
    resolve(input.graphVault),
    "catalog",
    catalogRoot,
    input.scopeId,
    "projection.yaml",
  );
}

function locator(input: {
  scopeKind: UpperScopeKind;
  scopeId: string;
  generation: string;
  relativePath: string;
}): string {
  return packageLocator(input);
}

function authority(input: {
  scopeKind: UpperScopeKind;
  scopeId: string;
  generation: string;
  manifestSha256: string;
  qualityGatePath: string;
}): z.infer<typeof ProjectionAuthoritySchema> {
  const packageRoot = scopeRootRelative(input.scopeKind, input.scopeId);
  const manifestName = input.scopeKind === "bookshelf"
    ? "BOOKSHELF_MANIFEST.json"
    : "LIBRARY_MANIFEST.json";
  return {
    packageRoot,
    currentPath: `${packageRoot}/CURRENT.json`,
    manifestPath: locator({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      generation: input.generation,
      relativePath: manifestName,
    }),
    manifestSha256: input.manifestSha256,
    qualityGatePath: locator({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      generation: input.generation,
      relativePath: input.qualityGatePath,
    }),
    publishReadyPath: `${packageRoot}/PUBLISH_READY.json`,
    readinessProof: "package_local_current_publish_ready_quality_gate",
    catalogIsAuthority: false,
  };
}

function artifacts(input: {
  scopeKind: UpperScopeKind;
  scopeId: string;
  generation: string;
  graphArtifacts: {
    semanticUnits: string;
    semanticEdges: string;
    communities: string;
    communityReports: string;
    semanticUnitEmbeddings: string;
  };
  evidenceMapPath: string;
}): z.infer<typeof ProjectionArtifactSchema> {
  return ProjectionArtifactSchema.parse({
    semanticUnits: locator({ ...input, relativePath: input.graphArtifacts.semanticUnits }),
    semanticEdges: locator({ ...input, relativePath: input.graphArtifacts.semanticEdges }),
    communities: locator({ ...input, relativePath: input.graphArtifacts.communities }),
    communityReports: locator({
      ...input,
      relativePath: input.graphArtifacts.communityReports,
    }),
    evidenceMap: locator({ ...input, relativePath: input.evidenceMapPath }),
    semanticUnitEmbeddings: locator({
      ...input,
      relativePath: input.graphArtifacts.semanticUnitEmbeddings,
    }),
  });
}

export async function rebuildBookshelfCatalogProjection(input: {
  graphVault: string;
  bookshelfId: string;
  now?: () => string;
}): Promise<{
  path: string;
  projection: BookshelfCatalogProjection;
}> {
  const graphVault = resolve(input.graphVault);
  const ready = await readQueryReadyPackage({
    graphVault,
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
  });
  const manifest = BookshelfGraphManifestSchema.parse(
    await readHotplugPackageUnknown(ready.manifestPath),
  );
  const gate = BookshelfQualityGateSchema.parse(
    await readHotplugPackageUnknown(ready.gatePath),
  );
  const generation = manifest.bookshelfIdentity.generation;
  const projection = BookshelfCatalogProjectionSchema.parse({
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_bookshelf_catalog_projection",
    projectionSource: ProjectionSource,
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation,
    readyState: gate.readyState,
    queryReady: true,
    projectedAt: input.now?.() ?? new Date().toISOString(),
    authority: authority({
      scopeKind: "bookshelf",
      scopeId: input.bookshelfId,
      generation,
      manifestSha256: ready.current.manifestSha256,
      qualityGatePath: manifest.qualityGate.path,
    }),
    membership: {
      membershipGeneration: manifest.bookshelfIdentity.membershipGeneration,
      memberCount: manifest.membership.memberCount,
      memberBookIds: Object.keys(manifest.membership.memberManifestSha256).sort(),
    },
    artifacts: artifacts({
      scopeKind: "bookshelf",
      scopeId: input.bookshelfId,
      generation,
      graphArtifacts: manifest.graphArtifacts,
      evidenceMapPath: manifest.evidenceMap.path,
    }),
    fixedQueryBudget: {
      maxSemanticUnits: manifest.fixedQueryBudget.maxSemanticUnits,
      maxBooksForDeepening: manifest.fixedQueryBudget.maxBooksForDeepening,
      maxMemberCommunityRefs: manifest.fixedQueryBudget.maxMemberCommunityRefs,
      maxInputTokens: manifest.fixedQueryBudget.maxInputTokens,
    },
    qualityGate: {
      path: authority({
        scopeKind: "bookshelf",
        scopeId: input.bookshelfId,
        generation,
        manifestSha256: ready.current.manifestSha256,
        qualityGatePath: manifest.qualityGate.path,
      }).qualityGatePath,
      checkedAt: gate.checkedAt,
      checkIds: gate.checks.map((check) => check.checkId).sort(),
    },
  });
  const path = projectionPath({
    graphVault,
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
  });
  await writeYamlFileDurable(path, projection);
  return { path, projection };
}

export async function rebuildLibraryCatalogProjection(input: {
  graphVault: string;
  libraryId: string;
  now?: () => string;
}): Promise<{
  path: string;
  projection: LibraryCatalogProjection;
}> {
  const graphVault = resolve(input.graphVault);
  const ready = await readQueryReadyPackage({
    graphVault,
    scopeKind: "library",
    scopeId: input.libraryId,
  });
  const manifest = LibraryGraphManifestSchema.parse(
    await readHotplugPackageUnknown(ready.manifestPath),
  );
  const gate = LibraryQualityGateSchema.parse(
    await readHotplugPackageUnknown(ready.gatePath),
  );
  const generation = manifest.libraryIdentity.generation;
  const projection = LibraryCatalogProjectionSchema.parse({
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_library_catalog_projection",
    projectionSource: ProjectionSource,
    scopeKind: "library",
    scopeId: input.libraryId,
    generation,
    readyState: gate.readyState,
    queryReady: true,
    projectedAt: input.now?.() ?? new Date().toISOString(),
    authority: authority({
      scopeKind: "library",
      scopeId: input.libraryId,
      generation,
      manifestSha256: ready.current.manifestSha256,
      qualityGatePath: manifest.qualityGate.path,
    }),
    membership: {
      membershipGeneration: manifest.libraryIdentity.membershipGeneration,
      bookshelfCount: manifest.membership.bookshelfCount,
      directBookCount: manifest.membership.directBookCount,
      expandedMaterializedBookshelfIds:
        manifest.membership.expandedMaterializedBookshelfIds,
    },
    artifacts: artifacts({
      scopeKind: "library",
      scopeId: input.libraryId,
      generation,
      graphArtifacts: manifest.graphArtifacts,
      evidenceMapPath: manifest.evidenceMap.path,
    }),
    fixedQueryBudget: {
      maxSemanticUnits: manifest.fixedQueryBudget.maxSemanticUnits,
      maxBookshelves: manifest.fixedQueryBudget.maxBookshelves,
      maxShelfCommunityRefs: manifest.fixedQueryBudget.maxShelfCommunityRefs,
      maxInputTokens: manifest.fixedQueryBudget.maxInputTokens,
    },
    qualityGate: {
      path: authority({
        scopeKind: "library",
        scopeId: input.libraryId,
        generation,
        manifestSha256: ready.current.manifestSha256,
        qualityGatePath: manifest.qualityGate.path,
      }).qualityGatePath,
      checkedAt: gate.checkedAt,
      checkIds: gate.checks.map((check) => check.checkId).sort(),
    },
  });
  const path = projectionPath({
    graphVault,
    scopeKind: "library",
    scopeId: input.libraryId,
  });
  await writeYamlFileDurable(path, projection);
  return { path, projection };
}

export async function rebuildUpperCatalogProjection(
  input: RebuildUpperCatalogProjectionInput,
): Promise<{
  path: string;
  projection: UpperCatalogProjection;
}> {
  return input.scopeKind === "bookshelf"
    ? rebuildBookshelfCatalogProjection({
        graphVault: input.graphVault,
        bookshelfId: input.scopeId,
        now: input.now,
      })
    : rebuildLibraryCatalogProjection({
        graphVault: input.graphVault,
        libraryId: input.scopeId,
        now: input.now,
      });
}

export async function loadUpperCatalogProjection(input: {
  graphVault: string;
  scopeKind: UpperScopeKind;
  scopeId: string;
}): Promise<UpperCatalogProjection | null> {
  const parsed = await readYamlUnknownDurable(projectionPath(input));
  if (parsed == null) return null;
  const projection = UpperCatalogProjectionSchema.parse(parsed);
  if (
    projection.scopeKind !== input.scopeKind ||
    projection.scopeId !== input.scopeId
  ) {
    throw new Error("upper_quality_gate_failed:catalog_projection_scope_mismatch");
  }
  return projection;
}
