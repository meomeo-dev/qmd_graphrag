import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  BookArtifactKind,
  BookArtifactManifest,
  BookStage,
} from "../contracts/book-job.js";
import { resolveVaultRelativePath } from "../vault/path.js";
import {
  bookScopedGraphOutputBases,
} from "../graphrag/book-package-layout.js";
import { createDeterministicHash, hashFile } from "./fingerprint.js";
import { hashContent } from "../store.js";
import {
  DurableStateError,
  readJsonFileDurable,
} from "./durable-json.js";

export { resolveVaultRelativePath } from "../vault/path.js";

export const REQUIRED_LANCEDB_TABLES = [
  "entity_description.lance",
  "community_full_content.lance",
  "text_unit_text.lance",
] as const;

export const GRAPH_EXTRACT_CORE_ARTIFACT_KINDS = [
  "graphrag_documents_parquet",
  "graphrag_text_units_parquet",
  "graphrag_entities_parquet",
  "graphrag_relationships_parquet",
  "graphrag_communities_parquet",
  "graphrag_context_json",
  "graphrag_stats_json",
] as const satisfies readonly BookArtifactKind[];

export const GRAPH_EXTRACT_ARTIFACT_KINDS = [
  ...GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
] as const satisfies readonly BookArtifactKind[];

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
  invalidArtifacts: Array<{
    artifactId: string;
    kind: BookArtifactKind;
    path: string;
    reason: string;
  }>;
  validArtifacts: BookArtifactManifest[];
};

export type BookArtifactKindSelectionResult = BookArtifactSetValidationResult & {
  artifactIds: string[];
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
    await readLanceRowCountSidecars(tableDir);
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

  let hasRowCountProof = false;
  try {
    hasRowCountProof = await hasPositiveLanceRowCount(tableDir);
  } catch (error) {
    if (error instanceof DurableStateError) {
      return { valid: false, reason: "lancedb_table_missing_positive_row_count" };
    }
    throw error;
  }
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
    const parsed = await readJsonFileDurable(join(tableDir, "qmd_row_count.json"));
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
  } catch (error) {
    if (error instanceof DurableStateError) throw error;
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
    const rowCount = readParquetRowCount(path);
    if (rowCount == null) {
      return { valid: false, reason: "parquet_metadata_unreadable" };
    }
    if (rowCount <= 0) return { valid: false, reason: "parquet_row_count_empty" };
    return { valid: true };
  } finally {
    await handle.close();
  }
}

function readParquetRowCount(path: string): number | null {
  try {
    const file = existsSync(path) ? readFileSync(path) : null;
    if (file == null) return null;
    const footerLength = file.readUInt32LE(file.length - 8);
    const footer = file.subarray(file.length - 8 - footerLength, file.length - 8);
    return readParquetFooterNumRows(footer);
  } catch {
    return null;
  }
}

function readParquetFooterNumRows(buffer: Buffer): number | null {
  const reader = createCompactReader(buffer);
  let previousFieldId = 0;
  while (!reader.eof()) {
    const header = reader.readByte();
    const type = header & 0x0f;
    if (type === 0) return null;
    const delta = header >> 4;
    const fieldId = delta === 0
      ? reader.readZigZagVarint()
      : previousFieldId + delta;
    previousFieldId = fieldId;
    if (fieldId === 3 && type === 6) {
      return reader.readZigZagVarint();
    }
    reader.skip(type);
  }
  return null;
}

