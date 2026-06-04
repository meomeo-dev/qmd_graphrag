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
  writeProviderAuthReopenGraphFixture,
  writeProviderAuthStoppedBatchFixture,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG EPUB batch runner - Status Recovery", () => {
  test("fail-fast transient failure persists recoverable pending checkpoint", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-fail-fast-transient-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "fail-fast-transient-fixture";
    const sourceBytes = "fail fast transient";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const normalizedPath = join(
      stateRoot,
      "input",
      `book-${sourceHash.slice(0, 10)}.md`,
    );
    await mkdir(dirname(normalizedPath), { recursive: true });
    await writeFile(normalizedPath, "# Book\n\nFail-fast transient fixture.\n");
    const resumeScript = join(tmpRoot, "fake-transient-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "console.error('HTTP 503 upstream unavailable');",
        "process.exit(1);",
      ].join("\n"),
    );

    const result = await new Promise<{
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
        "--fail-fast",
        "--max-transient-command-attempts",
        "2",
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
    });

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
    expect(result.stderr).toContain("HTTP 503 upstream unavailable");
    expect(manifest.status).toBe("incomplete");
    expect(checkpoint).toMatchObject({
      status: "pending",
      bookId,
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      failedStage: "resume-book-1",
      metadata: {
        waitingForProviderRecovery: true,
        providerRecoveryReason: "transient_failure_recovered",
      },
    });
    expect(checkpoint.nextRetryAt).toEqual(expect.any(String));
    expect(checkpoint.commandChecks.at(-1)).toMatchObject({
      name: "resume-book-1",
      status: "failed",
      failureKind: "transient",
      retryable: true,
      attemptExhausted: false,
      recoveryDecision: "retry_same_run_id",
    });
  });

  test("migrate-only backfills typed fields into legacy failure events", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-migrate-events-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "migrate-events-fixture";
    const sourceBytes = "legacy failed event";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(join(stateRoot, "reports"), { recursive: true });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const leakedReportText =
      "raw https://user:password@gateway.example/responses?api_key=raw-key" +
      " Bearer raw-token sk-raw-secret /var/tmp/qmd-secret/query.log";
    await writeFile(join(stateRoot, "reports", "query.log"), leakedReportText);
    await writeFile(join(stateRoot, "reports", "report.txt"), "raw provider report");
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
        completedItems: 0,
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
        normalizedPath: join(
          ".tmp-tests",
          "graph_vault",
          "input",
          "book.md",
        ),
        attempts: 1,
        failedAt: "2026-05-23T00:01:00.000Z",
        errorSummary: "HTTP 503 Retry-After: 180 Service temporarily unavailable",
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 3,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 12,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          errorSummary: "HTTP 503 Retry-After: 180 Service temporarily unavailable",
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
        command: "resume-book-1",
        at: "2026-05-23T00:01:00.000Z",
        message: "HTTP 503 Retry-After: 180 Service temporarily unavailable",
        recoveryDecision: "retry_same_run_id",
        metadata: { attempt: 3, exitCode: 1 },
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
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const eventLines = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const recoverySummary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const migrated = eventLines.find((event) => event.event === "command_failed");
    const exhausted = eventLines.find(
      (event) => event.event === "command_retry_exhausted",
    );
    const rawLogEvent = eventLines.find((event) => event.event === "raw_log_migrated");
    const remainingRawReports = readdirSync(join(stateRoot, "reports"));
    const movedRawReports = readdirSync(join(logRoot, "graph_vault_reports"));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(migrated).toMatchObject({
      eventId: expect.any(String),
      sequence: 1,
      runnerSessionId: expect.any(String),
      failureKind: "transient",
      retryable: true,
      attemptExhausted: true,
      providerStatusCode: 503,
      retryAfterSeconds: 180,
      recoveryDecision: "retry_same_run_id",
      failedStage: "resume-book-1",
    });
    expect(exhausted).toBeUndefined();
    expect(recoverySummary).toMatchObject({
      schemaVersion: SchemaVersion,
      runId,
      recoveryDecision: "retry_same_run_id",
      retryPolicy: {
        maxCommandAttempts: 3,
        maxTransientCommandAttempts: 12,
        retryBudgetSeconds: 7200,
        maxProviderRecoveryWaits: 3,
        commandTimeoutSeconds: 21600,
      },
    });
    expect(recoverySummary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      waitingForProviderRecovery: true,
      failedStage: "resume-book-1",
      providerStatusCode: 503,
      retryAfterSeconds: 180,
    });
    expect(rawLogEvent).toMatchObject({
      event: "raw_log_migrated",
      metadata: {
        sourceLocator: "graph_vault/reports/query.log",
        targetLogRootName: "logs",
      },
    });
    expect(remainingRawReports).toEqual([]);
    expect(movedRawReports.filter((name) => name.endsWith("query.log")))
      .toHaveLength(1);
    expect(movedRawReports.filter((name) => name.endsWith("report.txt")))
      .toHaveLength(1);
    const movedQueryLogName = movedRawReports.find((name) => name.endsWith("query.log"));
    expect(movedQueryLogName).toBeDefined();
    const movedQueryLog = readFileSync(
      join(logRoot, "graph_vault_reports", movedQueryLogName ?? ""),
      "utf8",
    );
    expect(movedQueryLog).toContain("//[REDACTED]@");
    expect(movedQueryLog).toContain("api_key=[REDACTED]");
    expect(movedQueryLog).toContain("Bearer [REDACTED]");
    expect(movedQueryLog).toContain("sk-[REDACTED]");
    expect(movedQueryLog).toContain("[ABS_PATH]");
    expect(movedQueryLog).not.toContain("user:password");
    expect(movedQueryLog).not.toContain("raw-key");
    expect(movedQueryLog).not.toContain("raw-token");
    expect(movedQueryLog).not.toContain("sk-raw-secret");
    expect(movedQueryLog).not.toContain(tmpRoot);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("migrate-only recovers a partial event log tail", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-event-tail-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "event-tail-fixture";
    const sourceBytes = "partial event tail";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
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
        attempts: 0,
        commandChecks: [],
      },
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        eventId: "evt-existing",
        sequence: 1,
        runnerSessionId: "session-existing",
        event: "batch_started",
        at: "2026-05-23T00:00:00.000Z",
      }) + "\n{\"schemaVersion\"",
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
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(events.some((event) =>
      event.event === "partial_event_tail_recovered"
    )).toBe(true);
    expect(events.every((event) =>
      typeof event.eventId === "string" &&
      Number.isInteger(event.sequence) &&
      typeof event.runnerSessionId === "string"
    )).toBe(true);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("migrate-only normalizes duplicate event ids and non-monotonic sequences", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-event-dedupe-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "event-dedupe-fixture";
    const sourceBytes = "duplicate event ids";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
    await mkdir(join(runRoot, "items"), { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeDurableJsonFixture(join(runRoot, "manifest.json"), {
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
    });
    await writeDurableJsonFixture(join(runRoot, "items", `${itemId}.json`), {
      schemaVersion: SchemaVersion,
      itemId,
      runId,
      status: "pending",
      sourceName: "Book.epub",
      sourceRelativePath,
      sourceHash,
      normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
      bookId: batchBookId(sourceHash, sourceRelativePath),
      attempts: 0,
      commandChecks: [],
    });
    await writeFile(join(runRoot, "events.jsonl"), [
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        eventId: "evt-dup",
        sequence: 5,
        runnerSessionId: "legacy",
        event: "batch_started",
        at: "2026-05-23T00:00:00.000Z",
      }),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        eventId: "evt-dup",
        sequence: 5,
        runnerSessionId: "legacy",
        event: "batch_state_migrated_marker",
        at: "2026-05-23T00:00:01.000Z",
      }),
    ].join("\n") + "\n");

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
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const eventIds = events.map((event) => event.eventId);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(events.map((event) => event.sequence))
      .toEqual(events.map((_, index) => index + 1));
    const firstRunRecoveredId = events.find((event) =>
      event.event === "batch_state_migrated_marker"
    )?.eventId;
    const second = await new Promise<{ stderr: string; exitCode: number | null }>(
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
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );
    const secondEvents = readFileSync(join(runRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const secondRunRecoveredId = secondEvents.find((event) =>
      event.event === "batch_state_migrated_marker"
    )?.eventId;
    expect(second.exitCode).toBe(0);
    expect(second.stderr).toBe("");
    expect(secondRunRecoveredId).toBe(firstRunRecoveredId);
    expect(events.some((event) =>
      event.event === "partial_event_tail_recovered" &&
      event.metadata?.normalizedEventLog === true &&
      Array.isArray(event.metadata?.diagnostics)
    )).toBe(true);
    expect(secondEvents.some((event) =>
      event.event === "event_log_normalized" &&
      Array.isArray(event.metadata?.diagnostics)
    )).toBe(true);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("migrate-only leaves legacy GraphRAG output manifests stale", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-legacy-output-manifest-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "legacy-output-manifest-fixture";
    const sourceBytes = "absolute output manifest";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const outputRel = join("books", bookId, "graphrag", "output");
    const outputDir = join(stateRoot, outputRel);
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(outputDir, { recursive: true });
    await writeDurableJsonFixture(
      join(outputDir, "qmd_output_manifest.json"),
      {
        schemaVersion: SchemaVersion,
        bookId,
        sourceHash,
        documentId: `doc-${sourceHash.slice(0, 12)}`,
        contentHash: sourceHash,
        stageFingerprints: {
          ingest: "fp-ingest",
          normalize: "fp-normalize",
          graph_extract: "fp-graph-extract",
          community_report: "fp-community-report",
          embed: "fp-embed",
          query_ready: "fp-query-ready",
        },
        providerFingerprint: "provider-fp",
        outputDir,
        producerRunId: "run-query-ready",
        stageProducerRunIds: {
          graph_extract: "run-graph-extract",
          community_report: "run-community-report",
          embed: "run-embed",
        },
      },
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
        bookId,
        attempts: 0,
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
          "--migrate-only",
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const manifest = JSON.parse(readFileSync(
      join(outputDir, "qmd_output_manifest.json"),
      "utf8",
    ));
    const eventsRaw = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(manifest.outputDir).toBe(outputDir);
    expect(eventsRaw).not.toContain("graph_output_manifest_migrated");
  });

  test("status-json emits recovery summary without running work", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-status-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "status-json-fixture";
    const sourceBytes = "status only";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(join(sourceDir, "Book.epub"), sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, join(sourceDir, "Book.epub"));
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
        attempts: 1,
        recoveryDecision: "retry_same_run_id",
        failureKind: "transient",
        retryable: true,
        nextRetryAt: "2026-05-23T00:05:00.000Z",
        retryDelaySeconds: 240,
        commandChecks: [],
      },
    );
    const checkpointPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );
    const checkpointBeforeStatusJson = readFileSync(checkpointPath, "utf8");

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

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      schemaVersion: SchemaVersion,
      runId,
      recoveryDecision: "retry_same_run_id",
      retryableItemCount: 1,
      nextRetryAt: "2026-05-23T00:05:00.000Z",
    });
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      qmdBuildStatus: { status: "pending" },
      graphBuildStatus: { status: "pending" },
      failureKind: "transient",
      retryable: true,
      nextRetryAt: "2026-05-23T00:05:00.000Z",
    });
    expect(readFileSync(checkpointPath, "utf8")).toBe(checkpointBeforeStatusJson);
    expect(existsSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
    )).toBe(false);
  });
});
