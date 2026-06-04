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
  writeCompleteLanceDbFixture,
  writeCompletedGraphBatchFixture,
  writeDurableJsonFixture,
  writeDurableTextFixture,
  writeDurableYamlFixture,
  writeGraphRagPromptFixtures,
  writeMinimalParquetFixture,
  writeMinimalEpubFixture,
  writeQmdBuildFixture,
  writeProviderAuthReopenGraphFixture,
  writeProviderAuthStoppedBatchFixture,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG EPUB batch runner - Completed Reconciliation", () => {
  test("status-json projects stale remote running items as retryable pending", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-stale-remote-running-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "stale-remote-running-fixture";
    const sourceBytes = "stale remote running";
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
        runningItems: 1,
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
        status: "running",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        runnerSessionId: "stale-remote-session",
        runnerHost: "other-host.example",
        runnerPid: 12345,
        runnerHeartbeatAt: "2026-05-23T00:01:00.000Z",
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
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventLog = existsSync(eventLogPath) ? readFileSync(eventLogPath, "utf8") : "";
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.counts).toMatchObject({ pending: 1 });
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      recoveryDecision: "retry_same_run_id",
      failedStage: "runner_orphaned",
    });
    expect(checkpoint.status).toBe("running");
    expect(eventLog).not.toContain("item_running_recovered");
  });

  test("normal run does not steal fresh remote running items", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-remote-running-run-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "remote-running-run-fixture";
    const sourceBytes = "remote running normal run";
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
        runningItems: 1,
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
        status: "running",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        runnerSessionId: "remote-session",
        runnerHost: "other-host.example",
        runnerPid: 12345,
        runnerHeartbeatAt: new Date().toISOString(),
        commandChecks: [],
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
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "running",
      runnerSessionId: "remote-session",
      runnerHost: "other-host.example",
      attempts: 1,
    });
    expect(events.some((event) => event.event === "item_running_observed"))
      .toBe(true);
    expect(events.some((event) => event.event === "item_start")).toBe(false);
  });

  test("normal run recovers stale remote running items before processing", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-stale-remote-running-run-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "stale-remote-running-run-fixture";
    const sourceBytes = "stale remote running normal run";
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
    const normalizedPath = join(
      stateRoot,
      "input",
      `book-${sourceHash.slice(0, 10)}.md`,
    );
    await mkdir(dirname(normalizedPath), { recursive: true });
    await writeFile(normalizedPath, "# Book\n\nStale remote running fixture.\n");
    const resumeScript = join(tmpRoot, "fake-stale-remote-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "console.error('permanent GraphRAG failure after stale lease recovery');",
        "process.exit(1);",
      ].join("\n"),
    );
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
        runningItems: 1,
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
        status: "running",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        runnerSessionId: "stale-remote-session",
        runnerHost: "other-host.example",
        runnerPid: 12345,
        runnerHeartbeatAt: "2026-05-23T00:01:00.000Z",
        commandChecks: [],
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
          "--max-resume-passes",
          "1",
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
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(events.some((event) => event.event === "item_running_recovered"))
      .toBe(true);
    expect(events.some((event) => event.event === "item_start")).toBe(true);
    expect(checkpoint).toMatchObject({
      status: "failed",
      attempts: 2,
      metadata: {
        orphanedRunnerRecovered: true,
        orphanedRunnerHost: "other-host.example",
      },
    });
  });

  test("migrate-only reopens completed items without real closed-loop evidence", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-reopen-completed-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "reopen-completed-fixture";
    const sourceBytes = "legacy completed item";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const commandChecks = passedBatchCommandChecks();

    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
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
        normalizedPath: join(
          ".tmp-tests",
          "graph_vault",
          "input",
          "book.md",
        ),
        bookId,
        attempts: 1,
        expectedCommandCheckCount: 27,
        maxCommandAttempts: 3,
        maxResumePasses: 8,
        completedAt: "2026-05-23T00:01:00.000Z",
        commandChecks,
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
          "--migrate-only",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const batchRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const manifest = JSON.parse(readFileSync(join(batchRoot, "manifest.json"), "utf8"));
    const checkpoint = JSON.parse(
      readFileSync(join(batchRoot, "items", `${itemId}.json`), "utf8"),
    );
    const events = readFileSync(join(batchRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(manifest).toMatchObject({
      status: "running",
      pendingItems: 1,
      completedItems: 0,
      failedItems: 0,
    });
    expect(checkpoint).toMatchObject({
      status: "pending",
      qmdBuildStatus: {
        status: "pending",
        stage: "qmd-build",
        reason: "qmd_build_manifest_missing",
      },
      graphBuildStatus: {
        status: "pending",
        stage: "graph_extract",
        reason: "real_graphrag_stage_missing",
      },
    });
    expect(events.some((event) => event.event === "item_completed_reopened"))
      .toBe(true);
  });

  test("non-migrate runs reopen skipped items for real build", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-reopen-skipped-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "reopen-skipped-fixture";
    const sourceBytes = "legacy skipped item";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;

    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
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
        skippedItems: 1,
        importedCompletedItems: 1,
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
        status: "skipped",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 0,
        recoveryDecision: "none",
        commandChecks: [],
        metadata: {
          importedCompletedMode: "skip_for_migration",
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
          "--command-timeout-seconds",
          "1",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const batchRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const manifest = JSON.parse(readFileSync(join(batchRoot, "manifest.json"), "utf8"));
    const checkpoint = JSON.parse(
      readFileSync(join(batchRoot, "items", `${itemId}.json`), "utf8"),
    );
    const events = readFileSync(join(batchRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(manifest.skippedItems).toBe(0);
    expect(checkpoint.status).not.toBe("skipped");
    expect(checkpoint.metadata).toMatchObject({
      reopenedSkippedForRealBuild: true,
    });
    expect(events.some((event) =>
      event.event === "item_skipped_reopened" &&
      event.itemId === itemId
    )).toBe(true);
    expect(events.some((event) => event.event === "item_skipped")).toBe(false);
  });

  test("status-json accepts portable book-scoped GraphRAG producer evidence", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-graph-evidence-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "graph-evidence-fixture";
    const sourceBytes = "completed with graph evidence";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const outputRel = join("books", bookId, "graphrag", "output");
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
    const normalizedPath = join(stateRoot, "books", bookId, "input", "book.md");
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
    });
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
        outputDir: `books/${bookId}/graphrag/output`,
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
      join(stateRoot, "books", bookId, "state", "artifacts.yaml"),
      { schemaVersion: SchemaVersion, items: graphArtifacts },
    );
    await writeDurableYamlFixture(
      join(stateRoot, "books", bookId, "state", "checkpoints.yaml"),
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
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      recoveryDecision: "none",
      counts: { completed: 1 },
    });
    expect(summary.items[0]).toMatchObject({
      status: "completed",
      qmdBuildStatus: { status: "succeeded" },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
    });

    await writeFile(join(outputDir, "documents.parquet"), "", "utf8");
    const missingCoreResult = await new Promise<{
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
    const missingCoreSummary = JSON.parse(missingCoreResult.stdout);
    expect(missingCoreResult.exitCode).toBe(0);
    expect(missingCoreResult.stderr).toBe("");
    expect(missingCoreSummary.items[0].graphBuildStatus).toMatchObject({
      status: "stale",
      stage: "graph_extract",
      reason: "stage_artifact_invalid:content_hash_mismatch",
    });
    expect(missingCoreSummary.items[0].graphBuildStatus.reason)
      .not.toContain("stats");
    await rm(tmpRoot, { recursive: true, force: true });
  });
});
