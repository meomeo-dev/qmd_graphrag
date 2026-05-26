import { isBun, openDatabase } from "../db.js";
import type { Database, SQLiteValue } from "../db.js";
import fastGlob from "fast-glob";
import { execSync, spawn as nodeSpawn } from "child_process";
import { fileURLToPath } from "url";
import { basename, dirname, join as pathJoin, relative as relativePath, resolve as pathResolve } from "path";
import { parseArgs } from "util";
import { readFileSync, readdirSync, realpathSync, statSync, existsSync, unlinkSync, writeFileSync, openSync, closeSync, mkdirSync, lstatSync, rmSync, symlinkSync, readlinkSync, copyFileSync } from "fs";
import { createInterface } from "readline/promises";
import {
  getPwd,
  getRealPath,
  homedir,
  resolve,
  enableProductionMode,
  searchFTS,
  extractSnippet,
  getContextForFile,
  getContextForPath,
  listCollections,
  removeCollection,
  renameCollection,
  findSimilarFiles,
  findDocumentByDocid,
  isDocid,
  matchFilesByGlob,
  getHashesNeedingEmbedding,
  clearAllEmbeddings,
  insertEmbedding,
  getStatus,
  hashContent,
  extractTitle,
  formatDocForEmbedding,
  getEmbeddingFingerprint,
  chunkDocumentByTokens,
  clearCache,
  getCacheKey,
  getCachedResult,
  setCachedResult,
  getIndexHealth,
  parseVirtualPath,
  buildVirtualPath,
  isVirtualPath,
  resolveVirtualPath,
  toVirtualPath,
  insertContent,
  insertDocument,
  findActiveDocument,
  findOrMigrateLegacyDocument,
  updateDocumentTitle,
  updateDocument,
  deactivateDocument,
  getActiveDocumentPaths,
  cleanupOrphanedContent,
  deleteLLMCache,
  deleteInactiveDocuments,
  cleanupOrphanedVectors,
  vacuumDatabase,
  getCollectionsWithoutContext,
  getTopLevelPathsWithoutContext,
  handelize,
  hybridQuery,
  vectorSearchQuery,
  structuredSearch,
  addLineNumbers,
  type ExpandedQuery,
  type HybridQueryExplain,
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_MAX_BATCH_BYTES,
  DEFAULT_EMBED_MAX_DOCS_PER_BATCH,
  DEFAULT_RERANK_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_GLOB,
  DEFAULT_MULTI_GET_MAX_BYTES,
  createStore,
  getDefaultDbPath,
  reindexCollection,
  generateEmbeddings,
  maybeAdoptLegacyEmbeddingFingerprint,
  syncConfigToDb,
  DEFAULT_EMBED_CHUNK_STRATEGY,
  type ReindexResult,
  type ChunkStrategy,
} from "../store.js";
import {
  disposeDefaultLlamaCpp,
  getDefaultLlamaCpp,
  setDefaultLlamaCpp,
  LlamaCpp,
  withLLMSession,
  pullModels,
  DEFAULT_MODEL_CACHE_DIR,
  resolveEmbedModel,
  resolveGenerateModel,
  resolveRerankModel,
  resolveModels,
  resolveModelsFromConfig,
  inspectGgufFile,
  isJinaEmbeddingModel,
  isJinaRerankModel,
  isOpenAIResponsesModel,
  DEFAULT_JINA_EMBEDDING_PROFILE,
  JINA_EMBEDDING_PROFILES,
} from "../llm.js";
import {
  formatSearchResults,
  formatDocuments,
  escapeXml,
  escapeCSV,
  type OutputFormat,
} from "./formatter.js";
import {
  getCollection as getCollectionFromYaml,
  listCollections as yamlListCollections,
  getDefaultCollectionNames,
  addContext as yamlAddContext,
  removeContext as yamlRemoveContext,
  removeCollection as yamlRemoveCollectionFn,
  renameCollection as yamlRenameCollectionFn,
  setGlobalContext,
  listAllContexts,
  setConfigIndexName,
  loadConfig,
  saveConfig,
  setConfigSource,
  findLocalConfigPath,
  getLocalDbPath,
  getConfigPath,
  configExists,
  type CollectionConfig,
  type ModelsConfig,
} from "../collections.js";
import { createQmdGraphRagRuntime } from "../runtime.js";
import { GraphRagSearchMethodSchema } from "../contracts/graphrag.js";
import { SchemaVersion } from "../contracts/common.js";
import {
  buildDspyRuntimeFingerprints,
  dspyProviderEnvRefs,
} from "../dspy/fingerprints.js";
import { DspyPolicyStore } from "../dspy/policy-store.js";
import type { DspyArtifactWriteResult } from "../dspy/policy-store.js";
import {
  DspyEvaluationDatasetSchema,
  DspyGeneratedExpansionRecordSchema,
  DspyOptimizationArtifactSchema,
  DspyEvaluationReportSchema,
  DspyMetricSpecSchema,
  DspyPromotionDecisionSchema,
  QueryExpansionFailurePolicySchema,
} from "../contracts/dspy.js";
import { OpenAIResponsesProviderConfigSchema } from "../contracts/provider.js";
import type { QmdSearchResult } from "../contracts/qmd-query.js";
import type {
  EvidenceRef,
  QueryRouteDecision,
  QueryStage,
  UnifiedAnswer,
} from "../contracts/unified-query.js";
import {
  TypedQueryErrorException,
  createTypedQueryError,
  routeQuery,
} from "../query/unified-router.js";
import {
  QmdSearchResultSchema,
  QmdVectorSearchRequestSchema,
  QmdVectorSearchResultSchema,
} from "../contracts/qmd-query.js";
import {
  loadDocumentIdentitiesFromGraphVault,
  toQmdRetrievalCandidates,
  type QmdCandidateInput,
} from "../query/qmd-candidates.js";
import {
  loadGraphQueryCapabilities,
  resolveCandidateGraphCapabilities,
} from "../graphrag/capability-catalog.js";
import {
  writeManagedGraphRagSettingsSync,
} from "../graphrag/settings-projection.js";
import { createRunId } from "../job-state/fingerprint.js";

// NOTE: enableProductionMode() is intentionally NOT called at module scope here.
// Importing this module for its exports (e.g. buildEditorUri, termLink from
// test/cli.test.ts) must not flip the global production flag, as that leaks
// into unrelated tests that rely on the default (development) database path
// resolution. The flag is flipped inside the CLI's main-module guard below so
// it only fires when qmd is actually invoked as a script.

// =============================================================================
// Store/DB lifecycle (no legacy singletons in store.ts)
// =============================================================================

let store: ReturnType<typeof createStore> | null = null;
let storeDbPathOverride: string | undefined;
let currentIndexName = "index";

function getStore(): ReturnType<typeof createStore> {
  if (!store) {
    store = createStore(storeDbPathOverride);
    // Sync YAML config into SQLite store_collections so store.ts reads from DB
    try {
      const activeModels = ensureModelsConfiguredForCli();
      const config = loadConfig();
      syncConfigToDb(store.db, config);
      setDefaultLlamaCpp(new LlamaCpp({
        embedModel: activeModels.embed,
        generateModel: activeModels.generate,
        rerankModel: activeModels.rerank,
      }));
    } catch {
      // Config may not exist yet — that's fine, DB works without it
    }
  }
  return store;
}

function getDb(): Database {
  return getStore().db;
}

/** Re-sync YAML config into SQLite after CLI mutations (add/remove/rename collection, context changes) */
function resyncConfig(): void {
  const s = getStore();
  try {
    const config = loadConfig();
    // Clear config hash to force re-sync
    s.db.prepare(`DELETE FROM store_config WHERE key = 'config_hash'`).run();
    syncConfigToDb(s.db, config);
  } catch {
    // Config may not exist — that's fine
  }
}

function closeDb(): void {
  if (store) {
    store.close();
    store = null;
  }
}

function getDbPath(): string {
  return store?.dbPath ?? storeDbPathOverride ?? getDefaultDbPath();
}

function getActiveIndexName(): string {
  return currentIndexName;
}

function setIndexName(name: string | null): void {
  let normalizedName = name;
  // Normalize relative paths to prevent malformed database paths
  if (name && name.includes('/')) {
    const absolutePath = pathResolve(process.cwd(), name);
    // Replace path separators with underscores to create a valid filename
    normalizedName = absolutePath.replace(/\//g, '_').replace(/^_/, '');
  }
  currentIndexName = normalizedName || "index";
  storeDbPathOverride = normalizedName ? getDefaultDbPath(normalizedName) : undefined;
  // Reset open handle so next use opens the new index
  closeDb();
}

function ensureVecTable(_db: Database, dimensions: number): void {
  // Store owns the DB; ignore `_db` and ensure vec table on the active store
  getStore().ensureVecTable(dimensions);
}

// Terminal colors (respects NO_COLOR env)
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  green: useColor ? "\x1b[32m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  blue: useColor ? "\x1b[34m" : "",
};

// Terminal cursor control
const cursor = {
  hide() { process.stderr.write('\x1b[?25l'); },
  show() { process.stderr.write('\x1b[?25h'); },
};

type CliLifecycleWritable = {
  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
};

type FinishSuccessfulCliCommandOptions = {
  command: string;
  format?: OutputFormat;
  cleanup?: () => Promise<void>;
  exit?: (code: number) => void;
  immediateExit?: (code: number) => void;
  stdout?: CliLifecycleWritable;
  stderr?: CliLifecycleWritable;
  platform?: NodeJS.Platform;
};

async function flushWritable(stream: CliLifecycleWritable): Promise<void> {
  await new Promise<void>((resolve) => {
    stream.write("", () => resolve());
  });
}

function shouldBypassNativeCleanup(options: FinishSuccessfulCliCommandOptions): boolean {
  return (
    (options.platform ?? process.platform) === "darwin" &&
    options.command === "query" &&
    options.format === "json" &&
    process.env.QMD_DISABLE_DARWIN_QUERY_JSON_SAFE_EXIT !== "1"
  );
}

function immediateProcessExit(code: number): void {
  const processWithReallyExit = process as NodeJS.Process & { reallyExit?: (code?: number) => void };
  if (typeof processWithReallyExit.reallyExit === "function") {
    processWithReallyExit.reallyExit(code);
    return;
  }
  process.exit(code);
}

/**
 * Finish a successful CLI command after output has been flushed. On macOS JSON
 * query runs, skip normal native teardown and use Node/Bun's immediate exit path:
 * ggml Metal can abort from C++ finalizers after valid JSON has already been
 * produced (#368). This wrapper is only reached after the command completed, so
 * real query failures still exit through the normal error path before this runs.
 */
export async function finishSuccessfulCliCommand(options: FinishSuccessfulCliCommandOptions): Promise<void> {
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const immediateExit = options.immediateExit ?? immediateProcessExit;

  await flushWritable(options.stdout ?? process.stdout);

  if (shouldBypassNativeCleanup(options)) {
    await flushWritable(stderr);
    immediateExit(0);
    return;
  }

  try {
    await (options.cleanup ?? disposeDefaultLlamaCpp)();
  } catch (error) {
    stderr.write(
      `QMD Warning: cleanup after successful output failed (${error instanceof Error ? error.message : String(error)}); exiting 0 because command output completed.\n`
    );
  }
  await flushWritable(stderr);
  exit(0);
}

// Ensure cursor is restored on exit
process.on('SIGINT', () => { cursor.show(); process.exit(130); });
process.on('SIGTERM', () => { cursor.show(); process.exit(143); });

// Terminal progress bar using OSC 9;4 escape sequence (TTY only)
const isTTY = process.stderr.isTTY;
const progress = {
  set(percent: number) {
    if (isTTY) process.stderr.write(`\x1b]9;4;1;${Math.round(percent)}\x07`);
  },
  clear() {
    if (isTTY) process.stderr.write(`\x1b]9;4;0\x07`);
  },
  indeterminate() {
    if (isTTY) process.stderr.write(`\x1b]9;4;3\x07`);
  },
  error() {
    if (isTTY) process.stderr.write(`\x1b]9;4;2\x07`);
  },
};

// Format seconds into human-readable ETA
function formatETA(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}


// Check index health and print warnings/tips
function checkIndexHealth(db: Database, model: string = resolveEmbedModelForCli()): void {
  const { needsEmbedding, totalDocs, daysStale } = getIndexHealth(db, model);

  // Warn if many docs need embedding
  if (needsEmbedding > 0) {
    const pct = Math.round((needsEmbedding / totalDocs) * 100);
    if (pct >= 10) {
      process.stderr.write(`${c.yellow}Warning: ${needsEmbedding} documents (${pct}%) need embeddings. Run 'qmd embed' for better results.${c.reset}\n`);
    } else {
      process.stderr.write(`${c.dim}Tip: ${needsEmbedding} documents need embeddings. Run 'qmd embed' to index them.${c.reset}\n`);
    }
  }

  // Check if most recent document update is older than 2 weeks
  if (daysStale !== null && daysStale >= 14) {
    process.stderr.write(`${c.dim}Tip: Index last updated ${daysStale} days ago. Run 'qmd update' to refresh.${c.reset}\n`);
  }
}

// Compute unique display path for a document
// Always include at least parent folder + filename, add more parent dirs until unique
function computeDisplayPath(
  filepath: string,
  collectionPath: string,
  existingPaths: Set<string>
): string {
  // Get path relative to collection (include collection dir name)
  const collectionDir = collectionPath.replace(/\/$/, '');
  const collectionName = collectionDir.split('/').pop() || '';

  let relativePath: string;
  if (filepath.startsWith(collectionDir + '/')) {
    // filepath is under collection: use collection name + relative path
    relativePath = collectionName + filepath.slice(collectionDir.length);
  } else {
    // Fallback: just use the filepath
    relativePath = filepath;
  }

  const parts = relativePath.split('/').filter(p => p.length > 0);

  // Always include at least parent folder + filename (minimum 2 parts if available)
  // Then add more parent dirs until unique
  const minParts = Math.min(2, parts.length);
  for (let i = parts.length - minParts; i >= 0; i--) {
    const candidate = parts.slice(i).join('/');
    if (!existingPaths.has(candidate)) {
      return candidate;
    }
  }

  // Absolute fallback: use full path (should be unique)
  return filepath;
}


function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return pathResolve(a) === pathResolve(b);
  }
}

function initLocalIndex(): void {
  const cwd = getPwd();
  if (sameDirectory(cwd, homedir())) {
    throw new Error("Refusing to initialize a local index in $HOME. The global index is automatically created; run `qmd collection add <path>` for the global index, or run `qmd init` inside a project folder.");
  }

  const qmdDir = pathJoin(cwd, ".qmd");
  const ymlPath = pathJoin(qmdDir, "index.yml");
  const yamlPath = pathJoin(qmdDir, "index.yaml");
  const configPath = existsSync(yamlPath) ? yamlPath : ymlPath;
  const dbPath = pathJoin(qmdDir, "index.sqlite");

  mkdirSync(qmdDir, { recursive: true });
  setConfigSource({ configPath });
  storeDbPathOverride = dbPath;
  closeDb();

  if (!existsSync(configPath)) {
    ensureRuntimeConfigForCli();
  } else {
    ensureRuntimeConfigForCli();
  }

  const localStore = createStore(dbPath);
  syncConfigToDb(localStore.db, loadConfig());
  localStore.close();

  console.log("ready to go with new local index");
}

function defaultProjectProvidersConfig(): CollectionConfig["providers"] {
  return {
    openai: {
      api_key_env: "OPENAI_API_KEY",
      base_url_env: "OPENAI_BASE_URL",
      response_api: {
        endpoint: "/responses",
        stream: true,
        reasoning_effort: "medium",
        strict_structured_output: true,
      },
    },
    jina: {
      api_key_env: "JINA_API_KEY",
      base_url_env: "JINA_API_BASE",
      base_url: "https://api.jina.ai",
      embedding_endpoint: "/v1/embeddings",
      rerank_endpoint: "/v1/rerank",
      embedding_profile: DEFAULT_JINA_EMBEDDING_PROFILE,
      embedding_model:
        JINA_EMBEDDING_PROFILES[DEFAULT_JINA_EMBEDDING_PROFILE].embeddingModel,
      rerank_model:
        JINA_EMBEDDING_PROFILES[DEFAULT_JINA_EMBEDDING_PROFILE].rerankModel,
      embedding_query_task:
        JINA_EMBEDDING_PROFILES[DEFAULT_JINA_EMBEDDING_PROFILE].queryTask,
      embedding_document_task:
        JINA_EMBEDDING_PROFILES[DEFAULT_JINA_EMBEDDING_PROFILE].documentTask,
      embedding_dimensions:
        JINA_EMBEDDING_PROFILES[DEFAULT_JINA_EMBEDDING_PROFILE].dimensions,
      embedding_normalized:
        JINA_EMBEDDING_PROFILES[DEFAULT_JINA_EMBEDDING_PROFILE].normalized,
      embedding_type:
        JINA_EMBEDDING_PROFILES[DEFAULT_JINA_EMBEDDING_PROFILE].embeddingType,
      embedding_truncate:
        JINA_EMBEDDING_PROFILES[DEFAULT_JINA_EMBEDDING_PROFILE].truncate,
    },
  };
}

function parseDotenvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
  const separatorIndex = body.indexOf("=");
  if (separatorIndex <= 0) return null;
  const key = body.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = body.slice(separatorIndex + 1).trim();
  const quote = value[0];
  if (
    (quote === "\"" || quote === "'") &&
    value.endsWith(quote) &&
    value.length >= 2
  ) {
    value = value.slice(1, -1);
    if (quote === "\"") {
      value = value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
    }
  } else {
    const commentIndex = value.search(/\s#/);
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trimEnd();
  }

  return { key, value };
}

export function loadProjectDotenvForCli(startDir: string = getPwd()): string[] {
  const localConfigPath = findLocalConfigPath(startDir);
  const projectDir = localConfigPath
    ? dirname(dirname(localConfigPath))
    : pathResolve(startDir);
  const dotenvPath = pathJoin(projectDir, ".env");
  if (!existsSync(dotenvPath)) return [];

  const loaded: string[] = [];
  const body = readFileSync(dotenvPath, "utf-8");
  for (const line of body.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line);
    if (!parsed || process.env[parsed.key] !== undefined) continue;
    process.env[parsed.key] = parsed.value;
    loaded.push(parsed.key);
  }
  return loaded;
}

function openAIResponsesProviderConfigForCli(config: CollectionConfig, model: string) {
  const openai = {
    ...defaultProjectProvidersConfig()?.openai,
    ...(config.providers?.openai ?? {}),
    response_api: {
      ...defaultProjectProvidersConfig()?.openai?.response_api,
      ...(config.providers?.openai?.response_api ?? {}),
    },
  };
  return OpenAIResponsesProviderConfigSchema.parse({
    apiKeyEnv: openai.api_key_env ?? "OPENAI_API_KEY",
    baseUrlEnv: openai.base_url_env ?? "OPENAI_BASE_URL",
    endpoint: openai.response_api?.endpoint ?? "/responses",
    stream: openai.response_api?.stream ?? true,
    model,
    reasoningEffort: openai.response_api?.reasoning_effort,
    strictStructuredOutput: openai.response_api?.strict_structured_output ?? true,
  });
}

function updateQueryExpansionPolicyConfig(input: {
  provider: "builtin" | "dspy";
  graphVault?: string;
  policyRef?: string;
  failurePolicy?: "fallback_to_builtin_expander" | "strict_refuse";
}): void {
  if (process.env.QMD_TEST_FAIL_DSPY_CONFIG_WRITE === "1") {
    throw new Error("test-injected DSPy config write failure");
  }
  const config = ensureRuntimeConfigForCli();
  const graphVault = input.graphVault
    ? (relativePath(getPwd(), input.graphVault) || ".")
    : config.graphrag?.vault;
  const next: CollectionConfig = {
    ...config,
    graphrag: {
      ...(config.graphrag ?? {}),
      ...(graphVault ? { vault: graphVault } : {}),
    },
    query: {
      ...(config.query ?? {}),
      expansion_policy: {
        ...(config.query?.expansion_policy ?? {}),
        provider: input.provider,
        policy_ref: input.policyRef
          ?? config.query?.expansion_policy?.policy_ref
          ?? "graph_vault/dspy/policies/query-expansion/current.yaml",
        failure_policy: input.failurePolicy
          ?? config.query?.expansion_policy?.failure_policy
          ?? "fallback_to_builtin_expander",
        strict_schema: config.query?.expansion_policy?.strict_schema ?? true,
      },
    },
  };
  saveConfig(next);
  resyncConfig();
}

function ensureRuntimeConfigForCli(): CollectionConfig {
  const config = loadConfig();
  const configuredDefaultRoute = config.query?.default_route;
  if (
    configuredDefaultRoute != null &&
    configuredDefaultRoute !== "qmd" &&
    configuredDefaultRoute !== "auto"
  ) {
    throw new Error(
      "query.default_route must be qmd or auto; use --graphrag for graph-only queries",
    );
  }
  const models = resolveModelsFromConfig(config);
  const jinaProviderDefaults = {
    ...defaultProjectProvidersConfig()?.jina,
    ...(config.providers?.jina ?? {}),
  };
  const next: CollectionConfig = {
    ...config,
    collections: config.collections ?? {},
    models: {
      ...(config.models ?? {}),
      embed: models.embed,
      generate: models.generate,
      rerank: models.rerank,
    },
    providers: {
      ...defaultProjectProvidersConfig(),
      ...(config.providers ?? {}),
      openai: {
        ...defaultProjectProvidersConfig()?.openai,
        ...(config.providers?.openai ?? {}),
        response_api: {
          ...defaultProjectProvidersConfig()?.openai?.response_api,
          ...(config.providers?.openai?.response_api ?? {}),
        },
      },
      jina: {
        ...jinaProviderDefaults,
      },
    },
    embedding: {
      chunk_strategy: DEFAULT_EMBED_CHUNK_STRATEGY,
      ...(config.embedding ?? {}),
    },
    graphrag: {
      enabled: true,
      vault: "graph_vault",
      concurrent_requests: 10,
      default_method: "local",
      default_response_type: "multiple paragraphs",
      ...(config.graphrag ?? {}),
    },
    query: {
      default_route: "qmd",
      allow_graph_upgrade: true,
      ...(config.query ?? {}),
      auto_route: {
        graph_coverage_threshold: 0.7,
        max_cost_class: "medium",
        ...(config.query?.auto_route ?? {}),
      },
      expansion_policy: {
        provider: "builtin",
        policy_ref: "graph_vault/dspy/policies/query-expansion/current.yaml",
        failure_policy: "fallback_to_builtin_expander",
        strict_schema: true,
        ...(config.query?.expansion_policy ?? {}),
      },
    },
  };
  saveConfig(next);
  if (next.graphrag?.enabled !== false) {
    writeManagedGraphRagSettingsSync({
      config: next,
      graphVault: pathResolve(getPwd(), next.graphrag?.vault ?? "graph_vault"),
    });
  }
  return next;
}

function isForceCpuEnabled(): boolean {
  const value = process.env.QMD_FORCE_CPU;
  return !!value && !["false", "off", "none", "disable", "disabled", "0"].includes(value.trim().toLowerCase());
}

function configuredGpuModeLabel(): string {
  return isForceCpuEnabled()
    ? "CPU forced (QMD_FORCE_CPU)"
    : (process.env.QMD_LLAMA_GPU?.trim() || "auto");
}

function summarizeDeviceNames(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => count > 1 ? `${count}× ${name}` : name)
    .join(", ");
}

function sanitizeDiagnosticMessage(message: string): string {
  const home = homedir();
  return message
    .replaceAll(home, "~")
    .replaceAll(process.cwd(), ".")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("; ");
}

