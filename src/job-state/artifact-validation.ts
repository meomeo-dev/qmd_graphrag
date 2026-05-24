import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import type {
  BookArtifactKind,
  BookArtifactManifest,
  BookStage,
} from "../contracts/book-job.js";
import { resolveVaultRelativePath } from "../vault/path.js";
import { createDeterministicHash, hashFile } from "./fingerprint.js";
import { hashContent } from "../store.js";

export { resolveVaultRelativePath } from "../vault/path.js";

export const REQUIRED_LANCEDB_TABLES = [
  "entity_description.lance",
  "community_full_content.lance",
  "text_unit_text.lance",
] as const;

export const QUERY_READY_ARTIFACT_KINDS = [
  "graphrag_community_reports_parquet",
  "lancedb_index",
] as const satisfies readonly BookArtifactKind[];

const PRODUCER_STAGE_BY_ARTIFACT_KIND: Partial<Record<BookArtifactKind, BookStage>> = {
  source_epub: "ingest",
  normalized_markdown: "normalize",
  graphrag_documents_parquet: "graph_extract",
  graphrag_text_units_parquet: "graph_extract",
  graphrag_entities_parquet: "graph_extract",
  graphrag_relationships_parquet: "graph_extract",
  graphrag_communities_parquet: "graph_extract",
  graphrag_context_json: "graph_extract",
  graphrag_stats_json: "graph_extract",
  graphrag_community_reports_parquet: "community_report",
  lancedb_index: "embed",
  query_snapshot: "query_ready",
};

export type ArtifactValidationResult = {
  valid: boolean;
  reason?: string;
};

export type BookArtifactSetValidationResult = {
  isSatisfied: boolean;
  missingArtifactIds: string[];
  missingArtifactKinds: BookArtifactKind[];
  validArtifacts: BookArtifactManifest[];
};

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(entryPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

export async function hashDirectoryContents(rootDir: string): Promise<string> {
  const files = await listFilesRecursive(rootDir);
  const payload = await hashFilePayload(rootDir, files);
  return createDeterministicHash(payload);
}

async function hashFilePayload(
  rootDir: string,
  files: readonly string[],
): Promise<Array<{ path: string; hash: string }>> {
  return Promise.all(
    files.map(async (path) => ({
      hash: await hashFile(path),
      path: path.slice(rootDir.length + 1),
    })),
  );
}

export async function hashLanceDbDirectoryContents(rootDir: string): Promise<string> {
  const files: string[] = [];
  for (const tableName of REQUIRED_LANCEDB_TABLES) {
    const tableDir = join(rootDir, tableName);
    const dataDir = join(tableDir, "data");
    const dataFiles = await readdir(dataDir);
    files.push(
      ...dataFiles
        .filter((item) => item.endsWith(".lance"))
        .map((item) => join(dataDir, item)),
      join(tableDir, "qmd_row_count.json"),
    );
  }
  files.sort((left, right) => left.localeCompare(right));
  const payload = await hashFilePayload(rootDir, files);
  return createDeterministicHash(payload);
}

async function hasNonEmptyDataFile(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    return entry.isFile() && entry.size > 0;
  } catch {
    return false;
  }
}

async function validateLanceTable(tableDir: string): Promise<ArtifactValidationResult> {
  const tableEntry = await stat(tableDir);
  if (!tableEntry.isDirectory()) {
    return { valid: false, reason: "lancedb_table_not_directory" };
  }

  const dataFiles = await readdir(join(tableDir, "data"));
  const lanceDataFiles = dataFiles.filter((item) => item.endsWith(".lance"));
  if (lanceDataFiles.length === 0) {
    return { valid: false, reason: "lancedb_table_missing_data" };
  }

  const nonEmptyDataFiles = [];
  for (const fileName of lanceDataFiles) {
    if (await hasNonEmptyDataFile(join(tableDir, "data", fileName))) {
      nonEmptyDataFiles.push(fileName);
    }
  }
  if (nonEmptyDataFiles.length === 0) {
    return { valid: false, reason: "lancedb_table_has_no_non_empty_fragments" };
  }

  const hasRowCountProof = await hasPositiveLanceRowCount(tableDir);
  if (!hasRowCountProof) {
    return { valid: false, reason: "lancedb_table_missing_positive_row_count" };
  }

  return { valid: true };
}

