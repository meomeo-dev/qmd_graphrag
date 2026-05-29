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

const ReducedGraphQueryCommandChecks = [
  "qmd-version",
  "qmd-query-auto-json",
  "qmd-query-graphrag-json",
].join(",");

describe("GraphRAG EPUB batch runner - Concurrency And Coordination", () => {
  test("rename ENOENT during durable checkpoint write is stop-until-fixed",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-rename-enoent-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "durable-rename-enoent-fixture";
      await mkdir(sourceDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
      const sourcePath = join(sourceDir, "Rename-Enoent.epub");
      await writeMinimalEpubFixture(sourcePath, "Rename Enoent");
      const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
      const bookId = batchBookId(sourceHash, relative(projectRoot, sourcePath));
      await writeProviderAuthReopenGraphFixture({ stateRoot, bookId, sourceHash });

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
            QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES: ReducedGraphQueryCommandChecks,
            QMD_GRAPHRAG_TEST_RENAME_ENOENT_ONCE_PATTERN:
              "items/item-",
            QMD_GRAPHRAG_TEST_RENAME_ENOENT_AFTER_MATCHES: "1",
          },
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
      });
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const checkpointName = readdirSync(join(runRoot, "items"))
        .find((name) => /^item-.*\.json$/.test(name));
      expect(checkpointName).toBeDefined();
      const checkpoint = JSON.parse(readFileSync(
        join(runRoot, "items", String(checkpointName)),
        "utf8",
      ));
      const recoverySummary = JSON.parse(readFileSync(
        join(runRoot, "recovery-summary.json"),
        "utf8",
      ));
      const durableFailureEvent = events.find((event) =>
        event.event === "durable_replace_failed" &&
        event.localFailureClass === "durable_temp_rename_enoent"
      );
      const itemFailedEvent = events.find((event) =>
        event.event === "item_failed" &&
        event.localFailureClass === "durable_temp_rename_enoent"
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toBe("");
	      expect(checkpoint).toMatchObject({
	        status: "failed",
	        failureKind: "local_state_integrity",
	        localFailureClass: "durable_temp_rename_enoent",
	        retryable: false,
        recoveryDecision: "stop_until_fixed",
        failedStage: "durable_state",
	        failedSyscall: "rename",
	        errno: "ENOENT",
        renameCause: "generation_advanced",
	        completedPublishRule: "forbidden",
	      });
      expect(checkpoint.tempId).toEqual(expect.any(String));
      expect(checkpoint.operationId).toEqual(expect.any(String));
      expect(checkpoint.targetLocator).toContain("items/item-");
      expect(checkpoint.commandChecks ?? []).toHaveLength(0);
	      expect(durableFailureEvent).toMatchObject({
	        failureKind: "local_state_integrity",
	        retryable: false,
	        recoveryDecision: "stop_until_fixed",
	        failedStage: "durable_state",
	        failedSyscall: "rename",
	        errno: "ENOENT",
        renameCause: "generation_advanced",
	      });
      expect(durableFailureEvent?.tempId).toEqual(expect.any(String));
      expect(durableFailureEvent?.operationId).toEqual(expect.any(String));
      expect(itemFailedEvent).toMatchObject({
        failureKind: "local_state_integrity",
        retryable: false,
        recoveryDecision: "stop_until_fixed",
        failedStage: "durable_state",
        failedSyscall: "rename",
        errno: "ENOENT",
      });
      expect(recoverySummary).toMatchObject({
        recoveryDecision: "stop_until_fixed",
      });
	      expect(recoverySummary.items[0]).toMatchObject({
	        status: "failed",
	        failureKind: "local_state_integrity",
	        localFailureClass: "durable_temp_rename_enoent",
	        recoveryDecision: "stop_until_fixed",
	        failedStage: "durable_state",
        renameCause: "generation_advanced",
	      });
      expect(recoverySummary.items[0].tempId).toEqual(expect.any(String));
      await rm(tmpRoot, { recursive: true, force: true });
    },
    30000);

  for (const targetName of ["job.yaml", "checkpoints.yaml", "artifacts.yaml"]) {
    test(`resume-book child projects ${targetName} rename ENOENT`,
      async () => {
        const tmpRoot = await mkProjectTmpDir("qmd-batch-child-yaml-enoent-");
        const sourceDir = join(tmpRoot, "source");
        const stateRoot = join(tmpRoot, "graph_vault");
        const logRoot = join(tmpRoot, "logs");
        const configDir = join(tmpRoot, "config");
        const runId = `child-book-yaml-enoent-${targetName.replace(".", "-")}`;
        try {
          await mkdir(sourceDir, { recursive: true });
          await mkdir(configDir, { recursive: true });
          await writeFile(join(configDir, "index.yml"), "collections: {}\n");
          await writeGraphRagPromptFixtures(stateRoot);
          const sourcePath = join(sourceDir, "Child-Yaml-Enoent.epub");
          await writeMinimalEpubFixture(sourcePath, "Child YAML Enoent");
          const sourceHash = createHash("sha256")
            .update(readFileSync(sourcePath))
            .digest("hex");
          const bookId = batchBookId(sourceHash, relative(projectRoot, sourcePath));
          const exactTarget = join(stateRoot, "books", bookId, targetName);

          const result = await runBatchWorkflow({
            tmpRoot,
            sourceDir,
            stateRoot,
            logRoot,
            configDir,
            runId,
            env: {
              QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
              QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES:
                ReducedGraphQueryCommandChecks,
              QMD_GRAPHRAG_TEST_ALLOW_NON_QUARANTINE_RENAME_ENOENT: "1",
              QMD_GRAPHRAG_TEST_RENAME_ENOENT_ONCE_TARGET: exactTarget,
            },
            timeoutMs: 120_000,
          });

          const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
          const itemFile = durablePrimaryJsonEntries(join(runRoot, "items"))[0];
          const checkpoint = JSON.parse(readFileSync(
            join(runRoot, "items", itemFile),
            "utf8",
          ));
          const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const recoverySummary = JSON.parse(readFileSync(
            join(runRoot, "recovery-summary.json"),
            "utf8",
          ));
          const statusResult = await runBatchWorkflow({
            tmpRoot,
            sourceDir,
            stateRoot,
            logRoot,
            configDir,
            runId,
            statusJson: true,
            timeoutMs: 90_000,
          });
          const statusSummary = JSON.parse(statusResult.stdout);
          const resumeErrLog = readFileSync(
            join(logRoot, `${checkpoint.itemId}-resume-book-1.err`),
            "utf8",
          );
          const commandFailed = events.find((event) =>
            event.event === "command_failed" &&
            event.command === "resume-book-1"
          );
          const itemFailed = events.find((event) => event.event === "item_failed");
          const failedCheck = checkpoint.commandChecks.at(-1);
          const statusDiagnostic = statusSummary.durableStateFailures.find(
            (item: Record<string, unknown>) =>
              item.itemId === checkpoint.itemId &&
              item.localFailureClass === "durable_temp_rename_enoent",
          );
          const targetSuffix = `/graph_vault/books/${bookId}/${targetName}`;

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toBe("");
          expect(statusResult.exitCode).toBe(0);
          expect(statusResult.stderr).toBe("");
          expect(resumeErrLog).toContain("QMD_GRAPHRAG_DURABLE_FAILURE");
          for (const surface of [
            failedCheck,
            commandFailed,
            itemFailed,
            recoverySummary.items[0],
            statusSummary.items[0],
            statusDiagnostic,
          ]) {
            expect(surface).toMatchObject({
              failureKind: "local_state_integrity",
              localFailureClass: "durable_temp_rename_enoent",
              retryable: false,
              recoveryDecision: "stop_until_fixed",
              failedStage: "resume-book-1",
              failedSyscall: "rename",
              errno: "ENOENT",
              lane: "checkpointWriterLane",
              targetMappingOwner: "repository",
              completedPublishRule: "forbidden",
            });
            expect(surface.tempId).toEqual(expect.any(String));
            expect(surface.operationId).toEqual(expect.any(String));
            expect(surface.renameCause).toEqual(expect.any(String));
            expect(surface.leaseGeneration).toEqual(expect.any(Number));
            const locator = String(surface.targetLocator).replaceAll("\\", "/");
            expect(locator.endsWith(targetSuffix)).toBe(true);
            expect(String(surface.targetLocator)).not.toContain(".sha256");
          }
          expect(failedCheck).toMatchObject({ name: "resume-book-1" });
          expect(checkpoint).toMatchObject({
            status: "failed",
            activeCommand: "resume-book-1",
            localFailureClass: "durable_temp_rename_enoent",
            recoveryDecision: "stop_until_fixed",
          });
          expect(statusDiagnostic).toMatchObject({
            itemId: checkpoint.itemId,
            bookId,
            activeCommand: "resume-book-1",
          });
        } finally {
          await rm(tmpRoot, { recursive: true, force: true });
        }
      },
      180000);
  }

  test("partial durable subprocess envelope fails closed", async () => {
    await expectDurableSubprocessEnvelopeIncomplete({
      prefix: "fake-partial-envelope",
      runId: "child-partial-envelope",
      expectedSentinels: [
        "marker",
        "status",
        "itemId",
        "bookId",
        "workerId",
      ],
      resumeScriptLines: [
        "const payload = {",
        "  schemaVersion: '1.0.0',",
        "  failureKind: 'local_state_integrity',",
        "  localFailureClass: 'durable_temp_rename_enoent',",
        "  retryable: false,",
        "  recoveryDecision: 'stop_until_fixed',",
        "  failedStage: 'resume-book-1',",
        "  targetLocator: 'graph_vault/books/book/checkpoints.yaml',",
        "  tempId: 'tmp-partial',",
        "  operationId: 'op-partial',",
        "  failedSyscall: 'rename',",
        "  errno: 'ENOENT',",
        "  renameCause: 'filesystem_or_external_mutation',",
        "  lane: 'checkpointWriterLane',",
        "  targetMappingOwner: 'repository',",
        "  leaseGeneration: 1,",
        "  completedPublishRule: 'forbidden',",
        "};",
        "console.error('QMD_GRAPHRAG_DURABLE_FAILURE ' + JSON.stringify(payload));",
        "process.exit(1);",
      ],
    });
  }, 150000);

  test("malformed durable subprocess envelope fails closed", async () => {
    await expectDurableSubprocessEnvelopeIncomplete({
      prefix: "fake-malformed-envelope",
      runId: "child-malformed-envelope",
      expectedSentinels: ["parseable_json"],
      resumeScriptLines: [
        "console.error('QMD_GRAPHRAG_DURABLE_FAILURE {bad-json');",
        "process.exit(1);",
      ],
    });
  }, 150000);

  test("missing durable subprocess envelope fails closed for durable text", async () => {
    await expectDurableSubprocessEnvelopeIncomplete({
      prefix: "fake-missing-envelope",
      runId: "child-missing-envelope",
      expectedSentinels: ["envelope"],
      resumeScriptLines: [
        "console.error('local_state_integrity durable_temp_rename_enoent: ' +",
        "  'rename ENOENT checkpoints.yaml.tmp-op checkpoints.yaml');",
        "process.exit(1);",
      ],
    });
  }, 150000);

  test("book-concurrency 2 runs multiple books through the worker pool", async () => {
    const fixture = await runParallelRunnerFixture({
      concurrency: 2,
      runId: "parallel-workers-fixture",
    });
    const starts = fixture.resumeEvents.filter((event) => event.phase === "start");
    const workerStarts = fixture.events.filter((event) =>
      event.event === "item_worker_start"
    );
    const firstWorkerCompleted = fixture.events.find((event) =>
      event.event === "item_worker_completed"
    );
    expect(fixture.result.exitCode).toBe(0);
    expect(fixture.result.stderr).toBe("");
    expect(starts).toHaveLength(2);
    expect(fixture.events.some((event) =>
      event.event === "batch_worker_pool_start" &&
      event.metadata?.candidateCount === 2
    )).toBe(true);
    expect(workerStarts).toHaveLength(2);
    expect(firstWorkerCompleted).toBeDefined();
    expect(workerStarts[1]?.sequence).toBeLessThan(firstWorkerCompleted?.sequence);
    expect(fixture.events.every((event) =>
      typeof event.eventId === "string" &&
      Number.isInteger(event.sequence) &&
      typeof event.runnerSessionId === "string"
    )).toBe(true);
    expect(fixture.events.map((event) => event.sequence))
      .toEqual(fixture.events.map((_, index) => index + 1));
    expect(fixture.events.some((event) =>
      event.event === "provider_slot_lease_acquired"
    )).toBe(true);
    expect(fixture.events.some((event) =>
      event.event === "provider_slot_lease_released"
    )).toBe(true);
    const runRoot = join(
      fixture.stateRoot,
      "catalog",
      "batch-runs",
      "parallel-workers-fixture",
    );
    const providerSlotDir = join(runRoot, "provider-slots");
    const bookLeaseDir = join(runRoot, "book-leases");
    const subprocessDir = join(runRoot, "subprocesses");
    const manifest = JSON.parse(readFileSync(join(runRoot, "manifest.json"), "utf8"));
    const subprocesses = durablePrimaryJsonEntries(subprocessDir)
      .map((name) => JSON.parse(readFileSync(join(subprocessDir, name), "utf8")));
    expect(existsSync(join(runRoot, "coordinator-lock.json"))).toBe(false);
    expect(durablePrimaryJsonEntries(providerSlotDir)
      .filter((name) => !name.endsWith(".registry.json"))).toHaveLength(0);
    expect(durablePrimaryJsonEntries(bookLeaseDir)).toHaveLength(0);
    expect(subprocesses.length).toBeGreaterThan(0);
    expect(subprocesses.every((record) =>
      ["exited", "killed", "spawn_error"].includes(record.status)
    )).toBe(true);
    const providerSubprocesses = subprocesses.filter((record) =>
      typeof record.providerSlotId === "string"
    );
    expect(providerSubprocesses.length).toBeGreaterThan(0);
    expect(providerSubprocesses.every((record) =>
      typeof record.providerSlotProvider === "string" &&
      typeof record.providerSlotGeneration === "number" &&
      typeof record.providerSlotFencingToken === "string"
    )).toBe(true);
    expect(manifest).toMatchObject({
      activeProviderSlots: 0,
      activeSubprocesses: 0,
      activeBookLeases: 0,
    });
    expect(fixture.events.some((event) =>
      event.event === "batch_completed" &&
      event.status === "completed"
    )).toBe(true);
    await rm(fixture.tmpRoot, { recursive: true, force: true });
  }, 90000);

  test("book worker pool defers duplicate canonical books", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-duplicate-book-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "duplicate-canonical-book-fixture";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const firstPath = join(sourceDir, "Duplicate-A.epub");
    const secondPath = join(sourceDir, "Duplicate-B.epub");
    await writeMinimalEpubFixture(firstPath, "Duplicate Book");
    await copyFile(firstPath, secondPath);
    const sourceHash = createHash("sha256").update(readFileSync(firstPath)).digest("hex");
    const firstRelativePath = relative(projectRoot, firstPath);
    const secondRelativePath = relative(projectRoot, secondPath);
    const bookId = `book-duplicate-${sourceHash.slice(0, 12)}`;
    await writeProviderAuthReopenGraphFixture({ stateRoot, bookId, sourceHash });
    const catalogPath = join(stateRoot, "catalog", "books.yaml");
    const catalog = YAML.parse(readFileSync(catalogPath, "utf8")) as {
      items: Array<Record<string, unknown>>;
    };
    const baseJob = catalog.items[0];
    await writeDurableYamlFixture(catalogPath, {
      schemaVersion: SchemaVersion,
      items: [
        {
          ...baseJob,
          metadata: { sourceIdentityPath: firstRelativePath },
        },
        {
          ...baseJob,
          metadata: { sourceIdentityPath: secondRelativePath },
        },
      ],
    });

    const resumeEventsPath = join(tmpRoot, "resume-events.jsonl");
    const resumeScript = join(tmpRoot, "fake-duplicate-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "import { appendFileSync } from 'node:fs';",
        "import { basename } from 'node:path';",
        "const args = process.argv.slice(2);",
        "const value = (name) => {",
        "  const index = args.indexOf(name);",
        "  return index >= 0 ? args[index + 1] : '';",
        "};",
        "const name = basename(value('--source-path'));",
        "appendFileSync(process.env.RESUME_EVENTS_PATH, JSON.stringify({",
        "  name, phase: 'start', at: Date.now()",
        "}) + '\\n');",
        "await new Promise((resolve) => setTimeout(resolve, 500));",
        "appendFileSync(process.env.RESUME_EVENTS_PATH, JSON.stringify({",
        "  name, phase: 'end', at: Date.now()",
        "}) + '\\n');",
        "console.log(JSON.stringify({ status: 'ready', bookId: process.env.TEST_BOOK_ID }));",
      ].join("\n"),
    );
    const qmdScript = join(tmpRoot, "fake-qmd.mjs");
    await writeFile(
      qmdScript,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const args = process.argv.slice(2);",
        "if (process.env.INDEX_PATH) {",
        "  mkdirSync(dirname(process.env.INDEX_PATH), { recursive: true });",
        "  writeFileSync(process.env.INDEX_PATH, 'fake qmd index\\n');",
        "}",
        "if (args.includes('--version')) console.log('qmd-test 1.0.0');",
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
        "2",
        "--openai-provider-concurrency",
        "2",
        "--jina-provider-concurrency",
        "2",
        "--local-cpu-concurrency",
        "2",
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
          QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES: ReducedGraphQueryCommandChecks,
          RESUME_EVENTS_PATH: resumeEventsPath,
          TEST_BOOK_ID: bookId,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const resumeEvents = readFileSync(resumeEventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const starts = resumeEvents.filter((event) => event.phase === "start");
    const firstEndAt = resumeEvents
      .filter((event) => event.phase === "end")
      .map((event) => event.at)
      .sort((left, right) => left - right)[0];
    const secondStartAt = starts
      .map((event) => event.at)
      .sort((left, right) => left - right)[1];

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(events.some((event) =>
      event.event === "item_book_running_observed" &&
      event.metadata?.bookId === bookId &&
      event.metadata?.workerPoolDeferred === true
    )).toBe(true);
    expect(events.filter((event) => event.event === "item_worker_start"))
      .toHaveLength(2);
    expect(starts).toHaveLength(2);
    expect(secondStartAt).toBeGreaterThanOrEqual(firstEndAt);
  }, 360000);

  test("stale item checkpoint ownership rejects terminal event writes", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-stale-fence-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "stale-item-fence-fixture";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourcePath = join(sourceDir, "Stale-Fence.epub");
    await writeMinimalEpubFixture(sourcePath, "Stale Fence");
    const sourceHash = createHash("sha256")
      .update(readFileSync(sourcePath))
      .digest("hex");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    await writeProviderAuthReopenGraphFixture({ stateRoot, bookId, sourceHash });
    const resumeEventsPath = join(tmpRoot, "resume-events.jsonl");
    const resumeScript = join(tmpRoot, "fake-stale-fence-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync(process.env.RESUME_EVENTS_PATH, JSON.stringify({",
        "  phase: 'start', at: Date.now()",
        "}) + '\\n');",
        "await new Promise((resolve) => setTimeout(resolve, 1500));",
        "console.log(JSON.stringify({ status: 'ready', bookId: process.env.TEST_BOOK_ID }));",
      ].join("\n"),
    );
    const qmdScript = join(tmpRoot, "fake-qmd.mjs");
    await writeFile(
      qmdScript,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const args = process.argv.slice(2);",
        "if (process.env.INDEX_PATH) {",
        "  mkdirSync(dirname(process.env.INDEX_PATH), { recursive: true });",
        "  writeFileSync(process.env.INDEX_PATH, 'fake qmd index\\n');",
        "}",
        "if (args.includes('--version')) console.log('qmd-test 1.0.0');",
        "else if (args.includes('--json')) console.log('{}');",
        "else if (args.includes('--csv')) console.log('title');",
        "else if (args.includes('--xml')) console.log('<ok/>');",
        "else if (args.includes('--md')) console.log('# ok');",
        "else console.log('ok');",
      ].join("\n"),
    );

    const resultPromise = new Promise<{
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
        "--book-concurrency",
        "1",
        "--max-command-attempts",
        "1",
        "--max-resume-passes",
        "1",
        "--heartbeat-interval-seconds",
        "10",
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
          QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES: ReducedGraphQueryCommandChecks,
          RESUME_EVENTS_PATH: resumeEventsPath,
          TEST_BOOK_ID: bookId,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    await waitForFile(resumeEventsPath, 120000);
    const checkpointPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );
    await waitForFile(checkpointPath);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    expect(checkpoint.status).toBe("running");
    await writeDurableJsonFixture(checkpointPath, {
        ...checkpoint,
        runnerSessionId: "stale-runner-session",
    });
    const result = await resultPromise;
    const finalCheckpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "item checkpoint terminal write is owned by another runner",
    );
    expect(finalCheckpoint.status).toBe("running");
    expect(finalCheckpoint.runnerSessionId).toBe("stale-runner-session");
    expect(events.some((event) =>
      event.itemId === itemId && event.event === "item_completed"
    )).toBe(false);
  }, 180000);

  test("terminal completion events share the checkpoint finalization fence", async () => {
    const fixture = await runParallelRunnerFixture({
      concurrency: 2,
      runId: "terminal-finalization-fence-fixture",
    });
    try {
      expect(fixture.result.exitCode).toBe(0);
      const runRoot = join(
        fixture.stateRoot,
        "catalog",
        "batch-runs",
        "terminal-finalization-fence-fixture",
      );
      const checkpointFiles = durablePrimaryJsonEntries(join(runRoot, "items"));
      expect(checkpointFiles).toHaveLength(2);
      for (const file of checkpointFiles) {
        const checkpoint = JSON.parse(readFileSync(join(runRoot, "items", file), "utf8"));
        const fence = checkpoint.metadata?.terminalFinalization;
        expect(checkpoint.status).toBe("completed");
        expect(fence).toMatchObject({
          runnerSessionId: checkpoint.runnerSessionId ?? fence.runnerSessionId,
          bookId: checkpoint.bookId,
          providerSlotFence: "no_active_provider_slot",
          activeProviderSlotsAtFinalization: 0,
        });
        expect(typeof fence.token).toBe("string");
        const itemCompleted = fixture.events.find((event) =>
          event.event === "item_completed" &&
          event.itemId === checkpoint.itemId
        );
        const workerCompleted = fixture.events.find((event) =>
          event.event === "item_worker_completed" &&
          event.itemId === checkpoint.itemId
        );
        expect(itemCompleted?.metadata?.terminalFinalization?.token)
          .toBe(fence.token);
        expect(workerCompleted?.metadata?.terminalFinalization?.token)
          .toBe(fence.token);
        expect(itemCompleted?.metadata?.terminalFinalization?.bookFencingToken)
          .toBe(fence.bookFencingToken);
        expect(workerCompleted?.metadata?.terminalFinalization?.itemFencingToken)
          .toBe(fence.itemFencingToken);
      }
    } finally {
      await rm(fixture.tmpRoot, { recursive: true, force: true });
    }
  }, 240000);

  test("recovers stale provider slot leases when a coordinator starts", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-slot-recovery-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-slot-recovery-fixture";
    const fixture = await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "completed epub fixture",
    });
    const providerSlotDir = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "provider-slots",
    );
    await mkdir(providerSlotDir, { recursive: true });
    await writeDurableJsonFixture(
      join(providerSlotDir, "openai-slot-stale.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        provider: "openai",
        slotId: "openai-slot-stale",
        itemId: fixture.itemId,
        bookId: fixture.bookId,
        workerId: "worker-stale",
        command: "resume-book-1",
        limit: 1,
        runnerSessionId: "stale-session",
        runnerHost: hostname(),
        runnerPid: 99999999,
        generation: 1,
        fencingToken: "stale-provider-fence",
        acquiredAt: "2026-05-23T00:00:00.000Z",
        heartbeatAt: "2026-05-23T00:00:00.000Z",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
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
        "--migrate-only",
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
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("provider_slot_lease_recovered");
    expect(result.stderr).toBe("");
    expect(durablePrimaryJsonEntries(providerSlotDir)
      .filter((name) => !name.endsWith(".registry.json"))).toHaveLength(0);
    expect(events.some((event) =>
      event.event === "provider_slot_lease_recovered" &&
      event.metadata?.slotId === "openai-slot-stale"
    )).toBe(true);
    await rm(tmpRoot, { recursive: true, force: true });
  }, 30000);

  test("recovers stale provider slots without requiring old item ownership", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-slot-stale-item-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-slot-stale-item-fixture";
    const fixture = await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "stale item provider slot fixture",
    });
    const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const checkpointPath = join(runRoot, "items", `${fixture.itemId}.json`);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    await writeDurableJsonFixture(
      checkpointPath,
      {
        ...checkpoint,
        status: "running",
        runnerSessionId: "stale-session",
        runnerHost: hostname(),
        runnerPid: 99999999,
        runnerHeartbeatAt: "2026-05-23T00:00:00.000Z",
        leaseGeneration: 1,
        fencingToken: "stale-item-fence",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        bookLeaseGeneration: 1,
        bookFencingToken: "stale-book-fence",
        currentCommand: "resume-book-1",
      },
    );
    const providerSlotDir = join(runRoot, "provider-slots");
    await mkdir(providerSlotDir, { recursive: true });
    await writeDurableJsonFixture(
      join(providerSlotDir, "openai-slot-stale.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        provider: "openai",
        slotId: "openai-slot-stale",
        itemId: fixture.itemId,
        bookId: fixture.bookId,
        workerId: "worker-stale",
        command: "resume-book-1",
        limit: 1,
        runnerSessionId: "stale-session",
        runnerHost: hostname(),
        runnerPid: 99999999,
        generation: 1,
        fencingToken: "stale-provider-fence",
        acquiredAt: "2026-05-23T00:00:00.000Z",
        heartbeatAt: "2026-05-23T00:00:00.000Z",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
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
        "--migrate-only",
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
    const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const recoveredEvent = events.find((event) =>
      event.event === "provider_slot_lease_recovered" &&
      event.metadata?.slotId === "openai-slot-stale"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(durablePrimaryJsonEntries(providerSlotDir)
      .filter((name) => !name.endsWith(".registry.json"))).toHaveLength(0);
    expect(recoveredEvent?.itemId).toBeUndefined();
    expect(recoveredEvent?.metadata).toMatchObject({
      itemId: fixture.itemId,
      bookId: fixture.bookId,
      workerId: "worker-stale",
      reason: "dead_same_host_runner",
    });
    await rm(tmpRoot, { recursive: true, force: true });
  }, 30000);

  test("durable provider slots gate capacity across concurrent workers", async () => {
    const fixture = await runParallelRunnerFixture({
      concurrency: 2,
      runId: "durable-provider-slot-capacity-fixture",
      openaiProviderConcurrency: 1,
    });
    const openaiAcquires = fixture.events.filter((event) =>
      event.event === "provider_slot_lease_acquired" &&
      event.metadata?.provider === "openai"
    );
    const openaiReleases = fixture.events.filter((event) =>
      event.event === "provider_slot_lease_released" &&
      event.metadata?.provider === "openai"
    );
    let active = 0;
    let maxActive = 0;
    for (const event of fixture.events) {
      if (
        event.event === "provider_slot_lease_acquired" &&
        event.metadata?.provider === "openai"
      ) {
        active += 1;
        maxActive = Math.max(maxActive, active);
      }
      if (
        event.event === "provider_slot_lease_released" &&
        event.metadata?.provider === "openai"
      ) {
        active = Math.max(0, active - 1);
      }
    }
    expect(fixture.result.exitCode).toBe(0);
    expect(fixture.result.stderr).toBe("");
    expect(openaiAcquires.length).toBeGreaterThan(0);
    expect(openaiReleases.length).toBe(openaiAcquires.length);
    expect(maxActive).toBeLessThanOrEqual(1);
    expect(openaiAcquires.every((event) =>
      event.metadata?.durableCapacityGate === true
    )).toBe(true);
    await rm(fixture.tmpRoot, { recursive: true, force: true });
  }, 240000);

  test("provider slot stale release cannot delete the current durable slot", async () => {
    const fixture = await runParallelRunnerFixture({
      concurrency: 1,
      runId: "provider-slot-release-fence-fixture",
    });
    const releaseRejected = fixture.events.filter((event) =>
      event.event === "provider_slot_lease_release_rejected"
    );
    const releases = fixture.events.filter((event) =>
      event.event === "provider_slot_lease_released"
    );
    expect(fixture.result.exitCode).toBe(0);
    expect(fixture.result.stderr).toBe("");
    expect(releaseRejected).toHaveLength(0);
    expect(releases.length).toBeGreaterThan(0);
    expect(releases.every((event) =>
      typeof event.metadata?.fencingToken === "string" &&
      typeof event.metadata?.generation === "number"
    )).toBe(true);
    await rm(fixture.tmpRoot, { recursive: true, force: true });
  }, 240000);

  test("parallel non-transient failure quiesces sibling workers", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-parallel-quiesce-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "parallel-non-transient-quiesce-fixture";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const firstPath = join(sourceDir, "A-Failed.epub");
    const secondPath = join(sourceDir, "B-Slow.epub");
    const thirdPath = join(sourceDir, "C-Should-Not-Start.epub");
    await writeMinimalEpubFixture(firstPath, "A Failed");
    await writeMinimalEpubFixture(secondPath, "B Slow");
    await writeMinimalEpubFixture(thirdPath, "C Pending");
    const resumeEventsPath = join(tmpRoot, "resume-events.jsonl");
    const resumeScript = join(tmpRoot, "fake-parallel-quiesce-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "import { appendFileSync } from 'node:fs';",
        "import { basename } from 'node:path';",
        "const sourceArg = process.argv.indexOf('--source-path');",
        "const name = basename(process.argv[sourceArg + 1] ?? 'unknown');",
        "appendFileSync(process.env.RESUME_EVENTS_PATH, JSON.stringify({",
        "  name, phase: 'start', at: Date.now()",
        "}) + '\\n');",
        "if (name === 'A-Failed.epub') {",
        "  await new Promise((resolve) => setTimeout(resolve, 700));",
        "  console.error('search output contract mismatch');",
        "  process.exit(1);",
        "}",
        "await new Promise((resolve) => setTimeout(resolve, 30000));",
        "console.log(JSON.stringify({ status: 'ready', bookId: 'unused' }));",
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
        "--book-concurrency",
        "2",
        "--openai-provider-concurrency",
        "2",
        "--jina-provider-concurrency",
        "2",
        "--local-cpu-concurrency",
        "2",
        "--max-command-attempts",
        "1",
        "--max-resume-passes",
        "1",
        "--command-timeout-seconds",
        "20",
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
          QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES: ReducedGraphQueryCommandChecks,
          RESUME_EVENTS_PATH: resumeEventsPath,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const resumeEvents = readFileSync(resumeEventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const subprocesses = readdirSync(join(runRoot, "subprocesses"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(
        join(runRoot, "subprocesses", name),
        "utf8",
      )));
    const thirdHash = createHash("sha256").update(readFileSync(thirdPath)).digest("hex");
    const thirdItemId = `item-${thirdHash.slice(0, 12)}-${
      createHash("sha256")
        .update(relative(projectRoot, thirdPath))
        .digest("hex")
        .slice(0, 8)
    }`;

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(resumeEvents.some((event) => event.name === "A-Failed.epub")).toBe(true);
    expect(resumeEvents.some((event) => event.name === "B-Slow.epub")).toBe(true);
    expect(resumeEvents.some((event) => event.name === "C-Should-Not-Start.epub"))
      .toBe(false);
    expect(events.some((event) =>
      event.event === "batch_stop_requested" &&
      event.metadata?.reason === "worker_stop_until_fixed"
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "batch_active_subprocesses_terminating" &&
      event.metadata?.reason === "worker_stop_until_fixed"
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "command_start" && event.itemId === thirdItemId
    )).toBe(false);
    expect(subprocesses.some((record) =>
      record.command === "resume-book-1" &&
      record.status === "killed" &&
      record.signal === "SIGTERM"
    )).toBe(true);
  }, 60000);

  test("restart quarantines remote orphan subprocess records", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-remote-orphan-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "remote-orphan-fixture";
    const fixture = await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "remote orphan fixture",
    });
    const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const subprocessDir = join(runRoot, "subprocesses");
    await mkdir(subprocessDir, { recursive: true });
    await writeDurableJsonFixture(join(subprocessDir, "remote-child.json"), {
      schemaVersion: SchemaVersion,
      runId,
      subprocessId: "remote-child",
      runnerSessionId: "remote-session",
      runnerHost: "remote-host.example",
      runnerPid: 43210,
      pid: 54321,
      command: "resume-book-1",
      itemId: fixture.itemId,
      bookId: fixture.bookId,
      workerId: "worker-remote",
      providerSlotId: "openai-slot-remote",
      processGroup: true,
      startedAt: "2026-05-23T00:00:00.000Z",
      heartbeatAt: "2026-05-23T00:00:01.000Z",
      status: "running",
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
      ], { cwd: tmpRoot, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const subprocessRecord = JSON.parse(readFileSync(
      join(subprocessDir, "remote-child.json"),
      "utf8",
    ));
    const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(subprocessRecord.status).toBe("quarantined");
    expect(subprocessRecord.signal).toBe("REMOTE_ORPHAN_QUARANTINED");
    expect(events.some((event) =>
      event.event === "subprocess_orphan_quarantined" &&
      event.recoveryDecision === "stop_until_fixed"
    )).toBe(true);
    await rm(tmpRoot, { recursive: true, force: true });
  }, 30000);

  test("recovers dead subprocess records without requiring old item ownership", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-dead-orphan-stale-item-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "dead-orphan-stale-item-fixture";
    const fixture = await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "dead orphan stale item fixture",
    });
    const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const checkpointPath = join(runRoot, "items", `${fixture.itemId}.json`);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    await writeDurableJsonFixture(
      checkpointPath,
      {
        ...checkpoint,
        status: "running",
        runnerSessionId: "stale-session",
        runnerHost: hostname(),
        runnerPid: 99999999,
        runnerHeartbeatAt: "2026-05-23T00:00:00.000Z",
        leaseGeneration: 1,
        fencingToken: "stale-item-fence",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        bookLeaseGeneration: 1,
        bookFencingToken: "stale-book-fence",
        currentCommand: "resume-book-1",
      },
    );
    const subprocessDir = join(runRoot, "subprocesses");
    await mkdir(subprocessDir, { recursive: true });
    await writeDurableJsonFixture(join(subprocessDir, "dead-child.json"), {
      schemaVersion: SchemaVersion,
      runId,
      subprocessId: "dead-child",
      runnerSessionId: "stale-session",
      runnerHost: hostname(),
      runnerPid: 99999999,
      pid: 99999998,
      command: "resume-book-1",
      itemId: fixture.itemId,
      bookId: fixture.bookId,
      workerId: "worker-stale",
      providerSlotId: "openai-slot-stale",
      processGroup: true,
      startedAt: "2026-05-23T00:00:00.000Z",
      heartbeatAt: "2026-05-23T00:00:01.000Z",
      status: "running",
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
        "--migrate-only",
      ], { cwd: tmpRoot, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const subprocessRecord = JSON.parse(readFileSync(
      join(subprocessDir, "dead-child.json"),
      "utf8",
    ));
    const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const recoveredEvent = events.find((event) =>
      event.event === "subprocess_orphan_recovered" &&
      event.metadata?.subprocessId === "dead-child"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(subprocessRecord.status).toBe("killed");
    expect(subprocessRecord.signal).toBe("ORPHAN_RECOVERED");
    expect(recoveredEvent?.itemId).toBeUndefined();
    expect(recoveredEvent?.metadata).toMatchObject({
      itemId: fixture.itemId,
      bookId: fixture.bookId,
      workerId: "worker-stale",
      reason: "dead_child",
    });
    await rm(tmpRoot, { recursive: true, force: true });
  }, 30000);

  test("restart terminates same-host live orphan subprocess records", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-live-orphan-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "same-host-live-orphan-fixture";
    const fixture = await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "same-host live orphan fixture",
    });
    const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const subprocessDir = join(runRoot, "subprocesses");
    await mkdir(subprocessDir, { recursive: true });
    const orphan = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000);",
    ], { stdio: "ignore" });
    try {
      await writeDurableJsonFixture(join(subprocessDir, "live-child.json"), {
        schemaVersion: SchemaVersion,
        runId,
        subprocessId: "live-child",
        runnerSessionId: "dead-parent-session",
        runnerHost: hostname(),
        runnerPid: 99999999,
        pid: orphan.pid,
        command: "resume-book-1",
        itemId: fixture.itemId,
        bookId: fixture.bookId,
        workerId: "worker-orphan",
        providerSlotId: "openai-slot-orphan",
        processGroup: false,
        startedAt: "2026-05-23T00:00:00.000Z",
        heartbeatAt: "2026-05-23T00:00:01.000Z",
        status: "running",
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
        ], {
          cwd: tmpRoot,
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
      });

      const subprocessRecord = JSON.parse(readFileSync(
        join(subprocessDir, "live-child.json"),
        "utf8",
      ));
      const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      await new Promise<void>((resolveResult) => {
        if (orphan.exitCode != null) {
          resolveResult();
          return;
        }
        orphan.once("close", () => resolveResult());
        setTimeout(() => resolveResult(), 5000).unref();
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(subprocessRecord.status).toBe("killed");
      expect(subprocessRecord.signal).toBe("ORPHAN_TERMINATED");
      expect(events.some((event) =>
        event.event === "subprocess_orphan_terminated" &&
        event.recoveryDecision === "continue_pending"
      )).toBe(true);
      if (orphan.pid != null) {
        expect(() => process.kill(orphan.pid as number, 0)).toThrow();
      }
    } finally {
      if (orphan.exitCode == null && orphan.pid != null) {
        try {
          process.kill(orphan.pid, "SIGKILL");
        } catch {
          // The runner may already have terminated the orphan.
        }
      }
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 30000);
});
