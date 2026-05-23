import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import { DataBusEnvelopeSchema } from "../../src/contracts/bus.js";
import {
  DspyEvaluationReportSchema,
  DspyOptimizationArtifactSchema,
  DspyPolicyPointerSchema,
  DspyPromotionDecisionSchema,
  DspyQueryExpansionProgramOutputSchema,
  DspyQueryPromptOptimizationRequestSchema,
  QueryExpansionFailurePolicySchema,
  QueryExpansionFailureReasonSchema,
  VaultRelativePathSchema,
} from "../../src/contracts/dspy.js";
import {
  GraphCapabilitySchema,
  GraphEnhancementRequestSchema,
} from "../../src/contracts/graph-enhancement.js";
import {
  GraphRagEvidenceSchema,
  GraphRagIndexRequestSchema,
  GraphRagQueryResponseSchema,
  GraphRagQueryRequestSchema,
} from "../../src/contracts/graphrag.js";
import {
  JinaEmbeddingResponseSchema,
  JinaEmbeddingRequestSchema,
  JinaProviderConfigSchema,
  JinaRerankResponseSchema,
  JinaRerankRequestSchema,
} from "../../src/contracts/jina.js";
import {
  OpenAIResponsesProviderConfigSchema,
  OpenAIResponsesRequestSchema,
  OpenAIResponsesResponseSchema,
  OpenAIStructuredOutputSchemaSchema,
  ProviderCostAccountingSchema,
  ProviderRequestFingerprintSchema,
} from "../../src/contracts/provider.js";
import {
  QmdQueryRequestSchema,
  QmdRetrievalCandidateSchema,
  QmdSearchResultSchema,
} from "../../src/contracts/qmd-query.js";
import {
  GraphCapabilityErrorSchema,
  TypedQueryErrorSchema,
  QueryRouteDecisionSchema,
  UnifiedAnswerSchema,
  UnifiedQueryRequestSchema,
} from "../../src/contracts/unified-query.js";
import {
  VaultRestoreReportSchema,
  VaultRestoreRequestSchema,
} from "../../src/contracts/vault.js";
import { SchemaVersion } from "../../src/contracts/common.js";
import {
  BookArtifactManifestSchema,
  BookJobSchema,
  BookJobRunRecordEnvelopeSchema,
} from "../../src/contracts/book-job.js";
import {
  CorpusChunkSchema,
  CorpusDocumentSchema,
  DocumentIdentityMapSchema,
  GraphTextUnitIdentityMapSchema,
  SourceDocumentSchema,
} from "../../src/contracts/corpus.js";
import { restoreFromVault } from "../../src/vault/restore.js";
import { createStore, hashContent } from "../../src/store.js";
import { hashLanceDbDirectoryContents } from "../../src/job-state/artifact-validation.js";
import { hashFile } from "../../src/job-state/fingerprint.js";

type TypeDdPayload = {
  name: string;
  schema: string;
  envelope: string;
  producers?: string[];
  consumers?: string[];
};

type TypeDdBus = {
  payloads?: TypeDdPayload[];
  payload_refs?: string[];
};

type TypeDdDocument = {
  contract_artifacts?: Record<string, {
    path: string;
    exports: string[];
  }>;
  typed_buses: Record<string, TypeDdBus>;
  route_contracts: Record<string, {
    schema: string;
    required_fields?: string[];
  }>;
};

type CatalogType = {
  name: string;
  schema: string;
  envelope: string;
  contract_level: string;
  producers: string[];
  consumers: string[];
};

type CatalogBus = {
  name: string;
  payloads: string[];
};

type CatalogDocument = {
  types: CatalogType[];
  buses: CatalogBus[];
};

const LocalSymbolRefPattern = /^(src|test|scripts|python|finetune)\//;

function expectLocalSymbolRef(ref: string): void {
  expect(
    LocalSymbolRefPattern.test(ref),
    `${ref} must be a local file#symbol reference`,
  ).toBe(true);
  expect(ref, `${ref} must use file#symbol form`).toContain("#");
}

function collectTypeDdPayloads(typeDd: TypeDdDocument): Map<string, TypeDdPayload> {
  const payloads = new Map<string, TypeDdPayload>();
  for (const bus of Object.values(typeDd.typed_buses)) {
    for (const payload of bus.payloads ?? []) {
      expect(payloads.has(payload.name)).toBe(false);
      payloads.set(payload.name, payload);
    }
  }
  return payloads;
}

function unionEnvelopeNames(source: string): string[] {
  const match = source.match(/DataBusEnvelopeSchema = z\.union\(\[([\s\S]*?)\]\)/);
  expect(match?.[1], "DataBusEnvelopeSchema union not found").toBeDefined();
  return [...match![1].matchAll(/\b([A-Za-z0-9_]+EnvelopeSchema)\b/g)]
    .map((item) => item[1]!)
    .sort();
}

async function expectLocalRefExists(ref: string): Promise<void> {
  expectLocalSymbolRef(ref);

  const [filePath, symbolPath] = ref.split("#");
  expect(filePath, `invalid local ref: ${ref}`).toBeTruthy();
  expect(symbolPath, `${ref} must use file#symbol form`).toBeTruthy();
  expect(symbolPath, `${ref} must reference a symbol, not descriptive text`)
    .not.toMatch(/\s/);
  const source = await readFile(filePath!, "utf8");

  const symbols = symbolPath!.split(".");
  for (const symbol of symbols) {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declaration = new RegExp([
      `\\b(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`,
      `\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`,
      `\\b(?:export\\s+)?class\\s+${escaped}\\b`,
      `\\bdef\\s+${escaped}\\b`,
      `\\bclass\\s+${escaped}\\b`,
      `\\b(?:async\\s+)?${escaped}\\s*\\(`,
    ].join("|"));
    expect(
      source,
      `${ref} is declared in catalog but ${symbol} is missing from ${filePath}`,
    ).toMatch(declaration);
  }
}

async function writeCompleteLanceDbFixture(root: string): Promise<void> {
  for (const tableName of [
    "entity_description.lance",
    "community_full_content.lance",
    "text_unit_text.lance",
  ]) {
    const tableDir = join(root, tableName);
    await mkdir(join(tableDir, "data"), { recursive: true });
    await mkdir(join(tableDir, "_versions"), { recursive: true });
    await writeFile(join(tableDir, "data", "part-1.lance"), "rows", "utf8");
    await writeFile(
      join(tableDir, "_versions", "1.manifest"),
      "part-1.lance",
      "utf8",
    );
    await writeFile(
      join(tableDir, "qmd_row_count.json"),
      JSON.stringify({ schemaVersion: SchemaVersion, rowCount: 1 }),
      "utf8",
    );
  }
}

describe("GraphRAG contracts", () => {
  test("accepts a local query request", () => {
    const parsed = GraphRagQueryRequestSchema.parse({
      rootDir: "/tmp/graphrag-root",
      method: "local",
      query: "What changed in the roadmap?",
      responseType: "multiple paragraphs",
      capabilityScope: {
        selectedBookIds: ["book-1"],
        graphCapabilityIds: ["book-1:graph_query"],
        sourceIds: ["sha256:source"],
        documentIds: ["doc-1"],
        contentHashes: ["sha256:content"],
        artifactIds: ["artifact-1"],
      },
      communityLevel: 2,
    });

    expect(parsed.method).toBe("local");
    expect(parsed.communityLevel).toBe(2);
  });

  test("rejects graph query requests without capability scope", () => {
    expect(() =>
      GraphRagQueryRequestSchema.parse({
        rootDir: "/tmp/graphrag-root",
        method: "local",
        query: "What changed in the roadmap?",
        responseType: "multiple paragraphs",
      }),
    ).toThrow();
  });

  test("accepts typed graph evidence", () => {
    const parsed = GraphRagEvidenceSchema.parse({
      evidenceId: "book-1:graph_query",
      graphCapabilityId: "book-1:graph_query",
      sourceId: "source-1",
      documentId: "doc-1",
      bookId: "book-1",
      contentHash: "sha256:content",
      graphTextUnitId: "tu-1",
      artifactId: "artifact-1",
    });

    expect(parsed.bookId).toBe("book-1");
    expect(parsed.graphCapabilityId).toBe("book-1:graph_query");
  });

  test("rejects GraphRAG evidence without resolvable identity", () => {
    expect(() =>
      GraphRagEvidenceSchema.parse({
        evidenceId: "evidence-1",
        sourceId: "source-1",
        documentId: "doc-1",
        bookId: "book-1",
        contentHash: "sha256:content",
      }),
    ).toThrow();
  });

  test("rejects GraphRAG query responses without evidence", () => {
    expect(() =>
      GraphRagQueryResponseSchema.parse({
        schemaVersion: SchemaVersion,
        method: "local",
        responseText: "Graph answer",
      }),
    ).toThrow();
  });

  test("accepts a standard index request", () => {
    const parsed = GraphRagIndexRequestSchema.parse({
      rootDir: "/tmp/graphrag-root",
      method: "standard",
      indexScope: {
        bookId: "book-1",
        sourceId: "source-1",
        documentId: "doc-1",
        contentHash: "content-1",
        artifactIds: [],
      },
      skipValidation: true,
      workflows: ["generate_text_embeddings"],
    });

    expect(parsed.method).toBe("standard");
    expect(parsed.indexScope?.bookId).toBe("book-1");
    expect(parsed.skipValidation).toBe(true);
    expect(parsed.workflows).toEqual(["generate_text_embeddings"]);
  });
});