async function showStatus(): Promise<void> {
  const dbPath = getDbPath();
  const db = getDb();

  // Collections are defined in YAML; no duplicate cleanup needed.
  // Collections are defined in YAML; no duplicate cleanup needed.

  // Index size
  let indexSize = 0;
  try {
    const stat = statSync(dbPath).size;
    indexSize = stat;
  } catch { }

  // Collections info (from YAML + database stats)
  const collections = listCollections(db);

  // Overall stats
  const totalDocs = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number };
  const vectorCount = db.prepare(`SELECT COUNT(*) as count FROM content_vectors`).get() as { count: number };
  const statusEmbedModel = resolveEmbedModelForCli();
  const needsEmbedding = getHashesNeedingEmbedding(db, undefined, statusEmbedModel);

  // Most recent update across all collections
  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as { latest: string | null };

  console.log(`${c.bold}QMD Status${c.reset}\n`);
  console.log(`Index: ${dbPath}`);
  console.log(`Size:  ${formatBytes(indexSize)}`);

  // MCP daemon status (check PID file liveness)
  const mcpCacheDir = process.env.XDG_CACHE_HOME
    ? resolve(process.env.XDG_CACHE_HOME, "qmd")
    : resolve(homedir(), ".cache", "qmd");
  const mcpPidPath = resolve(mcpCacheDir, "mcp.pid");
  if (existsSync(mcpPidPath)) {
    const mcpPid = parseInt(readFileSync(mcpPidPath, "utf-8").trim());
    try {
      process.kill(mcpPid, 0);
      console.log(`MCP:   ${c.green}running${c.reset} (PID ${mcpPid})`);
    } catch {
      unlinkSync(mcpPidPath);
      // Stale PID file cleaned up silently
    }
  }
  console.log("");

  console.log(`${c.bold}Documents${c.reset}`);
  console.log(`  Total:    ${totalDocs.count} files indexed`);
  console.log(`  Vectors:  ${vectorCount.count} embedded`);
  if (needsEmbedding > 0) {
    console.log(`  ${c.yellow}Pending:  ${needsEmbedding} need embedding${c.reset} (run 'qmd embed')`);
  }
  if (mostRecent.latest) {
    const lastUpdate = new Date(mostRecent.latest);
    console.log(`  Updated:  ${formatTimeAgo(lastUpdate)}`);
  }

  // Get all contexts grouped by collection (from YAML)
  const allContexts = listAllContexts();
  const contextsByCollection = new Map<string, { path_prefix: string; context: string }[]>();

  for (const ctx of allContexts) {
    // Group contexts by collection name
    if (!contextsByCollection.has(ctx.collection)) {
      contextsByCollection.set(ctx.collection, []);
    }
    contextsByCollection.get(ctx.collection)!.push({
      path_prefix: ctx.path,
      context: ctx.context
    });
  }

  // AST chunking status
  try {
    const { getASTStatus } = await import("../ast.js");
    const ast = await getASTStatus();
    console.log(`\n${c.bold}AST Chunking${c.reset}`);
    if (ast.available) {
      const ok = ast.languages.filter(l => l.available).map(l => l.language);
      const fail = ast.languages.filter(l => !l.available);
      console.log(`  Status:   ${c.green}active${c.reset}`);
      console.log(`  Languages: ${ok.join(", ")}`);
      if (fail.length > 0) {
        for (const f of fail) {
          console.log(`  ${c.yellow}Unavailable: ${f.language} (${f.error})${c.reset}`);
        }
      }
    } else {
      console.log(`  Status:   ${c.yellow}unavailable${c.reset} (falling back to regex chunking)`);
      for (const l of ast.languages) {
        if (l.error) console.log(`  ${c.dim}${l.language}: ${l.error}${c.reset}`);
      }
    }
  } catch {
    console.log(`\n${c.bold}AST Chunking${c.reset}`);
    console.log(`  Status:   ${c.dim}not available${c.reset}`);
  }

  if (collections.length > 0) {
    console.log(`\n${c.bold}Collections${c.reset}`);
    for (const col of collections) {
      const lastMod = col.last_modified ? formatTimeAgo(new Date(col.last_modified)) : "never";
      const contexts = contextsByCollection.get(col.name) || [];

      console.log(`  ${c.cyan}${col.name}${c.reset} ${c.dim}(qmd://${col.name}/)${c.reset}`);
      console.log(`    ${c.dim}Pattern:${c.reset}  ${col.glob_pattern}`);
      console.log(`    ${c.dim}Files:${c.reset}    ${col.active_count} (updated ${lastMod})`);

      if (contexts.length > 0) {
        console.log(`    ${c.dim}Contexts:${c.reset} ${contexts.length}`);
        for (const ctx of contexts) {
          // Handle both empty string and '/' as root context
          const pathDisplay = (ctx.path_prefix === '' || ctx.path_prefix === '/') ? '/' : `/${ctx.path_prefix}`;
          const contextPreview = ctx.context.length > 60
            ? ctx.context.substring(0, 57) + '...'
            : ctx.context;
          console.log(`      ${c.dim}${pathDisplay}:${c.reset} ${contextPreview}`);
        }
      }
    }

    // Show examples of virtual paths
    console.log(`\n${c.bold}Examples${c.reset}`);
    console.log(`  ${c.dim}# List files in a collection${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd ls ${collections[0].name}`);
    }
    console.log(`  ${c.dim}# Get a document${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd get qmd://${collections[0].name}/path/to/file.md`);
    }
    console.log(`  ${c.dim}# Search within a collection${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd search "query" -c ${collections[0].name}`);
    }
  } else {
    console.log(`\n${c.dim}No collections. Run 'qmd collection add .' to index markdown files.${c.reset}`);
  }

  // Models
  {
    // hf:org/repo/file.gguf → https://huggingface.co/org/repo
    const hfLink = (uri: string) => {
      const match = uri.match(/^hf:([^/]+\/[^/]+)\//);
      return match ? `https://huggingface.co/${match[1]}` : uri;
    };
    const activeModels = resolveModelsForCli();
    console.log(`\n${c.bold}Models${c.reset}`);
    console.log(`  Embedding:   ${hfLink(activeModels.embed)}`);
    console.log(`  Reranking:   ${hfLink(activeModels.rerank)}`);
    console.log(`  Generation:  ${hfLink(activeModels.generate)}`);
  }


  // Tips section
  const tips: string[] = [];

  // Check for collections without context
  const collectionsWithoutContext = collections.filter(col => {
    const contexts = contextsByCollection.get(col.name) || [];
    return contexts.length === 0;
  });
  if (collectionsWithoutContext.length > 0) {
    const names = collectionsWithoutContext.map(c => c.name).slice(0, 3).join(', ');
    const more = collectionsWithoutContext.length > 3 ? ` +${collectionsWithoutContext.length - 3} more` : '';
    tips.push(`Add context to collections for better search results: ${names}${more}`);
    tips.push(`  ${c.dim}qmd context add qmd://<name>/ "What this collection contains"${c.reset}`);
    tips.push(`  ${c.dim}qmd context add qmd://<name>/meeting-notes "Weekly team meeting notes"${c.reset}`);
  }

  // Check for collections without update commands
  const collectionsWithoutUpdate = collections.filter(col => {
    const yamlCol = getCollectionFromYaml(col.name);
    return !yamlCol?.update;
  });
  if (collectionsWithoutUpdate.length > 0 && collections.length > 1) {
    const names = collectionsWithoutUpdate.map(c => c.name).slice(0, 3).join(', ');
    const more = collectionsWithoutUpdate.length > 3 ? ` +${collectionsWithoutUpdate.length - 3} more` : '';
    tips.push(`Add update commands to keep collections fresh: ${names}${more}`);
    tips.push(`  ${c.dim}qmd collection update-cmd <name> 'git stash && git pull --rebase --ff-only && git stash pop'${c.reset}`);
  }

  if (tips.length > 0) {
    console.log(`\n${c.bold}Tips${c.reset}`);
    for (const tip of tips) {
      console.log(`  ${tip}`);
    }
  }

  closeDb();
}

