import { SchemaVersion } from "../contracts/common.js";
import {
  buildBookshelfGraph,
  validateBookshelfGraph,
} from "../graphrag/upper-index/bookshelf-graph.js";
import {
  readBookshelfMembershipCurrent,
  resolveBookshelfMembership,
  validateBookshelfMembership,
} from "../graphrag/upper-index/bookshelf-membership.js";
import {
  buildLibraryGraph,
  validateLibraryGraph,
} from "../graphrag/upper-index/library-graph.js";
import {
  readLibraryMembershipCurrent,
  resolveLibraryMembership,
  validateLibraryMembership,
} from "../graphrag/upper-index/library-membership.js";
import {
  getUpperPackageStatus,
  listUpperPackageStatuses,
} from "../graphrag/upper-index/upper-management.js";
import type {
  UpperPackageStatus,
} from "../graphrag/upper-index/upper-management.js";
import type { UpperScopeKind } from "../graphrag/upper-index/upper-package-paths.js";

export type UpperManagementCommandInput = {
  graphVault: string;
  scopeKind: UpperScopeKind;
  args: string[];
  json: boolean;
  values: Record<string, unknown>;
};

function scopeName(scopeKind: UpperScopeKind): string {
  return scopeKind === "bookshelf" ? "bookshelf" : "library";
}

function usage(scopeKind: UpperScopeKind): string {
  const scope = scopeName(scopeKind);
  return [
    `Usage: qmd ${scope} <command> [options]`,
    "",
    "Commands:",
    `  build <id>         Build query-ready ${scope} graph from package membership`,
    `  rebuild <id>       Rebuild query-ready ${scope} graph from package membership`,
    `  refresh-membership <id>`,
    `                     Materialize a new package-root ${scope} membership generation`,
    `  repair <id>        Revalidate membership and rebuild query-ready ${scope} graph`,
    `  status <id>        Show package-root ${scope} readiness state`,
    `  list               List package-root ${scope} packages`,
    "",
    "Options:",
    "  --graph-vault <path>  GraphRAG vault root, default graph_vault",
    "  --python-bin <path>   Python executable for parquet bridge",
    "  --book-id <id>        Bookshelf refresh only; repeat for each member book",
    "  --member-bookshelf-id <id>",
    "                        Library refresh only; repeat for each member bookshelf",
    "  --policy-kind <kind>  user_explicit | deterministic_rule | taxonomy | llm_accepted",
    "  --decided-by <actor>  Bounded actor id, default local_cli_user",
    "  --shelf-limit <n>     Library refresh partition limit, default 32",
    "  --direct-book-limit <n>",
    "  --max-semantic-units <n>",
    "  --max-edges <n>",
    "  --max-reports-per-book <n>   Bookshelf build only",
    "  --max-reports-per-shelf <n>  Library build only",
    "  --json                Print structured JSON",
  ].join("\n");
}

function outputJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printStatus(status: UpperPackageStatus): void {
  console.log(`${scopeName(status.scopeKind)}: ${status.scopeId}`);
  console.log(`  status: ${status.status}`);
  console.log(`  queryReady: ${status.queryReady ? "true" : "false"}`);
  console.log(`  readyState: ${status.readyState ?? "-"}`);
  console.log(`  generation: ${status.generation ?? "-"}`);
  console.log(`  packageRoot: ${status.packageRoot}`);
  console.log(`  manifest: ${status.manifestPath ?? "-"}`);
  console.log(`  qualityGate: ${status.qualityGatePath ?? "-"}`);
  console.log(
    `  catalogProjection: ${status.catalogProjectionExists ? "present" : "missing"}`,
  );
  if (Object.keys(status.summary).length > 0) {
    console.log(`  summary: ${JSON.stringify(status.summary)}`);
  }
  if (status.diagnostics.length > 0) {
    console.log(`  diagnostics: ${status.diagnostics.join(", ")}`);
  }
}

