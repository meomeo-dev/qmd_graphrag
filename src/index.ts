/**
 * QMD SDK - Library mode for programmatic access to QMD search and indexing.
 *
 * Usage:
 *   import { createStore } from '@tobilu/qmd'
 *
 *   const store = await createStore({
 *     dbPath: './my-index.sqlite',
 *     config: {
 *       collections: {
 *         docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *       }
 *     }
 *   })
 *
 *   const results = await store.search({ query: "how does auth work?" })
 *   await store.close()
 */

import {
  createStore as createStoreInternal,
  hybridQuery,
  structuredSearch,
  extractSnippet,
  addLineNumbers,
  DEFAULT_MULTI_GET_MAX_BYTES,
  reindexCollection,
  generateEmbeddings,
  listCollections as storeListCollections,
  syncConfigToDb,
  getStoreCollections,
  getStoreCollection,
  getStoreGlobalContext,
  getStoreContexts,
  upsertStoreCollection,
  deleteStoreCollection,
  renameStoreCollection,
  updateStoreContext,
  removeStoreContext,
  setStoreGlobalContext,
  vacuumDatabase,
  cleanupOrphanedContent,
  cleanupOrphanedVectors,
  deleteLLMCache,
  deleteInactiveDocuments,
  clearAllEmbeddings,
  type Store as InternalStore,
  type DocumentResult,
  type DocumentNotFound,
  type SearchResult,
  type HybridQueryResult,
  type HybridQueryOptions,
  type HybridQueryExplain,
  type ExpandedQuery,
  type StructuredSearchOptions,
  type MultiGetResult,
  type IndexStatus,
  type IndexHealthInfo,
  type SearchHooks,
  type ReindexProgress,
  type ReindexResult,
  type EmbedProgress,
  type EmbedResult,
  type ChunkStrategy,
} from "./store.js";
import {
  LlamaCpp,
} from "./llm.js";
import {
  setConfigSource,
  loadConfig,
  addCollection as collectionsAddCollection,
  removeCollection as collectionsRemoveCollection,
  renameCollection as collectionsRenameCollection,
  addContext as collectionsAddContext,
  removeContext as collectionsRemoveContext,
  setGlobalContext as collectionsSetGlobalContext,
  type Collection,
  type CollectionConfig,
  type NamedCollection,
  type ContextMap,
} from "./collections.js";
import { createQmdGraphRagRuntime, type QmdGraphRagRuntime } from "./runtime.js";
import type {
  BatchCommandCheck,
  BatchEventLog,
  BatchFailureKind,
  BatchItemCheckpoint,
  BatchItemCheckpointInput,
  BatchItemStatus,
  BatchProjectRelativeLocator,
  BatchRecoveryDecision,
  BatchRunManifest,
  BatchRunStatus,
} from "./contracts/batch-run.js";
import type {
  GraphRagIndexMethod,
  GraphRagIndexRequest,
  GraphRagIndexResponse,
  GraphRagQueryRequest,
  GraphRagQueryResponse,
  GraphRagCapabilityScope,
  GraphRagEvidence,
  GraphRagSearchMethod,
  GraphRagWorkflowName,
} from "./contracts/graphrag.js";
import type {
  DspyExpansionFailureReason,
  DspyExpansionPolicy,
  DspyFingerprintSet,
  DspyAutoMode,
  DspyEvaluationDataset,
  DspyEvaluationReport,
  DspyGeneratedExpansionRecord,
  DspyMetricSpec,
  DspyOptimizer,
  DspyOptimizationArtifact,
  DspyOptimizationRequestSummary,
  DspyOptimizationResponseSummary,
  DspyOptimizationRun,
  DspyPointerLockError,
  DspyPolicyPointer,
  DspyPromotionDecision,
  DspyPromotionHistoryEntry,
  DspyQueryExpansionProgramInput,
  DspyQueryExpansionProgramOutput,
  DspyQueryPromptOptimizationRequest,
  DspyQueryPromptOptimizationResponse,
  QueryExpansionFailureAction,
  QueryExpansionFailurePolicy,
  QueryExpansionFailureReason,
} from "./contracts/dspy.js";
import type {
  BridgeEnvironment,
  QueryExpansionItem,
  QueryKind,
} from "./contracts/common.js";
import type {
  DataBusEnvelope,
} from "./contracts/bus.js";
import type {
  VaultRestoreReport,
  VaultRestoreRequest,
} from "./contracts/vault.js";
import type {
  JinaEmbeddingItem,
  JinaEmbeddingProfile,
  JinaEmbeddingProfileName,
  JinaEmbeddingRequest,
  JinaEmbeddingResponse,
  JinaEmbeddingTask,
  JinaEmbeddingType,
  JinaProviderConfig,
  JinaRerankDocument,
  JinaRerankRequest,
  JinaRerankResponse,
  JinaRerankResult,
} from "./contracts/jina.js";
import type {
  CorpusChunk,
  CorpusDocument,
  DocumentIdentityCatalog,
  DocumentIdentityMap,
  GraphTextUnitIdentityMap,
  SourceDocument,
  SourceDocumentCatalog,
  SourceLocator,
} from "./contracts/corpus.js";
import type {
  ContentVectorEmbeddingRecord,
  QmdQueryRequest,
  QmdQuerySearch,
  QmdRetrievalCandidate,
  QmdSearchResult,
  QmdVectorSearchRequest,
  QmdVectorSearchResult,
} from "./contracts/qmd-query.js";
import type {
  GraphCapability,
  GraphCapabilityCatalog,
  GraphCapabilityKind,
  GraphEnhancementRequest,
  GraphEnhancementState,
  GraphEnhancementStatus,
} from "./contracts/graph-enhancement.js";
import type {
  CandidateDistribution,
  CandidateRouteDecision,
  EvidenceLocator,
  EvidenceRef,
  GraphCapabilityError,
  QueryCostClass,
  QueryIntentClass,
  QueryRoute,
  QueryRouteDecision,
  QueryStage,
  RouteRefusalReason,
  RouteDecisionStatus,
  SelectedQueryRoute,
  TypedQueryError,
  UnifiedAnswer,
  UnifiedQueryRequest,
} from "./contracts/unified-query.js";
import type {
  OpenAIResponsesProviderConfig,
  OpenAIResponsesReasoning,
  OpenAIResponsesRequest,
  OpenAIResponsesResponse,
  OpenAIResponsesStreamEvent,
  OpenAIStructuredOutputSchema,
  ProviderCostAccounting,
  ProviderRequestFingerprint,
  StrictJsonSchemaNode,
} from "./contracts/provider.js";
import type {
  BookArtifactKind,
  BookArtifactManifest,
  BookJob,
  BookJobRunRecord,
  BookJobStageCheckpoint,
  BookJobStatus,
  BookResumePlan,
  BookResumeStageState,
  BookStage,
  StageCheckpointStatus,
} from "./contracts/book-job.js";
import {
  FileBookJobStateRepository,
  type BuildGraphEnhancementRequestInput,
  type CompleteStageInput,
  type FailStageInput,
  type RecordArtifactInput,
  type RegisterBookSourceInput,
  type StageArtifactRequirementMap,
  type StageFingerprintMap,
  type StartStageInput,
} from "./job-state/repository.js";
import {
  syncGraphRagBookWorkspace,
} from "./job-state/graphrag-book.js";
import type {
  BuildUnifiedAnswerInput,
} from "./query/unified-answer.js";
import type {
  DecideRouteInput,
  RouteQueryServices,
} from "./query/unified-router.js";

