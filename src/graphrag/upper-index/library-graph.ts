import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { readHotplugPackageUnknown } from "../book-hotplug-package-readonly.js";
import {
  BookshelfGraphManifestSchema,
  BookshelfQualityGateSchema,
  type BookshelfGraphManifest,
} from "./bookshelf-graph-contracts.js";
import {
  defaultBookshelfGraphBridgePath,
  runBookshelfGraphParquetBridge,
} from "./bookshelf-graph-parquet.js";
import {
  rebuildLibraryCatalogProjection,
} from "./upper-catalog-projection.js";
import {
  LibraryGraphBuilderVersion,
  LibraryGraphChecks,
  LibraryGraphManifestSchema,
  LibraryGraphSchemaVersion,
  LibraryQualityGateSchema,
  LibraryDiagnosticsSchema,
  ForbiddenFields,
  RequiredParquetColumns,
  type LibraryGraphManifest,
  type LibraryQualityGate,
} from "./library-graph-contracts.js";
import {
  readLibraryMembershipCurrent,
  type LibraryBookshelfMember,
} from "./library-membership.js";
import {
  validateLibraryGraphAtRoot,
  validateLibraryGraph,
} from "./library-graph-validator.js";
import {
  libraryPackageRoot,
} from "./upper-package-paths.js";

export { validateLibraryGraph } from "./library-graph-validator.js";

export type BuildLibraryGraphInput = {
  graphVault: string;
  libraryId: string;
  pythonBin?: string;
  bridgePath?: string;
  maxReportsPerShelf?: number;
  maxSemanticUnits?: number;
  maxEdges?: number;
  maxInputTokens?: number;
  maxBookshelvesForDeepening?: number;
  maxShelfCommunityRefs?: number;
  now?: () => string;
};

export type BuildLibraryGraphResult = {
  libraryId: string;
  generation: string;
  root: string;
  manifest: LibraryGraphManifest;
  qualityGate: LibraryQualityGate;
};

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256Buffer(await readFile(path));
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeScopeRelativePath(path: string): string | null {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.startsWith("../") ||
    path.includes("/../") ||
    path === ".." ||
    /^[A-Za-z]:\//u.test(path) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
  ) {
    return null;
  }
  return path;
}

function libraryRunId(libraryId: string, generation: string): string {
  return `${libraryId}-${generation}`;
}

async function writeAtomicText(path: string, text: string): Promise<{
  path: string;
  sha256: string;
  bytes: number;
}> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const checksum = sha256Text(text);
  await writeFile(tmpPath, text, "utf8");
  await rename(tmpPath, path);
  await writeFile(`${path}.sha256`, `${checksum}\n`, "utf8");
  return { path, sha256: checksum, bytes: Buffer.byteLength(text) };
}

async function writeJson(path: string, value: unknown): Promise<{
  path: string;
  sha256: string;
  bytes: number;
}> {
  return writeAtomicText(path, stableJson(value));
}

async function writeJsonl(
  path: string,
  values: readonly unknown[],
): Promise<{ path: string; sha256: string; bytes: number }> {
  return writeAtomicText(
    path,
    values.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
}

function relativeLibraryFile(root: string, written: {
  path: string;
  sha256: string;
  bytes: number;
}): { path: string; sha256: string; bytes: number } {
  return {
    path: written.path.slice(root.length + 1),
    sha256: written.sha256,
    bytes: written.bytes,
  };
}

async function fileRecord(root: string, relativePath: string): Promise<{
  path: string;
  sha256: string;
  bytes: number;
}> {
  const path = join(root, relativePath);
  const info = await stat(path);
  const sha256 = await sha256File(path);
  await writeFile(`${path}.sha256`, `${sha256}\n`, "utf8");
  return { path: relativePath, sha256, bytes: info.size };
}

async function directoryFileRecords(
  root: string,
  relativeRoot: string,
): Promise<{ path: string; sha256: string; bytes: number }[]> {
  const { readdir } = await import("node:fs/promises");
  const result: { path: string; sha256: string; bytes: number }[] = [];
  const visit = async (relativeDir: string) => {
    const entries = await readdir(join(root, relativeDir), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const next = join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await visit(next);
      } else if (entry.isFile()) {
        result.push(await fileRecord(root, next));
      }
    }
  };
  await visit(relativeRoot);
  return result;
}