describe("DSPy contracts", () => {
  test("keeps query expansion failure policy taxonomy exact", () => {
    expect(QueryExpansionFailureReasonSchema.options).toEqual([
      "pointer_missing",
      "decision_missing",
      "policy_unavailable",
      "artifact_missing",
      "generated_expansion_missing",
      "artifact_stale",
      "runtime_output_schema_invalid",
      "runtime_error",
    ]);
    expect(QueryExpansionFailurePolicySchema.parse({
      schemaVersion: SchemaVersion,
      defaultAction: "fallback_to_builtin_expander",
      reasonActions: {
        artifact_missing: "strict_refuse",
        generated_expansion_missing: "strict_refuse",
        artifact_stale: "strict_refuse",
        runtime_output_schema_invalid: "strict_refuse",
        runtime_error: "strict_refuse",
      },
      strictSchema: true,
    }).reasonActions?.generated_expansion_missing).toBe("strict_refuse");
    expect(() => QueryExpansionFailurePolicySchema.parse({
      schemaVersion: SchemaVersion,
      defaultAction: "fallback_to_builtin_expander",
      reasonActions: {
        artifact_invalid: "fallback_to_builtin_expander",
      },
      strictSchema: true,
    })).toThrow(/artifact_invalid is fail-closed/);
    for (const reason of [
      "pointer_missing",
      "decision_missing",
      "policy_unavailable",
    ]) {
      expect(() => QueryExpansionFailurePolicySchema.parse({
        schemaVersion: SchemaVersion,
        defaultAction: "fallback_to_builtin_expander",
        reasonActions: {
          [reason]: "strict_refuse",
        },
        strictSchema: true,
      })).toThrow(/native qmd fallback/);
    }
  });

  test("accepts full query expansion policy lifecycle contracts", () => {
    const fingerprints = {
      modelFingerprint: "model",
      providerFingerprint: "provider",
      retrievalConfigFingerprint: "retrieval",
      corpusSnapshotFingerprint: "corpus",
      indexSnapshotFingerprint: "index",
      retrieverFingerprint: "retriever",
      rerankerFingerprint: "reranker",
      schemaFingerprint: "schema",
    };
    const artifact = DspyOptimizationArtifactSchema.parse({
      schemaVersion: SchemaVersion,
      artifactId: "artifact-1",
      optimizer: "gepa",
      programName: "query_expansion",
      signatureVersion: "query-expansion-v1",
      runtimeProjection: "generated_expansion_records",
      requestMode: "online_policy",
      promotability: "promotable",
      promotionStatus: "candidate",
      createdAt: "2026-05-22T00:00:00.000Z",
      artifactHash: "hash",
      generatedExpansionPath: "dspy/artifact-files/artifact-1/generated.jsonl",
      generatedExpansionHash: "generated-hash",
      providerCallLedgerPath: "dspy/ledgers/artifact-1.jsonl",
      fingerprints,
      metricVersion: "metric-v1",
      trainsetHash: "train-hash",
      maxExpansionItems: 8,
      providerEnvRefs: ["OPENAI_API_KEY"],
      stdoutTail: [],
    });
    const report = DspyEvaluationReportSchema.parse({
      schemaVersion: SchemaVersion,
      reportId: "report-1",
      artifactId: artifact.artifactId,
      artifactHash: artifact.artifactHash,
      metricVersion: "metric-v1",
      createdAt: "2026-05-22T00:00:00.000Z",
      schemaValidity: true,
      promotability: "promotable",
      totalRecords: 1,
      validRecords: 1,
      invalidRecords: 0,
      metrics: { schema_validity: true },
    });
    const pointer = DspyPolicyPointerSchema.parse({
      schemaVersion: SchemaVersion,
      pointerId: "query-expansion-current",
      provider: "dspy",
      active: true,
      currentDecisionId: "decision-1",
      currentDecisionPath: "dspy/promotions/decision-1.yaml",
      failurePolicy: {
        schemaVersion: SchemaVersion,
        defaultAction: "fallback_to_builtin_expander",
        reasonActions: {},
        strictSchema: true,
      },
      updatedAt: "2026-05-22T00:00:00.000Z",
    });
    const decision = DspyPromotionDecisionSchema.parse({
      schemaVersion: SchemaVersion,
      decisionId: "decision-1",
      artifactId: artifact.artifactId,
      artifactHash: artifact.artifactHash,
      artifactPath: "dspy/artifacts/artifact-1.yaml",
      reportId: report.reportId,
      reportHash: "report-hash",
      reportPath: "dspy/reports/report-1.yaml",
      previousDecisionId: null,
      previousPointerState: null,
      historyEntryId: "history-1",
      decisionReason: "contract test",
      promotionStatus: "promoted",
      gateVerdict: "promote",
      decidedAt: "2026-05-22T00:00:00.000Z",
    });

    expect(pointer.currentDecisionId).toBe(decision.decisionId);
  });

  test("rejects non-portable DSPy vault paths", () => {
    for (const path of [
      "/tmp/artifact.yaml",
      "../artifact.yaml",
      "~/artifact.yaml",
      "~user/artifact.yaml",
      "bad\u0000artifact.yaml",
      "C:/artifact.yaml",
      "file://artifact.yaml",
    ]) {
      expect(() => VaultRelativePathSchema.parse(path)).toThrow(/vault-relative/);
    }
  });

  test("accepts only typed query expansion program output", () => {
    const parsed = DspyQueryExpansionProgramOutputSchema.parse({
      schemaVersion: SchemaVersion,
      output: [{ type: "vec", text: "architecture boundaries" }],
    });
    expect(parsed.output[0]?.type).toBe("vec");
  });
});

describe("DSPy contracts", () => {
  test("accepts an optimization request", () => {
    const parsed = DspyQueryPromptOptimizationRequestSchema.parse({
      optimizer: "gepa",
      trainsetPath: "/tmp/train.jsonl",
      model: "openai/gpt-4.1-mini",
      savePromptPath: "/tmp/best_prompt.txt",
      provider: {
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrlEnv: "OPENAI_BASE_URL",
        endpoint: "/responses",
        stream: true,
        model: "gpt-5.4",
        reasoningEffort: "medium",
        strictStructuredOutput: true,
      },
    });

    expect(parsed.optimizer).toBe("gepa");
    expect(parsed.savePromptPath).toContain("best_prompt");
    expect(parsed.provider.endpoint).toBe("/responses");
    expect(parsed.provider.stream).toBe(true);
  });
});

describe("Jina contracts", () => {
  test("accepts provider config", () => {
    const parsed = JinaProviderConfigSchema.parse({
      apiKeyEnv: "JINA_API_KEY",
      baseUrlEnv: "JINA_API_BASE",
      baseUrl: "https://api.jina.ai",
      embeddingEndpoint: "/v1/embeddings",
      rerankEndpoint: "/v1/rerank",
    });

    expect(parsed.apiKeyEnv).toBe("JINA_API_KEY");
    expect(() =>
      JinaProviderConfigSchema.parse({
        apiKeyEnv: "jina-key",
        baseUrlEnv: "JINA_API_BASE",
        baseUrl: "https://api.jina.ai",
        embeddingEndpoint: "/v1/embeddings",
        rerankEndpoint: "/v1/rerank",
      }),
    ).toThrow();
  });

  test("accepts an embedding request", () => {
    const parsed = JinaEmbeddingRequestSchema.parse({
      model: "jina-embeddings-v3",
      input: ["query one", "query two"],
      task: "retrieval.query",
    });

    expect(parsed.model).toBe("jina-embeddings-v3");
  });

  test("accepts an embedding response", () => {
    const parsed = JinaEmbeddingResponseSchema.parse({
      model: "jina-embeddings-v3",
      data: [{
        index: 0,
        embedding: [0.1, 0.2, 0.3],
      }],
      usage: {
        total_tokens: 3,
      },
    });

    expect(parsed.data[0]?.embedding).toHaveLength(3);
  });

  test("accepts a rerank request", () => {
    const parsed = JinaRerankRequestSchema.parse({
      model: "jina-reranker-v3",
      query: "how to configure authentication",
      documents: ["weather report", "set AUTH_SECRET"],
      return_documents: false,
    });

    expect(parsed.model).toBe("jina-reranker-v3");
    expect(parsed.documents).toHaveLength(2);
  });

  test("accepts a rerank response", () => {
    const parsed = JinaRerankResponseSchema.parse({
      model: "jina-reranker-v3",
      results: [{
        index: 1,
        relevance_score: 0.87,
        document: "set AUTH_SECRET",
      }],
      usage: {
        total_tokens: 5,
      },
    });

    expect(parsed.results[0]?.index).toBe(1);
  });
});