// Re-export types for SDK consumers
export type {
  DocumentResult,
  DocumentNotFound,
  SearchResult,
  HybridQueryResult,
  HybridQueryOptions,
  HybridQueryExplain,
  ExpandedQuery,
  StructuredSearchOptions,
  MultiGetResult,
  IndexStatus,
  IndexHealthInfo,
  SearchHooks,
  ReindexProgress,
  ReindexResult,
  EmbedProgress,
  EmbedResult,
  Collection,
  CollectionConfig,
  NamedCollection,
  ContextMap,
  BatchCommandCheck,
  BatchEventLog,
  BatchFailureKind,
  BatchItemCheckpoint,
  BatchItemCheckpointInput,
  BatchItemStatus,
  BatchProjectRelativeLocator,
  BatchRecoveryDecision,
  BatchRunManifest,
  BatchRunStatus,
  GraphRagIndexMethod,
  GraphRagIndexRequest,
  GraphRagIndexResponse,
  GraphRagQueryRequest,
  GraphRagQueryResponse,
  GraphRagCapabilityScope,
  GraphRagEvidence,
  GraphRagSearchMethod,
  GraphRagWorkflowName,
  DspyAutoMode,
  DspyExpansionFailureReason,
  DspyExpansionPolicy,
  DspyEvaluationDataset,
  DspyEvaluationReport,
  DspyFingerprintSet,
  DspyGeneratedExpansionRecord,
  DspyMetricSpec,
  DspyOptimizer,
  DspyOptimizationArtifact,
  DspyOptimizationRequestSummary,
  DspyOptimizationResponseSummary,
  DspyOptimizationRun,
  DspyPointerLockError,
  DspyPolicyPointer,
  DspyPromotionDecision,
  DspyPromotionHistoryEntry,
  DspyQueryExpansionProgramInput,
  DspyQueryExpansionProgramOutput,
  DspyQueryPromptOptimizationRequest,
  DspyQueryPromptOptimizationResponse,
  QueryExpansionFailureAction,
  QueryExpansionFailurePolicy,
  QueryExpansionFailureReason,
  BridgeEnvironment,
  JinaEmbeddingItem,
  JinaEmbeddingProfile,
  JinaEmbeddingProfileName,
  JinaEmbeddingRequest,
  JinaEmbeddingResponse,
  JinaEmbeddingTask,
  JinaEmbeddingType,
  JinaProviderConfig,
  JinaRerankDocument,
  JinaRerankRequest,
  JinaRerankResponse,
  JinaRerankResult,
  SourceLocator,
  SourceDocument,
  SourceDocumentCatalog,
  CorpusDocument,
  CorpusChunk,
  DocumentIdentityMap,
  DocumentIdentityCatalog,
  ContentVectorEmbeddingRecord,
  QmdQuerySearch,
  QmdQueryRequest,
  QmdVectorSearchRequest,
  QmdRetrievalCandidate,
  QmdSearchResult,
  QmdVectorSearchResult,
  GraphCapabilityKind,
  GraphEnhancementStatus,
  GraphEnhancementRequest,
  GraphEnhancementState,
  GraphCapability,
  GraphCapabilityCatalog,
  QueryRoute,
  SelectedQueryRoute,
  RouteDecisionStatus,
  QueryIntentClass,
  QueryCostClass,
  RouteRefusalReason,
  UnifiedQueryRequest,
  CandidateDistribution,
  CandidateRouteDecision,
  QueryRouteDecision,
  EvidenceLocator,
  EvidenceRef,
  UnifiedAnswer,
  QueryStage,
  GraphCapabilityError,
  TypedQueryError,
  OpenAIResponsesProviderConfig,
  OpenAIResponsesReasoning,
  OpenAIResponsesRequest,
  OpenAIResponsesResponse,
  StrictJsonSchemaNode,
  OpenAIStructuredOutputSchema,
  OpenAIResponsesStreamEvent,
  ProviderCostAccounting,
  ProviderRequestFingerprint,
  BuildUnifiedAnswerInput,
  DecideRouteInput,
  RouteQueryServices,
  DataBusEnvelope,
  QueryExpansionItem,
  QueryKind,
  VaultRestoreRequest,
  VaultRestoreReport,
  BookArtifactKind,
  BookArtifactManifest,
  BookJob,
  BookJobRunRecord,
  BookJobStageCheckpoint,
  BookJobStatus,
  BookResumePlan,
  BookResumeStageState,
  BookStage,
  StageCheckpointStatus,
};

