import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildBookshelfGraph,
  validateBookshelfGraph,
} from "../src/graphrag/upper-index/bookshelf-graph.js";
import {
  loadBookshelfGraphQueryCapabilities,
  queryBookshelfGraph,
} from "../src/graphrag/upper-index/bookshelf-query.js";
import {
  resolveBookshelfMembership,
} from "../src/graphrag/upper-index/bookshelf-membership.js";
import { writeReadyHotplugBook } from "./helpers/graphrag-hotplug-book-package.js";
import { mkProjectTmpDir } from "./helpers/graphrag-runner-harness.js";

describe("GraphRAG bookshelf graph build", () => {
  test("publishes a query-ready bookshelf graph from membership handoff",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-bookshelf-graph-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookIds = ["book-graph-a", "book-graph-b", "book-graph-c"];
        for (const [index, bookId] of bookIds.entries()) {
          await writeReadyHotplugBook({
            stateRoot,
            bookId,
            title: `Architecture Graph ${index + 1}`,
          });
        }
        await resolveBookshelfMembership({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          bookIds,
          now: () => "2026-06-06T00:00:02.000Z",
        });

        const result = await buildBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          maxReportsPerBook: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:03.000Z",
        });
        const validation = await validateBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
        });
        const currentRoot = join(
          stateRoot,
          "catalog",
          "bookshelves",
          "architecture-core",
          "current",
        );
        const manifest = JSON.parse(
          await readFile(join(currentRoot, "BOOKSHELF_MANIFEST.json"), "utf8"),
        );
        const qualityGate = JSON.parse(
          await readFile(join(
            currentRoot,
            "state",
            "bookshelf-quality-gate.json",
          ), "utf8"),
        );

        expect(result.qualityGate.readyState).toBe("bookshelf_query_ready");
        expect(validation.ok).toBe(true);
        expect(validation.diagnostics).toEqual([]);
        expect(validation.semanticUnitCount).toBeGreaterThanOrEqual(3);
        expect(validation.evidenceMapCount).toBeGreaterThanOrEqual(
          validation.semanticUnitCount,
        );
        expect(manifest.kind).toBe("qmd_graphrag_bookshelf_manifest");
        expect(manifest.bookshelfIdentity.queryReady).toBe(true);
        expect(manifest.membership.membersPath).toBe("bookshelf_members.json");
        expect(manifest.membership.membershipManifestPath)
          .toBe("membership/BOOKSHELF_MEMBERSHIP_MANIFEST.json");
        expect(manifest.files.map((file: { path: string }) => file.path))
          .not.toContain("BOOKSHELF_MANIFEST.json");
        expect(qualityGate.fixedQueryBudgetSimulation.status).toBe("passed");
        expect(qualityGate.checks.map(
          (check: { checkId: string }) => check.checkId,
        )).toContain("semantic_edges_relation_types_allowed");
        for (const relativePath of [
          "semantic_units.parquet",
          "semantic_edges.parquet",
          "communities.parquet",
          "community_reports.parquet",
          "evidence_map.parquet",
          "semantic_unit_embeddings.lance/INDEX_MANIFEST.json",
          "membership/BOOKSHELF_MEMBERSHIP_MANIFEST.json",
        ]) {
          expect(existsSync(join(currentRoot, relativePath)), relativePath)
            .toBe(true);
          expect(existsSync(join(currentRoot, `${relativePath}.sha256`)),
            `${relativePath}.sha256`).toBe(true);
        }
        for (const bookId of bookIds) {
          expect(existsSync(join(
            stateRoot,
            "books",
            bookId,
            "BOOKSHELF_MANIFEST.json",
          ))).toBe(false);
          expect(existsSync(join(
            stateRoot,
            "books",
            bookId,
            "semantic_units.parquet",
          ))).toBe(false);
        }

        const capabilities = await loadBookshelfGraphQueryCapabilities({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          method: "global",
        });
        const query = await queryBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          query: "What is architecture testing?",
          method: "global",
        });

        expect(capabilities).toHaveLength(3);
        expect(capabilities.every((capability) => capability.ready)).toBe(true);
        expect(query.method).toBe("global");
        expect(query.providerDetail?.runtimeMetrics?.aggregate
          .attemptedRequestCount).toBe(0);
        expect(query.providerDetail?.runtimeMetrics?.aggregate
          .promptTokens).toBeGreaterThan(0);
        expect(query.responseText).toContain("fixed-budget GraphRAG report search");
        expect(query.evidence.length).toBeGreaterThan(0);
        expect(query.evidence[0]?.bookId).toMatch(/^book-graph-/u);
        expect(query.evidence[0]?.sourceId).toMatch(/^sha256:/u);
        expect(query.evidence[0]?.documentId).toMatch(/^doc-/u);
        expect(query.evidence[0]?.contentHash).toBeTruthy();
        expect(query.evidence[0]?.graphTextUnitId).toBeTruthy();
        expect(query.evidence[0]?.locator?.path).toBe(
          "catalog/bookshelves/architecture-core/current/community_reports.parquet",
        );

        const gatePath = join(
          currentRoot,
          "state",
          "bookshelf-quality-gate.json",
        );
        await writeFile(gatePath, JSON.stringify({
          ...qualityGate,
          checks: qualityGate.checks.filter(
            (check: { checkId: string }) =>
              check.checkId !== "semantic_edges_relation_types_allowed",
          ),
        }));
        const invalidGateValidation = await validateBookshelfGraph({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
        });
        expect(invalidGateValidation.ok).toBe(false);
        expect(invalidGateValidation.diagnostics).toContain(
          "quality_gate_missing_check:semantic_edges_relation_types_allowed",
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });
});