async function copyMembershipFile(
  sourceRoot: string,
  stagingRoot: string,
  relativePath: string,
): Promise<{ path: string; sha256: string; bytes: number }> {
  const normalized = normalizeScopeRelativePath(relativePath);
  if (normalized == null) {
    throw new Error(`upper_quality_gate_failed:invalid_membership_path:${relativePath}`);
  }
  const source = join(sourceRoot, normalized);
  const target = join(stagingRoot, normalized);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: false });
  if (existsSync(`${source}.sha256`)) {
    await cp(`${source}.sha256`, `${target}.sha256`, { recursive: false });
  } else {
    await writeFile(`${target}.sha256`, `${await sha256File(target)}\n`, "utf8");
  }
  const info = await stat(target);
  return { path: target, sha256: await sha256File(target), bytes: info.size };
}

async function archiveMembershipCurrent(input: {
  sourceRoot: string;
  stagingRoot: string;
}): Promise<{ path: string; sha256: string; bytes: number }> {
  const archiveRoot = join(input.stagingRoot, "membership");
  await cp(input.sourceRoot, archiveRoot, { recursive: true });
  const path = join(archiveRoot, "LIBRARY_MEMBERSHIP_MANIFEST.json");
  const info = await stat(path);
  const sha256 = await sha256File(path);
  await writeFile(`${path}.sha256`, `${sha256}\n`, "utf8");
  return { path, sha256, bytes: info.size };
}

async function readMemberBookshelf(input: {
  graphVault: string;
  member: LibraryBookshelfMember;
}): Promise<{
  member: LibraryBookshelfMember;
  manifest: BookshelfGraphManifest;
  manifestSha256: string;
  artifactDigests: Record<string, string>;
  artifactPaths: Record<string, string>;
}> {
  const manifestPath = join(input.graphVault, input.member.manifestPath);
  const gatePath = join(input.graphVault, input.member.qualityGatePath);
  const manifestSha256 = await sha256File(manifestPath);
  if (manifestSha256 !== input.member.manifestSha256) {
    throw new Error(
      `upper_index_stale:member_bookshelf_manifest_sha_changed:${input.member.bookshelfId}`,
    );
  }
  const manifest = BookshelfGraphManifestSchema.safeParse(
    await readHotplugPackageUnknown(manifestPath),
  );
  const gate = BookshelfQualityGateSchema.safeParse(
    await readHotplugPackageUnknown(gatePath),
  );
  if (!manifest.success) {
    throw new Error(
      `upper_quality_gate_failed:member_bookshelf_manifest_invalid:${input.member.bookshelfId}`,
    );
  }
  if (!gate.success || !gate.data.queryReady) {
    throw new Error(
      `upper_quality_gate_failed:member_bookshelf_gate_failed:${input.member.bookshelfId}`,
    );
  }
  const artifactPaths = {
    semanticUnits: join(input.graphVault, input.member.semanticArtifacts.semanticUnits),
    semanticEdges: join(input.graphVault, input.member.semanticArtifacts.semanticEdges),
    communityReports: join(
      input.graphVault,
      input.member.semanticArtifacts.communityReports,
    ),
    evidenceMap: join(input.graphVault, input.member.semanticArtifacts.evidenceMap),
  };
  for (const [kind, path] of Object.entries(artifactPaths)) {
    if (!existsSync(path)) {
      throw new Error(
        `upper_quality_gate_failed:member_bookshelf_artifact_missing:${input.member.bookshelfId}:${kind}`,
      );
    }
  }
  return {
    member: input.member,
    manifest: manifest.data,
    manifestSha256,
    artifactDigests: {
      semanticUnits: await sha256File(artifactPaths.semanticUnits),
      semanticEdges: await sha256File(artifactPaths.semanticEdges),
      communityReports: await sha256File(artifactPaths.communityReports),
      evidenceMap: await sha256File(artifactPaths.evidenceMap),
    },
    artifactPaths,
  };
}

