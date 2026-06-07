import { describe, expect, test } from "vitest";

import { SchemaVersion } from "../src/contracts/common.js";
import type { GraphCapability } from "../src/contracts/graph-enhancement.js";
import type { GraphRagQueryResponse } from "../src/contracts/graphrag.js";
import {
  ControlledDeepeningError,
  applyControlledDeepening,
} from "../src/graphrag/upper-index/controlled-deepening.js";

function capability(bookId: string): GraphCapability {
  return {
    schemaVersion: SchemaVersion,
    capabilityId: `${bookId}:graph_query`,
    kind: "graph_query",
    bookId,
    sourceId: `sha256:${bookId}`,
    documentId: `doc-${bookId}`,
    contentHash: `content-${bookId}`,
    ready: true,
    readinessSource: "validated_checkpoint_plus_validated_manifest",
    artifactIds: [`artifact-${bookId}-report`, `artifact-${bookId}-lancedb`],
    createdAt: "2026-06-07T00:00:00.000Z",
  };
}

function upperResponse(input: {
  scopeKind: "bookshelf" | "library";
  books: readonly string[];
  bookshelfIds?: readonly string[];
}): GraphRagQueryResponse {
  return {
    schemaVersion: SchemaVersion,
    method: "global",
    responseText: `${input.scopeKind} upper answer`,
    evidence: input.books.map((bookId, index) => ({
      evidenceId: `upper-evidence-${index + 1}`,
      graphCapabilityId: `${input.scopeKind}:scope:graph_query`,
      sourceId: `sha256:${bookId}`,
      documentId: `doc-${bookId}`,
      bookId,
      contentHash: `content-${bookId}`,
      graphTextUnitId: `upper-tu-${index + 1}`,
      artifactId: `upper-report-${index + 1}`,
      locator: { path: `${input.scopeKind}/scope/community_reports.parquet` },
      quote: `upper quote ${index + 1}`,
      score: 1 - index / 10,
      metadata: {
        scopeKind: input.scopeKind,
        ...(input.bookshelfIds?.[index] == null
          ? {}
          : { targetBookshelfId: input.bookshelfIds[index] }),
      },
    })),
    providerDetail: {
      provider: "graphrag",
      method: "global",
      runtimeMetrics: {
        kind: "graphrag_query_runtime_metrics",
        scope: "current_invocation",
        totalDurationMs: 4,
        stages: [{
          name: `${input.scopeKind}.fixed_budget_report_search`,
          durationMs: 4,
          status: "succeeded",
        }],
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
          promptTokens: 120,
          completionTokens: 0,
          totalTokens: 120,
          unattributedWallDurationMs: 0,
        },
      },
    },
  };
}

function childResponse(bookId: string): GraphRagQueryResponse {
  return {
    schemaVersion: SchemaVersion,
    method: "global",
    responseText: `deep answer for ${bookId}`,
    evidence: [{
      evidenceId: `deep-evidence-${bookId}`,
      graphCapabilityId: `${bookId}:graph_query`,
      sourceId: `sha256:${bookId}`,
      documentId: `doc-${bookId}`,
      bookId,
      contentHash: `content-${bookId}`,
      graphTextUnitId: `tu-${bookId}`,
      artifactId: `artifact-${bookId}-report`,
      locator: { path: `books/${bookId}/graphrag/output/community_reports.parquet` },
      quote: `deep quote ${bookId}`,
      score: 0.9,
    }],
    providerDetail: {
      provider: "graphrag",
      method: "global",
      runtimeMetrics: {
        kind: "graphrag_query_runtime_metrics",
        scope: "current_invocation",
        totalDurationMs: 7,
        stages: [{
          name: "book.graphrag_query",
          durationMs: 7,
          status: "succeeded",
        }],
        modelMetrics: [],
        aggregate: {
          modelCount: 1,
          attemptedRequestCount: 1,
          successfulResponseCount: 1,
          failedResponseCount: 0,
          requestsWithRetries: 0,
          retryCount: 0,
          streamingResponseCount: 0,
          loggedComputeDurationMs: 7,
          promptTokens: 40,
          completionTokens: 12,
          totalTokens: 52,
          unattributedWallDurationMs: 0,
        },
      },
    },
  };
}