// Re-export the internal Store type for advanced consumers
export type { InternalStore };

// Re-export utility functions and types used by frontends
export { extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES };
export type { ChunkStrategy } from "./store.js";
export { createQmdGraphRagRuntime };
export type { QmdGraphRagRuntime };
export {
  SchemaVersion,
  JsonPrimitiveSchema,
  JsonValueSchema,
  QueryKindSchema,
  QueryExpansionItemSchema,
  QueryExpansionItemEnvelopeSchema,
  BridgeEnvironmentSchema,
} from "./contracts/common.js";
export {
  SourceLocatorSchema,
  SourceDocumentSchema,
  SourceDocumentEnvelopeSchema,
  SourceDocumentCatalogSchema,
  SourceDocumentCatalogEnvelopeSchema,
  CorpusDocumentSchema,
  CorpusDocumentEnvelopeSchema,
  CorpusChunkSchema,
  CorpusChunkEnvelopeSchema,
  DocumentIdentityMapSchema,
  DocumentIdentityMapEnvelopeSchema,
  DocumentIdentityCatalogSchema,
  DocumentIdentityCatalogEnvelopeSchema,
  GraphTextUnitIdentityMapSchema,
  GraphTextUnitIdentityMapEnvelopeSchema,
} from "./contracts/corpus.js";
export {
  BatchItemStatusSchema,
  BatchRunStatusSchema,
  BatchFailureKindSchema,
  BatchRecoveryDecisionSchema,
  BatchProjectRelativeLocatorSchema,
  BatchCommandCheckSchema,
  BatchItemCheckpointInputSchema,
  BatchItemCheckpointSchema,
  BatchRunManifestSchema,
  BatchEventLogSchema,
  BatchRunManifestEnvelopeSchema,
  BatchItemCheckpointEnvelopeSchema,
  BatchEventLogEnvelopeSchema,
  parseBatchItemCheckpoint,
} from "./contracts/batch-run.js";
export {
  ContentVectorEmbeddingRecordSchema,
  ContentVectorEmbeddingRecordEnvelopeSchema,
  QmdQuerySearchSchema,
  QmdQueryRequestSchema,
  QmdQueryRequestEnvelopeSchema,
  QmdVectorSearchRequestSchema,
  QmdVectorSearchRequestEnvelopeSchema,
  QmdRetrievalCandidateSchema,
  QmdRetrievalCandidateEnvelopeSchema,
  QmdSearchResultSchema,
  QmdSearchResultEnvelopeSchema,
  QmdVectorSearchResultSchema,
  QmdVectorSearchResultEnvelopeSchema,
} from "./contracts/qmd-query.js";
export {
  GraphCapabilityKindSchema,
  GraphEnhancementStatusSchema,
  GraphEnhancementRequestSchema,
  GraphEnhancementRequestEnvelopeSchema,
  GraphEnhancementStateSchema,
  GraphEnhancementStateEnvelopeSchema,
  GraphCapabilitySchema,
  GraphCapabilityCatalogSchema,
  GraphCapabilityEnvelopeSchema,
  GraphCapabilityCatalogEnvelopeSchema,
} from "./contracts/graph-enhancement.js";
export {
  QueryRouteSchema,
  SelectedQueryRouteSchema,
  RouteDecisionStatusSchema,
  QueryIntentClassSchema,
  QueryCostClassSchema,
  RouteRefusalReasonSchema,
  UnifiedQueryRequestSchema,
  UnifiedQueryRequestEnvelopeSchema,
  CandidateDistributionSchema,
  CandidateRouteDecisionSchema,
  QueryRouteDecisionSchema,
  QueryRouteDecisionEnvelopeSchema,
  CandidateRouteDecisionEnvelopeSchema,
  EvidenceLocatorSchema,
  EvidenceRefSchema,
  EvidenceRefEnvelopeSchema,
  UnifiedAnswerSchema,
  UnifiedAnswerEnvelopeSchema,
  QueryStageSchema,
  GraphCapabilityErrorSchema,
  GraphCapabilityErrorEnvelopeSchema,
  TypedQueryErrorSchema,
  TypedQueryErrorEnvelopeSchema,
} from "./contracts/unified-query.js";
export {
  OpenAIResponsesProviderConfigSchema,
  OpenAIResponsesProviderConfigEnvelopeSchema,
  OpenAIResponsesReasoningSchema,
  OpenAIResponsesRequestSchema,
  OpenAIResponsesRequestEnvelopeSchema,
  OpenAIResponsesResponseSchema,
  OpenAIResponsesResponseEnvelopeSchema,
  StrictJsonSchemaNodeSchema,
  OpenAIStructuredOutputSchemaSchema,
  OpenAIStructuredOutputSchemaEnvelopeSchema,
  OpenAIResponsesStreamEventSchema,
  OpenAIResponsesStreamEventEnvelopeSchema,
  ProviderCostAccountingSchema,
  ProviderCostAccountingEnvelopeSchema,
  ProviderRequestFingerprintSchema,
  ProviderRequestFingerprintEnvelopeSchema,
} from "./contracts/provider.js";
export {
  JinaEmbeddingProfileNameSchema,
  JinaEmbeddingTaskSchema,
  JinaEmbeddingTypeSchema,
  JinaEmbeddingProfileSchema,
  JinaProviderConfigSchema,
  JinaProviderConfigEnvelopeSchema,
  JinaEmbeddingRequestSchema,
  JinaEmbeddingRequestEnvelopeSchema,
  JinaEmbeddingItemSchema,
  JinaEmbeddingResponseSchema,
  JinaEmbeddingResponseEnvelopeSchema,
  JinaRerankDocumentSchema,
  JinaRerankRequestSchema,
  JinaRerankRequestEnvelopeSchema,
  JinaRerankResponseSchema,
  JinaRerankResponseEnvelopeSchema,
  JinaRerankResultSchema,
} from "./contracts/jina.js";
export {
  BookStageSchema,
  BookJobStatusSchema,
  StageCheckpointStatusSchema,
  BookArtifactKindSchema,
  BookJobSchema,
  BookJobEnvelopeSchema,
  BookJobCatalogEnvelopeSchema,
  BookJobStageCheckpointSchema,
  BookJobStageCheckpointEnvelopeSchema,
  BookJobCheckpointListEnvelopeSchema,
  BookArtifactManifestSchema,
  BookArtifactManifestEnvelopeSchema,
  BookArtifactManifestListEnvelopeSchema,
  BookJobRunRecordSchema,
  BookJobRunRecordEnvelopeSchema,
  BookJobCatalogSchema,
  BookJobCheckpointListSchema,
  BookArtifactManifestListSchema,
  BookJobRunCatalogEntrySchema,
  BookJobRunCatalogSchema,
  BookJobRunCatalogEnvelopeSchema,
  BookResumeStageStateSchema,
  BookResumePlanSchema,
  BookResumePlanEnvelopeSchema,
  BookStageOrder,
} from "./contracts/book-job.js";
export {
  GraphRagSearchMethodSchema,
  GraphRagCapabilityScopeSchema,
  GraphRagIndexMethodSchema,
  GraphRagWorkflowNameSchema,
  GraphRagQueryRequestSchema,
  GraphRagWorkflowResultSchema,
  GraphRagIndexRequestSchema,
  GraphRagEvidenceSchema,
  GraphRagEvidenceEnvelopeSchema,
  GraphRagQueryResponseSchema,
  GraphRagIndexResponseSchema,
  GraphRagProviderDetailSchema,
  GraphRagProviderDetailEnvelopeSchema,
  GraphRagQueryEnvelopeSchema,
  GraphRagQueryResponseEnvelopeSchema,
  GraphRagIndexEnvelopeSchema,
  GraphRagIndexResponseEnvelopeSchema,
} from "./contracts/graphrag.js";
export {
  DspyOptimizerSchema,
  DspyAutoModeSchema,
  DspyProgramNameSchema,
  DspyRuntimeProjectionSchema,
  DspyPromotionStatusSchema,
  DspyRunStatusSchema,
  DspyGateVerdictSchema,
  DspyPolicyProviderSchema,
  QueryExpansionFailureActionSchema,
  QueryExpansionFailureReasonSchema,
  DspyExpansionFailureReasonSchema,
  DspyArtifactRequestModeSchema,
  DspyArtifactPromotabilitySchema,
  VaultRelativePathSchema,
  EnvVarNameSchema,
  RedactedTextSchema,
  DspyQueryPromptOptimizationRequestSchema,
  DspyGeneratedExpansionRecordSchema,
  DspyQueryPromptOptimizationResponseSchema,
  DspyOptimizationRequestSummarySchema,
  DspyOptimizationResponseSummarySchema,
  QueryExpansionFailurePolicySchema,
  CorpusSnapshotRefSchema,
  QmdIndexSnapshotRefSchema,
  DspyFingerprintSetSchema,
  DspyOptimizationRunSchema,
  DspyOptimizationArtifactSchema,
  DspyExpansionPolicySchema,
  DspyPolicyPointerSchema,
  DspyPointerLockErrorSchema,
  DspyEvaluationDatasetSchema,
  DspyEvaluationReportSchema,
  DspyPromotionDecisionSchema,
  DspyPromotionHistoryEntrySchema,
  DspyQueryExpansionProgramInputSchema,
  DspyQueryExpansionProgramOutputSchema,
  DspyMetricSpecSchema,
  DspyOptimizationEnvelopeSchema,
  DspyOptimizationResponseEnvelopeSchema,
  DspyGeneratedExpansionRecordEnvelopeSchema,
  DspyOptimizationRunEnvelopeSchema,
  DspyOptimizationArtifactEnvelopeSchema,
  DspyExpansionPolicyEnvelopeSchema,
  DspyPolicyPointerEnvelopeSchema,
  DspyPointerLockErrorEnvelopeSchema,
  DspyEvaluationDatasetEnvelopeSchema,
  DspyEvaluationReportEnvelopeSchema,
  DspyPromotionDecisionEnvelopeSchema,
  DspyPromotionHistoryEntryEnvelopeSchema,
  DspyQueryExpansionProgramInputEnvelopeSchema,
  DspyQueryExpansionProgramOutputEnvelopeSchema,
  DspyMetricSpecEnvelopeSchema,
} from "./contracts/dspy.js";
export { DataBusEnvelopeSchema } from "./contracts/bus.js";
export {
  VaultRestoreRequestSchema,
  VaultRestoreRequestEnvelopeSchema,
  VaultRestoreReportSchema,
  VaultRestoreReportEnvelopeSchema,
} from "./contracts/vault.js";
export {
  buildEvidenceRefsFromQmdResults,
  buildEvidenceRefsFromGraphRagResponse,
  buildUnifiedAnswer,
} from "./query/unified-answer.js";
export {
  DEFAULT_GRAPH_COVERAGE_THRESHOLD,
  DEFAULT_MAX_COST_CLASS,
  TypedQueryErrorException,
  buildGraphCapabilityError,
  classifyQueryIntent,
  createTypedQueryError,
  decideRoute,
  routeQuery,
} from "./query/unified-router.js";
export {
  FileBookJobStateRepository,
  type BuildGraphEnhancementRequestInput,
  type CompleteStageInput,
  type FailStageInput,
  type RecordArtifactInput,
  type RegisterBookSourceInput,
  type StageArtifactRequirementMap,
  type StageFingerprintMap,
  type StartStageInput,
} from "./job-state/repository.js";
export {
  readGraphTextUnitIdentity,
  syncGraphRagBookWorkspace,
} from "./job-state/graphrag-book.js";
export {
  loadGraphCapabilities,
  loadGraphQueryCapabilities,
  recordGraphCapability,
  resolveCandidateGraphCapabilities,
} from "./graphrag/capability-catalog.js";
export {
  assertManagedGraphRagSettings,
  buildGraphRagRuntimeSettingsProjection,
  graphRagProjectConfigFingerprint,
  writeManagedGraphRagSettings,
  writeManagedGraphRagSettingsSync,
} from "./graphrag/settings-projection.js";
export {
  buildProviderCostAccounting,
  appendProviderCostAccounting,
} from "./provider/cost-accounting.js";
export {
  restoreFromVault,
} from "./vault/restore.js";
export type {
  GraphRagBookWorkspacePaths,
  GraphRagBookWorkspaceState,
  GraphRagTextUnitIdentity,
  SyncGraphRagBookWorkspaceInput,
} from "./job-state/graphrag-book.js";
export {
  isJinaRerankModel,
} from "./llm.js";
export {
  buildBookId,
  buildBookIdFromSourceHash,
  createDeterministicHash,
  createRunId,
  hashFile,
  hashText,
  normalizeBookSlug,
  toIsoTimestamp,
} from "./job-state/fingerprint.js";

