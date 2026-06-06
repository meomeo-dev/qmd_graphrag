import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildBookshelfGraph,
} from "../src/graphrag/upper-index/bookshelf-graph.js";
import {
  resolveBookshelfMembership,
} from "../src/graphrag/upper-index/bookshelf-membership.js";
import {
  buildLibraryGraph,
  validateLibraryGraph,
} from "../src/graphrag/upper-index/library-graph.js";
import {
  resolveLibraryMembership,
} from "../src/graphrag/upper-index/library-membership.js";
import {
  loadLibraryGraphQueryCapabilities,
  queryLibraryGraph,
} from "../src/graphrag/upper-index/library-query.js";
import {
  defaultBookshelfGraphBridgePath,
  runBookshelfGraphParquetBridge,
  runBookshelfGraphQueryBridge,
} from "../src/graphrag/upper-index/bookshelf-graph-parquet.js";
import { writeReadyHotplugBook } from "./helpers/graphrag-hotplug-book-package.js";
import { mkProjectTmpDir } from "./helpers/graphrag-runner-harness.js";

const AllowedRelationTypes = new Set([
  "shared_entity",
  "source_relationship",
  "co_clustered_topic",
  "parent_child_community",
  "bookshelf_membership",
  "library_membership",
]);

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

async function readParquetColumn(path: string, column: string): Promise<string[]> {
  const script = [
    "import json, sys",
    "import pyarrow.parquet as pq",
    "table = pq.read_table(sys.argv[1], columns=[sys.argv[2]])",
    "print(json.dumps(table.column(sys.argv[2]).to_pylist()))",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", script, path, column]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(JSON.parse(stdout));
      } else {
        reject(new Error(stderr || `python3 exited ${code ?? 1}`));
      }
    });
  });
}

async function overwriteParquetColumn(input: {
  path: string;
  column: string;
  value: string;
}): Promise<void> {
  const script = [
    "import sys",
    "import pandas as pd",
    "path, column, value = sys.argv[1], sys.argv[2], sys.argv[3]",
    "df = pd.read_parquet(path)",
    "df[column] = value",
    "df.to_parquet(path, index=False)",
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

async function writeSyntheticShelfArtifacts(root: string): Promise<{
  communityReportsPath: string;
  evidenceMapPath: string;
}> {
  await mkdir(root, { recursive: true });
  const script = [
    "import sys",
    "from pathlib import Path",
    "import pandas as pd",
    "root = Path(sys.argv[1])",
    "root.mkdir(parents=True, exist_ok=True)",
    "reports = [",
    "  {",
    "    'id': 'scr-high',",
    "    'human_readable_id': 0,",
    "    'community': 0,",
    "    'level': 0,",
    "    'parent': -1,",
    "    'children': [],",
    "    'title': 'Architecture delivery alignment',",
    "    'summary': 'architecture delivery practices test driven development',",
    "    'full_content': 'architecture delivery practices test driven development',",
    "    'rank': 9.0,",
    "    'findings': [],",
    "    'evidenceMapIds': ['sev-high'],",
    "    'generation': 'synthetic-shelf',",
    "  },",
    "  {",
    "    'id': 'scr-low',",
    "    'human_readable_id': 1,",
    "    'community': 1,",
    "    'level': 0,",
    "    'parent': -1,",
    "    'children': [],",
    "    'title': 'Lower ranked implementation note',",
    "    'summary': 'implementation note with lower rank',",
    "    'full_content': 'implementation note with lower rank',",
    "    'rank': 3.0,",
    "    'findings': [],",
    "    'evidenceMapIds': ['sev-low'],",
    "    'generation': 'synthetic-shelf',",
    "  },",
    "]",
    "evidence = [",
    "  {",
    "    'evidenceMapId': 'sev-high',",
    "    'ownerLevel': 'bookshelf',",
    "    'ownerId': 'synthetic-shelf',",
    "    'upperArtifactKind': 'community_report',",
    "    'upperArtifactId': 'scr-high',",
    "    'targetLevel': 'book',",
    "    'targetBookId': 'book-simulated-0001',",
    "    'targetBookshelfId': 'synthetic-shelf',",
    "    'targetSourceId': 'sha256:synthetic',",
    "    'targetDocumentId': 'doc-synthetic',",
    "    'targetContentHash': 'content-synthetic',",
    "    'targetCommunityReportId': 'scr-high',",
    "    'targetTextUnitId': 'tu-synthetic',",
    "    'targetArtifactDigest': 'digest-high',",
    "    'rank': 9.0,",
    "    'generation': 'synthetic-shelf',",
    "  },",
    "  {",
    "    'evidenceMapId': 'sev-low',",
    "    'ownerLevel': 'bookshelf',",
    "    'ownerId': 'synthetic-shelf',",
    "    'upperArtifactKind': 'community_report',",
    "    'upperArtifactId': 'scr-low',",
    "    'targetLevel': 'book',",
    "    'targetBookId': 'book-simulated-0002',",
    "    'targetBookshelfId': 'synthetic-shelf',",
    "    'targetSourceId': 'sha256:synthetic-low',",
    "    'targetDocumentId': 'doc-synthetic-low',",
    "    'targetContentHash': 'content-synthetic-low',",
    "    'targetCommunityReportId': 'scr-low',",
    "    'targetTextUnitId': 'tu-synthetic-low',",
    "    'targetArtifactDigest': 'digest-low',",
    "    'rank': 3.0,",
    "    'generation': 'synthetic-shelf',",
    "  },",
    "]",
    "pd.DataFrame(reports).to_parquet(",
    "    root / 'community_reports.parquet', index=False",
    ")",
    "pd.DataFrame(evidence).to_parquet(",
    "    root / 'evidence_map.parquet', index=False",
    ")",
  ].join("\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", ["-c", script, root]);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `python3 exited ${code ?? 1}`));
    });
  });
  return {
    communityReportsPath: join(root, "community_reports.parquet"),
    evidenceMapPath: join(root, "evidence_map.parquet"),
  };
}

