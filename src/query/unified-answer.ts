import { SchemaVersion } from "../contracts/common.js";
import type { GraphRagQueryResponse } from "../contracts/graphrag.js";
import type { JsonValue } from "../contracts/common.js";
import type {
  QmdRetrievalCandidate,
  QmdSearchResult,
} from "../contracts/qmd-query.js";
import {
  EvidenceRefSchema,
  type EvidenceLocator,
  UnifiedAnswerSchema,
  type EvidenceRef,
  type QueryRouteDecision,
  type UnifiedAnswer,
} from "../contracts/unified-query.js";
import { sanitizeVaultMetadata } from "../vault/metadata.js";
import {
  hasAbsolutePathSyntax,
  isPortableVaultRelativePath,
} from "../vault/path.js";

function sanitizeGraphRagMetadata(
  metadata?: Record<string, JsonValue>,
): Record<string, JsonValue> | undefined {
  return sanitizeVaultMetadata(metadata);
}

function isSafeLocatorUri(uri: string): boolean {
  return /^(?:urn|doi):[A-Za-z0-9][A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*$/iu
    .test(uri);
}

function sanitizeGraphRagLocator(
  locator: GraphRagQueryResponse["evidence"][number]["locator"],
): EvidenceLocator | null {
  if (locator == null) return null;
  const safeLocator: EvidenceLocator = {};
  if (
    typeof locator.path === "string" &&
    !hasAbsolutePathSyntax(locator.path) &&
    isPortableVaultRelativePath(locator.path)
  ) {
    safeLocator.path = locator.path.replaceAll("\\", "/");
  }
  if (typeof locator.uri === "string" && isSafeLocatorUri(locator.uri)) {
    safeLocator.uri = locator.uri;
  }
  if (locator.lineStart != null) safeLocator.lineStart = locator.lineStart;
  if (locator.lineEnd != null) safeLocator.lineEnd = locator.lineEnd;
  return Object.keys(safeLocator).length > 0 ? safeLocator : null;
}

export function buildEvidenceRefsFromQmdResults(
  candidates: QmdRetrievalCandidate[],
): EvidenceRef[] {
  return candidates.map((candidate, index) =>
    EvidenceRefSchema.parse({
      evidenceId: candidate.candidateId || `qmd:${index}`,
      graphCapabilityId: null,
      sourceId: candidate.sourceId,
      documentId: candidate.documentId,
      contentHash: candidate.contentHash ?? null,
      chunkId: candidate.chunkId,
      bookId: null,
      graphTextUnitId: null,
      artifactId: null,
      locator: { path: candidate.path },
      quote: candidate.snippet,
      score: candidate.rerankScore ?? candidate.retrievalScore,
      metadata: {
        ...(candidate.chunkId ? { chunkId: candidate.chunkId } : {}),
        ...(candidate.metadata?.chunkLen != null ? {
          chunkLen: candidate.metadata.chunkLen,
        } : {}),
        ...(candidate.metadata?.chunkPos != null ? {
          chunkPos: candidate.metadata.chunkPos,
        } : {}),
        ...(candidate.metadata?.context != null ? {
          context: candidate.metadata.context,
        } : {}),
        ...(candidate.metadata?.docid != null ? {
          docid: candidate.metadata.docid,
        } : {}),
        ...(candidate.metadata?.explain != null ? {
          explain: candidate.metadata.explain,
        } : {}),
        ...(candidate.metadata?.fullText != null ? {
          fullText: candidate.metadata.fullText,
        } : {}),
        ...(candidate.metadata?.line != null ? {
          line: candidate.metadata.line,
        } : {}),
        ...(candidate.metadata?.path != null ? {
          path: candidate.metadata.path,
        } : {}),
        ...(candidate.metadata?.qmdDocumentIdSource != null ? {
          qmdDocumentIdSource: candidate.metadata.qmdDocumentIdSource,
        } : {}),
        ...(candidate.metadata?.qmdChunkSeq != null ? {
          qmdChunkSeq: candidate.metadata.qmdChunkSeq,
        } : {}),
        title: candidate.title ?? "",
        source: candidate.source ?? "hybrid",
      },
    }),
  );
}

export function buildEvidenceRefsFromGraphRagResponse(
  response: GraphRagQueryResponse,
  fallbackCandidates: QmdRetrievalCandidate[] = [],
): EvidenceRef[] {
  return response.evidence.map((item) =>
    EvidenceRefSchema.parse({
      evidenceId: item.evidenceId,
      graphCapabilityId: item.graphCapabilityId,
      sourceId: item.sourceId,
      documentId: item.documentId,
      contentHash: item.contentHash ?? null,
      chunkId: item.chunkId ?? null,
      bookId: item.bookId,
      graphTextUnitId: item.graphTextUnitId ?? null,
      artifactId: item.artifactId ?? null,
      locator: sanitizeGraphRagLocator(item.locator),
      ...(item.quote == null ? {} : { quote: item.quote }),
      score: item.score,
      metadata: sanitizeGraphRagMetadata(item.metadata),
    }),
  );
}

export type BuildUnifiedAnswerInput = {
  query: string;
  routeDecision: QueryRouteDecision;
  qmdResult?: QmdSearchResult;
  graphRagResponse?: GraphRagQueryResponse;
  elapsedMs?: number;
};

export function buildUnifiedAnswer(input: BuildUnifiedAnswerInput): UnifiedAnswer {
  const candidates = input.qmdResult?.results ?? [];
  const graphRagResponse = input.graphRagResponse;
  const evidence = graphRagResponse
    ? buildEvidenceRefsFromGraphRagResponse(graphRagResponse, candidates)
    : buildEvidenceRefsFromQmdResults(candidates);

  const answerText = graphRagResponse
    ? graphRagResponse.responseText
    : `Found ${candidates.length} qmd retrieval candidates.`;

  return UnifiedAnswerSchema.parse({
    schemaVersion: SchemaVersion,
    query: input.query,
    routeDecision: input.routeDecision,
    answerText,
    evidence,
    providerDetail: graphRagResponse?.providerDetail,
    elapsedMs: input.elapsedMs,
  });
}
