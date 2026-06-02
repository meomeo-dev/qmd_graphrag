import type {
  DocumentIdentityCatalog,
  DocumentIdentityMap,
} from "../contracts/corpus.js";

export type DocumentIdentitySelectionInput = {
  catalog: DocumentIdentityCatalog;
  documentId: string;
  contentHash?: string;
  currentBookId?: string;
};

export function isDocumentIdentityMatch(
  item: DocumentIdentityMap,
  input: {
    documentId: string;
    contentHash?: string;
    currentBookId?: string;
  },
): boolean {
  if (item.documentId !== input.documentId) return false;
  if (input.contentHash != null && item.contentHash !== input.contentHash) {
    return false;
  }
  if (
    input.currentBookId != null &&
    input.currentBookId !== "" &&
    item.canonicalBookId !== input.currentBookId
  ) {
    return false;
  }
  return true;
}

export function selectDocumentIdentityForFencedWrite(
  input: DocumentIdentitySelectionInput,
): DocumentIdentityMap | null {
  const matches = input.catalog.items.filter((item) =>
    isDocumentIdentityMatch(item, {
      documentId: input.documentId,
      contentHash: input.contentHash,
    })
  );
  if (matches.length === 0) return null;
  if (input.currentBookId == null || input.currentBookId === "") {
    return matches[0] ?? null;
  }
  return matches.find((item) =>
    item.canonicalBookId === input.currentBookId
  ) ?? null;
}
