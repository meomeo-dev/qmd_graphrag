import { z } from "zod";

import {
  ForbiddenFields,
  RequiredParquetColumns,
  type ParquetInspection,
} from "./bookshelf-graph-contracts.js";

export { ForbiddenFields, RequiredParquetColumns };
export type { ParquetInspection };

export const LibraryGraphSchemaVersion = "1.0.0";
export const LibraryGraphBuilderVersion = "library-graph-build-v3";

const FileRecordSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});

export const LibraryQualityGateSchema = z.object({
  schemaVersion: z.literal(LibraryGraphSchemaVersion),
  scopeKind: z.literal("library"),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  stageId: z.literal("library_graph_build"),
  readyState: z.literal("library_query_ready"),
  queryReady: z.literal(true),
  status: z.literal("passed"),
  checkedAt: z.string().min(1),
  checks: z.array(z.object({
    checkId: z.string().min(1),
    status: z.literal("passed"),
  })),
  diagnostics: z.array(z.string()),
  artifactRowCounts: z.record(z.string(), z.number().int().nonnegative()),
  fixedQueryBudgetSimulation: z.object({
    status: z.literal("passed"),
    maxSemanticUnits: z.number().int().positive(),
    selectedSemanticUnits: z.number().int().nonnegative(),
    maxInputTokens: z.number().int().positive(),
    estimatedInputTokens: z.number().int().nonnegative(),
    maxBookshelves: z.number().int().nonnegative(),
    selectedBookshelvesForDeepening: z.number().int().nonnegative(),
  }),
});

export const LibraryDiagnosticsSchema = z.object({
  schemaVersion: z.literal(LibraryGraphSchemaVersion),
  scopeKind: z.literal("library"),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  status: z.literal("passed"),
  failedCheckId: z.null(),
  severity: z.literal("info"),
  typedErrorCode: z.null(),
  affectedArtifactKind: z.literal("library_graph"),
  affectedArtifactDigest: z.string().min(1),
  expectedDigest: z.string().min(1),
  observedDigest: z.string().min(1),
  redactedLocator: z.string().min(1),
  remediationCommand: z.null(),
  checkedAt: z.string().min(1),
});

export const LibraryGraphManifestSchema = z.object({
  schemaVersion: z.literal(LibraryGraphSchemaVersion),
  kind: z.literal("qmd_graphrag_library_manifest"),
  libraryIdentity: z.object({
    libraryId: z.string().min(1),
    generation: z.string().min(1),
    membershipGeneration: z.string().min(1),
    createdAt: z.string().min(1),
    materializationStatus: z.literal("library_query_ready"),
    queryReady: z.literal(true),
  }),
  membership: z.object({
    bookshelfCount: z.number().int().positive(),
    directBookCount: z.number().int().nonnegative(),
    membersPath: z.literal("library_members.json"),
    membershipManifestPath: z.string().min(1),
    membershipManifestSha256: z.string().min(1),
    membersDigest: z.string().min(1),
    partitionPlanDigest: z.string().min(1),
    memberBookshelfManifestSha256: z.record(z.string(), z.string().min(1)),
    expandedMaterializedBookshelfIds: z.array(z.string().min(1)).min(1),
  }),
  buildConfig: z.object({
    builderVersion: z.literal(LibraryGraphBuilderVersion),
    maxReportsPerShelf: z.number().int().positive(),
    maxSemanticUnits: z.number().int().positive(),
    maxEdges: z.number().int().positive(),
    embeddingFingerprint: z.string().min(1),
    summaryFingerprint: z.string().min(1),
    evidenceSchema: z.literal("upper-evidence-map-v1"),
  }),
  graphArtifacts: z.object({
    semanticUnits: z.literal("semantic_units.parquet"),
    semanticEdges: z.literal("semantic_edges.parquet"),
    communities: z.literal("communities.parquet"),
    communityReports: z.literal("community_reports.parquet"),
    semanticUnitEmbeddings: z.literal("semantic_unit_embeddings.lance"),
  }),
  graphArtifactSchemas: z.object({
    semanticUnits: z.object({ requiredColumns: z.array(z.string().min(1)) }),
    semanticEdges: z.object({ requiredColumns: z.array(z.string().min(1)) }),
    communities: z.object({ requiredColumns: z.array(z.string().min(1)) }),
    communityReports: z.object({ requiredColumns: z.array(z.string().min(1)) }),
  }),
  evidenceMap: z.object({
    path: z.literal("evidence_map.parquet"),
    requiredColumns: z.array(z.string().min(1)),
    rowCount: z.number().int().positive(),
  }),
  fixedQueryBudget: z.object({
    maxSemanticUnits: z.number().int().positive(),
    maxBookshelves: z.number().int().nonnegative(),
    maxShelfCommunityRefs: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(),
    simulationStatus: z.literal("passed"),
  }),
  qualityGate: z.object({
    path: z.literal("state/library-quality-gate.json"),
    status: z.literal("passed"),
  }),
  files: z.array(FileRecordSchema),
  sensitivityPolicy: z.object({
    forbiddenFields: z.array(z.string().min(1)),
    locatorRule: z.string().min(1),
  }),
});

export type LibraryGraphManifest = z.infer<typeof LibraryGraphManifestSchema>;
export type LibraryQualityGate = z.infer<typeof LibraryQualityGateSchema>;

export const LibraryGraphChecks = [
  "member_bookshelf_manifest_sha256_matches",
  "member_bookshelf_gates_passed",
  "library_membership_gate_passed",
  "semantic_units_schema_valid",
  "semantic_edges_schema_valid",
  "semantic_edges_relation_types_allowed",
  "communities_schema_valid",
  "community_reports_schema_valid",
  "evidence_map_links_shelf_and_book_evidence",
  "embedding_fingerprint_matches_manifest",
  "fixed_query_budget_simulation_passed",
  "sensitive_payload_scan_passed",
  "stale_marker_absent",
];
