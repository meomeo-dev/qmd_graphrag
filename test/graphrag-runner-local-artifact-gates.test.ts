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
  writeMinimalEpubFixture,
  writeQmdBuildFixture,
  writeProviderAuthReopenGraphFixture,
  writeProviderAuthStoppedBatchFixture,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG EPUB batch runner - Local Artifact Gates", () => {
  test("status-json recovers legacy bare output-none with adapter log evidence", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-legacy-output-none-log-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "legacy-responses-output-none-log";
    const sourceBytes = "legacy responses output none log";
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
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const errorSummary =
      "Error: GraphRAG index workflow failed: " +
      "[{\"workflow\":\"extract_graph\",\"errorMessage\":\"'NoneType' object " +
      "is not iterable\"}]";
    await mkdir(join(logRoot, "graphrag-reports", bookId, "graph_extract"), {
      recursive: true,
    });
    await writeFile(
      join(logRoot, "graphrag-reports", bookId, "graph_extract", "indexing-engine.log"),
      [
        "Traceback (most recent call last):",
        "  File \"python/qmd_graphrag/graphrag_responses_completion.py\", " +
          "line 584, in _collect_response_stream_async",
        "    final_text = _completed_response_output_text(completed_response)",
        "  File \"python/qmd_graphrag/graphrag_responses_completion.py\", " +
          "line 515, in _completed_response_output_text",
        "    return str(getattr(response, \"output_text\", \"\") or \"\")",
        "  File \".venv-graphrag/lib/python3.13/site-packages/openai/types/" +
          "responses/response.py\", line 316, in output_text",
        "    for output in self.output:",
        "TypeError: 'NoneType' object is not iterable",
      ].join("\n"),
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
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
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 3,
        retryStartedAt: "2026-05-23T00:00:00.000Z",
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "unknown",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary,
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 12,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: errorSummary.length,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:10:00.000Z",
          failureKind: "unknown",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary,
        }],
      },
    );

    const result = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
      args: ["--skip-dotenv"],
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      failedStage: "resume-book-1",
      waitingForProviderRecovery: true,
      providerRecoveryWaitCount: 1,
      maxProviderRecoveryWaits: 3,
      providerRecoveryReason: "responses_output_none",
    });
  });

  test("status-json recovers GraphRAG query provider_unavailable as provider transient", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-graphrag-query-provider-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "graphrag-query-provider-unavailable";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourcePath = join(sourceDir, "Book.epub");
    const secondPath = join(sourceDir, "Second.epub");
    const sourceBytes = "graph query provider unavailable";
    const secondBytes = "pending after graph query provider unavailable";
    await writeFile(sourcePath, sourceBytes);
    await writeFile(secondPath, secondBytes);
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const secondHash = createHash("sha256").update(secondBytes).digest("hex");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const secondRelativePath = relative(projectRoot, secondPath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const secondItemId = `item-${secondHash.slice(0, 12)}-${
      createHash("sha256").update(secondRelativePath).digest("hex").slice(0, 8)
    }`;
    const bookId = batchBookId(sourceHash, sourceRelativePath);
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
    await writeProviderAuthReopenGraphFixture({ stateRoot, bookId, sourceHash });
    const errorSummary = JSON.stringify({
      schemaVersion: "1.0.0",
      route: "graphrag",
      stage: "graphrag_query",
      provider: "graphrag",
      capability: "graph_query",
      code: "provider_unavailable",
      retryable: false,
      redactedMessage:
        "GraphRAG query provider failed before returning a response.",
    }, null, 2);
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 2,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId, secondItemId],
      },
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: relative(projectRoot, normalizedPath),
        bookId,
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "unknown",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "qmd-query-graphrag-json",
        errorSummary,
        metadata: { waitingForProviderRecovery: false },
        commandChecks: [{
          name: "qmd-query-graphrag-json",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: errorSummary.length,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          retryDelaySeconds: 31,
          failureKind: "unknown",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary,
        }],
      },
    );

    const result = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
      args: ["--skip-dotenv"],
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    const recovered = summary.items.find((item: { itemId: string }) =>
      item.itemId === itemId
    );
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.retryableItemCount).toBe(1);
    expect(summary.manifest).toMatchObject({
      pendingItems: 2,
      completedItems: 0,
      failedItems: 0,
    });
    expect(recovered).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      failedStage: "qmd-query-graphrag-json",
      waitingForProviderRecovery: true,
      providerRecoveryWaitCount: 1,
      maxProviderRecoveryWaits: 3,
      providerRecoveryReason: expect.any(String),
      qmdBuildStatus: { status: "succeeded", bookId },
      commandCheckStatus: {
        status: "failed",
        stage: "qmd-query-graphrag-json",
      },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
      graphQueryStatus: {
        status: "failed",
        stage: "qmd-query-graphrag-json",
      },
    });
    expect(recovered.nextRetryAt).toEqual(expect.any(String));
    expect(recovered.retryDelaySeconds).toBeGreaterThan(0);
    expect(recovered.errorSummary).toContain("\"code\": \"provider_unavailable\"");
  });

  test("status-json marks local GraphRAG artifact gate failures resumable", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-artifact-gap-local-gate-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "artifact-gap-local-gate";
    const sourceBytes = "artifact gap local gate";
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
    const errorSummary =
      "GraphRAG stage did not produce valid book-scoped artifacts: " +
      JSON.stringify({
        bookId: batchBookId(sourceHash, sourceRelativePath),
        stage: "graph_extract",
        missingArtifactKinds: [
          "graphrag_documents_parquet",
          "graphrag_text_units_parquet",
        ],
      });
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
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
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 4,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary,
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 12,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "permanent",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary,
        }],
      },
    );

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
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("continue_pending");
    expect(summary.retryableItemCount).toBe(0);
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      failureKind: "permanent",
      retryable: false,
      retryExhausted: true,
      recoveryDecision: "stop_until_fixed",
      waitingForProviderRecovery: false,
    });
  });

  test("normal run stops repair-only when local artifact gate is blocked", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-repair-blocked-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "repair-blocked";
    const blockedBytes = "repair blocked local gate";
    const repairedBytes = "repair repaired local gate";
    const blockedHash = createHash("sha256").update(blockedBytes).digest("hex");
    const repairedHash = createHash("sha256").update(repairedBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const repairedSourcePath = join(sourceDir, "A-Repaired.epub");
    const blockedSourcePath = join(sourceDir, "B-Blocked.epub");
    await writeFile(blockedSourcePath, blockedBytes);
    await writeFile(repairedSourcePath, repairedBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const blockedRelativePath = relative(projectRoot, blockedSourcePath);
    const repairedRelativePath = relative(projectRoot, repairedSourcePath);
    const blockedItemId = `item-${blockedHash.slice(0, 12)}-${
      createHash("sha256").update(blockedRelativePath).digest("hex").slice(0, 8)
    }`;
    const repairedItemId = `item-${repairedHash.slice(0, 12)}-${
      createHash("sha256").update(repairedRelativePath).digest("hex").slice(0, 8)
    }`;
    const blockedErrorSummary =
      "GraphRAG stage did not produce valid book-scoped artifacts: " +
      JSON.stringify({
        bookId: batchBookId(blockedHash, blockedRelativePath),
        stage: "graph_extract",
        missingArtifactKinds: ["graphrag_documents_parquet"],
      });
    const repairedErrorSummary =
      "GraphRAG stage did not produce valid book-scoped artifacts: " +
      JSON.stringify({
        bookId: batchBookId(repairedHash, repairedRelativePath),
        stage: "graph_extract",
        missingArtifactKinds: ["graphrag_documents_parquet"],
      });
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 2,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 2,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [blockedItemId, repairedItemId],
      },
    );
    await writeDurableJsonFixture(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${blockedItemId}.json`,
      ),
      {
        schemaVersion: SchemaVersion,
        itemId: blockedItemId,
        runId,
        status: "failed",
        sourceName: "B-Blocked.epub",
        sourceRelativePath: blockedRelativePath,
        sourceIdentityPath: blockedRelativePath,
        sourceHash: blockedHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(blockedHash, blockedRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: blockedErrorSummary,
        commandChecks: [],
        metadata: {
          localArtifactGateRepairCompleted: true,
        },
      },
    );
    await writeDurableJsonFixture(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${repairedItemId}.json`,
      ),
      {
        schemaVersion: SchemaVersion,
        itemId: repairedItemId,
        runId,
        status: "failed",
        sourceName: "A-Repaired.epub",
        sourceRelativePath: repairedRelativePath,
        sourceIdentityPath: repairedRelativePath,
        sourceHash: repairedHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book-2.md"),
        bookId: batchBookId(repairedHash, repairedRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: repairedErrorSummary,
        commandChecks: [],
        metadata: {
          localArtifactGateRepairBlocked: true,
          localArtifactGateRepairBlockedReason: "old blocked reason",
        },
      },
    );
    const resumeScript = join(
      tmpRoot,
      "scripts",
      "graphrag",
      "resume-book-workspace.mjs",
    );
    await mkdir(dirname(resumeScript), { recursive: true });
    await writeFile(
      resumeScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { basename } from 'node:path';",
        "const sourceIndex = process.argv.indexOf('--source-path');",
        "const sourcePath = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : '';",
        "const sourceName = basename(sourcePath);",
        "const marker = process.env.QMD_FAKE_RESUME_MARKER;",
        "const isRepairOnly = process.argv.includes('--repair-local-artifact-gate-only');",
        "if (marker) writeFileSync(marker, `${sourceName}:${isRepairOnly}\\n`, { flag: 'a' });",
        "if (sourceName === 'B-Blocked.epub') {",
        "console.log(JSON.stringify({",
        "  status: 'blocked',",
        `  bookId: '${batchBookId(blockedHash, blockedRelativePath)}',`,
        "  startedStage: null,",
        "  nextStage: null,",
        "  completedStages: ['ingest', 'normalize', 'graph_extract'],",
        "  queryResult: null,",
        "  repairOnly: true,",
        "  repairedLocalArtifactGate: false,",
        "  reason: 'local artifact gate failure checkpoint not found',",
        "}));",
        "} else {",
        "console.log(JSON.stringify({",
        "  status: 'repaired',",
        `  bookId: '${batchBookId(repairedHash, repairedRelativePath)}',`,
        "  startedStage: null,",
        "  nextStage: null,",
        "  completedStages: ['ingest', 'normalize', 'graph_extract'],",
        "  queryResult: null,",
        "  repairOnly: true,",
        "  repairedLocalArtifactGate: true,",
        "  repairReason: 'graph_identity_projection_missing',",
        "  repairedProjection: 'document_identity_map',",
        `  repairEvidenceLocator: 'graph_vault/books/${batchBookId(repairedHash, repairedRelativePath)}/output/qmd_graph_text_unit_identity.json',`,
        "  reusedProducerRunIds: {",
        "    graph_extract: 'run-graph-extract',",
        "    community_report: 'run-community-report',",
        "    embed: 'run-embed',",
        "  },",
        "}));",
        "}",
      ].join("\n"),
    );
    const markerPath = join(tmpRoot, "fake-resume-count.txt");

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
        "--max-resume-passes",
        "24",
      ], {
        env: {
          ...process.env,
          QMD_FAKE_RESUME_MARKER: markerPath,
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const blockedCheckpoint = JSON.parse(readFileSync(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${blockedItemId}.json`,
      ),
      "utf8",
    ));
    const repairedCheckpoint = JSON.parse(readFileSync(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${repairedItemId}.json`,
      ),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const blockedRepairStarts = events.filter((event) =>
      event.itemId === blockedItemId &&
      event.event === "command_start" &&
      event.command?.startsWith("repair-local-artifact-gate-")
    );
    const blockedSkips = events.filter((event) =>
      event.itemId === blockedItemId &&
      event.event === "item_local_artifact_gate_repair_blocked_skip"
    );
    const repairedNormalizeStarts = events.filter((event) =>
      event.itemId === repairedItemId &&
      event.event === "command_start" &&
      event.command === "normalize-epub"
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain("did not reach ready after 24 passes");
    expect(readFileSync(markerPath, "utf8").trim().split("\n")).toEqual([
      "A-Repaired.epub:true",
      "B-Blocked.epub:true",
    ]);
    expect(blockedRepairStarts).toHaveLength(1);
    expect(blockedSkips.length).toBeGreaterThanOrEqual(1);
    expect(blockedCheckpoint.metadata?.localArtifactGateRepairBlocked).toBe(true);
    expect(repairedNormalizeStarts.length).toBeGreaterThanOrEqual(1);
    expect(events.some((event) =>
      event.itemId === blockedItemId &&
      event.event === "item_local_artifact_gate_repair_blocked"
    )).toBe(true);
    expect(blockedCheckpoint).toMatchObject({
      status: "pending",
      recoveryDecision: "continue_pending",
      errorSummary: "local artifact gate failure checkpoint not found",
      failureKind: "permanent",
      retryable: false,
      failedStage: "resume-book-1",
      metadata: {
        localArtifactGateRepairBlocked: true,
        localArtifactGateRepairBlockedReason:
          "local artifact gate failure checkpoint not found",
      },
    });
    expect(blockedCheckpoint.metadata?.localArtifactGateRepairCompleted)
      .toBeUndefined();
    expect(blockedCheckpoint.failedAt).toBeUndefined();
    expect(blockedCheckpoint.retryExhausted).toBeUndefined();
    expect(repairedCheckpoint.metadata?.localArtifactGateRepairCompleted).toBe(true);
    expect(repairedCheckpoint.metadata?.localArtifactGateRepairBlocked)
      .toBeUndefined();
    expect(repairedCheckpoint.metadata?.localArtifactGateRepairBlockedReason)
      .toBeUndefined();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("repair-only blocked can reopen a real GraphRAG rebuild", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-repair-real-rebuild-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "repair-real-rebuild";
    const sourceBytes = "repair requires real graphrag rebuild";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(join(stateRoot, "input"), { recursive: true });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    const normalizedPath = join(
      stateRoot,
      "input",
      `book-${sourceHash.slice(0, 10)}.md`,
    );
    await writeFile(
      normalizedPath,
      "# Book\n\nAlready normalized.\n",
    );
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const blockedErrorSummary =
      "GraphRAG stage did not produce valid book-scoped artifacts: " +
      JSON.stringify({
        bookId,
        stage: "graph_extract",
        missingArtifactKinds: ["graphrag_documents_parquet"],
      });
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
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
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: relative(projectRoot, normalizedPath),
        bookId,
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: blockedErrorSummary,
        commandChecks: [],
      },
    );
    const resumeScript = join(
      tmpRoot,
      "scripts",
      "graphrag",
      "resume-book-workspace.mjs",
    );
    await mkdir(dirname(resumeScript), { recursive: true });
    await writeFile(
      resumeScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { basename } from 'node:path';",
        "const sourceIndex = process.argv.indexOf('--source-path');",
        "const sourcePath = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : '';",
        "const sourceName = basename(sourcePath);",
        "const marker = process.env.QMD_FAKE_RESUME_MARKER;",
        "const isRepairOnly = process.argv.includes('--repair-local-artifact-gate-only');",
        "if (marker) writeFileSync(marker, `${sourceName}:${isRepairOnly}\\n`, { flag: 'a' });",
        "if (isRepairOnly) {",
        "  console.log(JSON.stringify({",
        "    status: 'blocked',",
        `    bookId: '${bookId}',`,
        "    startedStage: null,",
        "    nextStage: 'graph_extract',",
        "    completedStages: ['ingest', 'normalize'],",
        "    queryResult: null,",
        "    repairOnly: true,",
        "    repairedLocalArtifactGate: false,",
        "    requiresRealRebuild: true,",
        "    rebuildStage: 'graph_extract',",
        "    reason: 'real GraphRAG rebuild required for graph_extract',",
        "  }));",
        "} else {",
        "  console.error('normal GraphRAG rebuild attempted');",
        "  process.exit(1);",
        "}",
      ].join("\n"),
    );
    const markerPath = join(tmpRoot, "fake-resume-count.txt");

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
      ], {
        env: {
          ...process.env,
          QMD_FAKE_RESUME_MARKER: markerPath,
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const blockedSkips = events.filter((event) =>
      event.itemId === itemId &&
      event.event === "item_local_artifact_gate_repair_blocked_skip"
    );
    const normalResumeStarts = events.filter((event) =>
      event.itemId === itemId &&
      event.event === "command_start" &&
      event.command === "resume-book-1"
    );
    const repairBlockedEvent = events.find((event) =>
      event.itemId === itemId &&
      event.event === "item_local_artifact_gate_repair_blocked"
    );
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(markerPath, "utf8").trim().split("\n")).toEqual([
      "Book.epub:true",
      "Book.epub:false",
    ]);
    expect(blockedSkips).toHaveLength(0);
    expect(normalResumeStarts).toHaveLength(1);
    expect(repairBlockedEvent).toMatchObject({
      failureKind: "permanent",
      retryable: false,
      recoveryDecision: "continue_pending",
      failedStage: "graph_extract",
      metadata: {
        requiresRealRebuild: true,
        rebuildStage: "graph_extract",
      },
    });
    expect(checkpoint).toMatchObject({
      status: "failed",
      failedStage: "resume-book-1",
      recoveryDecision: "stop_until_fixed",
      metadata: {
        localArtifactGateRepairRequiresRealRebuild: true,
        localArtifactGateRepairRebuildStage: "graph_extract",
      },
    });
    expect(checkpoint.metadata?.localArtifactGateRepairBlocked).toBeUndefined();
    expect(checkpoint.metadata?.localArtifactGateRepairBlockedReason)
      .toBeUndefined();
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      localArtifactGateRepairRequiresRealRebuild: true,
      localArtifactGateRepairRebuildStage: "graph_extract",
    });
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test.each([
    {
      name: "document identity",
      failureText:
        "GraphRAG document identity is missing for query_ready: doc-fd8875181a17",
      repairReason: "graph_identity_projection_missing",
      repairedProjection: "document_identity_map",
      evidenceSuffix: "output/qmd_graph_text_unit_identity.json",
    },
    {
      name: "graph capability",
      failureText:
        "capabilityScope references unknown or not-ready graphCapabilityId(s): " +
        "book-356ff4920cdf-0bbd8bdb:graph_query",
      repairReason: "graph_query_capability_projection_missing",
      repairedProjection: "graph_capability",
      evidenceSuffix: "checkpoints.yaml#query_ready",
    },
    {
      name: "document identity sidecar mismatch",
      failureText:
        "GraphRAG document identity sidecar does not match query_ready",
      repairReason: "graph_identity_projection_missing",
      repairedProjection: "document_identity_map",
      evidenceSuffix: "output/qmd_graph_text_unit_identity.json",
    },
    {
      name: "document identity sidecar invalid evidence",
      failureText:
        "GraphRAG document identity sidecar evidence is invalid for query_ready",
      repairReason: "graph_identity_projection_missing",
      repairedProjection: "document_identity_map",
      evidenceSuffix: "output/qmd_graph_text_unit_identity.json",
    },
    {
      name: "managed settings projection",
      failureText:
        "graph_vault/settings.yaml is not the managed projection of .qmd/index.yml",
      repairReason: "graph_query_capability_projection_missing",
      repairedProjection: "graph_capability",
      evidenceSuffix: "checkpoints.yaml#query_ready",
    },
  ])("reopens query-ready $name projection gate failures with fixed repair metadata", async ({
    failureText,
    repairReason,
    repairedProjection,
    evidenceSuffix,
  }) => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-query-ready-reopen-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "query-ready-reopen";
    const sourceBytes = "query ready projection reopen";
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
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
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
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
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
        bookId,
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: failureText,
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 128,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "permanent",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary: failureText,
        }],
      },
    );
    const resumeScript = join(
      tmpRoot,
      "scripts",
      "graphrag",
      "resume-book-workspace.mjs",
    );
    await mkdir(dirname(resumeScript), { recursive: true });
    await writeFile(
      resumeScript,
      [
        "console.log(JSON.stringify({",
        "  status: 'repaired',",
        `  bookId: '${bookId}',`,
        "  startedStage: null,",
        "  nextStage: null,",
        "  completedStages: ['graph_extract', 'community_report', 'embed', 'query_ready'],",
        "  queryResult: null,",
        "  repairOnly: true,",
        "  repairedLocalArtifactGate: true,",
        `  repairReason: '${repairReason}',`,
        `  repairedProjection: '${repairedProjection}',`,
        `  repairEvidenceLocator: 'graph_vault/books/${bookId}/${evidenceSuffix}',`,
        "  reusedProducerRunIds: {",
        "    graph_extract: 'run-graph-extract',",
        "    community_report: 'run-community-report',",
        "    embed: 'run-embed',",
        "    query_ready: 'run-query-ready',",
        "  },",
        "  settingsProjectionRepair: {",
        "    decision: 'already_valid',",
        "    rewritten: false,",
        "    sourceFingerprint: 'settings-source-fp',",
        `    settingsPath: '${join(stateRoot, "settings.yaml")}',`,
        `    evidenceLocator: '${join(stateRoot, "settings.yaml")}',`,
        "    reason: 'managed_projection_valid',",
        "  },",
        "}));",
      ].join("\n"),
    );

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
      ], {
        env: {
          ...process.env,
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const redactionRoot = projectRoot.endsWith(sep) ? projectRoot : `${projectRoot}${sep}`;
    const redactedPath = (path: string) =>
      path.split(redactionRoot).join("[PROJECT_ROOT]");
    const expectedRepairMetadata = {
      reopenedFromStatus: "failed",
      reopenedToStatus: "pending",
      reopenedFromRecoveryDecision: "stop_until_fixed",
      repairReason,
      repairFailureText: failureText,
      repairedProjection,
      repairEvidenceLocator: `graph_vault/books/${bookId}/${evidenceSuffix}`,
      reusedProducerRunIds: {
        graph_extract: "run-graph-extract",
        community_report: "run-community-report",
        embed: "run-embed",
        query_ready: "run-query-ready",
      },
      normalCommandChecksRequired: true,
      settingsProjectionDecision: "already_valid",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: "settings-source-fp",
      settingsProjectionProjectConfigLocator:
        redactedPath(join(configDir, "index.yml")),
      settingsProjectionLocator: redactedPath(join(stateRoot, "settings.yaml")),
      settingsProjectionEvidenceLocator:
        redactedPath(join(stateRoot, "settings.yaml")),
      settingsProjectionReason: "managed_projection_valid",
    };

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint.status).toBe("failed");
    expect(checkpoint.failedStage).toBe("normalize-epub");
    expect(checkpoint.commandChecks[0]?.name).toBe("normalize-epub");
    expect(checkpoint.metadata).toMatchObject({
      localArtifactGateRepairCompleted: true,
      ...expectedRepairMetadata,
      waitingForProviderRecovery: false,
    });
    expect(events.some((event) =>
      event.itemId === itemId &&
      event.event === "item_local_artifact_gate_repair_reopened" &&
      event.status === "pending" &&
      event.metadata?.normalCommandChecksRequired === true &&
      event.metadata?.repairReason === repairReason &&
      event.metadata?.repairedProjection === repairedProjection
    )).toBe(true);
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      ...expectedRepairMetadata,
    });
    expect(events.some((event) =>
      event.itemId === itemId &&
      event.event === "item_start"
    )).toBe(true);
    expect(checkpoint.status).not.toBe("completed");
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("mixed data compatibility and local projection text still stops batch", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-mixed-data-compat-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "mixed-data-compat";
    const sourceBytes = "mixed data compatibility failure";
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
    const compatibilityError =
      "GraphRAG community text-unit context references missing text units: tu-1";
    const localProjectionError =
      "GraphRAG document identity is missing for query_ready: doc-fd8875181a17";
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
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
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
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
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "data_compatibility",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-2",
        errorSummary: compatibilityError,
        commandChecks: [{
          name: "resume-book-2",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 128,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "permanent",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary: localProjectionError,
        }],
      },
    );
    const resumeScript = join(tmpRoot, "should-not-run.mjs");
    await writeFile(
      resumeScript,
      "throw new Error('repair runner should not be invoked');\n",
      "utf8",
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
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
            QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "failed",
      failureKind: "data_compatibility",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
    });
    expect(events.some((event) =>
      event.event === "item_local_artifact_gate_repair"
    )).toBe(false);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_data_compatibility_failure" &&
      event.itemId === itemId
    )).toBe(true);
  });

  test("mixed provider failure and local projection text does not repair", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-mixed-provider-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "mixed-provider";
    const sourceBytes = "mixed provider failure";
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
    const providerError = "HTTP 401 upstream unauthorized";
    const localProjectionError =
      "GraphRAG document identity is missing for query_ready: doc-fd8875181a17";
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
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
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
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
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: localProjectionError,
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 128,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "permanent",
          retryable: false,
          attemptExhausted: true,
          providerStatusCode: 401,
          recoveryDecision: "stop_until_fixed",
          errorSummary: providerError,
        }],
      },
    );
    const resumeScript = join(tmpRoot, "should-not-run.mjs");
    await writeFile(
      resumeScript,
      "throw new Error('repair runner should not be invoked');\n",
      "utf8",
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
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
            QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "failed",
      failureKind: "permanent",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
    });
    expect(checkpoint.commandChecks[0]).toMatchObject({
      providerStatusCode: 401,
    });
    expect(events.some((event) =>
      event.event === "item_local_artifact_gate_repair"
    )).toBe(false);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_non_transient_failure" &&
      event.itemId === itemId &&
      event.metadata?.stopReason === "provider_auth"
    )).toBe(true);
  });
});
