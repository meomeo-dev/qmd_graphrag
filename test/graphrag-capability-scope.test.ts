import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import YAML from "yaml";

import {
  FileBookJobStateRepository,
  SchemaVersion,
  loadGraphQueryCapabilities,
} from "../src/index.js";
import {
  buildBookHotplugPackage,
} from "../scripts/graphrag/book-hotplug-package.mjs";
import {
  writeBookScopedQmdIndexFixture,
  writeDurableJsonFixture,
  writeDurableYamlFixture,
  writeProviderAuthReopenGraphFixture,
} from "./helpers/graphrag-runner-harness.js";

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function createGraphReadyBook(input: {
  graphVault: string;
  bookId: string;
  sourceHash: string;
}) {
  await writeProviderAuthReopenGraphFixture({
    stateRoot: input.graphVault,
    bookId: input.bookId,
    sourceHash: input.sourceHash,
  });
  const identityPath = join(input.graphVault, "catalog", "document-identity-map.yaml");
  const existing = await readFile(identityPath, "utf8")
    .then((text) => YAML.parse(text))
    .catch(() => ({ schemaVersion: SchemaVersion, items: [] }));
  await writeDurableYamlFixture(identityPath, {
    schemaVersion: SchemaVersion,
    items: [
      ...((existing.items ?? []) as unknown[]),
      {
        schemaVersion: SchemaVersion,
        canonicalBookId: input.bookId,
        sourceId: `sha256:${input.sourceHash}`,
        sourceHash: input.sourceHash,
        documentId: `doc-${input.sourceHash.slice(0, 12)}`,
        contentHash: input.sourceHash,
        normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
        normalizedPath: `books/${input.bookId}/input/book.md`,
        chunkIds: [],
        graphDocumentId: `graph-doc-${input.bookId}`,
        graphTextUnitIds: [`tu-${input.bookId}`],
        metadata: { qmdCorpusRegistered: true },
      },
    ],
  });
  const repo = new FileBookJobStateRepository(input.graphVault);
  await repo.recordQmdCorpusRegistration({
    documentId: `doc-${input.sourceHash.slice(0, 12)}`,
    contentHash: input.sourceHash,
    collection: "books",
    relativePath: `${input.bookId}.md`,
  });
}

async function appendBadRunCatalogEntry(input: {
  graphVault: string;
  bookId: string;
  runId: string;
}) {
  const catalogPath = join(input.graphVault, "catalog", "runs.yaml");
  const catalog = await readFile(catalogPath, "utf8")
    .then((text) => YAML.parse(text))
    .catch(() => ({ schemaVersion: SchemaVersion, items: [] }));
  catalog.items ??= [];
  catalog.items.push({
    schemaVersion: SchemaVersion,
    bookId: input.bookId,
    runId: input.runId,
    stage: "graph_extract",
    status: "succeeded",
    startedAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
  });
  await writeDurableYamlFixture(catalogPath, catalog);
  await mkdir(join(input.graphVault, "books", input.bookId, "runs"), {
    recursive: true,
  });
  await writeFile(
    join(input.graphVault, "books", input.bookId, "runs", `${input.runId}.yaml`),
    "not: [valid",
    "utf8",
  );
}

