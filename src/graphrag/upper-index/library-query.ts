import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { SchemaVersion } from "../../contracts/common.js";
import type { GraphCapability } from "../../contracts/graph-enhancement.js";
import {
  GraphRagQueryResponseSchema,
  type GraphRagQueryResponse,
  type GraphRagSearchMethod,
} from "../../contracts/graphrag.js";
import { readHotplugPackageUnknown } from "../book-hotplug-package-readonly.js";
import { resolveBookManifestPath } from "../book-package-layout.js";
import {
  BookManifestSchema,
  BookshelfGraphManifestSchema,
} from "./bookshelf-graph-contracts.js";
import {
  defaultBookshelfGraphBridgePath,
  runBookshelfGraphQueryBridge,
} from "./bookshelf-graph-parquet.js";
import {
  LibraryGraphManifestSchema,
  LibraryQualityGateSchema,
  type LibraryGraphManifest,
} from "./library-graph-contracts.js";
import { validateLibraryGraphAtRoot } from "./library-graph-validator.js";

export type LibraryQueryScopeErrorCode =
  | "upper_index_missing"
  | "upper_index_stale"
  | "upper_quality_gate_failed"
  | "budget_exceeded_narrow_scope_required"
  | "upper_index_runtime_error";

export class LibraryQueryScopeError extends Error {
  readonly code: LibraryQueryScopeErrorCode;
  readonly diagnostics: string[];