// Re-export getDefaultDbPath for CLI/MCP that need the default database location
export { getDefaultDbPath } from "./store.js";

// Re-export Maintenance class for CLI housekeeping operations
export { Maintenance } from "./maintenance.js";

/**
 * Progress info emitted during update() for each file processed.
 */
export type UpdateProgress = {
  collection: string;
  file: string;
  current: number;
  total: number;
};

/**
 * Aggregated result from update() across all collections.
 */
export type UpdateResult = {
  collections: number;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  needsEmbedding: number;
};

/**
 * Options for the unified search() method.
 */
export interface SearchOptions {
  /** Simple query string — will be auto-expanded via LLM */
  query?: string;
  /** Pre-expanded queries (from expandQuery) — skips auto-expansion */
  queries?: ExpandedQuery[];
  /** Domain intent hint — steers expansion and reranking */
  intent?: string;
  /** Rerank results using LLM (default: true) */
  rerank?: boolean;
  /** Filter to a specific collection */
  collection?: string;
  /** Filter to specific collections */
  collections?: string[];
  /** Max results (default: 10) */
  limit?: number;
  /** Max candidates to rerank (default: 40) */
  candidateLimit?: number;
  /** Minimum score threshold */
  minScore?: number;
  /** Include explain traces */
  explain?: boolean;
  /** Chunk strategy: "auto" (default, uses AST for code files) or "regex" (legacy) */
  chunkStrategy?: ChunkStrategy;
}