async function updateCollections(): Promise<void> {
  const db = getDb();
  const storeInstance = getStore();
  // Collections are defined in YAML; no duplicate cleanup needed.

  // Clear Ollama cache on update
  clearCache(db);

  const collections = listCollections(db);

  if (collections.length === 0) {
    console.log(`${c.dim}No collections found. Run 'qmd collection add .' to index markdown files.${c.reset}`);
    closeDb();
    return;
  }

  console.log(`${c.bold}Updating ${collections.length} collection(s)...${c.reset}\n`);

  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    if (!col) continue;
    console.log(`${c.cyan}[${i + 1}/${collections.length}]${c.reset} ${c.bold}${col.name}${c.reset} ${c.dim}(${col.glob_pattern})${c.reset}`);

    // Execute custom update command if specified in YAML
    const yamlCol = getCollectionFromYaml(col.name);
    if (yamlCol?.update) {
      console.log(`${c.dim}    Running update command: ${yamlCol.update}${c.reset}`);
      try {
        const proc = nodeSpawn("bash", ["-c", yamlCol.update], {
          cwd: col.pwd,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const [output, errorOutput, exitCode] = await new Promise<[string, string, number]>((resolve, reject) => {
          let out = "";
          let err = "";
          proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
          proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
          proc.on("error", reject);
          proc.on("close", (code) => resolve([out, err, code ?? 1]));
        });

        if (output.trim()) {
          console.log(output.trim().split('\n').map(l => `    ${l}`).join('\n'));
        }
        if (errorOutput.trim()) {
          console.log(errorOutput.trim().split('\n').map(l => `    ${l}`).join('\n'));
        }

        if (exitCode !== 0) {
          console.log(`${c.yellow}✗ Update command failed with exit code ${exitCode}${c.reset}`);
          process.exit(exitCode);
        }
      } catch (err) {
        console.log(`${c.yellow}✗ Update command failed: ${err}${c.reset}`);
        process.exit(1);
      }
    }

    const startTime = Date.now();
    console.log(`Collection: ${col.pwd} (${col.glob_pattern})`);
    progress.indeterminate();

    const result = await reindexCollection(storeInstance, col.pwd, col.glob_pattern, col.name, {
      ignorePatterns: yamlCol?.ignore,
      onProgress: (info) => {
        progress.set((info.current / info.total) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = info.current / elapsed;
        const remaining = (info.total - info.current) / rate;
        const eta = info.current > 2 ? ` ETA: ${formatETA(remaining)}` : "";
        if (isTTY) process.stderr.write(`\rIndexing: ${info.current}/${info.total}${eta}        `);
      },
    });

    progress.clear();
    console.log(`\nIndexed: ${result.indexed} new, ${result.updated} updated, ${result.unchanged} unchanged, ${result.removed} removed`);
    if (result.orphanedCleaned > 0) {
      console.log(`Cleaned up ${result.orphanedCleaned} orphaned content hash(es)`);
    }
    console.log("");
  }

  // Check if any documents need embedding (show once at end)
  const needsEmbedding = getHashesNeedingEmbedding(db);
  closeDb();

  console.log(`${c.green}✓ All collections updated.${c.reset}`);
  if (needsEmbedding > 0) {
    console.log(`\nRun 'qmd embed' to update embeddings (${needsEmbedding} unique hashes need vectors)`);
  }
}

/**
 * Detect which collection (if any) contains the given filesystem path.
 * Returns { collectionId, collectionName, relativePath } or null if not in any collection.
 */
function detectCollectionFromPath(db: Database, fsPath: string): { collectionName: string; relativePath: string } | null {
  const realPath = getRealPath(fsPath);

  // Find collections that this path is under from YAML
  const allCollections = yamlListCollections();

  // Find longest matching path
  let bestMatch: { name: string; path: string } | null = null;
  for (const coll of allCollections) {
    if (realPath.startsWith(coll.path + '/') || realPath === coll.path) {
      if (!bestMatch || coll.path.length > bestMatch.path.length) {
        bestMatch = { name: coll.name, path: coll.path };
      }
    }
  }

  if (!bestMatch) return null;

  // Calculate relative path
  let relativePath = realPath;
  if (relativePath.startsWith(bestMatch.path + '/')) {
    relativePath = relativePath.slice(bestMatch.path.length + 1);
  } else if (relativePath === bestMatch.path) {
    relativePath = '';
  }

  return {
    collectionName: bestMatch.name,
    relativePath
  };
}

async function contextAdd(pathArg: string | undefined, contextText: string): Promise<void> {
  const db = getDb();

  // Handle "/" as global context (applies to all collections)
  if (pathArg === '/') {
    setGlobalContext(contextText);
    resyncConfig();
    console.log(`${c.green}✓${c.reset} Set global context`);
    console.log(`${c.dim}Context: ${contextText}${c.reset}`);
    closeDb();
    return;
  }

  // Resolve path - defaults to current directory if not provided
  let fsPath = pathArg || '.';
  if (fsPath === '.' || fsPath === './') {
    fsPath = getPwd();
  } else if (fsPath.startsWith('~/')) {
    fsPath = homedir() + fsPath.slice(1);
  } else if (!fsPath.startsWith('/') && !fsPath.startsWith('qmd://')) {
    fsPath = resolve(getPwd(), fsPath);
  }

  // Handle virtual paths (qmd://collection/path)
  if (isVirtualPath(fsPath)) {
    const parsed = parseVirtualPath(fsPath);
    if (!parsed) {
      console.error(`${c.yellow}Invalid virtual path: ${fsPath}${c.reset}`);
      process.exit(1);
    }

    const coll = getCollectionFromYaml(parsed.collectionName);
    if (!coll) {
      console.error(`${c.yellow}Collection not found: ${parsed.collectionName}${c.reset}`);
      process.exit(1);
    }

    yamlAddContext(parsed.collectionName, parsed.path, contextText);
    resyncConfig();

    const displayPath = parsed.path
      ? `qmd://${parsed.collectionName}/${parsed.path}`
      : `qmd://${parsed.collectionName}/ (collection root)`;
    console.log(`${c.green}✓${c.reset} Added context for: ${displayPath}`);
    console.log(`${c.dim}Context: ${contextText}${c.reset}`);
    closeDb();
    return;
  }

  // Detect collection from filesystem path
  const detected = detectCollectionFromPath(db, fsPath);
  if (!detected) {
    console.error(`${c.yellow}Path is not in any indexed collection: ${fsPath}${c.reset}`);
    console.error(`${c.dim}Run 'qmd status' to see indexed collections${c.reset}`);
    process.exit(1);
  }

  yamlAddContext(detected.collectionName, detected.relativePath, contextText);
  resyncConfig();

  const displayPath = detected.relativePath ? `qmd://${detected.collectionName}/${detected.relativePath}` : `qmd://${detected.collectionName}/`;
  console.log(`${c.green}✓${c.reset} Added context for: ${displayPath}`);
  console.log(`${c.dim}Context: ${contextText}${c.reset}`);
  closeDb();
}

function contextList(): void {
  const db = getDb();

  const allContexts = listAllContexts();

  if (allContexts.length === 0) {
    console.log(`${c.dim}No contexts configured. Use 'qmd context add' to add one.${c.reset}`);
    closeDb();
    return;
  }

  console.log(`\n${c.bold}Configured Contexts${c.reset}\n`);

  let lastCollection = '';
  for (const ctx of allContexts) {
    if (ctx.collection !== lastCollection) {
      console.log(`${c.cyan}${ctx.collection}${c.reset}`);
      lastCollection = ctx.collection;
    }

    const displayPath = ctx.path ? `  ${ctx.path}` : '  / (root)';
    console.log(`${displayPath}`);
    console.log(`    ${c.dim}${ctx.context}${c.reset}`);
  }

  closeDb();
}

function contextRemove(pathArg: string): void {
  if (pathArg === '/') {
    // Remove global context
    setGlobalContext(undefined);
    // Resync so SQLite store_config is updated
    const s = getStore();
    resyncConfig();
    closeDb();
    console.log(`${c.green}✓${c.reset} Removed global context`);
    return;
  }

  // Handle virtual paths
  if (isVirtualPath(pathArg)) {
    const parsed = parseVirtualPath(pathArg);
    if (!parsed) {
      console.error(`${c.yellow}Invalid virtual path: ${pathArg}${c.reset}`);
      process.exit(1);
    }

    const coll = getCollectionFromYaml(parsed.collectionName);
    if (!coll) {
      console.error(`${c.yellow}Collection not found: ${parsed.collectionName}${c.reset}`);
      process.exit(1);
    }

    const success = yamlRemoveContext(coll.name, parsed.path);

    if (!success) {
      console.error(`${c.yellow}No context found for: ${pathArg}${c.reset}`);
      process.exit(1);
    }

    console.log(`${c.green}✓${c.reset} Removed context for: ${pathArg}`);
    return;
  }

  // Handle filesystem paths
  let fsPath = pathArg;
  if (fsPath === '.' || fsPath === './') {
    fsPath = getPwd();
  } else if (fsPath.startsWith('~/')) {
    fsPath = homedir() + fsPath.slice(1);
  } else if (!fsPath.startsWith('/')) {
    fsPath = resolve(getPwd(), fsPath);
  }

  const db = getDb();
  const detected = detectCollectionFromPath(db, fsPath);
  closeDb();

  if (!detected) {
    console.error(`${c.yellow}Path is not in any indexed collection: ${fsPath}${c.reset}`);
    process.exit(1);
  }

  const success = yamlRemoveContext(detected.collectionName, detected.relativePath);

  if (!success) {
    console.error(`${c.yellow}No context found for: qmd://${detected.collectionName}/${detected.relativePath}${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.green}✓${c.reset} Removed context for: qmd://${detected.collectionName}/${detected.relativePath}`);
}

function getDocument(filename: string, fromLine?: number, maxLines?: number, lineNumbers?: boolean): void {
  // Parse :linenum suffix from filename (e.g., "file.md:100")
  let inputPath = filename;
  const colonMatch = inputPath.match(/:(\d+)$/);
  if (colonMatch && !fromLine) {
    const matched = colonMatch[1];
    if (matched) {
      fromLine = parseInt(matched, 10);
      inputPath = inputPath.slice(0, -colonMatch[0].length);
    }
  }
  if (fromLine !== undefined) fromLine = Math.max(1, fromLine);

  const parsedIndexPath = isVirtualPath(inputPath) ? parseVirtualPath(inputPath) : null;
  if (parsedIndexPath?.indexName) {
    setIndexName(parsedIndexPath.indexName);
    setConfigIndexName(parsedIndexPath.indexName);
  }

  const db = getDb();

  // Handle docid lookup (#abc123, abc123, "#abc123", "abc123", etc.)
  if (isDocid(inputPath)) {
    const docidMatch = findDocumentByDocid(db, inputPath);
    if (docidMatch) {
      inputPath = docidMatch.filepath;
    } else {
      console.error(`Document not found: ${filename}`);
      closeDb();
      process.exit(1);
    }
  }
  let doc: { collectionName: string; path: string; body: string } | null = null;
  let virtualPath: string;

  // Handle virtual paths (qmd://collection/path)
  if (isVirtualPath(inputPath)) {
    const parsed = parseVirtualPath(inputPath);
    if (!parsed) {
      console.error(`Invalid virtual path: ${inputPath}`);
      closeDb();
      process.exit(1);
    }

    // Try exact match on collection + path
    doc = db.prepare(`
      SELECT d.collection as collectionName, d.path, content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `).get(parsed.collectionName, parsed.path) as typeof doc;

    if (!doc) {
      // Try fuzzy match by path ending
      doc = db.prepare(`
        SELECT d.collection as collectionName, d.path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
        LIMIT 1
      `).get(parsed.collectionName, `%${parsed.path}`) as typeof doc;
    }

    virtualPath = inputPath;
  } else {
    // Try to interpret as collection/path format first (before filesystem path)
    // If path is relative (no / or ~ prefix), check if first component is a collection name
    if (!inputPath.startsWith('/') && !inputPath.startsWith('~')) {
      const parts = inputPath.split('/');
      if (parts.length >= 2) {
        const possibleCollection = parts[0];
        const possiblePath = parts.slice(1).join('/');

        // Check if this collection exists
        const collExists = possibleCollection ? db.prepare(`
          SELECT 1 FROM documents WHERE collection = ? AND active = 1 LIMIT 1
        `).get(possibleCollection) : null;

        if (collExists) {
          // Try exact match on collection + path
          doc = db.prepare(`
            SELECT d.collection as collectionName, d.path, content.doc as body
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.collection = ? AND d.path = ? AND d.active = 1
          `).get(possibleCollection || "", possiblePath || "") as { collectionName: string; path: string; body: string } | null;

          if (!doc) {
            // Try fuzzy match by path ending
            doc = db.prepare(`
              SELECT d.collection as collectionName, d.path, content.doc as body
              FROM documents d
              JOIN content ON content.hash = d.hash
              WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
              LIMIT 1
            `).get(possibleCollection || "", `%${possiblePath}`) as { collectionName: string; path: string; body: string } | null;
          }

          if (doc) {
            virtualPath = buildVirtualPath(doc.collectionName, doc.path);
            // Skip the filesystem path handling below
          }
        }
      }
    }

    // If not found as collection/path, handle as filesystem paths
    if (!doc) {
      let fsPath = inputPath;

      // Expand ~ to home directory
      if (fsPath.startsWith('~/')) {
        fsPath = homedir() + fsPath.slice(1);
      } else if (!fsPath.startsWith('/')) {
        // Relative path - resolve from current directory
        fsPath = resolve(getPwd(), fsPath);
      }
      fsPath = getRealPath(fsPath);

      // Try to detect which collection contains this path
      const detected = detectCollectionFromPath(db, fsPath);

      if (detected) {
        // Found collection - query by collection name + relative path
        doc = db.prepare(`
          SELECT d.collection as collectionName, d.path, content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(detected.collectionName, detected.relativePath) as { collectionName: string; path: string; body: string } | null;
      }

      // Fuzzy match by filename (last component of path)
      if (!doc) {
        const filename = inputPath.split('/').pop() || inputPath;
        doc = db.prepare(`
          SELECT d.collection as collectionName, d.path, content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${filename}`) as { collectionName: string; path: string; body: string } | null;
      }

      if (doc) {
        virtualPath = buildVirtualPath(doc.collectionName, doc.path);
      } else {
        virtualPath = inputPath;
      }
    }
  }

  // Ensure doc is not null before proceeding
  if (!doc) {
    console.error(`Document not found: ${filename}`);
    closeDb();
    process.exit(1);
  }

  // Get context for this file
  const context = getContextForPath(db, doc.collectionName, doc.path);

  let output = doc.body;
  const startLine = fromLine || 1;

  // Apply line filtering if specified
  if (fromLine !== undefined || maxLines !== undefined) {
    const lines = output.split('\n');
    const start = startLine - 1; // Convert to 0-indexed
    const end = maxLines !== undefined ? start + maxLines : lines.length;
    output = lines.slice(start, end).join('\n');
  }

  // Add line numbers if requested
  if (lineNumbers) {
    output = addLineNumbers(output, startLine);
  }

  // Output context header if exists
  if (context) {
    console.log(`Folder Context: ${context}\n---\n`);
  }
  console.log(output);
  closeDb();
}

// Multi-get: fetch multiple documents by glob pattern or comma-separated list
function multiGet(pattern: string, maxLines?: number, maxBytes: number = DEFAULT_MULTI_GET_MAX_BYTES, format: OutputFormat = "cli"): void {
  const db = getDb();

  // Check if it's a comma-separated list or a glob pattern
  const isCommaSeparated = pattern.includes(',') && !pattern.includes('*') && !pattern.includes('?') && !pattern.includes('{');

  let files: { filepath: string; displayPath: string; bodyLength: number; collection?: string; path?: string }[];

  if (isCommaSeparated) {
    // Comma-separated list of files (can be virtual paths or relative paths)
    const names = pattern.split(',').map(s => s.trim()).filter(Boolean);
    files = [];
    for (const name of names) {
      let doc: { virtual_path: string; body_length: number; collection: string; path: string } | null = null;

      // Handle virtual paths
      if (isVirtualPath(name)) {
        const parsed = parseVirtualPath(name);
        if (parsed) {
          // Try exact match on collection + path
          doc = db.prepare(`
            SELECT
              'qmd://' || d.collection || '/' || d.path as virtual_path,
              LENGTH(content.doc) as body_length,
              d.collection,
              d.path
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.collection = ? AND d.path = ? AND d.active = 1
          `).get(parsed.collectionName, parsed.path) as typeof doc;
        }
      } else {
        // Try exact match on path
        doc = db.prepare(`
          SELECT
            'qmd://' || d.collection || '/' || d.path as virtual_path,
            LENGTH(content.doc) as body_length,
            d.collection,
            d.path
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.path = ? AND d.active = 1
          LIMIT 1
        `).get(name) as { virtual_path: string; body_length: number; collection: string; path: string } | null;

        // Try suffix match
        if (!doc) {
          doc = db.prepare(`
            SELECT
              'qmd://' || d.collection || '/' || d.path as virtual_path,
              LENGTH(content.doc) as body_length,
              d.collection,
              d.path
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.path LIKE ? AND d.active = 1
            LIMIT 1
          `).get(`%${name}`) as { virtual_path: string; body_length: number; collection: string; path: string } | null;
        }
      }

      if (doc) {
        files.push({
          filepath: doc.virtual_path,
          displayPath: doc.virtual_path,
          bodyLength: doc.body_length,
          collection: doc.collection,
          path: doc.path
        });
      } else {
        console.error(`File not found: ${name}`);
      }
    }
  } else {
    // Glob pattern - matchFilesByGlob now returns virtual paths
    files = matchFilesByGlob(db, pattern).map(f => ({
      ...f,
      collection: undefined,  // Will be fetched later if needed
      path: undefined
    }));
    if (files.length === 0) {
      console.error(`No files matched pattern: ${pattern}`);
      closeDb();
      process.exit(1);
    }
  }

  // Collect results for structured output
  const results: { file: string; displayPath: string; title: string; body: string; context: string | null; skipped: boolean; skipReason?: string }[] = [];

  for (const file of files) {
    // Parse virtual path to get collection info if not already available
    let collection = file.collection;
    let path = file.path;

    if (!collection || !path) {
      const parsed = parseVirtualPath(file.filepath);
      if (parsed) {
        collection = parsed.collectionName;
        path = parsed.path;
      }
    }

    // Get context using collection-scoped function
    const context = collection && path ? getContextForPath(db, collection, path) : null;

    // Check size limit
    if (file.bodyLength > maxBytes) {
      results.push({
        file: file.filepath,
        displayPath: file.displayPath,
        title: file.displayPath.split('/').pop() || file.displayPath,
        body: "",
        context,
        skipped: true,
        skipReason: `File too large (${Math.round(file.bodyLength / 1024)}KB > ${Math.round(maxBytes / 1024)}KB). Use 'qmd get ${file.displayPath}' to retrieve.`,
      });
      continue;
    }

    // Fetch document content using collection and path
    if (!collection || !path) continue;

    const doc = db.prepare(`
      SELECT content.doc as body, d.title
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `).get(collection, path) as { body: string; title: string } | null;

    if (!doc) continue;

    let body = doc.body;

    // Apply line limit if specified
    if (maxLines !== undefined) {
      const lines = body.split('\n');
      body = lines.slice(0, maxLines).join('\n');
      if (lines.length > maxLines) {
        body += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
      }
    }

    results.push({
      file: file.filepath,
      displayPath: file.displayPath,
      title: doc.title || file.displayPath.split('/').pop() || file.displayPath,
      body,
      context,
      skipped: false,
    });
  }

  closeDb();

  // Output based on format
  if (format === "json") {
    const output = results.map(r => ({
      file: r.displayPath,
      title: r.title,
      ...(r.context && { context: r.context }),
      ...(r.skipped ? { skipped: true, reason: r.skipReason } : { body: r.body }),
    }));
    console.log(JSON.stringify(output, null, 2));
  } else if (format === "csv") {
    const escapeField = (val: string | null | undefined): string => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    console.log("file,title,context,skipped,body");
    for (const r of results) {
      console.log([r.displayPath, r.title, r.context, r.skipped ? "true" : "false", r.skipped ? r.skipReason : r.body].map(escapeField).join(","));
    }
  } else if (format === "files") {
    for (const r of results) {
      const ctx = r.context ? `,"${r.context.replace(/"/g, '""')}"` : "";
      const status = r.skipped ? "[SKIPPED]" : "";
      console.log(`${r.displayPath}${ctx}${status ? `,${status}` : ""}`);
    }
  } else if (format === "md") {
    for (const r of results) {
      console.log(`## ${r.displayPath}\n`);
      if (r.title && r.title !== r.displayPath) console.log(`**Title:** ${r.title}\n`);
      if (r.context) console.log(`**Context:** ${r.context}\n`);
      if (r.skipped) {
        console.log(`> ${r.skipReason}\n`);
      } else {
        console.log("```");
        console.log(r.body);
        console.log("```\n");
      }
    }
  } else if (format === "xml") {
    console.log('<?xml version="1.0" encoding="UTF-8"?>');
    console.log("<documents>");
    for (const r of results) {
      console.log("  <document>");
      console.log(`    <file>${escapeXml(r.displayPath)}</file>`);
      console.log(`    <title>${escapeXml(r.title)}</title>`);
      if (r.context) console.log(`    <context>${escapeXml(r.context)}</context>`);
      if (r.skipped) {
        console.log(`    <skipped>true</skipped>`);
        console.log(`    <reason>${escapeXml(r.skipReason || "")}</reason>`);
      } else {
        console.log(`    <body>${escapeXml(r.body)}</body>`);
      }
      console.log("  </document>");
    }
    console.log("</documents>");
  } else {
    // CLI format (default)
    for (const r of results) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`File: ${r.displayPath}`);
      console.log(`${'='.repeat(60)}\n`);

      if (r.skipped) {
        console.log(`[SKIPPED: ${r.skipReason}]`);
        continue;
      }

      if (r.context) {
        console.log(`Folder Context: ${r.context}\n---\n`);
      }
      console.log(r.body);
    }
  }
}

// List files in virtual file tree
function listFiles(pathArg?: string): void {
  const db = getDb();

  if (!pathArg) {
    // No argument - list all collections
    const yamlCollections = yamlListCollections();

    if (yamlCollections.length === 0) {
      console.log("No collections found. Run 'qmd collection add .' to index files.");
      closeDb();
      return;
    }

    // Get file counts from database for each collection
    const collections = yamlCollections.map(coll => {
      const stats = db.prepare(`
        SELECT COUNT(*) as file_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { file_count: number } | null;

      return {
        name: coll.name,
        file_count: stats?.file_count || 0
      };
    });

    console.log(`${c.bold}Collections:${c.reset}\n`);
    for (const coll of collections) {
      console.log(`  ${c.dim}qmd://${c.reset}${c.cyan}${coll.name}/${c.reset}  ${c.dim}(${coll.file_count} files)${c.reset}`);
    }
    closeDb();
    return;
  }

  // Parse the path argument
  let collectionName: string;
  let pathPrefix: string | null = null;

  const afterScheme = pathArg.startsWith('qmd://') ? pathArg.slice('qmd://'.length) : null;
  if (afterScheme !== null && afterScheme.startsWith('/')) {
    // Absolute-path collection: qmd:///Users/foo/bar — normalizeVirtualPath would corrupt
    // this by stripping all leading slashes, so bypass parseVirtualPath entirely.
    const normalized = afterScheme.replace(/\/$/, '');
    const allColls = yamlListCollections();
    const match = allColls
      .filter(c => normalized === c.name || normalized.startsWith(c.name + '/'))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (match) {
      collectionName = match.name;
      const rest = normalized.slice(match.name.length).replace(/^\//, '');
      pathPrefix = rest || null;
    } else {
      // Preserve the historical qmd:////collection/path alias behavior for normal
      // collections when no absolute-path collection matches.
      const parsed = parseVirtualPath(pathArg);
      if (!parsed) {
        console.error(`Invalid virtual path: ${pathArg}`);
        closeDb();
        process.exit(1);
      }
      collectionName = parsed.collectionName;
      pathPrefix = parsed.path;
    }
  } else if (afterScheme !== null) {
    // Normal virtual path: qmd://collection-name/path
    const parsed = parseVirtualPath(pathArg);
    if (!parsed) {
      console.error(`Invalid virtual path: ${pathArg}`);
      closeDb();
      process.exit(1);
    }
    collectionName = parsed.collectionName;
    pathPrefix = parsed.path;
  } else if (pathArg.startsWith('/')) {
    // Raw absolute filesystem path — longest-prefix match against collection names
    const normalized = pathArg.replace(/\/$/, '');
    const allColls = yamlListCollections();
    const match = allColls
      .filter(c => normalized === c.name || normalized.startsWith(c.name + '/'))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (match) {
      collectionName = match.name;
      const rest = normalized.slice(match.name.length).replace(/^\//, '');
      pathPrefix = rest || null;
    } else {
      collectionName = normalized;
    }
  } else {
    // Short collection name or name/path
    const parts = pathArg.split('/');
    collectionName = parts[0] || '';
    if (parts.length > 1) {
      pathPrefix = parts.slice(1).join('/');
    }
  }

  // Get the collection
  const coll = getCollectionFromYaml(collectionName);
  if (!coll) {
    console.error(`Collection not found: ${collectionName}`);
    console.error(`Run 'qmd ls' to see available collections.`);
    closeDb();
    process.exit(1);
  }

  // List files in the collection with size and modification time
  let query: string;
  let params: SQLiteValue[];

  if (pathPrefix) {
    // List files under a specific path
    query = `
      SELECT d.path, d.title, d.modified_at, LENGTH(ct.doc) as size
      FROM documents d
      JOIN content ct ON d.hash = ct.hash
      WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
      ORDER BY d.path
    `;
    params = [coll.name, `${pathPrefix}%`];
  } else {
    // List all files in the collection
    query = `
      SELECT d.path, d.title, d.modified_at, LENGTH(ct.doc) as size
      FROM documents d
      JOIN content ct ON d.hash = ct.hash
      WHERE d.collection = ? AND d.active = 1
      ORDER BY d.path
    `;
    params = [coll.name];
  }

  const files = db.prepare(query).all(...params) as { path: string; title: string; modified_at: string; size: number }[];

  if (files.length === 0) {
    if (pathPrefix) {
      console.log(`No files found under qmd://${collectionName}/${pathPrefix}`);
    } else {
      console.log(`No files found in collection: ${collectionName}`);
    }
    closeDb();
    return;
  }

  // Calculate max widths for alignment
  const maxSize = Math.max(...files.map(f => formatBytes(f.size).length));

  // Output in ls -l style
  for (const file of files) {
    const sizeStr = formatBytes(file.size).padStart(maxSize);
    const date = new Date(file.modified_at);
    const timeStr = formatLsTime(date);

    // Dim the qmd:// prefix, highlight the filename
    console.log(`${sizeStr}  ${timeStr}  ${c.dim}qmd://${collectionName}/${c.reset}${c.cyan}${file.path}${c.reset}`);
  }

  closeDb();
}

// Format date/time like ls -l
function formatLsTime(date: Date): string {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000);

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2, ' ');

  // If file is older than 6 months, show year instead of time
  if (date < sixMonthsAgo) {
    const year = date.getFullYear();
    return `${month} ${day}  ${year}`;
  } else {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${month} ${day} ${hours}:${minutes}`;
  }
}

// Collection management commands
function collectionList(): void {
  const db = getDb();
  const collections = listCollections(db);

  if (collections.length === 0) {
    console.log("No collections found. Run 'qmd collection add .' to create one.");
    closeDb();
    return;
  }

  console.log(`${c.bold}Collections (${collections.length}):${c.reset}\n`);

  for (const coll of collections) {
    const updatedAt = coll.last_modified ? new Date(coll.last_modified) : new Date();
    const timeAgo = formatTimeAgo(updatedAt);
    
    // Get YAML config to check includeByDefault
    const yamlColl = getCollectionFromYaml(coll.name);
    const excluded = yamlColl?.includeByDefault === false;
    const excludeTag = excluded ? ` ${c.yellow}[excluded]${c.reset}` : '';

    console.log(`${c.cyan}${coll.name}${c.reset} ${c.dim}(qmd://${coll.name}/)${c.reset}${excludeTag}`);
    console.log(`  ${c.dim}Pattern:${c.reset}  ${coll.glob_pattern}`);
    if (yamlColl?.ignore?.length) {
      console.log(`  ${c.dim}Ignore:${c.reset}   ${yamlColl.ignore.join(', ')}`);
    }
    console.log(`  ${c.dim}Files:${c.reset}    ${coll.active_count}`);
    console.log(`  ${c.dim}Updated:${c.reset}  ${timeAgo}`);
    console.log();
  }

  closeDb();
}

async function collectionAdd(pwd: string, globPattern: string, name?: string): Promise<void> {
  // If name not provided, generate from pwd basename
  let collName = name;
  if (!collName) {
    const parts = pwd.split('/').filter(Boolean);
    collName = parts[parts.length - 1] || 'root';
  }

  // Check if collection with this name already exists in YAML
  const existing = getCollectionFromYaml(collName);
  if (existing) {
    console.error(`${c.yellow}Collection '${collName}' already exists.${c.reset}`);
    console.error(`Use a different name with --name <name>`);
    process.exit(1);
  }

  // Check if a collection with this pwd+glob already exists in YAML
  const allCollections = yamlListCollections();
  const existingPwdGlob = allCollections.find(c => c.path === pwd && c.pattern === globPattern);

  if (existingPwdGlob) {
    console.error(`${c.yellow}A collection already exists for this path and pattern:${c.reset}`);
    console.error(`  Name: ${existingPwdGlob.name} (qmd://${existingPwdGlob.name}/)`);
    console.error(`  Pattern: ${globPattern}`);
    console.error(`\nUse 'qmd update' to re-index it, or remove it first with 'qmd collection remove ${existingPwdGlob.name}'`);
    process.exit(1);
  }

  // Add to YAML config + sync to SQLite
  const { addCollection } = await import("../collections.js");
  addCollection(collName, pwd, globPattern);
  resyncConfig();

  // Create the collection and index files
  console.log(`Creating collection '${collName}'...`);
  const newColl = getCollectionFromYaml(collName);
  await indexFiles(pwd, globPattern, collName, false, newColl?.ignore);
  console.log(`${c.green}✓${c.reset} Collection '${collName}' created successfully`);
}

function collectionRemove(name: string): void {
  // Check if collection exists in YAML
  const coll = getCollectionFromYaml(name);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${name}${c.reset}`);
    console.error(`Run 'qmd collection list' to see available collections.`);
    process.exit(1);
  }

  const db = getDb();
  const result = removeCollection(db, name);
  // Also remove from YAML config
  yamlRemoveCollectionFn(name);
  closeDb();

  console.log(`${c.green}✓${c.reset} Removed collection '${name}'`);
  console.log(`  Deleted ${result.deletedDocs} documents`);
  if (result.cleanedHashes > 0) {
    console.log(`  Cleaned up ${result.cleanedHashes} orphaned content hashes`);
  }
}

function collectionRename(oldName: string, newName: string): void {
  // Check if old collection exists in YAML
  const coll = getCollectionFromYaml(oldName);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${oldName}${c.reset}`);
    console.error(`Run 'qmd collection list' to see available collections.`);
    process.exit(1);
  }

  // Check if new name already exists in YAML
  const existing = getCollectionFromYaml(newName);
  if (existing) {
    console.error(`${c.yellow}Collection name already exists: ${newName}${c.reset}`);
    console.error(`Choose a different name or remove the existing collection first.`);
    process.exit(1);
  }

  const db = getDb();
  renameCollection(db, oldName, newName);
  // Also rename in YAML config
  yamlRenameCollectionFn(oldName, newName);
  closeDb();

  console.log(`${c.green}✓${c.reset} Renamed collection '${oldName}' to '${newName}'`);
  console.log(`  Virtual paths updated: ${c.cyan}qmd://${oldName}/${c.reset} → ${c.cyan}qmd://${newName}/${c.reset}`);
}

async function indexFiles(pwd?: string, globPattern: string = DEFAULT_GLOB, collectionName?: string, suppressEmbedNotice: boolean = false, ignorePatterns?: string[]): Promise<void> {
  const db = getDb();
  const resolvedPwd = pwd || getPwd();
  const now = new Date().toISOString();
  const excludeDirs = ["node_modules", ".git", ".cache", "vendor", "dist", "build"];

  // Clear Ollama cache on index
  clearCache(db);

  // Collection name must be provided (from YAML)
  if (!collectionName) {
    throw new Error("Collection name is required. Collections must be defined in ~/.config/qmd/index.yml");
  }

  console.log(`Collection: ${resolvedPwd} (${globPattern})`);

  progress.indeterminate();
  const allIgnore = [
    ...excludeDirs.map(d => `**/${d}/**`),
    ...(ignorePatterns || []),
  ];
  const allFiles: string[] = await fastGlob(globPattern, {
    cwd: resolvedPwd,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
    ignore: allIgnore,
  });
  // Filter hidden files/folders (dot: false handles top-level but not nested)
  const files = allFiles.filter(file => {
    const parts = file.split("/");
    return !parts.some(part => part.startsWith("."));
  });

  const total = files.length;
  const hasNoFiles = total === 0;
  if (hasNoFiles) {
    progress.clear();
    console.log("No files found matching pattern.");
    // Continue so the deactivation pass can mark previously indexed docs as inactive.
  }

  let indexed = 0, updated = 0, unchanged = 0, processed = 0;
  const seenPaths = new Set<string>();
  const startTime = Date.now();

  for (const relativeFile of files) {
    const filepath = getRealPath(resolve(resolvedPwd, relativeFile));
    const path = handelize(relativeFile); // Normalize path for token-friendliness
    seenPaths.add(path);

    let content: string;
    try {
      content = readFileSync(filepath, "utf-8");
    } catch {
      // Skip files that can't be read (e.g. iCloud evicted files returning EAGAIN)
      processed++;
      progress.set((processed / total) * 100);
      continue;
    }

    // Skip empty files - nothing useful to index
    if (!content.trim()) {
      processed++;
      continue;
    }

    const hash = await hashContent(content);
    const title = extractTitle(content, relativeFile);

    // Check if document exists (also migrates legacy lowercase paths)
    const existing = findOrMigrateLegacyDocument(db, collectionName, path);

    if (existing) {
      if (existing.hash === hash) {
        // Hash unchanged, but check if title needs updating
        if (existing.title !== title) {
          updateDocumentTitle(db, existing.id, title, now);
          updated++;
        } else {
          unchanged++;
        }
      } else {
        // Content changed - insert new content hash and update document
        insertContent(db, hash, content, now);
        const stat = statSync(filepath);
        updateDocument(db, existing.id, title, hash,
          stat ? new Date(stat.mtime).toISOString() : now);
        updated++;
      }
    } else {
      // New document - insert content and document
      indexed++;
      insertContent(db, hash, content, now);
      const stat = statSync(filepath);
      insertDocument(db, collectionName, path, title, hash,
        stat ? new Date(stat.birthtime).toISOString() : now,
        stat ? new Date(stat.mtime).toISOString() : now);
    }

    processed++;
    progress.set((processed / total) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = processed / elapsed;
    const remaining = (total - processed) / rate;
    const eta = processed > 2 ? ` ETA: ${formatETA(remaining)}` : "";
    if (isTTY) process.stderr.write(`\rIndexing: ${processed}/${total}${eta}        `);
  }

  // Deactivate documents in this collection that no longer exist
  const allActive = getActiveDocumentPaths(db, collectionName);
  let removed = 0;
  for (const path of allActive) {
    if (!seenPaths.has(path)) {
      deactivateDocument(db, collectionName, path);
      removed++;
    }
  }

  // Clean up orphaned content hashes (content not referenced by any document)
  const orphanedContent = cleanupOrphanedContent(db);

  // Check if vector index needs updating
  const needsEmbedding = getHashesNeedingEmbedding(db);

  progress.clear();
  console.log(`\nIndexed: ${indexed} new, ${updated} updated, ${unchanged} unchanged, ${removed} removed`);
  if (orphanedContent > 0) {
    console.log(`Cleaned up ${orphanedContent} orphaned content hash(es)`);
  }

  if (needsEmbedding > 0 && !suppressEmbedNotice) {
    console.log(`\nRun 'qmd embed' to update embeddings (${needsEmbedding} unique hashes need vectors)`);
  }

  closeDb();
}

function renderProgressBar(percent: number, width: number = 30): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return bar;
}

function parseEmbedBatchOption(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveIntegerOption(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseChunkStrategy(value: unknown): ChunkStrategy | undefined {
  if (value === undefined) return undefined;
  const s = String(value);
  if (s === "auto" || s === "regex") return s;
  throw new Error(`--chunk-strategy must be "auto" or "regex" (got "${s}")`);
}

function ensureModelsConfiguredForCli(): { embed: string; generate: string; rerank: string } {
  try {
    return resolveModelsFromConfig(ensureRuntimeConfigForCli());
  } catch {
    return resolveModels();
  }
}

export function resolveEmbedModelForCli(): string {
  return ensureModelsConfiguredForCli().embed;
}

export function resolveGenerateModelForCli(): string {
  return ensureModelsConfiguredForCli().generate;
}

export function resolveRerankModelForCli(): string {
  return ensureModelsConfiguredForCli().rerank;
}

function resolveEmbeddingChunkStrategyForCli(): ChunkStrategy {
  try {
    return ensureRuntimeConfigForCli().embedding?.chunk_strategy
      ?? DEFAULT_EMBED_CHUNK_STRATEGY;
  } catch {
    return DEFAULT_EMBED_CHUNK_STRATEGY;
  }
}

function resolveModelsForCli(): { embed: string; generate: string; rerank: string } {
  return ensureModelsConfiguredForCli();
}

async function vectorIndex(
  model: string = resolveEmbedModelForCli(),
  force: boolean = false,
  batchOptions?: { maxDocsPerBatch?: number; maxBatchBytes?: number; chunkStrategy?: ChunkStrategy; collection?: string },
): Promise<void> {
  const storeInstance = getStore();
  const db = storeInstance.db;
  const effectiveChunkStrategy = batchOptions?.chunkStrategy
    ?? resolveEmbeddingChunkStrategyForCli();
  syncConfigToDb(db, {
    ...loadConfig(),
    embedding: { chunk_strategy: effectiveChunkStrategy },
  });

  if (force) {
    console.log(`${c.yellow}Force re-indexing: clearing all vectors...${c.reset}`);
  }

  // Check if there's work to do before starting
  const hashesToEmbed = getHashesNeedingEmbedding(db, batchOptions?.collection, model);
  if (hashesToEmbed === 0 && !force) {
    console.log(`${c.green}✓ All content hashes already have embeddings.${c.reset}`);
    closeDb();
    return;
  }

  console.log(`${c.dim}Model: ${shortModelName(model)}${c.reset}\n`);
  if (batchOptions?.maxDocsPerBatch !== undefined || batchOptions?.maxBatchBytes !== undefined) {
    const maxDocsPerBatch = batchOptions.maxDocsPerBatch ?? DEFAULT_EMBED_MAX_DOCS_PER_BATCH;
    const maxBatchBytes = batchOptions.maxBatchBytes ?? DEFAULT_EMBED_MAX_BATCH_BYTES;
    console.log(`${c.dim}Batch: ${maxDocsPerBatch} docs / ${formatBytes(maxBatchBytes)}${c.reset}\n`);
  }
  cursor.hide();
  progress.indeterminate();

  const startTime = Date.now();

  const result = await generateEmbeddings(storeInstance, {
    force,
    model,
    collection: batchOptions?.collection,
    maxDocsPerBatch: batchOptions?.maxDocsPerBatch,
    maxBatchBytes: batchOptions?.maxBatchBytes,
    chunkStrategy: effectiveChunkStrategy,
    onProgress: (info) => {
      if (info.totalBytes === 0) return;
      // Progress is measured by input bytes, not by chunks. The final chunk
      // count is discovered lazily batch-by-batch, so displaying
      // chunksEmbedded/totalChunks makes the percent look wrong when a few
      // large documents remain. Show chunks as a count and label the byte
      // percentage explicitly as input progress.
      const percent = Math.min(100, (info.bytesProcessed / info.totalBytes) * 100);
      progress.set(percent);

      const elapsed = (Date.now() - startTime) / 1000;
      const bytesPerSec = elapsed > 0 ? info.bytesProcessed / elapsed : 0;
      const remainingBytes = Math.max(0, info.totalBytes - info.bytesProcessed);
      const etaSec = bytesPerSec > 0 ? remainingBytes / bytesPerSec : Number.POSITIVE_INFINITY;

      const bar = renderProgressBar(percent);
      const percentStr = percent.toFixed(0).padStart(3);
      const throughput = bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : ".../s";
      const eta = elapsed > 2 && Number.isFinite(etaSec) ? formatETA(etaSec) : "...";
      const inputStr = `${formatBytes(info.bytesProcessed)}/${formatBytes(info.totalBytes)} input`;
      const chunkStr = `${formatCount(info.chunksEmbedded)} chunks`;
      const errStr = info.errors > 0 ? ` ${c.yellow}${formatCount(info.errors)} err${c.reset}` : "";

      if (isTTY) process.stderr.write(`\r${c.cyan}${bar}${c.reset} ${c.bold}${percentStr}% input${c.reset} ${c.dim}${chunkStr}${errStr} · ${inputStr} · ${throughput} · ETA ${eta}${c.reset}   `);
    },
  });

  progress.clear();
  cursor.show();

  const totalTimeSec = result.durationMs / 1000;

  if (result.chunksEmbedded === 0 && result.docsProcessed === 0) {
    console.log(`${c.green}✓ No non-empty documents to embed.${c.reset}`);
  } else {
    console.log(`\r${c.green}${renderProgressBar(100)}${c.reset} ${c.bold}100%${c.reset}                                    `);
    console.log(`\n${c.green}✓ Done!${c.reset} Embedded ${c.bold}${result.chunksEmbedded}${c.reset} chunks from ${c.bold}${result.docsProcessed}${c.reset} documents in ${c.bold}${formatETA(totalTimeSec)}${c.reset}`);
    if (result.errors > 0) {
      console.log(`${c.yellow}⚠ ${formatCount(result.errors)} chunks still failed after retries${c.reset}`);
      for (const failure of (result.failures ?? []).slice(0, 8)) {
        console.log(`  ${c.dim}${failure.path}#${failure.seq} (${failure.attempts} attempts): ${failure.reason}${c.reset}`);
      }
      if ((result.failures?.length ?? 0) > 8) {
        console.log(`  ${c.dim}...and ${formatCount((result.failures?.length ?? 0) - 8)} more${c.reset}`);
      }
    }
  }

  closeDb();
}

// Sanitize a term for FTS5: remove punctuation except apostrophes
function sanitizeFTS5Term(term: string): string {
  // Remove all non-alphanumeric except apostrophes (for contractions like "don't")
  return term.replace(/[^\w']/g, '').trim();
}

// Build FTS5 query: phrase-aware with fallback to individual terms
function buildFTS5Query(query: string): string {
  // Sanitize the full query for phrase matching
  const sanitizedQuery = query.replace(/[^\w\s']/g, '').trim();

  const terms = query
    .split(/\s+/)
    .map(sanitizeFTS5Term)
    .filter(term => term.length >= 2); // Skip single chars and empty

  if (terms.length === 0) return "";
  if (terms.length === 1) return `"${terms[0]!.replace(/"/g, '""')}"`;

  // Strategy: exact phrase OR proximity match OR individual terms
  // Exact phrase matches rank highest, then close proximity, then any term
  const phrase = `"${sanitizedQuery.replace(/"/g, '""')}"`;
  const quotedTerms = terms.map(t => `"${t.replace(/"/g, '""')}"`);

  // FTS5 NEAR syntax: NEAR(term1 term2, distance)
  const nearPhrase = `NEAR(${quotedTerms.join(' ')}, 10)`;
  const orTerms = quotedTerms.join(' OR ');

  // Exact phrase > proximity > any term
  return `(${phrase}) OR (${nearPhrase}) OR (${orTerms})`;
}

// Normalize BM25 score to 0-1 range using sigmoid
function normalizeBM25(score: number): number {
  // BM25 scores are negative in SQLite (lower = better)
  // Typical range: -15 (excellent) to -2 (weak match)
  // Map to 0-1 where higher is better
  const absScore = Math.abs(score);
  // Sigmoid-ish normalization: maps ~2-15 range to ~0.1-0.95
  return 1 / (1 + Math.exp(-(absScore - 5) / 3));
}

type OutputOptions = {
  format: OutputFormat;
  full: boolean;
  limit: number;
  minScore: number;
  all?: boolean;
  collection?: string | string[];  // Filter by collection name(s)
  lineNumbers?: boolean; // Add line numbers to output
  explain?: boolean;     // Include retrieval score traces (query only)
  context?: string;      // Optional context for query expansion
  candidateLimit?: number;  // Max candidates to rerank (default: 40)
  intent?: string;       // Domain intent for disambiguation
  skipRerank?: boolean;  // Skip LLM reranking, use RRF scores only
  chunkStrategy?: ChunkStrategy;  // "auto" (default) or "regex"
  displayQuery?: string; // Presentation-only query string for snippets.
  showRouteSummary?: boolean;
};

// Highlight query terms in text (skip short words < 3 chars)
function highlightTerms(text: string, query: string): string {
  if (!useColor) return text;
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  let result = text;
  for (const term of terms) {
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(regex, `${c.yellow}${c.bold}$1${c.reset}`);
  }
  return result;
}

// Format score with color based on value
function formatScore(score: number): string {
  const pct = (score * 100).toFixed(0).padStart(3);
  if (!useColor) return `${pct}%`;
  if (score >= 0.7) return `${c.green}${pct}%${c.reset}`;
  if (score >= 0.4) return `${c.yellow}${pct}%${c.reset}`;
  return `${c.dim}${pct}%${c.reset}`;
}

function formatExplainNumber(value: number): string {
  return value.toFixed(4);
}

// Shorten directory path for display - relative to $HOME (used for context paths, not documents)
function shortPath(dirpath: string): string {
  const home = homedir();
  if (dirpath.startsWith(home)) {
    return '~' + dirpath.slice(home.length);
  }
  return dirpath;
}

type EmptySearchReason = "no_results" | "min_score";

// Emit format-safe empty output for search commands.
function printEmptySearchResults(format: OutputFormat, reason: EmptySearchReason = "no_results"): void {
  if (format === "json") {
    console.log("[]");
    return;
  }
  if (format === "csv") {
    console.log("docid,score,file,title,context,line,snippet");
    return;
  }
  if (format === "xml") {
    console.log("<results></results>");
    return;
  }
  if (format === "md" || format === "files") {
    return;
  }

  if (reason === "min_score") {
    console.log("No results found above minimum score threshold.");
    return;
  }
  console.log("No results found.");
}

type OutputRow = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  context?: string | null;
  chunkPos?: number;
  chunkLen?: number;
  hash?: string;
  docid?: string;
  explain?: HybridQueryExplain;
};

const DEFAULT_EDITOR_URI_TEMPLATE = "vscode://file/{path}:{line}:{col}";

function encodePathForEditorUri(absolutePath: string): string {
  return encodeURI(absolutePath)
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23");
}

function getEditorUriTemplate(): string {
  const envTemplate = process.env.QMD_EDITOR_URI?.trim();
  if (envTemplate) return envTemplate;

  try {
    const config = loadConfig() as unknown as {
      editor_uri?: string;
      editor_uri_template?: string;
      editorUri?: string;
      [key: string]: unknown;
    };
    const configTemplate = (
      config.editor_uri
      || config.editor_uri_template
      || config.editorUri
      || (typeof config["editor-uri"] === "string" ? config["editor-uri"] : undefined)
    )?.trim();

    if (configTemplate) return configTemplate;
  } catch {
    // Ignore config parsing issues and use default template.
  }

  return DEFAULT_EDITOR_URI_TEMPLATE;
}

export function buildEditorUri(template: string, absolutePath: string, line: number, col: number): string {
  const safeLine = Number.isFinite(line) && line > 0 ? Math.floor(line) : 1;
  const safeCol = Number.isFinite(col) && col > 0 ? Math.floor(col) : 1;
  const encodedPath = encodePathForEditorUri(absolutePath);

  return template
    .replace(/\{path\}/g, encodedPath)
    .replace(/\{line\}/g, String(safeLine))
    .replace(/\{col\}/g, String(safeCol))
    .replace(/\{column\}/g, String(safeCol));
}

export function termLink(text: string, url: string, isTTY: boolean = !!process.stdout.isTTY): string {
  if (!isTTY) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function outputResults(results: OutputRow[], query: string, opts: OutputOptions): void {
  const filtered = results.filter(r => r.score >= opts.minScore).slice(0, opts.limit);

  if (filtered.length === 0) {
    printEmptySearchResults(opts.format, "min_score");
    return;
  }

  // Helper to create qmd:// URI from displayPath
  const toQmdPath = (displayPath: string) => {
    const [collectionName, ...segments] = displayPath.split("/");
    if (!collectionName || segments.length === 0) {
      return `qmd://${displayPath}`;
    }
    const indexName = getActiveIndexName();
    return buildVirtualPath(
      collectionName,
      segments.join("/"),
      indexName === "index" ? undefined : indexName,
    );
  };

  if (opts.format === "json") {
    // JSON output for LLM consumption
    const output = filtered.map(row => {
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);
      const snippetInfo = extractSnippet(row.body, query, 300, row.chunkPos, row.chunkLen, opts.intent);
      let body = opts.full ? row.body : undefined;
      let snippet = !opts.full ? snippetInfo.snippet : undefined;
      if (opts.lineNumbers) {
        if (body) body = addLineNumbers(body);
        if (snippet) snippet = addLineNumbers(snippet);
      }
      return {
        ...(docid && { docid: `#${docid}` }),
        score: Math.round(row.score * 100) / 100,
        file: toQmdPath(row.displayPath),
        line: snippetInfo.line,
        title: row.title,
        ...(row.context && { context: row.context }),
        ...(body && { body }),
        ...(snippet && { snippet }),
        ...(opts.explain && row.explain && { explain: row.explain }),
      };
    });
    console.log(JSON.stringify(output, null, 2));
  } else if (opts.format === "files") {
    // Simple docid,score,filepath,context output
    for (const row of filtered) {
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      const ctx = row.context ? `,"${row.context.replace(/"/g, '""')}"` : "";
      console.log(`#${docid},${row.score.toFixed(2)},${toQmdPath(row.displayPath)}${ctx}`);
    }
  } else if (opts.format === "cli") {
    const editorUriTemplate = getEditorUriTemplate();
    const linkDb = getDb();

    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i];
      if (!row) continue;
      const { line, snippet } = extractSnippet(row.body, query, 500, row.chunkPos, row.chunkLen, opts.intent);
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);

      // Line 1: filepath with docid
      const virtualPath = row.file.startsWith("qmd://") ? row.file : toQmdPath(row.displayPath);
      const parsed = parseVirtualPath(virtualPath);
      const absolutePath = resolveVirtualPath(linkDb, virtualPath);

      const legacyPath = toQmdPath(row.displayPath);
      const displayPath = parsed?.path || row.displayPath;

      // Only show :line if we actually found a term match in the snippet body (exclude header line).
      const snippetBody = snippet.split("\n").slice(1).join("\n").toLowerCase();
      const hasMatch = query.toLowerCase().split(/\s+/).some(t => t.length > 0 && snippetBody.includes(t));
      const lineInfo = hasMatch ? `:${line}` : "";
      const docidStr = docid ? ` ${c.dim}#${docid}${c.reset}` : "";

      if (process.stdout.isTTY && absolutePath && parsed?.path) {
        const linkLine = hasMatch ? line : 1;
        const linkTarget = buildEditorUri(editorUriTemplate, absolutePath, linkLine, 1);
        const clickable = termLink(`${displayPath}${lineInfo}`, linkTarget);
        console.log(`${c.cyan}${clickable}${c.reset}${docidStr}`);
      } else {
        console.log(`${c.cyan}${legacyPath}${c.dim}${lineInfo}${c.reset}${docidStr}`);
      }

      // Line 2: Title (if available)
      if (row.title) {
        console.log(`${c.bold}Title: ${row.title}${c.reset}`);
      }

      // Line 3: Context (if available)
      if (row.context) {
        console.log(`${c.dim}Context: ${row.context}${c.reset}`);
      }

      // Line 4: Score
      const score = formatScore(row.score);
      console.log(`Score: ${c.bold}${score}${c.reset}`);
      if (opts.explain && row.explain) {
        const explain = row.explain;
        const ftsScores = explain.ftsScores.length > 0
          ? explain.ftsScores.map(formatExplainNumber).join(", ")
          : "none";
        const vecScores = explain.vectorScores.length > 0
          ? explain.vectorScores.map(formatExplainNumber).join(", ")
          : "none";
        const contribSummary = explain.rrf.contributions
          .slice()
          .sort((a, b) => b.rrfContribution - a.rrfContribution)
          .slice(0, 3)
          .map(c => `${c.source}/${c.queryType}#${c.rank}:${formatExplainNumber(c.rrfContribution)}`)
          .join(" | ");

        console.log(`${c.dim}Explain: fts=[${ftsScores}] vec=[${vecScores}]${c.reset}`);
        console.log(`${c.dim}  RRF: total=${formatExplainNumber(explain.rrf.totalScore)} base=${formatExplainNumber(explain.rrf.baseScore)} bonus=${formatExplainNumber(explain.rrf.topRankBonus)} rank=${explain.rrf.rank}${c.reset}`);
        console.log(`${c.dim}  Blend: ${Math.round(explain.rrf.weight * 100)}%*${formatExplainNumber(explain.rrf.positionScore)} + ${Math.round((1 - explain.rrf.weight) * 100)}%*${formatExplainNumber(explain.rerankScore)} = ${formatExplainNumber(explain.blendedScore)}${c.reset}`);
        if (contribSummary.length > 0) {
          console.log(`${c.dim}  Top RRF contributions: ${contribSummary}${c.reset}`);
        }
      }
      console.log();

      // Snippet with highlighting (diff-style header included)
      const content = opts.full ? row.body : snippet;
      const displayContent = opts.lineNumbers ? addLineNumbers(content, opts.full ? 1 : line) : content;
      const highlighted = highlightTerms(displayContent, query);
      console.log(highlighted);

      // Double empty line between results
      if (i < filtered.length - 1) console.log('\n');
    }
  } else if (opts.format === "md") {
    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i];
      if (!row) continue;
      const heading = row.title || row.displayPath;
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);
      let content = opts.full ? row.body : extractSnippet(row.body, query, 500, row.chunkPos, row.chunkLen, opts.intent).snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content);
      }
      const docidLine = docid ? `**docid:** \`#${docid}\`\n` : "";
      const contextLine = row.context ? `**context:** ${row.context}\n` : "";
      console.log(`---\n# ${heading}\n${docidLine}${contextLine}\n${content}\n`);
    }
  } else if (opts.format === "xml") {
    for (const row of filtered) {
      const titleAttr = row.title ? ` title="${row.title.replace(/"/g, '&quot;')}"` : "";
      const contextAttr = row.context ? ` context="${row.context.replace(/"/g, '&quot;')}"` : "";
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      let content = opts.full ? row.body : extractSnippet(row.body, query, 500, row.chunkPos, row.chunkLen, opts.intent).snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content);
      }
      console.log(`<file docid="#${docid}" name="${toQmdPath(row.displayPath)}"${titleAttr}${contextAttr}>\n${content}\n</file>\n`);
    }
  } else {
    // CSV format
    console.log("docid,score,file,title,context,line,snippet");
    for (const row of filtered) {
      const { line, snippet } = extractSnippet(row.body, query, 500, row.chunkPos, row.chunkLen, opts.intent);
      let content = opts.full ? row.body : snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content, opts.full ? 1 : line);
      }
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      const snippetText = content || "";
      console.log(`#${docid},${row.score.toFixed(4)},${escapeCSV(toQmdPath(row.displayPath))},${escapeCSV(row.title || "")},${escapeCSV(row.context || "")},${line},${escapeCSV(snippetText)}`);
    }
  }
}

