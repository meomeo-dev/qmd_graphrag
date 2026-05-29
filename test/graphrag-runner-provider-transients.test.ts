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

describe("GraphRAG EPUB batch runner - Provider Transients", () => {
  test("keeps GraphRAG resume failures out of qmd build evidence", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-qmd-graph-state-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "qmd-graph-state-isolation-fixture";
    const sourceBytes = "state isolation";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const qmdChecks = passedBatchCommandChecks();
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
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
        status: "pending",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        failureKind: "transient",
        retryable: true,
        recoveryDecision: "retry_same_run_id",
        failedStage: "resume-book-2",
        errorSummary: "GraphRAG stage report partial-output failure",
        commandChecks: [
          {
            name: "resume-book-2",
            status: "failed",
            attempts: 1,
            exitCode: 1,
            stdoutBytes: 0,
            stderrBytes: 64,
            startedAt: "2026-05-23T00:00:00.000Z",
            completedAt: "2026-05-23T00:01:00.000Z",
            failureKind: "transient",
            retryable: true,
            attemptExhausted: false,
            recoveryDecision: "retry_same_run_id",
            errorSummary: "GraphRAG stage report partial-output failure",
          },
          ...qmdChecks,
        ],
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
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      qmdBuildStatus: {
        status: "pending",
        stage: "qmd-build",
        reason: "qmd_build_manifest_missing",
      },
      commandCheckStatus: {
        status: "failed",
        stage: "resume-book-2",
        reason: "command_check_failed",
      },
      graphBuildStatus: {
        status: "pending",
        stage: "graph_extract",
        reason: "real_graphrag_stage_missing",
      },
      failureKind: "transient",
      retryable: true,
      recoveryDecision: "retry_same_run_id",
      failedStage: "resume-book-2",
    });
  });

  test("status-json stops the batch when another item is permanent failed", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-status-mixed-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "status-json-mixed-failure";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sources = [
      ["Failed.epub", "permanent failure"],
      ["Pending.epub", "still pending"],
    ];
    const itemIds: string[] = [];
    for (const [name, body] of sources) {
      const sourcePath = join(sourceDir, name);
      const sourceHash = createHash("sha256").update(body).digest("hex");
      const sourceRelativePath = relative(projectRoot, sourcePath);
      const itemId = `item-${sourceHash.slice(0, 12)}-${
        createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
      }`;
      await writeFile(sourcePath, body);
      itemIds.push(itemId);
      await writeDurableJsonFixture(
        join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
        {
          schemaVersion: SchemaVersion,
          itemId,
          runId,
          status: name === "Failed.epub" ? "failed" : "pending",
          sourceName: name,
          sourceRelativePath,
          sourceHash,
          normalizedPath: join(".tmp-tests", "graph_vault", "input", `${name}.md`),
          bookId: batchBookId(sourceHash, sourceRelativePath),
          attempts: name === "Failed.epub" ? 1 : 0,
          ...(name === "Failed.epub"
            ? {
                failureKind: "permanent",
                retryable: false,
                recoveryDecision: "stop_until_fixed",
                failedStage: "graphrag-build",
                errorSummary: "HTTP 400 invalid request",
              }
            : { recoveryDecision: "none" }),
          commandChecks: [],
        },
      );
    }
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
        itemIds,
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
    expect(summary.recoveryDecision).toBe("stop_until_fixed");
    expect(summary.counts).toMatchObject({ failed: 1, pending: 1 });
  });

  test("status-json projects exhausted transient failures as provider recovery wait", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-status-exhausted-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "status-json-exhausted";
    const sourceBytes = "exhausted transient";
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
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
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
        attempts: 12,
        retryStartedAt: "2026-05-23T00:00:00.000Z",
        failedAt: "2026-05-23T03:00:00.000Z",
        failureKind: "transient",
        retryable: true,
        retryExhausted: true,
        recoveryDecision: "retry_same_run_id",
        failedStage: "resume-book-2",
        errorSummary: "GraphRAG stage report partial-output failure",
        commandChecks: [
          {
            name: "resume-book-1",
            status: "failed",
            attempts: 3,
            exitCode: 1,
            stdoutBytes: 0,
            stderrBytes: 48,
            startedAt: "2026-05-23T00:00:00.000Z",
            completedAt: "2026-05-23T00:01:00.000Z",
            failureKind: "transient",
            retryable: true,
            attemptExhausted: true,
            providerStatusCode: 500,
            retryAfterSeconds: 60,
            recoveryDecision: "retry_same_run_id",
            errorSummary: "HTTP 500 Retry-After: 60",
          },
          {
            name: "resume-book-2",
            status: "failed",
            attempts: 3,
            exitCode: 1,
            stdoutBytes: 0,
            stderrBytes: 64,
            startedAt: "2026-05-23T02:59:00.000Z",
            completedAt: "2026-05-23T03:00:00.000Z",
            failureKind: "transient",
            retryable: true,
            attemptExhausted: true,
            providerStatusCode: 503,
            retryAfterSeconds: 180,
            recoveryDecision: "retry_same_run_id",
            errorSummary: "HTTP 503 Retry-After: 180",
          },
        ],
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

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventsExist = existsSync(eventLogPath);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      recoveryDecision: "retry_same_run_id",
      retryableItemCount: 1,
    });
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      qmdBuildStatus: { status: "pending" },
      graphBuildStatus: { status: "pending" },
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      waitingForProviderRecovery: true,
      providerStatusCode: 503,
      retryAfterSeconds: 180,
    });
    expect(checkpoint).toMatchObject({
      retryable: true,
      retryExhausted: true,
      recoveryDecision: "retry_same_run_id",
    });
    expect(eventsExist).toBe(false);
  });

  test("normal run exits after provider recovery wait limit", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-wait-limit-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-wait-limit";
    const sourceBytes = "provider wait limit";
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
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
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
        status: "pending",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 12,
        retryStartedAt: "2026-05-23T00:00:00.000Z",
        failureKind: "transient",
        retryable: true,
        retryExhausted: false,
        recoveryDecision: "retry_same_run_id",
        failedStage: "resume-book-2",
        nextRetryAt: "2099-01-01T00:00:00.000Z",
        retryDelaySeconds: 300,
        errorSummary: "GraphRAG stage report partial-output failure",
        commandChecks: [],
        metadata: {
          waitingForProviderRecovery: true,
          providerRecoveryWaitCount: 9,
          maxProviderRecoveryWaits: 1,
        },
      },
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
          "--max-provider-recovery-waits",
          "1",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const eventsRaw = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    );
    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const manifest = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      "utf8",
    ));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(eventsRaw).toContain("batch_provider_recovery_wait_limit");
    expect(manifest.status).toBe("failed");
    expect(checkpoint).toMatchObject({
      status: "failed",
      failureKind: "transient",
      retryable: false,
      retryExhausted: true,
      recoveryDecision: "stop_until_fixed",
      metadata: {
        providerRecoveryWaitCount: 1,
        maxProviderRecoveryWaits: 1,
        providerRecoveryWaitLimitReached: true,
        providerRecoveryExcludedFromRun: true,
      },
    });
    expect(checkpoint.nextRetryAt).toBeUndefined();
    expect(checkpoint.retryDelaySeconds).toBeUndefined();
  });

  test("provider recovery wait limit preserves checkpoint identity during catalog drift", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-wait-identity-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-wait-identity";
    const sourceBytes = "provider wait identity";
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
    const persistedSourceIdentityPath = join(
      ".tmp-tests",
      "legacy",
      "provider-wait-source.epub",
    );
    const persistedBookId = batchBookId(sourceHash, persistedSourceIdentityPath);
    const driftBookId = `${persistedBookId}-catalog-drift`;
    const persistedNormalizedPath = join(stateRoot, "input", "provider-wait.md");
    await writeQmdBuildFixture({
      tmpRoot,
      stateRoot,
      configDir,
      runId,
      itemId,
      bookId: persistedBookId,
      sourceRelativePath,
      sourceHash,
      normalizedPath: persistedNormalizedPath,
    });
    await writeProviderAuthReopenGraphFixture({
      stateRoot,
      bookId: persistedBookId,
      sourceHash,
    });
    const catalogPath = join(stateRoot, "catalog", "books.yaml");
    const catalog = YAML.parse(readFileSync(catalogPath, "utf8"));
    catalog.items.push({
      ...catalog.items[0],
      bookId: driftBookId,
      documentId: `doc-${driftBookId}`,
      sourcePath: `sources/${driftBookId}/source.epub`,
      metadata: { sourceIdentityPath: sourceRelativePath },
      normalizedPath: `books/${driftBookId}/input/book.md`,
      createdAt: "2026-05-23T00:00:02.000Z",
      updatedAt: "2026-05-23T00:00:03.000Z",
    });
    await writeDurableYamlFixture(catalogPath, catalog);
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
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
        status: "pending",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: persistedSourceIdentityPath,
        sourceHash,
        normalizedPath: relative(projectRoot, persistedNormalizedPath),
        bookId: persistedBookId,
        attempts: 12,
        retryStartedAt: "2026-05-23T00:00:00.000Z",
        failureKind: "transient",
        retryable: true,
        retryExhausted: false,
        recoveryDecision: "retry_same_run_id",
        failedStage: "resume-book-2",
        nextRetryAt: "2099-01-01T00:00:00.000Z",
        retryDelaySeconds: 300,
        errorSummary: "GraphRAG provider recovery wait",
        commandChecks: [],
        metadata: {
          waitingForProviderRecovery: true,
          providerRecoveryWaitCount: 9,
          maxProviderRecoveryWaits: 1,
        },
      },
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
          "--max-provider-recovery-waits",
          "1",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "failed",
      bookId: persistedBookId,
      sourceIdentityPath: persistedSourceIdentityPath,
      normalizedPath: relative(projectRoot, persistedNormalizedPath),
      qmdBuildStatus: { status: "succeeded", bookId: persistedBookId },
      graphBuildStatus: { status: "succeeded" },
      retryable: false,
      retryExhausted: true,
      recoveryDecision: "stop_until_fixed",
    });
    expect(checkpoint.bookId).not.toBe(driftBookId);
    expect(checkpoint.graphBuildStatus.artifactIds.every((artifactId: string) =>
      artifactId.includes(persistedBookId)
    )).toBe(true);
    expect(JSON.stringify(checkpoint.graphBuildStatus)).not.toContain(driftBookId);
  });

  test("status-json recovers legacy stop-until-fixed transient failures", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-legacy-stop-transient-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "legacy-stop-transient";
    const sourceBytes = "legacy transient stop";
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
        attempts: 3,
        retryStartedAt: "2026-05-23T00:00:00.000Z",
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "transient",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: "Concurrency limit exceeded for account, please retry later",
        commandChecks: [],
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
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.retryableItemCount).toBe(1);
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      waitingForProviderRecovery: true,
      providerRecoveryWaitCount: 1,
      maxProviderRecoveryWaits: 3,
      providerRecoveryReason: "retry_budget_window_elapsed",
    });
  });

  test("status-json recovers legacy Jina APIConnectionError as provider transient", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-legacy-jina-transient-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "legacy-jina-transient";
    const sourceBytes = "legacy jina transient";
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
      "Error: GraphRAG index workflow failed: " +
      "[{\"workflow\":\"generate_text_embeddings\",\"errorMessage\":\"" +
      "litellm.APIConnectionError: Jina_aiException - Cannot connect to host " +
      "api.jina.ai:443 ssl:<ssl.SSLContext object> [None]\"}]";
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
        attempts: 3,
        retryStartedAt: "2026-05-23T00:00:00.000Z",
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "unknown",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-2",
        errorSummary,
        commandChecks: [{
          name: "resume-book-2",
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
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.retryableItemCount).toBe(1);
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      failedStage: "resume-book-2",
      waitingForProviderRecovery: true,
      providerRecoveryWaitCount: 1,
      maxProviderRecoveryWaits: 3,
      providerRecoveryReason: "retry_budget_window_elapsed",
    });
  });

  test("status-json recovers legacy Responses output-none as provider transient", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-legacy-output-none-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "legacy-responses-output-none";
    const sourceBytes = "legacy responses output none";
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
      "Error: GraphRAG index workflow failed: " +
      "[{\"workflow\":\"extract_graph\",\"errorMessage\":\"Responses API " +
      "transient failure after 13 attempts: OpenAIResponsesTransientError: " +
      "Responses API transient error kind=responses_output_none " +
      "status_code=unknown: completed response output was null\"}]";
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
    expect(summary.retryableItemCount).toBe(1);
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
});
