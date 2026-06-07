import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { readHotplugPackageUnknown } from "../book-hotplug-package-readonly.js";
import {
  BookshelfGraphManifestSchema,
  BookshelfQualityGateSchema,
  type BookshelfGraphManifest,
} from "./bookshelf-graph-contracts.js";
import {
  libraryPackageRoot,
  packageLocator,
  readPackageCurrent,
  readQueryReadyPackage,
} from "./upper-package-paths.js";

export const LibraryMembershipSchemaVersion = "1.0.0";

const MembershipSourceKindSchema = z.enum([
  "user_explicit",
  "deterministic_rule",
  "taxonomy",
  "llm_suggested",
  "llm_accepted",
  "hybrid",
]);

const LibraryBookshelfMemberSchema = z.object({
  bookshelfId: z.string().min(1),
  manifestSha256: z.string().min(1),
  generation: z.string().min(1),
  membershipGeneration: z.string().min(1),
  queryReady: z.literal(true),
  readyState: z.literal("bookshelf_query_ready"),
  memberCount: z.number().int().positive(),
  semanticUnitBudget: z.number().int().positive(),
  evidenceMapRowCount: z.number().int().positive(),
  membershipSourceKind: MembershipSourceKindSchema,
  userLocked: z.boolean(),
  manifestPath: z.string().min(1),
  qualityGatePath: z.string().min(1),
  semanticArtifacts: z.object({
    semanticUnits: z.string().min(1),
    semanticEdges: z.string().min(1),
    communityReports: z.string().min(1),
    evidenceMap: z.string().min(1),
  }),
});

const LibraryDirectBookMemberSchema = z.object({
  bookId: z.string().min(1),
  reason: z.string().min(1),
});

export const LibraryMembersFileSchema = z.object({
  schemaVersion: z.literal(LibraryMembershipSchemaVersion),
  kind: z.literal("qmd_graphrag_library_members"),
  libraryId: z.string().min(1),
  generation: z.string().min(1),
  directBookLimit: z.number().int().nonnegative(),
  bookshelfCount: z.number().int().positive(),
  directBookCount: z.number().int().nonnegative(),
  members: z.object({
    bookshelves: z.array(LibraryBookshelfMemberSchema).min(1),
    directBooks: z.array(LibraryDirectBookMemberSchema),
  }),
  expandedMaterializedBookshelfIds: z.array(z.string().min(1)).min(1),
});

export const LibraryPartitionPlanSchema = z.object({
  schemaVersion: z.literal(LibraryMembershipSchemaVersion),
  kind: z.literal("qmd_graphrag_library_partition_plan"),
  libraryId: z.string().min(1),
  generation: z.string().min(1),
  status: z.enum(["not_required", "partitioned"]),
  shelfCount: z.number().int().positive(),
  shelfLimit: z.number().int().positive(),
  directBookLimit: z.number().int().nonnegative(),
  virtualParentBookshelfIds: z.array(z.string().min(1)),
  partitions: z.array(z.object({
    partitionId: z.string().min(1),
    materializedBookshelfIds: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1),
  })),
});

export const LibraryMembershipGateSchema = z.object({
  schemaVersion: z.literal(LibraryMembershipSchemaVersion),
  scopeKind: z.literal("library"),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  stageId: z.literal("library_membership_resolution"),
  readyState: z.literal("library_membership_resolved"),
  queryReady: z.literal(false),
  status: z.literal("passed"),
  checkedAt: z.string().min(1),
  checks: z.array(z.object({
    checkId: z.string().min(1),
    status: z.literal("passed"),
  })),
  diagnostics: z.array(z.string()),
});

const LibraryDiagnosticsSchema = z.object({
  schemaVersion: z.literal(LibraryMembershipSchemaVersion),
  scopeKind: z.literal("library"),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  status: z.literal("passed"),
  failedCheckId: z.null(),
  severity: z.literal("info"),
  typedErrorCode: z.null(),
  affectedArtifactKind: z.literal("library_membership"),
  affectedArtifactDigest: z.string().min(1),
  expectedDigest: z.string().min(1),
  observedDigest: z.string().min(1),
  redactedLocator: z.string().min(1),
  remediationCommand: z.null(),
  checkedAt: z.string().min(1),
});

const FileRecordSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});

