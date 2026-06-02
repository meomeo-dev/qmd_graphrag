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
  writeDurableYamlFixture,
  writeProviderAuthReopenGraphFixture,
} from "./helpers/graphrag-runner-harness.js";

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
});
