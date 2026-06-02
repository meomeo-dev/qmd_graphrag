import { mkdir, rm, writeFile } from "fs/promises";
import { join, relative } from "path";
import { describe, expect, test } from "vitest";
import {
  durablePreflightDeferReopenDecision,
} from "../scripts/graphrag/durable-preflight-defer-policy.mjs";
import { mkProjectTmpDir } from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG runner durable preflight defer policy", () => {
  test("reopens before-resume live lock failures only after the lock clears", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-durable-preflight-defer-");
    try {
      const targetPath = join(
        tmpRoot,
        "graph_vault",
        "catalog",
        "document-identity-map.yaml",
      );
      await mkdir(join(targetPath, ".."), { recursive: true });
      await writeFile(targetPath, "schemaVersion: 1.0.0\nmappings: []\n", "utf8");
      const lockPath = `${targetPath}.lock`;
      const checkpoint = {
        status: "failed",
        failureKind: "local_state_integrity",
        retryable: false,
        recoveryDecision: "stop_until_fixed",
        localFailureClass: "durable_preflight_live_lock",
        failedStage: "before_resume_book",
        targetLocator: relative(tmpRoot, targetPath),
        lockOwnerEvidence: {
          runnerSessionId: "runner-a",
          operationId: "operation-a",
        },
      };

      await writeFile(lockPath, "{}\n", "utf8");
      expect(durablePreflightDeferReopenDecision({
        checkpoint,
        projectRoot: tmpRoot,
      })).toMatchObject({
        candidate: true,
        reopen: false,
        decision: "blocked_lock_still_present",
      });

      await rm(lockPath, { force: true });
      expect(durablePreflightDeferReopenDecision({
        checkpoint,
        projectRoot: `${tmpRoot}/`,
      })).toMatchObject({
        candidate: true,
        reopen: true,
        decision: "reopen_deferred_durable_preflight_live_lock",
        operationId: "operation-a",
        runnerSessionId: "runner-a",
      });

      expect(durablePreflightDeferReopenDecision({
        checkpoint: { ...checkpoint, failedStage: "runner_start" },
        projectRoot: tmpRoot,
      })).toMatchObject({ candidate: false, reopen: false });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
