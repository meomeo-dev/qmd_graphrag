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

describe("GraphRAG EPUB batch runner - Provider Auth Stop Decisions", () => {
  test("settings projection rejection is observable in checkpoint events and summary", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-settings-reject-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "settings-projection-reject";
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await writeMinimalEpubFixture(sourcePath, "Settings Projection Rejection");
    const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    const normalizedPath = join(
      stateRoot,
      "input",
      `book-${sourceHash.slice(0, 10)}.md`,
    );
    await mkdir(configDir, { recursive: true });
    await mkdir(dirname(normalizedPath), { recursive: true });
    await writeFile(normalizedPath, "# Book\n\nSettings rejection fixture.\n");
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const resumeScript = join(tmpRoot, "fake-settings-reject-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "console.error(",
        "  'Error: graph_vault/settings.yaml is not the managed projection of .qmd/index.yml',",
        ");",
        "process.exit(1);",
      ].join("\n"),
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
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const commandFailed = events.find((event) =>
      event.event === "command_failed" && event.itemId === itemId
    );
    const commandExhausted = events.find((event) =>
      event.event === "command_attempt_budget_exhausted" && event.itemId === itemId
    );
    const itemFailed = events.find((event) =>
      event.event === "item_failed" && event.itemId === itemId
    );
    const settingsSourceFingerprint = createHash("sha256")
      .update(JSON.stringify({
        embedding: {},
        graphrag: {},
        models: {},
        providers: {},
        query: {},
      }))
      .digest("hex");
    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "failed",
      recoveryDecision: "stop_until_fixed",
      metadata: {
        settingsProjectionDecision: "rejected_user_owned",
        settingsProjectionRewritten: false,
        settingsProjectionSourceFingerprint: settingsSourceFingerprint,
        settingsProjectionReason:
          "settings_projection_rejected_user_owned_or_invalid",
      },
    });
    expect(commandFailed?.metadata).toMatchObject({
      settingsProjectionDecision: "rejected_user_owned",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
      settingsProjectionReason:
        "settings_projection_rejected_user_owned_or_invalid",
    });
    expect(commandExhausted?.metadata).toMatchObject({
      settingsProjectionDecision: "rejected_user_owned",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
      settingsProjectionReason:
        "settings_projection_rejected_user_owned_or_invalid",
    });
    expect(itemFailed?.metadata).toMatchObject({
      activeCommand: "resume-book-1",
      command: "resume-book-1",
      settingsProjectionDecision: "rejected_user_owned",
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
    });
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      activeCommand: "resume-book-1",
      settingsProjectionDecision: "rejected_user_owned",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
      settingsProjectionProjectConfigLocator: join(configDir, "index.yml"),
      settingsProjectionLocator: join(stateRoot, "settings.yaml"),
      settingsProjectionEvidenceLocator: join(stateRoot, "settings.yaml"),
      settingsProjectionReason:
        "settings_projection_rejected_user_owned_or_invalid",
    });
  });

  test("invalid source settings projection rejection is observable", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-settings-invalid-source-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "settings-projection-invalid-source";
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await writeMinimalEpubFixture(sourcePath, "Settings Projection Invalid Source");
    const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    const normalizedPath = join(
      stateRoot,
      "input",
      `book-${sourceHash.slice(0, 10)}.md`,
    );
    await mkdir(configDir, { recursive: true });
    await mkdir(dirname(normalizedPath), { recursive: true });
    await writeFile(normalizedPath, "# Book\n\nInvalid source fixture.\n");
    await writeFile(
      join(configDir, "index.yml"),
      [
        "collections: {}",
        "providers:",
        "  jina:",
        "    embedding_profile: audio",
      ].join("\n"),
    );
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const resumeScript = join(tmpRoot, "fake-settings-invalid-source-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "console.error(",
        "  \"TypeError: Cannot read properties of undefined (reading 'queryTask')\",",
        ");",
        "process.exit(1);",
      ].join("\n"),
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
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const itemFailed = events.find((event) =>
      event.event === "item_failed" && event.itemId === itemId
    );
    const settingsSourceFingerprint = createHash("sha256")
      .update(JSON.stringify({
        embedding: {},
        graphrag: {},
        models: {},
        providers: { jina: { embedding_profile: "audio" } },
        query: {},
      }))
      .digest("hex");
    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint.metadata).toMatchObject({
      settingsProjectionDecision: "rejected_invalid_source",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
      settingsProjectionReason: "settings_projection_rejected_invalid_source",
    });
    expect(itemFailed?.metadata).toMatchObject({
      activeCommand: "resume-book-1",
      settingsProjectionDecision: "rejected_invalid_source",
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
    });
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      settingsProjectionDecision: "rejected_invalid_source",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
      settingsProjectionProjectConfigLocator: join(configDir, "index.yml"),
      settingsProjectionEvidenceLocator: join(configDir, "index.yml"),
      settingsProjectionReason: "settings_projection_rejected_invalid_source",
    });
  });

  test("blocks repaired local projection output that lacks required metadata", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-repair-missing-meta-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "repair-missing-meta";
    const sourceBytes = "missing repair metadata";
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
    const failureText =
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
        bookId,
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: failureText,
        commandChecks: [],
      },
    );
    const resumeScript = join(tmpRoot, "fake-repair-missing-meta.mjs");
    await writeFile(
      resumeScript,
      [
        "console.log(JSON.stringify({",
        "  status: 'repaired',",
        `  bookId: '${bookId}',`,
        "  repairOnly: true,",
        "  repairedLocalArtifactGate: true",
        "}));",
      ].join("\n"),
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
      status: "pending",
      recoveryDecision: "continue_pending",
      retryable: false,
      metadata: {
        localArtifactGateRepairBlocked: true,
      },
    });
    expect(checkpoint.metadata?.localArtifactGateRepairCompleted).toBeUndefined();
    expect(checkpoint.metadata?.repairReason).toBeUndefined();
    expect(events.some((event) =>
      event.event === "item_local_artifact_gate_repair_reopened"
    )).toBe(false);
    expect(events.some((event) =>
      event.event === "item_local_artifact_gate_repair_blocked" &&
      event.metadata?.repairedLocalArtifactGate === false
    )).toBe(true);
  });

  test("status-json hydrates event-proven repair-only blocked loops", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-repair-loop-hydrate-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "repair-loop-hydrate";
    const sourceBytes = "event proven repair loop";
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
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "repair-local-artifact-gate",
        errorSummary: "resume-book did not reach ready after 24 passes",
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
          errorSummary: "GraphRAG stage did not produce valid book-scoped artifacts",
        }],
      },
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      [
        JSON.stringify({
          schemaVersion: SchemaVersion,
          runId,
          itemId,
          event: "local_artifact_gate_repair_pass_completed",
          status: "running",
          at: "2026-05-23T00:09:00.000Z",
          metadata: {
            pass: 24,
            command: "repair-local-artifact-gate-24",
            resumeStatus: "blocked",
            nextStage: null,
          },
        }),
      ].join("\n") + "\n",
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
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      recoveryDecision: "continue_pending",
      failureKind: "permanent",
      retryable: false,
      failedStage: "repair-local-artifact-gate",
      waitingForProviderRecovery: false,
    });
  });

  test("status-json recovers orphaned running item to retryable pending", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-orphan-running-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "orphan-running-fixture";
    const sourceBytes = "orphaned running";
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
        runnerSessionId: "dead-session",
        runnerHost: hostname(),
        runnerPid: 999999,
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
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventsExist = existsSync(eventLogPath);
    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.counts).toMatchObject({ pending: 1 });
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      qmdBuildStatus: { status: "pending" },
      graphBuildStatus: { status: "pending" },
      failureKind: "transient",
      retryable: true,
      recoveryDecision: "retry_same_run_id",
      failedStage: "runner_orphaned",
    });
    expect(checkpoint).toMatchObject({
      status: "running",
      runnerSessionId: "dead-session",
      runnerHost: hostname(),
      attempts: 1,
    });
    expect(eventsExist).toBe(false);
  });
});
