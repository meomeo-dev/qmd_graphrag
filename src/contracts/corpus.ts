import { z } from "zod";

import {
  JsonValueSchema,
  SchemaVersion,
  buildEnvelopeSchema,
} from "./common.js";
import { isPortableVaultRelativePath } from "../vault/path.js";

export const VaultRelativePathSchema = z.string().min(1).refine(
  isPortableVaultRelativePath,
  "path must be vault-relative",
);

export const SourceLocatorSchema = z.object({
  path: VaultRelativePathSchema.optional(),
  relativePath: VaultRelativePathSchema.optional(),
}).strict();

export const SourceDocumentSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  sourceId: z.string().min(1),
  sourceHash: z.string().min(1),
  sourceName: z.string().min(1),
  sourceRelativePath: VaultRelativePathSchema.optional(),
  locator: SourceLocatorSchema.optional(),
  mediaType: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  createdAt: z.string().min(1).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const CorpusDocumentSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  documentId: z.string().min(1),
  sourceId: z.string().min(1),
  collection: z.string().min(1),
  relativePath: VaultRelativePathSchema,
  contentHash: z.string().min(1),
  title: z.string().min(1).optional(),
  normalizationPolicyVersion: z.string().min(1),
  createdAt: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const CorpusChunkSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  chunkId: z.string().min(1),
  documentId: z.string().min(1),
  sourceId: z.string().min(1),
  contentHash: z.string().min(1),
  chunkStrategy: z.string().min(1),
  seq: z.number().int().nonnegative(),
  pos: z.number().int().nonnegative(),
  endPos: z.number().int().nonnegative().optional(),
  textHash: z.string().min(1).optional(),
  text: z.string().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const DocumentIdentityMapSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  sourceId: z.string().min(1),
  sourceHash: z.string().min(1),
  canonicalBookId: z.string().min(1).nullable(),
  documentId: z.string().min(1),
  contentHash: z.string().min(1),
  normalizationPolicyVersion: z.string().min(1),
  normalizedPath: VaultRelativePathSchema.optional(),
  chunkIds: z.array(z.string().min(1)),
  graphDocumentId: z.string().min(1).optional(),
  graphTextUnitIds: z.array(z.string().min(1)).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const GraphTextUnitIdentityMapSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  bookId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceHash: z.string().min(1),
  documentId: z.string().min(1),
  contentHash: z.string().min(1),
  normalizedPath: VaultRelativePathSchema,
  graphDocumentId: z.string().min(1),
  graphTextUnitIds: z.array(z.string().min(1)).nonempty(),
});

export const SourceDocumentCatalogSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  items: z.array(SourceDocumentSchema),
});

export const DocumentIdentityCatalogSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  items: z.array(DocumentIdentityMapSchema),
});

export const SourceDocumentEnvelopeSchema = buildEnvelopeSchema(
  "corpus.source_document",
  SourceDocumentSchema,
);

export const CorpusDocumentEnvelopeSchema = buildEnvelopeSchema(
  "corpus.document",
  CorpusDocumentSchema,
);

export const CorpusChunkEnvelopeSchema = buildEnvelopeSchema(
  "corpus.chunk",
  CorpusChunkSchema,
);

export const DocumentIdentityMapEnvelopeSchema = buildEnvelopeSchema(
  "corpus.document_identity_map",
  DocumentIdentityMapSchema,
);

export const GraphTextUnitIdentityMapEnvelopeSchema = buildEnvelopeSchema(
  "corpus.graph_text_unit_identity_map",
  GraphTextUnitIdentityMapSchema,
);

export const SourceDocumentCatalogEnvelopeSchema = buildEnvelopeSchema(
  "corpus.source_document_catalog",
  SourceDocumentCatalogSchema,
);

export const DocumentIdentityCatalogEnvelopeSchema = buildEnvelopeSchema(
  "corpus.document_identity_catalog",
  DocumentIdentityCatalogSchema,
);

export type SourceLocator = z.infer<typeof SourceLocatorSchema>;
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export type CorpusDocument = z.infer<typeof CorpusDocumentSchema>;
export type CorpusChunk = z.infer<typeof CorpusChunkSchema>;
export type DocumentIdentityMap = z.infer<typeof DocumentIdentityMapSchema>;
export type GraphTextUnitIdentityMap = z.infer<
  typeof GraphTextUnitIdentityMapSchema
>;
export type SourceDocumentCatalog = z.infer<typeof SourceDocumentCatalogSchema>;
export type DocumentIdentityCatalog = z.infer<
  typeof DocumentIdentityCatalogSchema
>;
