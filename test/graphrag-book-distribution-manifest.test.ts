import { describe, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { buildBookDistributionManifest } from "../scripts/graphrag/book-distribution-manifest.mjs";
import { mkProjectTmpDir } from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG book distribution manifest", () => {
  test("copies normalized markdown into the book closure and excludes sensitive roots",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-book-distribution-manifest-");
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-abc12345-12345678";
      const normalizedPath = join(stateRoot, "input", "book.md");
      await mkdir(join(stateRoot, "input"), { recursive: true });
      await mkdir(join(stateRoot, "sources", bookId), { recursive: true });
      await mkdir(join(stateRoot, "books", bookId, "output"), { recursive: true });
      await writeFile(normalizedPath, "# Book\n", "utf8");
      await writeFile(join(stateRoot, "sources", bookId, "source.epub"), "epub", "utf8");
      await writeFile(join(stateRoot, "books", bookId, "job.yaml"), "items: []\n", "utf8");
      await writeFile(
        join(stateRoot, "books", bookId, "output", "qmd_output_manifest.json"),
        "{}\n",
        "utf8",
      );

      const manifest = buildBookDistributionManifest({
        stateRoot,
        bookId,
        itemId: "item-1",
        runId: "run-1",
        sourceHash: "abc123",
        sourceRelativePath: "inbox/Book.epub",
        normalizedPath,
        producer: {
          producerRunId: "run-query-ready",
          stageProducerRunIds: { embed: "run-embed" },
        },
        now: () => "2026-06-01T00:00:00.000Z",
      });

      await rm(tmpRoot, { recursive: true, force: true });

      expect(manifest).toMatchObject({
        schemaVersion: "1.0.0",
        kind: "book_distribution_manifest",
        bookId,
        portability: {
          canonicalNormalizedPath: `books/${bookId}/input/book.md`,
          legacyNormalizedPath: "input/book.md",
        },
        producerEvidence: {
          outputProducerRunId: "run-query-ready",
          missingRunRecordIds: ["run-embed", "run-query-ready"],
        },
      });
      expect(manifest.files.map((file) => file.path)).toContain(
        `books/${bookId}/input/book.md`,
      );
      expect(manifest.exclusions).toContain("graph_vault/catalog/provider-requests/**");
      expect(manifest.exclusions).toContain(".env");
    });
});
