import { describe, expect, test } from "vitest";
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from "fs/promises";
import {
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { hostname, tmpdir } from "os";
import { dirname, join, relative, sep } from "path";
import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { createHash } from "crypto";
import YAML from "yaml";
import { SchemaVersion } from "../src/contracts/common.ts";
import {
  batchBookId,
  classifyFailure,
  durablePrimaryJsonEntries,
  expectDurableSubprocessEnvelopeIncomplete,
  graphArtifactManifests,
  mkProjectTmpDir,
  passedBatchCommandChecks,
  projectRoot,
  requiredBatchCommandCheckNames,
  runBatchMigrateOnly,
  runBatchStatusJson,
  runBatchWorkflow,
  runParallelRunnerFixture,
  sanitizeVaultText,
  stableJsonHash,
  stableTextHash,
  waitForFile,
  writeCompletedGraphBatchFixture,
  writeDurableJsonFixture,
  writeDurableTextFixture,
  writeDurableYamlFixture,
  writeGraphRagPromptFixtures,
  writeCompleteLanceDbFixture,
  writeMinimalEpubFixture,
  writeMinimalParquetFixture,
  writeProviderAuthReopenGraphFixture,
  writeProviderAuthStoppedBatchFixture,
  writeQmdBuildFixture,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG EPUB batch runner - Redaction", () => {
  test("status-json reopens completed non-transient failed checks with valid schema", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-nontransient-reopen-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "nontransient-reopen-fixture";
    const commandChecks = passedBatchCommandChecks().map((check) =>
      check.name === "qmd-search-json"
        ? {
            ...check,
            status: "failed",
            exitCode: 1,
            stderrBytes: 64,
            failureKind: "permanent",
            retryable: false,
            attemptExhausted: true,
            recoveryDecision: "stop_until_fixed",
            errorSummary: "search output contract mismatch",
          }
        : check
    );
    await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "completed with non-transient failed check",
      commandChecks,
    });

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("continue_pending");
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "permanent",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
      failedStage: "qmd-search-json",
      qmdBuildStatus: {
        status: "succeeded",
        stage: "qmd-build",
      },
      commandCheckStatus: {
        status: "failed",
        stage: "qmd-search-json",
        reason: "command_check_failed",
      },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
      graphQueryStatus: { status: "succeeded" },
    });
    expect(summary.items[0].retryExhausted).toBeUndefined();
  });

  test("status-json reopens completed items with stale GraphRAG producer lineage", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-stale-producer-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "stale-producer-fixture";
    const sourceBytes = "completed with stale graph evidence";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const outputRel = join("books", bookId, "output");
    const outputDir = join(stateRoot, outputRel);
    const documentId = `doc-${sourceHash.slice(0, 12)}`;
    const contentHash = sourceHash;
    const stageFingerprints = {
      ingest: "fp-ingest",
      normalize: "fp-normalize",
      graph_extract: "fp-graph-extract",
      community_report: "fp-community-report",
      embed: "fp-embed",
      query_ready: "fp-query-ready",
    };
    const providerFingerprint = "provider-fp";
    const artifactIds = {
      documents: `${bookId}:graph_extract:documents`,
      textUnits: `${bookId}:graph_extract:text_units`,
      entities: `${bookId}:graph_extract:entities`,
      relationships: `${bookId}:graph_extract:relationships`,
      communities: `${bookId}:graph_extract:communities`,
      context: `${bookId}:graph_extract:context`,
      stats: `${bookId}:graph_extract:stats`,
      reports: `${bookId}:community_report:reports`,
      lancedb: `${bookId}:embed:lancedb`,
    };
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const normalizedPath = join(stateRoot, "input", "book.md");
    await writeQmdBuildFixture({
      tmpRoot,
      stateRoot,
      configDir,
      runId,
      itemId,
      bookId,
      sourceRelativePath,
      sourceHash,
      normalizedPath,
    });
    for (const name of [
      "documents.parquet", "text_units.parquet", "entities.parquet",
      "relationships.parquet", "communities.parquet", "community_reports.parquet",
    ]) {
      await writeMinimalParquetFixture(join(outputDir, name));
    }
    await writeDurableJsonFixture(join(outputDir, "context.json"), {});
    await writeDurableJsonFixture(join(outputDir, "stats.json"), {});
    await writeCompleteLanceDbFixture(join(outputDir, "lancedb"));
    const graphArtifacts = await graphArtifactManifests({
      outputDir,
      outputRel,
      bookId,
      artifactIds,
      stageFingerprints,
      providerFingerprint,
      corpusContentHash: contentHash,
    }).then((items) => items.map((artifact) =>
      artifact.artifactId === artifactIds.reports
        ? { ...artifact, producerRunId: "wrong-community-report-run" }
        : artifact
    ));
    await writeDurableJsonFixture(
      join(outputDir, "qmd_output_manifest.json"),
      {
        schemaVersion: SchemaVersion,
        bookId,
        sourceHash,
        documentId,
        contentHash,
        stageFingerprints,
        providerFingerprint,
        outputDir: outputDir,
        producerRunId: "run-query-ready",
        stageProducerRunIds: {
          graph_extract: "run-graph-extract",
          community_report: "run-community-report",
          embed: "run-embed",
        },
      },
    );
    await mkdir(join(stateRoot, "books", bookId), { recursive: true });
    await mkdir(join(stateRoot, "catalog"), { recursive: true });
    await writeDurableYamlFixture(
      join(stateRoot, "catalog", "books.yaml"),
      {
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          bookId,
          documentId,
          sourcePath: `sources/${bookId}/source.epub`,
          sourceHash,
          metadata: { sourceIdentityPath: sourceRelativePath },
          normalizedContentHash: contentHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          configFingerprint: "config-fp",
          promptFingerprint: "prompt-fp",
          modelFingerprint: "model-fp",
          stageFingerprints,
          providerFingerprint,
          overallStatus: "succeeded",
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:01.000Z",
        }],
      },
    );
    await writeDurableYamlFixture(
      join(stateRoot, "books", bookId, "artifacts.yaml"),
      { schemaVersion: SchemaVersion, items: graphArtifacts },
    );
    await writeDurableYamlFixture(
      join(stateRoot, "books", bookId, "checkpoints.yaml"),
      {
        schemaVersion: SchemaVersion,
        items: [
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "graph_extract",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-graph-extract",
            inputFingerprint: "fp-graph-extract",
            contentHash,
            stageFingerprint: "fp-graph-extract",
            providerFingerprint,
            artifactIds: [
              artifactIds.documents, artifactIds.textUnits, artifactIds.entities,
              artifactIds.relationships, artifactIds.communities,
              artifactIds.context, artifactIds.stats,
            ],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "community_report",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-community-report",
            inputFingerprint: "fp-community-report",
            contentHash,
            stageFingerprint: "fp-community-report",
            providerFingerprint,
            artifactIds: [artifactIds.reports],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "embed",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-embed",
            inputFingerprint: "fp-embed",
            contentHash,
            stageFingerprint: "fp-embed",
            providerFingerprint,
            artifactIds: [artifactIds.lancedb],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "query_ready",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-query-ready",
            inputFingerprint: "fp-query-ready",
            contentHash,
            stageFingerprint: "fp-query-ready",
            providerFingerprint,
            artifactIds: [artifactIds.reports, artifactIds.lancedb],
          },
        ],
      },
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      },
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "completed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: relative(projectRoot, normalizedPath),
        bookId,
        attempts: 1,
        qmdBuildStatus: { status: "succeeded" },
        commandChecks: passedBatchCommandChecks(),
      },
    );

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--status-json",
        ]);
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventsExist = existsSync(eventLogPath);
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("continue_pending");
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      qmdBuildStatus: { status: "succeeded" },
      graphBuildStatus: {
        status: "stale",
        stage: "community_report",
      },
    });
    expect(summary.items[0].graphBuildStatus.reason).toMatch(
      /stage_artifact_producer_run_mismatch:community_report/u,
    );
    expect(checkpoint.status).toBe("completed");
    expect(eventsExist).toBe(false);
  });

  test("keeps checkpoints unique for duplicate EPUB content", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-duplicate-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "duplicate-fixture";
    const sourceBytes = "same content";
    const { createHash } = await import("crypto");
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(sourceDir, "A.epub"), sourceBytes);
    await writeFile(join(sourceDir, "B.epub"), sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const completedManifest = join(tmpRoot, "completed.json");
    await writeFile(
      completedManifest,
      JSON.stringify([
        { source: "A.epub", sourceHash },
        { source: "B.epub", sourceHash },
      ]),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--completed-manifest",
          completedManifest,
          "--run-id",
          runId,
          "--skip-dotenv",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const batchRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const itemRoot = join(batchRoot, "items");
    const manifest = JSON.parse(readFileSync(join(batchRoot, "manifest.json"), "utf8"));
    const checkpoints = durablePrimaryJsonEntries(itemRoot).sort();
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(manifest).toMatchObject({
      status: "failed",
      totalItems: 2,
      pendingItems: 0,
      runningItems: 0,
      completedItems: 0,
      skippedItems: 0,
      importedCompletedItems: 2,
      failedItems: 2,
      expectedCommandCheckCount: 27,
    });
    expect(checkpoints).toHaveLength(2);
    expect(new Set(checkpoints).size).toBe(2);
  });
  test("redacts exact environment values from preflight errors", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "qmd-batch-redact-"));
    const sourceDir = join(tmpRoot, "empty-source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const secretBase = join(tmpRoot, "secret-config-path");
    await mkdir(sourceDir, { recursive: true });
    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          join(tmpRoot, "logs"),
          "--config",
          secretBase,
          "--skip-dotenv",
        ], {
          env: {
            ...process.env,
            OPENAI_BASE_URL: secretBase,
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain(secretBase);
    expect(result.stderr).toContain("[REDACTED:OPENAI_BASE_URL]");
  });

  test("redacts URL credentials from batch logs and recovery summaries", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-url-redact-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "url-redact-fixture";
    const sourceBytes = "url secret redaction";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const leakedUrl =
      "https://gateway.example/responses?api_key=url-secret&token=tok-secret&safe=ok";
    const manifestPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "manifest.json",
    );
    const itemPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );
    await writeDurableJsonFixture(
      manifestPath,
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      },
    );
    await writeDurableJsonFixture(
      itemPath,
      {
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:01:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "qmd-query-graphrag-json",
        errorSummary: `provider leaked ${leakedUrl}`,
        commandChecks: [{
          name: "qmd-query-graphrag-json",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 12,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "permanent",
          retryable: false,
          errorSummary: `stderr ${leakedUrl}`,
        }],
      },
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        itemId,
        event: "command_failed",
        command: "qmd-query-graphrag-json",
        at: "2026-05-23T00:01:00.000Z",
        message: `event ${leakedUrl}`,
        metadata: { requestUrl: leakedUrl },
      }) + "\n",
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--migrate-only",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const eventRaw = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    );
    const summaryRaw = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    );
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stderr).not.toContain("url-secret");
    expect(result.stderr).not.toContain("tok-secret");
    for (const raw of [eventRaw, summaryRaw]) {
      expect(raw).not.toContain("url-secret");
      expect(raw).not.toContain("tok-secret");
      expect(raw).toContain("api_key=[REDACTED]");
      expect(raw).toContain("token=[REDACTED]");
      expect(raw).toContain("safe=ok");
    }
  });

  test("sanitizes vault text secrets, urls, and absolute paths", () => {
    const previous = process.env.QMD_TEST_BASE_URL;
    process.env.QMD_TEST_BASE_URL = "https://secret-gateway.example/responses";
    try {
      const input = [
        "bearer sk-test-secret",
        "https://secret-gateway.example/responses",
        "https://public-gateway.example/responses",
        "/Users/jin/projects/qmd_graphrag/.env",
        "C:\\Users\\jin\\secret.env",
      ].join(" ");
      const sanitized = sanitizeVaultText(input) ?? "";
      expect(sanitized).toContain("[redacted-secret]");
      expect(sanitized).toContain("[redacted-url]");
      expect(sanitized).toContain("[redacted-path]");
      expect(sanitized).not.toContain("secret-gateway");
      expect(sanitized).not.toContain("/Users/jin");
      expect(sanitized).not.toContain("C:\\Users");
      expect(sanitized).not.toContain("sk-test-secret");
    } finally {
      if (previous == null) {
        delete process.env.QMD_TEST_BASE_URL;
      } else {
        process.env.QMD_TEST_BASE_URL = previous;
      }
    }
  });
});