describe("GraphRAG upper controlled deepening", () => {
  test("keeps upper report-only response when disabled", async () => {
    const response = upperResponse({
      scopeKind: "bookshelf",
      books: ["book-a", "book-b"],
    });

    await expect(applyControlledDeepening({
      enabled: false,
      graphVault: "/tmp/unused",
      scopeKind: "bookshelf",
      scopeId: "architecture-core",
      generation: "generation-1",
      query: "How do topics relate?",
      method: "global",
      responseType: "multiple paragraphs",
      upperResponse: response,
      maxDeepeningTargets: 2,
    })).resolves.toBe(response);
  });

  test("deepens only the selected fixed-budget bookshelf member books", async () => {
    const calledBooks: string[] = [];
    const response = await applyControlledDeepening({
      enabled: true,
      graphVault: "/tmp/unused",
      scopeKind: "bookshelf",
      scopeId: "architecture-core",
      generation: "generation-1",
      query: "How do topics relate?",
      method: "global",
      responseType: "multiple paragraphs",
      upperResponse: upperResponse({
        scopeKind: "bookshelf",
        books: ["book-a", "book-b", "book-c"],
      }),
      maxDeepeningTargets: 2,
      requestedMaxDeepeningTargets: 1,
      loadBookCapabilities: async (bookIds) => bookIds.map(capability),
      runBookQuery: async (input) => {
        calledBooks.push(input.bookId);
        expect(input.capabilityScope.selectedBookIds).toEqual([input.bookId]);
        expect(input.capabilityScope.graphCapabilityIds).toEqual([
          `${input.bookId}:graph_query`,
        ]);
        return childResponse(input.bookId);
      },
    });

    expect(calledBooks).toEqual(["book-a"]);
    expect(response.responseText).toContain("Controlled deepening results");
    expect(response.responseText).toContain("deep answer for book-a");
    expect(response.evidence).toHaveLength(4);
    const deepEvidence = response.evidence.find((item) =>
      item.evidenceId.includes(":deepening:")
    );
    expect(deepEvidence).toMatchObject({
      bookId: "book-a",
      sourceId: "sha256:book-a",
      metadata: {
        upperDeepening: true,
        upperScopeKind: "bookshelf",
        upperScopeId: "architecture-core",
        selectedByUpperEvidenceIds: ["upper-evidence-1"],
      },
    });
    expect(response.providerDetail?.runtimeMetrics?.aggregate
      .attemptedRequestCount).toBe(1);
    expect(response.providerDetail?.runtimeMetrics?.stages.map((stage) =>
      stage.name
    )).toContain("upper.controlled_book_deepening");
  });

  test("fails closed when requested deepening exceeds package budget", async () => {
    await expect(applyControlledDeepening({
      enabled: true,
      graphVault: "/tmp/unused",
      scopeKind: "bookshelf",
      scopeId: "architecture-core",
      generation: "generation-1",
      query: "How do topics relate?",
      method: "global",
      responseType: "multiple paragraphs",
      upperResponse: upperResponse({
        scopeKind: "bookshelf",
        books: ["book-a", "book-b"],
      }),
      maxDeepeningTargets: 1,
      requestedMaxDeepeningTargets: 2,
      loadBookCapabilities: async () => [],
      runBookQuery: async () => childResponse("book-a"),
    })).rejects.toMatchObject({
      name: "ControlledDeepeningError",
      code: "budget_exceeded_narrow_scope_required",
      diagnostics: [
        "requested_deepening_targets:2",
        "max_deepening_targets:1",
      ],
    } satisfies Partial<ControlledDeepeningError>);
  });

  test("fails closed when selected member book capability is missing", async () => {
    await expect(applyControlledDeepening({
      enabled: true,
      graphVault: "/tmp/unused",
      scopeKind: "bookshelf",
      scopeId: "architecture-core",
      generation: "generation-1",
      query: "How do topics relate?",
      method: "global",
      responseType: "multiple paragraphs",
      upperResponse: upperResponse({
        scopeKind: "bookshelf",
        books: ["book-a", "book-b"],
      }),
      maxDeepeningTargets: 2,
      loadBookCapabilities: async () => [capability("book-a")],
      runBookQuery: async () => childResponse("book-a"),
    })).rejects.toMatchObject({
      name: "ControlledDeepeningError",
      code: "upper_index_stale",
      diagnostics: [
        "controlled_deepening_book_capability_missing:book-b",
      ],
    } satisfies Partial<ControlledDeepeningError>);
  });

  test("deduplicates library deepening by selected bookshelf target", async () => {
    const calledBooks: string[] = [];
    const response = await applyControlledDeepening({
      enabled: true,
      graphVault: "/tmp/unused",
      scopeKind: "library",
      scopeId: "software-library",
      generation: "generation-1",
      query: "How do shelves relate?",
      method: "global",
      responseType: "multiple paragraphs",
      upperResponse: upperResponse({
        scopeKind: "library",
        books: ["book-a1", "book-a2", "book-b1"],
        bookshelfIds: ["shelf-a", "shelf-a", "shelf-b"],
      }),
      maxDeepeningTargets: 2,
      loadBookCapabilities: async (bookIds) => bookIds.map(capability),
      runBookQuery: async (input) => {
        calledBooks.push(input.bookId);
        return childResponse(input.bookId);
      },
    });

    expect(calledBooks).toEqual(["book-a1", "book-b1"]);
    const deepEvidence = response.evidence.filter((item) =>
      item.evidenceId.includes(":deepening:")
    );
    expect(deepEvidence.map((item) => item.bookId)).toEqual([
      "book-a1",
      "book-b1",
    ]);
    expect(deepEvidence[0]?.metadata).toMatchObject({
      upperScopeKind: "library",
      selectedDeepeningTarget: "shelf-a",
      selectedByUpperEvidenceIds: ["upper-evidence-1", "upper-evidence-2"],
    });
  });
});