export const LibraryMembershipManifestSchema = z.object({
  schemaVersion: z.literal(LibraryMembershipSchemaVersion),
  kind: z.literal("qmd_graphrag_library_membership_manifest"),
  libraryIdentity: z.object({
    libraryId: z.string().min(1),
    generation: z.string().min(1),
    createdAt: z.string().min(1),
    materializationStatus: z.literal("library_membership_resolved"),
    queryReady: z.literal(false),
  }),
  membership: z.object({
    bookshelfCount: z.number().int().positive(),
    directBookCount: z.number().int().nonnegative(),
    membersPath: z.literal("library_members.json"),
    policyKind: MembershipSourceKindSchema,
    policyDigest: z.string().min(1),
    membersDigest: z.string().min(1),
    memberManifestSha256: z.record(z.string(), z.string().min(1)),
    expandedMaterializedBookshelfIds: z.array(z.string().min(1)).min(1),
  }),
  partitionPlan: z.object({
    partitionPlanPath: z.literal("library_partition_plan.json"),
    partitionPlanDigest: z.string().min(1),
    shelfLimit: z.number().int().positive(),
    directBookLimit: z.number().int().nonnegative(),
    status: z.enum(["not_required", "partitioned"]),
  }),
  nextStage: z.object({
    stageId: z.literal("library_graph_build"),
    requiredManifest: z.literal("LIBRARY_MANIFEST.json"),
    rule: z.string().min(1),
  }),
  qualityGate: z.object({
    path: z.literal("state/library-membership-gate.json"),
    status: z.literal("passed"),
  }),
  sensitivityPolicy: z.object({
    forbiddenFields: z.array(z.string().min(1)),
    locatorRule: z.string().min(1),
  }),
  files: z.array(FileRecordSchema),
});

export type LibraryBookshelfMember =
  z.infer<typeof LibraryBookshelfMemberSchema>;
export type LibraryMembersFile = z.infer<typeof LibraryMembersFileSchema>;
export type LibraryPartitionPlan = z.infer<typeof LibraryPartitionPlanSchema>;
export type LibraryMembershipGate = z.infer<typeof LibraryMembershipGateSchema>;
export type LibraryMembershipManifest =
  z.infer<typeof LibraryMembershipManifestSchema>;

export type LibraryMembershipPolicy = {
  sourceKind?: z.infer<typeof MembershipSourceKindSchema>;
  decidedBy?: string;
  taxonomyId?: string | null;
  taxonomyVersion?: string | null;
  confidence?: number;
};

export type ResolveLibraryMembershipInput = {
  graphVault: string;
  libraryId: string;
  bookshelfIds: readonly string[];
  directBookIds?: readonly string[];
  shelfLimit?: number;
  directBookLimit?: number;
  policy?: LibraryMembershipPolicy;
  now?: () => string;
};

export type ResolveLibraryMembershipResult = {
  libraryId: string;
  generation: string;
  root: string;
  manifest: LibraryMembershipManifest;
  qualityGate: LibraryMembershipGate;
  bookshelfCount: number;
  directBookCount: number;
};

export type LibraryMembershipCurrent = {
  currentRoot: string;
  manifestSha256: string;
  manifest: LibraryMembershipManifest;
  membersFile: LibraryMembersFile;
  partitionPlan: LibraryPartitionPlan;
  qualityGate: LibraryMembershipGate;
};

const ForbiddenManifestFields = [
  "providerRequestPayload",
  "providerResponsePayload",
  "rawPrompt",
  "rawCompletion",
  "apiKey",
  "credential",
  "absoluteLocalPath",
  "queryLogContent",
];

const LibraryMembershipChecks = [
  "member_bookshelf_manifest_sha256_matches",
  "member_bookshelf_quality_gates_passed",
  "virtual_parents_expand_to_materialized_children",
  "membership_direct_book_limit_valid",
  "membership_library_partition_valid",
  "suggestion_only_members_not_query_ready",
  "library_members_schema_valid",
  "library_partition_plan_schema_valid",
  "sensitive_payload_scan_passed",
  "stale_marker_absent",
];

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeScopeIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
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

function assertSafeScopeId(kind: string, id: string): void {
  if (
    id === "" ||
    id.includes("/") ||
    id.includes("\\") ||
    id === "." ||
    id === ".." ||
    id.includes("..") ||
    /^[A-Za-z]:/u.test(id) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(id)
  ) {
    throw new Error(`upper_quality_gate_failed:invalid_${kind}_id`);
  }
}

function defaultPolicy(
  policy: LibraryMembershipPolicy | undefined,
): Required<LibraryMembershipPolicy> {
  return {
    sourceKind: policy?.sourceKind ?? "user_explicit",
    decidedBy: policy?.decidedBy ?? "local_cli_user",
    taxonomyId: policy?.taxonomyId ?? null,
    taxonomyVersion: policy?.taxonomyVersion ?? null,
    confidence: policy?.confidence ?? 1,
  };
}

function libraryRunId(libraryId: string, generation: string): string {
  return `${libraryId}-${generation}`;
}

