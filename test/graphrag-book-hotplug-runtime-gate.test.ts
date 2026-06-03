import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildBookHotplugPackage,
  validateBookHotplugPackage,
} from "../scripts/graphrag/book-hotplug-package.mjs";
import {
  validateHotplugRuntimeQueryGate,
} from "../src/graphrag/book-hotplug-runtime-gate.js";
import { loadGraphQueryCapabilities } from "../src/index.js";
import {
  mkProjectTmpDir,
  writeDurableJsonFixture,
  writeDurableYamlFixture,
  writeProviderAuthReopenGraphFixture,
} from "./helpers/graphrag-runner-harness.js";

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readJsonFixture<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function refreshManifestFileEntry(input: {
  bookRoot: string;
  manifest: { files: Array<Record<string, unknown>> };
  relativePath: string;
}): Promise<void> {
  const absolutePath = join(input.bookRoot, input.relativePath);
  const stats = await stat(absolutePath);
  const bytes = await readFile(absolutePath);
  const current = input.manifest.files.find((entry) =>
    entry.path === input.relativePath
  );
  if (current == null) {
    input.manifest.files.push({
      path: input.relativePath,
      role: "graphrag_output",
      bytes: stats.size,
      sha256: sha256Buffer(bytes),
      required: true,
      sensitivity: "public",
    });
    return;
  }
  current.bytes = stats.size;
  current.sha256 = sha256Buffer(bytes);
}

function rebuildManifestAndPublishReady(input: {
  manifest: Record<string, unknown> & {
    checksums: Record<string, unknown>;
    files: Array<{ bytes?: number }>;
  };
  publishReady: Record<string, unknown>;
}): {
  manifest: typeof input.manifest;
  publishReady: typeof input.publishReady;
} {
  const canonicalManifest = {
    ...input.manifest,
    checksums: {
      ...input.manifest.checksums,
      manifestSha256: "",
      manifestContentSha256: "",
      publishMarkerSha256: "",
    },
  };
  const manifestSha256 = sha256Text(
    `${JSON.stringify(canonicalManifest, null, 2)}\n`,
  );
  const publishReady = {
    ...input.publishReady,
    manifestSha256,
    fileCount: input.manifest.files.length,
    byteCount: input.manifest.files.reduce(
      (total, file) => total + (Number.isFinite(file.bytes) ? file.bytes! : 0),
      0,
    ),
  };
  const publishMarkerSha256 = sha256Text(
    `${JSON.stringify(publishReady, null, 2)}\n`,
  );
  return {
    manifest: {
      ...input.manifest,
      checksums: {
        ...input.manifest.checksums,
        manifestSha256,
        manifestContentSha256: manifestSha256,
        publishMarkerSha256,
      },
    },
    publishReady,
  };
}

async function writeQueryReadyHotplugPackageFixture(input: {
  stateRoot: string;
  bookId: string;
}): Promise<void> {
  const sourceText = "epub";
  const inputText = "# Book\n\nRuntime compatibility gate.\n";
  const sourceHash = sha256Text(sourceText);
  const normalizedHash = sha256Text(inputText);

  await writeProviderAuthReopenGraphFixture({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    contentHash: normalizedHash,
  });
  await mkdir(join(input.stateRoot, "books", input.bookId, "input"), {
    recursive: true,
  });
  await mkdir(join(input.stateRoot, "books", input.bookId, "qmd"), {
    recursive: true,
  });
  await mkdir(join(input.stateRoot, "sources", input.bookId), {
    recursive: true,
  });
  await writeFile(
    join(input.stateRoot, "books", input.bookId, "input", "book.md"),
    inputText,
    "utf8",
  );
  await writeFile(
    join(input.stateRoot, "sources", input.bookId, "source.epub"),
    sourceText,
    "utf8",
  );
  await writeDurableJsonFixture(
    join(
      input.stateRoot,
      "books",
      input.bookId,
      "qmd",
      "qmd_build_manifest.json",
    ),
    {
      schemaVersion: "1.0.0",
      kind: "qmd_build_manifest",
      itemId: "item-runtime-gate",
      runId: "run-runtime-gate",
      bookId: input.bookId,
      sourceName: "Book.epub",
      sourceRelativePath: `sources/${input.bookId}/source.epub`,
      sourceHash,
      canonicalBookNormalizedPath: `books/${input.bookId}/input/book.md`,
      normalizedContentHash: normalizedHash,
      configHash: "config-hash",
      normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
    },
  );
  await writeDurableJsonFixture(
    join(
      input.stateRoot,
      "books",
      input.bookId,
      "graphrag",
      "output",
      "qmd_graph_text_unit_identity.json",
    ),
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
    },
  );

  const { manifest, publishReady } = buildBookHotplugPackage({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    sourceRelativePath: `sources/${input.bookId}/source.epub`,
    now: () => "2026-06-02T00:00:00.000Z",
    toolVersion: "test",
  });
  await writeDurableJsonFixture(
    join(input.stateRoot, "books", input.bookId, "BOOK_MANIFEST.json"),
    manifest,
  );
  await writeDurableJsonFixture(
    join(input.stateRoot, "books", input.bookId, "PUBLISH_READY.json"),
    publishReady,
  );
}

