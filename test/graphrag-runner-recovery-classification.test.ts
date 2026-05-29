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

describe("GraphRAG EPUB batch runner - Recovery Classification", () => {
  test("all batch qmd commands acquire the qmd index file lock", async () => {
    const fixture = await runParallelRunnerFixture({
      concurrency: 1,
      runId: "qmd-index-file-lock-fixture",
      commandCheckNames: requiredBatchCommandCheckNames,
      bookCount: 1,
    });
    const lockedCommands = new Set(requiredBatchCommandCheckNames);
    const acquired = fixture.events.filter((event) =>
      event.event === "qmd_index_file_lock_acquired"
    );
    const released = fixture.events.filter((event) =>
      event.event === "qmd_index_file_lock_released"
    );
    const countByCommand = (events: Array<Record<string, unknown>>) =>
      events.reduce((counts, event) => {
        const command = String(event.command);
        counts.set(command, (counts.get(command) ?? 0) + 1);
        return counts;
      }, new Map<string, number>());

    expect(fixture.result.exitCode).toBe(0);
    expect(fixture.result.stderr).toBe("");
    expect(acquired.length).toBeGreaterThanOrEqual(lockedCommands.size);
    expect(released).toHaveLength(acquired.length);
    expect(acquired.every((event) => lockedCommands.has(String(event.command))))
      .toBe(true);
    expect(released.every((event) => lockedCommands.has(String(event.command))))
      .toBe(true);
    expect(new Set(acquired.map((event) => String(event.command))))
      .toEqual(lockedCommands);
    expect(countByCommand(acquired)).toEqual(countByCommand(released));
    expect(acquired.every((event) =>
      typeof event.metadata?.generation === "number" &&
	      typeof event.metadata?.fencingTokenHash === "string" &&
	      typeof event.metadata?.operationId === "string" &&
	      event.metadata?.lane === "qmdIndexWriterLane" &&
	      event.metadata?.targetMappingOwner === "qmd"
	    )).toBe(true);
    expect(released.every((event) =>
      event.metadata?.released === true &&
      typeof event.metadata?.generation === "number" &&
      typeof event.metadata?.fencingTokenHash === "string" &&
      typeof event.metadata?.operationId === "string"
    )).toBe(true);
    expect(existsSync(join(fixture.tmpRoot, "index.sqlite.lock"))).toBe(false);
    await rm(fixture.tmpRoot, { recursive: true, force: true });
  }, 180000);

  test("book-concurrency 1 preserves sequential book execution", async () => {
    const fixture = await runParallelRunnerFixture({
      concurrency: 1,
      runId: "sequential-workers-fixture",
    });
    const starts = fixture.resumeEvents.filter((event) => event.phase === "start");
    const ends = fixture.resumeEvents.filter((event) => event.phase === "end");
    const firstEnd = ends.map((event) => event.at).sort((a, b) => a - b)[0];
    const secondStart = starts.map((event) => event.at).sort((a, b) => a - b)[1];
    expect(fixture.result.exitCode).toBe(0);
    expect(fixture.result.stderr).toBe("");
    expect(starts).toHaveLength(2);
    expect(secondStart).toBeGreaterThanOrEqual(firstEnd);
    expect(fixture.events.some((event) =>
      event.event === "batch_worker_pool_start"
    )).toBe(false);
    expect(fixture.events.filter((event) =>
      event.event === "item_worker_start"
    )).toHaveLength(2);
    await rm(fixture.tmpRoot, { recursive: true, force: true });
  }, 90000);

  test("rejects raw log directories that still resolve inside graph_vault", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "qmd-batch-log-root-"));
    const sourceDir = join(tmpRoot, "empty-source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          join(stateRoot, "..logs"),
          "--skip-dotenv",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--log-root must be outside graph_vault");
  });

  test("rejects symlinked raw log directories that resolve inside graph_vault", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "qmd-batch-log-symlink-"));
    const sourceDir = join(tmpRoot, "empty-source");
    const stateRoot = join(tmpRoot, "graph_vault");
    await mkdir(join(stateRoot, "logs"), { recursive: true });
    symlinkSync(join(stateRoot, "logs"), join(tmpRoot, "logs-link"));
    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          join(tmpRoot, "logs-link"),
          "--skip-dotenv",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--log-root must be outside graph_vault");
  });

  test("completed-manifest annotates default work but does not skip real builds", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-skipped-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "skipped-fixture";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sourceBytes = "still processed when seeded";
    await writeFile(join(sourceDir, "Book.epub"), sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const completedManifest = join(tmpRoot, "completed.json");
    const { createHash } = await import("crypto");
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await writeFile(
      completedManifest,
      JSON.stringify([{ source: "Book.epub", sourceHash }]),
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
    const manifest = JSON.parse(readFileSync(join(batchRoot, "manifest.json"), "utf8"));
    const eventLines = readFileSync(join(batchRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const [checkpointName] = readdirSync(join(batchRoot, "items"));
    const checkpoint = JSON.parse(
      readFileSync(join(batchRoot, "items", checkpointName), "utf8"),
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(manifest).toMatchObject({
      schemaVersion: SchemaVersion,
      runId,
      status: "failed",
      totalItems: 1,
      pendingItems: 0,
      runningItems: 0,
      completedItems: 0,
      skippedItems: 0,
      importedCompletedItems: 1,
      failedItems: 1,
      expectedCommandCheckCount: 27,
    });
    expect(checkpoint).toMatchObject({
      schemaVersion: SchemaVersion,
      runId,
      status: "failed",
      sourceName: "Book.epub",
      sourceHash,
      bookId: batchBookId(sourceHash, relative(projectRoot, join(sourceDir, "Book.epub"))),
      expectedCommandCheckCount: 27,
      metadata: {
        seedMatchMode: "source_name_and_hash",
        importedCompletedMode: "audit_only",
      },
    });
    expect(eventLines.some((event) => event.event === "item_skipped")).toBe(false);
    expect(eventLines.some((event) => event.event === "command_start")).toBe(true);
    expect(eventLines.at(-1)).toMatchObject({
      event: "batch_incomplete",
      recoveryDecision: "stop_until_fixed",
    });
  });

  test("keeps transient and permanent provider recovery decisions typed", () => {
    const script = readFileSync(
      join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
      "utf8",
    );

    expect(classifyFailure("HTTP 400 timeout")).toMatchObject({
      failureKind: "permanent",
      retryable: false,
      providerStatusCode: 400,
    });
    expect(classifyFailure("HTTP 409 conflict")).toMatchObject({
      failureKind: "permanent",
      retryable: false,
      providerStatusCode: 409,
    });
    expect(classifyFailure("HTTP 429 retry-after: 7")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 429,
      retryAfterSeconds: 7,
    });
    expect(classifyFailure("HTTP 500")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 500,
    });
    expect(classifyFailure("HTTP 599")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 599,
    });
    expect(classifyFailure("status code: 429")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 429,
    });
    expect(classifyFailure("error code: 500")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 500,
    });
    expect(classifyFailure("(599)")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 599,
    });
    expect(classifyFailure("timeout without status")).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure("openai.APIError: stream_read_error")).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "litellm.APIConnectionError: Jina_aiException - Cannot connect to host " +
      "api.jina.ai:443 ssl:<ssl.SSLContext object> [None]",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure("httpx.ConnectError: [Errno 8] nodename nor servname"))
      .toMatchObject({
        failureKind: "transient",
        retryable: true,
      });
    expect(classifyFailure("aiohttp.ClientConnectorError: getaddrinfo failed"))
      .toMatchObject({
        failureKind: "transient",
        retryable: true,
      });
    expect(classifyFailure("urllib3 ReadTimeoutError: read reset by peer"))
      .toMatchObject({
        failureKind: "transient",
        retryable: true,
      });
    expect(classifyFailure(
      "Responses API transient error kind=server_error status_code=unknown",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "Responses API transient error kind=rate_limit_exceeded status_code=unknown",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "Responses API transient error kind=responses_output_none " +
      "status_code=unknown: completed response output was null",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "GraphRAG index workflow failed: " +
      "[{\"workflow\":\"extract_graph\",\"errorMessage\":\"Responses API " +
      "transient failure after 13 attempts: OpenAIResponsesTransientError: " +
      "Responses API transient error kind=responses_output_none " +
      "status_code=unknown: completed response output was null\"}]",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "GraphRAG index workflow failed: " +
      "[{\"workflow\":\"extract_graph\",\"errorMessage\":\"'NoneType' object " +
      "is not iterable\"}]",
    )).toMatchObject({
      failureKind: "unknown",
      retryable: false,
    });
    expect(classifyFailure(
      "GraphRAG index workflow failed: " +
      "[{\"workflow\":\"extract_graph\",\"errorMessage\":\"TypeError: local " +
      "parser object is not iterable\"}]",
    )).toMatchObject({
      failureKind: "unknown",
      retryable: false,
    });
    expect(classifyFailure(
      "Responses API completed response output field was missing",
    )).toMatchObject({
      failureKind: "unknown",
      retryable: false,
    });
    expect(classifyFailure(
      "GraphRAG index workflow failed: " +
      "[{\"workflow\":\"extract_graph\",\"errorMessage\":\"An error occurred " +
      "while processing your request. You can retry your request, or contact " +
      "support if the error persists. Please include the request ID req-1.\"}]",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure("GraphRAG stage report partial-output failure")).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "GraphRAG stage did not produce valid book-scoped artifacts: " +
      "{\"missingArtifactKinds\":[\"graphrag_documents_parquet\"]} " +
      "litellm.APIConnectionError",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "GraphRAG index workflow failed: " +
      "[{\"workflow\":\"create_community_reports_text\"," +
      "\"errorMessage\":\"'float' object is not subscriptable\"}] " +
      "Cannot connect to host api.jina.ai",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure("No report found for community: 16")).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure("SqliteError: database is locked")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      localRetryClass: "sqlite_busy_or_locked",
    });
    expect(classifyFailure("SQLITE_BUSY: database is busy")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      localRetryClass: "sqlite_busy_or_locked",
    });
    const graphQueryProviderUnavailable = JSON.stringify({
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
    expect(classifyFailure(graphQueryProviderUnavailable)).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "qmd-query failed:\n" + graphQueryProviderUnavailable +
      "\nhttpx.ConnectError: [SSL: UNEXPECTED_EOF_WHILE_READING]",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    const graphQueryProviderNotConfigured = JSON.stringify({
      schemaVersion: "1.0.0",
      route: "graphrag",
      stage: "provider",
      provider: "graphrag",
      capability: "graph_query",
      code: "provider_unavailable",
      retryable: false,
      redactedMessage: "GraphRAG query provider is not configured.",
    }, null, 2);
    expect(classifyFailure(graphQueryProviderNotConfigured)).toMatchObject({
      failureKind: "unknown",
      retryable: false,
    });
    expect(script).not.toContain("function isTransient(");
    expect(script).toContain("function recoveryDecisionForBatch(checkpoints)");
    expect(script).toContain("item.status !== \"completed\"");
    expect(script).toContain("item.recoveryDecision === \"retry_same_run_id\"");
    expect(script).toContain("checkpoint?.status === \"failed\" && checkpoint.retryable === false");
    expect(script).not.toContain("event: \"item_retry_exhausted\"");
    expect(script).toContain("recoverProviderTransientCheckpoint(activeItem, checkpoint)");
    expect(script).toContain("transientBudgetAvailable(running)");
    expect(script).toContain("if (options.allowTransientBudget) {");
    expect(script).toContain("throw Object.assign(new Error(check.errorSummary)");
    expect(script).toContain("failedStage: name");
    expect(script).toContain("const claim = markItemRunning(");
  });

  test("classifies query-ready projection failures as local artifact gates", () => {
    expect(classifyFailure(
      "GraphRAG document identity is missing for query_ready: doc-fd8875181a17",
    )).toMatchObject({
      failureKind: "permanent",
      retryable: false,
    });
    expect(classifyFailure(
      "capabilityScope references unknown or not-ready graphCapabilityId(s): " +
      "book-356ff4920cdf-0bbd8bdb:graph_query",
    )).toMatchObject({
      failureKind: "permanent",
      retryable: false,
    });
    expect(classifyFailure(
      "GraphRAG document identity sidecar does not match query_ready",
    )).toMatchObject({
      failureKind: "permanent",
      retryable: false,
    });
    expect(classifyFailure(
      "GraphRAG document identity sidecar evidence is invalid for query_ready: " +
      "doc-fd8875181a17",
    )).toMatchObject({
      failureKind: "permanent",
      retryable: false,
    });
    expect(classifyFailure(
      "query_ready requires completed graph_extract, community_report and embed stages",
    )).toMatchObject({
      failureKind: "permanent",
      retryable: false,
    });
    expect(classifyFailure(
      "graph_vault/settings.yaml is not the managed projection of .qmd/index.yml",
    )).toMatchObject({
      failureKind: "permanent",
      retryable: false,
    });
    const repairScript = readFileSync(
      join(projectRoot, "scripts", "graphrag", "resume-book-workspace.mjs"),
      "utf8",
    );
    expect(repairScript).toContain(
      "graphrag document identity sidecar evidence is invalid for query_ready",
    );
    expect(repairScript).toContain(
      "graphrag document identity sidecar does not match query_ready",
    );
    expect(repairScript).toContain(
      "graph_vault/settings.yaml is not the managed projection of .qmd/index.yml",
    );
    expect(repairScript).toContain(
      "query_ready requires completed graph_extract",
    );
  });

  test("repair-only validates query-ready projection without graph query calls", () => {
    const script = readFileSync(
      join(projectRoot, "scripts", "graphrag", "resume-book-workspace.mjs"),
      "utf8",
    );
    const repairOnlyStart = script.indexOf(
      "async function runRepairLocalArtifactGateOnly",
    );
    const runStart = script.indexOf("async function run()", repairOnlyStart);
    const repairOnlyBody = script.slice(repairOnlyStart, runStart);

    expect(repairOnlyStart).toBeGreaterThanOrEqual(0);
    expect(repairOnlyBody).toContain("completeProducerStageFromEvidence");
    expect(repairOnlyBody).toContain("graphQueryScopeFromSync");
    expect(repairOnlyBody).toContain("graph_identity_projection_missing");
    expect(repairOnlyBody).toContain("graph_query_capability_projection_missing");
    expect(repairOnlyBody).not.toContain("runtime.graphQuery");
  });

  test("status-json starts transient retry budget at first failure", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-long-run-first-transient-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "long-run-first-transient";
    const sourceBytes = "long running graph before first transient";
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
        updatedAt: "2026-05-23T03:01:00.000Z",
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
        attempts: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        failedAt: new Date().toISOString(),
        failureKind: "transient",
        retryable: true,
        retryExhausted: true,
        recoveryDecision: "retry_same_run_id",
        failedStage: "resume-book-1",
        errorSummary: "HTTP 503 Retry-After: 180 Service temporarily unavailable",
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 3,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 64,
          startedAt: "2026-05-23T03:00:00.000Z",
          completedAt: "2026-05-23T03:01:00.000Z",
          failureKind: "transient",
          retryable: true,
          attemptExhausted: true,
          providerStatusCode: 503,
          retryAfterSeconds: 180,
          recoveryDecision: "retry_same_run_id",
          errorSummary: "HTTP 503 Retry-After: 180 Service temporarily unavailable",
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
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventsExist = existsSync(eventLogPath);
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      waitingForProviderRecovery: true,
      providerRecoveryReason: "transient_failure_recovered",
    });
    expect(summary.items[0].providerRecoveryReason)
      .not.toBe("retry_budget_window_elapsed");
    expect(eventsExist).toBe(false);
  });
});
