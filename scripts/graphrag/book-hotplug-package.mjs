import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import YAML from "yaml";

import {
  validateArtifactMetadata,
  writeArtifactMetadata,
} from "./book-hotplug-artifact-metadata.mjs";
import {
  validateHotplugProducerRunBindings,
} from "./book-hotplug-producer-run-bindings.mjs";
import {
  isForbiddenHotplugPackagePath,
} from "./book-hotplug-residue-quarantine.mjs";
import {
  validateRuntimeCompatibility,
  writeRuntimeCompatibility,
} from "./book-hotplug-runtime-compatibility.mjs";
import { writeHotplugTextAtomic } from "./book-hotplug-durable-writer.mjs";

const SchemaVersion = "1.0.0";
const LayoutVersion = "book-hotplug-v1";
const PackageVersion = "1.0.0";
const IdentityAlgorithmVersion = "book-hotplug-package-v1";

const RequiredGraphRagArtifacts = [
  "graphrag/output/qmd_output_manifest.json",
  "graphrag/output/qmd_graph_text_unit_identity.json",
  "graphrag/output/artifact-metadata.json",
  "graphrag/output/runtime-compatibility.json",
  "graphrag/output/context.json",
  "graphrag/output/stats.json",
  "graphrag/output/documents.parquet",
  "graphrag/output/text_units.parquet",
  "graphrag/output/entities.parquet",
  "graphrag/output/relationships.parquet",
  "graphrag/output/communities.parquet",
  "graphrag/output/community_reports.parquet",
  "graphrag/output/lancedb",
];

const RequiredQmdArtifacts = [
  "qmd/qmd_build_manifest.json",
  "qmd/index/qmd_book_index.sqlite",
  "qmd/index/qmd_book_index.sqlite.sha256",
  "qmd/index/qmd_book_index.sqlite.sha256.meta.json",
  "qmd/index/qmd_book_index.meta.json",
];

function toPosixPath(path) {
  return String(path).split(sep).join("/");
}

