import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import YAML from "yaml";

import { resolveBookRoot } from "./book-package-layout.js";

type ManifestFileEntry = {
  path: string;
  bytes: number;
  sha256: string;
  required?: boolean;
};

type HotplugManifest = {
  kind?: unknown;
  schemaVersion?: unknown;
  layoutVersion?: unknown;
  identity?: {
    bookId?: unknown;
    sourceHash?: unknown;
    packageGeneration?: unknown;
  };
  source?: {
    sourcePath?: unknown;
    sourceHash?: unknown;
    sourceBytes?: unknown;
    redactionStatus?: unknown;
  };
  input?: {
    canonicalNormalizedPath?: unknown;
    normalizedHash?: unknown;
    normalizedBytes?: unknown;
  };
  qmd?: {
    qmdIndexSchema?: unknown;
    indexPolicy?: unknown;
    qmdReadyState?: unknown;
    requiredArtifacts?: unknown;
  };
  graphrag?: {
    queryReady?: unknown;
    requiredArtifacts?: unknown;
    producerRunIds?: unknown;
    outputManifestPath?: unknown;
    graphRagArtifactSchema?: unknown;
    artifactSchema?: unknown;
  };
  compatibility?: {
    minQmdGraphRagVersion?: unknown;
  };
  files?: unknown;
  checksums?: {
    manifestSha256?: unknown;
    manifestContentSha256?: unknown;
    publishMarkerSha256?: unknown;
  };
  [key: string]: unknown;
};

type PublishReady = {
  kind?: unknown;
  bookId?: unknown;
  packageGeneration?: unknown;
  manifestSha256?: unknown;
  fileCount?: unknown;
  byteCount?: unknown;
  [key: string]: unknown;
};

export type HotplugPackageValidation = {
  ok: boolean;
  diagnostics: string[];
  manifest?: HotplugManifest;
  publishReady?: PublishReady;
};

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

