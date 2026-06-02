import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import YAML from "yaml";
import { describe, expect, test } from "vitest";

import {
  FileBookJobStateRepository,
  SchemaVersion,
  buildBookId,
  hashFile,
} from "../src/index.js";
import { writeDurableYamlFixture } from "./helpers/graphrag-runner-harness.js";

describe("GraphRAG runner resume run record scope", () => {
  test("normal resume does not read unrelated historical run records", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-graphrag-run-record-scope-"));
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      await repo.completeStage({
        bookId: job.bookId,
        stage: "ingest",
        runId: "run-ingest-current",
        inputFingerprint: job.stageFingerprints!.ingest!,
      });

      const historicalRunId = "run-graph-extract-historical";
      await writeDurableYamlFixture(join(graphVault, "catalog", "runs.yaml"), {
        schemaVersion: SchemaVersion,
        items: [
          {
            schemaVersion: SchemaVersion,
            bookId: job.bookId,
            runId: historicalRunId,
            stage: "graph_extract",
            status: "succeeded",
            startedAt: "2026-05-29T00:00:00.000Z",
            finishedAt: "2026-05-29T00:01:00.000Z",
          },
          {
            schemaVersion: SchemaVersion,
            bookId: job.bookId,
            runId: "run-ingest-current",
            stage: "ingest",
            status: "succeeded",
            startedAt: "2026-05-30T00:00:00.000Z",
            finishedAt: "2026-05-30T00:01:00.000Z",
          },
        ],
      });

      const historicalRunPath = join(
        graphVault,
        "books",
        job.bookId,
        "runs",
        `${historicalRunId}.yaml`,
      );
      await mkdir(join(graphVault, "books", job.bookId, "runs"), {
        recursive: true,
      });
      await writeFile(historicalRunPath, "not: [valid", "utf8");

      const plan = await repo.getResumePlan(job.bookId, job.stageFingerprints!);

      expect(plan.completedStages).toEqual(["ingest"]);
      expect(plan.nextStage).toBe("normalize");
      const runDirEntries = await readdir(join(graphVault, "books", job.bookId, "runs"));
      expect(runDirEntries.some((entry) =>
        entry.startsWith(`${basename(historicalRunPath)}.corrupt-`)
      )).toBe(false);
      const runFiles = await readFile(historicalRunPath, "utf8");
      expect(runFiles).toBe("not: [valid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("legacy migration only reads checkpoint-referenced run records", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-graphrag-legacy-run-scope-"));
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "legacy-book.epub");
      const artifactPath = join(graphVault, "input", "legacy.md");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await writeFile(artifactPath, "# Legacy", "utf8");

      const stableJob = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const legacyBookId = buildBookId(sourcePath);
      await mkdir(join(graphVault, "books", legacyBookId, "runs"), {
        recursive: true,
      });
      await writeFile(
        join(graphVault, "books", legacyBookId, "job.yaml"),
        YAML.stringify({
          ...stableJob,
          bookId: legacyBookId,
          sourcePath: `sources/${legacyBookId}/source.epub`,
        }),
        "utf8",
      );
      await writeFile(
        join(graphVault, "books", legacyBookId, "artifacts.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          items: [
            {
              schemaVersion: SchemaVersion,
              artifactId: "legacy-artifact",
              bookId: legacyBookId,
              stage: "normalize",
              kind: "normalized_markdown",
              path: "input/legacy.md",
              contentHash: await hashFile(artifactPath),
              producerRunId: "run-legacy-current",
              createdAt: "2026-05-29T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );
      await writeFile(
        join(graphVault, "books", legacyBookId, "checkpoints.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          items: [
            {
              schemaVersion: SchemaVersion,
              bookId: legacyBookId,
              stage: "normalize",
              status: "succeeded",
              attemptCount: 1,
              runId: "run-legacy-current",
              startedAt: "2026-05-29T00:00:00.000Z",
              finishedAt: "2026-05-29T00:01:00.000Z",
              inputFingerprint: "fp-legacy",
              artifactIds: ["legacy-artifact"],
            },
          ],
        }),
        "utf8",
      );
      await writeFile(
        join(graphVault, "books", legacyBookId, "runs", "run-legacy-current.yaml"),
        YAML.stringify({
          schemaVersion: SchemaVersion,
          runId: "run-legacy-current",
          bookId: legacyBookId,
          stage: "normalize",
          status: "succeeded",
          attemptCount: 1,
          startedAt: "2026-05-29T00:00:00.000Z",
          finishedAt: "2026-05-29T00:01:00.000Z",
          inputFingerprint: "fp-legacy",
          artifactIds: ["legacy-artifact"],
        }),
        "utf8",
      );
      const unrelatedRunPath = join(
        graphVault,
        "books",
        legacyBookId,
        "runs",
        "run-unrelated-damaged.yaml",
      );
      await writeFile(unrelatedRunPath, "not: [valid", "utf8");

      await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-2",
        promptFingerprint: "prompt-2",
        modelFingerprint: "model-2",
      });

      const migratedRun = YAML.parse(await readFile(
        join(graphVault, "books", stableJob.bookId, "runs", "run-legacy-current.yaml"),
        "utf8",
      )) as { bookId: string; artifactIds: string[] };
      expect(migratedRun.bookId).toBe(stableJob.bookId);
      expect(migratedRun.artifactIds[0]).not.toBe("legacy-artifact");

      const legacyRunDir = join(graphVault, "archive", "legacy-books");
      const archives = await readdir(legacyRunDir);
      expect(archives.length).toBe(1);
      const archivedDamagedRun = join(
        legacyRunDir,
        archives[0]!,
        "runs",
        "run-unrelated-damaged.yaml",
      );
      expect(await readFile(archivedDamagedRun, "utf8")).toBe("not: [valid");
      const archivedRunFiles = await readdir(join(legacyRunDir, archives[0]!, "runs"));
      expect(archivedRunFiles.some((entry) =>
        entry.startsWith("run-unrelated-damaged.yaml.corrupt-")
      )).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