  constructor(
    code: LibraryQueryScopeErrorCode,
    message: string,
    diagnostics: string[] = [],
  ) {
    super(message);
    this.name = "LibraryQueryScopeError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export type LibraryQueryScope = {
  graphVault: string;
  libraryId: string;
  root: string;
  manifest: LibraryGraphManifest;
  maxInputTokens: number;
  maxReports: number;
};

export type QueryLibraryGraphInput = {
  graphVault: string;
  libraryId: string;
  query: string;
  method?: GraphRagSearchMethod;
  pythonBin?: string;
  bridgePath?: string;
  maxReports?: number;
  maxInputTokens?: number;
};

async function readPublishedScope(input: {
  graphVault: string;
  libraryId: string;
  pythonBin: string;
  bridgePath: string;
}): Promise<LibraryQueryScope> {
  const graphVault = resolve(input.graphVault);
  const root = join(graphVault, "catalog", "library", input.libraryId, "current");
  const manifestPath = join(root, "LIBRARY_MANIFEST.json");
  const gatePath = join(root, "state", "library-quality-gate.json");
  if (!existsSync(manifestPath) || !existsSync(gatePath)) {
    throw new LibraryQueryScopeError(
      "upper_index_missing",
      "Library upper index is missing or not published.",
      ["missing_library_manifest_or_gate"],
    );
  }
  let validation: { ok: boolean; diagnostics: string[] };
  try {
    validation = await validateLibraryGraphAtRoot({
      graphVault,
      libraryId: input.libraryId,
      root,
      pythonBin: input.pythonBin,
      bridgePath: input.bridgePath,
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.startsWith("upper_index_runtime_error:")) {
        throw new LibraryQueryScopeError(
          "upper_index_runtime_error",
          "Library upper index runtime failed during readiness validation.",
          ["parquet_bridge_failed"],
        );
      }
      if (error.message.startsWith("upper_quality_gate_failed:")) {
        throw new LibraryQueryScopeError(
          "upper_quality_gate_failed",
          "Library upper index failed query readiness validation.",
          ["parquet_bridge_response_invalid"],
        );
      }
    }
    throw new LibraryQueryScopeError(
      "upper_index_runtime_error",
      "Library upper index runtime failed during readiness validation.",
      ["upper_index_validation_runtime_error"],
    );
  }
  if (!validation.ok) {
    const stale = validation.diagnostics.some((item) =>
      item.includes("stale") ||
      item.includes("sha_changed")
    );
    throw new LibraryQueryScopeError(
      stale ? "upper_index_stale" : "upper_quality_gate_failed",
      "Library upper index failed query readiness validation.",
      validation.diagnostics,
    );
  }
  const manifest = LibraryGraphManifestSchema.parse(
    await readHotplugPackageUnknown(manifestPath),
  );
  const gate = LibraryQualityGateSchema.parse(
    await readHotplugPackageUnknown(gatePath),
  );
  if (!manifest.libraryIdentity.queryReady || !gate.queryReady || gate.status !== "passed") {
    throw new LibraryQueryScopeError(
      "upper_quality_gate_failed",
      "Library quality gate is not query-ready.",
      ["library_gate_not_query_ready"],
    );
  }
  return {
    graphVault,
    libraryId: input.libraryId,
    root,
    manifest,
    maxInputTokens: manifest.fixedQueryBudget.maxInputTokens,
    maxReports: manifest.fixedQueryBudget.maxSemanticUnits,
  };
}

async function representativeBookForShelf(input: {
  graphVault: string;
  bookshelfId: string;
}): Promise<{ bookId: string; contentHash: string }> {
  const manifest = BookshelfGraphManifestSchema.parse(
    await readHotplugPackageUnknown(join(
      input.graphVault,
      "catalog",
      "bookshelves",
      input.bookshelfId,
      "current",
      "BOOKSHELF_MANIFEST.json",
    )),
  );
  const bookId = Object.keys(manifest.membership.memberManifestSha256).sort()[0];
  if (bookId == null) {
    throw new LibraryQueryScopeError(
      "upper_quality_gate_failed",
      "Library member bookshelf has no representative book.",
      [`empty_bookshelf_member:${input.bookshelfId}`],
    );
  }
  const bookManifest = BookManifestSchema.parse(
    await readHotplugPackageUnknown(resolveBookManifestPath(input.graphVault, bookId)),
  );
  return {
    bookId,
    contentHash: bookManifest.identity.sourceHash,
  };
}

export async function loadLibraryGraphQueryCapabilities(input: {
  graphVault: string;
  libraryId: string;
  method?: GraphRagSearchMethod;
  pythonBin?: string;
  bridgePath?: string;
}): Promise<GraphCapability[]> {
  const scope = await readPublishedScope({
    graphVault: input.graphVault,
    libraryId: input.libraryId,
    pythonBin: input.pythonBin ?? "python3",
    bridgePath: input.bridgePath ?? defaultBookshelfGraphBridgePath(),
  });
  const selectedShelves =
    scope.manifest.membership.expandedMaterializedBookshelfIds.slice(
      0,
      Math.max(1, scope.manifest.fixedQueryBudget.maxBookshelvesForDeepening),
    );
  const capabilities: GraphCapability[] = [];
  for (const bookshelfId of selectedShelves) {
    const representative = await representativeBookForShelf({
      graphVault: scope.graphVault,
      bookshelfId,
    });
    capabilities.push({
      schemaVersion: SchemaVersion,
      capabilityId: [
        "library",
        scope.libraryId,
        scope.manifest.libraryIdentity.generation,
        bookshelfId,
        representative.bookId,
        input.method ?? "global",
      ].join(":"),
      kind: "global_search",
      bookId: representative.bookId,
      sourceId: `library:${scope.libraryId}`,
      documentId: `library:${scope.libraryId}:${bookshelfId}`,
      contentHash: representative.contentHash,
      method: input.method ?? "global",
      ready: true,
      readinessSource: "validated_checkpoint_plus_validated_manifest",
      artifactIds: [
        `library:${scope.libraryId}:community_reports.parquet`,
        `library:${scope.libraryId}:evidence_map.parquet`,
      ],
      createdAt: scope.manifest.libraryIdentity.createdAt,
      metadata: {
        projectionSource: "library_manifest",
        libraryId: scope.libraryId,
        libraryGeneration: scope.manifest.libraryIdentity.generation,
        bookshelfId,
        sourceName: scope.libraryId,
      },
    });
  }
  return capabilities;
}

export async function queryLibraryGraph(
  input: QueryLibraryGraphInput,
): Promise<GraphRagQueryResponse> {
  const pythonBin = input.pythonBin ?? "python3";
  const bridgePath = input.bridgePath ?? defaultBookshelfGraphBridgePath();
  const scope = await readPublishedScope({
    graphVault: input.graphVault,
    libraryId: input.libraryId,
    pythonBin,
    bridgePath,
  });
  const maxInputTokens = input.maxInputTokens ?? scope.maxInputTokens;
  const bridge = await runBookshelfGraphQueryBridge({
    pythonBin,
    bridgePath,
    payload: {
      scopeKind: "library",
      scopeId: scope.libraryId,
      libraryId: scope.libraryId,
      generation: scope.manifest.libraryIdentity.generation,
      outputRoot: scope.root,
      query: input.query,
      maxReports: input.maxReports ?? scope.maxReports,
      maxInputTokens,
    },
  }).catch((error: unknown) => {
    if (error instanceof Error) {
      if (error.message.startsWith("upper_index_runtime_error:")) {
        throw new LibraryQueryScopeError(
          "upper_index_runtime_error",
          "Library upper index runtime failed during fixed-budget query.",
          ["parquet_bridge_failed"],
        );
      }
      if (error.message.startsWith("upper_quality_gate_failed:")) {
        throw new LibraryQueryScopeError(
          "upper_quality_gate_failed",
          "Library query bridge returned an invalid typed response.",
          ["library_query_response_invalid"],
        );
      }
    }
    throw new LibraryQueryScopeError(
      "upper_index_runtime_error",
      "Library upper index runtime failed during fixed-budget query.",
      ["library_query_runtime_error"],
    );
  });
  if (!bridge.ok) {
    const budgetExceeded = bridge.diagnostics.includes(
      "budget_exceeded_narrow_scope_required",
    );
    throw new LibraryQueryScopeError(
      budgetExceeded
        ? "budget_exceeded_narrow_scope_required"
        : "upper_quality_gate_failed",
      "Library query could not produce a ready fixed-budget response.",
      bridge.diagnostics,
    );
  }
  return GraphRagQueryResponseSchema.parse({
    schemaVersion: SchemaVersion,
    method: input.method ?? "global",
    responseText: bridge.answerText,
    evidence: bridge.evidence.map((item) => ({
      evidenceId: item.evidenceMapId,
      graphCapabilityId: `library:${scope.libraryId}:graph_query`,
      sourceId: item.targetSourceId,
      documentId: item.targetDocumentId,
      bookId: item.targetBookId,
      contentHash: item.targetContentHash,
      graphTextUnitId: item.targetTextUnitId,
      artifactId: item.targetCommunityReportId,
      locator: {
        path: [
          "catalog",
          "library",
          scope.libraryId,
          "current",
          "community_reports.parquet",
        ].join("/"),
      },
      quote: item.quote,
      score: item.score,
      metadata: {
        scopeKind: "library",
        libraryId: scope.libraryId,
        libraryGeneration: scope.manifest.libraryIdentity.generation,
        targetBookshelfId: item.targetBookshelfId ?? null,
        upperCommunityReportId: item.upperCommunityReportId,
        upperCommunityReportTitle: item.upperCommunityReportTitle,
        targetCommunityReportId: item.targetCommunityReportId,
        targetArtifactDigest: item.targetArtifactDigest,
        estimatedInputTokens: bridge.estimatedInputTokens,
        maxInputTokens: bridge.maxInputTokens,
        selectedReportCount: bridge.selectedReportCount,
        reportCount: bridge.reportCount,
      },
    })),
    providerDetail: {
      provider: "graphrag",
      method: input.method ?? "global",
      runtimeMetrics: {
        kind: "graphrag_query_runtime_metrics",
        scope: "current_invocation",
        totalDurationMs: 0,
        stages: [
          {
            name: "library.fixed_budget_report_search",
            durationMs: 0,
            status: "succeeded",
          },
        ],
        modelMetrics: [],
        aggregate: {
          modelCount: 0,
          attemptedRequestCount: 0,
          successfulResponseCount: 0,
          failedResponseCount: 0,
          requestsWithRetries: 0,
          retryCount: 0,
          streamingResponseCount: 0,
          loggedComputeDurationMs: 0,
          promptTokens: bridge.estimatedInputTokens,
          completionTokens: 0,
          totalTokens: bridge.estimatedInputTokens,
          cacheHitRate: 0,
          unattributedWallDurationMs: 0,
        },
      },
    },
  });
}
