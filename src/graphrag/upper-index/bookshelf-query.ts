import { resolve } from "node:path";

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
  BookshelfQualityGateSchema,
  type BookshelfGraphManifest,
} from "./bookshelf-graph-contracts.js";
import {
  defaultBookshelfGraphBridgePath,
  runBookshelfGraphQueryBridge,
} from "./bookshelf-graph-parquet.js";
import { validateBookshelfGraphAtRoot } from "./bookshelf-graph-validator.js";
import {
  packageLocator,
  readQueryReadyPackage,
} from "./upper-package-paths.js";

export type BookshelfQueryScopeErrorCode =
  | "upper_index_missing"
  | "upper_package_migration_required"
  | "upper_index_stale"
  | "upper_quality_gate_failed"
  | "budget_exceeded_narrow_scope_required"
  | "upper_index_runtime_error";

export class BookshelfQueryScopeError extends Error {
  readonly code: BookshelfQueryScopeErrorCode;
  readonly diagnostics: string[];

  constructor(
    code: BookshelfQueryScopeErrorCode,
    message: string,
    diagnostics: string[] = [],
  ) {
    super(message);
    this.name = "BookshelfQueryScopeError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export type BookshelfQueryScope = {
  graphVault: string;
  bookshelfId: string;
  root: string;
  manifest: BookshelfGraphManifest;
  maxInputTokens: number;
  maxReports: number;
};

export type QueryBookshelfGraphInput = {
  graphVault: string;
  bookshelfId: string;
  query: string;
  method?: GraphRagSearchMethod;
  pythonBin?: string;
  bridgePath?: string;
  maxReports?: number;
  maxInputTokens?: number;
};

async function readPublishedScope(input: {
  graphVault: string;
  bookshelfId: string;
  pythonBin: string;
  bridgePath: string;
}): Promise<BookshelfQueryScope> {
  const graphVault = resolve(input.graphVault);
  let packageReady: Awaited<ReturnType<typeof readQueryReadyPackage>>;
  try {
    packageReady = await readQueryReadyPackage({
      graphVault,
      scopeKind: "bookshelf",
      scopeId: input.bookshelfId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("upper_package_migration_required:")) {
      throw new BookshelfQueryScopeError(
        "upper_package_migration_required",
        "Bookshelf upper package must be migrated out of catalog.",
        ["legacy_catalog_bookshelf_package_requires_migration"],
      );
    }
    if (message.startsWith("upper_quality_gate_failed:")) {
      throw new BookshelfQueryScopeError(
        "upper_quality_gate_failed",
        "Bookshelf package-local publish gate is not query-ready.",
        [message.replace(/^upper_quality_gate_failed:/u, "")],
      );
    }
    throw new BookshelfQueryScopeError(
      "upper_index_missing",
      "Bookshelf upper package is missing or not query-ready.",
      [message.replace(/^upper_index_missing:/u, "")],
    );
  }
  const root = packageReady.generationRoot;
  let validation: { ok: boolean; diagnostics: string[] };
  try {
    validation = await validateBookshelfGraphAtRoot({
      graphVault,
      bookshelfId: input.bookshelfId,
      root,
      pythonBin: input.pythonBin,
      bridgePath: input.bridgePath,
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.startsWith("upper_index_runtime_error:")) {
        throw new BookshelfQueryScopeError(
          "upper_index_runtime_error",
          "Bookshelf upper index runtime failed during readiness validation.",
          ["parquet_bridge_failed"],
        );
      }
      if (error.message.startsWith("upper_quality_gate_failed:")) {
        throw new BookshelfQueryScopeError(
          "upper_quality_gate_failed",
          "Bookshelf upper index failed query readiness validation.",
          ["parquet_bridge_response_invalid"],
        );
      }
    }
    throw new BookshelfQueryScopeError(
      "upper_index_runtime_error",
      "Bookshelf upper index runtime failed during readiness validation.",
      ["upper_index_validation_runtime_error"],
    );
  }
  if (!validation.ok) {
    const stale = validation.diagnostics.some((item) =>
      item.startsWith("member_manifest_stale:") ||
      item.includes("stale")
    );
    throw new BookshelfQueryScopeError(
      stale ? "upper_index_stale" : "upper_quality_gate_failed",
      "Bookshelf upper index failed query readiness validation.",
      validation.diagnostics,
    );
  }
  const manifest = BookshelfGraphManifestSchema.parse(
    await readHotplugPackageUnknown(packageReady.manifestPath),
  );
  const gate = BookshelfQualityGateSchema.parse(
    await readHotplugPackageUnknown(packageReady.gatePath),
  );
  if (
    !manifest.bookshelfIdentity.queryReady ||
    !gate.queryReady ||
    gate.status !== "passed"
  ) {
    throw new BookshelfQueryScopeError(
      "upper_quality_gate_failed",
      "Bookshelf quality gate is not query-ready.",
      ["bookshelf_gate_not_query_ready"],
    );
  }
  return {
    graphVault,
    bookshelfId: input.bookshelfId,
    root,
    manifest,
    maxInputTokens: manifest.fixedQueryBudget.maxInputTokens,
    maxReports: manifest.fixedQueryBudget.maxSemanticUnits,
  };
}

export async function loadBookshelfGraphQueryCapabilities(input: {
  graphVault: string;
  bookshelfId: string;
  method?: GraphRagSearchMethod;
  pythonBin?: string;
  bridgePath?: string;
}): Promise<GraphCapability[]> {
  const scope = await readPublishedScope({
    graphVault: input.graphVault,
    bookshelfId: input.bookshelfId,
    pythonBin: input.pythonBin ?? "python3",
    bridgePath: input.bridgePath ?? defaultBookshelfGraphBridgePath(),
  });
  const entries = Object.entries(scope.manifest.membership.memberManifestSha256)
    .slice(0, Math.max(1, scope.manifest.fixedQueryBudget.maxBooksForDeepening));
  const capabilities: GraphCapability[] = [];
  for (const [bookId] of entries) {
    const bookManifest = BookManifestSchema.parse(
      await readHotplugPackageUnknown(resolveBookManifestPath(scope.graphVault, bookId)),
    );
    capabilities.push({
      schemaVersion: SchemaVersion,
      capabilityId: [
        "bookshelf",
        scope.bookshelfId,
        scope.manifest.bookshelfIdentity.generation,
        bookId,
        input.method ?? "global",
      ].join(":"),
      kind: "global_search",
      bookId,
      sourceId: `bookshelf:${scope.bookshelfId}`,
      documentId: `bookshelf:${scope.bookshelfId}:${bookId}`,
      contentHash: bookManifest.identity.sourceHash,
      method: input.method ?? "global",
      ready: true,
      readinessSource: "validated_checkpoint_plus_validated_manifest",
      artifactIds: [
        `bookshelf:${scope.bookshelfId}:community_reports.parquet`,
        `bookshelf:${scope.bookshelfId}:evidence_map.parquet`,
      ],
      createdAt: scope.manifest.bookshelfIdentity.createdAt,
      metadata: {
        projectionSource: "bookshelf_manifest",
        bookshelfId: scope.bookshelfId,
        bookshelfGeneration: scope.manifest.bookshelfIdentity.generation,
        sourceName: scope.bookshelfId,
      },
    });
  }
  return capabilities;
}

export async function queryBookshelfGraph(
  input: QueryBookshelfGraphInput,
): Promise<GraphRagQueryResponse> {
  const pythonBin = input.pythonBin ?? "python3";
  const bridgePath = input.bridgePath ?? defaultBookshelfGraphBridgePath();
  const scope = await readPublishedScope({
    graphVault: input.graphVault,
    bookshelfId: input.bookshelfId,
    pythonBin,
    bridgePath,
  });
  const maxInputTokens = input.maxInputTokens ?? scope.maxInputTokens;
  const bridgeStartedAt = Date.now();
  const bridge = await runBookshelfGraphQueryBridge({
    pythonBin,
    bridgePath,
    payload: {
      bookshelfId: scope.bookshelfId,
      scopeKind: "bookshelf",
      scopeId: scope.bookshelfId,
      generation: scope.manifest.bookshelfIdentity.generation,
      outputRoot: scope.root,
      query: input.query,
      maxReports: input.maxReports ?? scope.maxReports,
      maxInputTokens,
    },
  }).catch((error: unknown) => {
    if (error instanceof Error) {
      if (error.message.startsWith("upper_index_runtime_error:")) {
        throw new BookshelfQueryScopeError(
          "upper_index_runtime_error",
          "Bookshelf upper index runtime failed during fixed-budget query.",
          ["parquet_bridge_failed"],
        );
      }
      if (error.message.startsWith("upper_quality_gate_failed:")) {
        throw new BookshelfQueryScopeError(
          "upper_quality_gate_failed",
          "Bookshelf query bridge returned an invalid typed response.",
          ["bookshelf_query_response_invalid"],
        );
      }
    }
    throw new BookshelfQueryScopeError(
      "upper_index_runtime_error",
      "Bookshelf upper index runtime failed during fixed-budget query.",
      ["bookshelf_query_runtime_error"],
    );
  });
  const bridgeDurationMs = Math.max(0, Date.now() - bridgeStartedAt);
  if (!bridge.ok) {
    const budgetExceeded = bridge.diagnostics.includes(
      "budget_exceeded_narrow_scope_required",
    );
    throw new BookshelfQueryScopeError(
      budgetExceeded
        ? "budget_exceeded_narrow_scope_required"
        : "upper_quality_gate_failed",
      "Bookshelf query could not produce a ready fixed-budget response.",
      bridge.diagnostics,
    );
  }
  return GraphRagQueryResponseSchema.parse({
    schemaVersion: SchemaVersion,
    method: input.method ?? "global",
    responseText: bridge.answerText,
    evidence: bridge.evidence.map((item) => ({
      evidenceId: item.evidenceMapId,
      graphCapabilityId: `bookshelf:${scope.bookshelfId}:graph_query`,
      sourceId: item.targetSourceId,
      documentId: item.targetDocumentId,
      bookId: item.targetBookId,
      contentHash: item.targetContentHash,
      graphTextUnitId: item.targetTextUnitId,
      artifactId: item.targetCommunityReportId,
      locator: {
        path: packageLocator({
          scopeKind: "bookshelf",
          scopeId: scope.bookshelfId,
          generation: scope.manifest.bookshelfIdentity.generation,
          relativePath: "community_reports.parquet",
        }),
      },
      quote: item.quote,
      score: item.score,
      metadata: {
        scopeKind: "bookshelf",
        bookshelfId: scope.bookshelfId,
        bookshelfGeneration: scope.manifest.bookshelfIdentity.generation,
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
        totalDurationMs: bridgeDurationMs,
        stages: [
          {
            name: "bookshelf.fixed_budget_report_search",
            durationMs: bridgeDurationMs,
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
          loggedComputeDurationMs: bridgeDurationMs,
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
