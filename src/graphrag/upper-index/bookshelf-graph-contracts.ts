import { z } from "zod";

export const BookshelfGraphSchemaVersion = "1.0.0";
export const BookshelfGraphBuilderVersion = "bookshelf-graph-build-v2";

export const RequiredParquetColumns = {
  "semantic_units.parquet": [
    "semanticUnitId",
    "level",
    "ownerId",
    "sourceKind",
    "sourceBookId",
    "sourceBookshelfId",
    "sourceCommunityReportId",
    "title",
    "summary",
    "rank",
    "tokenEstimate",
    "embeddingId",
    "generation",
    "evidenceMapIds",
  ],
  "semantic_edges.parquet": [
    "semanticEdgeId",
    "level",
    "ownerId",
    "sourceSemanticUnitId",
    "targetSemanticUnitId",
    "relationType",
    "weight",
    "direction",
    "sourceEntityTitles",
    "sourceRelationshipIds",
    "evidenceMapIds",
    "generation",
  ],
  "communities.parquet": [
    "id",
    "human_readable_id",
    "community",
    "level",
    "parent",
    "children",
    "title",
    "semanticUnitIds",
    "generation",
  ],
  "community_reports.parquet": [
    "id",
    "human_readable_id",
    "community",
    "level",
    "parent",
    "children",
    "title",
    "summary",
    "full_content",
    "rank",
    "findings",
    "evidenceMapIds",
    "generation",
  ],
  "evidence_map.parquet": [
    "evidenceMapId",
    "ownerLevel",
    "ownerId",
    "upperArtifactKind",
    "upperArtifactId",
    "targetLevel",
    "targetBookId",
    "targetBookshelfId",
    "targetSourceId",
    "targetDocumentId",
    "targetContentHash",
    "targetCommunityReportId",
    "targetTextUnitId",
    "targetArtifactDigest",
    "rank",
    "generation",
  ],
} as const;

export const BookshelfMemberSchema = z.object({
  bookId: z.string().min(1),
  manifestSha256: z.string().min(1),
  packageGeneration: z.string().min(1),
  queryReady: z.literal(true),
  qmdReadyState: z.string().min(1),
  graphRagReadyState: z.string().min(1),
  membershipSourceKind: z.string().min(1),
  membershipDecisionId: z.string().min(1),
  membershipConfidence: z.number(),
  userLocked: z.boolean(),
  splitGroupId: z.string().nullable(),
  virtualParentBookshelfId: z.string().nullable(),
  title: z.string().min(1),
  packageRoot: z.string().min(1),
  graphArtifacts: z.object({
    communityReports: z.string().min(1),
    entities: z.string().min(1),
    relationships: z.string().min(1),
    textUnits: z.string().min(1),
  }),
});

export const BookshelfMembersFileSchema = z.object({
  schemaVersion: z.literal(BookshelfGraphSchemaVersion),
  kind: z.literal("qmd_graphrag_bookshelf_members"),
  bookshelfId: z.string().min(1),
  generation: z.string().min(1),
  members: z.array(BookshelfMemberSchema).min(1),
});

export const BookshelfMembershipManifestSchema = z.object({
  schemaVersion: z.literal(BookshelfGraphSchemaVersion),
  kind: z.literal("qmd_graphrag_bookshelf_membership_manifest"),
  bookshelfIdentity: z.object({
    bookshelfId: z.string().min(1),
    generation: z.string().min(1),
    createdAt: z.string().min(1),
    materializationStatus: z.literal("membership_resolved"),
    queryReady: z.literal(false),
  }),
  membership: z.object({
    memberCount: z.number().int().positive(),
    membersPath: z.literal("bookshelf_members.json"),
    decisionsPath: z.literal("membership_decisions.jsonl"),
    splitPlanPath: z.literal("bookshelf_split_plan.json"),
    policyKind: z.string().min(1),
    policyDigest: z.string().min(1),
    membersDigest: z.string().min(1),
    decisionsDigest: z.string().min(1),
    splitPlanDigest: z.string().min(1),
  }),
  qualityGate: z.object({
    path: z.literal("state/membership-quality-gate.json"),
    status: z.literal("passed"),
  }),
}).passthrough();

