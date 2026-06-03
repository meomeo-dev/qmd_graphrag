import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildBookHotplugPackage,
} from "../scripts/graphrag/book-hotplug-package.mjs";
import {
  mkProjectTmpDir,
  writeDurableJsonFixture,
  writeProviderAuthReopenGraphFixture,
} from "./helpers/graphrag-runner-harness.js";

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function runBackfill(input: {
  stateRoot: string;
  args?: string[];
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveResult) => {
    const proc = spawn(process.execPath, [
      "scripts/graphrag/backfill-hotplug-packages.mjs",
      "--state-root",
      input.stateRoot,
      ...(input.args ?? []),
    ]);
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

async function writeRefreshExistingFixture(input: {
  stateRoot: string;
  bookId: string;
}): Promise<void> {
  const sourceText = "epub";
  const inputText = "# Book\n\nRefresh existing hotplug package.\n";
  const sourceHash = sha256Text(sourceText);
  const normalizedHash = sha256Text(inputText);
  const bookRoot = join(input.stateRoot, "books", input.bookId);
  const sourceRelativePath = `sources/${input.bookId}/source.epub`;

  await writeProviderAuthReopenGraphFixture({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    contentHash: normalizedHash,
  });
  await mkdir(join(bookRoot, "input"), { recursive: true });
  await mkdir(join(bookRoot, "qmd"), { recursive: true });
  await mkdir(join(input.stateRoot, "sources", input.bookId), {
    recursive: true,
  });
  await writeFile(join(bookRoot, "input", "book.md"), inputText, "utf8");
  await writeFile(
    join(input.stateRoot, "sources", input.bookId, "source.epub"),
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
      sourceRoot: `sources/${input.bookId}`,
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

  const { manifest, publishReady } = buildBookHotplugPackage({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    sourceRelativePath,
    forceGraphRagNotQueryReady: true,
    now: () => "2026-06-03T00:00:00.000Z",
    toolVersion: "test",
  });
  await writeDurableJsonFixture(join(bookRoot, "BOOK_MANIFEST.json"), manifest);
  await writeDurableJsonFixture(join(bookRoot, "PUBLISH_READY.json"), publishReady);
}

describe("GraphRAG hotplug refresh existing", () => {
  test("refresh-existing rewrites a valid package after lineage recovery",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-refresh-existing-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-refresh-existing";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeRefreshExistingFixture({ stateRoot, bookId });

        const initialManifest = JSON.parse(await readFile(
          join(bookRoot, "BOOK_MANIFEST.json"),
          "utf8",
        ));
        expect(initialManifest.graphrag.queryReady).toBe(false);

        const forceOnly = await runBackfill({
          stateRoot,
          args: ["--force", "--fail-fast"],
        });
        expect(forceOnly, forceOnly.stderr || forceOnly.stdout).toMatchObject({
          exitCode: 0,
        });
        expect(forceOnly.stdout).toContain("\"status\":\"verified_existing\"");
        const forceManifest = JSON.parse(await readFile(
          join(bookRoot, "BOOK_MANIFEST.json"),
          "utf8",
        ));
        expect(forceManifest.graphrag.queryReady).toBe(false);

        const refreshed = await runBackfill({
          stateRoot,
          args: [
            "--force",
            "--refresh-existing",
            "--rebuild-catalog",
            "--fail-fast",
          ],
        });
        expect(refreshed, refreshed.stderr || refreshed.stdout).toMatchObject({
          exitCode: 0,
        });
        expect(refreshed.stdout).toContain("\"status\":\"refreshed_existing\"");
        const summary = parseBackfillSummary(refreshed.stdout);
        expect(summary.catalogRebuild).toMatchObject({ capabilityCount: 1 });
        const refreshedManifest = JSON.parse(await readFile(
          join(bookRoot, "BOOK_MANIFEST.json"),
          "utf8",
        ));
        expect(refreshedManifest.graphrag.queryReady).toBe(true);
        expect(refreshedManifest.graphrag.graphRagReadyState)
          .toBe("query_ready");
        expect(existsSync(join(bookRoot, "PUBLISH_READY.json"))).toBe(true);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });
});