describe("Corpus and Graph Enhancement contracts", () => {
  test("accepts typed corpus identities", () => {
    const source = SourceDocumentSchema.parse({
      schemaVersion: SchemaVersion,
      sourceId: "sha256:source",
      sourceHash: "source",
      sourceName: "book.epub",
      sourceRelativePath: "sources/book/source.epub",
    });
    const document = CorpusDocumentSchema.parse({
      schemaVersion: SchemaVersion,
      documentId: "doc-1",
      sourceId: source.sourceId,
      collection: "books",
      relativePath: "book.md",
      contentHash: "sha256:content",
      normalizationPolicyVersion: "v1",
    });
    const chunk = CorpusChunkSchema.parse({
      schemaVersion: SchemaVersion,
      chunkId: "chunk-1",
      documentId: document.documentId,
      sourceId: source.sourceId,
      contentHash: document.contentHash,
      chunkStrategy: "tokens",
      seq: 0,
      pos: 0,
    });
    const identity = DocumentIdentityMapSchema.parse({
      schemaVersion: SchemaVersion,
      sourceId: source.sourceId,
      sourceHash: source.sourceHash,
      canonicalBookId: "book-1",
      documentId: document.documentId,
      contentHash: document.contentHash,
      normalizationPolicyVersion: "v1",
      normalizedPath: "input/book.md",
      chunkIds: [chunk.chunkId],
    });

    expect(identity.documentId).toBe("doc-1");
    expect(identity.normalizedPath).toBe("input/book.md");
  });

  test("rejects non-portable public corpus paths", () => {
    for (const sourceRelativePath of [
      "/tmp/book.epub",
      "~/book.epub",
      "~other/book.epub",
      "bad\u0000book.epub",
      "C:/book.epub",
    ]) {
      expect(() => SourceDocumentSchema.parse({
        schemaVersion: SchemaVersion,
        sourceId: "sha256:source",
        sourceHash: "source",
        sourceName: "book.epub",
        sourceRelativePath,
      })).toThrow(/vault-relative/);
    }
    for (const path of [
      "../book.epub",
      "~/book.epub",
      "~user/book.epub",
      "bad\u0000book.epub",
      "file://book.epub",
    ]) {
      expect(() => SourceDocumentSchema.parse({
        schemaVersion: SchemaVersion,
        sourceId: "sha256:source",
        sourceHash: "source",
        sourceName: "book.epub",
        locator: { path },
      })).toThrow(/vault-relative/);
    }
    expect(() => SourceDocumentSchema.parse({
      schemaVersion: SchemaVersion,
      sourceId: "sha256:source",
      sourceHash: "source",
      sourceName: "book.epub",
      locator: { uri: "file:///tmp/book.epub" },
    })).toThrow();
    expect(() => GraphTextUnitIdentityMapSchema.parse({
      schemaVersion: SchemaVersion,
      bookId: "book-1",
      sourceId: "sha256:source",
      sourceHash: "source",
      documentId: "doc-1",
      contentHash: "content",
      normalizedPath: "/tmp/book.md",
      graphDocumentId: "graph-doc-1",
      graphTextUnitIds: ["tu-1"],
    })).toThrow(/vault-relative/);
  });

  test("accepts a graph enhancement request and capability", () => {
    const request = GraphEnhancementRequestSchema.parse({
      schemaVersion: SchemaVersion,
      requestId: "req-1",
      sourceId: "sha256:source",
      documentId: "doc-1",
      bookId: "book-1",
      contentHash: "sha256:content",
      graphVault: "graph_vault",
      normalizedInputPath: "input/book.md",
      methods: ["local"],
    });
    const capability = GraphCapabilitySchema.parse({
      schemaVersion: SchemaVersion,
      capabilityId: "cap-1",
      kind: "graph_query",
      bookId: request.bookId,
      sourceId: request.sourceId,
      documentId: request.documentId,
      contentHash: request.contentHash,
      ready: true,
      readinessSource: "validated_checkpoint_plus_validated_manifest",
      artifactIds: ["artifact-1"],
      createdAt: "2026-05-21T00:00:00.000Z",
    });

    expect(capability.kind).toBe("graph_query");
  });

  test("rejects non-portable graph enhancement input paths", () => {
    for (const normalizedInputPath of [
      "../input/book.md",
      "file://input/book.md",
      "~/input/book.md",
      "~user/input/book.md",
      "bad\u0000input/book.md",
      "C:/input/book.md",
    ]) {
      expect(() => GraphEnhancementRequestSchema.parse({
        schemaVersion: SchemaVersion,
        requestId: "req-1",
        sourceId: "sha256:source",
        documentId: "doc-1",
        bookId: "book-1",
        contentHash: "sha256:content",
        graphVault: "graph_vault",
        normalizedInputPath,
        methods: ["local"],
      })).toThrow(/vault-relative/);
    }
  });
});

describe("Unified query contracts", () => {
  test("accepts query route decisions with candidate decisions", () => {
    const request = UnifiedQueryRequestSchema.parse({
      schemaVersion: SchemaVersion,
      query: "How do these concepts relate across the book?",
      requestedRoute: "auto",
      maxCostClass: "medium",
    });
    const candidate = QmdRetrievalCandidateSchema.parse({
      candidateId: "cand-1",
      sourceId: "source-1",
      documentId: "doc-1",
      chunkId: "chunk-1",
      path: "qmd://books/book.md",
      retrievalScore: 0.9,
    });
    const decision = QueryRouteDecisionSchema.parse({
      requestedRoute: request.requestedRoute,
      selectedRoute: "graphrag",
      reasonCode: "graph_upgrade",
      intentClass: "graph_synthesis",
      costClass: "medium",
      maxCostClass: "medium",
      graphCoverage: 1,
      candidateDistribution: {
        totalCandidateCount: 1,
        graphReadyCandidateCount: 1,
        nonGraphReadyCandidateCount: 0,
      },
      selectedSourceIds: [candidate.sourceId],
      selectedDocumentIds: [candidate.documentId],
      selectedContentHashes: ["sha256:content"],
      selectedBookIds: ["book-1"],
      candidateEvidenceIds: [candidate.candidateId],
      graphCapabilityIds: ["cap-1"],
      graphArtifactIds: ["artifact-1"],
      candidateDecisions: [{
        candidateId: candidate.candidateId,
        sourceId: candidate.sourceId,
        documentId: candidate.documentId,
        bookId: "book-1",
        isGraphReady: true,
        retrievalScore: candidate.retrievalScore,
        rerankScore: null,
        selected: true,
        selectionReason: "selected_for_graph",
        refusalReason: null,
      }],
      refusalReasons: [],
    });

    expect(decision.selectedRoute).toBe("graphrag");
  });

  test("accepts a qmd query request", () => {
    const parsed = QmdQueryRequestSchema.parse({
      schemaVersion: SchemaVersion,
      query: "auth flow",
      searches: [{ type: "lex", query: "auth" }],
    });

    expect(parsed.searches?.[0]?.type).toBe("lex");
  });
});

