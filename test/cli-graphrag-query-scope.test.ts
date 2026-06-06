import { describe, expect, test } from "vitest";

import {
  resolveGraphRagQueryMethod,
  resolveUpperTypedQueryErrorDetails,
} from "../src/cli/graphrag-query-scope.js";

describe("GraphRAG CLI query scope helpers", () => {
  test("defaults bookshelf scope to global search", () => {
    expect(resolveGraphRagQueryMethod({
      bookshelfId: "software-architecture-core",
      defaultMethod: "local",
    })).toBe("global");
  });

  test("defaults library scope to global search", () => {
    expect(resolveGraphRagQueryMethod({
      libraryId: "software-engineering-library",
      defaultMethod: "local",
    })).toBe("global");
  });

  test("honors an explicit query method for bookshelf scope", () => {
    expect(resolveGraphRagQueryMethod({
      requestedMethod: "basic",
      bookshelfId: "software-architecture-core",
      defaultMethod: "local",
    })).toBe("basic");
  });

  test("uses the configured default for single-book scope", () => {
    expect(resolveGraphRagQueryMethod({
      bookshelfId: null,
      defaultMethod: "drift",
    })).toBe("drift");
  });

  test("maps missing upper index to the contracted CLI error fields", () => {
    expect(resolveUpperTypedQueryErrorDetails({
      code: "upper_index_missing",
      scopeKind: "bookshelf",
      scopeId: "software-architecture-core",
      timingAvailable: true,
    })).toEqual({
      exitCode: 66,
      scopeKind: "bookshelf",
      scopeId: "software-architecture-core",
      retryable: false,
      remediationCommand:
        "node scripts/graphrag/build-bookshelf-graph.mjs --graph-vault <path> --bookshelf-id software-architecture-core",
      timingAvailable: true,
    });
  });

  test("maps upper runtime errors to exit code 70", () => {
    expect(resolveUpperTypedQueryErrorDetails({
      code: "upper_index_runtime_error",
      scopeKind: "bookshelf",
      scopeId: "software-architecture-core",
    })).toMatchObject({
      exitCode: 70,
      retryable: true,
      remediationCommand:
        "node scripts/graphrag/build-bookshelf-graph.mjs --graph-vault <path> --bookshelf-id software-architecture-core",
      timingAvailable: false,
    });
  });
});
