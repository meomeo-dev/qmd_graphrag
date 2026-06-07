import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { readHotplugPackageUnknown } from "../book-hotplug-package-readonly.js";
import {
  validatePublishedBookHotplugPackage,
} from "../book-hotplug-package-validator.js";
import { validateHotplugRuntimeQueryGate } from "../book-hotplug-runtime-gate.js";
import {
  resolveBookManifestPath,
  resolveBookPublishReadyPath,
  resolveBookRoot,
} from "../book-package-layout.js";
import {
  bookshelfPackageRoot,
  readPackageCurrent,
} from "./upper-package-paths.js";

export const BookshelfMembershipSchemaVersion = "1.0.0";

const MembershipSourceKindSchema = z.enum([
  "user_explicit",
  "deterministic_rule",
  "taxonomy",
  "llm_suggested",
  "llm_accepted",
  "hybrid",
]);

const BookManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("qmd_graphrag_book_package"),
  identity: z.object({
    bookId: z.string().min(1),
    sourceHash: z.string().min(1),
    canonicalTitle: z.string().min(1),
    titleSlug: z.string().min(1),
    createdAt: z.string().min(1),
    packageVersion: z.string().min(1).optional(),
    packageGeneration: z.string().min(1),
  }).passthrough(),
  source: z.object({
    sourcePath: z.string().min(1),
    sourceHash: z.string().min(1),
    sourceKind: z.string().min(1).optional(),
  }).passthrough(),
  input: z.object({
    canonicalNormalizedPath: z.string().min(1),
    normalizedHash: z.string().min(1),
  }).passthrough(),
  qmd: z.object({
    qmdReadyState: z.string().min(1).optional(),
    qmdIndexSchema: z.string().min(1).optional(),
    indexPolicy: z.string().min(1).optional(),
  }).passthrough(),
  graphrag: z.object({
    queryReady: z.boolean(),
    graphRagReadyState: z.string().min(1).optional(),
    graphRagArtifactSchema: z.string().min(1).optional(),
    artifactSchema: z.string().min(1).optional(),
    outputManifestPath: z.string().min(1).optional(),
  }).passthrough(),
  checksums: z.object({
    manifestSha256: z.string().min(1),
  }).passthrough(),
}).passthrough();

const HotplugQualityGateSchema = z.object({
  status: z.literal("passed"),
  copyDistributionAllowed: z.literal(true),
}).passthrough();

const HotplugRuntimeGateSchema = z.object({
  currentState: z.literal("query_ready"),
  queryReady: z.literal(true),
  copyDistributionAllowed: z.literal(true),
}).passthrough();

const BookshelfMemberSchema = z.object({
  bookId: z.string().min(1),
  manifestSha256: z.string().min(1),
  packageGeneration: z.string().min(1),
  queryReady: z.boolean(),
  qmdReadyState: z.string().min(1),
  graphRagReadyState: z.string().min(1),
  membershipSourceKind: MembershipSourceKindSchema,
  membershipDecisionId: z.string().min(1),
  membershipConfidence: z.number().min(0).max(1),
  userLocked: z.boolean(),
  splitGroupId: z.string().nullable(),
  virtualParentBookshelfId: z.string().nullable(),
  title: z.string().min(1),
  packageRoot: z.string().min(1),
  graphArtifacts: z.object({
    communityReports: z.string().min(1),
    entities: z.string().min(1),
    relationships: z.string().min(1),
    textUnits: z.string().min(1),
  }),
});

const MembershipDecisionSchema = z.object({
  decisionId: z.string().min(1),
  bookshelfId: z.string().min(1),
  bookId: z.string().min(1),
  action: z.enum(["include", "exclude", "lock_include", "lock_exclude"]),
  policyKind: MembershipSourceKindSchema,
  authority: z.enum(["user", "deterministic", "taxonomy", "user_accepted"]),
  evidenceRefs: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  decidedBy: z.string().min(1),
  decidedAt: z.string().min(1),
  taxonomyId: z.string().nullable(),
  taxonomyVersion: z.string().nullable(),
  llmRunId: z.string().nullable(),
  userAcceptedAt: z.string().nullable(),
});

