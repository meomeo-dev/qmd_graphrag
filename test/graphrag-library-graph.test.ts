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
import {
  loadUpperCatalogProjection,
} from "../src/graphrag/upper-index/upper-catalog-projection.js";
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

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
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

async function readLibraryCurrentRoot(
  stateRoot: string,
  libraryId: string,
): Promise<string> {
  const current = JSON.parse(
    await readFile(join(stateRoot, "library", libraryId, "CURRENT.json"), "utf8"),
  );
  return join(stateRoot, "library", libraryId, current.current);
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
        const currentRoot = await readLibraryCurrentRoot(
          stateRoot,
          "software-engineering-library",
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
        expect(existsSync(join(
          stateRoot,
          "library",
          "software-engineering-library",
          "LIBRARY_MANIFEST.json",
        ))).toBe(true);
        expect(existsSync(join(
          stateRoot,
          "library",
          "software-engineering-library",
          "PUBLISH_READY.json",
        ))).toBe(true);
        expect(existsSync(join(
          stateRoot,
          "library",
          "software-engineering-library",
          "state",
          "library-quality-gate.json",
        ))).toBe(true);
        const projection = await loadUpperCatalogProjection({
          graphVault: stateRoot,
          scopeKind: "library",
          scopeId: "software-engineering-library",
        });
        expect(projection?.scopeKind).toBe("library");
        expect(projection?.generation).toBe(manifest.libraryIdentity.generation);
        expect(projection?.authority.packageRoot)
          .toBe("library/software-engineering-library");
        expect(projection?.authority.catalogIsAuthority).toBe(false);
        expect(existsSync(join(
          stateRoot,
          "catalog",
          "library",
          "software-engineering-library",
          "projection.yaml",
        ))).toBe(true);
        expect(existsSync(join(
          stateRoot,
          "catalog",
          "library",
          "software-engineering-library",
          "LIBRARY_MANIFEST.json",
        ))).toBe(false);
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
          "library/software-engineering-library/generations/" +
            `${manifest.libraryIdentity.generation}/community_reports.parquet`,
        );

        const catalogProjectionRoot = join(
          stateRoot,
          "catalog",
          "library",
          "software-engineering-library",
        );
        await mkdir(catalogProjectionRoot, { recursive: true });
        await writeFile(join(catalogProjectionRoot, "projection.json"), "{}\n");
        await rm(catalogProjectionRoot, { recursive: true, force: true });
        const queryAfterProjectionDelete = await queryLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          query: "How do architecture and delivery practices relate?",
          method: "global",
        });
        expect(queryAfterProjectionDelete.evidence.length).toBeGreaterThan(0);

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

        await writeUpperGateCopies({
          generationRoot: currentRoot,
          packageRoot: join(stateRoot, "library", "software-engineering-library"),
          gateRelativePath: "state/library-quality-gate.json",
          gate: {
            ...qualityGate,
            checks: qualityGate.checks.filter(
              (check: { checkId: string }) =>
                check.checkId !== "semantic_edges_relation_types_allowed",
            ),
          },
        });
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
    120000,
  );

  test("refuses query when library CURRENT pointer is not query-ready",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-library-current-not-ready-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "architecture-core",
          bookIds: ["book-lc-a1", "book-lc-a2", "book-lc-a3"],
          titlePrefix: "Library Current A",
          clockSecond: 32,
        });
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "delivery-core",
          bookIds: ["book-lc-b1", "book-lc-b2", "book-lc-b3"],
          titlePrefix: "Library Current B",
          clockSecond: 34,
        });
        await resolveLibraryMembership({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          bookshelfIds: ["architecture-core", "delivery-core"],
          now: () => "2026-06-06T00:00:36.000Z",
        });
        await buildLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          maxReportsPerShelf: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:37.000Z",
        });

        const currentPath = join(
          stateRoot,
          "library",
          "software-engineering-library",
          "CURRENT.json",
        );
        const current = JSON.parse(await readFile(currentPath, "utf8"));
        current.readyState = "pending";
        await writeJsonWithSidecar(currentPath, current);

        const validation = await validateLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
        });
        expect(validation.ok).toBe(false);
        expect(validation.diagnostics).toContain(
          "upper_quality_gate_failed:current_ready_state_mismatch",
        );
        await expect(queryLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          query: "How do architecture and delivery practices relate?",
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
    },
    120000,
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
    120000,
  );

  test("fails library graph build when member report evidence is not traceable",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-library-missing-evidence-");
      try {
        const bridgePath = defaultBookshelfGraphBridgePath();
        const shelfArtifacts = await writeSyntheticShelfArtifacts(
          join(tmpRoot, "synthetic-shelf"),
        );
        await overwriteParquetColumn({
          path: shelfArtifacts.evidenceMapPath,
          column: "evidenceMapId",
          value: "missing-evidence",
        });
        await overwriteParquetColumn({
          path: shelfArtifacts.evidenceMapPath,
          column: "upperArtifactId",
          value: "not-a-report-id",
        });

        const inspection = await runBookshelfGraphParquetBridge({
          mode: "build-library",
          pythonBin: "python3",
          bridgePath,
          payload: {
            libraryId: "library-missing-evidence",
            generation: "library-missing-evidence-generation",
            outputRoot: join(tmpRoot, "library-missing-evidence"),
            maxReportsPerShelf: 2,
            maxSemanticUnits: 8,
            maxEdges: 16,
            embeddingFingerprint: "synthetic-embedding-fingerprint",
            members: [{
              bookshelfId: "synthetic-shelf",
              generation: "bookshelf-synthetic-generation",
              manifestSha256: "sha256-shelf",
              communityReportsPath: shelfArtifacts.communityReportsPath,
              evidenceMapPath: shelfArtifacts.evidenceMapPath,
              artifactDigests: {
                semanticUnits: "sha256:synthetic-semantic-units",
                semanticEdges: "sha256:synthetic-semantic-edges",
                communityReports: "sha256:synthetic-community-reports",
                evidenceMap: "sha256:synthetic-evidence-map",
              },
            }],
          },
        });

        expect(inspection.ok).toBe(false);
        expect(inspection.diagnostics).toContain("missing_lower_evidence:scr-high");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000,
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

        const memberCurrentRoot = await readBookshelfCurrentRoot(
          stateRoot,
          "architecture-core",
        );
        const memberManifestPath = join(
          memberCurrentRoot,
          "BOOKSHELF_MANIFEST.json",
        );
        const memberManifest = JSON.parse(
          await readFile(memberManifestPath, "utf8"),
        );
        memberManifest.bookshelfIdentity.createdAt =
          "2026-06-06T00:02:00.000Z";
        await writeJsonWithSidecar(memberManifestPath, memberManifest);
        await updateUpperPublishPointers({
          packageRoot: join(stateRoot, "bookshelves", "architecture-core"),
          manifestName: "BOOKSHELF_MANIFEST.json",
          generationManifestPath: memberManifestPath,
        });

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
    120000,
  );

  test("refuses library query when upper parquet artifacts contain sensitive payload text",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-library-sensitive-parquet-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "architecture-core",
          bookIds: ["book-lp-a1", "book-lp-a2", "book-lp-a3"],
          titlePrefix: "Library Sensitive A",
          clockSecond: 22,
        });
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "delivery-core",
          bookIds: ["book-lp-b1", "book-lp-b2", "book-lp-b3"],
          titlePrefix: "Library Sensitive B",
          clockSecond: 24,
        });
        await resolveLibraryMembership({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          bookshelfIds: ["architecture-core", "delivery-core"],
          now: () => "2026-06-06T00:00:26.000Z",
        });
        await buildLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          maxReportsPerShelf: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:27.000Z",
        });

        const currentRoot = await readLibraryCurrentRoot(
          stateRoot,
          "software-engineering-library",
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
          manifestName: "LIBRARY_MANIFEST.json",
          relativePath: "community_reports.parquet",
        });
        await updateUpperPublishPointers({
          packageRoot: join(stateRoot, "library", "software-engineering-library"),
          manifestName: "LIBRARY_MANIFEST.json",
          generationManifestPath: join(currentRoot, "LIBRARY_MANIFEST.json"),
        });

        const validation = await validateLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
        });
        expect(validation.ok).toBe(false);
        expect(validation.diagnostics).toContain(
          "sensitive_payload_detected:community_reports.parquet:summary:provider_payload",
        );
        await expect(queryLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          query: "How do architecture and delivery practices relate?",
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
    },
    120000,
  );

  test("refuses library query when evidence lineage contains unknown placeholders",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-library-unknown-lineage-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "architecture-core",
          bookIds: ["book-lu-a1", "book-lu-a2", "book-lu-a3"],
          titlePrefix: "Library Unknown A",
          clockSecond: 42,
        });
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "delivery-core",
          bookIds: ["book-lu-b1", "book-lu-b2", "book-lu-b3"],
          titlePrefix: "Library Unknown B",
          clockSecond: 44,
        });
        await resolveLibraryMembership({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          bookshelfIds: ["architecture-core", "delivery-core"],
          now: () => "2026-06-06T00:00:46.000Z",
        });
        await buildLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          maxReportsPerShelf: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:47.000Z",
        });

        const currentRoot = await readLibraryCurrentRoot(
          stateRoot,
          "software-engineering-library",
        );
        await overwriteParquetColumn({
          path: join(currentRoot, "evidence_map.parquet"),
          column: "targetBookId",
          value: "unknown-book",
        });
        await refreshManifestFileRecord({
          root: currentRoot,
          manifestName: "LIBRARY_MANIFEST.json",
          relativePath: "evidence_map.parquet",
        });
        await updateUpperPublishPointers({
          packageRoot: join(stateRoot, "library", "software-engineering-library"),
          manifestName: "LIBRARY_MANIFEST.json",
          generationManifestPath: join(currentRoot, "LIBRARY_MANIFEST.json"),
        });

        const validation = await validateLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
        });
        expect(validation.ok).toBe(false);
        expect(validation.diagnostics).toContain(
          "invalid_evidence_lineage:evidence_map.parquet:targetBookId:unknown",
        );
        await expect(queryLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          query: "How do architecture and delivery practices relate?",
          method: "global",
        })).rejects.toMatchObject({
          code: "upper_quality_gate_failed",
          diagnostics: expect.arrayContaining([
            "invalid_evidence_lineage:evidence_map.parquet:targetBookId:unknown",
          ]),
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000,
  );
});
