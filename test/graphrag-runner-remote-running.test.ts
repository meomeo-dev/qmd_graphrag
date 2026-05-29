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

describe("GraphRAG EPUB batch runner - Remote Running Recovery", () => {
  test("provider auth status-json blocks already reopened current fingerprint", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-already-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-already";
    const { itemId } = await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });

    const readyResult = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
    });
    expect(readyResult.exitCode).toBe(0);
    const readySummary = JSON.parse(readyResult.stdout);
    const currentFingerprint =
      readySummary.items[0].currentProviderAuthFingerprint;
    expect(typeof currentFingerprint).toBe("string");

    const checkpointPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    checkpoint.metadata = {
      ...(checkpoint.metadata ?? {}),
      providerAuthReopenedFingerprints: [currentFingerprint],
      providerAuthReopenAttemptCount: 1,
      providerAuthReopenDecision: "reopen_legacy_provider_auth_key_present",
      providerAuthReopenEligible: true,
    };
    await writeDurableJsonFixture(checkpointPath, checkpoint);

    const result = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
    });

    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      providerAuthReopenDecision:
        "blocked_provider_auth_fingerprint_already_reopened",
      providerAuthReopenEligible: false,
      providerAuthReopenBlockedReason:
        "current_provider_auth_fingerprint_already_reopened",
      providerAuthReopenAttemptCount: 1,
    });
    expect(summary.items[0].currentProviderAuthFingerprint)
      .toBe(currentFingerprint);
  });

  test("provider auth status-json blocks unchanged current fingerprint", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-unchanged-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-unchanged";
    const { itemId } = await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });

    const readyResult = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
    });
    expect(readyResult.exitCode).toBe(0);
    const readySummary = JSON.parse(readyResult.stdout);
    const currentFingerprint =
      readySummary.items[0].currentProviderAuthFingerprint;
    expect(typeof currentFingerprint).toBe("string");

    const checkpointPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    checkpoint.metadata = {
      ...(checkpoint.metadata ?? {}),
      providerAuthFailureFingerprint: currentFingerprint,
      providerAuthReopenDecision: "reopen_legacy_provider_auth_key_present",
      providerAuthReopenEligible: true,
    };
    await writeDurableJsonFixture(checkpointPath, checkpoint);

    const result = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
    });

    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      providerAuthReopenDecision: "blocked_provider_auth_fingerprint_unchanged",
      providerAuthReopenEligible: false,
      providerAuthReopenBlockedReason:
        "current_provider_auth_fingerprint_matches_failure",
      providerAuthConfigChanged: false,
      providerAuthFailureFingerprint: currentFingerprint,
    });
  });

  test("provider auth refailure clears stale reopen eligibility", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-refail-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-refail";
    const { itemId } = await writeProviderAuthStoppedBatchFixture({
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
        providerAuthReopenedFingerprints: ["old-fingerprint"],
        providerAuthReopenAttemptCount: 1,
      },
    });
    const normalizedPath = join(stateRoot, "input", "a-auth.md");
    await mkdir(dirname(normalizedPath), { recursive: true });
    await writeFile(normalizedPath, "# A\n\nProvider auth refail.\n");
    const resumeScript = join(tmpRoot, "fake-refail-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "console.error(\"Error code: 401 - {'code': 'INVALID_API_KEY', " +
          "'message': 'Invalid API key'}\");",
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
        "--book-concurrency",
        "1",
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
      metadata: {
        providerAuthFailureDetected: true,
        providerAuthReopenDecision: "blocked_provider_auth_fingerprint_unchanged",
        providerAuthReopenEligible: false,
        providerAuthReopenBlockedReason:
          "current_provider_auth_fingerprint_matches_failure",
        providerAuthConfigChanged: false,
      },
    });
    expect(summary.items[0]).toMatchObject({
      providerAuthReopenDecision: "blocked_provider_auth_fingerprint_unchanged",
      providerAuthReopenEligible: false,
      providerAuthConfigChanged: false,
    });
    const serialized = JSON.stringify({ checkpoint, summary });
    expect(serialized).not.toContain("file-openai-key");
    expect(serialized).not.toContain("file-jina-key");
  });

  test("status-json does not project stale provider auth reopen state on completed item", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-completed-stale-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-completed-stale";
    const { itemId } = await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "completed after provider auth reopen",
    });
    const checkpointPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    checkpoint.metadata = {
      ...(checkpoint.metadata ?? {}),
      providerAuthReopenDecision: "reopen_legacy_provider_auth_key_present",
      providerAuthReopenEligible: true,
      providerAuthReopenReason: "legacy_provider_auth_failure_key_present",
      providerAuthReopenBlockedReason: "old_blocked_reason",
      providerAuthConfigChanged: true,
      providerAuthFailureFingerprint: "old-failure-fingerprint",
      currentProviderAuthFingerprint: "old-current-fingerprint",
      providerAuthReadinessStatus: "ready",
      providerAuthCredentialSources: {
        OPENAI_API_KEY: "graph_vault_dotenv",
      },
      providerAuthReopenAttemptCount: 1,
      lastProviderAuthReopenFingerprint: "old-current-fingerprint",
      legacyProviderAuthFingerprintMissing: true,
    };
    await writeDurableJsonFixture(checkpointPath, checkpoint);
    const checkpointBefore = readFileSync(checkpointPath, "utf8");

    const result = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
      args: ["--skip-dotenv"],
    });

    const checkpointAfter = readFileSync(checkpointPath, "utf8");
    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpointAfter).toBe(checkpointBefore);
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      status: "completed",
      providerAuthFailureFingerprint: "old-failure-fingerprint",
      lastProviderAuthReopenFingerprint: "old-current-fingerprint",
      providerAuthReopenAttemptCount: 1,
      legacyProviderAuthFingerprintMissing: true,
    });
    expect(summary.items[0].providerAuthReopenDecision).toBeUndefined();
    expect(summary.items[0].providerAuthReopenEligible).toBeUndefined();
    expect(summary.items[0].providerAuthReopenReason).toBeUndefined();
    expect(summary.items[0].providerAuthReopenBlockedReason).toBeUndefined();
    expect(summary.items[0].providerAuthConfigChanged).toBeUndefined();
    expect(summary.items[0].currentProviderAuthFingerprint).toBeUndefined();
    expect(summary.items[0].providerAuthReadinessStatus).toBeUndefined();
    expect(summary.items[0].providerAuthCredentialSources).toBeUndefined();
  });

  test("runtime provider auth failure stops before next book", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-auth-runtime-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-runtime";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const firstBytes = "runtime provider auth";
    const secondBytes = "pending should not run after runtime auth";
    await writeFile(join(sourceDir, "A-Auth.epub"), firstBytes);
    await writeFile(join(sourceDir, "B-Pending.epub"), secondBytes);

    const firstPath = join(sourceDir, "A-Auth.epub");
    const secondPath = join(sourceDir, "B-Pending.epub");
    const firstHash = createHash("sha256").update(firstBytes).digest("hex");
    const secondHash = createHash("sha256").update(secondBytes).digest("hex");
    const firstRelativePath = relative(projectRoot, firstPath);
    const secondRelativePath = relative(projectRoot, secondPath);
    const firstItemId = `item-${firstHash.slice(0, 12)}-${
      createHash("sha256").update(firstRelativePath).digest("hex").slice(0, 8)
    }`;
    const secondItemId = `item-${secondHash.slice(0, 12)}-${
      createHash("sha256").update(secondRelativePath).digest("hex").slice(0, 8)
    }`;
    const firstNormalizedPath = join(
      stateRoot,
      "input",
      `a-auth-${firstHash.slice(0, 10)}.md`,
    );
    const secondNormalizedPath = join(
      stateRoot,
      "input",
      `b-pending-${secondHash.slice(0, 10)}.md`,
    );
    await mkdir(dirname(firstNormalizedPath), { recursive: true });
    await writeFile(firstNormalizedPath, "# A\n\nRuntime provider auth.\n");
    await writeFile(secondNormalizedPath, "# B\n\nShould not run.\n");
    const resumeScript = join(tmpRoot, "fake-runtime-auth-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "const sourceIndex = process.argv.indexOf('--source-path');",
        "const sourcePath = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : '';",
        "if (sourcePath.includes('B-Pending.epub')) {",
        "  console.error('second item should not run');",
        "  process.exit(97);",
        "}",
        "console.error(\"Error code: 401 - {'code': 'INVALID_API_KEY', " +
          "'message': 'Invalid API key'}\");",
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
        "--book-concurrency",
        "1",
        "--max-command-attempts",
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
    const firstCheckpoint = JSON.parse(readFileSync(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${firstItemId}.json`,
      ),
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
    expect(firstCheckpoint).toMatchObject({
      status: "failed",
      failureKind: "permanent",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
      failedStage: "resume-book-1",
    });
    expect(firstCheckpoint.commandChecks.at(-1)).toMatchObject({
      name: "resume-book-1",
      status: "failed",
      providerStatusCode: 401,
      recoveryDecision: "stop_until_fixed",
    });
    expect(events.some((event) =>
      event.event === "item_failed" &&
      event.itemId === firstItemId &&
      event.providerStatusCode === 401
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_non_transient_failure" &&
      event.itemId === firstItemId &&
      event.metadata?.stopReason === "provider_auth"
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_data_compatibility_failure" &&
      event.itemId === firstItemId
    )).toBe(false);
    expect(events.some((event) =>
      event.event === "command_start" &&
      event.itemId === secondItemId
    )).toBe(false);
    expect(secondCheckpoint.status).toBe("pending");
    expect(secondCheckpoint.attempts).toBe(0);
    expect(summary.recoveryDecision).toBe("stop_until_fixed");
    expect(summary.counts).toMatchObject({ failed: 1, pending: 1 });
  });

  test("pure float data compatibility failure remains stop-until-fixed", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-float-data-compat-stop-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "float-data-compat-stop";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(sourceDir, "Book.epub"), "float data compat");

    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const sourceHash = createHash("sha256").update("float data compat").digest("hex");
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
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
    const compatibilityError =
      "create_community_reports_text failed: 'float' object is not subscriptable";
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
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "failed",
      failureKind: "data_compatibility",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
    });
    expect(events.some((event) =>
      event.event === "item_data_compatibility_recovered"
    )).toBe(false);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_data_compatibility_failure" &&
      event.itemId === itemId
    )).toBe(true);
  });

  test("data compatibility stop scans all items before sorted pending work", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-data-compat-global-stop-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "data-compat-global-stop";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(sourceDir, "A-Pending.epub"), "pending sorts first");
    await writeFile(join(sourceDir, "B-Failed.epub"), "failed sorts second");

    const pendingPath = join(sourceDir, "A-Pending.epub");
    const failedPath = join(sourceDir, "B-Failed.epub");
    const pendingHash = createHash("sha256")
      .update("pending sorts first")
      .digest("hex");
    const failedHash = createHash("sha256")
      .update("failed sorts second")
      .digest("hex");
    const pendingRelativePath = relative(projectRoot, pendingPath);
    const failedRelativePath = relative(projectRoot, failedPath);
    const pendingItemId = `item-${pendingHash.slice(0, 12)}-${
      createHash("sha256").update(pendingRelativePath).digest("hex").slice(0, 8)
    }`;
    const failedItemId = `item-${failedHash.slice(0, 12)}-${
      createHash("sha256").update(failedRelativePath).digest("hex").slice(0, 8)
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
        itemIds: [pendingItemId, failedItemId],
      },
    );
    await writeDurableJsonFixture(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${pendingItemId}.json`,
      ),
      {
        schemaVersion: SchemaVersion,
        itemId: pendingItemId,
        runId,
        status: "pending",
        sourceName: "A-Pending.epub",
        sourceRelativePath: pendingRelativePath,
        sourceIdentityPath: pendingRelativePath,
        sourceHash: pendingHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "pending.md"),
        bookId: batchBookId(pendingHash, pendingRelativePath),
        attempts: 0,
        recoveryDecision: "none",
        commandChecks: [],
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
        `${failedItemId}.json`,
      ),
      {
        schemaVersion: SchemaVersion,
        itemId: failedItemId,
        runId,
        status: "failed",
        sourceName: "B-Failed.epub",
        sourceRelativePath: failedRelativePath,
        sourceIdentityPath: failedRelativePath,
        sourceHash: failedHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "failed.md"),
        bookId: batchBookId(failedHash, failedRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "data_compatibility",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-2",
        errorSummary: compatibilityError,
        commandChecks: [],
      },
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
    const pendingCheckpoint = JSON.parse(readFileSync(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${pendingItemId}.json`,
      ),
      "utf8",
    ));

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(events.some((event) =>
      event.event === "batch_stopped_after_data_compatibility_failure" &&
      event.itemId === failedItemId
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_non_transient_failure" &&
      event.itemId === failedItemId
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "command_start" &&
      event.itemId === pendingItemId
    )).toBe(false);
    expect(pendingCheckpoint.status).toBe("pending");
    expect(pendingCheckpoint.attempts).toBe(0);
  });

  test("summary does not project stale provider wait on non-transient failures", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-stale-provider-wait-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "stale-provider-wait";
    const sourceBytes = "stale provider wait";
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
        errorSummary: "GraphRAG community text-unit context references missing text units",
        commandChecks: [],
        metadata: {
          waitingForProviderRecovery: true,
        },
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

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      failureKind: "data_compatibility",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
    });
    expect(summary.items[0].waitingForProviderRecovery).toBe(false);
    expect(summary.items[0].providerRecoveryWaitCount).toBeUndefined();
    expect(summary.items[0].maxProviderRecoveryWaits).toBeUndefined();
    expect(summary.items[0].providerRecoveryReason).toBeUndefined();
  });

  test("status-json does not steal fresh remote running items", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-remote-running-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "remote-running-fixture";
    const sourceBytes = "remote running";
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
    expect(summary.counts).toMatchObject({ running: 1 });
    expect(summary.recoveryDecision).toBe("continue_pending");
    expect(summary.items[0]).toMatchObject({
      status: "running",
      runnerHost: "other-host.example",
    });
    expect(checkpoint.status).toBe("running");
    expect(eventLog).not.toContain("item_running_recovered");
  });
});
