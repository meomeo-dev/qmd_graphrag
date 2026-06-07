import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { readHotplugPackageUnknown } from "../book-hotplug-package-readonly.js";

export type UpperScopeKind = "bookshelf" | "library";

export const CurrentPointerSchema = z.object({
  schemaVersion: z.string().min(1),
  scopeKind: z.enum(["bookshelf", "library"]).optional(),
  bookshelfId: z.string().min(1).optional(),
  libraryId: z.string().min(1).optional(),
  generation: z.string().min(1),
  current: z.string().min(1),
  manifestPath: z.string().min(1),
  manifestSha256: z.string().min(1),
  readyState: z.string().min(1),
  queryReady: z.boolean(),
  publishedAt: z.string().min(1),
});

export type CurrentPointer = z.infer<typeof CurrentPointerSchema>;

export const UpperPublishReadySchema = z.object({
  schemaVersion: z.string().min(1),
  kind: z.literal("qmd_graphrag_upper_package_publish_ready"),
  scopeKind: z.enum(["bookshelf", "library"]),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  readyState: z.string().min(1),
  queryReady: z.literal(true),
  manifestPath: z.string().min(1),
  manifestSha256: z.string().min(1),
  qualityGatePath: z.string().min(1),
  currentPath: z.literal("CURRENT.json"),
  publishedAt: z.string().min(1),
});

export type UpperPublishReady = z.infer<typeof UpperPublishReadySchema>;

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256Buffer(await readFile(path));
}

export function graphVaultRoot(graphVault: string): string {
  return resolve(graphVault);
}

export function assertSafeUpperScopeId(
  scopeKind: UpperScopeKind,
  scopeId: string,
): void {
  if (
    scopeId === "" ||
    scopeId !== scopeId.trim() ||
    scopeId.includes("/") ||
    scopeId.includes("\\") ||
    scopeId === "." ||
    scopeId === ".." ||
    scopeId.includes("..") ||
    scopeId.includes("\0") ||
    /^[A-Za-z]:/u.test(scopeId) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(scopeId)
  ) {
    throw new Error(`upper_quality_gate_failed:invalid_${scopeKind}_id`);
  }
}

export function bookshelfPackageRoot(
  graphVault: string,
  bookshelfId: string,
): string {
  assertSafeUpperScopeId("bookshelf", bookshelfId);
  return join(graphVaultRoot(graphVault), "bookshelves", bookshelfId);
}

export function libraryPackageRoot(graphVault: string, libraryId: string): string {
  assertSafeUpperScopeId("library", libraryId);
  return join(graphVaultRoot(graphVault), "library", libraryId);
}

export function legacyBookshelfCatalogRoot(
  graphVault: string,
  bookshelfId: string,
): string {
  assertSafeUpperScopeId("bookshelf", bookshelfId);
  return join(graphVaultRoot(graphVault), "catalog", "bookshelves", bookshelfId);
}

export function legacyLibraryCatalogRoot(
  graphVault: string,
  libraryId: string,
): string {
  assertSafeUpperScopeId("library", libraryId);
  return join(graphVaultRoot(graphVault), "catalog", "library", libraryId);
}

export function upperPackageRoot(input: {
  graphVault: string;
  scopeKind: UpperScopeKind;
  scopeId: string;
}): string {
  return input.scopeKind === "bookshelf"
    ? bookshelfPackageRoot(input.graphVault, input.scopeId)
    : libraryPackageRoot(input.graphVault, input.scopeId);
}

export function legacyUpperCatalogRoot(input: {
  graphVault: string;
  scopeKind: UpperScopeKind;
  scopeId: string;
}): string {
  return input.scopeKind === "bookshelf"
    ? legacyBookshelfCatalogRoot(input.graphVault, input.scopeId)
    : legacyLibraryCatalogRoot(input.graphVault, input.scopeId);
}

export function generationRoot(input: {
  packageRoot: string;
  generation: string;
}): string {
  return join(input.packageRoot, "generations", input.generation);
}

