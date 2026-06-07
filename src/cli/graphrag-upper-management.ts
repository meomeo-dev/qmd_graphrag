import { SchemaVersion } from "../contracts/common.js";
import {
  buildBookshelfGraph,
  validateBookshelfGraph,
} from "../graphrag/upper-index/bookshelf-graph.js";
import {
  buildLibraryGraph,
  validateLibraryGraph,
} from "../graphrag/upper-index/library-graph.js";
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
    `  status <id>        Show package-root ${scope} readiness state`,
    `  list               List package-root ${scope} packages`,
    "",
    "Options:",
    "  --graph-vault <path>  GraphRAG vault root, default graph_vault",
    "  --python-bin <path>   Python executable for parquet bridge",
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

function optionalStringOption(
  values: Record<string, unknown>,
  name: string,
): string | undefined {
  return values[name] == null ? undefined : String(values[name]);
}

async function runBuildCommand(input: UpperManagementCommandInput & {
  scopeId: string;
  command: "build" | "rebuild";
}): Promise<void> {
  const pythonBin = optionalStringOption(input.values, "python-bin");
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
      pythonBin,
      maxReportsPerBook: positiveIntegerOption(
        input.values,
        "max-reports-per-book",
        8,
      ),
      maxSemanticUnits: positiveIntegerOption(
        input.values,
        "max-semantic-units",
        32,
      ),
      maxEdges: positiveIntegerOption(input.values, "max-edges", 96),
    });
    validation = await validateBookshelfGraph({
      graphVault: input.graphVault,
      bookshelfId: input.scopeId,
      pythonBin,
    });
  } else {
    await buildLibraryGraph({
      graphVault: input.graphVault,
      libraryId: input.scopeId,
      pythonBin,
      maxReportsPerShelf: positiveIntegerOption(
        input.values,
        "max-reports-per-shelf",
        8,
      ),
      maxSemanticUnits: positiveIntegerOption(
        input.values,
        "max-semantic-units",
        32,
      ),
      maxEdges: positiveIntegerOption(input.values, "max-edges", 96),
    });
    validation = await validateLibraryGraph({
      graphVault: input.graphVault,
      libraryId: input.scopeId,
      pythonBin,
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
