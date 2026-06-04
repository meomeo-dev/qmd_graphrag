import { SchemaVersion } from "../contracts/common.js";
import type { GraphCapability } from "../contracts/graph-enhancement.js";
import {
  GraphRagQueryResponseSchema,
  type GraphRagQueryResponse,
} from "../contracts/graphrag.js";
import type {
  QmdRetrievalCandidate,
  QmdSearchResult,
} from "../contracts/qmd-query.js";
import {
  QmdRetrievalCandidateSchema,
  QmdSearchResultSchema,
} from "../contracts/qmd-query.js";
import { DspyQueryExpansionStrictRefusalError } from "../dspy/errors.js";
import {
  GraphCapabilityErrorSchema,
  QueryRouteDecisionSchema,
  TypedQueryErrorSchema,
  UnifiedQueryRequestSchema,
  type CandidateRouteDecision,
  type GraphCapabilityError,
  type QueryCostClass,
  type QueryIntentClass,
  type QueryRouteDecision,
  type RouteRefusalReason,
  type TypedQueryError,
  type UnifiedAnswer,
  type UnifiedQueryRequest,
} from "../contracts/unified-query.js";
import type { QueryTimingRecorder } from "./query-timing.js";
import { buildUnifiedAnswer } from "./unified-answer.js";

export const DEFAULT_GRAPH_COVERAGE_THRESHOLD = 0.7;
export const DEFAULT_MAX_COST_CLASS: QueryCostClass = "medium";

const COST_RANK: Record<QueryCostClass, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export class TypedQueryErrorException extends Error {
  readonly payload: TypedQueryError;

  constructor(payload: TypedQueryError) {
    super(payload.redactedMessage);
    this.name = "TypedQueryErrorException";
    this.payload = payload;
  }
}

export function classifyQueryIntent(query: string): QueryIntentClass {
  const normalized = query.toLowerCase();
  if (/关系|关联|联系|为什么|原因|综合|总结|全书|跨章节/.test(query)) {
    return "graph_synthesis";
  }
  if (/\b(relationship|relate|why|synthesize|summari[sz]e|across)\b/.test(normalized)) {
    return "graph_synthesis";
  }
  if (/多跳|推理|因果/.test(query)) return "multi_hop_reasoning";
  if (/\b(multi-hop|reason|causal|tradeoff)\b/.test(normalized)) {
    return "multi_hop_reasoning";
  }
  if (/定位|原文|文件|章节/.test(query)) return "source_location";
  if (/\b(file|source|where|locate|chapter)\b/.test(normalized)) {
    return "source_location";
  }
  return "lookup";
}

function compareCost(a: QueryCostClass, b: QueryCostClass): number {
  return COST_RANK[a] - COST_RANK[b];
}

function graphCostForIntent(intentClass: QueryIntentClass): QueryCostClass {
  return intentClass === "multi_hop_reasoning" ? "high" : "medium";
}