async function hasPositiveLanceRowCount(tableDir: string): Promise<boolean> {
  const sidecarRows = await readLanceRowCountSidecars(tableDir);
  return sidecarRows != null && sidecarRows > 0;
}

async function readLanceRowCountSidecars(tableDir: string): Promise<number | null> {
  try {
    const raw = await readFile(join(tableDir, "qmd_row_count.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const count =
      typeof parsed === "number"
        ? parsed
        : parsed != null &&
            typeof parsed === "object" &&
            "rowCount" in parsed &&
            typeof parsed.rowCount === "number"
          ? parsed.rowCount
          : null;
    if (count != null) return count;
  } catch {
    return null;
  }
  return null;
}

export async function validateLanceDbDirectory(
  path: string,
): Promise<ArtifactValidationResult> {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) {
      return { valid: false, reason: "lancedb_path_not_directory" };
    }

    for (const tableName of REQUIRED_LANCEDB_TABLES) {
      const tableValidation = await validateLanceTable(join(path, tableName));
      if (!tableValidation.valid) {
        return {
          valid: false,
          reason: `${tableName}:${tableValidation.reason}`,
        };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: "lancedb_path_missing_or_unreadable" };
  }
}

export async function isCompleteLanceDbDirectory(path: string): Promise<boolean> {
  return (await validateLanceDbDirectory(path)).valid;
}

function isParquetArtifact(kind: BookArtifactKind): boolean {
  return kind.startsWith("graphrag_") && kind.endsWith("_parquet");
}

async function validateParquetFile(
  path: string,
  size: number,
): Promise<ArtifactValidationResult> {
  if (size < 12) {
    return { valid: false, reason: "parquet_file_too_small" };
  }
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(4);
    const footer = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    await handle.read(footer, 0, 4, size - 4);
    if (header.toString("ascii") !== "PAR1" || footer.toString("ascii") !== "PAR1") {
      return { valid: false, reason: "parquet_magic_mismatch" };
    }
    return { valid: true };
  } finally {
    await handle.close();
  }
}

async function validateJsonObject(path: string): Promise<ArtifactValidationResult> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? { valid: true }
      : { valid: false, reason: "json_artifact_not_object" };
  } catch {
    return { valid: false, reason: "json_artifact_invalid" };
  }
}

export async function validateArtifact(
  graphVault: string,
  artifact: BookArtifactManifest,
): Promise<ArtifactValidationResult> {
  const expectedStage = PRODUCER_STAGE_BY_ARTIFACT_KIND[artifact.kind];
  if (expectedStage != null && artifact.stage !== expectedStage) {
    return {
      valid: false,
      reason: `artifact_stage_mismatch:${artifact.kind}:${artifact.stage}:${expectedStage}`,
    };
  }

  const artifactPath = resolveVaultRelativePath(graphVault, artifact.path);
  if (artifactPath == null) {
    return { valid: false, reason: "path_outside_graph_vault" };
  }

  let artifactStat;
  try {
    artifactStat = await stat(artifactPath);
    const [vaultRealPath, artifactRealPath] = await Promise.all([
      realpath(graphVault),
      realpath(artifactPath),
    ]);
    if (
      artifactRealPath !== vaultRealPath &&
      !artifactRealPath.startsWith(`${vaultRealPath}/`)
    ) {
      return { valid: false, reason: "realpath_outside_graph_vault" };
    }
  } catch {
    return { valid: false, reason: "path_missing" };
  }

  if (artifact.kind === "lancedb_index") {
    const lanceValidation = await validateLanceDbDirectory(artifactPath);
    if (!lanceValidation.valid) {
      return lanceValidation;
    }
  }

  const actualHash = artifact.kind === "lancedb_index"
    ? await hashLanceDbDirectoryContents(artifactPath)
    : artifact.kind === "normalized_markdown"
      ? await hashContent(
          await readFile(artifactPath, "utf8"),
          artifact.normalizationPolicyVersion,
        )
    : artifactStat.isDirectory()
      ? await hashDirectoryContents(artifactPath)
      : await hashFile(artifactPath);
  if (actualHash !== artifact.contentHash) {
    return { valid: false, reason: "content_hash_mismatch" };
  }

  if (isParquetArtifact(artifact.kind)) {
    if (!artifactStat.isFile() || artifactStat.size === 0) {
      return { valid: false, reason: "parquet_file_empty_or_not_file" };
    }
    const parquetValidation = await validateParquetFile(
      artifactPath,
      artifactStat.size,
    );
    if (!parquetValidation.valid) return parquetValidation;
  }

  if (
    artifact.kind === "graphrag_context_json" ||
    artifact.kind === "graphrag_stats_json"
  ) {
    const jsonValidation = await validateJsonObject(artifactPath);
    if (!jsonValidation.valid) {
      return jsonValidation;
    }
  }

  return { valid: true };
}

