import { describe, expect, test } from "vitest";
import { rm, writeFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  durablePrimaryJsonEntries,
  mkProjectTmpDir,
  runBatchWorkflow,
  writeCompletedGraphBatchFixture,
  writeDurableJsonFixture,
  writeGraphRagPromptFixtures,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG runner claim conflict recovery", () => {
  test("checkpoint refresh after book lease claim defers without leaking lease",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-claim-conflict-recovery-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "claim-conflict-recovery-fixture";
      try {
        const fixture = await writeCompletedGraphBatchFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
          sourceBytes: "claim conflict recovery fixture",
        });
        await writeGraphRagPromptFixtures(stateRoot);
        const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
        const itemPath = join(runRoot, "items", `${fixture.itemId}.json`);
        const checkpoint = JSON.parse(readFileSync(itemPath, "utf8"));
        checkpoint.status = "pending";
        checkpoint.completedAt = undefined;
        checkpoint.recoveryDecision = "continue_pending";
        checkpoint.runnerHeartbeatAt = "2026-05-23T00:00:00.000Z";
        await writeDurableJsonFixture(itemPath, checkpoint);

        const resumeScript = join(tmpRoot, "fake-resume.mjs");
        await writeFile(
          resumeScript,
          [
            "console.log(JSON.stringify({",
            "  status: 'ready',",
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
            QMD_GRAPHRAG_TEST_CLAIM_START_CHECKPOINT_CHANGE_ITEM_ID:
              fixture.itemId,
          },
          timeoutMs: 30_000,
        });

        const eventRaw = readFileSync(join(runRoot, "events.jsonl"), "utf8");
        const events = eventRaw.trim().split("\n").map((line) => JSON.parse(line));
        const manifest = JSON.parse(readFileSync(join(runRoot, "manifest.json"), "utf8"));
        const finalCheckpoint = JSON.parse(readFileSync(itemPath, "utf8"));
        const leaseDir = join(runRoot, "book-leases");
        const conflict = events.find((event) =>
          event.event === "item_claim_conflict_deferred"
        );
        const release = events.find((event) =>
          event.event === "book_lease_released" &&
          event.metadata?.generation === conflict?.metadata?.bookLeaseGeneration
        );

        expect(result).toMatchObject({ exitCode: 0, stderr: "" });
        expect(eventRaw).not.toContain("checkpoint changed before item start");
        expect(conflict).toMatchObject({
          itemId: fixture.itemId,
          event: "item_claim_conflict_deferred",
          status: "pending",
          recoveryDecision: "continue_pending",
          metadata: {
            reason: "checkpoint_changed_before_item_start",
            changedFields: expect.arrayContaining(["runnerHeartbeatAt"]),
          },
        });
        expect(release).toMatchObject({
          itemId: fixture.itemId,
          event: "book_lease_released",
          status: "pending",
        });
        expect(events.some((event) =>
          event.event === "item_completed" && event.itemId === fixture.itemId
        )).toBe(true);
        expect(manifest).toMatchObject({
          status: "completed",
          completedItems: 1,
          pendingItems: 0,
          failedItems: 0,
          activeBookLeases: 0,
        });
        expect(finalCheckpoint).toMatchObject({
          itemId: fixture.itemId,
          status: "completed",
        });
        expect(existsSync(leaseDir)).toBe(true);
        expect(durablePrimaryJsonEntries(leaseDir)).toHaveLength(0);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    60000,
  );
});
