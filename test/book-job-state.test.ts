import {
  access,
  mkdir,
  mkdtemp,
  rename,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import YAML from "yaml";

import {
  FileBookJobStateRepository,
  SchemaVersion,
  buildBookId,
  buildBookIdFromSourceHash,
  createDeterministicHash,
  hashFile,
  loadGraphQueryCapabilities,
  normalizeBookSlug,
  syncGraphRagBookWorkspace,
} from "../src/index.js";
import {
  DocumentIdentityMapSchema,
  SourceDocumentSchema,
} from "../src/contracts/corpus.js";
import { hashLanceDbDirectoryContents } from "../src/job-state/artifact-validation.js";

async function createFixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qmd-graphrag-book-state-"));
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

function bookScopedOutputDir(graphVault: string, bookId: string): string {
  return join(graphVault, "books", bookId, "output");
}

async function completeGraphQueryProducerStages(input: {
  repo: FileBookJobStateRepository;
  bookId: string;
  reportArtifactId: string;
  lancedbArtifactId: string;
  communityReportRunId?: string;
  embedRunId?: string;
  communityReportFingerprint?: string;
  embedFingerprint?: string;
}): Promise<void> {
  await input.repo.completeStage({
    bookId: input.bookId,
    stage: "community_report",
    runId: input.communityReportRunId ?? "run-community-report-1",
    inputFingerprint: input.communityReportFingerprint ?? "fp-community-report",
    artifactIds: [input.reportArtifactId],
  });
  await input.repo.completeStage({
    bookId: input.bookId,
    stage: "embed",
    runId: input.embedRunId ?? "run-embed-1",
    inputFingerprint: input.embedFingerprint ?? "fp-embed",
    artifactIds: [input.lancedbArtifactId],
  });
}

describe("FileBookJobStateRepository", () => {
  test("registers a book and persists catalog entry", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      expect(job.bookId).toMatch(/^book-[a-f0-9]{12}$/);
      expect(job.sourcePath).toMatch(/^sources\/book-[a-f0-9]{12}\/source\.epub$/);
      expect(job.sourcePath).not.toContain(root);
      expect(job.overallStatus).toBe("pending");

      const catalogRaw = await readFile(
        join(root, "graph_vault", "catalog", "books.yaml"),
        "utf8",
      );
      const catalog = YAML.parse(catalogRaw) as {
        schemaVersion: string;
        items: Array<{ bookId: string }>;
      };
      expect(catalog.schemaVersion).toBe(SchemaVersion);
      expect(catalog.items.map((item) => item.bookId)).toContain(job.bookId);

      const sourcesRaw = await readFile(
        join(root, "graph_vault", "catalog", "sources.yaml"),
        "utf8",
      );
      const sources = YAML.parse(sourcesRaw) as {
        items: Array<{
          sourceId: string;
          sourceHash: string;
          sourceRelativePath: string;
        }>;
      };
      expect(sources.items[0]?.sourceId).toBe(`sha256:${job.sourceHash}`);
      expect(sources.items[0]?.sourceRelativePath).toBe(job.sourcePath);
      expect(sources.items[0]?.sourceRelativePath).not.toContain(root);

      const identityRaw = await readFile(
        join(root, "graph_vault", "catalog", "document-identity-map.yaml"),
        "utf8",
      );
      const identities = YAML.parse(identityRaw) as {
        items: Array<{
          canonicalBookId: string;
          documentId: string;
          contentHash: string;
          normalizationPolicyVersion: string;
          normalizedPath?: string;
        }>;
      };
      expect(identities.items[0]?.canonicalBookId).toBe(job.bookId);
      expect(identities.items[0]?.documentId).toBe(job.documentId);
      expect(identities.items[0]?.contentHash).toBe(job.sourceHash);
      expect(identities.items[0]?.normalizationPolicyVersion).toBe(
        "graphrag-normalized-markdown-v1",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("projects graph enhancement request and state from book checkpoints", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await writeFile(join(graphVault, "input", "book.md"), "# Book", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        normalizedPath: "input/book.md",
        normalizedContentHash: "normalized-content-hash",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const request = await repo.buildGraphEnhancementRequest({
        bookId: job.bookId,
        requestId: "req-1",
        graphVault: "graph_vault",
        methods: ["local"],
      });

      expect(request.normalizedInputPath).toBe("input/book.md");
      expect(request.documentId).toBe(job.documentId);
      expect(request.methods).toEqual(["local"]);

      const outputDir = bookScopedOutputDir(graphVault, job.bookId);
      const reportsPath = join(outputDir, "community_reports.parquet");
      const lancedbPath = join(outputDir, "lancedb");
      await mkdir(outputDir, { recursive: true });
      await writeFile(reportsPath, "reports", "utf8");
      await writeCompleteLanceDbFixture(lancedbPath);
      const reportHash = await hashFile(reportsPath);
      const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);
      const artifacts = await repo.recordArtifacts(job.bookId, [
        {
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: reportsPath,
          contentHash: reportHash,
          producerRunId: "run-community-report-1",
        },
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: lancedbHash,
          producerRunId: "run-embed-1",
        },
      ]);
      await completeGraphQueryProducerStages({
        repo,
        bookId: job.bookId,
        reportArtifactId: artifacts[0]!.artifactId,
        lancedbArtifactId: artifacts[1]!.artifactId,
      });
      await repo.recordGraphTextUnitIdentity({
        schemaVersion: SchemaVersion,
        bookId: job.bookId,
        sourceId: `sha256:${job.sourceHash}`,
        sourceHash: job.sourceHash,
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        normalizedPath: "input/book.md",
        graphDocumentId: "graph-doc-1",
        graphTextUnitIds: ["tu-1"],
      });
      await repo.recordQmdCorpusRegistration({
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        collection: "books",
        relativePath: "book.md",
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "query_ready",
        runId: "run-query-ready-1",
        inputFingerprint: "fp-query-ready",
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
      });

      const state = await repo.getGraphEnhancementState(job.bookId);

      expect(state.status).toBe("succeeded");
      expect(state.artifactIds).toEqual(
        artifacts.map((artifact) => artifact.artifactId),
      );
      expect(state.capabilityIds).toContain(`${job.bookId}:graph_query`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("graph enhancement state revalidates query-ready artifacts on read", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        normalizedContentHash: "normalized-content-hash",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const outputDir = bookScopedOutputDir(graphVault, job.bookId);
      const reportsPath = join(outputDir, "community_reports.parquet");
      const lancedbPath = join(outputDir, "lancedb");
      await mkdir(outputDir, { recursive: true });
      await writeCompleteLanceDbFixture(lancedbPath);
      await writeFile(reportsPath, "reports", "utf8");
      const reportHash = await hashFile(reportsPath);
      const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);
      const artifacts = await repo.recordArtifacts(job.bookId, [
        {
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: reportsPath,
          contentHash: reportHash,
          producerRunId: "run-community-report-1",
        },
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: lancedbHash,
          producerRunId: "run-embed-1",
        },
      ]);
      await completeGraphQueryProducerStages({
        repo,
        bookId: job.bookId,
        reportArtifactId: artifacts[0]!.artifactId,
        lancedbArtifactId: artifacts[1]!.artifactId,
      });
      await repo.recordGraphTextUnitIdentity({
        schemaVersion: SchemaVersion,
        bookId: job.bookId,
        sourceId: `sha256:${job.sourceHash}`,
        sourceHash: job.sourceHash,
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        normalizedPath: "input/book.md",
        graphDocumentId: "graph-doc-1",
        graphTextUnitIds: ["tu-1"],
      });
      await repo.recordQmdCorpusRegistration({
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        collection: "books",
        relativePath: "book.md",
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "query_ready",
        runId: "run-query-ready-1",
        inputFingerprint: "fp-query-ready",
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
      });
      await unlink(
        join(lancedbPath, "entity_description.lance", "qmd_row_count.json"),
      );

      const state = await repo.getGraphEnhancementState(job.bookId);

      expect(state.status).toBe("not_ready");
      expect(state.capabilityIds).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("graph enhancement state rejects legacy query-ready without producer checkpoints", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        normalizedContentHash: "normalized-content-hash",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const outputDir = bookScopedOutputDir(graphVault, job.bookId);
      const reportsPath = join(outputDir, "community_reports.parquet");
      const lancedbPath = join(outputDir, "lancedb");
      await mkdir(outputDir, { recursive: true });
      await writeFile(reportsPath, "reports", "utf8");
      await writeCompleteLanceDbFixture(lancedbPath);
      const artifacts = await repo.recordArtifacts(job.bookId, [
        {
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: reportsPath,
          contentHash: await hashFile(reportsPath),
          producerRunId: "run-community-report-1",
        },
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: await hashLanceDbDirectoryContents(lancedbPath),
          producerRunId: "run-embed-1",
        },
      ]);
      await repo.recordGraphTextUnitIdentity({
        schemaVersion: SchemaVersion,
        bookId: job.bookId,
        sourceId: `sha256:${job.sourceHash}`,
        sourceHash: job.sourceHash,
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        normalizedPath: "input/book.md",
        graphDocumentId: "graph-doc-1",
        graphTextUnitIds: ["tu-1"],
      });
      await repo.recordQmdCorpusRegistration({
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        collection: "books",
        relativePath: "book.md",
      });
      await writeFile(
        join(graphVault, "books", job.bookId, "checkpoints.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          items: [{
            schemaVersion: SchemaVersion,
            bookId: job.bookId,
            stage: "query_ready",
            status: "succeeded",
            attemptCount: 1,
            runId: "legacy-query-ready",
            inputFingerprint: "fp-query-ready",
            contentHash: "normalized-content-hash",
            stageFingerprint: job.stageFingerprints?.query_ready,
            providerFingerprint: job.providerFingerprint,
            artifactIds: artifacts.map((artifact) => artifact.artifactId),
            finishedAt: "2026-05-21T00:00:00.000Z",
          }],
        }),
        "utf8",
      );

      const state = await repo.getGraphEnhancementState(job.bookId);

      expect(state.status).toBe("not_ready");
      expect(state.capabilityIds).toEqual([]);
      expect(await loadGraphQueryCapabilities({ graphVault })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resume plan rejects legacy query-ready without producer checkpoints", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        normalizedContentHash: "normalized-content-hash",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const outputDir = bookScopedOutputDir(graphVault, job.bookId);
      const reportsPath = join(outputDir, "community_reports.parquet");
      const lancedbPath = join(outputDir, "lancedb");
      await mkdir(outputDir, { recursive: true });
      await writeFile(reportsPath, "reports", "utf8");
      await writeCompleteLanceDbFixture(lancedbPath);
      const artifacts = await repo.recordArtifacts(job.bookId, [
        {
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: reportsPath,
          contentHash: await hashFile(reportsPath),
          producerRunId: "run-community-report-1",
        },
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: await hashLanceDbDirectoryContents(lancedbPath),
          producerRunId: "run-embed-1",
        },
      ]);
      await writeFile(
        join(graphVault, "books", job.bookId, "checkpoints.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          items: [{
            schemaVersion: SchemaVersion,
            bookId: job.bookId,
            stage: "query_ready",
            status: "succeeded",
            attemptCount: 1,
            runId: "legacy-query-ready",
            inputFingerprint: "fp-query-ready",
            contentHash: "normalized-content-hash",
            stageFingerprint: job.stageFingerprints?.query_ready,
            providerFingerprint: job.providerFingerprint,
            artifactIds: artifacts.map((artifact) => artifact.artifactId),
            finishedAt: "2026-05-21T00:00:00.000Z",
          }],
        }),
        "utf8",
      );

      const plan = await repo.getResumePlan(
        job.bookId,
        { query_ready: "fp-query-ready" },
        { query_ready: ["graphrag_community_reports_parquet", "lancedb_index"] },
      );
      const queryReady = plan.stageStates.find((item) =>
        item.stage === "query_ready"
      );

      expect(queryReady?.reason).toBe("artifact_missing");
      expect(plan.completedStages).not.toContain("query_ready");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps document identity stable when only normalized path changes", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "same source content", "utf8");

      const first = await repo.registerBookSource({
        sourcePath,
        normalizedPath: "input/edition-a/book.md",
        normalizedContentHash: "same-normalized-content",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const second = await repo.registerBookSource({
        sourcePath,
        normalizedPath: "input/edition-b/book.md",
        normalizedContentHash: "same-normalized-content",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      expect(second.bookId).toBe(first.bookId);
      expect(second.documentId).toBe(first.documentId);
      expect(first.documentId).toMatch(/^doc-[a-f0-9]{12}$/);

      const identityRaw = await readFile(
        join(root, "graph_vault", "catalog", "document-identity-map.yaml"),
        "utf8",
      );
      const identities = YAML.parse(identityRaw) as {
        items: Array<{
          sourceId: string;
          documentId: string;
          normalizedPath?: string;
        }>;
      };
      expect(identities.items).toHaveLength(1);
      expect(identities.items[0]?.documentId).toBe(first.documentId);
      expect(identities.items[0]?.normalizedPath).toBe("input/edition-b/book.md");
      expect(identities.items[0]?.aliases).toEqual(
        expect.arrayContaining([
          "input/edition-a/book.md",
          "input/edition-b/book.md",
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects non-portable normalized paths", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      await expect(repo.registerBookSource({
        sourcePath,
        normalizedPath: "../input/book.md",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      })).rejects.toThrow(/vault-relative/);
      await expect(repo.registerBookSource({
        sourcePath,
        normalizedPath: "/tmp/book.md",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      })).rejects.toThrow(/vault-relative/);
      await expect(repo.registerBookSource({
        sourcePath,
        normalizedPath: "C:\\tmp\\book.md",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      })).rejects.toThrow(/vault-relative/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects non-portable paths at the book job persistence boundary", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      await expect(repo.upsertBookJob({
        schemaVersion: SchemaVersion,
        bookId: "book-1",
        documentId: "doc-1",
        sourcePath: "/tmp/book.epub",
        sourceHash: "source-hash",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
        overallStatus: "pending",
        createdAt: "2026-05-21T00:00:00.000Z",
        updatedAt: "2026-05-21T00:00:00.000Z",
      })).rejects.toThrow(/vault-relative/);
      await expect(repo.upsertBookJob({
        schemaVersion: SchemaVersion,
        bookId: "book-1",
        documentId: "doc-1",
        sourcePath: "sources/book/source.epub",
        sourceHash: "source-hash",
        normalizedPath: "C:\\tmp\\book.md",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
        overallStatus: "pending",
        createdAt: "2026-05-21T00:00:00.000Z",
        updatedAt: "2026-05-21T00:00:00.000Z",
      })).rejects.toThrow(/vault-relative/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects non-portable public corpus catalog paths", () => {
    expect(() => SourceDocumentSchema.parse({
      schemaVersion: SchemaVersion,
      sourceId: "sha256:source",
      sourceHash: "source",
      sourceName: "book.epub",
      sourceRelativePath: "/tmp/book.epub",
    })).toThrow(/vault-relative/);
    expect(() => SourceDocumentSchema.parse({
      schemaVersion: SchemaVersion,
      sourceId: "sha256:source",
      sourceHash: "source",
      sourceName: "book.epub",
      locator: { path: "../book.epub" },
    })).toThrow(/vault-relative/);
    expect(() => SourceDocumentSchema.parse({
      schemaVersion: SchemaVersion,
      sourceId: "sha256:source",
      sourceHash: "source",
      sourceName: "book.epub",
      locator: { uri: "file:///tmp/book.epub" },
    })).toThrow();
    expect(() => DocumentIdentityMapSchema.parse({
      schemaVersion: SchemaVersion,
      sourceId: "sha256:source",
      sourceHash: "source",
      canonicalBookId: "book-1",
      documentId: "doc-1",
      contentHash: "content",
      normalizationPolicyVersion: "v1",
      normalizedPath: "C:\\tmp\\book.md",
      chunkIds: [],
    })).toThrow(/vault-relative/);
  });

  test("keeps book identity stable across device paths for identical source content", async () => {
    const root = await createFixtureDir();
    try {
      const firstRepo = new FileBookJobStateRepository(join(root, "a", "graph_vault"));
      const secondRepo = new FileBookJobStateRepository(join(root, "b", "graph_vault"));
      const firstSourcePath = join(root, "a", "book.epub");
      const secondSourcePath = join(root, "b", "book.epub");
      await mkdir(join(root, "a"), { recursive: true });
      await mkdir(join(root, "b"), { recursive: true });
      await writeFile(firstSourcePath, "fixture epub content", "utf8");
      await writeFile(secondSourcePath, "fixture epub content", "utf8");

      const first = await firstRepo.registerBookSource({
        sourcePath: firstSourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const second = await secondRepo.registerBookSource({
        sourcePath: secondSourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      expect(second.bookId).toBe(first.bookId);
      expect(second.sourceHash).toBe(first.sourceHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("content-hash book identity differs from legacy path identity", async () => {
    const sourcePath = "/vault/input/book.epub";
    const sourceHash = "abcdef1234567890";

    expect(buildBookIdFromSourceHash(sourcePath, sourceHash)).toBe("book-abcdef123456");
    expect(buildBookId(sourcePath)).not.toBe("book-abcdef123456");
  });

  test("preserves dotted author initials when deriving a book slug", () => {
    const sourceName = "A Philosophy of Software Design (John K. Ousterhout).epub";

    expect(normalizeBookSlug(sourceName)).toBe(
      "a-philosophy-of-software-design-john-k-ousterhout",
    );
    expect(buildBookIdFromSourceHash(sourceName, "9f587b71073a0000")).toBe(
      "book-9f587b71073a",
    );
  });

  test("stores a caller-provided vault-relative source path", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        canonicalSourcePath: "sources/book-123/source.epub",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      expect(job.sourcePath).toBe("sources/book-123/source.epub");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects caller-provided absolute canonical source paths", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      await expect(repo.registerBookSource({
        sourcePath,
        canonicalSourcePath: sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      })).rejects.toThrow(/vault-relative/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tracks stage progress and computes resume plan from failure point", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      const ingestFp = createDeterministicHash(["book", "ingest", 1]);
      const normalizeFp = createDeterministicHash(["book", "normalize", 1]);
      const extractFp = createDeterministicHash(["book", "graph_extract", 1]);

      await repo.startStage({
        bookId: job.bookId,
        stage: "ingest",
        runId: "run-ingest-1",
        inputFingerprint: ingestFp,
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "ingest",
        runId: "run-ingest-1",
        inputFingerprint: ingestFp,
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "normalize",
        runId: "run-normalize-1",
        inputFingerprint: normalizeFp,
      });
      await repo.failStage({
        bookId: job.bookId,
        stage: "graph_extract",
        runId: "run-extract-1",
        inputFingerprint: extractFp,
        errorSummary: "gateway 502",
      });

      const plan = await repo.getResumePlan(job.bookId, {
        ingest: ingestFp,
        normalize: normalizeFp,
        graph_extract: extractFp,
      });

      expect(plan.nextStage).toBe("graph_extract");
      expect(plan.canQuery).toBe(false);
      expect(plan.completedStages).toEqual(["ingest", "normalize"]);
      expect(
        plan.stageStates.find((item) => item.stage === "graph_extract")?.reason,
      ).toBe("failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("abandons stale running run records when a stage succeeds", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      await repo.startStage({
        bookId: job.bookId,
        stage: "embed",
        runId: "run-embed-running",
        inputFingerprint: "fp-embed-v1",
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "embed",
        runId: "run-embed-success",
        inputFingerprint: "fp-embed-v1",
      });

      const records = await repo.listRunRecords(job.bookId);
      const running = records.find((item) => item.runId === "run-embed-running");
      const success = records.find((item) => item.runId === "run-embed-success");

      expect(running?.status).toBe("abandoned");
      expect(running?.metadata?.supersededByRunId).toBe("run-embed-success");
      expect(success?.status).toBe("succeeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redacts absolute paths and secrets from checkpoint and run errors", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      await repo.failStage({
        bookId: job.bookId,
        stage: "graph_extract",
        runId: "run-extract-redacted",
        inputFingerprint: "fp-extract",
        errorSummary:
          `failed at ${root}/private/book.md with Bearer opaque-redaction-marker`,
      });

      const checkpointRaw = await readFile(
        join(graphVault, "books", job.bookId, "checkpoints.yaml"),
        "utf8",
      );
      const runRaw = await readFile(
        join(
          graphVault,
          "books",
          job.bookId,
          "runs",
          "run-extract-redacted.yaml",
        ),
        "utf8",
      );

      expect(checkpointRaw).not.toContain(root);
      expect(checkpointRaw).not.toContain("opaque-redaction-marker");
      expect(checkpointRaw).toContain("[redacted-path]");
      expect(checkpointRaw).toContain("[redacted-secret]");
      expect(runRaw).not.toContain(root);
      expect(runRaw).not.toContain("opaque-redaction-marker");
      expect(runRaw).toContain("[redacted-path]");
      expect(runRaw).toContain("[redacted-secret]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists typed checkpoint fingerprints for resumable stages", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        normalizedContentHash: "sha256:normalized-content",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
        stageFingerprints: {
          normalize: "stage-normalize-v1",
        },
        providerFingerprint: "provider-openai-responses-jina",
      });

      await repo.completeStage({
        bookId: job.bookId,
        stage: "normalize",
        runId: "run-normalize-1",
        inputFingerprint: "input-normalize-v1",
      });

      const checkpoints = await repo.listStageCheckpoints(job.bookId);
      const checkpoint = checkpoints.find((item) => item.stage === "normalize");

      expect(checkpoint?.contentHash).toBe("sha256:normalized-content");
      expect(checkpoint?.stageFingerprint).toBe("stage-normalize-v1");
      expect(checkpoint?.providerFingerprint).toBe(
        "provider-openai-responses-jina",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("marks downstream stages stale when upstream fingerprint changes", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      await repo.completeStage({
        bookId: job.bookId,
        stage: "ingest",
        runId: "run-ingest-1",
        inputFingerprint: "fp-ingest-v1",
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "normalize",
        runId: "run-normalize-1",
        inputFingerprint: "fp-normalize-v1",
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "graph_extract",
        runId: "run-extract-1",
        inputFingerprint: "fp-extract-v1",
      });

      const plan = await repo.getResumePlan(job.bookId, {
        ingest: "fp-ingest-v1",
        normalize: "fp-normalize-v2",
        graph_extract: "fp-extract-v1",
      });

      expect(plan.nextStage).toBe("normalize");
      expect(plan.staleStages).toContain("normalize");
      expect(plan.staleStages).toContain("graph_extract");
      expect(
        plan.stageStates.find((item) => item.stage === "normalize")?.reason,
      ).toBe("stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deduplicates stable artifacts across bootstrap runs", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      const artifactPath = join(root, "graph_vault", "input", "book.md");
      await mkdir(join(root, "graph_vault", "input"), { recursive: true });
      await writeFile(artifactPath, "# Book", "utf8");
      const artifactHash = await hashFile(artifactPath);
      const first = await repo.recordArtifacts(job.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: artifactPath,
          contentHash: artifactHash,
          producerRunId: "bootstrap-1",
        },
      ]);
      const second = await repo.recordArtifacts(job.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: artifactPath,
          contentHash: artifactHash,
          producerRunId: "bootstrap-2",
        },
      ]);

      expect(second[0]?.artifactId).toBe(first[0]?.artifactId);
      expect(await repo.listArtifacts(job.bookId)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deduplicates high-cost artifacts without path or run locators", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      const firstPath = join(root, "graph_vault", "output-a", "entities.parquet");
      const secondPath = join(root, "graph_vault", "output-b", "entities.parquet");
      await mkdir(join(root, "graph_vault", "output-a"), { recursive: true });
      await mkdir(join(root, "graph_vault", "output-b"), { recursive: true });
      await writeFile(firstPath, "entities", "utf8");
      await writeFile(secondPath, "entities", "utf8");
      const contentHash = await hashFile(firstPath);
      const first = await repo.recordArtifacts(job.bookId, [
        {
          stage: "graph_extract",
          kind: "graphrag_entities_parquet",
          path: firstPath,
          contentHash,
          producerRunId: "run-a",
          metadata: {
            stageFingerprint: "stage-fp",
            providerFingerprint: "provider-fp",
          },
        },
      ]);
      const second = await repo.recordArtifacts(job.bookId, [
        {
          stage: "graph_extract",
          kind: "graphrag_entities_parquet",
          path: secondPath,
          contentHash,
          producerRunId: "run-b",
          metadata: {
            stageFingerprint: "stage-fp",
            providerFingerprint: "provider-fp",
          },
        },
      ]);

      expect(second[0]?.artifactId).toBe(first[0]?.artifactId);
      expect(await repo.listArtifacts(job.bookId)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates legacy high-cost artifact fingerprints from metadata", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      await writeFile(
        join(graphVault, "books", job.bookId, "artifacts.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          items: [
            {
              schemaVersion: SchemaVersion,
              artifactId: "legacy-artifact",
              bookId: job.bookId,
              stage: "graph_extract",
              kind: "graphrag_entities_parquet",
              path: "output/entities.parquet",
              contentHash: "content-hash",
              producerRunId: "run-legacy",
              createdAt: "2026-05-22T00:00:00.000Z",
              metadata: {
                stageFingerprint: "stage-from-metadata",
                providerFingerprint: "provider-from-metadata",
              },
            },
          ],
        }),
        "utf8",
      );

      const artifacts = await repo.listArtifacts(job.bookId);

      expect(artifacts[0]?.stageFingerprint).toBe("stage-from-metadata");
      expect(artifacts[0]?.providerFingerprint).toBe("provider-from-metadata");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates legacy high-cost checkpoint fingerprints from job state", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      const job = await repo.registerBookSource({
        sourcePath,
        normalizedContentHash: "normalized-content",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
        providerFingerprint: "provider-from-job",
        stageFingerprints: {
          query_ready: "query-ready-from-job",
        },
      });

      await writeFile(
        join(graphVault, "books", job.bookId, "checkpoints.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          items: [
            {
              schemaVersion: SchemaVersion,
              bookId: job.bookId,
              stage: "query_ready",
              status: "succeeded",
              attemptCount: 1,
              runId: "run-query-ready",
              startedAt: "2026-05-22T00:00:00.000Z",
              finishedAt: "2026-05-22T00:01:00.000Z",
              inputFingerprint: "input-query-ready",
              artifactIds: ["upstream-artifact"],
            },
          ],
        }),
        "utf8",
      );

      const checkpoints = await repo.listStageCheckpoints(job.bookId);

      expect(checkpoints[0]?.contentHash).toBe("normalized-content");
      expect(checkpoints[0]?.stageFingerprint).toBe("query-ready-from-job");
      expect(checkpoints[0]?.providerFingerprint).toBe("provider-from-job");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not deduplicate high-cost artifacts across provider fingerprints", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      const artifactPath = join(root, "graph_vault", "output", "entities.parquet");
      await mkdir(join(root, "graph_vault", "output"), { recursive: true });
      await writeFile(artifactPath, "entities", "utf8");
      const contentHash = await hashFile(artifactPath);
      const first = await repo.recordArtifacts(job.bookId, [
        {
          stage: "graph_extract",
          kind: "graphrag_entities_parquet",
          path: artifactPath,
          contentHash,
          producerRunId: "run-a",
          stageFingerprint: "stage-fp",
          providerFingerprint: "provider-a",
        },
      ]);
      const second = await repo.recordArtifacts(job.bookId, [
        {
          stage: "graph_extract",
          kind: "graphrag_entities_parquet",
          path: artifactPath,
          contentHash,
          producerRunId: "run-b",
          stageFingerprint: "stage-fp",
          providerFingerprint: "provider-b",
        },
      ]);

      expect(second[0]?.artifactId).not.toBe(first[0]?.artifactId);
      expect(await repo.listArtifacts(job.bookId)).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires checkpoint artifacts to exist before a stage is resumable", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      const artifactPath = join(root, "graph_vault", "input", "book.md");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await mkdir(join(root, "graph_vault", "input"), { recursive: true });
      await writeFile(artifactPath, "# Book", "utf8");
      const artifactHash = await hashFile(artifactPath);

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      const [artifact] = await repo.recordArtifacts(job.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: artifactPath,
          contentHash: artifactHash,
          producerRunId: "run-normalize-1",
        },
      ]);
      await repo.completeStage({
        bookId: job.bookId,
        stage: "ingest",
        runId: "run-ingest-1",
        inputFingerprint: "fp-ingest-v1",
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "normalize",
        runId: "run-normalize-1",
        inputFingerprint: "fp-normalize-v1",
        artifactIds: [artifact.artifactId],
      });

      await unlink(artifactPath);

      const plan = await repo.getResumePlan(
        job.bookId,
        {
          ingest: "fp-ingest-v1",
          normalize: "fp-normalize-v1",
        },
        { normalize: ["normalized_markdown"] },
      );

      const normalizeState = plan.stageStates.find(
        (item) => item.stage === "normalize",
      );
      expect(plan.nextStage).toBe("normalize");
      expect(normalizeState?.reason).toBe("artifact_missing");
      expect(normalizeState?.missingArtifactIds).toEqual([artifact.artifactId]);
      expect(normalizeState?.missingArtifactKinds).toEqual(["normalized_markdown"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires LanceDB row-count sidecars before embed is resumable", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      const lancedbPath = join(root, "graph_vault", "output", "lancedb");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await writeCompleteLanceDbFixture(lancedbPath);
      const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const [artifact] = await repo.recordArtifacts(job.bookId, [
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: lancedbHash,
          producerRunId: "run-embed-1",
        },
      ]);
      await repo.completeStage({
        bookId: job.bookId,
        stage: "embed",
        runId: "run-embed-1",
        inputFingerprint: "fp-embed-v1",
        artifactIds: [artifact!.artifactId],
      });
      await unlink(
        join(lancedbPath, "entity_description.lance", "qmd_row_count.json"),
      );

      const plan = await repo.getResumePlan(
        job.bookId,
        { ingest: "fp-ingest-v1", embed: "fp-embed-v1" },
        { embed: ["lancedb_index"] },
      );
      const embedState = plan.stageStates.find((item) => item.stage === "embed");

      expect(embedState?.reason).toBe("artifact_missing");
      expect(embedState?.missingArtifactIds).toEqual([artifact?.artifactId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects LanceDB row-count sidecar aliases", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      const lancedbPath = join(root, "graph_vault", "output", "lancedb");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await writeCompleteLanceDbFixture(lancedbPath);
      const strictSidecar = join(
        lancedbPath,
        "entity_description.lance",
        "qmd_row_count.json",
      );
      const aliasSidecar = join(
        lancedbPath,
        "entity_description.lance",
        "row_count.json",
      );
      const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);
      await rename(strictSidecar, aliasSidecar);

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const [artifact] = await repo.recordArtifacts(job.bookId, [
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: lancedbHash,
          producerRunId: "run-embed-1",
        },
      ]);
      await repo.completeStage({
        bookId: job.bookId,
        stage: "embed",
        runId: "run-embed-1",
        inputFingerprint: "fp-embed-v1",
        artifactIds: [artifact!.artifactId],
      });

      const plan = await repo.getResumePlan(
        job.bookId,
        { embed: "fp-embed-v1" },
        { embed: ["lancedb_index"] },
      );
      const embedState = plan.stageStates.find((item) => item.stage === "embed");

      expect(embedState?.reason).toBe("artifact_missing");
      expect(embedState?.missingArtifactIds).toEqual([artifact?.artifactId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts LanceDB row-count sidecars without manifest files", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const lancedbPath = join(
        bookScopedOutputDir(graphVault, job.bookId),
        "lancedb",
      );
      await writeCompleteLanceDbFixture(lancedbPath);
      for (const tableName of [
        "entity_description.lance",
        "community_full_content.lance",
        "text_unit_text.lance",
      ]) {
        await unlink(join(lancedbPath, tableName, "_versions", "1.manifest"));
      }
      const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);
      const [artifact] = await repo.recordArtifacts(job.bookId, [
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: lancedbHash,
          producerRunId: "run-embed-1",
        },
      ]);
      await repo.completeStage({
        bookId: job.bookId,
        stage: "embed",
        runId: "run-embed-1",
        inputFingerprint: "fp-embed-v1",
        artifactIds: [artifact!.artifactId],
      });

      const plan = await repo.getResumePlan(
        job.bookId,
        { embed: "fp-embed-v1" },
        { embed: ["lancedb_index"] },
      );
      const embedState = plan.stageStates.find((item) => item.stage === "embed");

      expect(embedState?.isSatisfied).toBe(true);
      expect(embedState?.reason).toBe("ready");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps LanceDB artifact hash independent from vendor manifests", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const lancedbPath = join(
        bookScopedOutputDir(graphVault, job.bookId),
        "lancedb",
      );
      await writeCompleteLanceDbFixture(lancedbPath);
      const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);
      const [artifact] = await repo.recordArtifacts(job.bookId, [
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: lancedbHash,
          producerRunId: "run-embed-1",
        },
      ]);
      await repo.completeStage({
        bookId: job.bookId,
        stage: "embed",
        runId: "run-embed-1",
        inputFingerprint: "fp-embed-v1",
        artifactIds: [artifact!.artifactId],
      });
      await writeFile(
        join(lancedbPath, "entity_description.lance", "_versions", "1.manifest"),
        "rewritten-upstream-manifest",
        "utf8",
      );

      const plan = await repo.getResumePlan(
        job.bookId,
        { embed: "fp-embed-v1" },
        { embed: ["lancedb_index"] },
      );
      const embedState = plan.stageStates.find((item) => item.stage === "embed");

      expect(await hashLanceDbDirectoryContents(lancedbPath)).toBe(lancedbHash);
      expect(embedState?.isSatisfied).toBe(true);
      expect(embedState?.reason).toBe("ready");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires checkpoint artifact content hashes to remain valid", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      const artifactPath = join(root, "graph_vault", "input", "book.md");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await mkdir(join(root, "graph_vault", "input"), { recursive: true });
      await writeFile(artifactPath, "# Book", "utf8");
      const originalHash = await hashFile(artifactPath);

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const [artifact] = await repo.recordArtifacts(job.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: artifactPath,
          contentHash: originalHash,
          producerRunId: "run-normalize-1",
        },
      ]);
      await repo.completeStage({
        bookId: job.bookId,
        stage: "ingest",
        runId: "run-ingest-1",
        inputFingerprint: "fp-ingest-v1",
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "normalize",
        runId: "run-normalize-1",
        inputFingerprint: "fp-normalize-v1",
        artifactIds: [artifact.artifactId],
      });

      await writeFile(artifactPath, "# Book\n\nmutated", "utf8");

      const plan = await repo.getResumePlan(
        job.bookId,
        { ingest: "fp-ingest-v1", normalize: "fp-normalize-v1" },
        { normalize: ["normalized_markdown"] },
      );

      const normalizeState = plan.stageStates.find(
        (item) => item.stage === "normalize",
      );
      expect(plan.nextStage).toBe("normalize");
      expect(normalizeState?.reason).toBe("artifact_missing");
      expect(normalizeState?.missingArtifactIds).toEqual([artifact.artifactId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes graph capabilities after query-ready checkpoint validates", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        normalizedContentHash: "normalized-content-hash",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const outputDir = bookScopedOutputDir(graphVault, job.bookId);
      const reportsPath = join(outputDir, "community_reports.parquet");
      const lancedbPath = join(outputDir, "lancedb");
      await mkdir(outputDir, { recursive: true });
      await writeCompleteLanceDbFixture(lancedbPath);
      await writeFile(reportsPath, "reports", "utf8");
      const reportHash = await hashFile(reportsPath);
      const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);
      const artifacts = await repo.recordArtifacts(job.bookId, [
        {
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: reportsPath,
          contentHash: reportHash,
          producerRunId: "run-community-report-1",
        },
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: lancedbHash,
          producerRunId: "run-embed-1",
        },
      ]);
      await completeGraphQueryProducerStages({
        repo,
        bookId: job.bookId,
        reportArtifactId: artifacts[0]!.artifactId,
        lancedbArtifactId: artifacts[1]!.artifactId,
      });
      await repo.recordGraphTextUnitIdentity({
        schemaVersion: SchemaVersion,
        bookId: job.bookId,
        sourceId: `sha256:${job.sourceHash}`,
        sourceHash: job.sourceHash,
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        normalizedPath: "input/book.md",
        graphDocumentId: "graph-doc-1",
        graphTextUnitIds: ["tu-1"],
      });
      await repo.recordQmdCorpusRegistration({
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        collection: "books",
        relativePath: "book.md",
      });

      await repo.completeStage({
        bookId: job.bookId,
        stage: "query_ready",
        runId: "run-query-ready-1",
        inputFingerprint: "fp-query-ready",
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
      });

      const capabilities = await loadGraphQueryCapabilities({ graphVault });

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0]?.bookId).toBe(job.bookId);
      expect(capabilities[0]?.contentHash).toBe("normalized-content-hash");
      expect(capabilities[0]?.artifactIds).toEqual(
        artifacts.map((artifact) => artifact.artifactId),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects query-ready success checkpoint without valid artifacts", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        normalizedContentHash: "normalized-content-hash",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const outputDir = bookScopedOutputDir(graphVault, job.bookId);
      const reportsPath = join(outputDir, "community_reports.parquet");
      const lancedbPath = join(outputDir, "lancedb");
      await mkdir(outputDir, { recursive: true });
      await writeFile(reportsPath, "reports", "utf8");
      await writeCompleteLanceDbFixture(lancedbPath);
      const artifacts = await repo.recordArtifacts(job.bookId, [
        {
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: reportsPath,
          contentHash: await hashFile(reportsPath),
          producerRunId: "run-community-report-1",
        },
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: await hashLanceDbDirectoryContents(lancedbPath),
          producerRunId: "run-embed-1",
        },
      ]);
      await completeGraphQueryProducerStages({
        repo,
        bookId: job.bookId,
        reportArtifactId: artifacts[0]!.artifactId,
        lancedbArtifactId: artifacts[1]!.artifactId,
      });

      await expect(repo.completeStage({
        bookId: job.bookId,
        stage: "query_ready",
        runId: "run-query-ready-1",
        inputFingerprint: "fp-query-ready",
        artifactIds: ["missing-artifact"],
      })).rejects.toThrow(/query_ready checkpoint requires valid/);

      expect(await repo.getStageCheckpoint(job.bookId, "query_ready")).toBeNull();
      expect(await loadGraphQueryCapabilities({ graphVault })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects query-ready success checkpoint without succeeded producer stages", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        normalizedContentHash: "normalized-content-hash",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const outputDir = bookScopedOutputDir(graphVault, job.bookId);
      const reportsPath = join(outputDir, "community_reports.parquet");
      const lancedbPath = join(outputDir, "lancedb");
      await mkdir(outputDir, { recursive: true });
      await writeFile(reportsPath, "reports", "utf8");
      await writeCompleteLanceDbFixture(lancedbPath);
      const artifacts = await repo.recordArtifacts(job.bookId, [
        {
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: reportsPath,
          contentHash: await hashFile(reportsPath),
          producerRunId: "run-community-report-1",
        },
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: await hashLanceDbDirectoryContents(lancedbPath),
          producerRunId: "run-embed-1",
        },
      ]);
      await repo.startStage({
        bookId: job.bookId,
        stage: "community_report",
        runId: "run-community-report-1",
        inputFingerprint: "fp-community-report",
        artifactIds: [artifacts[0]!.artifactId],
      });
      await repo.failStage({
        bookId: job.bookId,
        stage: "embed",
        runId: "run-embed-1",
        inputFingerprint: "fp-embed",
        artifactIds: [artifacts[1]!.artifactId],
        errorSummary: "provider failed",
      });
      await repo.recordGraphTextUnitIdentity({
        schemaVersion: SchemaVersion,
        bookId: job.bookId,
        sourceId: `sha256:${job.sourceHash}`,
        sourceHash: job.sourceHash,
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        normalizedPath: "input/book.md",
        graphDocumentId: "graph-doc-1",
        graphTextUnitIds: ["tu-1"],
      });
      await repo.recordQmdCorpusRegistration({
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        collection: "books",
        relativePath: "book.md",
      });

      await expect(repo.completeStage({
        bookId: job.bookId,
        stage: "query_ready",
        runId: "run-query-ready-1",
        inputFingerprint: "fp-query-ready",
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
      })).rejects.toThrow(/completed GraphRAG producer stages/);

      expect(await repo.getStageCheckpoint(job.bookId, "query_ready")).toBeNull();
      expect(await loadGraphQueryCapabilities({ graphVault })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects query-ready checkpoint from shared GraphRAG output", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      const reportsPath = join(graphVault, "output", "community_reports.parquet");
      const lancedbPath = join(graphVault, "output", "lancedb");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await mkdir(join(graphVault, "output"), { recursive: true });
      await writeCompleteLanceDbFixture(lancedbPath);
      await writeFile(reportsPath, "reports", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        normalizedContentHash: "normalized-content-hash",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const artifacts = await repo.recordArtifacts(job.bookId, [
        {
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: reportsPath,
          contentHash: await hashFile(reportsPath),
          producerRunId: "run-community-report-1",
        },
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: await hashLanceDbDirectoryContents(lancedbPath),
          producerRunId: "run-embed-1",
        },
      ]);
      await completeGraphQueryProducerStages({
        repo,
        bookId: job.bookId,
        reportArtifactId: artifacts[0]!.artifactId,
        lancedbArtifactId: artifacts[1]!.artifactId,
      });
      await repo.recordGraphTextUnitIdentity({
        schemaVersion: SchemaVersion,
        bookId: job.bookId,
        sourceId: `sha256:${job.sourceHash}`,
        sourceHash: job.sourceHash,
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        normalizedPath: "input/book.md",
        graphDocumentId: "graph-doc-1",
        graphTextUnitIds: ["tu-1"],
      });
      await repo.recordQmdCorpusRegistration({
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        collection: "books",
        relativePath: "book.md",
      });

      await expect(repo.completeStage({
        bookId: job.bookId,
        stage: "query_ready",
        runId: "run-query-ready-1",
        inputFingerprint: "fp-query-ready",
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
      })).rejects.toThrow(/query_ready checkpoint requires valid/);

      expect(await repo.getStageCheckpoint(job.bookId, "query_ready")).toBeNull();
      expect(await loadGraphQueryCapabilities({ graphVault })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects query-ready success checkpoint without qmd corpus registration", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        normalizedContentHash: "normalized-content-hash",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const outputDir = bookScopedOutputDir(graphVault, job.bookId);
      const reportsPath = join(outputDir, "community_reports.parquet");
      const lancedbPath = join(outputDir, "lancedb");
      await mkdir(outputDir, { recursive: true });
      await writeCompleteLanceDbFixture(lancedbPath);
      await writeFile(reportsPath, "reports", "utf8");
      const reportHash = await hashFile(reportsPath);
      const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);
      const artifacts = await repo.recordArtifacts(job.bookId, [
        {
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: reportsPath,
          contentHash: reportHash,
          producerRunId: "run-community-report-1",
        },
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbPath,
          contentHash: lancedbHash,
          producerRunId: "run-embed-1",
        },
      ]);
      await completeGraphQueryProducerStages({
        repo,
        bookId: job.bookId,
        reportArtifactId: artifacts[0]!.artifactId,
        lancedbArtifactId: artifacts[1]!.artifactId,
      });
      await repo.recordGraphTextUnitIdentity({
        schemaVersion: SchemaVersion,
        bookId: job.bookId,
        sourceId: `sha256:${job.sourceHash}`,
        sourceHash: job.sourceHash,
        documentId: job.documentId,
        contentHash: "normalized-content-hash",
        normalizedPath: "input/book.md",
        graphDocumentId: "graph-doc-1",
        graphTextUnitIds: ["tu-1"],
      });

      await expect(repo.completeStage({
        bookId: job.bookId,
        stage: "query_ready",
        runId: "run-query-ready-1",
        inputFingerprint: "fp-query-ready",
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
      })).rejects.toThrow(/qmd corpus/);

      expect(await repo.getStageCheckpoint(job.bookId, "query_ready")).toBeNull();
      expect(await loadGraphQueryCapabilities({ graphVault })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sanitizes sensitive keys and absolute paths from persisted metadata", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
        metadata: {
          sourceName: "Book",
          OPENAI_API_KEY: "opaque-redaction-marker",
          workspaceRoot: root,
          nested: {
            token: "opaque-redaction-marker",
            safe: "kept",
          },
        },
      });

      await repo.startStage({
        bookId: job.bookId,
        stage: "ingest",
        runId: "run-ingest-1",
        inputFingerprint: "fp-ingest",
        metadata: {
          authorization: "Bearer redaction-sentinel",
          portable: "yes",
          localPath: root,
        },
      });

      const jobRaw = await readFile(
        join(graphVault, "books", job.bookId, "job.yaml"),
        "utf8",
      );
      const checkpointRaw = await readFile(
        join(graphVault, "books", job.bookId, "checkpoints.yaml"),
        "utf8",
      );

      expect(jobRaw).not.toContain("OPENAI_API_KEY");
      expect(jobRaw).not.toContain("opaque-redaction-marker");
      expect(jobRaw).not.toContain(root);
      expect(jobRaw).toContain("safe: kept");
      expect(checkpointRaw).not.toContain("Bearer redaction-sentinel");
      expect(checkpointRaw).not.toContain(root);
      expect(checkpointRaw).toContain("portable: yes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("single book failure does not roll back another book query capability", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourceA = join(root, "book-a.epub");
      const sourceB = join(root, "book-b.epub");
      await writeFile(sourceA, "book a content", "utf8");
      await writeFile(sourceB, "book b content", "utf8");

      const jobA = await repo.registerBookSource({
        sourcePath: sourceA,
        normalizedContentHash: "normalized-a",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const jobB = await repo.registerBookSource({
        sourcePath: sourceB,
        normalizedContentHash: "normalized-b",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      const reportsA = join(graphVault, "books", jobA.bookId, "output", "community_reports.parquet");
      const lancedbA = join(graphVault, "books", jobA.bookId, "output", "lancedb");
      await mkdir(join(graphVault, "books", jobA.bookId, "output"), {
        recursive: true,
      });
      await writeFile(reportsA, "reports-a", "utf8");
      await writeCompleteLanceDbFixture(lancedbA);
      const artifactsA = await repo.recordArtifacts(jobA.bookId, [
        {
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: reportsA,
          contentHash: await hashFile(reportsA),
          producerRunId: "run-community-report-a",
        },
        {
          stage: "embed",
          kind: "lancedb_index",
          path: lancedbA,
          contentHash: await hashLanceDbDirectoryContents(lancedbA),
          producerRunId: "run-embed-a",
        },
      ]);
      await completeGraphQueryProducerStages({
        repo,
        bookId: jobA.bookId,
        reportArtifactId: artifactsA[0]!.artifactId,
        lancedbArtifactId: artifactsA[1]!.artifactId,
        communityReportRunId: "run-community-report-a",
        embedRunId: "run-embed-a",
      });
      await repo.recordGraphTextUnitIdentity({
        schemaVersion: SchemaVersion,
        bookId: jobA.bookId,
        sourceId: `sha256:${jobA.sourceHash}`,
        sourceHash: jobA.sourceHash,
        documentId: jobA.documentId,
        contentHash: "normalized-a",
        normalizedPath: "input/book-a.md",
        graphDocumentId: "graph-doc-a",
        graphTextUnitIds: ["tu-a"],
      });
      await repo.recordQmdCorpusRegistration({
        documentId: jobA.documentId,
        contentHash: "normalized-a",
        collection: "books",
        relativePath: "book-a.md",
      });
      await repo.completeStage({
        bookId: jobA.bookId,
        stage: "query_ready",
        runId: "run-query-ready-a",
        inputFingerprint: "fp-query-ready-a",
        artifactIds: artifactsA.map((artifact) => artifact.artifactId),
      });

      const checkpointsABeforeFailure = await repo.listStageCheckpoints(jobA.bookId);
      const capabilitiesBeforeFailure = await loadGraphQueryCapabilities({ graphVault });

      await repo.completeStage({
        bookId: jobB.bookId,
        stage: "ingest",
        runId: "run-ingest-b",
        inputFingerprint: "fp-ingest-b",
      });
      await repo.failStage({
        bookId: jobB.bookId,
        stage: "embed",
        runId: "run-embed-b",
        inputFingerprint: "fp-embed-b",
        errorSummary: "provider unavailable",
      });

      const checkpointsAAfterFailure = await repo.listStageCheckpoints(jobA.bookId);
      const capabilitiesAfterFailure = await loadGraphQueryCapabilities({ graphVault });
      const planB = await repo.getResumePlan(jobB.bookId, {
        ingest: "fp-ingest-b",
        embed: "fp-embed-b",
      });

      expect(checkpointsAAfterFailure).toEqual(checkpointsABeforeFailure);
      expect(capabilitiesAfterFailure).toEqual(capabilitiesBeforeFailure);
      expect(capabilitiesAfterFailure.map((capability) => capability.bookId))
        .toEqual([jobA.bookId]);
      expect(planB.nextStage).toBe("normalize");
      expect(planB.canQuery).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates legacy path book state to portable content identity", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      const artifactPath = join(root, "graph_vault", "input", "book.md");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await mkdir(join(root, "graph_vault", "input"), { recursive: true });
      await writeFile(artifactPath, "# Book", "utf8");
      const artifactHash = await hashFile(artifactPath);

      const stableJob = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const [stableArtifact] = await repo.recordArtifacts(stableJob.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: artifactPath,
          contentHash: artifactHash,
          producerRunId: "run-normalize-1",
        },
      ]);
      await repo.completeStage({
        bookId: stableJob.bookId,
        stage: "normalize",
        runId: "run-normalize-1",
        inputFingerprint: "fp-normalize-v1",
        artifactIds: [stableArtifact.artifactId],
      });

      const legacyBookId = buildBookId(sourcePath);
      await rename(
        join(root, "graph_vault", "books", stableJob.bookId),
        join(root, "graph_vault", "books", legacyBookId),
      );
      const legacyArtifacts = (await readFile(
        join(root, "graph_vault", "books", legacyBookId, "artifacts.yaml"),
        "utf8",
      )).split(stableJob.bookId).join(legacyBookId);
      await writeFile(
        join(root, "graph_vault", "books", legacyBookId, "artifacts.yaml"),
        legacyArtifacts,
        "utf8",
      );
      const legacyCheckpoints = (await readFile(
        join(root, "graph_vault", "books", legacyBookId, "checkpoints.yaml"),
        "utf8",
      )).split(stableJob.bookId).join(legacyBookId);
      await writeFile(
        join(root, "graph_vault", "books", legacyBookId, "checkpoints.yaml"),
        legacyCheckpoints,
        "utf8",
      );
      const legacyJob = (await readFile(
        join(root, "graph_vault", "books", legacyBookId, "job.yaml"),
        "utf8",
      )).split(stableJob.bookId).join(legacyBookId);
      await writeFile(
        join(root, "graph_vault", "books", legacyBookId, "job.yaml"),
        legacyJob,
        "utf8",
      );

      const migratedJob = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const [migratedArtifact] = await repo.listArtifacts(migratedJob.bookId);
      const [migratedCheckpoint] = await repo.listStageCheckpoints(
        migratedJob.bookId,
      );

      expect(migratedJob.bookId).toBe(stableJob.bookId);
      expect(migratedArtifact?.bookId).toBe(stableJob.bookId);
      expect(migratedArtifact?.artifactId).toBe(stableArtifact.artifactId);
      expect(migratedCheckpoint?.bookId).toBe(stableJob.bookId);
      expect(migratedCheckpoint?.artifactIds).toEqual([stableArtifact.artifactId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("merges duplicate legacy book directory when stable directory exists", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourceName = "A Philosophy of Software Design (John K. Ousterhout).epub";
      const sourcePath = join(root, sourceName);
      const stableArtifactPath = join(graphVault, "input", "stable.md");
      const legacyArtifactPath = join(graphVault, "input", "legacy.md");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await writeFile(stableArtifactPath, "# Stable", "utf8");
      await writeFile(legacyArtifactPath, "# Legacy", "utf8");

      const stableJob = await repo.registerBookSource({
        sourcePath,
        sourceIdentityPath: sourceName,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const legacyBookId = `a-philosophy-of-software-design-john-k-ousterhout-${
        stableJob.sourceHash.slice(0, 12)
      }`;
      const [stableArtifact] = await repo.recordArtifacts(stableJob.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: stableArtifactPath,
          contentHash: await hashFile(stableArtifactPath),
          producerRunId: "run-stable",
        },
      ]);
      await repo.completeStage({
        bookId: stableJob.bookId,
        stage: "normalize",
        runId: "run-stable",
        inputFingerprint: "fp-stable",
        artifactIds: [stableArtifact.artifactId],
      });

      await mkdir(join(graphVault, "books", legacyBookId, "runs"), {
        recursive: true,
      });
      await mkdir(join(graphVault, "sources", legacyBookId), { recursive: true });
      await writeFile(
        join(graphVault, "sources", legacyBookId, "source.epub"),
        "fixture epub content",
        "utf8",
      );
      await writeFile(
        join(graphVault, "books", legacyBookId, "job.yaml"),
        YAML.stringify({
          ...stableJob,
          bookId: legacyBookId,
          sourcePath: `sources/${legacyBookId}/source.epub`,
        }),
        "utf8",
      );
      await writeFile(
        join(graphVault, "books", legacyBookId, "artifacts.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          items: [
            {
              schemaVersion: SchemaVersion,
              artifactId: "legacy-artifact",
              bookId: legacyBookId,
              stage: "graph_extract",
              kind: "graphrag_documents_parquet",
              path: "input/legacy.md",
              contentHash: await hashFile(legacyArtifactPath),
              producerRunId: "run-legacy",
              createdAt: "2026-05-21T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );
      await writeFile(
        join(graphVault, "books", legacyBookId, "checkpoints.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          items: [
            {
              schemaVersion: SchemaVersion,
              bookId: legacyBookId,
              stage: "graph_extract",
              status: "succeeded",
              attemptCount: 1,
              runId: "run-legacy",
              startedAt: "2026-05-21T00:00:00.000Z",
              finishedAt: "2026-05-21T00:01:00.000Z",
              inputFingerprint: "fp-legacy",
              artifactIds: ["legacy-artifact"],
            },
          ],
        }),
        "utf8",
      );
      await writeFile(
        join(graphVault, "books", legacyBookId, "runs", "run-legacy.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          runId: "run-legacy",
          bookId: legacyBookId,
          stage: "graph_extract",
          status: "succeeded",
          attemptCount: 1,
          startedAt: "2026-05-21T00:00:00.000Z",
          finishedAt: "2026-05-21T00:01:00.000Z",
          inputFingerprint: "fp-legacy",
          artifactIds: ["legacy-artifact"],
        }),
        "utf8",
      );

      const migratedJob = await repo.registerBookSource({
        sourcePath,
        sourceIdentityPath: sourceName,
        configFingerprint: "cfg-2",
        promptFingerprint: "prompt-2",
        modelFingerprint: "model-2",
      });
      const artifacts = await repo.listArtifacts(stableJob.bookId);
      const checkpoints = await repo.listStageCheckpoints(stableJob.bookId);
      const books = YAML.parse(await readFile(
        join(graphVault, "catalog", "books.yaml"),
        "utf8",
      )) as { items: Array<{ bookId: string }> };
      const legacyRun = YAML.parse(await readFile(
        join(graphVault, "books", stableJob.bookId, "runs", "run-legacy.yaml"),
        "utf8",
      )) as { bookId: string; artifactIds: string[] };

      expect(migratedJob.bookId).toBe(stableJob.bookId);
      expect(books.items.map((item) => item.bookId)).toEqual([stableJob.bookId]);
      expect(artifacts.map((item) => item.bookId)).toEqual([
        stableJob.bookId,
        stableJob.bookId,
      ]);
      expect(artifacts.some((item) => item.stage === "graph_extract")).toBe(true);
      expect(checkpoints.map((item) => item.bookId)).toEqual([
        stableJob.bookId,
        stableJob.bookId,
      ]);
      expect(legacyRun.bookId).toBe(stableJob.bookId);
      expect(legacyRun.artifactIds[0]).not.toBe("legacy-artifact");
      await expect(access(join(graphVault, "books", legacyBookId))).rejects
        .toThrow();
      await expect(access(join(graphVault, "sources", legacyBookId))).rejects
        .toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("discovers same-source legacy directory even when catalog is canonical", async () => {
    const root = await createFixtureDir();
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "source.epub");
      const legacyArtifactPath = join(graphVault, "input", "legacy.md");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await writeFile(legacyArtifactPath, "# Legacy", "utf8");

      const stableJob = await repo.registerBookSource({
        sourcePath,
        sourceIdentityPath: "source.epub",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const legacyBookId = `a-philosophy-of-software-design-john-k-ousterhout-${
        stableJob.sourceHash.slice(0, 12)
      }`;
      await mkdir(join(graphVault, "books", legacyBookId, "runs"), {
        recursive: true,
      });
      await writeFile(
        join(graphVault, "books", legacyBookId, "job.yaml"),
        YAML.stringify({
          ...stableJob,
          bookId: legacyBookId,
          sourcePath: `sources/${legacyBookId}/source.epub`,
        }),
        "utf8",
      );
      await writeFile(
        join(graphVault, "books", legacyBookId, "artifacts.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          items: [
            {
              schemaVersion: SchemaVersion,
              artifactId: "legacy-artifact",
              bookId: legacyBookId,
              stage: "normalize",
              kind: "normalized_markdown",
              path: "input/legacy.md",
              contentHash: await hashFile(legacyArtifactPath),
              producerRunId: "run-legacy",
              createdAt: "2026-05-21T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );
      await writeFile(
        join(graphVault, "books", legacyBookId, "checkpoints.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          items: [
            {
              schemaVersion: SchemaVersion,
              bookId: legacyBookId,
              stage: "normalize",
              status: "succeeded",
              attemptCount: 1,
              runId: "run-legacy",
              startedAt: "2026-05-21T00:00:00.000Z",
              finishedAt: "2026-05-21T00:01:00.000Z",
              inputFingerprint: "fp-legacy",
              artifactIds: ["legacy-artifact"],
            },
          ],
        }),
        "utf8",
      );

      await repo.registerBookSource({
        sourcePath,
        sourceIdentityPath: "source.epub",
        configFingerprint: "cfg-2",
        promptFingerprint: "prompt-2",
        modelFingerprint: "model-2",
      });
      const artifacts = await repo.listArtifacts(stableJob.bookId);
      const checkpoints = await repo.listStageCheckpoints(stableJob.bookId);

      expect(artifacts.some((item) => item.kind === "normalized_markdown"))
        .toBe(true);
      expect(checkpoints.some((item) => item.runId === "run-legacy")).toBe(true);
      await expect(access(join(graphVault, "books", legacyBookId))).rejects
        .toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates truncated dotted-name book state to full source identity", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourceName = "A Philosophy of Software Design (John K. Ousterhout).epub";
      const sourcePath = join(root, sourceName);
      const artifactPath = join(root, "graph_vault", "input", "book.md");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await mkdir(join(root, "graph_vault", "input"), { recursive: true });
      await writeFile(artifactPath, "# Book", "utf8");
      const artifactHash = await hashFile(artifactPath);

      const stableJob = await repo.registerBookSource({
        sourcePath,
        sourceIdentityPath: sourceName,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const [stableArtifact] = await repo.recordArtifacts(stableJob.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: artifactPath,
          contentHash: artifactHash,
          producerRunId: "run-normalize-1",
        },
      ]);

      const truncatedBookId = buildBookIdFromSourceHash(
        "A Philosophy of Software Design (John K",
        stableJob.sourceHash,
      );
      await rename(
        join(root, "graph_vault", "books", stableJob.bookId),
        join(root, "graph_vault", "books", truncatedBookId),
      );
      for (const fileName of ["artifacts.yaml", "job.yaml"]) {
        const filePath = join(root, "graph_vault", "books", truncatedBookId, fileName);
        const raw = (await readFile(filePath, "utf8"))
          .split(stableJob.bookId)
          .join(truncatedBookId);
        await writeFile(filePath, raw, "utf8");
      }

      const migratedJob = await repo.registerBookSource({
        sourcePath,
        sourceIdentityPath: sourceName,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const [migratedArtifact] = await repo.listArtifacts(migratedJob.bookId);

      expect(migratedJob.bookId).toBe(stableJob.bookId);
      expect(migratedArtifact?.bookId).toBe(stableJob.bookId);
      expect(migratedArtifact?.artifactId).toBe(stableArtifact.artifactId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
