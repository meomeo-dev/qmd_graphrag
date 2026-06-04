import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  writeProviderAuthReopenGraphFixture,
} from "./helpers/graphrag-runner-harness.js";

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readJson<T>(path: string): Promise<T> {
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
  const entry = input.manifest.files.find((candidate) =>
    candidate.path === input.relativePath
  );
  if (entry == null) {
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
  entry.bytes = stats.size;
  entry.sha256 = sha256Buffer(bytes);
}

function rebuildManifestAndPublishReady(input: {
  manifest: Record<string, unknown> & {
    checksums: Record<string, unknown>;
    files: Array<{ bytes?: number }>;
  };
  publishReady: Record<string, unknown>;
}) {
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

async function writeQueryReadyPackage(input: {
  stateRoot: string;
  bookId: string;
}): Promise<string> {
  const sourceText = "epub";
  const inputText = "# Book\n\nRuntime hardening.\n";
  const sourceHash = sha256Text(sourceText);
  const normalizedHash = sha256Text(inputText);
  const bookRoot = join(input.stateRoot, "books", input.bookId);

  await writeProviderAuthReopenGraphFixture({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    contentHash: normalizedHash,
  });
  await mkdir(join(bookRoot, "input"), { recursive: true });
  await mkdir(join(bookRoot, "qmd"), { recursive: true });
  await mkdir(join(input.stateRoot, "books", input.bookId, "source"), {
    recursive: true,
  });
  await writeFile(join(bookRoot, "input", "book.md"), inputText, "utf8");
  await writeFile(
    join(input.stateRoot, "books", input.bookId, "source", "source.epub"),
    sourceText,
    "utf8",
  );
  await writeDurableJsonFixture(join(bookRoot, "qmd", "qmd_build_manifest.json"), {
    schemaVersion: "1.0.0",
    kind: "qmd_build_manifest",
    bookId: input.bookId,
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
    },
  );

  const { manifest, publishReady } = buildBookHotplugPackage({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    sourceRelativePath: `books/${input.bookId}/source/source.epub`,
    now: () => "2026-06-02T00:00:00.000Z",
    toolVersion: "test",
  });
  await writeDurableJsonFixture(join(bookRoot, "BOOK_MANIFEST.json"), manifest);
  await writeDurableJsonFixture(join(bookRoot, "PUBLISH_READY.json"), publishReady);
  return bookRoot;
}

async function refreshPackageBoundary(input: {
  bookRoot: string;
  touchedRelativePaths: string[];
}): Promise<void> {
  const manifestPath = join(input.bookRoot, "BOOK_MANIFEST.json");
  const publishReadyPath = join(input.bookRoot, "PUBLISH_READY.json");
  const manifest = await readJson<{
    checksums: Record<string, unknown>;
    files: Array<{ path?: string; bytes?: number }>;
  } & Record<string, unknown>>(manifestPath);
  for (const relativePath of input.touchedRelativePaths) {
    if (!existsSync(join(input.bookRoot, relativePath))) continue;
    await refreshManifestFileEntry({
      bookRoot: input.bookRoot,
      manifest,
      relativePath,
    });
  }
  const publishReady =
    await readJson<Record<string, unknown>>(publishReadyPath);
  const rebuilt = rebuildManifestAndPublishReady({ manifest, publishReady });
  await writeDurableJsonFixture(manifestPath, rebuilt.manifest);
  await writeDurableJsonFixture(publishReadyPath, rebuilt.publishReady);
}

async function expectPackageRejected(input: {
  stateRoot: string;
  bookRoot: string;
  bookId: string;
  diagnostic: string;
}): Promise<void> {
  const runtimeGate = await validateHotplugRuntimeQueryGate({
    graphVault: input.stateRoot,
    bookId: input.bookId,
  });
  const packageValidation = validateBookHotplugPackage({
    bookRoot: input.bookRoot,
  });
  const capabilities = await loadGraphQueryCapabilities({
    graphVault: input.stateRoot,
    bookIds: [input.bookId],
  });

  expect(runtimeGate.ok).toBe(false);
  expect(runtimeGate.diagnostics).toContain(input.diagnostic);
  expect(packageValidation.ok).toBe(false);
  expect(packageValidation.diagnostics).toContain(input.diagnostic);
  expect(capabilities).toHaveLength(0);
}

describe("GraphRAG hotplug runtime hardening", () => {
  test("fails closed when artifact metadata stage fingerprint is missing",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-stage-fp-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-stage-fingerprint-missing";
        const bookRoot = await writeQueryReadyPackage({ stateRoot, bookId });
        const metadataPath = join(
          bookRoot,
          "graphrag",
          "output",
          "artifact-metadata.json",
        );
        const metadata = await readJson<{
          rows: Array<{ path?: string; stageFingerprint?: string }>;
          closureDigest: string;
        }>(metadataPath);
        for (const row of metadata.rows) {
          if (row.path === "graphrag/output/documents.parquet") {
            delete row.stageFingerprint;
          }
        }
        metadata.closureDigest = sha256Text(
          `${JSON.stringify(metadata.rows, null, 2)}\n`,
        );
        await writeDurableJsonFixture(metadataPath, metadata);
        await refreshPackageBoundary({
          bookRoot,
          touchedRelativePaths: [
            "graphrag/output/artifact-metadata.json",
            "graphrag/output/artifact-metadata.json.sha256",
            "graphrag/output/artifact-metadata.json.sha256.meta.json",
          ],
        });

        await expectPackageRejected({
          stateRoot,
          bookRoot,
          bookId,
          diagnostic:
            "artifact_metadata_missing_stage_fingerprint:graphrag/output/documents.parquet",
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("fails closed when artifact metadata provider fingerprint is missing",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-provider-fp-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-provider-fingerprint-missing";
        const bookRoot = await writeQueryReadyPackage({ stateRoot, bookId });
        const metadataPath = join(
          bookRoot,
          "graphrag",
          "output",
          "artifact-metadata.json",
        );
        const metadata = await readJson<{
          rows: Array<{ path?: string; providerFingerprint?: string }>;
          closureDigest: string;
        }>(metadataPath);
        for (const row of metadata.rows) {
          if (row.path === "graphrag/output/documents.parquet") {
            delete row.providerFingerprint;
          }
        }
        metadata.closureDigest = sha256Text(
          `${JSON.stringify(metadata.rows, null, 2)}\n`,
        );
        await writeDurableJsonFixture(metadataPath, metadata);
        await refreshPackageBoundary({
          bookRoot,
          touchedRelativePaths: [
            "graphrag/output/artifact-metadata.json",
            "graphrag/output/artifact-metadata.json.sha256",
            "graphrag/output/artifact-metadata.json.sha256.meta.json",
          ],
        });

        await expectPackageRejected({
          stateRoot,
          bookRoot,
          bookId,
          diagnostic:
            "artifact_metadata_missing_provider_fingerprint:graphrag/output/documents.parquet",
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

  test("fails closed when runtime compatibility identity fields are forged",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-hotplug-runtime-fields-");
      try {
        const stateRoot = join(tmpRoot, "graph_vault");
        const bookId = "book-runtime-fields-forged";
        const bookRoot = await writeQueryReadyPackage({ stateRoot, bookId });
        const compatibilityPath = join(
          bookRoot,
          "graphrag",
          "output",
          "runtime-compatibility.json",
        );
        const compatibility = await readJson<{
          package: { layoutVersion: string };
          runtime: { embeddingVectorDimension: number | null };
        } & Record<string, unknown>>(compatibilityPath);
        compatibility.package.layoutVersion = "forged-layout";
        compatibility.runtime.embeddingVectorDimension = 999;
        await writeDurableJsonFixture(compatibilityPath, compatibility);
        await refreshPackageBoundary({
          bookRoot,
          touchedRelativePaths: [
            "graphrag/output/runtime-compatibility.json",
            "graphrag/output/runtime-compatibility.json.sha256",
            "graphrag/output/runtime-compatibility.json.sha256.meta.json",
          ],
        });

        await expectPackageRejected({
          stateRoot,
          bookRoot,
          bookId,
          diagnostic: "runtime_compatibility_layout_mismatch",
        });
        const runtimeGate = await validateHotplugRuntimeQueryGate({
          graphVault: stateRoot,
          bookId,
        });
        expect(runtimeGate.diagnostics).toContain(
          "runtime_compatibility_embedding_dimension_mismatch",
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });
});
