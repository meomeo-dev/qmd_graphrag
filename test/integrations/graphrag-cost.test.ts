import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { SchemaVersion } from "../../src/contracts/common.js";
import { callPythonBridge } from "../../src/integrations/python-bridge.js";
import {
  runGraphRagIndex,
  runGraphRagQuery,
} from "../../src/integrations/graphrag.js";
import {
  appendProviderCostAccounting,
  buildProviderCostAccounting,
} from "../../src/provider/cost-accounting.js";
import { hashLanceDbDirectoryContents } from "../../src/job-state/artifact-validation.js";
import { hashFile } from "../../src/job-state/fingerprint.js";

vi.mock("../../src/integrations/python-bridge.js", () => ({
  callPythonBridge: vi.fn(),
}));

const mockedBridge = callPythonBridge as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedBridge.mockReset();
});

async function writeValidatedGraphVault(root: string): Promise<{
  reportArtifactId: string;
  lancedbArtifactId: string;
}> {
  const reportArtifactId = "artifact-report-1";
  const lancedbArtifactId = "artifact-lancedb-1";
  await mkdir(join(root, "catalog"), { recursive: true });
  const lancedbPath = join(root, "books", "book-1", "output", "lancedb");
  await writeCompleteLanceDbFixture(lancedbPath);
  await writeFile(
    join(root, "books", "book-1", "output", "community_reports.parquet"),
    "reports",
    "utf8",
  );
  const reportHash = await hashFile(
    join(root, "books", "book-1", "output", "community_reports.parquet"),
  );
  const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);
  await writeFile(
    join(root, "books", "book-1", "checkpoints.yaml"),
    `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    bookId: book-1
    stage: query_ready
    status: succeeded
    attemptCount: 1
    inputFingerprint: fp
    artifactIds:
      - ${reportArtifactId}
      - ${lancedbArtifactId}
    finishedAt: 2026-05-21T00:00:00.000Z
`,
    "utf8",
  );
  await writeFile(
    join(root, "books", "book-1", "artifacts.yaml"),
    `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    artifactId: ${reportArtifactId}
    bookId: book-1
    stage: community_report
    kind: graphrag_community_reports_parquet
    path: books/book-1/output/community_reports.parquet
    contentHash: ${reportHash}
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
  - schemaVersion: ${SchemaVersion}
    artifactId: ${lancedbArtifactId}
    bookId: book-1
    stage: embed
    kind: lancedb_index
    path: books/book-1/output/lancedb
    contentHash: ${lancedbHash}
    producerRunId: run-1
    createdAt: 2026-05-21T00:00:00.000Z
`,
    "utf8",
  );
  await writeFile(
    join(root, "catalog", "graph-capabilities.yaml"),
    `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    capabilityId: cap-1
    kind: graph_query
    bookId: book-1
    sourceId: source-1
    documentId: doc-1
    contentHash: content-1
    ready: true
    readinessSource: validated_checkpoint_plus_validated_manifest
    artifactIds:
      - ${reportArtifactId}
      - ${lancedbArtifactId}
    createdAt: 2026-05-21T00:00:00.000Z
`,
    "utf8",
  );
  await writeFile(
    join(root, "catalog", "document-identity-map.yaml"),
    `
schemaVersion: ${SchemaVersion}
items:
  - schemaVersion: ${SchemaVersion}
    sourceId: source-1
    sourceHash: source-1
    canonicalBookId: book-1
    documentId: doc-1
    contentHash: content-1
    normalizationPolicyVersion: graphrag-normalized-markdown-v1
    normalizedPath: input/book-1.md
    chunkIds: []
    graphDocumentId: graph-doc-1
    graphTextUnitIds:
      - tu-1
    metadata:
      qmdCorpusRegistered: true
`,
    "utf8",
  );
  return { reportArtifactId, lancedbArtifactId };
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

