import { describe, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import { readFileSync, rmSync } from "fs";
import { join, relative } from "path";
import {
  durablePrimaryJsonEntries,
  mkProjectTmpDir,
  projectRoot,
  runBatchWorkflow,
  writeCompletedGraphBatchFixture,
  writeDurableJsonFixture,
  writeDurableTextFixture,
  writeGraphRagPromptFixtures,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG runner claim preflight defer", () => {
  test("before-claim live lock defers and batch continues", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-claim-preflight-defer-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "claim-preflight-defer-fixture";
    try {
      const fixture = await writeCompletedGraphBatchFixture({
        tmpRoot,
        sourceDir,
        stateRoot,
        configDir,
        runId,
        sourceBytes: "claim preflight defer fixture",
      });
      await writeGraphRagPromptFixtures(stateRoot);
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      const catalogPath = join(stateRoot, "catalog", "document-identity-map.yaml");
      const lockPath = `${catalogPath}.lock`;
      await writeDurableTextFixture(catalogPath, "schemaVersion: 1.0.0\nmappings: []\n");
      const resumeScript = join(tmpRoot, "fake-resume.mjs");
      await writeFile(
        resumeScript,
        [
          "console.log(JSON.stringify({",
          "  status: 'completed',",
          `  bookId: ${JSON.stringify(fixture.bookId)},`,
          "  nextStage: null,",
          "  completedStages: ['ingest', 'normalize', 'graph_extract',",
          "    'community_report', 'embed', 'query_ready'],",
          "  queryResult: { schemaVersion: '1.0.0', method: 'local' }",
          "}));",
        ].join("\n"),
      );
      const qmdScript = join(tmpRoot, "fake-qmd.mjs");
      await writeFile(
        qmdScript,
        [
          "const args = process.argv.slice(2);",
          "if (args.includes('--version')) console.log('qmd-test 1.0.0');",
          "else if (args.includes('--json')) console.log('{}');",
          "else console.log('ok');",
        ].join("\n"),
      );
      const itemPath = join(runRoot, "items", `${fixture.itemId}.json`);
      const checkpoint = JSON.parse(readFileSync(itemPath, "utf8"));
      checkpoint.status = "pending";
      checkpoint.completedAt = undefined;
      checkpoint.recoveryDecision = "continue_pending";
      await mkdir(join(stateRoot, "catalog"), { recursive: true });
      await writeDurableJsonFixture(itemPath, checkpoint);

      await writeDurableTextFixture(catalogPath, "schemaVersion: 1.0.0\nmappings: []\n");
      await writeFile(lockPath, `${JSON.stringify({
        pid: process.pid,
        runnerSessionId: "fixture-live-lock",
        runnerHost: "fixture-host",
        runId,
        targetLocator: relative(projectRoot, catalogPath),
        lockPath: relative(projectRoot, lockPath),
        lane: "catalogWriterLane",
        targetMappingOwner: "repository",
        durableKind: "json-lock",
        laneTimeoutMs: 120000,
        releaseOn: ["commit", "error", "cancellation", "lease_loss", "timeout"],
        generation: 1,
        fencingTokenHash: "fixture-live-lock-fence",
        operationId: "fixture-live-lock-op",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1500).toISOString(),
      }, null, 2)}\n`, "utf8");
      const releaseLock = setInterval(() => {
        const eventsPath = join(runRoot, "events.jsonl");
        try {
          if (readFileSync(eventsPath, "utf8").includes(
            "item_claim_preflight_deferred",
          )) {
            rmSync(lockPath, { force: true });
            clearInterval(releaseLock);
          }
        } catch {
          // The event log may not exist before runner startup.
        }
      }, 25);

      const result = await runBatchWorkflow({
        tmpRoot,
        sourceDir,
        stateRoot,
        logRoot,
        configDir,
        runId,
        env: {
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
          QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          QMD_GRAPHRAG_TEST_QMD_RUNNER: "1",
          QMD_GRAPHRAG_QMD_RUNNER: qmdScript,
          QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES:
            "qmd-version,qmd-query-auto-json,qmd-query-graphrag-json",
        },
        timeoutMs: 30_000,
      });
      const eventRaw = readFileSync(join(runRoot, "events.jsonl"), "utf8");
      const events = eventRaw.trim().split("\n").map((line) => JSON.parse(line));
      const manifest = JSON.parse(readFileSync(join(runRoot, "manifest.json"), "utf8"));
      clearInterval(releaseLock);
      rmSync(lockPath, { force: true });
      const itemFile = durablePrimaryJsonEntries(join(runRoot, "items"))[0];
      const finalCheckpoint = JSON.parse(
        readFileSync(join(runRoot, "items", itemFile), "utf8"),
      );
      const deferred = events.find((event) =>
        event.event === "item_claim_preflight_deferred"
      );
      const waited = events.find((event) =>
        event.event === "batch_wait_claim_preflight_retry"
      );
      const completed = events.find((event) =>
        event.event === "item_completed" && event.itemId === fixture.itemId
      );

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(eventRaw).not.toContain("durable preflight blocked before_claim");
      expect(deferred).toMatchObject({
        itemId: fixture.itemId,
        event: "item_claim_preflight_deferred",
        recoveryDecision: "continue_pending",
        failedStage: "before_claim",
        localFailureClass: "durable_preflight_live_lock",
        targetMappingOwner: "repository",
      });
      expect(waited).toMatchObject({
        event: "batch_wait_claim_preflight_retry",
        recoveryDecision: "continue_pending",
      });
      expect(completed).toBeTruthy();
      expect(manifest).toMatchObject({
        status: "completed",
        completedItems: 1,
        pendingItems: 0,
        failedItems: 0,
      });
      expect(finalCheckpoint).toMatchObject({
        status: "completed",
        itemId: fixture.itemId,
      });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 60000);

  test("before-resume live catalog lock defers running item and continues", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-resume-preflight-defer-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "resume-preflight-defer-fixture";
    try {
      const fixture = await writeCompletedGraphBatchFixture({
        tmpRoot,
        sourceDir,
        stateRoot,
        configDir,
        runId,
        sourceBytes: "resume preflight defer fixture",
      });
      await writeGraphRagPromptFixtures(stateRoot);
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      const catalogPath = join(stateRoot, "catalog", "document-identity-map.yaml");
      const lockPath = `${catalogPath}.lock`;
      await writeDurableTextFixture(catalogPath, "schemaVersion: 1.0.0\nmappings: []\n");
      const resumeScript = join(tmpRoot, "fake-resume.mjs");
      await writeFile(
        resumeScript,
        [
          "import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
          `const markerPath = ${JSON.stringify(join(tmpRoot, "resume-marker"))};`,
          `const lockPath = ${JSON.stringify(lockPath)};`,
          `const lockOwner = ${JSON.stringify({
            pid: process.pid,
            runnerSessionId: "fixture-resume-live-lock",
            runnerHost: "fixture-host",
            runId,
            targetLocator: relative(projectRoot, catalogPath),
            lockPath: relative(projectRoot, lockPath),
            lane: "catalogWriterLane",
            targetMappingOwner: "repository",
            durableKind: "json-lock",
            laneTimeoutMs: 120000,
            releaseOn: ["commit", "error", "cancellation", "lease_loss", "timeout"],
            generation: 1,
            fencingTokenHash: "fixture-resume-live-lock-fence",
            operationId: "fixture-resume-live-lock-op",
          })};`,
          "const count = existsSync(markerPath)",
          "  ? Number(readFileSync(markerPath, 'utf8'))",
          "  : 0;",
          "writeFileSync(markerPath, String(count + 1));",
          "if (count === 0) {",
          "  writeFileSync(lockPath, JSON.stringify({",
          "    ...lockOwner,",
          "    acquiredAt: new Date().toISOString(),",
          "    heartbeatAt: new Date().toISOString(),",
          "    expiresAt: new Date(Date.now() + 120000).toISOString(),",
          "  }, null, 2) + '\\n');",
          "  console.log(JSON.stringify({",
          "    status: 'running',",
          `    bookId: ${JSON.stringify(fixture.bookId)},`,
          "    nextStage: 'embed'",
          "  }));",
          "  process.exit(0);",
          "}",
          "if (existsSync(lockPath)) {",
          "  rmSync(lockPath, { force: true });",
          "}",
          "console.log(JSON.stringify({",
          "  status: 'completed',",
          `  bookId: ${JSON.stringify(fixture.bookId)},`,
          "  nextStage: null,",
          "  completedStages: ['ingest', 'normalize', 'graph_extract',",
          "    'community_report', 'embed', 'query_ready'],",
          "  queryResult: { schemaVersion: '1.0.0', method: 'local' }",
          "}));",
        ].join("\n"),
      );
      const qmdScript = join(tmpRoot, "fake-qmd.mjs");
      await writeFile(
        qmdScript,
        [
          "const args = process.argv.slice(2);",
          "if (args.includes('--version')) console.log('qmd-test 1.0.0');",
          "else if (args.includes('--json')) console.log('{}');",
          "else console.log('ok');",
        ].join("\n"),
      );
      const itemPath = join(runRoot, "items", `${fixture.itemId}.json`);
      const checkpoint = JSON.parse(readFileSync(itemPath, "utf8"));
      checkpoint.status = "pending";
      checkpoint.completedAt = undefined;
      checkpoint.recoveryDecision = "continue_pending";
      await writeDurableJsonFixture(itemPath, checkpoint);

      const releaseLock = setInterval(() => {
        const eventsPath = join(runRoot, "events.jsonl");
        try {
          if (readFileSync(eventsPath, "utf8").includes(
            "item_durable_preflight_deferred",
          )) {
            rmSync(lockPath, { force: true });
            clearInterval(releaseLock);
          }
        } catch {
          // The event log may not exist before runner startup.
        }
      }, 25);

      const result = await runBatchWorkflow({
        tmpRoot,
        sourceDir,
        stateRoot,
        logRoot,
        configDir,
        runId,
        maxResumePasses: 2,
        env: {
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
          QMD_GRAPHRAG_TEST_SKIP_RUNNER_START_PREFLIGHT: "1",
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          QMD_GRAPHRAG_TEST_QMD_RUNNER: "1",
          QMD_GRAPHRAG_QMD_RUNNER: qmdScript,
          QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES:
            "qmd-version,qmd-query-auto-json,qmd-query-graphrag-json",
        },
        timeoutMs: 60_000,
      });
      const eventRaw = readFileSync(join(runRoot, "events.jsonl"), "utf8");
      const events = eventRaw.trim().split("\n").map((line) => JSON.parse(line));
      const manifest = JSON.parse(readFileSync(join(runRoot, "manifest.json"), "utf8"));
      clearInterval(releaseLock);
      rmSync(lockPath, { force: true });
      const itemFile = durablePrimaryJsonEntries(join(runRoot, "items"))[0];
      const finalCheckpoint = JSON.parse(
        readFileSync(join(runRoot, "items", itemFile), "utf8"),
      );
      const deferred = events.find((event) =>
        event.event === "item_durable_preflight_deferred"
      );
      const waited = events.find((event) =>
        event.event === "batch_wait_claim_preflight_retry"
      );

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(eventRaw).not.toContain("durable preflight blocked before_resume_book");
      expect(deferred).toMatchObject({
        itemId: fixture.itemId,
        event: "item_durable_preflight_deferred",
        recoveryDecision: "continue_pending",
        failedStage: "before_resume_book",
        localFailureClass: "durable_preflight_live_lock",
        targetMappingOwner: "repository",
      });
      expect(waited).toMatchObject({
        event: "batch_wait_claim_preflight_retry",
        recoveryDecision: "continue_pending",
      });
      expect(manifest).toMatchObject({
        status: "completed",
        completedItems: 1,
        pendingItems: 0,
        failedItems: 0,
      });
      expect(finalCheckpoint).toMatchObject({
        status: "completed",
        itemId: fixture.itemId,
      });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 60000);
});