function evidenceMetadataString(
  evidence: EvidenceRef,
  key: string,
): string | undefined {
  const value = evidence.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function evidenceMetadataNumber(
  evidence: EvidenceRef,
  key: string,
): number | undefined {
  const value = evidence.metadata?.[key];
  return typeof value === "number" ? value : undefined;
}

function formatRouteRefusals(decision: QueryRouteDecision): string {
  return decision.refusalReasons.length > 0
    ? decision.refusalReasons.join(", ")
    : "none";
}

function outputRouteDecisionSummary(decision: QueryRouteDecision, format: OutputFormat): void {
  if (format === "cli") {
    console.log("QueryRouteDecision:");
    console.log(`  requestedRoute: ${decision.requestedRoute}`);
    console.log(`  selectedRoute: ${decision.selectedRoute}`);
    console.log(`  reasonCode: ${decision.reasonCode}`);
    console.log(`  refusalReasons: ${formatRouteRefusals(decision)}`);
    console.log();
    return;
  }

  if (format === "md") {
    console.log("## QueryRouteDecision\n");
    console.log(`- requestedRoute: \`${decision.requestedRoute}\``);
    console.log(`- selectedRoute: \`${decision.selectedRoute}\``);
    console.log(`- reasonCode: \`${decision.reasonCode}\``);
    console.log(`- refusalReasons: \`${formatRouteRefusals(decision)}\`\n`);
  }
}

function evidenceDisplayPath(evidence: EvidenceRef): string {
  return evidence.locator?.uri ?? evidence.locator?.path ??
    evidenceMetadataString(evidence, "path") ?? evidence.evidenceId;
}

function evidenceTitle(evidence: EvidenceRef): string {
  return evidenceMetadataString(evidence, "title") ?? evidenceDisplayPath(evidence);
}

function evidenceBody(evidence: EvidenceRef): string {
  return evidenceMetadataString(evidence, "fullText") ?? evidence.quote ?? "";
}

function evidenceDocid(evidence: EvidenceRef): string {
  return evidenceMetadataString(evidence, "docid") ?? evidence.documentId ??
    evidence.evidenceId;
}

function unifiedEvidenceReference(evidence: EvidenceRef): Record<string, unknown> {
  return {
    evidenceId: evidence.evidenceId,
    graphCapabilityId: evidence.graphCapabilityId,
    sourceId: evidence.sourceId,
    documentId: evidence.documentId,
    contentHash: evidence.contentHash,
    chunkId: evidence.chunkId,
    bookId: evidence.bookId,
    graphTextUnitId: evidence.graphTextUnitId,
    artifactId: evidence.artifactId,
    locator: evidence.locator,
    score: evidence.score ?? null,
    metadata: evidence.metadata ?? {},
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unifiedReferenceSummary(evidence: EvidenceRef): string {
  return [
    `evidenceId=${evidence.evidenceId}`,
    evidence.sourceId ? `sourceId=${evidence.sourceId}` : undefined,
    evidence.documentId ? `documentId=${evidence.documentId}` : undefined,
    evidence.contentHash ? `contentHash=${evidence.contentHash}` : undefined,
    evidence.bookId ? `bookId=${evidence.bookId}` : undefined,
    evidence.graphCapabilityId
      ? `graphCapabilityId=${evidence.graphCapabilityId}`
      : undefined,
    evidence.graphTextUnitId ? `graphTextUnitId=${evidence.graphTextUnitId}` : undefined,
    evidence.artifactId ? `artifactId=${evidence.artifactId}` : undefined,
    evidence.score == null ? undefined : `score=${evidence.score}`,
  ].filter(Boolean).join(" ");
}

function outputUnifiedAnswerEvidence(answer: UnifiedAnswer, opts: OutputOptions): void {
  const evidence = answer.evidence.slice(0, opts.limit);
  if (opts.format === "files") {
    for (const item of evidence) {
      console.log([
        evidenceDocid(item),
        item.score ?? "",
        evidenceDisplayPath(item),
        item.sourceId ?? "",
        item.documentId ?? "",
        item.contentHash ?? "",
        item.bookId ?? "",
        item.graphCapabilityId ?? "",
        item.graphTextUnitId ?? "",
        item.artifactId ?? "",
      ].map(String).map(escapeCSV).join(","));
    }
    return;
  }

  if (opts.format === "csv") {
    console.log([
      "evidenceId",
      "score",
      "path",
      "title",
      "sourceId",
      "documentId",
      "contentHash",
      "bookId",
      "graphCapabilityId",
      "graphTextUnitId",
      "artifactId",
      "locator",
      "quote",
    ].join(","));
    for (const item of evidence) {
      console.log([
        item.evidenceId,
        item.score ?? "",
        evidenceDisplayPath(item),
        evidenceTitle(item),
        item.sourceId ?? "",
        item.documentId ?? "",
        item.contentHash ?? "",
        item.bookId ?? "",
        item.graphCapabilityId ?? "",
        item.graphTextUnitId ?? "",
        item.artifactId ?? "",
        item.locator == null ? "" : JSON.stringify(item.locator),
        item.quote ?? "",
      ].map(String).map(escapeCSV).join(","));
    }
    return;
  }

  if (opts.format === "md") {
    console.log(`# Answer\n\n${answer.answerText}\n`);
    console.log("## Evidence\n");
    for (const item of evidence) {
      console.log(`### ${evidenceTitle(item)}\n`);
      console.log("```json");
      console.log(JSON.stringify(unifiedEvidenceReference(item), null, 2));
      console.log("```\n");
      if (item.quote) console.log(`${item.quote}\n`);
    }
    return;
  }

  if (opts.format === "xml") {
    console.log(`<answer route="${xmlEscape(answer.routeDecision.selectedRoute)}">`);
    console.log(`  <text>${xmlEscape(answer.answerText)}</text>`);
    console.log("  <evidence>");
    for (const item of evidence) {
      console.log(
        `    <item evidenceId="${xmlEscape(item.evidenceId)}"` +
          ` sourceId="${xmlEscape(item.sourceId ?? "")}"` +
          ` documentId="${xmlEscape(item.documentId ?? "")}"` +
          ` contentHash="${xmlEscape(item.contentHash ?? "")}"` +
          ` bookId="${xmlEscape(item.bookId ?? "")}"` +
          ` graphCapabilityId="${xmlEscape(item.graphCapabilityId ?? "")}"` +
          ` graphTextUnitId="${xmlEscape(item.graphTextUnitId ?? "")}"` +
          ` artifactId="${xmlEscape(item.artifactId ?? "")}"` +
          ` score="${xmlEscape(String(item.score ?? ""))}">`,
      );
      console.log(`      <locator>${xmlEscape(JSON.stringify(item.locator ?? {}))}</locator>`);
      console.log(`      <quote>${xmlEscape(item.quote ?? "")}</quote>`);
      console.log("    </item>");
    }
    console.log("  </evidence>");
    console.log("</answer>");
    return;
  }

  console.log(answer.answerText);
  if (evidence.length > 0) {
    console.log();
    console.log("Evidence:");
    for (const item of evidence) {
      console.log(`- ${evidenceDisplayPath(item)} ${c.dim}${unifiedReferenceSummary(item)}${c.reset}`);
      if (item.score != null) console.log(`  Score: ${formatScore(item.score)}`);
      if (item.quote) console.log(`  ${item.quote}`);
    }
  }
}

function outputUnifiedAnswer(answer: UnifiedAnswer, opts: OutputOptions): void {
  if (opts.format === "json") {
    console.log(JSON.stringify(answer, null, 2));
    return;
  }

  if (opts.showRouteSummary) {
    outputRouteDecisionSummary(answer.routeDecision, opts.format);
  }

  outputUnifiedAnswerEvidence(answer, opts);
}

// Resolve -c collection filter: supports single string, array, or undefined.
// Returns validated collection names (exits on unknown collection).
function resolveCollectionFilter(raw: string | string[] | undefined, useDefaults: boolean = false): string[] {
  // If no filter specified and useDefaults is true, use default collections
  if (!raw && useDefaults) {
    return getDefaultCollectionNames();
  }
  if (!raw) return [];
  const names = Array.isArray(raw) ? raw : [raw];
  const validated: string[] = [];
  for (const name of names) {
    const coll = getCollectionFromYaml(name);
    if (!coll) {
      console.error(`Collection not found: ${name}`);
      closeDb();
      process.exit(1);
    }
    validated.push(name);
  }
  return validated;
}

// Post-filter results to only include files from specified collections.
function filterByCollections<T extends { filepath?: string; file?: string }>(results: T[], collectionNames: string[]): T[] {
  if (collectionNames.length <= 1) return results;
  const prefixes = collectionNames.map(n => `qmd://${n}/`);
  return results.filter(r => {
    const path = r.filepath || r.file || '';
    return prefixes.some(p => path.startsWith(p));
  });
}

/**
 * Parse structured search query syntax.
 * Lines starting with lex:, vec:, or hyde: are routed directly.
 * Plain lines without prefix go through query expansion.
 * 
 * Returns null if this is a plain query (single line, no prefix).
 * Returns ExpandedQuery[] if structured syntax detected.
 * Throws if multiple plain lines (ambiguous).
 * 
 * Examples:
 *   "CAP theorem"                    -> null (plain query, use expansion)
 *   "lex: CAP theorem"               -> [{ type: 'lex', query: 'CAP theorem' }]
 *   "lex: CAP\nvec: consistency"     -> [{ type: 'lex', ... }, { type: 'vec', ... }]
 *   "CAP\nconsistency"               -> throws (multiple plain lines)
 */
interface ParsedStructuredQuery {
  searches: ExpandedQuery[];
  intent?: string;
}

function parseStructuredQuery(query: string): ParsedStructuredQuery | null {
  const rawLines = query.split('\n').map((line, idx) => ({
    raw: line,
    trimmed: line.trim(),
    number: idx + 1,
  })).filter(line => line.trimmed.length > 0);

  if (rawLines.length === 0) return null;

  const prefixRe = /^(lex|vec|hyde):\s*/i;
  const expandRe = /^expand:\s*/i;
  const intentRe = /^intent:\s*/i;
  const typed: ExpandedQuery[] = [];
  let intent: string | undefined;

  for (const line of rawLines) {
    if (expandRe.test(line.trimmed)) {
      if (rawLines.length > 1) {
        throw new Error(`Line ${line.number} starts with expand:, but query documents cannot mix expand with typed lines. Submit a single expand query instead.`);
      }
      const text = line.trimmed.replace(expandRe, '').trim();
      if (!text) {
        throw new Error('expand: query must include text.');
      }
      return null; // treat as standalone expand query
    }

    // Parse intent: lines
    if (intentRe.test(line.trimmed)) {
      if (intent !== undefined) {
        throw new Error(`Line ${line.number}: only one intent: line is allowed per query document.`);
      }
      const text = line.trimmed.replace(intentRe, '').trim();
      if (!text) {
        throw new Error(`Line ${line.number}: intent: must include text.`);
      }
      intent = text;
      continue;
    }

    const match = line.trimmed.match(prefixRe);
    if (match) {
      const type = match[1]!.toLowerCase() as 'lex' | 'vec' | 'hyde';
      const text = line.trimmed.slice(match[0].length).trim();
      if (!text) {
        throw new Error(`Line ${line.number} (${type}:) must include text.`);
      }
      if (/\r|\n/.test(text)) {
        throw new Error(`Line ${line.number} (${type}:) contains a newline. Keep each query on a single line.`);
      }
      typed.push({ type, query: text, line: line.number });
      continue;
    }

    if (rawLines.length === 1) {
      // Single plain line -> implicit expand
      return null;
    }

    throw new Error(`Line ${line.number} is missing a lex:/vec:/hyde:/intent: prefix. Each line in a query document must start with one.`);
  }

  // intent: alone is not a valid query — must have at least one search
  if (intent && typed.length === 0) {
    throw new Error('intent: cannot appear alone. Add at least one lex:, vec:, or hyde: line.');
  }

  return typed.length > 0 ? { searches: typed, intent } : null;
}

async function searchQmdForUnifiedRoute(
  query: string,
  opts: OutputOptions,
  routeOptions: {
    quietDiagnostics?: boolean;
    graphVault?: string;
  } = {},
): Promise<{
  results: Awaited<ReturnType<typeof hybridQuery>>;
  qmdResult: QmdSearchResult;
}> {
  const store = getStore();
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;
  if (!routeOptions.quietDiagnostics) {
    checkIndexHealth(store.db);
  }

  const parsed = parseStructuredQuery(query);
  const intent = opts.intent || parsed?.intent;
  let results = parsed
    ? await structuredSearch(store, parsed.searches, {
        collections: singleCollection ? [singleCollection] : undefined,
        limit: opts.all ? 500 : (opts.limit || 10),
        minScore: opts.minScore || 0,
        candidateLimit: opts.candidateLimit,
        skipRerank: opts.skipRerank,
        explain: !!opts.explain,
        intent,
        chunkStrategy: opts.chunkStrategy,
      })
    : await hybridQuery(store, query, {
        collection: singleCollection,
        limit: opts.all ? 500 : (opts.limit || 10),
        minScore: opts.minScore || 0,
        candidateLimit: opts.candidateLimit,
        skipRerank: opts.skipRerank,
        explain: !!opts.explain,
        intent,
        chunkStrategy: opts.chunkStrategy,
      });

  if (collectionNames.length > 1) {
    results = results.filter(r => {
      const prefixes = collectionNames.map(n => `qmd://${n}/`);
      return prefixes.some(p => r.file.startsWith(p));
    });
  }

  const identities = routeOptions.graphVault
    ? await loadDocumentIdentitiesFromGraphVault(routeOptions.graphVault)
    : [];

  return {
    results,
    qmdResult: QmdSearchResultSchema.parse({
      schemaVersion: SchemaVersion,
      query,
      results: toQmdRetrievalCandidates(results as readonly QmdCandidateInput[], {
        identities,
        fallbackCandidatePrefix: "qmd",
      }),
    }),
  };
}

function outputHybridResults(
  results: Awaited<ReturnType<typeof hybridQuery>>,
  query: string,
  opts: OutputOptions,
): void {
  outputResults(results.map(r => ({
    file: r.file,
    displayPath: r.displayPath,
    title: r.title,
    body: r.body,
    chunkPos: r.bestChunkPos,
    chunkLen: r.bestChunk.length,
    score: r.score,
    context: r.context,
    docid: r.docid,
    explain: r.explain,
  })), query, { ...opts, limit: results.length });
}

function search(query: string, opts: OutputOptions): void {
  const db = getDb();

  // Validate collection filter (supports multiple -c flags)
  // Use default collections if none specified
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;

  // Use large limit for --all, otherwise fetch more than needed and let outputResults filter
  const fetchLimit = opts.all ? 100000 : Math.max(50, opts.limit * 2);
  const results = filterByCollections(
    searchFTS(db, query, fetchLimit, singleCollection),
    collectionNames
  );

  // Add context to results
  const resultsWithContext = results.map(r => ({
    file: r.filepath,
    displayPath: r.displayPath,
    title: r.title,
    body: r.body || "",
    score: r.score,
    context: getContextForFile(db, r.filepath),
    hash: r.hash,
    docid: r.docid,
  }));

  closeDb();

  if (resultsWithContext.length === 0) {
    printEmptySearchResults(opts.format);
    return;
  }
  outputResults(resultsWithContext, query, opts);
}

// Log query expansion as a tree to stderr (CLI progress feedback)
function logExpansionTree(originalQuery: string, expanded: ExpandedQuery[]): void {
  const lines: string[] = [];
  lines.push(`${c.dim}├─ ${originalQuery}${c.reset}`);
  for (const q of expanded) {
    let preview = q.query.replace(/\n/g, ' ');
    if (preview.length > 72) preview = preview.substring(0, 69) + '...';
    lines.push(`${c.dim}├─ ${q.type}: ${preview}${c.reset}`);
  }
  if (lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace('├─', '└─');
  }
  for (const line of lines) process.stderr.write(line + '\n');
}

async function vectorSearch(query: string, opts: OutputOptions, _model: string = DEFAULT_EMBED_MODEL): Promise<void> {
  const store = getStore();

  // Validate collection filter (supports multiple -c flags)
  // Use default collections if none specified
  const collectionNames = resolveCollectionFilter(opts.collection, true);
  const singleCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;

  checkIndexHealth(store.db);

  await withLLMSession(async () => {
    const request = QmdVectorSearchRequestSchema.parse({
      schemaVersion: SchemaVersion,
      query,
      ...(collectionNames.length > 0 ? { collections: collectionNames } : {}),
      intent: opts.intent,
      limit: opts.all ? 500 : (opts.limit || 10),
      minScore: opts.minScore || 0.3,
      providerPolicy: {
        generation: false,
        queryExpansion: false,
        rerank: false,
        embedding: true,
      },
    });
    let results = await vectorSearchQuery(store, request.query, {
      collection: singleCollection,
      limit: request.limit ?? (opts.all ? 500 : (opts.limit || 10)),
      minScore: request.minScore ?? 0.3,
      intent: request.intent,
    });

    // Post-filter for multi-collection
    if (collectionNames.length > 1) {
      results = results.filter(r => {
        const prefixes = collectionNames.map(n => `qmd://${n}/`);
        return prefixes.some(p => r.file.startsWith(p));
      });
    }

    closeDb();

    if (results.length === 0 && opts.format !== "json") {
      printEmptySearchResults(opts.format);
      return;
    }

    const vectorResult = QmdVectorSearchResultSchema.parse({
      schemaVersion: SchemaVersion,
      query,
      results: results.map((result, index) => ({
        candidateId: result.hash
          ? `${result.hash}:vec:${index}`
          : `vec:${index}`,
        sourceId: null,
        documentId: null,
        contentHash: result.hash ?? null,
        chunkId: null,
        path: result.file,
        title: result.title,
        snippet: result.body.slice(0, 300),
        source: "vec",
        retrievalScore: result.score,
        rerankScore: null,
        metadata: {
          displayPath: result.displayPath,
          docid: result.docid,
          fullText: result.body,
          ...(result.context ? { context: result.context } : {}),
        },
      })),
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(vectorResult, null, 2));
      return;
    }

    outputResults(vectorResult.results.map((candidate) => ({
      file: candidate.path,
      displayPath: typeof candidate.metadata?.displayPath === "string"
        ? candidate.metadata.displayPath
        : candidate.path,
      title: candidate.title ?? "",
      body: typeof candidate.metadata?.fullText === "string"
        ? candidate.metadata.fullText
        : candidate.snippet ?? "",
      score: candidate.retrievalScore,
      context: typeof candidate.metadata?.context === "string"
        ? candidate.metadata.context
        : null,
      hash: candidate.contentHash ?? undefined,
      docid: typeof candidate.metadata?.docid === "string"
        ? candidate.metadata.docid
        : undefined,
    })), query, { ...opts, limit: vectorResult.results.length });
  }, { maxDuration: 10 * 60 * 1000, name: 'vectorSearch' });
}

async function querySearch(query: string, opts: OutputOptions, _embedModel: string = DEFAULT_EMBED_MODEL, _rerankModel: string = DEFAULT_RERANK_MODEL): Promise<void> {
  await withLLMSession(async () => {
    const parsed = parseStructuredQuery(query);
    const intent = opts.intent || parsed?.intent;
    if (parsed) {
      const structuredQueries = parsed.searches;
      const typeLabels = structuredQueries.map(s => s.type).join('+');
      process.stderr.write(`${c.dim}Structured search: ${structuredQueries.length} queries (${typeLabels})${c.reset}\n`);
      if (intent) {
        process.stderr.write(`${c.dim}├─ intent: ${intent}${c.reset}\n`);
      }

      // Log each sub-query
      for (const s of structuredQueries) {
        let preview = s.query.replace(/\n/g, ' ');
        if (preview.length > 72) preview = preview.substring(0, 69) + '...';
        process.stderr.write(`${c.dim}├─ ${s.type}: ${preview}${c.reset}\n`);
      }
      process.stderr.write(`${c.dim}└─ Searching...${c.reset}\n`);
    }

    const answer = await routeQuery({
      schemaVersion: SchemaVersion,
      query,
      requestedRoute: "qmd",
      collections: resolveCollectionFilter(opts.collection, true),
      maxCostClass: "medium",
    }, {
      searchQmd: async () => {
        const searchResult = await searchQmdForUnifiedRoute(
          query,
          opts,
          {
            quietDiagnostics: opts.format === "json",
          },
        );
        return searchResult.qmdResult;
      },
    });

    closeDb();

    // Use first lex/vec query for output context, or original query
    const structuredQueries = parsed?.searches;
    const displayQuery = structuredQueries
      ? (structuredQueries.find(s => s.type === 'lex')?.query || structuredQueries.find(s => s.type === 'vec')?.query || query)
      : query;

    outputUnifiedAnswer(answer, { ...opts, displayQuery });
  }, { maxDuration: 10 * 60 * 1000, name: 'querySearch' });
}

async function autoQuerySearch(query: string, opts: OutputOptions): Promise<void> {
  await withLLMSession(async () => {
    const config = ensureRuntimeConfigForCli();
    const graphVault = pathResolve(
      getPwd(),
      config.graphrag?.vault ?? "graph_vault",
    );
    const method = GraphRagSearchMethodSchema.parse(
      config.graphrag?.default_method ?? "local",
    );
    const responseType =
      config.graphrag?.default_response_type ?? "multiple paragraphs";
    const answer = await routeQuery({
      schemaVersion: SchemaVersion,
      query,
      requestedRoute: "auto",
      maxCostClass: config.query?.auto_route?.max_cost_class ?? "medium",
      graphCoverageThreshold: config.query?.auto_route?.graph_coverage_threshold,
      allowGraphUpgrade: config.query?.allow_graph_upgrade !== false,
    }, {
      searchQmd: async () => {
        const searchResult = await searchQmdForUnifiedRoute(
          query,
          opts,
          {
            quietDiagnostics: opts.format === "json",
            graphVault,
          },
        );
        return searchResult.qmdResult;
      },
      resolveGraphCapabilities: async (candidates) =>
        resolveCandidateGraphCapabilities({ graphVault, candidates }),
      queryGraphRag: async (request, decision) => {
        if (decision.selectedBookIds.length !== 1) {
          throw new TypedQueryErrorException(createTypedQueryError({
            route: request.requestedRoute,
            stage: "route",
            provider: "graphrag",
            capability: "graph_query",
            code: "ambiguous_graph_book_scope",
            retryable: false,
            redactedMessage:
              "GraphRAG auto upgrade requires exactly one graph-ready book.",
            metadata: {
              selectedBookCount: decision.selectedBookIds.length,
            },
          }));
        }
        const runtime = createQmdGraphRagRuntime();
        return runtime.graphQuery({
          rootDir: graphVault,
          dataDir: pathResolve(
            graphVault,
            "books",
            decision.selectedBookIds[0]!,
            "output",
          ),
          method: GraphRagSearchMethodSchema.parse(request.method ?? method),
          query: request.query,
          responseType,
          capabilityScope: {
            selectedBookIds: decision.selectedBookIds,
            graphCapabilityIds: decision.graphCapabilityIds,
            sourceIds: decision.selectedSourceIds,
            documentIds: decision.selectedDocumentIds,
            contentHashes: decision.selectedContentHashes,
            artifactIds: decision.graphArtifactIds,
          },
          verbose: false,
          environment: {
            workingDirectory: getPwd(),
          },
        });
      },
    });

    closeDb();

    outputUnifiedAnswer(answer, { ...opts, showRouteSummary: true });
  }, { maxDuration: 10 * 60 * 1000, name: 'autoQuerySearch' });
}

async function graphRagQuerySearch(
  query: string,
  opts: OutputOptions,
  values: Record<string, unknown>,
): Promise<void> {
  const config = ensureRuntimeConfigForCli();
  const graphVault = pathResolve(
    getPwd(),
    String(values["graph-vault"] || config.graphrag?.vault || "graph_vault"),
  );
  const method = GraphRagSearchMethodSchema.parse(
    String(values["query-method"] || config.graphrag?.default_method || "local"),
  );
  const responseType = String(
    values["response-type"] ||
    config.graphrag?.default_response_type ||
    "multiple paragraphs",
  );
  const graphBookId = values["graph-book-id"] == null
    ? null
    : String(values["graph-book-id"]);
  const communityLevel = values["community-level"] == null
    ? undefined
    : parseInt(String(values["community-level"]), 10);
  if (
    communityLevel !== undefined &&
    (!Number.isInteger(communityLevel) || communityLevel <= 0)
  ) {
    throw new Error("--community-level must be a positive integer");
  }

  const answer = await routeQuery({
    schemaVersion: SchemaVersion,
    query,
    requestedRoute: "graphrag",
    method,
    maxCostClass: "medium",
    graphCoverageThreshold: 0,
  }, {
    searchQmd: async () => (await searchQmdForUnifiedRoute(
      query,
      opts,
      {
        quietDiagnostics: true,
        graphVault,
      },
    )).qmdResult,
    resolveGraphScopeCapabilities: async () => {
      const capabilities = await loadGraphQueryCapabilities({ graphVault });
      return graphBookId == null
        ? capabilities
        : capabilities.filter((capability) => capability.bookId === graphBookId);
    },
    resolveGraphCapabilities: async (candidates) =>
      resolveCandidateGraphCapabilities({ graphVault, candidates }),
    queryGraphRag: async (request, decision) => {
      if (decision.selectedBookIds.length !== 1) {
        throw new TypedQueryErrorException(createTypedQueryError({
          route: request.requestedRoute,
          stage: "route",
          provider: "graphrag",
          capability: "graph_query",
          code: "ambiguous_graph_book_scope",
          retryable: false,
          redactedMessage:
            "qmd query --graphrag requires --graph-book-id when multiple " +
            "graph-ready books match the request.",
          metadata: {
            selectedBookCount: decision.selectedBookIds.length,
          },
        }));
      }
      const runtime = createQmdGraphRagRuntime();
      return runtime.graphQuery({
        rootDir: graphVault,
        dataDir: pathResolve(graphVault, "books", decision.selectedBookIds[0]!, "output"),
        method: GraphRagSearchMethodSchema.parse(request.method ?? method),
        query: request.query,
        responseType,
        capabilityScope: {
          selectedBookIds: decision.selectedBookIds,
          graphCapabilityIds: decision.graphCapabilityIds,
          sourceIds: decision.selectedSourceIds,
          documentIds: decision.selectedDocumentIds,
          contentHashes: decision.selectedContentHashes,
          artifactIds: decision.graphArtifactIds,
        },
        communityLevel,
        verbose: false,
        environment: {
          pythonBin: values["python-bin"]
            ? pathResolve(getPwd(), String(values["python-bin"]))
            : config.graphrag?.python_bin
              ? pathResolve(getPwd(), config.graphrag.python_bin)
              : undefined,
          workingDirectory: getPwd(),
        },
      });
    },
  });

  outputUnifiedAnswer(answer, opts);
}

function createDspyPolicyStore(values: Record<string, unknown>): DspyPolicyStore {
  const config = ensureRuntimeConfigForCli();
  const graphVault = resolveGraphVaultForCli(values, config);
  return new DspyPolicyStore({ graphVault, actor: "qmd-cli" });
}

function printDspyJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function dspyFailurePolicyFromCli(values: Record<string, unknown>) {
  const strict = values["strict-refuse"] === true;
  return QueryExpansionFailurePolicySchema.parse({
    schemaVersion: SchemaVersion,
    defaultAction: strict ? "strict_refuse" : "fallback_to_builtin_expander",
    reasonActions: {},
    strictSchema: true,
  });
}

function printDspyArtifactResult(result: DspyArtifactWriteResult): void {
  printDspyJson({
    runId: result.run.runId,
    runPath: result.runPath,
    artifactId: result.artifact.artifactId,
    artifactPath: result.artifactPath,
  });
}

function optionalPositiveIntegerOption(
  name: string,
  value: unknown,
): number | undefined {
  return value == null ? undefined : parsePositiveIntegerOption(name, value);
}

function resolveDspyMetricSpec(
  store: DspyPolicyStore,
  metricVersion: string | undefined,
) {
  return metricVersion ? store.loadMetricSpec(metricVersion) : null;
}

function resolveDspyDatasetForCli(
  store: DspyPolicyStore,
  datasetId: string | undefined,
) {
  return datasetId ? store.loadEvaluationDataset(datasetId) : null;
}

function resolveDspyDatasetSourcePath(
  store: DspyPolicyStore,
  relativePath: string | undefined,
): string | undefined {
  return relativePath ? store.resolvePath(relativePath) : undefined;
}

async function dspyRegisterMetricSpec(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const metricVersion = String(values.metric || args[1] || "");
  if (!metricVersion) {
    throw new Error("Usage: qmd dspy register-metric-spec --metric <version>");
  }
  const store = createDspyPolicyStore(values);
  const result = store.writeMetricSpec({
    metricVersion,
    name: values.name ? String(values.name) : metricVersion,
    description: String(values.description || "DSPy query expansion metric"),
    maxMetricCalls: values["max-metric-calls"] == null
      ? undefined
      : parsePositiveIntegerOption("maxMetricCalls", values["max-metric-calls"]),
    maxTotalTokens: values["max-total-tokens"] == null
      ? undefined
      : parsePositiveIntegerOption("maxTotalTokens", values["max-total-tokens"]),
    maxExpansionItems: values["max-expansion-items"] == null
      ? undefined
      : parsePositiveIntegerOption(
        "maxExpansionItems",
        values["max-expansion-items"],
      ),
  });
  printDspyJson({
    metricPath: result.path,
    metric: DspyMetricSpecSchema.parse(result.value),
  });
}

async function dspyRegisterEvaluationDataset(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const datasetId = String(values.dataset || args[1] || "");
  if (!datasetId) {
    throw new Error(
      "Usage: qmd dspy register-evaluation-dataset --dataset <id>",
    );
  }
  if (
    values["dataset-path"] == null &&
    values.trainset == null &&
    values.valset == null &&
    values.testset == null
  ) {
    throw new Error(
      "register-evaluation-dataset requires --dataset-path, --trainset, --valset, or --testset",
    );
  }
  const store = createDspyPolicyStore(values);
  const result = store.writeEvaluationDataset({
    datasetId,
    datasetPath: values["dataset-path"]
      ? pathResolve(getPwd(), String(values["dataset-path"]))
      : undefined,
    trainsetPath: values.trainset
      ? pathResolve(getPwd(), String(values.trainset))
      : undefined,
    valsetPath: values.valset
      ? pathResolve(getPwd(), String(values.valset))
      : undefined,
    testsetPath: values.testset
      ? pathResolve(getPwd(), String(values.testset))
      : undefined,
  });
  printDspyJson({
    datasetPath: result.path,
    dataset: DspyEvaluationDatasetSchema.parse(result.value),
  });
}

async function dspyOptimizeQueryPrompt(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const config = ensureRuntimeConfigForCli();
  const graphVault = resolveGraphVaultForCli(values, config);
  const store = new DspyPolicyStore({ graphVault, actor: "qmd-cli" });
  const dataset = resolveDspyDatasetForCli(
    store,
    values.dataset ? String(values.dataset) : undefined,
  );
  const metricVersion = values.metric
    ? String(values.metric)
    : "dspy-query-expansion-schema-v1";
  const metricSpec = resolveDspyMetricSpec(store, metricVersion);
  const trainsetPath = String(
    values.trainset ||
    resolveDspyDatasetSourcePath(store, dataset?.trainsetPath) ||
    args[1] ||
    "",
  );
  if (!trainsetPath) {
    throw new Error(
      "Usage: qmd dspy optimize-query-prompt --trainset <jsonl> or --dataset <id>",
    );
  }
  const runId = createRunId("dspy-cli");
  const artifactDir = pathJoin(graphVault, "dspy", "runs", runId);
  mkdirSync(artifactDir, { recursive: true });
  const savePromptPath = values["save-prompt"]
    ? pathResolve(getPwd(), String(values["save-prompt"]))
    : pathJoin(artifactDir, "prompt.txt");
  const emitPath = values.emit
    ? pathResolve(getPwd(), String(values.emit))
    : pathJoin(artifactDir, "generated.jsonl");
  const model = String(values.model || config.models?.generate || "openai/gpt-5.4");
  const provider = openAIResponsesProviderConfigForCli(config, model);
  const runtime = createQmdGraphRagRuntime();
  const response = await runtime.optimizeQueryPrompt({
    optimizer: "gepa",
    trainsetPath: pathResolve(getPwd(), trainsetPath),
    valsetPath: values.valset
      ? pathResolve(getPwd(), String(values.valset))
      : dataset?.valsetPath
        ? store.resolvePath(dataset.valsetPath)
      : undefined,
    model,
    reflectionModel: values["reflection-model"]
      ? String(values["reflection-model"])
      : undefined,
    auto: values.auto
      ? (String(values.auto) as "light" | "medium" | "heavy")
      : "light",
    maxMetricCalls: parsePositiveIntegerOption(
      "maxMetricCalls",
      values["max-metric-calls"] ?? metricSpec?.maxMetricCalls,
    ),
    limit: parsePositiveIntegerOption("limit", values.limit),
    valLimit: parsePositiveIntegerOption("valLimit", values["val-limit"]),
    savePromptPath,
    emitPath,
    provider,
    environment: {
      pythonBin: values["python-bin"]
        ? pathResolve(getPwd(), String(values["python-bin"]))
        : config.graphrag?.python_bin
          ? pathResolve(getPwd(), config.graphrag.python_bin)
          : undefined,
      workingDirectory: getPwd(),
    },
  });
  const result = store.writeOptimizationArtifact({
    request: {
      optimizer: "gepa",
      trainsetPath: pathResolve(getPwd(), trainsetPath),
      valsetPath: values.valset
        ? pathResolve(getPwd(), String(values.valset))
        : dataset?.valsetPath
          ? store.resolvePath(dataset.valsetPath)
        : undefined,
      model,
      reflectionModel: values["reflection-model"]
        ? String(values["reflection-model"])
        : undefined,
      auto: values.auto
        ? (String(values.auto) as "light" | "medium" | "heavy")
        : "light",
      maxMetricCalls: parsePositiveIntegerOption(
        "maxMetricCalls",
        values["max-metric-calls"] ?? metricSpec?.maxMetricCalls,
      ),
      limit: parsePositiveIntegerOption("limit", values.limit),
      valLimit: parsePositiveIntegerOption("valLimit", values["val-limit"]),
      savePromptPath,
      emitPath,
      provider,
    },
    response,
    runId,
    fingerprints: buildDspyRuntimeFingerprints(config, {
      generateModel: DEFAULT_QUERY_MODEL,
      embedModel: DEFAULT_EMBED_MODEL,
      rerankModel: DEFAULT_RERANK_MODEL,
    }),
    providerEnvRefs: dspyProviderEnvRefs(config),
    metricVersion,
    metricSpec: metricSpec ?? undefined,
    maxExpansionItems: values["max-expansion-items"]
      ? parsePositiveIntegerOption("maxExpansionItems", values["max-expansion-items"])
      : metricSpec?.maxExpansionItems,
  });
  printDspyArtifactResult(result);
}

async function dspyEvaluateExpansionPolicy(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const artifactPath = String(values.artifact || args[1] || "");
  if (!artifactPath) {
    throw new Error("Usage: qmd dspy evaluate-expansion-policy --artifact <path>");
  }
  const store = createDspyPolicyStore(values);
  const report = store.evaluateExpansionPolicy({
    artifactPath,
    datasetId: values.dataset ? String(values.dataset) : undefined,
    metricVersion: values.metric ? String(values.metric) : undefined,
  });
  printDspyJson(DspyEvaluationReportSchema.parse(report));
}

async function dspyPromoteExpansionPolicy(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const artifactPath = String(values.artifact || args[1] || "");
  const reportPath = String(values.report || args[2] || "");
  if (!artifactPath || !reportPath) {
    throw new Error(
      "Usage: qmd dspy promote-expansion-policy --artifact <path> --report <path>",
    );
  }
  const store = createDspyPolicyStore(values);
  const previousPointer = store.loadPointer();
  const decision = store.promoteExpansionPolicy({
    artifactPath,
    reportPath,
    reason: String(values.reason || "operator promotion"),
    failurePolicy: dspyFailurePolicyFromCli(values),
  });
  try {
    updateQueryExpansionPolicyConfig({
      provider: "dspy",
      graphVault: store.graphVault,
      policyRef: graphVaultPolicyRef(store.graphVault, store),
      failurePolicy: values["strict-refuse"] === true
        ? "strict_refuse"
        : "fallback_to_builtin_expander",
    });
  } catch (error) {
    store.restorePointerForCliFailure(previousPointer, "config write failed");
    throw error;
  }
  printDspyJson(DspyPromotionDecisionSchema.parse(decision));
}

async function dspyDisableExpansionPolicy(
  _args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const store = createDspyPolicyStore(values);
  const previousPointer = store.loadPointer();
  const pointer = store.disableExpansionPolicy(String(values.reason || "disabled"));
  try {
    updateQueryExpansionPolicyConfig({
      provider: "builtin",
      failurePolicy: "fallback_to_builtin_expander",
    });
  } catch (error) {
    store.restorePointerForCliFailure(previousPointer, "config write failed");
    throw error;
  }
  printDspyJson(pointer);
}

async function dspyRollbackExpansionPolicy(
  _args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const store = createDspyPolicyStore(values);
  const previousPointer = store.loadPointer();
  const pointer = store.rollbackExpansionPolicy();
  try {
    updateQueryExpansionPolicyConfig({
      provider: pointer.provider === "dspy" && pointer.active ? "dspy" : "builtin",
      graphVault: store.graphVault,
      policyRef: graphVaultPolicyRef(store.graphVault, store),
      failurePolicy: pointer.failurePolicy.defaultAction,
    });
  } catch (error) {
    store.restorePointerForCliFailure(previousPointer, "config write failed");
    throw error;
  }
  printDspyJson(pointer);
}

async function dspyImportExpansionRecords(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const recordsPath = String(values.records || args[1] || "");
  if (!recordsPath) {
    throw new Error("Usage: qmd dspy import-expansion-records --records <jsonl>");
  }
  const records = readFileSync(pathResolve(getPwd(), recordsPath), "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => DspyGeneratedExpansionRecordSchema.parse(JSON.parse(line)));
  const config = ensureRuntimeConfigForCli();
  const store = createDspyPolicyStore(values);
  const result = store.writeSyntheticArtifact({
    records,
    fingerprints: buildDspyRuntimeFingerprints(config, {
      generateModel: DEFAULT_QUERY_MODEL,
      embedModel: DEFAULT_EMBED_MODEL,
      rerankModel: DEFAULT_RERANK_MODEL,
    }),
    providerEnvRefs: dspyProviderEnvRefs(config),
    reason: String(values.reason || "imported expansion records"),
  });
  printDspyArtifactResult(result);
}

async function dspyCommand(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  const subcommand = args[0];
  switch (subcommand) {
    case "optimize-query-prompt":
      await dspyOptimizeQueryPrompt(args, values);
      break;
    case "evaluate-expansion-policy":
      await dspyEvaluateExpansionPolicy(args, values);
      break;
    case "promote-expansion-policy":
      await dspyPromoteExpansionPolicy(args, values);
      break;
    case "rollback-expansion-policy":
      await dspyRollbackExpansionPolicy(args, values);
      break;
    case "disable-expansion-policy":
      await dspyDisableExpansionPolicy(args, values);
      break;
    case "import-expansion-records":
      await dspyImportExpansionRecords(args, values);
      break;
    case "register-metric-spec":
      await dspyRegisterMetricSpec(args, values);
      break;
    case "register-evaluation-dataset":
      await dspyRegisterEvaluationDataset(args, values);
      break;
    case "status": {
      const store = createDspyPolicyStore(values);
      const pointer = store.loadPointer();
      printDspyJson({ pointerPath: store.pointerRelativePath(), pointer });
      break;
    }
    default:
      console.error("Usage: qmd dspy <command> [options]");
      console.error("");
      console.error("Commands:");
      console.error("  optimize-query-prompt       Run offline DSPy GEPA optimization");
      console.error("  evaluate-expansion-policy   Validate a DSPy artifact before promotion");
      console.error("  promote-expansion-policy    Promote an evaluated artifact into qmd query");
      console.error("  rollback-expansion-policy   Restore the previous promoted pointer");
      console.error("  disable-expansion-policy    Disable DSPy online expansion");
      console.error("  import-expansion-records    Import typed generated expansion records");
      console.error("  register-metric-spec        Register a typed metric spec in graph_vault");
      console.error("  register-evaluation-dataset Register a typed evaluation dataset in graph_vault");
      console.error("  status                      Show the current DSPy pointer");
      process.exit(1);
  }
}

// Parse CLI arguments using util.parseArgs
function parseCLI() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2), // Skip node and script path
    options: {
      // Global options
      index: {
        type: "string",
      },
      context: {
        type: "string",
      },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      skill: { type: "boolean" },
      global: { type: "boolean" },
      yes: { type: "boolean" },
      // Search options
      n: { type: "string" },
      "min-score": { type: "string" },
      all: { type: "boolean" },
      full: { type: "boolean" },
      csv: { type: "boolean" },
      md: { type: "boolean" },
      xml: { type: "boolean" },
      files: { type: "boolean" },
      json: { type: "boolean" },
      explain: { type: "boolean" },
      collection: { type: "string", short: "c", multiple: true },  // Filter by collection(s)
      // Collection options
      name: { type: "string" },  // collection name
      mask: { type: "string" },  // glob pattern
      // Embed options
      force: { type: "boolean", short: "f" },
      "max-docs-per-batch": { type: "string" },
      "max-batch-mb": { type: "string" },
      // Update options
      pull: { type: "boolean" },  // git pull before update
      refresh: { type: "boolean" },
      // Get options
      l: { type: "string" },  // max lines
      from: { type: "string" },  // start line
      "max-bytes": { type: "string" },  // max bytes for multi-get
      "line-numbers": { type: "boolean" },  // add line numbers to output
      // Query options
      "candidate-limit": { type: "string", short: "C" },
      "no-rerank": { type: "boolean", default: false },
      "no-gpu": { type: "boolean", default: false },
      graphrag: { type: "boolean", default: false },
      "graph-vault": { type: "string" },
      "graph-book-id": { type: "string" },
      mode: { type: "string" },
      "query-method": { type: "string" },
      "response-type": { type: "string" },
      "community-level": { type: "string" },
      "python-bin": { type: "string" },
      intent: { type: "string" },
      trainset: { type: "string" },
      valset: { type: "string" },
      dataset: { type: "string" },
      "dataset-path": { type: "string" },
      testset: { type: "string" },
      artifact: { type: "string" },
      report: { type: "string" },
      records: { type: "string" },
      metric: { type: "string" },
      description: { type: "string" },
      model: { type: "string" },
      "reflection-model": { type: "string" },
      auto: { type: "string" },
      "max-metric-calls": { type: "string" },
      "max-total-tokens": { type: "string" },
      limit: { type: "string" },
      "val-limit": { type: "string" },
      "max-expansion-items": { type: "string" },
      emit: { type: "string" },
      "save-prompt": { type: "string" },
      reason: { type: "string" },
      "strict-refuse": { type: "boolean" },
      // Chunking options
      "chunk-strategy": { type: "string" },  // "regex" (default) or "auto" (AST for code files)
      // MCP HTTP transport options
      http: { type: "boolean" },
      daemon: { type: "boolean" },
      port: { type: "string" },
    },
    allowPositionals: true,
    strict: false, // Allow unknown options to pass through
  });

  if (values["no-gpu"]) {
    process.env.QMD_FORCE_CPU = "1";
  }

  // Select index name (default: "index"). If no explicit --index is supplied,
  // a project-local .qmd/index.yaml overrides the global config/cache paths.
  const indexName = values.index as string | undefined;
  if (indexName) {
    setIndexName(indexName);
    setConfigIndexName(indexName);
    setConfigSource();
  } else {
    const localConfigPath = findLocalConfigPath();
    if (localConfigPath) {
      setConfigSource({ configPath: localConfigPath });
      storeDbPathOverride = getLocalDbPath(localConfigPath);
      closeDb();
    } else {
      setConfigSource();
    }
  }

  // Determine output format
  let format: OutputFormat = "cli";
  if (values.csv) format = "csv";
  else if (values.md) format = "md";
  else if (values.xml) format = "xml";
  else if (values.files) format = "files";
  else if (values.json) format = "json";

  // Default limit: 20 for --files/--json, 5 otherwise
  // --all means return all results (use very large limit)
  const defaultLimit = (format === "files" || format === "json") ? 20 : 5;
  const isAll = !!values.all;

  const opts: OutputOptions = {
    format,
    full: !!values.full,
    limit: isAll ? 100000 : (values.n ? parseInt(String(values.n), 10) || defaultLimit : defaultLimit),
    minScore: values["min-score"] ? parseFloat(String(values["min-score"])) || 0 : 0,
    all: isAll,
    collection: values.collection as string[] | undefined,
    lineNumbers: !!values["line-numbers"],
    candidateLimit: values["candidate-limit"] ? parseInt(String(values["candidate-limit"]), 10) : undefined,
    skipRerank: !!values["no-rerank"],
    explain: !!values.explain,
    intent: values.intent as string | undefined,
    chunkStrategy: parseChunkStrategy(values["chunk-strategy"]),
  };

  return {
    command: positionals[0] || "",
    args: positionals.slice(1),
    query: positionals.slice(1).join(" "),
    opts,
    values,
  };
}

