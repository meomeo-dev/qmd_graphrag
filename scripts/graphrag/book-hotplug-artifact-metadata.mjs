import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import YAML from "yaml";

import {
  writeHotplugJsonWithSidecars,
} from "./book-hotplug-json-sidecars.mjs";

const SchemaVersion = "1.0.0";
const ArtifactMetadataKind = "qmd_graphrag_artifact_metadata";

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

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readYaml(path) {
  return YAML.parse(readFileSync(path, "utf8"));
}

function fileEntryByPath(files) {
  return new Map((files ?? []).map((entry) => [entry.path, entry]));
}

function readJsonOptional(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function derivedRequiredArtifactKind(path) {
  if (path.endsWith("/qmd_output_manifest.json")) {
    return "graphrag_output_manifest";
  }
  if (path.endsWith("/qmd_graph_text_unit_identity.json")) {
    return "graphrag_identity_map";
  }
  return "graphrag_required_file";
}

function producerStepForKind(kind) {
  if (kind === "graphrag_community_reports_parquet") return "community_report";
  if (kind === "lancedb_index") return "embed";
  return "graph_extract";
}

function upstreamHashesForRow(graphManifest, fileEntry, producerStep) {
  return [
    graphManifest?.contentHash,
    graphManifest?.stageFingerprints?.[producerStep],
    fileEntry?.sha256,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

function derivedRowsFromRequiredArtifacts(input, existingRows) {
  const filesByPath = fileEntryByPath(input.files);
  const existingPaths = new Set(existingRows.map((row) => row.path));
  const graphManifest = readJsonOptional(
    join(input.bookRoot, "graphrag", "output", "qmd_output_manifest.json"),
  );
  const rows = [];
  for (const path of input.requiredArtifacts ?? []) {
    if (path === "graphrag/output/artifact-metadata.json") continue;
    if (existingPaths.has(path)) continue;
    const fileEntry = filesByPath.get(path);
    if (fileEntry == null) continue;
    const kind = derivedRequiredArtifactKind(path);
    const producerStep = "query_ready";
    rows.push({
      schemaVersion: SchemaVersion,
      artifactId: `manifest-derived:${path}`,
      bookId: input.bookId,
      stage: "query_ready",
      kind,
      path,
      contentHash: fileEntry.sha256,
      fileSha256: fileEntry.sha256,
      bytes: fileEntry.bytes,
      required: fileEntry.required !== false,
      producerRunId: graphManifest?.producerRunId,
      producerStep,
      producerToolVersion: input.toolVersion ?? "unknown",
      producerSchemaVersion: SchemaVersion,
      stageFingerprint: graphManifest?.stageFingerprints?.query_ready,
      providerFingerprint: graphManifest?.providerFingerprint,
      corpusContentHash: graphManifest?.contentHash,
      upstreamArtifactHashes: upstreamHashesForRow(
        graphManifest,
        fileEntry,
        producerStep,
      ),
      createdAt: input.generatedAt,
    });
  }
  return rows;
}

function artifactRowsFromState(input) {
  const artifactsPath = join(input.bookRoot, "state", "artifacts.yaml");
  if (!existsSync(artifactsPath)) return [];
  const parsed = readYaml(artifactsPath);
  const filesByPath = fileEntryByPath(input.files);
  const rows = [];
  for (const artifact of parsed?.items ?? []) {
    if (artifact == null || typeof artifact !== "object") continue;
    if (artifact.bookId !== input.bookId) continue;
    const path = normalizeRelativePath(artifact.path);
    if (path == null || !path.startsWith(`books/${input.bookId}/`)) continue;
    const packagePath = path.replace(`books/${input.bookId}/`, "");
    if (!packagePath.startsWith("graphrag/output/")) continue;
    const fileEntry = filesByPath.get(packagePath);
    rows.push({
      schemaVersion: SchemaVersion,
      artifactId: artifact.artifactId,
      bookId: input.bookId,
      stage: artifact.stage,
      kind: artifact.kind,
      path: packagePath,
      contentHash: artifact.contentHash,
      fileSha256: fileEntry?.sha256,
      bytes: fileEntry?.bytes,
      required: fileEntry?.required !== false,
      producerRunId: artifact.producerRunId,
      producerStep: artifact.stage,
      producerToolVersion: artifact.metadata?.toolVersion ?? input.toolVersion ?? "unknown",
      producerSchemaVersion: artifact.schemaVersion ?? SchemaVersion,
      stageFingerprint: artifact.stageFingerprint,
      providerFingerprint: artifact.providerFingerprint,
      corpusContentHash: artifact.metadata?.corpusContentHash,
      upstreamArtifactHashes: [
        artifact.metadata?.corpusContentHash,
        artifact.stageFingerprint,
        fileEntry?.sha256,
      ].filter((value) => typeof value === "string" && value.length > 0),
      createdAt: artifact.createdAt,
    });
  }
  return rows;
}

export function buildArtifactMetadata(input) {
  const stateRows = artifactRowsFromState(input);
  const rows = [
    ...stateRows,
    ...derivedRowsFromRequiredArtifacts(input, stateRows),
  ].sort((left, right) =>
    String(left.artifactId).localeCompare(String(right.artifactId))
  );
  const closureDigest = sha256Text(JSON.stringify(rows, null, 2) + "\n");
  return {
    schemaVersion: SchemaVersion,
    kind: ArtifactMetadataKind,
    bookId: input.bookId,
    packageGeneration: input.packageGeneration,
    generatedAt: input.generatedAt,
    artifactCount: rows.length,
    closureDigest,
    rows,
  };
}

export function writeArtifactMetadata(input) {
  const path = join(input.bookRoot, "graphrag", "output", "artifact-metadata.json");
  const metadata = buildArtifactMetadata(input);
  if (!existsSync(dirname(path))) return { path, written: false, metadata };
  writeHotplugJsonWithSidecars(path, metadata, {
    rootPath: input.rootPath,
    runnerSessionId: input.runnerSessionId ?? "book-hotplug-artifact-metadata",
    committedAt: input.generatedAt,
  });
  return { path, written: true, metadata };
}

export function validateArtifactMetadata(input) {
  const diagnostics = [];
  const path = join(input.bookRoot, "graphrag", "output", "artifact-metadata.json");
  if (!existsSync(path)) {
    return { ok: false, diagnostics: ["artifact_metadata_missing"] };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, diagnostics: ["artifact_metadata_json_invalid"] };
  }
  if (parsed?.kind !== ArtifactMetadataKind) {
    diagnostics.push("artifact_metadata_kind_invalid");
  }
  if (parsed?.bookId !== input.bookId) diagnostics.push("artifact_metadata_book_mismatch");
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const rowsByPath = new Map(rows.map((row) => [row.path, row]));
  const rowsByArtifactId = new Map(rows.map((row) => [row.artifactId, row]));
  const rowsByRun = new Map();
  for (const row of rows) {
    if (typeof row?.producerRunId === "string") {
      const current = rowsByRun.get(row.producerRunId) ?? [];
      current.push(row);
      rowsByRun.set(row.producerRunId, current);
    }
  }
  const metadataPath = "graphrag/output/artifact-metadata.json";
  for (const requiredPath of input.requiredArtifacts ?? []) {
    if (requiredPath === metadataPath) continue;
    const row = rowsByPath.get(requiredPath);
    if (row == null) {
      diagnostics.push(`artifact_metadata_missing_row:${requiredPath}`);
      continue;
    }
    if (typeof row.producerRunId !== "string" || row.producerRunId.length === 0) {
      diagnostics.push(`artifact_metadata_missing_producer:${requiredPath}`);
    }
    if (typeof row.producerStep !== "string" || row.producerStep.length === 0) {
      diagnostics.push(`artifact_metadata_missing_producer_step:${requiredPath}`);
    }
    if (
      typeof row.producerToolVersion !== "string" ||
      row.producerToolVersion.length === 0
    ) {
      diagnostics.push(`artifact_metadata_missing_tool_version:${requiredPath}`);
    }
    if (
      typeof row.producerSchemaVersion !== "string" ||
      row.producerSchemaVersion.length === 0
    ) {
      diagnostics.push(`artifact_metadata_missing_schema_version:${requiredPath}`);
    }
    if (!Array.isArray(row.upstreamArtifactHashes) ||
      row.upstreamArtifactHashes.length === 0) {
      diagnostics.push(`artifact_metadata_missing_upstream_hash:${requiredPath}`);
    }
    if (typeof row.createdAt !== "string" || row.createdAt.length === 0) {
      diagnostics.push(`artifact_metadata_missing_created_at:${requiredPath}`);
    }
    if (
      typeof row.stageFingerprint !== "string" ||
      row.stageFingerprint.length === 0
    ) {
      diagnostics.push(`artifact_metadata_missing_stage_fingerprint:${requiredPath}`);
    }
    if (
      typeof row.providerFingerprint !== "string" ||
      row.providerFingerprint.length === 0
    ) {
      diagnostics.push(`artifact_metadata_missing_provider_fingerprint:${requiredPath}`);
    }
    const fileEntry = (input.files ?? []).find((entry) => entry.path === requiredPath);
    if (fileEntry != null && row.fileSha256 !== fileEntry.sha256) {
      diagnostics.push(`artifact_metadata_file_sha_mismatch:${requiredPath}`);
    }
    const stat = existsSync(join(input.bookRoot, requiredPath))
      ? statSync(join(input.bookRoot, requiredPath))
      : null;
    if (stat?.isFile() && row.bytes !== stat.size) {
      diagnostics.push(`artifact_metadata_bytes_mismatch:${requiredPath}`);
    }
  }
  for (const runId of input.producerRunIds ?? []) {
    if (rowsByRun.has(runId)) continue;
    const runPath = join(input.bookRoot, "graphrag", "runs", `${runId}.yaml`);
    const run = existsSync(runPath) ? readYaml(runPath) : null;
    const runArtifacts = Array.isArray(run?.artifactIds) ? run.artifactIds : [];
    const runArtifactsCovered = runArtifacts.length > 0 &&
      runArtifacts.every((artifactId) => rowsByArtifactId.has(artifactId));
    if (!runArtifactsCovered) {
      diagnostics.push(`artifact_metadata_missing_run_binding:${runId}`);
    }
  }
  const expectedDigest = sha256Text(
    JSON.stringify(rows, null, 2) + "\n",
  );
  if (parsed?.closureDigest !== expectedDigest) {
    diagnostics.push("artifact_metadata_closure_digest_mismatch");
  }
  return { ok: diagnostics.length === 0, diagnostics };
}
