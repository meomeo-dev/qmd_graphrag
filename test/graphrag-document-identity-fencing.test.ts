import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import YAML from "yaml";

import {
  FileBookJobStateRepository,
  SchemaVersion,
} from "../src/index.js";
import {
  writeDurableYamlFixture,
} from "./helpers/graphrag-runner-harness.ts";

async function installBatchBookLease(input: {
  graphVault: string;
  runId: string;
  bookId: string;
  sessionId: string;
  generation: number;
  token: string;
}): Promise<void> {
  const leaseDir = join(
    input.graphVault,
    "catalog",
    "batch-runs",
    input.runId,
    "book-leases",
  );
  await mkdir(leaseDir, { recursive: true });
  await writeFile(join(leaseDir, `${input.bookId}.json`), JSON.stringify({
    schemaVersion: SchemaVersion,
    runId: input.runId,
    bookId: input.bookId,
    itemId: "item-fenced",
    workerId: "worker-1",
    runnerSessionId: input.sessionId,
    runnerHost: "localhost",
    runnerPid: 1,
    generation: input.generation,
    fencingToken: input.token,
    acquiredAt: "2026-05-23T00:00:00.000Z",
    heartbeatAt: "2026-05-23T00:00:00.000Z",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), "utf8");
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("GraphRAG document identity fencing", () => {
  test("fenced document writes select the current book identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-doc-identity-fencing-"));
    const previousEnv = {
      QMD_GRAPHRAG_RUN_ID: process.env.QMD_GRAPHRAG_RUN_ID,
      QMD_GRAPHRAG_RUNNER_SESSION_ID:
        process.env.QMD_GRAPHRAG_RUNNER_SESSION_ID,
      QMD_GRAPHRAG_BOOK_ID: process.env.QMD_GRAPHRAG_BOOK_ID,
      QMD_GRAPHRAG_BOOK_LEASE_GENERATION:
        process.env.QMD_GRAPHRAG_BOOK_LEASE_GENERATION,
      QMD_GRAPHRAG_BOOK_FENCING_TOKEN:
        process.env.QMD_GRAPHRAG_BOOK_FENCING_TOKEN,
    };
    try {
      const graphVault = join(root, "graph_vault");
      const repo = new FileBookJobStateRepository(graphVault);
      const runId = "batch-run-document-identity-fencing";
      const currentBookId = "book-sourcehash-current";
      const staleBookId = "book-sourcehash-stale";
      const documentId = "doc-sourcehash";
      const contentHash = "normalized-content-hash";
      const identityPath = join(
        graphVault,
        "catalog",
        "document-identity-map.yaml",
      );

      await writeDurableYamlFixture(identityPath, {
        schemaVersion: SchemaVersion,
        items: [
          {
            schemaVersion: SchemaVersion,
            canonicalBookId: staleBookId,
            sourceId: "sha256:sourcehash",
            sourceHash: "sourcehash",
            documentId,
            contentHash,
            normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
            normalizedPath: "books/stale/input/book.md",
            chunkIds: ["stale-chunk"],
            metadata: { qmdCorpusRegistered: false },
          },
          {
            schemaVersion: SchemaVersion,
            canonicalBookId: currentBookId,
            sourceId: "sha256:sourcehash",
            sourceHash: "sourcehash",
            documentId,
            contentHash,
            normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
            normalizedPath: "books/current/input/book.md",
            chunkIds: [],
            metadata: {},
          },
        ],
      });
      await installBatchBookLease({
        graphVault,
        runId,
        bookId: currentBookId,
        sessionId: "active-session",
        generation: 2,
        token: "active-token",
      });
      process.env.QMD_GRAPHRAG_RUN_ID = runId;
      process.env.QMD_GRAPHRAG_RUNNER_SESSION_ID = "active-session";
      process.env.QMD_GRAPHRAG_BOOK_ID = currentBookId;
      process.env.QMD_GRAPHRAG_BOOK_LEASE_GENERATION = "2";
      process.env.QMD_GRAPHRAG_BOOK_FENCING_TOKEN = "active-token";

      await expect(repo.recordDocumentChunks({
        documentId,
        contentHash,
        chunkIds: ["current-chunk-1", "current-chunk-2"],
      })).resolves.toBeUndefined();
      await expect(repo.recordQmdCorpusRegistration({
        documentId,
        contentHash,
        collection: "books",
        relativePath: "books/current/book.md",
      })).resolves.toBeUndefined();

      const catalog = YAML.parse(await readFile(identityPath, "utf8")) as {
        items: Array<{
          canonicalBookId: string;
          chunkIds: string[];
          metadata?: Record<string, unknown>;
        }>;
      };
      const stale = catalog.items.find((item) =>
        item.canonicalBookId === staleBookId
      );
      const current = catalog.items.find((item) =>
        item.canonicalBookId === currentBookId
      );

      expect(stale).toMatchObject({
        chunkIds: ["stale-chunk"],
        metadata: { qmdCorpusRegistered: false },
      });
      expect(current).toMatchObject({
        chunkIds: ["current-chunk-1", "current-chunk-2"],
        metadata: {
          qmdChunkCount: 2,
          qmdCorpusRegistered: true,
          qmdCollection: "books",
          qmdRelativePath: "books/current/book.md",
        },
      });
    } finally {
      restoreEnv(previousEnv);
      await rm(root, { recursive: true, force: true });
    }
  });
});
