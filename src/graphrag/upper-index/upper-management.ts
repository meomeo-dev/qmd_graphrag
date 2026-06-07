import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { SchemaVersion } from "../../contracts/common.js";
import { readHotplugPackageUnknown } from "../book-hotplug-package-readonly.js";
import {
  BookshelfGraphManifestSchema,
  BookshelfMembershipManifestSchema,
  BookshelfQualityGateSchema,
} from "./bookshelf-graph-contracts.js";
import {
  LibraryGraphManifestSchema,
  LibraryQualityGateSchema,
} from "./library-graph-contracts.js";
import {
  LibraryMembershipManifestSchema,
} from "./library-membership.js";
import {
  hasLegacyCatalogUpperArtifacts,
  hasPackageRoot,
  assertSafeUpperScopeId,
  packageLocator,
  readPackageCurrent,
  readQueryReadyPackage,
  upperPackageRoot,
  type UpperScopeKind,
} from "./upper-package-paths.js";

export type UpperManagementStatus =
  | "query_ready"
  | "not_query_ready"
  | "migration_required"
  | "missing"
  | "invalid";

export type UpperPackageStatus = {
  schemaVersion: typeof SchemaVersion;
  kind: "qmd_graphrag_upper_package_status";
  scopeKind: UpperScopeKind;
  scopeId: string;
  status: UpperManagementStatus;
  queryReady: boolean;
  packageRoot: string;
  generation: string | null;
  readyState: string | null;
  currentPath: string;
  manifestPath: string | null;
  manifestSha256: string | null;
  publishReadyPath: string | null;
  qualityGatePath: string | null;
  catalogProjectionPath: string;
  catalogProjectionExists: boolean;
  authority: {
    packageRootIsAuthority: true;
    catalogProjectionIsAuthority: false;
  };
  summary: {
    memberBookCount?: number;
    bookshelfCount?: number;
    directBookCount?: number;
    maxSemanticUnits?: number;
    maxInputTokens?: number;
  };
  diagnostics: string[];
};

function relativeRoot(scopeKind: UpperScopeKind, scopeId: string): string {
  return scopeKind === "bookshelf"
    ? `bookshelves/${scopeId}`
    : `library/${scopeId}`;
}

function catalogProjectionPath(scopeKind: UpperScopeKind, scopeId: string): string {
  const catalogRoot = scopeKind === "bookshelf" ? "bookshelves" : "library";
  return `catalog/${catalogRoot}/${scopeId}/projection.yaml`;
}

function parseErrorDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^[^:]+:/u, "") || "unknown_error";
}

function baseStatus(input: {
  scopeKind: UpperScopeKind;
  scopeId: string;
}): Omit<UpperPackageStatus, "status" | "queryReady" | "diagnostics"> {
  const packageRoot = relativeRoot(input.scopeKind, input.scopeId);
  return {
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_upper_package_status",
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    packageRoot,
    generation: null,
    readyState: null,
    currentPath: `${packageRoot}/CURRENT.json`,
    manifestPath: null,
    manifestSha256: null,
    publishReadyPath: null,
    qualityGatePath: null,
    catalogProjectionPath: catalogProjectionPath(input.scopeKind, input.scopeId),
    catalogProjectionExists: false,
    authority: {
      packageRootIsAuthority: true,
      catalogProjectionIsAuthority: false,
    },
    summary: {},
  };
}

async function attachSummary(input: {
  status: UpperPackageStatus;
  manifestPath: string;
}): Promise<void> {
  const manifest = await readHotplugPackageUnknown(input.manifestPath);
  if (input.status.scopeKind === "bookshelf") {
    const graph = BookshelfGraphManifestSchema.safeParse(manifest);
    if (graph.success) {
      input.status.summary.memberBookCount = graph.data.membership.memberCount;
      input.status.summary.maxSemanticUnits =
        graph.data.fixedQueryBudget.maxSemanticUnits;
      input.status.summary.maxInputTokens =
        graph.data.fixedQueryBudget.maxInputTokens;
      input.status.qualityGatePath = packageLocator({
        scopeKind: input.status.scopeKind,
        scopeId: input.status.scopeId,
        generation: graph.data.bookshelfIdentity.generation,
        relativePath: graph.data.qualityGate.path,
      });
      return;
    }
    const membership = BookshelfMembershipManifestSchema.safeParse(manifest);
    if (membership.success) {
      input.status.summary.memberBookCount = membership.data.membership.memberCount;
      input.status.qualityGatePath = packageLocator({
        scopeKind: input.status.scopeKind,
        scopeId: input.status.scopeId,
        generation: membership.data.bookshelfIdentity.generation,
        relativePath: membership.data.qualityGate.path,
      });
    }
    return;
  }

  const graph = LibraryGraphManifestSchema.safeParse(manifest);
  if (graph.success) {
    input.status.summary.bookshelfCount = graph.data.membership.bookshelfCount;
    input.status.summary.directBookCount = graph.data.membership.directBookCount;
    input.status.summary.maxSemanticUnits =
      graph.data.fixedQueryBudget.maxSemanticUnits;
    input.status.summary.maxInputTokens =
      graph.data.fixedQueryBudget.maxInputTokens;
    input.status.qualityGatePath = packageLocator({
      scopeKind: input.status.scopeKind,
      scopeId: input.status.scopeId,
      generation: graph.data.libraryIdentity.generation,
      relativePath: graph.data.qualityGate.path,
    });
    return;
  }
  const membership = LibraryMembershipManifestSchema.safeParse(manifest);
  if (membership.success) {
    input.status.summary.bookshelfCount = membership.data.membership.bookshelfCount;
    input.status.summary.directBookCount =
      membership.data.membership.directBookCount;
    input.status.qualityGatePath = packageLocator({
      scopeKind: input.status.scopeKind,
      scopeId: input.status.scopeId,
      generation: membership.data.libraryIdentity.generation,
      relativePath: membership.data.qualityGate.path,
    });
  }
}

