import { mkdir, rm, writeFile } from "fs/promises";
import { join, relative } from "path";
import { describe, expect, test } from "vitest";
import {
  durableChecksumReopenDecision,
} from "../scripts/graphrag/durable-checksum-reopen-policy.mjs";
import {
  mkProjectTmpDir,
  stableTextHash,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG EPUB batch runner - durable checksum reopen policy", () => {
  test("reopens only after fixed checksum sidecars prove the current target", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-durable-checksum-reopen-");
    try {
      const targetPath = join(
        tmpRoot,
        "graph_vault",
        "books",
        "book-a",
        "output",
        "stats.json",
      );
      await mkdir(join(targetPath, ".."), { recursive: true });
      const oldText = "{\"stage\":\"graph_extract\"}\n";
      const fixedText = "{\"stage\":\"community_report\"}\n";
      const oldChecksum = stableTextHash(oldText);
      const fixedChecksum = stableTextHash(fixedText);
      await writeFile(targetPath, fixedText, "utf8");
      await writeFile(`${targetPath}.sha256`, `${oldChecksum}\n`, "utf8");
      await writeFile(`${targetPath}.sha256.meta.json`, JSON.stringify({
        checksum: oldChecksum,
        checksumRecoveryDecision: "committed",
      }, null, 2) + "\n", "utf8");
      const checkpoint = {
        status: "failed",
        failureKind: "local_state_integrity",
        retryable: false,
        recoveryDecision: "stop_until_fixed",
        localFailureClass: "durable_checksum_mismatch",
        targetLocator: relative(tmpRoot, targetPath),
        checksumExpected: oldChecksum,
        checksumActual: fixedChecksum,
      };

      expect(durableChecksumReopenDecision({
        checkpoint,
        projectRoot: tmpRoot,
      })).toMatchObject({
        candidate: true,
        reopen: false,
        decision: "blocked_checksum_still_mismatched",
      });

      await writeFile(`${targetPath}.sha256`, `${fixedChecksum}\n`, "utf8");
      await writeFile(`${targetPath}.sha256.meta.json`, JSON.stringify({
        checksum: fixedChecksum,
        checksumRecoveryDecision: "artifact_evidence_checksum_refreshed",
      }, null, 2) + "\n", "utf8");

      expect(durableChecksumReopenDecision({
        checkpoint,
        projectRoot: `${tmpRoot}/`,
      })).toMatchObject({
        candidate: true,
        reopen: true,
        decision: "reopen_fixed_durable_checksum",
        checksum: fixedChecksum,
        checksumRecoveryDecision: "artifact_evidence_checksum_refreshed",
      });

      expect(durableChecksumReopenDecision({
        checkpoint: { ...checkpoint, checksumActual: oldChecksum },
        projectRoot: tmpRoot,
      })).toMatchObject({
        candidate: true,
        reopen: false,
        decision: "blocked_fixed_checksum_not_original_failure_actual",
      });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
