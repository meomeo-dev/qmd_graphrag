import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  writeHotplugJsonWithSidecars,
} from "./book-hotplug-json-sidecars.mjs";

const SchemaVersion = "1.0.0";
const CompatibilityKind = "qmd_graphrag_runtime_compatibility";

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readJsonOptional(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function graphManifestEmbeddingDimension(graphManifest) {
  return graphManifest?.embeddingVectorDimension ??
    graphManifest?.embeddingDimension ??
    null;
}

function fileByPath(files, path) {
  return (files ?? []).find((entry) => entry.path === path);
}

function digestRows(rows) {
  return sha256Text(`${JSON.stringify(rows, null, 2)}\n`);
}

function requiredFileDigest(files, paths) {
  return digestRows(
    paths.map((path) => {
      const entry = fileByPath(files, path);
      return {
        path,
        bytes: entry?.bytes ?? null,
        sha256: entry?.sha256 ?? null,
      };
    }),
  );
}

function lancedbDigest(files) {
  const entry = fileByPath(files, "graphrag/output/lancedb");
  return digestRows([{
    path: "graphrag/output/lancedb",
    sha256: entry?.sha256 ?? null,
  }]);
}

export function buildRuntimeCompatibility(input) {
  const graphManifest = readJsonOptional(
    join(input.bookRoot, "graphrag", "output", "qmd_output_manifest.json"),
  );
  const parquetArtifacts = [
    "graphrag/output/documents.parquet",
    "graphrag/output/text_units.parquet",
    "graphrag/output/entities.parquet",
    "graphrag/output/relationships.parquet",
    "graphrag/output/communities.parquet",
    "graphrag/output/community_reports.parquet",
  ];
  const schemaDigests = {
    outputManifestSchemaDigest: digestRows([{
      schemaVersion: graphManifest?.schemaVersion ?? null,
      stageFingerprintKeys: Object.keys(graphManifest?.stageFingerprints ?? {}).sort(),
      hasProviderFingerprint: typeof graphManifest?.providerFingerprint === "string",
      hasContentHash: typeof graphManifest?.contentHash === "string",
    }]),
    parquetSchemaDigest: requiredFileDigest(input.files, parquetArtifacts),
    lancedbSchemaDigest: lancedbDigest(input.files),
    artifactMetadataSchemaDigest: digestRows([{
      schemaVersion: SchemaVersion,
      requiredFields: [
        "artifactId",
        "bookId",
        "stage",
        "kind",
        "path",
        "contentHash",
        "fileSha256",
        "bytes",
        "producerRunId",
        "producerStep",
        "producerToolVersion",
        "producerSchemaVersion",
        "upstreamArtifactHashes",
        "createdAt",
      ],
    }]),
  };
  return {
    schemaVersion: SchemaVersion,
    kind: CompatibilityKind,
    bookId: input.bookId,
    packageGeneration: input.packageGeneration,
    generatedAt: input.generatedAt,
    package: {
      packageSchemaVersion: input.packageSchemaVersion,
      layoutVersion: input.layoutVersion,
      qmdIndexSchema: input.qmdIndexSchema,
      graphRagArtifactSchema: input.graphRagArtifactSchema,
      artifactSchema: input.artifactSchema,
    },
    runtime: {
      toolName: "qmd_graphrag",
      toolVersion: input.toolVersion ?? "unknown",
      minQmdGraphRagVersion: input.minQmdGraphRagVersion,
      providerFingerprint: graphManifest?.providerFingerprint,
      embeddingVectorDimension:
        graphManifest?.embeddingVectorDimension ??
        graphManifest?.embeddingDimension ??
        null,
    },
    schemaDigests,
    compatibilityStatus: "compatible",
    diagnostics: [],
  };
}

export function writeRuntimeCompatibility(input) {
  const path = join(input.bookRoot, "graphrag", "output", "runtime-compatibility.json");
  const compatibility = buildRuntimeCompatibility(input);
  if (!existsSync(dirname(path))) return { path, written: false, compatibility };
  writeHotplugJsonWithSidecars(path, compatibility, {
    rootPath: input.rootPath,
    runnerSessionId: input.runnerSessionId ?? "book-hotplug-runtime-compatibility",
    committedAt: input.generatedAt,
  });
  return { path, written: true, compatibility };
}

export function validateRuntimeCompatibility(input) {
  const path = join(input.bookRoot, "graphrag", "output", "runtime-compatibility.json");
  const graphManifest = readJsonOptional(
    join(input.bookRoot, "graphrag", "output", "qmd_output_manifest.json"),
  );
  if (!existsSync(path)) {
    return { ok: false, diagnostics: ["runtime_compatibility_missing"] };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, diagnostics: ["runtime_compatibility_json_invalid"] };
  }
  const diagnostics = [];
  if (parsed?.kind !== CompatibilityKind) {
    diagnostics.push("runtime_compatibility_kind_invalid");
  }
  if (parsed?.bookId !== input.bookId) {
    diagnostics.push("runtime_compatibility_book_mismatch");
  }
  if (parsed?.packageGeneration !== input.packageGeneration) {
    diagnostics.push("runtime_compatibility_generation_mismatch");
  }
  if (parsed?.compatibilityStatus !== "compatible") {
    diagnostics.push("runtime_compatibility_not_compatible");
  }
  if (parsed?.package?.packageSchemaVersion !== input.packageSchemaVersion) {
    diagnostics.push("runtime_compatibility_package_schema_mismatch");
  }
  if (parsed?.package?.layoutVersion !== input.layoutVersion) {
    diagnostics.push("runtime_compatibility_layout_mismatch");
  }
  if (parsed?.package?.qmdIndexSchema !== input.qmdIndexSchema) {
    diagnostics.push("runtime_compatibility_qmd_index_schema_mismatch");
  }
  if (
    parsed?.package?.graphRagArtifactSchema !== input.graphRagArtifactSchema
  ) {
    diagnostics.push("runtime_compatibility_graphrag_artifact_schema_mismatch");
  }
  if (parsed?.package?.artifactSchema !== input.artifactSchema) {
    diagnostics.push("runtime_compatibility_artifact_schema_mismatch");
  }
  if (parsed?.runtime?.minQmdGraphRagVersion !== input.minQmdGraphRagVersion) {
    diagnostics.push("runtime_compatibility_min_runtime_mismatch");
  }
  if (parsed?.runtime?.providerFingerprint !== graphManifest?.providerFingerprint) {
    diagnostics.push("runtime_compatibility_provider_fingerprint_mismatch");
  }
  if (
    (parsed?.runtime?.embeddingVectorDimension ?? null) !==
      graphManifestEmbeddingDimension(graphManifest)
  ) {
    diagnostics.push("runtime_compatibility_embedding_dimension_mismatch");
  }
  for (const field of [
    "outputManifestSchemaDigest",
    "parquetSchemaDigest",
    "lancedbSchemaDigest",
    "artifactMetadataSchemaDigest",
  ]) {
    if (typeof parsed?.schemaDigests?.[field] !== "string") {
      diagnostics.push(`runtime_compatibility_missing_digest:${field}`);
    }
  }
  if (Array.isArray(input.files)) {
    const expected = buildRuntimeCompatibility({
      bookRoot: input.bookRoot,
      bookId: input.bookId,
      packageGeneration: input.packageGeneration,
      generatedAt: parsed?.generatedAt,
      files: input.files,
      packageSchemaVersion: input.packageSchemaVersion,
      layoutVersion: input.layoutVersion,
      qmdIndexSchema: input.qmdIndexSchema,
      graphRagArtifactSchema: input.graphRagArtifactSchema,
      artifactSchema: input.artifactSchema,
      minQmdGraphRagVersion: input.minQmdGraphRagVersion,
      toolVersion: parsed?.runtime?.toolVersion,
    }).schemaDigests;
    for (const field of [
      "outputManifestSchemaDigest",
      "parquetSchemaDigest",
      "lancedbSchemaDigest",
      "artifactMetadataSchemaDigest",
    ]) {
      if (
        typeof parsed?.schemaDigests?.[field] === "string" &&
        parsed.schemaDigests[field] !== expected[field]
      ) {
        diagnostics.push(`runtime_compatibility_digest_mismatch:${field}`);
      }
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}
