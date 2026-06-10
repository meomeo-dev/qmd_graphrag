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
  nodeScriptBin,
  passedBatchCommandChecks,
  projectRoot,
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

const minimalGraphQueryCommandChecks = [
  "qmd-version",
  "qmd-query-auto-json",
  "qmd-query-graphrag-json",
];

describe("GraphRAG EPUB batch runner - Provider Auth Reopen", () => {
  test("non-transient GraphRAG data compatibility failure stops before next book", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-data-compat-stop-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "data-compat-stop";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(sourceDir, "A-Failed.epub"), "failed data compat");
    await writeFile(join(sourceDir, "B-Pending.epub"), "pending should not run");

    const firstPath = join(sourceDir, "A-Failed.epub");
    const secondPath = join(sourceDir, "B-Pending.epub");
    const firstHash = createHash("sha256")
      .update("failed data compat")
      .digest("hex");
    const secondHash = createHash("sha256")
      .update("pending should not run")
      .digest("hex");
    const firstRelativePath = relative(projectRoot, firstPath);
    const secondRelativePath = relative(projectRoot, secondPath);
    const firstItemId = `item-${firstHash.slice(0, 12)}-${
      createHash("sha256").update(firstRelativePath).digest("hex").slice(0, 8)
    }`;
    const secondItemId = `item-${secondHash.slice(0, 12)}-${
      createHash("sha256").update(secondRelativePath).digest("hex").slice(0, 8)
    }`;
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
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
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [firstItemId, secondItemId],
      },
    );
    const compatibilityError =
      "GraphRAG community text-unit context references missing text units: " +
      "tu-missing";
    await writeDurableJsonFixture(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${firstItemId}.json`,
      ),
      {
        schemaVersion: SchemaVersion,
        itemId: firstItemId,
        runId,
        status: "failed",
        sourceName: "A-Failed.epub",
        sourceRelativePath: firstRelativePath,
        sourceIdentityPath: firstRelativePath,
        sourceHash: firstHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "failed.md"),
        bookId: batchBookId(firstHash, firstRelativePath),
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
          stderrBytes: 120,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "data_compatibility",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary: compatibilityError,
        }],
      },
    );
    await writeDurableJsonFixture(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${secondItemId}.json`,
      ),
      {
        schemaVersion: SchemaVersion,
        itemId: secondItemId,
        runId,
        status: "pending",
        sourceName: "B-Pending.epub",
        sourceRelativePath: secondRelativePath,
        sourceIdentityPath: secondRelativePath,
        sourceHash: secondHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "pending.md"),
        bookId: batchBookId(secondHash, secondRelativePath),
        attempts: 0,
        recoveryDecision: "none",
        commandChecks: [],
      },
    );

    const result = await new Promise<{
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(nodeScriptBin(), [
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
      ]);
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
    });

    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const secondCheckpoint = JSON.parse(readFileSync(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${secondItemId}.json`,
      ),
      "utf8",
    ));

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(events.some((event) =>
      event.event === "batch_stopped_after_data_compatibility_failure" &&
      event.itemId === firstItemId &&
      event.failureKind === "data_compatibility"
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_non_transient_failure" &&
      event.itemId === firstItemId &&
      event.failureKind === "data_compatibility"
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "command_start" &&
      event.itemId === secondItemId
    )).toBe(false);
    expect(secondCheckpoint.status).toBe("pending");
    expect(secondCheckpoint.attempts).toBe(0);
    expect(summary.recoveryDecision).toBe("stop_until_fixed");
    expect(summary.counts).toMatchObject({ failed: 1, pending: 1 });
  });

  test("generic stop-until-fixed failure stops before next book", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-generic-stop-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "generic-stop-until-fixed";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(sourceDir, "A-Failed.epub"), "failed generic");
    await writeFile(join(sourceDir, "B-Pending.epub"), "pending should not run");

    const firstPath = join(sourceDir, "A-Failed.epub");
    const secondPath = join(sourceDir, "B-Pending.epub");
    const firstHash = createHash("sha256").update("failed generic").digest("hex");
    const secondHash = createHash("sha256")
      .update("pending should not run")
      .digest("hex");
    const firstRelativePath = relative(projectRoot, firstPath);
    const secondRelativePath = relative(projectRoot, secondPath);
    const firstItemId = `item-${firstHash.slice(0, 12)}-${
      createHash("sha256").update(firstRelativePath).digest("hex").slice(0, 8)
    }`;
    const secondItemId = `item-${secondHash.slice(0, 12)}-${
      createHash("sha256").update(secondRelativePath).digest("hex").slice(0, 8)
    }`;
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
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
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [firstItemId, secondItemId],
      },
    );
    const permanentError = "search output contract mismatch";
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${firstItemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId: firstItemId,
        runId,
        status: "failed",
        sourceName: "A-Failed.epub",
        sourceRelativePath: firstRelativePath,
        sourceIdentityPath: firstRelativePath,
        sourceHash: firstHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "failed.md"),
        bookId: batchBookId(firstHash, firstRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "qmd-search-json",
        errorSummary: permanentError,
        commandChecks: [{
          name: "qmd-search-json",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: permanentError.length,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "permanent",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary: permanentError,
        }],
      },
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${secondItemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId: secondItemId,
        runId,
        status: "pending",
        sourceName: "B-Pending.epub",
        sourceRelativePath: secondRelativePath,
        sourceIdentityPath: secondRelativePath,
        sourceHash: secondHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "pending.md"),
        bookId: batchBookId(secondHash, secondRelativePath),
        attempts: 0,
        recoveryDecision: "none",
        commandChecks: [],
      },
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(nodeScriptBin(), [
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
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const secondCheckpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${secondItemId}.json`),
      "utf8",
    ));

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(events.some((event) =>
      event.event === "batch_stopped_after_non_transient_failure" &&
      event.itemId === firstItemId &&
      event.metadata?.stopReason === "non_transient"
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "command_start" &&
      event.itemId === secondItemId
    )).toBe(false);
    expect(secondCheckpoint).toMatchObject({ status: "pending", attempts: 0 });
    expect(summary.recoveryDecision).toBe("stop_until_fixed");
    expect(summary.counts).toMatchObject({ failed: 1, pending: 1 });
  });

  test("unrecoverable provider auth failure stops before next book", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-stop-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-stop";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(sourceDir, "A-Failed.epub"), "failed provider auth");
    await writeFile(join(sourceDir, "B-Pending.epub"), "pending should not run");

    const firstPath = join(sourceDir, "A-Failed.epub");
    const secondPath = join(sourceDir, "B-Pending.epub");
    const firstHash = createHash("sha256")
      .update("failed provider auth")
      .digest("hex");
    const secondHash = createHash("sha256")
      .update("pending should not run")
      .digest("hex");
    const firstRelativePath = relative(projectRoot, firstPath);
    const secondRelativePath = relative(projectRoot, secondPath);
    const firstItemId = `item-${firstHash.slice(0, 12)}-${
      createHash("sha256").update(firstRelativePath).digest("hex").slice(0, 8)
    }`;
    const secondItemId = `item-${secondHash.slice(0, 12)}-${
      createHash("sha256").update(secondRelativePath).digest("hex").slice(0, 8)
    }`;
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
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
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [firstItemId, secondItemId],
      },
    );
    const providerError =
      "Error code: 401 - {'code': 'INVALID_API_KEY', " +
      "'message': 'Invalid API key'}";
    await writeDurableJsonFixture(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${firstItemId}.json`,
      ),
      {
        schemaVersion: SchemaVersion,
        itemId: firstItemId,
        runId,
        status: "failed",
        sourceName: "A-Failed.epub",
        sourceRelativePath: firstRelativePath,
        sourceIdentityPath: firstRelativePath,
        sourceHash: firstHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "failed.md"),
        bookId: batchBookId(firstHash, firstRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: providerError,
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 120,
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
    await writeDurableJsonFixture(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${secondItemId}.json`,
      ),
      {
        schemaVersion: SchemaVersion,
        itemId: secondItemId,
        runId,
        status: "pending",
        sourceName: "B-Pending.epub",
        sourceRelativePath: secondRelativePath,
        sourceIdentityPath: secondRelativePath,
        sourceHash: secondHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "pending.md"),
        bookId: batchBookId(secondHash, secondRelativePath),
        attempts: 0,
        recoveryDecision: "none",
        commandChecks: [],
      },
    );

    const result = await new Promise<{
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(nodeScriptBin(), [
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
      ]);
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
    });

    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const secondCheckpoint = JSON.parse(readFileSync(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${secondItemId}.json`,
      ),
      "utf8",
    ));

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(events.some((event) =>
      event.event === "batch_stopped_after_data_compatibility_failure" &&
      event.itemId === firstItemId
    )).toBe(false);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_non_transient_failure" &&
      event.itemId === firstItemId &&
      event.failureKind === "permanent" &&
      event.metadata?.stopReason === "provider_auth"
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "command_start" &&
      event.itemId === secondItemId
    )).toBe(false);
    expect(secondCheckpoint.status).toBe("pending");
    expect(secondCheckpoint.attempts).toBe(0);
    expect(summary.recoveryDecision).toBe("stop_until_fixed");
    expect(summary.counts).toMatchObject({ failed: 1, pending: 1 });
  });

  test("provider auth repair reopens legacy checkpoint once and reruns closed loop", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-reopen-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-reopen";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(
      join(tmpRoot, ".env"),
      [
        "OPENAI_API_KEY=repaired-openai-key",
        "OPENAI_BASE_URL=https://api.openai.example",
        "JINA_API_KEY=repaired-jina-key",
        "JINA_API_BASE=https://api.jina.example",
      ].join("\n"),
    );
    await writeFile(
      join(stateRoot, ".env"),
      [
        "OPENAI_API_KEY=repaired-openai-key",
        "OPENAI_BASE_URL=https://api.openai.example",
        "JINA_API_KEY=repaired-jina-key",
        "JINA_API_BASE=https://api.jina.example",
      ].join("\n"),
    );

    const sourcePath = join(sourceDir, "A-Auth.epub");
    await writeMinimalEpubFixture(sourcePath, "A Auth");
    const sourceHash = createHash("sha256")
      .update(readFileSync(sourcePath))
      .digest("hex");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const normalizedPath = join(stateRoot, "books", bookId, "input", "a-auth.md");
    await writeQmdBuildFixture({
      tmpRoot,
      stateRoot,
      configDir,
      runId,
      itemId,
      bookId,
      sourceName: "A-Auth.epub",
      sourceRelativePath,
      sourceHash,
      normalizedPath,
    });
    await writeProviderAuthReopenGraphFixture({ stateRoot, bookId, sourceHash });
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
    const providerError =
      "Error code: 401 - {'code': 'INVALID_API_KEY', " +
      "'message': 'Invalid API key'}";
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "A-Auth.epub",
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
        errorSummary: providerError,
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 120,
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
    const resumeScript = join(tmpRoot, "fake-ready-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "const sourceIndex = process.argv.indexOf('--source-path');",
        "const sourcePath = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : '';",
        "const name = sourcePath.includes('A-Auth.epub') ? 'A-Auth.epub' : sourcePath;",
        "console.log(JSON.stringify({ status: 'ready', bookId: process.env.TEST_BOOK_ID, sourceName: name }));",
      ].join("\n"),
    );
    const qmdScript = join(tmpRoot, "fake-qmd.mjs");
    await writeFile(
      qmdScript,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const args = process.argv.slice(2);",
        "const commandName = process.env.QMD_GRAPHRAG_COMMAND_NAME || '';",
        "if (process.env.INDEX_PATH) {",
        "  mkdirSync(dirname(process.env.INDEX_PATH), { recursive: true });",
        "  writeFileSync(process.env.INDEX_PATH, 'fake qmd index\\n');",
        "}",
        "if (commandName === 'qmd-query-auto-json') console.log('{}');",
        "else if (commandName === 'qmd-query-graphrag-json') console.log('{}');",
        "else if (args.includes('--version')) console.log('qmd-test 1.0.0');",
        "else if (args.includes('--json')) console.log('{}');",
        "else if (args.includes('--csv')) console.log('title');",
        "else if (args.includes('--xml')) console.log('<ok/>');",
        "else if (args.includes('--md')) console.log('# ok');",
        "else console.log('ok');",
      ].join("\n"),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(nodeScriptBin(), [
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
        "--max-command-attempts",
        "1",
        "--max-resume-passes",
        "1",
      ], {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          QMD_GRAPHRAG_TEST_QMD_RUNNER: "1",
          QMD_GRAPHRAG_QMD_RUNNER: qmdScript,
          QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES:
            minimalGraphQueryCommandChecks.join(","),
          TEST_BOOK_ID: bookId,
          OPENAI_API_KEY: "repaired-openai-key",
          OPENAI_BASE_URL: "https://api.openai.example",
          JINA_API_KEY: "repaired-jina-key",
          JINA_API_BASE: "https://api.jina.example",
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
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
    expect(result.stderr).toBe("");
    expect(result.exitCode, result.stdout).toBe(0);
    expect(checkpoint.status).toBe("completed");
    expect(checkpoint.commandChecks.map((check: { name: string }) => check.name))
      .toEqual(minimalGraphQueryCommandChecks);
    expect(checkpoint.metadata).toMatchObject({
      providerAuthReopenDecision: "reopen_legacy_provider_auth_key_present",
      providerAuthReopenEligible: true,
      legacyProviderAuthFingerprintMissing: true,
      normalCommandChecksRequired: true,
    });
    expect(events.some((event) =>
      event.itemId === itemId &&
      event.event === "item_provider_auth_reopened" &&
      event.status === "pending" &&
      event.metadata?.providerAuthRequiredKeys?.includes("OPENAI_API_KEY")
    )).toBe(true);
    expect(events.some((event) =>
      event.itemId === itemId &&
      event.event === "resume_pass_completed"
    )).toBe(true);
    expect(summary.recoveryDecision).toBe("none");
    expect(summary.counts).toMatchObject({ completed: 1 });
    const serializedState = JSON.stringify({ checkpoint, events, summary });
    expect(serializedState).not.toContain("repaired-openai-key");
    expect(serializedState).not.toContain("repaired-jina-key");
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("provider auth reopen preserves checkpoint identity during catalog drift", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-identity-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-identity";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(
      join(tmpRoot, ".env"),
      [
        "OPENAI_API_KEY=identity-openai-key",
        "OPENAI_BASE_URL=https://api.openai.example",
        "JINA_API_KEY=identity-jina-key",
        "JINA_API_BASE=https://api.jina.example",
      ].join("\n"),
    );
    await writeFile(
      join(stateRoot, ".env"),
      [
        "OPENAI_API_KEY=identity-openai-key",
        "OPENAI_BASE_URL=https://api.openai.example",
        "JINA_API_KEY=identity-jina-key",
        "JINA_API_BASE=https://api.jina.example",
      ].join("\n"),
    );

    const firstSourcePath = join(sourceDir, "A-Auth.epub");
    const secondSourcePath = join(sourceDir, "B-Auth.epub");
    await writeMinimalEpubFixture(firstSourcePath, "A Auth");
    await writeMinimalEpubFixture(secondSourcePath, "B Auth");
    const firstSourceHash = createHash("sha256")
      .update(readFileSync(firstSourcePath))
      .digest("hex");
    const secondSourceHash = createHash("sha256")
      .update(readFileSync(secondSourcePath))
      .digest("hex");
    const firstSourceRelativePath = relative(projectRoot, firstSourcePath);
    const secondSourceRelativePath = relative(projectRoot, secondSourcePath);
    const firstItemId = `item-${firstSourceHash.slice(0, 12)}-${
      createHash("sha256").update(firstSourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const secondItemId = `item-${secondSourceHash.slice(0, 12)}-${
      createHash("sha256").update(secondSourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const persistedSourceIdentityPath = join(
      ".tmp-tests",
      "legacy",
      "provider-auth-source.epub",
    );
    const persistedBookId = batchBookId(firstSourceHash, persistedSourceIdentityPath);
    const driftBookId = `${persistedBookId}-catalog-drift`;
    const secondBookId = batchBookId(secondSourceHash, secondSourceRelativePath);
    const persistedNormalizedPath = join(stateRoot, "input", "provider-auth.md");
    await writeQmdBuildFixture({
      tmpRoot,
      stateRoot,
      configDir,
      runId,
      itemId: firstItemId,
      bookId: persistedBookId,
      sourceName: "A-Auth.epub",
      sourceRelativePath: firstSourceRelativePath,
      sourceHash: firstSourceHash,
      normalizedPath: persistedNormalizedPath,
    });
    await writeProviderAuthReopenGraphFixture({
      stateRoot,
      bookId: persistedBookId,
      sourceHash: firstSourceHash,
    });
    const catalogPath = join(stateRoot, "catalog", "books.yaml");
    const catalog = YAML.parse(readFileSync(catalogPath, "utf8"));
    catalog.items.push({
      ...catalog.items[0],
      bookId: driftBookId,
      documentId: `doc-${driftBookId}`,
      sourcePath: `sources/${driftBookId}/source.epub`,
      metadata: { sourceIdentityPath: firstSourceRelativePath },
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
        itemIds: [firstItemId, secondItemId],
      },
    );
    const providerError =
      "Error code: 401 - {'code': 'INVALID_API_KEY', " +
      "'message': 'Invalid API key'}";
    const failedProviderCheck = {
      name: "resume-book-1",
      status: "failed",
      attempts: 1,
      exitCode: 1,
      stdoutBytes: 0,
      stderrBytes: 120,
      startedAt: "2026-05-23T00:00:00.000Z",
      completedAt: "2026-05-23T00:01:00.000Z",
      failureKind: "permanent",
      retryable: false,
      attemptExhausted: true,
      providerStatusCode: 401,
      recoveryDecision: "stop_until_fixed",
      errorSummary: providerError,
    };
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${firstItemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId: firstItemId,
        runId,
        status: "failed",
        sourceName: "A-Auth.epub",
        sourceRelativePath: firstSourceRelativePath,
        sourceIdentityPath: persistedSourceIdentityPath,
        sourceHash: firstSourceHash,
        normalizedPath: relative(projectRoot, persistedNormalizedPath),
        bookId: persistedBookId,
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: providerError,
        commandChecks: [failedProviderCheck],
        metadata: {
          providerAuthFailureFingerprint: "old-provider-auth-fingerprint",
        },
      },
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${secondItemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId: secondItemId,
        runId,
        status: "failed",
        sourceName: "B-Auth.epub",
        sourceRelativePath: secondSourceRelativePath,
        sourceIdentityPath: secondSourceRelativePath,
        sourceHash: secondSourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "b-auth.md"),
        bookId: secondBookId,
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: providerError,
        commandChecks: [failedProviderCheck],
        metadata: {
          providerAuthFailureFingerprint: "old-provider-auth-fingerprint",
          providerAuthReopenAttemptCount: 3,
        },
      },
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(nodeScriptBin(), [
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
          cwd: tmpRoot,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            OPENAI_API_KEY: "identity-openai-key",
            OPENAI_BASE_URL: "https://api.openai.example",
            JINA_API_KEY: "identity-jina-key",
            JINA_API_BASE: "https://api.jina.example",
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const firstCheckpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${firstItemId}.json`),
      "utf8",
    ));
    const secondCheckpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${secondItemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(firstCheckpoint).toMatchObject({
      status: "pending",
      bookId: persistedBookId,
      sourceIdentityPath: persistedSourceIdentityPath,
      normalizedPath: relative(projectRoot, persistedNormalizedPath),
      qmdBuildStatus: { status: "succeeded", bookId: persistedBookId },
      graphBuildStatus: { status: "succeeded" },
    });
    expect(firstCheckpoint.bookId).not.toBe(driftBookId);
    expect(firstCheckpoint.graphBuildStatus.artifactIds.every((artifactId: string) =>
      artifactId.includes(persistedBookId)
    )).toBe(true);
    expect(JSON.stringify(firstCheckpoint.graphBuildStatus)).not.toContain(driftBookId);
    expect(secondCheckpoint.status).toBe("failed");
    expect(events.some((event) =>
      event.itemId === firstItemId &&
      event.event === "item_provider_auth_reopened"
    )).toBe(true);
  });

  test("status-json blocks provider auth reopen when shell env shadows dotenv", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-shadow-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-shadow";
    const { itemId } = await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });
    const checkpointBefore = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(nodeScriptBin(), [
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
      ], {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          OPENAI_API_KEY: "shadow-openai-key",
          OPENAI_BASE_URL: "https://api.openai.example",
          JINA_API_KEY: "file-jina-key",
          JINA_API_BASE: "https://api.jina.example",
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpointAfter = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    );
    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpointAfter).toBe(checkpointBefore);
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      providerAuthReopenDecision: "blocked_provider_auth_not_ready",
      providerAuthReopenEligible: false,
      providerAuthReopenBlockedReason: "process_env_shadows_dotenv",
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("shadow-openai-key");
    expect(serialized).not.toContain("file-openai-key");
  });

  test("status-json blocks provider auth reopen when observed endpoint env shadows dotenv", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-endpoint-shadow-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-endpoint-shadow";
    await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(nodeScriptBin(), [
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
      ], {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          OPENAI_API_KEY: "file-openai-key",
          OPENAI_BASE_URL: "https://api.openai.example",
          JINA_API_KEY: "file-jina-key",
          JINA_API_BASE: "https://shadow.jina.example",
        },
      });
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
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      providerAuthReopenDecision: "blocked_provider_auth_not_ready",
      providerAuthReopenEligible: false,
      providerAuthReopenBlockedReason: "process_env_shadows_dotenv",
      providerAuthCredentialSources: {
        JINA_API_BASE: "process_env_shadows_dotenv",
      },
    });
    expect(summary.items[0].providerAuthShadowedEnvNames)
      .toContain("JINA_API_BASE");
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("https://shadow.jina.example");
    expect(serialized).not.toContain("https://api.jina.example");
  });

  test("status-json current provider auth readiness overrides stale reopen metadata", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-stale-ready-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-stale-ready";
    await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      metadata: {
        providerAuthReopenDecision: "reopen_legacy_provider_auth_key_present",
        providerAuthReopenEligible: true,
        providerAuthReopenReason: "legacy_provider_auth_failure_key_present",
        currentProviderAuthFingerprint: "old-fingerprint",
        providerAuthReadinessStatus: "ready",
      },
    });

    const result = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
      args: ["--skip-dotenv"],
      env: {
        OPENAI_API_KEY: "shadow-openai-key",
        OPENAI_BASE_URL: "https://api.openai.example",
        JINA_API_KEY: "file-jina-key",
        JINA_API_BASE: "https://api.jina.example",
      },
    });

    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      providerAuthReopenDecision: "blocked_provider_auth_not_ready",
      providerAuthReopenEligible: false,
      providerAuthReopenBlockedReason: "process_env_shadows_dotenv",
      providerAuthReadinessStatus: "process_env_shadows_dotenv",
    });
    expect(summary.items[0].providerAuthReopenReason).toBeUndefined();
    expect(summary.items[0].providerAuthShadowedEnvNames)
      .toContain("OPENAI_API_KEY");
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("shadow-openai-key");
    expect(serialized).not.toContain("file-openai-key");
  });

  test("test qmd runner hook is not activated from dotenv", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-test-hook-dotenv-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "test-hook-dotenv";
    const { itemId, bookId, sourceHash } = await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });
    await writeProviderAuthReopenGraphFixture({
      stateRoot,
      bookId,
      sourceHash,
    });
    const resumeScript = join(tmpRoot, "fake-ready-resume.mjs");
    await writeFile(
      resumeScript,
      "console.log(JSON.stringify({ status: 'ready' }));\n",
    );
    const qmdScript = join(tmpRoot, "fake-qmd.mjs");
    await writeFile(
      qmdScript,
      [
        "await import('node:fs').then(fs => fs.writeFileSync(process.env.HOOK_MARKER, 'ran'));",
        "console.log('qmd-test');",
      ].join("\n"),
    );
    const hookMarker = join(tmpRoot, "hook-marker.txt");
    await writeFile(
      join(stateRoot, ".env"),
      [
        "OPENAI_API_KEY=file-openai-key",
        "OPENAI_BASE_URL=https://api.openai.example",
        "JINA_API_KEY=file-jina-key",
        "JINA_API_BASE=https://api.jina.example",
        "QMD_GRAPHRAG_ENABLE_TEST_HOOKS=1",
        "QMD_GRAPHRAG_TEST_QMD_RUNNER=1",
        `QMD_GRAPHRAG_QMD_RUNNER=${qmdScript}`,
      ].join("\n"),
    );

    const result = await new Promise<{
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(nodeScriptBin(), [
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
        "--max-command-attempts",
        "1",
        "--max-resume-passes",
        "1",
      ], {
        cwd: tmpRoot,
        env: {
          PATH: "/nonexistent",
          HOME: process.env.HOME ?? "",
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          HOOK_MARKER: hookMarker,
        },
      });
      let stderr = "";
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const hookMarkerExists = existsSync(hookMarker);
    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(hookMarkerExists).toBe(false);
    expect(checkpoint.status).not.toBe("completed");
  });

  test("provider auth status-json lets graph_vault dotenv override root dotenv", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-vault-env-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-vault-env";
    const { itemId } = await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });
    await writeFile(
      join(tmpRoot, ".env"),
      [
        "OPENAI_API_KEY=root-openai-key",
        "OPENAI_BASE_URL=https://root.openai.example",
        "JINA_API_KEY=root-jina-key",
        "JINA_API_BASE=https://root.jina.example",
      ].join("\n"),
    );
    await writeFile(
      join(stateRoot, ".env"),
      [
        "OPENAI_API_KEY=vault-openai-key",
        "OPENAI_BASE_URL=https://vault.openai.example",
        "JINA_API_KEY=vault-jina-key",
        "JINA_API_BASE=https://vault.jina.example",
      ].join("\n"),
    );
    const checkpointBefore = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(nodeScriptBin(), [
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
        "--project-dotenv",
        join(tmpRoot, ".env"),
        "--run-id",
        runId,
        "--status-json",
      ], {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpointAfter = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    );
    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpointAfter).toBe(checkpointBefore);
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      providerAuthReopenDecision: "reopen_legacy_provider_auth_key_present",
      providerAuthReopenEligible: true,
      providerAuthCredentialSources: {
        OPENAI_API_KEY: "graph_vault_dotenv_shadows_project_dotenv",
        OPENAI_BASE_URL: "graph_vault_dotenv_shadows_project_dotenv",
        JINA_API_KEY: "graph_vault_dotenv_shadows_project_dotenv",
        JINA_API_BASE: "graph_vault_dotenv_shadows_project_dotenv",
      },
    });
    expect(summary.items[0].providerAuthDotenvShadowedEnvNames)
      .toEqual(["JINA_API_BASE", "JINA_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
    const serialized = JSON.stringify(summary);
    for (const secret of [
      "root-openai-key",
      "root-jina-key",
      "vault-openai-key",
      "vault-jina-key",
      "https://root.openai.example",
      "https://vault.openai.example",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("provider auth status-json blocks missing OpenAI base URL", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-missing-base-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-missing-base";
    const { itemId } = await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });
    await writeFile(
      join(stateRoot, ".env"),
      [
        "OPENAI_API_KEY=file-openai-key",
        "JINA_API_KEY=file-jina-key",
        "JINA_API_BASE=https://api.jina.example",
      ].join("\n"),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(nodeScriptBin(), [
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
      ], {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          OPENAI_API_KEY: "file-openai-key",
          JINA_API_KEY: "file-jina-key",
          JINA_API_BASE: "https://api.jina.example",
        },
      });
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
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      providerAuthReopenDecision: "blocked_provider_auth_not_ready",
      providerAuthReopenEligible: false,
      providerAuthReopenBlockedReason: "missing_required_keys",
    });
    expect(summary.items[0].providerAuthRequiredEndpoints)
      .toEqual(["OPENAI_BASE_URL"]);
    expect(summary.items[0].providerAuthMissingRequiredKeys)
      .toEqual(["OPENAI_BASE_URL"]);
  });

  test("provider auth status-json blocks missing OpenAI API key", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-missing-key-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-missing-key";
    await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(nodeScriptBin(), [
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
      ], {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          OPENAI_BASE_URL: "https://api.openai.example",
          JINA_API_KEY: "file-jina-key",
          JINA_API_BASE: "https://api.jina.example",
        },
      });
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
    expect(summary.items[0]).toMatchObject({
      providerAuthReopenDecision: "blocked_provider_auth_not_ready",
      providerAuthReopenEligible: false,
      providerAuthReopenBlockedReason: "missing_required_keys",
    });
    expect(summary.items[0].providerAuthMissingRequiredKeys)
      .toContain("OPENAI_API_KEY");
  });

  test("skip-dotenv blocks provider auth reopen when only dotenv has required values", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-skip-dotenv-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-skip-dotenv";
    await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });

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
    expect(summary.items[0]).toMatchObject({
      providerAuthReopenDecision: "blocked_provider_auth_not_ready",
      providerAuthReopenEligible: false,
      providerAuthReopenBlockedReason: "missing_required_keys",
      providerAuthCredentialSources: {
        OPENAI_API_KEY: "dotenv_not_loaded",
        OPENAI_BASE_URL: "dotenv_not_loaded",
        JINA_API_KEY: "dotenv_not_loaded",
        JINA_API_BASE: "dotenv_not_loaded",
      },
    });
    expect(summary.items[0].providerAuthMissingRequiredKeys)
      .toEqual(["JINA_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
    expect(summary.items[0].providerAuthRootDotenvPresent).toBe(true);
    expect(summary.items[0].providerAuthGraphVaultDotenvPresent).toBe(true);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("file-openai-key");
    expect(serialized).not.toContain("file-jina-key");
  });

  test("provider auth status-json blocks unreadable provider config", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-bad-config-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-bad-config";
    await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });
    await writeFile(join(configDir, "index.yml"), "collections:\n  bad: [unterminated\n");

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(nodeScriptBin(), [
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
      ], {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          OPENAI_API_KEY: "file-openai-key",
          OPENAI_BASE_URL: "https://api.openai.example",
          JINA_API_KEY: "file-jina-key",
          JINA_API_BASE: "https://api.jina.example",
        },
      });
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
    expect(summary.items[0]).toMatchObject({
      providerAuthReopenDecision: "blocked_provider_auth_not_ready",
      providerAuthReopenEligible: false,
      providerAuthReopenBlockedReason: "provider_auth_config_unreadable",
      providerAuthConfigReadStatus: "invalid",
    });
  });

  test("provider auth reopen respects attempt limit without count downgrade", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-limit-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-limit";
    const { itemId } = await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      metadata: {
        providerAuthReopenAttemptCount: 3,
        providerAuthReopenedFingerprints: [],
      },
    });

    const result = await new Promise<{
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(nodeScriptBin(), [
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
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          OPENAI_API_KEY: "file-openai-key",
          OPENAI_BASE_URL: "https://api.openai.example",
          JINA_API_KEY: "file-jina-key",
          JINA_API_BASE: "https://api.jina.example",
        },
      });
      let stderr = "";
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "failed",
      recoveryDecision: "stop_until_fixed",
    });
    expect(summary.items[0]).toMatchObject({
      providerAuthReopenDecision: "blocked_provider_auth_reopen_attempt_limit",
      providerAuthReopenEligible: false,
      providerAuthReopenAttemptCount: 3,
    });
  });
});
