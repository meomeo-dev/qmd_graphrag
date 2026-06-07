import { describe, expect, test } from "vitest";

import {
  resolveGraphRagQueryMethod,
  resolveUpperTypedQueryErrorDetails,
} from "../src/cli/graphrag-query-scope.js";
import {
  bookshelfPackageRoot,
  libraryPackageRoot,
  packageLocator,
} from "../src/graphrag/upper-index/upper-package-paths.js";

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

  test("maps legacy catalog-only upper index to migration error fields", () => {
    expect(resolveUpperTypedQueryErrorDetails({
      code: "upper_package_migration_required",
      scopeKind: "library",
      scopeId: "software-engineering-library",
      timingAvailable: true,
    })).toEqual({
      exitCode: 65,
      scopeKind: "library",
      scopeId: "software-engineering-library",
      retryable: false,
      remediationCommand:
        "node scripts/graphrag/build-library-graph.mjs --graph-vault <path> --library-id software-engineering-library",
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

  test("rejects unsafe upper scope ids before path joining", () => {
    expect(() => bookshelfPackageRoot("/tmp/vault", "../escape"))
      .toThrow("upper_quality_gate_failed:invalid_bookshelf_id");
    expect(() => libraryPackageRoot("/tmp/vault", "file:library"))
      .toThrow("upper_quality_gate_failed:invalid_library_id");
    expect(() => packageLocator({
      scopeKind: "bookshelf",
      scopeId: "architecture/core",
      generation: "generation-1",
      relativePath: "community_reports.parquet",
    })).toThrow("upper_quality_gate_failed:invalid_bookshelf_id");
  });
});