describe("Provider contracts", () => {
  test("accepts Responses API stream request and response contracts", () => {
    const request = OpenAIResponsesRequestSchema.parse({
      model: "gpt-5.4",
      input: "answer with JSON",
      stream: true,
      reasoning: { effort: "medium" },
      text: {
        format: {
          name: "Answer",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["answer"],
            properties: {
              answer: { type: "string" },
            },
          },
        },
      },
    });
    const response = OpenAIResponsesResponseSchema.parse({
      id: "resp-1",
      model: "gpt-5.4",
      outputText: "{\"answer\":\"ok\"}",
    });

    expect(request.stream).toBe(true);
    expect(response.outputText).toContain("ok");
  });

  test("rejects non-stream Responses API requests", () => {
    expect(() =>
      OpenAIResponsesRequestSchema.parse({
        model: "gpt-5.4",
        input: "answer with JSON",
        stream: false,
      }),
    ).toThrow();
  });

  test("accepts plain Responses API stream requests without structured output", () => {
    const request = OpenAIResponsesRequestSchema.parse({
      model: "gpt-5.4",
      input: "answer in plain text",
      stream: true,
      reasoning: { effort: "medium" },
    });

    expect(request.text).toBeUndefined();
  });

  test("requires strict structured output provider config", () => {
    const parsed = OpenAIResponsesProviderConfigSchema.parse({
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrlEnv: "OPENAI_BASE_URL",
      endpoint: "/responses",
      stream: true,
      model: "gpt-5.4",
      strictStructuredOutput: true,
    });

    expect(parsed.strictStructuredOutput).toBe(true);
    expect(() =>
      OpenAIResponsesProviderConfigSchema.parse({
        apiKeyEnv: "openai-key",
        baseUrlEnv: "OPENAI_BASE_URL",
        endpoint: "/responses",
        stream: true,
        model: "gpt-5.4",
        strictStructuredOutput: true,
      }),
    ).toThrow();
    expect(() =>
      OpenAIResponsesProviderConfigSchema.parse({
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrlEnv: "OPENAI_BASE_URL",
        endpoint: "/responses",
        stream: true,
        model: "gpt-5.4",
      }),
    ).toThrow();
  });

  test("accepts Responses API response usage metadata", () => {
    const response = OpenAIResponsesResponseSchema.parse({
      id: "resp-1",
      model: "gpt-5.4",
      outputText: "ok",
      usage: {
        input_tokens: 10,
        output_tokens: 3,
      },
    });

    expect(response.usage?.input_tokens).toBe(10);
  });

  test("requires additionalProperties false for strict object schemas", () => {
    const parsed = OpenAIStructuredOutputSchemaSchema.parse({
      name: "Answer",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["answer"],
        properties: {
          answer: { type: "string" },
        },
      },
    });

    expect(parsed.schema.additionalProperties).toBe(false);
  });

  test("rejects non-strict object schemas", () => {
    expect(() =>
      OpenAIStructuredOutputSchemaSchema.parse({
        name: "Answer",
        strict: true,
        schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
          },
        },
      }),
    ).toThrow(/additionalProperties/);
  });

  test("requires additionalProperties false for nested strict object schemas", () => {
    const parsed = OpenAIStructuredOutputSchemaSchema.parse({
      name: "NestedAnswer",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title"],
              properties: {
                title: { type: "string" },
              },
            },
          },
        },
        $defs: {
          Finding: {
            type: "object",
            additionalProperties: false,
            required: ["summary"],
            properties: {
              summary: { type: "string" },
            },
          },
        },
      },
    });

    expect(parsed.schema.$defs?.Finding?.additionalProperties).toBe(false);
  });

  test("rejects nested strict object schemas without additionalProperties false", () => {
    expect(() =>
      OpenAIStructuredOutputSchemaSchema.parse({
        name: "NestedAnswer",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["items"],
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                required: ["title"],
                properties: {
                  title: { type: "string" },
                },
              },
            },
          },
          $defs: {
            Finding: {
              type: "object",
              required: ["summary"],
              properties: {
                summary: { type: "string" },
              },
            },
          },
        },
      }),
    ).toThrow(/additionalProperties/);
  });

  test("accepts provider cost accounting", () => {
    const parsed = ProviderCostAccountingSchema.parse({
      schemaVersion: SchemaVersion,
      sourceId: "source-1",
      documentId: "doc-1",
      bookId: "book-1",
      contentHash: "sha256:content",
      stage: "embed",
      provider: "jina",
      model: "jina-embeddings-v3",
      requestCount: 1,
      tokenCount: 0,
      tokenCountStatus: "unknown",
      embeddingCount: 10,
      embeddingCountStatus: "reported",
      lineageMode: "corpus_artifact",
      cacheHit: false,
      runId: "run-1",
      requestArtifactId: "request-artifact-1",
      artifactIds: ["request-artifact-1", "artifact-1"],
    });

    expect(parsed.provider).toBe("jina");
  });

  test("requires high-cost book artifacts to carry stage and provider fingerprints", () => {
    expect(() =>
      BookArtifactManifestSchema.parse({
        schemaVersion: SchemaVersion,
        artifactId: "artifact-1",
        bookId: "book-1",
        stage: "embed",
        kind: "lancedb_index",
        path: "books/book-1/output/lancedb",
        contentHash: "sha256:artifact",
        producerRunId: "run-1",
        createdAt: "2026-05-21T00:00:00.000Z",
      }),
    ).toThrow(/stageFingerprint/);
  });

  test("rejects home-relative book state paths", () => {
    for (const sourcePath of [
      "~/sources/book.epub",
      "~user/sources/book.epub",
      "bad\u0000sources/book.epub",
      "C:/sources/book.epub",
    ]) {
      expect(() =>
        BookJobSchema.parse({
          schemaVersion: SchemaVersion,
          bookId: "book-1",
          documentId: "doc-1",
          sourcePath,
          sourceHash: "sha256:source",
          configFingerprint: "config",
          promptFingerprint: "prompt",
          modelFingerprint: "model",
          overallStatus: "pending",
          createdAt: "2026-05-21T00:00:00.000Z",
          updatedAt: "2026-05-21T00:00:00.000Z",
        }),
      ).toThrow(/vault-relative/);
    }
    for (const path of [
      "~/books/book-1/normalized.md",
      "~user/books/book-1/normalized.md",
      "bad\u0000books/book-1/normalized.md",
      "file://books/book-1/normalized.md",
    ]) {
      expect(() =>
        BookArtifactManifestSchema.parse({
          schemaVersion: SchemaVersion,
          artifactId: "artifact-1",
          bookId: "book-1",
          stage: "normalize",
          kind: "normalized_markdown",
          path,
          contentHash: "sha256:artifact",
          producerRunId: "run-1",
          createdAt: "2026-05-21T00:00:00.000Z",
        }),
      ).toThrow(/vault-relative/);
    }
  });

  test("accepts redacted provider request fingerprints", () => {
    const parsed = ProviderRequestFingerprintSchema.parse({
      schemaVersion: SchemaVersion,
      artifactId: "request-artifact-1",
      kind: "provider_request_fingerprint",
      provider: "jina",
      stage: "rerank",
      model: "jina-reranker-v3",
      requestFingerprint: "sha256:request",
      createdAt: "2026-05-21T00:00:00.000Z",
      metadata: {
        inputCount: 3,
      },
    });

    expect(parsed.kind).toBe("provider_request_fingerprint");
  });
});