function createCompactReader(buffer: Buffer) {
  let offset = 0;
  const readByte = () => {
    if (offset >= buffer.length) {
      throw new Error("parquet compact metadata ended unexpectedly");
    }
    const value = buffer[offset];
    if (value == null) {
      throw new Error("parquet compact metadata ended unexpectedly");
    }
    offset += 1;
    return value;
  };
  const readVarint = () => {
    let shift = 0;
    let value = 0;
    for (;;) {
      const byte = readByte();
      value += (byte & 0x7f) * (2 ** shift);
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 63) throw new Error("parquet compact varint too large");
    }
  };
  const readZigZagVarint = () => {
    const value = readVarint();
    return Math.floor(value / 2) ^ -(value % 2);
  };
  const skip = (type: number): void => {
    switch (type) {
      case 0:
      case 1:
      case 2:
        return;
      case 3:
        offset += 1;
        return;
      case 4:
      case 5:
      case 6:
        readVarint();
        return;
      case 7:
        offset += 8;
        return;
      case 8: {
        const length = readVarint();
        offset += length;
        return;
      }
      case 9:
      case 10: {
        const header = readByte();
        const elementType = header & 0x0f;
        const inlineSize = header >> 4;
        const size = inlineSize === 15 ? readVarint() : inlineSize;
        for (let index = 0; index < size; index += 1) skip(elementType);
        return;
      }
      case 11: {
        const size = readVarint();
        if (size === 0) return;
        const types = readByte();
        const keyType = types >> 4;
        const valueType = types & 0x0f;
        for (let index = 0; index < size; index += 1) {
          skip(keyType);
          skip(valueType);
        }
        return;
      }
      case 12: {
        let previousFieldId = 0;
        for (;;) {
          const header = readByte();
          const fieldType = header & 0x0f;
          if (fieldType === 0) return;
          const delta = header >> 4;
          previousFieldId = delta === 0
            ? readZigZagVarint()
            : previousFieldId + delta;
          skip(fieldType);
        }
      }
      default:
        throw new Error(`unsupported parquet compact type: ${type}`);
    }
  };
  return {
    eof: () => offset >= buffer.length,
    readByte,
    readZigZagVarint,
    skip,
  };
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
  const invalidArtifacts: BookArtifactSetValidationResult["invalidArtifacts"] = [];
  const validArtifacts: BookArtifactManifest[] = [];
  const recordInvalid = (artifact: BookArtifactManifest, reason: string) => {
    missingArtifactIds.push(artifact.artifactId);
    invalidArtifacts.push({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      path: artifact.path,
      reason,
    });
  };

  for (const artifactId of input.artifactIds) {
    const artifact = artifactById.get(artifactId);
    if (artifact == null || artifact.bookId !== input.bookId) {
      missingArtifactIds.push(artifactId);
      continue;
    }
    if (allowedKinds != null && !allowedKinds.has(artifact.kind)) {
      recordInvalid(artifact, "artifact_kind_not_allowed");
      continue;
    }
    if (
      input.requireBookScopedGraphOutput === true &&
      !isBookScopedGraphOutputArtifact(input.bookId, artifact)
    ) {
      recordInvalid(artifact, "artifact_not_book_scoped_graph_output");
      continue;
    }
    const expectedProducerRunId = input.expectedProducerRunIds?.[artifact.stage];
    if (
      expectedProducerRunId != null &&
      artifact.producerRunId !== expectedProducerRunId
    ) {
      recordInvalid(artifact, "producer_run_id_mismatch");
      continue;
    }
    const expectedStageFingerprint = input.expectedStageFingerprints?.[artifact.stage];
    if (
      expectedStageFingerprint != null &&
      artifact.stageFingerprint !== expectedStageFingerprint
    ) {
      recordInvalid(artifact, "stage_fingerprint_mismatch");
      continue;
    }
    if (
      input.expectedProviderFingerprint != null &&
      artifact.providerFingerprint !== input.expectedProviderFingerprint
    ) {
      recordInvalid(artifact, "provider_fingerprint_mismatch");
      continue;
    }
    if (
      input.expectedCorpusContentHash != null &&
      (artifact.kind.startsWith("graphrag_") || artifact.kind === "lancedb_index") &&
      artifact.metadata?.corpusContentHash !== input.expectedCorpusContentHash
    ) {
      recordInvalid(artifact, "corpus_content_hash_mismatch");
      continue;
    }

    const validation = await validateArtifact(input.graphVault, artifact);
    if (!validation.valid) {
      recordInvalid(artifact, validation.reason ?? "artifact_invalid");
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
    invalidArtifacts,
    validArtifacts,
  };
}