function getSkillInstallDir(globalInstall: boolean): string {
  return globalInstall
    ? resolve(homedir(), ".agents", "skills", "qmd")
    : resolve(getPwd(), ".agents", "skills", "qmd");
}

function getClaudeSkillLinkPath(globalInstall: boolean): string {
  return globalInstall
    ? resolve(homedir(), ".claude", "skills", "qmd")
    : resolve(getPwd(), ".claude", "skills", "qmd");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function removePath(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmSync(path, { recursive: true, force: true });
  } else {
    unlinkSync(path);
  }
}

type SkillInfo = {
  name: string;
  description: string;
  dir: string;
  hidden: boolean;
};

const SKILL_DIR = "skills";

function findPackageRoot(): string | null {
  if (process.env.QMD_SKILLS_DIR) {
    return null;
  }

  const start = dirname(fileURLToPath(import.meta.url));
  let current = start;
  while (true) {
    if (existsSync(resolve(current, SKILL_DIR))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function getSkillSearchDirs(_runtimeOnly = false): string[] {
  if (process.env.QMD_SKILLS_DIR) {
    return [process.env.QMD_SKILLS_DIR];
  }

  const root = findPackageRoot();
  if (!root) return [];

  const dir = resolve(root, SKILL_DIR);
  return existsSync(dir) ? [dir] : [];
}

function parseSkillFrontmatter(content: string): { name: string; description: string; hidden: boolean } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const end = trimmed.slice(3).indexOf("\n---");
  if (end < 0) return null;

  const frontmatter = trimmed.slice(3, 3 + end);
  let name = "";
  let description = "";
  let hidden = false;
  const lines = frontmatter.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("name:")) {
      name = line.slice("name:".length).trim();
    } else if (line.startsWith("description:")) {
      const parts = [line.slice("description:".length).trim()];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) {
        i++;
        parts.push(lines[i]!.trim());
      }
      description = parts.join(" ");
    } else if (line.startsWith("hidden:")) {
      const value = line.slice("hidden:".length).trim().toLowerCase();
      hidden = value === "true" || value === "yes";
    }
  }

  if (!name) return null;
  return { name, description, hidden };
}

