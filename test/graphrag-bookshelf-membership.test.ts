import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildBookHotplugPackage,
  validateBookHotplugPackage,
} from "../scripts/graphrag/book-hotplug-package.mjs";
import {
  buildPostPublishQualityGate,
  buildRuntimeGateState,
  prePublishHotplugQualityGate,
} from "../scripts/graphrag/book-hotplug-quality-gate.mjs";
import {
  resolveBookshelfMembership,
  validateBookshelfMembership,
} from "../src/graphrag/upper-index/bookshelf-membership.js";
import {
  mkProjectTmpDir,
  writeBookScopedQmdIndexFixture,
  writeDurableJsonFixture,
  writeProviderAuthReopenGraphFixture,
} from "./helpers/graphrag-runner-harness.js";

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function writeReadyHotplugBook(input: {
  stateRoot: string;
  bookId: string;
  title: string;
}): Promise<void> {
  const sourceText = `epub:${input.title}`;
  const normalizedText = `# ${input.title}\n\nArchitecture and software design.\n`;
  const sourceHash = sha256Text(sourceText);
  const normalizedHash = sha256Text(normalizedText);
  const bookRoot = join(input.stateRoot, "books", input.bookId);
  await writeProviderAuthReopenGraphFixture({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    contentHash: normalizedHash,
  });
  await mkdir(join(bookRoot, "input"), { recursive: true });
  await mkdir(join(bookRoot, "qmd"), { recursive: true });
  await mkdir(join(bookRoot, "source"), { recursive: true });
  await writeFile(join(bookRoot, "input", "book.md"), normalizedText, "utf8");
  await writeFile(join(bookRoot, "source", "source.epub"), sourceText, "utf8");
  await writeDurableJsonFixture(join(bookRoot, "qmd", "qmd_build_manifest.json"), {
    schemaVersion: "1.0.0",
    kind: "qmd_build_manifest",
    itemId: `item-${input.bookId}`,
    runId: `run-${input.bookId}`,
    bookId: input.bookId,
    sourceName: `${input.title}.epub`,
    sourceRelativePath: `books/${input.bookId}/source/source.epub`,
    sourceHash,
    canonicalBookNormalizedPath: `books/${input.bookId}/input/book.md`,
    normalizedContentHash: normalizedHash,
    configHash: "config-hash",
    normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
  });
  await writeDurableJsonFixture(
    join(bookRoot, "graphrag", "output", "qmd_graph_text_unit_identity.json"),
    {
      schemaVersion: "1.0.0",
      bookId: input.bookId,
      sourceId: `sha256:${sourceHash}`,
      sourceHash,
      documentId: `doc-${sourceHash.slice(0, 12)}`,
      contentHash: normalizedHash,
      normalizedPath: `books/${input.bookId}/input/book.md`,
      graphDocumentId: `graph-doc-${input.bookId}`,
      graphTextUnitIds: [`tu-${input.bookId}`],
      metadata: {
        title: input.title,
        identityProvenance: "package_source",
        publishAllowed: true,
      },
    },
  );
  await writeBookScopedQmdIndexFixture({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    normalizedPath: join(bookRoot, "input", "book.md"),
    normalizedContentHash: normalizedHash,
  });
  const built = buildBookHotplugPackage({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    sourceRelativePath: `books/${input.bookId}/source/source.epub`,
    now: () => "2026-06-06T00:00:00.000Z",
    toolVersion: "test",
  });
  await writeDurableJsonFixture(join(bookRoot, "BOOK_MANIFEST.json"), built.manifest);
  await writeDurableJsonFixture(join(bookRoot, "PUBLISH_READY.json"), built.publishReady);
  const validation = validateBookHotplugPackage({ bookRoot });
  expect(validation.ok).toBe(true);
  const gate = prePublishHotplugQualityGate({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
  });
  await writeDurableJsonFixture(
    join(bookRoot, "state", "hotplug-quality-gate.json"),
    buildPostPublishQualityGate({
      bookId: input.bookId,
      gate,
      validation,
      manifest: built.manifest,
      checkedAt: "2026-06-06T00:00:01.000Z",
    }),
  );
  await writeDurableJsonFixture(
    join(bookRoot, "state", "hotplug-runtime-gate.json"),
    buildRuntimeGateState({
      bookId: input.bookId,
      gate,
      validation,
      manifest: built.manifest,
      checkedAt: "2026-06-06T00:00:01.000Z",
      candidateValidationOk: true,
    }),
  );
}

async function readBookshelfCurrentRoot(
  stateRoot: string,
  bookshelfId: string,
): Promise<string> {
  const current = JSON.parse(
    await readFile(
      join(stateRoot, "bookshelves", bookshelfId, "CURRENT.json"),
      "utf8",
    ),
  );
  return join(stateRoot, "bookshelves", bookshelfId, current.current);
}

