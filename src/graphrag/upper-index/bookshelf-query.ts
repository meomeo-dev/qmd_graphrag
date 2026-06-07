import { resolve } from "node:path";

import { SchemaVersion } from "../../contracts/common.js";
import type { GraphCapability } from "../../contracts/graph-enhancement.js";
import {
  GraphRagQueryResponseSchema,
  type GraphRagQueryResponse,
  type GraphRagSearchMethod,
} from "../../contracts/graphrag.js";
import { readHotplugPackageUnknown } from "../book-hotplug-package-readonly.js";
import {
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
import {
  upperGraphQueryCapability,
  upperGraphQueryCapabilityId,
} from "./upper-query-capability.js";
import {
  ControlledDeepeningError,
  applyControlledDeepening,
  type ControlledDeepeningBookQuery,
} from "./controlled-deepening.js";

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
  manifestSha256: string;
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
  responseType?: string;
  communityLevel?: number;
  controlledDeepening?: {
    enabled?: boolean;
    maxTargets?: number;
    loadBookCapabilities?: (
      bookIds: readonly string[],
    ) => Promise<GraphCapability[]>;
    runBookQuery?: ControlledDeepeningBookQuery;
  };
};

function hasBudgetDiagnostic(diagnostics: readonly string[]): boolean {
  return diagnostics.some((item) =>
    item === "budget_exceeded_narrow_scope_required" ||
    item.startsWith("budget_exceeded_narrow_scope_required:")
  );
}

function resolveRequestedBudget(input: {
  requestedMaxReports?: number;
  requestedMaxInputTokens?: number;
  scope: BookshelfQueryScope;
}): { maxReports: number; maxInputTokens: number } {
  const diagnostics: string[] = [];
  if (input.requestedMaxReports != null) {
    if (
      !Number.isInteger(input.requestedMaxReports) ||
      input.requestedMaxReports < 1
    ) {
      diagnostics.push(`invalid_max_reports:${input.requestedMaxReports}`);
    } else if (input.requestedMaxReports > input.scope.maxReports) {
      diagnostics.push(
        `requested_max_reports_exceeds_package_budget:` +
          `${input.requestedMaxReports}:max:${input.scope.maxReports}`,
      );
    }
  }
  if (input.requestedMaxInputTokens != null) {
    if (
      !Number.isInteger(input.requestedMaxInputTokens) ||
      input.requestedMaxInputTokens < 1
    ) {
      diagnostics.push(
        `invalid_max_input_tokens:${input.requestedMaxInputTokens}`,
      );
    } else if (input.requestedMaxInputTokens > input.scope.maxInputTokens) {
      diagnostics.push(
        `requested_max_input_tokens_exceeds_package_budget:` +
          `${input.requestedMaxInputTokens}:max:${input.scope.maxInputTokens}`,
      );
    }
  }
  if (diagnostics.length > 0) {
    throw new BookshelfQueryScopeError(
      "budget_exceeded_narrow_scope_required",
      "Bookshelf query budget cannot exceed the package-local fixed budget.",
      diagnostics,
    );
  }
  return {
    maxReports: input.requestedMaxReports ?? input.scope.maxReports,
    maxInputTokens:
      input.requestedMaxInputTokens ?? input.scope.maxInputTokens,
  };
}

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
    const budgetExceeded = hasBudgetDiagnostic(validation.diagnostics);
    const stale = validation.diagnostics.some((item) =>
      item.startsWith("member_manifest_stale:") ||
      item.includes("stale")
    );
    throw new BookshelfQueryScopeError(
      budgetExceeded
        ? "budget_exceeded_narrow_scope_required"
        : stale ? "upper_index_stale" : "upper_quality_gate_failed",
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
    manifestSha256: packageReady.current.manifestSha256,
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
  return [upperGraphQueryCapability({
    scopeKind: "bookshelf",
    scopeId: scope.bookshelfId,
    generation: scope.manifest.bookshelfIdentity.generation,
    createdAt: scope.manifest.bookshelfIdentity.createdAt,
    manifestSha256: scope.manifestSha256,
    method: input.method,
  })];
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
  const budget = resolveRequestedBudget({
    requestedMaxReports: input.maxReports,
    requestedMaxInputTokens: input.maxInputTokens,
    scope,
  });
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
      maxReports: budget.maxReports,
      maxInputTokens: budget.maxInputTokens,
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
  const graphCapabilityId = upperGraphQueryCapabilityId({
    scopeKind: "bookshelf",
    scopeId: scope.bookshelfId,
    generation: scope.manifest.bookshelfIdentity.generation,
    method: input.method ?? "global",
  });
  const upperResponse = GraphRagQueryResponseSchema.parse({
    schemaVersion: SchemaVersion,
    method: input.method ?? "global",
    responseText: bridge.answerText,
    evidence: bridge.evidence.map((item) => ({
      evidenceId: item.evidenceMapId,
      graphCapabilityId,
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
  try {
    return await applyControlledDeepening({
      enabled: input.controlledDeepening?.enabled,
      graphVault: scope.graphVault,
      scopeKind: "bookshelf",
      scopeId: scope.bookshelfId,
      generation: scope.manifest.bookshelfIdentity.generation,
      query: input.query,
      method: input.method ?? "global",
      responseType: input.responseType ?? "multiple paragraphs",
      communityLevel: input.communityLevel,
      upperResponse,
      maxDeepeningTargets: scope.manifest.fixedQueryBudget.maxBooksForDeepening,
      requestedMaxDeepeningTargets: input.controlledDeepening?.maxTargets,
      loadBookCapabilities: input.controlledDeepening?.loadBookCapabilities,
      runBookQuery: input.controlledDeepening?.runBookQuery,
    });
  } catch (error) {
    if (error instanceof ControlledDeepeningError) {
      throw new BookshelfQueryScopeError(
        error.code,
        error.message,
        error.diagnostics,
      );
    }
    throw error;
  }
}
