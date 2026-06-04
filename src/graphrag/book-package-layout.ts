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
  return hotplugOutputDir;
}

export function resolveBookStateFile(
  graphVaultInput: string,
  bookId: string,
  fileName: BookStateFileName,
): string {
  const bookRoot = resolveBookRoot(graphVaultInput, bookId);
  return join(bookRoot, "state", fileName);
}

export function resolveBookRunDir(
  graphVaultInput: string,
  bookId: string,
): string {
  const bookRoot = resolveBookRoot(graphVaultInput, bookId);
  return join(bookRoot, "graphrag", "runs");
}

export function resolveBookRuntimeGraphRagQueryReportDir(
  graphVaultInput: string,
  bookId: string,
): string {
  return join(
    resolve(graphVaultInput),
    ".local",
    "book-runtime",
    bookId,
    "graphrag-query",
    "reports",
  );
}

export function bookScopedGraphOutputBases(bookId: string): string[] {
  return [`books/${bookId}/graphrag/output`];
}
