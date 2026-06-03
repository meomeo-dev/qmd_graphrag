import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { readHotplugPackageUnknown } from "./book-hotplug-package-readonly.js";

const BookManifestLocatorSchema = z.object({
  graphrag: z.object({
    outputManifestPath: z.string().min(1),
  }).passthrough(),
}).passthrough();

export type BookStateFileName = "job.yaml" | "artifacts.yaml" | "checkpoints.yaml";

export function resolveBookRoot(graphVaultInput: string, bookId: string): string {
  return join(resolve(graphVaultInput), "books", bookId);
}

export function resolveBookManifestPath(
  graphVaultInput: string,
  bookId: string,
): string {
  return join(resolveBookRoot(graphVaultInput, bookId), "BOOK_MANIFEST.json");
}

export function resolveBookPublishReadyPath(
  graphVaultInput: string,
  bookId: string,
): string {
  return join(resolveBookRoot(graphVaultInput, bookId), "PUBLISH_READY.json");
}

export async function resolveBookGraphRagDataDir(
  graphVaultInput: string,
  bookId: string,
): Promise<string> {
  const bookRoot = resolveBookRoot(graphVaultInput, bookId);
  const manifestPath = resolveBookManifestPath(graphVaultInput, bookId);
  if (existsSync(manifestPath)) {
    const parsed = await readHotplugPackageUnknown(manifestPath);
    const result = BookManifestLocatorSchema.safeParse(parsed);
    if (result.success) {
      return dirname(join(bookRoot, result.data.graphrag.outputManifestPath));
    }
  }
  const hotplugOutputDir = join(bookRoot, "graphrag", "output");
  if (existsSync(hotplugOutputDir)) return hotplugOutputDir;
  return join(bookRoot, "output");
}

export function resolveBookStateFile(
  graphVaultInput: string,
  bookId: string,
  fileName: BookStateFileName,
): string {
  const bookRoot = resolveBookRoot(graphVaultInput, bookId);
  const hotplugPath = join(bookRoot, "state", fileName);
  if (existsSync(hotplugPath)) return hotplugPath;
  return join(bookRoot, fileName);
}

export function resolveBookRunDir(
  graphVaultInput: string,
  bookId: string,
): string {
  const bookRoot = resolveBookRoot(graphVaultInput, bookId);
  const hotplugRunDir = join(bookRoot, "graphrag", "runs");
  if (existsSync(hotplugRunDir)) return hotplugRunDir;
  return join(bookRoot, "runs");
}

export function bookScopedGraphOutputBases(bookId: string): string[] {
  return [
    `books/${bookId}/graphrag/output`,
    `books/${bookId}/output`,
  ];
}

export function rewriteLegacyGraphArtifactPath(
  bookId: string,
  artifactPath: string,
): string {
  const legacyBase = `books/${bookId}/output`;
  const hotplugBase = `books/${bookId}/graphrag/output`;
  if (artifactPath === legacyBase || artifactPath.startsWith(`${legacyBase}/`)) {
    return artifactPath.replace(legacyBase, hotplugBase);
  }
  if (artifactPath === "output" || artifactPath.startsWith("output/")) {
    return artifactPath.replace(/^output\b/u, "graphrag/output");
  }
  return artifactPath;
}