export function packageRelativePath(path: string): string | null {
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

export function packageLocator(input: {
  scopeKind: UpperScopeKind;
  scopeId: string;
  generation: string;
  relativePath: string;
}): string {
  assertSafeUpperScopeId(input.scopeKind, input.scopeId);
  const root = input.scopeKind === "bookshelf" ? "bookshelves" : "library";
  return [
    root,
    input.scopeId,
    "generations",
    input.generation,
    input.relativePath,
  ].join("/");
}

export function upperManifestName(scopeKind: UpperScopeKind): string {
  return scopeKind === "bookshelf"
    ? "BOOKSHELF_MANIFEST.json"
    : "LIBRARY_MANIFEST.json";
}

export function upperQualityGateRelativePath(scopeKind: UpperScopeKind): string {
  return scopeKind === "bookshelf"
    ? "state/bookshelf-quality-gate.json"
    : "state/library-quality-gate.json";
}

function queryReadyState(scopeKind: UpperScopeKind): string {
  return scopeKind === "bookshelf"
    ? "bookshelf_query_ready"
    : "library_query_ready";
}

export async function readPackageCurrent(input: {
  graphVault: string;
  scopeKind: UpperScopeKind;
  scopeId: string;
}): Promise<{
  packageRoot: string;
  generationRoot: string;
  current: CurrentPointer;
}> {
  const packageRoot = upperPackageRoot(input);
  const currentPath = join(packageRoot, "CURRENT.json");
  if (!existsSync(currentPath) || !existsSync(`${currentPath}.sha256`)) {
    throw new Error("upper_index_missing:current_pointer_invalid_or_missing");
  }
  const parsed = CurrentPointerSchema.safeParse(
    await readHotplugPackageUnknown(currentPath),
  );
  if (!parsed.success) {
    throw new Error("upper_index_missing:current_pointer_invalid_or_missing");
  }
  const currentSha256 = await sha256File(currentPath);
  const currentSidecarSha256 = (await readFile(`${currentPath}.sha256`, "utf8"))
    .trim();
  if (currentSidecarSha256 !== currentSha256) {
    throw new Error("upper_quality_gate_failed:current_pointer_sidecar_mismatch");
  }
  const current = parsed.data;
  if (current.scopeKind != null && current.scopeKind !== input.scopeKind) {
    throw new Error("upper_quality_gate_failed:current_scope_kind_mismatch");
  }
  const scopeId = input.scopeKind === "bookshelf"
    ? current.bookshelfId
    : current.libraryId;
  if (scopeId != null && scopeId !== input.scopeId) {
    throw new Error("upper_quality_gate_failed:current_scope_id_mismatch");
  }
  const currentRelative = packageRelativePath(current.current);
  const manifestRelative = packageRelativePath(current.manifestPath);
  if (currentRelative == null || manifestRelative == null) {
    throw new Error("upper_quality_gate_failed:current_pointer_path_invalid");
  }
  if (currentRelative !== `generations/${current.generation}`) {
    throw new Error("upper_quality_gate_failed:current_generation_path_mismatch");
  }
  const resolvedGenerationRoot = join(packageRoot, currentRelative);
  const manifestPath = join(packageRoot, manifestRelative);
  if (!manifestPath.startsWith(`${resolvedGenerationRoot}/`)) {
    throw new Error("upper_quality_gate_failed:current_manifest_not_generation_local");
  }
  if (!existsSync(manifestPath) || !existsSync(`${manifestPath}.sha256`)) {
    throw new Error("upper_index_missing:current_manifest_missing");
  }
  const manifestSha256 = await sha256File(manifestPath);
  const sidecarSha256 = (await readFile(`${manifestPath}.sha256`, "utf8")).trim();
  if (
    manifestSha256 !== current.manifestSha256 ||
    sidecarSha256 !== manifestSha256
  ) {
    throw new Error("upper_quality_gate_failed:current_manifest_checksum_mismatch");
  }
  return {
    packageRoot,
    generationRoot: resolvedGenerationRoot,
    current,
  };
}

export function hasLegacyCatalogUpperArtifacts(input: {
  graphVault: string;
  scopeKind: UpperScopeKind;
  scopeId: string;
}): boolean {
  const legacyRoot = legacyUpperCatalogRoot(input);
  const manifestName = input.scopeKind === "bookshelf"
    ? "BOOKSHELF_MANIFEST.json"
    : "LIBRARY_MANIFEST.json";
  const membershipName = input.scopeKind === "bookshelf"
    ? "BOOKSHELF_MEMBERSHIP_MANIFEST.json"
    : "LIBRARY_MEMBERSHIP_MANIFEST.json";
  return existsSync(join(legacyRoot, "current", manifestName)) ||
    existsSync(join(legacyRoot, "current", membershipName)) ||
    existsSync(join(legacyRoot, "CURRENT.json"));
}

export function hasPackageRoot(input: {
  graphVault: string;
  scopeKind: UpperScopeKind;
  scopeId: string;
}): boolean {
  return existsSync(upperPackageRoot(input));
}

export async function readQueryReadyPackage(input: {
  graphVault: string;
  scopeKind: UpperScopeKind;
  scopeId: string;
}): Promise<{
  packageRoot: string;
  generationRoot: string;
  current: CurrentPointer;
  publishReady: UpperPublishReady;
  manifestPath: string;
  rootManifestPath: string;
  gatePath: string;
  rootGatePath: string;
}> {
  if (!hasPackageRoot(input)) {
    if (hasLegacyCatalogUpperArtifacts(input)) {
      throw new Error("upper_package_migration_required:legacy_catalog_only");
    }
    throw new Error("upper_index_missing:package_root_missing");
  }
  const resolved = await readPackageCurrent(input);
  if (!resolved.current.queryReady) {
    throw new Error("upper_index_missing:current_not_query_ready");
  }
  if (resolved.current.readyState !== queryReadyState(input.scopeKind)) {
    throw new Error("upper_quality_gate_failed:current_ready_state_mismatch");
  }
  const manifestName = upperManifestName(input.scopeKind);
  const gateRelativePath = upperQualityGateRelativePath(input.scopeKind);
  const manifestPath = join(resolved.generationRoot, manifestName);
  const rootManifestPath = join(resolved.packageRoot, manifestName);
  const gatePath = join(resolved.generationRoot, gateRelativePath);
  const rootGatePath = join(resolved.packageRoot, gateRelativePath);
  const publishReadyPath = join(resolved.packageRoot, "PUBLISH_READY.json");
  for (const path of [
    manifestPath,
    rootManifestPath,
    gatePath,
    rootGatePath,
    publishReadyPath,
  ]) {
    if (!existsSync(path) || !existsSync(`${path}.sha256`)) {
      throw new Error("upper_index_missing:package_query_ready_file_missing");
    }
  }
  const manifestSha256 = await sha256File(manifestPath);
  const rootManifestSha256 = await sha256File(rootManifestPath);
  if (
    manifestSha256 !== resolved.current.manifestSha256 ||
    rootManifestSha256 !== manifestSha256
  ) {
    throw new Error("upper_quality_gate_failed:package_manifest_mismatch");
  }
  const rootManifestSidecar = (await readFile(
    `${rootManifestPath}.sha256`,
    "utf8",
  )).trim();
  if (rootManifestSidecar !== rootManifestSha256) {
    throw new Error("upper_quality_gate_failed:package_manifest_sidecar_mismatch");
  }
  const gateSha256 = await sha256File(gatePath);
  const rootGateSha256 = await sha256File(rootGatePath);
  const gateSidecar = (await readFile(`${gatePath}.sha256`, "utf8")).trim();
  const rootGateSidecar = (await readFile(`${rootGatePath}.sha256`, "utf8"))
    .trim();
  if (gateSidecar !== gateSha256 || rootGateSidecar !== rootGateSha256) {
    throw new Error("upper_quality_gate_failed:package_gate_sidecar_mismatch");
  }
  if (rootGateSha256 !== gateSha256) {
    throw new Error("upper_quality_gate_failed:package_gate_mismatch");
  }
  const publishReady = UpperPublishReadySchema.safeParse(
    await readHotplugPackageUnknown(publishReadyPath),
  );
  if (!publishReady.success) {
    throw new Error("upper_quality_gate_failed:publish_ready_invalid");
  }
  if (
    publishReady.data.scopeKind !== input.scopeKind ||
    publishReady.data.scopeId !== input.scopeId ||
    publishReady.data.generation !== resolved.current.generation ||
    publishReady.data.manifestSha256 !== manifestSha256 ||
    publishReady.data.readyState !== queryReadyState(input.scopeKind) ||
    publishReady.data.manifestPath !== manifestName ||
    publishReady.data.qualityGatePath !== gateRelativePath ||
    publishReady.data.currentPath !== "CURRENT.json"
  ) {
    throw new Error("upper_quality_gate_failed:publish_ready_scope_mismatch");
  }
  const publishReadySha256 = await sha256File(publishReadyPath);
  const publishReadySidecar = (await readFile(
    `${publishReadyPath}.sha256`,
    "utf8",
  )).trim();
  if (publishReadySidecar !== publishReadySha256) {
    throw new Error("upper_quality_gate_failed:publish_ready_sidecar_mismatch");
  }
  return {
    packageRoot: resolved.packageRoot,
    generationRoot: resolved.generationRoot,
    current: resolved.current,
    publishReady: publishReady.data,
    manifestPath,
    rootManifestPath,
    gatePath,
    rootGatePath,
  };
}