function graphGeneration(input: {
  libraryId: string;
  membershipGeneration: string;
  memberManifestSha256: Record<string, string>;
  maxReportsPerShelf: number;
  maxSemanticUnits: number;
  maxEdges: number;
  maxInputTokens: number;
  maxBookshelvesForDeepening: number;
  maxShelfCommunityRefs: number;
}): string {
  return `library-${sha256Text(stableJson({
    builderVersion: LibraryGraphBuilderVersion,
    ...input,
  })).slice(0, 16)}`;
}

function budgetSimulation(input: {
  artifactRows: Record<string, number>;
  maxSemanticUnits: number;
  maxInputTokens: number;
  maxBookshelvesForDeepening: number;
  bookshelfCount: number;
}): LibraryQualityGate["fixedQueryBudgetSimulation"] {
  const selectedSemanticUnits = Math.min(
    input.artifactRows["semantic_units.parquet"] ?? 0,
    input.maxSemanticUnits,
  );
  const estimatedInputTokens = selectedSemanticUnits * 640;
  return {
    status: "passed",
    maxSemanticUnits: input.maxSemanticUnits,
    selectedSemanticUnits,
    maxInputTokens: input.maxInputTokens,
    estimatedInputTokens,
    maxBookshelvesForDeepening: input.maxBookshelvesForDeepening,
    selectedBookshelvesForDeepening: Math.min(
      input.bookshelfCount,
      input.maxBookshelvesForDeepening,
    ),
  };
}

function ensureBudgetPasses(
  simulation: LibraryQualityGate["fixedQueryBudgetSimulation"],
): void {
  if (simulation.estimatedInputTokens > simulation.maxInputTokens) {
    throw new Error("budget_exceeded_narrow_scope_required:library_graph_build");
  }
}

function requiredColumns(name: keyof typeof RequiredParquetColumns): string[] {
  return [...RequiredParquetColumns[name]];
}

function assertNoForbiddenText(artifactKind: string, text: string): void {
  for (const field of ForbiddenFields) {
    if (text.includes(field)) {
      throw new Error(`upper_quality_gate_failed:sensitive_field:${artifactKind}:${field}`);
    }
  }
}

function sensitivityScanManifest(manifest: LibraryGraphManifest): unknown {
  return {
    ...manifest,
    sensitivityPolicy: {
      ...manifest.sensitivityPolicy,
      forbiddenFields: manifest.sensitivityPolicy.forbiddenFields.map(
        () => "<forbidden-field-policy-name>",
      ),
    },
  };
}

