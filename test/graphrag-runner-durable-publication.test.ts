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

describe("GraphRAG EPUB batch runner - Durable Publication", () => {
  test("durable reconcile preserves stale temps when target generation advanced",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-durable-temp-generation-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "durable-temp-generation-fixture";
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      await mkdir(sourceDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await mkdir(join(runRoot, "items"), { recursive: true });
      await writeMinimalEpubFixture(join(sourceDir, "Generation.epub"), "Generation");
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
      const staleTemp = `${manifestPath}.tmp-advanced-generation`;
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await writeFile(staleTemp, "{\"stale\":true}\n", "utf8");
      await writeFile(`${staleTemp}.owner.json`, JSON.stringify({
        tempId: "advanced-generation-temp",
        operationId: "advanced-generation-op",
        targetLocator: relative(projectRoot, manifestPath),
        absoluteTargetLocator: manifestPath,
        ownerPid: 999999,
        ownerHost: hostname(),
        createdAt: oldDate.toISOString(),
        leaseGeneration: 1,
        targetGeneration: 1,
        targetChecksumBefore: "old-target-checksum",
        fencingTokenHash: "advanced-generation-fence",
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
      expect(existsSync(staleTemp)).toBe(true);
      expect(existsSync(`${staleTemp}.owner.json`)).toBe(true);
      expect(eventRaw).not.toContain("advanced-generation-temp");
      await rm(tmpRoot, { recursive: true, force: true });
    },
    30000);

  test("durable reconcile ignores auxiliary JSON in lease and registry dirs",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-durable-aux-filter-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "durable-aux-filter-fixture";
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      const sourcePath = join(sourceDir, "Aux.epub");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await mkdir(join(runRoot, "items"), { recursive: true });
      await mkdir(join(runRoot, "provider-slots"), { recursive: true });
      await mkdir(join(runRoot, "subprocesses"), { recursive: true });
      await mkdir(join(runRoot, "book-leases"), { recursive: true });
      await writeMinimalEpubFixture(sourcePath, "Auxiliary Filter");
      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
      const sourceHash = createHash("sha256")
        .update(readFileSync(sourcePath))
        .digest("hex");
      const sourceRelativePath = relative(projectRoot, sourcePath);
      const itemId = `item-${sourceHash.slice(0, 12)}-${
        createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
      }`;

      await writeDurableJsonFixture(join(runRoot, "manifest.json"), {
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
        activeProviderSlots: 0,
        activeSubprocesses: 0,
        activeBookLeases: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
        itemIds: [itemId],
      });
      const sidecarNames = [
        "provider-slots/openai-slot-x.json.sha256.meta.json",
        "provider-slots/openai-slot-x.json.tmp-live.owner.json",
        "provider-slots/openai-slot-x.json.tmp-live",
        "subprocesses/subprocess-x.json.sha256.meta.json",
        "subprocesses/subprocess-x.json.tmp-live.owner.json",
        "book-leases/book-x.json.sha256.meta.json",
        "book-leases/book-x.json.tmp-live.owner.json",
      ];
      for (const name of sidecarNames) {
        const path = join(runRoot, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "{\"sidecar\":true}\n", "utf8");
      }

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
      const generatedAuxiliary = readdirSync(join(runRoot, "provider-slots"))
        .concat(readdirSync(join(runRoot, "subprocesses")))
        .concat(readdirSync(join(runRoot, "book-leases")))
        .filter((name) => name.includes(".sha256.meta.json.sha256") ||
          name.includes(".owner.json.sha256"));

      expect(result.exitCode).toBe(0);
      expect(eventRaw).not.toContain("durable_json_checksum_backfilled");
      expect(eventRaw).not.toContain("durable_json_target_quarantined");
      expect(generatedAuxiliary).toEqual([]);
      await rm(tmpRoot, { recursive: true, force: true });
    },
    30000);

	  test("durable reconcile commits matching pending checksum metadata",
	    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-pending-meta-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "durable-pending-meta-fixture";
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      await mkdir(sourceDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await mkdir(join(runRoot, "items"), { recursive: true });
      await writeMinimalEpubFixture(join(sourceDir, "Pending.epub"), "Pending Meta");
      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
      await writeDurableJsonFixture(join(runRoot, "manifest.json"), {
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
      const slotPath = join(runRoot, "provider-slots", "unused-pending.json");
      const slotText = await writeDurableJsonFixture(slotPath, {
        schemaVersion: SchemaVersion,
        status: "pending",
        value: "pending-meta-target",
      });
      const checksum = stableTextHash(slotText);
      const committedMeta = JSON.parse(
        readFileSync(`${slotPath}.sha256.meta.json`, "utf8"),
      );
      await writeFile(`${slotPath}.sha256.meta.json`, JSON.stringify({
        ...committedMeta,
        checksum,
        targetLocator: relative(projectRoot, slotPath),
        checksumRecoveryDecision: "target_rename_pending",
        commitState: "target_rename_pending",
      }, null, 2) + "\n", "utf8");

      const result = await runBatchMigrateOnly({
        tmpRoot,
        sourceDir,
        stateRoot,
        logRoot,
        configDir,
        runId,
      });
      const meta = JSON.parse(readFileSync(`${slotPath}.sha256.meta.json`, "utf8"));
      const eventRaw = readFileSync(join(runRoot, "events.jsonl"), "utf8");

      expect(result.exitCode).toBe(0);
      expect(meta).toMatchObject({
        checksum,
        checksumRecoveryDecision: "pending_meta_committed",
        commitState: "committed",
      });
      expect(eventRaw).toContain("durable_json_checksum_meta_committed");
      await rm(tmpRoot, { recursive: true, force: true });
	    },
	    60000);

	  test("durable preflight blocks partial checksum sidecar crash window",
	    async () => {
	      const tmpRoot = await mkProjectTmpDir("qmd-batch-partial-checksum-");
	      const sourceDir = join(tmpRoot, "source");
	      const stateRoot = join(tmpRoot, "graph_vault");
	      const logRoot = join(tmpRoot, "logs");
	      const configDir = join(tmpRoot, "config");
	      const runId = "partial-checksum-sidecar-fixture";
	      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
	      await mkdir(sourceDir, { recursive: true });
	      await mkdir(configDir, { recursive: true });
	      await writeMinimalEpubFixture(join(sourceDir, "Partial.epub"), "Partial");
	      await writeFile(join(configDir, "index.yml"), "collections: {}\n");

	      const first = await new Promise<{
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
	      const second = await runBatchMigrateOnly({
	        tmpRoot,
	        sourceDir,
	        stateRoot,
	        logRoot,
	        configDir,
	        runId,
	      });
	      const manifestPath = join(runRoot, "manifest.json");
	      await writeFile(`${manifestPath}.sha256`, `${"0".repeat(64)}\n`, "utf8");
	      await writeFile(`${manifestPath}.sha256.meta.json`, JSON.stringify({
	        checksum: "partial-checksum-sidecar",
	        targetLocator: relative(projectRoot, manifestPath),
	        checksumRecoveryDecision: "partial_checksum_sidecar_injected",
	        commitState: "checksum_sidecar_partial",
	      }, null, 2) + "\n", "utf8");
	      const third = await runBatchMigrateOnly({
	        tmpRoot,
	        sourceDir,
	        stateRoot,
	        logRoot,
	        configDir,
	        runId,
	      });
      const eventRaw = readFileSync(join(runRoot, "events.jsonl"), "utf8");
      const events = eventRaw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const quarantine = events.find((event) =>
        event.event === "durable_json_target_quarantined"
      );
      const checksumFailure = events.find((event) =>
        event.localFailureClass === "durable_checksum_mismatch"
      );

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(third.exitCode).not.toBe(0);
      expect(third.stderr).toContain("invalid durable JSON target");
      expect(third.stderr).toContain("checksum mismatch");
      expect(eventRaw).toContain("stop_until_fixed");
      expect(eventRaw).toContain("durable_json_target_quarantined");
      expect(quarantine).toMatchObject({
        failureKind: "local_state_integrity",
        localFailureClass: "durable_checksum_mismatch",
        retryable: false,
        recoveryDecision: "stop_until_fixed",
        checksumRecoveryDecision: "stop_until_fixed",
        failedStage: "durable_state",
      });
      expect(quarantine?.metadata?.quarantineLocator)
        .toContain("manifest.json.corrupt-");
      expect(checksumFailure).toMatchObject({
        localFailureClass: "durable_checksum_mismatch",
        checksumRecoveryDecision: "stop_until_fixed",
      });
      await rm(tmpRoot, { recursive: true, force: true });
	    },
	    30000);

	  test("durable preflight blocks unresolved stale lock without fencing evidence",
	    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-preflight-lock-fence-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "durable-preflight-lock-fence-fixture";
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      await mkdir(sourceDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await mkdir(runRoot, { recursive: true });
      await writeMinimalEpubFixture(join(sourceDir, "Fence.epub"), "Fence");
      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
      const lockPath = join(runRoot, "manifest.json.lock");
      await writeDurableJsonFixture(join(runRoot, "manifest.json"), {
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
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await writeFile(lockPath, JSON.stringify({
        pid: 999999,
        runnerSessionId: "legacy-lock-without-fence",
        runnerHost: hostname(),
        targetLocator: relative(projectRoot, join(runRoot, "manifest.json")),
        acquiredAt: oldDate.toISOString(),
        heartbeatAt: oldDate.toISOString(),
        expiresAt: oldDate.toISOString(),
      }) + "\n", "utf8");
      await utimes(lockPath, oldDate, oldDate);

      const result = await runBatchMigrateOnly({
        tmpRoot,
        sourceDir,
        stateRoot,
        logRoot,
        configDir,
        runId,
      });
      const eventsPath = join(runRoot, "events.jsonl");
      const events = existsSync(eventsPath)
        ? readFileSync(eventsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        : [];
      const preflight = events.find((event) =>
        event.event === "durable_preflight_blocked"
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr)
        .toContain("durable preflight blocked stale lock without recovery fence");
      expect(result.stderr).toContain("manifest.json.lock");
      expect(existsSync(lockPath)).toBe(true);
      if (preflight == null) {
        expect(events).toEqual([]);
      } else {
        expect(preflight).toMatchObject({
          failureKind: "local_state_integrity",
          retryable: false,
          recoveryDecision: "stop_until_fixed",
          localFailureClass: "durable_preflight_live_lock",
        });
        expect(preflight.lockOwnerEvidence).toMatchObject({
          runnerSessionId: "legacy-lock-without-fence",
        });
      }
      await rm(tmpRoot, { recursive: true, force: true });
	    },
	    30000);

	  test("before-claim preflight blocks nested book output durable sidecar temp",
	    async () => {
	      const tmpRoot = await mkProjectTmpDir("qmd-batch-preflight-orphan-temp-");
	      const sourceDir = join(tmpRoot, "source");
	      const stateRoot = join(tmpRoot, "graph_vault");
	      const logRoot = join(tmpRoot, "logs");
	      const configDir = join(tmpRoot, "config");
	      const runId = "preflight-orphan-temp-fixture";
	      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
	      const sourcePath = join(sourceDir, "Orphan.epub");
	      await mkdir(sourceDir, { recursive: true });
	      await mkdir(configDir, { recursive: true });
	      await mkdir(join(runRoot, "items"), { recursive: true });
	      await writeMinimalEpubFixture(sourcePath, "Orphan");
	      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
	      const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
	      const bookId = batchBookId(sourceHash, relative(projectRoot, sourcePath));
	      await writeProviderAuthReopenGraphFixture({ stateRoot, bookId, sourceHash });
	      const manifestPath = join(runRoot, "manifest.json");
	      const resumeEventsPath = join(tmpRoot, "resume-events.jsonl");
	      const resumeScript = join(tmpRoot, "fake-resume-should-not-run.mjs");
	      await writeFile(
	        resumeScript,
	        [
	          "import { appendFileSync } from 'node:fs';",
	          "appendFileSync(process.env.RESUME_EVENTS_PATH, 'started\\n');",
	          `console.log(JSON.stringify({ status: 'ready', bookId: '${bookId}' }));`,
	        ].join("\n"),
	      );
	      const qmdScript = join(tmpRoot, "fake-qmd.mjs");
	      await writeFile(
	        qmdScript,
	        [
	          "if (process.argv.includes('--version')) console.log('qmd-test 1.0.0');",
	          "else if (process.argv.includes('--json')) console.log('{}');",
	          "else console.log('ok');",
	        ].join("\n"),
	      );
		      const rowCountPath = join(
		        stateRoot,
		        "books",
		        bookId,
		        "graphrag",
		        "output",
		        "lancedb",
		        "entity_description.lance",
		        "qmd_row_count.json",
		      );
		      const orphanTemp = `${rowCountPath}.tmp-before-resume-orphan`;
		      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
		      await mkdir(dirname(rowCountPath), { recursive: true });
		      await writeFile(orphanTemp, "{\"orphan\":true}\n", "utf8");
		      await writeFile(`${orphanTemp}.owner.json`, JSON.stringify({
		        tempId: "before-resume-orphan",
		        operationId: "before-resume-orphan-op",
		        targetLocator: relative(projectRoot, rowCountPath),
		        absoluteTargetLocator: rowCountPath,
		        ownerPid: 999999,
	        ownerHost: hostname(),
	        createdAt: oldDate.toISOString(),
	        leaseGeneration: 1,
	        targetGeneration: 1,
	        targetChecksumBefore: "stale-checksum",
	        fencingTokenHash: "before-resume-orphan-fence",
	        durableMode: "strict",
	      }) + "\n", "utf8");
	      await utimes(orphanTemp, oldDate, oldDate);
	      await utimes(`${orphanTemp}.owner.json`, oldDate, oldDate);

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
	            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
	            QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
	            QMD_GRAPHRAG_TEST_QMD_RUNNER: "1",
	            QMD_GRAPHRAG_QMD_RUNNER: qmdScript,
	            QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES:
	              "qmd-version,qmd-query-auto-json,qmd-query-graphrag-json",
	            QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
	            RESUME_EVENTS_PATH: resumeEventsPath,
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
	      const preflight = events.find((event) =>
	        event.event === "durable_preflight_blocked"
	      );

      expect(result.exitCode).not.toBe(0);
      expect(existsSync(orphanTemp)).toBe(true);
      expect(existsSync(resumeEventsPath)).toBe(false);
      expect(preflight).toMatchObject({
        failureKind: "local_state_integrity",
        retryable: false,
        recoveryDecision: "stop_until_fixed",
	        localFailureClass: "durable_preflight_unresolved_temp",
	        failedStage: "before_claim",
	        targetLocator: expect.stringContaining("qmd_row_count.json"),
	      });
      expect(preflight?.metadata).toMatchObject({
        cleanupReason: "target_generation_advanced",
        firstBlockerReason: "target_generation_advanced",
      });
	      expect(preflight?.lockOwnerEvidence).toMatchObject({
	        tempId: "before-resume-orphan",
	        targetChecksumBefore: "stale-checksum",
	      });
	      await rm(tmpRoot, { recursive: true, force: true });
	    },
	    30000);

  test("runner-start preflight blocks book YAML temp from target mapping",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-runner-start-book-temp-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "runner-start-book-yaml-temp";
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      const sourcePath = join(sourceDir, "Runner-Start-Temp.epub");
      try {
        await mkdir(sourceDir, { recursive: true });
        await mkdir(configDir, { recursive: true });
        await writeFile(join(configDir, "index.yml"), "collections: {}\n");
        await writeMinimalEpubFixture(sourcePath, "Runner Start Temp");
        const sourceHash = createHash("sha256")
          .update(readFileSync(sourcePath))
          .digest("hex");
        const bookId = batchBookId(sourceHash, relative(projectRoot, sourcePath));
        await writeProviderAuthReopenGraphFixture({ stateRoot, bookId, sourceHash });

        const target = join(stateRoot, "books", bookId, "state", "job.yaml");
        const orphanTemp = `${target}.tmp-runner-start`;
        const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(orphanTemp, "partial: true\n", "utf8");
        await writeFile(`${orphanTemp}.owner.json`, JSON.stringify({
          tempId: "runner-start-book-temp",
          operationId: "runner-start-book-temp-op",
          targetLocator: relative(projectRoot, target),
          absoluteTargetLocator: target,
          ownerPid: 999999,
          ownerHost: hostname(),
          createdAt: oldDate.toISOString(),
          expiresAt: oldDate.toISOString(),
          leaseGeneration: 1,
          targetGeneration: 1,
          targetChecksumBefore: "stale-checksum",
          fencingTokenHash: "runner-start-book-temp-fence",
          lane: "checkpointWriterLane",
          targetMappingOwner: "repository",
          durableMode: "strict",
          completedPublishRule: "forbidden",
        }, null, 2) + "\n", "utf8");
        await utimes(orphanTemp, oldDate, oldDate);
        await utimes(`${orphanTemp}.owner.json`, oldDate, oldDate);

        const resumeEventsPath = join(tmpRoot, "resume-events.jsonl");
        const resumeScript = join(tmpRoot, "fake-resume-should-not-run.mjs");
        await writeFile(
          resumeScript,
          [
            "import { appendFileSync } from 'node:fs';",
            "appendFileSync(process.env.RESUME_EVENTS_PATH, 'started\\n');",
            `console.log(JSON.stringify({ status: 'ready', bookId: '${bookId}' }));`,
          ].join("\n"),
        );
        const result = await runBatchWorkflow({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
          env: {
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
            QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
            RESUME_EVENTS_PATH: resumeEventsPath,
          },
        });
        const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const preflight = events.find((event) =>
          event.event === "durable_preflight_blocked"
        );

        expect(result.exitCode).not.toBe(0);
        expect(existsSync(orphanTemp)).toBe(true);
        expect(existsSync(resumeEventsPath)).toBe(false);
        expect(preflight).toMatchObject({
          failureKind: "local_state_integrity",
          retryable: false,
          recoveryDecision: "stop_until_fixed",
          localFailureClass: "durable_preflight_unresolved_temp",
          failedStage: "runner_start",
          targetLocator: expect.stringContaining("job.yaml"),
          lane: "checkpointWriterLane",
          targetMappingOwner: "repository",
          completedPublishRule: "forbidden",
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30000);
});
