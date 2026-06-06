import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildBookshelfGraph,
} from "../src/graphrag/upper-index/bookshelf-graph.js";
import {
  resolveBookshelfMembership,
} from "../src/graphrag/upper-index/bookshelf-membership.js";
import {
  resolveLibraryMembership,
  validateLibraryMembership,
} from "../src/graphrag/upper-index/library-membership.js";
import { writeReadyHotplugBook } from "./helpers/graphrag-hotplug-book-package.js";
import { mkProjectTmpDir } from "./helpers/graphrag-runner-harness.js";

async function writeReadyBookshelf(input: {
  stateRoot: string;
  bookshelfId: string;
  bookIds: readonly string[];
  titlePrefix: string;
  clockSecond: number;
}): Promise<void> {
  for (const [index, bookId] of input.bookIds.entries()) {
    await writeReadyHotplugBook({
      stateRoot: input.stateRoot,
      bookId,
      title: `${input.titlePrefix} ${index + 1}`,
    });
  }
  await resolveBookshelfMembership({
    graphVault: input.stateRoot,
    bookshelfId: input.bookshelfId,
    bookIds: input.bookIds,
    now: () => `2026-06-06T00:00:${input.clockSecond}.000Z`,
  });
  await buildBookshelfGraph({
    graphVault: input.stateRoot,
    bookshelfId: input.bookshelfId,
    maxReportsPerBook: 2,
    maxSemanticUnits: 16,
    maxEdges: 32,
    now: () => `2026-06-06T00:00:${input.clockSecond + 1}.000Z`,
  });
}

describe("GraphRAG library membership", () => {
  test("materializes library membership from two query-ready bookshelves",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-library-membership-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "architecture-core",
          bookIds: ["book-lib-a1", "book-lib-a2", "book-lib-a3"],
          titlePrefix: "Architecture Library A",
          clockSecond: 2,
        });
        await writeReadyBookshelf({
          stateRoot,
          bookshelfId: "delivery-core",
          bookIds: ["book-lib-b1", "book-lib-b2", "book-lib-b3"],
          titlePrefix: "Architecture Library B",
          clockSecond: 4,
        });

        const result = await resolveLibraryMembership({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
          bookshelfIds: ["architecture-core", "delivery-core"],
          shelfLimit: 8,
          directBookLimit: 0,
          now: () => "2026-06-06T00:00:06.000Z",
        });
        const validation = await validateLibraryMembership({
          graphVault: stateRoot,
          libraryId: "software-engineering-library",
        });
        const currentRoot = join(
          stateRoot,
          "catalog",
          "library",
          "software-engineering-library",
          "current",
        );
        const manifest = JSON.parse(
          await readFile(
            join(currentRoot, "LIBRARY_MEMBERSHIP_MANIFEST.json"),
            "utf8",
          ),
        );
        const members = JSON.parse(
          await readFile(join(currentRoot, "library_members.json"), "utf8"),
        );
        const partitionPlan = JSON.parse(
          await readFile(join(currentRoot, "library_partition_plan.json"), "utf8"),
        );

        expect(result.bookshelfCount).toBe(2);
        expect(result.directBookCount).toBe(0);
        expect(validation).toMatchObject({
          ok: true,
          bookshelfCount: 2,
          directBookCount: 0,
          diagnostics: [],
        });
        expect(manifest.libraryIdentity.queryReady).toBe(false);
        expect(manifest.nextStage.requiredManifest).toBe("LIBRARY_MANIFEST.json");
        expect(manifest.files.map((file: { path: string }) => file.path))
          .not.toContain("LIBRARY_MEMBERSHIP_MANIFEST.json");
        expect(members.members.bookshelves.map(
          (member: { bookshelfId: string }) => member.bookshelfId,
        )).toEqual(["architecture-core", "delivery-core"]);
        expect(partitionPlan.status).toBe("not_required");
        expect(existsSync(join(currentRoot, "LIBRARY_MANIFEST.json"))).toBe(false);
        expect(existsSync(join(
          stateRoot,
          "catalog",
          "bookshelves",
          "architecture-core",
          "current",
          "BOOKSHELF_MANIFEST.json",
        ))).toBe(true);
        for (const member of members.members.bookshelves) {
          const checkpoint = join(
            currentRoot,
            "runs",
            `software-engineering-library-${manifest.libraryIdentity.generation}`,
            "checkpoints",
            `${member.bookshelfId}.json`,
          );
          expect(existsSync(checkpoint)).toBe(true);
          expect(existsSync(`${checkpoint}.sha256`)).toBe(true);
        }
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    60000,
  );

  test("rejects direct book members beyond the configured limit", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-library-direct-book-limit-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      await writeReadyBookshelf({
        stateRoot,
        bookshelfId: "architecture-core",
        bookIds: ["book-lib-limit-a", "book-lib-limit-b", "book-lib-limit-c"],
        titlePrefix: "Direct Limit",
        clockSecond: 2,
      });

      await expect(resolveLibraryMembership({
        graphVault: stateRoot,
        libraryId: "software-engineering-library",
        bookshelfIds: ["architecture-core"],
        directBookIds: ["book-lib-limit-a"],
        directBookLimit: 0,
        now: () => "2026-06-06T00:00:06.000Z",
      })).rejects.toThrow("direct_book_limit_exceeded");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 60000);
});