export const MembershipQualityGateSchema = z.object({
  schemaVersion: z.literal(BookshelfGraphSchemaVersion),
  scopeKind: z.literal("bookshelf"),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  stageId: z.literal("bookshelf_membership_resolution"),
  readyState: z.literal("membership_resolved"),
  queryReady: z.literal(false),
  status: z.literal("passed"),
}).passthrough();

export const BookManifestSchema = z.object({
  schemaVersion: z.literal(BookshelfGraphSchemaVersion),
  kind: z.literal("qmd_graphrag_book_package"),
  identity: z.object({
    bookId: z.string().min(1),
    sourceHash: z.string().min(1),
    canonicalTitle: z.string().min(1),
    packageGeneration: z.string().min(1),
  }).passthrough(),
  qmd: z.object({
    qmdReadyState: z.string().min(1).optional(),
  }).passthrough(),
  input: z.object({
    normalizedHash: z.string().min(1).optional(),
  }).passthrough().optional(),
  graphrag: z.object({
    queryReady: z.literal(true),
    graphRagReadyState: z.string().min(1).optional(),
  }).passthrough(),
  checksums: z.object({
    manifestSha256: z.string().min(1),
  }).passthrough(),
}).passthrough();

export const GraphIdentitySchema = z.object({
  schemaVersion: z.literal(BookshelfGraphSchemaVersion),
  bookId: z.string().min(1),
  sourceId: z.string().min(1).optional(),
  sourceHash: z.string().min(1),
  documentId: z.string().min(1).optional(),
  contentHash: z.string().min(1).optional(),
  graphTextUnitIds: z.array(z.string().min(1)).optional(),
}).passthrough();

export const FileRecordSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});

export const BookshelfQualityGateSchema = z.object({
  schemaVersion: z.literal(BookshelfGraphSchemaVersion),
  scopeKind: z.literal("bookshelf"),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  stageId: z.literal("materialized_bookshelf_graph_build"),
  readyState: z.literal("bookshelf_query_ready"),
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
    maxBooksForDeepening: z.number().int().nonnegative(),
    selectedBooksForDeepening: z.number().int().nonnegative(),
  }),
});

export const BookshelfDiagnosticsSchema = z.object({
  schemaVersion: z.literal(BookshelfGraphSchemaVersion),
  scopeKind: z.literal("bookshelf"),
  scopeId: z.string().min(1),
  generation: z.string().min(1),
  status: z.literal("passed"),
  failedCheckId: z.null(),
  severity: z.literal("info"),
  typedErrorCode: z.null(),
  affectedArtifactKind: z.literal("bookshelf_graph"),
  affectedArtifactDigest: z.string().min(1),
  expectedDigest: z.string().min(1),
  observedDigest: z.string().min(1),
  redactedLocator: z.string().min(1),
  remediationCommand: z.null(),
  checkedAt: z.string().min(1),
});

export const ParquetInspectionSchema = z.object({
  ok: z.boolean(),
  diagnostics: z.array(z.string()),
  artifacts: z.record(z.string(), z.object({
    path: z.string().min(1),
    rowCount: z.number().int().nonnegative(),
    columns: z.array(z.string()).optional(),
    sha256: z.string().min(1).optional(),
    bytes: z.number().int().nonnegative().optional(),
    kind: z.string().optional(),
    fingerprint: z.string().optional(),
  })),
});

export const BookshelfQueryBridgeEvidenceSchema = z.object({
  evidenceMapId: z.string().min(1),
  upperCommunityReportId: z.string().min(1),
  upperCommunityReportTitle: z.string().min(1),
  quote: z.string().min(1),
  score: z.number(),
  targetBookId: z.string().min(1),
  targetBookshelfId: z.string().min(1).optional(),
  targetSourceId: z.string().min(1),
  targetDocumentId: z.string().min(1),
  targetContentHash: z.string().min(1),
  targetCommunityReportId: z.string().min(1),
  targetTextUnitId: z.string().min(1),
  targetArtifactDigest: z.string().min(1),
  ownerId: z.string().min(1),
  generation: z.string().min(1),
});