function listLockFiles(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...listLockFiles(root, path));
    } else if (entry.isFile() && entry.name.endsWith(".lock")) {
      result.push(path.slice(root.length + 1));
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

describe("GraphRAG hotplug runtime query gate", () => {
  test("fails closed when manifest content changes without matching sidecars",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-runtime-sidecar-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-runtime-sidecar-mismatch";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeQueryReadyHotplugPackageFixture({ stateRoot, bookId });

        const manifestPath = join(bookRoot, "BOOK_MANIFEST.json");
        const manifest = await readJsonFixture<
          Record<string, unknown> & {
            metadata?: Record<string, unknown>;
          }
        >(manifestPath);
        manifest.metadata = {
          ...(manifest.metadata ?? {}),
          injectedAfterPublish: true,
        };
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

        const runtimeGate = await validateHotplugRuntimeQueryGate({
          graphVault: stateRoot,
          bookId,
        });
        const capabilities = await loadGraphQueryCapabilities({
          graphVault: stateRoot,
          bookIds: [bookId],
        });

        expect(runtimeGate.ok).toBe(false);
        expect(runtimeGate.diagnostics).toContain("manifest_sha256_mismatch");
        expect(capabilities).toHaveLength(0);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("fails closed when publish marker points to a different manifest",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-publish-mismatch-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-publish-marker-mismatch";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeQueryReadyHotplugPackageFixture({ stateRoot, bookId });

        const publishPath = join(bookRoot, "PUBLISH_READY.json");
        const publishReady =
          await readJsonFixture<Record<string, unknown>>(publishPath);
        await writeDurableJsonFixture(publishPath, {
          ...publishReady,
          manifestSha256: "forged-manifest-sha",
        });

        const runtimeGate = await validateHotplugRuntimeQueryGate({
          graphVault: stateRoot,
          bookId,
        });
        const capabilities = await loadGraphQueryCapabilities({
          graphVault: stateRoot,
          bookIds: [bookId],
        });

        expect(runtimeGate.ok).toBe(false);
        expect(runtimeGate.diagnostics).toContain("publish_marker_mismatch");
        expect(capabilities).toHaveLength(0);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("rejects synthetic test-hook graph identity as query-ready evidence",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-synthetic-identity-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-synthetic-identity";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeQueryReadyHotplugPackageFixture({ stateRoot, bookId });

        const identityPath = join(
          bookRoot,
          "graphrag",
          "output",
          "qmd_graph_text_unit_identity.json",
        );
        const identity =
          await readJsonFixture<Record<string, unknown>>(identityPath);
        await writeDurableJsonFixture(identityPath, {
          ...identity,
          graphDocumentId: `graph-doc-${identity.documentId}`,
          metadata: {
            identityProvenance: "test_hook_synthetic",
            publishAllowed: false,
          },
        });

        const manifestPath = join(bookRoot, "BOOK_MANIFEST.json");
        const publishReadyPath = join(bookRoot, "PUBLISH_READY.json");
        const manifest = await readJsonFixture<{
          checksums: Record<string, unknown>;
          files: Array<{ path?: string; bytes?: number }>;
        } & Record<string, unknown>>(manifestPath);
        for (const relativePath of [
          "graphrag/output/qmd_graph_text_unit_identity.json",
          "graphrag/output/qmd_graph_text_unit_identity.json.sha256",
          "graphrag/output/qmd_graph_text_unit_identity.json.sha256.meta.json",
        ]) {
          await refreshManifestFileEntry({
            bookRoot,
            manifest,
            relativePath,
          });
        }
        const publishReady =
          await readJsonFixture<Record<string, unknown>>(publishReadyPath);
        const rebuilt = rebuildManifestAndPublishReady({
          manifest,
          publishReady,
        });
        await writeDurableJsonFixture(manifestPath, rebuilt.manifest);
        await writeDurableJsonFixture(publishReadyPath, rebuilt.publishReady);

        const runtimeGate = await validateHotplugRuntimeQueryGate({
          graphVault: stateRoot,
          bookId,
        });
        const packageValidation = validateBookHotplugPackage({ bookRoot });
        const capabilities = await loadGraphQueryCapabilities({
          graphVault: stateRoot,
          bookIds: [bookId],
        });

        expect(runtimeGate.ok).toBe(false);
        expect(runtimeGate.diagnostics).toContain(
          "graph_identity_test_hook_synthetic_not_publishable",
        );
        expect(packageValidation.ok).toBe(false);
        expect(packageValidation.diagnostics).toContain(
          "graph_identity_test_hook_synthetic_not_publishable",
        );
        expect(capabilities).toHaveLength(0);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("validates query-ready package without writing runtime locks into package",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-runtime-readonly-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-runtime-readonly";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeQueryReadyHotplugPackageFixture({ stateRoot, bookId });

        const runtimeGate = await validateHotplugRuntimeQueryGate({
          graphVault: stateRoot,
          bookId,
        });
        const capabilities = await loadGraphQueryCapabilities({
          graphVault: stateRoot,
          bookIds: [bookId],
        });

        expect(runtimeGate.ok).toBe(true);
        expect(capabilities).toHaveLength(1);
        expect(listLockFiles(bookRoot)).toEqual([]);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("derives query capability from package when global catalog is absent",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-manifest-first-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-manifest-first-query";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeQueryReadyHotplugPackageFixture({ stateRoot, bookId });
        await rm(join(stateRoot, "catalog"), { recursive: true, force: true });

        const capabilities = await loadGraphQueryCapabilities({
          graphVault: stateRoot,
          bookIds: [bookId],
        });

        expect(capabilities).toHaveLength(1);
        expect(capabilities[0]).toMatchObject({
          bookId,
          sourceId: expect.stringMatching(/^sha256:/u),
          documentId: expect.stringMatching(/^doc-/u),
          readinessSource: "validated_checkpoint_plus_validated_manifest",
        });
        expect(capabilities[0]?.metadata?.projectionSource)
          .toBe("book_hotplug_manifest");
        expect(listLockFiles(bookRoot)).toEqual([]);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("fails closed when runtime compatibility semantic digest is forged",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-runtime-gate-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-runtime-digest-forged";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeQueryReadyHotplugPackageFixture({ stateRoot, bookId });

        const runtimeCompatibilityPath = join(
          bookRoot,
          "graphrag",
          "output",
          "runtime-compatibility.json",
        );
        const compatibility = await readJsonFixture<{
          schemaDigests: { parquetSchemaDigest: string };
        }>(runtimeCompatibilityPath);
        compatibility.schemaDigests.parquetSchemaDigest = "forged";
        await writeDurableJsonFixture(runtimeCompatibilityPath, compatibility);

        const manifestPath = join(bookRoot, "BOOK_MANIFEST.json");
        const publishReadyPath = join(bookRoot, "PUBLISH_READY.json");
        const manifest = await readJsonFixture<{
          checksums: Record<string, unknown>;
          files: Array<{ path?: string; bytes?: number }>;
        } & Record<string, unknown>>(manifestPath);
        for (const relativePath of [
          "graphrag/output/runtime-compatibility.json",
          "graphrag/output/runtime-compatibility.json.sha256",
          "graphrag/output/runtime-compatibility.json.sha256.meta.json",
        ]) {
          await refreshManifestFileEntry({
            bookRoot,
            manifest,
            relativePath,
          });
        }
        const publishReady =
          await readJsonFixture<Record<string, unknown>>(publishReadyPath);
        const rebuilt = rebuildManifestAndPublishReady({
          manifest,
          publishReady,
        });
        await writeDurableJsonFixture(manifestPath, rebuilt.manifest);
        await writeDurableJsonFixture(publishReadyPath, rebuilt.publishReady);

        for (const path of [
          join(stateRoot, "catalog", "graph-capabilities.yaml"),
          join(stateRoot, "catalog", "graph-capabilities.yaml.sha256"),
          join(stateRoot, "catalog", "graph-capabilities.yaml.sha256.meta.json"),
        ]) {
          if (existsSync(path)) await unlink(path);
        }

        const runtimeGate = await validateHotplugRuntimeQueryGate({
          graphVault: stateRoot,
          bookId,
        });
        const packageValidation = validateBookHotplugPackage({ bookRoot });
        const capabilities = await loadGraphQueryCapabilities({
          graphVault: stateRoot,
          bookIds: [bookId],
        });

        expect(runtimeGate.ok).toBe(false);
        expect(runtimeGate.diagnostics).toContain(
          "runtime_compatibility_digest_mismatch:parquetSchemaDigest",
        );
        expect(packageValidation.ok).toBe(false);
        expect(packageValidation.diagnostics).toContain(
          "runtime_compatibility_digest_mismatch:parquetSchemaDigest",
        );
        expect(capabilities).toHaveLength(0);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("fails closed when artifact metadata row creation time is missing",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-metadata-created-at-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-metadata-created-at-missing";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeQueryReadyHotplugPackageFixture({ stateRoot, bookId });

        const metadataPath = join(
          bookRoot,
          "graphrag",
          "output",
          "artifact-metadata.json",
        );
        const metadata = await readJsonFixture<{
          rows: Array<{ path?: string; createdAt?: string }>;
          closureDigest: string;
        }>(metadataPath);
        for (const row of metadata.rows) {
          if (row.path === "graphrag/output/documents.parquet") {
            delete row.createdAt;
          }
        }
        metadata.closureDigest = sha256Text(
          `${JSON.stringify(metadata.rows, null, 2)}\n`,
        );
        await writeDurableJsonFixture(metadataPath, metadata);

        const manifestPath = join(bookRoot, "BOOK_MANIFEST.json");
        const publishReadyPath = join(bookRoot, "PUBLISH_READY.json");
        const manifest = await readJsonFixture<{
          checksums: Record<string, unknown>;
          files: Array<{ path?: string; bytes?: number }>;
        } & Record<string, unknown>>(manifestPath);
        for (const relativePath of [
          "graphrag/output/artifact-metadata.json",
          "graphrag/output/artifact-metadata.json.sha256",
          "graphrag/output/artifact-metadata.json.sha256.meta.json",
        ]) {
          await refreshManifestFileEntry({
            bookRoot,
            manifest,
            relativePath,
          });
        }
        const publishReady =
          await readJsonFixture<Record<string, unknown>>(publishReadyPath);
        const rebuilt = rebuildManifestAndPublishReady({
          manifest,
          publishReady,
        });
        await writeDurableJsonFixture(manifestPath, rebuilt.manifest);
        await writeDurableJsonFixture(publishReadyPath, rebuilt.publishReady);

        const runtimeGate = await validateHotplugRuntimeQueryGate({
          graphVault: stateRoot,
          bookId,
        });
        const packageValidation = validateBookHotplugPackage({ bookRoot });
        const capabilities = await loadGraphQueryCapabilities({
          graphVault: stateRoot,
          bookIds: [bookId],
        });

        expect(runtimeGate.ok).toBe(false);
        expect(runtimeGate.diagnostics).toContain(
          "artifact_metadata_missing_created_at:graphrag/output/documents.parquet",
        );
        expect(packageValidation.ok).toBe(false);
        expect(packageValidation.diagnostics).toContain(
          "artifact_metadata_missing_created_at:graphrag/output/documents.parquet",
        );
        expect(capabilities).toHaveLength(0);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("fails closed when producer run artifact binding is forged",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-run-binding-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-run-binding-forged";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeQueryReadyHotplugPackageFixture({ stateRoot, bookId });

        const runPath = join(
          bookRoot,
          "graphrag",
          "runs",
          "run-graph-extract.yaml",
        );
        const runRecord = {
          schemaVersion: "1.0.0",
          runId: "run-graph-extract",
          bookId,
          stage: "graph_extract",
          status: "succeeded",
          attemptCount: 1,
          startedAt: "2026-05-23T00:00:00.000Z",
          finishedAt: "2026-05-23T00:00:01.000Z",
          inputFingerprint: "fp-graph-extract",
          artifactIds: ["forged-artifact-id"],
          metadata: {
            stageFingerprint: "fp-graph-extract",
            providerFingerprint: "provider-fp",
          },
        };
        await writeDurableYamlFixture(runPath, runRecord);

        const manifestPath = join(bookRoot, "BOOK_MANIFEST.json");
        const publishReadyPath = join(bookRoot, "PUBLISH_READY.json");
        const manifest = await readJsonFixture<{
          checksums: Record<string, unknown>;
          files: Array<{ path?: string; bytes?: number }>;
        } & Record<string, unknown>>(manifestPath);
        await refreshManifestFileEntry({
          bookRoot,
          manifest,
          relativePath: "graphrag/runs/run-graph-extract.yaml",
        });
        const publishReady =
          await readJsonFixture<Record<string, unknown>>(publishReadyPath);
        const rebuilt = rebuildManifestAndPublishReady({
          manifest,
          publishReady,
        });
        await writeDurableJsonFixture(manifestPath, rebuilt.manifest);
        await writeDurableJsonFixture(publishReadyPath, rebuilt.publishReady);

        const runtimeGate = await validateHotplugRuntimeQueryGate({
          graphVault: stateRoot,
          bookId,
        });
        const packageValidation = validateBookHotplugPackage({ bookRoot });
        const capabilities = await loadGraphQueryCapabilities({
          graphVault: stateRoot,
          bookIds: [bookId],
        });

        expect(runtimeGate.ok).toBe(false);
        expect(runtimeGate.diagnostics).toContain(
          "producer_run_artifact_binding_mismatch:run-graph-extract",
        );
        expect(packageValidation.ok).toBe(false);
        expect(packageValidation.diagnostics).toContain(
          "producer_run_artifact_binding_mismatch:run-graph-extract",
        );
        expect(capabilities).toHaveLength(0);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("fails closed when producer run provider fingerprint is forged",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-run-provider-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-run-provider-forged";
        const bookRoot = join(stateRoot, "books", bookId);
        await writeQueryReadyHotplugPackageFixture({ stateRoot, bookId });

        const runPath = join(
          bookRoot,
          "graphrag",
          "runs",
          "run-graph-extract.yaml",
        );
        const runRecord = {
          schemaVersion: "1.0.0",
          runId: "run-graph-extract",
          bookId,
          stage: "graph_extract",
          status: "succeeded",
          attemptCount: 1,
          startedAt: "2026-05-23T00:00:00.000Z",
          finishedAt: "2026-05-23T00:00:01.000Z",
          inputFingerprint: "fp-graph-extract",
          artifactIds: [
            `${bookId}:graph_extract:documents`,
            `${bookId}:graph_extract:text_units`,
            `${bookId}:graph_extract:entities`,
            `${bookId}:graph_extract:relationships`,
            `${bookId}:graph_extract:communities`,
            `${bookId}:graph_extract:context`,
            `${bookId}:graph_extract:stats`,
          ],
          metadata: {
            stageFingerprint: "fp-graph-extract",
            providerFingerprint: "forged-provider-fp",
          },
        };
        await writeDurableYamlFixture(runPath, runRecord);

        const manifestPath = join(bookRoot, "BOOK_MANIFEST.json");
        const publishReadyPath = join(bookRoot, "PUBLISH_READY.json");
        const manifest = await readJsonFixture<{
          checksums: Record<string, unknown>;
          files: Array<{ path?: string; bytes?: number }>;
        } & Record<string, unknown>>(manifestPath);
        await refreshManifestFileEntry({
          bookRoot,
          manifest,
          relativePath: "graphrag/runs/run-graph-extract.yaml",
        });
        const publishReady =
          await readJsonFixture<Record<string, unknown>>(publishReadyPath);
        const rebuilt = rebuildManifestAndPublishReady({
          manifest,
          publishReady,
        });
        await writeDurableJsonFixture(manifestPath, rebuilt.manifest);
        await writeDurableJsonFixture(publishReadyPath, rebuilt.publishReady);

        const runtimeGate = await validateHotplugRuntimeQueryGate({
          graphVault: stateRoot,
          bookId,
        });
        const packageValidation = validateBookHotplugPackage({ bookRoot });
        const capabilities = await loadGraphQueryCapabilities({
          graphVault: stateRoot,
          bookIds: [bookId],
        });

        expect(runtimeGate.ok).toBe(false);
        expect(runtimeGate.diagnostics).toContain(
          "producer_run_provider_fingerprint_mismatch:run-graph-extract",
        );
        expect(packageValidation.ok).toBe(false);
        expect(packageValidation.diagnostics).toContain(
          "producer_run_provider_fingerprint_mismatch:run-graph-extract",
        );
        expect(capabilities).toHaveLength(0);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });
});
