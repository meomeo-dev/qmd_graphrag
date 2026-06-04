import { createHash } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";
import { describe, expect, test } from "vitest";

import {
  buildBookHotplugPackage,
  validateBookHotplugPackage,
} from "../scripts/graphrag/book-hotplug-package.mjs";
import {
  buildPostPublishQualityGate,
  buildRuntimeGateState,
} from "../scripts/graphrag/book-hotplug-quality-gate.mjs";
import {
  createHotplugMigrationRun,
  classifySingleBookForHotplugMigration,
  writeHotplugMigrationRunEvidence,
} from "../scripts/graphrag/book-hotplug-migration-state.mjs";
import {
  loadGraphQueryCapabilities,
} from "../src/index.js";
import {
  writeDurableJsonFixture,
  writeDurableYamlFixture,
  writeProviderAuthReopenGraphFixture,
  writeBookScopedQmdIndexFixture,
  mkProjectTmpDir,
} from "./helpers/graphrag-runner-harness.js";

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function writeLegacyDistributionFixture(input: {
  stateRoot: string;
  bookId: string;
  sourceText?: string;
  withSource?: boolean;
}): Promise<string> {
  const sourceText = input.sourceText ?? "epub";
  const sourceHash = sha256Text(sourceText);
  const sourceRelativePath = `inbox/${input.bookId}.epub`;
  const bookRoot = join(input.stateRoot, "books", input.bookId);
  await mkdir(join(bookRoot, "input"), { recursive: true });
  await mkdir(join(bookRoot, "qmd"), { recursive: true });
  await mkdir(join(bookRoot, "graphrag", "output"), { recursive: true });
  await mkdir(join(bookRoot, "graphrag", "runs"), { recursive: true });
  await mkdir(join(bookRoot, "state"), { recursive: true });
  if (input.withSource !== false) {
    await mkdir(join(input.stateRoot, "books", input.bookId, "source"), { recursive: true });
    await writeFile(
      join(input.stateRoot, "books", input.bookId, "source", "source.epub"),
      sourceText,
      "utf8",
    );
  }
  await writeFile(join(bookRoot, "input", "book.md"), "# Book\n", "utf8");
  await writeDurableJsonFixture(join(bookRoot, "qmd", "qmd_build_manifest.json"), {
    schemaVersion: "1.0.0",
    kind: "qmd_build_manifest",
    bookId: input.bookId,
    sourceHash,
    sourceRelativePath,
    normalizedPath: `books/${input.bookId}/input/book.md`,
    normalizedContentHash: sha256Text("# Book\n"),
    qmdIndexLocator: ".qmd/index.sqlite",
    qmdIndexHash: "index-hash",
    configHash: "config-hash",
  });
  await writeDurableJsonFixture(
    join(bookRoot, "graphrag", "output", "qmd_output_manifest.json"),
    {
    schemaVersion: "1.0.0",
    bookId: input.bookId,
    sourceHash,
    documentId: `doc-${sourceHash.slice(0, 12)}`,
    contentHash: sourceHash,
    stageFingerprints: { graph_extract: "fp-graph" },
    providerFingerprint: "provider-fp",
    outputDir: `books/${input.bookId}/graphrag/output`,
    producerRunId: "run-query-ready",
    stageProducerRunIds: { graph_extract: "run-graph-extract" },
    },
  );
  await writeDurableYamlFixture(join(bookRoot, "state", "artifacts.yaml"), {
    schemaVersion: "1.0.0",
    items: [{
      artifactId: `${input.bookId}:graph_extract:manifest`,
      bookId: input.bookId,
      stage: "graph_extract",
      kind: "graphrag_output_manifest",
      path: `books/${input.bookId}/graphrag/output/qmd_output_manifest.json`,
      contentHash: sha256Text(JSON.stringify({ bookId: input.bookId })),
      producerRunId: "run-graph-extract",
    }],
  });
  await writeDurableYamlFixture(join(bookRoot, "state", "checkpoints.yaml"), {
    schemaVersion: "1.0.0",
    items: [{
      bookId: input.bookId,
      stage: "graph_extract",
      status: "succeeded",
      runId: "run-graph-extract",
    }],
  });
  await writeDurableYamlFixture(
    join(bookRoot, "graphrag", "runs", "run-graph-extract.yaml"),
    {
    schemaVersion: "1.0.0",
    runId: "run-graph-extract",
    bookId: input.bookId,
    stage: "graph_extract",
    status: "succeeded",
    },
  );
  await writeDurableJsonFixture(join(bookRoot, "distribution_manifest.json"), {
    schemaVersion: "1.0.0",
    kind: "book_distribution_manifest",
    bookId: input.bookId,
    sourceHash,
    sourceRelativePath,
    portability: {
      closureRoot: `books/${input.bookId}`,
      sourceRoot: `books/${input.bookId}/source`,
      canonicalNormalizedPath: `books/${input.bookId}/input/book.md`,
      qmdBuildManifestPath: `books/${input.bookId}/qmd/qmd_build_manifest.json`,
      graphOutputManifestPath:
        `books/${input.bookId}/graphrag/output/qmd_output_manifest.json`,
    },
    producerEvidence: {
      outputProducerRunId: "run-query-ready",
      stageProducerRunIds: { graph_extract: "run-graph-extract" },
      presentRunRecordCount: 1,
      missingRunRecordIds: [],
    },
    files: [],
  });
  await writePackageQmdIndex({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    normalizedContentHash: sha256Text("# Book\n"),
  });
  return sourceHash;
}

