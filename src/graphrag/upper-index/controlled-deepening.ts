import {
  GraphRagQueryResponseSchema,
  type GraphRagCapabilityScope,
  type GraphRagEvidence,
  type GraphRagQueryResponse,
  type GraphRagQueryRuntimeAggregate,
  type GraphRagQueryRuntimeMetrics,
  type GraphRagSearchMethod,
} from "../../contracts/graphrag.js";
import type { GraphCapability } from "../../contracts/graph-enhancement.js";
import { sanitizeVaultMetadata } from "../../vault/metadata.js";
import {
  hasAbsolutePathSyntax,
  isPortableVaultRelativePath,
} from "../../vault/path.js";
import { loadGraphQueryCapabilities } from "../capability-catalog.js";

export type ControlledDeepeningErrorCode =
  | "budget_exceeded_narrow_scope_required"
  | "upper_index_stale"
  | "upper_quality_gate_failed"
  | "upper_index_runtime_error";

export class ControlledDeepeningError extends Error {
  readonly code: ControlledDeepeningErrorCode;
  readonly diagnostics: string[];

  constructor(
    code: ControlledDeepeningErrorCode,
    message: string,
    diagnostics: string[] = [],
  ) {
    super(message);
    this.name = "ControlledDeepeningError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export type ControlledDeepeningScopeKind = "bookshelf" | "library";

export type ControlledDeepeningBookQueryInput = {
  bookId: string;
  capability: GraphCapability;
  capabilityScope: GraphRagCapabilityScope;
  query: string;
  method: GraphRagSearchMethod;
  responseType: string;
  communityLevel?: number;
};

export type ControlledDeepeningBookQuery = (
  input: ControlledDeepeningBookQueryInput,
) => Promise<GraphRagQueryResponse>;

export type ApplyControlledDeepeningInput = {
  enabled?: boolean;
  graphVault: string;
  scopeKind: ControlledDeepeningScopeKind;
  scopeId: string;
  generation: string;
  query: string;
  method: GraphRagSearchMethod;
  responseType: string;
  communityLevel?: number;
  upperResponse: GraphRagQueryResponse;
  maxDeepeningTargets: number;
  requestedMaxDeepeningTargets?: number;
  loadBookCapabilities?: (
    bookIds: readonly string[],
  ) => Promise<GraphCapability[]>;
  runBookQuery?: ControlledDeepeningBookQuery;
};

type DeepeningTarget = {
  bookId: string;
  targetKey: string;
  selectedByEvidenceIds: string[];
};

function metadataString(
  metadata: GraphRagEvidence["metadata"],
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function targetKeyForEvidence(
  scopeKind: ControlledDeepeningScopeKind,
  evidence: GraphRagEvidence,
): string | null {
  if (evidence.bookId == null || evidence.bookId === "") return null;
  if (scopeKind === "library") {
    return metadataString(evidence.metadata, "targetBookshelfId") ??
      evidence.bookId;
  }
  return evidence.bookId;
}

function selectDeepeningTargets(input: {
  scopeKind: ControlledDeepeningScopeKind;
  evidence: readonly GraphRagEvidence[];
  limit: number;
}): { targets: DeepeningTarget[]; totalCandidateTargetCount: number } {
  const byTarget = new Map<string, DeepeningTarget>();
  for (const evidence of input.evidence) {
    const bookId = evidence.bookId;
    const targetKey = targetKeyForEvidence(input.scopeKind, evidence);
    if (bookId == null || targetKey == null) continue;
    const existing = byTarget.get(targetKey);
    if (existing == null) {
      byTarget.set(targetKey, {
        bookId,
        targetKey,
        selectedByEvidenceIds: [evidence.evidenceId],
      });
      continue;
    }
    existing.selectedByEvidenceIds.push(evidence.evidenceId);
  }
  return {
    targets: [...byTarget.values()].slice(0, input.limit),
    totalCandidateTargetCount: byTarget.size,
  };
}

function capabilityScope(capability: GraphCapability): GraphRagCapabilityScope {
  return {
    selectedBookIds: [capability.bookId],
    graphCapabilityIds: [capability.capabilityId],
    sourceIds: [capability.sourceId],
    documentIds: [capability.documentId],
    contentHashes: [capability.contentHash],
    artifactIds: capability.artifactIds,
  };
}

function safeLocator(locator: GraphRagEvidence["locator"]): GraphRagEvidence["locator"] {
  if (locator == null) return null;
  const next: NonNullable<GraphRagEvidence["locator"]> = {};
  if (
    typeof locator.path === "string" &&
    !hasAbsolutePathSyntax(locator.path) &&
    isPortableVaultRelativePath(locator.path)
  ) {
    next.path = locator.path.replaceAll("\\", "/");
  }
  if (
    typeof locator.uri === "string" &&
    /^(?:urn|doi):[A-Za-z0-9][A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*$/u
      .test(locator.uri)
  ) {
    next.uri = locator.uri;
  }
  if (locator.lineStart != null) next.lineStart = locator.lineStart;
  if (locator.lineEnd != null) next.lineEnd = locator.lineEnd;
  return Object.keys(next).length > 0 ? next : null;
}

function deepeningEvidence(input: {
  scopeKind: ControlledDeepeningScopeKind;
  scopeId: string;
  generation: string;
  target: DeepeningTarget;
  item: GraphRagEvidence;
}): GraphRagEvidence {
  const metadata = sanitizeVaultMetadata({
    ...(input.item.metadata ?? {}),
    upperDeepening: true,
    upperScopeKind: input.scopeKind,
    upperScopeId: input.scopeId,
    upperGeneration: input.generation,
    selectedDeepeningTarget: input.target.targetKey,
    selectedByUpperEvidenceIds: input.target.selectedByEvidenceIds,
  });
  return {
    ...input.item,
    evidenceId: [
      input.scopeKind,
      input.scopeId,
      "deepening",
      input.target.bookId,
      input.item.evidenceId,
    ].join(":"),
    locator: safeLocator(input.item.locator),
    metadata,
  };
}

function emptyAggregate(): GraphRagQueryRuntimeAggregate {
  return {
    modelCount: 0,
    attemptedRequestCount: 0,
    successfulResponseCount: 0,
    failedResponseCount: 0,
    requestsWithRetries: 0,
    retryCount: 0,
    streamingResponseCount: 0,
    loggedComputeDurationMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    unattributedWallDurationMs: 0,
  };
}

function addAggregate(
  left: GraphRagQueryRuntimeAggregate,
  right: GraphRagQueryRuntimeAggregate,
): GraphRagQueryRuntimeAggregate {
  return {
    modelCount: left.modelCount + right.modelCount,
    attemptedRequestCount:
      left.attemptedRequestCount + right.attemptedRequestCount,
    successfulResponseCount:
      left.successfulResponseCount + right.successfulResponseCount,
    failedResponseCount: left.failedResponseCount + right.failedResponseCount,
    requestsWithRetries: left.requestsWithRetries + right.requestsWithRetries,
    retryCount: left.retryCount + right.retryCount,
    streamingResponseCount:
      left.streamingResponseCount + right.streamingResponseCount,
    loggedComputeDurationMs:
      left.loggedComputeDurationMs + right.loggedComputeDurationMs,
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    unattributedWallDurationMs:
      left.unattributedWallDurationMs + right.unattributedWallDurationMs,
  };
}

function mergeRuntimeMetrics(input: {
  base?: GraphRagQueryRuntimeMetrics;
  childMetrics: readonly (GraphRagQueryRuntimeMetrics | undefined)[];
  deepeningDurationMs: number;
  attemptedDeepeningCount: number;
  successfulDeepeningCount: number;
}): GraphRagQueryRuntimeMetrics | undefined {
  if (
    input.base == null &&
    input.attemptedDeepeningCount === 0 &&
    input.childMetrics.every((item) => item == null)
  ) {
    return undefined;
  }
  const childAggregate = input.childMetrics.reduce(
    (aggregate, metrics) =>
      metrics == null ? aggregate : addAggregate(aggregate, metrics.aggregate),
    emptyAggregate(),
  );
  const childAttemptCount = childAggregate.attemptedRequestCount > 0
    ? childAggregate.attemptedRequestCount
    : input.attemptedDeepeningCount;
  const childSuccessCount = childAggregate.successfulResponseCount > 0
    ? childAggregate.successfulResponseCount
    : input.successfulDeepeningCount;
  const syntheticChildAggregate: GraphRagQueryRuntimeAggregate = {
    ...childAggregate,
    attemptedRequestCount: childAttemptCount,
    successfulResponseCount: childSuccessCount,
    loggedComputeDurationMs: childAggregate.loggedComputeDurationMs,
    unattributedWallDurationMs:
      childAggregate.unattributedWallDurationMs + input.deepeningDurationMs,
  };
  const aggregate = addAggregate(
    input.base?.aggregate ?? emptyAggregate(),
    syntheticChildAggregate,
  );
  const modelMetrics = [
    ...(input.base?.modelMetrics ?? []),
    ...input.childMetrics.flatMap((metrics) => metrics?.modelMetrics ?? []),
  ].slice(0, 32);
  const stages = [
    ...(input.base?.stages ?? []),
    {
      name: "upper.controlled_book_deepening",
      durationMs: input.deepeningDurationMs,
      status: "succeeded" as const,
    },
  ].slice(0, 16);
  return {
    kind: "graphrag_query_runtime_metrics",
    scope: "current_invocation",
    totalDurationMs:
      (input.base?.totalDurationMs ?? 0) + input.deepeningDurationMs,
    stages,
    modelMetrics,
    aggregate,
  };
}

function deepeningSummaryText(input: {
  targets: readonly DeepeningTarget[];
  responses: readonly GraphRagQueryResponse[];
}): string {
  if (input.responses.length === 0) return "";
  const lines = [
    "",
    "Controlled deepening results from selected member books:",
  ];
  for (const [index, response] of input.responses.entries()) {
    const target = input.targets[index];
    if (target == null) continue;
    lines.push(`- ${target.bookId}: ${response.responseText}`);
  }
  return lines.join("\n");
}

export async function applyControlledDeepening(
  input: ApplyControlledDeepeningInput,
): Promise<GraphRagQueryResponse> {
  if (input.enabled !== true) return input.upperResponse;
  if (input.runBookQuery == null) {
    throw new ControlledDeepeningError(
      "upper_index_runtime_error",
      "Controlled deepening requested but no single-book GraphRAG runner is configured.",
      ["controlled_deepening_runner_missing"],
    );
  }
  if (input.maxDeepeningTargets <= 0) {
    throw new ControlledDeepeningError(
      "budget_exceeded_narrow_scope_required",
      "Controlled deepening cannot run because the package budget is zero.",
      ["controlled_deepening_budget_zero"],
    );
  }
  const requestedMax = input.requestedMaxDeepeningTargets ??
    input.maxDeepeningTargets;
  if (requestedMax <= 0 || requestedMax > input.maxDeepeningTargets) {
    throw new ControlledDeepeningError(
      "budget_exceeded_narrow_scope_required",
      "Controlled deepening target count exceeds the package fixed budget.",
      [
        `requested_deepening_targets:${requestedMax}`,
        `max_deepening_targets:${input.maxDeepeningTargets}`,
      ],
    );
  }

  const selection = selectDeepeningTargets({
    scopeKind: input.scopeKind,
    evidence: input.upperResponse.evidence,
    limit: requestedMax,
  });
  if (selection.targets.length === 0) {
    return GraphRagQueryResponseSchema.parse({
      ...input.upperResponse,
      evidence: input.upperResponse.evidence,
      providerDetail: {
        provider: "graphrag",
        method: input.method,
        runtimeMetrics: mergeRuntimeMetrics({
          base: input.upperResponse.providerDetail?.runtimeMetrics,
          childMetrics: [],
          deepeningDurationMs: 0,
          attemptedDeepeningCount: 0,
          successfulDeepeningCount: 0,
        }),
      },
    });
  }

  const capabilities = await (input.loadBookCapabilities ??
    ((bookIds: readonly string[]) =>
      loadGraphQueryCapabilities({
        graphVault: input.graphVault,
        bookIds,
      })))(selection.targets.map((target) => target.bookId));
  const capabilityByBook = new Map(
    capabilities.map((capability) => [capability.bookId, capability]),
  );
  const missingBookIds = selection.targets
    .map((target) => target.bookId)
    .filter((bookId) => !capabilityByBook.has(bookId));
  if (missingBookIds.length > 0) {
    throw new ControlledDeepeningError(
      "upper_index_stale",
      "Controlled deepening selected a book that is no longer query-ready.",
      missingBookIds.map((bookId) =>
        `controlled_deepening_book_capability_missing:${bookId}`
      ),
    );
  }

  const startedAt = Date.now();
  const childResponses: GraphRagQueryResponse[] = [];
  for (const target of selection.targets) {
    const capability = capabilityByBook.get(target.bookId);
    if (capability == null) continue;
    try {
      const response = GraphRagQueryResponseSchema.parse(
        await input.runBookQuery({
          bookId: target.bookId,
          capability,
          capabilityScope: capabilityScope(capability),
          query: input.query,
          method: input.method,
          responseType: input.responseType,
          communityLevel: input.communityLevel,
        }),
      );
      childResponses.push(response);
    } catch (error) {
      const diagnostic = error instanceof Error ? error.name : typeof error;
      throw new ControlledDeepeningError(
        "upper_index_runtime_error",
        "Controlled deepening failed while querying a selected member book.",
        [`controlled_deepening_book_query_failed:${target.bookId}:${diagnostic}`],
      );
    }
  }
  const deepeningDurationMs = Math.max(0, Date.now() - startedAt);
  const childEvidence = childResponses.flatMap((response, index) => {
    const target = selection.targets[index];
    if (target == null) return [];
    return response.evidence.map((item) =>
      deepeningEvidence({
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        generation: input.generation,
        target,
        item,
      })
    );
  });
  const providerDetail = {
    provider: "graphrag" as const,
    method: input.method,
    runtimeMetrics: mergeRuntimeMetrics({
      base: input.upperResponse.providerDetail?.runtimeMetrics,
      childMetrics: childResponses.map((response) =>
        response.providerDetail?.runtimeMetrics
      ),
      deepeningDurationMs,
      attemptedDeepeningCount: selection.targets.length,
      successfulDeepeningCount: childResponses.length,
    }),
  };
  return GraphRagQueryResponseSchema.parse({
    ...input.upperResponse,
    responseText:
      input.upperResponse.responseText +
      deepeningSummaryText({
        targets: selection.targets,
        responses: childResponses,
      }),
    evidence: [
      ...input.upperResponse.evidence,
      ...childEvidence,
    ],
    providerDetail,
  });
}