function getCandidateCapabilities(
  candidate: QmdRetrievalCandidate,
  capabilitiesByCandidateId?: Map<string, GraphCapability[]>,
): GraphCapability[] {
  const explicit = capabilitiesByCandidateId?.get(candidate.candidateId);
  return explicit?.filter(capability => capability.ready) ?? [];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

export type DecideRouteInput = {
  request: UnifiedQueryRequest;
  candidates: QmdRetrievalCandidate[];
  capabilitiesByCandidateId?: Map<string, GraphCapability[]>;
};

export function decideRoute(input: DecideRouteInput): QueryRouteDecision {
  const threshold = input.request.graphCoverageThreshold
    ?? DEFAULT_GRAPH_COVERAGE_THRESHOLD;
  const maxCostClass = input.request.maxCostClass ?? DEFAULT_MAX_COST_CLASS;
  const intentClass = classifyQueryIntent(input.request.query);
  const costClass = graphCostForIntent(intentClass);
  const graphCapableCandidateIds = new Set<string>();
  const candidateCapabilities = new Map<string, GraphCapability[]>();
  const candidateById = new Map(
    input.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );

  for (const candidate of input.candidates) {
    const capabilities = getCandidateCapabilities(
      candidate,
      input.capabilitiesByCandidateId,
    );
    candidateCapabilities.set(candidate.candidateId, capabilities);
    if (capabilities.length > 0) {
      graphCapableCandidateIds.add(candidate.candidateId);
    }
  }

  const totalCandidateCount = input.candidates.length;
  const graphReadyCandidateCount = graphCapableCandidateIds.size;
  const graphCoverage = totalCandidateCount === 0
    ? 0
    : graphReadyCandidateCount / totalCandidateCount;
  const isGraphIntent = intentClass === "graph_synthesis"
    || intentClass === "multi_hop_reasoning";
  const costAllowed = compareCost(costClass, maxCostClass) <= 0;
  const graphUpgradeAllowed = input.request.allowGraphUpgrade !== false;

  const refusalReasons: RouteRefusalReason[] = [];
  if (graphReadyCandidateCount === 0) refusalReasons.push("no_graph_ready_candidate");
  if (graphCoverage < threshold) refusalReasons.push("coverage_below_threshold");
  if (!isGraphIntent) refusalReasons.push("intent_not_graph_synthesis");
  if (!costAllowed) refusalReasons.push("cost_policy_exceeded");
  if (!graphUpgradeAllowed) refusalReasons.push("graph_upgrade_disabled");

  const selectedRoute = input.request.requestedRoute === "graphrag"
    ? "graphrag"
    : input.request.requestedRoute === "qmd"
      ? "qmd"
      : refusalReasons.length === 0
        ? "graphrag"
        : "qmd";
  const isExplicitGraphRefusal =
    input.request.requestedRoute === "graphrag" && graphReadyCandidateCount === 0;
  const status = isExplicitGraphRefusal ? "refused" : "selected";

  const candidateDecisions: CandidateRouteDecision[] = input.candidates.map((candidate) => {
    const isGraphReady = graphCapableCandidateIds.has(candidate.candidateId);
    const capabilities = candidateCapabilities.get(candidate.candidateId) ?? [];
    const bookId = capabilities[0]?.bookId ?? null;
    const selected = status === "selected" && (selectedRoute === "qmd" || isGraphReady);
    const refusalReason = isGraphReady
      ? null
      : "capability_missing" as const;

    return {
      candidateId: candidate.candidateId,
      sourceId: candidate.sourceId,
      documentId: candidate.documentId,
      bookId,
      isGraphReady,
      retrievalScore: candidate.retrievalScore,
      rerankScore: candidate.rerankScore ?? null,
      selected,
      selectionReason: selected
        ? selectedRoute === "qmd" ? "selected_for_qmd" : "selected_for_graph"
        : null,
      refusalReason: selected ? null : refusalReason,
    };
  });
  const selectedCandidateDecisions = candidateDecisions.filter(
    (decision) => decision.selected,
  );
  const selectedCapabilities = selectedCandidateDecisions.flatMap((decision) =>
    candidateCapabilities.get(decision.candidateId) ?? []
  );
  const selectedSourceIds = selectedRoute === "graphrag"
    ? uniqueStrings(selectedCapabilities.map((capability) => capability.sourceId))
    : uniqueStrings(
        selectedCandidateDecisions.map((decision) => decision.sourceId),
      );
  const selectedDocumentIds = selectedRoute === "graphrag"
    ? uniqueStrings(selectedCapabilities.map((capability) => capability.documentId))
    : uniqueStrings(
        selectedCandidateDecisions.map((decision) => decision.documentId),
      );
  const selectedContentHashes = selectedRoute === "graphrag"
    ? uniqueStrings(selectedCapabilities.map((capability) => capability.contentHash))
    : uniqueStrings(
        selectedCandidateDecisions.map((decision) =>
          candidateById.get(decision.candidateId)?.contentHash ?? null
        ),
      );

  return QueryRouteDecisionSchema.parse({
    requestedRoute: input.request.requestedRoute,
    selectedRoute,
    status,
    reasonCode: selectedRoute === "graphrag"
      ? input.request.requestedRoute === "graphrag"
        ? status === "refused" ? "capability_missing" : "explicit_graphrag_route"
        : "graph_upgrade"
      : input.request.requestedRoute === "graphrag"
        ? "capability_missing"
        : "qmd_retrieval",
    intentClass,
    costClass,
    maxCostClass,
    graphCoverage,
    candidateDistribution: {
      totalCandidateCount,
      graphReadyCandidateCount,
      nonGraphReadyCandidateCount: totalCandidateCount - graphReadyCandidateCount,
    },
    selectedSourceIds,
    selectedDocumentIds,
    selectedContentHashes,
    selectedBookIds: uniqueStrings(
      selectedCapabilities.map((capability) => capability.bookId),
    ),
    candidateEvidenceIds: selectedCandidateDecisions.map(
      (decision) => decision.candidateId,
    ),
    graphCapabilityIds: uniqueStrings(
      selectedCapabilities.map((capability) => capability.capabilityId),
    ),
    graphArtifactIds: uniqueStrings(
      selectedCapabilities.flatMap((capability) => capability.artifactIds),
    ),
    candidateDecisions,
    refusalReasons,
  });
}

export function buildGraphCapabilityError(
  candidate: QmdRetrievalCandidate | undefined,
): GraphCapabilityError {
  return GraphCapabilityErrorSchema.parse({
    schemaVersion: SchemaVersion,
    route: "graphrag",
    provider: null,
    capability: "graph_query",
    code: "capability_missing",
    retryable: false,
    queriedScope: "graph_enhanced_subset",
    sourceId: candidate?.sourceId ?? null,
    documentId: candidate?.documentId ?? null,
    bookId: null,
    redactedMessage: "No graph_query capability is available for this query scope.",
  });
}

export function createTypedQueryError(input: {
  route: UnifiedQueryRequest["requestedRoute"];
  stage: TypedQueryError["stage"];
  provider?: string | null;
  capability?: string | null;
  code: string;
  retryable: boolean;
  redactedMessage: string;
  graphCapabilityError?: GraphCapabilityError;
  metadata?: TypedQueryError["metadata"];
}): TypedQueryError {
  return TypedQueryErrorSchema.parse({
    schemaVersion: SchemaVersion,
    route: input.route,
    stage: input.stage,
    provider: input.provider ?? null,
    capability: input.capability ?? null,
    code: input.code,
    retryable: input.retryable,
    redactedMessage: input.redactedMessage,
    graphCapabilityError: input.graphCapabilityError,
    metadata: input.metadata,
  });
}

export type RouteQueryServices = {
  searchQmd(request: UnifiedQueryRequest): Promise<QmdSearchResult>;
  queryGraphRag?(
    request: UnifiedQueryRequest,
    decision: QueryRouteDecision,
  ): Promise<GraphRagQueryResponse>;
  resolveGraphCapabilities?(
    candidates: QmdRetrievalCandidate[],
  ): Promise<Map<string, GraphCapability[]>>;
  resolveGraphScopeCapabilities?(
    request: UnifiedQueryRequest,
  ): Promise<GraphCapability[]>;
  timing?: QueryTimingRecorder;
};

function measureRouteStage<T>(
  services: RouteQueryServices,
  name: string,
  action: () => T | Promise<T>,
): T | Promise<T> {
  return services.timing == null
    ? action()
    : services.timing.measure(name, action);
}

function typedGraphProviderError(input: {
  request: UnifiedQueryRequest;
  code: "provider_unavailable" | "provider_response_invalid";
  stage?: TypedQueryError["stage"];
  retryable?: boolean;
  redactedMessage: string;
}): TypedQueryErrorException {
  return new TypedQueryErrorException(createTypedQueryError({
    route: input.request.requestedRoute,
    stage: input.stage ?? "graphrag_query",
    provider: "graphrag",
    capability: "graph_query",
    code: input.code,
    retryable: input.retryable ?? false,
    redactedMessage: input.redactedMessage,
  }));
}

function isTransientGraphProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return [
    "concurrency limit",
    "rate limit",
    "temporarily unavailable",
    "stream_read_error",
    "timeout",
    "timed out",
    "service unavailable",
    "gateway timeout",
    "bad gateway",
    "apiconnectionerror",
    "api connection error",
    "connectionerror",
    "connecterror",
    "connecttimeout",
    "readtimeout",
    "clientconnectorerror",
    "serverdisconnectederror",
    "remote protocol error",
    "jina_aiexception",
    "jina ai exception",
    "jina_ai exception",
    "cannot connect to host",
    "network error",
    "fetch failed",
    "ssl",
    "unexpected_eof_while_reading",
    "eof occurred in violation of protocol",
    "connection reset",
    "connection reset by peer",
    "read reset",
    "connection aborted",
    "connection refused",
    "socket hang up",
    "temporary failure in name resolution",
    "getaddrinfo",
    "dns",
    "httpx.",
    "aiohttp.",
    "urllib3.",
    "econnreset",
    "econnrefused",
    "enotfound",
    "etimedout",
    "eai_again",
    "(429)",
  ].some((token) => message.includes(token)) ||
    /(?:http|status(?: code)?|error code|code)[^\d]*([5]\d\d)/iu
      .test(message) ||
    /\(([5]\d\d)\)/iu.test(message);
}