describe("Data bus contracts", () => {
  test("keeps Type DD payload ownership aligned with catalog inventory", async () => {
    const [typeDdRaw, catalogRaw] = await Promise.all([
      readFile(
        "docs/architecture/unified-retrieval-plane.type-dd.yaml",
        "utf8",
      ),
      readFile("catalog/data-bus.catalog.yaml", "utf8"),
    ]);
    const typeDd = YAML.parse(typeDdRaw) as TypeDdDocument;
    const catalog = YAML.parse(catalogRaw) as CatalogDocument;
    const typeDdPayloads = collectTypeDdPayloads(typeDd);

    for (const type of catalog.types) {
      const payload = typeDdPayloads.get(type.name);
      expect(payload, `${type.name} missing from Type DD`).toBeDefined();
      expect(payload?.schema).toBe(type.schema);
      expect(payload?.envelope).toBe(type.envelope);
      expect(payload?.producers ?? []).toEqual(type.producers);
      expect(payload?.consumers ?? []).toEqual(type.consumers);
    }

    for (const bus of catalog.buses) {
      const typeDdBus = typeDd.typed_buses[bus.name];
      expect(typeDdBus, `${bus.name} missing from Type DD`).toBeDefined();
      const payloadNames = [
        ...(typeDdBus?.payloads ?? []).map(payload => payload.name),
        ...(typeDdBus?.payload_refs ?? []),
      ];
      expect(new Set(payloadNames).size).toBe(payloadNames.length);
      expect([...payloadNames].sort()).toEqual([...bus.payloads].sort());
    }
  });

  test("keeps catalog envelopes covered by DataBusEnvelopeSchema", async () => {
    const [catalogRaw, busSource] = await Promise.all([
      readFile("catalog/data-bus.catalog.yaml", "utf8"),
      readFile("src/contracts/bus.ts", "utf8"),
    ]);
    const catalog = YAML.parse(catalogRaw) as CatalogDocument;
    const catalogEnvelopes = catalog.types
      .map(item => item.envelope.split("#")[1])
      .sort();

    expect(unionEnvelopeNames(busSource)).toEqual(catalogEnvelopes);
  });

  test("keeps declared producer and consumer symbols implemented", async () => {
    const [typeDdRaw, catalogRaw] = await Promise.all([
      readFile(
        "docs/architecture/unified-retrieval-plane.type-dd.yaml",
        "utf8",
      ),
      readFile("catalog/data-bus.catalog.yaml", "utf8"),
    ]);
    const typeDd = YAML.parse(typeDdRaw) as TypeDdDocument;
    const catalog = YAML.parse(catalogRaw) as CatalogDocument;
    const typeDdPayloads = collectTypeDdPayloads(typeDd);
    const refs = new Set<string>();

    for (const type of catalog.types) {
      for (const ref of [...type.producers, ...type.consumers]) {
        refs.add(ref);
      }
      const payload = typeDdPayloads.get(type.name);
      for (const ref of [
        ...(payload?.producers ?? []),
        ...(payload?.consumers ?? []),
      ]) {
        refs.add(ref);
      }
    }

    for (const ref of refs) {
      await expectLocalRefExists(ref);
    }
  });

  test("keeps Type DD contract exports aligned with SDK public exports", async () => {
    const typeDdRaw = await readFile(
      "docs/architecture/unified-retrieval-plane.type-dd.yaml",
      "utf8",
    );
    const typeDd = YAML.parse(typeDdRaw) as TypeDdDocument;
    const sdkExports = await import("../../src/index.js") as Record<string, unknown>;

    for (const [artifactName, artifact] of Object.entries(
      typeDd.contract_artifacts ?? {},
    )) {
      for (const exportName of artifact.exports) {
        expect(
          sdkExports,
          `${artifactName}.${exportName} missing from src/index.ts exports`,
        ).toHaveProperty(exportName);
      }
    }
  });

  test("keeps provider bus producer symbols tied to implemented projection", async () => {
    const [typeDdRaw, catalogRaw] = await Promise.all([
      readFile(
        "docs/architecture/unified-retrieval-plane.type-dd.yaml",
        "utf8",
      ),
      readFile("catalog/data-bus.catalog.yaml", "utf8"),
    ]);
    const typeDd = YAML.parse(typeDdRaw) as TypeDdDocument;
    const catalog = YAML.parse(catalogRaw) as CatalogDocument;
    const typeDdPayload =
      typeDd.typed_buses.provider_bus.payloads?.find(
        item => item.name === "openai_responses_provider_config",
      );
    const catalogType = catalog.types.find(
      item => item.name === "openai_responses_provider_config",
    );
    const expectedProducer =
      "src/graphrag/settings-projection.ts#buildGraphRagRuntimeSettingsProjection";

    expect(typeDdPayload?.producers).toContain(expectedProducer);
    expect(typeDdPayload?.producers).not.toContain(
      "src/graphrag/settings-projection.ts#projectGraphRagSettings",
    );
    expect(catalogType?.producers).toContain(expectedProducer);
    const projectionModule = await import(
      "../../src/graphrag/settings-projection.js"
    ) as Record<string, unknown>;
    expect(
      typeof projectionModule.buildGraphRagRuntimeSettingsProjection,
    ).toBe("function");
  });

  test("keeps route contract required fields aligned with Zod schemas", async () => {
    const typeDdRaw = await readFile(
      "docs/architecture/unified-retrieval-plane.type-dd.yaml",
      "utf8",
    );
    const { route_contracts: contracts } =
      YAML.parse(typeDdRaw) as TypeDdDocument;

    expect(contracts.unified_query_request.required_fields).toEqual([
      "schemaVersion",
      "query",
      "requestedRoute",
    ]);
    expect(Object.keys(UnifiedQueryRequestSchema.shape)).toEqual(
      expect.arrayContaining(contracts.unified_query_request.required_fields),
    );
    expect(contracts.qmd_search_result.required_fields).toEqual([
      "schemaVersion",
      "query",
      "results",
    ]);
    expect(Object.keys(QmdSearchResultSchema.shape)).toEqual(
      expect.arrayContaining(contracts.qmd_search_result.required_fields),
    );
    expect(contracts.graphrag_query_response.required_fields).toEqual([
      "schemaVersion",
      "method",
      "responseText",
      "evidence",
    ]);
    expect(Object.keys(GraphRagQueryResponseSchema.shape)).toEqual(
      expect.arrayContaining(contracts.graphrag_query_response.required_fields),
    );
    expect(contracts.unified_answer.required_fields).toEqual([
      "schemaVersion",
      "query",
      "routeDecision",
      "answerText",
      "evidence",
    ]);
    expect(Object.keys(UnifiedAnswerSchema.shape)).toEqual(
      expect.arrayContaining(contracts.unified_answer.required_fields),
    );
    expect(contracts.graph_capability_error.required_fields).toEqual([
      "schemaVersion",
      "route",
      "provider",
      "capability",
      "code",
      "retryable",
      "queriedScope",
      "sourceId",
      "documentId",
      "bookId",
      "redactedMessage",
    ]);
    expect(Object.keys(GraphCapabilityErrorSchema.shape)).toEqual(
      expect.arrayContaining(contracts.graph_capability_error.required_fields),
    );
    expect(contracts.typed_query_error.required_fields).toEqual([
      "schemaVersion",
      "route",
      "stage",
      "provider",
      "capability",
      "code",
      "retryable",
      "redactedMessage",
    ]);
    expect(Object.keys(TypedQueryErrorSchema.shape)).toEqual(
      expect.arrayContaining(contracts.typed_query_error.required_fields),
    );
  });

  test("accepts unified query request envelopes", () => {
    const parsed = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "unified_query.request",
      payload: {
        schemaVersion: SchemaVersion,
        query: "How do concepts relate across the book?",
        requestedRoute: "auto",
        maxCostClass: "medium",
      },
    });

    expect(parsed.kind).toBe("unified_query.request");
  });

  test("accepts Jina embedding request envelopes", () => {
    const parsed = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "provider.jina.embedding_request",
      payload: {
        model: "jina-embeddings-v3",
        input: ["typed data bus"],
      },
    });

    expect(parsed.kind).toBe("provider.jina.embedding_request");
  });

  test("accepts Jina response and rerank provider envelopes", () => {
    const embeddingResponse = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "provider.jina.embedding_response",
      payload: {
        model: "jina-embeddings-v3",
        data: [{
          index: 0,
          embedding: [0.1, 0.2],
        }],
      },
    });
    const rerankRequest = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "provider.jina.rerank_request",
      payload: {
        model: "jina-reranker-v3",
        query: "auth",
        documents: ["set AUTH_SECRET"],
      },
    });
    const rerankResponse = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "provider.jina.rerank_response",
      payload: {
        model: "jina-reranker-v3",
        results: [{
          index: 0,
          relevance_score: 0.9,
        }],
      },
    });

    expect(embeddingResponse.kind).toBe("provider.jina.embedding_response");
    expect(rerankRequest.kind).toBe("provider.jina.rerank_request");
    expect(rerankResponse.kind).toBe("provider.jina.rerank_response");
  });

  test("accepts provider request fingerprint envelopes", () => {
    const parsed = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "provider.request_fingerprint",
      payload: {
        schemaVersion: SchemaVersion,
        artifactId: "request-artifact-1",
        kind: "provider_request_fingerprint",
        provider: "jina",
        stage: "embed",
        model: "jina-embeddings-v3",
        requestFingerprint: "sha256:request",
        createdAt: "2026-05-21T00:00:00.000Z",
      },
    });

    expect(parsed.kind).toBe("provider.request_fingerprint");
  });

  test("accepts OpenAI Responses and provider cost envelopes", () => {
    const request = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "provider.openai_responses.request",
      payload: {
        model: "gpt-5.4",
        input: "answer in JSON",
        stream: true,
        reasoning: { effort: "medium" },
      },
    });
    const response = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "provider.openai_responses.response",
      payload: {
        id: "resp-1",
        model: "gpt-5.4",
        outputText: "ok",
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    });
    const streamEvent = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "provider.openai_responses.stream_event",
      payload: {
        type: "response.output_text.delta",
        sequence: 0,
        textDelta: "ok",
        responseId: "resp-1",
      },
    });
    const structuredOutput = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "provider.openai_responses.structured_output_schema",
      payload: {
        name: "Answer",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["answer"],
          properties: {
            answer: { type: "string" },
          },
        },
      },
    });
    const cost = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "provider.cost_accounting",
      payload: {
        schemaVersion: SchemaVersion,
        sourceId: null,
        documentId: null,
        bookId: null,
        contentHash: null,
        lineageMode: "transient_query",
        stage: "graphrag_query",
        provider: "graphrag",
        model: "local",
        requestCount: 1,
        tokenCount: 0,
        tokenCountStatus: "unknown",
        embeddingCount: 0,
        embeddingCountStatus: "unknown",
        cacheHit: false,
        runId: "run-1",
        requestArtifactId: "request-artifact-1",
        artifactIds: ["request-artifact-1"],
      },
    });

    expect(request.kind).toBe("provider.openai_responses.request");
    expect(response.kind).toBe("provider.openai_responses.response");
    expect(streamEvent.kind).toBe("provider.openai_responses.stream_event");
    expect(structuredOutput.kind).toBe(
      "provider.openai_responses.structured_output_schema",
    );
    expect(cost.kind).toBe("provider.cost_accounting");
  });

  test("accepts vault restore envelopes", () => {
    const request = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "vault.restore_request",
      payload: {
        schemaVersion: SchemaVersion,
        graphVault: "graph_vault",
        mode: "audit",
      },
    });
    const report = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "vault.restore_report",
      payload: {
        schemaVersion: SchemaVersion,
        graphVault: "graph_vault",
        mode: "audit",
        portable: true,
        documentsPortable: true,
        capabilitiesPortable: true,
        sourceDocumentCount: 1,
        documentIdentityCount: 1,
        graphCapabilityCount: 1,
        restoredDocumentCount: 0,
        restoredCapabilityCount: 0,
        restoredCapabilityIds: ["cap-1"],
        failedItems: [],
        missingRequiredPaths: [],
      },
    });

    expect(request.kind).toBe("vault.restore_request");
    expect(report.kind).toBe("vault.restore_report");
  });

  test("accepts route decision and GraphRAG response envelopes", () => {
    const candidateDecision = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "unified_query.candidate_route_decision",
      payload: {
        candidateId: "cand-1",
        sourceId: "source-1",
        documentId: "doc-1",
        bookId: "book-1",
        isGraphReady: true,
        retrievalScore: 0.9,
        rerankScore: null,
        selected: true,
        selectionReason: "selected_for_graph",
        refusalReason: null,
      },
    });
    const queryResponse = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "graphrag.query_response",
      payload: {
        schemaVersion: SchemaVersion,
        method: "local",
        responseText: "Graph answer",
        evidence: [{
          evidenceId: "cap-1",
          graphCapabilityId: "cap-1",
          sourceId: "sha256:source",
          documentId: "doc-1",
          bookId: "book-1",
          contentHash: "sha256:content",
          graphTextUnitId: "tu-1",
          artifactId: "cap-1",
        }],
      },
    });
    const graphEvidence = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "graphrag.evidence",
      payload: {
        evidenceId: "cap-1",
        graphCapabilityId: "cap-1",
        sourceId: "sha256:source",
        documentId: "doc-1",
        bookId: "book-1",
        contentHash: "sha256:content",
        graphTextUnitId: "tu-1",
        artifactId: "cap-1",
      },
    });
    const indexResponse = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "graphrag.index_response",
      payload: {
        schemaVersion: SchemaVersion,
        method: "standard",
        outputs: [{
          workflow: "generate_text_embeddings",
          hasError: false,
          stateKeys: [],
        }],
      },
    });

    expect(candidateDecision.kind).toBe(
      "unified_query.candidate_route_decision",
    );
    expect(queryResponse.kind).toBe("graphrag.query_response");
    expect(graphEvidence.kind).toBe("graphrag.evidence");
    expect(indexResponse.kind).toBe("graphrag.index_response");
  });

  test("accepts DSPy and book state envelopes", () => {
    const optimizedPrompt = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "dspy.optimized_query_prompt_artifact",
      payload: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["python", "dspy_gepa.py"],
        savedPromptPath: "finetune/prompts/query.txt",
        stdoutTail: [],
      },
    });
    const generatedRecord = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "dspy.generated_expansion_record",
      payload: {
        query: "software design",
        output: [{ type: "lex", text: "software design" }],
      },
    });
    const bookJob = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "book.job",
      payload: {
        schemaVersion: SchemaVersion,
        bookId: "book-1",
        documentId: "doc-1",
        sourcePath: "sources/book/source.epub",
        sourceHash: "sha256:source",
        normalizedContentHash: "sha256:content",
        configFingerprint: "config",
        promptFingerprint: "prompt",
        modelFingerprint: "model",
        stageFingerprints: {
          normalize: "stage-normalize",
          graph_extract: "stage-graph-extract",
        },
        providerFingerprint: "provider-openai-responses-jina",
        overallStatus: "succeeded",
        createdAt: "2026-05-21T00:00:00.000Z",
        updatedAt: "2026-05-21T00:00:00.000Z",
      },
    });
    const checkpoint = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "book.stage_checkpoint",
      payload: {
        schemaVersion: SchemaVersion,
        bookId: "book-1",
        stage: "query_ready",
        status: "succeeded",
        attemptCount: 1,
        inputFingerprint: "input",
        contentHash: "sha256:content",
        stageFingerprint: "stage-query-ready",
        providerFingerprint: "provider-openai-responses-jina",
        artifactIds: ["artifact-1"],
      },
    });
    const artifact = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "book.artifact_manifest",
      payload: {
        schemaVersion: SchemaVersion,
        artifactId: "artifact-1",
        bookId: "book-1",
        stage: "query_ready",
        kind: "query_snapshot",
        path: "books/book-1/artifacts.yaml",
        contentHash: "sha256:artifact",
        stageFingerprint: "stage-query-ready",
        providerFingerprint: "provider-openai-responses-jina",
        producerRunId: "run-1",
        createdAt: "2026-05-21T00:00:00.000Z",
      },
    });
    const runRecord = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "book.run_record",
      payload: {
        schemaVersion: SchemaVersion,
        runId: "run-1",
        bookId: "book-1",
        stage: "query_ready",
        status: "succeeded",
        attemptCount: 1,
        startedAt: "2026-05-21T00:00:00.000Z",
        inputFingerprint: "input",
        artifactIds: ["artifact-1"],
      },
    });
    const resumePlan = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "book.resume_plan",
      payload: {
        schemaVersion: SchemaVersion,
        bookId: "book-1",
        nextStage: null,
        canQuery: true,
        staleStages: [],
        completedStages: ["query_ready"],
        stageStates: [{
          stage: "query_ready",
          checkpointStatus: "succeeded",
          isSatisfied: true,
          reason: "ready",
        }],
      },
    });

    expect(optimizedPrompt.kind).toBe("dspy.optimized_query_prompt_artifact");
    expect(generatedRecord.kind).toBe("dspy.generated_expansion_record");
    expect(bookJob.kind).toBe("book.job");
    expect(checkpoint.kind).toBe("book.stage_checkpoint");
    expect(artifact.kind).toBe("book.artifact_manifest");
    expect(runRecord.kind).toBe("book.run_record");
    expect(resumePlan.kind).toBe("book.resume_plan");
  });

  test("accepts shared catalog and list envelopes", () => {
    const bookCatalog = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "book.job_catalog",
      payload: {
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          bookId: "book-1",
          documentId: "doc-1",
          sourcePath: "sources/book/source.epub",
          sourceHash: "sha256:source",
          normalizedContentHash: "sha256:content",
          configFingerprint: "config",
          promptFingerprint: "prompt",
          modelFingerprint: "model",
          stageFingerprints: {
            normalize: "stage-normalize",
            graph_extract: "stage-graph-extract",
          },
          providerFingerprint: "provider-openai-responses-jina",
          overallStatus: "succeeded",
          createdAt: "2026-05-21T00:00:00.000Z",
          updatedAt: "2026-05-21T00:00:00.000Z",
        }],
      },
    });
    const checkpointList = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "book.stage_checkpoint_list",
      payload: {
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          bookId: "book-1",
          stage: "query_ready",
          status: "succeeded",
          attemptCount: 1,
          inputFingerprint: "input",
          contentHash: "sha256:content",
          stageFingerprint: "stage-query-ready",
          providerFingerprint: "provider-openai-responses-jina",
          artifactIds: ["artifact-1"],
        }],
      },
    });
    const artifactList = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "book.artifact_manifest_list",
      payload: {
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          artifactId: "artifact-1",
          bookId: "book-1",
          stage: "query_ready",
          kind: "query_snapshot",
          path: "books/book-1/artifacts.yaml",
          contentHash: "sha256:artifact",
          stageFingerprint: "stage-query-ready",
          providerFingerprint: "provider-openai-responses-jina",
          producerRunId: "run-1",
          createdAt: "2026-05-21T00:00:00.000Z",
        }],
      },
    });
    const runCatalog = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "book.run_catalog",
      payload: {
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          runId: "run-1",
          bookId: "book-1",
          stage: "query_ready",
          status: "succeeded",
          startedAt: "2026-05-21T00:00:00.000Z",
        }],
      },
    });
    const runRecord = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "book.run_record",
      payload: {
        schemaVersion: SchemaVersion,
        runId: "run-1",
        bookId: "book-1",
        stage: "query_ready",
        status: "succeeded",
        attemptCount: 1,
        startedAt: "2026-05-21T00:00:00.000Z",
        inputFingerprint: "input",
        artifactIds: ["artifact-1"],
      },
    });
    const parsedRunRecord = BookJobRunRecordEnvelopeSchema.parse(runRecord);
    const capabilityCatalog = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "graph_enhancement.capability_catalog",
      payload: {
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          capabilityId: "cap-1",
          kind: "graph_query",
          bookId: "book-1",
          sourceId: "sha256:source",
          documentId: "doc-1",
          contentHash: "sha256:content",
          ready: true,
          readinessSource: "validated_checkpoint_plus_validated_manifest",
          artifactIds: ["artifact-1"],
          createdAt: "2026-05-21T00:00:00.000Z",
        }],
      },
    });

    expect(bookCatalog.kind).toBe("book.job_catalog");
    expect(checkpointList.kind).toBe("book.stage_checkpoint_list");
    expect(artifactList.kind).toBe("book.artifact_manifest_list");
    expect(runCatalog.kind).toBe("book.run_catalog");
    expect(parsedRunRecord.kind).toBe("book.run_record");
    expect(capabilityCatalog.kind).toBe("graph_enhancement.capability_catalog");
  });

  test("accepts corpus, qmd, graph, provider, and vault envelopes", () => {
    const source = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "corpus.source_document",
      payload: {
        schemaVersion: SchemaVersion,
        sourceId: "sha256:source",
        sourceHash: "source",
        sourceName: "book.epub",
      },
    });
    const sourceCatalog = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "corpus.source_document_catalog",
      payload: {
        schemaVersion: SchemaVersion,
        items: [source.payload],
      },
    });
    const graphTextUnitIdentity = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "corpus.graph_text_unit_identity_map",
      payload: {
        schemaVersion: SchemaVersion,
        bookId: "book-1",
        sourceId: "sha256:source",
        sourceHash: "source",
        documentId: "doc-1",
        contentHash: "sha256:content",
        normalizedPath: "input/book.md",
        graphDocumentId: "graph-doc-1",
        graphTextUnitIds: ["tu-1"],
      },
    });
    const qmdRequest = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "qmd.query.request",
      payload: {
        schemaVersion: SchemaVersion,
        query: "typed retrieval",
      },
    });
    const qmdCandidate = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "qmd.retrieval.candidate",
      payload: {
        candidateId: "cand-1",
        sourceId: "sha256:source",
        documentId: "doc-1",
        chunkId: "chunk-1",
        path: "qmd://books/book.md",
        retrievalScore: 0.9,
      },
    });
    const graphState = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "graph_enhancement.state",
      payload: {
        schemaVersion: SchemaVersion,
        bookId: "book-1",
        sourceId: "sha256:source",
        documentId: "doc-1",
        contentHash: "sha256:content",
        status: "succeeded",
        checkpointIds: ["checkpoint-1"],
        artifactIds: ["artifact-1"],
        capabilityIds: ["cap-1"],
        updatedAt: "2026-05-21T00:00:00.000Z",
      },
    });
    const providerConfig = DataBusEnvelopeSchema.parse({
      schemaVersion: SchemaVersion,
      kind: "provider.openai_responses.config",
      payload: {
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrlEnv: "OPENAI_BASE_URL",
        endpoint: "/responses",
        stream: true,
        model: "gpt-5.4",
        reasoningEffort: "medium",
        strictStructuredOutput: true,
      },
    });

    expect(sourceCatalog.kind).toBe("corpus.source_document_catalog");
    expect(graphTextUnitIdentity.kind).toBe("corpus.graph_text_unit_identity_map");
    expect(qmdRequest.kind).toBe("qmd.query.request");
    expect(qmdCandidate.kind).toBe("qmd.retrieval.candidate");
    expect(graphState.kind).toBe("graph_enhancement.state");
    expect(providerConfig.kind).toBe("provider.openai_responses.config");
  });

  test("rejects envelopes with unknown kind", () => {
    expect(() =>
      DataBusEnvelopeSchema.parse({
        schemaVersion: SchemaVersion,
        kind: "unknown.payload",
        payload: {},
      }),
    ).toThrow();
  });

  test("rejects envelopes without payload", () => {
    expect(() =>
      DataBusEnvelopeSchema.parse({
        schemaVersion: SchemaVersion,
        kind: "unified_query.request",
      }),
    ).toThrow();
  });
});

