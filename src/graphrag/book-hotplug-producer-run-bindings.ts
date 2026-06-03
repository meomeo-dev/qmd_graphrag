import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { BookJobRunRecordSchema } from "../contracts/book-job.js";
import { readHotplugPackageUnknown } from "./book-hotplug-package-readonly.js";

type ProducerRunRecord = z.infer<typeof BookJobRunRecordSchema>;

export type HotplugArtifactMetadataRow = {
  artifactId?: string;
  stage?: string;
  kind?: string;
  contentHash?: string;
  fileSha256: string;
  producerRunId: string;
  producerStep: string;
  stageFingerprint?: string;
  providerFingerprint?: string;
};

function metadataString(metadata: Record<string, unknown> | undefined, key: string):
  string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRunTrackedArtifactId(artifactId: string): boolean {
  return !artifactId.startsWith("manifest-derived:");
}

function isManifestDerivedRow(row: HotplugArtifactMetadataRow): boolean {
  return typeof row.artifactId === "string" &&
    row.artifactId.startsWith("manifest-derived:");
}

function metadataArray(metadata: Record<string, unknown> | undefined, key: string):
  unknown[] {
  const value = metadata?.[key];
  return Array.isArray(value) ? value : [];
}

function refreshBindingKey(input: {
  stage: string;
  artifactKind: string;
  checksum: string;
}): string {
  return `${input.stage}\0${input.artifactKind}\0${input.checksum}`;
}

function refreshedArtifactBindingKeys(
  records: Iterable<ProducerRunRecord>,
): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    for (const item of metadataArray(record.metadata, "durableOutputRefresh")) {
      if (item == null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const refresh = item as Record<string, unknown>;
      if (
        typeof refresh.stage !== "string" ||
        typeof refresh.artifactKind !== "string" ||
        typeof refresh.checksum !== "string"
      ) {
        continue;
      }
      keys.add(refreshBindingKey({
        stage: refresh.stage,
        artifactKind: refresh.artifactKind,
        checksum: refresh.checksum,
      }));
    }
  }
  return keys;
}

function rowCoveredByDurableRefresh(
  row: HotplugArtifactMetadataRow,
  refreshKeys: Set<string>,
): boolean {
  if (
    typeof row.stage !== "string" ||
    typeof row.kind !== "string" ||
    row.stage.length === 0 ||
    row.kind.length === 0
  ) {
    return false;
  }
  const checksums = [row.fileSha256, row.contentHash]
    .filter((checksum): checksum is string =>
      typeof checksum === "string" && checksum.length > 0
    );
  return checksums.some((checksum) =>
    refreshKeys.has(refreshBindingKey({
      stage: row.stage!,
      artifactKind: row.kind!,
      checksum,
    }))
  );
}

async function loadProducerRunRecords(input: {
  bookRoot: string;
  bookId: string;
  producerRunIds: readonly string[];
}): Promise<{
  records: Map<string, ProducerRunRecord>;
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  const records = new Map<string, ProducerRunRecord>();
  for (const runId of input.producerRunIds) {
    const path = join(input.bookRoot, "graphrag", "runs", `${runId}.yaml`);
    const stats = existsSync(path) ? statSync(path) : null;
    if (!stats?.isFile()) {
      diagnostics.push(`missing_producer_run:${runId}`);
      continue;
    }
    const parsed = await readHotplugPackageUnknown(path);
    const runResult = BookJobRunRecordSchema.safeParse(parsed);
    if (!runResult.success) {
      diagnostics.push(`producer_run_record_invalid:${runId}`);
      continue;
    }
    const run = runResult.data;
    if (run.runId !== runId) {
      diagnostics.push(`producer_run_record_invalid:${runId}`);
    }
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

export async function validateHotplugProducerRunBindings(input: {
  bookRoot: string;
  bookId: string;
  producerRunIds: readonly string[];
  rows: readonly HotplugArtifactMetadataRow[];
  providerFingerprint?: string;
}): Promise<string[]> {
  const { records, diagnostics } = await loadProducerRunRecords(input);
  const rowsByRunId = new Map<string, HotplugArtifactMetadataRow[]>();
  for (const row of input.rows) {
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
      .filter((artifactId): artifactId is string =>
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