function discoverSkills(runtimeOnly = false): SkillInfo[] {
  const skills: SkillInfo[] = [];
  for (const dir of getSkillSearchDirs(runtimeOnly)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillDir = resolve(dir, entry);
      const skillPath = resolve(skillDir, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      let content = "";
      try {
        content = readFileSync(skillPath, "utf-8");
      } catch {
        continue;
      }
      const parsed = parseSkillFrontmatter(content);
      if (!parsed) continue;
      skills.push({ ...parsed, dir: skillDir });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function findSkill(name: string, runtimeOnly = false): SkillInfo | null {
  return discoverSkills(runtimeOnly).find((skill) => skill.name === name) ?? null;
}

function readSkillContent(skill: SkillInfo): string {
  return readFileSync(resolve(skill.dir, "SKILL.md"), "utf-8");
}

function collectSkillFiles(skill: SkillInfo): { relativePath: string; content: string }[] {
  const files: { relativePath: string; content: string }[] = [];
  for (const subdirName of ["references", "templates", "scripts"]) {
    const subdir = resolve(skill.dir, subdirName);
    if (!existsSync(subdir)) continue;
    for (const entry of readdirSync(subdir).sort()) {
      const filePath = resolve(subdir, entry);
      try {
        if (!statSync(filePath).isFile()) continue;
        files.push({ relativePath: `${subdirName}/${basename(filePath)}`, content: readFileSync(filePath, "utf-8") });
      } catch {
        // Ignore unreadable supplementary files.
      }
    }
  }
  return files;
}

function showSkill(): void {
  const skill = findSkill("qmd");
  if (!skill) {
    throw new Error("QMD skill not found. Reinstall qmd or set QMD_SKILLS_DIR.");
  }
  console.log("QMD Skill");
  console.log("");
  const content = readSkillContent(skill);
  process.stdout.write(content.endsWith("\n") ? content : content + "\n");
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = resolve(sourceDir, entry);
    const targetPath = resolve(targetDir, entry);
    const stat = statSync(sourcePath);
    if (stat.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
    } else if (stat.isFile()) {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

function installedSkillStubContent(): string {
  return `---
name: qmd
description: Bootstrap QMD search instructions from the installed qmd CLI. Use when users ask to find notes, retrieve documents, inspect a wiki, or answer from indexed local markdown.
license: MIT
compatibility: Requires qmd CLI. Run \`qmd skill show\` for version-matched instructions.
allowed-tools: Bash(qmd:*), mcp__qmd__*
---

# QMD - Query Markdown Documents

This installed skill is intentionally a small bootstrap so it does not go stale
when the qmd package updates.

Load the full, version-matched QMD instructions from the CLI:

!\`qmd skill show\`

If your agent does not support bang-command expansion, run:

\`\`\`bash
qmd skill show
\`\`\`

Then follow those instructions. In short: search first, fetch full sources with
\`qmd get\` or \`qmd multi-get\`, and answer from retrieved text rather than snippets.
`;
}

function writeSkillInstall(targetDir: string, force: boolean): void {
  if (pathExists(targetDir)) {
    if (!force) {
      throw new Error(`Skill already exists: ${targetDir} (use --force to replace it)`);
    }
    removePath(targetDir);
  }

  const skill = findSkill("qmd");
  if (!skill) {
    throw new Error("QMD skill not found. Reinstall qmd or set QMD_SKILLS_DIR.");
  }

  copyDirectoryContents(skill.dir, targetDir);
  writeFileSync(resolve(targetDir, "SKILL.md"), installedSkillStubContent(), "utf-8");
}

function outputSkillsJson(payload: unknown): void {
  console.log(JSON.stringify(payload));
}

function runSkillsCommand(args: string[], jsonMode: boolean, fullOption = false, allOption = false): void {
  const subcommand = args[0] ?? "list";
  const runtimeSkills = () => discoverSkills(true).filter((skill) => !skill.hidden);

  switch (subcommand) {
    case "list": {
      const skills = runtimeSkills();
      if (jsonMode) {
        outputSkillsJson({ success: true, data: skills.map(({ name, description }) => ({ name, description })) });
        return;
      }
      if (skills.length === 0) {
        console.log("No skills found");
        return;
      }
      const maxName = Math.max(...skills.map((skill) => skill.name.length));
      for (const skill of skills) {
        console.log(`  ${skill.name.padEnd(maxName)}  ${skill.description}`);
      }
      return;
    }

    case "get": {
      const full = fullOption || args.includes("--full");
      const getAll = allOption || args.includes("--all");
      const names = args.slice(1).filter((arg) => arg !== "--full" && arg !== "--all");
      const targets = getAll ? runtimeSkills() : names.map((name) => {
        const skill = findSkill(name, true);
        if (!skill) {
          throw new Error(`Skill not found: ${name}`);
        }
        return skill;
      });

      if (targets.length === 0) {
        throw new Error("No skill name provided. Usage: qmd skills get <name>");
      }

      if (jsonMode) {
        outputSkillsJson({
          success: true,
          data: targets.map((skill) => ({
            name: skill.name,
            content: readSkillContent(skill),
            ...(full ? { files: collectSkillFiles(skill).map((file) => ({ path: file.relativePath, content: file.content })) } : {}),
          })),
        });
        return;
      }

      targets.forEach((skill, index) => {
        if (index > 0) console.log("\n---\n");
        const content = readSkillContent(skill);
        process.stdout.write(content.endsWith("\n") ? content : content + "\n");
        if (full) {
          for (const file of collectSkillFiles(skill)) {
            console.log(`\n--- ${file.relativePath} ---\n`);
            process.stdout.write(file.content.endsWith("\n") ? file.content : file.content + "\n");
          }
        }
      });
      return;
    }

    case "path": {
      const name = args[1];
      if (!name) {
        const paths = getSkillSearchDirs(true);
        if (jsonMode) outputSkillsJson({ success: true, data: { paths } });
        else paths.forEach((path) => console.log(path));
        return;
      }
      const skill = findSkill(name, true);
      if (!skill) {
        throw new Error(`Skill not found: ${name}`);
      }
      if (jsonMode) outputSkillsJson({ success: true, data: { name: skill.name, path: skill.dir } });
      else console.log(skill.dir);
      return;
    }

    case "help": {
      showSkillsHelp();
      return;
    }

    default:
      throw new Error(`Unknown skills subcommand: ${subcommand}`);
  }
}

function showSkillsHelp(): void {
  console.log("Usage: qmd skills <list|get|path> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  list                 List bundled runtime skills");
  console.log("  get <name>           Print a bundled runtime skill");
  console.log("  get <name> --full    Include references/templates/scripts");
  console.log("  get --all            Print all bundled runtime skills");
  console.log("  path [name]          Print runtime skill directory path(s)");
  console.log("");
  console.log("Options:");
  console.log("  --json               Print structured JSON");
}

function ensureClaudeSymlink(linkPath: string, targetDir: string, force: boolean): boolean {
  const parentDir = dirname(linkPath);
  if (pathExists(parentDir)) {
    const resolvedTargetDir = realpathSync(dirname(targetDir));
    const resolvedLinkParent = realpathSync(parentDir);

    // If .claude/skills already resolves to the same directory as .agents/skills,
    // the skill is already visible to Claude and creating qmd -> qmd would loop.
    if (resolvedTargetDir === resolvedLinkParent) {
      return false;
    }
  }

  const linkTarget = relativePath(parentDir, targetDir) || ".";

  mkdirSync(parentDir, { recursive: true });

  if (pathExists(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() && readlinkSync(linkPath) === linkTarget) {
      return true;
    }
    if (!force) {
      throw new Error(`Claude skill path already exists: ${linkPath} (use --force to replace it)`);
    }
    removePath(linkPath);
  }

  symlinkSync(linkTarget, linkPath, "dir");
  return true;
}

async function shouldCreateClaudeSymlink(linkPath: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`Tip: create a Claude symlink manually at ${linkPath}`);
    return false;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`Create a symlink in ${linkPath}? [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

async function installSkill(globalInstall: boolean, force: boolean, autoYes: boolean): Promise<void> {
  const installDir = getSkillInstallDir(globalInstall);
  writeSkillInstall(installDir, force);
  console.log(`✓ Installed QMD skill to ${installDir}`);

  const claudeLinkPath = getClaudeSkillLinkPath(globalInstall);
  if (!(await shouldCreateClaudeSymlink(claudeLinkPath, autoYes))) {
    return;
  }

  const linked = ensureClaudeSymlink(claudeLinkPath, installDir, force);
  if (linked) {
    console.log(`✓ Linked Claude skill at ${claudeLinkPath}`);
  } else {
    console.log(`✓ Claude already sees the skill via ${dirname(claudeLinkPath)}`);
  }
}

function showHelp(): void {
  console.log("qmd — Quick Markdown Search");
  console.log("");
  console.log("Usage:");
  console.log("  qmd <command> [options]");
  console.log("");
  console.log("Primary commands:");
  console.log("  qmd query <query>             - Whole-corpus qmd search with expansion + reranking");
  console.log("  qmd query --graphrag <query>  - Graph-enhanced qmd query for graph-ready sources");
  console.log("  qmd dspy <command>            - Offline DSPy query expansion policy lifecycle");
  console.log("  qmd query 'lex:..\\nvec:...'   - Structured query document (you provide lex/vec/hyde lines)");
  console.log("  qmd search <query>            - Full-text BM25 keywords (no LLM)");
  console.log("  qmd vsearch <query>           - Vector similarity only");
  console.log("  qmd get <file>[:line] [-l N]  - Show a single document, optional line slice");
  console.log("  qmd multi-get <pattern>       - Batch fetch via glob or comma-separated list");
  console.log("  qmd skills list/get/path      - List and retrieve bundled runtime skills");
  console.log("  qmd skill show/install        - Show or install the QMD skill");
  console.log("  qmd mcp                       - Start the MCP server (stdio transport for AI agents)");
  console.log("  qmd bench <fixture.json>      - Run search quality benchmarks against a fixture file");
  console.log("");
  console.log("Collections & context:");
  console.log("  qmd collection add/list/remove/rename/show   - Manage indexed folders");
  console.log("  qmd context add/list/rm                      - Attach human-written summaries");
  console.log("  qmd ls [collection[/path]]                   - Inspect indexed files");
  console.log("");
  console.log("Maintenance:");
  console.log("  qmd init                      - Create a project-local .qmd index");
  console.log("  qmd status                    - View index + collection health");
  console.log("  qmd update [--pull]           - Re-index collections (optionally git pull first)");
  console.log("  qmd embed [-f] [-c <name>]    - Generate/refresh vector embeddings");
  console.log("    --max-docs-per-batch <n>    - Cap docs loaded into memory per embedding batch");
  console.log("    --max-batch-mb <n>          - Cap UTF-8 MB loaded into memory per embedding batch");
  console.log("  qmd cleanup                   - Clear caches, vacuum DB");
  console.log("");
  console.log("DSPy offline lifecycle:");
  console.log("  qmd dspy optimize-query-prompt --trainset <jsonl>");
  console.log("  qmd dspy evaluate-expansion-policy --artifact <path>");
  console.log("  qmd dspy promote-expansion-policy --artifact <path> --report <path>");
  console.log("  qmd dspy rollback-expansion-policy");
  console.log("  qmd dspy disable-expansion-policy");
  console.log("  qmd dspy register-metric-spec --metric <version>");
  console.log("  qmd dspy register-evaluation-dataset --dataset <id> --trainset <jsonl>");
  console.log("");
  console.log("Query syntax (qmd query):");
  console.log("  QMD queries are either a single expand query (no prefix) or a multi-line");
  console.log("  document where every line is typed with lex:, vec:, or hyde:. This grammar");
  console.log("  matches the docs in docs/SYNTAX.md and is enforced in the CLI.");
  console.log("");
  const grammar = [
    `query          = expand_query | query_document ;`,
    `expand_query   = text | explicit_expand ;`,
    `explicit_expand= "expand:" text ;`,
    `query_document = [ intent_line ] { typed_line } ;`,
    `intent_line    = "intent:" text newline ;`,
    `typed_line     = type ":" text newline ;`,
    `type           = "lex" | "vec" | "hyde" ;`,
    `text           = quoted_phrase | plain_text ;`,
    `quoted_phrase  = '"' { character } '"' ;`,
    `plain_text     = { character } ;`,
    `newline        = "\\n" ;`,
  ];
  console.log("  Grammar:");
  for (const line of grammar) {
    console.log(`    ${line}`);
  }
  console.log("");
  console.log("  Examples:");
  console.log("    qmd query \"how does auth work\"                # single-line → implicit expand");
  console.log("    qmd query $'lex: CAP theorem\\nvec: consistency'  # typed query document");
  console.log("    qmd query $'lex: \"exact matches\" sports -baseball'  # phrase + negation lex search");
  console.log("    qmd query $'hyde: Hypothetical answer text'       # hyde-only document");
  console.log("");
  console.log("  Constraints:");
  console.log("    - Standalone expand queries cannot mix with typed lines.");
  console.log("    - Query documents allow only lex:, vec:, or hyde: prefixes.");
  console.log("    - Each typed line must be single-line text with balanced quotes.");
  console.log("");
  console.log("AI agents & integrations:");
  console.log("  - Run `qmd mcp` to expose the MCP server (stdio) to agents/IDEs.");
  console.log("  - Run `qmd skills get qmd --full` for version-matched agent instructions.");
  console.log("  - `qmd skill install` installs the QMD skill into ./.agents/skills/qmd.");
  console.log("  - Use `qmd skill install --global` for ~/.agents/skills/qmd.");
  console.log("  - `qmd --skill` is kept as an alias for `qmd skill show`.");
  console.log("  - Advanced: `qmd mcp --http ...` and `qmd mcp --http --daemon` are optional for custom transports.");
  console.log("");
  console.log("Global options:");
  console.log("  --index <name>             - Use a named index (default: index)");
  console.log("  QMD_EDITOR_URI             - Editor link template for clickable TTY search output");
  console.log("");
  console.log("Search options:");
  console.log("  -n <num>                   - Max results (default 5, or 20 for --files/--json)");
  console.log("  --all                      - Return all matches (pair with --min-score)");
  console.log("  --min-score <num>          - Minimum similarity score");
  console.log("  --full                     - Output full document instead of snippet");
  console.log("  -C, --candidate-limit <n>  - Max candidates to rerank (default 40, lower = faster)");
  console.log("  --no-rerank                - Skip LLM reranking (use RRF scores only, much faster on CPU)");
  console.log("  --no-gpu                   - Force CPU mode for llama.cpp operations (same as QMD_FORCE_CPU=1)");
  console.log("  --line-numbers             - Include line numbers in output");
  console.log("  --explain                  - Include retrieval score traces (query --json/CLI)");
  console.log("  --files | --json | --csv | --md | --xml  - Output format");
  console.log("  -c, --collection <name>    - Filter by one or more collections");
  console.log("");
  console.log("Embed/query options:");
  console.log("  --chunk-strategy <auto|regex> - Chunking mode (default: regex; auto uses AST for code files)");
  console.log("  --mode <qmd|auto>             - Query route selector (default qmd)");
  console.log("  --graphrag                    - Use qmd graph-enhanced query over graph_vault");
  console.log("  --graph-vault <path>          - GraphRAG vault root (default ./graph_vault)");
  console.log("  --graph-book-id <bookId>      - Restrict GraphRAG query to one graph-ready book");
  console.log("  --query-method <method>       - GraphRAG method: local, global, drift, or basic");
  console.log("  --response-type <text>        - GraphRAG response type (default multiple paragraphs)");
  console.log("  --community-level <n>         - GraphRAG community level override");
  console.log("  --python-bin <path>           - Python executable for GraphRAG bridge");
  console.log("");
  console.log("Multi-get options:");
  console.log("  -l <num>                   - Maximum lines per file");
  console.log("  --max-bytes <num>          - Skip files larger than N bytes (default 10240)");
  console.log("  --json/--csv/--md/--xml/--files - Same formats as search");
  console.log("");
  console.log(`Index: ${getDbPath()}`);
}

type DoctorCheckRecord = {
  label: string;
  ok: boolean;
  details: string;
};

type DoctorEnvironmentOverrideRecord = {
  name: string;
  value: "[redacted]";
  valueRedacted: true;
  consequence: string;
};

type DoctorCapture = {
  checks: DoctorCheckRecord[];
  environmentOverrides: DoctorEnvironmentOverrideRecord[];
};

let activeDoctorCapture: DoctorCapture | null = null;

function doctorCheck(label: string, ok: boolean, details: string): void {
  activeDoctorCapture?.checks.push({ label, ok, details });
  if (activeDoctorCapture) return;

  const mark = ok ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
  console.log(`${mark} ${label}: ${details}`);
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function shortModelName(model: string): string {
  if (model.startsWith("hf:")) {
    return model.split("/").pop() || model;
  }
  return model.length > 56 ? `${model.slice(0, 53)}...` : model;
}

function normalizedDoctorNextSteps(steps: string[]): string[] {
  const unique = Array.from(new Set(steps));
  const hasForceEmbed = unique.some(step => step.includes("qmd embed --force"));
  if (!hasForceEmbed) return unique;
  return unique.filter(step => !step.includes("qmd embed") || step.startsWith("Run `qmd embed --force`"));
}

function shortHashSeq(hashSeq: string): string {
  const idx = hashSeq.lastIndexOf("_");
  if (idx < 0) return hashSeq.length > 18 ? `${hashSeq.slice(0, 18)}...` : hashSeq;
  return `${hashSeq.slice(0, 12)}_${hashSeq.slice(idx + 1)}`;
}

type DoctorVectorSampleResult = {
  ok: boolean;
  details: string;
};

function decodeStoredEmbedding(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function cosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return Number.POSITIVE_INFINITY;
  return 1 - (dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

type CachedModelInspection = {
  path: string | null;
  invalid: string[];
};

function formatModelDiagnosticPath(path: string): string {
  return sanitizeDiagnosticMessage(path);
}

function formatConfigDiagnosticPath(path: string): string {
  const name = basename(path);
  return name || "index.yml";
}

function findCachedModelInspection(model: string): CachedModelInspection {
  const invalid: string[] = [];
  if (
    isJinaEmbeddingModel(model) ||
    isJinaRerankModel(model) ||
    isOpenAIResponsesModel(model)
  ) {
    return { path: model, invalid };
  }
  if (model.startsWith("hf:")) {
    const filename = model.split("/").pop();
    if (!filename || !existsSync(DEFAULT_MODEL_CACHE_DIR)) return { path: null, invalid };
    const entries = readdirSync(DEFAULT_MODEL_CACHE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.includes(filename)) continue;
      const candidate = pathJoin(DEFAULT_MODEL_CACHE_DIR, entry.name);
      const inspection = inspectGgufFile(candidate);
      if (inspection.valid) return { path: candidate, invalid };
      invalid.push(`${formatModelDiagnosticPath(candidate)}: ${inspection.details}`);
    }
    return { path: null, invalid };
  }

  const inspection = inspectGgufFile(model);
  if (inspection.valid) return { path: model, invalid };
  if (inspection.exists) invalid.push(`${formatModelDiagnosticPath(model)}: ${inspection.details}`);
  return { path: null, invalid };
}

type EnvOverride = {
  name: string;
  value: string;
  consequence: string;
};

function envValueForDisplay(value: string): string {
  const sanitized = sanitizeDiagnosticMessage(value);
  return sanitized.length > 96 ? `${sanitized.slice(0, 93)}...` : sanitized;
}

function envOverrideForJson(override: EnvOverride): DoctorEnvironmentOverrideRecord {
  return {
    name: override.name,
    value: "[redacted]",
    valueRedacted: true,
    consequence: override.consequence,
  };
}

function collectEnvironmentOverrides(activeModels: { embed: string; generate: string; rerank: string }, configModels: ModelsConfig = {}): EnvOverride[] {
  const overrides: EnvOverride[] = [];
  const jinaProfile = (() => {
    try {
      return loadConfig().providers?.jina?.embedding_profile;
    } catch {
      return undefined;
    }
  })();
  const add = (name: string, consequence: string) => {
    const raw = process.env[name]?.trim();
    if (!raw) return;
    overrides.push({ name, value: envValueForDisplay(raw), consequence });
  };
  const addModel = (name: string, key: "embed" | "generate" | "rerank", active: string) => {
    const raw = process.env[name]?.trim();
    if (!raw) return;
    const configured = configModels[key];
    const profileOwnedJinaModel =
      jinaProfile != null &&
      (key === "embed" || key === "rerank") &&
      raw.startsWith("jina:");
    const consequence = profileOwnedJinaModel
      ? `set but ignored because providers.jina.embedding_profile=${jinaProfile} owns the active Jina ${key} model ${active}`
      : configured && configured !== raw
      ? `set but ignored because index models.${key} is configured as ${configured}`
      : `sets the active ${key} model to ${active}; changes embedding/search semantics and may require \`qmd pull\` plus \`qmd embed\``;
    overrides.push({ name, value: envValueForDisplay(raw), consequence });
  };

  add("INDEX_PATH", "overrides the SQLite index path; QMD reads/writes a different database");
  add("QMD_CONFIG_DIR", "overrides the QMD config directory and takes precedence over XDG_CONFIG_HOME");
  add("XDG_CONFIG_HOME", "moves QMD config to $XDG_CONFIG_HOME/qmd when QMD_CONFIG_DIR is not set");
  add("XDG_CACHE_HOME", "moves the default index cache, model cache, and MCP daemon PID files");
  addModel("QMD_EMBED_MODEL", "embed", activeModels.embed);
  addModel("QMD_GENERATE_MODEL", "generate", activeModels.generate);
  addModel("QMD_RERANK_MODEL", "rerank", activeModels.rerank);
  add("QMD_FORCE_CPU", "forces llama.cpp to bypass GPU backends; embeddings/query will be slower but GPU crashes are avoided");
  add("QMD_LLAMA_GPU", "selects llama.cpp GPU backend (metal/cuda/vulkan) or disables GPU when set to false/off/0");
  add("QMD_DOCTOR_DEVICE_PROBE", "controls qmd doctor native device probing; 0/off skips GPU probing");
  add("QMD_EMBED_PARALLELISM", "overrides embedding parallel context count; too high can exhaust RAM/VRAM");
  add("QMD_EXPAND_CONTEXT_SIZE", "overrides query expansion context size; larger values use more memory");
  add("QMD_RERANK_CONTEXT_SIZE", "overrides reranker context size; larger values use more memory");
  add("QMD_EMBED_CONTEXT_SIZE", "overrides embed context size; larger values use more memory");
  add("QMD_EDITOR_URI", "overrides clickable editor link template in terminal output");
  add("QMD_SKILLS_DIR", "overrides where qmd skills are discovered from");
  add("QMD_DISABLE_DARWIN_QUERY_JSON_SAFE_EXIT", "disables macOS JSON-query safe exit workaround; may re-expose Metal finalizer crashes");
  add("NO_COLOR", "disables colored terminal output");
  add("CI", "disables real LLM operations inside QMD's LlamaCpp wrapper");
  add("HF_ENDPOINT", "changes Hugging Face download endpoint used when pulling models");
  add("QMD_WRAPPER_CAPTURE", "test/debug hook for the qmd shell wrapper; should not be set in normal use");
  add("WSL_DISTRO_NAME", "enables WSL path handling heuristics");
  add("WSL_INTEROP", "enables WSL path handling heuristics");
  return overrides;
}

type DoctorConfigCheck = {
  config: CollectionConfig | null;
  valid: boolean;
};

function checkDoctorIndexConfig(nextSteps: string[]): DoctorConfigCheck {
  try {
    const config = loadConfig();
    const collectionCount = Object.keys(config.collections ?? {}).length;
    if (collectionCount === 0) {
      doctorCheck("index config", false, "no collections configured. Next: `qmd collection add .`");
      nextSteps.push("Run `qmd collection add . --name <name>` from the folder you want to index, or edit .qmd/index.yml manually.");
    } else {
      doctorCheck("index config", true, `${formatCount(collectionCount)} ${collectionCount === 1 ? "collection" : "collections"} configured`);
    }
    return { config, valid: true };
  } catch (error) {
    const rawConfigPath = getConfigPath();
    const configPath = formatConfigDiagnosticPath(rawConfigPath);
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = sanitizeDiagnosticMessage(rawMessage.replaceAll(rawConfigPath, configPath));
    doctorCheck("index config", false, `invalid index.yml at ${configPath}: ${message}. Next: fix the YAML and rerun \`qmd doctor\``);
    nextSteps.push(`Fix invalid YAML in ${configPath}, then rerun \`qmd doctor\`.`);
    return { config: null, valid: false };
  }
}

function checkEnvironmentOverrides(activeModels: { embed: string; generate: string; rerank: string }, configModels: ModelsConfig = {}): void {
  const overrides = collectEnvironmentOverrides(activeModels, configModels);
  activeDoctorCapture?.environmentOverrides.push(...overrides.map(envOverrideForJson));
  if (overrides.length === 0) {
    doctorCheck("environment overrides", true, "none");
    return;
  }

  doctorCheck("environment overrides", false, `${overrides.length} set`);
  for (const override of overrides) {
    if (activeDoctorCapture) continue;
    console.log(`  - ${override.name}=${override.value}: ${override.consequence}`);
  }
}

function checkModelDefaults(activeModels: { embed: string; generate: string; rerank: string }, configModels: ModelsConfig = {}): void {
  const checks = [
    { role: "embedding", key: "embed", active: activeModels.embed, configured: configModels.embed, defaultModel: DEFAULT_EMBED_MODEL, envName: "QMD_EMBED_MODEL", envValue: process.env.QMD_EMBED_MODEL },
    { role: "generation", key: "generate", active: activeModels.generate, configured: configModels.generate, defaultModel: DEFAULT_QUERY_MODEL, envName: "QMD_GENERATE_MODEL", envValue: process.env.QMD_GENERATE_MODEL },
    { role: "reranking", key: "rerank", active: activeModels.rerank, configured: configModels.rerank, defaultModel: DEFAULT_RERANK_MODEL, envName: "QMD_RERANK_MODEL", envValue: process.env.QMD_RERANK_MODEL },
  ] as const;

  const notes: string[] = [];
  for (const check of checks) {
    const envValue = check.envValue?.trim();
    if (envValue && check.active === envValue) {
      notes.push(`${check.role}: env ${check.envName}=${check.active} (default ${check.defaultModel}; might be ok)`);
    } else if (check.configured && check.configured !== check.defaultModel) {
      notes.push(`${check.role}: index ${check.configured} (default ${check.defaultModel}; might be ok)`);
    } else if (envValue && check.active !== envValue) {
      notes.push(`${check.role}: ${check.envName} is set to ${envValue} but index config uses ${check.active}`);
    }
  }

  if (notes.length === 0) {
    doctorCheck("model defaults", true, "using QMD codebase defaults");
    return;
  }

  doctorCheck("model defaults", false, `non-default model configuration: ${notes.join("; ")}`);
}

function checkModelCache(activeModels: { embed: string; generate: string; rerank: string }, nextSteps: string[]): void {
  const models = [
    ["embedding", activeModels.embed],
    ["generation", activeModels.generate],
    ["reranking", activeModels.rerank],
  ] as const;
  const unique = new Map<string, string[]>();
  for (const [role, model] of models) {
    unique.set(model, [...(unique.get(model) ?? []), role]);
  }

  const missing: string[] = [];
  const cached: string[] = [];
  const invalid: string[] = [];
  for (const [model, roles] of unique) {
    const label = `${roles.join("+")}: ${model}`;
    const inspection = findCachedModelInspection(model);
    invalid.push(...inspection.invalid.map(detail => `${label} (${detail})`));
    if (inspection.path) {
      cached.push(label);
    } else {
      missing.push(label);
    }
  }

  if (missing.length === 0 && invalid.length === 0) {
    doctorCheck("model cache", true, `${cached.length} active ${cached.length === 1 ? "model is" : "models are"} downloaded and valid GGUF`);
    return;
  }

  const parts: string[] = [];
  if (invalid.length > 0) parts.push(`invalid ${invalid.length}: ${invalid.join("; ")}`);
  if (missing.length > 0) parts.push(`missing ${missing.length}/${unique.size}: ${missing.join("; ")}`);
  const next = invalid.length > 0
    ? "Next: run `qmd pull --refresh` (or remove the bad cached file)"
    : "Next: run `qmd pull`";
  doctorCheck("model cache", false, `${parts.join("; ")}. ${next}`);
  if (invalid.length > 0) {
    nextSteps.push("Run `qmd pull --refresh` to replace invalid cached model files, or delete the listed file and rerun `qmd pull`.");
  } else {
    nextSteps.push("Run `qmd pull` to download missing embedding/generation/reranking models before `qmd embed` or `qmd query`.");
  }
}

async function checkEmbeddingVectorSamples(db: Database, model: string, fingerprint: string, sampleSize: number = 3): Promise<DoctorVectorSampleResult> {
  const activeDocs = (db.prepare(`SELECT COUNT(*) AS count FROM documents WHERE active = 1`).get() as { count: number }).count;
  if (activeDocs === 0) {
    return { ok: true, details: "no active documents indexed" };
  }

  const vecTableExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!vecTableExists) {
    return { ok: false, details: "no vector table to test; please run qmd embed again" };
  }

  const samples = db.prepare(`
    SELECT cv.hash, cv.seq, c.doc AS body, MIN(d.path) AS path
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    JOIN content c ON c.hash = cv.hash
    WHERE cv.model = ? AND cv.embed_fingerprint = ?
    GROUP BY cv.hash, cv.seq, c.doc
    ORDER BY random()
    LIMIT ?
  `).all(model, fingerprint, sampleSize) as { hash: string; seq: number; body: string; path: string }[];

  if (samples.length === 0) {
    return { ok: false, details: "no current embedded chunks to test; please run qmd embed again" };
  }

  const threshold = 0.0001;
  const mismatches: string[] = [];

  await withLLMSession(async (session) => {
    for (const sample of samples) {
      const hashSeq = `${sample.hash}_${sample.seq}`;
      const chunks = await chunkDocumentByTokens(sample.body, undefined, undefined, undefined, sample.path, undefined, session.signal);
      const chunk = chunks[sample.seq];
      if (!chunk) {
        mismatches.push(`${shortHashSeq(hashSeq)}: chunk no longer exists`);
        continue;
      }

      const title = extractTitle(sample.body, sample.path);
      const result = await session.embed(formatDocForEmbedding(chunk.text, title, model), { model });
      if (!result) {
        mismatches.push(`${shortHashSeq(hashSeq)}: embedding failed`);
        continue;
      }

      const stored = db.prepare(`SELECT embedding FROM vectors_vec WHERE hash_seq = ?`).get(hashSeq) as { embedding: Uint8Array } | undefined;
      if (!stored) {
        mismatches.push(`${shortHashSeq(hashSeq)}: stored vector missing`);
        continue;
      }

      const distance = cosineDistance(result.embedding, decodeStoredEmbedding(stored.embedding));
      if (distance > threshold) {
        mismatches.push(`${shortHashSeq(hashSeq)}: stored vector distance ${distance.toFixed(6)}`);
      }
    }
  }, { maxDuration: 10 * 60 * 1000, name: "doctorEmbeddingVectorSample" });

  if (mismatches.length > 0) {
    return {
      ok: false,
      details: `${mismatches.length}/${samples.length} sampled chunks differ from stored vectors (${mismatches[0]}). Rebuild with \`qmd embed --force\``,
    };
  }

  return {
    ok: true,
    details: `${samples.length} sampled ${samples.length === 1 ? "chunk" : "chunks"} reproduce stored vectors`,
  };
}

function hasLibraryInDirs(libraryBaseName: string, dirs: string[]): boolean {
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry === libraryBaseName || entry.startsWith(`${libraryBaseName}.`)) return true;
      }
    } catch { /* ignore unreadable system library dirs */ }
  }
  return false;
}

