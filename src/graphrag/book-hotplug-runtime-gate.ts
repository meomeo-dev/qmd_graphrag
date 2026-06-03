import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { z } from "zod";

import { readHotplugPackageUnknown } from "./book-hotplug-package-readonly.js";
import { validateHotplugProducerRunBindings } from "./book-hotplug-producer-run-bindings.js";
import {
  buildRuntimeCompatibilitySchemaDigests,
  runtimeCompatibilityDigestDiagnostics,
} from "./book-hotplug-runtime-compatibility-digests.js";
import {
  resolveBookManifestPath,
  resolveBookPublishReadyPath,
  resolveBookRoot,
} from "./book-package-layout.js";
import {
  validateBookHotplugPackageBoundary,
} from "./book-hotplug-package-validator.js";

const RuntimeBookManifestSchema = z.object({
  schemaVersion: z.string().min(1),
  kind: z.literal("qmd_graphrag_book_package"),
  layoutVersion: z.string().min(1).optional(),
  identity: z.object({
    bookId: z.string().min(1),
    packageGeneration: z.string().min(1),
  }).passthrough(),
  qmd: z.object({
    qmdIndexSchema: z.string().min(1).optional(),
  }).passthrough().optional(),
  graphrag: z.object({
    queryReady: z.boolean(),
    outputManifestPath: z.string().min(1),
    requiredArtifacts: z.array(z.string().min(1)),
    producerRunIds: z.array(z.string().min(1)),
    graphRagArtifactSchema: z.string().min(1).optional(),
    artifactSchema: z.string().min(1).optional(),
  }).passthrough(),
  compatibility: z.object({
    minQmdGraphRagVersion: z.string().min(1).optional(),
  }).passthrough().optional(),
  files: z.array(z.object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
    required: z.boolean().optional(),
  }).passthrough()),
}).passthrough();

const RuntimeCompatibilitySchema = z.object({
  kind: z.literal("qmd_graphrag_runtime_compatibility"),
  bookId: z.string().min(1),
  packageGeneration: z.string().min(1),
  compatibilityStatus: z.literal("compatible"),
  package: z.object({
    packageSchemaVersion: z.string().min(1).optional(),
    layoutVersion: z.string().min(1).optional(),
    qmdIndexSchema: z.string().min(1).optional(),
    graphRagArtifactSchema: z.string().min(1).optional(),
    artifactSchema: z.string().min(1).optional(),
  }).passthrough(),
  runtime: z.object({
    minQmdGraphRagVersion: z.string().min(1).optional(),
    providerFingerprint: z.string().min(1).optional(),
    embeddingVectorDimension: z.number().int().positive().nullable().optional(),
  }).passthrough(),
  schemaDigests: z.object({
    outputManifestSchemaDigest: z.string().min(1),
    parquetSchemaDigest: z.string().min(1),
    lancedbSchemaDigest: z.string().min(1),
    artifactMetadataSchemaDigest: z.string().min(1),
  }).passthrough(),
}).passthrough();

const ArtifactMetadataSchema = z.object({
  kind: z.literal("qmd_graphrag_artifact_metadata"),
  bookId: z.string().min(1),
  packageGeneration: z.string().min(1),
  closureDigest: z.string().min(1),
  rows: z.array(z.object({
    path: z.string().min(1),
    fileSha256: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    producerRunId: z.string().min(1),
    producerStep: z.string().min(1),
    producerToolVersion: z.string().min(1),
    producerSchemaVersion: z.string().min(1),
    artifactId: z.string().min(1).optional(),
    stage: z.string().min(1).optional(),
    stageFingerprint: z.string().min(1).optional(),
    providerFingerprint: z.string().min(1).optional(),
    upstreamArtifactHashes: z.array(z.string().min(1)).min(1),
    createdAt: z.string().min(1).optional(),
  }).passthrough()),
}).passthrough();

const RuntimeGraphOutputManifestSchema = z.object({
  bookId: z.string().min(1),
  stageFingerprints: z.record(z.string(), z.string().min(1)).optional(),
  providerFingerprint: z.string().min(1).optional(),
  embeddingVectorDimension: z.number().int().positive().nullable().optional(),
  embeddingDimension: z.number().int().positive().nullable().optional(),
}).passthrough();