describe("GraphRAG bookshelf membership", () => {
  test("materializes a membership generation from three query-ready book packages",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-bookshelf-membership-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookIds = ["book-shelf-a", "book-shelf-b", "book-shelf-c"];
        for (const [index, bookId] of bookIds.entries()) {
          await writeReadyHotplugBook({
            stateRoot,
            bookId,
            title: `Architecture ${index + 1}`,
          });
        }

        const result = await resolveBookshelfMembership({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          bookIds,
          now: () => "2026-06-06T00:00:02.000Z",
        });
        const validation = await validateBookshelfMembership({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
        });
        const currentRoot = await readBookshelfCurrentRoot(
          stateRoot,
          "architecture-core",
        );
        const manifest = JSON.parse(
          await readFile(
            join(currentRoot, "BOOKSHELF_MEMBERSHIP_MANIFEST.json"),
            "utf8",
          ),
        );
        const members = JSON.parse(
          await readFile(join(currentRoot, "bookshelf_members.json"), "utf8"),
        );

        expect(result.memberCount).toBe(3);
        expect(validation).toMatchObject({ ok: true, memberCount: 3 });
        expect(manifest.bookshelfIdentity.queryReady).toBe(false);
        expect(manifest.nextStage.requiredManifest).toBe("BOOKSHELF_MANIFEST.json");
        const manifestFilePaths = manifest.files.map((file: { path: string }) =>
          file.path
        );
        expect(manifestFilePaths).not.toContain(
          "BOOKSHELF_MEMBERSHIP_MANIFEST.json",
        );
        expect(manifestFilePaths).toEqual(expect.arrayContaining([
            "state/diagnostics.json",
            `runs/architecture-core-${manifest.bookshelfIdentity.generation}/events.jsonl`,
            `runs/architecture-core-${manifest.bookshelfIdentity.generation}/status.json`,
            `runs/architecture-core-${manifest.bookshelfIdentity.generation}/recovery-summary.json`,
        ]));
        expect(members.members.map((member: { bookId: string }) => member.bookId))
          .toEqual(bookIds);
        expect(existsSync(join(currentRoot, "BOOKSHELF_MANIFEST.json"))).toBe(false);
        for (const member of members.members) {
          const checkpointName = member.membershipDecisionId
            .replace(/[^A-Za-z0-9._-]/gu, "_");
          expect(existsSync(join(
            currentRoot,
            "runs",
            `architecture-core-${manifest.bookshelfIdentity.generation}`,
            "checkpoints",
            `${checkpointName}.json`,
          ))).toBe(true);
        }
        for (const bookId of bookIds) {
          expect(existsSync(join(stateRoot, "books", bookId, "BOOK_MANIFEST.json")))
            .toBe(true);
        }
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("rejects membership manifests with mismatched file closure digests",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-bookshelf-closure-digest-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookIds = ["book-shelf-a", "book-shelf-b", "book-shelf-c"];
        for (const [index, bookId] of bookIds.entries()) {
          await writeReadyHotplugBook({
            stateRoot,
            bookId,
            title: `Architecture ${index + 1}`,
          });
        }
        await resolveBookshelfMembership({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
          bookIds,
          now: () => "2026-06-06T00:00:02.000Z",
        });
        const currentRoot = await readBookshelfCurrentRoot(
          stateRoot,
          "architecture-core",
        );
        const manifestPath = join(
          currentRoot,
          "BOOKSHELF_MEMBERSHIP_MANIFEST.json",
        );
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const tamperedFile = manifest.files.find(
          (file: { path: string }) => file.path === "bookshelf_members.json",
        ) as { path: string };
        const members = JSON.parse(
          await readFile(join(currentRoot, tamperedFile.path), "utf8"),
        );
        members.members[0].title = "Tampered Architecture";
        await writeFile(
          join(currentRoot, tamperedFile.path),
          `${JSON.stringify(members, null, 2)}\n`,
        );

        const validation = await validateBookshelfMembership({
          graphVault: stateRoot,
          bookshelfId: "architecture-core",
        });

        expect(validation.ok).toBe(false);
        expect(validation.diagnostics).toContain(
          `manifest_file_sha256_mismatch:${tamperedFile.path}`,
        );
        expect(validation.diagnostics).toContain(
          `manifest_file_sidecar_mismatch:${tamperedFile.path}`,
        );
        expect(validation.diagnostics).toContain("members_digest_mismatch");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("rejects members without package-local hotplug runtime gate", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-bookshelf-gate-reject-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      await writeReadyHotplugBook({
        stateRoot,
        bookId: "book-shelf-ready",
        title: "Ready",
      });
      await writeReadyHotplugBook({
        stateRoot,
        bookId: "book-shelf-not-ready",
        title: "Not Ready",
      });
      await rm(
        join(
          stateRoot,
          "books",
          "book-shelf-not-ready",
          "state",
          "hotplug-runtime-gate.json",
        ),
        { force: true },
      );

      await expect(resolveBookshelfMembership({
        graphVault: stateRoot,
        bookshelfId: "architecture-core",
        bookIds: ["book-shelf-ready", "book-shelf-not-ready"],
        now: () => "2026-06-06T00:00:02.000Z",
      })).rejects.toThrow(
        "upper_quality_gate_failed:package_runtime_gate_failed",
      );
      expect(existsSync(
        join(
          stateRoot,
          "bookshelves",
          "architecture-core",
          "CURRENT.json",
        ),
      )).toBe(false);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