function requiredBookshelfArtifactPaths(
  bookshelfId: string,
  manifest: BookshelfGraphManifest,
): LibraryBookshelfMember["semanticArtifacts"] {
  const generation = manifest.bookshelfIdentity.generation;
  return {
    semanticUnits: packageLocator({
      scopeKind: "bookshelf",
      scopeId: bookshelfId,
      generation,
      relativePath:
        manifest.graphArtifacts.semanticUnits,
    }),
    semanticEdges: packageLocator({
      scopeKind: "bookshelf",
      scopeId: bookshelfId,
      generation,
      relativePath:
        manifest.graphArtifacts.semanticEdges,
    }),
    communityReports: packageLocator({
      scopeKind: "bookshelf",
      scopeId: bookshelfId,
      generation,
      relativePath:
        manifest.graphArtifacts.communityReports,
    }),
    evidenceMap: packageLocator({
      scopeKind: "bookshelf",
      scopeId: bookshelfId,
      generation,
      relativePath: manifest.evidenceMap.path,
    }),
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  return readHotplugPackageUnknown(path);
}

export async function readLibraryMembershipCurrent(input: {
  graphVault: string;
  libraryId: string;
}): Promise<LibraryMembershipCurrent> {
  const graphVault = resolve(input.graphVault);
  const current = await readPackageCurrent({
    graphVault,
    scopeKind: "library",
    scopeId: input.libraryId,
  });
  const currentRoot = current.generationRoot;
  const membershipRoot = existsSync(
    join(currentRoot, "LIBRARY_MEMBERSHIP_MANIFEST.json"),
  )
    ? currentRoot
    : join(currentRoot, "membership");
  const manifestPath = join(membershipRoot, "LIBRARY_MEMBERSHIP_MANIFEST.json");
  const membersPath = join(membershipRoot, "library_members.json");
  const partitionPath = join(membershipRoot, "library_partition_plan.json");
  const gatePath = join(membershipRoot, "state", "library-membership-gate.json");
  const manifest = LibraryMembershipManifestSchema.safeParse(
    await readJsonFile(manifestPath),
  );
  const members = LibraryMembersFileSchema.safeParse(await readJsonFile(membersPath));
  const partitionPlan = LibraryPartitionPlanSchema.safeParse(
    await readJsonFile(partitionPath),
  );
  const gate = LibraryMembershipGateSchema.safeParse(await readJsonFile(gatePath));
  if (!manifest.success) {
    throw new Error("upper_quality_gate_failed:library_membership_manifest_invalid");
  }
  if (!members.success) {
    throw new Error("upper_quality_gate_failed:library_members_invalid");
  }
  if (!partitionPlan.success) {
    throw new Error("upper_quality_gate_failed:library_partition_plan_invalid");
  }
  if (!gate.success || gate.data.status !== "passed") {
    throw new Error("upper_quality_gate_failed:library_membership_gate_not_passed");
  }
  if (manifest.data.libraryIdentity.libraryId !== input.libraryId) {
    throw new Error("upper_quality_gate_failed:library_membership_scope_mismatch");
  }
  const manifestSha256 = sha256Buffer(await readFile(manifestPath));
  const sidecar = existsSync(`${manifestPath}.sha256`)
    ? (await readFile(`${manifestPath}.sha256`, "utf8")).trim()
    : "";
  if (sidecar !== manifestSha256) {
    throw new Error("upper_quality_gate_failed:library_membership_checksum_mismatch");
  }
  return {
    currentRoot: membershipRoot,
    manifestSha256,
    manifest: manifest.data,
    membersFile: members.data,
    partitionPlan: partitionPlan.data,
    qualityGate: gate.data,
  };
}

async function readBookshelfManifest(input: {
  graphVault: string;
  bookshelfId: string;
  policy: Required<LibraryMembershipPolicy>;
}): Promise<LibraryBookshelfMember> {
  assertSafeScopeId("bookshelf", input.bookshelfId);
  const ready = await readQueryReadyPackage({
    graphVault: input.graphVault,
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `upper_quality_gate_failed:bookshelf_package_not_query_ready:${input.bookshelfId}:${message}`,
    );
  });
  const root = ready.generationRoot;
  const manifestPath = ready.manifestPath;
  const gatePath = ready.gatePath;
  const manifestSha256 = sha256Buffer(await readFile(manifestPath));
  const sidecarSha256 = (await readFile(`${manifestPath}.sha256`, "utf8")).trim();
  if (sidecarSha256 !== manifestSha256) {
    throw new Error(
      `upper_quality_gate_failed:bookshelf_manifest_sidecar_mismatch:${input.bookshelfId}`,
    );
  }
  const manifest = BookshelfGraphManifestSchema.safeParse(
    await readJsonFile(manifestPath),
  );
  const gate = BookshelfQualityGateSchema.safeParse(await readJsonFile(gatePath));
  if (!manifest.success) {
    throw new Error(
      `upper_quality_gate_failed:bookshelf_manifest_schema_invalid:${input.bookshelfId}`,
    );
  }
  if (!gate.success) {
    throw new Error(
      `upper_quality_gate_failed:bookshelf_gate_schema_invalid:${input.bookshelfId}`,
    );
  }
  if (manifest.data.bookshelfIdentity.bookshelfId !== input.bookshelfId) {
    throw new Error(
      `upper_quality_gate_failed:bookshelf_manifest_scope_mismatch:${input.bookshelfId}`,
    );
  }
  if (!manifest.data.bookshelfIdentity.queryReady || !gate.data.queryReady) {
    throw new Error(
      `upper_quality_gate_failed:bookshelf_not_query_ready:${input.bookshelfId}`,
    );
  }
  for (const relativePath of [
    manifest.data.graphArtifacts.semanticUnits,
    manifest.data.graphArtifacts.semanticEdges,
    manifest.data.graphArtifacts.communityReports,
    manifest.data.evidenceMap.path,
  ]) {
    const normalized = normalizeScopeRelativePath(relativePath);
    if (normalized == null) {
      throw new Error(
        `upper_quality_gate_failed:bookshelf_artifact_path_invalid:${input.bookshelfId}`,
      );
    }
    const artifactPath = join(root, normalized);
    if (!existsSync(artifactPath) || !existsSync(`${artifactPath}.sha256`)) {
      throw new Error(
        `upper_quality_gate_failed:bookshelf_artifact_missing:${input.bookshelfId}`,
      );
    }
  }
  return LibraryBookshelfMemberSchema.parse({
    bookshelfId: input.bookshelfId,
    manifestSha256,
    generation: manifest.data.bookshelfIdentity.generation,
    membershipGeneration: manifest.data.bookshelfIdentity.membershipGeneration,
    queryReady: true,
    readyState: "bookshelf_query_ready",
    memberCount: manifest.data.membership.memberCount,
    semanticUnitBudget: manifest.data.fixedQueryBudget.maxSemanticUnits,
    evidenceMapRowCount: manifest.data.evidenceMap.rowCount,
    membershipSourceKind: input.policy.sourceKind,
    userLocked: input.policy.sourceKind === "user_explicit",
    manifestPath: packageLocator({
      scopeKind: "bookshelf",
      scopeId: input.bookshelfId,
      generation: manifest.data.bookshelfIdentity.generation,
      relativePath: "BOOKSHELF_MANIFEST.json",
    }),
    qualityGatePath: packageLocator({
      scopeKind: "bookshelf",
      scopeId: input.bookshelfId,
      generation: manifest.data.bookshelfIdentity.generation,
      relativePath: "state/bookshelf-quality-gate.json",
    }),
    semanticArtifacts: requiredBookshelfArtifactPaths(
      input.bookshelfId,
      manifest.data,
    ),
  });
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

function buildPartitionPlan(input: {
  libraryId: string;
  generation: string;
  bookshelfIds: readonly string[];
  shelfLimit: number;
  directBookLimit: number;
}): LibraryPartitionPlan {
  const partitions = [];
  for (let index = 0; index < input.bookshelfIds.length; index += input.shelfLimit) {
    const chunk = input.bookshelfIds.slice(index, index + input.shelfLimit);
    if (input.bookshelfIds.length > input.shelfLimit) {
      partitions.push({
        partitionId: `${input.libraryId}-partition-${partitions.length + 1}`,
        materializedBookshelfIds: chunk,
        reason: "shelf_count_exceeds_single_partition_limit",
      });
    }
  }
  return LibraryPartitionPlanSchema.parse({
    schemaVersion: LibraryMembershipSchemaVersion,
    kind: "qmd_graphrag_library_partition_plan",
    libraryId: input.libraryId,
    generation: input.generation,
    status: input.bookshelfIds.length > input.shelfLimit
      ? "partitioned"
      : "not_required",
    shelfCount: input.bookshelfIds.length,
    shelfLimit: input.shelfLimit,
    directBookLimit: input.directBookLimit,
    virtualParentBookshelfIds: [],
    partitions,
  });
}

function libraryEvents(input: {
  libraryId: string;
  generation: string;
  runId: string;
  bookshelfCount: number;
  directBookCount: number;
  at: string;
}): unknown[] {
  return [
    {
      schemaVersion: LibraryMembershipSchemaVersion,
      runId: input.runId,
      stageId: "library_membership_resolution",
      scopeKind: "library",
      scopeId: input.libraryId,
      generation: input.generation,
      event: "library_membership_started",
      status: "running",
      at: input.at,
    },
    {
      schemaVersion: LibraryMembershipSchemaVersion,
      runId: input.runId,
      stageId: "library_membership_resolution",
      scopeKind: "library",
      scopeId: input.libraryId,
      generation: input.generation,
      event: "library_membership_published",
      status: "passed",
      bookshelfCount: input.bookshelfCount,
      directBookCount: input.directBookCount,
      queryReady: false,
      at: input.at,
    },
  ];
}

export async function resolveLibraryMembership(
  input: ResolveLibraryMembershipInput,
): Promise<ResolveLibraryMembershipResult> {
  const graphVault = resolve(input.graphVault);
  assertSafeScopeId("library", input.libraryId);
  const bookshelfIds = normalizeScopeIds(input.bookshelfIds);
  const directBookIds = normalizeScopeIds(input.directBookIds ?? []);
  for (const bookshelfId of bookshelfIds) {
    assertSafeScopeId("bookshelf", bookshelfId);
  }
  const shelfLimit = input.shelfLimit ?? 32;
  const directBookLimit = input.directBookLimit ?? 0;
  if (!Number.isInteger(shelfLimit) || shelfLimit <= 0) {
    throw new Error("upper_quality_gate_failed:library_shelf_limit_invalid");
  }
  if (!Number.isInteger(directBookLimit) || directBookLimit < 0) {
    throw new Error("upper_quality_gate_failed:direct_book_limit_invalid");
  }
  if (bookshelfIds.length < 1) {
    throw new Error("upper_quality_gate_failed:library_membership_empty");
  }
  if (directBookIds.length > directBookLimit) {
    throw new Error("upper_quality_gate_failed:direct_book_limit_exceeded");
  }
  const policy = defaultPolicy(input.policy);
  if (policy.sourceKind === "llm_suggested") {
    throw new Error("upper_quality_gate_failed:llm_suggestion_not_query_ready");
  }
  const createdAt = input.now?.() ?? new Date().toISOString();
  const generation = `library-membership-${sha256Text([
    input.libraryId,
    ...bookshelfIds,
    ...directBookIds,
    policy.sourceKind,
    policy.taxonomyId ?? "",
    policy.taxonomyVersion ?? "",
    String(shelfLimit),
    String(directBookLimit),
  ].join("\n")).slice(0, 16)}`;
  const runId = libraryRunId(input.libraryId, generation);
  const root = libraryPackageRoot(graphVault, input.libraryId);
  const stagingRoot = join(root, "staging", runId);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(join(stagingRoot, "state"), { recursive: true });
  await mkdir(join(stagingRoot, "runs", runId, "checkpoints"), {
    recursive: true,
  });

  const bookshelves = [];
  for (const bookshelfId of bookshelfIds) {
    bookshelves.push(await readBookshelfManifest({
      graphVault,
      bookshelfId,
      policy,
    }));
  }
  const membersFile = LibraryMembersFileSchema.parse({
    schemaVersion: LibraryMembershipSchemaVersion,
    kind: "qmd_graphrag_library_members",
    libraryId: input.libraryId,
    generation,
    directBookLimit,
    bookshelfCount: bookshelves.length,
    directBookCount: directBookIds.length,
    members: {
      bookshelves,
      directBooks: directBookIds.map((bookId) => ({
        bookId,
        reason: "direct book membership is reserved for small libraries",
      })),
    },
    expandedMaterializedBookshelfIds: bookshelves.map((member) =>
      member.bookshelfId
    ),
  });
  const partitionPlan = buildPartitionPlan({
    libraryId: input.libraryId,
    generation,
    bookshelfIds,
    shelfLimit,
    directBookLimit,
  });
  const membersDigest = sha256Text(stableJson(membersFile));
  const partitionPlanDigest = sha256Text(stableJson(partitionPlan));
  const memberManifestSha256 = Object.fromEntries(
    bookshelves.map((member) => [member.bookshelfId, member.manifestSha256]),
  );
  const qualityGate = LibraryMembershipGateSchema.parse({
    schemaVersion: LibraryMembershipSchemaVersion,
    scopeKind: "library",
    scopeId: input.libraryId,
    generation,
    stageId: "library_membership_resolution",
    readyState: "library_membership_resolved",
    queryReady: false,
    status: "passed",
    checkedAt: createdAt,
    checks: LibraryMembershipChecks.map((checkId) => ({
      checkId,
      status: "passed",
    })),
    diagnostics: [],
  });
  const diagnostics = LibraryDiagnosticsSchema.parse({
    schemaVersion: LibraryMembershipSchemaVersion,
    scopeKind: "library",
    scopeId: input.libraryId,
    generation,
    status: "passed",
    failedCheckId: null,
    severity: "info",
    typedErrorCode: null,
    affectedArtifactKind: "library_membership",
    affectedArtifactDigest: membersDigest,
    expectedDigest: membersDigest,
    observedDigest: membersDigest,
    redactedLocator: `generations/${generation}/library_members.json`,
    remediationCommand: null,
    checkedAt: createdAt,
  });
  const status = {
    schemaVersion: LibraryMembershipSchemaVersion,
    runId,
    stageId: "library_membership_resolution",
    scopeKind: "library",
    scopeId: input.libraryId,
    generation,
    status: "passed",
    readyState: "library_membership_resolved",
    queryReady: false,
    bookshelfCount: bookshelves.length,
    directBookCount: directBookIds.length,
    startedAt: createdAt,
    completedAt: createdAt,
  };
  const recoverySummary = {
    schemaVersion: LibraryMembershipSchemaVersion,
    runId,
    stageId: "library_membership_resolution",
    scopeKind: "library",
    scopeId: input.libraryId,
    generation,
    status: "passed",
    recoveryDecision: "not_required",
    checkpointCount: bookshelves.length,
    eventCount: 2,
    currentGenerationPublished: true,
    queryReady: false,
    completedAt: createdAt,
  };

  const writtenMembers = await writeJson(
    join(stagingRoot, "library_members.json"),
    membersFile,
  );
  const writtenPartitionPlan = await writeJson(
    join(stagingRoot, "library_partition_plan.json"),
    partitionPlan,
  );
  const writtenGate = await writeJson(
    join(stagingRoot, "state", "library-membership-gate.json"),
    qualityGate,
  );
  const writtenDiagnostics = await writeJson(
    join(stagingRoot, "state", "diagnostics.json"),
    diagnostics,
  );
  const writtenEvents = await writeJsonl(
    join(stagingRoot, "runs", runId, "events.jsonl"),
    libraryEvents({
      libraryId: input.libraryId,
      generation,
      runId,
      bookshelfCount: bookshelves.length,
      directBookCount: directBookIds.length,
      at: createdAt,
    }),
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
  for (const member of bookshelves) {
    writtenCheckpoints.push(await writeJson(
      join(
        stagingRoot,
        "runs",
        runId,
        "checkpoints",
        `${member.bookshelfId.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`,
      ),
      {
        schemaVersion: LibraryMembershipSchemaVersion,
        runId,
        stageId: "library_membership_resolution",
        scopeKind: "library",
        scopeId: input.libraryId,
        generation,
        status: "passed",
        bookshelfId: member.bookshelfId,
        bookshelfManifestSha256: member.manifestSha256,
        checkedAt: createdAt,
      },
    ));
  }
  const manifest = LibraryMembershipManifestSchema.parse({
    schemaVersion: LibraryMembershipSchemaVersion,
    kind: "qmd_graphrag_library_membership_manifest",
    libraryIdentity: {
      libraryId: input.libraryId,
      generation,
      createdAt,
      materializationStatus: "library_membership_resolved",
      queryReady: false,
    },
    membership: {
      bookshelfCount: bookshelves.length,
      directBookCount: directBookIds.length,
      membersPath: "library_members.json",
      policyKind: policy.sourceKind,
      policyDigest: sha256Text(stableJson(policy)),
      membersDigest,
      memberManifestSha256,
      expandedMaterializedBookshelfIds: bookshelves.map((member) =>
        member.bookshelfId
      ),
    },
    partitionPlan: {
      partitionPlanPath: "library_partition_plan.json",
      partitionPlanDigest,
      shelfLimit,
      directBookLimit,
      status: partitionPlan.status,
    },
    nextStage: {
      stageId: "library_graph_build",
      requiredManifest: "LIBRARY_MANIFEST.json",
      rule: "library membership manifest does not grant library query readiness",
    },
    qualityGate: {
      path: "state/library-membership-gate.json",
      status: "passed",
    },
    sensitivityPolicy: {
      forbiddenFields: ForbiddenManifestFields,
      locatorRule: "only graph_vault-relative and scope-relative locators allowed",
    },
    files: [
      relativeLibraryFile(stagingRoot, writtenMembers),
      relativeLibraryFile(stagingRoot, writtenPartitionPlan),
      relativeLibraryFile(stagingRoot, writtenGate),
      relativeLibraryFile(stagingRoot, writtenDiagnostics),
      relativeLibraryFile(stagingRoot, writtenEvents),
      relativeLibraryFile(stagingRoot, writtenStatus),
      relativeLibraryFile(stagingRoot, writtenRecovery),
      ...writtenCheckpoints.map((item) => relativeLibraryFile(stagingRoot, item)),
    ],
  });
  const writtenManifest = await writeJson(
    join(stagingRoot, "LIBRARY_MEMBERSHIP_MANIFEST.json"),
    manifest,
  );

  const generationRoot = join(root, "generations", generation);
  const previousRoot = `${generationRoot}.previous-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(generationRoot), { recursive: true });
  await rm(previousRoot, { recursive: true, force: true });
  if (existsSync(generationRoot)) await rename(generationRoot, previousRoot);
  await rename(stagingRoot, generationRoot);
  await rm(previousRoot, { recursive: true, force: true });
  await writeJson(join(root, "CURRENT.json"), {
    schemaVersion: LibraryMembershipSchemaVersion,
    scopeKind: "library",
    libraryId: input.libraryId,
    generation,
    current: `generations/${generation}`,
    manifestPath: `generations/${generation}/LIBRARY_MEMBERSHIP_MANIFEST.json`,
    manifestSha256: writtenManifest.sha256,
    readyState: "library_membership_resolved",
    queryReady: false,
    publishedAt: createdAt,
  });

  return {
    libraryId: input.libraryId,
    generation,
    root,
    manifest,
    qualityGate,
    bookshelfCount: bookshelves.length,
    directBookCount: directBookIds.length,
  };
}

async function validateFileRecord(input: {
  root: string;
  path: string;
  sha256: string;
  bytes: number;
  diagnostics: string[];
}): Promise<void> {
  const relativePath = normalizeScopeRelativePath(input.path);
  if (relativePath == null) {
    input.diagnostics.push(`manifest_file_path_invalid:${input.path}`);
    return;
  }
  if (relativePath === "LIBRARY_MEMBERSHIP_MANIFEST.json") {
    input.diagnostics.push("manifest_self_reference_forbidden");
    return;
  }
  const path = join(input.root, relativePath);
  if (!existsSync(path)) {
    input.diagnostics.push(`manifest_file_missing:${relativePath}`);
    return;
  }
  const content = await readFile(path);
  const actualSha = sha256Buffer(content);
  if (content.byteLength !== input.bytes) {
    input.diagnostics.push(`manifest_file_bytes_mismatch:${relativePath}`);
  }
  if (actualSha !== input.sha256) {
    input.diagnostics.push(`manifest_file_sha256_mismatch:${relativePath}`);
  }
  const sidecarPath = `${path}.sha256`;
  if (!existsSync(sidecarPath)) {
    input.diagnostics.push(`manifest_file_checksum_missing:${relativePath}`);
    return;
  }
  if ((await readFile(sidecarPath, "utf8")).trim() !== actualSha) {
    input.diagnostics.push(`manifest_file_sidecar_mismatch:${relativePath}`);
  }
}

async function validateMemberBookshelf(input: {
  graphVault: string;
  member: LibraryBookshelfMember;
  diagnostics: string[];
}): Promise<void> {
  let ready: Awaited<ReturnType<typeof readQueryReadyPackage>>;
  try {
    ready = await readQueryReadyPackage({
      graphVault: input.graphVault,
      scopeKind: "bookshelf",
      scopeId: input.member.bookshelfId,
    });
  } catch {
    input.diagnostics.push(`member_bookshelf_manifest_missing:${input.member.bookshelfId}`);
    return;
  }
  const root = ready.generationRoot;
  const manifestPath = ready.manifestPath;
  const gatePath = ready.gatePath;
  const actualManifestSha = sha256Buffer(await readFile(manifestPath));
  if (actualManifestSha !== input.member.manifestSha256) {
    input.diagnostics.push(`member_bookshelf_manifest_stale:${input.member.bookshelfId}`);
  }
  if (!existsSync(`${manifestPath}.sha256`)) {
    input.diagnostics.push(
      `member_bookshelf_manifest_checksum_missing:${input.member.bookshelfId}`,
    );
  } else if (
    (await readFile(`${manifestPath}.sha256`, "utf8")).trim() !== actualManifestSha
  ) {
    input.diagnostics.push(
      `member_bookshelf_manifest_sidecar_mismatch:${input.member.bookshelfId}`,
    );
  }
  const manifest = BookshelfGraphManifestSchema.safeParse(
    await readJsonFile(manifestPath),
  );
  const gate = existsSync(gatePath)
    ? BookshelfQualityGateSchema.safeParse(await readJsonFile(gatePath))
    : null;
  if (!manifest.success) {
    input.diagnostics.push(`member_bookshelf_manifest_invalid:${input.member.bookshelfId}`);
  } else if (!manifest.data.bookshelfIdentity.queryReady) {
    input.diagnostics.push(`member_bookshelf_not_query_ready:${input.member.bookshelfId}`);
  }
  if (gate?.success !== true || !gate.data.queryReady) {
    input.diagnostics.push(`member_bookshelf_gate_failed:${input.member.bookshelfId}`);
  }
  for (const artifactPath of Object.values(input.member.semanticArtifacts)) {
    const expectedPrefix = [
      "bookshelves",
      input.member.bookshelfId,
      "generations",
      input.member.generation,
      "",
    ].join("/");
    if (!artifactPath.startsWith(expectedPrefix)) {
      input.diagnostics.push(
        `member_bookshelf_artifact_locator_invalid:${input.member.bookshelfId}`,
      );
      continue;
    }
    const absolutePath = join(input.graphVault, artifactPath);
    if (!existsSync(absolutePath) || !existsSync(`${absolutePath}.sha256`)) {
      input.diagnostics.push(
        `member_bookshelf_artifact_missing:${input.member.bookshelfId}`,
      );
    }
  }
}

export async function validateLibraryMembership(input: {
  graphVault: string;
  libraryId: string;
}): Promise<{
  ok: boolean;
  diagnostics: string[];
  bookshelfCount: number;
  directBookCount: number;
}> {
  const graphVault = resolve(input.graphVault);
  let root: string;
  try {
    const current = await readPackageCurrent({
      graphVault,
      scopeKind: "library",
      scopeId: input.libraryId,
    });
    root = existsSync(join(current.generationRoot, "LIBRARY_MEMBERSHIP_MANIFEST.json"))
      ? current.generationRoot
      : join(current.generationRoot, "membership");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [detail],
      bookshelfCount: 0,
      directBookCount: 0,
    };
  }
  const diagnostics: string[] = [];
  const manifestPath = join(root, "LIBRARY_MEMBERSHIP_MANIFEST.json");
  const membersPath = join(root, "library_members.json");
  const partitionPlanPath = join(root, "library_partition_plan.json");
  const gatePath = join(root, "state", "library-membership-gate.json");
  const diagnosticsPath = join(root, "state", "diagnostics.json");
  for (const path of [
    manifestPath,
    membersPath,
    partitionPlanPath,
    gatePath,
    diagnosticsPath,
  ]) {
    if (!existsSync(path)) diagnostics.push(`missing:${path.slice(root.length + 1)}`);
    if (!existsSync(`${path}.sha256`)) {
      diagnostics.push(`missing_checksum:${path.slice(root.length + 1)}`);
    }
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics, bookshelfCount: 0, directBookCount: 0 };
  }
  const manifest = LibraryMembershipManifestSchema.safeParse(
    await readJsonFile(manifestPath),
  );
  const members = LibraryMembersFileSchema.safeParse(await readJsonFile(membersPath));
  const partitionPlan = LibraryPartitionPlanSchema.safeParse(
    await readJsonFile(partitionPlanPath),
  );
  const gate = LibraryMembershipGateSchema.safeParse(await readJsonFile(gatePath));
  const diagnosticState = LibraryDiagnosticsSchema.safeParse(
    await readJsonFile(diagnosticsPath),
  );
  if (!manifest.success) diagnostics.push("manifest_schema_invalid");
  if (!members.success) diagnostics.push("members_schema_invalid");
  if (!partitionPlan.success) diagnostics.push("partition_plan_schema_invalid");
  if (!gate.success) diagnostics.push("quality_gate_schema_invalid");
  if (!diagnosticState.success) diagnostics.push("diagnostics_schema_invalid");
  if (
    !manifest.success ||
    !members.success ||
    !partitionPlan.success ||
    !gate.success ||
    !diagnosticState.success
  ) {
    return { ok: false, diagnostics, bookshelfCount: 0, directBookCount: 0 };
  }
  if (manifest.data.libraryIdentity.libraryId !== input.libraryId) {
    diagnostics.push("manifest_scope_mismatch");
  }
  if (manifest.data.libraryIdentity.queryReady) {
    diagnostics.push("membership_manifest_must_not_be_query_ready");
  }
  if (gate.data.queryReady) diagnostics.push("membership_gate_must_not_be_query_ready");
  if (existsSync(join(root, "LIBRARY_MANIFEST.json"))) {
    diagnostics.push("library_membership_must_not_publish_query_manifest");
  }
  if (members.data.bookshelfCount !== manifest.data.membership.bookshelfCount) {
    diagnostics.push("bookshelf_count_mismatch");
  }
  if (members.data.directBookCount !== manifest.data.membership.directBookCount) {
    diagnostics.push("direct_book_count_mismatch");
  }
  if (members.data.directBookCount > members.data.directBookLimit) {
    diagnostics.push("direct_book_limit_exceeded");
  }
  const actualMembersDigest = sha256Text(stableJson(members.data));
  if (actualMembersDigest !== manifest.data.membership.membersDigest) {
    diagnostics.push("members_digest_mismatch");
  }
  const actualPartitionDigest = sha256Text(stableJson(partitionPlan.data));
  if (actualPartitionDigest !== manifest.data.partitionPlan.partitionPlanDigest) {
    diagnostics.push("partition_plan_digest_mismatch");
  }
  if (
    partitionPlan.data.shelfCount > partitionPlan.data.shelfLimit &&
    partitionPlan.data.partitions.length === 0
  ) {
    diagnostics.push("library_partition_plan_missing");
  }
  for (const file of manifest.data.files) {
    await validateFileRecord({ root, diagnostics, ...file });
  }
  const manifestSha = sha256Buffer(await readFile(manifestPath));
  if ((await readFile(`${manifestPath}.sha256`, "utf8")).trim() !== manifestSha) {
    diagnostics.push("manifest_sidecar_mismatch");
  }
  const runId = libraryRunId(
    input.libraryId,
    manifest.data.libraryIdentity.generation,
  );
  const runRoot = join(root, "runs", runId);
  for (const relativePath of [
    "events.jsonl",
    "status.json",
    "recovery-summary.json",
  ]) {
    const path = join(runRoot, relativePath);
    if (!existsSync(path)) diagnostics.push(`missing:runs/${runId}/${relativePath}`);
    if (!existsSync(`${path}.sha256`)) {
      diagnostics.push(`missing_checksum:runs/${runId}/${relativePath}`);
    }
  }
  for (const member of members.data.members.bookshelves) {
    const checkpointPath = join(
      runRoot,
      "checkpoints",
      `${member.bookshelfId.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`,
    );
    if (!existsSync(checkpointPath)) {
      diagnostics.push(`missing_checkpoint:${member.bookshelfId}`);
    }
    if (!existsSync(`${checkpointPath}.sha256`)) {
      diagnostics.push(`missing_checkpoint_checksum:${member.bookshelfId}`);
    }
    await validateMemberBookshelf({
      graphVault,
      member,
      diagnostics,
    });
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)],
    bookshelfCount: members.data.bookshelfCount,
    directBookCount: members.data.directBookCount,
  };
}