/**
 * Options for searchLex() — BM25 keyword search.
 */
export interface LexSearchOptions {
  limit?: number;
  collection?: string;
}

/**
 * Options for searchVector() — vector similarity search.
 */
export interface VectorSearchOptions {
  limit?: number;
  collection?: string;
}

/**
 * Options for expandQuery() — manual query expansion.
 */
export interface ExpandQueryOptions {
  intent?: string;
}

/**
 * Options for creating a QMD store.
 *
 * Provide `dbPath` and optionally `configPath` (YAML file) or `config` (inline).
 * If neither configPath nor config is provided, the store reads from existing
 * DB state (useful for reopening a previously-configured store).
 */
export interface StoreOptions {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Path to a YAML config file (mutually exclusive with `config`) */
  configPath?: string;
  /** Inline collection config (mutually exclusive with `configPath`) */
  config?: CollectionConfig;
}

/**
 * The QMD SDK store — provides search, retrieval, collection management,
 * context management, and indexing operations.
 *
 * All methods are async. The store manages its own LlamaCpp instance
 * (lazy-loaded, auto-unloaded after inactivity) — no global singletons.
 */
export interface QMDStore {
  /** The underlying internal store (for advanced use) */
  readonly internal: InternalStore;
  /** Path to the SQLite database */
  readonly dbPath: string;

