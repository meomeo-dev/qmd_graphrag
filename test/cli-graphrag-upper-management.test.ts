import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildBookshelfGraph,
} from "../src/graphrag/upper-index/bookshelf-graph.js";
import {
  buildLibraryGraph,
} from "../src/graphrag/upper-index/library-graph.js";
import {
  resolveBookshelfMembership,
} from "../src/graphrag/upper-index/bookshelf-membership.js";
import {
  resolveLibraryMembership,
} from "../src/graphrag/upper-index/library-membership.js";
import { writeReadyHotplugBook } from "./helpers/graphrag-hotplug-book-package.js";
import { createCliTestHarness } from "./helpers/cli-harness.js";
import { mkProjectTmpDir } from "./helpers/graphrag-runner-harness.js";

const harness = createCliTestHarness();

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJsonWithSidecar(
  path: string,
  value: unknown,
): Promise<string> {
  const text = stableJson(value);
  const sha256 = sha256Text(text);
  await writeFile(path, text, "utf8");
  await writeFile(`${path}.sha256`, `${sha256}\n`, "utf8");
  return sha256;
}

function upperRoot(input: {
  graphVault: string;
  scopeKind: "bookshelf" | "library";
  scopeId: string;
}): string {
  return join(
    input.graphVault,
    input.scopeKind === "bookshelf" ? "bookshelves" : "library",
    input.scopeId,
  );
}

async function corruptUpperQualityGate(input: {
  graphVault: string;
  scopeKind: "bookshelf" | "library";
  scopeId: string;
}): Promise<void> {
  const root = upperRoot(input);
  const current = JSON.parse(await readFile(join(root, "CURRENT.json"), "utf8"));
  const gatePath = input.scopeKind === "bookshelf"
    ? "state/bookshelf-quality-gate.json"
    : "state/library-quality-gate.json";
  const corruptGate = {
    schemaVersion: "1.0.0",
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    generation: current.generation,
    status: "failed",
  };
  await writeJsonWithSidecar(join(root, current.current, gatePath), corruptGate);
  await writeJsonWithSidecar(join(root, gatePath), corruptGate);
}

async function corruptUpperManifest(input: {
  graphVault: string;
  scopeKind: "bookshelf" | "library";
  scopeId: string;
}): Promise<void> {
  const root = upperRoot(input);
  const currentPath = join(root, "CURRENT.json");
  const publishReadyPath = join(root, "PUBLISH_READY.json");
  const current = JSON.parse(await readFile(currentPath, "utf8"));
  const publishReady = JSON.parse(await readFile(publishReadyPath, "utf8"));
  const manifestName = input.scopeKind === "bookshelf"
    ? "BOOKSHELF_MANIFEST.json"
    : "LIBRARY_MANIFEST.json";
  const corruptManifest = { schemaVersion: "1.0.0", kind: "corrupt" };
  const manifestSha256 = await writeJsonWithSidecar(
    join(root, current.current, manifestName),
    corruptManifest,
  );
  await writeJsonWithSidecar(join(root, manifestName), corruptManifest);
  await writeJsonWithSidecar(currentPath, {
    ...current,
    manifestSha256,
  });
  await writeJsonWithSidecar(publishReadyPath, {
    ...publishReady,
    manifestSha256,
  });
}

async function writeBookshelfFixture(input: {
  graphVault: string;
  bookshelfId: string;
  bookIds: readonly string[];
  queryReady: boolean;
}): Promise<void> {
  for (const [index, bookId] of input.bookIds.entries()) {
    await writeReadyHotplugBook({
      stateRoot: input.graphVault,
      bookId,
      title: `Upper Management ${input.bookshelfId} ${index + 1}`,
    });
  }
  await resolveBookshelfMembership({
    graphVault: input.graphVault,
    bookshelfId: input.bookshelfId,
    bookIds: input.bookIds,
    now: () => "2026-06-06T00:00:02.000Z",
  });
  if (!input.queryReady) return;
  await buildBookshelfGraph({
    graphVault: input.graphVault,
    bookshelfId: input.bookshelfId,
    maxReportsPerBook: 2,
    maxSemanticUnits: 16,
    maxEdges: 32,
    now: () => "2026-06-06T00:00:03.000Z",
  });
}

