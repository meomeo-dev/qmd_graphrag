import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { SchemaVersion } from "../contracts/common.js";
import {
  GraphRagIndexRequestSchema,
  GraphRagQueryRequestSchema,
  GraphRagIndexResponseSchema,
  GraphRagQueryResponseSchema,
} from "../contracts/graphrag.js";
import type { JsonValue } from "../contracts/common.js";
import type {
  GraphRagEvidence,
  GraphRagIndexRequest,
  GraphRagIndexResponse,
  GraphRagIndexScope,
  GraphRagQueryRequest,
  GraphRagQueryResponse,
} from "../contracts/graphrag.js";
import {
  appendProviderCostAccounting,
  buildProviderCostAccounting,
} from "../provider/cost-accounting.js";
import { ProviderRequestFingerprintSchema } from "../contracts/provider.js";
import type { ProviderCostLineageMode } from "../contracts/provider.js";
import {
  createDeterministicHash,
  toIsoTimestamp,
} from "../job-state/fingerprint.js";
import { callPythonBridge } from "./python-bridge.js";

const GRAPHRAG_QUERY_MAX_RETRIES = 3;
const GRAPHRAG_QUERY_RETRY_BASE_MS = 1000;

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGraphRagQueryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("concurrency limit") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable") ||
    message.includes("timeout") ||
    message.includes("(429)") ||
    message.includes("(500)") ||
    message.includes("(502)") ||
    message.includes("(503)") ||
    message.includes("(504)")
  );
}

