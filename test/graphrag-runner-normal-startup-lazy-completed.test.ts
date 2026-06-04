import { describe, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { SchemaVersion } from "../src/contracts/common.ts";
import {
  mkProjectTmpDir,
  runBatchWorkflow,
  writeCompletedGraphBatchFixture,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG EPUB batch runner - normal startup lazy completed load", () => {
  test("normal resume skips completed checkpoints without closed-loop rescan", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-lazy-completed-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "lazy-completed-normal-resume-fixture";
    const batchRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const invocationDir = join(tmpRoot, "invocations");

    try {
      const { bookId, itemId } = await writeCompletedGraphBatchFixture({
        tmpRoot,
        sourceDir,
        stateRoot,
        configDir,
        runId,
        sourceBytes: "completed item with query-ready package evidence",
      });
      await mkdir(invocationDir, { recursive: true });

      const resumeScript = join(tmpRoot, "fail-if-resume-called.mjs");
      const qmdScript = join(tmpRoot, "fail-if-qmd-called.mjs");
      await writeFile(
        resumeScript,
        [
          "import { writeFileSync } from 'node:fs';",
          "writeFileSync(process.env.RESUME_CALLED_PATH, 'called\\n');",
          "process.exit(7);",
        ].join("\n"),
      );
      await writeFile(
        qmdScript,
        [
          "import { writeFileSync } from 'node:fs';",
          "writeFileSync(process.env.QMD_CALLED_PATH, 'called\\n');",
          "process.exit(7);",
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
          QMD_GRAPHRAG_TEST_QMD_RUNNER: "1",
          QMD_GRAPHRAG_QMD_RUNNER: qmdScript,
          RESUME_CALLED_PATH: join(invocationDir, "resume-called.txt"),
          QMD_CALLED_PATH: join(invocationDir, "qmd-called.txt"),
        },
      });

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);

      const manifest = JSON.parse(
        readFileSync(join(batchRoot, "manifest.json"), "utf8"),
      );
      const checkpoint = JSON.parse(
        readFileSync(join(batchRoot, "items", `${itemId}.json`), "utf8"),
      );
      const distributionManifest = JSON.parse(readFileSync(
        join(stateRoot, "books", bookId, "distribution_manifest.json"),
        "utf8",
      ));
      const events = readFileSync(join(batchRoot, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      expect(manifest).toMatchObject({
        status: "completed",
        completedItems: 1,
        pendingItems: 0,
        failedItems: 0,
      });
      expect(checkpoint).toMatchObject({
        status: "completed",
      });
      expect(checkpoint.qmdBuildStatus).toMatchObject({ status: "succeeded" });
      expect(checkpoint.graphBuildStatus).toMatchObject({ status: "succeeded" });
      expect(checkpoint.graphQueryStatus).toMatchObject({ status: "succeeded" });
      expect(events.some((event) => event.event === "item_skip_completed"))
        .toBe(true);
      expect(events.some((event) => event.event === "batch_completed"))
        .toBe(true);
      expect(events.some((event) => event.event === "item_completed_reopened"))
        .toBe(false);
      expect(events.some((event) => event.event === "item_worker_start"))
        .toBe(false);
      expect(events.some((event) => event.event === "durable_preflight_blocked"))
        .toBe(false);
      expect(distributionManifest).toMatchObject({
        schemaVersion: SchemaVersion,
        kind: "book_distribution_manifest",
        bookId,
        itemId,
        portability: {
          canonicalNormalizedPath: `books/${bookId}/input/book.md`,
        },
        exclusions: expect.arrayContaining([
          ".env",
          "graph_vault/catalog/provider-requests/**",
        ]),
      });
      expect(distributionManifest.files.map((file) => file.path)).toContain(
        `books/${bookId}/input/book.md`,
      );
      expect(existsSync(join(invocationDir, "resume-called.txt"))).toBe(false);
      expect(existsSync(join(invocationDir, "qmd-called.txt"))).toBe(false);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