export const BookshelfQueryBridgeResponseSchema = z.object({
  ok: z.boolean(),
  diagnostics: z.array(z.string()),
  reportCount: z.number().int().nonnegative(),
  selectedReportCount: z.number().int().nonnegative(),
  estimatedInputTokens: z.number().int().nonnegative(),
  maxInputTokens: z.number().int().positive(),
  answerText: z.string(),
  evidence: z.array(BookshelfQueryBridgeEvidenceSchema),
});

export const BookshelfGraphManifestSchema = z.object({
  schemaVersion: z.literal(BookshelfGraphSchemaVersion),
  kind: z.literal("qmd_graphrag_bookshelf_manifest"),
  bookshelfIdentity: z.object({
    bookshelfId: z.string().min(1),
    generation: z.string().min(1),
    membershipGeneration: z.string().min(1),
    createdAt: z.string().min(1),
    materializationStatus: z.literal("bookshelf_query_ready"),
    queryReady: z.literal(true),
  }),
  membership: z.object({
    memberCount: z.number().int().positive(),
    membersPath: z.literal("bookshelf_members.json"),
    membershipManifestPath: z.string().min(1),
    membershipManifestSha256: z.string().min(1),
    membersDigest: z.string().min(1),
    decisionsDigest: z.string().min(1),
    splitPlanDigest: z.string().min(1),
    memberManifestSha256: z.record(z.string(), z.string().min(1)),
  }),
  buildConfig: z.object({
    builderVersion: z.literal(BookshelfGraphBuilderVersion),
    maxReportsPerBook: z.number().int().positive(),
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
    maxBooksForDeepening: z.number().int().nonnegative(),
    maxMemberCommunityRefs: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(),
    simulationStatus: z.literal("passed"),
  }),
  qualityGate: z.object({
    path: z.literal("state/bookshelf-quality-gate.json"),
    status: z.literal("passed"),
  }),
  files: z.array(FileRecordSchema),
  sensitivityPolicy: z.object({
    forbiddenFields: z.array(z.string().min(1)),
    locatorRule: z.string().min(1),
  }),
});

export type BookshelfMember = z.infer<typeof BookshelfMemberSchema>;
export type BookshelfMembersFile = z.infer<typeof BookshelfMembersFileSchema>;
export type BookshelfMembershipManifest =
  z.infer<typeof BookshelfMembershipManifestSchema>;
export type BookManifest = z.infer<typeof BookManifestSchema>;
export type BookshelfGraphManifest =
  z.infer<typeof BookshelfGraphManifestSchema>;
export type BookshelfQualityGate = z.infer<typeof BookshelfQualityGateSchema>;
export type ParquetInspection = z.infer<typeof ParquetInspectionSchema>;
export type BookshelfQueryBridgeResponse =
  z.infer<typeof BookshelfQueryBridgeResponseSchema>;

export const BookshelfGraphChecks = [
  "member_manifest_sha256_matches",
  "member_package_gates_passed",
  "membership_decisions_schema_valid",
  "semantic_units_schema_valid",
  "semantic_edges_schema_valid",
  "semantic_edges_relation_types_allowed",
  "communities_schema_valid",
  "community_reports_schema_valid",
  "evidence_map_lineage_valid",
  "embedding_fingerprint_matches_manifest",
  "fixed_query_budget_simulation_passed",
  "sensitive_payload_scan_passed",
  "stale_marker_absent",
];

export const ForbiddenFields = [
  "providerRequestPayload",
  "providerResponsePayload",
  "rawPrompt",
  "rawCompletion",
  "apiKey",
  "credential",
  "absoluteLocalPath",
  "queryLogContent",
];