async function createPublishedHotplugBook(input: {
  graphVault: string;
  bookId: string;
  sourceText: string;
  inputText: string;
}) {
  const sourceHash = sha256Text(input.sourceText);
  const normalizedHash = sha256Text(input.inputText);
  const bookRoot = join(input.graphVault, "books", input.bookId);
  await writeProviderAuthReopenGraphFixture({
    stateRoot: input.graphVault,
    bookId: input.bookId,
    sourceHash,
    contentHash: normalizedHash,
  });
  await mkdir(join(bookRoot, "source"), { recursive: true });
  await mkdir(join(bookRoot, "input"), { recursive: true });
  await mkdir(join(bookRoot, "qmd"), { recursive: true });
  await writeFile(join(bookRoot, "source", "source.epub"), input.sourceText, "utf8");
  await writeFile(join(bookRoot, "input", "book.md"), input.inputText, "utf8");
  await writeDurableJsonFixture(join(bookRoot, "qmd", "qmd_build_manifest.json"), {
    schemaVersion: SchemaVersion,
    kind: "qmd_build_manifest",
    bookId: input.bookId,
    sourceRelativePath: `books/${input.bookId}/source/source.epub`,
    sourceHash,
    canonicalBookNormalizedPath: `books/${input.bookId}/input/book.md`,
    normalizedContentHash: normalizedHash,
    configHash: "config-hash",
    normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
  });
  await writeDurableJsonFixture(
    join(bookRoot, "graphrag", "output", "qmd_graph_text_unit_identity.json"),
    {
      schemaVersion: SchemaVersion,
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
  await writeBookScopedQmdIndexFixture({
    stateRoot: input.graphVault,
    bookId: input.bookId,
    normalizedPath: join(bookRoot, "input", "book.md"),
    normalizedContentHash: normalizedHash,
  });
  const { manifest, publishReady } = buildBookHotplugPackage({
    stateRoot: input.graphVault,
    bookId: input.bookId,
    sourceHash,
    sourceRelativePath: `books/${input.bookId}/source/source.epub`,
    now: () => "2026-06-04T00:00:00.000Z",
    toolVersion: "test",
  });
  await writeDurableJsonFixture(join(bookRoot, "BOOK_MANIFEST.json"), manifest);
  await writeDurableJsonFixture(join(bookRoot, "PUBLISH_READY.json"), publishReady);
}

describe("GraphRAG capability scope", () => {
  test("scoped query skips unrelated damaged run records", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-graphrag-cap-scope-"));
    try {
      const graphVault = join(root, "graph_vault");
      const wanted = {
        bookId: "book-wanted",
        sourceHash: "a".repeat(64),
      };
      const unrelated = {
        bookId: "book-unrelated",
        sourceHash: "b".repeat(64),
      };
      await createGraphReadyBook({ graphVault, ...wanted });
      await createGraphReadyBook({ graphVault, ...unrelated });
      await appendBadRunCatalogEntry({
        graphVault,
        bookId: unrelated.bookId,
        runId: "graph_extract-damaged",
      });

      const capabilities = await loadGraphQueryCapabilities({
        graphVault,
        sourceIds: [`sha256:${wanted.sourceHash}`],
        documentIds: [`doc-${wanted.sourceHash.slice(0, 12)}`],
      });

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0]?.bookId).toBe(wanted.bookId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("book-scoped query skips unrelated damaged run records", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-graphrag-book-scope-"));
    try {
      const graphVault = join(root, "graph_vault");
      const wanted = {
        bookId: "book-wanted",
        sourceHash: "c".repeat(64),
      };
      const unrelated = {
        bookId: "book-unrelated",
        sourceHash: "d".repeat(64),
      };
      await createGraphReadyBook({ graphVault, ...wanted });
      await createGraphReadyBook({ graphVault, ...unrelated });
      await appendBadRunCatalogEntry({
        graphVault,
        bookId: unrelated.bookId,
        runId: "graph_extract-damaged",
      });

      const capabilities = await loadGraphQueryCapabilities({
        graphVault,
        bookIds: [wanted.bookId],
      });

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0]?.bookId).toBe(wanted.bookId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("book-scoped hotplug query does not rebuild global projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-graphrag-book-live-scope-"));
    try {
      const graphVault = join(root, "graph_vault");
      const bookId = "book-live-hotplug";
      await createPublishedHotplugBook({
        graphVault,
        bookId,
        sourceText: "epub",
        inputText: "# Book\n\nTest driven development.\n",
      });
      for (const path of [
        "books.yaml",
        "sources.yaml",
        "document-identity-map.yaml",
        "graph-capabilities.yaml",
        "qmd-projection.yaml",
      ]) {
        await rm(join(graphVault, "catalog", path), { force: true });
      }

      const capabilities = await loadGraphQueryCapabilities({
        graphVault,
        bookIds: [bookId],
      });

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0]?.bookId).toBe(bookId);
      expect(capabilities[0]?.metadata?.projectionSource)
        .toBe("book_hotplug_manifest");
      expect(existsSync(join(graphVault, "catalog", "graph-capabilities.yaml")))
        .toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
