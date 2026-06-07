import {
  GraphRagSearchMethodSchema,
  type GraphRagSearchMethod,
} from "../contracts/graphrag.js";

export type ResolveGraphRagQueryMethodInput = {
  requestedMethod?: unknown;
  bookshelfId?: string | null;
  libraryId?: string | null;
  defaultMethod?: string | null;
};

type GraphRagScopeKind = "book" | "bookshelf" | "library";

export type UpperTypedQueryErrorCode =
  | "missing_scope"
  | "ambiguous_scope"
  | "upper_index_missing"
  | "upper_package_migration_required"
  | "upper_index_stale"
  | "upper_quality_gate_failed"
  | "budget_exceeded_narrow_scope_required"
  | "upper_index_runtime_error";

export type UpperTypedQueryErrorDetails = {
  exitCode: number;
  scopeKind?: GraphRagScopeKind;
  scopeId?: string;
  retryable: boolean;
  remediationCommand: string;
  timingAvailable: boolean;
};

function scopeSelectionCommand(): string {
  return "qmd query --graph-book-id <id>, --bookshelf-id <id>, or --library-id <id>";
}

function rebuildUpperIndexCommand(input: {
  scopeKind?: GraphRagScopeKind;
  scopeId: string;
}): string {
  if (input.scopeKind === "library") {
    return [
      "node scripts/graphrag/build-library-graph.mjs",
      "--graph-vault <path>",
      `--library-id ${input.scopeId}`,
    ].join(" ");
  }
  if (input.scopeKind === "bookshelf") {
    return [
      "node scripts/graphrag/build-bookshelf-graph.mjs",
      "--graph-vault <path>",
      `--bookshelf-id ${input.scopeId}`,
    ].join(" ");
  }
  return scopeSelectionCommand();
}

function migrateUpperPackageCommand(input: {
  scopeKind?: GraphRagScopeKind;
  scopeId: string;
}): string {
  if (input.scopeKind === "library") {
    return [
      "node scripts/graphrag/build-library-graph.mjs",
      "--graph-vault <path>",
      `--library-id ${input.scopeId}`,
    ].join(" ");
  }
  if (input.scopeKind === "bookshelf") {
    return [
      "node scripts/graphrag/build-bookshelf-graph.mjs",
      "--graph-vault <path>",
      `--bookshelf-id ${input.scopeId}`,
    ].join(" ");
  }
  return [
    "rebuild or migrate the upper package under graph_vault/bookshelves/<id>",
    "or graph_vault/library/<id>",
  ].join(" ");
}

export function resolveGraphRagQueryMethod(
  input: ResolveGraphRagQueryMethodInput,
): GraphRagSearchMethod {
  const requestedMethod = input.requestedMethod == null
    ? null
    : String(input.requestedMethod);
  const defaultMethod = input.defaultMethod == null || input.defaultMethod === ""
    ? "local"
    : input.defaultMethod;
  const method = requestedMethod == null || requestedMethod === ""
    ? input.bookshelfId == null && input.libraryId == null
      ? defaultMethod
      : "global"
    : requestedMethod;
  return GraphRagSearchMethodSchema.parse(method);
}

export function resolveUpperTypedQueryErrorDetails(input: {
  code: UpperTypedQueryErrorCode;
  scopeKind?: GraphRagScopeKind;
  scopeId?: string | null;
  timingAvailable?: boolean;
}): UpperTypedQueryErrorDetails {
  const scopeId = input.scopeId == null || input.scopeId === ""
    ? undefined
    : input.scopeId;
  const scopePlaceholder = scopeId ?? "<scopeId>";
  const shared = {
    scopeKind: input.scopeKind,
    scopeId,
    timingAvailable: input.timingAvailable === true,
  };
  switch (input.code) {
    case "missing_scope":
    case "ambiguous_scope":
      return {
        ...shared,
        exitCode: 64,
        retryable: false,
        remediationCommand: scopeSelectionCommand(),
      };
    case "upper_index_missing":
      return {
        ...shared,
        exitCode: 66,
        retryable: false,
        remediationCommand: rebuildUpperIndexCommand({
          scopeKind: input.scopeKind,
          scopeId: scopePlaceholder,
        }),
      };
    case "upper_package_migration_required":
      return {
        ...shared,
        exitCode: 65,
        retryable: false,
        remediationCommand: migrateUpperPackageCommand({
          scopeKind: input.scopeKind,
          scopeId: scopePlaceholder,
        }),
      };
    case "upper_index_stale":
      return {
        ...shared,
        exitCode: 65,
        retryable: false,
        remediationCommand: rebuildUpperIndexCommand({
          scopeKind: input.scopeKind,
          scopeId: scopePlaceholder,
        }),
      };
    case "upper_quality_gate_failed":
      return {
        ...shared,
        exitCode: 65,
        retryable: false,
        remediationCommand: rebuildUpperIndexCommand({
          scopeKind: input.scopeKind,
          scopeId: scopePlaceholder,
        }),
      };
    case "budget_exceeded_narrow_scope_required":
      return {
        ...shared,
        exitCode: 64,
        retryable: false,
        remediationCommand:
          "qmd query --library-id <id>, --bookshelf-id <id>, or --graph-book-id <id>",
      };
    case "upper_index_runtime_error":
      return {
        ...shared,
        exitCode: 70,
        retryable: true,
        remediationCommand: rebuildUpperIndexCommand({
          scopeKind: input.scopeKind,
          scopeId: scopePlaceholder,
        }),
      };
  }
}
