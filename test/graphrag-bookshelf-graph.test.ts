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
  BookshelfGraphBuilderVersion,
  BookshelfGraphChecks,
  BookshelfGraphSchemaVersion,
} from "../src/graphrag/upper-index/bookshelf-graph-contracts.js";
import {
  defaultBookshelfGraphBridgePath,
  runBookshelfGraphParquetBridge,
  runBookshelfGraphQueryBridge,
} from "../src/graphrag/upper-index/bookshelf-graph-parquet.js";
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

async function packageFileRecord(
  root: string,
  relativePath: string,
): Promise<{ path: string; sha256: string; bytes: number }> {
  const path = join(root, relativePath);
  const bytes = await readFile(path);
  const sha256 = sha256Buffer(bytes);
  await writeFile(`${path}.sha256`, `${sha256}\n`, "utf8");
  return { path: relativePath, sha256, bytes: bytes.byteLength };
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

async function duplicateParquetRows(input: {
  path: string;
  minRows: number;
}): Promise<void> {
  const script = [
    "import sys",
    "import pyarrow as pa",
    "import pyarrow.parquet as pq",
    "path, min_rows = sys.argv[1], int(sys.argv[2])",
    "table = pq.read_table(path)",
    "tables = [table]",
    "while sum(item.num_rows for item in tables) < min_rows:",
    "    tables.append(table)",
    "pq.write_table(pa.concat_tables(tables), path)",
  ].join("\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", ["-c", script, input.path, String(input.minRows)]);
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

async function writeSyntheticBookArtifacts(root: string): Promise<{
  communityReportsPath: string;
  identityPath: string;
}> {
  await mkdir(root, { recursive: true });
  const script = [
    "import sys",
    "from pathlib import Path",
    "import json",
    "import pandas as pd",
    "root = Path(sys.argv[1])",
    "root.mkdir(parents=True, exist_ok=True)",
    "reports = [",
    "  {",
    "    'id': 'bcr-high',",
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
    "  },",
    "  {",
    "    'id': 'bcr-low',",
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
    "  },",
    "]",
    "pd.DataFrame(reports).to_parquet(",
    "    root / 'community_reports.parquet', index=False",
    ")",
    "(root / 'qmd_graph_text_unit_identity.json').write_text(json.dumps({",
    "  'schemaVersion': '1.0.0',",
    "  'bookId': 'synthetic-book',",
    "  'sourceId': 'sha256:synthetic',",
    "  'sourceHash': 'synthetic-source',",
    "  'documentId': 'doc-synthetic',",
    "  'contentHash': 'content-synthetic',",
    "  'graphTextUnitIds': ['tu-synthetic'],",
    "}, indent=2) + '\\n', 'utf8')",
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
    identityPath: join(root, "qmd_graph_text_unit_identity.json"),
  };
}

async function writeSyntheticBookManifest(input: {
  stateRoot: string;
  bookId: string;
  title: string;
  manifestSha256: string;
  sourceHash: string;
  contentHash: string;
}): Promise<void> {
  await mkdir(join(input.stateRoot, "books", input.bookId), { recursive: true });
  await writeJsonWithSidecar(
    join(input.stateRoot, "books", input.bookId, "BOOK_MANIFEST.json"),
    {
      schemaVersion: BookshelfGraphSchemaVersion,
      kind: "qmd_graphrag_book_package",
      identity: {
        bookId: input.bookId,
        sourceHash: input.sourceHash,
        canonicalTitle: input.title,
        titleSlug: input.bookId,
        createdAt: "2026-06-06T00:00:00.000Z",
        packageGeneration: `pkg-${input.bookId}`,
      },
      source: {
        sourcePath: `books/${input.bookId}/source/source.epub`,
        sourceHash: input.sourceHash,
      },
      input: {
        canonicalNormalizedPath: `books/${input.bookId}/input/book.md`,
        normalizedHash: input.contentHash,
      },
      qmd: {
        qmdReadyState: "qmd_index_ready",
      },
      graphrag: {
        queryReady: true,
        graphRagReadyState: "query_ready",
      },
      checksums: {
        manifestSha256: input.manifestSha256,
      },
    },
  );
}

async function publishSyntheticBookshelfPackage(input: {
  stateRoot: string;
  bookshelfId: string;
  generation: string;
  memberManifests: Record<string, string>;
  memberCount: number;
  maxSemanticUnits: number;
  maxInputTokens: number;
  maxBooksForDeepening: number;
  maxMemberCommunityRefs: number;
  artifactRows: Record<string, number>;
}): Promise<void> {
  const packageRoot = join(input.stateRoot, "bookshelves", input.bookshelfId);
  const generationRoot = join(packageRoot, "generations", input.generation);
  await mkdir(join(generationRoot, "state"), { recursive: true });
  await mkdir(join(generationRoot, "membership"), { recursive: true });
  await mkdir(join(packageRoot, "state"), { recursive: true });
  const members = {
    schemaVersion: BookshelfGraphSchemaVersion,
    kind: "qmd_graphrag_bookshelf_members",
    bookshelfId: input.bookshelfId,
    generation: `membership-${input.generation}`,
    members: Object.keys(input.memberManifests).map((bookId) => ({
      bookId,
      manifestSha256: input.memberManifests[bookId],
      packageGeneration: `pkg-${bookId}`,
      queryReady: true,
      qmdReadyState: "qmd_index_ready",
      graphRagReadyState: "query_ready",
      membershipSourceKind: "user_explicit",
      membershipDecisionId: `decision-${bookId}`,
      membershipConfidence: 1,
      userLocked: true,
      splitGroupId: null,
      virtualParentBookshelfId: null,
      title: `Synthetic Book ${bookId}`,
      packageRoot: `books/${bookId}`,
      graphArtifacts: {
        communityReports: `books/${bookId}/graphrag/output/community_reports.parquet`,
        entities: `books/${bookId}/graphrag/output/entities.parquet`,
        relationships: `books/${bookId}/graphrag/output/relationships.parquet`,
        textUnits: `books/${bookId}/graphrag/output/text_units.parquet`,
      },
    })),
  };
  const membershipManifest = {
    schemaVersion: BookshelfGraphSchemaVersion,
    kind: "qmd_graphrag_bookshelf_membership_manifest",
    bookshelfIdentity: {
      bookshelfId: input.bookshelfId,
      generation: `membership-${input.generation}`,
      createdAt: "2026-06-06T00:00:00.000Z",
      materializationStatus: "membership_resolved",
      queryReady: false,
    },
    membership: {
      memberCount: input.memberCount,
      membersPath: "bookshelf_members.json",
      decisionsPath: "membership_decisions.jsonl",
      splitPlanPath: "bookshelf_split_plan.json",
      policyKind: "user_explicit",
      policyDigest: "synthetic-policy",
      membersDigest: sha256Text(stableJson(members)),
      decisionsDigest: sha256Text("synthetic-decisions"),
      splitPlanDigest: sha256Text("synthetic-split-plan"),
    },
    qualityGate: {
      path: "state/membership-quality-gate.json",
      status: "passed",
    },
  };
  const membershipGate = {
    schemaVersion: BookshelfGraphSchemaVersion,
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation: `membership-${input.generation}`,
    stageId: "bookshelf_membership_resolution",
    readyState: "membership_resolved",
    queryReady: false,
    status: "passed",
  };
  await writeJsonWithSidecar(join(generationRoot, "bookshelf_members.json"), members);
  await writeJsonWithSidecar(
    join(generationRoot, "membership", "BOOKSHELF_MEMBERSHIP_MANIFEST.json"),
    membershipManifest,
  );
  await writeJsonWithSidecar(
    join(generationRoot, "state", "membership-quality-gate.json"),
    membershipGate,
  );

  const gate = {
    schemaVersion: BookshelfGraphSchemaVersion,
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation: input.generation,
    stageId: "materialized_bookshelf_graph_build",
    readyState: "bookshelf_query_ready",
    queryReady: true,
    status: "passed",
    checkedAt: "2026-06-06T00:00:01.000Z",
    checks: BookshelfGraphChecks.map((checkId) => ({ checkId, status: "passed" })),
    diagnostics: [],
    artifactRowCounts: input.artifactRows,
    fixedQueryBudgetSimulation: {
      status: "passed",
      maxSemanticUnits: input.maxSemanticUnits,
      selectedSemanticUnits: input.artifactRows["semantic_units.parquet"] ?? 0,
      maxInputTokens: input.maxInputTokens,
      estimatedInputTokens:
        (input.artifactRows["semantic_units.parquet"] ?? 0) * 64,
      maxBooksForDeepening: input.maxBooksForDeepening,
      selectedBooksForDeepening: Math.min(
        input.memberCount,
        input.maxBooksForDeepening,
      ),
    },
  };
  await writeJsonWithSidecar(
    join(generationRoot, "state", "bookshelf-quality-gate.json"),
    gate,
  );

  const files = [
    await packageFileRecord(generationRoot, "bookshelf_members.json"),
    await packageFileRecord(
      generationRoot,
      "membership/BOOKSHELF_MEMBERSHIP_MANIFEST.json",
    ),
    await packageFileRecord(
      generationRoot,
      "state/membership-quality-gate.json",
    ),
    await packageFileRecord(generationRoot, "semantic_units.parquet"),
    await packageFileRecord(generationRoot, "semantic_edges.parquet"),
    await packageFileRecord(generationRoot, "communities.parquet"),
    await packageFileRecord(generationRoot, "community_reports.parquet"),
    await packageFileRecord(generationRoot, "evidence_map.parquet"),
    await packageFileRecord(
      generationRoot,
      "semantic_unit_embeddings.lance/INDEX_MANIFEST.json",
    ),
    await packageFileRecord(
      generationRoot,
      "semantic_unit_embeddings.lance/qmd_row_count.json",
    ),
    await packageFileRecord(
      generationRoot,
      "semantic_unit_embeddings.lance/vectors.parquet",
    ),
    await packageFileRecord(
      generationRoot,
      "state/bookshelf-quality-gate.json",
    ),
  ];
  const manifest = {
    schemaVersion: BookshelfGraphSchemaVersion,
    kind: "qmd_graphrag_bookshelf_manifest",
    bookshelfIdentity: {
      bookshelfId: input.bookshelfId,
      generation: input.generation,
      membershipGeneration: `membership-${input.generation}`,
      createdAt: "2026-06-06T00:00:01.000Z",
      materializationStatus: "bookshelf_query_ready",
      queryReady: true,
    },
    membership: {
      memberCount: input.memberCount,
      membersPath: "bookshelf_members.json",
      membershipManifestPath: "membership/BOOKSHELF_MEMBERSHIP_MANIFEST.json",
      membershipManifestSha256: sha256Text(stableJson(membershipManifest)),
      membersDigest: sha256Text(stableJson(members)),
      decisionsDigest: sha256Text("synthetic-decisions"),
      splitPlanDigest: sha256Text("synthetic-split-plan"),
      memberManifestSha256: input.memberManifests,
    },
    buildConfig: {
      builderVersion: BookshelfGraphBuilderVersion,
      maxReportsPerBook: 2,
      maxSemanticUnits: input.maxSemanticUnits,
      maxEdges: 16,
      embeddingFingerprint: "synthetic-embedding-fingerprint",
      summaryFingerprint: sha256Text(BookshelfGraphBuilderVersion),
      evidenceSchema: "upper-evidence-map-v1",
    },
    graphArtifacts: {
      semanticUnits: "semantic_units.parquet",
      semanticEdges: "semantic_edges.parquet",
      communities: "communities.parquet",
      communityReports: "community_reports.parquet",
      semanticUnitEmbeddings: "semantic_unit_embeddings.lance",
    },
    graphArtifactSchemas: {
      semanticUnits: { requiredColumns: [] },
      semanticEdges: { requiredColumns: [] },
      communities: { requiredColumns: [] },
      communityReports: { requiredColumns: [] },
    },
    evidenceMap: {
      path: "evidence_map.parquet",
      requiredColumns: [],
      rowCount: input.artifactRows["evidence_map.parquet"] ?? 0,
    },
    fixedQueryBudget: {
      maxSemanticUnits: input.maxSemanticUnits,
      maxBooksForDeepening: input.maxBooksForDeepening,
      maxMemberCommunityRefs: input.maxMemberCommunityRefs,
      maxInputTokens: input.maxInputTokens,
      simulationStatus: "passed",
    },
    qualityGate: {
      path: "state/bookshelf-quality-gate.json",
      status: "passed",
    },
    files,
    sensitivityPolicy: {
      forbiddenFields: [
        "providerRequestPayload",
        "providerResponsePayload",
        "rawPrompt",
        "rawCompletion",
        "apiKey",
        "credential",
        "absoluteLocalPath",
        "queryLogContent",
      ],
      locatorRule: "only graph_vault-relative and scope-relative locators allowed",
    },
  };
  const manifestPath = join(generationRoot, "BOOKSHELF_MANIFEST.json");
  await writeJsonWithSidecar(manifestPath, manifest);
  const manifestSha256 = sha256Text(stableJson(manifest));
  await writeJsonWithSidecar(join(packageRoot, "BOOKSHELF_MANIFEST.json"), manifest);
  await writeJsonWithSidecar(
    join(packageRoot, "state", "bookshelf-quality-gate.json"),
    gate,
  );
  await writeJsonWithSidecar(join(packageRoot, "CURRENT.json"), {
    schemaVersion: BookshelfGraphSchemaVersion,
    scopeKind: "bookshelf",
    bookshelfId: input.bookshelfId,
    generation: input.generation,
    current: `generations/${input.generation}`,
    manifestPath: `generations/${input.generation}/BOOKSHELF_MANIFEST.json`,
    manifestSha256,
    readyState: "bookshelf_query_ready",
    queryReady: true,
    publishedAt: "2026-06-06T00:00:01.000Z",
  });
  await writeJsonWithSidecar(join(packageRoot, "PUBLISH_READY.json"), {
    schemaVersion: BookshelfGraphSchemaVersion,
    kind: "qmd_graphrag_upper_package_publish_ready",
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation: input.generation,
    readyState: "bookshelf_query_ready",
    queryReady: true,
    manifestPath: "BOOKSHELF_MANIFEST.json",
    manifestSha256,
    qualityGatePath: "state/bookshelf-quality-gate.json",
    currentPath: "CURRENT.json",
    publishedAt: "2026-06-06T00:00:01.000Z",
  });
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

        expect(capabilities).toHaveLength(1);
        expect(capabilities.every((capability) => capability.ready)).toBe(true);
        expect(capabilities[0]?.kind).toBe("graph_query");
        expect(query.method).toBe("global");
        expect(query.providerDetail?.runtimeMetrics?.aggregate
          .attemptedRequestCount).toBe(0);
        expect(query.providerDetail?.runtimeMetrics?.aggregate
          .promptTokens).toBeGreaterThan(0);
        expect(query.responseText).toContain("fixed-budget GraphRAG report search");
        expect(query.evidence.length).toBeGreaterThan(0);
        expect(query.evidence[0]?.graphCapabilityId)
          .toBe(capabilities[0]?.capabilityId);
        expect(query.evidence[0]?.bookId).toMatch(/^book-graph-/u);
        expect(query.evidence[0]?.sourceId).toMatch(/^sha256:/u);
        expect(query.evidence[0]?.documentId).toMatch(/^doc-/u);
        expect(query.evidence[0]?.contentHash).toBeTruthy();
        expect(query.evidence[0]?.graphTextUnitId).toBeTruthy();
        expect(query.evidence[0]?.locator?.path).toBe(
          "bookshelves/architecture-core/generations/" +
            `${manifest.bookshelfIdentity.generation}/community_reports.parquet`,
        );
        const synthesized = await queryBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          query: "What is architecture testing?",
          method: "global",
          synthesis: {
            enabled: true,
            maxInputTokens: manifest.fixedQueryBudget.maxInputTokens,
            maxOutputTokens: 128,
            runner: async (input) => {
              expect(input.scopeKind).toBe("bookshelf");
              expect(input.scopeId).toBe("architecture-core");
              expect(input.evidence.length).toBeGreaterThan(0);
              expect(input.evidence.length).toBeLessThanOrEqual(
                manifest.fixedQueryBudget.maxSemanticUnits,
              );
              return {
                text: `Synthesized bookshelf answer ${input.evidence[0]?.evidenceId}`,
                model: "deterministic-upper-synthesis",
                promptTokens: input.estimatedInputTokens,
                completionTokens: 11,
                durationMs: 5,
              };
            },
          },
        });
        expect(synthesized.responseText).toContain(
          "Synthesized bookshelf answer",
        );
        expect(synthesized.providerDetail?.runtimeMetrics?.aggregate
          .attemptedRequestCount).toBe(1);
        expect(synthesized.providerDetail?.runtimeMetrics?.stages.map(
          (stage) => stage.name,
        )).toContain("upper.llm_synthesis");
        expect(synthesized.evidence[0]?.metadata?.upperSynthesis).toBe(true);
        expect(JSON.stringify(synthesized)).not.toContain("Answer the user query");

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

        await expect(queryBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          query: "What is architecture testing?",
          method: "global",
          maxReports: manifest.fixedQueryBudget.maxSemanticUnits + 1,
        })).rejects.toMatchObject({
          code: "budget_exceeded_narrow_scope_required",
          diagnostics: expect.arrayContaining([
            expect.stringContaining(
              "requested_max_reports_exceeds_package_budget",
            ),
          ]),
        });
        await expect(queryBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          query: "What is architecture testing?",
          method: "global",
          maxInputTokens: manifest.fixedQueryBudget.maxInputTokens + 1,
        })).rejects.toMatchObject({
          code: "budget_exceeded_narrow_scope_required",
          diagnostics: expect.arrayContaining([
            expect.stringContaining(
              "requested_max_input_tokens_exceeds_package_budget",
            ),
          ]),
        });

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

  test("refuses query when actual upper artifact rows exceed fixed budget",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-bookshelf-row-budget-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookIds = ["book-br-a", "book-br-b", "book-br-c"];
        for (const [index, bookId] of bookIds.entries()) {
          await writeReadyHotplugBook({
            stateRoot,
            bookId,
            title: `Bookshelf Row Budget ${index + 1}`,
          });
        }
        await resolveBookshelfMembership({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          bookIds,
          now: () => "2026-06-06T00:00:52.000Z",
        });
        await buildBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          maxReportsPerBook: 2,
          maxSemanticUnits: 4,
          maxEdges: 16,
          now: () => "2026-06-06T00:00:53.000Z",
        });

        const currentRoot = await readBookshelfCurrentRoot(
          stateRoot,
          "architecture-core",
        );
        await duplicateParquetRows({
          path: join(currentRoot, "community_reports.parquet"),
          minRows: 8,
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
          "artifact_row_count_mismatch:community_reports.parquet",
        );
        expect(validation.diagnostics).toEqual(expect.arrayContaining([
          expect.stringContaining(
            "budget_exceeded_narrow_scope_required:community_reports.parquet",
          ),
        ]));
        await expect(queryBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          query: "What is architecture testing?",
          method: "global",
        })).rejects.toMatchObject({
          code: "budget_exceeded_narrow_scope_required",
          diagnostics: expect.arrayContaining([
            expect.stringContaining(
              "budget_exceeded_narrow_scope_required:community_reports.parquet",
            ),
          ]),
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000,
  );

  test("keeps bookshelf query budget fixed at simulated 10, 100, and 1000 book scale",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-bookshelf-budget-scale-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bridgePath = defaultBookshelfGraphBridgePath();
        const bookArtifacts = await writeSyntheticBookArtifacts(
          join(tmpRoot, "synthetic-book"),
        );
        const results = [];
        for (const scale of [10, 100, 1000]) {
          const bookshelfId = `bookshelf-scale-${scale}`;
          const generation = `bookshelf-scale-generation-${scale}`;
          const generationRoot = join(
            stateRoot,
            "bookshelves",
            bookshelfId,
            "generations",
            generation,
          );
          const memberManifests: Record<string, string> = {};
          const members = Array.from({ length: scale }, (_, index) => {
            const padded = String(index + 1).padStart(4, "0");
            const bookId = `book-${padded}`;
            const manifestSha256 = `sha256-book-${padded}`;
            memberManifests[bookId] = manifestSha256;
            return {
              bookId,
              title: `Synthetic Book ${padded}`,
              sourceHash: `synthetic-source-${padded}`,
              contentHash: `synthetic-content-${padded}`,
              manifestSha256,
              communityReportsPath: bookArtifacts.communityReportsPath,
              entitiesPath: join(tmpRoot, "unused-entities.parquet"),
              relationshipsPath: join(tmpRoot, "unused-relationships.parquet"),
              textUnitsPath: join(tmpRoot, "unused-text-units.parquet"),
              identityPath: bookArtifacts.identityPath,
              artifactDigests: {
                communityReports: "sha256:synthetic-community-reports",
                entities: "sha256:synthetic-entities",
                relationships: "sha256:synthetic-relationships",
                textUnits: "sha256:synthetic-text-units",
              },
            };
          });
          for (const member of members) {
            await writeSyntheticBookManifest({
              stateRoot,
              bookId: member.bookId,
              title: member.title,
              manifestSha256: member.manifestSha256,
              sourceHash: member.sourceHash,
              contentHash: member.contentHash,
            });
          }
          const inspection = await runBookshelfGraphParquetBridge({
            mode: "build",
            pythonBin: "python3",
            bridgePath,
            payload: {
              bookshelfId,
              generation,
              outputRoot: generationRoot,
              maxReportsPerBook: 2,
              maxSemanticUnits: 8,
              maxEdges: 16,
              embeddingFingerprint: "synthetic-embedding-fingerprint",
              members,
            },
          });
          const artifactRows = Object.fromEntries(
            Object.entries(inspection.artifacts).map(([name, artifact]) => [
              name,
              artifact.rowCount,
            ]),
          );
          await publishSyntheticBookshelfPackage({
            stateRoot,
            bookshelfId,
            generation,
            memberManifests,
            memberCount: scale,
            maxSemanticUnits: 8,
            maxInputTokens: 1000,
            maxBooksForDeepening: 3,
            maxMemberCommunityRefs: 24,
            artifactRows,
          });
          const validation = await validateBookshelfGraph({
            graphVault: stateRoot,
            bookshelfId,
            bridgePath,
          });
          const query = await queryBookshelfGraph({
            graphVault: stateRoot,
            bookshelfId,
            bridgePath,
            query: "architecture delivery practices",
            maxReports: 3,
            maxInputTokens: 1000,
          });
          const queryBudgetMetadata = query.evidence[0]?.metadata as {
            reportCount?: number;
            selectedReportCount?: number;
            estimatedInputTokens?: number;
          } | undefined;
          results.push({
            scale,
            semanticUnitCount:
              validation.semanticUnitCount,
            reportCount: queryBudgetMetadata?.reportCount ?? -1,
            selectedReportCount:
              queryBudgetMetadata?.selectedReportCount ?? -1,
            estimatedInputTokens:
              queryBudgetMetadata?.estimatedInputTokens ?? -1,
            evidenceCount: query.evidence.length,
            validationOk: validation.ok,
            validationDiagnostics: validation.diagnostics,
          });
        }

        for (const result of results) {
          expect(result.validationOk, String(result.scale)).toBe(true);
          expect(result.validationDiagnostics, String(result.scale)).toEqual([]);
          expect(result.semanticUnitCount, String(result.scale)).toBe(8);
          expect(result.reportCount, String(result.scale)).toBeLessThanOrEqual(8);
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
