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
  BookshelfGraphBuilderVersion,
  BookshelfGraphChecks,
  BookshelfGraphSchemaVersion,
} from "../src/graphrag/upper-index/bookshelf-graph-contracts.js";
import {
  resolveBookshelfMembership,
} from "../src/graphrag/upper-index/bookshelf-membership.js";
import {
  buildLibraryGraph,
  validateLibraryGraph,
} from "../src/graphrag/upper-index/library-graph.js";
import {
  LibraryGraphBuilderVersion,
  LibraryGraphChecks,
  LibraryGraphSchemaVersion,
} from "../src/graphrag/upper-index/library-graph-contracts.js";
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

async function duplicateParquetRows(input: {
  path: string;
  minRows: number;
}): Promise<void> {
  const script = [
    "import sys",
    "import pandas as pd",
    "path, min_rows = sys.argv[1], int(sys.argv[2])",
    "df = pd.read_parquet(path)",
    "frames = [df]",
    "while sum(len(frame) for frame in frames) < min_rows:",
    "    frames.append(df)",
    "pd.concat(frames, ignore_index=True).to_parquet(path, index=False)",
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

async function publishSyntheticBookshelfMemberPackage(input: {
  stateRoot: string;
  bookshelfId: string;
  generation: string;
  memberCount: number;
  maxSemanticUnits: number;
  evidenceMapRowCount: number;
}): Promise<{ manifestSha256: string }> {
  const packageRoot = join(input.stateRoot, "bookshelves", input.bookshelfId);
  const generationRoot = join(packageRoot, "generations", input.generation);
  await mkdir(join(generationRoot, "state"), { recursive: true });
  await mkdir(join(packageRoot, "state"), { recursive: true });
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
    artifactRowCounts: {
      "semantic_units.parquet": input.maxSemanticUnits,
      "community_reports.parquet": input.maxSemanticUnits,
      "evidence_map.parquet": input.evidenceMapRowCount,
    },
    fixedQueryBudgetSimulation: {
      status: "passed",
      maxSemanticUnits: input.maxSemanticUnits,
      selectedSemanticUnits: input.maxSemanticUnits,
      maxInputTokens: 1000,
      estimatedInputTokens: input.maxSemanticUnits * 64,
      maxBooksForDeepening: 3,
      selectedBooksForDeepening: Math.min(input.memberCount, 3),
    },
  };
  await writeJsonWithSidecar(
    join(generationRoot, "state", "bookshelf-quality-gate.json"),
    gate,
  );
  await writeJsonWithSidecar(
    join(packageRoot, "state", "bookshelf-quality-gate.json"),
    gate,
  );
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
      membershipManifestSha256: `membership-sha-${input.bookshelfId}`,
      membersDigest: `members-digest-${input.bookshelfId}`,
      decisionsDigest: `decisions-digest-${input.bookshelfId}`,
      splitPlanDigest: `split-plan-digest-${input.bookshelfId}`,
      memberManifestSha256: {},
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
      rowCount: input.evidenceMapRowCount,
    },
    fixedQueryBudget: {
      maxSemanticUnits: input.maxSemanticUnits,
      maxBooksForDeepening: 3,
      maxMemberCommunityRefs: 24,
      maxInputTokens: 1000,
      simulationStatus: "passed",
    },
    qualityGate: {
      path: "state/bookshelf-quality-gate.json",
      status: "passed",
    },
    files: [],
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
  await writeJsonWithSidecar(
    join(generationRoot, "BOOKSHELF_MANIFEST.json"),
    manifest,
  );
  await writeJsonWithSidecar(join(packageRoot, "BOOKSHELF_MANIFEST.json"), manifest);
  const manifestSha256 = sha256Text(stableJson(manifest));
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
  return { manifestSha256 };
}