const RequiredQmdArtifacts = [
  "qmd/qmd_build_manifest.json",
  "qmd/index/qmd_book_index.sqlite",
  "qmd/index/qmd_book_index.sqlite.sha256",
  "qmd/index/qmd_book_index.sqlite.sha256.meta.json",
  "qmd/index/qmd_book_index.meta.json",
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

function normalizeRelativePath(path: unknown): string | null {
  if (typeof path !== "string") return null;
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

function readPackageUnknown(path: string): unknown {
  return YAML.parse(readFileSync(path, "utf8"));
}

function readObject(path: string): Record<string, unknown> | null {
  const parsed = readPackageUnknown(path);
  return parsed != null && typeof parsed === "object"
    ? parsed as Record<string, unknown>
    : null;
}

function listFilesRecursive(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const result: string[] = [];
  const entries = readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...listFilesRecursive(root, path));
    else if (entry.isFile()) result.push(path);
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
  return stats.isDirectory() ? sha256Directory(path) : sha256Buffer(readFileSync(path));
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

function countDirectoryFiles(path: string): number {
  return listFilesRecursive(path).length;
}

function pushSidecarDiagnostics(input: {
  path: string;
  label: "manifest" | "publish_marker";
  diagnostics: string[];
}): string | null {
  const actual = sha256Buffer(readFileSync(input.path));
  const sidecarPath = `${input.path}.sha256`;
  const metaPath = `${input.path}.sha256.meta.json`;
  const missingSidecar = input.label === "manifest"
    ? "missing_manifest_sidecar"
    : "missing_publish_marker_sidecar";
  const missingMeta = input.label === "manifest"
    ? "missing_manifest_meta_sidecar"
    : "missing_publish_marker_meta_sidecar";
  const sidecarMismatch = input.label === "manifest"
    ? "manifest_sha256_mismatch"
    : "publish_marker_sha256_sidecar_mismatch";
  const metaInvalid = input.label === "manifest"
    ? "manifest_meta_sidecar_invalid"
    : "publish_marker_meta_sidecar_invalid";
  const metaMismatch = input.label === "manifest"
    ? "manifest_meta_checksum_mismatch"
    : "publish_marker_meta_checksum_mismatch";

  if (!existsSync(sidecarPath)) {
    input.diagnostics.push(missingSidecar);
  } else if (readFileSync(sidecarPath, "utf8").trim() !== actual) {
    input.diagnostics.push(sidecarMismatch);
  }
  if (!existsSync(metaPath)) {
    input.diagnostics.push(missingMeta);
  } else {
    try {
      const meta = readObject(metaPath);
      if (meta == null || meta.checksum !== actual) {
        input.diagnostics.push(metaMismatch);
      }
    } catch {
      input.diagnostics.push(metaInvalid);
    }
  }
  return actual;
}

function manifestFileEntries(manifest: HotplugManifest): ManifestFileEntry[] {
  if (!Array.isArray(manifest.files)) return [];
  return manifest.files.filter((entry): entry is ManifestFileEntry => {
    if (entry == null || typeof entry !== "object") return false;
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.path === "string" &&
      typeof candidate.sha256 === "string" &&
      typeof candidate.bytes === "number";
  });
}

function validateManifestChecksums(
  manifest: HotplugManifest,
  diagnostics: string[],
): void {
  if (manifest.kind !== "qmd_graphrag_book_package") {
    diagnostics.push("manifest_kind_invalid");
  }
  if (typeof manifest.checksums?.manifestContentSha256 === "string") {
    const canonicalManifest = {
      ...manifest,
      checksums: {
        ...manifest.checksums,
        manifestSha256: "",
        manifestContentSha256: "",
        publishMarkerSha256: "",
      },
    };
    const canonicalSha = sha256Text(
      `${JSON.stringify(canonicalManifest, null, 2)}\n`,
    );
    if (manifest.checksums.manifestSha256 !== canonicalSha) {
      diagnostics.push("manifest_embedded_sha256_mismatch");
    }
    if (manifest.checksums.manifestContentSha256 !== canonicalSha) {
      diagnostics.push("manifest_embedded_content_sha256_mismatch");
    }
  }
}

function validatePublishReady(input: {
  bookRoot: string;
  publishReady: PublishReady;
  manifest: HotplugManifest;
  diagnostics: string[];
}): void {
  if (input.publishReady.kind !== "qmd_graphrag_book_publish_ready") {
    input.diagnostics.push("publish_marker_invalid");
  }
  if (
    input.publishReady.bookId !== input.manifest.identity?.bookId ||
    input.publishReady.packageGeneration !==
      input.manifest.identity?.packageGeneration
  ) {
    input.diagnostics.push("publish_marker_identity_mismatch");
  }
  if (
    input.publishReady.manifestSha256 !==
      input.manifest.checksums?.manifestSha256
  ) {
    input.diagnostics.push("publish_marker_mismatch");
  }
  const publishPath = join(input.bookRoot, "PUBLISH_READY.json");
  if (
    typeof input.manifest.checksums?.publishMarkerSha256 === "string" &&
    input.manifest.checksums.publishMarkerSha256.length > 0 &&
    input.manifest.checksums.publishMarkerSha256 !== sha256Path(publishPath)
  ) {
    input.diagnostics.push("publish_marker_sha256_mismatch");
  }
  const fileEntries = manifestFileEntries(input.manifest);
  if (
    typeof input.publishReady.fileCount === "number" &&
    input.publishReady.fileCount !== fileEntries.length
  ) {
    input.diagnostics.push("publish_marker_file_count_mismatch");
  }
  if (typeof input.publishReady.byteCount === "number") {
    const byteCount = fileEntries.reduce((total, entry) => total + entry.bytes, 0);
    if (input.publishReady.byteCount !== byteCount) {
      input.diagnostics.push("publish_marker_byte_count_mismatch");
    }
  }
}

function validateManifestClosure(input: {
  bookRoot: string;
  manifest: HotplugManifest;
  diagnostics: string[];
}): void {
  const fileEntries = manifestFileEntries(input.manifest);
  if (fileEntries.length === 0) input.diagnostics.push("manifest_files_empty");

  const sourcePath = normalizeRelativePath(input.manifest.source?.sourcePath);
  if (sourcePath == null) {
    input.diagnostics.push("source_path_invalid");
  } else {
    const absoluteSourcePath = join(input.bookRoot, sourcePath);
    if (!existsSync(absoluteSourcePath)) {
      input.diagnostics.push("source_closure_missing");
    } else {
      const stats = statSync(absoluteSourcePath);
      if (!stats.isFile() || stats.size <= 0) {
        input.diagnostics.push("source_closure_missing");
      } else {
        if (input.manifest.source?.sourceBytes !== stats.size) {
          input.diagnostics.push("source_bytes_mismatch");
        }
        if (
          input.manifest.source?.redactionStatus === "included_source_epub" &&
          input.manifest.source?.sourceHash !== sha256Path(absoluteSourcePath)
        ) {
          input.diagnostics.push("source_hash_mismatch");
        }
      }
    }
  }

  const normalizedPath = normalizeRelativePath(
    input.manifest.input?.canonicalNormalizedPath,
  );
  if (normalizedPath == null) {
    input.diagnostics.push("canonical_input_path_invalid");
  } else {
    const absoluteInputPath = join(input.bookRoot, normalizedPath);
    if (!existsSync(absoluteInputPath)) {
      input.diagnostics.push("canonical_input_missing");
    } else {
      const stats = statSync(absoluteInputPath);
      if (!stats.isFile() || stats.size <= 0) {
        input.diagnostics.push("canonical_input_missing");
      } else {
        if (input.manifest.input?.normalizedBytes !== stats.size) {
          input.diagnostics.push("canonical_input_bytes_mismatch");
        }
        if (input.manifest.input?.normalizedHash !== sha256Path(absoluteInputPath)) {
          input.diagnostics.push("canonical_input_hash_mismatch");
        }
      }
    }
  }

  const filesByPath = new Map(fileEntries.map((entry) => [entry.path, entry]));
  for (const entry of fileEntries) {
    const path = normalizeRelativePath(entry.path);
    if (path == null) {
      input.diagnostics.push("path_escape");
      continue;
    }
    if (ForbiddenPackagePathPatterns.some((pattern) => pattern.test(path))) {
      input.diagnostics.push("forbidden_sensitive_material");
      continue;
    }
    const absolutePath = join(input.bookRoot, path);
    if (!existsSync(absolutePath)) {
      if (entry.required !== false) input.diagnostics.push(`missing_required_file:${path}`);
      continue;
    }
    const stats = statSync(absolutePath);
    if (stats.isFile()) {
      if (entry.bytes !== stats.size) {
        input.diagnostics.push(`file_bytes_mismatch:${path}`);
      }
    } else if (stats.isDirectory()) {
      if (entry.bytes !== 0) {
        input.diagnostics.push(`directory_bytes_mismatch:${path}`);
      }
      if (countDirectoryFiles(absolutePath) === 0 && entry.required !== false) {
        input.diagnostics.push(`directory_empty:${path}`);
      }
    }
    if (entry.sha256 !== sha256Path(absolutePath)) {
      input.diagnostics.push(`file_sha256_mismatch:${path}`);
    }
  }

  if (input.manifest.qmd?.indexPolicy !== "included_index") {
    input.diagnostics.push("qmd_index_policy_not_included");
  }
  if (input.manifest.qmd?.qmdReadyState !== "included_index_valid") {
    input.diagnostics.push("qmd_ready_state_not_included_index_valid");
  }
  const requiredQmdArtifacts = Array.isArray(input.manifest.qmd?.requiredArtifacts)
    ? input.manifest.qmd.requiredArtifacts
    : RequiredQmdArtifacts;
  for (const artifact of requiredQmdArtifacts) {
    const path = normalizeRelativePath(artifact);
    if (path == null || !filesByPath.has(path) || !existsSync(join(input.bookRoot, path))) {
      input.diagnostics.push(`missing_required_file:${String(artifact)}`);
    }
  }

  const requiredArtifacts = Array.isArray(input.manifest.graphrag?.requiredArtifacts)
    ? input.manifest.graphrag.requiredArtifacts
    : [];
  for (const artifact of requiredArtifacts) {
    const path = normalizeRelativePath(artifact);
    if (path == null || !filesByPath.has(path) || !existsSync(join(input.bookRoot, path))) {
      input.diagnostics.push(`missing_required_file:${String(artifact)}`);
    }
  }
  if (input.manifest.graphrag?.queryReady === true) {
    const producerRunIds = Array.isArray(input.manifest.graphrag.producerRunIds)
      ? input.manifest.graphrag.producerRunIds
      : [];
    for (const runId of producerRunIds) {
      if (
        typeof runId !== "string" ||
        runId.length === 0 ||
        !existsSync(join(input.bookRoot, "graphrag", "runs", `${runId}.yaml`))
      ) {
        input.diagnostics.push(`missing_producer_run:${String(runId)}`);
      }
    }
    const graphIdentityPath = join(
      input.bookRoot,
      "graphrag",
      "output",
      "qmd_graph_text_unit_identity.json",
    );
    const graphIdentity = existsSync(graphIdentityPath)
      ? readObject(graphIdentityPath)
      : null;
    const identityMetadata = graphIdentity?.metadata;
    const provenance = identityMetadata != null &&
        typeof identityMetadata === "object"
      ? (identityMetadata as Record<string, unknown>).identityProvenance
      : null;
    const publishAllowed = identityMetadata != null &&
        typeof identityMetadata === "object"
      ? (identityMetadata as Record<string, unknown>).publishAllowed
      : null;
    if (
      provenance === "test_hook_synthetic" ||
      publishAllowed === false ||
      typeof graphIdentity?.graphDocumentId === "string" &&
        graphIdentity.graphDocumentId.startsWith("graph-doc-doc-")
    ) {
      input.diagnostics.push("graph_identity_test_hook_synthetic_not_publishable");
    }
  }
}

export function validateBookHotplugPackageBoundary(input: {
  bookRoot: string;
}): HotplugPackageValidation {
  const bookRoot = resolve(input.bookRoot);
  const diagnostics: string[] = [];
  const manifestPath = join(bookRoot, "BOOK_MANIFEST.json");
  const publishReadyPath = join(bookRoot, "PUBLISH_READY.json");
  for (const path of listForbiddenPaths(bookRoot)) {
    diagnostics.push(`forbidden_sensitive_material:${path}`);
  }
  if (!existsSync(manifestPath)) {
    return { ok: false, diagnostics: [...new Set([...diagnostics, "missing_manifest"])] };
  }
  if (!existsSync(publishReadyPath)) {
    diagnostics.push("missing_publish_marker");
  }

  pushSidecarDiagnostics({ path: manifestPath, label: "manifest", diagnostics });
  let manifest: HotplugManifest;
  try {
    manifest = readObject(manifestPath) as HotplugManifest;
    if (manifest == null) throw new Error("manifest_not_object");
  } catch {
    diagnostics.push("manifest_json_invalid");
    return { ok: false, diagnostics: [...new Set(diagnostics)] };
  }
  validateManifestChecksums(manifest, diagnostics);

  let publishReady: PublishReady | undefined;
  if (existsSync(publishReadyPath)) {
    pushSidecarDiagnostics({
      path: publishReadyPath,
      label: "publish_marker",
      diagnostics,
    });
    try {
      publishReady = readObject(publishReadyPath) as PublishReady;
      if (publishReady == null) throw new Error("publish_marker_not_object");
      validatePublishReady({ bookRoot, publishReady, manifest, diagnostics });
    } catch {
      diagnostics.push("publish_marker_invalid");
    }
  }

  validateManifestClosure({ bookRoot, manifest, diagnostics });
  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)],
    manifest,
    publishReady,
  };
}

export function validatePublishedBookHotplugPackage(input: {
  graphVault: string;
  bookId: string;
}): HotplugPackageValidation {
  return validateBookHotplugPackageBoundary({
    bookRoot: resolveBookRoot(input.graphVault, input.bookId),
  });
}