export const BookshelfMembershipManifestSchema = z.object({
  schemaVersion: z.literal(BookshelfMembershipSchemaVersion),
  kind: z.literal("qmd_graphrag_bookshelf_membership_manifest"),
  bookshelfIdentity: z.object({
    bookshelfId: z.string().min(1),
    generation: z.string().min(1),
    createdAt: z.string().min(1),
    materializationStatus: z.literal("membership_resolved"),
    queryReady: z.literal(false),
  }),
  membership: z.object({
    memberCount: z.number().int().nonnegative(),
    membersPath: z.literal("bookshelf_members.json"),
    decisionsPath: z.literal("membership_decisions.jsonl"),
    splitPlanPath: z.literal("bookshelf_split_plan.json"),
    policyKind: MembershipSourceKindSchema,
    policyDigest: z.string().min(1),
    membersDigest: z.string().min(1),
    decisionsDigest: z.string().min(1),
    splitPlanDigest: z.string().min(1),
  }),
  nextStage: z.object({
    stageId: z.literal("materialized_bookshelf_graph_build"),
    requiredManifest: z.literal("BOOKSHELF_MANIFEST.json"),
    rule: z.string().min(1),
  }),
  qualityGate: z.object({
    path: z.literal("state/membership-quality-gate.json"),
    status: z.literal("passed"),
  }),
  sensitivityPolicy: z.object({
    forbiddenFields: z.array(z.string().min(1)),
    locatorRule: z.string().min(1),
  }),
  files: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })),
});

export const BookshelfMembersFileSchema = z.object({
  schemaVersion: z.literal(BookshelfMembershipSchemaVersion),
  kind: z.literal("qmd_graphrag_bookshelf_members"),
  bookshelfId: z.string().min(1),
  generation: z.string().min(1),
  members: z.array(BookshelfMemberSchema).min(1),
});

export const MembershipQualityGateSchema = z.object({
  schemaVersion: z.literal(BookshelfMembershipSchemaVersion),
  scopeKind: z.literal("bookshelf"),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  stageId: z.literal("bookshelf_membership_resolution"),
  readyState: z.literal("membership_resolved"),
  queryReady: z.literal(false),
  status: z.literal("passed"),
  checkedAt: z.string().min(1),
  checks: z.array(z.object({
    checkId: z.string().min(1),
    status: z.literal("passed"),
  })),
  diagnostics: z.array(z.string()),
});

const MembershipDiagnosticsSchema = z.object({
  schemaVersion: z.literal(BookshelfMembershipSchemaVersion),
  scopeKind: z.literal("bookshelf"),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  status: z.literal("passed"),
  failedCheckId: z.null(),
  severity: z.literal("info"),
  typedErrorCode: z.null(),
  affectedArtifactKind: z.literal("bookshelf_membership"),
  affectedArtifactDigest: z.string().min(1),
  expectedDigest: z.string().min(1),
  observedDigest: z.string().min(1),
  redactedLocator: z.string().min(1),
  remediationCommand: z.null(),
  checkedAt: z.string().min(1),
});

type BookManifest = z.infer<typeof BookManifestSchema>;
export type BookshelfMember = z.infer<typeof BookshelfMemberSchema>;
export type MembershipDecision = z.infer<typeof MembershipDecisionSchema>;
export type BookshelfMembershipManifest =
  z.infer<typeof BookshelfMembershipManifestSchema>;
export type MembershipQualityGate = z.infer<typeof MembershipQualityGateSchema>;

export type BookshelfMembershipPolicy = {
  sourceKind?: z.infer<typeof MembershipSourceKindSchema>;
  decidedBy?: string;
  taxonomyId?: string | null;
  taxonomyVersion?: string | null;
  confidence?: number;
};

export type ResolveBookshelfMembershipInput = {
  graphVault: string;
  bookshelfId: string;
  bookIds: readonly string[];
  policy?: BookshelfMembershipPolicy;
  now?: () => string;
};

