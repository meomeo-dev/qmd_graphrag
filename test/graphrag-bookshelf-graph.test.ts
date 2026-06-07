import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildBookshelfGraph,
  validateBookshelfGraph,
} from "../src/graphrag/upper-index/bookshelf-graph.js";
import {
  loadBookshelfGraphQueryCapabilities,
  queryBookshelfGraph,
} from "../src/graphrag/upper-index/bookshelf-query.js";
import {
  resolveBookshelfMembership,
} from "../src/graphrag/upper-index/bookshelf-membership.js";
import {
  loadUpperCatalogProjection,
} from "../src/graphrag/upper-index/upper-catalog-projection.js";
import {
  writeYamlFileDurable,
} from "../src/job-state/durable-state-store.js";
import { writeReadyHotplugBook } from "./helpers/graphrag-hotplug-book-package.js";
import { mkProjectTmpDir } from "./helpers/graphrag-runner-harness.js";

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJsonWithSidecar(path: string, value: unknown): Promise<void> {
  const text = stableJson(value);
  await writeFile(path, text, "utf8");
  await writeFile(`${path}.sha256`, `${sha256Text(text)}\n`, "utf8");
}

async function overwriteParquetColumn(input: {
  path: string;
  column: string;
  value: string;
}): Promise<void> {
  const script = [
    "import sys",
    "import pyarrow as pa",
    "import pyarrow.parquet as pq",
    "path, column, value = sys.argv[1], sys.argv[2], sys.argv[3]",
    "table = pq.read_table(path)",
    "arrays = []",
    "for name in table.column_names:",
    "    if name == column:",
    "        arrays.append(pa.array([value] * table.num_rows, type=pa.string()))",
    "    else:",
    "        arrays.append(table.column(name))",
    "pq.write_table(pa.table(arrays, names=table.column_names), path)",
  ].join("\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", [
      "-c",
      script,
      input.path,
      input.column,
      input.value,
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `python3 exited ${code ?? 1}`));
    });
  });
}

