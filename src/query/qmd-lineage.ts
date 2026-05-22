import { createHash } from "node:crypto";

export type QmdDocumentLineageInput = {
  contentHash: string;
  normalizationPolicyVersion?: string | null;
  sourceId?: string | null;
};

export type QmdDocumentLineageProjection = {
  collection: string;
  path: string;
  documentId: string;
  normalizationPolicyVersion: string;
};

export const QMD_SQLITE_NORMALIZATION_POLICY_VERSION = "qmd-sqlite-content-v1";

export function buildQmdDocumentLineageId(
  input: QmdDocumentLineageInput,
): string {
  return `qmd-doc:${createHash("sha256")
    .update(JSON.stringify({
      contentHash: input.contentHash,
      normalizationPolicyVersion: input.normalizationPolicyVersion ??
        QMD_SQLITE_NORMALIZATION_POLICY_VERSION,
      sourceId: input.sourceId ?? null,
    }))
    .digest("hex")
    .slice(0, 24)}`;
}

export function projectQmdDocumentLineage(input: {
  file?: string | null;
  displayPath?: string | null;
  collection?: string | null;
  path?: string | null;
  hash: string;
  normalizationPolicyVersion?: string | null;
  sourceId?: string | null;
}): QmdDocumentLineageProjection {
  const fromFile = input.file?.startsWith("qmd://")
    ? {
      collection: collectionFromQmdVirtualPath(input.file),
      path: pathFromQmdVirtualPath(input.file),
    }
    : null;
  const fromDisplayPath = input.displayPath != null
    ? splitQmdDisplayPath(input.displayPath)
    : null;
  const collection = input.collection || fromFile?.collection ||
    fromDisplayPath?.collection || "default";
  const path = input.path || fromFile?.path || fromDisplayPath?.path ||
    input.displayPath || input.file || "";
  return {
    collection,
    path,
    normalizationPolicyVersion: input.normalizationPolicyVersion ??
      QMD_SQLITE_NORMALIZATION_POLICY_VERSION,
    documentId: buildQmdDocumentLineageId({
      contentHash: input.hash,
      normalizationPolicyVersion: input.normalizationPolicyVersion,
      sourceId: input.sourceId,
    }),
  };
}

export function buildQmdChunkLineageId(hash: string, seq: number): string {
  return `qmd-chunk:${hash}:${Math.max(0, Math.floor(seq))}`;
}

export function collectionFromQmdVirtualPath(file: string): string {
  if (!file.startsWith("qmd://")) return "default";
  const withoutScheme = file.slice("qmd://".length);
  return withoutScheme.split("/")[0] || "default";
}

export function pathFromQmdVirtualPath(file: string): string {
  if (!file.startsWith("qmd://")) return file;
  const withoutScheme = file.slice("qmd://".length);
  const index = withoutScheme.indexOf("/");
  return index < 0 ? withoutScheme : withoutScheme.slice(index + 1);
}

function splitQmdDisplayPath(displayPath: string): {
  collection: string;
  path: string;
} {
  const parts = displayPath.split("/").filter((part) => part.length > 0);
  const collection = parts[0] || "default";
  const path = parts.length > 1 ? parts.slice(1).join("/") : displayPath;
  return { collection, path };
}