function linuxCudaRuntimeDiagnostic(): string | null {
  if (process.platform !== "linux") return null;

  const dirs = new Set<string>();
  for (const value of [process.env.LD_LIBRARY_PATH, process.env.CUDA_PATH]) {
    for (const part of (value ?? "").split(":")) {
      if (part) dirs.add(part);
    }
  }
  if (process.env.CUDA_PATH) {
    dirs.add(pathJoin(process.env.CUDA_PATH, "lib64"));
    dirs.add(pathJoin(process.env.CUDA_PATH, "targets", "x86_64-linux", "lib"));
  }
  for (const dir of ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/local/cuda/lib64", "/usr/local/cuda/targets/x86_64-linux/lib"]) {
    dirs.add(dir);
  }
  try {
    for (const entry of readdirSync("/usr/local")) {
      if (!entry.toLowerCase().startsWith("cuda-")) continue;
      const cudaRoot = pathJoin("/usr/local", entry);
      dirs.add(pathJoin(cudaRoot, "lib64"));
      dirs.add(pathJoin(cudaRoot, "targets", "x86_64-linux", "lib"));
    }
  } catch { /* /usr/local may not be readable in restricted environments */ }

  const searchDirs = [...dirs];
  const hasDriver = hasLibraryInDirs("libcuda.so", searchDirs) || hasLibraryInDirs("libnvidia-ml.so", searchDirs);
  if (!hasDriver) return null;

  const cudaLibraries: [library: string, label: string][] = [
    ["libcudart.so", "CUDA runtime"],
    ["libcublas.so", "cuBLAS"],
    ["libcublasLt.so", "cuBLASLt"],
  ];
  const missing = cudaLibraries
    .filter(([library]) => !hasLibraryInDirs(library, searchDirs))
    .map(([, label]) => label);

  if (missing.length === 0) return null;
  return `NVIDIA driver libraries are visible, but CUDA user-space libraries are missing from loader paths (${missing.join(", ")})`;
}

async function runDoctorDeviceChecks(nextSteps: string[]): Promise<void> {
  const mode = configuredGpuModeLabel();
  doctorCheck("device mode", true, mode);

  const skipProbe = ["0", "false", "off", "no", "skip"].includes((process.env.QMD_DOCTOR_DEVICE_PROBE ?? "").trim().toLowerCase());
  if (skipProbe) {
    doctorCheck("device probe", false, "skipped by QMD_DOCTOR_DEVICE_PROBE=0. Next: unset it and rerun `qmd doctor` to verify GPU/CPU acceleration");
    nextSteps.push("Unset `QMD_DOCTOR_DEVICE_PROBE` and rerun `qmd doctor` when you want to verify llama.cpp device acceleration.");
    return;
  }

  const crashHint = "Probing native llama backend now. If qmd crashes here, rerun with `QMD_FORCE_CPU=1 qmd doctor` (or `QMD_DOCTOR_DEVICE_PROBE=0 qmd doctor` to skip this probe).";
  if (process.stdout.isTTY && !activeDoctorCapture) {
    process.stdout.write(`${c.dim}${crashHint}${c.reset}`);
  }

  try {
    const device = await getDefaultLlamaCpp().getDeviceInfo({ allowBuild: false });
    if (process.stdout.isTTY && !activeDoctorCapture) {
      process.stdout.write(`\r${" ".repeat(crashHint.length)}\r`);
    }
    if (device.gpu) {
      const gpuLabel = device.gpu === "metal" && process.platform === "darwin"
        ? "metal (macOS Metal backend)"
        : String(device.gpu);
      const parts = [`GPU ${gpuLabel}`, `offloading ${device.gpuOffloading ? "enabled" : "disabled"}`];
      if (device.gpuDevices.length > 0) parts.push(`devices: ${summarizeDeviceNames(device.gpuDevices)}`);
      if (device.vram) parts.push(`VRAM ${formatBytes(device.vram.free)} free / ${formatBytes(device.vram.total)} total`);
      parts.push(`${device.cpuCores} CPU math cores`);
      doctorCheck("device probe", device.gpuOffloading, device.gpuOffloading
        ? parts.join("; ")
        : `${parts.join("; ")}. Next: check QMD_LLAMA_GPU and llama.cpp backend support`);
      if (!device.gpuOffloading) {
        nextSteps.push("GPU was detected but offloading is disabled; check `QMD_LLAMA_GPU=metal|cuda|vulkan` and rerun `qmd doctor`.");
      }
    } else {
      const cudaDiagnostic = linuxCudaRuntimeDiagnostic();
      const diagnosticSuffix = cudaDiagnostic ? ` ${cudaDiagnostic}.` : "";
      doctorCheck("device probe", false, `running on CPU (${device.cpuCores} math cores).${diagnosticSuffix} Next: install/configure Metal, CUDA, or Vulkan for faster embeddings, or set QMD_FORCE_CPU=1 to make CPU mode explicit`);
      if (cudaDiagnostic) {
        nextSteps.push(`${cudaDiagnostic}; install CUDA runtime/cuBLAS libraries or add their directory to LD_LIBRARY_PATH, then rerun \`qmd doctor\`.`);
      } else {
        nextSteps.push("Vector operations are running on CPU; install/configure Metal, CUDA, or Vulkan if embedding/query performance is too slow.");
      }
    }
  } catch (error) {
    if (process.stdout.isTTY && !activeDoctorCapture) {
      process.stdout.write(`\r${" ".repeat(crashHint.length)}\r`);
    }
    const message = error instanceof Error ? sanitizeDiagnosticMessage(error.message) : sanitizeDiagnosticMessage(String(error));
    doctorCheck("device probe", false, `probe failed: ${message}. Next: run with QMD_FORCE_CPU=1 to bypass GPU probing, or set QMD_LLAMA_GPU=metal|cuda|vulkan and retry`);
    nextSteps.push("GPU probe failed; try `QMD_FORCE_CPU=1 qmd doctor` to confirm CPU fallback, then fix GPU drivers/backend if acceleration is expected.");
  }
}