function typedGraphCapabilityResolutionError(input: {
  request: UnifiedQueryRequest;
  code: string;
  redactedMessage: string;
  metadata?: TypedQueryError["metadata"];
}): TypedQueryErrorException {
  return new TypedQueryErrorException(createTypedQueryError({
    route: input.request.requestedRoute,
    stage: "graph_capability",
    provider: "graphrag",
    capability: "graph_query",
    code: input.code,
    retryable: false,
    redactedMessage: input.redactedMessage,
    metadata: input.metadata,
  }));
}

function typedDspyQueryExpansionError(input: {
  request: UnifiedQueryRequest;
  error: DspyQueryExpansionStrictRefusalError;
}): TypedQueryErrorException {
  return new TypedQueryErrorException(createTypedQueryError({
    route: input.request.requestedRoute,
    stage: "qmd_retrieval",
    provider: "dspy",
    capability: "query_expansion",
    code: input.error.reason,
    retryable: false,
    redactedMessage: input.error.message,
    metadata: {
      dspyFailureReason: input.error.reason,
    },
  }));
}

async function resolveGraphScopeCapabilitiesForRoute(
  request: UnifiedQueryRequest,
  services: RouteQueryServices,
): Promise<GraphCapability[] | null> {
  if (
    request.requestedRoute !== "graphrag" ||
    services.resolveGraphScopeCapabilities == null
  ) {
    return null;
  }
  try {
    return await services.resolveGraphScopeCapabilities(request);
  } catch (error) {
    if (error instanceof TypedQueryErrorException) throw error;
    throw typedGraphCapabilityResolutionError({
      request,
      code: "capability_catalog_unreadable",
      redactedMessage:
        "GraphRAG capability catalog is unreadable or invalid for this query scope.",
      metadata: {
        errorName: error instanceof Error ? error.name : typeof error,
      },
    });
  }
}