export async function validateBookArtifactSet(input: {
  graphVault: string;
  bookId: string;
  artifactIds: readonly string[];
  artifacts: readonly BookArtifactManifest[];
  requiredKinds?: readonly BookArtifactKind[];
  allowedKinds?: readonly BookArtifactKind[];
  requireBookScopedGraphOutput?: boolean;
  expectedProducerRunIds?: Partial<Record<BookStage, string>>;
  expectedStageFingerprints?: Partial<Record<BookStage, string>>;
  expectedProviderFingerprint?: string;
  expectedCorpusContentHash?: string;
}): Promise<BookArtifactSetValidationResult> {
  const requiredKinds = input.requiredKinds ?? [];
  const allowedKinds = input.allowedKinds == null
    ? null
    : new Set(input.allowedKinds);
  const artifactById = new Map(
    input.artifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
  const missingArtifactIds: string[] = [];
  const validArtifacts: BookArtifactManifest[] = [];

  for (const artifactId of input.artifactIds) {
    const artifact = artifactById.get(artifactId);
    if (artifact == null || artifact.bookId !== input.bookId) {
      missingArtifactIds.push(artifactId);
      continue;
    }
    if (allowedKinds != null && !allowedKinds.has(artifact.kind)) {
      missingArtifactIds.push(artifactId);
      continue;
    }
    if (
      input.requireBookScopedGraphOutput === true &&
      !isBookScopedGraphOutputArtifact(input.bookId, artifact)
    ) {
      missingArtifactIds.push(artifactId);
      continue;
    }
    const expectedProducerRunId = input.expectedProducerRunIds?.[artifact.stage];
    if (
      expectedProducerRunId != null &&
      artifact.producerRunId !== expectedProducerRunId
    ) {
      missingArtifactIds.push(artifactId);
      continue;
    }
    const expectedStageFingerprint = input.expectedStageFingerprints?.[artifact.stage];
    if (
      expectedStageFingerprint != null &&
      artifact.stageFingerprint !== expectedStageFingerprint
    ) {
      missingArtifactIds.push(artifactId);
      continue;
    }
    if (
      input.expectedProviderFingerprint != null &&
      artifact.providerFingerprint !== input.expectedProviderFingerprint
    ) {
      missingArtifactIds.push(artifactId);
      continue;
    }
    if (
      input.expectedCorpusContentHash != null &&
      (artifact.kind.startsWith("graphrag_") || artifact.kind === "lancedb_index") &&
      artifact.metadata?.corpusContentHash !== input.expectedCorpusContentHash
    ) {
      missingArtifactIds.push(artifactId);
      continue;
    }

    const validation = await validateArtifact(input.graphVault, artifact);
    if (!validation.valid) {
      missingArtifactIds.push(artifactId);
      continue;
    }

    validArtifacts.push(artifact);
  }

  const validKinds = new Set(validArtifacts.map((artifact) => artifact.kind));
  const missingArtifactKinds = requiredKinds.filter(
    (kind) => !validKinds.has(kind),
  );

  return {
    isSatisfied: missingArtifactIds.length === 0 &&
      missingArtifactKinds.length === 0,
    missingArtifactIds: [...new Set(missingArtifactIds)],
    missingArtifactKinds,
    validArtifacts,
  };
}

function isBookScopedGraphOutputArtifact(
  bookId: string,
  artifact: BookArtifactManifest,
): boolean {
  const base = `books/${bookId}/output`;
  if (artifact.kind === "lancedb_index") {
    return artifact.path === `${base}/lancedb`;
  }
  if (
    artifact.kind === "graphrag_community_reports_parquet" ||
    artifact.kind.startsWith("graphrag_")
  ) {
    return artifact.path.startsWith(`${base}/`);
  }
  return true;
}
