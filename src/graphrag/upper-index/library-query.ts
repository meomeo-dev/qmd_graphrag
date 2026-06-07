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
  defaultBookshelfGraphBridgePath,
  runBookshelfGraphQueryBridge,
} from "./bookshelf-graph-parquet.js";
import {
  LibraryGraphManifestSchema,
  LibraryQualityGateSchema,
  type LibraryGraphManifest,
} from "./library-graph-contracts.js";
import { validateLibraryGraphAtRoot } from "./library-graph-validator.js";
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

export type LibraryQueryScopeErrorCode =
  | "upper_index_missing"
  | "upper_package_migration_required"
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
  manifestSha256: string;
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
  scope: LibraryQueryScope;
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
    throw new LibraryQueryScopeError(
      "budget_exceeded_narrow_scope_required",
      "Library query budget cannot exceed the package-local fixed budget.",
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
  libraryId: string;
  pythonBin: string;
  bridgePath: string;
}): Promise<LibraryQueryScope> {
  const graphVault = resolve(input.graphVault);
  let packageReady: Awaited<ReturnType<typeof readQueryReadyPackage>>;
  try {
    packageReady = await readQueryReadyPackage({
      graphVault,
      scopeKind: "library",
      scopeId: input.libraryId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("upper_package_migration_required:")) {
      throw new LibraryQueryScopeError(
        "upper_package_migration_required",
        "Library upper package must be migrated out of catalog.",
        ["legacy_catalog_library_package_requires_migration"],
      );
    }
    if (message.startsWith("upper_quality_gate_failed:")) {
      throw new LibraryQueryScopeError(
        "upper_quality_gate_failed",
        "Library package-local publish gate is not query-ready.",
        [message.replace(/^upper_quality_gate_failed:/u, "")],
      );
    }
    throw new LibraryQueryScopeError(
      "upper_index_missing",
      "Library upper package is missing or not query-ready.",
      [message.replace(/^upper_index_missing:/u, "")],
    );
  }
  const root = packageReady.generationRoot;
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
    const budgetExceeded = hasBudgetDiagnostic(validation.diagnostics);
    const stale = validation.diagnostics.some((item) =>
      item.includes("stale") ||
      item.includes("sha_changed")
    );
    throw new LibraryQueryScopeError(
      budgetExceeded
        ? "budget_exceeded_narrow_scope_required"
        : stale ? "upper_index_stale" : "upper_quality_gate_failed",
      "Library upper index failed query readiness validation.",
      validation.diagnostics,
    );
  }
  const manifest = LibraryGraphManifestSchema.parse(
    await readHotplugPackageUnknown(packageReady.manifestPath),
  );
  const gate = LibraryQualityGateSchema.parse(
    await readHotplugPackageUnknown(packageReady.gatePath),
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
    manifestSha256: packageReady.current.manifestSha256,
    maxInputTokens: manifest.fixedQueryBudget.maxInputTokens,
    maxReports: manifest.fixedQueryBudget.maxSemanticUnits,
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
  return [upperGraphQueryCapability({
    scopeKind: "library",
    scopeId: scope.libraryId,
    generation: scope.manifest.libraryIdentity.generation,
    createdAt: scope.manifest.libraryIdentity.createdAt,
    manifestSha256: scope.manifestSha256,
    method: input.method,
  })];
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
      scopeKind: "library",
      scopeId: scope.libraryId,
      libraryId: scope.libraryId,
      generation: scope.manifest.libraryIdentity.generation,
      outputRoot: scope.root,
      query: input.query,
      maxReports: budget.maxReports,
      maxInputTokens: budget.maxInputTokens,
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
  const bridgeDurationMs = Math.max(0, Date.now() - bridgeStartedAt);
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
  const graphCapabilityId = upperGraphQueryCapabilityId({
    scopeKind: "library",
    scopeId: scope.libraryId,
    generation: scope.manifest.libraryIdentity.generation,
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
          scopeKind: "library",
          scopeId: scope.libraryId,
          generation: scope.manifest.libraryIdentity.generation,
          relativePath: "community_reports.parquet",
        }),
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
        totalDurationMs: bridgeDurationMs,
        stages: [
          {
            name: "library.fixed_budget_report_search",
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
      scopeKind: "library",
      scopeId: scope.libraryId,
      generation: scope.manifest.libraryIdentity.generation,
      query: input.query,
      method: input.method ?? "global",
      responseType: input.responseType ?? "multiple paragraphs",
      communityLevel: input.communityLevel,
      upperResponse,
      maxDeepeningTargets: scope.manifest.fixedQueryBudget.maxBookshelves,
      requestedMaxDeepeningTargets: input.controlledDeepening?.maxTargets,
      loadBookCapabilities: input.controlledDeepening?.loadBookCapabilities,
      runBookQuery: input.controlledDeepening?.runBookQuery,
    });
  } catch (error) {
    if (error instanceof ControlledDeepeningError) {
      throw new LibraryQueryScopeError(
        error.code,
        error.message,
        error.diagnostics,
      );
    }
    throw error;
  }
}
