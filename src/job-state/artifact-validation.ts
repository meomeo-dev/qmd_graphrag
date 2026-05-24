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
    const footerLengthBytes = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    await handle.read(footerLengthBytes, 0, 4, size - 8);
    await handle.read(footer, 0, 4, size - 4);
    if (header.toString("ascii") !== "PAR1" || footer.toString("ascii") !== "PAR1") {
      return { valid: false, reason: "parquet_magic_mismatch" };
    }
    const footerLength = footerLengthBytes.readUInt32LE(0);
    if (footerLength <= 0 || footerLength > size - 12) {
      return { valid: false, reason: "parquet_footer_length_invalid" };
    }
    const metadata = Buffer.alloc(footerLength);
    await handle.read(metadata, 0, footerLength, size - 8 - footerLength);
    const numRows = readParquetMetadataNumRows(metadata);
    if (numRows == null) {
      return { valid: false, reason: "parquet_metadata_unreadable" };
    }
    if (numRows <= 0n) {
      return { valid: false, reason: "parquet_row_count_empty" };
    }
    return { valid: true };
  } finally {
    await handle.close();
  }
}

function readParquetMetadataNumRows(metadata: Buffer): bigint | null {
  let offset = 0;
  let fieldId = 0;
  while (offset < metadata.length) {
    const header = readCompactVarInt(metadata, offset);
    if (header == null) return null;
    offset = header.offset;
    const type = header.value & 0x0f;
    const fieldDelta = header.value >> 4;
    if (type === 0) return null;
    if (fieldDelta > 0) {
      fieldId += fieldDelta;
    } else {
      const explicitFieldId = readCompactZigZagInt(metadata, offset);
      if (explicitFieldId == null) return null;
      offset = explicitFieldId.offset;
      fieldId = explicitFieldId.value;
    }
    if (fieldId === 3 && type === 6) {
      const numRows = readCompactZigZagLong(metadata, offset);
      return numRows?.value ?? null;
    }
    const skipped = skipCompactThriftValue(metadata, offset, type);
    if (skipped == null) return null;
    offset = skipped;
  }
  return null;
}

function readCompactVarInt(
  buffer: Buffer,
  offset: number,
): { value: number; offset: number } | null {
  let result = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length && shift <= 28) {
    const byte = buffer[cursor]!;
    cursor += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset: cursor };
    shift += 7;
  }
  return null;
}

function readCompactZigZagInt(
  buffer: Buffer,
  offset: number,
): { value: number; offset: number } | null {
  const raw = readCompactVarInt(buffer, offset);
  if (raw == null) return null;
  return { value: (raw.value >>> 1) ^ -(raw.value & 1), offset: raw.offset };
}

function readCompactZigZagLong(
  buffer: Buffer,
  offset: number,
): { value: bigint; offset: number } | null {
  let result = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length && shift <= 63n) {
    const byte = BigInt(buffer[cursor]!);
    cursor += 1;
    result |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) {
      const value = (result >> 1n) ^ -(result & 1n);
      return { value, offset: cursor };
    }
    shift += 7n;
  }
  return null;
}

function skipCompactThriftValue(
  buffer: Buffer,
  offset: number,
  type: number,
): number | null {
  if (type === 1 || type === 2) return offset;
  if (type === 3) return offset + 1 <= buffer.length ? offset + 1 : null;
  if (type === 4 || type === 5 || type === 6) {
    return readCompactVarInt(buffer, offset)?.offset ?? null;
  }
  if (type === 7) return offset + 8 <= buffer.length ? offset + 8 : null;
  if (type === 8) {
    const length = readCompactVarInt(buffer, offset);
    if (length == null) return null;
    const next = length.offset + length.value;
    return next <= buffer.length ? next : null;
  }
  if (type === 9 || type === 10) {
    const header = readCompactVarInt(buffer, offset);
    if (header == null) return null;
    const elementType = header.value & 0x0f;
    const size = header.value >> 4;
    let cursor = header.offset;
    const actualSize = size === 15
      ? readCompactVarInt(buffer, cursor)
      : { value: size, offset: cursor };
    if (actualSize == null) return null;
    cursor = actualSize.offset;
    for (let index = 0; index < actualSize.value; index += 1) {
      const skipped = skipCompactThriftValue(buffer, cursor, elementType);
      if (skipped == null) return null;
      cursor = skipped;
    }
    return cursor;
  }
  if (type === 11) {
    const size = readCompactVarInt(buffer, offset);
    if (size == null) return null;
    let cursor = size.offset;
    if (size.value === 0) return cursor;
    if (cursor >= buffer.length) return null;
    const typeByte = buffer[cursor]!;
    cursor += 1;
    const keyType = typeByte >> 4;
    const valueType = typeByte & 0x0f;
    for (let index = 0; index < size.value; index += 1) {
      const keySkipped = skipCompactThriftValue(buffer, cursor, keyType);
      if (keySkipped == null) return null;
      const valueSkipped = skipCompactThriftValue(buffer, keySkipped, valueType);
      if (valueSkipped == null) return null;
      cursor = valueSkipped;
    }
    return cursor;
  }
  if (type === 12) {
    let cursor = offset;
    while (cursor < buffer.length) {
      const header = readCompactVarInt(buffer, cursor);
      if (header == null) return null;
      cursor = header.offset;
      const nestedType = header.value & 0x0f;
      if (nestedType === 0) return cursor;
      if ((header.value >> 4) === 0) {
        const fieldId = readCompactZigZagInt(buffer, cursor);
        if (fieldId == null) return null;
        cursor = fieldId.offset;
      }
      const skipped = skipCompactThriftValue(buffer, cursor, nestedType);
      if (skipped == null) return null;
      cursor = skipped;
    }
    return null;
  }
  if (type === 13) return offset + 4 <= buffer.length ? offset + 4 : null;
  return null;
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