function sortCurrentArtifacts(
  artifacts: readonly BookArtifactManifest[],
): BookArtifactManifest[] {
  return [...artifacts].sort((left, right) => {
    const created = right.createdAt.localeCompare(left.createdAt);
    return created === 0 ? left.artifactId.localeCompare(right.artifactId) : created;
  });
}

export async function selectValidBookArtifactsByKind(input: {
  graphVault: string;
  bookId: string;
  artifacts: readonly BookArtifactManifest[];
  requiredKinds: readonly BookArtifactKind[];
  allowedKinds?: readonly BookArtifactKind[];
  requireBookScopedGraphOutput?: boolean;
  expectedProducerRunIds?: Partial<Record<BookStage, string>>;
  expectedStageFingerprints?: Partial<Record<BookStage, string>>;
  expectedProviderFingerprint?: string;
  expectedCorpusContentHash?: string;
}): Promise<BookArtifactKindSelectionResult> {
  const requiredKinds = input.requiredKinds ?? [];
  const requiredKindSet = new Set<BookArtifactKind>(requiredKinds);
  const validByKind = new Map<BookArtifactKind, BookArtifactManifest[]>();
  const invalidByKind = new Map<
    BookArtifactKind,
    BookArtifactKindSelectionResult["invalidArtifacts"]
  >();

  for (const artifact of input.artifacts) {
    if (!requiredKindSet.has(artifact.kind)) continue;
    const validation = await validateBookArtifactSet({
      graphVault: input.graphVault,
      bookId: input.bookId,
      artifactIds: [artifact.artifactId],
      artifacts: input.artifacts,
      requiredKinds: [artifact.kind],
      allowedKinds: input.allowedKinds ?? [artifact.kind],
      requireBookScopedGraphOutput: input.requireBookScopedGraphOutput,
      expectedProducerRunIds: input.expectedProducerRunIds,
      expectedStageFingerprints: input.expectedStageFingerprints,
      expectedProviderFingerprint: input.expectedProviderFingerprint,
      expectedCorpusContentHash: input.expectedCorpusContentHash,
    });
    if (validation.isSatisfied) {
      const items = validByKind.get(artifact.kind) ?? [];
      items.push(artifact);
      validByKind.set(artifact.kind, items);
      continue;
    }
    const items = invalidByKind.get(artifact.kind) ?? [];
    items.push(...validation.invalidArtifacts);
    invalidByKind.set(artifact.kind, items);
  }

  const selected: BookArtifactManifest[] = [];
  const missingArtifactIds: string[] = [];
  const missingArtifactKinds: BookArtifactKind[] = [];
  const invalidArtifacts: BookArtifactKindSelectionResult["invalidArtifacts"] = [];
  for (const kind of requiredKinds) {
    const candidates = validByKind.get(kind) ?? [];
    if (candidates.length === 0) {
      missingArtifactKinds.push(kind);
      const invalid = invalidByKind.get(kind) ?? [];
      invalidArtifacts.push(...invalid);
      missingArtifactIds.push(...invalid.map((artifact) => artifact.artifactId));
      continue;
    }
    selected.push(sortCurrentArtifacts(candidates)[0]!);
  }

  return {
    isSatisfied: missingArtifactKinds.length === 0,
    artifactIds: selected.map((artifact) => artifact.artifactId),
    missingArtifactIds: [...new Set(missingArtifactIds)],
    missingArtifactKinds,
    invalidArtifacts,
    validArtifacts: selected,
  };
}

function isBookScopedGraphOutputArtifact(
  bookId: string,
  artifact: BookArtifactManifest,
): boolean {
  const bases = bookScopedGraphOutputBases(bookId);
  if (artifact.kind === "lancedb_index") {
    return bases.some((base) => artifact.path === `${base}/lancedb`);
  }
  if (
    artifact.kind === "graphrag_community_reports_parquet" ||
    artifact.kind.startsWith("graphrag_")
  ) {
    return bases.some((base) => artifact.path.startsWith(`${base}/`));
  }
  return true;
}
