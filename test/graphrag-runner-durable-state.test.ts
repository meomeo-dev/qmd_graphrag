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

describe("GraphRAG EPUB batch runner - Durable State", () => {
  test("keeps batch state typed and raw logs outside graph_vault", () => {
    const script = readFileSync(
      join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
      "utf8",
    );
    const contract = readFileSync(
      join(projectRoot, "src", "contracts", "batch-run.ts"),
      "utf8",
    );

    expect(contract).toContain("BatchRunManifestSchema");
    expect(contract).toContain("BatchItemCheckpointSchema");
    expect(contract).toContain("BatchEventLogSchema");
    expect(contract).toContain("\"skipped\"");
    expect(contract).toContain("BatchFailureKindSchema");
    expect(contract).toContain("BatchRecoveryDecisionSchema");
    expect(contract).toContain("pendingItems");
    expect(contract).toContain("runningItems");
    expect(contract).toContain("skippedItems");
    expect(contract).toContain("expectedCommandCheckCount");
    expect(contract).toContain("maxResumePasses");
    expect(contract).toContain("nextRetryAt");
    expect(contract).toContain("retryBudgetSeconds");
    expect(contract).toContain("commandTimeoutSeconds");
    expect(contract).toContain("runnerSessionId");
    expect(contract).toContain("providerStatusCode");
    expect(contract).toContain("retryAfterSeconds");
    expect(contract).toContain("providerRecoveryWaitCount");
    expect(contract).toContain("providerRecoveryReason");
    expect(contract).toContain("recoveryDecision: BatchRecoveryDecisionSchema");
    expect(script).toContain("\"completed-manifest\"");
    expect(script).toContain("\"heartbeat-interval-seconds\"");
    expect(script).toContain("\"fail-fast\"");
    expect(script).toContain("\"migrate-only\"");
    expect(script).toContain("\"status-json\"");
    expect(script).toContain("\"max-resume-passes\"");
    expect(script).toContain("\"max-transient-command-attempts\"");
    expect(script).toContain("\"command-timeout-seconds\"");
    expect(script).toContain("\"book-concurrency\"");
    expect(script).toContain("\"openai-provider-concurrency\"");
    expect(script).toContain("\"jina-provider-concurrency\"");
    expect(script).toContain("\"local-cpu-concurrency\"");
    expect(script).toContain("coordinator-lock.json");
    expect(script).toContain("qmd-projection\\.yaml");
    expect(script).toContain("qmdProjectionCatalog");
    expect(script).toContain("CoordinatorLockSchema");
    expect(script).toContain("BookLeaseSchema");
    expect(script).toContain("ProviderSlotLeaseSchema");
    expect(script).toContain("SubprocessRecordSchema");
    expect(script).toContain("eventId");
    expect(script).toContain("sequence");
    expect(script).toContain("fencingToken");
    expect(script).toContain("partial_event_tail_recovered");
    expect(script).toContain("provider_slot_lease_acquired");
    expect(script).toContain("provider_slot_lease_released");
    expect(script).toContain("subprocesses");
    expect(script).toContain("runWorkerPool");
    expect(script).toContain("item_worker_candidate");
    expect(script).toContain("item_worker_queued");
    expect(script).toContain("batch_worker_pool_start");
    expect(script).toContain("batch_worker_pool_settled");
    expect(script).toContain("providerSemaphoreForResumeNextStage");
    expect(script).toContain("providerSlotProvider");
    expect(script).toContain("openai_provider");
    expect(script).toContain("jina_provider");
    expect(script).toContain("qmd_index_writer");
    expect(script).toContain("_slot_acquired");
    expect(script).toContain("default: \"21600\"");
    expect(script).toContain("startCommandHeartbeatMonitor");
    expect(script).toContain("currentCommandStartedAt");
    expect(script).toContain("withJsonFileLock");
    expect(script).toContain("withCheckpointPersistenceInvariants");
    expect(script).toContain("renameSync");
    expect(script).toContain("const start = epochMs(checkpoint.retryStartedAt)");
    expect(script).toContain("recovery-summary.json");
    expect(script).toContain("item_retry_deferred");
    expect(script).toContain("item_provider_recovery_wait");
    expect(script).toContain("item_retry_window_deferred");
    expect(script).toContain("batch_wait_retry_window");
    expect(script).toContain("item_running_recovered");
    expect(script).toContain("batch_state_migrated");
    expect(script).toContain("migrateGraphVaultRawReportsForItems");
    expect(script).toContain("\"--report-root\"");
    expect(script).toContain("assertNoBookScopedRawReports");
    expect(script).toContain("BatchRunManifestSchema.parse");
    expect(script).toContain("withBuildStatusSnapshot(item, checkpoint)");
    expect(script).toContain("BatchEventLogSchema.parse");
    expect(script).toContain("command_attempt_budget_exhausted");
    expect(script).toContain("command_retry_exhausted");
    expect(script).toContain("batch_incomplete");
    expect(script).toContain("if (canRecoverInThisRun) {");
    expect(script).toContain("persistFailFastInterruptedManifest");
    expect(script).toContain("interruptedByFailFast: true");
    expect(script).toContain("validateCommandChecks(checks)");
    expect(script).toContain("--log-root must be outside graph_vault");
    expect(script).toContain("resume-book-workspace.mjs");
    expect(script).toContain("resume-book did not reach ready");
    expect(script).toContain("repair-local-artifact-gate-");
    expect(script).toContain("--repair-local-artifact-gate-only");
    expect(script).toContain("item_local_artifact_gate_repair");
    expect(script).toContain("item_local_artifact_gate_repair_blocked");
    expect(script).toContain("localArtifactGateRepairCompleted");
    expect(script).toContain("qmd-query-graphrag-json");
    expect(script).toContain("redactLog(stdout)");
    expect(script).toContain("redactLog(stderr)");
    expect(script).toContain("redactUrlCredentials");
    expect(script).toContain("console.error(redactLog");
    expect(script).not.toContain("metadata: {\\n      logRoot,");
  });

  test("keeps query_ready resume stage ordered and fail-safe", () => {
    const script = readFileSync(
      join(projectRoot, "scripts", "graphrag", "resume-book-workspace.mjs"),
      "utf8",
    );
    const queryReadyStart = script.indexOf('if (nextStage === "query_ready")');
    const startStage = script.indexOf("await repo.startStage", queryReadyStart);
    const writeManifest = script.indexOf(
      "await runtimeApi.writeGraphRagOutputProducerManifest",
      queryReadyStart,
    );
    const completeStage = script.indexOf("await repo.completeStage", queryReadyStart);
    const failStage = script.indexOf("await repo.failStage", queryReadyStart);
    const safeError = script.indexOf("errorSummary: safeText", failStage);

    expect(queryReadyStart).toBeGreaterThanOrEqual(0);
    expect(startStage).toBeGreaterThan(queryReadyStart);
    expect(writeManifest).toBeGreaterThan(startStage);
    expect(completeStage).toBeGreaterThan(writeManifest);
    expect(failStage).toBeGreaterThan(completeStage);
    expect(safeError).toBeGreaterThan(failStage);
    expect(script).toContain('console.error("[redacted]")');
  });

  test("updates batch checkpoint heartbeat while long commands run", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-command-heartbeat-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "command-heartbeat-fixture";
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeMinimalEpubFixture(sourcePath, "Book");
    const sourceHash = createHash("sha256")
      .update(readFileSync(sourcePath))
      .digest("hex");
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const normalizedPath = join(
      stateRoot,
      "books",
      bookId,
      "input",
      `book-${sourceHash.slice(0, 10)}.md`,
    );
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const checkpointPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );

    await mkdir(dirname(normalizedPath), { recursive: true });
    await writeFile(normalizedPath, "# Book\n\nHeartbeat fixture.\n");
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const resumeScript = join(tmpRoot, "fake-slow-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "setTimeout(() => {",
        "  console.log(JSON.stringify({ status: 'blocked', reason: 'test blocked' }));",
        "}, 8000);",
      ].join("\n"),
    );

    const resultPromise = new Promise<{
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
        "--heartbeat-interval-seconds",
        "1",
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
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    let heartbeatCheckpoint: Record<string, unknown> | null = null;
    let heartbeatCheckpointText = "";
    let heartbeatChecksumText = "";
    let heartbeatChecksumMeta: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      await sleep(250);
      if (!existsSync(checkpointPath)) continue;
      const checkpointText = readFileSync(checkpointPath, "utf8");
      const checkpoint = JSON.parse(checkpointText);
      if (checkpoint.currentCommand === "resume-book-1") {
        const checksumText = readFileSync(`${checkpointPath}.sha256`, "utf8").trim();
        const checksumMeta = JSON.parse(
          readFileSync(`${checkpointPath}.sha256.meta.json`, "utf8"),
        );
        const computed = createHash("sha256").update(checkpointText).digest("hex");
        if (checksumText !== computed || checksumMeta.checksum !== checksumText) {
          continue;
        }
        heartbeatCheckpoint = checkpoint;
        heartbeatCheckpointText = checkpointText;
        heartbeatChecksumText = checksumText;
        heartbeatChecksumMeta = checksumMeta;
        break;
      }
    }

    const statusDuringRun = await new Promise<{
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
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });
    const result = await resultPromise;
    const finalCheckpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    const recoverySummary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    expect(heartbeatCheckpoint).toMatchObject({
      status: "running",
      currentCommand: "resume-book-1",
    });
    expect(heartbeatChecksumText).toBe(
      createHash("sha256").update(heartbeatCheckpointText).digest("hex"),
    );
    expect(heartbeatChecksumMeta).toMatchObject({
      checksum: heartbeatChecksumText,
      targetLocator: relative(projectRoot, checkpointPath),
      durableMode: "strict",
    });
    const finalCheckpointText = readFileSync(checkpointPath, "utf8");
    const finalChecksumText = readFileSync(`${checkpointPath}.sha256`, "utf8").trim();
    expect(finalChecksumText).toBe(
      createHash("sha256").update(finalCheckpointText).digest("hex"),
    );
    expect(JSON.parse(
      readFileSync(`${checkpointPath}.sha256.meta.json`, "utf8"),
    )).toMatchObject({
      checksum: finalChecksumText,
      targetLocator: relative(projectRoot, checkpointPath),
      durableMode: "strict",
    });
    await rm(tmpRoot, { recursive: true, force: true });
    const statusSummary = JSON.parse(statusDuringRun.stdout);
    expect(statusDuringRun.exitCode).toBe(0);
    expect(statusDuringRun.stderr).toBe("");
    expect(statusSummary.items[0]).toMatchObject({
      status: "running",
      currentCommand: "resume-book-1",
    });
    expect(heartbeatCheckpoint?.currentCommandStartedAt).toEqual(expect.any(String));
    expect(heartbeatCheckpoint?.runnerHeartbeatAt).toEqual(expect.any(String));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(finalCheckpoint.currentCommand).toBeUndefined();
    expect(finalCheckpoint.currentCommandStartedAt).toBeUndefined();
    expect(finalCheckpoint.commandChecks).toHaveLength(1);
    expect(finalCheckpoint.commandChecks[0]).toMatchObject({
      name: "resume-book-1",
      status: "passed",
    });
    expect(recoverySummary.items[0].currentCommand).toBeUndefined();
    expect(recoverySummary.items[0].currentCommandStartedAt).toBeUndefined();
    expect(events.some((event) =>
      event.event === "command_start" &&
      event.command === "resume-book-1"
    )).toBe(true);
  }, 120000);

  test("rejects a second live coordinator for the same run id", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-coordinator-lock-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "coordinator-lock-fixture";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourcePath = join(sourceDir, "Coordinator.epub");
    await writeMinimalEpubFixture(sourcePath, "Coordinator Lock");
    const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    const bookId = batchBookId(sourceHash, relative(projectRoot, sourcePath));
    await writeProviderAuthReopenGraphFixture({ stateRoot, bookId, sourceHash });
    const resumeScript = join(tmpRoot, "slow-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "await new Promise((resolve) => setTimeout(resolve, 5000));",
        `console.log(JSON.stringify({ status: 'ready', bookId: '${bookId}' }));`,
      ].join("\n"),
    );
    const qmdScript = join(tmpRoot, "fake-qmd.mjs");
    await writeFile(
      qmdScript,
      [
        "if (process.argv.includes('--version')) console.log('qmd-test 1.0.0');",
        "else if (process.argv.includes('--json')) console.log('{}');",
        "else if (process.argv.includes('--csv')) console.log('title');",
        "else if (process.argv.includes('--xml')) console.log('<ok/>');",
        "else if (process.argv.includes('--md')) console.log('# ok');",
        "else console.log('ok');",
      ].join("\n"),
    );
    const args = [
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
      "--book-concurrency",
      "1",
      "--max-command-attempts",
      "1",
      "--max-resume-passes",
      "1",
    ];
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
      QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
      QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
      QMD_GRAPHRAG_TEST_QMD_RUNNER: "1",
      QMD_GRAPHRAG_QMD_RUNNER: qmdScript,
    };
    const first = spawn(nodeScriptBin(), args, { cwd: tmpRoot, env });
    let firstStdout = "";
    let firstStderr = "";
    first.stdout.on("data", (chunk) => { firstStdout += String(chunk); });
    first.stderr.on("data", (chunk) => { firstStderr += String(chunk); });
    try {
      await waitForFile(
        join(stateRoot, "catalog", "batch-runs", runId, "coordinator-lock.json"),
      );
      const second = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
      }>((resolveResult) => {
        const proc = spawn(nodeScriptBin(), args, { cwd: tmpRoot, env });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
      });
      expect(second.exitCode).not.toBe(0);
      expect(second.stdout).toBe("");
      expect(second.stderr).toContain("already has a live coordinator");
    } finally {
      first.kill("SIGTERM");
      await new Promise((resolveResult) => first.once("close", resolveResult));
      await rm(tmpRoot, { recursive: true, force: true });
    }
    expect(firstStdout).toContain("coordinator_lock_acquired");
    expect(firstStderr).toBe("");
  }, 60000);

  test("rejects coordinator takeover when expired lock pid is still alive", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-expired-live-lock-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "expired-live-lock-fixture";
    const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(runRoot, { recursive: true });
    await writeMinimalEpubFixture(join(sourceDir, "Coordinator.epub"), "Expired Lock");
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(runRoot, "coordinator-lock.json"), JSON.stringify({
      schemaVersion: SchemaVersion,
      runId,
      runnerSessionId: "expired-live-session",
      runnerHost: hostname(),
      runnerPid: process.pid,
      generation: 1,
      fencingToken: "expired-live-fence",
      acquiredAt: "2026-05-23T00:00:00.000Z",
      heartbeatAt: "2026-05-23T00:00:00.000Z",
      expiresAt: "2026-05-23T00:00:01.000Z",
      bookConcurrency: 1,
      openaiProviderConcurrency: 1,
      jinaProviderConcurrency: 1,
      localCpuConcurrency: 1,
    }) + "\n");

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
      ], { cwd: tmpRoot, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("already has a live coordinator");
    expect(existsSync(join(runRoot, "events.jsonl"))).toBe(false);
    expect(existsSync(join(runRoot, "coordinator-lock.json.sha256"))).toBe(false);
    await rm(tmpRoot, { recursive: true, force: true });
  }, 30000);

  test("durable state classifier preserves local failure classes", () => {
    expect(classifyFailure(
      "local_state_integrity durable_temp_rename_enoent: " +
      "rename /state/item.json.tmp-1 /state/item.json fetch failed",
    )).toMatchObject({
      failureKind: "local_state_integrity",
      retryable: false,
      localFailureClass: "durable_temp_rename_enoent",
    });
    expect(classifyFailure(
      "durable directory fsync failed: graph_vault/catalog " +
      "HTTP 500 retry-after: 9",
    )).toMatchObject({
      failureKind: "local_state_integrity",
      retryable: false,
      localFailureClass: "durable_directory_fsync_uncertain",
      retryAfterSeconds: 9,
    });
    expect(classifyFailure(
      "timed out waiting for json file lock: graph_vault/catalog/items/a.json",
    )).toMatchObject({
      failureKind: "local_state_lock_timeout",
      retryable: false,
      localFailureClass: "durable_state_lock_timeout",
      recoveryDecision: "stop_until_fixed",
    });
    expect(classifyFailure(
      "durable YAML checksum mismatch target_new_checksum_old",
    )).toMatchObject({
      failureKind: "local_state_integrity",
      retryable: false,
      localFailureClass: "durable_checksum_window_recovered",
    });
  });

  test("durable JSON lock timeout is stop-until-fixed with owner evidence",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-json-lock-timeout-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "durable-json-lock-timeout-fixture";
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      await mkdir(sourceDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await mkdir(runRoot, { recursive: true });
      await writeMinimalEpubFixture(join(sourceDir, "Lock.epub"), "Lock Timeout");
      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
      await writeFile(join(runRoot, "manifest.json.lock"), JSON.stringify({
        pid: process.pid,
        runnerSessionId: "active-lock-session",
        runnerHost: hostname(),
        runId,
        targetLocator:
          relative(tmpRoot, join(runRoot, "manifest.json")).split(sep).join("/"),
        lockPath:
          relative(tmpRoot, join(runRoot, "manifest.json.lock")).split(sep).join("/"),
        lane: "checkpointWriterLane",
        targetMappingOwner: "batchCoordinator",
        durableKind: "json-lock",
        laneTimeoutMs: 50,
        releaseOn: ["commit", "error", "cancellation", "lease_loss", "timeout"],
        generation: 7,
        fencingTokenHash: "held-lock-fence",
        operationId: "held-lock-operation",
        acquiredAt: "2026-05-23T00:00:00.000Z",
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }) + "\n");

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
          "--migrate-only",
        ], {
          cwd: tmpRoot,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_JSON_FILE_LOCK_WAIT_MS: "50",
            QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
          },
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
      });
      const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const timeoutEvent = events.find((event) =>
        event.event === "durable_lock_timeout" &&
        event.localFailureClass === "durable_state_lock_timeout"
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("timed out waiting for json file lock");
      expect(result.stderr).toContain("[PROJECT_ROOT]");
      expect(result.stderr).not.toContain(projectRoot);
	      expect(timeoutEvent).toMatchObject({
	        failureKind: "local_state_lock_timeout",
	        retryable: false,
	        recoveryDecision: "stop_until_fixed",
	        failedStage: "durable_state",
	        localFailureClass: "durable_state_lock_timeout",
	        targetMappingOwner: "batchCoordinator",
	        laneTimeoutMs: 120000,
	        durableMode: "strict",
	      });
      expect(timeoutEvent?.lockOwnerEvidence).toMatchObject({
        runnerSessionId: "active-lock-session",
        generation: 7,
        fencingTokenHash: "held-lock-fence",
        operationId: "held-lock-operation",
      });
      expect(timeoutEvent?.metadata?.lockOwnerEvidence).toMatchObject({
        runnerSessionId: "active-lock-session",
        generation: 7,
        fencingTokenHash: "held-lock-fence",
        operationId: "held-lock-operation",
      });
      await rm(tmpRoot, { recursive: true, force: true });
	    },
	    30000);

	  test("forced durable temp collision is stop-until-fixed before overwrite",
	    async () => {
	      const tmpRoot = await mkProjectTmpDir("qmd-batch-temp-collision-");
	      const sourceDir = join(tmpRoot, "source");
	      const stateRoot = join(tmpRoot, "graph_vault");
	      const logRoot = join(tmpRoot, "logs");
	      const configDir = join(tmpRoot, "config");
	      const runId = "forced-temp-collision-fixture";
	      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
	      await mkdir(sourceDir, { recursive: true });
	      await mkdir(configDir, { recursive: true });
	      await mkdir(runRoot, { recursive: true });
	      await writeMinimalEpubFixture(join(sourceDir, "Collision.epub"), "Collision");
	      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
	      const manifestPath = join(runRoot, "manifest.json");
	      const collidingTempId = "forced-temp-id";
	      await writeFile(`${manifestPath}.tmp-${collidingTempId}`, "foreign temp\n");

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
	          "--migrate-only",
	        ], {
	          cwd: tmpRoot,
	          env: {
	            PATH: process.env.PATH ?? "",
	            HOME: process.env.HOME ?? "",
	            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
	            QMD_GRAPHRAG_TEST_TEMP_ID_ONCE_PATTERN: "manifest.json",
	            QMD_GRAPHRAG_TEST_TEMP_ID_ONCE_VALUE: collidingTempId,
	            QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
	          },
	        });
	        let stdout = "";
	        let stderr = "";
	        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
	        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
	        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
	      });
	      const eventRaw = readFileSync(join(runRoot, "events.jsonl"), "utf8");
	      const manifestTemp = readFileSync(`${manifestPath}.tmp-${collidingTempId}`, "utf8");

	      expect(result.exitCode).not.toBe(0);
	      expect(result.stderr).toContain("durable_temp_create_collision");
	      expect(manifestTemp).toBe("foreign temp\n");
	      expect(eventRaw).toContain("durable_replace_failed");
	      expect(eventRaw).toContain("durable_temp_create_collision");
	      expect(eventRaw).toContain("completedPublishRule");
	      await rm(tmpRoot, { recursive: true, force: true });
	    },
	    120000);

  test("directory fsync failure blocks completed publication with evidence",
    async () => {
	      const tmpRoot = await mkProjectTmpDir("qmd-batch-dir-fsync-");
	      const sourceDir = join(tmpRoot, "source");
	      const stateRoot = join(tmpRoot, "graph_vault");
	      const logRoot = join(tmpRoot, "logs");
	      const configDir = join(tmpRoot, "config");
	      const runId = "directory-fsync-failure-fixture";
	      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
	      await mkdir(sourceDir, { recursive: true });
	      await mkdir(configDir, { recursive: true });
	      await writeMinimalEpubFixture(join(sourceDir, "Fsync.epub"), "Fsync");
	      await writeFile(join(configDir, "index.yml"), "collections: {}\n");

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
	          "--migrate-only",
	        ], {
	          cwd: tmpRoot,
	          env: {
	            PATH: process.env.PATH ?? "",
	            HOME: process.env.HOME ?? "",
	            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
	            QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_PATTERN:
	              "catalog/batch-runs",
	          },
	        });
	        let stdout = "";
	        let stderr = "";
	        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
	        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
	        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
	      });
	      const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
	        .trim().split("\n").map((line) => JSON.parse(line));
	      const durableFailure = events.find((event: {
	        localFailureClass?: string;
	      }) => event.localFailureClass === "durable_directory_fsync_uncertain");

	      expect(result.exitCode).not.toBe(0);
	      expect(result.stderr).toContain("durable directory fsync failed");
	      expect(durableFailure).toMatchObject({
	        recoveryDecision: "stop_until_fixed",
	        directoryTargetLocator: expect.stringContaining(
	          "catalog/batch-runs",
	        ),
	        directoryDurableKind: "directory",
	        lane: "manifestWriterLane",
	        targetMappingOwner: "batchCoordinator",
	        fsyncTarget: expect.stringContaining("catalog/batch-runs"),
	        fsyncErrno: "EIO",
	        fsyncPlatform: expect.any(String),
	        completedPublishRule: "forbidden",
	      });
	      await rm(tmpRoot, { recursive: true, force: true });
    },
    30000);

  test("durable reconcile preserves fresh temps and cleans stale temps with owner evidence",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-durable-temp-reconcile-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "durable-temp-reconcile-fixture";
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      await mkdir(sourceDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await mkdir(join(runRoot, "items"), { recursive: true });
      await writeMinimalEpubFixture(join(sourceDir, "Temp.epub"), "Temp Reconcile");
      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
      const manifestPath = join(runRoot, "manifest.json");
      await writeDurableJsonFixture(manifestPath, {
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: relative(projectRoot, stateRoot),
        qmdIndexLocator: relative(projectRoot, join(tmpRoot, "index.sqlite")),
        configLocator: relative(projectRoot, join(configDir, "index.yml")),
        totalItems: 1,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
        itemIds: [],
      });
      const target = manifestPath;
      const freshTemp = `${target}.tmp-fresh`;
      const staleTemp = `${target}.tmp-stale`;
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const targetChecksumBefore = readFileSync(`${target}.sha256`, "utf8").trim();
      await writeFile(freshTemp, "{\"fresh\":true}\n", "utf8");
      await writeFile(`${freshTemp}.owner.json`, JSON.stringify({
        tempId: "fresh-temp",
        operationId: "fresh-op",
        targetLocator: relative(projectRoot, target),
        absoluteTargetLocator: target,
        ownerPid: process.pid,
        ownerHost: hostname(),
        createdAt: new Date().toISOString(),
        leaseGeneration: 1,
        targetGeneration: 1,
        targetChecksumBefore,
        fencingTokenHash: "fresh-fence-hash",
        durableMode: "strict",
      }) + "\n", "utf8");
      await writeFile(staleTemp, "{\"stale\":true}\n", "utf8");
      await writeFile(`${staleTemp}.owner.json`, JSON.stringify({
        tempId: "stale-temp",
        operationId: "stale-op",
        targetLocator: relative(projectRoot, target),
        absoluteTargetLocator: target,
        ownerPid: 999999,
        ownerHost: hostname(),
        createdAt: oldDate.toISOString(),
        leaseGeneration: 1,
        targetGeneration: 1,
        targetChecksumBefore,
        fencingTokenHash: "stale-fence-hash",
        durableMode: "strict",
      }) + "\n", "utf8");
      await utimes(staleTemp, oldDate, oldDate);
      await utimes(`${staleTemp}.owner.json`, oldDate, oldDate);

      const result = await runBatchMigrateOnly({
        tmpRoot,
        sourceDir,
        stateRoot,
        logRoot,
        configDir,
        runId,
        env: {
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
          QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
        },
      });
      const eventRaw = readFileSync(join(runRoot, "events.jsonl"), "utf8");

      expect(result.exitCode).toBe(0);
      expect(existsSync(freshTemp)).toBe(true);
      expect(existsSync(`${freshTemp}.owner.json`)).toBe(true);
      expect(existsSync(staleTemp)).toBe(false);
      expect(existsSync(`${staleTemp}.owner.json`)).toBe(false);
      expect(eventRaw).toContain("durable_json_temp_reconciled");
      expect(eventRaw).toContain("stale-temp");
      expect(eventRaw).not.toContain("fresh-temp");
      await rm(tmpRoot, { recursive: true, force: true });
    },
    30000);

  test("durable reconcile preserves stale temps without complete owner evidence",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-durable-temp-owner-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "durable-temp-owner-fixture";
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      await mkdir(sourceDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await mkdir(join(runRoot, "items"), { recursive: true });
      await writeMinimalEpubFixture(join(sourceDir, "Owner.epub"), "Owner Evidence");
      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
      const manifestPath = join(runRoot, "manifest.json");
      await writeDurableJsonFixture(manifestPath, {
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: relative(projectRoot, stateRoot),
        qmdIndexLocator: relative(projectRoot, join(tmpRoot, "index.sqlite")),
        configLocator: relative(projectRoot, join(configDir, "index.yml")),
        totalItems: 1,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
        itemIds: [],
      });
      const ownerlessTemp = `${manifestPath}.tmp-ownerless`;
      const missingCreatedAtTemp = `${manifestPath}.tmp-missing-created`;
      await writeFile(ownerlessTemp, "{\"ownerless\":true}\n", "utf8");
      await writeFile(missingCreatedAtTemp, "{\"missingCreatedAt\":true}\n", "utf8");
      await writeFile(`${missingCreatedAtTemp}.owner.json`, JSON.stringify({
        tempId: "missing-created-at",
        operationId: "missing-created-at-op",
        targetLocator: relative(projectRoot, manifestPath),
        absoluteTargetLocator: manifestPath,
        ownerPid: 999999,
        ownerHost: hostname(),
        durableMode: "strict",
      }) + "\n", "utf8");
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await utimes(ownerlessTemp, oldDate, oldDate);
      await utimes(missingCreatedAtTemp, oldDate, oldDate);
      await utimes(`${missingCreatedAtTemp}.owner.json`, oldDate, oldDate);

      const result = await runBatchMigrateOnly({
        tmpRoot,
        sourceDir,
        stateRoot,
        logRoot,
        configDir,
        runId,
        env: {
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
          QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
        },
      });
      const eventRaw = readFileSync(join(runRoot, "events.jsonl"), "utf8");

      expect(result.exitCode).toBe(0);
      expect(existsSync(ownerlessTemp)).toBe(true);
      expect(existsSync(missingCreatedAtTemp)).toBe(true);
      expect(existsSync(`${missingCreatedAtTemp}.owner.json`)).toBe(true);
      expect(eventRaw).not.toContain("ownerless");
      expect(eventRaw).not.toContain("missing-created-at");
      await rm(tmpRoot, { recursive: true, force: true });
    },
    30000);
});
