import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import YAML from "yaml";

import { SchemaVersion } from "../src/contracts/common.js";
import { DspyQueryExpansionStrictRefusalError } from "../src/dspy/errors.js";
import type { GraphCapability } from "../src/contracts/graph-enhancement.js";
import type { GraphRagProviderDetail } from "../src/contracts/graphrag.js";
import type { QmdRetrievalCandidate } from "../src/contracts/qmd-query.js";
import type { UnifiedQueryRequest } from "../src/contracts/unified-query.js";
import {
  loadGraphQueryCapabilities,
  recordGraphCapability,
  resolveCandidateGraphCapabilities,
} from "../src/graphrag/capability-catalog.js";
import {
  hashDirectoryContents,
  hashLanceDbDirectoryContents,
} from "../src/job-state/artifact-validation.js";
import {
  TypedQueryErrorException,
  decideRoute,
  routeQuery,
} from "../src/query/unified-router.js";
import {
  loadDocumentIdentitiesFromGraphVault,
  toQmdRetrievalCandidates,
} from "../src/query/qmd-candidates.js";
import {
  QueryTimingRecorder,
  formatGraphRagRuntimeMetrics,
} from "../src/query/query-timing.js";

const MinimalParquetFixture = Buffer.from(
  "UEFSMRUEFRIVFkwVAhUAEgAACSAFAAAAcm93LTEVABUSFRYsFQIVEBUGFQYcNgAoBXJvdy0xGAVyb3ctMRERAAAACSACAAAAAgEBAgAVBBksNQAYBnNjaGVtYRUCABUMJQIYAmlkJQBMHAAAABYCGRwZHCYAHBUMGTUABhAZGAJpZBUCFgIWigEWkgEmOiYIHDYAKAVyb3ctMRgFcm93LTEREQAZLBUEFQAVAgAVABUQFQIAPBYKGQYZJgACAAAAFooBFgImCBaSAQAZHBgMQVJST1c6c2NoZW1hGKABLy8vLy8zQUFBQUFRQUFBQUFBQUtBQXdBQmdBRkFBZ0FDZ0FBQUFBQkJBQU1BQUFBQ0FBSUFBQUFCQUFJQUFBQUJBQUFBQUVBQUFBVUFBQUFFQUFVQUFnQUJnQUhBQXdBQUFBUUFCQUFBQUFBQUFFRkVBQUFBQmdBQUFBRUFBQUFBQUFBQUFJQUFBQnBaQUFBQkFBRUFBUUFBQUFBQUFBQQAYIHBhcnF1ZXQtY3BwLWFycm93IHZlcnNpb24gMjIuMC4wGRwcAAAAWgEAAFBBUjE=",
  "base64",
);
import { hashFile } from "../src/job-state/fingerprint.js";

function request(overrides: Partial<UnifiedQueryRequest> = {}): UnifiedQueryRequest {
  return {
    schemaVersion: SchemaVersion,
    query: "How do core concepts relate across the book?",
    requestedRoute: "auto",
    maxCostClass: "medium",
    ...overrides,
  };
}

function candidate(overrides: Partial<QmdRetrievalCandidate> = {}): QmdRetrievalCandidate {
  return {
    candidateId: "cand-1",
    sourceId: "source-1",
    documentId: "doc-1",
    chunkId: "chunk-1",
    path: "qmd://books/book.md",
    retrievalScore: 0.9,
    ...overrides,
  };
}

function capability(candidateId = "cand-1"): [string, GraphCapability[]] {
  return [candidateId, [{
    schemaVersion: SchemaVersion,
    capabilityId: "cap-1",
    kind: "graph_query",
    bookId: "book-1",
    sourceId: "source-1",
    documentId: "doc-1",
    contentHash: "sha256:content",
    ready: true,
    readinessSource: "validated_checkpoint_plus_validated_manifest",
    artifactIds: ["artifact-1", "artifact-2"],
    createdAt: "2026-05-21T00:00:00.000Z",
  }]];
}

function graphEvidence(overrides: Record<string, unknown> = {}) {
  return {
    evidenceId: "cap-1",
    graphCapabilityId: "cap-1",
    sourceId: "source-1",
    documentId: "doc-1",
    bookId: "book-1",
    contentHash: "sha256:content",
    graphTextUnitId: "tu-1",
    artifactId: "artifact-1",
    ...overrides,
  };
}