async function refreshManifestFileRecord(input: {
  root: string;
  manifestName: string;
  relativePath: string;
}): Promise<void> {
  const artifactPath = join(input.root, input.relativePath);
  const bytes = await readFile(artifactPath);
  const sha256 = sha256Buffer(bytes);
  await writeFile(`${artifactPath}.sha256`, `${sha256}\n`, "utf8");

  const manifestPath = join(input.root, input.manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const file = manifest.files.find(
    (item: { path: string }) => item.path === input.relativePath,
  );
  if (file == null) {
    throw new Error(`manifest_file_record_missing:${input.relativePath}`);
  }
  file.bytes = bytes.byteLength;
  file.sha256 = sha256;
  await writeJsonWithSidecar(manifestPath, manifest);
}

async function readBookshelfCurrentRoot(
  stateRoot: string,
  bookshelfId: string,
): Promise<string> {
  const current = JSON.parse(
    await readFile(
      join(stateRoot, "bookshelves", bookshelfId, "CURRENT.json"),
      "utf8",
    ),
  );
  return join(stateRoot, "bookshelves", bookshelfId, current.current);
}

async function updateUpperPublishPointers(input: {
  packageRoot: string;
  manifestName: string;
  generationManifestPath: string;
}): Promise<void> {
  const manifestSha256 = sha256Buffer(await readFile(input.generationManifestPath));
  await writeFile(`${input.generationManifestPath}.sha256`, `${manifestSha256}\n`);
  const rootManifestPath = join(input.packageRoot, input.manifestName);
  const rootManifest = JSON.parse(await readFile(input.generationManifestPath, "utf8"));
  await writeJsonWithSidecar(rootManifestPath, rootManifest);

  const currentPath = join(input.packageRoot, "CURRENT.json");
  const current = JSON.parse(await readFile(currentPath, "utf8"));
  current.manifestSha256 = manifestSha256;
  await writeJsonWithSidecar(currentPath, current);

  const publishReadyPath = join(input.packageRoot, "PUBLISH_READY.json");
  const publishReady = JSON.parse(await readFile(publishReadyPath, "utf8"));
  publishReady.manifestSha256 = manifestSha256;
  await writeJsonWithSidecar(publishReadyPath, publishReady);
}

async function writeUpperGateCopies(input: {
  generationRoot: string;
  packageRoot: string;
  gateRelativePath: string;
  gate: unknown;
}): Promise<void> {
  await writeJsonWithSidecar(
    join(input.generationRoot, input.gateRelativePath),
    input.gate,
  );
  await writeJsonWithSidecar(
    join(input.packageRoot, input.gateRelativePath),
    input.gate,
  );
}

describe("GraphRAG bookshelf graph build", () => {
  test("publishes a query-ready bookshelf graph from membership handoff",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-bookshelf-graph-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookIds = ["book-graph-a", "book-graph-b", "book-graph-c"];
        for (const [index, bookId] of bookIds.entries()) {
          await writeReadyHotplugBook({
            stateRoot,
            bookId,
            title: `Architecture Graph ${index + 1}`,
          });
        }
        await resolveBookshelfMembership({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          bookIds,
          now: () => "2026-06-06T00:00:02.000Z",
        });

        const result = await buildBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          maxReportsPerBook: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:03.000Z",
        });
        const validation = await validateBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
        });
        const currentRoot = await readBookshelfCurrentRoot(
          stateRoot,
          "architecture-core",
        );
        const manifest = JSON.parse(
          await readFile(join(currentRoot, "BOOKSHELF_MANIFEST.json"), "utf8"),
        );
        const qualityGate = JSON.parse(
          await readFile(join(
            currentRoot,
            "state",
            "bookshelf-quality-gate.json",
          ), "utf8"),
        );

        expect(result.qualityGate.readyState).toBe("bookshelf_query_ready");
        expect(validation.ok).toBe(true);
        expect(validation.diagnostics).toEqual([]);
        expect(validation.semanticUnitCount).toBeGreaterThanOrEqual(3);
        expect(validation.evidenceMapCount).toBeGreaterThanOrEqual(
          validation.semanticUnitCount,
        );
        expect(manifest.kind).toBe("qmd_graphrag_bookshelf_manifest");
        expect(manifest.bookshelfIdentity.queryReady).toBe(true);
        expect(manifest.membership.membersPath).toBe("bookshelf_members.json");
        expect(manifest.membership.membershipManifestPath)
          .toBe("membership/BOOKSHELF_MEMBERSHIP_MANIFEST.json");
        expect(existsSync(join(
          stateRoot,
          "bookshelves",
          "architecture-core",
          "BOOKSHELF_MANIFEST.json",
        ))).toBe(true);
        expect(existsSync(join(
          stateRoot,
          "bookshelves",
          "architecture-core",
          "PUBLISH_READY.json",
        ))).toBe(true);
        expect(existsSync(join(
          stateRoot,
          "bookshelves",
          "architecture-core",
          "state",
          "bookshelf-quality-gate.json",
        ))).toBe(true);
        const projection = await loadUpperCatalogProjection({
          graphVault: stateRoot,
          scopeKind: "bookshelf",
          scopeId: "architecture-core",
        });
        expect(projection?.scopeKind).toBe("bookshelf");
        expect(projection?.generation)
          .toBe(manifest.bookshelfIdentity.generation);
        expect(projection?.authority.packageRoot)
          .toBe("bookshelves/architecture-core");
        expect(projection?.authority.catalogIsAuthority).toBe(false);
        expect(existsSync(join(
          stateRoot,
          "catalog",
          "bookshelves",
          "architecture-core",
          "projection.yaml",
        ))).toBe(true);
        expect(existsSync(join(
          stateRoot,
          "catalog",
          "bookshelves",
          "architecture-core",
          "BOOKSHELF_MANIFEST.json",
        ))).toBe(false);
        expect(manifest.files.map((file: { path: string }) => file.path))
          .not.toContain("BOOKSHELF_MANIFEST.json");
        expect(qualityGate.fixedQueryBudgetSimulation.status).toBe("passed");
        expect(qualityGate.checks.map(
          (check: { checkId: string }) => check.checkId,
        )).toContain("semantic_edges_relation_types_allowed");
        for (const relativePath of [
          "semantic_units.parquet",
          "semantic_edges.parquet",
          "communities.parquet",
          "community_reports.parquet",
          "evidence_map.parquet",
          "semantic_unit_embeddings.lance/INDEX_MANIFEST.json",
          "membership/BOOKSHELF_MEMBERSHIP_MANIFEST.json",
        ]) {
          expect(existsSync(join(currentRoot, relativePath)), relativePath)
            .toBe(true);
          expect(existsSync(join(currentRoot, `${relativePath}.sha256`)),
            `${relativePath}.sha256`).toBe(true);
        }
        for (const bookId of bookIds) {
          expect(existsSync(join(
            stateRoot,
            "books",
            bookId,
            "BOOKSHELF_MANIFEST.json",
          ))).toBe(false);
          expect(existsSync(join(
            stateRoot,
            "books",
            bookId,
            "semantic_units.parquet",
          ))).toBe(false);
        }

        const capabilities = await loadBookshelfGraphQueryCapabilities({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          method: "global",
        });
        const query = await queryBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          query: "What is architecture testing?",
          method: "global",
        });

        expect(capabilities).toHaveLength(3);
        expect(capabilities.every((capability) => capability.ready)).toBe(true);
        expect(query.method).toBe("global");
        expect(query.providerDetail?.runtimeMetrics?.aggregate
          .attemptedRequestCount).toBe(0);
        expect(query.providerDetail?.runtimeMetrics?.aggregate
          .promptTokens).toBeGreaterThan(0);
        expect(query.responseText).toContain("fixed-budget GraphRAG report search");
        expect(query.evidence.length).toBeGreaterThan(0);
        expect(query.evidence[0]?.bookId).toMatch(/^book-graph-/u);
        expect(query.evidence[0]?.sourceId).toMatch(/^sha256:/u);
        expect(query.evidence[0]?.documentId).toMatch(/^doc-/u);
        expect(query.evidence[0]?.contentHash).toBeTruthy();
        expect(query.evidence[0]?.graphTextUnitId).toBeTruthy();
        expect(query.evidence[0]?.locator?.path).toBe(
          "bookshelves/architecture-core/generations/" +
            `${manifest.bookshelfIdentity.generation}/community_reports.parquet`,
        );

        const catalogProjectionRoot = join(
          stateRoot,
          "catalog",
          "bookshelves",
          "architecture-core",
        );
        await mkdir(catalogProjectionRoot, { recursive: true });
        await writeFile(join(catalogProjectionRoot, "projection.json"), "{}\n");
        await rm(catalogProjectionRoot, { recursive: true, force: true });
        const queryAfterProjectionDelete = await queryBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          query: "What is architecture testing?",
          method: "global",
        });
        expect(queryAfterProjectionDelete.evidence.length).toBeGreaterThan(0);

        await writeUpperGateCopies({
          generationRoot: currentRoot,
          packageRoot: join(stateRoot, "bookshelves", "architecture-core"),
          gateRelativePath: "state/bookshelf-quality-gate.json",
          gate: {
            ...qualityGate,
            checks: qualityGate.checks.filter(
              (check: { checkId: string }) =>
                check.checkId !== "semantic_edges_relation_types_allowed",
            ),
          },
        });
        const invalidGateValidation = await validateBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
        });
        expect(invalidGateValidation.ok).toBe(false);
        expect(invalidGateValidation.diagnostics).toContain(
          "quality_gate_missing_check:semantic_edges_relation_types_allowed",
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("rejects catalog projection when stored scope does not match request",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-bookshelf-projection-scope-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookIds = ["book-bps-a", "book-bps-b", "book-bps-c"];
        for (const [index, bookId] of bookIds.entries()) {
          await writeReadyHotplugBook({
            stateRoot,
            bookId,
            title: `Bookshelf Projection Scope ${index + 1}`,
          });
        }
        await resolveBookshelfMembership({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          bookIds,
          now: () => "2026-06-06T00:00:10.000Z",
        });
        await buildBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          maxReportsPerBook: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:11.000Z",
        });

        const projectionPath = join(
          stateRoot,
          "catalog",
          "bookshelves",
          "architecture-core",
          "projection.yaml",
        );
        const projection = await loadUpperCatalogProjection({
          graphVault: stateRoot,
          scopeKind: "bookshelf",
          scopeId: "architecture-core",
        });
        expect(projection?.scopeId).toBe("architecture-core");
        await writeYamlFileDurable(projectionPath, {
          ...projection,
          scopeId: "different-shelf",
        });

        await expect(loadUpperCatalogProjection({
          graphVault: stateRoot,
          scopeKind: "bookshelf",
          scopeId: "architecture-core",
        })).rejects.toThrow(
          "upper_quality_gate_failed:catalog_projection_scope_mismatch",
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("refuses query when CURRENT pointer is not in a query-ready state",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-bookshelf-current-not-ready-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookIds = ["book-bc-a", "book-bc-b", "book-bc-c"];
        for (const [index, bookId] of bookIds.entries()) {
          await writeReadyHotplugBook({
            stateRoot,
            bookId,
            title: `Bookshelf Current ${index + 1}`,
          });
        }
        await resolveBookshelfMembership({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          bookIds,
          now: () => "2026-06-06T00:00:08.000Z",
        });
        await buildBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          maxReportsPerBook: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:09.000Z",
        });

        const currentPath = join(
          stateRoot,
          "bookshelves",
          "architecture-core",
          "CURRENT.json",
        );
        const current = JSON.parse(await readFile(currentPath, "utf8"));
        current.readyState = "running";
        await writeJsonWithSidecar(currentPath, current);

        const validation = await validateBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
        });
        expect(validation.ok).toBe(false);
        expect(validation.diagnostics).toContain(
          "upper_quality_gate_failed:current_ready_state_mismatch",
        );
        await expect(queryBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          query: "What is architecture testing?",
          method: "global",
        })).rejects.toMatchObject({
          code: "upper_quality_gate_failed",
          diagnostics: expect.arrayContaining([
            "current_ready_state_mismatch",
          ]),
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("refuses bookshelf query when a member book manifest becomes stale",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-bookshelf-stale-query-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookIds = ["book-bs-a", "book-bs-b", "book-bs-c"];
        for (const [index, bookId] of bookIds.entries()) {
          await writeReadyHotplugBook({
            stateRoot,
            bookId,
            title: `Bookshelf Stale ${index + 1}`,
          });
        }
        await resolveBookshelfMembership({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          bookIds,
          now: () => "2026-06-06T00:00:04.000Z",
        });
        await buildBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          maxReportsPerBook: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:05.000Z",
        });

        const staleBookId = bookIds[0]!;
        const memberManifestPath = join(
          stateRoot,
          "books",
          staleBookId,
          "BOOK_MANIFEST.json",
        );
        const memberManifest = JSON.parse(
          await readFile(memberManifestPath, "utf8"),
        );
        memberManifest.checksums.manifestSha256 = "stale-member-manifest-sha";
        await writeJsonWithSidecar(memberManifestPath, memberManifest);

        const validation = await validateBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
        });
        expect(validation.ok).toBe(false);
        expect(validation.diagnostics).toContain(
          `member_manifest_stale:${staleBookId}`,
        );
        await expect(queryBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          query: "What is architecture testing?",
          method: "global",
        })).rejects.toMatchObject({
          code: "upper_index_stale",
          diagnostics: expect.arrayContaining([
            `member_manifest_stale:${staleBookId}`,
          ]),
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("refuses query when upper parquet artifacts contain sensitive payload text",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-bookshelf-sensitive-parquet-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookIds = ["book-bp-a", "book-bp-b", "book-bp-c"];
        for (const [index, bookId] of bookIds.entries()) {
          await writeReadyHotplugBook({
            stateRoot,
            bookId,
            title: `Bookshelf Sensitive ${index + 1}`,
          });
        }
        await resolveBookshelfMembership({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          bookIds,
          now: () => "2026-06-06T00:00:06.000Z",
        });
        await buildBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          maxReportsPerBook: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:07.000Z",
        });

        const currentRoot = await readBookshelfCurrentRoot(
          stateRoot,
          "architecture-core",
        );
        await overwriteParquetColumn({
          path: join(currentRoot, "community_reports.parquet"),
          column: "summary",
          value: [
            "providerRequestPayload rawPrompt Bearer testtoken12345678",
            "/Users/jin/private/query.log",
          ].join(" "),
        });
        await refreshManifestFileRecord({
          root: currentRoot,
          manifestName: "BOOKSHELF_MANIFEST.json",
          relativePath: "community_reports.parquet",
        });
        await updateUpperPublishPointers({
          packageRoot: join(stateRoot, "bookshelves", "architecture-core"),
          manifestName: "BOOKSHELF_MANIFEST.json",
          generationManifestPath: join(currentRoot, "BOOKSHELF_MANIFEST.json"),
        });

        const validation = await validateBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
        });
        expect(validation.ok).toBe(false);
        expect(validation.diagnostics).toContain(
          "sensitive_payload_detected:community_reports.parquet:summary:provider_payload",
        );
        await expect(queryBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          query: "What is architecture testing?",
          method: "global",
        })).rejects.toMatchObject({
          code: "upper_quality_gate_failed",
          diagnostics: expect.arrayContaining([
            "sensitive_payload_detected:community_reports.parquet:summary:provider_payload",
          ]),
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });
});