  // ── Search ──────────────────────────────────────────────────────────

  /** Full search: query expansion + multi-signal retrieval + LLM reranking */
  search(options: SearchOptions): Promise<HybridQueryResult[]>;

  /** BM25 keyword search (fast, no LLM) */
  searchLex(query: string, options?: LexSearchOptions): Promise<SearchResult[]>;

  /** Vector similarity search (embedding model, no reranking) */
  searchVector(query: string, options?: VectorSearchOptions): Promise<SearchResult[]>;

  /** Expand a query into typed sub-searches (lex/vec/hyde) for manual control */
  expandQuery(query: string, options?: ExpandQueryOptions): Promise<ExpandedQuery[]>;

  // ── Document Retrieval ──────────────────────────────────────────────

  /** Get a single document by path or docid */
  get(pathOrDocid: string, options?: { includeBody?: boolean }): Promise<DocumentResult | DocumentNotFound>;

  /** Get the body content of a document, optionally sliced by line range */
  getDocumentBody(pathOrDocid: string, opts?: { fromLine?: number; maxLines?: number }): Promise<string | null>;

  /** Get multiple documents by glob pattern or comma-separated list */
  multiGet(pattern: string, options?: { includeBody?: boolean; maxBytes?: number }): Promise<{ docs: MultiGetResult[]; errors: string[] }>;

  // ── Collection Management ───────────────────────────────────────────

  /** Add or update a collection */
  addCollection(name: string, opts: { path: string; pattern?: string; ignore?: string[] }): Promise<void>;

