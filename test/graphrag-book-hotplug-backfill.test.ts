import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  mkProjectTmpDir,
  nodeScriptBin,
  writeDurableJsonFixture,
  writeProviderAuthReopenGraphFixture,
} from "./helpers/graphrag-runner-harness.js";

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function runBackfill(input: {
  stateRoot: string;
  args?: string[];
  env?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveResult) => {
    const proc = spawn(nodeScriptBin(), [
      "scripts/graphrag/backfill-hotplug-packages.mjs",
      "--state-root",
      input.stateRoot,
      ...(input.args ?? []),
    ], {
      env: { ...process.env, ...(input.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
    proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
    proc.on("close", (exitCode) => {
      resolveResult({ stdout, stderr, exitCode });
    });
    proc.on("error", (error) => {
      resolveResult({ stdout, stderr: String(error), exitCode: null });
    });
  });
}

function parseBackfillSummary(stdout: string): Record<string, unknown> {
  const marker = "\n{\n  \"stateRoot\"";
  const index = stdout.lastIndexOf(marker);
  const jsonText = index >= 0
    ? stdout.slice(index + 1)
    : stdout.slice(stdout.indexOf("{"));
  return JSON.parse(jsonText) as Record<string, unknown>;
}

async function writeLegacyBackfillFixture(input: {
  stateRoot: string;
  bookId: string;
}): Promise<void> {
  const sourceText = "epub";
  const inputText = "# Book\n\nBackfill idempotency.\n";
  const sourceHash = sha256Text(sourceText);
  const normalizedHash = sha256Text(inputText);
  const sourceRelativePath = `books/${input.bookId}/source/source.epub`;
  const bookRoot = join(input.stateRoot, "books", input.bookId);

  await writeProviderAuthReopenGraphFixture({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    contentHash: normalizedHash,
  });
  await mkdir(join(bookRoot, "input"), { recursive: true });
  await mkdir(join(bookRoot, "qmd"), { recursive: true });
  await mkdir(join(input.stateRoot, "books", input.bookId, "source"), { recursive: true });
  await writeFile(join(bookRoot, "input", "book.md"), inputText, "utf8");
  await writeFile(
    join(input.stateRoot, "books", input.bookId, "source", "source.epub"),
    sourceText,
    "utf8",
  );
  await writeDurableJsonFixture(join(bookRoot, "qmd", "qmd_build_manifest.json"), {
    schemaVersion: "1.0.0",
    kind: "qmd_build_manifest",
    bookId: input.bookId,
    sourceHash,
    sourceRelativePath,
    canonicalBookNormalizedPath: `books/${input.bookId}/input/book.md`,
    normalizedContentHash: normalizedHash,
    configHash: "config-hash",
    normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
  });
  await writeDurableJsonFixture(
    join(
      bookRoot,
      "graphrag",
      "output",
      "qmd_graph_text_unit_identity.json",
    ),
    {
      schemaVersion: "1.0.0",
      bookId: input.bookId,
      sourceId: `sha256:${sourceHash}`,
      sourceHash,
      documentId: `doc-${sourceHash.slice(0, 12)}`,
      contentHash: normalizedHash,
      normalizedPath: `books/${input.bookId}/input/book.md`,
      graphDocumentId: `graph-doc-${input.bookId}`,
      graphTextUnitIds: [`tu-${input.bookId}`],
    },
  );
  await writeDurableJsonFixture(join(bookRoot, "distribution_manifest.json"), {
    schemaVersion: "1.0.0",
    kind: "book_distribution_manifest",
    bookId: input.bookId,
    sourceHash,
    sourceRelativePath,
    portability: {
      closureRoot: `books/${input.bookId}`,
      sourceRoot: `books/${input.bookId}/source`,
      canonicalNormalizedPath: `books/${input.bookId}/input/book.md`,
      qmdBuildManifestPath: `books/${input.bookId}/qmd/qmd_build_manifest.json`,
      graphOutputManifestPath:
        `books/${input.bookId}/graphrag/output/qmd_output_manifest.json`,
    },
    producerEvidence: {
      outputProducerRunId: "run-query-ready",
      stageProducerRunIds: {
        graph_extract: "run-graph-extract",
        community_report: "run-community-report",
        embed: "run-embed",
      },
      presentRunRecordCount: 4,
      missingRunRecordIds: [],
    },
    files: [],
  });
}

describe("GraphRAG hotplug backfill", () => {
  test("fails closed instead of publishing duplicate source-hash candidates",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-backfill-conflict-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const firstBookId = "book-duplicate-source-a";
        const secondBookId = "book-duplicate-source-b";
        await writeLegacyBackfillFixture({ stateRoot, bookId: firstBookId });
        await writeLegacyBackfillFixture({ stateRoot, bookId: secondBookId });

        const result = await runBackfill({
          stateRoot,
          args: ["--force"],
        });

        expect(result.exitCode).toBe(1);
        const summary = parseBackfillSummary(result.stdout);
        expect(result.stderr).toContain("\"status\":\"blocked_by_conflict\"");
        expect(summary.conflictCount).toBeGreaterThan(0);
        expect(summary.failed).toBe(2);
        expect(summary.skippedItems).toEqual(expect.arrayContaining([
          expect.objectContaining({
            bookId: firstBookId,
            reason: "blocked_by_conflict",
          }),
          expect.objectContaining({
            bookId: secondBookId,
            reason: "blocked_by_conflict",
          }),
        ]));
        expect(existsSync(
          join(stateRoot, "books", firstBookId, "BOOK_MANIFEST.json"),
        )).toBe(false);
        expect(existsSync(
          join(stateRoot, "books", secondBookId, "BOOK_MANIFEST.json"),
        )).toBe(false);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("force rerun verifies existing valid package without rewriting manifest",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-backfill-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-backfill-force";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeLegacyBackfillFixture({ stateRoot, bookId });

        const first = await runBackfill({
          stateRoot,
          args: ["--force", "--fail-fast"],
        });
        expect(first, first.stderr || first.stdout).toMatchObject({
          exitCode: 0,
        });
        expect(existsSync(join(bookRoot, "BOOK_MANIFEST.json"))).toBe(true);
        const manifestBefore = await readFile(
          join(bookRoot, "BOOK_MANIFEST.json"),
          "utf8",
        );
        const publishReadyBefore = await readFile(
          join(bookRoot, "PUBLISH_READY.json"),
          "utf8",
        );
        const runtimeCompatibilityBefore = await readFile(
          join(bookRoot, "graphrag", "output", "runtime-compatibility.json"),
          "utf8",
        );

        const second = await runBackfill({
          stateRoot,
          args: ["--force", "--fail-fast"],
        });
        expect(second, second.stderr || second.stdout).toMatchObject({
          exitCode: 0,
        });
        expect(second.stdout).toContain("\"status\":\"verified_existing\"");
        expect(await readFile(join(bookRoot, "BOOK_MANIFEST.json"), "utf8"))
          .toBe(manifestBefore);
        expect(await readFile(join(bookRoot, "PUBLISH_READY.json"), "utf8"))
          .toBe(publishReadyBefore);
        expect(await readFile(
          join(bookRoot, "graphrag", "output", "runtime-compatibility.json"),
          "utf8",
        )).toBe(runtimeCompatibilityBefore);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("only-missing verifies existing package before skipping", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-backfill-skip-gate-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-backfill-skip-gate";
      const bookRoot = join(stateRoot, "books", bookId);
      await writeLegacyBackfillFixture({ stateRoot, bookId });

      const first = await runBackfill({
        stateRoot,
        args: ["--force", "--fail-fast"],
      });
      expect(first, first.stderr || first.stdout).toMatchObject({
        exitCode: 0,
      });
      const manifestBefore = await readFile(
        join(bookRoot, "BOOK_MANIFEST.json"),
        "utf8",
      );

      const second = await runBackfill({
        stateRoot,
        args: ["--fail-fast"],
      });
      expect(second, second.stderr || second.stdout).toMatchObject({
        exitCode: 0,
      });
      const summary = parseBackfillSummary(second.stdout);
      expect(summary.skippedItems).toEqual(expect.arrayContaining([
        expect.objectContaining({
          bookId,
          reason: "already_migrated",
          copyDistributionAllowed: true,
        }),
      ]));
      expect(summary.packageResults).toEqual(expect.arrayContaining([
        expect.objectContaining({
          bookId,
          status: "valid",
          diagnostics: [],
        }),
      ]));
      const qualityGate = JSON.parse(await readFile(
        join(bookRoot, "state", "hotplug-quality-gate.json"),
        "utf8",
      ));
      expect(qualityGate).toMatchObject({
        bookId,
        status: "passed",
        copyDistributionAllowed: true,
        backfillHotplugPackageCompatibility: "passed",
      });
      expect(await readFile(join(bookRoot, "BOOK_MANIFEST.json"), "utf8"))
        .toBe(manifestBefore);

      await writeFile(
        join(bookRoot, "BOOK_MANIFEST.json.sha256"),
        "stale-sidecar\n",
        "utf8",
      );
      const third = await runBackfill({
        stateRoot,
        args: ["--fail-fast"],
      });
      expect(third.exitCode).toBe(1);
      expect(third.stderr).toContain("manifest_sha256_mismatch");
      const failedGate = JSON.parse(await readFile(
        join(bookRoot, "state", "hotplug-quality-gate.json"),
        "utf8",
      ));
      expect(failedGate).toMatchObject({
        bookId,
        status: "failed",
        copyDistributionAllowed: false,
        backfillHotplugPackageCompatibility: "failed_package_validation",
      });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("resume-interrupted removes uncommitted staging and completes backfill",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-resume-exec-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-resume-interrupted";
        const bookRoot = join(stateRoot, "books", bookId);
        const stagingRoot = join(
          stateRoot,
          "catalog",
          ".staging",
          "book-hotplug-migrations",
          bookId,
        );
        await writeLegacyBackfillFixture({ stateRoot, bookId });
        await mkdir(stagingRoot, { recursive: true });
        await writeFile(join(stagingRoot, "uncommitted.tmp"), "staged", "utf8");

        const result = await runBackfill({
          stateRoot,
          args: ["--resume-interrupted", "--force", "--fail-fast"],
        });

        expect(result, result.stderr || result.stdout).toMatchObject({
          exitCode: 0,
        });
        const summary = parseBackfillSummary(result.stdout);
        expect(summary.interruptedRecovery).toMatchObject({
          status: "executed",
          executedCount: 1,
          blockedCount: 0,
        });
        expect(summary.processedItems).toEqual(expect.arrayContaining([
          expect.objectContaining({ bookId, action: "backfilled" }),
        ]));
        expect(existsSync(stagingRoot)).toBe(false);
        expect(existsSync(join(bookRoot, "BOOK_MANIFEST.json"))).toBe(true);
        expect(existsSync(join(bookRoot, "PUBLISH_READY.json"))).toBe(true);
        expect(existsSync(
          join(
            stateRoot,
            String(
              (summary.interruptedRecovery as { recordPath?: unknown })
                .recordPath,
            ),
          ),
        )).toBe(true);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("rollback-interrupted removes invalid live manifest before backfill",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-rollback-exec-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-rollback-interrupted";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeLegacyBackfillFixture({ stateRoot, bookId });
        await writeDurableJsonFixture(join(bookRoot, "BOOK_MANIFEST.json"), {
          schemaVersion: "1.0.0",
          kind: "qmd_graphrag_book_package",
          identity: {
            bookId,
            sourceHash: sha256Text("epub"),
          },
          source: { sourceHash: sha256Text("epub") },
        });

        const result = await runBackfill({
          stateRoot,
          args: ["--rollback-interrupted", "--force", "--fail-fast"],
        });

        expect(result, result.stderr || result.stdout).toMatchObject({
          exitCode: 0,
        });
        const summary = parseBackfillSummary(result.stdout);
        expect(summary.interruptedRecovery).toMatchObject({
          status: "executed",
          executedCount: 1,
          blockedCount: 0,
        });
        expect(summary.interruptedRecovery.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              bookId,
              action: "rollback_interrupted",
              removedInvalidManifest: true,
            }),
          ]),
        );
        expect(summary.processedItems).toEqual(expect.arrayContaining([
          expect.objectContaining({ bookId, action: "backfilled" }),
        ]));
        expect(existsSync(join(bookRoot, "BOOK_MANIFEST.json"))).toBe(true);
        expect(existsSync(join(bookRoot, "PUBLISH_READY.json"))).toBe(true);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("resume-interrupted blocks cleanup when staging has protected metadata",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-resume-blocked-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-resume-protected";
        const stagingState = join(
          stateRoot,
          "catalog",
          ".staging",
          "book-hotplug-migrations",
          bookId,
          "state",
        );
        await writeLegacyBackfillFixture({ stateRoot, bookId });
        await mkdir(stagingState, { recursive: true });
        await writeFile(
          join(stagingState, "user-overrides.yaml"),
          "preserve: true\n",
          "utf8",
        );

        const result = await runBackfill({
          stateRoot,
          args: ["--resume-interrupted", "--force", "--fail-fast"],
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("interrupted_recovery_blocked");
        const summary = parseBackfillSummary(result.stdout);
        expect(summary.failed).toBe(1);
        expect(summary.failures).toEqual(expect.arrayContaining([
          expect.objectContaining({
            bookId,
            error: "protected_user_metadata_in_staging",
          }),
        ]));
        expect(existsSync(join(stagingState, "user-overrides.yaml"))).toBe(true);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("fsync failure blocks publish marker visibility", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-backfill-fsync-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-backfill-fsync";
      const bookRoot = join(stateRoot, "books", bookId);
      await writeLegacyBackfillFixture({ stateRoot, bookId });

      const result = await runBackfill({
        stateRoot,
        args: ["--force", "--fail-fast"],
        env: {
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
          QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_PATTERN:
            `books/${bookId}/PUBLISH_READY.json`,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "hotplug durable directory fsync failed",
      );
      expect(existsSync(join(bookRoot, "PUBLISH_READY.json"))).toBe(false);
      expect(existsSync(join(bookRoot, "PUBLISH_READY.json.sha256")))
        .toBe(false);
      expect(existsSync(join(bookRoot, "PUBLISH_READY.json.sha256.meta.json")))
        .toBe(false);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("fails closed when same bookId points to a different source hash",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-backfill-book-id-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-backfill-source-hash-conflict";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeLegacyBackfillFixture({ stateRoot, bookId });

        const first = await runBackfill({
          stateRoot,
          args: ["--force", "--fail-fast"],
        });
        expect(first, first.stderr || first.stdout).toMatchObject({
          exitCode: 0,
        });
        const manifestBefore = await readFile(
          join(bookRoot, "BOOK_MANIFEST.json"),
          "utf8",
        );
        const publishReadyBefore = await readFile(
          join(bookRoot, "PUBLISH_READY.json"),
          "utf8",
        );

        await writeDurableJsonFixture(join(bookRoot, "distribution_manifest.json"), {
          schemaVersion: "1.0.0",
          kind: "book_distribution_manifest",
          bookId,
          sourceHash: sha256Text("different epub"),
          sourceRelativePath: `books/${bookId}/source/source.epub`,
          portability: {
            closureRoot: `books/${bookId}`,
            sourceRoot: `books/${bookId}/source`,
            canonicalNormalizedPath: `books/${bookId}/input/book.md`,
            qmdBuildManifestPath: `books/${bookId}/qmd/qmd_build_manifest.json`,
            graphOutputManifestPath:
              `books/${bookId}/graphrag/output/qmd_output_manifest.json`,
          },
          producerEvidence: {
            outputProducerRunId: "run-query-ready",
            stageProducerRunIds: {
              graph_extract: "run-graph-extract",
              community_report: "run-community-report",
              embed: "run-embed",
            },
            presentRunRecordCount: 4,
            missingRunRecordIds: [],
          },
          files: [],
        });

        const second = await runBackfill({
          stateRoot,
          args: ["--force", "--fail-fast"],
        });
        expect(second.exitCode).toBe(1);
        const summary = parseBackfillSummary(second.stdout);
        expect(second.stderr).toContain(
          "migration_book_id_source_hash_conflict",
        );
        expect(summary.failed).toBe(1);
        expect(summary.skippedItems).toEqual(expect.arrayContaining([
          expect.objectContaining({
            bookId,
            reason: "blocked_by_conflict",
            conflictCodes: expect.arrayContaining([
              "migration_book_id_source_hash_conflict",
            ]),
          }),
        ]));
        expect(await readFile(join(bookRoot, "BOOK_MANIFEST.json"), "utf8"))
          .toBe(manifestBefore);
        expect(await readFile(join(bookRoot, "PUBLISH_READY.json"), "utf8"))
          .toBe(publishReadyBefore);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });
});