describe("GraphRAG upper package management CLI", () => {
  test("builds and rebuilds a bookshelf package from package-root membership",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-upper-bookshelf-build-cli-");
      try {
        const graphVault = join(tmpRoot, "graph_vault");
        const bookshelfId = "architecture-core";
        for (const [index, bookId] of [
          "book-ub-a",
          "book-ub-b",
          "book-ub-c",
        ].entries()) {
          await writeReadyHotplugBook({
            stateRoot: graphVault,
            bookId,
            title: `Upper Build Bookshelf ${index + 1}`,
          });
        }
        await resolveBookshelfMembership({
          graphVault,
          bookshelfId,
          bookIds: ["book-ub-a", "book-ub-b", "book-ub-c"],
          now: () => "2026-06-06T00:00:01.000Z",
        });

        const build = await harness.runQmd([
          "bookshelf",
          "build",
          bookshelfId,
          "--graph-vault",
          graphVault,
          "--json",
          "--max-reports-per-book",
          "2",
          "--max-semantic-units",
          "16",
          "--max-edges",
          "32",
        ], { timeoutMs: 120000 });
        expect(build.exitCode, build.stderr).toBe(0);
        const buildResult = JSON.parse(build.stdout);
        expect(buildResult.command).toBe("build");
        expect(buildResult.scopeKind).toBe("bookshelf");
        expect(buildResult.scopeId).toBe(bookshelfId);
        expect(buildResult.ok).toBe(true);
        expect(buildResult.queryReady).toBe(true);
        expect(buildResult.status).toBe("query_ready");
        expect(buildResult.validation.semanticUnitCount).toBeGreaterThan(0);
        expect(buildResult.validation.evidenceMapCount).toBeGreaterThan(0);
        expect(buildResult.packageStatus.catalogProjectionExists).toBe(true);
        expect(buildResult.packageStatus.authority.catalogProjectionIsAuthority)
          .toBe(false);
        expect(JSON.stringify(buildResult)).not.toContain(graphVault);

        const rebuild = await harness.runQmd([
          "bookshelf",
          "rebuild",
          bookshelfId,
          "--graph-vault",
          graphVault,
          "--json",
          "--max-reports-per-book",
          "2",
          "--max-semantic-units",
          "16",
          "--max-edges",
          "32",
        ], { timeoutMs: 120000 });
        expect(rebuild.exitCode, rebuild.stderr).toBe(0);
        const rebuildResult = JSON.parse(rebuild.stdout);
        expect(rebuildResult.command).toBe("rebuild");
        expect(rebuildResult.queryReady).toBe(true);
        expect(rebuildResult.status).toBe("query_ready");
        expect(rebuildResult.packageStatus.readyState)
          .toBe("bookshelf_query_ready");
        expect(JSON.stringify(rebuildResult)).not.toContain(graphVault);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000,
  );

  test("reports bookshelf package-root status without using catalog as authority",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-upper-management-cli-");
      try {
        const graphVault = join(tmpRoot, "graph_vault");
        await writeBookshelfFixture({
          graphVault,
          bookshelfId: "architecture-core",
          bookIds: ["book-um-a", "book-um-b", "book-um-c"],
          queryReady: true,
        });
        await writeBookshelfFixture({
          graphVault,
          bookshelfId: "membership-only",
          bookIds: ["book-um-d", "book-um-e", "book-um-f"],
          queryReady: false,
        });
        await mkdir(
          join(graphVault, "catalog", "bookshelves", "legacy-only", "current"),
          { recursive: true },
        );
        await writeFile(
          join(
            graphVault,
            "catalog",
            "bookshelves",
            "legacy-only",
            "current",
            "BOOKSHELF_MANIFEST.json",
          ),
          "{}\n",
          "utf8",
        );

        const ready = await harness.runQmd([
          "bookshelf",
          "status",
          "architecture-core",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(ready.exitCode).toBe(0);
        const readyStatus = JSON.parse(ready.stdout);
        expect(readyStatus.status).toBe("query_ready");
        expect(readyStatus.queryReady).toBe(true);
        expect(readyStatus.authority.catalogProjectionIsAuthority).toBe(false);
        expect(readyStatus.catalogProjectionExists).toBe(true);
        expect(readyStatus.manifestPath).toContain(
          "bookshelves/architecture-core/generations/",
        );
        expect(JSON.stringify(readyStatus)).not.toContain(graphVault);

        await corruptUpperQualityGate({
          graphVault,
          scopeKind: "bookshelf",
          scopeId: "architecture-core",
        });
        const corruptGate = await harness.runQmd([
          "bookshelf",
          "status",
          "architecture-core",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(corruptGate.exitCode).toBe(0);
        const corruptGateStatus = JSON.parse(corruptGate.stdout);
        expect(corruptGateStatus.status).toBe("not_query_ready");
        expect(corruptGateStatus.queryReady).toBe(false);
        expect(corruptGateStatus.diagnostics).toContain(
          "bookshelf_quality_gate_invalid",
        );

        await corruptUpperManifest({
          graphVault,
          scopeKind: "bookshelf",
          scopeId: "architecture-core",
        });
        const corruptManifest = await harness.runQmd([
          "bookshelf",
          "status",
          "architecture-core",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(corruptManifest.exitCode).toBe(0);
        const corruptManifestStatus = JSON.parse(corruptManifest.stdout);
        expect(corruptManifestStatus.status).toBe("not_query_ready");
        expect(corruptManifestStatus.queryReady).toBe(false);
        expect(corruptManifestStatus.diagnostics).toContain(
          "bookshelf_graph_manifest_invalid",
        );

        const notReady = await harness.runQmd([
          "bookshelf",
          "status",
          "membership-only",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(notReady.exitCode).toBe(0);
        const notReadyStatus = JSON.parse(notReady.stdout);
        expect(notReadyStatus.status).toBe("not_query_ready");
        expect(notReadyStatus.queryReady).toBe(false);
        expect(notReadyStatus.readyState).toBe("membership_resolved");
        expect(notReadyStatus.manifestPath).toContain(
          "BOOKSHELF_MEMBERSHIP_MANIFEST.json",
        );

        const legacy = await harness.runQmd([
          "bookshelf",
          "status",
          "legacy-only",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(legacy.exitCode).toBe(0);
        const legacyStatus = JSON.parse(legacy.stdout);
        expect(legacyStatus.status).toBe("migration_required");
        expect(legacyStatus.queryReady).toBe(false);

        const list = await harness.runQmd([
          "bookshelf",
          "list",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(list.exitCode).toBe(0);
        const listStatus = JSON.parse(list.stdout);
        expect(listStatus.statuses.map((item: { scopeId: string }) =>
          item.scopeId
        )).toEqual(["architecture-core", "membership-only"]);
        const architectureCore = listStatus.statuses.find(
          (item: { scopeId: string }) => item.scopeId === "architecture-core",
        );
        expect(architectureCore.status).toBe("not_query_ready");
        expect(JSON.stringify(listStatus)).not.toContain("legacy-only");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000,
  );

  test("reports library package-root status without using catalog as authority",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-upper-library-management-cli-");
      try {
        const graphVault = join(tmpRoot, "graph_vault");
        await writeBookshelfFixture({
          graphVault,
          bookshelfId: "architecture-core",
          bookIds: ["book-ulm-a", "book-ulm-b", "book-ulm-c"],
          queryReady: true,
        });
        await writeBookshelfFixture({
          graphVault,
          bookshelfId: "delivery-core",
          bookIds: ["book-ulm-d", "book-ulm-e", "book-ulm-f"],
          queryReady: true,
        });
        await resolveLibraryMembership({
          graphVault,
          libraryId: "software-engineering-library",
          bookshelfIds: ["architecture-core", "delivery-core"],
          now: () => "2026-06-06T00:00:04.000Z",
        });
        await buildLibraryGraph({
          graphVault,
          libraryId: "software-engineering-library",
          maxReportsPerShelf: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:05.000Z",
        });
        await resolveLibraryMembership({
          graphVault,
          libraryId: "library-membership-only",
          bookshelfIds: ["architecture-core", "delivery-core"],
          now: () => "2026-06-06T00:00:06.000Z",
        });
        await mkdir(
          join(graphVault, "catalog", "library", "legacy-library", "current"),
          { recursive: true },
        );
        await writeFile(
          join(
            graphVault,
            "catalog",
            "library",
            "legacy-library",
            "current",
            "LIBRARY_MANIFEST.json",
          ),
          "{}\n",
          "utf8",
        );

        const ready = await harness.runQmd([
          "library",
          "status",
          "software-engineering-library",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(ready.exitCode).toBe(0);
        const readyStatus = JSON.parse(ready.stdout);
        expect(readyStatus.status).toBe("query_ready");
        expect(readyStatus.queryReady).toBe(true);
        expect(readyStatus.authority.catalogProjectionIsAuthority).toBe(false);
        expect(readyStatus.catalogProjectionExists).toBe(true);
        expect(readyStatus.manifestPath).toContain(
          "library/software-engineering-library/generations/",
        );
        expect(JSON.stringify(readyStatus)).not.toContain(graphVault);

        await corruptUpperQualityGate({
          graphVault,
          scopeKind: "library",
          scopeId: "software-engineering-library",
        });
        const corruptGate = await harness.runQmd([
          "library",
          "status",
          "software-engineering-library",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(corruptGate.exitCode).toBe(0);
        const corruptGateStatus = JSON.parse(corruptGate.stdout);
        expect(corruptGateStatus.status).toBe("not_query_ready");
        expect(corruptGateStatus.queryReady).toBe(false);
        expect(corruptGateStatus.diagnostics).toContain(
          "library_quality_gate_invalid",
        );

        await corruptUpperManifest({
          graphVault,
          scopeKind: "library",
          scopeId: "software-engineering-library",
        });
        const corruptManifest = await harness.runQmd([
          "library",
          "status",
          "software-engineering-library",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(corruptManifest.exitCode).toBe(0);
        const corruptManifestStatus = JSON.parse(corruptManifest.stdout);
        expect(corruptManifestStatus.status).toBe("not_query_ready");
        expect(corruptManifestStatus.queryReady).toBe(false);
        expect(corruptManifestStatus.diagnostics).toContain(
          "library_graph_manifest_invalid",
        );

        const notReady = await harness.runQmd([
          "library",
          "status",
          "library-membership-only",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(notReady.exitCode).toBe(0);
        const notReadyStatus = JSON.parse(notReady.stdout);
        expect(notReadyStatus.status).toBe("not_query_ready");
        expect(notReadyStatus.queryReady).toBe(false);
        expect(notReadyStatus.readyState).toBe("library_membership_resolved");
        expect(notReadyStatus.manifestPath).toContain(
          "LIBRARY_MEMBERSHIP_MANIFEST.json",
        );

        const legacy = await harness.runQmd([
          "library",
          "status",
          "legacy-library",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(legacy.exitCode).toBe(0);
        const legacyStatus = JSON.parse(legacy.stdout);
        expect(legacyStatus.status).toBe("migration_required");
        expect(legacyStatus.queryReady).toBe(false);

        const list = await harness.runQmd([
          "library",
          "list",
          "--graph-vault",
          graphVault,
          "--json",
        ], { timeoutMs: 120000 });
        expect(list.exitCode).toBe(0);
        const listStatus = JSON.parse(list.stdout);
        expect(listStatus.statuses.map((item: { scopeId: string }) =>
          item.scopeId
        )).toEqual(["library-membership-only", "software-engineering-library"]);
        const softwareEngineeringLibrary = listStatus.statuses.find(
          (item: { scopeId: string }) =>
            item.scopeId === "software-engineering-library",
        );
        expect(softwareEngineeringLibrary.status).toBe("not_query_ready");
        expect(JSON.stringify(listStatus)).not.toContain("legacy-library");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000,
  );

  test("builds and rebuilds a library package from package-root membership",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-upper-library-build-cli-");
      try {
        const graphVault = join(tmpRoot, "graph_vault");
        await writeBookshelfFixture({
          graphVault,
          bookshelfId: "architecture-core",
          bookIds: ["book-ulb-a", "book-ulb-b", "book-ulb-c"],
          queryReady: true,
        });
        await writeBookshelfFixture({
          graphVault,
          bookshelfId: "delivery-core",
          bookIds: ["book-ulb-d", "book-ulb-e", "book-ulb-f"],
          queryReady: true,
        });
        await resolveLibraryMembership({
          graphVault,
          libraryId: "software-engineering-library",
          bookshelfIds: ["architecture-core", "delivery-core"],
          now: () => "2026-06-06T00:00:06.000Z",
        });

        const build = await harness.runQmd([
          "library",
          "build",
          "software-engineering-library",
          "--graph-vault",
          graphVault,
          "--json",
          "--max-reports-per-shelf",
          "2",
          "--max-semantic-units",
          "16",
          "--max-edges",
          "32",
        ], { timeoutMs: 120000 });
        expect(build.exitCode, build.stderr).toBe(0);
        const buildResult = JSON.parse(build.stdout);
        expect(buildResult.command).toBe("build");
        expect(buildResult.scopeKind).toBe("library");
        expect(buildResult.scopeId).toBe("software-engineering-library");
        expect(buildResult.ok).toBe(true);
        expect(buildResult.queryReady).toBe(true);
        expect(buildResult.status).toBe("query_ready");
        expect(buildResult.validation.semanticUnitCount).toBeGreaterThan(0);
        expect(buildResult.validation.evidenceMapCount).toBeGreaterThan(0);
        expect(buildResult.packageStatus.catalogProjectionExists).toBe(true);
        expect(buildResult.packageStatus.authority.catalogProjectionIsAuthority)
          .toBe(false);
        expect(JSON.stringify(buildResult)).not.toContain(graphVault);

        const rebuild = await harness.runQmd([
          "library",
          "rebuild",
          "software-engineering-library",
          "--graph-vault",
          graphVault,
          "--json",
          "--max-reports-per-shelf",
          "2",
          "--max-semantic-units",
          "16",
          "--max-edges",
          "32",
        ], { timeoutMs: 120000 });
        expect(rebuild.exitCode, rebuild.stderr).toBe(0);
        const rebuildResult = JSON.parse(rebuild.stdout);
        expect(rebuildResult.command).toBe("rebuild");
        expect(rebuildResult.queryReady).toBe(true);
        expect(rebuildResult.status).toBe("query_ready");
        expect(rebuildResult.packageStatus.readyState).toBe("library_query_ready");
        expect(JSON.stringify(rebuildResult)).not.toContain(graphVault);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000,
  );
});
