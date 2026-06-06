import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readHotplugPackageUnknown } from "../book-hotplug-package-readonly.js";
import { resolveBookManifestPath } from "../book-package-layout.js";
import {
  BookManifestSchema,
  BookshelfGraphChecks,
  BookshelfGraphManifestSchema,
  BookshelfQualityGateSchema,
  RequiredParquetColumns,
} from "./bookshelf-graph-contracts.js";
import {
  defaultBookshelfGraphBridgePath,
  runBookshelfGraphParquetBridge,
} from "./bookshelf-graph-parquet.js";

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256Buffer(await readFile(path));
}

function validateQualityGateChecks(input: {
  checks: Array<{ checkId: string; status: "passed" }>;
  diagnostics: string[];
}): void {
  const observed = new Set(input.checks.map((check) => check.checkId));
  for (const requiredCheck of BookshelfGraphChecks) {
    if (!observed.has(requiredCheck)) {
      input.diagnostics.push(`quality_gate_missing_check:${requiredCheck}`);
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

export async function validateBookshelfGraphAtRoot(input: {
  graphVault: string;
  bookshelfId: string;
  root: string;
  pythonBin: string;
  bridgePath: string;
}): Promise<{ ok: boolean; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const manifestPath = join(input.root, "BOOKSHELF_MANIFEST.json");
  const gatePath = join(input.root, "state", "bookshelf-quality-gate.json");
  if (!existsSync(manifestPath)) diagnostics.push("missing:BOOKSHELF_MANIFEST.json");
  if (!existsSync(`${manifestPath}.sha256`)) {
    diagnostics.push("missing_checksum:BOOKSHELF_MANIFEST.json");
  }
  if (!existsSync(gatePath)) diagnostics.push("missing:state/bookshelf-quality-gate.json");
  if (!existsSync(`${gatePath}.sha256`)) {
    diagnostics.push("missing_checksum:state/bookshelf-quality-gate.json");
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const manifest = BookshelfGraphManifestSchema.safeParse(
    await readHotplugPackageUnknown(manifestPath),
  );
  const gate = BookshelfQualityGateSchema.safeParse(
    await readHotplugPackageUnknown(gatePath),
  );
  if (!manifest.success) diagnostics.push("manifest_schema_invalid");
  if (!gate.success) diagnostics.push("quality_gate_schema_invalid");
  if (!manifest.success || !gate.success) return { ok: false, diagnostics };
  if (manifest.data.bookshelfIdentity.bookshelfId !== input.bookshelfId) {
    diagnostics.push("manifest_scope_mismatch");
  }
  if (!manifest.data.bookshelfIdentity.queryReady) {
    diagnostics.push("manifest_not_query_ready");
  }
  if (!gate.data.queryReady) diagnostics.push("gate_not_query_ready");
  validateQualityGateChecks({
    checks: gate.data.checks,
    diagnostics,
  });
  for (const file of manifest.data.files) {
    const relativePath = normalizeScopeRelativePath(file.path);
    if (relativePath == null) {
      diagnostics.push(`manifest_file_path_invalid:${file.path}`);
      continue;
    }
    if (relativePath === "BOOKSHELF_MANIFEST.json") {
      diagnostics.push("manifest_self_reference_forbidden");
      continue;
    }
    const path = join(input.root, relativePath);
    if (!existsSync(path)) {
      diagnostics.push(`manifest_file_missing:${relativePath}`);
      continue;
    }
    const content = await readFile(path);
    const actualSha = sha256Buffer(content);
    if (content.byteLength !== file.bytes) {
      diagnostics.push(`manifest_file_bytes_mismatch:${relativePath}`);
    }
    if (actualSha !== file.sha256) {
      diagnostics.push(`manifest_file_sha256_mismatch:${relativePath}`);
    }
    const sidecarPath = `${path}.sha256`;
    if (!existsSync(sidecarPath)) {
      diagnostics.push(`manifest_file_checksum_missing:${relativePath}`);
      continue;
    }
    if ((await readFile(sidecarPath, "utf8")).trim() !== actualSha) {
      diagnostics.push(`manifest_file_sidecar_mismatch:${relativePath}`);
    }
  }
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
  if (
    inspection.artifacts["evidence_map.parquet"]?.rowCount !==
      manifest.data.evidenceMap.rowCount
  ) {
    diagnostics.push("evidence_map_row_count_mismatch");
  }
  for (const [bookId, sha256] of Object.entries(
    manifest.data.membership.memberManifestSha256,
  )) {
    const parsed = BookManifestSchema.safeParse(
      await readHotplugPackageUnknown(resolveBookManifestPath(input.graphVault, bookId)),
    );
    if (!parsed.success) {
      diagnostics.push(`member_manifest_invalid:${bookId}`);
    } else if (parsed.data.checksums.manifestSha256 !== sha256) {
      diagnostics.push(`member_manifest_stale:${bookId}`);
    }
  }
  return { ok: diagnostics.length === 0, diagnostics: [...new Set(diagnostics)] };
}

export async function validateBookshelfGraph(input: {
  graphVault: string;
  bookshelfId: string;
  pythonBin?: string;
  bridgePath?: string;
}): Promise<{
  ok: boolean;
  diagnostics: string[];
  semanticUnitCount: number;
  evidenceMapCount: number;
}> {
  const root = join(
    resolve(input.graphVault),
    "catalog",
    "bookshelves",
    input.bookshelfId,
    "current",
  );
  const bridgePath = input.bridgePath ?? defaultBookshelfGraphBridgePath();
  const pythonBin = input.pythonBin ?? "python3";
  const validation = await validateBookshelfGraphAtRoot({
    graphVault: resolve(input.graphVault),
    bookshelfId: input.bookshelfId,
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
