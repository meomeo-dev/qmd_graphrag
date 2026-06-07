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
  validatePublishedBookHotplugPackage,
} from "../book-hotplug-package-validator.js";
import { validateHotplugRuntimeQueryGate } from "../book-hotplug-runtime-gate.js";
import {
  resolveBookManifestPath,
  resolveBookRoot,
} from "../book-package-layout.js";
import {
  BookManifestSchema,
  BookshelfDiagnosticsSchema,
  BookshelfGraphBuilderVersion,
  BookshelfGraphChecks,
  BookshelfGraphManifestSchema,
  BookshelfGraphSchemaVersion,
  BookshelfMembersFileSchema,
  BookshelfMembershipManifestSchema,
  BookshelfQualityGateSchema,
  ForbiddenFields,
  GraphIdentitySchema,
  MembershipQualityGateSchema,
  RequiredParquetColumns,
  type BookManifest,
  type BookshelfGraphManifest,
  type BookshelfMember,
  type BookshelfMembersFile,
  type BookshelfMembershipManifest,
  type BookshelfQualityGate,
} from "./bookshelf-graph-contracts.js";
import {
  defaultBookshelfGraphBridgePath,
  runBookshelfGraphParquetBridge,
} from "./bookshelf-graph-parquet.js";
import {
  rebuildBookshelfCatalogProjection,
} from "./upper-catalog-projection.js";
import {
  validateBookshelfGraphAtRoot,
  validateBookshelfGraph,
} from "./bookshelf-graph-validator.js";
import {
  bookshelfPackageRoot,
  packageLocator,
  readPackageCurrent,
} from "./upper-package-paths.js";

export { validateBookshelfGraph } from "./bookshelf-graph-validator.js";

export type BuildBookshelfGraphInput = {
  graphVault: string;
  bookshelfId: string;
  pythonBin?: string;
  bridgePath?: string;
  maxReportsPerBook?: number;
  maxSemanticUnits?: number;
  maxEdges?: number;
  maxInputTokens?: number;
  maxBooksForDeepening?: number;
  maxMemberCommunityRefs?: number;
  now?: () => string;
};