describe("Vault contracts", () => {
  test("accepts restore request and report contracts", () => {
    const request = VaultRestoreRequestSchema.parse({
      schemaVersion: SchemaVersion,
      graphVault: "graph_vault",
    });
    const report = VaultRestoreReportSchema.parse({
      schemaVersion: SchemaVersion,
      graphVault: "graph_vault",
      mode: "audit",
      portable: false,
      documentsPortable: false,
      capabilitiesPortable: false,
      sourceDocumentCount: 0,
      documentIdentityCount: 0,
      graphCapabilityCount: 0,
      restoredDocumentCount: 0,
      restoredCapabilityCount: 0,
      restoredCapabilityIds: [],
      failedItems: [],
      missingRequiredPaths: ["catalog/sources.yaml"],
    });

    expect(request.mode).toBe("audit");
    expect(report.missingRequiredPaths).toContain("catalog/sources.yaml");
  });

  test("rejects malformed restore reports", () => {
    expect(() =>
      VaultRestoreReportSchema.parse({
        schemaVersion: SchemaVersion,
        graphVault: "graph_vault",
        mode: "copy",
        portable: true,
        documentsPortable: true,
        capabilitiesPortable: true,
        restoredDocumentCount: 0,
        restoredCapabilityCount: 0,
        restoredCapabilityIds: [],
        failedItems: [],
        missingRequiredPaths: [],
      }),
    ).toThrow();
  });

  test("reports missing portable vault paths during restore audit", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-vault-restore-"));
    const report = await restoreFromVault({
      schemaVersion: SchemaVersion,
      graphVault,
      mode: "restore",
    });

    expect(report.mode).toBe("restore");
    expect(report.portable).toBe(false);
    expect(report.documentsPortable).toBe(false);
    expect(report.capabilitiesPortable).toBe(true);
    expect(report.missingRequiredPaths).toContain("input");
    expect(report.missingRequiredPaths).toContain("catalog/sources.yaml");
    expect(report.missingRequiredPaths).toContain(
      "catalog/document-identity-map.yaml",
    );
  });

  test("reports portable vault counts from typed catalogs", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-vault-portable-"));
    await mkdir(join(graphVault, "input"), { recursive: true });
    await mkdir(join(graphVault, "catalog"), { recursive: true });
    await writeFile(join(graphVault, "catalog", "sources.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: sha256:source
    sourceName: book.epub
    sourceRelativePath: sources/book.epub
    mediaType: application/epub+zip
    sizeBytes: 12
`);
    await writeFile(
      join(graphVault, "catalog", "document-identity-map.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: sha256:source
    documentId: book-123
    canonicalBookId: book-123
    contentHash: sha256:content
    normalizationPolicyVersion: v1
    chunkIds: []
    metadata:
      normalizedPath: input/book.md
`,
    );

    const report = await restoreFromVault({
      schemaVersion: SchemaVersion,
      graphVault,
      mode: "audit",
    });

    expect(report.portable).toBe(true);
    expect(report.documentsPortable).toBe(true);
    expect(report.capabilitiesPortable).toBe(true);
    expect(report.sourceDocumentCount).toBe(1);
    expect(report.documentIdentityCount).toBe(1);
    expect(report.restoredDocumentCount).toBe(0);
    expect(report.restoredCapabilityCount).toBe(0);
    expect(report.missingRequiredPaths).toEqual([]);
    const auditRaw = await readFile(
      join(graphVault, "catalog", "restore-audits.jsonl"),
      "utf8",
    );
    const audit = JSON.parse(auditRaw.trim()) as { graphVault: string; mode: string };
    expect(audit.graphVault).toBe(".");
    expect(audit.mode).toBe("audit");
  });

  test("does not report graph-capable vault portable without book state", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-vault-capability-audit-"));
    await mkdir(join(graphVault, "input"), { recursive: true });
    await mkdir(join(graphVault, "catalog"), { recursive: true });
    await writeFile(join(graphVault, "catalog", "sources.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: source
    sourceName: book.epub
    sourceRelativePath: sources/book.epub
`);
    await writeFile(
      join(graphVault, "catalog", "document-identity-map.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: source
    documentId: book-123
    canonicalBookId: book-123
    contentHash: sha256:content
    normalizationPolicyVersion: v1
    chunkIds: []
    graphDocumentId: graph-doc-123
    graphTextUnitIds:
      - tu-123
    metadata:
      normalizedPath: input/book.md
`,
    );

    const report = await restoreFromVault({
      schemaVersion: SchemaVersion,
      graphVault,
      mode: "audit",
    });

    expect(report.documentsPortable).toBe(true);
    expect(report.capabilitiesPortable).toBe(false);
    expect(report.portable).toBe(false);
    expect(report.missingRequiredPaths).toEqual(
      expect.arrayContaining([
        "catalog/books.yaml",
        "books/book-123/checkpoints.yaml",
        "books/book-123/artifacts.yaml",
        "catalog/graph-capabilities.yaml",
      ]),
    );
  });

  test("restore audit rejects invalid raw graph capability catalog entries", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-vault-raw-cap-audit-"));
    await mkdir(join(graphVault, "input"), { recursive: true });
    await mkdir(join(graphVault, "catalog"), { recursive: true });
    await writeFile(
      join(graphVault, "input", "book.md"),
      "# Test Book\n\nGraphRAG restore smoke content.",
      "utf8",
    );
    const contentHash =
      "bab48ae75ad984bfbe8e92a34d2255c36a79e5b3bbfe92b5ef6716c660982f88";
    await writeFile(join(graphVault, "catalog", "sources.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: source
    sourceName: book.epub
    sourceRelativePath: sources/book/source.epub
`);
    await writeFile(join(graphVault, "catalog", "books.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: book-123
    documentId: book-123
    sourcePath: sources/book/source.epub
    sourceHash: source
    normalizedContentHash: ${contentHash}
    normalizedPath: input/book.md
    configFingerprint: cfg
    promptFingerprint: prompt
    modelFingerprint: model
    currentStage: query_ready
    overallStatus: succeeded
    createdAt: 2026-05-21T00:00:00.000Z
    updatedAt: 2026-05-21T00:00:00.000Z
`);
    const lancedbPath = join(graphVault, "books", "book-123", "output", "lancedb");
    await writeCompleteLanceDbFixture(lancedbPath);
    await mkdir(join(graphVault, "books", "book-123", "output"), {
      recursive: true,
    });
    await writeFile(
      join(graphVault, "books", "book-123", "output", "community_reports.parquet"),
      "reports",
      "utf8",
    );
    const reportHash = await hashFile(
      join(graphVault, "books", "book-123", "output", "community_reports.parquet"),
    );
    const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);
    await writeFile(join(graphVault, "books", "book-123", "checkpoints.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: book-123
    stage: query_ready
    status: succeeded
    attemptCount: 1
    inputFingerprint: fp
    contentHash: ${contentHash}
    stageFingerprint: stage-query-ready
    providerFingerprint: provider-openai-responses-jina
    artifactIds:
      - artifact-1
      - artifact-2
    finishedAt: 2026-05-21T00:00:00.000Z
`);
    await writeFile(join(graphVault, "books", "book-123", "artifacts.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-1
    bookId: book-123
    stage: community_report
    kind: graphrag_community_reports_parquet
    path: books/book-123/output/community_reports.parquet
    contentHash: ${reportHash}
    stageFingerprint: stage-community-report
    providerFingerprint: provider-openai-responses-jina
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-2
    bookId: book-123
    stage: embed
    kind: lancedb_index
    path: books/book-123/output/lancedb
    contentHash: ${lancedbHash}
    producerRunId: run-2
    createdAt: 2026-05-21T00:00:00.000Z
`);
    await writeFile(join(graphVault, "catalog", "document-identity-map.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: source
    documentId: book-123
    canonicalBookId: book-123
    contentHash: ${contentHash}
    normalizationPolicyVersion: v1
    normalizedPath: input/book.md
    chunkIds: []
    graphDocumentId: graph-doc-123
    graphTextUnitIds:
      - tu-123
`);
    await writeFile(join(graphVault, "catalog", "graph-capabilities.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    capabilityId: book-123:graph_query
    kind: graph_query
    bookId: book-123
    sourceId: sha256:source
    documentId: book-123
    contentHash: ${contentHash}
    ready: true
    readinessSource: validated_checkpoint_plus_validated_manifest
    artifactIds:
      - artifact-1
      - artifact-2
    createdAt: 2026-05-21T00:00:00.000Z
`);

    const report = await restoreFromVault({
      schemaVersion: SchemaVersion,
      graphVault,
      mode: "audit",
    });

    expect(report.documentsPortable).toBe(true);
    expect(report.capabilitiesPortable).toBe(false);
    expect(report.portable).toBe(false);
    expect(report.graphCapabilityCount).toBe(1);
    expect(report.failedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "book-123:graph_query",
          stage: "audit_capability",
        }),
      ]),
    );
  });

  test("restores qmd index and capability mirror from graph vault catalogs", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-vault-restore-ok-"));
    const targetIndexPath = join(graphVault, "restored.sqlite");
    const normalizedContent = "# Test Book\n\nGraphRAG restore smoke content.";
    const contentHash = await hashContent(normalizedContent, "v1");
    await mkdir(join(graphVault, "input"), { recursive: true });
    await mkdir(join(graphVault, "catalog"), { recursive: true });
    await writeFile(
      join(graphVault, "catalog", "books.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: book-123
    documentId: book-123
    sourcePath: sources/book/source.epub
    sourceHash: source
    normalizedContentHash: ${contentHash}
    normalizedPath: input/book.md
    configFingerprint: cfg
    promptFingerprint: prompt
    modelFingerprint: model
    currentStage: query_ready
    overallStatus: succeeded
    createdAt: 2026-05-21T00:00:00.000Z
    updatedAt: 2026-05-21T00:00:00.000Z
`,
    );
    await writeFile(
      join(graphVault, "input", "book.md"),
      normalizedContent,
      "utf8",
    );
    const lancedbPath = join(graphVault, "books", "book-123", "output", "lancedb");
    await writeCompleteLanceDbFixture(lancedbPath);
    await writeFile(
      join(graphVault, "books", "book-123", "output", "community_reports.parquet"),
      "reports",
      "utf8",
    );
    const reportHash = await hashFile(
      join(graphVault, "books", "book-123", "output", "community_reports.parquet"),
    );
    const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);
    await writeFile(
      join(graphVault, "books", "book-123", "checkpoints.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: book-123
    stage: query_ready
    status: succeeded
    attemptCount: 1
    inputFingerprint: fp
    contentHash: ${contentHash}
    stageFingerprint: stage-query-ready
    providerFingerprint: provider-openai-responses-jina
    artifactIds:
      - artifact-1
      - artifact-2
    finishedAt: 2026-05-21T00:00:00.000Z
`,
      "utf8",
    );
    await writeFile(
      join(graphVault, "books", "book-123", "artifacts.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-1
    bookId: book-123
    stage: community_report
    kind: graphrag_community_reports_parquet
    path: books/book-123/output/community_reports.parquet
    contentHash: ${reportHash}
    stageFingerprint: stage-community-report
    providerFingerprint: provider-openai-responses-jina
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-2
    bookId: book-123
    stage: embed
    kind: lancedb_index
    path: books/book-123/output/lancedb
    contentHash: ${lancedbHash}
    stageFingerprint: stage-embed
    providerFingerprint: provider-openai-responses-jina
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
`,
      "utf8",
    );
    await writeFile(join(graphVault, "catalog", "sources.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: source
    sourceName: book.epub
    sourceRelativePath: sources/book/source.epub
`);
    await writeFile(
      join(graphVault, "catalog", "document-identity-map.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: source
    documentId: book-123
    canonicalBookId: book-123
    contentHash: ${contentHash}
    normalizationPolicyVersion: v1
    chunkIds: []
    graphDocumentId: graph-doc-123
    graphTextUnitIds:
      - tu-123
    metadata:
      normalizedPath: input/book.md
      qmdCorpusRegistered: true
`,
    );
    await writeFile(
      join(graphVault, "catalog", "graph-capabilities.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    capabilityId: book-123:graph_query
    kind: graph_query
    bookId: book-123
    sourceId: sha256:source
    documentId: book-123
    contentHash: ${contentHash}
    ready: true
    readinessSource: validated_checkpoint_plus_validated_manifest
    artifactIds:
      - artifact-1
      - artifact-2
    createdAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    capabilityId: book-123:local_search
    kind: local_search
    method: local
    bookId: book-123
    sourceId: sha256:source
    documentId: book-123
    contentHash: ${contentHash}
    ready: true
    readinessSource: validated_checkpoint_plus_validated_manifest
    artifactIds:
      - artifact-1
      - artifact-2
    createdAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    capabilityId: book-123:global_search
    kind: global_search
    method: global
    bookId: book-123
    sourceId: sha256:source
    documentId: book-123
    contentHash: ${contentHash}
    ready: true
    readinessSource: validated_checkpoint_plus_validated_manifest
    artifactIds:
      - artifact-1
      - artifact-2
    createdAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    capabilityId: book-123:drift_search
    kind: drift_search
    method: drift
    bookId: book-123
    sourceId: sha256:source
    documentId: book-123
    contentHash: ${contentHash}
    ready: true
    readinessSource: validated_checkpoint_plus_validated_manifest
    artifactIds:
      - artifact-1
      - artifact-2
    createdAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    capabilityId: book-123:community_reports
    kind: community_reports
    bookId: book-123
    sourceId: sha256:source
    documentId: book-123
    contentHash: ${contentHash}
    ready: true
    readinessSource: validated_checkpoint_plus_validated_manifest
    artifactIds:
      - artifact-1
      - artifact-2
    createdAt: 2026-05-21T00:00:00.000Z
`,
    );

    const report = await restoreFromVault({
      schemaVersion: SchemaVersion,
      graphVault,
      targetIndexPath,
      mode: "restore",
    });

    expect(report.portable).toBe(true);
    expect(report.documentsPortable).toBe(true);
    expect(report.capabilitiesPortable).toBe(true);
    expect(report.restoredDocumentCount).toBe(1);
    expect(report.restoredCapabilityCount).toBe(5);
    expect(report.failedItems).toEqual([]);

    const restoredStore = createStore(targetIndexPath);
    try {
      const document = restoredStore.db.prepare(
        "SELECT hash FROM documents WHERE collection = 'books' AND path = 'book.md'",
      ).get() as { hash: string } | undefined;
      const capabilities = restoredStore.db.prepare(`
        SELECT capability_id, content_hash
        FROM qmd_graph_capabilities
        ORDER BY capability_id
      `).all() as Array<{ capability_id: string; content_hash: string }>;

      expect(document?.hash).toBe(contentHash);
      expect(capabilities.map((item) => item.capability_id)).toEqual([
        "book-123:community_reports",
        "book-123:drift_search",
        "book-123:global_search",
        "book-123:graph_query",
        "book-123:local_search",
      ]);
      expect(capabilities.every((item) => item.content_hash === contentHash)).toBe(true);
    } finally {
      restoredStore.close();
    }
  });

  test("rejects restore when normalized content hash differs from identity map", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-vault-restore-bad-hash-"));
    const targetIndexPath = join(graphVault, "restored.sqlite");
    await mkdir(join(graphVault, "input"), { recursive: true });
    await mkdir(join(graphVault, "catalog"), { recursive: true });
    await writeFile(
      join(graphVault, "input", "book.md"),
      "# Test Book\n\nChanged restore content.",
      "utf8",
    );
    await writeFile(join(graphVault, "catalog", "sources.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: source
    sourceName: book.epub
`);
    await writeFile(
      join(graphVault, "catalog", "document-identity-map.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: source
    documentId: book-123
    canonicalBookId: book-123
    contentHash: expected-content-hash
    normalizationPolicyVersion: v1
    chunkIds: []
    metadata:
      normalizedPath: input/book.md
`,
    );
    await writeFile(
      join(graphVault, "catalog", "graph-capabilities.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    capabilityId: book-123:graph_query
    kind: graph_query
    bookId: book-123
    sourceId: sha256:source
    documentId: book-123
    contentHash: expected-content-hash
    ready: true
    readinessSource: validated_checkpoint_plus_validated_manifest
    artifactIds:
      - artifact-1
    createdAt: 2026-05-21T00:00:00.000Z
`,
    );

    const report = await restoreFromVault({
      schemaVersion: SchemaVersion,
      graphVault,
      targetIndexPath,
      mode: "restore",
    });

    expect(report.restoredDocumentCount).toBe(0);
    expect(report.restoredCapabilityCount).toBe(0);
    expect(report.failedItems.some((item) =>
      item.stage === "restore_document" &&
      item.redactedMessage.includes("content hash differs"),
    )).toBe(true);

    const restoredStore = createStore(targetIndexPath);
    try {
      const capability = restoredStore.db.prepare(
        "SELECT content_hash FROM qmd_graph_capabilities WHERE capability_id = ?",
      ).get("book-123:graph_query") as { content_hash: string } | undefined;

      expect(capability).toBeFalsy();
    } finally {
      restoredStore.close();
    }
  });

  test("redacts absolute paths and secrets from restore audit failures", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-vault-redact-"));
    const targetIndexPath = join(graphVault, "restored.sqlite");
    const secretPath = join(graphVault, "input", "missing.md");
    await mkdir(join(graphVault, "input"), { recursive: true });
    await mkdir(join(graphVault, "catalog"), { recursive: true });
    await writeFile(join(graphVault, "catalog", "sources.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: source
    sourceName: book.epub
`);
    await writeFile(
      join(graphVault, "catalog", "document-identity-map.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source
    sourceHash: source
    documentId: book-123
    canonicalBookId: book-123
    contentHash: expected-content-hash
    normalizationPolicyVersion: v1
    chunkIds: []
    metadata:
      normalizedPath: input/missing.md
`,
    );
    await writeFile(
      join(graphVault, "catalog", "graph-capabilities.yaml"),
      `
schemaVersion: ${SchemaVersion}
items: []
`,
    );

    const report = await restoreFromVault({
      schemaVersion: SchemaVersion,
      graphVault,
      targetIndexPath,
      mode: "restore",
      metadata: {
        authorization: "Bearer opaque-redaction-marker",
        localPath: secretPath,
      },
    });
    const auditRaw = await readFile(
      join(graphVault, "catalog", "restore-audits.jsonl"),
      "utf8",
    );

    expect(report.failedItems[0]?.redactedMessage).not.toContain(graphVault);
    expect(auditRaw).not.toContain(graphVault);
    expect(auditRaw).not.toContain(secretPath);
    expect(auditRaw).not.toContain("opaque-redaction-marker");
    expect(auditRaw).toContain("[redacted-path]");
  });
});