async function callGraphRagQueryBridgeWithRetry(
  parsed: GraphRagQueryRequest,
): Promise<GraphRagQueryResponse> {
  for (let attempt = 0; attempt <= GRAPHRAG_QUERY_MAX_RETRIES; attempt += 1) {
    try {
      return await callPythonBridge({
        command: "graphrag_query",
        pythonBin: parsed.environment?.pythonBin,
        workingDirectory: parsed.environment?.workingDirectory,
        request: parsed,
        responseSchema: GraphRagQueryResponseSchema,
      });
    } catch (error) {
      if (
        attempt >= GRAPHRAG_QUERY_MAX_RETRIES ||
        !isRetryableGraphRagQueryError(error)
      ) {
        throw error;
      }
      await delayMs(GRAPHRAG_QUERY_RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw new Error("unreachable GraphRAG query retry state");
}

async function writeGraphRagProviderRequestArtifact(input: {
  rootDir: string;
  stage: string;
  model: string;
  request: Record<string, unknown>;
}): Promise<{
  artifactId: string;
  artifactPath: string;
  requestFingerprint: string;
}> {
  const requestFingerprint = createDeterministicHash(input.request);
  const artifactId = createDeterministicHash([
    "provider_request",
    "graphrag",
    input.stage,
    input.model,
    requestFingerprint,
  ]);
  const artifactPath = `catalog/provider-requests/${artifactId}.json`;
  const absolutePath = join(input.rootDir, artifactPath);
  const requestArtifact = ProviderRequestFingerprintSchema.parse({
    schemaVersion: SchemaVersion,
    artifactId,
    kind: "provider_request_fingerprint",
    provider: "graphrag",
    stage: input.stage,
    model: input.model,
    requestFingerprint,
    createdAt: toIsoTimestamp(),
    metadata: {
      adapter: "python/qmd_graphrag/bridge.py",
    },
  });
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(requestArtifact, null, 2), "utf8");
  return { artifactId, artifactPath, requestFingerprint };
}

async function recordGraphRagCost(input: {
  rootDir: string;
  stage: string;
  model: string;
  runId: string;
  requestCount?: number;
  artifactIds: string[];
  sourceId?: string | null;
  documentId?: string | null;
  bookId?: string | null;
  contentHash?: string | null;
  lineageMode: ProviderCostLineageMode;
  requestArtifactId: string;
  requestArtifactPath: string;
  requestFingerprint: string;
  metadata?: Record<string, JsonValue>;
}): Promise<void> {
  const record = buildProviderCostAccounting({
    sourceId: input.sourceId ?? null,
    documentId: input.documentId ?? null,
    bookId: input.bookId ?? null,
    contentHash: input.contentHash ?? null,
    lineageMode: input.lineageMode,
    stage: input.stage,
    provider: "graphrag",
    model: input.model,
    requestCount: input.requestCount ?? 1,
    tokenCount: 0,
    tokenCountStatus: "unknown",
    embeddingCount: 0,
    embeddingCountStatus: "unknown",
    cacheHit: false,
    runId: input.runId,
    requestArtifactId: input.requestArtifactId,
    artifactIds: [...new Set([input.requestArtifactId, ...input.artifactIds])],
    metadata: {
      ...(input.metadata ?? {}),
      requestArtifactPath: input.requestArtifactPath,
      requestFingerprint: input.requestFingerprint,
    },
  });
  await appendProviderCostAccounting(input.rootDir, record);
}

function evidenceCostLineage(
  evidence: readonly GraphRagEvidence[],
): Array<{
  sourceId: string | null;
  documentId: string | null;
  bookId: string | null;
  contentHash: string | null;
  artifactIds: string[];
}> {
  const groups = new Map<string, {
    sourceId: string | null;
    documentId: string | null;
    bookId: string | null;
    contentHash: string | null;
    artifactIds: Set<string>;
  }>();

  for (const item of evidence) {
    const key = JSON.stringify([
      item.bookId ?? null,
      item.sourceId ?? null,
      item.documentId ?? null,
      item.contentHash ?? null,
    ]);
    const existing = groups.get(key) ?? {
      sourceId: item.sourceId ?? null,
      documentId: item.documentId ?? null,
      bookId: item.bookId ?? null,
      contentHash: item.contentHash ?? null,
      artifactIds: new Set<string>(),
    };
    if (item.artifactId) existing.artifactIds.add(item.artifactId);
    groups.set(key, existing);
  }

  return [...groups.values()].map((item) => ({
    sourceId: item.sourceId,
    documentId: item.documentId,
    bookId: item.bookId,
    contentHash: item.contentHash,
    artifactIds: [...item.artifactIds],
  }));
}

function indexCostLineage(scope: GraphRagIndexScope | undefined): {
  sourceId: string | null;
  documentId: string | null;
  bookId: string | null;
  contentHash: string | null;
  artifactIds: string[];
} {
  return {
    sourceId: scope?.sourceId ?? null,
    documentId: scope?.documentId ?? null,
    bookId: scope?.bookId ?? null,
    contentHash: scope?.contentHash ?? null,
    artifactIds: [...new Set(scope?.artifactIds ?? [])],
  };
}

export async function runGraphRagQuery(
  request: GraphRagQueryRequest,
): Promise<GraphRagQueryResponse> {
  const parsed = GraphRagQueryRequestSchema.parse({
    ...request,
    responseType: request.responseType ?? "multiple paragraphs",
  });
  const requestArtifact = await writeGraphRagProviderRequestArtifact({
    rootDir: parsed.rootDir,
    stage: "graphrag_query",
    model: parsed.method,
    request: {
      method: parsed.method,
      query: parsed.query,
      responseType: parsed.responseType,
      capabilityScope: parsed.capabilityScope,
      communityLevel: parsed.communityLevel,
      dynamicCommunitySelection: parsed.dynamicCommunitySelection,
    },
  });

  const response = await callGraphRagQueryBridgeWithRetry(parsed);
  const lineages = evidenceCostLineage(response.evidence);
  const runId = `graphrag-query-${Date.now()}`;
  for (const [index, lineage] of lineages.entries()) {
    await recordGraphRagCost({
      rootDir: parsed.rootDir,
      stage: "graphrag_query",
      model: parsed.method,
      runId,
      requestCount: index === 0 ? 1 : 0,
      ...lineage,
      lineageMode: "graph_artifact",
      requestArtifactId: requestArtifact.artifactId,
      requestArtifactPath: requestArtifact.artifactPath,
      requestFingerprint: requestArtifact.requestFingerprint,
      metadata: {
        graphCapabilityIds: parsed.capabilityScope.graphCapabilityIds,
        selectedBookIds: parsed.capabilityScope.selectedBookIds,
        sourceIds: parsed.capabilityScope.sourceIds,
        documentIds: parsed.capabilityScope.documentIds,
        contentHashes: parsed.capabilityScope.contentHashes,
        scopedArtifactIds: parsed.capabilityScope.artifactIds,
        lineageGroupCount: lineages.length,
        lineageGroupIndex: index,
        requestCountPolicy: "first_group_counts_request",
      },
    });
  }
  return response;
}

export async function runGraphRagIndex(
  request: GraphRagIndexRequest,
): Promise<GraphRagIndexResponse> {
  const parsed = GraphRagIndexRequestSchema.parse(request);
  const requestArtifact = await writeGraphRagProviderRequestArtifact({
    rootDir: parsed.rootDir,
    stage: "graphrag_index",
    model: parsed.method,
    request: {
      method: parsed.method,
      skipValidation: parsed.skipValidation,
      workflows: parsed.workflows ?? null,
      indexScope: parsed.indexScope ?? null,
    },
  });

  const response = await callPythonBridge({
    command: "graphrag_index",
    pythonBin: parsed.environment?.pythonBin,
    workingDirectory: parsed.environment?.workingDirectory,
    request: parsed,
    responseSchema: GraphRagIndexResponseSchema,
  });
  const lineage = indexCostLineage(parsed.indexScope);
  await recordGraphRagCost({
    rootDir: parsed.rootDir,
    stage: "graphrag_index",
    model: parsed.method,
    runId: `graphrag-index-${Date.now()}`,
    ...lineage,
    lineageMode: "graph_artifact",
    artifactIds: lineage.artifactIds,
    requestArtifactId: requestArtifact.artifactId,
    requestArtifactPath: requestArtifact.artifactPath,
    requestFingerprint: requestArtifact.requestFingerprint,
    metadata: {
      workflows: response.outputs.map((output) => output.workflow),
      ...(parsed.indexScope == null ? {} : {
        scopedBookId: parsed.indexScope.bookId,
      }),
    },
  });
  return response;
}