function normalizeRelativePath(path) {
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

function packageRelative(bookRoot, path) {
  return normalizeRelativePath(relative(bookRoot, path));
}

function vaultRelative(stateRoot, path) {
  return normalizeRelativePath(relative(stateRoot, path));
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isForbiddenPackagePath(path) {
  return isForbiddenHotplugPackagePath(path);
}

function listFilesRecursive(rootPath, options = {}) {
  if (!existsSync(rootPath)) return [];
  const files = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relativePath = packageRelative(options.bookRoot ?? rootPath, path);
      if (
        relativePath == null ||
        (options.includeForbidden !== true &&
          isForbiddenPackagePath(relativePath)) ||
        options.exclude?.(path, entry, relativePath) === true
      ) {
        continue;
      }
      if (entry.isSymbolicLink() && options.followSymlinks !== true) continue;
      const pathStats = entry.isSymbolicLink() && options.followSymlinks === true
        ? safeStat(path)
        : null;
      if (entry.isDirectory()) {
        visit(path);
      } else if (pathStats?.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else if (pathStats?.isFile()) {
        files.push(path);
      }
    }
  };
  visit(rootPath);
  return files;
}

function listForbiddenPackagePaths(bookRoot) {
  return listFilesRecursive(bookRoot, {
    bookRoot,
    exclude: () => false,
    includeForbidden: true,
    followSymlinks: true,
  }).map((path) => packageRelative(bookRoot, path))
    .filter((path) => path != null && isForbiddenPackagePath(path))
    .sort((left, right) => left.localeCompare(right));
}

function inferRole(path) {
  if (path.startsWith("source/")) return "source";
  if (path.startsWith("input/")) return "normalized_input";
  if (path.startsWith("qmd/")) return "qmd";
  if (path.startsWith("graphrag/output/")) return "graphrag_output";
  if (path.startsWith("graphrag/runs/")) return "producer_run_evidence";
  if (path.startsWith("state/")) return "runner_state";
  if (path.startsWith("metadata/")) return "metadata";
  if (path === "PUBLISH_READY.json") return "publish_marker";
  return "package_file";
}

function sensitivityFor(path, role) {
  if (role === "producer_run_evidence" || role === "runner_state") {
    return "restricted";
  }
  if (path.endsWith(".sha256") || path.endsWith(".sha256.meta.json")) {
    return "public";
  }
  return "public";
}

function fileEntry(bookRoot, path, options = {}) {
  const relativePath = packageRelative(bookRoot, path);
  if (relativePath == null) {
    throw new Error(`package file is not package-relative: ${path}`);
  }
  const entry = statSync(path);
  const role = options.role ?? inferRole(relativePath);
  return {
    path: relativePath,
    role,
    bytes: entry.size,
    sha256: sha256File(path),
    required: options.required ?? true,
    ...(options.producerRunId == null ? {} : {
      producerRunId: options.producerRunId,
    }),
    sensitivity: sensitivityFor(relativePath, role),
  };
}

function directoryEntry(bookRoot, path, options = {}) {
  const relativePath = packageRelative(bookRoot, path);
  if (relativePath == null) {
    throw new Error(`package directory is not package-relative: ${path}`);
  }
  return {
    path: relativePath,
    role: options.role ?? inferRole(relativePath),
    bytes: 0,
    sha256: sha256Directory(path),
    required: options.required ?? true,
    ...(options.producerRunId == null ? {} : {
      producerRunId: options.producerRunId,
    }),
    sensitivity: sensitivityFor(relativePath, options.role ?? inferRole(relativePath)),
  };
}

function sha256Directory(path) {
  const hash = createHash("sha256");
  const files = listFilesRecursive(path, { bookRoot: path });
  for (const file of files) {
    const relativePath = toPosixPath(relative(path, file));
    hash.update(relativePath);
    hash.update("\0");
    hash.update(sha256File(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readGraphIdentity(outputDir) {
  const path = join(outputDir, "qmd_graph_text_unit_identity.json");
  if (!existsSync(path)) return null;
  const parsed = readJson(path);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function readGraphOutputManifest(outputDir) {
  const path = join(outputDir, "qmd_output_manifest.json");
  if (!existsSync(path)) return null;
  const parsed = readJson(path);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function readQmdBuildManifest(bookRoot) {
  const path = join(bookRoot, "qmd", "qmd_build_manifest.json");
  if (!existsSync(path)) return null;
  const parsed = readJson(path);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function readDistributionManifest(bookRoot) {
  const path = join(bookRoot, "distribution_manifest.json");
  if (!existsSync(path)) return null;
  const parsed = readJson(path);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function titleSlugFromTitle(title, fallback) {
  const normalized = String(title ?? fallback ?? "book")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return normalized || String(fallback ?? "book");
}

function canonicalTitle(input, graphIdentity) {
  const sourceName = input.sourceRelativePath == null
    ? input.bookId
    : basename(input.sourceRelativePath).replace(/\.epub$/iu, "");
  const metadataTitle = graphIdentity?.metadata?.title;
  return typeof metadataTitle === "string" && metadataTitle.trim()
    ? metadataTitle.trim()
    : sourceName;
}

function buildFileEntries(input, producerRunIds) {
  const entries = [];
  const addFile = (path, options = {}) => {
    if (!existsSync(path)) return;
    if (!lstatSync(path).isFile()) return;
    const relativePath = packageRelative(input.bookRoot, path);
    if (relativePath == null || isForbiddenPackagePath(relativePath)) return;
    entries.push(fileEntry(input.bookRoot, path, options));
  };
  const addDirectory = (path, options = {}) => {
    if (!existsSync(path)) return;
    if (!lstatSync(path).isDirectory()) return;
    const relativePath = packageRelative(input.bookRoot, path);
    if (relativePath == null || isForbiddenPackagePath(relativePath)) return;
    entries.push(directoryEntry(input.bookRoot, path, options));
  };

  for (const rootPath of [
    join(input.bookRoot, "source"),
    join(input.bookRoot, "input"),
    join(input.bookRoot, "qmd"),
    join(input.bookRoot, "graphrag", "output"),
    join(input.bookRoot, "graphrag", "runs"),
    join(input.bookRoot, "state"),
    join(input.bookRoot, "metadata"),
  ]) {
    for (const path of listFilesRecursive(rootPath, { bookRoot: input.bookRoot })) {
      const relativePath = packageRelative(input.bookRoot, path);
      if (
        relativePath === "state/hotplug-quality-gate.json" ||
        relativePath === "state/hotplug-quality-gate.json.sha256" ||
        relativePath === "state/hotplug-quality-gate.json.sha256.meta.json" ||
        relativePath === "state/hotplug-runtime-gate.json" ||
        relativePath === "state/hotplug-runtime-gate.json.sha256" ||
        relativePath === "state/hotplug-runtime-gate.json.sha256.meta.json"
      ) {
        continue;
      }
      addFile(path);
    }
  }
  addDirectory(join(input.bookRoot, "graphrag", "output", "lancedb"), {
    role: "graphrag_output",
    producerRunId: producerRunIds.embed,
  });

  const byPath = new Map();
  for (const entry of entries) {
    byPath.set(entry.path, {
      ...entry,
      producerRunId: entry.path.startsWith("graphrag/output/")
        ? producerRunIdForArtifactPath(entry.path, producerRunIds)
        : entry.producerRunId,
    });
  }
  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
}

function producerRunIdForArtifactPath(path, producerRunIds) {
  if (path === "graphrag/output/artifact-metadata.json") return undefined;
  if (path === "graphrag/output/community_reports.parquet") {
    return producerRunIds.community_report;
  }
  if (path === "graphrag/output/lancedb" || path.startsWith("graphrag/output/lancedb/")) {
    return producerRunIds.embed;
  }
  if (path.startsWith("graphrag/output/")) return producerRunIds.graph_extract;
  return undefined;
}

function producerRunIdsFrom(input, graphManifest, distributionManifest) {
  const stageProducerRunIds = {
    ...(distributionManifest?.producerEvidence?.stageProducerRunIds ?? {}),
    ...(graphManifest?.stageProducerRunIds ?? {}),
  };
  return {
    graph_extract: stageProducerRunIds.graph_extract,
    community_report: stageProducerRunIds.community_report,
    embed: stageProducerRunIds.embed,
    query_ready:
      stageProducerRunIds.query_ready ??
      graphManifest?.producerRunId ??
      distributionManifest?.producerEvidence?.outputProducerRunId,
  };
}

function sourcePathFromPackage(bookRoot) {
  const sourceFiles = listFilesRecursive(join(bookRoot, "source"), { bookRoot });
  return sourceFiles.length === 0 ? "source/source.epub" : packageRelative(bookRoot, sourceFiles[0]);
}

function sourceBytesFromPath(bookRoot, relativePath) {
  const path = relativePath == null ? null : join(bookRoot, relativePath);
  const stats = path == null ? null : safeStat(path);
  return stats?.isFile() ? stats.size : 0;
}

function normalizedPathFrom(input, qmdManifest, graphIdentity, distributionManifest) {
  const explicit = qmdManifest?.canonicalBookNormalizedPath ??
    graphIdentity?.normalizedPath ??
    distributionManifest?.portability?.canonicalNormalizedPath;
  const relativePath = typeof explicit === "string"
    ? explicit.replace(/^books\/[^/]+\//u, "")
    : null;
  if (relativePath != null && existsSync(join(input.bookRoot, relativePath))) {
    return relativePath;
  }
  const inputFiles = listFilesRecursive(join(input.bookRoot, "input"), {
    bookRoot: input.bookRoot,
  }).filter((path) => /\.(md|markdown|txt)$/iu.test(path));
  return inputFiles.length === 0 ? "input/book.md" : packageRelative(input.bookRoot, inputFiles[0]);
}

function qmdState(input) {
  const indexPath = join(input.bookRoot, "qmd", "index", "qmd_book_index.sqlite");
  return existsSync(indexPath) ? "included_index_valid" : "reindex_required";
}

function graphRagState(input) {
  if (input.forceGraphRagNotQueryReady === true) return "producer_lineage_missing";
  const graphIdentity = readGraphIdentity(join(input.bookRoot, "graphrag", "output"));
  if (
    graphIdentity?.metadata?.identityProvenance === "test_hook_synthetic" ||
    graphIdentity?.metadata?.publishAllowed === false ||
    typeof graphIdentity?.graphDocumentId === "string" &&
      graphIdentity.graphDocumentId.startsWith("graph-doc-doc-")
  ) {
    return "producer_lineage_missing";
  }
  const missing = RequiredGraphRagArtifacts.filter((path) =>
    !existsSync(join(input.bookRoot, path))
  );
  return missing.length === 0 ? "query_ready" : "artifact_missing";
}

function buildChecksumsPlaceholder(generatedAt) {
  return {
    algorithm: "sha256",
    generatedAt,
    manifestSha256: "",
    manifestContentSha256: "",
    publishMarkerSha256: "",
  };
}

function manifestWithChecksum(manifest) {
  const contentSha256 = sha256Text(JSON.stringify(manifest, null, 2) + "\n");
  return {
    manifest: {
      ...manifest,
      checksums: {
        ...manifest.checksums,
        manifestSha256: contentSha256,
        manifestContentSha256: contentSha256,
      },
    },
  };
}

export function buildBookHotplugManifest(input) {
  const stateRoot = resolve(input.stateRoot);
  const bookRoot = resolve(stateRoot, "books", input.bookId);

  const qmdManifest = readQmdBuildManifest(bookRoot);
  const graphOutputDir = join(bookRoot, "graphrag", "output");
  const graphManifest = readGraphOutputManifest(graphOutputDir);
  const graphIdentity = readGraphIdentity(graphOutputDir);
  const distributionManifest = readDistributionManifest(bookRoot);
  const generatedAt = input.now();
  const title = canonicalTitle(input, graphIdentity);
  const sourcePath = sourcePathFromPackage(bookRoot);
  const normalizedPath = normalizedPathFrom(
    { ...input, stateRoot, bookRoot },
    qmdManifest,
    graphIdentity,
    distributionManifest,
  );
  const producerRunIds = producerRunIdsFrom(input, graphManifest, distributionManifest);
  const normalizedAbsolutePath = normalizedPath == null ? null : join(bookRoot, normalizedPath);
  const normalizedBytes = normalizedAbsolutePath == null
    ? 0
    : safeStat(normalizedAbsolutePath)?.size ?? 0;
  const normalizedHash = normalizedAbsolutePath == null ||
    !existsSync(normalizedAbsolutePath)
    ? qmdManifest?.normalizedContentHash ?? input.sourceHash
    : sha256File(normalizedAbsolutePath);
  const packageGeneration = input.packageGeneration ??
    `${generatedAt.replace(/[-:.TZ]/gu, "")}-${input.sourceHash.slice(0, 12)}`;
  let files = buildFileEntries({ ...input, stateRoot, bookRoot }, producerRunIds);
  writeRuntimeCompatibility({
    bookRoot,
    bookId: input.bookId,
    packageGeneration,
    generatedAt,
    files,
    packageSchemaVersion: SchemaVersion,
    layoutVersion: LayoutVersion,
    qmdIndexSchema: "qmd-book-index-v1",
    graphRagArtifactSchema: "graphrag-output-v1",
    artifactSchema: "graphrag-output-v1",
    minQmdGraphRagVersion: "2.5.1",
    toolVersion: input.toolVersion,
    rootPath: stateRoot,
  });
  files = buildFileEntries({ ...input, stateRoot, bookRoot }, producerRunIds);
  writeArtifactMetadata({
    bookRoot,
    bookId: input.bookId,
    packageGeneration,
    generatedAt,
    files,
    requiredArtifacts: RequiredGraphRagArtifacts,
    toolVersion: input.toolVersion,
    rootPath: stateRoot,
  });
  files = buildFileEntries({ ...input, stateRoot, bookRoot }, producerRunIds);
  const qmdReadyState = qmdState({ ...input, bookRoot });
  const qmdRequiredArtifacts = [
    ...RequiredQmdArtifacts,
    normalizedPath,
  ].filter(Boolean);
  const graphRagReadyState = graphRagState({ ...input, bookRoot });

  const manifest = {
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_book_package",
    layoutVersion: LayoutVersion,
    identity: {
      bookId: input.bookId,
      sourceHash: input.sourceHash,
      canonicalTitle: title,
      titleSlug: titleSlugFromTitle(title, input.bookId),
      createdAt: generatedAt,
      packageVersion: PackageVersion,
      packageGeneration,
      identityAlgorithmVersion: IdentityAlgorithmVersion,
      identityDecisionReason: "source_hash_and_source_identity_path",
    },
    mount: {
      packageRoot: ".",
      publishMarkerPath: "PUBLISH_READY.json",
      packageGeneration,
      mountMode: "readonly",
      catalogProjectionPolicy: "mount_scan_rebuildable_projection",
      qmdIndexPolicy: "use_included_index",
    },
    metadata: {
      title,
      language: graphIdentity?.metadata?.language,
      descriptionSummary: graphIdentity?.metadata?.descriptionSummary,
    },
    source: {
      sourcePath,
      sourceHash: input.sourceHash,
      sourceBytes: sourceBytesFromPath(bookRoot, sourcePath),
      sourceKind: "epub",
      sourceProvenanceKind: "packaged_source",
      redactionStatus: "included_source_epub",
    },
    input: {
      canonicalNormalizedPath: normalizedPath,
      normalizedHash,
      normalizedBytes,
      normalizationToolVersion: qmdManifest?.normalizationPolicyVersion,
      normalizationConfigDigest: qmdManifest?.configHash,
    },
    qmd: {
      buildManifestPath: "qmd/qmd_build_manifest.json",
      indexPath: "qmd/index/qmd_book_index.sqlite",
      indexMetadataPath: "qmd/index/qmd_book_index.meta.json",
      indexPolicy: "included_index",
      requiredArtifacts: qmdRequiredArtifacts,
      qmdIndexSchema: "qmd-book-index-v1",
      freshnessDigest: sha256Text(JSON.stringify({
        bookId: input.bookId,
        sourceHash: input.sourceHash,
        normalizedHash,
        qmdIndexSchema: "qmd-book-index-v1",
      })),
      qmdReadyState,
    },
    graphrag: {
      outputManifestPath: "graphrag/output/qmd_output_manifest.json",
      queryReady: graphRagReadyState === "query_ready",
      requiredArtifacts: RequiredGraphRagArtifacts,
      producerRunIds: Object.values(producerRunIds).filter(Boolean),
      graphRagArtifactSchema: "graphrag-output-v1",
      artifactSchema: "graphrag-output-v1",
      graphRagReadyState,
    },
    files,
    checksums: buildChecksumsPlaceholder(generatedAt),
    exclusions: {
      patterns: [
        ".env",
        "**/.env",
        "provider-requests/**",
        "provider-responses/**",
        "graphrag/output/reports/**",
        "**/*.corrupt-*",
        "**/.durable-recovery.jsonl",
        "**/logs/**",
      ],
    },
    compatibility: {
      minQmdGraphRagVersion: "2.5.1",
      graphRagArtifactSchema: "graphrag-output-v1",
      qmdIndexSchema: "qmd-book-index-v1",
      createdBy: {
        toolName: "qmd_graphrag",
        toolVersion: input.toolVersion ?? "unknown",
        platformClass: process.platform,
      },
    },
    diagnostics: [],
    legacyEvidence: {
      distributionManifestPath: existsSync(join(bookRoot, "distribution_manifest.json"))
        ? "distribution_manifest.json"
        : undefined,
    },
  };
  return manifestWithChecksum(withoutUndefined(manifest)).manifest;
}

export function buildPublishReady(input) {
  return {
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_book_publish_ready",
    bookId: input.manifest.identity.bookId,
    packageGeneration: input.manifest.identity.packageGeneration,
    manifestSha256: input.manifest.checksums.manifestSha256,
    fileCount: input.manifest.files.length,
    byteCount: input.manifest.files.reduce(
      (total, file) => total + (Number.isFinite(file.bytes) ? file.bytes : 0),
      0,
    ),
    createdAt: input.createdAt ?? input.now(),
    toolVersion: input.toolVersion ?? "unknown",
  };
}

export function buildBookHotplugPackage(input) {
  const manifest = buildBookHotplugManifest(input);
  const publishReady = buildPublishReady({
    manifest,
    now: input.now,
    createdAt: manifest.checksums.generatedAt,
    toolVersion: input.toolVersion,
  });
  const publishMarkerSha256 = sha256Text(
    JSON.stringify(publishReady, null, 2) + "\n",
  );
  return {
    manifest: {
      ...manifest,
      checksums: {
        ...manifest.checksums,
        publishMarkerSha256,
      },
    },
    publishReady,
  };
}

export function validateBookHotplugPackage(input) {
  const bookRoot = resolve(input.bookRoot);
  const diagnostics = [];
  const manifestPath = join(bookRoot, "BOOK_MANIFEST.json");
  const publishPath = join(bookRoot, "PUBLISH_READY.json");
  for (const path of listForbiddenPackagePaths(bookRoot)) {
    diagnostics.push(`forbidden_sensitive_material:${path}`);
  }
  if (!existsSync(manifestPath)) {
    return { ok: false, diagnostics: [...new Set([...diagnostics, "missing_manifest"])] };
  }
  if (!existsSync(`${manifestPath}.sha256`)) diagnostics.push("missing_manifest_sidecar");
  if (!existsSync(`${manifestPath}.sha256.meta.json`)) {
    diagnostics.push("missing_manifest_meta_sidecar");
  }
  if (!existsSync(publishPath)) diagnostics.push("missing_publish_marker");
  if (!existsSync(`${publishPath}.sha256`)) diagnostics.push("missing_publish_marker_sidecar");
  if (!existsSync(`${publishPath}.sha256.meta.json`)) {
    diagnostics.push("missing_publish_marker_meta_sidecar");
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    diagnostics.push("manifest_json_invalid");
    return { ok: false, diagnostics };
  }

  if (manifest.kind !== "qmd_graphrag_book_package") {
    diagnostics.push("manifest_kind_invalid");
  }
  if (manifest.mount?.packageRoot !== ".") diagnostics.push("package_root_not_relative");
  const expectedManifestSha = sha256File(manifestPath);
  const sidecarSha = existsSync(`${manifestPath}.sha256`)
    ? readFileSync(`${manifestPath}.sha256`, "utf8").trim()
    : "";
  if (sidecarSha && sidecarSha !== expectedManifestSha) {
    diagnostics.push("manifest_sha256_mismatch");
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
    const canonicalSha = sha256Text(JSON.stringify(canonicalManifest, null, 2) + "\n");
    if (manifest.checksums.manifestSha256 !== canonicalSha) {
      diagnostics.push("manifest_embedded_sha256_mismatch");
    }
    if (manifest.checksums.manifestContentSha256 !== canonicalSha) {
      diagnostics.push("manifest_embedded_content_sha256_mismatch");
    }
  }

  if (existsSync(publishPath)) {
    try {
      const publishReady = readJson(publishPath);
      if (publishReady.manifestSha256 !== manifest.checksums?.manifestSha256) {
        diagnostics.push("publish_marker_mismatch");
      }
      if (
        typeof manifest.checksums?.publishMarkerSha256 === "string" &&
        manifest.checksums.publishMarkerSha256 &&
        manifest.checksums.publishMarkerSha256 !== sha256File(publishPath)
      ) {
        diagnostics.push("publish_marker_sha256_mismatch");
      }
    } catch {
      diagnostics.push("publish_marker_invalid");
    }
  }

  const fileEntries = Array.isArray(manifest.files) ? manifest.files : [];
  if (fileEntries.length === 0) diagnostics.push("manifest_files_empty");
  const filesByPath = new Map(fileEntries.map((entry) => [entry.path, entry]));

  const sourcePath = normalizeRelativePath(manifest.source?.sourcePath);
  if (sourcePath == null) {
    diagnostics.push("source_path_invalid");
  } else {
    const absoluteSourcePath = join(bookRoot, sourcePath);
    const sourceStats = safeStat(absoluteSourcePath);
    if (!sourceStats?.isFile() || sourceStats.size <= 0) {
      diagnostics.push("source_closure_missing");
    } else {
      if (manifest.source?.sourceBytes !== sourceStats.size) {
        diagnostics.push("source_bytes_mismatch");
      }
      if (
        manifest.source?.redactionStatus === "included_source_epub" &&
        manifest.source?.sourceHash !== sha256File(absoluteSourcePath)
      ) {
        diagnostics.push("source_hash_mismatch");
      }
    }
  }

  const normalizedPath = normalizeRelativePath(
    manifest.input?.canonicalNormalizedPath,
  );
  if (normalizedPath == null) {
    diagnostics.push("canonical_input_path_invalid");
  } else {
    const absoluteInputPath = join(bookRoot, normalizedPath);
    const inputStats = safeStat(absoluteInputPath);
    if (!inputStats?.isFile() || inputStats.size <= 0) {
      diagnostics.push("canonical_input_missing");
    } else {
      if (manifest.input?.normalizedBytes !== inputStats.size) {
        diagnostics.push("canonical_input_bytes_mismatch");
      }
      if (manifest.input?.normalizedHash !== sha256File(absoluteInputPath)) {
        diagnostics.push("canonical_input_hash_mismatch");
      }
    }
  }

  for (const entry of fileEntries) {
    const path = normalizeRelativePath(entry.path);
    if (path == null) {
      diagnostics.push("path_escape");
      continue;
    }
    if (isForbiddenPackagePath(path)) {
      diagnostics.push("forbidden_sensitive_material");
      continue;
    }
    const absolutePath = join(bookRoot, path);
    if (!existsSync(absolutePath)) {
      if (entry.required !== false) diagnostics.push(`missing_required_file:${path}`);
      continue;
    }
    const stat = statSync(absolutePath);
    if (stat.isFile()) {
      if (entry.bytes !== stat.size) diagnostics.push(`file_bytes_mismatch:${path}`);
      if (entry.sha256 !== sha256File(absolutePath)) {
        diagnostics.push(`file_sha256_mismatch:${path}`);
      }
    } else if (stat.isDirectory()) {
      if (entry.sha256 !== sha256Directory(absolutePath)) {
        diagnostics.push(`directory_sha256_mismatch:${path}`);
      }
    }
  }

  if (manifest.mount?.qmdIndexPolicy !== "use_included_index") {
    diagnostics.push("qmd_index_policy_not_included");
  }
  if (manifest.qmd?.indexPolicy !== "included_index") {
    diagnostics.push("qmd_index_policy_not_included");
  }
  if (manifest.qmd?.qmdReadyState !== "included_index_valid") {
    diagnostics.push("qmd_ready_state_not_included_index_valid");
  }
  for (const artifact of manifest.qmd?.requiredArtifacts ?? RequiredQmdArtifacts) {
    const path = normalizeRelativePath(artifact);
    if (path == null || !filesByPath.has(path) || !existsSync(join(bookRoot, path))) {
      diagnostics.push(`missing_required_file:${artifact}`);
    }
  }

  for (const artifact of manifest.graphrag?.requiredArtifacts ?? []) {
    const path = normalizeRelativePath(artifact);
    if (path == null || !existsSync(join(bookRoot, path))) {
      diagnostics.push(`missing_required_file:${artifact}`);
    }
  }
  const manifestQueryReady = manifest.graphrag?.queryReady === true;
  if (manifestQueryReady) {
    for (const runId of manifest.graphrag?.producerRunIds ?? []) {
      if (
        typeof runId !== "string" ||
        runId.length === 0 ||
        !existsSync(join(bookRoot, "graphrag", "runs", `${runId}.yaml`))
      ) {
        diagnostics.push(`missing_producer_run:${runId}`);
      }
    }
    const graphIdentityPath = join(
      bookRoot,
      "graphrag",
      "output",
      "qmd_graph_text_unit_identity.json",
    );
    const graphIdentity = existsSync(graphIdentityPath)
      ? readJson(graphIdentityPath)
      : null;
    const identityMetadata = graphIdentity?.metadata;
    const provenance = identityMetadata != null &&
        typeof identityMetadata === "object"
      ? identityMetadata.identityProvenance
      : null;
    const publishAllowed = identityMetadata != null &&
        typeof identityMetadata === "object"
      ? identityMetadata.publishAllowed
      : null;
    if (
      provenance === "test_hook_synthetic" ||
      publishAllowed === false ||
      typeof graphIdentity?.graphDocumentId === "string" &&
        graphIdentity.graphDocumentId.startsWith("graph-doc-doc-")
    ) {
      diagnostics.push("graph_identity_test_hook_synthetic_not_publishable");
    }
  }
  const artifactMetadataValidation = validateArtifactMetadata({
    bookRoot,
    bookId: manifest.identity?.bookId,
    files: fileEntries,
    requiredArtifacts: manifest.graphrag?.requiredArtifacts,
    producerRunIds: manifestQueryReady ? manifest.graphrag?.producerRunIds : [],
  });
  diagnostics.push(...artifactMetadataValidation.diagnostics);
  if (manifestQueryReady) {
    const metadataPath = join(bookRoot, "graphrag", "output", "artifact-metadata.json");
    const metadata = existsSync(metadataPath) ? readJson(metadataPath) : null;
    const graphManifestPath = join(
      bookRoot,
      manifest.graphrag?.outputManifestPath ?? "",
    );
    const graphManifest = existsSync(graphManifestPath)
      ? readGraphOutputManifest(dirname(graphManifestPath))
      : null;
    diagnostics.push(...validateHotplugProducerRunBindings({
      bookRoot,
      bookId: manifest.identity?.bookId,
      producerRunIds: manifest.graphrag?.producerRunIds,
      rows: Array.isArray(metadata?.rows) ? metadata.rows : [],
      providerFingerprint: graphManifest?.providerFingerprint,
    }));
  }
  const runtimeCompatibilityValidation = validateRuntimeCompatibility({
    bookRoot,
    bookId: manifest.identity?.bookId,
    packageGeneration: manifest.identity?.packageGeneration,
    files: fileEntries,
    packageSchemaVersion: manifest.schemaVersion,
    layoutVersion: manifest.layoutVersion,
    qmdIndexSchema: manifest.qmd?.qmdIndexSchema,
    graphRagArtifactSchema: manifest.graphrag?.graphRagArtifactSchema,
    artifactSchema: manifest.graphrag?.artifactSchema,
    minQmdGraphRagVersion: manifest.compatibility?.minQmdGraphRagVersion,
  });
  diagnostics.push(...runtimeCompatibilityValidation.diagnostics);
  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)],
    manifest,
  };
}

export function mountScanBookPackages(input) {
  const stateRoot = resolve(input.stateRoot);
  const booksRoot = join(stateRoot, "books");
  const candidates = existsSync(booksRoot)
    ? readdirSync(booksRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
    : [];
  const mounted = [];
  const failed = [];
  for (const bookId of candidates) {
    const bookRoot = join(booksRoot, bookId);
    const result = validateBookHotplugPackage({ bookRoot });
    if (!result.ok || result.manifest == null) {
      failed.push({ bookId, diagnostics: result.diagnostics });
      continue;
    }
    mounted.push({
      bookId,
      manifest: result.manifest,
      packageRoot: vaultRelative(stateRoot, bookRoot),
      manifestSha256: sha256File(join(bookRoot, "BOOK_MANIFEST.json")),
    });
  }
  return {
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_mount_scan",
    generatedAt: input.now(),
    mounted,
    failed,
  };
}

function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value == null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, withoutUndefined(item)]),
  );
}