function printList(scopeKind: UpperScopeKind, statuses: UpperPackageStatus[]): void {
  if (statuses.length === 0) {
    console.log(`No ${scopeName(scopeKind)} packages found.`);
    return;
  }
  for (const status of statuses) {
    console.log([
      status.scopeId,
      status.status,
      status.readyState ?? "-",
      status.generation ?? "-",
    ].join("\t"));
  }
}

function positiveIntegerOption(
  values: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = values[name];
  if (value == null) return fallback;
  if (typeof value === "boolean") {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeIntegerOption(
  values: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = values[name];
  if (value == null) return fallback;
  if (typeof value === "boolean") {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function optionalStringOption(
  values: Record<string, unknown>,
  name: string,
): string | undefined {
  return values[name] == null ? undefined : String(values[name]);
}

function stringListOption(
  values: Record<string, unknown>,
  name: string,
): string[] {
  const value = values[name];
  if (value == null) return [];
  const valuesList = Array.isArray(value) ? value : [value];
  return [...new Set(valuesList.map((item) => String(item).trim())
    .filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function policyOptions(values: Record<string, unknown>): {
  sourceKind?: "user_explicit" | "deterministic_rule" | "taxonomy" |
    "llm_accepted" | "hybrid";
  decidedBy?: string;
} {
  const sourceKind = optionalStringOption(values, "policy-kind");
  const allowed = [
    "user_explicit",
    "deterministic_rule",
    "taxonomy",
    "llm_accepted",
    "hybrid",
  ] as const;
  if (sourceKind != null && !allowed.includes(
    sourceKind as (typeof allowed)[number],
  )) {
    throw new Error("--policy-kind must be user_explicit, deterministic_rule, " +
      "taxonomy, llm_accepted, or hybrid");
  }
  return {
    sourceKind: sourceKind as
      | "user_explicit"
      | "deterministic_rule"
      | "taxonomy"
      | "llm_accepted"
      | "hybrid"
      | undefined,
    decidedBy: optionalStringOption(values, "decided-by") ?? "local_cli_user",
  };
}

function buildOptions(values: Record<string, unknown>): {
  pythonBin?: string;
  maxReportsPerBook: number;
  maxReportsPerShelf: number;
  maxSemanticUnits: number;
  maxEdges: number;
} {
  return {
    pythonBin: optionalStringOption(values, "python-bin"),
    maxReportsPerBook: positiveIntegerOption(
      values,
      "max-reports-per-book",
      8,
    ),
    maxReportsPerShelf: positiveIntegerOption(
      values,
      "max-reports-per-shelf",
      8,
    ),
    maxSemanticUnits: positiveIntegerOption(
      values,
      "max-semantic-units",
      32,
    ),
    maxEdges: positiveIntegerOption(values, "max-edges", 96),
  };
}

async function runBuildCommand(input: UpperManagementCommandInput & {
  scopeId: string;
  command: "build" | "rebuild";
}): Promise<void> {
  const options = buildOptions(input.values);
  let validation: {
    ok: boolean;
    diagnostics: string[];
    semanticUnitCount: number;
    evidenceMapCount: number;
  };
  if (input.scopeKind === "bookshelf") {
    await buildBookshelfGraph({
      graphVault: input.graphVault,
      bookshelfId: input.scopeId,
      pythonBin: options.pythonBin,
      maxReportsPerBook: options.maxReportsPerBook,
      maxSemanticUnits: options.maxSemanticUnits,
      maxEdges: options.maxEdges,
    });
    validation = await validateBookshelfGraph({
      graphVault: input.graphVault,
      bookshelfId: input.scopeId,
      pythonBin: options.pythonBin,
    });
  } else {
    await buildLibraryGraph({
      graphVault: input.graphVault,
      libraryId: input.scopeId,
      pythonBin: options.pythonBin,
      maxReportsPerShelf: options.maxReportsPerShelf,
      maxSemanticUnits: options.maxSemanticUnits,
      maxEdges: options.maxEdges,
    });
    validation = await validateLibraryGraph({
      graphVault: input.graphVault,
      libraryId: input.scopeId,
      pythonBin: options.pythonBin,
    });
  }
  const status = await getUpperPackageStatus({
    graphVault: input.graphVault,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
  });
  const result = {
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_upper_package_build_result",
    command: input.command,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    ok: validation.ok,
    queryReady: status.queryReady,
    status: status.status,
    generation: status.generation,
    validation: {
      semanticUnitCount: validation.semanticUnitCount,
      evidenceMapCount: validation.evidenceMapCount,
      diagnostics: validation.diagnostics,
    },
    packageStatus: status,
  };
  if (!validation.ok) {
    throw new Error(
      `${scopeName(input.scopeKind)}_${input.command}_validation_failed:` +
        validation.diagnostics.join(","),
    );
  }
  if (input.json) {
    outputJson(result);
    return;
  }
  console.log(`${scopeName(input.scopeKind)} ${input.command}: ${input.scopeId}`);
  console.log(`  status: ${status.status}`);
  console.log(`  generation: ${status.generation ?? "-"}`);
  console.log(`  semanticUnitCount: ${validation.semanticUnitCount}`);
  console.log(`  evidenceMapCount: ${validation.evidenceMapCount}`);
}

async function runRefreshMembershipCommand(
  input: UpperManagementCommandInput & { scopeId: string },
): Promise<void> {
  let membershipResult: {
    generation: string;
    memberCount?: number;
    bookshelfCount?: number;
    directBookCount?: number;
    qualityGate: { readyState: string; queryReady: boolean };
  };
  let validation: {
    ok: boolean;
    diagnostics: string[];
    memberCount?: number;
    bookshelfCount?: number;
    directBookCount?: number;
  };
  if (input.scopeKind === "bookshelf") {
    const bookIds = stringListOption(input.values, "book-id");
    if (bookIds.length === 0) {
      throw new Error("bookshelf refresh-membership requires --book-id");
    }
    const result = await resolveBookshelfMembership({
      graphVault: input.graphVault,
      bookshelfId: input.scopeId,
      bookIds,
      policy: policyOptions(input.values),
    });
    const checked = await validateBookshelfMembership({
      graphVault: input.graphVault,
      bookshelfId: input.scopeId,
    });
    membershipResult = result;
    validation = checked;
  } else {
    const bookshelfIds = stringListOption(input.values, "member-bookshelf-id");
    if (bookshelfIds.length === 0) {
      throw new Error("library refresh-membership requires --member-bookshelf-id");
    }
    const result = await resolveLibraryMembership({
      graphVault: input.graphVault,
      libraryId: input.scopeId,
      bookshelfIds,
      shelfLimit: positiveIntegerOption(input.values, "shelf-limit", 32),
      directBookLimit: nonNegativeIntegerOption(
        input.values,
        "direct-book-limit",
        0,
      ),
      policy: policyOptions(input.values),
    });
    const checked = await validateLibraryMembership({
      graphVault: input.graphVault,
      libraryId: input.scopeId,
    });
    membershipResult = result;
    validation = checked;
  }
  const status = await getUpperPackageStatus({
    graphVault: input.graphVault,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
  });
  const result = {
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_upper_membership_refresh_result",
    command: "refresh-membership",
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    ok: validation.ok,
    queryReady: false,
    generation: membershipResult.generation,
    readyState: membershipResult.qualityGate.readyState,
    validation,
    packageStatus: status,
  };
  if (!validation.ok) {
    throw new Error(
      `${scopeName(input.scopeKind)}_membership_validation_failed:` +
        validation.diagnostics.join(","),
    );
  }
  if (input.json) {
    outputJson(result);
    return;
  }
  console.log(`${scopeName(input.scopeKind)} refresh-membership: ${input.scopeId}`);
  console.log(`  generation: ${membershipResult.generation}`);
  console.log(`  readyState: ${membershipResult.qualityGate.readyState}`);
  if (validation.memberCount != null) {
    console.log(`  memberCount: ${validation.memberCount}`);
  }
  if (validation.bookshelfCount != null) {
    console.log(`  bookshelfCount: ${validation.bookshelfCount}`);
  }
}

async function currentLibraryBookshelfIds(input: {
  graphVault: string;
  libraryId: string;
}): Promise<{
  bookshelfIds: string[];
  directBookIds: string[];
  shelfLimit: number;
  directBookLimit: number;
  policyKind: "user_explicit" | "deterministic_rule" | "taxonomy" |
    "llm_accepted" | "hybrid";
}> {
  const membership = await readLibraryMembershipCurrent(input);
  const policyKind = membership.manifest.membership.policyKind;
  if (policyKind === "llm_suggested") {
    throw new Error("library_repair_refuses_unaccepted_llm_suggestion");
  }
  return {
    bookshelfIds: membership.membersFile.members.bookshelves
      .map((member) => member.bookshelfId)
      .sort((left, right) => left.localeCompare(right)),
    directBookIds: membership.membersFile.members.directBooks
      .map((member) => member.bookId)
      .sort((left, right) => left.localeCompare(right)),
    shelfLimit: membership.partitionPlan.shelfLimit,
    directBookLimit: membership.partitionPlan.directBookLimit,
    policyKind,
  };
}

async function runRepairCommand(
  input: UpperManagementCommandInput & { scopeId: string },
): Promise<void> {
  const options = buildOptions(input.values);
  let membershipValidation: {
    ok: boolean;
    diagnostics: string[];
    memberCount?: number;
    bookshelfCount?: number;
    directBookCount?: number;
  };
  let graphValidation: {
    ok: boolean;
    diagnostics: string[];
    semanticUnitCount: number;
    evidenceMapCount: number;
  };
  let refreshedMembershipGeneration: string | null = null;
  if (input.scopeKind === "bookshelf") {
    const currentMembership = await readBookshelfMembershipCurrent({
      graphVault: input.graphVault,
      bookshelfId: input.scopeId,
    });
    const currentPolicyKind = currentMembership.manifest.membership.policyKind;
    if (currentPolicyKind === "llm_suggested") {
      throw new Error("bookshelf_repair_refuses_unaccepted_llm_suggestion");
    }
    const selectedPolicy = policyOptions(input.values);
    const refreshed = await resolveBookshelfMembership({
      graphVault: input.graphVault,
      bookshelfId: input.scopeId,
      bookIds: currentMembership.membersFile.members.map((member) =>
        member.bookId
      ),
      policy: {
        ...selectedPolicy,
        sourceKind: selectedPolicy.sourceKind ?? currentPolicyKind,
        decidedBy: selectedPolicy.decidedBy ?? "local_cli_repair",
      },
    });
    refreshedMembershipGeneration = refreshed.generation;
    membershipValidation = await validateBookshelfMembership({
      graphVault: input.graphVault,
      bookshelfId: input.scopeId,
    });
    if (!membershipValidation.ok) {
      throw new Error(
        `bookshelf_repair_membership_validation_failed:` +
          membershipValidation.diagnostics.join(","),
      );
    }
    await buildBookshelfGraph({
      graphVault: input.graphVault,
      bookshelfId: input.scopeId,
      pythonBin: options.pythonBin,
      maxReportsPerBook: options.maxReportsPerBook,
      maxSemanticUnits: options.maxSemanticUnits,
      maxEdges: options.maxEdges,
    });
    graphValidation = await validateBookshelfGraph({
      graphVault: input.graphVault,
      bookshelfId: input.scopeId,
      pythonBin: options.pythonBin,
    });
  } else {
    const currentMembership = await currentLibraryBookshelfIds({
      graphVault: input.graphVault,
      libraryId: input.scopeId,
    });
    const selectedPolicy = policyOptions(input.values);
    const refreshed = await resolveLibraryMembership({
      graphVault: input.graphVault,
      libraryId: input.scopeId,
      bookshelfIds: currentMembership.bookshelfIds,
      directBookIds: currentMembership.directBookIds,
      shelfLimit: positiveIntegerOption(
        input.values,
        "shelf-limit",
        currentMembership.shelfLimit,
      ),
      directBookLimit: nonNegativeIntegerOption(
        input.values,
        "direct-book-limit",
        currentMembership.directBookLimit,
      ),
      policy: {
        ...selectedPolicy,
        sourceKind: selectedPolicy.sourceKind ?? currentMembership.policyKind,
        decidedBy: selectedPolicy.decidedBy ?? "local_cli_repair",
      },
    });
    refreshedMembershipGeneration = refreshed.generation;
    membershipValidation = await validateLibraryMembership({
      graphVault: input.graphVault,
      libraryId: input.scopeId,
    });
    if (!membershipValidation.ok) {
      throw new Error(
        `library_repair_membership_validation_failed:` +
          membershipValidation.diagnostics.join(","),
      );
    }
    await buildLibraryGraph({
      graphVault: input.graphVault,
      libraryId: input.scopeId,
      pythonBin: options.pythonBin,
      maxReportsPerShelf: options.maxReportsPerShelf,
      maxSemanticUnits: options.maxSemanticUnits,
      maxEdges: options.maxEdges,
    });
    graphValidation = await validateLibraryGraph({
      graphVault: input.graphVault,
      libraryId: input.scopeId,
      pythonBin: options.pythonBin,
    });
  }
  const status = await getUpperPackageStatus({
    graphVault: input.graphVault,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
  });
  const result = {
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_upper_package_repair_result",
    command: "repair",
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    ok: membershipValidation.ok && graphValidation.ok && status.queryReady,
    refreshedMembershipGeneration,
    membershipValidation,
    graphValidation,
    packageStatus: status,
  };
  if (!result.ok) {
    throw new Error(
      `${scopeName(input.scopeKind)}_repair_validation_failed:` +
        [
          ...membershipValidation.diagnostics,
          ...graphValidation.diagnostics,
          ...status.diagnostics,
        ].join(","),
    );
  }
  if (input.json) {
    outputJson(result);
    return;
  }
  console.log(`${scopeName(input.scopeKind)} repair: ${input.scopeId}`);
  console.log(`  status: ${status.status}`);
  console.log(`  generation: ${status.generation ?? "-"}`);
  console.log(`  semanticUnitCount: ${graphValidation.semanticUnitCount}`);
  console.log(`  evidenceMapCount: ${graphValidation.evidenceMapCount}`);
}

export async function runUpperManagementCommand(
  input: UpperManagementCommandInput,
): Promise<void> {
  const subcommand = input.args[0] ?? "help";
  if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
    console.log(usage(input.scopeKind));
    return;
  }

  if (subcommand === "status") {
    const scopeId = input.args[1];
    if (scopeId == null) throw new Error(usage(input.scopeKind));
    const status = await getUpperPackageStatus({
      graphVault: input.graphVault,
      scopeKind: input.scopeKind,
      scopeId,
    });
    if (input.json) outputJson(status);
    else printStatus(status);
    return;
  }

  if (subcommand === "build" || subcommand === "rebuild") {
    const scopeId = input.args[1];
    if (scopeId == null) throw new Error(usage(input.scopeKind));
    await runBuildCommand({
      ...input,
      scopeId,
      command: subcommand,
    });
    return;
  }

  if (subcommand === "refresh-membership") {
    const scopeId = input.args[1];
    if (scopeId == null) throw new Error(usage(input.scopeKind));
    await runRefreshMembershipCommand({
      ...input,
      scopeId,
    });
    return;
  }

  if (subcommand === "repair") {
    const scopeId = input.args[1];
    if (scopeId == null) throw new Error(usage(input.scopeKind));
    await runRepairCommand({
      ...input,
      scopeId,
    });
    return;
  }

  if (subcommand === "list") {
    const statuses = await listUpperPackageStatuses({
      graphVault: input.graphVault,
      scopeKind: input.scopeKind,
    });
    if (input.json) {
      outputJson({
        schemaVersion: SchemaVersion,
        kind: "qmd_graphrag_upper_package_status_list",
        scopeKind: input.scopeKind,
        count: statuses.length,
        statuses,
      });
    } else {
      printList(input.scopeKind, statuses);
    }
    return;
  }

  throw new Error(usage(input.scopeKind));
}