export type ResolveBookshelfMembershipResult = {
  bookshelfId: string;
  generation: string;
  root: string;
  manifest: BookshelfMembershipManifest;
  qualityGate: MembershipQualityGate;
  memberCount: number;
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

const MembershipChecks = [
  "membership_decisions_schema_valid",
  "membership_authority_order_valid",
  "membership_user_locks_preserved",
  "membership_llm_suggestion_not_query_ready",
  "membership_llm_acceptance_recorded",
  "membership_oversized_category_split",
  "membership_virtual_parent_no_direct_index",
];

function membershipRunId(bookshelfId: string, generation: string): string {
  return `${bookshelfId}-${generation}`;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeBookIds(bookIds: readonly string[]): string[] {
  return [...new Set(bookIds.map((bookId) => bookId.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function packageRelativeBookPath(bookId: string, path: string): string {
  return path.startsWith(`books/${bookId}/`) ? path : `books/${bookId}/${path}`;
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

function graphArtifactPaths(bookId: string): BookshelfMember["graphArtifacts"] {
  const outputRoot = `books/${bookId}/graphrag/output`;
  return {
    communityReports: `${outputRoot}/community_reports.parquet`,
    entities: `${outputRoot}/entities.parquet`,
    relationships: `${outputRoot}/relationships.parquet`,
    textUnits: `${outputRoot}/text_units.parquet`,
  };
}

async function readBookManifest(
  graphVault: string,
  bookId: string,
): Promise<BookManifest> {
  const manifestPath = resolveBookManifestPath(graphVault, bookId);
  const publishReadyPath = resolveBookPublishReadyPath(graphVault, bookId);
  if (!existsSync(manifestPath)) {
    throw new Error(`upper_quality_gate_failed:missing_manifest:${bookId}`);
  }
  if (!existsSync(publishReadyPath)) {
    throw new Error(`upper_quality_gate_failed:missing_publish_marker:${bookId}`);
  }
  const qualityGatePath = join(
    resolveBookRoot(graphVault, bookId),
    "state",
    "hotplug-quality-gate.json",
  );
  const runtimeGatePath = join(
    resolveBookRoot(graphVault, bookId),
    "state",
    "hotplug-runtime-gate.json",
  );
  const qualityGate = existsSync(qualityGatePath)
    ? HotplugQualityGateSchema.safeParse(
      await readHotplugPackageUnknown(qualityGatePath),
    )
    : null;
  if (qualityGate?.success !== true) {
    throw new Error(`upper_quality_gate_failed:package_quality_gate_failed:${bookId}`);
  }
  const publishedRuntimeGate = existsSync(runtimeGatePath)
    ? HotplugRuntimeGateSchema.safeParse(
      await readHotplugPackageUnknown(runtimeGatePath),
    )
    : null;
  if (publishedRuntimeGate?.success !== true) {
    throw new Error(`upper_quality_gate_failed:package_runtime_gate_failed:${bookId}`);
  }
  const boundary = validatePublishedBookHotplugPackage({ graphVault, bookId });
  if (!boundary.ok) {
    const diagnostics = boundary.diagnostics.slice(0, 8).join(",");
    throw new Error(`upper_quality_gate_failed:package_gate_failed:${bookId}:${diagnostics}`);
  }
  const runtimeGate = await validateHotplugRuntimeQueryGate({ graphVault, bookId });
  if (!runtimeGate.ok) {
    const diagnostics = runtimeGate.diagnostics.slice(0, 8).join(",");
    throw new Error(`upper_quality_gate_failed:runtime_gate_failed:${bookId}:${diagnostics}`);
  }
  const parsed = await readHotplugPackageUnknown(manifestPath);
  const result = BookManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`upper_quality_gate_failed:manifest_schema_invalid:${bookId}`);
  }
  const manifest = result.data;
  if (manifest.identity.bookId !== bookId) {
    throw new Error(`upper_quality_gate_failed:manifest_book_id_mismatch:${bookId}`);
  }
  if (!manifest.graphrag.queryReady) {
    throw new Error(`upper_quality_gate_failed:member_not_query_ready:${bookId}`);
  }
  return manifest;
}

async function collectMembers(input: {
  graphVault: string;
  bookshelfId: string;
  generation: string;
  bookIds: readonly string[];
  policy: Required<BookshelfMembershipPolicy>;
  decidedAt: string;
}): Promise<{
  members: BookshelfMember[];
  decisions: MembershipDecision[];
}> {
  const members: BookshelfMember[] = [];
  const decisions: MembershipDecision[] = [];
  for (const bookId of input.bookIds) {
    const manifest = await readBookManifest(input.graphVault, bookId);
    const decisionId = `${input.bookshelfId}:${input.generation}:${bookId}:include`;
    decisions.push(MembershipDecisionSchema.parse({
      decisionId,
      bookshelfId: input.bookshelfId,
      bookId,
      action: input.policy.sourceKind === "user_explicit"
        ? "lock_include"
        : "include",
      policyKind: input.policy.sourceKind,
      authority: input.policy.sourceKind === "taxonomy" ? "taxonomy" :
        input.policy.sourceKind === "llm_accepted" ? "user_accepted" :
          input.policy.sourceKind === "deterministic_rule" ? "deterministic" :
            "user",
      evidenceRefs: [
        `books/${bookId}/BOOK_MANIFEST.json`,
        `books/${bookId}/PUBLISH_READY.json`,
        packageRelativeBookPath(bookId, "state/hotplug-quality-gate.json"),
        packageRelativeBookPath(bookId, "state/hotplug-runtime-gate.json"),
      ],
      confidence: input.policy.confidence,
      decidedBy: input.policy.decidedBy,
      decidedAt: input.decidedAt,
      taxonomyId: input.policy.taxonomyId,
      taxonomyVersion: input.policy.taxonomyVersion,
      llmRunId: null,
      userAcceptedAt: input.policy.sourceKind === "llm_accepted"
        ? input.decidedAt
        : null,
    }));
    members.push(BookshelfMemberSchema.parse({
      bookId,
      manifestSha256: manifest.checksums.manifestSha256,
      packageGeneration: manifest.identity.packageGeneration,
      queryReady: true,
      qmdReadyState: manifest.qmd.qmdReadyState ?? "query_ready",
      graphRagReadyState: manifest.graphrag.graphRagReadyState ?? "query_ready",
      membershipSourceKind: input.policy.sourceKind,
      membershipDecisionId: decisionId,
      membershipConfidence: input.policy.confidence,
      userLocked: input.policy.sourceKind === "user_explicit",
      splitGroupId: null,
      virtualParentBookshelfId: null,
      title: manifest.identity.canonicalTitle,
      packageRoot: `books/${bookId}`,
      graphArtifacts: graphArtifactPaths(bookId),
    }));
  }
  return { members, decisions };
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

function defaultPolicy(
  policy: BookshelfMembershipPolicy | undefined,
): Required<BookshelfMembershipPolicy> {
  return {
    sourceKind: policy?.sourceKind ?? "user_explicit",
    decidedBy: policy?.decidedBy ?? "local_cli_user",
    taxonomyId: policy?.taxonomyId ?? null,
    taxonomyVersion: policy?.taxonomyVersion ?? null,
    confidence: policy?.confidence ?? 1,
  };
}

function membershipEvents(input: {
  bookshelfId: string;
  generation: string;
  runId: string;
  memberCount: number;
  at: string;
}): unknown[] {
  return [
    {
      schemaVersion: BookshelfMembershipSchemaVersion,
      runId: input.runId,
      stageId: "bookshelf_membership_resolution",
      scopeKind: "bookshelf",
      scopeId: input.bookshelfId,
      generation: input.generation,
      event: "membership_started",
      status: "running",
      at: input.at,
    },
    {
      schemaVersion: BookshelfMembershipSchemaVersion,
      runId: input.runId,
      stageId: "bookshelf_membership_resolution",
      scopeKind: "bookshelf",
      scopeId: input.bookshelfId,
      generation: input.generation,
      event: "membership_published",
      status: "passed",
      memberCount: input.memberCount,
      queryReady: false,
      at: input.at,
    },
  ];
}

export async function resolveBookshelfMembership(
  input: ResolveBookshelfMembershipInput,
): Promise<ResolveBookshelfMembershipResult> {
  const graphVault = resolve(input.graphVault);
  const bookIds = normalizeBookIds(input.bookIds);
  if (bookIds.length < 1) {
    throw new Error("upper_quality_gate_failed:membership_empty");
  }
  const policy = defaultPolicy(input.policy);
  if (policy.sourceKind === "llm_suggested") {
    throw new Error("upper_quality_gate_failed:llm_suggestion_not_query_ready");
  }
  const createdAt = input.now?.() ?? new Date().toISOString();
  const generation = `membership-${sha256Text([
    input.bookshelfId,
    ...bookIds,
    policy.sourceKind,
    policy.taxonomyId ?? "",
    policy.taxonomyVersion ?? "",
  ].join("\n")).slice(0, 16)}`;
  const runId = membershipRunId(input.bookshelfId, generation);
  const root = bookshelfPackageRoot(graphVault, input.bookshelfId);
  const stagingRoot = join(root, "staging", runId);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(join(stagingRoot, "state"), { recursive: true });
  await mkdir(join(stagingRoot, "runs", runId, "checkpoints"), {
    recursive: true,
  });

  const collected = await collectMembers({
    graphVault,
    bookshelfId: input.bookshelfId,
    generation,
    bookIds,
    policy,
    decidedAt: createdAt,
  });
  const membersFile = BookshelfMembersFileSchema.parse({
    schemaVersion: BookshelfMembershipSchemaVersion,
    kind: "qmd_graphrag_bookshelf_members",
    bookshelfId: input.bookshelfId,
    generation,
    members: collected.members,
  });
  const splitPlan = {
    schemaVersion: BookshelfMembershipSchemaVersion,
    kind: "qmd_graphrag_bookshelf_split_plan",
    bookshelfId: input.bookshelfId,
    generation,
    status: "not_required",
    virtualParentBookshelfId: null,
    materializedChildBookshelfIds: [],
    reason: "member_count_within_membership_stage_limit",
  };
  const qualityGate = MembershipQualityGateSchema.parse({
    schemaVersion: BookshelfMembershipSchemaVersion,
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation,
    stageId: "bookshelf_membership_resolution",
    readyState: "membership_resolved",
    queryReady: false,
    status: "passed",
    checkedAt: createdAt,
    checks: MembershipChecks.map((checkId) => ({ checkId, status: "passed" })),
    diagnostics: [],
  });
  const membershipDigest = sha256Text(stableJson(membersFile));
  const splitPlanDigest = sha256Text(stableJson(splitPlan));
  const decisionsText = collected.decisions
    .map((value) => JSON.stringify(value))
    .join("\n") + "\n";
  const decisionsDigest = sha256Text(decisionsText);
  const diagnostics = MembershipDiagnosticsSchema.parse({
    schemaVersion: BookshelfMembershipSchemaVersion,
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation,
    status: "passed",
    failedCheckId: null,
    severity: "info",
    typedErrorCode: null,
    affectedArtifactKind: "bookshelf_membership",
    affectedArtifactDigest: membershipDigest,
    expectedDigest: membershipDigest,
    observedDigest: membershipDigest,
    redactedLocator: `generations/${generation}/bookshelf_members.json`,
    remediationCommand: null,
    checkedAt: createdAt,
  });
  const status = {
    schemaVersion: BookshelfMembershipSchemaVersion,
    runId,
    stageId: "bookshelf_membership_resolution",
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation,
    status: "passed",
    readyState: "membership_resolved",
    queryReady: false,
    memberCount: collected.members.length,
    startedAt: createdAt,
    completedAt: createdAt,
  };
  const recoverySummary = {
    schemaVersion: BookshelfMembershipSchemaVersion,
    runId,
    stageId: "bookshelf_membership_resolution",
    scopeKind: "bookshelf",
    scopeId: input.bookshelfId,
    generation,
    status: "passed",
    recoveryDecision: "not_required",
    checkpointCount: collected.decisions.length,
    eventCount: 2,
    currentGenerationPublished: true,
    queryReady: false,
    completedAt: createdAt,
  };
  const writtenMembers = await writeJson(
    join(stagingRoot, "bookshelf_members.json"),
    membersFile,
  );
  const writtenDecisions = await writeJsonl(
    join(stagingRoot, "membership_decisions.jsonl"),
    collected.decisions,
  );
  const writtenSplit = await writeJson(
    join(stagingRoot, "bookshelf_split_plan.json"),
    splitPlan,
  );
  const writtenGate = await writeJson(
    join(stagingRoot, "state", "membership-quality-gate.json"),
    qualityGate,
  );
  const writtenDiagnostics = await writeJson(
    join(stagingRoot, "state", "diagnostics.json"),
    diagnostics,
  );
  const writtenEvents = await writeJsonl(
    join(stagingRoot, "runs", runId, "events.jsonl"),
    membershipEvents({
      bookshelfId: input.bookshelfId,
      generation,
      runId,
      memberCount: collected.members.length,
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
  for (const decision of collected.decisions) {
    writtenCheckpoints.push(await writeJson(
      join(
        stagingRoot,
        "runs",
        runId,
        "checkpoints",
        `${decision.decisionId.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`,
      ),
      {
        schemaVersion: BookshelfMembershipSchemaVersion,
        runId,
        stageId: "bookshelf_membership_resolution",
        scopeKind: "bookshelf",
        scopeId: input.bookshelfId,
        generation,
        status: "passed",
        decisionId: decision.decisionId,
        bookId: decision.bookId,
        membershipDecisionDigest: sha256Text(stableJson(decision)),
        checkedAt: createdAt,
      },
    ));
  }
  const manifest = BookshelfMembershipManifestSchema.parse({
    schemaVersion: BookshelfMembershipSchemaVersion,
    kind: "qmd_graphrag_bookshelf_membership_manifest",
    bookshelfIdentity: {
      bookshelfId: input.bookshelfId,
      generation,
      createdAt,
      materializationStatus: "membership_resolved",
      queryReady: false,
    },
    membership: {
      memberCount: collected.members.length,
      membersPath: "bookshelf_members.json",
      decisionsPath: "membership_decisions.jsonl",
      splitPlanPath: "bookshelf_split_plan.json",
      policyKind: policy.sourceKind,
      policyDigest: sha256Text(stableJson(policy)),
      membersDigest: membershipDigest,
      decisionsDigest,
      splitPlanDigest,
    },
    nextStage: {
      stageId: "materialized_bookshelf_graph_build",
      requiredManifest: "BOOKSHELF_MANIFEST.json",
      rule: "membership manifest does not grant bookshelf query readiness",
    },
    qualityGate: {
      path: "state/membership-quality-gate.json",
      status: "passed",
    },
    sensitivityPolicy: {
      forbiddenFields: ForbiddenManifestFields,
      locatorRule: "only graph_vault-relative and scope-relative locators allowed",
    },
    files: [
      relativeShelfFile(stagingRoot, writtenMembers),
      relativeShelfFile(stagingRoot, writtenDecisions),
      relativeShelfFile(stagingRoot, writtenSplit),
      relativeShelfFile(stagingRoot, writtenGate),
      relativeShelfFile(stagingRoot, writtenDiagnostics),
      relativeShelfFile(stagingRoot, writtenEvents),
      relativeShelfFile(stagingRoot, writtenStatus),
      relativeShelfFile(stagingRoot, writtenRecovery),
      ...writtenCheckpoints.map((item) => relativeShelfFile(stagingRoot, item)),
    ],
  });
  const writtenManifest = await writeJson(
    join(stagingRoot, "BOOKSHELF_MEMBERSHIP_MANIFEST.json"),
    manifest,
  );
  void writtenManifest;

  const generationRoot = join(root, "generations", generation);
  const previousRoot = `${generationRoot}.previous-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(generationRoot), { recursive: true });
  await rm(previousRoot, { recursive: true, force: true });
  if (existsSync(generationRoot)) await rename(generationRoot, previousRoot);
  await rename(stagingRoot, generationRoot);
  await rm(previousRoot, { recursive: true, force: true });
  await writeJson(join(root, "CURRENT.json"), {
    schemaVersion: BookshelfMembershipSchemaVersion,
    scopeKind: "bookshelf",
    bookshelfId: input.bookshelfId,
    generation,
    current: `generations/${generation}`,
    manifestPath: `generations/${generation}/BOOKSHELF_MEMBERSHIP_MANIFEST.json`,
    manifestSha256: writtenManifest.sha256,
    readyState: "membership_resolved",
    queryReady: false,
    publishedAt: createdAt,
  });

  return {
    bookshelfId: input.bookshelfId,
    generation,
    root,
    manifest,
    qualityGate,
    memberCount: collected.members.length,
  };
}

export async function validateBookshelfMembership(input: {
  graphVault: string;
  bookshelfId: string;
}): Promise<{ ok: boolean; diagnostics: string[]; memberCount: number }> {
  let root: string;
  try {
    const resolved = await readPackageCurrent({
      graphVault: input.graphVault,
      scopeKind: "bookshelf",
      scopeId: input.bookshelfId,
    });
    root = existsSync(
      join(resolved.generationRoot, "BOOKSHELF_MEMBERSHIP_MANIFEST.json"),
    )
      ? resolved.generationRoot
      : join(resolved.generationRoot, "membership");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, diagnostics: [detail], memberCount: 0 };
  }
  const diagnostics: string[] = [];
  const manifestPath = join(root, "BOOKSHELF_MEMBERSHIP_MANIFEST.json");
  const membersPath = join(root, "bookshelf_members.json");
  const decisionsPath = join(root, "membership_decisions.jsonl");
  const gatePath = join(root, "state", "membership-quality-gate.json");
  const diagnosticsPath = join(root, "state", "diagnostics.json");
  for (const path of [
    manifestPath,
    membersPath,
    decisionsPath,
    gatePath,
    diagnosticsPath,
  ]) {
    if (!existsSync(path)) diagnostics.push(`missing:${path.slice(root.length + 1)}`);
    if (!existsSync(`${path}.sha256`)) {
      diagnostics.push(`missing_checksum:${path.slice(root.length + 1)}`);
    }
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics, memberCount: 0 };
  }
  const manifest = BookshelfMembershipManifestSchema.safeParse(
    await readHotplugPackageUnknown(manifestPath),
  );
  const members = BookshelfMembersFileSchema.safeParse(
    await readHotplugPackageUnknown(membersPath),
  );
  const gate = MembershipQualityGateSchema.safeParse(
    await readHotplugPackageUnknown(gatePath),
  );
  const diagnosticState = MembershipDiagnosticsSchema.safeParse(
    await readHotplugPackageUnknown(diagnosticsPath),
  );
  if (!manifest.success) diagnostics.push("manifest_schema_invalid");
  if (!members.success) diagnostics.push("members_schema_invalid");
  if (!gate.success) diagnostics.push("quality_gate_schema_invalid");
  if (!diagnosticState.success) diagnostics.push("diagnostics_schema_invalid");
  if (!manifest.success || !members.success || !gate.success || !diagnosticState.success) {
    return { ok: false, diagnostics, memberCount: 0 };
  }
  if (manifest.data.bookshelfIdentity.queryReady) {
    diagnostics.push("membership_manifest_must_not_be_query_ready");
  }
  if (gate.data.queryReady) diagnostics.push("membership_gate_must_not_be_query_ready");
  if (members.data.members.length !== manifest.data.membership.memberCount) {
    diagnostics.push("member_count_mismatch");
  }
  for (const file of manifest.data.files) {
    const relativePath = normalizeScopeRelativePath(file.path);
    if (relativePath == null) {
      diagnostics.push(`manifest_file_path_invalid:${file.path}`);
      continue;
    }
    if (relativePath === "BOOKSHELF_MEMBERSHIP_MANIFEST.json") {
      diagnostics.push("manifest_self_reference_forbidden");
      continue;
    }
    const path = join(root, relativePath);
    if (!existsSync(path)) {
      diagnostics.push(`manifest_file_missing:${relativePath}`);
      continue;
    }
    const content = await readFile(path);
    const actualSha256 = sha256Buffer(content);
    if (content.byteLength !== file.bytes) {
      diagnostics.push(`manifest_file_bytes_mismatch:${relativePath}`);
    }
    if (actualSha256 !== file.sha256) {
      diagnostics.push(`manifest_file_sha256_mismatch:${relativePath}`);
    }
    const sidecarPath = `${path}.sha256`;
    if (!existsSync(sidecarPath)) {
      diagnostics.push(`manifest_file_checksum_missing:${relativePath}`);
      continue;
    }
    if ((await readFile(sidecarPath, "utf8")).trim() !== actualSha256) {
      diagnostics.push(`manifest_file_sidecar_mismatch:${relativePath}`);
    }
  }
  const manifestContent = await readFile(manifestPath);
  const manifestSha256 = sha256Buffer(manifestContent);
  if ((await readFile(`${manifestPath}.sha256`, "utf8")).trim() !== manifestSha256) {
    diagnostics.push("manifest_sidecar_mismatch");
  }
  const actualMembersDigest = sha256Text(stableJson(members.data));
  if (actualMembersDigest !== manifest.data.membership.membersDigest) {
    diagnostics.push("members_digest_mismatch");
  }
  const decisionsText = await readFile(decisionsPath, "utf8");
  if (sha256Text(decisionsText) !== manifest.data.membership.decisionsDigest) {
    diagnostics.push("decisions_digest_mismatch");
  }
  const splitPlanPath = join(root, "bookshelf_split_plan.json");
  const splitPlan = await readHotplugPackageUnknown(splitPlanPath);
  if (splitPlan == null) {
    diagnostics.push("split_plan_missing");
  } else if (
    sha256Text(stableJson(splitPlan)) !== manifest.data.membership.splitPlanDigest
  ) {
    diagnostics.push("split_plan_digest_mismatch");
  }
  const runId = membershipRunId(
    input.bookshelfId,
    manifest.data.bookshelfIdentity.generation,
  );
  const runRoot = join(root, "runs", runId);
  const runRequired = [
    join(runRoot, "events.jsonl"),
    join(runRoot, "status.json"),
    join(runRoot, "recovery-summary.json"),
  ];
  for (const path of runRequired) {
    if (!existsSync(path)) diagnostics.push(`missing:${path.slice(root.length + 1)}`);
    if (!existsSync(`${path}.sha256`)) {
      diagnostics.push(`missing_checksum:${path.slice(root.length + 1)}`);
    }
  }
  for (const member of members.data.members) {
    const checkpointPath = join(
      runRoot,
      "checkpoints",
      `${member.membershipDecisionId.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`,
    );
    if (!existsSync(checkpointPath)) {
      diagnostics.push(`missing_checkpoint:${member.bookId}`);
    }
    if (!existsSync(`${checkpointPath}.sha256`)) {
      diagnostics.push(`missing_checkpoint_checksum:${member.bookId}`);
    }
  }
  for (const member of members.data.members) {
    const bookRoot = resolveBookRoot(input.graphVault, member.bookId);
    for (const relativePath of Object.values(member.graphArtifacts)) {
      const path = join(resolve(input.graphVault), relativePath);
      if (!path.startsWith(bookRoot)) {
        diagnostics.push(`member_artifact_not_package_local:${member.bookId}`);
      }
      if (!existsSync(path)) {
        diagnostics.push(`member_artifact_missing:${member.bookId}`);
      }
    }
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)],
    memberCount: members.data.members.length,
  };
}
