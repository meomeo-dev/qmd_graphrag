import { describe, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, relative } from "path";
import {
  batchBookId,
  durablePrimaryJsonEntries,
  mkProjectTmpDir,
  projectRoot,
  runBatchWorkflow,
  writeMinimalEpubFixture,
  writeProviderAuthReopenGraphFixture,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG EPUB batch runner - resume terminal status", () => {
  test("completed resume output with no next stage enters validation", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-resume-terminal-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "resume-terminal-completed-fixture";

    try {
      await mkdir(sourceDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "index.yml"), "collections: {}\n");

      const sourcePath = join(sourceDir, "Terminal.epub");
      await writeMinimalEpubFixture(sourcePath, "Terminal");
      const sourceHash = createHash("sha256")
        .update(readFileSync(sourcePath))
        .digest("hex");
      const bookId = batchBookId(sourceHash, relative(projectRoot, sourcePath));
      await writeProviderAuthReopenGraphFixture({ stateRoot, bookId, sourceHash });

      const resumeEventsPath = join(tmpRoot, "resume-events.jsonl");
      const resumeScript = join(tmpRoot, "fake-resume-terminal.mjs");
      await writeFile(
        resumeScript,
        [
          "import { appendFileSync } from 'node:fs';",
          "const args = process.argv.slice(2);",
          "const value = (name) => {",
          "  const index = args.indexOf(name);",
          "  return index >= 0 ? args[index + 1] : '';",
          "};",
          "appendFileSync(process.env.RESUME_EVENTS_PATH, JSON.stringify({",
          "  command: process.argv[1], sourcePath: value('--source-path')",
          "}) + '\\n');",
          "console.log(JSON.stringify({",
          "  status: 'completed',",
          "  bookId: process.env.TEST_BOOK_ID,",
          "  startedStage: 'graph_extract',",
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
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { dirname } from 'node:path';",
          "const args = process.argv.slice(2);",
          "if (process.env.INDEX_PATH) {",
          "  mkdirSync(dirname(process.env.INDEX_PATH), { recursive: true });",
          "  writeFileSync(process.env.INDEX_PATH, 'fake qmd index\\n');",
          "}",
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
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          QMD_GRAPHRAG_TEST_QMD_RUNNER: "1",
          QMD_GRAPHRAG_QMD_RUNNER: qmdScript,
          QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES:
            "qmd-version,qmd-query-auto-json,qmd-query-graphrag-json",
          RESUME_EVENTS_PATH: resumeEventsPath,
          TEST_BOOK_ID: bookId,
        },
        timeoutMs: 90_000,
      });

      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      const checkpointFile = durablePrimaryJsonEntries(join(runRoot, "items"))[0];
      const checkpoint = JSON.parse(readFileSync(
        join(runRoot, "items", checkpointFile),
        "utf8",
      ));
      const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const resumeEvents = readFileSync(resumeEventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(resumeEvents).toHaveLength(1);
      expect(events.filter((event) =>
        event.event === "resume_pass_completed"
      )).toHaveLength(1);
      expect(events.find((event) =>
        event.event === "resume_pass_completed"
      )).toMatchObject({
        status: "completed",
        metadata: { resumeStatus: "completed", nextStage: null },
      });
      expect(existsSync(join(logRoot, `${checkpoint.itemId}-resume-book-2.out`)))
        .toBe(false);
      expect(checkpoint.status).toBe("completed");
      expect(checkpoint.commandChecks.map((check: { name: string }) => check.name))
        .toEqual([
          "qmd-version",
          "qmd-query-auto-json",
          "qmd-query-graphrag-json",
        ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 120000);
});
