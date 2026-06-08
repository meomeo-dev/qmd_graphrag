import { describe, expect, test } from "vitest";

import { SchemaVersion } from "../src/contracts/common.js";
import type { GraphRagQueryResponse } from "../src/contracts/graphrag.js";
import {
  UpperSynthesisError,
  applyUpperSynthesis,
} from "../src/graphrag/upper-index/upper-synthesis.js";

function upperResponse(): GraphRagQueryResponse {
  return {
    schemaVersion: SchemaVersion,
    method: "global",
    responseText: "Upper report-only answer",
    evidence: [
      {
        evidenceId: "upper-evidence-1",
        graphCapabilityId: "bookshelf:scope:graph_query",
        sourceId: "sha256:source-a",
        documentId: "doc-a",
        bookId: "book-a",
        contentHash: "content-a",
        graphTextUnitId: "upper-tu-1",
        artifactId: "upper-report-1",
        locator: {
          path: "bookshelves/architecture-core/generations/gen/community_reports.parquet",
        },
        quote: "Architecture evidence quote.",
        score: 0.9,
        metadata: {
          scopeKind: "bookshelf",
          upperCommunityReportTitle: "Architecture report",
          rawPrompt: "must not survive metadata sanitization",
        },
      },
      {
        evidenceId: "upper-evidence-2",
        graphCapabilityId: "bookshelf:scope:graph_query",
        sourceId: "sha256:source-b",
        documentId: "doc-b",
        bookId: "book-b",
        contentHash: "content-b",
        graphTextUnitId: "upper-tu-2",
        artifactId: "upper-report-2",
        locator: {
          path: "bookshelves/architecture-core/generations/gen/community_reports.parquet",
        },
        quote: "Delivery evidence quote.",
        score: 0.8,
      },
    ],
    providerDetail: {
      provider: "graphrag",
      method: "global",
      runtimeMetrics: {
        kind: "graphrag_query_runtime_metrics",
        scope: "current_invocation",
        totalDurationMs: 3,
        stages: [{
          name: "bookshelf.fixed_budget_report_search",
          durationMs: 3,
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
          promptTokens: 40,
          completionTokens: 0,
          totalTokens: 40,
          unattributedWallDurationMs: 0,
        },
      },
    },
  };
}

describe("GraphRAG upper LLM synthesis", () => {
  test("keeps report-only upper response when disabled", async () => {
    const response = upperResponse();

    await expect(applyUpperSynthesis({
      enabled: false,
      scopeKind: "bookshelf",
      scopeId: "architecture-core",
      generation: "gen",
      query: "How do topics relate?",
      method: "global",
      upperResponse: response,
      maxInputTokens: 2048,
      maxOutputTokens: 512,
    })).resolves.toBe(response);
  });

  test("synthesizes selected upper evidence with one bounded runner call", async () => {
    const calls: string[] = [];
    const response = await applyUpperSynthesis({
      enabled: true,
      scopeKind: "bookshelf",
      scopeId: "architecture-core",
      generation: "gen",
      query: "How do topics relate?",
      method: "global",
      upperResponse: upperResponse(),
      maxInputTokens: 2048,
      requestedMaxInputTokens: 1024,
      maxOutputTokens: 512,
      requestedMaxOutputTokens: 128,
      runner: async (input) => {
        calls.push(input.prompt);
        expect(input.evidence.map((item) => item.evidenceId)).toEqual([
          "upper-evidence-1",
          "upper-evidence-2",
        ]);
        expect(input.maxInputTokens).toBe(1024);
        expect(input.maxOutputTokens).toBe(128);
        return {
          text: "Synthesized answer [upper-evidence-1] [upper-evidence-2]",
          model: "deterministic-synthesis",
          promptTokens: input.estimatedInputTokens,
          completionTokens: 12,
          durationMs: 9,
        };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("within 128 output tokens");
    expect(response.responseText).toBe(
      "Synthesized answer [upper-evidence-1] [upper-evidence-2]",
    );
    expect(response.evidence).toHaveLength(2);
    expect(response.evidence[0]?.metadata).toMatchObject({
      upperSynthesis: true,
      upperScopeKind: "bookshelf",
      upperScopeId: "architecture-core",
      synthesisInputEvidence: true,
    });
    expect(response.evidence[0]?.metadata?.rawPrompt).toBeUndefined();
    expect(response.providerDetail?.runtimeMetrics?.aggregate
      .attemptedRequestCount).toBe(1);
    expect(response.providerDetail?.runtimeMetrics?.aggregate
      .successfulResponseCount).toBe(1);
    expect(response.providerDetail?.runtimeMetrics?.aggregate
      .completionTokens).toBe(12);
    expect(response.providerDetail?.runtimeMetrics?.stages.map((stage) =>
      stage.name
    )).toContain("upper.llm_synthesis");
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("Answer the user query using");
    expect(serialized).not.toContain("rawPrompt");
    expect(serialized).not.toContain("rawCompletion");
    expect(serialized).not.toContain("providerRequestPayload");
  });

  test("fails closed when requested synthesis budget exceeds package budget",
    async () => {
      await expect(applyUpperSynthesis({
        enabled: true,
        scopeKind: "library",
        scopeId: "software-library",
        generation: "gen",
        query: "How do shelves relate?",
        method: "global",
        upperResponse: upperResponse(),
        maxInputTokens: 1024,
        requestedMaxInputTokens: 2048,
        maxOutputTokens: 512,
        requestedMaxOutputTokens: 128,
        runner: async () => ({ text: "unused" }),
      })).rejects.toMatchObject({
        name: "UpperSynthesisError",
        code: "budget_exceeded_narrow_scope_required",
        diagnostics: [
          "requested_synthesis_input_tokens_exceeds_package_budget:2048:max:1024",
        ],
      } satisfies Partial<UpperSynthesisError>);
    },
  );

  test("fails closed when no synthesis runner is configured", async () => {
    await expect(applyUpperSynthesis({
      enabled: true,
      scopeKind: "bookshelf",
      scopeId: "architecture-core",
      generation: "gen",
      query: "How do topics relate?",
      method: "global",
      upperResponse: upperResponse(),
      maxInputTokens: 2048,
      maxOutputTokens: 512,
    })).rejects.toMatchObject({
      name: "UpperSynthesisError",
      code: "upper_index_runtime_error",
      diagnostics: ["upper_synthesis_runner_missing"],
    } satisfies Partial<UpperSynthesisError>);
  });
});