  /** Remove a collection */
  removeCollection(name: string): Promise<boolean>;

  /** Rename a collection */
  renameCollection(oldName: string, newName: string): Promise<boolean>;

  /** List all collections with document stats */
  listCollections(): Promise<{ name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number; last_modified: string | null; includeByDefault: boolean }[]>;

  /** Get names of collections included by default in queries */
  getDefaultCollectionNames(): Promise<string[]>;

  // ── Context Management ──────────────────────────────────────────────

  /** Add context for a path within a collection */
  addContext(collectionName: string, pathPrefix: string, contextText: string): Promise<boolean>;

  /** Remove context from a collection path */
  removeContext(collectionName: string, pathPrefix: string): Promise<boolean>;

  /** Set global context (applies to all collections) */
  setGlobalContext(context: string | undefined): Promise<void>;

  /** Get global context */
  getGlobalContext(): Promise<string | undefined>;

  /** List all contexts across all collections */
  listContexts(): Promise<Array<{ collection: string; path: string; context: string }>>;

  // ── Indexing ────────────────────────────────────────────────────────

  /** Re-index collections by scanning the filesystem */
  update(options?: {
    collections?: string[];
    onProgress?: (info: UpdateProgress) => void;
  }): Promise<UpdateResult>;

  /** Generate vector embeddings for documents that need them */
  embed(options?: {
    force?: boolean;
    model?: string;
    /** Restrict embedding to documents in one collection. */
    collection?: string;
    maxDocsPerBatch?: number;
    maxBatchBytes?: number;
    chunkStrategy?: ChunkStrategy;
    onProgress?: (info: EmbedProgress) => void;
  }): Promise<EmbedResult>;

  // ── Index Health ────────────────────────────────────────────────────

  /** Get index status (document counts, collections, embedding state) */
  getStatus(): Promise<IndexStatus>;

  /** Get index health info (stale embeddings, etc.) */
  getIndexHealth(): Promise<IndexHealthInfo>;

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Close the store and release all resources (LLM models, DB connection) */
  close(): Promise<void>;
}

/**
 * Create a QMD store for programmatic access to search and indexing.
 *
 * @example
 * ```typescript
 * // With a YAML config file
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   configPath: './qmd.yml',
 * })
 *
 * // With inline config (no files needed besides the DB)
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   config: {
 *     collections: {
 *       docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *     }
 *   }
 * })
 *
 * const results = await store.search({ query: "authentication flow" })
 * await store.close()
 * ```
 */