async function readCostLedger(root: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(root, "catalog", "cost-accounting.jsonl"), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function expectDurableRequestArtifact(
  graphVault: string,
  requestArtifactPath: string,
): Promise<void> {
  const artifactPath = join(graphVault, requestArtifactPath);
  const checksumPath = `${artifactPath}.sha256`;
  expect(existsSync(artifactPath)).toBe(true);
  expect(existsSync(checksumPath)).toBe(true);
  await expect(readFile(checksumPath, "utf8")).resolves.toBe(
    `${await hashFile(artifactPath)}\n`,
  );
}

describe("GraphRAG provider cost accounting", () => {
  test("records query artifactIds from GraphRAG evidence", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-graphrag-cost-query-"));
    mockedBridge.mockResolvedValueOnce({
      schemaVersion: SchemaVersion,
      method: "local",
      responseText: "Graph answer",
      evidence: [{
        evidenceId: "cap-1",
        graphCapabilityId: "cap-1",
        sourceId: "source-1",
        documentId: "doc-1",
        bookId: "book-1",
        contentHash: "content-1",
        graphTextUnitId: "tu-1",
        artifactId: "artifact-from-evidence",
      }],
    });

    await runGraphRagQuery({
      rootDir: graphVault,
      method: "local",
      query: "How do concepts relate?",
      responseType: "multiple paragraphs",
      capabilityScope: {
        selectedBookIds: ["book-1"],
        graphCapabilityIds: ["cap-1"],
        sourceIds: ["source-1"],
        documentIds: ["doc-1"],
        contentHashes: ["content-1"],
        artifactIds: ["artifact-from-evidence"],
      },
    });

    const [record] = await readCostLedger(graphVault);
    const artifactIds = record?.artifactIds as string[];
    const requestArtifactPath = record?.metadata == null
      ? undefined
      : (record.metadata as Record<string, unknown>).requestArtifactPath;

    expect(record?.stage).toBe("graphrag_query");
    expect(record?.lineageMode).toBe("graph_artifact");
    expect(record?.requestArtifactId).toBe(artifactIds[0]);
    expect(artifactIds).toContain("artifact-from-evidence");
    expect(artifactIds).not.toContain("cap-1");
    expect(typeof requestArtifactPath).toBe("string");
    await expectDurableRequestArtifact(graphVault, requestArtifactPath as string);
    expect(record?.tokenCountStatus).toBe("unknown");
    expect(record?.embeddingCountStatus).toBe("unknown");
  });

  test("retries transient GraphRAG query bridge errors without duplicate cost records", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-graphrag-query-retry-"));
    mockedBridge
      .mockRejectedValueOnce(new Error("Concurrency limit exceeded for user"))
      .mockResolvedValueOnce({
        schemaVersion: SchemaVersion,
        method: "local",
        responseText: "Graph answer after retry",
        evidence: [{
          evidenceId: "cap-1",
          graphCapabilityId: "cap-1",
          sourceId: "source-1",
          documentId: "doc-1",
          bookId: "book-1",
          contentHash: "content-1",
          graphTextUnitId: "tu-1",
          artifactId: "artifact-from-evidence",
        }],
      });

    const response = await runGraphRagQuery({
      rootDir: graphVault,
      method: "local",
      query: "How do concepts relate?",
      responseType: "multiple paragraphs",
      capabilityScope: {
        selectedBookIds: ["book-1"],
        graphCapabilityIds: ["cap-1"],
        sourceIds: ["source-1"],
        documentIds: ["doc-1"],
        contentHashes: ["content-1"],
        artifactIds: ["artifact-from-evidence"],
      },
    });

    const records = await readCostLedger(graphVault);

    expect(response.responseText).toBe("Graph answer after retry");
    expect(mockedBridge).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(1);
    expect(records[0]?.requestCount).toBe(1);
  });

  test("keeps multi-book query cost lineage grouped by evidence identity", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-graphrag-cost-multi-"));
    mockedBridge.mockResolvedValueOnce({
      schemaVersion: SchemaVersion,
      method: "local",
      responseText: "Graph answer",
      evidence: [
        {
          evidenceId: "cap-1",
          graphCapabilityId: "cap-1",
          sourceId: "source-1",
          documentId: "doc-1",
          bookId: "book-1",
          contentHash: "content-1",
          graphTextUnitId: "tu-1",
          artifactId: "artifact-book-1",
        },
        {
          evidenceId: "cap-2",
          graphCapabilityId: "cap-2",
          sourceId: "source-2",
          documentId: "doc-2",
          bookId: "book-2",
          contentHash: "content-2",
          graphTextUnitId: "tu-2",
          artifactId: "artifact-book-2",
        },
      ],
    });

    await runGraphRagQuery({
      rootDir: graphVault,
      method: "local",
      query: "Compare the books",
      responseType: "multiple paragraphs",
      capabilityScope: {
        selectedBookIds: ["book-1", "book-2"],
        graphCapabilityIds: ["cap-1", "cap-2"],
        sourceIds: ["source-1", "source-2"],
        documentIds: ["doc-1", "doc-2"],
        contentHashes: ["content-1", "content-2"],
        artifactIds: ["artifact-book-1", "artifact-book-2"],
      },
    });

    const records = await readCostLedger(graphVault);
    const queryRecords = records.filter((record) => record.stage === "graphrag_query");
    const book1 = queryRecords.find((record) => record.bookId === "book-1");
    const book2 = queryRecords.find((record) => record.bookId === "book-2");

    expect(queryRecords).toHaveLength(2);
    expect(book1?.sourceId).toBe("source-1");
    expect(book1?.documentId).toBe("doc-1");
    expect(book1?.contentHash).toBe("content-1");
    expect(book2?.sourceId).toBe("source-2");
    expect(book2?.documentId).toBe("doc-2");
    expect(book2?.contentHash).toBe("content-2");

    const book1ArtifactIds = book1?.artifactIds as string[];
    const book2ArtifactIds = book2?.artifactIds as string[];
    expect(book1ArtifactIds).toContain("artifact-book-1");
    expect(book1ArtifactIds).not.toContain("artifact-book-2");
    expect(book2ArtifactIds).toContain("artifact-book-2");
    expect(book2ArtifactIds).not.toContain("artifact-book-1");

    expect(book1?.requestArtifactId).toBe(book2?.requestArtifactId);
    expect(queryRecords.map((record) => record.requestCount)).toEqual([1, 0]);
    expect(queryRecords.reduce(
      (sum, record) => sum + (record.requestCount as number),
      0,
    )).toBe(1);
    for (const [index, record] of queryRecords.entries()) {
      const metadata = record.metadata as Record<string, unknown>;
      expect(metadata.lineageGroupCount).toBe(2);
      expect(metadata.lineageGroupIndex).toBe(index);
      expect(metadata.requestCountPolicy).toBe("first_group_counts_request");
    }
  });

  test("records index lineage only from explicit index scope", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-graphrag-cost-index-"));
    const reportDir = join(graphVault, "books", "book-index", "output", "reports");
    const { reportArtifactId, lancedbArtifactId } =
      await writeValidatedGraphVault(graphVault);
    mockedBridge.mockResolvedValueOnce({
      schemaVersion: SchemaVersion,
      method: "standard",
      outputs: [{
        workflow: "workflow-not-artifact",
        hasError: false,
        stateKeys: [],
      }],
    });

    await runGraphRagIndex({
      rootDir: graphVault,
      reportDir,
      method: "standard",
      indexScope: {
        bookId: "book-index",
        sourceId: "source-index",
        documentId: "doc-index",
        contentHash: "content-index",
        artifactIds: ["artifact-current-stage"],
      },
      skipValidation: true,
      workflows: ["load_input_documents", "create_base_text_units"],
    });

    const [record] = await readCostLedger(graphVault);
    const artifactIds = record?.artifactIds as string[];
    const requestArtifactPath = record?.metadata == null
      ? undefined
      : (record.metadata as Record<string, unknown>).requestArtifactPath;

    expect(record?.stage).toBe("graphrag_index");
    expect(record?.lineageMode).toBe("graph_artifact");
    expect(record?.bookId).toBe("book-index");
    expect(record?.sourceId).toBe("source-index");
    expect(record?.documentId).toBe("doc-index");
    expect(record?.contentHash).toBe("content-index");
    expect(record?.requestArtifactId).toBe(artifactIds[0]);
    expect(artifactIds).toContain("artifact-current-stage");
    expect(artifactIds).not.toContain(reportArtifactId);
    expect(artifactIds).not.toContain(lancedbArtifactId);
    expect(artifactIds).not.toContain("workflow-not-artifact");
    expect(artifactIds).not.toContain("cap-1");
    expect(typeof requestArtifactPath).toBe("string");
    await expectDurableRequestArtifact(graphVault, requestArtifactPath as string);
    expect(mockedBridge).toHaveBeenCalledWith(expect.objectContaining({
      command: "graphrag_index",
      request: expect.objectContaining({
        rootDir: graphVault,
        reportDir,
        method: "standard",
        skipValidation: true,
        workflows: ["load_input_documents", "create_base_text_units"],
        indexScope: expect.objectContaining({
          bookId: "book-index",
          sourceId: "source-index",
          documentId: "doc-index",
          contentHash: "content-index",
          artifactIds: ["artifact-current-stage"],
        }),
      }),
    }));
  });

  test("recovers corrupt cost ledger tail before appending provider cost records",
    async () => {
      const graphVault = await mkdtemp(join(tmpdir(), "qmd-graphrag-cost-tail-"));
      await mkdir(join(graphVault, "catalog"), { recursive: true });
      const firstRecord = buildProviderCostAccounting({
        sourceId: "source-1",
        documentId: "doc-1",
        bookId: "book-1",
        contentHash: "content-1",
        lineageMode: "graph_artifact",
        stage: "graphrag_query",
        provider: "graphrag",
        model: "local",
        requestCount: 1,
        tokenCount: 0,
        tokenCountStatus: "unknown",
        embeddingCount: 0,
        embeddingCountStatus: "unknown",
        cacheHit: false,
        runId: "run-existing",
        requestArtifactId: "request-existing",
        artifactIds: ["request-existing", "artifact-existing"],
      });
      const secondRecord = buildProviderCostAccounting({
        sourceId: "source-2",
        documentId: "doc-2",
        bookId: "book-2",
        contentHash: "content-2",
        lineageMode: "graph_artifact",
        stage: "graphrag_index",
        provider: "graphrag",
        model: "standard",
        requestCount: 1,
        tokenCount: 0,
        tokenCountStatus: "unknown",
        embeddingCount: 0,
        embeddingCountStatus: "unknown",
        cacheHit: false,
        runId: "run-new",
        requestArtifactId: "request-new",
        artifactIds: ["request-new", "artifact-new"],
      });

      await writeFile(
        join(graphVault, "catalog", "cost-accounting.jsonl"),
        `${JSON.stringify(firstRecord)}\n{"schemaVersion":`,
        "utf8",
      );

      await appendProviderCostAccounting(graphVault, secondRecord);

      const records = await readCostLedger(graphVault);
      const catalogEntries = await readdir(join(graphVault, "catalog"));
      expect(records.map((record) => record.runId)).toEqual([
        "run-existing",
        "run-new",
      ]);
      expect(catalogEntries.some((entry) =>
        entry.startsWith("cost-accounting.jsonl.corrupt-")
      )).toBe(true);
    });

  test("rejects GraphRAG index responses with workflow errors", async () => {
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-graphrag-cost-index-"));
    const reportDir = join(graphVault, "books", "book-index", "output", "reports");
    mockedBridge.mockResolvedValueOnce({
      schemaVersion: SchemaVersion,
      method: "standard",
      outputs: [{
        workflow: "load_input_documents",
        hasError: true,
        errorMessage: "Error reading documents, please see logs.",
        stateKeys: [],
      }],
    });

    await expect(runGraphRagIndex({
      rootDir: graphVault,
      reportDir,
      method: "standard",
      skipValidation: true,
      workflows: ["load_input_documents"],
    })).rejects.toThrow("GraphRAG index workflow failed");
  });
});