async function publishSyntheticLibraryPackage(input: {
  stateRoot: string;
  libraryId: string;
  generation: string;
  members: Array<{
    bookshelfId: string;
    generation: string;
    manifestSha256: string;
    memberCount: number;
  }>;
  maxSemanticUnits: number;
  maxInputTokens: number;
  maxBookshelves: number;
  maxShelfCommunityRefs: number;
  artifactRows: Record<string, number>;
}): Promise<void> {
  const packageRoot = join(input.stateRoot, "library", input.libraryId);
  const generationRoot = join(packageRoot, "generations", input.generation);
  await mkdir(join(generationRoot, "state"), { recursive: true });
  await mkdir(join(generationRoot, "membership"), { recursive: true });
  await mkdir(join(packageRoot, "state"), { recursive: true });
  const memberManifestSha256 = Object.fromEntries(
    input.members.map((member) => [member.bookshelfId, member.manifestSha256]),
  );
  const libraryMembers = {
    schemaVersion: LibraryGraphSchemaVersion,
    kind: "qmd_graphrag_library_members",
    libraryId: input.libraryId,
    generation: `membership-${input.generation}`,
    directBookLimit: 0,
    bookshelfCount: input.members.length,
    directBookCount: 0,
    members: {
      bookshelves: input.members.map((member) => ({
        bookshelfId: member.bookshelfId,
        manifestSha256: member.manifestSha256,
        generation: member.generation,
        membershipGeneration: `membership-${member.generation}`,
        queryReady: true,
        readyState: "bookshelf_query_ready",
        memberCount: member.memberCount,
        semanticUnitBudget: input.maxSemanticUnits,
        evidenceMapRowCount: input.artifactRows["evidence_map.parquet"] ?? 1,
        membershipSourceKind: "user_explicit",
        userLocked: true,
        manifestPath:
          `bookshelves/${member.bookshelfId}/generations/` +
          `${member.generation}/BOOKSHELF_MANIFEST.json`,
        qualityGatePath:
          `bookshelves/${member.bookshelfId}/generations/` +
          `${member.generation}/state/bookshelf-quality-gate.json`,
        semanticArtifacts: {
          semanticUnits:
            `bookshelves/${member.bookshelfId}/generations/` +
            `${member.generation}/semantic_units.parquet`,
          semanticEdges:
            `bookshelves/${member.bookshelfId}/generations/` +
            `${member.generation}/semantic_edges.parquet`,
          communityReports:
            `bookshelves/${member.bookshelfId}/generations/` +
            `${member.generation}/community_reports.parquet`,
          evidenceMap:
            `bookshelves/${member.bookshelfId}/generations/` +
            `${member.generation}/evidence_map.parquet`,
        },
      })),
      directBooks: [],
    },
    expandedMaterializedBookshelfIds: input.members.map(
      (member) => member.bookshelfId,
    ),
  };
  const partitionPlan = {
    schemaVersion: LibraryGraphSchemaVersion,
    kind: "qmd_graphrag_library_partition_plan",
    libraryId: input.libraryId,
    generation: `membership-${input.generation}`,
    status: "not_required",
    shelfCount: input.members.length,
    shelfLimit: input.members.length,
    directBookLimit: 0,
    virtualParentBookshelfIds: [],
    partitions: [],
  };
  const membershipManifest = {
    schemaVersion: LibraryGraphSchemaVersion,
    kind: "qmd_graphrag_library_membership_manifest",
    libraryIdentity: {
      libraryId: input.libraryId,
      generation: `membership-${input.generation}`,
      createdAt: "2026-06-06T00:00:00.000Z",
      materializationStatus: "library_membership_resolved",
      queryReady: false,
    },
    membership: {
      bookshelfCount: input.members.length,
      directBookCount: 0,
      membersPath: "library_members.json",
      policyKind: "user_explicit",
      policyDigest: "synthetic-policy",
      membersDigest: sha256Text(stableJson(libraryMembers)),
      memberManifestSha256,
      expandedMaterializedBookshelfIds:
        input.members.map((member) => member.bookshelfId),
    },
    partitionPlan: {
      partitionPlanPath: "library_partition_plan.json",
      partitionPlanDigest: sha256Text(stableJson(partitionPlan)),
      shelfLimit: input.members.length,
      directBookLimit: 0,
      status: "not_required",
    },
    nextStage: {
      stageId: "library_graph_build",
      requiredManifest: "LIBRARY_MANIFEST.json",
      rule: "synthetic scale fixture",
    },
    qualityGate: {
      path: "state/library-membership-gate.json",
      status: "passed",
    },
    sensitivityPolicy: {
      forbiddenFields: [],
      locatorRule: "only graph_vault-relative locators allowed",
    },
    files: [],
  };
  const membershipGate = {
    schemaVersion: LibraryGraphSchemaVersion,
    scopeKind: "library",
    scopeId: input.libraryId,
    generation: `membership-${input.generation}`,
    stageId: "library_membership_resolution",
    readyState: "library_membership_resolved",
    queryReady: false,
    status: "passed",
    checkedAt: "2026-06-06T00:00:00.000Z",
    checks: [],
    diagnostics: [],
  };
  await writeJsonWithSidecar(join(generationRoot, "library_members.json"), libraryMembers);
  await writeJsonWithSidecar(
    join(generationRoot, "library_partition_plan.json"),
    partitionPlan,
  );
  await writeJsonWithSidecar(
    join(generationRoot, "membership", "LIBRARY_MEMBERSHIP_MANIFEST.json"),
    membershipManifest,
  );
  await writeJsonWithSidecar(
    join(generationRoot, "state", "library-membership-gate.json"),
    membershipGate,
  );

  const gate = {
    schemaVersion: LibraryGraphSchemaVersion,
    scopeKind: "library",
    scopeId: input.libraryId,
    generation: input.generation,
    stageId: "library_graph_build",
    readyState: "library_query_ready",
    queryReady: true,
    status: "passed",
    checkedAt: "2026-06-06T00:00:01.000Z",
    checks: LibraryGraphChecks.map((checkId) => ({ checkId, status: "passed" })),
    diagnostics: [],
    artifactRowCounts: input.artifactRows,
    fixedQueryBudgetSimulation: {
      status: "passed",
      maxSemanticUnits: input.maxSemanticUnits,
      selectedSemanticUnits: input.artifactRows["semantic_units.parquet"] ?? 0,
      maxInputTokens: input.maxInputTokens,
      estimatedInputTokens:
        (input.artifactRows["semantic_units.parquet"] ?? 0) * 64,
      maxBookshelves: input.maxBookshelves,
      selectedBookshelvesForDeepening: Math.min(
        input.members.length,
        input.maxBookshelves,
      ),
    },
  };
  await writeJsonWithSidecar(
    join(generationRoot, "state", "library-quality-gate.json"),
    gate,
  );

  const files = [
    await packageFileRecord(generationRoot, "library_members.json"),
    await packageFileRecord(generationRoot, "library_partition_plan.json"),
    await packageFileRecord(
      generationRoot,
      "membership/LIBRARY_MEMBERSHIP_MANIFEST.json",
    ),
    await packageFileRecord(
      generationRoot,
      "state/library-membership-gate.json",
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
    await packageFileRecord(generationRoot, "state/library-quality-gate.json"),
  ];
  const manifest = {
    schemaVersion: LibraryGraphSchemaVersion,
    kind: "qmd_graphrag_library_manifest",
    libraryIdentity: {
      libraryId: input.libraryId,
      generation: input.generation,
      membershipGeneration: `membership-${input.generation}`,
      createdAt: "2026-06-06T00:00:01.000Z",
      materializationStatus: "library_query_ready",
      queryReady: true,
    },
    membership: {
      bookshelfCount: input.members.length,
      directBookCount: 0,
      membersPath: "library_members.json",
      membershipManifestPath: "membership/LIBRARY_MEMBERSHIP_MANIFEST.json",
      membershipManifestSha256: sha256Text(stableJson(membershipManifest)),
      membersDigest: sha256Text(stableJson(libraryMembers)),
      partitionPlanDigest: sha256Text(stableJson(partitionPlan)),
      memberBookshelfManifestSha256: memberManifestSha256,
      expandedMaterializedBookshelfIds:
        input.members.map((member) => member.bookshelfId),
    },
    buildConfig: {
      builderVersion: LibraryGraphBuilderVersion,
      maxReportsPerShelf: 2,
      maxSemanticUnits: input.maxSemanticUnits,
      maxEdges: 16,
      embeddingFingerprint: "synthetic-embedding-fingerprint",
      summaryFingerprint: sha256Text(LibraryGraphBuilderVersion),
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
      maxBookshelves: input.maxBookshelves,
      maxShelfCommunityRefs: input.maxShelfCommunityRefs,
      maxInputTokens: input.maxInputTokens,
      simulationStatus: "passed",
    },
    qualityGate: {
      path: "state/library-quality-gate.json",
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
  await writeJsonWithSidecar(join(generationRoot, "LIBRARY_MANIFEST.json"), manifest);
  await writeJsonWithSidecar(join(packageRoot, "LIBRARY_MANIFEST.json"), manifest);
  await writeJsonWithSidecar(
    join(packageRoot, "state", "library-quality-gate.json"),
    gate,
  );
  const manifestSha256 = sha256Text(stableJson(manifest));
  await writeJsonWithSidecar(join(packageRoot, "CURRENT.json"), {
    schemaVersion: LibraryGraphSchemaVersion,
    scopeKind: "library",
    libraryId: input.libraryId,
    generation: input.generation,
    current: `generations/${input.generation}`,
    manifestPath: `generations/${input.generation}/LIBRARY_MANIFEST.json`,
    manifestSha256,
    readyState: "library_query_ready",
    queryReady: true,
    publishedAt: "2026-06-06T00:00:01.000Z",
  });
  await writeJsonWithSidecar(join(packageRoot, "PUBLISH_READY.json"), {
    schemaVersion: LibraryGraphSchemaVersion,
    kind: "qmd_graphrag_upper_package_publish_ready",
    scopeKind: "library",
    scopeId: input.libraryId,
    generation: input.generation,
    readyState: "library_query_ready",
    queryReady: true,
    manifestPath: "LIBRARY_MANIFEST.json",
    manifestSha256,
    qualityGatePath: "state/library-quality-gate.json",
    currentPath: "CURRENT.json",
    publishedAt: "2026-06-06T00:00:01.000Z",
  });
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

        expect(capabilities).toHaveLength(1);
        expect(capabilities.every((capability) => capability.ready)).toBe(true);
        expect(capabilities[0]?.kind).toBe("graph_query");
        expect(query.method).toBe("global");
        expect(query.providerDetail?.runtimeMetrics?.aggregate
          .attemptedRequestCount).toBe(0);
        expect(query.responseText).toContain(
          "Library software-engineering-library fixed-budget",
        );
        expect(query.evidence.length).toBeGreaterThan(0);
        expect(query.evidence[0]?.graphCapabilityId)
          .toBe(capabilities[0]?.capabilityId);
        expect(query.evidence[0]?.bookId).toMatch(/^book-lg-/u);
        expect(query.evidence[0]?.metadata?.scopeKind).toBe("library");
        expect(query.evidence[0]?.metadata?.targetBookshelfId).toMatch(/core$/u);
        expect(query.evidence[0]?.locator?.path).toBe(
          "library/software-engineering-library/generations/" +
            `${manifest.libraryIdentity.generation}/community_reports.parquet`,
        );
        const synthesized = await queryLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          query: "How do architecture and delivery practices relate?",
          method: "global",
          synthesis: {
            enabled: true,
            maxInputTokens: manifest.fixedQueryBudget.maxInputTokens,
            maxOutputTokens: 128,
            runner: async (input) => {
              expect(input.scopeKind).toBe("library");
              expect(input.scopeId).toBe("software-engineering-library");
              expect(input.evidence.length).toBeGreaterThan(0);
              expect(input.evidence.length).toBeLessThanOrEqual(
                manifest.fixedQueryBudget.maxSemanticUnits,
              );
              return {
                text: `Synthesized library answer ${input.evidence[0]?.evidenceId}`,
                model: "deterministic-upper-synthesis",
                promptTokens: input.estimatedInputTokens,
                completionTokens: 13,
                durationMs: 6,
              };
            },
          },
        });
        expect(synthesized.responseText).toContain("Synthesized library answer");
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
          maxReports: manifest.fixedQueryBudget.maxSemanticUnits + 1,
        })).rejects.toMatchObject({
          code: "budget_exceeded_narrow_scope_required",
          diagnostics: expect.arrayContaining([
            expect.stringContaining(
              "requested_max_reports_exceeds_package_budget",
            ),
          ]),
        });
        await expect(queryLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          query: "How do architecture and delivery practices relate?",
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
        const stateRoot = join(tmpRoot, "graph_vault");
        const bridgePath = defaultBookshelfGraphBridgePath();
        const shelfArtifacts = await writeSyntheticShelfArtifacts(
          join(tmpRoot, "synthetic-shelf"),
        );
        const results = [];
        for (const scale of [10, 100, 1000]) {
          const libraryId = `library-scale-${scale}`;
          const generation = `library-scale-generation-${scale}`;
          const generationRoot = join(
            stateRoot,
            "library",
            libraryId,
            "generations",
            generation,
          );
          const shelfCount = 4;
          const baseBookCount = Math.floor(scale / shelfCount);
          const remainder = scale % shelfCount;
          const members = [];
          for (let index = 0; index < shelfCount; index += 1) {
            const padded = String(index + 1).padStart(4, "0");
            const bookshelfId = `shelf-${scale}-${padded}`;
            const memberGeneration =
              `bookshelf-synthetic-generation-${scale}-${padded}`;
            const memberCount = baseBookCount + (index < remainder ? 1 : 0);
            const memberPackage = await publishSyntheticBookshelfMemberPackage({
              stateRoot,
              bookshelfId,
              generation: memberGeneration,
              memberCount,
              maxSemanticUnits: 8,
              evidenceMapRowCount: 2,
            });
            members.push({
              bookshelfId,
              generation: memberGeneration,
              manifestSha256: memberPackage.manifestSha256,
              memberCount,
              communityReportsPath: shelfArtifacts.communityReportsPath,
              evidenceMapPath: shelfArtifacts.evidenceMapPath,
              artifactDigests: {
                semanticUnits: "sha256:synthetic-semantic-units",
                semanticEdges: "sha256:synthetic-semantic-edges",
                communityReports: "sha256:synthetic-community-reports",
                evidenceMap: "sha256:synthetic-evidence-map",
              },
            });
          }
          const inspection = await runBookshelfGraphParquetBridge({
            mode: "build-library",
            pythonBin: "python3",
            bridgePath,
            payload: {
              libraryId,
              generation,
              outputRoot: generationRoot,
              maxReportsPerShelf: 2,
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
          await publishSyntheticLibraryPackage({
            stateRoot,
            libraryId,
            generation,
            members: members.map((member) => ({
              bookshelfId: member.bookshelfId,
              generation: member.generation,
              manifestSha256: member.manifestSha256,
              memberCount: member.memberCount,
            })),
            maxSemanticUnits: 8,
            maxInputTokens: 1000,
            maxBookshelves: 4,
            maxShelfCommunityRefs: 24,
            artifactRows,
          });
          const validation = await validateLibraryGraph({
            graphVault: stateRoot,
            libraryId,
            bridgePath,
          });
          const query = await queryLibraryGraph({
            graphVault: stateRoot,
            libraryId,
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
            representedBookCount: members.reduce(
              (total, member) => total + member.memberCount,
              0,
            ),
            validationOk: validation.ok,
            validationDiagnostics: validation.diagnostics,
          });
          await expect(queryLibraryGraph({
            graphVault: stateRoot,
            libraryId,
            bridgePath,
            query: "architecture delivery practices",
            maxReports: 3,
            maxInputTokens: 1,
          })).rejects.toMatchObject({
            code: "budget_exceeded_narrow_scope_required",
          });
        }

        for (const result of results) {
          expect(result.validationOk, String(result.scale)).toBe(true);
          expect(result.validationDiagnostics, String(result.scale)).toEqual([]);
          expect(result.representedBookCount, String(result.scale))
            .toBe(result.scale);
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

  test("refuses query when actual library artifact rows exceed fixed budget",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-library-row-budget-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "architecture-core",
          bookIds: ["book-lr-a1", "book-lr-a2", "book-lr-a3"],
          titlePrefix: "Library Row Budget A",
          clockSecond: 52,
        });
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "delivery-core",
          bookIds: ["book-lr-b1", "book-lr-b2", "book-lr-b3"],
          titlePrefix: "Library Row Budget B",
          clockSecond: 54,
        });
        await resolveLibraryMembership({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          bookshelfIds: ["architecture-core", "delivery-core"],
          now: () => "2026-06-06T00:00:56.000Z",
        });
        await buildLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          maxReportsPerShelf: 2,
          maxSemanticUnits: 4,
          maxEdges: 16,
          now: () => "2026-06-06T00:00:57.000Z",
        });

        const currentRoot = await readLibraryCurrentRoot(
          stateRoot,
          "software-engineering-library",
        );
        await duplicateParquetRows({
          path: join(currentRoot, "community_reports.parquet"),
          minRows: 8,
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
          "artifact_row_count_mismatch:community_reports.parquet",
        );
        expect(validation.diagnostics).toEqual(expect.arrayContaining([
          expect.stringContaining(
            "budget_exceeded_narrow_scope_required:community_reports.parquet",
          ),
        ]));
        await expect(queryLibraryGraph({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          query: "How do architecture and delivery practices relate?",
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