async function assertReadyPackageContent(input: {
  scopeKind: UpperScopeKind;
  scopeId: string;
  ready: Awaited<ReturnType<typeof readQueryReadyPackage>>;
}): Promise<void> {
  const manifest = await readHotplugPackageUnknown(input.ready.manifestPath);
  const gate = await readHotplugPackageUnknown(input.ready.gatePath);
  if (input.scopeKind === "bookshelf") {
    const parsedManifest = BookshelfGraphManifestSchema.safeParse(manifest);
    if (!parsedManifest.success) {
      throw new Error("upper_quality_gate_failed:bookshelf_graph_manifest_invalid");
    }
    const parsedGate = BookshelfQualityGateSchema.safeParse(gate);
    if (!parsedGate.success) {
      throw new Error("upper_quality_gate_failed:bookshelf_quality_gate_invalid");
    }
    if (
      parsedManifest.data.bookshelfIdentity.bookshelfId !== input.scopeId ||
      parsedManifest.data.bookshelfIdentity.generation !==
        input.ready.current.generation ||
      parsedGate.data.scopeId !== input.scopeId ||
      parsedGate.data.generation !== input.ready.current.generation
    ) {
      throw new Error("upper_quality_gate_failed:bookshelf_ready_scope_mismatch");
    }
    return;
  }

  const parsedManifest = LibraryGraphManifestSchema.safeParse(manifest);
  if (!parsedManifest.success) {
    throw new Error("upper_quality_gate_failed:library_graph_manifest_invalid");
  }
  const parsedGate = LibraryQualityGateSchema.safeParse(gate);
  if (!parsedGate.success) {
    throw new Error("upper_quality_gate_failed:library_quality_gate_invalid");
  }
  if (
    parsedManifest.data.libraryIdentity.libraryId !== input.scopeId ||
    parsedManifest.data.libraryIdentity.generation !==
      input.ready.current.generation ||
    parsedGate.data.scopeId !== input.scopeId ||
    parsedGate.data.generation !== input.ready.current.generation
  ) {
    throw new Error("upper_quality_gate_failed:library_ready_scope_mismatch");
  }
}

export async function getUpperPackageStatus(input: {
  graphVault: string;
  scopeKind: UpperScopeKind;
  scopeId: string;
}): Promise<UpperPackageStatus> {
  const graphVault = resolve(input.graphVault);
  try {
    assertSafeUpperScopeId(input.scopeKind, input.scopeId);
  } catch (error) {
    return {
      ...baseStatus(input),
      status: "invalid",
      queryReady: false,
      diagnostics: [parseErrorDiagnostic(error)],
    };
  }
  const scopeInput = {
    graphVault,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
  };
  const status = baseStatus(input);
  status.catalogProjectionExists = existsSync(join(
    graphVault,
    status.catalogProjectionPath,
  ));

  if (!hasPackageRoot(scopeInput)) {
    return {
      ...status,
      status: hasLegacyCatalogUpperArtifacts(scopeInput)
        ? "migration_required"
        : "missing",
      queryReady: false,
      diagnostics: hasLegacyCatalogUpperArtifacts(scopeInput)
        ? ["upper_package_migration_required"]
        : ["package_root_missing"],
    };
  }

  let current: Awaited<ReturnType<typeof readPackageCurrent>>;
  try {
    current = await readPackageCurrent(scopeInput);
  } catch (error) {
    return {
      ...status,
      status: "invalid",
      queryReady: false,
      diagnostics: [parseErrorDiagnostic(error)],
    };
  }

  status.generation = current.current.generation;
  status.readyState = current.current.readyState;
  status.manifestPath = `${status.packageRoot}/${current.current.manifestPath}`;
  status.manifestSha256 = current.current.manifestSha256;
  status.qualityGatePath = null;
  status.publishReadyPath = `${status.packageRoot}/PUBLISH_READY.json`;
  await attachSummary({
    status: status as UpperPackageStatus,
    manifestPath: join(current.packageRoot, current.current.manifestPath),
  });

  try {
    const ready = await readQueryReadyPackage(scopeInput);
    await assertReadyPackageContent({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      ready,
    });
  } catch (error) {
    return {
      ...(status as UpperPackageStatus),
      status: "not_query_ready",
      queryReady: false,
      diagnostics: [parseErrorDiagnostic(error)],
    };
  }

  return {
    ...(status as UpperPackageStatus),
    status: "query_ready",
    queryReady: true,
    diagnostics: [],
  };
}

export async function listUpperPackageStatuses(input: {
  graphVault: string;
  scopeKind: UpperScopeKind;
}): Promise<UpperPackageStatus[]> {
  const graphVault = resolve(input.graphVault);
  const root = join(
    graphVault,
    input.scopeKind === "bookshelf" ? "bookshelves" : "library",
  );
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const scopeIds = entries
    .filter((entry) => !entry.startsWith("."))
    .filter((entry) => {
      try {
        const packageRoot = upperPackageRoot({
          graphVault,
          scopeKind: input.scopeKind,
          scopeId: entry,
        });
        return existsSync(packageRoot) && statSync(packageRoot).isDirectory();
      } catch {
        return true;
      }
    })
    .sort();
  const statuses = await Promise.all(scopeIds.map((scopeId) =>
    getUpperPackageStatus({
      graphVault,
      scopeKind: input.scopeKind,
      scopeId,
    })
  ));
  return statuses;
}
