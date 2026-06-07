import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readHotplugPackageUnknown } from "../book-hotplug-package-readonly.js";
import {
  BookshelfGraphChecks,
  BookshelfGraphManifestSchema,
  BookshelfQualityGateSchema,
} from "./bookshelf-graph-contracts.js";
import {
  defaultBookshelfGraphBridgePath,
  runBookshelfGraphParquetBridge,
} from "./bookshelf-graph-parquet.js";
import {
  LibraryGraphChecks,
  LibraryGraphManifestSchema,
  LibraryQualityGateSchema,
  RequiredParquetColumns,
} from "./library-graph-contracts.js";
import { readQueryReadyPackage } from "./upper-package-paths.js";

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256Buffer(await readFile(path));
}

function validateQualityGateChecks(input: {
  scope: "bookshelf" | "library";
  requiredChecks: readonly string[];
  checks: Array<{ checkId: string; status: "passed" }>;
  diagnostics: string[];
}): void {
  const observed = new Set(input.checks.map((check) => check.checkId));
  for (const requiredCheck of input.requiredChecks) {
    if (!observed.has(requiredCheck)) {
      input.diagnostics.push(
        `${input.scope}_quality_gate_missing_check:${requiredCheck}`,
      );
    }
  }
}

function validateArtifactRowBudget(input: {
  artifactRows: Record<string, { rowCount: number } | undefined>;
  recordedRows: Record<string, number>;
  maxSemanticUnits: number;
  diagnostics: string[];
}): void {
  for (const artifact of ["semantic_units.parquet", "community_reports.parquet"]) {
    const actual = input.artifactRows[artifact]?.rowCount;
    if (actual == null) continue;
    const recorded = input.recordedRows[artifact];
    if (recorded != null && actual !== recorded) {
      input.diagnostics.push(`artifact_row_count_mismatch:${artifact}`);
    }
    if (actual > input.maxSemanticUnits) {
      input.diagnostics.push(
        `budget_exceeded_narrow_scope_required:${artifact}:` +
          `rows:${actual}:maxSemanticUnits:${input.maxSemanticUnits}`,
      );
    }
  }
}

function normalizeScopeRelativePath(path: string): string | null {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.startsWith("../") ||
    path.includes("/../") ||
    path === ".." ||
    /^[A-Za-z]:\//u.test(path) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
  ) {
    return null;
  }
  return path;
}

async function validateFileClosure(input: {
  root: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  diagnostics: string[];
}): Promise<void> {
  for (const file of input.files) {
    const relativePath = normalizeScopeRelativePath(file.path);
    if (relativePath == null) {
      input.diagnostics.push(`manifest_file_path_invalid:${file.path}`);
      continue;
    }
    if (relativePath === "LIBRARY_MANIFEST.json") {
      input.diagnostics.push("manifest_self_reference_forbidden");
      continue;
    }
    const path = join(input.root, relativePath);
    if (!existsSync(path)) {
      input.diagnostics.push(`manifest_file_missing:${relativePath}`);
      continue;
    }
    const content = await readFile(path);
    const actualSha = sha256Buffer(content);
    if (content.byteLength !== file.bytes) {
      input.diagnostics.push(`manifest_file_bytes_mismatch:${relativePath}`);
    }
    if (actualSha !== file.sha256) {
      input.diagnostics.push(`manifest_file_sha256_mismatch:${relativePath}`);
    }
    const sidecarPath = `${path}.sha256`;
    if (!existsSync(sidecarPath)) {
      input.diagnostics.push(`manifest_file_checksum_missing:${relativePath}`);
      continue;
    }
    if ((await readFile(sidecarPath, "utf8")).trim() !== actualSha) {
      input.diagnostics.push(`manifest_file_sidecar_mismatch:${relativePath}`);
    }
  }
}

async function validateMemberBookshelves(input: {
  graphVault: string;
  members: Record<string, string>;
  diagnostics: string[];
}): Promise<void> {
  for (const [bookshelfId, expectedSha] of Object.entries(input.members)) {
    let ready: Awaited<ReturnType<typeof readQueryReadyPackage>>;
    try {
      ready = await readQueryReadyPackage({
        graphVault: input.graphVault,
        scopeKind: "bookshelf",
        scopeId: bookshelfId,
      });
    } catch {
      input.diagnostics.push(`member_bookshelf_manifest_missing:${bookshelfId}`);
      continue;
    }
    const manifestPath = ready.manifestPath;
    const gatePath = ready.gatePath;
    const actualSha = await sha256File(manifestPath);
    if (actualSha !== expectedSha) {
      input.diagnostics.push(`member_bookshelf_manifest_stale:${bookshelfId}`);
    }
    const manifest = BookshelfGraphManifestSchema.safeParse(
      await readHotplugPackageUnknown(manifestPath),
    );
    const gate = existsSync(gatePath)
      ? BookshelfQualityGateSchema.safeParse(
        await readHotplugPackageUnknown(gatePath),
      )
      : null;
    if (!manifest.success) {
      input.diagnostics.push(`member_bookshelf_manifest_invalid:${bookshelfId}`);
    } else if (!manifest.data.bookshelfIdentity.queryReady) {
      input.diagnostics.push(`member_bookshelf_not_query_ready:${bookshelfId}`);
    }
    if (gate?.success !== true || !gate.data.queryReady) {
      input.diagnostics.push(`member_bookshelf_gate_failed:${bookshelfId}`);
    } else {
      validateQualityGateChecks({
        scope: "bookshelf",
        requiredChecks: BookshelfGraphChecks,
        checks: gate.data.checks,
        diagnostics: input.diagnostics,
      });
    }
  }
}