async function resolveCandidateCapabilitiesForRoute(
  request: UnifiedQueryRequest,
  services: RouteQueryServices,
  candidates: QmdRetrievalCandidate[],
): Promise<Map<string, GraphCapability[]> | undefined> {
  if (services.resolveGraphCapabilities == null) return undefined;
  try {
    return await services.resolveGraphCapabilities(candidates);
  } catch (error) {
    if (error instanceof TypedQueryErrorException) throw error;
    throw typedGraphCapabilityResolutionError({
      request,
      code: "capability_catalog_unreadable",
      redactedMessage:
        "GraphRAG capability catalog is unreadable or invalid for qmd candidates.",
      metadata: {
        errorName: error instanceof Error ? error.name : typeof error,
      },
    });
  }
}

function graphScopeCandidatesFromCapabilities(
  capabilities: readonly GraphCapability[],
): QmdRetrievalCandidate[] {
  return capabilities.map((capability) =>
    QmdRetrievalCandidateSchema.parse({
      candidateId: `graph:${capability.capabilityId}`,
      sourceId: capability.sourceId,
      documentId: capability.documentId,
      contentHash: capability.contentHash,
      chunkId: null,
      collection: "graph",
      path: `graph://${capability.bookId}`,
      title: capability.metadata?.sourceName == null
        ? capability.bookId
        : String(capability.metadata.sourceName),
      source: "hybrid",
      retrievalScore: 1,
      rerankScore: null,
      metadata: {
        bookId: capability.bookId,
        capabilityId: capability.capabilityId,
        artifactIds: capability.artifactIds,
      },
    }),
  );
}

function capabilitiesByGraphScopeCandidate(
  candidates: readonly QmdRetrievalCandidate[],
  capabilities: readonly GraphCapability[],
): Map<string, GraphCapability[]> {
  return new Map(candidates.map((candidate, index) => [
    candidate.candidateId,
    capabilities[index] == null ? [] : [capabilities[index]!],
  ]));
}