const ForbiddenPackagePathPatterns = [
  /^\.env$/u,
  /(?:^|\/)\.env$/u,
  /(?:^|\/)provider-requests(?:\/|$)/u,
  /(?:^|\/)provider-responses(?:\/|$)/u,
  /(?:^|\/)logs(?:\/|$)/u,
  /(?:^|\/)debug(?:\/|$)/u,
  /(?:^|\/)trace(?:\/|$)/u,
  /(?:^|\/)\.durable-recovery\.jsonl$/u,
  /\.lock$/u,
  /\.corrupt-[^/]+$/u,
  /(?:^|\/)\.DS_Store$/u,
];

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function graphManifestEmbeddingDimension(
  graphManifest: z.infer<typeof RuntimeGraphOutputManifestSchema> | null,
): number | null {
  return graphManifest?.embeddingVectorDimension ??
    graphManifest?.embeddingDimension ??
    null;
}

function listFilesRecursive(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const result: string[] = [];
  const entries = readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      result.push(...listFilesRecursive(root, path));
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result;
}

function sha256Directory(path: string): string {
  const hash = createHash("sha256");
  for (const file of listFilesRecursive(path)) {
    const relativePath = toPosixPath(file.slice(path.length + 1));
    hash.update(relativePath);
    hash.update("\0");
    hash.update(sha256Buffer(readFileSync(file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256Path(path: string): string {
  const stats = statSync(path);
  if (stats.isDirectory()) return sha256Directory(path);
  return sha256Buffer(readFileSync(path));
}

function normalizeRelativePath(path: string): string | null {
  const normalized = toPosixPath(path);
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized === ".." ||
    /^[A-Za-z]:\//u.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function listForbiddenPaths(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = toPosixPath(path.slice(root.length + 1));
    if (ForbiddenPackagePathPatterns.some((pattern) => pattern.test(relativePath))) {
      result.push(relativePath);
      if (entry.isDirectory()) continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      result.push(...listForbiddenPaths(root, path));
    }
  }
  return result;
}

function validateRequiredArtifactFiles(input: {
  bookRoot: string;
  manifest: z.infer<typeof RuntimeBookManifestSchema>;
  diagnostics: string[];
}): Map<string, z.infer<typeof RuntimeBookManifestSchema>["files"][number]> {
  const filesByPath = new Map(input.manifest.files.map((entry) => [
    entry.path,
    entry,
  ]));
  for (const artifact of input.manifest.graphrag.requiredArtifacts) {
    const artifactPath = normalizeRelativePath(artifact);
    if (artifactPath == null) {
      input.diagnostics.push(`required_artifact_path_invalid:${artifact}`);
      continue;
    }
    const entry = filesByPath.get(artifactPath);
    if (entry == null || entry.required === false) {
      input.diagnostics.push(`missing_manifest_file_entry:${artifactPath}`);
      continue;
    }
    const absolutePath = join(input.bookRoot, artifactPath);
    if (!existsSync(absolutePath)) {
      input.diagnostics.push(`missing_required_file:${artifactPath}`);
      continue;
    }
    const stats = statSync(absolutePath);
    if (stats.isFile() && entry.bytes !== stats.size) {
      input.diagnostics.push(`file_bytes_mismatch:${artifactPath}`);
    }
    const actualSha = sha256Path(absolutePath);
    if (entry.sha256 !== actualSha) {
      input.diagnostics.push(`file_sha256_mismatch:${artifactPath}`);
    }
  }
  return filesByPath;
}

async function validateArtifactMetadata(input: {
  bookRoot: string;
  manifest: z.infer<typeof RuntimeBookManifestSchema>;
  filesByPath: Map<string, z.infer<typeof RuntimeBookManifestSchema>["files"][number]>;
  diagnostics: string[];
}): Promise<void> {
  const metadataPath = join(
    input.bookRoot,
    "graphrag",
    "output",
    "artifact-metadata.json",
  );
  if (!existsSync(metadataPath)) {
    input.diagnostics.push("artifact_metadata_missing");
    return;
  }
  const parsed = await readHotplugPackageUnknown(metadataPath);
  const rawRows = parsed != null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { rows?: unknown }).rows)
    ? (parsed as { rows: unknown[] }).rows
    : null;
  const metadataResult = ArtifactMetadataSchema.safeParse(parsed);
  if (!metadataResult.success) {
    input.diagnostics.push("artifact_metadata_invalid");
    return;
  }
  const metadata = metadataResult.data;
  const graphManifestPath = join(
    input.bookRoot,
    "graphrag",
    "output",
    "qmd_output_manifest.json",
  );
  const graphManifestRaw = existsSync(graphManifestPath)
    ? await readHotplugPackageUnknown(graphManifestPath)
    : null;
  const graphManifestResult =
    RuntimeGraphOutputManifestSchema.safeParse(graphManifestRaw);
  const graphManifest = graphManifestResult.success
    ? graphManifestResult.data
    : null;
  if (metadata.bookId !== input.manifest.identity.bookId) {
    input.diagnostics.push("artifact_metadata_book_mismatch");
  }
  if (metadata.packageGeneration !== input.manifest.identity.packageGeneration) {
    input.diagnostics.push("artifact_metadata_generation_mismatch");
  }
  const expectedClosureDigest = rawRows == null
    ? null
    : sha256Text(`${JSON.stringify(rawRows, null, 2)}\n`);
  if (
    expectedClosureDigest == null ||
    metadata.closureDigest !== expectedClosureDigest
  ) {
    input.diagnostics.push("artifact_metadata_closure_digest_mismatch");
  }
  const producerRunIds = new Set(input.manifest.graphrag.producerRunIds);
  const rowsByPath = new Map(metadata.rows.map((row) => [row.path, row]));
  for (const artifact of input.manifest.graphrag.requiredArtifacts) {
    if (artifact === "graphrag/output/artifact-metadata.json") continue;
    const artifactPath = normalizeRelativePath(artifact);
    if (artifactPath == null) continue;
    const row = rowsByPath.get(artifactPath);
    if (row == null) {
      input.diagnostics.push(`artifact_metadata_missing_row:${artifactPath}`);
      continue;
    }
    if (!producerRunIds.has(row.producerRunId)) {
      input.diagnostics.push(`artifact_metadata_unknown_producer:${artifactPath}`);
    }
    if (typeof row.createdAt !== "string" || row.createdAt.length === 0) {
      input.diagnostics.push(`artifact_metadata_missing_created_at:${artifactPath}`);
    }
    if (
      typeof row.stageFingerprint !== "string" ||
      row.stageFingerprint.length === 0
    ) {
      input.diagnostics.push(
        `artifact_metadata_missing_stage_fingerprint:${artifactPath}`,
      );
    }
    if (
      typeof row.providerFingerprint !== "string" ||
      row.providerFingerprint.length === 0
    ) {
      input.diagnostics.push(
        `artifact_metadata_missing_provider_fingerprint:${artifactPath}`,
      );
    }
    const fileEntry = input.filesByPath.get(artifactPath);
    if (fileEntry != null && row.fileSha256 !== fileEntry.sha256) {
      input.diagnostics.push(`artifact_metadata_file_sha_mismatch:${artifactPath}`);
    }
    if (fileEntry != null && row.bytes !== fileEntry.bytes) {
      input.diagnostics.push(`artifact_metadata_bytes_mismatch:${artifactPath}`);
    }
  }
  input.diagnostics.push(...await validateHotplugProducerRunBindings({
    bookRoot: input.bookRoot,
    bookId: input.manifest.identity.bookId,
    producerRunIds: input.manifest.graphrag.producerRunIds,
    rows: metadata.rows,
    providerFingerprint: graphManifest?.providerFingerprint,
  }));
}

async function validateRuntimeCompatibility(input: {
  bookRoot: string;
  manifest: z.infer<typeof RuntimeBookManifestSchema>;
  diagnostics: string[];
}): Promise<void> {
  const runtimeCompatibilityPath = join(
    input.bookRoot,
    "graphrag",
    "output",
    "runtime-compatibility.json",
  );
  if (!input.manifest.graphrag.queryReady) return;
  if (!existsSync(runtimeCompatibilityPath)) {
    input.diagnostics.push("runtime_compatibility_missing");
    return;
  }

  const runtimeCompatibility = await readHotplugPackageUnknown(
    runtimeCompatibilityPath,
  );
  const compatibilityResult = RuntimeCompatibilitySchema.safeParse(
    runtimeCompatibility,
  );
  if (!compatibilityResult.success) {
    input.diagnostics.push("runtime_compatibility_invalid");
    return;
  }

  const compatibility = compatibilityResult.data;
  if (compatibility.bookId !== input.manifest.identity.bookId) {
    input.diagnostics.push("runtime_compatibility_book_mismatch");
  }
  if (
    compatibility.packageGeneration !==
      input.manifest.identity.packageGeneration
  ) {
    input.diagnostics.push("runtime_compatibility_generation_mismatch");
  }
  if (
    compatibility.package.packageSchemaVersion !== input.manifest.schemaVersion
  ) {
    input.diagnostics.push("runtime_compatibility_package_schema_mismatch");
  }
  if (compatibility.package.layoutVersion !== input.manifest.layoutVersion) {
    input.diagnostics.push("runtime_compatibility_layout_mismatch");
  }
  if (
    compatibility.package.qmdIndexSchema !==
      input.manifest.qmd?.qmdIndexSchema
  ) {
    input.diagnostics.push("runtime_compatibility_qmd_index_schema_mismatch");
  }
  if (
    compatibility.package.graphRagArtifactSchema !==
      input.manifest.graphrag.graphRagArtifactSchema
  ) {
    input.diagnostics.push(
      "runtime_compatibility_graphrag_artifact_schema_mismatch",
    );
  }
  if (
    compatibility.package.artifactSchema !== input.manifest.graphrag.artifactSchema
  ) {
    input.diagnostics.push("runtime_compatibility_artifact_schema_mismatch");
  }
  if (
    compatibility.runtime.minQmdGraphRagVersion !==
      input.manifest.compatibility?.minQmdGraphRagVersion
  ) {
    input.diagnostics.push("runtime_compatibility_min_runtime_mismatch");
  }

  const graphManifestPath = join(
    input.bookRoot,
    "graphrag",
    "output",
    "qmd_output_manifest.json",
  );
  const graphManifest = existsSync(graphManifestPath)
    ? await readHotplugPackageUnknown(graphManifestPath)
    : null;
  const graphManifestResult = RuntimeGraphOutputManifestSchema.safeParse(
    graphManifest,
  );
  const parsedGraphManifest = graphManifestResult.success
    ? graphManifestResult.data
    : null;
  if (
    compatibility.runtime.providerFingerprint !==
      parsedGraphManifest?.providerFingerprint
  ) {
    input.diagnostics.push(
      "runtime_compatibility_provider_fingerprint_mismatch",
    );
  }
  if (
    (compatibility.runtime.embeddingVectorDimension ?? null) !==
      graphManifestEmbeddingDimension(parsedGraphManifest)
  ) {
    input.diagnostics.push(
      "runtime_compatibility_embedding_dimension_mismatch",
    );
  }
  const expectedDigests = buildRuntimeCompatibilitySchemaDigests({
    graphManifest,
    files: input.manifest.files.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
  });
  input.diagnostics.push(...runtimeCompatibilityDigestDiagnostics({
    actual: compatibility.schemaDigests,
    expected: expectedDigests,
  }));
}

export async function validateHotplugRuntimeQueryGate(input: {
  graphVault: string;
  bookId: string;
}): Promise<{ ok: boolean; diagnostics: string[]; producerRunIds: string[] }> {
  const graphVault = resolve(input.graphVault);
  const bookRoot = resolveBookRoot(graphVault, input.bookId);
  const manifestPath = resolveBookManifestPath(graphVault, input.bookId);
  const publishReadyPath = resolveBookPublishReadyPath(graphVault, input.bookId);
  const diagnostics: string[] = [];

  if (!existsSync(manifestPath) && !existsSync(publishReadyPath)) {
    return { ok: true, diagnostics: [], producerRunIds: [] };
  }

  const packageBoundary = validateBookHotplugPackageBoundary({ bookRoot });
  diagnostics.push(...packageBoundary.diagnostics);
  if (packageBoundary.manifest == null) {
    return {
      ok: false,
      diagnostics: [...new Set(diagnostics)],
      producerRunIds: [],
    };
  }

  for (const path of listForbiddenPaths(bookRoot)) {
    diagnostics.push(`forbidden_sensitive_material:${path}`);
  }
  if (!existsSync(manifestPath)) diagnostics.push("missing_manifest");
  if (!existsSync(`${manifestPath}.sha256`)) diagnostics.push("missing_manifest_sidecar");
  if (!existsSync(`${manifestPath}.sha256.meta.json`)) {
    diagnostics.push("missing_manifest_meta_sidecar");
  }
  if (!existsSync(publishReadyPath)) diagnostics.push("missing_publish_marker");
  if (diagnostics.includes("missing_manifest")) {
    return { ok: false, diagnostics: [...new Set(diagnostics)], producerRunIds: [] };
  }

  const parsed = await readHotplugPackageUnknown(manifestPath);
  const manifestResult = RuntimeBookManifestSchema.safeParse(parsed);
  if (!manifestResult.success) {
    diagnostics.push("manifest_runtime_query_gate_invalid");
    return { ok: false, diagnostics: [...new Set(diagnostics)], producerRunIds: [] };
  }
  const manifest = manifestResult.data;
  if (!manifest.graphrag.queryReady) diagnostics.push("manifest_not_query_ready");
  const outputManifestPath = normalizeRelativePath(
    manifest.graphrag.outputManifestPath,
  );
  if (outputManifestPath == null) diagnostics.push("output_manifest_path_invalid");

  const filesByPath = validateRequiredArtifactFiles({
    bookRoot,
    manifest,
    diagnostics,
  });

  await validateArtifactMetadata({
    bookRoot,
    manifest,
    filesByPath,
    diagnostics,
  });
  await validateRuntimeCompatibility({ bookRoot, manifest, diagnostics });

  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)],
    producerRunIds: manifest.graphrag.producerRunIds,
  };
}