async function showDoctor(jsonMode = false): Promise<void> {
  const storeInstance = getStore();
  const db = storeInstance.db;
  const pkg = readPackageJson();
  const activeModels = resolveModelsForCli();
  const embedModel = activeModels.embed;
  const embeddingChunkStrategy = resolveEmbeddingChunkStrategyForCli();
  const fingerprint = getEmbeddingFingerprint(embedModel, embeddingChunkStrategy);
  const nextSteps: string[] = [];
  const capture: DoctorCapture | null = jsonMode ? { checks: [], environmentOverrides: [] } : null;
  const previousCapture = activeDoctorCapture;

  activeDoctorCapture = capture;

  try {
    if (!jsonMode) {
      console.log(`${c.bold}QMD Doctor${c.reset}\n`);
      console.log(`Index: ${getDbPath()}`);
      console.log(`Runtime: ${isBun ? "bun:sqlite" : "better-sqlite3"}`);
    }

    try {
      const row = db.prepare(`SELECT sqlite_version() AS version`).get() as { version: string };
      doctorCheck("SQLite runtime", true, row.version);
    } catch (error) {
      doctorCheck("SQLite runtime", false, error instanceof Error ? error.message : String(error));
    }

    const betterSqliteVersion = pkg.dependencies?.["better-sqlite3"] ?? pkg.devDependencies?.["better-sqlite3"] ?? "not declared";
    doctorCheck("better-sqlite3 package", true, String(betterSqliteVersion));

    try {
      const row = db.prepare(`SELECT vec_version() AS version`).get() as { version: string };
      doctorCheck("sqlite-vec", true, row.version);
    } catch (error) {
      doctorCheck("sqlite-vec", false, error instanceof Error ? error.message : String(error));
    }

    const configCheck = checkDoctorIndexConfig(nextSteps);
    const configModels = configCheck.config?.models ?? {};
    checkEnvironmentOverrides(activeModels, configModels);
    checkModelDefaults(activeModels, configModels);
    checkModelCache(activeModels, nextSteps);

    await runDoctorDeviceChecks(nextSteps);

    try {
      const adoption = await maybeAdoptLegacyEmbeddingFingerprint(storeInstance, embedModel);
      if (adoption.checked || adoption.adopted > 0) {
        doctorCheck("legacy fingerprint adoption", adoption.adopted > 0, adoption.adopted > 0 ? `adopted ${adoption.adopted} legacy chunks; ${adoption.reason}` : adoption.reason);
      }
    } catch (error) {
      doctorCheck("legacy fingerprint adoption", false, error instanceof Error ? error.message : String(error));
    }

    try {
      const pending = getHashesNeedingEmbedding(db, undefined, embedModel);
      doctorCheck("embedding freshness", pending === 0, pending === 0 ? "all active documents match current fingerprint" : `${formatCount(pending)} active documents need embeddings. Next: \`qmd embed\``);
      if (pending > 0) {
        nextSteps.push(`Run \`qmd embed\` to generate ${formatCount(pending)} missing/stale document embeddings.`);
      }
    } catch (error) {
      doctorCheck("embedding freshness", false, error instanceof Error ? error.message : String(error));
    }

    try {
      const rows = db.prepare(`
        SELECT model, embed_fingerprint AS fingerprint, COUNT(DISTINCT hash) AS docs, COUNT(*) AS chunks
        FROM content_vectors
        GROUP BY model, embed_fingerprint
        ORDER BY chunks DESC, model, embed_fingerprint
      `).all() as { model: string; fingerprint: string; docs: number; chunks: number }[];
      const uniqueFingerprints = new Set(rows.map(row => row.fingerprint));
      const offCurrent = rows.filter(row => row.model === embedModel && row.fingerprint !== fingerprint);
      const ok = rows.length === 0 || (uniqueFingerprints.size === 1 && rows[0]?.fingerprint === fingerprint && offCurrent.length === 0);
      const currentDocs = rows
        .filter(row => row.model === embedModel && row.fingerprint === fingerprint)
        .reduce((sum, row) => sum + row.docs, 0);
      const otherDocs = rows.reduce((sum, row) => sum + row.docs, 0) - currentDocs;
      const groups = rows.map(row => {
        const label = row.fingerprint === fingerprint ? "current" : (row.fingerprint || "legacy");
        return `${shortModelName(row.model)}:${label} ${formatCount(row.docs)} docs/${formatCount(row.chunks)} chunks`;
      }).join("; ");
      const namedFingerprintRows = rows.filter(row => row.fingerprint);
      const namedFingerprints = [...new Set(namedFingerprintRows.map(row => row.fingerprint))];
      if (namedFingerprints.length > 1) {
        const namedGroups = namedFingerprintRows
          .map(row => `${row.fingerprint}${row.fingerprint === fingerprint ? " (current)" : ""}: ${shortModelName(row.model)} ${formatCount(row.docs)} docs/${formatCount(row.chunks)} chunks`)
          .join("; ");
        doctorCheck("mixed named embedding fingerprints", false, `content_vectors contains ${namedFingerprints.length} named fingerprints: ${namedGroups}. Next: \`qmd embed\` or \`qmd embed --force\``);
        nextSteps.push("Run `qmd embed` to converge mixed named embedding fingerprints; use `qmd embed --force` if old named fingerprints or vector sample mismatches remain.");
      }
      const details = rows.length === 0
        ? `no vectors yet; current fingerprint ${fingerprint}`
        : ok
          ? `${formatCount(currentDocs)} docs on current fingerprint (${fingerprint})`
          : `${formatCount(currentDocs)} docs current, ${formatCount(otherDocs)} docs legacy/stale. ${groups}. Next: \`qmd embed\``;
      doctorCheck("embedding fingerprints", ok, details);
      if (!ok) {
        nextSteps.push("Run `qmd embed` to migrate active documents to the current embedding fingerprint; use `qmd embed --force` if vector samples still fail afterward.");
      }
    } catch (error) {
      doctorCheck("embedding fingerprints", false, error instanceof Error ? error.message : String(error));
    }

    try {
      const vectorSample = await checkEmbeddingVectorSamples(db, embedModel, fingerprint);
      doctorCheck("embedding vector sample", vectorSample.ok, vectorSample.details);
      if (!vectorSample.ok) {
        nextSteps.push("Run `qmd embed --force` to rebuild existing vectors that no longer reproduce under the current embedding pipeline.");
      }
    } catch (error) {
      const message = error instanceof Error ? sanitizeDiagnosticMessage(error.message) : sanitizeDiagnosticMessage(String(error));
      doctorCheck("embedding vector sample", false, `${message}; rebuild with \`qmd embed --force\``);
      nextSteps.push("Run `qmd embed --force` to rebuild existing vectors, then rerun `qmd doctor`.");
    }

    const steps = normalizedDoctorNextSteps(nextSteps);
    if (jsonMode) {
      console.log(JSON.stringify({
        schemaVersion: "qmd.doctor.v1",
        index: getDbPath(),
        runtime: isBun ? "bun:sqlite" : "better-sqlite3",
        models: activeModels,
        embedding: {
          model: embedModel,
          fingerprint,
          chunkStrategy: embeddingChunkStrategy,
        },
        checks: capture?.checks ?? [],
        environmentOverrides: capture?.environmentOverrides ?? [],
        nextSteps: steps,
      }, null, 2));
    } else if (steps.length > 0) {
      console.log(`\n${c.bold}Recommended next step${steps.length === 1 ? "" : "s"}${c.reset}`);
      for (const step of steps) {
        console.log(`  - ${step}`);
      }
    }
  } finally {
    activeDoctorCapture = previousCapture;
    closeDb();
  }
}

function printDoctorHint(): void {
  console.error("If qmd still behaves unexpectedly, run 'qmd doctor' for diagnostics.");
}

function exitWithError(
  error: unknown,
  code = 1,
  stage: QueryStage = "route",
): never {
  if (error instanceof TypedQueryErrorException) {
    console.error(JSON.stringify(error.payload, null, 2));
    process.exit(code);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    const redactedMessage =
      sanitizeDiagnosticMessage(message) || "QMD command failed.";
    const payload = createTypedQueryError({
      route: "qmd",
      stage,
      code: "cli_error",
      retryable: false,
      redactedMessage,
      metadata: {
        diagnosticHint: "Run `qmd doctor` for diagnostics.",
      },
    });
    console.error(JSON.stringify(payload, null, 2));
  }
  process.exit(code);
}

type PackageJson = {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function resolveGraphVaultForCli(
  values: Record<string, unknown>,
  config: CollectionConfig,
): string {
  return pathResolve(
    getPwd(),
    String(values["graph-vault"] || config.graphrag?.vault || "graph_vault"),
  );
}

function graphVaultPolicyRef(graphVault: string, store: DspyPolicyStore): string {
  return pathJoin(basename(graphVault), store.pointerRelativePath());
}

function readPackageJson(): PackageJson {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(scriptDir, "..", "..", "package.json");
  return JSON.parse(readFileSync(pkgPath, "utf-8"));
}

async function showVersion(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkg = readPackageJson();

  let commit = "";
  try {
    commit = execSync(`git -C ${scriptDir} rev-parse --short HEAD`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    // Not a git repo or git not available
  }

  const versionStr = commit ? `${pkg.version} (${commit})` : pkg.version;
  console.log(`qmd ${versionStr}`);
}

// Main CLI - only run if this is the main module
const __filename = fileURLToPath(import.meta.url);
const argv1 = process.argv[1];
const isMain = argv1 === __filename
  || argv1?.endsWith("/qmd.ts")
  || argv1?.endsWith("/qmd.js")
  || (argv1 != null && realpathSync(argv1) === __filename);
if (isMain) {
  // Flip to production mode only when this module is executed as the CLI
  // entrypoint, not when imported for its exports. Tests must set INDEX_PATH
  // or use createStore() with an explicit path.
  enableProductionMode();
  loadProjectDotenvForCli();

  const cli = parseCLI();

  if (cli.values.version) {
    await showVersion();
    process.exit(0);
  }

  if (cli.values.skill) {
    showSkill();
    process.exit(0);
  }

  if (cli.values.help && cli.command === "skill") {
    console.log("Usage: qmd skill <show|install> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  show                 Print the QMD skill");
    console.log("  install              Install QMD skill into ./.agents/skills/qmd");
    console.log("");
    console.log("Options:");
    console.log("  --global             Install into ~/.agents/skills/qmd");
    console.log("  --yes                Also create the .claude/skills/qmd symlink");
    console.log("  -f, --force          Replace existing install or symlink");
    process.exit(0);
  }

  if (!cli.command || cli.values.help) {
    showHelp();
    process.exit(cli.values.help ? 0 : 1);
  }

  switch (cli.command) {
    case "context": {
      const subcommand = cli.args[0];
      if (!subcommand) {
        console.error("Usage: qmd context <add|list|rm>");
        console.error("");
        console.error("Commands:");
        console.error("  qmd context add [path] \"text\"  - Add context (defaults to current dir)");
        console.error("  qmd context add / \"text\"       - Add global context to all collections");
        console.error("  qmd context list                - List all contexts");
        console.error("  qmd context rm <path>           - Remove context");
        process.exit(1);
      }

      switch (subcommand) {
        case "add": {
          if (cli.args.length < 2) {
            console.error("Usage: qmd context add [path] \"text\"");
            console.error("");
            console.error("Examples:");
            console.error("  qmd context add \"Context for current directory\"");
            console.error("  qmd context add . \"Context for current directory\"");
            console.error("  qmd context add /subfolder \"Context for subfolder\"");
            console.error("  qmd context add / \"Global context for all collections\"");
            console.error("");
            console.error("  Using virtual paths:");
            console.error("  qmd context add qmd://journals/ \"Context for entire journals collection\"");
            console.error("  qmd context add qmd://journals/2024 \"Context for 2024 journals\"");
            process.exit(1);
          }

          let pathArg: string | undefined;
          let contextText: string;

          // Check if first arg looks like a path or if it's the context text
          const firstArg = cli.args[1] || '';
          const secondArg = cli.args[2];

          if (secondArg) {
            // Two args: path + context
            pathArg = firstArg;
            contextText = cli.args.slice(2).join(" ");
          } else {
            // One arg: context only (use current directory)
            pathArg = undefined;
            contextText = firstArg;
          }

          await contextAdd(pathArg, contextText);
          break;
        }

        case "list": {
          contextList();
          break;
        }

        case "rm":
        case "remove": {
          if (cli.args.length < 2 || !cli.args[1]) {
            console.error("Usage: qmd context rm <path>");
            console.error("Examples:");
            console.error("  qmd context rm /");
            console.error("  qmd context rm qmd://journals/2024");
            process.exit(1);
          }
          contextRemove(cli.args[1]);
          break;
        }

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error("Available: add, list, rm");
          process.exit(1);
      }
      break;
    }

    case "get": {
      if (!cli.args[0]) {
        console.error("Usage: qmd get <filepath>[:line] [--from <line>] [-l <lines>] [--line-numbers]");
        process.exit(1);
      }
      const fromLine = cli.values.from ? parseInt(cli.values.from as string, 10) : undefined;
      const maxLines = cli.values.l ? parseInt(cli.values.l as string, 10) : undefined;
      getDocument(cli.args[0], fromLine, maxLines, cli.opts.lineNumbers);
      break;
    }

    case "multi-get": {
      if (!cli.args[0]) {
        console.error("Usage: qmd multi-get <pattern> [-l <lines>] [--max-bytes <bytes>] [--json|--csv|--md|--xml|--files]");
        console.error("  pattern: glob (e.g., 'journals/2025-05*.md') or comma-separated list");
        process.exit(1);
      }
      const maxLinesMulti = cli.values.l ? parseInt(cli.values.l as string, 10) : undefined;
      const maxBytes = cli.values["max-bytes"] ? parseInt(cli.values["max-bytes"] as string, 10) : DEFAULT_MULTI_GET_MAX_BYTES;
      multiGet(cli.args[0], maxLinesMulti, maxBytes, cli.opts.format);
      break;
    }

    case "ls": {
      listFiles(cli.args[0]);
      break;
    }

    case "collection": {
      const subcommand = cli.args[0];
      switch (subcommand) {
        case "list": {
          collectionList();
          break;
        }

        case "add": {
          const pwd = cli.args[1] || getPwd();
          const resolvedPwd = pwd === '.' ? getPwd() : getRealPath(resolve(pwd));
          const globPattern = cli.values.mask as string || DEFAULT_GLOB;
          const name = cli.values.name as string | undefined;

          await collectionAdd(resolvedPwd, globPattern, name);
          break;
        }

        case "remove":
        case "rm": {
          if (!cli.args[1]) {
            console.error("Usage: qmd collection remove <name>");
            console.error("  Use 'qmd collection list' to see available collections");
            process.exit(1);
          }
          collectionRemove(cli.args[1]);
          break;
        }

        case "rename":
        case "mv": {
          if (!cli.args[1] || !cli.args[2]) {
            console.error("Usage: qmd collection rename <old-name> <new-name>");
            console.error("  Use 'qmd collection list' to see available collections");
            process.exit(1);
          }
          collectionRename(cli.args[1], cli.args[2]);
          break;
        }

        case "set-update":
        case "update-cmd": {
          const name = cli.args[1];
          const cmd = cli.args.slice(2).join(' ') || null;
          if (!name) {
            console.error("Usage: qmd collection update-cmd <name> [command]");
            console.error("  Set the command to run before indexing (e.g., 'git pull')");
            console.error("  Omit command to clear it");
            process.exit(1);
          }
          const { updateCollectionSettings, getCollection } = await import("../collections.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          updateCollectionSettings(name, { update: cmd });
          if (cmd) {
            console.log(`✓ Set update command for '${name}': ${cmd}`);
          } else {
            console.log(`✓ Cleared update command for '${name}'`);
          }
          break;
        }

        case "include":
        case "exclude": {
          const name = cli.args[1];
          if (!name) {
            console.error(`Usage: qmd collection ${subcommand} <name>`);
            console.error(`  ${subcommand === 'include' ? 'Include' : 'Exclude'} collection in default queries`);
            process.exit(1);
          }
          const { updateCollectionSettings, getCollection } = await import("../collections.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          const include = subcommand === 'include';
          updateCollectionSettings(name, { includeByDefault: include });
          console.log(`✓ Collection '${name}' ${include ? 'included in' : 'excluded from'} default queries`);
          break;
        }

        case "show":
        case "info": {
          const name = cli.args[1];
          if (!name) {
            console.error("Usage: qmd collection show <name>");
            process.exit(1);
          }
          const { getCollection } = await import("../collections.js");
          const col = getCollection(name);
          if (!col) {
            console.error(`Collection not found: ${name}`);
            process.exit(1);
          }
          console.log(`Collection: ${name}`);
          console.log(`  Path:     ${col.path}`);
          console.log(`  Pattern:  ${col.pattern}`);
          console.log(`  Include:  ${col.includeByDefault !== false ? 'yes (default)' : 'no'}`);
          if (col.update) {
            console.log(`  Update:   ${col.update}`);
          }
          if (col.context) {
            const ctxCount = Object.keys(col.context).length;
            console.log(`  Contexts: ${ctxCount}`);
          }
          break;
        }

        case "help":
        case undefined: {
          console.log("Usage: qmd collection <command> [options]");
          console.log("");
          console.log("Commands:");
          console.log("  list                      List all collections");
          console.log("  add <path> [--name NAME]  Add a collection");
          console.log("  remove <name>             Remove a collection");
          console.log("  rename <old> <new>        Rename a collection");
          console.log("  show <name>               Show collection details");
          console.log("  update-cmd <name> [cmd]   Set pre-update command (e.g., 'git pull')");
          console.log("  include <name>            Include in default queries");
          console.log("  exclude <name>            Exclude from default queries");
          console.log("");
          console.log("Examples:");
          console.log("  qmd collection add ~/notes --name notes");
          console.log("  qmd collection update-cmd brain 'git pull'");
          console.log("  qmd collection exclude archive");
          process.exit(0);
        }

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error("Run 'qmd collection help' for usage");
          printDoctorHint();
          process.exit(1);
      }
      break;
    }

    case "init":
      try {
        initLocalIndex();
      } catch (error) {
        exitWithError(error);
      }
      break;

    case "status":
      await showStatus();
      break;

    case "doctor":
      await showDoctor(cli.opts.format === "json");
      break;

    case "update":
      await updateCollections();
      break;

    case "embed":
      try {
        const maxDocsPerBatch = parseEmbedBatchOption("maxDocsPerBatch", cli.values["max-docs-per-batch"]);
        const maxBatchMb = parseEmbedBatchOption("maxBatchBytes", cli.values["max-batch-mb"]);
        const embedChunkStrategy = parseChunkStrategy(cli.values["chunk-strategy"]);
        // Validate -c against configured collections before dispatching, so a
        // typo errors with "Collection not found: X" instead of silently
        // reporting success because no pending docs match a nonexistent name.
        // embed operates on a single collection; only the first value is used.
        const embedValidatedCollections = resolveCollectionFilter(cli.opts.collection, false);
        const embedCollection = embedValidatedCollections[0];
        await vectorIndex(resolveEmbedModelForCli(), !!cli.values.force, {
          maxDocsPerBatch,
          maxBatchBytes: maxBatchMb === undefined ? undefined : maxBatchMb * 1024 * 1024,
          chunkStrategy: embedChunkStrategy,
          collection: embedCollection,
        });
      } catch (error) {
        exitWithError(error);
      }
      break;

    case "dspy":
      try {
        await dspyCommand(cli.args, cli.values);
      } catch (error) {
        exitWithError(error);
      }
      break;

    case "pull": {
      const refresh = cli.values.refresh === undefined ? false : Boolean(cli.values.refresh);
      const activeModels = resolveModelsForCli();
      const models = [
        activeModels.embed,
        activeModels.generate,
        activeModels.rerank,
      ];
      console.log(`${c.bold}Pulling models${c.reset}`);
      const results = await pullModels(models, {
        refresh,
        cacheDir: DEFAULT_MODEL_CACHE_DIR,
      });
      for (const result of results) {
        const size = formatBytes(result.sizeBytes);
        const note = result.refreshed ? "refreshed" : "cached/checked";
        console.log(`- ${result.model} -> ${result.path} (${size}, ${note})`);
      }
      break;
    }

    case "search":
      if (!cli.query) {
        console.error("Usage: qmd search [options] <query>");
        process.exit(1);
      }
      search(cli.query, cli.opts);
      break;

    case "vsearch":
    case "vector-search": // undocumented alias
      if (!cli.query) {
        console.error("Usage: qmd vsearch [options] <query>");
        process.exit(1);
      }
      // Default min-score for vector search is 0.3
      if (!cli.values["min-score"]) {
        cli.opts.minScore = 0.3;
      }
      await vectorSearch(cli.query, cli.opts);
      break;

    case "query":
    case "deep-search": // undocumented alias
      if (!cli.query) {
        console.error("Usage: qmd query [options] <query>");
        process.exit(1);
      }
      try {
        if (cli.values.mode != null && !["qmd", "auto"].includes(String(cli.values.mode))) {
          throw new TypedQueryErrorException(createTypedQueryError({
            route: "auto",
            stage: "route",
            code: "invalid_query_mode",
            retryable: false,
            redactedMessage: "--mode must be qmd or auto.",
          }));
        }
        if (cli.values.graphrag) {
          await graphRagQuerySearch(cli.query, cli.opts, cli.values);
        } else {
          const config = ensureRuntimeConfigForCli();
          const configuredRoute = config.query?.default_route ?? "qmd";
          const explicitMode = cli.values.mode == null
            ? null
            : String(cli.values.mode);
          const route = explicitMode ?? configuredRoute;
          if (route === "auto") {
            await autoQuerySearch(cli.query, cli.opts);
          } else {
            await querySearch(cli.query, cli.opts);
          }
        }
      } catch (error) {
        exitWithError(error);
      }
      break;

    case "bench": {
      const fixturePath = cli.args[0];
      if (!fixturePath) {
        console.error("Usage: qmd bench <fixture.json> [--json] [-c collection]");
        console.error("");
        console.error("Run search quality benchmarks against a fixture file.");
        console.error("See src/bench/fixtures/example.json for the fixture format.");
        process.exit(1);
      }
      const { runBenchmark } = await import("../bench/bench.js");
      const benchCollection = cli.opts.collection;
      await runBenchmark(fixturePath, {
        json: !!cli.values.json,
        collection: Array.isArray(benchCollection) ? benchCollection[0] : benchCollection,
        dbPath: getDbPath(),
        configPath: configExists() ? getConfigPath() : undefined,
      });
      break;
    }

    case "mcp": {
      const sub = cli.args[0]; // stop | status | undefined

      // Cache dir for PID/log files — same dir as the index
      const cacheDir = process.env.XDG_CACHE_HOME
        ? resolve(process.env.XDG_CACHE_HOME, "qmd")
        : resolve(homedir(), ".cache", "qmd");
      const pidPath = resolve(cacheDir, "mcp.pid");

      // Subcommands take priority over flags
      if (sub === "stop") {
        if (!existsSync(pidPath)) {
          console.log("Not running (no PID file).");
          process.exit(0);
        }
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim());
        try {
          process.kill(pid, 0); // alive?
          process.kill(pid, "SIGTERM");
          unlinkSync(pidPath);
          console.log(`Stopped QMD MCP server (PID ${pid}).`);
        } catch {
          unlinkSync(pidPath);
          console.log("Cleaned up stale PID file (server was not running).");
        }
        process.exit(0);
      }

      if (cli.values.http) {
        const port = Number(cli.values.port) || 8181;

        if (cli.values.daemon) {
          // Guard: check if already running
          if (existsSync(pidPath)) {
            const existingPid = parseInt(readFileSync(pidPath, "utf-8").trim());
            try {
              process.kill(existingPid, 0); // alive?
              console.error(`Already running (PID ${existingPid}). Run 'qmd mcp stop' first.`);
              process.exit(1);
            } catch {
              // Stale PID file — continue
            }
          }

          mkdirSync(cacheDir, { recursive: true });
          const logPath = resolve(cacheDir, "mcp.log");
          const logFd = openSync(logPath, "w"); // truncate — fresh log per daemon run
          const selfPath = fileURLToPath(import.meta.url);
          const indexArgs = cli.values.index ? ["--index", String(cli.values.index)] : [];
          const spawnArgs = selfPath.endsWith(".ts")
            ? ["--import", pathJoin(dirname(selfPath), "..", "..", "node_modules", "tsx", "dist", "esm", "index.mjs"), selfPath, ...indexArgs, "mcp", "--http", "--port", String(port)]
            : [selfPath, ...indexArgs, "mcp", "--http", "--port", String(port)];
          const child = nodeSpawn(process.execPath, spawnArgs, {
            stdio: ["ignore", logFd, logFd],
            detached: true,
          });
          child.unref();
          closeSync(logFd); // parent's copy; child inherited the fd

          writeFileSync(pidPath, String(child.pid));
          console.log(`Started on http://localhost:${port}/mcp (PID ${child.pid})`);
          console.log(`Logs: ${logPath}`);
          process.exit(0);
        }

        // Foreground HTTP mode — remove top-level cursor handlers so the
        // async cleanup handlers in startMcpHttpServer actually run.
        process.removeAllListeners("SIGTERM");
        process.removeAllListeners("SIGINT");
        const { startMcpHttpServer } = await import("../mcp/server.js");
        try {
          await startMcpHttpServer(port, { dbPath: getDbPath() });
        } catch (e: unknown) {
          if (typeof e === "object" && e !== null && "code" in e && e.code === "EADDRINUSE") {
            console.error(`Port ${port} already in use. Try a different port with --port.`);
            process.exit(1);
          }
          throw e;
        }
      } else {
        // Default: stdio transport
        const { startMcpServer } = await import("../mcp/server.js");
        await startMcpServer({ dbPath: getDbPath() });
      }
      break;
    }

    case "skills": {
      try {
        if (cli.values.help || cli.args[0] === "help") {
          showSkillsHelp();
        } else {
          runSkillsCommand(cli.args, Boolean(cli.values.json), Boolean(cli.values.full), Boolean(cli.values.all));
        }
      } catch (error) {
        if (cli.values.json) {
          outputSkillsJson({ success: false, error: error instanceof Error ? error.message : String(error) });
        } else {
          console.error(error instanceof Error ? error.message : String(error));
        }
        process.exit(1);
      }
      break;
    }

    case "skill": {
      const subcommand = cli.args[0];
      switch (subcommand) {
        case "show": {
          showSkill();
          break;
        }

        case "install": {
          try {
            await installSkill(Boolean(cli.values.global), Boolean(cli.values.force), Boolean(cli.values.yes));
          } catch (error) {
            exitWithError(error);
          }
          break;
        }

        case "help":
        case undefined: {
          console.log("Usage: qmd skill <show|install> [options]");
          console.log("");
          console.log("Commands:");
          console.log("  show                 Print the QMD skill");
          console.log("  install              Install QMD skill into ./.agents/skills/qmd");
          console.log("");
          console.log("Options:");
          console.log("  --global             Install into ~/.agents/skills/qmd");
          console.log("  --yes                Also create the .claude/skills/qmd symlink");
          console.log("  -f, --force          Replace existing install or symlink");
          process.exit(0);
        }

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error("Run 'qmd skill help' for usage");
          printDoctorHint();
          process.exit(1);
      }
      break;
    }

    case "cleanup": {
      const db = getDb();

      // 1. Clear llm_cache
      const cacheCount = deleteLLMCache(db);
      console.log(`${c.green}✓${c.reset} Cleared ${cacheCount} cached API responses`);

      // 2. Remove orphaned vectors
      const orphanedVecs = cleanupOrphanedVectors(db);
      if (orphanedVecs > 0) {
        console.log(`${c.green}✓${c.reset} Removed ${orphanedVecs} orphaned embedding chunks`);
      } else {
        console.log(`${c.dim}No orphaned embeddings to remove${c.reset}`);
      }

      // 3. Remove inactive documents
      const inactiveDocs = deleteInactiveDocuments(db);
      if (inactiveDocs > 0) {
        console.log(`${c.green}✓${c.reset} Removed ${inactiveDocs} inactive document records`);
      }

      // 4. Vacuum to reclaim space
      vacuumDatabase(db);
      console.log(`${c.green}✓${c.reset} Database vacuumed`);

      closeDb();
      break;
    }

    default:
      console.error(`Unknown command: ${cli.command}`);
      console.error("Run 'qmd --help' for usage.");
      printDoctorHint();
      process.exit(1);
  }

  if (cli.command !== "mcp") {
    await finishSuccessfulCliCommand({
      command: cli.command,
      format: cli.opts.format,
    });
  }

} // end if (main module)
