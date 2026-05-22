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
    requestCount: 1,
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
): {
  sourceId: string | null;
  documentId: string | null;
  bookId: string | null;
  contentHash: string | null;
  artifactIds: string[];
} {
  const first = evidence[0];
  const evidenceArtifactIds = [...new Set(
    evidence
      .map((item) => item.artifactId)
      .filter((item): item is string => !!item),
  )];
  return {
    sourceId: first?.sourceId ?? null,
    documentId: first?.documentId ?? null,
    bookId: first?.bookId ?? null,
    contentHash: first?.contentHash ?? null,
    artifactIds: evidenceArtifactIds,
  };
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

  const response = await callPythonBridge({
    command: "graphrag_query",
    pythonBin: parsed.environment?.pythonBin,
    workingDirectory: parsed.environment?.workingDirectory,
    request: parsed,
    responseSchema: GraphRagQueryResponseSchema,
  });
  const lineage = evidenceCostLineage(response.evidence);
  await recordGraphRagCost({
    rootDir: parsed.rootDir,
    stage: "graphrag_query",
    model: parsed.method,
    runId: `graphrag-query-${Date.now()}`,
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
    },
  });
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
