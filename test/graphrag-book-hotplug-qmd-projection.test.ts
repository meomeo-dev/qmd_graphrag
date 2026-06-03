import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import YAML from "yaml";
import { describe, expect, test } from "vitest";

import {
  buildBookHotplugPackage,
} from "../scripts/graphrag/book-hotplug-package.mjs";
import {
  rebuildCatalogFromBookHotplugPackages,
} from "../src/graphrag/book-hotplug-catalog.js";
import {
  mkProjectTmpDir,
  writeDurableJsonFixture,
  writeProviderAuthReopenGraphFixture,
} from "./helpers/graphrag-runner-harness.js";

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function writeHotplugProjectionFixture(input: {
  stateRoot: string;
  bookId: string;
}): Promise<void> {
  const sourceText = "epub";
  const inputText = "# Book\n\nQMD projection cleanup.\n";
  const sourceHash = sha256Text(sourceText);
  const normalizedHash = sha256Text(inputText);
  const bookRoot = join(input.stateRoot, "books", input.bookId);

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
    sourceRelativePath: `sources/${input.bookId}/source.epub`,
    sourceHash,
    canonicalBookNormalizedPath: `books/${input.bookId}/input/book.md`,
    normalizedContentHash: normalizedHash,
    configHash: "config-hash",
    normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
  });
  await writeDurableJsonFixture(
    join(bookRoot, "graphrag", "output", "qmd_graph_text_unit_identity.json"),
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

  const { manifest, publishReady } = buildBookHotplugPackage({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    sourceRelativePath: `sources/${input.bookId}/source.epub`,
    now: () => "2026-06-02T00:00:00.000Z",
    toolVersion: "test",
  });
  await writeDurableJsonFixture(join(bookRoot, "BOOK_MANIFEST.json"), manifest);
  await writeDurableJsonFixture(join(bookRoot, "PUBLISH_READY.json"), publishReady);
}

describe("GraphRAG hotplug qmd projection", () => {
  test("rebuilds qmd projection and removes stale book projection roots",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-qmd-projection-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-qmd-projection";
        await writeHotplugProjectionFixture({ stateRoot, bookId });
        const staleRoot = join(
          stateRoot,
          "catalog",
          "qmd-book-projections",
          "stale-book",
        );
        await mkdir(staleRoot, { recursive: true });
        await writeFile(join(staleRoot, "qmd_projection_manifest.json"), "{}\n");

        const rebuild = await rebuildCatalogFromBookHotplugPackages(stateRoot);
        const projection = YAML.parse(
          await readFile(join(stateRoot, "catalog", "qmd-projection.yaml"), "utf8"),
        );

        expect(rebuild.bookCount).toBe(1);
        expect(projection.items).toHaveLength(1);
        expect(projection.items[0]).toMatchObject({
          bookId,
          packageRoot: `books/${bookId}`,
          projectionSource: "book_hotplug_manifest",
          qmdBuildManifestPath: "qmd/qmd_build_manifest.json",
        });
        expect(projection.removedStaleProjectionRoots).toEqual(["stale-book"]);
        expect(existsSync(staleRoot)).toBe(false);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });
});