export type BuildBookshelfGraphResult = {
  bookshelfId: string;
  generation: string;
  root: string;
  manifest: BookshelfGraphManifest;
  qualityGate: BookshelfQualityGate;
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

function bookshelfRunId(bookshelfId: string, generation: string): string {
  return `${bookshelfId}-${generation}`;
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

function relativeShelfFile(root: string, written: {
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
  return {
    path: relativePath,
    sha256,
    bytes: info.size,
  };
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
  const path = join(archiveRoot, "BOOKSHELF_MEMBERSHIP_MANIFEST.json");
  const info = await stat(path);
  const sha256 = await sha256File(path);
  await writeFile(`${path}.sha256`, `${sha256}\n`, "utf8");
  return { path, sha256, bytes: info.size };
}

async function readMembershipCurrent(input: {
  graphVault: string;
  bookshelfId: string;
}): Promise<{
  currentRoot: string;
  manifestSha256: string;
  manifest: BookshelfMembershipManifest;
  membersFile: BookshelfMembersFile;
}> {
  const current = await readPackageCurrent({
    graphVault: input.graphVault,
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
  });
  const currentRoot = current.generationRoot;
  const membershipRoot = existsSync(
    join(currentRoot, "BOOKSHELF_MEMBERSHIP_MANIFEST.json"),
  )
    ? currentRoot
    : join(currentRoot, "membership");
  const manifestPath = join(membershipRoot, "BOOKSHELF_MEMBERSHIP_MANIFEST.json");
  const gatePath = join(membershipRoot, "state", "membership-quality-gate.json");
  const membersPath = join(membershipRoot, "bookshelf_members.json");
  const manifest = BookshelfMembershipManifestSchema.safeParse(
    await readHotplugPackageUnknown(manifestPath),
  );
  const gate = MembershipQualityGateSchema.safeParse(
    await readHotplugPackageUnknown(gatePath),
  );
  const members = BookshelfMembersFileSchema.safeParse(
    await readHotplugPackageUnknown(membersPath),
  );
  if (!manifest.success) {
    throw new Error("upper_quality_gate_failed:membership_manifest_invalid");
  }
  if (!gate.success) {
    throw new Error("upper_quality_gate_failed:membership_gate_not_passed");
  }
  if (!members.success) {
    throw new Error("upper_quality_gate_failed:bookshelf_members_invalid");
  }
  if (manifest.data.bookshelfIdentity.bookshelfId !== input.bookshelfId) {
    throw new Error("upper_quality_gate_failed:membership_scope_mismatch");
  }
  if (members.data.bookshelfId !== input.bookshelfId) {
    throw new Error("upper_quality_gate_failed:members_scope_mismatch");
  }
  const manifestSha256 = await sha256File(manifestPath);
  const sidecar = existsSync(`${manifestPath}.sha256`)
    ? (await readFile(`${manifestPath}.sha256`, "utf8")).trim()
    : "";
  if (sidecar !== manifestSha256) {
    throw new Error("upper_quality_gate_failed:membership_manifest_checksum_mismatch");
  }
  return {
    currentRoot: membershipRoot,
    manifestSha256,
    manifest: manifest.data,
    membersFile: members.data,
  };
}

async function readAndValidateMember(
  graphVault: string,
  member: BookshelfMember,
): Promise<{
  member: BookshelfMember;
  manifest: BookManifest;
  artifactDigests: Record<string, string>;
  artifactPaths: Record<string, string>;
  identityPath: string;
}> {
  const manifestPath = resolveBookManifestPath(graphVault, member.bookId);
  const parsed = BookManifestSchema.safeParse(
    await readHotplugPackageUnknown(manifestPath),
  );
  if (!parsed.success) {
    throw new Error(`upper_quality_gate_failed:member_manifest_invalid:${member.bookId}`);
  }
  const manifest = parsed.data;
  if (manifest.identity.bookId !== member.bookId) {
    throw new Error(`upper_quality_gate_failed:member_manifest_book_mismatch:${member.bookId}`);
  }
  if (manifest.checksums.manifestSha256 !== member.manifestSha256) {
    throw new Error(`upper_index_stale:member_manifest_sha_changed:${member.bookId}`);
  }
  if (manifest.identity.packageGeneration !== member.packageGeneration) {
    throw new Error(`upper_index_stale:member_generation_changed:${member.bookId}`);
  }
  const packageValidation = validatePublishedBookHotplugPackage({
    graphVault,
    bookId: member.bookId,
  });
  if (!packageValidation.ok) {
    throw new Error(`upper_quality_gate_failed:member_package_gate:${member.bookId}`);
  }
  const runtimeGate = await validateHotplugRuntimeQueryGate({
    graphVault,
    bookId: member.bookId,
  });
  if (!runtimeGate.ok) {
    throw new Error(`upper_quality_gate_failed:member_runtime_gate:${member.bookId}`);
  }
  const artifactPaths = {
    communityReports: join(graphVault, member.graphArtifacts.communityReports),
    entities: join(graphVault, member.graphArtifacts.entities),
    relationships: join(graphVault, member.graphArtifacts.relationships),
    textUnits: join(graphVault, member.graphArtifacts.textUnits),
  };
  const bookRoot = resolveBookRoot(graphVault, member.bookId);
  for (const artifactPath of Object.values(artifactPaths)) {
    if (!artifactPath.startsWith(bookRoot)) {
      throw new Error(`upper_quality_gate_failed:member_artifact_not_package_local:${member.bookId}`);
    }
    if (!existsSync(artifactPath)) {
      throw new Error(`upper_quality_gate_failed:member_artifact_missing:${member.bookId}`);
    }
  }
  const identityPath = join(
    bookRoot,
    "graphrag",
    "output",
    "qmd_graph_text_unit_identity.json",
  );
  const identity = GraphIdentitySchema.safeParse(
    await readHotplugPackageUnknown(identityPath),
  );
  if (!identity.success) {
    throw new Error(`upper_quality_gate_failed:member_graph_identity_invalid:${member.bookId}`);
  }
  return {
    member,
    manifest,
    artifactDigests: {
      communityReports: await sha256File(artifactPaths.communityReports),
      entities: await sha256File(artifactPaths.entities),
      relationships: await sha256File(artifactPaths.relationships),
      textUnits: await sha256File(artifactPaths.textUnits),
    },
    artifactPaths,
    identityPath,
  };
}

function graphGeneration(input: {
  bookshelfId: string;
  membershipGeneration: string;
  memberManifestSha256: Record<string, string>;
  maxReportsPerBook: number;
  maxSemanticUnits: number;
  maxEdges: number;
  maxInputTokens: number;
  maxBooksForDeepening: number;
  maxMemberCommunityRefs: number;
}): string {
  return `bookshelf-${sha256Text(stableJson({
    builderVersion: BookshelfGraphBuilderVersion,
    ...input,
  })).slice(0, 16)}`;
}

function budgetSimulation(input: {
  artifactRows: Record<string, number>;
  maxSemanticUnits: number;
  maxInputTokens: number;
  maxBooksForDeepening: number;
  memberCount: number;
}): BookshelfQualityGate["fixedQueryBudgetSimulation"] {
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
    maxBooksForDeepening: input.maxBooksForDeepening,
    selectedBooksForDeepening: Math.min(
      input.memberCount,
      input.maxBooksForDeepening,
    ),
  };
}

function ensureBudgetPasses(
  simulation: BookshelfQualityGate["fixedQueryBudgetSimulation"],
): void {
  if (simulation.estimatedInputTokens > simulation.maxInputTokens) {
    throw new Error("budget_exceeded_narrow_scope_required:bookshelf_graph_build");
  }
}

function assertNoForbiddenText(
  artifactKind: string,
  text: string,
): void {
  for (const field of ForbiddenFields) {
    if (text.includes(field)) {
      throw new Error(`upper_quality_gate_failed:sensitive_field:${artifactKind}:${field}`);
    }
  }
}

function sensitivityScanManifest(manifest: BookshelfGraphManifest): unknown {
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

function requiredColumns(name: keyof typeof RequiredParquetColumns): string[] {
  return [...RequiredParquetColumns[name]];
}

export async function buildBookshelfGraph(
  input: BuildBookshelfGraphInput,
): Promise<BuildBookshelfGraphResult> {
  const graphVault = resolve(input.graphVault);
  const membership = await readMembershipCurrent({
    graphVault,
    bookshelfId: input.bookshelfId,
  });
  const maxReportsPerBook = input.maxReportsPerBook ?? 8;
  const maxSemanticUnits = input.maxSemanticUnits ?? 32;
  const maxEdges = input.maxEdges ?? 96;
  const maxInputTokens = input.maxInputTokens ?? 64000;
  const maxBooksForDeepening = input.maxBooksForDeepening ?? 3;
  const maxMemberCommunityRefs = input.maxMemberCommunityRefs ?? 24;
  const memberManifests = Object.fromEntries(
    membership.membersFile.members.map((member) => [
      member.bookId,
      member.manifestSha256,
    ]),
  );
  const generation = graphGeneration({
    bookshelfId: input.bookshelfId,
    membershipGeneration: membership.membersFile.generation,
    memberManifestSha256: memberManifests,
    maxReportsPerBook,
    maxSemanticUnits,
    maxEdges,
    maxInputTokens,
    maxBooksForDeepening,
    maxMemberCommunityRefs,
  });
  const createdAt = input.now?.() ?? new Date().toISOString();
  const runId = bookshelfRunId(input.bookshelfId, generation);
  const root = bookshelfPackageRoot(graphVault, input.bookshelfId);
  const stagingRoot = join(root, "staging", runId);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(join(stagingRoot, "state"), { recursive: true });
  await mkdir(join(stagingRoot, "runs", runId, "checkpoints"), {
    recursive: true,
  });

  const validatedMembers = [];
  for (const member of membership.membersFile.members) {
    validatedMembers.push(await readAndValidateMember(graphVault, member));
  }

  const copiedMembershipFiles = [
    await archiveMembershipCurrent({
      sourceRoot: membership.currentRoot,
      stagingRoot,
    }),
  ];
  for (const path of [
    "bookshelf_members.json",
    "membership_decisions.jsonl",
    "bookshelf_split_plan.json",
    "state/membership-quality-gate.json",
  ]) {
    copiedMembershipFiles.push(
      await copyMembershipFile(membership.currentRoot, stagingRoot, path),
    );
  }

  const embeddingFingerprint = sha256Text(stableJson({
    builderVersion: BookshelfGraphBuilderVersion,
    embedding: "deterministic_hash_vector_sidecar",
  }));
  const bridgePayload = {
    bookshelfId: input.bookshelfId,
    generation,
    outputRoot: stagingRoot,
    maxReportsPerBook,
    maxSemanticUnits,
    maxEdges,
    embeddingFingerprint,
    members: validatedMembers.map((item) => ({
      bookId: item.member.bookId,
      title: item.member.title,
      sourceHash: item.manifest.identity.sourceHash,
      contentHash: item.manifest.input?.normalizedHash ??
        item.manifest.identity.sourceHash,
      manifestSha256: item.member.manifestSha256,
      communityReportsPath: item.artifactPaths.communityReports,
      entitiesPath: item.artifactPaths.entities,
      relationshipsPath: item.artifactPaths.relationships,
      textUnitsPath: item.artifactPaths.textUnits,
      identityPath: item.identityPath,
      artifactDigests: item.artifactDigests,
    })),
  };
  const inspection = await runBookshelfGraphParquetBridge({
    mode: "build",
    pythonBin: input.pythonBin ?? "python3",
    bridgePath: input.bridgePath ?? defaultBookshelfGraphBridgePath(),
    payload: bridgePayload,
  });
  if (!inspection.ok) {
    throw new Error(
      `upper_quality_gate_failed:parquet_schema:${inspection.diagnostics.join(",")}`,
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
    maxBooksForDeepening,
    memberCount: membership.membersFile.members.length,
  });
  ensureBudgetPasses(simulation);

  const qualityGate = BookshelfQualityGateSchema.parse({
    schemaVersion: BookshelfGraphSchemaVersion,
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation,
    stageId: "materialized_bookshelf_graph_build",
    readyState: "bookshelf_query_ready",
    queryReady: true,
    status: "passed",
    checkedAt: createdAt,
    checks: BookshelfGraphChecks.map((checkId) => ({ checkId, status: "passed" })),
    diagnostics: [],
    artifactRowCounts: artifactRows,
    fixedQueryBudgetSimulation: simulation,
  });
  const graphDigest = sha256Text(stableJson({
    generation,
    artifacts: inspection.artifacts,
    members: memberManifests,
  }));
  const diagnostics = BookshelfDiagnosticsSchema.parse({
    schemaVersion: BookshelfGraphSchemaVersion,
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation,
    status: "passed",
    failedCheckId: null,
    severity: "info",
    typedErrorCode: null,
    affectedArtifactKind: "bookshelf_graph",
    affectedArtifactDigest: graphDigest,
    expectedDigest: graphDigest,
    observedDigest: graphDigest,
    redactedLocator: `generations/${generation}/BOOKSHELF_MANIFEST.json`,
    remediationCommand: null,
    checkedAt: createdAt,
  });
  const status = {
    schemaVersion: BookshelfGraphSchemaVersion,
    runId,
    stageId: "materialized_bookshelf_graph_build",
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation,
    status: "passed",
    readyState: "bookshelf_query_ready",
    queryReady: true,
    memberCount: membership.membersFile.members.length,
    semanticUnitCount: artifactRows["semantic_units.parquet"] ?? 0,
    startedAt: createdAt,
    completedAt: createdAt,
  };
  const recoverySummary = {
    schemaVersion: BookshelfGraphSchemaVersion,
    runId,
    stageId: "materialized_bookshelf_graph_build",
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
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
    join(stagingRoot, "state", "bookshelf-quality-gate.json"),
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
        schemaVersion: BookshelfGraphSchemaVersion,
        runId,
        stageId: "materialized_bookshelf_graph_build",
        scopeKind: "bookshelf",
        scopeId: input.bookshelfId,
        generation,
        event: "bookshelf_graph_build_started",
        status: "running",
        at: createdAt,
      },
      {
        schemaVersion: BookshelfGraphSchemaVersion,
        runId,
        stageId: "materialized_bookshelf_graph_build",
        scopeKind: "bookshelf",
        scopeId: input.bookshelfId,
        generation,
        event: "bookshelf_graph_published",
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
      join(stagingRoot, "runs", runId, "checkpoints", `${item.member.bookId}.json`),
      {
        schemaVersion: BookshelfGraphSchemaVersion,
        runId,
        stageId: "materialized_bookshelf_graph_build",
        scopeKind: "bookshelf",
        scopeId: input.bookshelfId,
        generation,
        status: "passed",
        bookId: item.member.bookId,
        manifestSha256: item.member.manifestSha256,
        artifactDigests: item.artifactDigests,
        checkedAt: createdAt,
      },
    ));
  }
  const files = [
    ...copiedMembershipFiles.map((item) => relativeShelfFile(stagingRoot, item)),
    await fileRecord(stagingRoot, "semantic_units.parquet"),
    await fileRecord(stagingRoot, "semantic_edges.parquet"),
    await fileRecord(stagingRoot, "communities.parquet"),
    await fileRecord(stagingRoot, "community_reports.parquet"),
    await fileRecord(stagingRoot, "evidence_map.parquet"),
    ...(await directoryFileRecords(stagingRoot, "semantic_unit_embeddings.lance")),
    relativeShelfFile(stagingRoot, writtenGate),
    relativeShelfFile(stagingRoot, writtenDiagnostics),
    relativeShelfFile(stagingRoot, writtenEvents),
    relativeShelfFile(stagingRoot, writtenStatus),
    relativeShelfFile(stagingRoot, writtenRecovery),
    ...writtenCheckpoints.map((item) => relativeShelfFile(stagingRoot, item)),
  ];
  const manifest = BookshelfGraphManifestSchema.parse({
    schemaVersion: BookshelfGraphSchemaVersion,
    kind: "qmd_graphrag_bookshelf_manifest",
    bookshelfIdentity: {
      bookshelfId: input.bookshelfId,
      generation,
      membershipGeneration: membership.membersFile.generation,
      createdAt,
      materializationStatus: "bookshelf_query_ready",
      queryReady: true,
    },
    membership: {
      memberCount: membership.membersFile.members.length,
      membersPath: "bookshelf_members.json",
      membershipManifestPath: "membership/BOOKSHELF_MEMBERSHIP_MANIFEST.json",
      membershipManifestSha256: membership.manifestSha256,
      membersDigest: membership.manifest.membership.membersDigest,
      decisionsDigest: membership.manifest.membership.decisionsDigest,
      splitPlanDigest: membership.manifest.membership.splitPlanDigest,
      memberManifestSha256: memberManifests,
    },
    buildConfig: {
      builderVersion: BookshelfGraphBuilderVersion,
      maxReportsPerBook,
      maxSemanticUnits,
      maxEdges,
      embeddingFingerprint,
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
      maxBooksForDeepening,
      maxMemberCommunityRefs,
      maxInputTokens,
      simulationStatus: "passed",
    },
    qualityGate: {
      path: "state/bookshelf-quality-gate.json",
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
    join(stagingRoot, "BOOKSHELF_MANIFEST.json"),
    manifest,
  );

  const validation = await validateBookshelfGraphAtRoot({
    graphVault,
    bookshelfId: input.bookshelfId,
    root: stagingRoot,
    bridgePath: input.bridgePath ?? defaultBookshelfGraphBridgePath(),
    pythonBin: input.pythonBin ?? "python3",
  });
  if (!validation.ok) {
    throw new Error(
      `upper_quality_gate_failed:bookshelf_graph_validation:${validation.diagnostics.join(",")}`,
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
    schemaVersion: BookshelfGraphSchemaVersion,
    scopeKind: "bookshelf",
    bookshelfId: input.bookshelfId,
    generation,
    current: `generations/${generation}`,
    manifestPath: `generations/${generation}/BOOKSHELF_MANIFEST.json`,
    manifestSha256: writtenManifest.sha256,
    readyState: "bookshelf_query_ready",
    queryReady: true,
    publishedAt: createdAt,
  });
  await writeJson(join(root, "BOOKSHELF_MANIFEST.json"), manifest);
  await writeJson(join(root, "state", "bookshelf-quality-gate.json"), qualityGate);
  await writeJson(join(root, "state", "diagnostics.json"), diagnostics);
  await writeJson(join(root, "PUBLISH_READY.json"), {
    schemaVersion: BookshelfGraphSchemaVersion,
    kind: "qmd_graphrag_upper_package_publish_ready",
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation,
    readyState: "bookshelf_query_ready",
    queryReady: true,
    manifestPath: "BOOKSHELF_MANIFEST.json",
    manifestSha256: writtenManifest.sha256,
    qualityGatePath: "state/bookshelf-quality-gate.json",
    currentPath: "CURRENT.json",
    publishedAt: createdAt,
  });
  await rebuildBookshelfCatalogProjection({
    graphVault,
    bookshelfId: input.bookshelfId,
    now: () => createdAt,
  });

  return {
    bookshelfId: input.bookshelfId,
    generation,
    root,
    manifest,
    qualityGate,
  };
}

export function bookshelfGraphArtifactRelativePaths(): string[] {
  return [
    "BOOKSHELF_MANIFEST.json",
    "semantic_units.parquet",
    "semantic_edges.parquet",
    "communities.parquet",
    "community_reports.parquet",
    "evidence_map.parquet",
    "semantic_unit_embeddings.lance",
    "state/bookshelf-quality-gate.json",
  ];
}