export async function validateLibraryGraphAtRoot(input: {
  graphVault: string;
  libraryId: string;
  root: string;
  pythonBin: string;
  bridgePath: string;
}): Promise<{ ok: boolean; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const manifestPath = join(input.root, "LIBRARY_MANIFEST.json");
  const gatePath = join(input.root, "state", "library-quality-gate.json");
  if (!existsSync(manifestPath)) diagnostics.push("missing:LIBRARY_MANIFEST.json");
  if (!existsSync(`${manifestPath}.sha256`)) {
    diagnostics.push("missing_checksum:LIBRARY_MANIFEST.json");
  }
  if (!existsSync(gatePath)) diagnostics.push("missing:state/library-quality-gate.json");
  if (!existsSync(`${gatePath}.sha256`)) {
    diagnostics.push("missing_checksum:state/library-quality-gate.json");
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const manifest = LibraryGraphManifestSchema.safeParse(
    await readHotplugPackageUnknown(manifestPath),
  );
  const gate = LibraryQualityGateSchema.safeParse(
    await readHotplugPackageUnknown(gatePath),
  );
  if (!manifest.success) diagnostics.push("manifest_schema_invalid");
  if (!gate.success) diagnostics.push("quality_gate_schema_invalid");
  if (!manifest.success || !gate.success) return { ok: false, diagnostics };
  if (manifest.data.libraryIdentity.libraryId !== input.libraryId) {
    diagnostics.push("manifest_scope_mismatch");
  }
  if (!manifest.data.libraryIdentity.queryReady) {
    diagnostics.push("manifest_not_query_ready");
  }
  if (!gate.data.queryReady) diagnostics.push("gate_not_query_ready");
  validateQualityGateChecks({
    scope: "library",
    requiredChecks: LibraryGraphChecks,
    checks: gate.data.checks,
    diagnostics,
  });
  await validateFileClosure({
    root: input.root,
    files: manifest.data.files,
    diagnostics,
  });
  const sidecarSha = (await readFile(`${manifestPath}.sha256`, "utf8")).trim();
  if (sidecarSha !== await sha256File(manifestPath)) {
    diagnostics.push("manifest_sidecar_mismatch");
  }
  const inspection = await runBookshelfGraphParquetBridge({
    mode: "inspect",
    pythonBin: input.pythonBin,
    bridgePath: input.bridgePath,
    payload: {
      outputRoot: input.root,
      requiredColumns: RequiredParquetColumns,
    },
  });
  if (!inspection.ok) diagnostics.push(...inspection.diagnostics);
  validateArtifactRowBudget({
    artifactRows: inspection.artifacts,
    recordedRows: gate.data.artifactRowCounts,
    maxSemanticUnits: manifest.data.fixedQueryBudget.maxSemanticUnits,
    diagnostics,
  });
  if (
    inspection.artifacts["evidence_map.parquet"]?.rowCount !==
      manifest.data.evidenceMap.rowCount
  ) {
    diagnostics.push("evidence_map_row_count_mismatch");
  }
  await validateMemberBookshelves({
    graphVault: input.graphVault,
    members: manifest.data.membership.memberBookshelfManifestSha256,
    diagnostics,
  });
  return { ok: diagnostics.length === 0, diagnostics: [...new Set(diagnostics)] };
}

export async function validateLibraryGraph(input: {
  graphVault: string;
  libraryId: string;
  pythonBin?: string;
  bridgePath?: string;
}): Promise<{
  ok: boolean;
  diagnostics: string[];
  semanticUnitCount: number;
  evidenceMapCount: number;
}> {
  const graphVault = resolve(input.graphVault);
  let root: string;
  try {
    root = (await readQueryReadyPackage({
      graphVault,
      scopeKind: "library",
      scopeId: input.libraryId,
    })).generationRoot;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [detail],
      semanticUnitCount: 0,
      evidenceMapCount: 0,
    };
  }
  const bridgePath = input.bridgePath ?? defaultBookshelfGraphBridgePath();
  const pythonBin = input.pythonBin ?? "python3";
  const validation = await validateLibraryGraphAtRoot({
    graphVault,
    libraryId: input.libraryId,
    root,
    pythonBin,
    bridgePath,
  });
  if (!validation.ok) {
    return {
      ok: false,
      diagnostics: validation.diagnostics,
      semanticUnitCount: 0,
      evidenceMapCount: 0,
    };
  }
  const inspection = await runBookshelfGraphParquetBridge({
    mode: "inspect",
    pythonBin,
    bridgePath,
    payload: {
      outputRoot: root,
      requiredColumns: RequiredParquetColumns,
    },
  });
  return {
    ok: validation.ok && inspection.ok,
    diagnostics: [...new Set([...validation.diagnostics, ...inspection.diagnostics])],
    semanticUnitCount: inspection.artifacts["semantic_units.parquet"]?.rowCount ?? 0,
    evidenceMapCount: inspection.artifacts["evidence_map.parquet"]?.rowCount ?? 0,
  };
}
