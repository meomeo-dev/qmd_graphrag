import { readFile } from "node:fs/promises";
import { join } from "node:path";

import YAML from "yaml";

import {
  DocumentIdentityCatalogSchema,
  type DocumentIdentityMap,
} from "../contracts/corpus.js";
import {
  QmdRetrievalCandidateSchema,
  type QmdRetrievalCandidate,
} from "../contracts/qmd-query.js";
import {
  ensureCatalogProjectionFromBookHotplugPackages,
} from "../graphrag/book-hotplug-catalog.js";
import {
  QMD_SQLITE_NORMALIZATION_POLICY_VERSION,
  buildQmdChunkLineageId,
  projectQmdDocumentLineage,
} from "./qmd-lineage.js";

export type QmdCandidateInput = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  bestChunk: string;
  bestChunkPos: number;
  bestChunkSeq?: number;
  score: number;
  context: string | null;
  docid: string;
  hash?: string;
  explain?: {
    rerankScore?: number;
  };
};

type QmdCandidateProjectionOptions = {
  identities?: readonly DocumentIdentityMap[];
  fallbackCandidatePrefix?: string;
};

export class GraphVaultCatalogError extends Error {
  readonly catalogPath: string;

  constructor(catalogPath: string, cause: unknown) {
    super(`Graph vault catalog is unreadable or invalid: ${catalogPath}`);
    this.name = "GraphVaultCatalogError";
    this.catalogPath = catalogPath;
    this.cause = cause;
  }
}

export function isGraphVaultCatalogError(
  error: unknown,
): error is GraphVaultCatalogError {
  return error instanceof GraphVaultCatalogError;
}

export async function loadDocumentIdentitiesFromGraphVault(
  graphVault: string,
): Promise<DocumentIdentityMap[]> {
  const catalogPath = join(graphVault, "catalog", "document-identity-map.yaml");
  try {
    const raw = await readFile(catalogPath, "utf8");
    return DocumentIdentityCatalogSchema.parse(YAML.parse(raw)).items;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await ensureCatalogProjectionFromBookHotplugPackages(graphVault);
      try {
        const raw = await readFile(catalogPath, "utf8");
        return DocumentIdentityCatalogSchema.parse(YAML.parse(raw)).items;
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new GraphVaultCatalogError(catalogPath, retryError);
      }
    }
    throw new GraphVaultCatalogError(catalogPath, error);
  }
}

export function toQmdRetrievalCandidates(
  results: readonly QmdCandidateInput[],
  options: QmdCandidateProjectionOptions = {},
): QmdRetrievalCandidate[] {
  return results.map((result, index) => {
    const identity = findDocumentIdentity(result, options.identities ?? []);
    const qmdLineage = result.hash == null
      ? null
      : projectQmdDocumentLineage({
        file: result.file,
        displayPath: result.displayPath,
        hash: result.hash,
        normalizationPolicyVersion: identity?.normalizationPolicyVersion ??
          QMD_SQLITE_NORMALIZATION_POLICY_VERSION,
        sourceId: identity?.sourceId ?? null,
      });
    const documentId = identity?.documentId ?? qmdLineage?.documentId ?? null;
    const chunkId = findChunkId(result, identity) ??
      buildFallbackChunkId(result);
    const contentHash = result.hash || null;
    const chunkSeq = chunkSequence(result);

    return QmdRetrievalCandidateSchema.parse({
      candidateId: result.hash
        ? `${result.hash}:${chunkSeq ?? "unknown"}`
        : result.docid || `${options.fallbackCandidatePrefix ?? "qmd"}:${index}`,
      sourceId: identity?.sourceId ?? null,
      documentId,
      contentHash,
      chunkId,
      collection: qmdLineage?.collection,
      path: result.file,
      title: result.title,
      snippet: result.bestChunk,
      source: "hybrid",
      retrievalScore: result.score,
      rerankScore: result.explain?.rerankScore ?? null,
      metadata: {
        chunkLen: result.bestChunk.length,
        chunkPos: result.bestChunkPos,
        ...(result.context ? { context: result.context } : {}),
        ...(result.displayPath ? { path: result.displayPath } : {}),
        ...(result.docid ? { docid: result.docid } : {}),
        qmdDocumentIdSource:
          identity == null ? "qmd_sqlite_projection" : "graph_vault_identity",
        ...(chunkSeq != null ? { qmdChunkSeq: chunkSeq } : {}),
        fullText: result.body,
      },
    });
  });
}

function buildFallbackChunkId(result: QmdCandidateInput): string | null {
  const seq = chunkSequence(result);
  if (!result.hash || seq == null) return null;
  return buildQmdChunkLineageId(result.hash, seq);
}

function chunkSequence(result: QmdCandidateInput): number | null {
  const value = result.bestChunkSeq;
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function findDocumentIdentity(
  result: QmdCandidateInput,
  identities: readonly DocumentIdentityMap[],
): DocumentIdentityMap | null {
  if (!result.hash) return null;
  const contentMatches = identities.filter((identity) =>
    identity.contentHash === result.hash
  );
  if (contentMatches.length === 1) return contentMatches[0]!;
  return null;
}

function findChunkId(
  result: QmdCandidateInput,
  identity: DocumentIdentityMap | null,
): string | null {
  if (identity?.chunkIds == null || identity.chunkIds.length === 0) {
    return null;
  }
  const metadata = result as QmdCandidateInput & {
    chunkId?: unknown;
    chunk_id?: unknown;
  };
  const rawChunkId = typeof metadata.chunkId === "string"
    ? metadata.chunkId
    : typeof metadata.chunk_id === "string"
      ? metadata.chunk_id
      : null;
  if (rawChunkId == null) return null;
  return identity.chunkIds.includes(rawChunkId) ? rawChunkId : null;
}
