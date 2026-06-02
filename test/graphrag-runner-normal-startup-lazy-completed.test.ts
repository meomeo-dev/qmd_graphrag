import { describe, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, relative } from "path";
import { hostname } from "os";
import { SchemaVersion } from "../src/contracts/common.ts";
import {
  batchBookId,
  mkProjectTmpDir,
  passedBatchCommandChecks,
  projectRoot,
  runBatchWorkflow,
  stableTextHash,
  writeDurableJsonFixture,
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
      const sourceBytes = "legacy completed item without live evidence";
      const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
      const sourcePath = join(sourceDir, "Book.epub");
      const sourceRelativePath = relative(projectRoot, sourcePath);
      const itemId = `item-${sourceHash.slice(0, 12)}-${
        stableTextHash(sourceRelativePath).slice(0, 8)
      }`;
      const bookId = batchBookId(sourceHash, sourceRelativePath);

      await mkdir(sourceDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await mkdir(join(batchRoot, "items"), { recursive: true });
      await mkdir(invocationDir, { recursive: true });
      await writeFile(sourcePath, sourceBytes);
      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
      const normalizedPath = join(stateRoot, "input", "book.md");
      await mkdir(join(stateRoot, "input"), { recursive: true });
      await writeFile(normalizedPath, "# Book\n\nSoftware design complexity.\n");
      await mkdir(join(stateRoot, "books", bookId, "output"), { recursive: true });
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "output", "qmd_output_manifest.json"),
        {
          schemaVersion: SchemaVersion,
          bookId,
          sourceHash,
          documentId: `doc-${sourceHash.slice(0, 12)}`,
          contentHash: sourceHash,
          stageFingerprints: {},
          providerFingerprint: "provider-fp",
          outputDir: `books/${bookId}/output`,
          producerRunId: "run-query-ready",
          stageProducerRunIds: {
            graph_extract: "run-graph-extract",
            community_report: "run-community-report",
            embed: "run-embed",
          },
        },
      );

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

      await writeDurableJsonFixture(
        join(batchRoot, "manifest.json"),
        {
          schemaVersion: SchemaVersion,
          runId,
          status: "completed",
          sourceRootName: "source",
          stateRootLocator: ".tmp-tests/unused/graph_vault",
          qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
          configLocator: ".tmp-tests/unused/config/index.yml",
          totalItems: 1,
          pendingItems: 0,
          runningItems: 0,
          completedItems: 1,
          skippedItems: 0,
          importedCompletedItems: 0,
          failedItems: 0,
          startedAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:01:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          itemIds: [itemId],
        },
      );
      await writeDurableJsonFixture(
        join(batchRoot, "items", `${itemId}.json`),
        {
          schemaVersion: SchemaVersion,
          itemId,
          runId,
          status: "completed",
          sourceName: "Book.epub",
          sourceRelativePath,
          sourceIdentityPath: sourceRelativePath,
          sourceHash,
          normalizedPath: relative(projectRoot, normalizedPath),
          bookId,
          attempts: 1,
          completedAt: "2026-05-23T00:01:00.000Z",
          commandChecks: passedBatchCommandChecks(),
        },
      );
      const completedBookCheckpointPath = join(
        stateRoot,
        "books",
        bookId,
        "checkpoints.yaml",
      );
      const completedBookLockPath = `${completedBookCheckpointPath}.lock`;
      await mkdir(join(stateRoot, "books", bookId), { recursive: true });
      await writeFile(
        completedBookLockPath,
        `${JSON.stringify({
          runnerSessionId: "completed-book-live-lock-session",
          ownerPid: process.pid,
          ownerHost: hostname(),
          lockPath: relative(projectRoot, completedBookLockPath),
          targetLocator: relative(projectRoot, completedBookCheckpointPath),
          lane: "checkpointWriterLane",
          targetMappingOwner: "repository",
          durableKind: "json-lock",
          releaseOn: "commit_or_rollback",
          generation: 1,
          fencingTokenHash: createHash("sha256")
            .update("completed-book-live-lock-fence")
            .digest("hex"),
          operationId: "completed-book-live-lock-op",
          createdAt: "2026-05-23T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }, null, 2)}\n`,
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
      expect(checkpoint.qmdBuildStatus).toBeUndefined();
      expect(checkpoint.graphBuildStatus).toBeUndefined();
      expect(checkpoint.graphQueryStatus).toBeUndefined();
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
          legacyNormalizedPath: "input/book.md",
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
      expect(existsSync(completedBookLockPath)).toBe(true);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
