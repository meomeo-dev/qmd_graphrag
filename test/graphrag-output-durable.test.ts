import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  refreshGraphRagOutputJsonSidecars,
} from "../src/job-state/graphrag-output-durable.ts";
import {
  mkProjectTmpDir,
  stableTextHash,
  writeDurableJsonFixture,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG output durable sidecars", () => {
  test("community_report refreshes stats.json checksum sidecars", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-graphrag-output-durable-");
    try {
      const outputDir = join(
        tmpRoot,
        "graph_vault",
        "books",
        "book-output-durable-fixture",
        "output",
      );
      const statsPath = join(outputDir, "stats.json");
      const oldStats = { workflows: { extract_graph: { overall: 1 } } };
      const newStats = { workflows: { create_community_reports: { overall: 2 } } };

      await writeDurableJsonFixture(statsPath, oldStats);
      await writeFile(
        statsPath,
        `${JSON.stringify(newStats, null, 2)}\n`,
        "utf8",
      );

      const result = await refreshGraphRagOutputJsonSidecars({
        outputDir,
        bookId: "book-output-durable-fixture",
        stage: "community_report",
        producerRunId: "community_report-fixture",
        reason: "stage_success",
      });

      expect(result).toMatchObject([{
        artifactKind: "graphrag_stats_json",
        stage: "graph_extract",
        refreshStage: "community_report",
        previousChecksum: stableTextHash(`${JSON.stringify(oldStats, null, 2)}\n`),
        checksum: stableTextHash(`${JSON.stringify(newStats, null, 2)}\n`),
        checksumRecoveryDecision: "graph_output_stage_success",
        mutated: true,
      }]);
      await expect(readFile(`${statsPath}.sha256`, "utf8"))
        .resolves.toBe(`${result[0].checksum}\n`);
      await expect(readFile(`${statsPath}.sha256.meta.json`, "utf8"))
        .resolves.toContain("\"checksumRecoveryDecision\": \"graph_output_stage_success\"");
      await expect(readFile(join(outputDir, ".durable-recovery.jsonl"), "utf8"))
        .resolves.toContain("\"refreshStage\":\"community_report\"");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
