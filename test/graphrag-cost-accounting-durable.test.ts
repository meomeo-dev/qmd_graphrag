import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  appendProviderCostAccounting,
  buildProviderCostAccounting,
} from "../src/provider/cost-accounting.js";

function providerCostRecord(runId: string) {
  return buildProviderCostAccounting({
    sourceId: `source-${runId}`,
    documentId: `doc-${runId}`,
    bookId: `book-${runId}`,
    contentHash: `content-${runId}`,
    lineageMode: "graph_artifact",
    stage: "graphrag_index",
    provider: "graphrag",
    model: "standard",
    requestCount: 1,
    tokenCount: 0,
    tokenCountStatus: "unknown",
    embeddingCount: 0,
    embeddingCountStatus: "unknown",
    cacheHit: false,
    runId,
    requestArtifactId: `request-${runId}`,
    artifactIds: [`request-${runId}`],
  });
}

async function readLedgerRunIds(graphVault: string): Promise<string[]> {
  const raw = await readFile(
    join(graphVault, "catalog", "cost-accounting.jsonl"),
    "utf8",
  );
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).runId as string);
}

describe("GraphRAG provider cost accounting durable writes", () => {
  test("appends through production graph_vault path without owner mapping miss", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-cost-durable-"));
    const graphVault = join(root, "graph_vault");

    await appendProviderCostAccounting(graphVault, providerCostRecord("run-1"));

    expect(await readLedgerRunIds(graphVault)).toEqual(["run-1"]);
    const catalogEntries = await readdir(join(graphVault, "catalog"));
    expect(catalogEntries.some((entry) => entry.includes(".tmp-"))).toBe(false);
    expect(catalogEntries.some((entry) => entry.endsWith(".owner.json"))).toBe(
      false,
    );
  });

  test("quarantines corrupt tail without owner mapping miss", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-cost-corrupt-"));
    const graphVault = join(root, "graph_vault");
    const catalog = join(graphVault, "catalog");
    const first = providerCostRecord("run-existing");

    await mkdir(catalog, { recursive: true });
    await writeFile(
      join(catalog, "cost-accounting.jsonl"),
      `${JSON.stringify(first)}\n{"schemaVersion":`,
      "utf8",
    );

    await appendProviderCostAccounting(graphVault, providerCostRecord("run-new"));

    expect(await readLedgerRunIds(graphVault)).toEqual([
      "run-existing",
      "run-new",
    ]);
    const catalogEntries = await readdir(catalog);
    expect(
      catalogEntries.some((entry) => entry.startsWith("cost-accounting.jsonl.corrupt-")),
    ).toBe(true);
    expect(existsSync(join(catalog, "cost-accounting.jsonl"))).toBe(true);
  });

  test("keeps unknown production JSONL targets fail closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "qmd-cost-unknown-"));
    const target = join(root, "graph_vault", "catalog", "unknown.jsonl");
    const module = await import("../src/job-state/durable-state-store.js");

    expect(() => module.writeOpaqueFileDurableSync(target, "{}\n")).toThrow(
      /durable target mapping missing/,
    );
  });
});