export async function buildLibraryGraph(
  input: BuildLibraryGraphInput,
): Promise<BuildLibraryGraphResult> {
  const graphVault = resolve(input.graphVault);
  const membership = await readLibraryMembershipCurrent({
    graphVault,
    libraryId: input.libraryId,
  });
  const maxReportsPerShelf = input.maxReportsPerShelf ?? 8;
  const maxSemanticUnits = input.maxSemanticUnits ?? 32;
  const maxEdges = input.maxEdges ?? 96;
  const maxInputTokens = input.maxInputTokens ?? 64000;
  const maxBookshelvesForDeepening = input.maxBookshelvesForDeepening ?? 3;
  const maxShelfCommunityRefs = input.maxShelfCommunityRefs ?? 24;
  const memberManifestSha256 = Object.fromEntries(
    membership.membersFile.members.bookshelves.map((member) => [
      member.bookshelfId,
      member.manifestSha256,
    ]),
  );
  const generation = graphGeneration({
    libraryId: input.libraryId,
    membershipGeneration: membership.membersFile.generation,
    memberManifestSha256,
    maxReportsPerShelf,
    maxSemanticUnits,
    maxEdges,
    maxInputTokens,
    maxBookshelvesForDeepening,
    maxShelfCommunityRefs,
  });
  const createdAt = input.now?.() ?? new Date().toISOString();
  const runId = libraryRunId(input.libraryId, generation);
  const root = libraryPackageRoot(graphVault, input.libraryId);
  const stagingRoot = join(root, "staging", runId);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(join(stagingRoot, "state"), { recursive: true });
  await mkdir(join(stagingRoot, "runs", runId, "checkpoints"), {
    recursive: true,
  });

  const validatedMembers = [];
  for (const member of membership.membersFile.members.bookshelves) {
    validatedMembers.push(await readMemberBookshelf({ graphVault, member }));
  }

  const copiedMembershipFiles = [
    await archiveMembershipCurrent({
      sourceRoot: membership.currentRoot,
      stagingRoot,
    }),
  ];
  for (const path of [
    "library_members.json",
    "library_partition_plan.json",
    "state/library-membership-gate.json",
  ]) {
    copiedMembershipFiles.push(
      await copyMembershipFile(membership.currentRoot, stagingRoot, path),
    );
  }

  const embeddingFingerprint = sha256Text(stableJson({
    builderVersion: LibraryGraphBuilderVersion,
    embedding: "deterministic_hash_vector_sidecar",
  }));
  const inspection = await runBookshelfGraphParquetBridge({
    mode: "build-library",
    pythonBin: input.pythonBin ?? "python3",
    bridgePath: input.bridgePath ?? defaultBookshelfGraphBridgePath(),
    payload: {
      libraryId: input.libraryId,
      generation,
      outputRoot: stagingRoot,
      maxReportsPerShelf,
      maxSemanticUnits,
      maxEdges,
      embeddingFingerprint,
      members: validatedMembers.map((item) => ({
        bookshelfId: item.member.bookshelfId,
        generation: item.member.generation,
        manifestSha256: item.manifestSha256,
        communityReportsPath: item.artifactPaths.communityReports,
        evidenceMapPath: item.artifactPaths.evidenceMap,
        artifactDigests: item.artifactDigests,
      })),
    },
  });
  if (!inspection.ok) {
    throw new Error(
      `upper_quality_gate_failed:library_parquet_schema:${inspection.diagnostics.join(",")}`,
    );
  }
  const artifactRows = Object.fromEntries(
    Object.entries(inspection.artifacts).map(([key, value]) => [
      key,
      value.rowCount,
    ]),
  );
  const simulation = budgetSimulation({
    artifactRows,
    maxSemanticUnits,
    maxInputTokens,
    maxBookshelvesForDeepening,
    bookshelfCount: membership.membersFile.bookshelfCount,
  });
  ensureBudgetPasses(simulation);

  const qualityGate = LibraryQualityGateSchema.parse({
    schemaVersion: LibraryGraphSchemaVersion,
    scopeKind: "library",
    scopeId: input.libraryId,
    generation,
    stageId: "library_graph_build",
    readyState: "library_query_ready",
    queryReady: true,
    status: "passed",
    checkedAt: createdAt,
    checks: LibraryGraphChecks.map((checkId) => ({ checkId, status: "passed" })),
    diagnostics: [],
    artifactRowCounts: artifactRows,
    fixedQueryBudgetSimulation: simulation,
  });
  const graphDigest = sha256Text(stableJson({
    generation,
    artifacts: inspection.artifacts,
    members: memberManifestSha256,
  }));
  const diagnostics = LibraryDiagnosticsSchema.parse({
    schemaVersion: LibraryGraphSchemaVersion,
    scopeKind: "library",
    scopeId: input.libraryId,
    generation,
    status: "passed",
    failedCheckId: null,
    severity: "info",
    typedErrorCode: null,
    affectedArtifactKind: "library_graph",
    affectedArtifactDigest: graphDigest,
    expectedDigest: graphDigest,
    observedDigest: graphDigest,
    redactedLocator: `generations/${generation}/LIBRARY_MANIFEST.json`,
    remediationCommand: null,
    checkedAt: createdAt,
  });
  const status = {
    schemaVersion: LibraryGraphSchemaVersion,
    runId,
    stageId: "library_graph_build",
    scopeKind: "library",
    scopeId: input.libraryId,
    generation,
    status: "passed",
    readyState: "library_query_ready",
    queryReady: true,
    bookshelfCount: membership.membersFile.bookshelfCount,
    semanticUnitCount: artifactRows["semantic_units.parquet"] ?? 0,
    startedAt: createdAt,
    completedAt: createdAt,
  };
  const recoverySummary = {
    schemaVersion: LibraryGraphSchemaVersion,
    runId,
    stageId: "library_graph_build",
    scopeKind: "library",
    scopeId: input.libraryId,
    generation,
    status: "passed",
    recoveryDecision: "not_required",
    checkpointCount: validatedMembers.length,
    eventCount: 2,
    currentGenerationPublished: true,
    queryReady: true,
    completedAt: createdAt,
  };
  const writtenGate = await writeJson(
    join(stagingRoot, "state", "library-quality-gate.json"),
    qualityGate,
  );
  const writtenDiagnostics = await writeJson(
    join(stagingRoot, "state", "diagnostics.json"),
    diagnostics,
  );
  const writtenEvents = await writeJsonl(
    join(stagingRoot, "runs", runId, "events.jsonl"),
    [
      {
        schemaVersion: LibraryGraphSchemaVersion,
        runId,
        stageId: "library_graph_build",
        scopeKind: "library",
        scopeId: input.libraryId,
        generation,
        event: "library_graph_build_started",
        status: "running",
        at: createdAt,
      },
      {
        schemaVersion: LibraryGraphSchemaVersion,
        runId,
        stageId: "library_graph_build",
        scopeKind: "library",
        scopeId: input.libraryId,
        generation,
        event: "library_graph_published",
        status: "passed",
        queryReady: true,
        at: createdAt,
      },
    ],
  );
  const writtenStatus = await writeJson(
    join(stagingRoot, "runs", runId, "status.json"),
    status,
  );
  const writtenRecovery = await writeJson(
    join(stagingRoot, "runs", runId, "recovery-summary.json"),
    recoverySummary,
  );
  const writtenCheckpoints = [];
  for (const item of validatedMembers) {
    writtenCheckpoints.push(await writeJson(
      join(
        stagingRoot,
        "runs",
        runId,
        "checkpoints",
        `${item.member.bookshelfId}.json`,
      ),
      {
        schemaVersion: LibraryGraphSchemaVersion,
        runId,
        stageId: "library_graph_build",
        scopeKind: "library",
        scopeId: input.libraryId,
        generation,
        status: "passed",
        bookshelfId: item.member.bookshelfId,
        manifestSha256: item.manifestSha256,
        artifactDigests: item.artifactDigests,
        checkedAt: createdAt,
      },
    ));
  }
  const files = [
    ...copiedMembershipFiles.map((item) => relativeLibraryFile(stagingRoot, item)),
    await fileRecord(stagingRoot, "semantic_units.parquet"),
    await fileRecord(stagingRoot, "semantic_edges.parquet"),
    await fileRecord(stagingRoot, "communities.parquet"),
    await fileRecord(stagingRoot, "community_reports.parquet"),
    await fileRecord(stagingRoot, "evidence_map.parquet"),
    ...(await directoryFileRecords(stagingRoot, "semantic_unit_embeddings.lance")),
    relativeLibraryFile(stagingRoot, writtenGate),
    relativeLibraryFile(stagingRoot, writtenDiagnostics),
    relativeLibraryFile(stagingRoot, writtenEvents),
    relativeLibraryFile(stagingRoot, writtenStatus),
    relativeLibraryFile(stagingRoot, writtenRecovery),
    ...writtenCheckpoints.map((item) => relativeLibraryFile(stagingRoot, item)),
  ];
  const manifest = LibraryGraphManifestSchema.parse({
    schemaVersion: LibraryGraphSchemaVersion,
    kind: "qmd_graphrag_library_manifest",
    libraryIdentity: {
      libraryId: input.libraryId,
      generation,
      membershipGeneration: membership.membersFile.generation,
      createdAt,
      materializationStatus: "library_query_ready",
      queryReady: true,
    },
    membership: {
      bookshelfCount: membership.membersFile.bookshelfCount,
      directBookCount: membership.membersFile.directBookCount,
      membersPath: "library_members.json",
      membershipManifestPath: "membership/LIBRARY_MEMBERSHIP_MANIFEST.json",
      membershipManifestSha256: membership.manifestSha256,
      membersDigest: membership.manifest.membership.membersDigest,
      partitionPlanDigest: membership.manifest.partitionPlan.partitionPlanDigest,
      memberBookshelfManifestSha256: memberManifestSha256,
      expandedMaterializedBookshelfIds:
        membership.membersFile.expandedMaterializedBookshelfIds,
    },
    buildConfig: {
      builderVersion: LibraryGraphBuilderVersion,
      maxReportsPerShelf,
      maxSemanticUnits,
      maxEdges,
      embeddingFingerprint,
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
      semanticUnits: {
        requiredColumns: requiredColumns("semantic_units.parquet"),
      },
      semanticEdges: {
        requiredColumns: requiredColumns("semantic_edges.parquet"),
      },
      communities: {
        requiredColumns: requiredColumns("communities.parquet"),
      },
      communityReports: {
        requiredColumns: requiredColumns("community_reports.parquet"),
      },
    },
    evidenceMap: {
      path: "evidence_map.parquet",
      requiredColumns: requiredColumns("evidence_map.parquet"),
      rowCount: artifactRows["evidence_map.parquet"] ?? 0,
    },
    fixedQueryBudget: {
      maxSemanticUnits,
      maxBookshelvesForDeepening,
      maxShelfCommunityRefs,
      maxInputTokens,
      simulationStatus: "passed",
    },
    qualityGate: {
      path: "state/library-quality-gate.json",
      status: "passed",
    },
    files,
    sensitivityPolicy: {
      forbiddenFields: ForbiddenFields,
      locatorRule: "only graph_vault-relative and scope-relative locators allowed",
    },
  });
  assertNoForbiddenText("manifest", stableJson(sensitivityScanManifest(manifest)));
  assertNoForbiddenText("quality_gate", stableJson(qualityGate));
  const writtenManifest = await writeJson(
    join(stagingRoot, "LIBRARY_MANIFEST.json"),
    manifest,
  );

  const validation = await validateLibraryGraphAtRoot({
    graphVault,
    libraryId: input.libraryId,
    root: stagingRoot,
    bridgePath: input.bridgePath ?? defaultBookshelfGraphBridgePath(),
    pythonBin: input.pythonBin ?? "python3",
  });
  if (!validation.ok) {
    throw new Error(
      `upper_quality_gate_failed:library_graph_validation:${validation.diagnostics.join(",")}`,
    );
  }

  const generationRoot = join(root, "generations", generation);
  const previousRoot = `${generationRoot}.previous-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(generationRoot), { recursive: true });
  await rm(previousRoot, { recursive: true, force: true });
  if (existsSync(generationRoot)) await rename(generationRoot, previousRoot);
  await rename(stagingRoot, generationRoot);
  await rm(previousRoot, { recursive: true, force: true });
  await writeJson(join(root, "CURRENT.json"), {
    schemaVersion: LibraryGraphSchemaVersion,
    scopeKind: "library",
    libraryId: input.libraryId,
    generation,
    current: `generations/${generation}`,
    manifestPath: `generations/${generation}/LIBRARY_MANIFEST.json`,
    manifestSha256: writtenManifest.sha256,
    readyState: "library_query_ready",
    queryReady: true,
    publishedAt: createdAt,
  });
  await writeJson(join(root, "LIBRARY_MANIFEST.json"), manifest);
  await writeJson(join(root, "state", "library-quality-gate.json"), qualityGate);
  await writeJson(join(root, "state", "diagnostics.json"), diagnostics);
  await writeJson(join(root, "PUBLISH_READY.json"), {
    schemaVersion: LibraryGraphSchemaVersion,
    kind: "qmd_graphrag_upper_package_publish_ready",
    scopeKind: "library",
    scopeId: input.libraryId,
    generation,
    readyState: "library_query_ready",
    queryReady: true,
    manifestPath: "LIBRARY_MANIFEST.json",
    manifestSha256: writtenManifest.sha256,
    qualityGatePath: "state/library-quality-gate.json",
    currentPath: "CURRENT.json",
    publishedAt: createdAt,
  });
  await rebuildLibraryCatalogProjection({
    graphVault,
    libraryId: input.libraryId,
    now: () => createdAt,
  });

  return {
    libraryId: input.libraryId,
    generation,
    root,
    manifest,
    qualityGate,
  };
}