export async function routeQuery(
  request: UnifiedQueryRequest,
  services: RouteQueryServices,
): Promise<UnifiedAnswer> {
  const startedAt = Date.now();
  const parsedRequest = UnifiedQueryRequestSchema.parse(request);
  const graphScopeCapabilities = await measureRouteStage(
    services,
    "route.resolve_graph_scope_capabilities",
    () => resolveGraphScopeCapabilitiesForRoute(parsedRequest, services),
  );
  const graphScopeCandidates = graphScopeCapabilities == null
    ? null
    : graphScopeCandidatesFromCapabilities(graphScopeCapabilities);
  let qmdResult: QmdSearchResult;
  if (graphScopeCandidates == null) {
    try {
      qmdResult = QmdSearchResultSchema.parse(await measureRouteStage(
        services,
        "route.qmd_retrieval",
        () => services.searchQmd(parsedRequest),
      ));
    } catch (error) {
      if (error instanceof TypedQueryErrorException) throw error;
      if (error instanceof DspyQueryExpansionStrictRefusalError) {
        throw typedDspyQueryExpansionError({ request: parsedRequest, error });
      }
      throw error;
    }
  } else {
    qmdResult = QmdSearchResultSchema.parse({
      schemaVersion: SchemaVersion,
      query: parsedRequest.query,
      results: graphScopeCandidates,
      metadata: {
        source: "graph_capability_scope",
      },
    });
  }
  const capabilitiesByCandidateId = graphScopeCandidates != null
    ? capabilitiesByGraphScopeCandidate(
        graphScopeCandidates,
        graphScopeCapabilities ?? [],
      )
    : await measureRouteStage(
        services,
        "route.resolve_candidate_graph_capabilities",
        () => resolveCandidateCapabilitiesForRoute(
          parsedRequest,
          services,
          qmdResult.results,
        ),
      );
  const decision = await measureRouteStage(
    services,
    "route.decide",
    () => decideRoute({
      request: parsedRequest,
      candidates: qmdResult.results,
      capabilitiesByCandidateId,
    }),
  );

  if (
    parsedRequest.requestedRoute === "graphrag"
    && decision.graphCapabilityIds.length === 0
  ) {
    const capabilityError = buildGraphCapabilityError(qmdResult.results[0]);
    throw new TypedQueryErrorException(createTypedQueryError({
      route: parsedRequest.requestedRoute,
      stage: "graph_capability",
      capability: "graph_query",
      code: capabilityError.code,
      retryable: false,
      redactedMessage: capabilityError.redactedMessage,
      graphCapabilityError: capabilityError,
    }));
  }

  if (decision.selectedRoute === "graphrag") {
    if (!services.queryGraphRag) {
      throw new TypedQueryErrorException(createTypedQueryError({
        route: parsedRequest.requestedRoute,
        stage: "provider",
        provider: "graphrag",
        capability: "graph_query",
        code: "provider_unavailable",
        retryable: false,
        redactedMessage: "GraphRAG query provider is not configured.",
      }));
    }

    let graphRagResponse: GraphRagQueryResponse;
    try {
      graphRagResponse = GraphRagQueryResponseSchema.parse(
        await measureRouteStage(
          services,
          "route.query_graphrag_provider",
          () => services.queryGraphRag!(parsedRequest, decision),
        ),
      );
    } catch (error) {
      if (error instanceof TypedQueryErrorException) throw error;
      if (error instanceof Error && error.name === "ZodError") {
        throw typedGraphProviderError({
          request: parsedRequest,
          code: "provider_response_invalid",
          stage: "provider",
          redactedMessage: "GraphRAG provider returned an invalid typed response.",
        });
      }
      const retryable = isTransientGraphProviderError(error);
      throw typedGraphProviderError({
        request: parsedRequest,
        code: "provider_unavailable",
        retryable,
        redactedMessage: "GraphRAG query provider failed before returning a response.",
      });
    }
    return measureRouteStage(
      services,
      "route.build_answer",
      () => buildUnifiedAnswer({
        query: parsedRequest.query,
        routeDecision: decision,
        qmdResult,
        graphRagResponse,
        elapsedMs: Date.now() - startedAt,
      }),
    );
  }

  return measureRouteStage(
    services,
    "route.build_answer",
    () => buildUnifiedAnswer({
      query: parsedRequest.query,
      routeDecision: decision,
      qmdResult,
      elapsedMs: Date.now() - startedAt,
    }),
  );
}