async function writeReadyBookshelf(input: {
  stateRoot: string;
  bookshelfId: string;
  bookIds: readonly string[];
  titlePrefix: string;
  clockSecond: number;
}): Promise<void> {
  for (const [index, bookId] of input.bookIds.entries()) {
    await writeReadyHotplugBook({
      stateRoot: input.stateRoot,
      bookId,
      title: `${input.titlePrefix} ${index + 1}`,
    });
  }
  await resolveBookshelfMembership({
    graphVault: input.stateRoot,
    bookshelfId: input.bookshelfId,
    bookIds: input.bookIds,
    now: () => `2026-06-06T00:00:${input.clockSecond}.000Z`,
  });
  await buildBookshelfGraph({
    graphVault: input.stateRoot,
    bookshelfId: input.bookshelfId,
    maxReportsPerBook: 2,
    maxSemanticUnits: 16,
    maxEdges: 32,
    now: () => `2026-06-06T00:00:${input.clockSecond + 1}.000Z`,
  });
}

describe("GraphRAG library graph build", () => {
  test("publishes a query-ready library graph from two published bookshelves",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-library-graph-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "architecture-core",
          bookIds: ["book-lg-a1", "book-lg-a2", "book-lg-a3"],
          titlePrefix: "Library Graph A",
          clockSecond: 2,
        });
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "delivery-core",
          bookIds: ["book-lg-b1", "book-lg-b2", "book-lg-b3"],
          titlePrefix: "Library Graph B",
          clockSecond: 4,
        });
        await resolveLibraryMembership({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          bookshelfIds: ["architecture-core", "delivery-core"],
          now: () => "2026-06-06T00:00:06.000Z",
        });

        const result = await buildLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          maxReportsPerShelf: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:07.000Z",
        });
        const validation = await validateLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
        });
        const currentRoot = join(
          stateRoot,
          "catalog",
          "library",
          "software-engineering-library",
          "current",
        );
        const manifest = JSON.parse(
          await readFile(join(currentRoot, "LIBRARY_MANIFEST.json"), "utf8"),
        );
        const qualityGate = JSON.parse(
          await readFile(join(
            currentRoot,
            "state",
            "library-quality-gate.json",
          ), "utf8"),
        );

        expect(result.qualityGate.readyState).toBe("library_query_ready");
        expect(validation.ok).toBe(true);
        expect(validation.diagnostics).toEqual([]);
        expect(validation.semanticUnitCount).toBeGreaterThanOrEqual(4);
        expect(validation.evidenceMapCount).toBeGreaterThanOrEqual(
          validation.semanticUnitCount,
        );
        expect(manifest.kind).toBe("qmd_graphrag_library_manifest");
        expect(manifest.libraryIdentity.queryReady).toBe(true);
        expect(manifest.membership.membershipManifestPath)
          .toBe("membership/LIBRARY_MEMBERSHIP_MANIFEST.json");
        expect(manifest.files.map((file: { path: string }) => file.path))
          .not.toContain("LIBRARY_MANIFEST.json");
        expect(qualityGate.fixedQueryBudgetSimulation.status).toBe("passed");
        expect(qualityGate.checks.map(
          (check: { checkId: string }) => check.checkId,
        )).toContain("semantic_edges_relation_types_allowed");
        const relationTypes = await readParquetColumn(
          join(currentRoot, "semantic_edges.parquet"),
          "relationType",
        );
        expect(relationTypes.length).toBeGreaterThan(0);
        expect(relationTypes).not.toContain("library_same_shelf");
        expect(relationTypes).not.toContain("cross_shelf_topic");
        expect(relationTypes.every((value) => AllowedRelationTypes.has(value)))
          .toBe(true);
        for (const relativePath of [
          "semantic_units.parquet",
          "semantic_edges.parquet",
          "communities.parquet",
          "community_reports.parquet",
          "evidence_map.parquet",
          "semantic_unit_embeddings.lance/INDEX_MANIFEST.json",
          "membership/LIBRARY_MEMBERSHIP_MANIFEST.json",
        ]) {
          expect(existsSync(join(currentRoot, relativePath)), relativePath)
            .toBe(true);
          expect(existsSync(join(currentRoot, `${relativePath}.sha256`)),
            `${relativePath}.sha256`).toBe(true);
        }

        const capabilities = await loadLibraryGraphQueryCapabilities({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          method: "global",
        });
        const query = await queryLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          query: "How do architecture and delivery practices relate?",
          method: "global",
        });

        expect(capabilities).toHaveLength(2);
        expect(capabilities.every((capability) => capability.ready)).toBe(true);
        expect(query.method).toBe("global");
        expect(query.providerDetail?.runtimeMetrics?.aggregate
          .attemptedRequestCount).toBe(0);
        expect(query.responseText).toContain(
          "Library software-engineering-library fixed-budget",
        );
        expect(query.evidence.length).toBeGreaterThan(0);
        expect(query.evidence[0]?.bookId).toMatch(/^book-lg-/u);
        expect(query.evidence[0]?.metadata?.scopeKind).toBe("library");
        expect(query.evidence[0]?.metadata?.targetBookshelfId).toMatch(/core$/u);
        expect(query.evidence[0]?.locator?.path).toBe(
          "catalog/library/software-engineering-library/current/community_reports.parquet",
        );
        await expect(queryLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          query: "How do architecture and delivery practices relate?",
          method: "global",
          maxInputTokens: 1,
        })).rejects.toMatchObject({
          code: "budget_exceeded_narrow_scope_required",
          diagnostics: expect.arrayContaining([
            "budget_exceeded_narrow_scope_required",
          ]),
        });

        await overwriteParquetColumn({
          path: join(currentRoot, "semantic_edges.parquet"),
          column: "relationType",
          value: "cross_shelf_topic",
        });
        const invalidValidation = await validateLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
        });
        expect(invalidValidation.ok).toBe(false);
        expect(invalidValidation.diagnostics).toContain(
          "disallowed_relation_type:semantic_edges.parquet:cross_shelf_topic",
        );

        const gatePath = join(
          currentRoot,
          "state",
          "library-quality-gate.json",
        );
        await writeFile(gatePath, JSON.stringify({
          ...qualityGate,
          checks: qualityGate.checks.filter(
            (check: { checkId: string }) =>
              check.checkId !== "semantic_edges_relation_types_allowed",
          ),
        }));
        const invalidGateValidation = await validateLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
        });
        expect(invalidGateValidation.ok).toBe(false);
        expect(invalidGateValidation.diagnostics).toContain(
          "library_quality_gate_missing_check:"
            + "semantic_edges_relation_types_allowed",
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    60000,
  );

  test("keeps library query budget fixed at simulated 10, 100, and 1000 book scale",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-library-budget-scale-");
      try {
        const bridgePath = defaultBookshelfGraphBridgePath();
        const shelfArtifacts = await writeSyntheticShelfArtifacts(
          join(tmpRoot, "synthetic-shelf"),
        );
        const results = [];
        for (const scale of [10, 100, 1000]) {
          const outputRoot = join(tmpRoot, `library-scale-${scale}`);
          const libraryId = `library-scale-${scale}`;
          const generation = `library-scale-generation-${scale}`;
          const members = Array.from({ length: scale }, (_, index) => {
            const padded = String(index + 1).padStart(4, "0");
            return {
              bookshelfId: `shelf-${padded}`,
              generation: "bookshelf-synthetic-generation",
              manifestSha256: `sha256-shelf-${padded}`,
              communityReportsPath: shelfArtifacts.communityReportsPath,
              evidenceMapPath: shelfArtifacts.evidenceMapPath,
              artifactDigests: {
                semanticUnits: "sha256:synthetic-semantic-units",
                semanticEdges: "sha256:synthetic-semantic-edges",
                communityReports: "sha256:synthetic-community-reports",
                evidenceMap: "sha256:synthetic-evidence-map",
              },
            };
          });
          const inspection = await runBookshelfGraphParquetBridge({
            mode: "build-library",
            pythonBin: "python3",
            bridgePath,
            payload: {
              libraryId,
              generation,
              outputRoot,
              maxReportsPerShelf: 2,
              maxSemanticUnits: 8,
              maxEdges: 16,
              embeddingFingerprint: "synthetic-embedding-fingerprint",
              members,
            },
          });
          const query = await runBookshelfGraphQueryBridge({
            pythonBin: "python3",
            bridgePath,
            payload: {
              scopeKind: "library",
              scopeId: libraryId,
              libraryId,
              generation,
              outputRoot,
              query: "architecture delivery practices",
              maxReports: 3,
              maxInputTokens: 1000,
            },
          });
          results.push({
            scale,
            semanticUnitCount:
              inspection.artifacts["semantic_units.parquet"]?.rowCount ?? -1,
            reportCount: query.reportCount,
            selectedReportCount: query.selectedReportCount,
            estimatedInputTokens: query.estimatedInputTokens,
            evidenceCount: query.evidence.length,
          });
          const budgetFailure = await runBookshelfGraphQueryBridge({
            pythonBin: "python3",
            bridgePath,
            payload: {
              scopeKind: "library",
              scopeId: libraryId,
              libraryId,
              generation,
              outputRoot,
              query: "architecture delivery practices",
              maxReports: 3,
              maxInputTokens: 1,
            },
          });
          expect(budgetFailure.ok).toBe(false);
          expect(budgetFailure.diagnostics).toContain(
            "budget_exceeded_narrow_scope_required",
          );
        }

        for (const result of results) {
          expect(result.semanticUnitCount, String(result.scale)).toBe(8);
          expect(result.reportCount, String(result.scale)).toBeLessThanOrEqual(9);
          expect(result.selectedReportCount, String(result.scale)).toBe(3);
          expect(result.estimatedInputTokens, String(result.scale))
            .toBeGreaterThan(0);
          expect(result.evidenceCount, String(result.scale)).toBeGreaterThan(0);
        }
        const budgetFingerprints = results.map((result) => [
          result.reportCount,
          result.selectedReportCount,
          result.estimatedInputTokens,
          result.evidenceCount,
        ].join(":"));
        expect(new Set(budgetFingerprints).size).toBe(1);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    60000,
  );

  test("refuses library query when a member bookshelf manifest becomes stale",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-library-stale-query-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "architecture-core",
          bookIds: ["book-ls-a1", "book-ls-a2", "book-ls-a3"],
          titlePrefix: "Library Stale A",
          clockSecond: 12,
        });
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "delivery-core",
          bookIds: ["book-ls-b1", "book-ls-b2", "book-ls-b3"],
          titlePrefix: "Library Stale B",
          clockSecond: 14,
        });
        await resolveLibraryMembership({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          bookshelfIds: ["architecture-core", "delivery-core"],
          now: () => "2026-06-06T00:00:16.000Z",
        });
        await buildLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          maxReportsPerShelf: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:17.000Z",
        });

        const memberManifestPath = join(
          stateRoot,
          "catalog",
          "bookshelves",
          "architecture-core",
          "current",
          "BOOKSHELF_MANIFEST.json",
        );
        const memberManifest = JSON.parse(
          await readFile(memberManifestPath, "utf8"),
        );
        memberManifest.bookshelfIdentity.createdAt =
          "2026-06-06T00:02:00.000Z";
        await writeJsonWithSidecar(memberManifestPath, memberManifest);

        const validation = await validateLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
        });
        expect(validation.ok).toBe(false);
        expect(validation.diagnostics).toContain(
          "member_bookshelf_manifest_stale:architecture-core",
        );
        await expect(queryLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          query: "How do architecture and delivery practices relate?",
          method: "global",
        })).rejects.toMatchObject({
          code: "upper_index_stale",
          diagnostics: expect.arrayContaining([
            "member_bookshelf_manifest_stale:architecture-core",
          ]),
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    60000,
  );
});
