import type { BookArtifactKind } from "../contracts/book-job.js";
import { normalizePortableVaultRelativePath } from "../vault/path.js";

export function assertBookPackageSourcePath(
  path: string,
  bookId: string,
): string {
  const portablePath = normalizePortableVaultRelativePath(path);
  if (!portablePath.startsWith(`books/${bookId}/source/`)) {
    throw new Error(
      "canonicalSourcePath must use books/{bookId}/source/{file}",
    );
  }
  return portablePath;
}

export function assertBookPackageInputPath(
  path: string,
  bookId: string,
): string {
  const portablePath = normalizePortableVaultRelativePath(path);
  if (!portablePath.startsWith(`books/${bookId}/input/`)) {
    throw new Error(
      "normalizedPath must use books/{bookId}/input/{file}",
    );
  }
  return portablePath;
}

export function assertBookArtifactPath(
  path: string,
  bookId: string,
  kind: BookArtifactKind,
): string {
  const portablePath = normalizePortableVaultRelativePath(path);
  if (kind === "source_epub") {
    return assertBookPackageSourcePath(portablePath, bookId);
  }
  if (kind === "normalized_markdown") {
    return assertBookPackageInputPath(portablePath, bookId);
  }
  if (
    kind === "lancedb_index" ||
    kind === "query_snapshot" ||
    kind === "graphrag_community_reports_parquet" ||
    kind.startsWith("graphrag_")
  ) {
    const outputPrefix = `books/${bookId}/graphrag/output`;
    if (
      portablePath === outputPrefix ||
      portablePath.startsWith(`${outputPrefix}/`)
    ) {
      return portablePath;
    }
    throw new Error(
      "graph artifact path must use books/{bookId}/graphrag/output",
    );
  }
  return portablePath;
}