async function writeValidatedQueryReadyArtifacts(
  root: string,
  bookId: string,
  identity: {
    sourceId?: string;
    sourceHash?: string;
    documentId?: string;
    contentHash?: string;
    graphDocumentId?: string;
    graphTextUnitIds?: string[];
    qmdCorpusRegistered?: boolean;
  } = {},
): Promise<void> {
  const sourceHash = identity.sourceHash ?? "source-1";
  const sourceId = identity.sourceId ?? "source-1";
  const documentId = identity.documentId ?? "doc-1";
  const contentHash = identity.contentHash ?? "sha256:content";
  const graphDocumentId = identity.graphDocumentId ?? "graph-doc-1";
  const graphTextUnitIds = identity.graphTextUnitIds ?? ["tu-1"];
  const qmdCorpusRegistered = identity.qmdCorpusRegistered ?? true;
  const providerFingerprint = "provider-openai-responses-jina";
  const stageFingerprints = {
    ingest: "stage-ingest",
    normalize: "stage-normalize",
    graph_extract: "stage-graph-extract",
    community_report: "stage-community-report",
    embed: "stage-embed",
    query_ready: "stage-query-ready",
  };
  await mkdir(join(root, "catalog"), { recursive: true });
  await mkdir(join(root, "books", bookId, "graphrag", "output"), {
    recursive: true,
  });
  await mkdir(join(root, "books", bookId, "state"), { recursive: true });
  const booksPath = join(root, "catalog", "books.yaml");
  let booksCatalog: { schemaVersion: string; items: Array<Record<string, unknown>> };
  try {
    booksCatalog = YAML.parse(await readFile(booksPath, "utf8")) as typeof booksCatalog;
    booksCatalog.items ??= [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    booksCatalog = { schemaVersion: SchemaVersion, items: [] };
  }
  const existingBook = booksCatalog.items.find((item) => item.bookId === bookId);
  const bookState = {
    schemaVersion: SchemaVersion,
    bookId,
    documentId,
    sourcePath: `sources/${bookId}/source.epub`,
    sourceHash,
    normalizedContentHash: contentHash,
    normalizedPath: `input/${bookId}.md`,
    configFingerprint: "config",
    promptFingerprint: "prompt",
    modelFingerprint: "model",
    stageFingerprints,
    providerFingerprint,
    currentStage: "query_ready",
    overallStatus: "succeeded",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    metadata: {
      normalizedPath: `input/${bookId}.md`,
      sourceName: "Test Book",
    },
  };
  if (existingBook == null) {
    booksCatalog.items.push(bookState);
  } else {
    Object.assign(existingBook, {
      ...bookState,
      ...existingBook,
      stageFingerprints: {
        ...stageFingerprints,
        ...(existingBook.stageFingerprints as Record<string, string> | undefined),
      },
      providerFingerprint:
        typeof existingBook.providerFingerprint === "string"
          ? existingBook.providerFingerprint
          : providerFingerprint,
    });
  }
  await writeFile(booksPath, YAML.stringify(booksCatalog), "utf8");
  const graphExtractFiles = [
    ["documents.parquet", "graphrag_documents_parquet"],
    ["text_units.parquet", "graphrag_text_units_parquet"],
    ["entities.parquet", "graphrag_entities_parquet"],
    ["relationships.parquet", "graphrag_relationships_parquet"],
    ["communities.parquet", "graphrag_communities_parquet"],
  ] as const;
  for (const [fileName] of graphExtractFiles) {
    await writeFile(
      join(root, "books", bookId, "graphrag", "output", fileName),
      MinimalParquetFixture,
    );
  }
  await writeFile(
    join(root, "books", bookId, "graphrag", "output", "context.json"),
    "{}",
    "utf8",
  );
  await writeFile(
    join(root, "books", bookId, "graphrag", "output", "stats.json"),
    JSON.stringify({ schemaVersion: SchemaVersion, bookId, documents: 1 }),
    "utf8",
  );
  const graphExtractArtifactIds = [
    ...graphExtractFiles.map(([fileName]) =>
      `artifact-graph-${fileName.replace(/[^a-z0-9]+/giu, "-")}`
    ),
    "artifact-graph-context-json",
    "artifact-graph-stats-json",
  ];
  await writeFile(
    join(root, "books", bookId, "state", "checkpoints.yaml"),
    `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: ${bookId}
    stage: graph_extract
    status: succeeded
    attemptCount: 1
    runId: run-graph-extract
    inputFingerprint: stage-graph-extract
    contentHash: ${contentHash}
    stageFingerprint: stage-graph-extract
    providerFingerprint: ${providerFingerprint}
    artifactIds:
${graphExtractArtifactIds.map((artifactId) => `      - ${artifactId}`).join("\n")}
    finishedAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    bookId: ${bookId}
    stage: community_report
    status: succeeded
    attemptCount: 1
    runId: run-community-report
    inputFingerprint: stage-community-report
    contentHash: ${contentHash}
    stageFingerprint: stage-community-report
    providerFingerprint: ${providerFingerprint}
    artifactIds:
      - artifact-1
    finishedAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    bookId: ${bookId}
    stage: embed
    status: succeeded
    attemptCount: 1
    runId: run-embed
    inputFingerprint: stage-embed
    contentHash: ${contentHash}
    stageFingerprint: stage-embed
    providerFingerprint: ${providerFingerprint}
    artifactIds:
      - artifact-2
    finishedAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    bookId: ${bookId}
    stage: query_ready
    status: succeeded
    attemptCount: 1
    inputFingerprint: fp
    contentHash: ${contentHash}
    stageFingerprint: stage-query-ready
    providerFingerprint: ${providerFingerprint}
    artifactIds:
      - artifact-1
      - artifact-2
    finishedAt: 2026-05-21T00:00:00.000Z
`,
    "utf8",
  );
  await writeFile(
    join(root, "books", bookId, "graphrag", "output", "community_reports.parquet"),
    MinimalParquetFixture,
  );
  const lancedbPath = join(root, "books", bookId, "graphrag", "output", "lancedb");
  await writeCompleteLanceDbFixture(lancedbPath);
  const reportHash = await hashFile(
    join(root, "books", bookId, "graphrag", "output", "community_reports.parquet"),
  );
  const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);
  await writeFile(
    join(root, "books", bookId, "state", "artifacts.yaml"),
    `
schemaVersion: ${SchemaVersion}
items:
${(await Promise.all(graphExtractFiles.map(async ([fileName, kind]) => `  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-graph-${fileName.replace(/[^a-z0-9]+/giu, "-")}
    bookId: ${bookId}
    stage: graph_extract
    kind: ${kind}
    path: books/${bookId}/graphrag/output/${fileName}
    contentHash: ${await hashFile(join(root, "books", bookId, "graphrag", "output", fileName))}
    stageFingerprint: stage-graph-extract
    providerFingerprint: ${providerFingerprint}
    producerRunId: run-graph-extract
    createdAt: 2026-05-21T00:00:00.000Z
    metadata:
      corpusContentHash: ${contentHash}`))).join("\n")}
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-graph-context-json
    bookId: ${bookId}
    stage: graph_extract
    kind: graphrag_context_json
    path: books/${bookId}/graphrag/output/context.json
    contentHash: ${await hashFile(join(root, "books", bookId, "graphrag", "output", "context.json"))}
    stageFingerprint: stage-graph-extract
    providerFingerprint: ${providerFingerprint}
    producerRunId: run-graph-extract
    createdAt: 2026-05-21T00:00:00.000Z
    metadata:
      corpusContentHash: ${contentHash}
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-graph-stats-json
    bookId: ${bookId}
    stage: graph_extract
    kind: graphrag_stats_json
    path: books/${bookId}/graphrag/output/stats.json
    contentHash: ${await hashFile(join(root, "books", bookId, "graphrag", "output", "stats.json"))}
    stageFingerprint: stage-graph-extract
    providerFingerprint: ${providerFingerprint}
    producerRunId: run-graph-extract
    createdAt: 2026-05-21T00:00:00.000Z
    metadata:
      corpusContentHash: ${contentHash}
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-1
    bookId: ${bookId}
    stage: community_report
    kind: graphrag_community_reports_parquet
    path: books/${bookId}/graphrag/output/community_reports.parquet
    contentHash: ${reportHash}
    stageFingerprint: stage-community-report
    providerFingerprint: ${providerFingerprint}
    producerRunId: run-community-report
    createdAt: 2026-05-21T00:00:00.000Z
    metadata:
      corpusContentHash: ${contentHash}
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-2
    bookId: ${bookId}
    stage: embed
    kind: lancedb_index
    path: books/${bookId}/graphrag/output/lancedb
    contentHash: ${lancedbHash}
    stageFingerprint: stage-embed
    providerFingerprint: ${providerFingerprint}
    producerRunId: run-embed
    createdAt: 2026-05-21T00:00:00.000Z
    metadata:
      corpusContentHash: ${contentHash}
`,
    "utf8",
  );
  await writeFile(
    join(root, "catalog", "document-identity-map.yaml"),
    `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: ${sourceId}
    sourceHash: ${sourceHash}
    canonicalBookId: ${bookId}
    documentId: ${documentId}
    contentHash: ${contentHash}
    normalizationPolicyVersion: graphrag-normalized-markdown-v1
    normalizedPath: input/${bookId}.md
    chunkIds: []
    graphDocumentId: ${graphDocumentId}
    graphTextUnitIds:
${graphTextUnitIds.map((value) => `      - ${value}`).join("\n")}
    metadata:
      qmdCorpusRegistered: ${qmdCorpusRegistered}
  `,
    "utf8",
  );
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

describe("unified query routing", () => {
  test("upgrades auto route when graph intent and coverage satisfy policy", () => {
    const decision = decideRoute({
      request: request(),
      candidates: [candidate()],
      capabilitiesByCandidateId: new Map([capability()]),
    });

    expect(decision.selectedRoute).toBe("graphrag");
    expect(decision.graphCoverage).toBe(1);
    expect(decision.candidateDecisions[0]?.isGraphReady).toBe(true);
  });

  test("keeps auto route on qmd when intent is lookup", () => {
    const decision = decideRoute({
      request: request({ query: "CAP theorem", requestedRoute: "auto" }),
      candidates: [candidate()],
      capabilitiesByCandidateId: new Map([capability()]),
    });

    expect(decision.selectedRoute).toBe("qmd");
    expect(decision.refusalReasons).toContain("intent_not_graph_synthesis");
  });

  test("keeps explicit auto route on qmd when graph upgrades are disabled", () => {
    const decision = decideRoute({
      request: request({
        requestedRoute: "auto",
        allowGraphUpgrade: false,
      }),
      candidates: [candidate()],
      capabilitiesByCandidateId: new Map([capability()]),
    });

    expect(decision.requestedRoute).toBe("auto");
    expect(decision.selectedRoute).toBe("qmd");
    expect(decision.refusalReasons).toContain("graph_upgrade_disabled");
  });

  test("returns typed unified answer for qmd route", async () => {
    const answer = await routeQuery(request({
      requestedRoute: "qmd",
      query: "find source",
    }), {
      searchQmd: async (qmdRequest) => ({
        schemaVersion: SchemaVersion,
        query: qmdRequest.query,
        results: [candidate()],
      }),
    });

    expect(answer.routeDecision.selectedRoute).toBe("qmd");
    expect(answer.evidence[0]?.documentId).toBe("doc-1");
  });

  test("wraps DSPy strict refusal as typed qmd retrieval error", async () => {
    await expect(routeQuery(request({
      requestedRoute: "qmd",
      query: "find source",
    }), {
      searchQmd: async () => {
        throw new DspyQueryExpansionStrictRefusalError(
          "pointer_missing",
          "DSPy query expansion failed (pointer_missing)",
        );
      },
    })).rejects.toMatchObject({
      payload: {
        route: "qmd",
        stage: "qmd_retrieval",
        provider: "dspy",
        capability: "query_expansion",
        code: "pointer_missing",
        retryable: false,
        metadata: {
          dspyFailureReason: "pointer_missing",
        },
      },
    });
  });

  test("projects qmd-only document and chunk lineage from qmd SQLite identity", () => {
    const [projected] = toQmdRetrievalCandidates([{
      file: "qmd://books/book.md",
      displayPath: "books/book.md",
      title: "Book",
      body: "first chunk\n\nsecond chunk",
      bestChunk: "first chunk",
      bestChunkPos: 14,
      bestChunkSeq: 2,
      score: 0.8,
      context: null,
      docid: "abcdef",
      hash: "content-hash-without-identity",
    }]);

    expect(projected?.sourceId).toBeNull();
    expect(projected?.documentId).toBe("qmd-doc:de40ba3ccf63de9081040e62");
    expect(projected?.chunkId).toBe("qmd-chunk:content-hash-without-identity:2");
    expect(projected?.contentHash).toBe("content-hash-without-identity");
    expect(projected?.metadata?.qmdDocumentIdSource).toBe("qmd_sqlite_projection");
    expect(projected?.metadata?.qmdChunkSeq).toBe(2);
  });

  test("does not bind graph identity by path when content hash is ambiguous", () => {
    const [projected] = toQmdRetrievalCandidates([{
      file: "qmd://books/book-one.md",
      displayPath: "books/book-one.md",
      title: "Book One",
      body: "first chunk",
      bestChunk: "first chunk",
      bestChunkPos: 0,
      bestChunkSeq: 0,
      score: 0.8,
      context: null,
      docid: "docid-1",
      hash: "shared-content-hash",
    }], {
      identities: [
        {
          schemaVersion: SchemaVersion,
          sourceId: "source-1",
          sourceHash: "source-hash-1",
          canonicalBookId: "book-1",
          documentId: "doc-1",
          contentHash: "shared-content-hash",
          normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
          normalizedPath: "books/book-one.md",
          chunkIds: [],
          graphDocumentId: "graph-doc-1",
          graphTextUnitIds: ["tu-1"],
          metadata: { qmdCorpusRegistered: true },
        },
        {
          schemaVersion: SchemaVersion,
          sourceId: "source-2",
          sourceHash: "source-hash-2",
          canonicalBookId: "book-2",
          documentId: "doc-2",
          contentHash: "shared-content-hash",
          normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
          normalizedPath: "books/book-two.md",
          chunkIds: [],
          graphDocumentId: "graph-doc-2",
          graphTextUnitIds: ["tu-2"],
          metadata: { qmdCorpusRegistered: true },
        },
      ],
    });

    expect(projected?.sourceId).toBeNull();
    expect(projected?.documentId).not.toBe("doc-1");
    expect(projected?.metadata?.qmdDocumentIdSource).toBe("qmd_sqlite_projection");
  });

  test("does not use bestChunkPos as qmd chunk identity", () => {
    const [projected] = toQmdRetrievalCandidates([{
      file: "qmd://books/book.md",
      displayPath: "books/book.md",
      title: "Book",
      body: "first chunk\n\nsecond chunk",
      bestChunk: "second chunk",
      bestChunkPos: 14,
      score: 0.8,
      context: null,
      docid: "abcdef",
      hash: "content-hash-without-identity",
    }]);

    expect(projected?.documentId).toBe("qmd-doc:de40ba3ccf63de9081040e62");
    expect(projected?.chunkId).toBeNull();
    expect(projected?.metadata?.chunkPos).toBe(14);
    expect(projected?.metadata?.qmdChunkSeq).toBeUndefined();
  });

  test("throws typed capability error for --graphrag without capabilities", async () => {
    await expect(routeQuery(request({
      requestedRoute: "graphrag",
    }), {
      searchQmd: async (qmdRequest) => ({
        schemaVersion: SchemaVersion,
        query: qmdRequest.query,
        results: [candidate()],
      }),
    })).rejects.toMatchObject({
      payload: {
        graphCapabilityError: {
          code: "capability_missing",
          queriedScope: "graph_enhanced_subset",
        },
      },
    });
  });

  test("wraps unreadable graph capability catalog as typed query error", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-bad-catalog-"));
    await mkdir(join(root, "catalog"), { recursive: true });
    await writeFile(
      join(root, "catalog", "document-identity-map.yaml"),
      "schemaVersion: [invalid",
      "utf8",
    );

    await expect(routeQuery(request({ requestedRoute: "auto" }), {
      searchQmd: async (qmdRequest) => ({
        schemaVersion: SchemaVersion,
        query: qmdRequest.query,
        results: [candidate()],
      }),
      resolveGraphCapabilities: async () => {
        await loadDocumentIdentitiesFromGraphVault(root);
        return new Map();
      },
    })).rejects.toMatchObject({
      payload: {
        stage: "graph_capability",
        code: "capability_catalog_unreadable",
      },
    });
  });

  test("keeps explicit graphrag refusal on graph route without qmd fallback", () => {
    const decision = decideRoute({
      request: request({ requestedRoute: "graphrag" }),
      candidates: [candidate()],
    });

    expect(decision.selectedRoute).toBe("graphrag");
    expect(decision.status).toBe("refused");
    expect(decision.graphCapabilityIds).toEqual([]);
    expect(decision.candidateDecisions[0]?.selected).toBe(false);
    expect(decision.candidateDecisions[0]?.selectionReason).toBeNull();
    expect(decision.candidateDecisions[0]?.refusalReason).toBe("capability_missing");
  });

  test("uses capability identity for graph scope when candidate identity is partial", () => {
    const decision = decideRoute({
      request: request({ requestedRoute: "graphrag", graphCoverageThreshold: 0 }),
      candidates: [candidate({
        sourceId: null,
        documentId: null,
        contentHash: "sha256:content",
      })],
      capabilitiesByCandidateId: new Map([capability()]),
    });

    expect(decision.selectedRoute).toBe("graphrag");
    expect(decision.selectedSourceIds).toEqual(["source-1"]);
    expect(decision.selectedDocumentIds).toEqual(["doc-1"]);
    expect(decision.selectedContentHashes).toEqual(["sha256:content"]);
  });

  test("does not infer graph readiness from candidate graphCapabilityIds", async () => {
    const candidateWithLegacyField = {
      ...candidate({
        metadata: {
          bookId: "book-1",
          contentHash: "content-1",
        },
      }),
      graphCapabilityIds: ["cap-legacy"],
    };

    const decision = decideRoute({
      request: request({ requestedRoute: "auto" }),
      candidates: [candidateWithLegacyField],
    });

    expect(decision.selectedRoute).toBe("qmd");
    expect(decision.graphCapabilityIds).toEqual([]);
    expect(decision.refusalReasons).toContain("no_graph_ready_candidate");
  });

  test("returns graph answer when auto upgrades", async () => {
    const answer = await routeQuery(request(), {
      searchQmd: async (qmdRequest) => ({
        schemaVersion: SchemaVersion,
        query: qmdRequest.query,
        results: [candidate()],
      }),
      resolveGraphCapabilities: async () => new Map([capability()]),
      queryGraphRag: async () => ({
        schemaVersion: SchemaVersion,
        method: "local",
        responseText: "Graph answer",
        evidence: [graphEvidence()],
      }),
    });

    expect(answer.routeDecision.selectedRoute).toBe("graphrag");
    expect(answer.answerText).toBe("Graph answer");
    expect(answer.evidence[0]?.artifactId).toBe("artifact-1");
    expect(answer.evidence[0]?.graphCapabilityId).toBe("cap-1");
  });

  test("records stable query timing stages when enabled", async () => {
    const timing = new QueryTimingRecorder({ route: "auto" });

    const answer = await routeQuery(request(), {
      searchQmd: async (qmdRequest) => ({
        schemaVersion: SchemaVersion,
        query: qmdRequest.query,
        results: [candidate()],
      }),
      resolveGraphCapabilities: async () => new Map([capability()]),
      queryGraphRag: async () => ({
        schemaVersion: SchemaVersion,
        method: "local",
        responseText: "Graph answer",
        evidence: [graphEvidence()],
      }),
      timing,
    });

    const report = timing.report({
      selectedRoute: answer.routeDecision.selectedRoute,
    });
    expect(report.kind).toBe("qmd_query_timing");
    expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(report.metadata).toMatchObject({
      route: "auto",
      selectedRoute: "graphrag",
    });
    expect(report.stages.map((stage) => stage.name)).toEqual([
      "route.resolve_graph_scope_capabilities",
      "route.qmd_retrieval",
      "route.resolve_candidate_graph_capabilities",
      "route.decide",
      "route.query_graphrag_provider",
      "route.build_answer",
    ]);
    for (const stage of report.stages) {
      expect(stage.status).toBe("succeeded");
      expect(stage.startedOffsetMs).toBeGreaterThanOrEqual(0);
      expect(stage.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("formats provider runtime metrics as bounded readable diagnostics", () => {
    const detail: GraphRagProviderDetail = {
      provider: "graphrag",
      method: "local",
      runtimeMetrics: {
        kind: "graphrag_query_runtime_metrics",
        scope: "current_invocation",
        totalDurationMs: 1100,
        stages: [
          {
            name: "bridge.import_graphrag_runtime",
            durationMs: 100,
            status: "succeeded",
          },
          {
            name: "graphrag.search",
            durationMs: 900,
            status: "succeeded",
          },
        ],
        modelMetrics: [{
          model: "gpt-example",
          attemptedRequestCount: 2,
          successfulResponseCount: 2,
          failedResponseCount: 0,
          requestsWithRetries: 1,
          retryCount: 1,
          streamingResponseCount: 0,
          loggedComputeDurationMs: 850,
          promptTokens: 120,
          completionTokens: 30,
          totalTokens: 150,
          cacheHitRate: 0,
        }],
        aggregate: {
          modelCount: 1,
          attemptedRequestCount: 2,
          successfulResponseCount: 2,
          failedResponseCount: 0,
          requestsWithRetries: 1,
          retryCount: 1,
          streamingResponseCount: 0,
          loggedComputeDurationMs: 850,
          promptTokens: 120,
          completionTokens: 30,
          totalTokens: 150,
          unattributedWallDurationMs: 250,
        },
      },
    };

    const report = formatGraphRagRuntimeMetrics(detail);

    expect(report).toContain("GraphRAG runtime metrics:");
    expect(report).toContain(
      "bridge.import_graphrag_runtime: 100.00ms (ok)",
    );
    expect(report).toContain("graphrag.search: 900.00ms (ok)");
    expect(report).toContain("requests: attempted=2, succeeded=2, failed=0");
    expect(report).toContain("tokens=150");
    expect(report).not.toContain("prompt text");
    expect(report).not.toContain("response text");
  });

  test("sanitizes provider-owned GraphRAG evidence locators", async () => {
    const answer = await routeQuery(request(), {
      searchQmd: async (qmdRequest) => ({
        schemaVersion: SchemaVersion,
        query: qmdRequest.query,
        results: [candidate()],
      }),
      resolveGraphCapabilities: async () => new Map([capability()]),
      queryGraphRag: async () => ({
        schemaVersion: SchemaVersion,
        method: "local",
        responseText: "Graph answer",
        evidence: [
          graphEvidence({
            locator: {
              path: "/Users/local/project/graph_vault/books/book-1/private.md",
              uri: "https://internal.example.local/private/source",
              lineStart: 9,
              lineEnd: 12,
            },
            metadata: {
              title: "Portable graph evidence",
              requestDataDir: "/Users/local/project/graph_vault/books/book-1",
              rawProviderResponse: { path: "/private/provider/cache.json" },
            },
          }),
          graphEvidence({
            evidenceId: "cap-2",
            locator: {
              path: "books/book-1/graphrag/output/community_reports.parquet",
              uri: "urn:qmd:book-1:evidence:cap-2",
              lineStart: 3,
            },
          }),
        ],
      }),
    });

    expect(answer.evidence[0]?.locator).toEqual({ lineStart: 9, lineEnd: 12 });
    expect(answer.evidence[0]?.metadata).toEqual({
      title: "Portable graph evidence",
    });
    expect(answer.evidence[1]?.locator).toEqual({
      path: "books/book-1/graphrag/output/community_reports.parquet",
      uri: "urn:qmd:book-1:evidence:cap-2",
      lineStart: 3,
    });
    expect(JSON.stringify(answer)).not.toContain("/Users/local/project");
    expect(JSON.stringify(answer)).not.toContain("internal.example.local");
    expect(JSON.stringify(answer)).not.toContain("provider/cache");
  });

  test("converts malformed graph provider responses to typed errors", async () => {
    await expect(routeQuery(request(), {
      searchQmd: async (qmdRequest) => ({
        schemaVersion: SchemaVersion,
        query: qmdRequest.query,
        results: [candidate()],
      }),
      resolveGraphCapabilities: async () => new Map([capability()]),
      queryGraphRag: async () => ({
        schemaVersion: SchemaVersion,
        method: "local",
      } as never),
    })).rejects.toMatchObject({
      payload: {
        stage: "provider",
        provider: "graphrag",
        capability: "graph_query",
        code: "provider_response_invalid",
      },
    });
  });

  test("rejects graph provider evidence without graphCapabilityId", async () => {
    await expect(routeQuery(request(), {
      searchQmd: async (qmdRequest) => ({
        schemaVersion: SchemaVersion,
        query: qmdRequest.query,
        results: [candidate()],
      }),
      resolveGraphCapabilities: async () => new Map([capability()]),
      queryGraphRag: async () => ({
        schemaVersion: SchemaVersion,
        method: "local",
        responseText: "Graph answer",
        evidence: [{
          evidenceId: "cap-1",
          sourceId: "source-1",
          documentId: "doc-1",
          bookId: "book-1",
          contentHash: "sha256:content",
          graphTextUnitId: "tu-1",
          artifactId: "artifact-1",
        }],
      } as never),
    })).rejects.toMatchObject({
      payload: {
        stage: "provider",
        provider: "graphrag",
        capability: "graph_query",
        code: "provider_response_invalid",
      },
    });
  });

  test("converts graph provider runtime failures to typed errors", async () => {
    await expect(routeQuery(request(), {
      searchQmd: async (qmdRequest) => ({
        schemaVersion: SchemaVersion,
        query: qmdRequest.query,
        results: [candidate()],
      }),
      resolveGraphCapabilities: async () => new Map([capability()]),
      queryGraphRag: async () => {
        throw new Error("bridge stderr with provider internals");
      },
    })).rejects.toMatchObject({
      payload: {
        stage: "graphrag_query",
        provider: "graphrag",
        capability: "graph_query",
        code: "provider_unavailable",
      },
    });
  });

  test("passes only selected candidate capabilities to GraphRAG provider", async () => {
    const selectedCapability = capability("cand-1");
    const ignoredCapability: [string, GraphCapability[]] = ["cand-2", [{
      ...selectedCapability[1][0]!,
      capabilityId: "cap-ignored",
      bookId: "book-ignored",
      sourceId: "source-ignored",
      documentId: "doc-ignored",
    }]];

    const answer = await routeQuery(request({ requestedRoute: "graphrag" }), {
      searchQmd: async (qmdRequest) => ({
        schemaVersion: SchemaVersion,
        query: qmdRequest.query,
        results: [candidate()],
      }),
      resolveGraphCapabilities: async () => new Map([
        selectedCapability,
        ignoredCapability,
      ]),
      queryGraphRag: async (_request, decision) => {
        expect(decision.graphCapabilityIds).toEqual(["cap-1"]);
        expect(decision.selectedBookIds).toEqual(["book-1"]);
        return {
          schemaVersion: SchemaVersion,
          method: "local",
          responseText: "Scoped graph answer",
          evidence: [graphEvidence()],
        };
      },
    });

    expect(answer.routeDecision.graphCapabilityIds).toEqual(["cap-1"]);
  });

  test("explicit graphrag route builds scope from graph capabilities without qmd recall", async () => {
    const answer = await routeQuery(request({ requestedRoute: "graphrag" }), {
      searchQmd: async () => {
        throw new Error("explicit GraphRAG scope must not depend on qmd top-k");
      },
      resolveGraphScopeCapabilities: async () => capability()[1],
      queryGraphRag: async (_request, decision) => {
        expect(decision.selectedRoute).toBe("graphrag");
        expect(decision.graphCapabilityIds).toEqual(["cap-1"]);
        expect(decision.selectedSourceIds).toEqual(["source-1"]);
        return {
          schemaVersion: SchemaVersion,
          method: "local",
          responseText: "Graph answer from capability scope",
          evidence: [graphEvidence()],
        };
      },
    });

    expect(answer.answerText).toBe("Graph answer from capability scope");
    expect(answer.routeDecision.candidateEvidenceIds).toEqual(["graph:cap-1"]);
  });

  test("accepts explicit graphrag responses with null evidence quotes", async () => {
    const answer = await routeQuery(request({ requestedRoute: "graphrag" }), {
      searchQmd: async () => {
        throw new Error("explicit GraphRAG scope must not depend on qmd top-k");
      },
      resolveGraphScopeCapabilities: async () => capability()[1],
      queryGraphRag: async () => ({
        schemaVersion: SchemaVersion,
        method: "global",
        responseText: "Graph answer from capability scope",
        evidence: [
          graphEvidence({
            quote: null,
          }),
        ],
      } as never),
    });

    expect(answer.answerText).toBe("Graph answer from capability scope");
    expect(answer.evidence[0]?.quote).toBeUndefined();
  });

  test("parses unified query request and qmd result at route boundary", async () => {
    await expect(routeQuery({
      schemaVersion: SchemaVersion,
      query: "",
      requestedRoute: "qmd",
    } as UnifiedQueryRequest, {
      searchQmd: async (qmdRequest) => ({
        schemaVersion: SchemaVersion,
        query: qmdRequest.query,
        results: [],
      }),
    })).rejects.toThrow();
  });

  test("derives graph capabilities from query-ready book state", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-"));
    const bookId = "book-1";
    await mkdir(join(root, "catalog"), { recursive: true });
    await mkdir(join(root, "books", bookId), { recursive: true });
    await writeFile(join(root, "catalog", "books.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: ${bookId}
    documentId: doc-from-identity-map
    sourcePath: sources/book-1/source.epub
    sourceHash: source-hash-1
    normalizedContentHash: content-hash-1
    configFingerprint: config
    promptFingerprint: prompt
    modelFingerprint: model
    overallStatus: succeeded
    createdAt: 2026-05-21T00:00:00.000Z
    updatedAt: 2026-05-21T00:00:00.000Z
    metadata:
      normalizedPath: input/book.md
      sourceName: Test Book
`);
    await writeValidatedQueryReadyArtifacts(root, bookId, {
      sourceId: "sha256:source-hash-1",
      sourceHash: "source-hash-1",
      documentId: "doc-from-identity-map",
      contentHash: "content-hash-1",
    });

    const capabilities = await loadGraphQueryCapabilities({ graphVault: root });
    const candidateCapabilities = await resolveCandidateGraphCapabilities({
      graphVault: root,
      candidates: [candidate({
        candidateId: "cand-1",
        sourceId: "sha256:source-hash-1",
        documentId: "doc-from-identity-map",
        path: "qmd://books/book.md",
      })],
    });

    expect(capabilities[0]?.kind).toBe("graph_query");
    expect(capabilities[0]?.documentId).toBe("doc-from-identity-map");
    expect(candidateCapabilities.get("cand-1")?.[0]?.bookId).toBe(bookId);
  });

  test("does not match qmd candidates to graph capabilities by qmd collection path", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-qmd-path-match-"));
    const bookId = "book-1";
    await mkdir(join(root, "catalog"), { recursive: true });
    await mkdir(join(root, "books", bookId), { recursive: true });
    await writeFile(join(root, "catalog", "books.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: ${bookId}
    documentId: doc-from-identity-map
    sourcePath: sources/book-1/source.epub
    sourceHash: source-hash-1
    normalizedContentHash: graph-normalized-hash
    configFingerprint: config
    promptFingerprint: prompt
    modelFingerprint: model
    overallStatus: succeeded
    createdAt: 2026-05-21T00:00:00.000Z
    updatedAt: 2026-05-21T00:00:00.000Z
`);
    await writeValidatedQueryReadyArtifacts(root, bookId, {
      sourceId: "sha256:source-hash-1",
      sourceHash: "source-hash-1",
      documentId: "doc-from-identity-map",
      contentHash: "graph-normalized-hash",
    });
    await writeFile(join(root, "catalog", "document-identity-map.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source-hash-1
    sourceHash: source-hash-1
    canonicalBookId: ${bookId}
    documentId: doc-from-identity-map
    contentHash: graph-normalized-hash
    normalizationPolicyVersion: graphrag-normalized-markdown-v1
    normalizedPath: input/book.md
    chunkIds: []
    graphDocumentId: graph-doc-1
    graphTextUnitIds:
      - tu-1
    metadata:
      qmdCorpusRegistered: true
      qmdCollection: books
      qmdRelativePath: book.md
`);

    const candidateCapabilities = await resolveCandidateGraphCapabilities({
      graphVault: root,
      candidates: [candidate({
        candidateId: "cand-1",
        sourceId: null,
        documentId: "qmd-doc-for-different-hash",
        contentHash: "qmd-sqlite-hash",
        collection: "books",
        path: "qmd://books/book.md",
        metadata: { path: "books/book.md" },
      })],
    });

    expect(candidateCapabilities.has("cand-1")).toBe(false);
  });

  test("loads query-ready capabilities from community-report and embed artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-cross-stage-ready-"));
    await writeValidatedQueryReadyArtifacts(root, "book-1", {
      sourceId: "source-1",
      sourceHash: "source-1",
      documentId: "doc-1",
      contentHash: "sha256:content",
    });
    await recordGraphCapability(root, capability()[1][0]!);

    const capabilities = await loadGraphQueryCapabilities({ graphVault: root });

    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]?.artifactIds).toEqual(expect.arrayContaining([
      "artifact-graph-documents-parquet",
      "artifact-graph-text-units-parquet",
      "artifact-graph-entities-parquet",
      "artifact-graph-relationships-parquet",
      "artifact-graph-communities-parquet",
      "artifact-graph-context-json",
      "artifact-graph-stats-json",
      "artifact-1",
      "artifact-2",
    ]));
  });

  test("does not derive capability when graph identity map is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-book-document-"));
    const bookId = "book-1";
    await mkdir(join(root, "catalog"), { recursive: true });
    await mkdir(join(root, "books", bookId), { recursive: true });
    await writeFile(join(root, "catalog", "books.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: ${bookId}
    documentId: doc-from-book-state
    sourcePath: sources/book-1/source.epub
    sourceHash: source-hash-1
    normalizedContentHash: content-hash-1
    configFingerprint: config
    promptFingerprint: prompt
    modelFingerprint: model
    overallStatus: succeeded
    createdAt: 2026-05-21T00:00:00.000Z
    updatedAt: 2026-05-21T00:00:00.000Z
`);
    await writeValidatedQueryReadyArtifacts(root, bookId);
    await writeFile(join(root, "catalog", "document-identity-map.yaml"), `
schemaVersion: ${SchemaVersion}
items: []
`);

    const capabilities = await loadGraphQueryCapabilities({ graphVault: root });

    expect(capabilities).toEqual([]);
  });

  test("does not derive capability when graph identity mismatches book state", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-mismatched-identity-"));
    const bookId = "book-1";
    await mkdir(join(root, "catalog"), { recursive: true });
    await mkdir(join(root, "books", bookId), { recursive: true });
    await writeFile(join(root, "catalog", "books.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: ${bookId}
    documentId: doc-1
    sourcePath: sources/book-1/source.epub
    sourceHash: source-hash-1
    normalizedContentHash: content-hash-1
    configFingerprint: config
    promptFingerprint: prompt
    modelFingerprint: model
    overallStatus: succeeded
    createdAt: 2026-05-21T00:00:00.000Z
    updatedAt: 2026-05-21T00:00:00.000Z
`);
    await writeValidatedQueryReadyArtifacts(root, bookId, {
      sourceId: "sha256:source-hash-1",
      sourceHash: "source-hash-1",
      documentId: "doc-1",
      contentHash: "different-content-hash",
      graphDocumentId: "graph-doc-1",
      graphTextUnitIds: ["tu-1"],
    });

    const capabilities = await loadGraphQueryCapabilities({ graphVault: root });

    expect(capabilities).toEqual([]);
  });

  test("does not derive capability without qmd corpus registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-qmd-registration-"));
    await mkdir(join(root, "catalog"), { recursive: true });
    const bookId = "book-1";
    await writeFile(join(root, "catalog", "books.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: ${bookId}
    documentId: doc-1
    sourcePath: sources/book-1/source.epub
    sourceHash: source-hash-1
    normalizedContentHash: content-hash-1
    configFingerprint: config
    promptFingerprint: prompt
    modelFingerprint: model
    overallStatus: succeeded
    createdAt: 2026-05-21T00:00:00.000Z
    updatedAt: 2026-05-21T00:00:00.000Z
`);
    await writeValidatedQueryReadyArtifacts(root, bookId, {
      sourceId: "sha256:source-hash-1",
      sourceHash: "source-hash-1",
      documentId: "doc-1",
      contentHash: "content-hash-1",
      graphDocumentId: "graph-doc-1",
      graphTextUnitIds: ["tu-1"],
      qmdCorpusRegistered: false,
    });
    await recordGraphCapability(root, {
      ...capability()[1][0]!,
      bookId,
      sourceId: "sha256:source-hash-1",
      documentId: "doc-1",
      contentHash: "content-hash-1",
    });

    const capabilities = await loadGraphQueryCapabilities({ graphVault: root });

    expect(capabilities).toEqual([]);
  });

  test("keeps derived book-state capability authoritative over explicit catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-capability-overlay-"));
    await mkdir(join(root, "catalog"), { recursive: true });
    for (const bookId of ["book-1", "book-2"]) {
      await mkdir(join(root, "books", bookId), { recursive: true });
      await writeValidatedQueryReadyArtifacts(root, bookId, {
        sourceId: `sha256:source-hash-${bookId.endsWith("1") ? "1" : "2"}`,
        sourceHash: `source-hash-${bookId.endsWith("1") ? "1" : "2"}`,
        documentId: `doc-${bookId.endsWith("1") ? "1" : "2"}`,
        contentHash: `content-hash-${bookId.endsWith("1") ? "1" : "2"}`,
        graphDocumentId: `graph-doc-${bookId.endsWith("1") ? "1" : "2"}`,
        graphTextUnitIds: [`tu-${bookId.endsWith("1") ? "1" : "2"}`],
      });
    }
    await writeFile(join(root, "catalog", "document-identity-map.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source-hash-1
    sourceHash: source-hash-1
    canonicalBookId: book-1
    documentId: doc-1
    contentHash: content-hash-1
    normalizationPolicyVersion: graphrag-normalized-markdown-v1
    normalizedPath: input/book-1.md
    chunkIds: []
    graphDocumentId: graph-doc-1
    graphTextUnitIds:
      - tu-1
    metadata:
      qmdCorpusRegistered: true
  - schemaVersion: ${SchemaVersion}
    sourceId: sha256:source-hash-2
    sourceHash: source-hash-2
    canonicalBookId: book-2
    documentId: doc-2
    contentHash: content-hash-2
    normalizationPolicyVersion: graphrag-normalized-markdown-v1
    normalizedPath: input/book-2.md
    chunkIds: []
    graphDocumentId: graph-doc-2
    graphTextUnitIds:
      - tu-2
    metadata:
      qmdCorpusRegistered: true
`);
    await recordGraphCapability(root, {
      ...capability()[1][0]!,
      capabilityId: "book-1:graph_query",
      bookId: "book-1",
      sourceId: "sha256:source-hash-1",
      documentId: "explicit-doc-overwrite",
      contentHash: "explicit-content-overwrite",
    });

    const capabilities = await loadGraphQueryCapabilities({ graphVault: root });

    expect(capabilities.map((item) => item.bookId).sort()).toEqual([
      "book-1",
      "book-2",
    ]);
    expect(capabilities.find((item) => item.bookId === "book-2")?.documentId)
      .toBe("doc-2");
    expect(capabilities.find((item) => item.bookId === "book-1")?.documentId)
      .toBe("doc-1");
    expect(capabilities.find((item) => item.bookId === "book-1")?.contentHash)
      .toBe("content-hash-1");
  });

  test("rejects graph capabilities when query artifacts rewrite producer stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-capability-bad-stage-"));
    await writeValidatedQueryReadyArtifacts(root, "book-1");
    await writeFile(
      join(root, "books", "book-1", "state", "artifacts.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-1
    bookId: book-1
    stage: query_ready
    kind: graphrag_community_reports_parquet
    path: books/book-1/graphrag/output/community_reports.parquet
    contentHash: ${(await hashFile(
      join(
        root,
        "books",
        "book-1",
        "graphrag",
        "output",
        "community_reports.parquet",
      ),
    ))}
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-2
    bookId: book-1
    stage: query_ready
    kind: lancedb_index
    path: books/book-1/graphrag/output/lancedb
    contentHash: ${(await hashLanceDbDirectoryContents(
      join(root, "books", "book-1", "graphrag", "output", "lancedb"),
    ))}
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
`,
      "utf8",
    );
    await recordGraphCapability(root, capability()[1][0]!);

    const capabilities = await loadGraphQueryCapabilities({ graphVault: root });

    expect(capabilities).toEqual([]);
  });

  test("records explicit graph capabilities as a rebuildable projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-capability-"));
    await writeValidatedQueryReadyArtifacts(root, "book-1");
    await recordGraphCapability(root, capability()[1][0]!);

    const capabilities = await loadGraphQueryCapabilities({ graphVault: root });

    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]?.capabilityId).toBe("cap-1");
  });

  test("rejects explicit graph capabilities without query-ready checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-capability-no-checkpoint-"));
    await mkdir(
      join(root, "books", "book-1", "graphrag", "output"),
      { recursive: true },
    );
    await mkdir(join(root, "books", "book-1", "state"), { recursive: true });
    await writeFile(
      join(
        root,
        "books",
        "book-1",
        "graphrag",
        "output",
        "community_reports.parquet",
      ),
      "reports",
      "utf8",
    );
    await mkdir(
      join(root, "books", "book-1", "graphrag", "output", "lancedb"),
      { recursive: true },
    );
    await writeFile(
      join(root, "books", "book-1", "state", "artifacts.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-1
    bookId: book-1
    stage: community_report
    kind: graphrag_community_reports_parquet
    path: books/book-1/graphrag/output/community_reports.parquet
    contentHash: report-hash
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-2
    bookId: book-1
    stage: embed
    kind: lancedb_index
    path: books/book-1/graphrag/output/lancedb
    contentHash: lancedb-hash
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
`,
      "utf8",
    );
    await recordGraphCapability(root, capability()[1][0]!);

    const capabilities = await loadGraphQueryCapabilities({ graphVault: root });

    expect(capabilities).toEqual([]);
  });

  test("rejects graph capabilities when required artifact kind is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-capability-bad-kind-"));
    await writeValidatedQueryReadyArtifacts(root, "book-1");
    await writeFile(
      join(root, "books", "book-1", "state", "artifacts.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-1
    bookId: book-1
    stage: community_report
    kind: query_snapshot
    path: books/book-1/graphrag/output/community_reports.parquet
    contentHash: report-hash
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-2
    bookId: book-1
    stage: embed
    kind: lancedb_index
    path: books/book-1/graphrag/output/lancedb
    contentHash: lancedb-hash
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
`,
      "utf8",
    );
    await recordGraphCapability(root, capability()[1][0]!);

    const capabilities = await loadGraphQueryCapabilities({ graphVault: root });

    expect(capabilities).toEqual([]);
  });

  test("rejects graph capabilities when artifact path is outside graph vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-capability-bad-path-"));
    await writeValidatedQueryReadyArtifacts(root, "book-1");
    await writeFile(
      join(root, "books", "book-1", "state", "artifacts.yaml"),
      `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-1
    bookId: book-1
    stage: query_ready
    kind: graphrag_community_reports_parquet
    path: ../outside/community_reports.parquet
    contentHash: report-hash
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    artifactId: artifact-2
    bookId: book-1
    stage: query_ready
    kind: lancedb_index
    path: books/book-1/graphrag/output/lancedb
    contentHash: lancedb-hash
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
`,
      "utf8",
    );
    await recordGraphCapability(root, capability()[1][0]!);

    const capabilities = await loadGraphQueryCapabilities({ graphVault: root });

    expect(capabilities).toEqual([]);
  });

  test("matches qmd candidates to graph capabilities by typed content hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-contenthash-"));
    await writeValidatedQueryReadyArtifacts(root, "book-1");
    await recordGraphCapability(root, capability()[1][0]!);

    const candidateCapabilities = await resolveCandidateGraphCapabilities({
      graphVault: root,
      candidates: [candidate({
        candidateId: "cand-by-content-hash",
        sourceId: null,
        documentId: "sha256",
        contentHash: "sha256:content",
      })],
    });

    expect(
      candidateCapabilities.get("cand-by-content-hash")?.[0]?.capabilityId,
    ).toBe("cap-1");
  });

  test("does not match graph capabilities from qmd candidate metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-contenthash-metadata-"));
    await writeValidatedQueryReadyArtifacts(root, "book-1");
    await recordGraphCapability(root, capability()[1][0]!);

    const candidateCapabilities = await resolveCandidateGraphCapabilities({
      graphVault: root,
      candidates: [candidate({
        candidateId: "cand-by-metadata",
        sourceId: null,
        documentId: "unmatched-doc",
        contentHash: null,
        metadata: {
          bookId: "book-1",
          contentHash: "sha256:content",
        },
      })],
    });

    expect(candidateCapabilities.has("cand-by-metadata")).toBe(false);
  });

  test("does not match content-hash-only candidates when graph hash is ambiguous", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-vault-ambiguous-contenthash-"));
    await mkdir(join(root, "catalog"), { recursive: true });
    await writeValidatedQueryReadyArtifacts(root, "book-1", {
      sourceId: "source-1",
      sourceHash: "source-1",
      documentId: "doc-1",
      contentHash: "sha256:content",
      graphDocumentId: "graph-doc-1",
      graphTextUnitIds: ["tu-1"],
    });
    await writeValidatedQueryReadyArtifacts(root, "book-2", {
      sourceId: "source-2",
      sourceHash: "source-2",
      documentId: "doc-2",
      contentHash: "sha256:content",
      graphDocumentId: "graph-doc-2",
      graphTextUnitIds: ["tu-2"],
    });
    await writeFile(join(root, "catalog", "books.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: book-1
    documentId: doc-1
    sourcePath: sources/book-1/source.epub
    sourceHash: source-1
    normalizedContentHash: sha256:content
    configFingerprint: config
    promptFingerprint: prompt
    modelFingerprint: model
    overallStatus: succeeded
    createdAt: 2026-05-21T00:00:00.000Z
    updatedAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    bookId: book-2
    documentId: doc-2
    sourcePath: sources/book-2/source.epub
    sourceHash: source-2
    normalizedContentHash: sha256:content
    configFingerprint: config
    promptFingerprint: prompt
    modelFingerprint: model
    overallStatus: succeeded
    createdAt: 2026-05-21T00:00:00.000Z
    updatedAt: 2026-05-21T00:00:00.000Z
`);
    await writeFile(join(root, "catalog", "document-identity-map.yaml"), `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: source-1
    sourceHash: source-1
    canonicalBookId: book-1
    documentId: doc-1
    contentHash: sha256:content
    normalizationPolicyVersion: graphrag-normalized-markdown-v1
    normalizedPath: input/book-1.md
    chunkIds: []
    graphDocumentId: graph-doc-1
    graphTextUnitIds:
      - tu-1
    metadata:
      qmdCorpusRegistered: true
  - schemaVersion: ${SchemaVersion}
    sourceId: source-2
    sourceHash: source-2
    canonicalBookId: book-2
    documentId: doc-2
    contentHash: sha256:content
    normalizationPolicyVersion: graphrag-normalized-markdown-v1
    normalizedPath: input/book-2.md
    chunkIds: []
    graphDocumentId: graph-doc-2
    graphTextUnitIds:
      - tu-2
    metadata:
      qmdCorpusRegistered: true
`);

    const candidateCapabilities = await resolveCandidateGraphCapabilities({
      graphVault: root,
      candidates: [candidate({
        candidateId: "cand-by-ambiguous-content-hash",
        sourceId: null,
        documentId: null,
        contentHash: "sha256:content",
      })],
    });

    expect(candidateCapabilities.has("cand-by-ambiguous-content-hash")).toBe(false);
  });
});
