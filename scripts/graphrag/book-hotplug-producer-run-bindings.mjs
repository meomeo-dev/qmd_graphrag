import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

const SchemaVersion = "1.0.0";
const BookStages = [
  "ingest",
  "normalize",
  "graph_extract",
  "community_report",
  "embed",
  "query_ready",
];
const StageStatuses = ["pending", "running", "succeeded", "failed", "abandoned"];

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readYaml(path) {
  return YAML.parse(readFileSync(path, "utf8"));
}

function metadataString(metadata, key) {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataArray(metadata, key) {
  const value = metadata?.[key];
  return Array.isArray(value) ? value : [];
}

function isRunTrackedArtifactId(artifactId) {
  return !String(artifactId).startsWith("manifest-derived:");
}

function isManifestDerivedRow(row) {
  return typeof row.artifactId === "string" &&
    row.artifactId.startsWith("manifest-derived:");
}

function isValidProducerRunRecord(run) {
  return run != null &&
    typeof run === "object" &&
    run.schemaVersion === SchemaVersion &&
    typeof run.runId === "string" &&
    run.runId.length > 0 &&
    typeof run.bookId === "string" &&
    run.bookId.length > 0 &&
    typeof run.stage === "string" &&
    BookStages.includes(run.stage) &&
    typeof run.status === "string" &&
    StageStatuses.includes(run.status) &&
    Number.isInteger(run.attemptCount) &&
    run.attemptCount >= 0 &&
    typeof run.startedAt === "string" &&
    run.startedAt.length > 0 &&
    typeof run.inputFingerprint === "string" &&
    run.inputFingerprint.length > 0 &&
    Array.isArray(run.artifactIds) &&
    run.artifactIds.every((artifactId) =>
      typeof artifactId === "string" && artifactId.length > 0
    );
}

function refreshBindingKey(input) {
  return `${input.stage}\0${input.artifactKind}\0${input.checksum}`;
}

function refreshedArtifactBindingKeys(records) {
  const keys = new Set();
  for (const record of records) {
    for (const item of metadataArray(record.metadata, "durableOutputRefresh")) {
      if (item == null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      if (
        typeof item.stage !== "string" ||
        typeof item.artifactKind !== "string" ||
        typeof item.checksum !== "string"
      ) {
        continue;
      }
      keys.add(refreshBindingKey({
        stage: item.stage,
        artifactKind: item.artifactKind,
        checksum: item.checksum,
      }));
    }
  }
  return keys;
}

function rowCoveredByDurableRefresh(row, refreshKeys) {
  if (
    typeof row.stage !== "string" ||
    typeof row.kind !== "string" ||
    row.stage.length === 0 ||
    row.kind.length === 0
  ) {
    return false;
  }
  const checksums = [row.fileSha256, row.contentHash]
    .filter((checksum) => typeof checksum === "string" && checksum.length > 0);
  return checksums.some((checksum) =>
    refreshKeys.has(refreshBindingKey({
      stage: row.stage,
      artifactKind: row.kind,
      checksum,
    }))
  );
}

function loadProducerRunRecords(input) {
  const diagnostics = [];
  const records = new Map();
  for (const runId of input.producerRunIds ?? []) {
    const path = join(input.bookRoot, "graphrag", "runs", `${runId}.yaml`);
    const stats = existsSync(path) ? safeStat(path) : null;
    if (!stats?.isFile()) {
      diagnostics.push(`missing_producer_run:${runId}`);
      continue;
    }
    let run;
    try {
      run = readYaml(path);
    } catch {
      diagnostics.push(`producer_run_record_invalid:${runId}`);
      continue;
    }
    if (!isValidProducerRunRecord(run)) {
      diagnostics.push(`producer_run_record_invalid:${runId}`);
      continue;
    }
    if (run.runId !== runId) diagnostics.push(`producer_run_record_invalid:${runId}`);
    if (run.bookId !== input.bookId) {
      diagnostics.push(`producer_run_book_mismatch:${runId}`);
    }
    if (run.status !== "succeeded") {
      diagnostics.push(`producer_run_status_not_succeeded:${runId}`);
    }
    records.set(runId, run);
  }
  return { records, diagnostics };
}

export function validateHotplugProducerRunBindings(input) {
  const { records, diagnostics } = loadProducerRunRecords(input);
  const rowsByRunId = new Map();
  for (const row of input.rows ?? []) {
    if (typeof row?.producerRunId !== "string" || row.producerRunId.length === 0) {
      continue;
    }
    const current = rowsByRunId.get(row.producerRunId) ?? [];
    current.push(row);
    rowsByRunId.set(row.producerRunId, current);
  }
  const refreshKeys = refreshedArtifactBindingKeys(records.values());

  for (const [runId, run] of records) {
    const rows = rowsByRunId.get(runId) ?? [];
    const rowArtifactIds = rows
      .filter((row) => !rowCoveredByDurableRefresh(row, refreshKeys))
      .map((row) => row.artifactId)
      .filter((artifactId) =>
        typeof artifactId === "string" &&
        artifactId.length > 0 &&
        isRunTrackedArtifactId(artifactId)
      );
    const runArtifactIds = new Set(run.artifactIds);
    if (
      rowArtifactIds.length > 0 &&
      !rowArtifactIds.every((artifactId) => runArtifactIds.has(artifactId))
    ) {
      diagnostics.push(`producer_run_artifact_binding_mismatch:${runId}`);
    }

    const runStageFingerprint =
      metadataString(run.metadata, "stageFingerprint") ?? run.inputFingerprint;
    const runProviderFingerprint =
      metadataString(run.metadata, "providerFingerprint") ??
      input.providerFingerprint;
    for (const row of rows) {
      const historicalDerivedStepFallback =
        isManifestDerivedRow(row) &&
        row.stage === run.stage;
      if (row.producerStep !== run.stage && !historicalDerivedStepFallback) {
        diagnostics.push(`producer_run_stage_mismatch:${runId}`);
      }
      if (
        !isManifestDerivedRow(row) &&
        typeof row.stageFingerprint === "string" &&
        row.stageFingerprint !== runStageFingerprint
      ) {
        diagnostics.push(`producer_run_stage_fingerprint_mismatch:${runId}`);
      }
      if (
        runProviderFingerprint != null &&
        typeof row.providerFingerprint === "string" &&
        row.providerFingerprint !== runProviderFingerprint
      ) {
        diagnostics.push(`producer_run_provider_fingerprint_mismatch:${runId}`);
      }
    }
  }
  return diagnostics;
}