export async function createStore(options: StoreOptions): Promise<QMDStore> {
  if (!options.dbPath) {
    throw new Error("dbPath is required");
  }
  if (options.configPath && options.config) {
    throw new Error("Provide either configPath or config, not both");
  }

  // Create the internal store (opens DB, creates tables)
  const internal = createStoreInternal(options.dbPath);
  const db = internal.db;

  // Track whether we have a YAML config path for write-through
  const hasYamlConfig = !!options.configPath;

  // Sync config into SQLite store_collections
  let config: CollectionConfig | undefined;
  if (options.configPath) {
    // YAML mode: inject config source for write-through, sync to DB
    setConfigSource({ configPath: options.configPath });
    config = loadConfig();
    syncConfigToDb(db, config);
  } else if (options.config) {
    // Inline config mode: inject config source for mutations, sync to DB
    setConfigSource({ config: options.config });
    config = options.config;
    syncConfigToDb(db, config);
  }
  // else: DB-only mode — no external config, use existing store_collections

  // Create a per-store LlamaCpp instance — lazy-loads models on first use,
  // auto-unloads after 5 min inactivity to free VRAM.
  const llm = new LlamaCpp({
    embedModel: config?.models?.embed,
    generateModel: config?.models?.generate,
    rerankModel: config?.models?.rerank,
    inactivityTimeoutMs: 5 * 60 * 1000,
    disposeModelsOnInactivity: true,
  });
  internal.llm = llm;

  const store: QMDStore = {
    internal,
    dbPath: internal.dbPath,

    // Search
    search: async (opts) => {
      if (!opts.query && !opts.queries) {
        throw new Error("search() requires either 'query' or 'queries'");
      }
      // Normalize collection/collections
      const collections = [
        ...(opts.collection ? [opts.collection] : []),
        ...(opts.collections ?? []),
      ];
      const skipRerank = opts.rerank === false;

      if (opts.queries) {
        // Pre-expanded queries — use structuredSearch
        return structuredSearch(internal, opts.queries, {
          collections: collections.length > 0 ? collections : undefined,
          limit: opts.limit,
          minScore: opts.minScore,
          explain: opts.explain,
          intent: opts.intent,
          candidateLimit: opts.candidateLimit,
          skipRerank,
          chunkStrategy: opts.chunkStrategy,
        });
      }

      // Simple query string — use hybridQuery (expand + search + rerank)
      return hybridQuery(internal, opts.query!, {
        collection: collections[0],
        limit: opts.limit,
        minScore: opts.minScore,
        explain: opts.explain,
        intent: opts.intent,
        candidateLimit: opts.candidateLimit,
        skipRerank,
        chunkStrategy: opts.chunkStrategy,
      });
    },
    searchLex: async (q, opts) => internal.searchFTS(q, opts?.limit, opts?.collection),
    searchVector: async (q, opts) => internal.searchVec(q, llm.embedModelName, opts?.limit, opts?.collection),
    expandQuery: async (q, opts) => internal.expandQuery(q, undefined, opts?.intent),
    get: async (pathOrDocid, opts) => internal.findDocument(pathOrDocid, opts),
    getDocumentBody: async (pathOrDocid, opts) => {
      const result = internal.findDocument(pathOrDocid, { includeBody: false });
      if ("error" in result) return null;
      return internal.getDocumentBody(result, opts?.fromLine, opts?.maxLines);
    },
    multiGet: async (pattern, opts) => internal.findDocuments(pattern, opts),

    // Collection Management — write to SQLite + write-through to YAML/inline if configured
    addCollection: async (name, opts) => {
      upsertStoreCollection(db, name, { path: opts.path, pattern: opts.pattern, ignore: opts.ignore });
      if (hasYamlConfig || options.config) {
        collectionsAddCollection(name, opts.path, opts.pattern);
      }
    },
    removeCollection: async (name) => {
      const result = deleteStoreCollection(db, name);
      if (hasYamlConfig || options.config) {
        collectionsRemoveCollection(name);
      }
      return result;
    },
    renameCollection: async (oldName, newName) => {
      const result = renameStoreCollection(db, oldName, newName);
      if (hasYamlConfig || options.config) {
        collectionsRenameCollection(oldName, newName);
      }
      return result;
    },
    listCollections: async () => storeListCollections(db),
    getDefaultCollectionNames: async () => {
      const collections = storeListCollections(db);
      return collections.filter(c => c.includeByDefault).map(c => c.name);
    },

    // Context Management — write to SQLite + write-through to YAML/inline if configured
    addContext: async (collectionName, pathPrefix, contextText) => {
      const result = updateStoreContext(db, collectionName, pathPrefix, contextText);
      if (hasYamlConfig || options.config) {
        collectionsAddContext(collectionName, pathPrefix, contextText);
      }
      return result;
    },
    removeContext: async (collectionName, pathPrefix) => {
      const result = removeStoreContext(db, collectionName, pathPrefix);
      if (hasYamlConfig || options.config) {
        collectionsRemoveContext(collectionName, pathPrefix);
      }
      return result;
    },
    setGlobalContext: async (context) => {
      setStoreGlobalContext(db, context);
      if (hasYamlConfig || options.config) {
        collectionsSetGlobalContext(context);
      }
    },
    getGlobalContext: async () => getStoreGlobalContext(db),
    listContexts: async () => getStoreContexts(db),

    // Indexing — reads collections from SQLite
    update: async (updateOpts) => {
      const collections = getStoreCollections(db);
      const filtered = updateOpts?.collections
        ? collections.filter(c => updateOpts.collections!.includes(c.name))
        : collections;

      internal.clearCache();

      let totalIndexed = 0, totalUpdated = 0, totalUnchanged = 0, totalRemoved = 0;

      for (const col of filtered) {
        const result = await reindexCollection(internal, col.path, col.pattern || "**/*.md", col.name, {
          ignorePatterns: col.ignore,
          onProgress: updateOpts?.onProgress
            ? (info) => updateOpts.onProgress!({ collection: col.name, ...info })
            : undefined,
        });
        totalIndexed += result.indexed;
        totalUpdated += result.updated;
        totalUnchanged += result.unchanged;
        totalRemoved += result.removed;
      }

      return {
        collections: filtered.length,
        indexed: totalIndexed,
        updated: totalUpdated,
        unchanged: totalUnchanged,
        removed: totalRemoved,
        needsEmbedding: internal.getHashesNeedingEmbedding(),
      };
    },

    embed: async (embedOpts) => {
      return generateEmbeddings(internal, {
        force: embedOpts?.force,
        model: embedOpts?.model,
        collection: embedOpts?.collection,
        maxDocsPerBatch: embedOpts?.maxDocsPerBatch,
        maxBatchBytes: embedOpts?.maxBatchBytes,
        chunkStrategy: embedOpts?.chunkStrategy,
        onProgress: embedOpts?.onProgress,
      });
    },

    // Index Health
    getStatus: async () => internal.getStatus(),
    getIndexHealth: async () => internal.getIndexHealth(),

    // Lifecycle
    close: async () => {
      await llm.dispose();
      internal.close();
      if (hasYamlConfig || options.config) {
        setConfigSource(undefined); // Reset config source
      }
    },
  };

  return store;
}