async function writePackageQmdIndex(input: {
  stateRoot: string;
  bookId: string;
  normalizedContentHash?: string;
}): Promise<void> {
  await writeBookScopedQmdIndexFixture({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    normalizedPath: join(input.stateRoot, "books", input.bookId, "input", "book.md"),
    normalizedContentHash: input.normalizedContentHash,
  });
}

describe("GraphRAG hotplug catalog projection", () => {
  test("rebuilds graph capability catalog from BOOK_MANIFEST package", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-catalog-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-hotplug-1";
      const sourceText = "epub";
      const inputText = "# Book\n\nSoftware design complexity.\n";
      const sourceHash = sha256Text(sourceText);
      const normalizedHash = sha256Text(inputText);

      await writeProviderAuthReopenGraphFixture({
        stateRoot,
        bookId,
        sourceHash,
        contentHash: normalizedHash,
      });
      await mkdir(join(stateRoot, "books", bookId, "input"), { recursive: true });
      await mkdir(join(stateRoot, "books", bookId, "qmd"), { recursive: true });
      await mkdir(join(stateRoot, "books", bookId, "source"), { recursive: true });
      await writeFile(
        join(stateRoot, "books", bookId, "input", "book.md"),
        inputText,
        "utf8",
      );
      await writeFile(
        join(stateRoot, "books", bookId, "source", "source.epub"),
        sourceText,
        "utf8",
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "qmd", "qmd_build_manifest.json"),
        {
          schemaVersion: "1.0.0",
          kind: "qmd_build_manifest",
          itemId: "item-hotplug-1",
          runId: "run-hotplug-1",
          bookId,
          sourceName: "Book.epub",
          sourceRelativePath: `books/${bookId}/source/source.epub`,
          sourceHash,
          canonicalBookNormalizedPath: `books/${bookId}/input/book.md`,
          normalizedContentHash: normalizedHash,
          configHash: "config-hash",
          normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
        },
      );
      await writeDurableJsonFixture(
        join(
          stateRoot,
          "books",
          bookId,
          "graphrag",
          "output",
          "qmd_graph_text_unit_identity.json",
        ),
        {
          schemaVersion: "1.0.0",
          bookId,
          sourceId: `sha256:${sourceHash}`,
          sourceHash,
          documentId: `doc-${sourceHash.slice(0, 12)}`,
          contentHash: normalizedHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          graphDocumentId: `graph-doc-${bookId}`,
          graphTextUnitIds: [`tu-${bookId}`],
        },
      );
      await writeDurableYamlFixture(
        join(
          stateRoot,
          "books",
          bookId,
          "graphrag",
          "runs",
          "run-query-ready.yaml",
        ),
        {
          schemaVersion: "1.0.0",
          runId: "run-query-ready",
          bookId,
          stage: "query_ready",
          status: "succeeded",
          attemptCount: 1,
          startedAt: "2026-06-02T00:00:00.000Z",
          finishedAt: "2026-06-02T00:00:01.000Z",
          inputFingerprint: "fp-query-ready",
          artifactIds: [],
          metadata: {},
        },
      );
      await writePackageQmdIndex({ stateRoot, bookId, normalizedContentHash: normalizedHash });

      const { manifest, publishReady } = buildBookHotplugPackage({
        stateRoot,
        bookId,
        sourceHash,
        sourceRelativePath: `books/${bookId}/source/source.epub`,
        now: () => "2026-06-02T00:00:00.000Z",
        toolVersion: "test",
      });
      expect(manifest.graphrag.queryReady).toBe(true);
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "BOOK_MANIFEST.json"),
        manifest,
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "PUBLISH_READY.json"),
        publishReady,
      );

      for (const path of [
        join(stateRoot, "catalog", "books.yaml"),
        join(stateRoot, "catalog", "document-identity-map.yaml"),
        join(stateRoot, "catalog", "graph-capabilities.yaml"),
      ]) {
        if (existsSync(path)) await unlink(path);
      }

      const capabilities = await loadGraphQueryCapabilities({
        graphVault: stateRoot,
        bookIds: [bookId],
      });

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0]?.bookId).toBe(bookId);

      const booksCatalog = YAML.parse(
        await readFile(join(stateRoot, "catalog", "books.yaml"), "utf8"),
      );
      const identityCatalog = YAML.parse(
        await readFile(
          join(stateRoot, "catalog", "document-identity-map.yaml"),
          "utf8",
        ),
      );
      const capabilityCatalog = YAML.parse(
        await readFile(
          join(stateRoot, "catalog", "graph-capabilities.yaml"),
          "utf8",
        ),
      );

      expect(booksCatalog.items).toHaveLength(1);
      expect(identityCatalog.items).toHaveLength(1);
      expect(capabilityCatalog.items).toHaveLength(1);
      expect(identityCatalog.items[0]?.normalizedPath)
        .toBe(`books/${bookId}/input/book.md`);
      expect(identityCatalog.items[0]?.metadata?.legacyGraphIdentityNormalizedPath)
        .toBeUndefined();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("records migration evidence and residue quarantine without promoting residue", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-migration-evidence-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const currentBookId = "book-current-1";
      const residueBookId = "book-residue-1";
      await writeLegacyDistributionFixture({ stateRoot, bookId: currentBookId });
      await mkdir(join(stateRoot, "books", residueBookId, "input"), {
        recursive: true,
      });
      await writeFile(
        join(stateRoot, "books", residueBookId, "input", "book.md"),
        "# Residue\n",
        "utf8",
      );

      const run = createHotplugMigrationRun({
        stateRoot,
        now: () => "2026-06-02T00:00:00.000Z",
      });
      const current = run.classifications.find((item) =>
        item.bookId === currentBookId
      );
      const residue = run.classifications.find((item) =>
        item.bookId === residueBookId
      );

      expect(run.candidates.map((item) => item.bookId)).toContain(currentBookId);
      expect(current?.mayGenerateBookManifest).toBe(true);
      expect(residue?.mayGenerateBookManifest).toBe(false);
      expect(residue?.migrationState).toBe("residue_quarantined");
      expect(residue?.residueAction).toBe("quarantine_without_delete");

      const evidence = writeHotplugMigrationRunEvidence({
        stateRoot,
        run,
        processed: [],
        skipped: [],
        failures: [],
        packageResults: [],
        failed: 0,
        completedAt: "2026-06-02T00:00:01.000Z",
      });
      const classification = YAML.parse(
        await readFile(
          join(evidence.migrationRoot, "classification.yaml"),
          "utf8",
        ),
      );
      const residueReport = YAML.parse(
        await readFile(evidence.residueReportPath, "utf8"),
      );

      expect(classification.items).toHaveLength(2);
      expect(residueReport.residues).toHaveLength(1);
      expect(residueReport.residues[0].mountAllowed).toBe(false);
      expect(existsSync(join(stateRoot, "books", residueBookId))).toBe(true);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("records executable resume and rollback evidence for interrupted migration",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-resume-evidence-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const partialBookId = "book-partial-migration";
        const interruptedBookId = "book-failed-interrupted";
        await writeLegacyDistributionFixture({ stateRoot, bookId: partialBookId });
        await writeLegacyDistributionFixture({
          stateRoot,
          bookId: interruptedBookId,
        });
        await mkdir(
          join(
            stateRoot,
            "catalog",
            ".staging",
            "book-hotplug-migrations",
            partialBookId,
          ),
          { recursive: true },
        );
        await writeDurableJsonFixture(
          join(stateRoot, "books", interruptedBookId, "BOOK_MANIFEST.json"),
          {
            schemaVersion: "1.0.0",
            kind: "qmd_graphrag_book_package",
            identity: {
              bookId: interruptedBookId,
              sourceHash: sha256Text("epub"),
            },
            source: { sourceHash: sha256Text("epub") },
          },
        );

        const run = createHotplugMigrationRun({
          stateRoot,
          now: () => "2026-06-02T00:00:00.000Z",
        });
        const partial = run.classifications.find((item) =>
          item.bookId === partialBookId
        );
        const interrupted = run.classifications.find((item) =>
          item.bookId === interruptedBookId
        );

        expect(partial?.migrationState).toBe("partial_migration");
        expect(partial?.rerunBehavior)
          .toBe("resume_from_copy_map_after_staging_validation");
        expect(interrupted?.migrationState).toBe("failed_interrupted");
        expect(interrupted?.rerunBehavior)
          .toBe("require_explicit_resume_or_restart_decision");

        const evidence = writeHotplugMigrationRunEvidence({
          stateRoot,
          run,
          processed: [],
          skipped: [],
          failures: [],
          packageResults: [],
          failed: 0,
          completedAt: "2026-06-02T00:00:01.000Z",
        });
        const resumePlan = YAML.parse(
          await readFile(evidence.resumePlanPath, "utf8"),
        );
        const rollbackRecord = YAML.parse(
          await readFile(evidence.rollbackRecordPath, "utf8"),
        );

        expect(resumePlan).toMatchObject({
          migrationId: run.migrationId,
          status: "ready",
          resumable: true,
          nextAction: "require_explicit_resume_or_restart_decision",
          partialMigrationCount: 1,
          failedInterruptedCount: 1,
          repairRequiredCount: 0,
          pendingBookIds: expect.arrayContaining([
            partialBookId,
            interruptedBookId,
          ]),
          processedBookIds: [],
          skippedBookIds: [],
          failureBookIds: [],
        });
        expect(resumePlan.items).toEqual(expect.arrayContaining([
          expect.objectContaining({
            bookId: partialBookId,
            requiredDecision: "validate_copy_map_then_resume",
            resumeAllowed: true,
            publishAllowedBeforeValidation: false,
          }),
          expect.objectContaining({
            bookId: interruptedBookId,
            requiredDecision: "explicit_resume_or_restart_decision",
            restartAllowed: true,
            publishAllowedBeforeValidation: false,
          }),
        ]));
        expect(rollbackRecord).toMatchObject({
          migrationId: run.migrationId,
          status: "committed",
          rollbackRequired: false,
          rollbackAvailable: true,
          restoreCatalogProjection: false,
          removePublishedBookIds: expect.arrayContaining([
            interruptedBookId,
          ]),
          failureBookIds: [],
          quarantineRoots: [],
        });
        expect(rollbackRecord.packageRoots).toEqual(expect.arrayContaining([
          expect.objectContaining({
            bookId: partialBookId,
            actionOnFailure: "delete_or_resume_staging_only",
          }),
          expect.objectContaining({
            bookId: interruptedBookId,
            actionOnFailure: "remove_publish_marker_and_require_manual_decision",
          }),
        ]));
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("fails closed when source closure is missing", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-missing-source-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-missing-source";
      await writeLegacyDistributionFixture({
        stateRoot,
        bookId,
        withSource: false,
      });

      const run = createHotplugMigrationRun({
        stateRoot,
        now: () => "2026-06-02T00:00:00.000Z",
      });
      const item = run.classifications.find((candidate) =>
        candidate.bookId === bookId
      );

      expect(item?.mayGenerateBookManifest).toBe(false);
      expect(item?.diagnostics).toContain("migration_source_closure_missing");
      expect(run.candidates).toHaveLength(0);
      expect(existsSync(
        join(stateRoot, "books", bookId, "BOOK_MANIFEST.json"),
      )).toBe(false);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("rebuilds stale catalog projection from current package manifests", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-stale-catalog-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-hotplug-stale";
      const sourceText = "epub";
      const inputText = "# Book\n\nSoftware design complexity.\n";
      const sourceHash = sha256Text(sourceText);
      const normalizedHash = sha256Text(inputText);

      await writeProviderAuthReopenGraphFixture({
        stateRoot,
        bookId,
        sourceHash,
        contentHash: normalizedHash,
      });
      await mkdir(join(stateRoot, "books", bookId, "input"), { recursive: true });
      await mkdir(join(stateRoot, "books", bookId, "qmd"), { recursive: true });
      await mkdir(join(stateRoot, "books", bookId, "source"), { recursive: true });
      await writeFile(
        join(stateRoot, "books", bookId, "input", "book.md"),
        inputText,
        "utf8",
      );
      await writeFile(
        join(stateRoot, "books", bookId, "source", "source.epub"),
        sourceText,
        "utf8",
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "qmd", "qmd_build_manifest.json"),
        {
          schemaVersion: "1.0.0",
          kind: "qmd_build_manifest",
          itemId: "item-hotplug-stale",
          runId: "run-hotplug-stale",
          bookId,
          sourceName: "Book.epub",
          sourceRelativePath: `books/${bookId}/source/source.epub`,
          sourceHash,
          canonicalBookNormalizedPath: `books/${bookId}/input/book.md`,
          normalizedContentHash: normalizedHash,
          configHash: "config-hash",
          normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
        },
      );
      await writeDurableJsonFixture(
        join(
          stateRoot,
          "books",
          bookId,
          "graphrag",
          "output",
          "qmd_graph_text_unit_identity.json",
        ),
        {
          schemaVersion: "1.0.0",
          bookId,
          sourceId: `sha256:${sourceHash}`,
          sourceHash,
          documentId: `doc-${sourceHash.slice(0, 12)}`,
          contentHash: normalizedHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          graphDocumentId: `graph-doc-${bookId}`,
          graphTextUnitIds: [`tu-${bookId}`],
        },
      );
      await writePackageQmdIndex({ stateRoot, bookId, normalizedContentHash: normalizedHash });
      const { manifest, publishReady } = buildBookHotplugPackage({
        stateRoot,
        bookId,
        sourceHash,
        sourceRelativePath: `books/${bookId}/source/source.epub`,
        now: () => "2026-06-02T00:00:00.000Z",
        toolVersion: "test",
      });
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "BOOK_MANIFEST.json"),
        manifest,
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "PUBLISH_READY.json"),
        publishReady,
      );
      await writeDurableYamlFixture(join(stateRoot, "catalog", "books.yaml"), {
        schemaVersion: "1.0.0",
        items: [{ bookId: "stale-book", sourceHash: "stale" }],
      });
      await writeDurableYamlFixture(
        join(stateRoot, "catalog", "document-identity-map.yaml"),
        {
          schemaVersion: "1.0.0",
          items: [{ canonicalBookId: "stale-book" }],
        },
      );

      const validation = validateBookHotplugPackage({
        bookRoot: join(stateRoot, "books", bookId),
      });
      expect(validation.ok).toBe(true);
      expect(
        manifest.files.some((entry) =>
          entry.path === "graphrag/output/runtime-compatibility.json"
        ),
      ).toBe(true);

      const capabilities = await loadGraphQueryCapabilities({
        graphVault: stateRoot,
        bookIds: [bookId],
      });
      expect(capabilities).toHaveLength(1);

      const booksCatalog = YAML.parse(
        await readFile(join(stateRoot, "catalog", "books.yaml"), "utf8"),
      );
      expect(booksCatalog.items.map((item: { bookId: string }) => item.bookId))
        .toEqual([bookId]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("does not project package with stale manifest sidecar", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-invalid-sidecar-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-invalid-manifest-sidecar";
      const sourceText = "epub";
      const inputText = "# Book\n\nInvalid package boundary.\n";
      const sourceHash = sha256Text(sourceText);
      const normalizedHash = sha256Text(inputText);

      await writeProviderAuthReopenGraphFixture({
        stateRoot,
        bookId,
        sourceHash,
        contentHash: normalizedHash,
      });
      await mkdir(join(stateRoot, "books", bookId, "input"), { recursive: true });
      await mkdir(join(stateRoot, "books", bookId, "qmd"), { recursive: true });
      await mkdir(join(stateRoot, "books", bookId, "source"), { recursive: true });
      await writeFile(
        join(stateRoot, "books", bookId, "input", "book.md"),
        inputText,
        "utf8",
      );
      await writeFile(
        join(stateRoot, "books", bookId, "source", "source.epub"),
        sourceText,
        "utf8",
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "qmd", "qmd_build_manifest.json"),
        {
          schemaVersion: "1.0.0",
          kind: "qmd_build_manifest",
          itemId: "item-invalid-sidecar",
          runId: "run-invalid-sidecar",
          bookId,
          sourceName: "Book.epub",
          sourceRelativePath: `books/${bookId}/source/source.epub`,
          sourceHash,
          canonicalBookNormalizedPath: `books/${bookId}/input/book.md`,
          normalizedContentHash: normalizedHash,
          configHash: "config-hash",
          normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
        },
      );
      await writeDurableJsonFixture(
        join(
          stateRoot,
          "books",
          bookId,
          "graphrag",
          "output",
          "qmd_graph_text_unit_identity.json",
        ),
        {
          schemaVersion: "1.0.0",
          bookId,
          sourceId: `sha256:${sourceHash}`,
          sourceHash,
          documentId: `doc-${sourceHash.slice(0, 12)}`,
          contentHash: normalizedHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          graphDocumentId: `graph-doc-${bookId}`,
          graphTextUnitIds: [`tu-${bookId}`],
        },
      );
      await writePackageQmdIndex({ stateRoot, bookId, normalizedContentHash: normalizedHash });

      const { manifest, publishReady } = buildBookHotplugPackage({
        stateRoot,
        bookId,
        sourceHash,
        sourceRelativePath: `books/${bookId}/source/source.epub`,
        now: () => "2026-06-02T00:00:00.000Z",
        toolVersion: "test",
      });
      const manifestPath = join(
        stateRoot,
        "books",
        bookId,
        "BOOK_MANIFEST.json",
      );
      await writeDurableJsonFixture(manifestPath, manifest);
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "PUBLISH_READY.json"),
        publishReady,
      );
      await writeFile(`${manifestPath}.sha256`, "stale-sidecar\n", "utf8");

      const validation = validateBookHotplugPackage({
        bookRoot: join(stateRoot, "books", bookId),
      });
      const capabilities = await loadGraphQueryCapabilities({
        graphVault: stateRoot,
        bookIds: [bookId],
      });
      const booksCatalog = YAML.parse(
        await readFile(join(stateRoot, "catalog", "books.yaml"), "utf8"),
      );
      const qmdProjection = YAML.parse(
        await readFile(join(stateRoot, "catalog", "qmd-projection.yaml"), "utf8"),
      );

      expect(validation.ok).toBe(false);
      expect(validation.diagnostics).toContain("manifest_sha256_mismatch");
      expect(capabilities).toHaveLength(0);
      expect(booksCatalog.items).toEqual([]);
      expect(qmdProjection.items).toEqual([]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("keeps creation quality gate evidence outside package file closure", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-quality-gate-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-quality-gate";
      const sourceText = "epub";
      const sourceHash = await writeLegacyDistributionFixture({
        stateRoot,
        bookId,
        sourceText,
      });
      const gate = classifySingleBookForHotplugMigration({ stateRoot, bookId });
      expect(gate.mayGenerateBookManifest).toBe(true);

      const { manifest, publishReady } = buildBookHotplugPackage({
        stateRoot,
        bookId,
        sourceHash,
        sourceRelativePath: `inbox/${bookId}.epub`,
        forceGraphRagNotQueryReady: true,
        now: () => "2026-06-02T00:00:00.000Z",
        toolVersion: "test",
      });
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "BOOK_MANIFEST.json"),
        manifest,
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "PUBLISH_READY.json"),
        publishReady,
      );
      const validation = { ok: true, diagnostics: [], manifest };
      const qualityGate = buildPostPublishQualityGate({
        bookId,
        gate,
        validation,
        manifest,
        checkedAt: "2026-06-02T00:00:01.000Z",
        phase: "test_creation_quality_gate",
      });
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "state", "hotplug-quality-gate.json"),
        qualityGate,
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "state", "hotplug-runtime-gate.json"),
        buildRuntimeGateState({
          bookId,
          gate,
          validation,
          manifest,
          checkedAt: "2026-06-02T00:00:01.000Z",
          candidateValidationOk: true,
        }),
      );

      const rebuilt = buildBookHotplugPackage({
        stateRoot,
        bookId,
        sourceHash,
        sourceRelativePath: `inbox/${bookId}.epub`,
        forceGraphRagNotQueryReady: true,
        now: () => "2026-06-02T00:00:02.000Z",
        toolVersion: "test",
      });
      expect(qualityGate.status).toBe("passed");
      expect(qualityGate.copyDistributionAllowed).toBe(true);
      expect(
        rebuilt.manifest.files.some((entry) =>
          entry.path === "state/hotplug-quality-gate.json"
        ),
      ).toBe(false);
      expect(
        rebuilt.manifest.files.some((entry) =>
          entry.path.startsWith("state/hotplug-runtime-gate.json")
        ),
      ).toBe(false);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("keeps GraphRAG runtime reports outside package file closure", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-runtime-reports-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-runtime-reports";
      const sourceText = "epub";
      const sourceHash = await writeLegacyDistributionFixture({
        stateRoot,
        bookId,
        sourceText,
      });
      await mkdir(
        join(stateRoot, "books", bookId, "graphrag", "output", "reports"),
        { recursive: true },
      );
      await writeFile(
        join(
          stateRoot,
          "books",
          bookId,
          "graphrag",
          "output",
          "reports",
          "query.log",
        ),
        "Bearer raw-token sk-test-secret /tmp/query.log\n",
        "utf8",
      );

      const { manifest } = buildBookHotplugPackage({
        stateRoot,
        bookId,
        sourceHash,
        sourceRelativePath: `inbox/${bookId}.epub`,
        forceGraphRagNotQueryReady: true,
        now: () => "2026-06-02T00:00:00.000Z",
        toolVersion: "test",
      });

      expect(
        manifest.files.some((entry) =>
          String(entry.path).startsWith("graphrag/output/reports/")
        ),
      ).toBe(false);
      expect(manifest.exclusions.patterns).toContain(
        "graphrag/output/reports/**",
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("rejects copied book package with declared runtime report payload", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-declared-report-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-declared-report";
      const sourceText = "epub";
      const sourceHash = await writeLegacyDistributionFixture({
        stateRoot,
        bookId,
        sourceText,
      });
      const { manifest, publishReady } = buildBookHotplugPackage({
        stateRoot,
        bookId,
        sourceHash,
        sourceRelativePath: `inbox/${bookId}.epub`,
        forceGraphRagNotQueryReady: true,
        now: () => "2026-06-02T00:00:00.000Z",
        toolVersion: "test",
      });
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "BOOK_MANIFEST.json"),
        {
          ...manifest,
          files: [
            ...manifest.files,
            {
              path: "graphrag/output/reports/query.log",
              role: "graphrag_output",
              bytes: 0,
              sha256: sha256Text(""),
              required: true,
              sensitivity: "restricted",
            },
          ],
        },
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "PUBLISH_READY.json"),
        publishReady,
      );

      const validation = validateBookHotplugPackage({
        bookRoot: join(stateRoot, "books", bookId),
      });

      expect(validation.ok).toBe(false);
      expect(validation.diagnostics).toContain("forbidden_sensitive_material");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("rejects copied book package with undeclared provider payload", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-provider-payload-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-provider-payload";
      const sourceText = "epub";
      const sourceHash = await writeLegacyDistributionFixture({
        stateRoot,
        bookId,
        sourceText,
      });
      const { manifest, publishReady } = buildBookHotplugPackage({
        stateRoot,
        bookId,
        sourceHash,
        sourceRelativePath: `inbox/${bookId}.epub`,
        forceGraphRagNotQueryReady: true,
        now: () => "2026-06-02T00:00:00.000Z",
        toolVersion: "test",
      });
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "BOOK_MANIFEST.json"),
        manifest,
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "PUBLISH_READY.json"),
        publishReady,
      );
      await mkdir(join(stateRoot, "books", bookId, "provider-requests"), {
        recursive: true,
      });
      await writeFile(
        join(stateRoot, "books", bookId, "provider-requests", "payload.json"),
        "{\"secret\":\"not distributable\"}\n",
        "utf8",
      );

      const validation = validateBookHotplugPackage({
        bookRoot: join(stateRoot, "books", bookId),
      });

      expect(validation.ok).toBe(false);
      expect(validation.diagnostics).toContain(
        "forbidden_sensitive_material:provider-requests/payload.json",
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("does not derive query capability when package producer runs are missing", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-missing-runs-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-missing-runs";
      const sourceText = "epub";
      const inputText = "# Book\n\nSoftware design complexity.\n";
      const sourceHash = sha256Text(sourceText);
      const normalizedHash = sha256Text(inputText);

      await writeProviderAuthReopenGraphFixture({
        stateRoot,
        bookId,
        sourceHash,
        contentHash: normalizedHash,
      });
      await mkdir(join(stateRoot, "books", bookId, "input"), { recursive: true });
      await mkdir(join(stateRoot, "books", bookId, "qmd"), { recursive: true });
      await mkdir(join(stateRoot, "books", bookId, "source"), { recursive: true });
      await writeFile(
        join(stateRoot, "books", bookId, "input", "book.md"),
        inputText,
        "utf8",
      );
      await writeFile(
        join(stateRoot, "books", bookId, "source", "source.epub"),
        sourceText,
        "utf8",
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "qmd", "qmd_build_manifest.json"),
        {
          schemaVersion: "1.0.0",
          kind: "qmd_build_manifest",
          itemId: "item-missing-runs",
          runId: "run-missing-runs",
          bookId,
          sourceName: "Book.epub",
          sourceRelativePath: `books/${bookId}/source/source.epub`,
          sourceHash,
          canonicalBookNormalizedPath: `books/${bookId}/input/book.md`,
          normalizedContentHash: normalizedHash,
          configHash: "config-hash",
          normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
        },
      );
      await writeDurableJsonFixture(
        join(
          stateRoot,
          "books",
          bookId,
          "graphrag",
          "output",
          "qmd_graph_text_unit_identity.json",
        ),
        {
          schemaVersion: "1.0.0",
          bookId,
          sourceId: `sha256:${sourceHash}`,
          sourceHash,
          documentId: `doc-${sourceHash.slice(0, 12)}`,
          contentHash: normalizedHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          graphDocumentId: `graph-doc-${bookId}`,
          graphTextUnitIds: [`tu-${bookId}`],
        },
      );
      await writePackageQmdIndex({ stateRoot, bookId, normalizedContentHash: normalizedHash });
      const { manifest, publishReady } = buildBookHotplugPackage({
        stateRoot,
        bookId,
        sourceHash,
        sourceRelativePath: `books/${bookId}/source/source.epub`,
        now: () => "2026-06-02T00:00:00.000Z",
        toolVersion: "test",
      });
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "BOOK_MANIFEST.json"),
        manifest,
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "PUBLISH_READY.json"),
        publishReady,
      );
      await rm(join(stateRoot, "books", bookId, "graphrag", "runs"), {
        recursive: true,
        force: true,
      });
      await rm(join(stateRoot, "catalog", "graph-capabilities.yaml"), {
        force: true,
      });

      const validation = validateBookHotplugPackage({
        bookRoot: join(stateRoot, "books", bookId),
      });
      const capabilities = await loadGraphQueryCapabilities({
        graphVault: stateRoot,
        bookIds: [bookId],
      });

      expect(validation.ok).toBe(false);
      expect(validation.diagnostics.some((diagnostic) =>
        diagnostic.startsWith("missing_producer_run:")
      )).toBe(true);
      expect(capabilities).toHaveLength(0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("does not derive query capability when artifact metadata omits an artifact", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-hotplug-missing-metadata-row-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const bookId = "book-missing-metadata-row";
      const sourceText = "epub";
      const inputText = "# Book\n\nSoftware design complexity.\n";
      const sourceHash = sha256Text(sourceText);
      const normalizedHash = sha256Text(inputText);

      await writeProviderAuthReopenGraphFixture({
        stateRoot,
        bookId,
        sourceHash,
        contentHash: normalizedHash,
      });
      await mkdir(join(stateRoot, "books", bookId, "input"), { recursive: true });
      await mkdir(join(stateRoot, "books", bookId, "qmd"), { recursive: true });
      await mkdir(join(stateRoot, "books", bookId, "source"), { recursive: true });
      await writeFile(
        join(stateRoot, "books", bookId, "input", "book.md"),
        inputText,
        "utf8",
      );
      await writeFile(
        join(stateRoot, "books", bookId, "source", "source.epub"),
        sourceText,
        "utf8",
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "qmd", "qmd_build_manifest.json"),
        {
          schemaVersion: "1.0.0",
          kind: "qmd_build_manifest",
          itemId: "item-missing-metadata-row",
          runId: "run-missing-metadata-row",
          bookId,
          sourceName: "Book.epub",
          sourceRelativePath: `books/${bookId}/source/source.epub`,
          sourceHash,
          canonicalBookNormalizedPath: `books/${bookId}/input/book.md`,
          normalizedContentHash: normalizedHash,
          configHash: "config-hash",
          normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
        },
      );
      await writeDurableJsonFixture(
        join(
          stateRoot,
          "books",
          bookId,
          "graphrag",
          "output",
          "qmd_graph_text_unit_identity.json",
        ),
        {
          schemaVersion: "1.0.0",
          bookId,
          sourceId: `sha256:${sourceHash}`,
          sourceHash,
          documentId: `doc-${sourceHash.slice(0, 12)}`,
          contentHash: normalizedHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          graphDocumentId: `graph-doc-${bookId}`,
          graphTextUnitIds: [`tu-${bookId}`],
        },
      );
      await writePackageQmdIndex({ stateRoot, bookId, normalizedContentHash: normalizedHash });
      const { manifest, publishReady } = buildBookHotplugPackage({
        stateRoot,
        bookId,
        sourceHash,
        sourceRelativePath: `books/${bookId}/source/source.epub`,
        now: () => "2026-06-02T00:00:00.000Z",
        toolVersion: "test",
      });
      const metadataPath = join(
        stateRoot,
        "books",
        bookId,
        "graphrag",
        "output",
        "artifact-metadata.json",
      );
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      metadata.rows = metadata.rows.filter((row: { path?: string }) =>
        row.path !== "graphrag/output/documents.parquet"
      );
      metadata.closureDigest = sha256Text(`${JSON.stringify(
        metadata.rows,
        null,
        2,
      )}\n`);
      await writeDurableJsonFixture(metadataPath, metadata);

      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "BOOK_MANIFEST.json"),
        manifest,
      );
      await writeDurableJsonFixture(
        join(stateRoot, "books", bookId, "PUBLISH_READY.json"),
        publishReady,
      );

      const validation = validateBookHotplugPackage({
        bookRoot: join(stateRoot, "books", bookId),
      });
      const capabilities = await loadGraphQueryCapabilities({
        graphVault: stateRoot,
        bookIds: [bookId],
      });

      expect(validation.ok).toBe(false);
      expect(validation.diagnostics).toContain(
        "artifact_metadata_missing_row:graphrag/output/documents.parquet",
      );
      expect(capabilities).toHaveLength(0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
