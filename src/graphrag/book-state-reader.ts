import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  BookJobCatalogSchema,
  BookJobSchema,
  type BookJob,
} from "../contracts/book-job.js";
import { SchemaVersion } from "../contracts/common.js";
import {
  DocumentIdentityMapSchema,
  GraphTextUnitIdentityMapSchema,
  type DocumentIdentityMap,
} from "../contracts/corpus.js";
import { readYamlUnknownDurable } from "../job-state/durable-state-store.js";
import { readHotplugPackageUnknown } from "./book-hotplug-package-readonly.js";
import {
  resolveBookManifestPath,
  resolveBookPublishReadyPath,
  resolveBookRoot,
  resolveBookStateFile,
} from "./book-package-layout.js";

async function readYaml(path: string): Promise<unknown | null> {
  return readYamlUnknownDurable(path);
}

export async function loadBookJobFromState(
  graphVault: string,
  bookId: string,
): Promise<BookJob | null> {
  const raw = await readYaml(resolveBookStateFile(graphVault, bookId, "job.yaml"));
  const result = BookJobSchema.safeParse(raw);
  return result.success && result.data.bookId === bookId ? result.data : null;
}

export async function loadBookJobFromCatalog(
  graphVault: string,
  bookId: string,
): Promise<BookJob | null> {
  const booksRaw = await readYaml(join(graphVault, "catalog", "books.yaml"));
  const booksResult = BookJobCatalogSchema.safeParse(booksRaw);
  if (!booksResult.success) return null;
  return booksResult.data.items.find((item) => item.bookId === bookId) ?? null;
}

export async function loadScopedBookJobsFromState(
  graphVaultInput: string,
  bookIds: ReadonlySet<string>,
): Promise<BookJob[]> {
  if (bookIds.size === 0) return [];
  const graphVault = resolve(graphVaultInput);
  const books = await Promise.all(
    [...bookIds].map((bookId) => loadBookJobFromState(graphVault, bookId)),
  );
  return books.filter((book): book is BookJob => book != null);
}

export async function loadCatalogBookJobs(
  graphVaultInput: string,
): Promise<BookJob[]> {
  const graphVault = resolve(graphVaultInput);
  const booksRaw = await readYaml(join(graphVault, "catalog", "books.yaml"));
  const booksResult = BookJobCatalogSchema.safeParse(booksRaw);
  return booksResult.success ? booksResult.data.items : [];
}

export async function projectDocumentIdentityFromBookState(
  graphVaultInput: string,
  book: BookJob,
): Promise<DocumentIdentityMap | null> {
  const graphVault = resolve(graphVaultInput);
  const path = join(
    resolveBookRoot(graphVault, book.bookId),
    "graphrag",
    "output",
    "qmd_graph_text_unit_identity.json",
  );
  if (!existsSync(path)) return null;
  const identityResult = GraphTextUnitIdentityMapSchema.safeParse(
    await readHotplugPackageUnknown(path),
  );
  if (!identityResult.success) return null;
  const identity = identityResult.data;
  const parsed = DocumentIdentityMapSchema.safeParse({
    schemaVersion: SchemaVersion,
    sourceId: identity.sourceId,
    sourceHash: identity.sourceHash,
    canonicalBookId: identity.bookId,
    documentId: identity.documentId,
    contentHash: identity.contentHash,
    normalizationPolicyVersion:
      book.normalizationPolicyVersion ?? "graphrag-normalized-markdown-v1",
    normalizedPath: book.normalizedPath,
    chunkIds: [],
    graphDocumentId: identity.graphDocumentId,
    graphTextUnitIds: identity.graphTextUnitIds,
    metadata: {
      qmdCorpusRegistered: true,
      projectionSource: "book_state",
      legacyGraphIdentityNormalizedPath: identity.normalizedPath,
    },
  });
  return parsed.success ? parsed.data : null;
}

export function listBookIdsFromVault(graphVaultInput: string): string[] {
  const booksDir = join(resolve(graphVaultInput), "books");
  if (!existsSync(booksDir)) return [];
  return readdirSync(booksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export function hasPublishedScopedBookPackage(
  graphVaultInput: string,
  bookIds: ReadonlySet<string>,
): boolean {
  if (bookIds.size === 0) return false;
  const graphVault = resolve(graphVaultInput);
  for (const bookId of bookIds) {
    if (
      existsSync(resolveBookManifestPath(graphVault, bookId)) &&
      existsSync(resolveBookPublishReadyPath(graphVault, bookId))
    ) {
      return true;
    }
  }
  return false;
}
