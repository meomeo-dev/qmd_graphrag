import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { CollectionConfig } from "../collections.js";
import {
  readYamlUnknownDurable,
  readYamlUnknownDurableSync,
  writeYamlFileDurable,
  writeYamlFileDurableSync,
} from "../job-state/durable-state-store.js";
import { createDeterministicHash } from "../job-state/fingerprint.js";
import {
  DEFAULT_JINA_EMBEDDING_PROFILE,
  JINA_EMBEDDING_PROFILES,
} from "../llm.js";

const ManagedBy = "qmd_graphrag";
const ResponsesEndpoint = "/responses";
const DocumentEmbeddingModelId = "default_embedding_model";
const QueryEmbeddingModelId = "query_embedding_model";
const DefaultConcurrentRequests = 10;
const DefaultMaxCompletionTokens = 23000;

export type GraphRagRuntimeSettingsProjection = {
  sourceFingerprint: string;
  settings: Record<string, unknown>;
};

export type ManagedGraphRagSettingsRepairResult = {
  decision: "already_valid" | "rewritten";
  rewritten: boolean;
  sourceFingerprint: string;
  settingsPath: string;
  evidenceLocator: string;
  reason: string;
};

const ManagedProjectionError =
  "graph_vault/settings.yaml is not the managed projection of .qmd/index.yml";

function settingsMissingError(settingsPath: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, open '${settingsPath}'`,
  ) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.errno = -2;
  error.path = settingsPath;
  error.syscall = "open";
  return error;
}

function envPlaceholder(envName: string | undefined, fallback: string): string {
  return `\${${envName || fallback}}`;
}

function modelName(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const separator = value.indexOf(":");
  return separator < 0 ? value : value.slice(separator + 1);
}

function jinaApiBase(value: string | undefined): string {
  return value ?? "https://api.jina.ai";
}

function jinaLiteLlmApiBase(value: string | undefined): string {
  const base = jinaApiBase(value).replace(/\/+$/u, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function graphRagProjectConfigFingerprint(config: CollectionConfig): string {
  return createDeterministicHash({
    models: config.models ?? {},
    providers: config.providers ?? {},
    embedding: config.embedding ?? {},
    graphrag: config.graphrag ?? {},
    query: config.query ?? {},
  });
}

export function buildGraphRagRuntimeSettingsProjection(
  config: CollectionConfig,
): GraphRagRuntimeSettingsProjection {
  const sourceFingerprint = graphRagProjectConfigFingerprint(config);
  const openai = config.providers?.openai ?? {};
  const responseApi = openai.response_api ?? {};
  if (
    responseApi.endpoint !== undefined &&
    responseApi.endpoint !== ResponsesEndpoint
  ) {
    throw new Error("OpenAI Responses API endpoint must be /responses");
  }
  if (responseApi.stream !== undefined && responseApi.stream !== true) {
    throw new Error("OpenAI Responses API stream transport must be enabled");
  }
  if (
    responseApi.strict_structured_output !== undefined &&
    responseApi.strict_structured_output !== true
  ) {
    throw new Error("OpenAI Responses API structured output must be strict");
  }
  const jina = config.providers?.jina ?? {};
  const profileName = jina.embedding_profile ?? DEFAULT_JINA_EMBEDDING_PROFILE;
  const profile = JINA_EMBEDDING_PROFILES[profileName];
  if (profile == null) {
    throw new Error(
      "providers.jina.embedding_profile must be one of: " +
        Object.keys(JINA_EMBEDDING_PROFILES).join(", "),
    );
  }
  const concurrentRequests =
    config.graphrag?.concurrent_requests ?? DefaultConcurrentRequests;
  if (!Number.isInteger(concurrentRequests) || concurrentRequests < 1) {
    throw new Error("graphrag.concurrent_requests must be a positive integer");
  }
  const settings = {
    qmd_graphrag: {
      managed_by: ManagedBy,
      source_fingerprint: sourceFingerprint,
      jina: {
        api_base: jinaApiBase(jina.base_url),
        default_base_url: jinaApiBase(jina.base_url),
        embedding_endpoint: jina.embedding_endpoint ?? "/v1/embeddings",
        rerank_endpoint: jina.rerank_endpoint ?? "/v1/rerank",
        embedding_profile: profileName,
        embedding_query_task: profile.queryTask,
        embedding_document_task: profile.documentTask,
        embedding_dimensions: profile.dimensions,
        embedding_normalized: profile.normalized,
        embedding_type: profile.embeddingType,
        embedding_truncate: profile.truncate,
      },
    },
    completion_models: {
      default_chat_model: {
        type: "openai_responses",
        model_provider: "openai",
        model: modelName(config.models?.generate, "gpt-5.4"),
        api_key: envPlaceholder(openai.api_key_env, "OPENAI_API_KEY"),
        api_base: envPlaceholder(openai.base_url_env, "OPENAI_BASE_URL"),
        retry: {
          type: "exponential_backoff",
          max_retries: 6,
          base_delay: 2.0,
          max_delay: 30.0,
          jitter: true,
        },
        call_args: {
          responses_endpoint: ResponsesEndpoint,
          responses_stream: responseApi.stream ?? true,
          strict_structured_output: responseApi.strict_structured_output ?? true,
          reasoning_effort: responseApi.reasoning_effort ?? "medium",
          max_completion_tokens: DefaultMaxCompletionTokens,
          qmd_responses_max_concurrency: concurrentRequests,
          qmd_responses_retry_max_retries: 12,
          qmd_responses_retry_base_delay: 2,
          qmd_responses_retry_max_delay: 120,
          qmd_responses_retry_jitter: true,
        },
      },
    },
    concurrent_requests: concurrentRequests,
    embedding_models: {
      [DocumentEmbeddingModelId]: {
        type: "litellm",
        model_provider: "jina_ai",
        model: profile.embeddingModel,
        api_key: envPlaceholder(jina.api_key_env, "JINA_API_KEY"),
        api_base: jinaLiteLlmApiBase(jina.base_url),
        call_args: {
          default_base_url: jinaApiBase(jina.base_url),
          embedding_endpoint: jina.embedding_endpoint ?? "/v1/embeddings",
          task: profile.documentTask,
          dimensions: profile.dimensions,
          normalized: profile.normalized,
          embedding_type: profile.embeddingType,
          truncate: profile.truncate,
        },
      },
      [QueryEmbeddingModelId]: {
        type: "litellm",
        model_provider: "jina_ai",
        model: profile.embeddingModel,
        api_key: envPlaceholder(jina.api_key_env, "JINA_API_KEY"),
        api_base: jinaLiteLlmApiBase(jina.base_url),
        call_args: {
          default_base_url: jinaApiBase(jina.base_url),
          embedding_endpoint: jina.embedding_endpoint ?? "/v1/embeddings",
          task: profile.queryTask,
          dimensions: profile.dimensions,
          normalized: profile.normalized,
          embedding_type: profile.embeddingType,
          truncate: profile.truncate,
        },
      },
    },
    input: {
      type: "text",
      file_pattern: ".*\\.(md|markdown|txt)",
    },
    input_storage: { type: "file", base_dir: "./input" },
    output_storage: { type: "file", base_dir: "./output" },
    reporting: { type: "file", base_dir: "./reports" },
    cache: { type: "json", storage: { type: "file", base_dir: "./cache" } },
    vector_store: {
      type: "lancedb",
      db_uri: "./output/lancedb",
      vector_size: profile.dimensions,
    },
    embed_text: { embedding_model_id: DocumentEmbeddingModelId },
    extract_graph: {
      completion_model_id: "default_chat_model",
      prompt: "prompts/extract_graph.txt",
    },
    summarize_descriptions: {
      completion_model_id: "default_chat_model",
      prompt: "prompts/summarize_descriptions.txt",
    },
    community_reports: {
      completion_model_id: "default_chat_model",
      graph_prompt: "prompts/community_report_graph.txt",
      text_prompt: "prompts/community_report_text.txt",
    },
    local_search: {
      completion_model_id: "default_chat_model",
      embedding_model_id: QueryEmbeddingModelId,
      prompt: "prompts/local_search_system_prompt.txt",
    },
    global_search: {
      completion_model_id: "default_chat_model",
      map_prompt: "prompts/global_search_map_system_prompt.txt",
      reduce_prompt: "prompts/global_search_reduce_system_prompt.txt",
      knowledge_prompt: "prompts/global_search_knowledge_system_prompt.txt",
    },
    drift_search: {
      completion_model_id: "default_chat_model",
      embedding_model_id: QueryEmbeddingModelId,
      prompt: "prompts/drift_search_system_prompt.txt",
      reduce_prompt: "prompts/drift_search_reduce_prompt.txt",
    },
    basic_search: {
      completion_model_id: "default_chat_model",
      embedding_model_id: QueryEmbeddingModelId,
      prompt: "prompts/basic_search_system_prompt.txt",
    },
  };

  return { sourceFingerprint, settings };
}

export async function writeManagedGraphRagSettings(input: {
  config: CollectionConfig;
  graphVault: string;
}): Promise<string> {
  const settingsPath = join(resolve(input.graphVault), "settings.yaml");
  await ensureManagedGraphRagSettings({ config: input.config, settingsPath });
  return settingsPath;
}

export function writeManagedGraphRagSettingsSync(input: {
  config: CollectionConfig;
  graphVault: string;
}): string {
  const settingsPath = join(resolve(input.graphVault), "settings.yaml");
  ensureManagedGraphRagSettingsSync({ config: input.config, settingsPath });
  return settingsPath;
}

async function writeManagedSettingsFile(
  settingsPath: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await writeYamlFileDurable(settingsPath, settings);
}

function writeManagedSettingsFileSync(
  settingsPath: string,
  settings: Record<string, unknown>,
): void {
  writeYamlFileDurableSync(settingsPath, settings);
}

function parseManagedSettings(input: unknown): Record<string, unknown> & {
  qmd_graphrag?: {
    managed_by?: unknown;
    source_fingerprint?: unknown;
  };
} {
  const parsed = (input ?? {}) as Record<string, unknown> & {
    qmd_graphrag?: {
      managed_by?: unknown;
      source_fingerprint?: unknown;
    };
  };
  if (typeof parsed !== "object" || parsed == null) {
    throw new Error(ManagedProjectionError);
  }
  return parsed;
}

async function readManagedSettingsFile(
  settingsPath: string,
): Promise<Record<string, unknown> & {
  qmd_graphrag?: {
    managed_by?: unknown;
    source_fingerprint?: unknown;
  };
}> {
  if (!existsSync(settingsPath)) throw settingsMissingError(settingsPath);
  const parsed = await readYamlUnknownDurable(settingsPath);
  if (parsed == null && !existsSync(settingsPath)) {
    throw settingsMissingError(settingsPath);
  }
  return parseManagedSettings(parsed);
}

function readManagedSettingsFileSync(
  settingsPath: string,
): Record<string, unknown> & {
  qmd_graphrag?: {
    managed_by?: unknown;
    source_fingerprint?: unknown;
  };
} {
  if (!existsSync(settingsPath)) throw settingsMissingError(settingsPath);
  const parsed = readYamlUnknownDurableSync(settingsPath);
  if (parsed == null && !existsSync(settingsPath)) {
    throw settingsMissingError(settingsPath);
  }
  return parseManagedSettings(parsed);
}

function isValidManagedProjection(
  parsed: Record<string, unknown> & {
    qmd_graphrag?: {
      managed_by?: unknown;
      source_fingerprint?: unknown;
    };
  },
  projection: GraphRagRuntimeSettingsProjection,
): boolean {
  const header = parsed.qmd_graphrag;
  return header?.managed_by === ManagedBy &&
    header.source_fingerprint === projection.sourceFingerprint &&
    createDeterministicHash(parsed) ===
      createDeterministicHash(projection.settings);
}

function hasManagedMarker(
  parsed: Record<string, unknown> & {
    qmd_graphrag?: {
      managed_by?: unknown;
      source_fingerprint?: unknown;
    };
  },
): boolean {
  return parsed.qmd_graphrag?.managed_by === ManagedBy;
}

export async function ensureManagedGraphRagSettings(input: {
  config: CollectionConfig;
  settingsPath: string;
}): Promise<ManagedGraphRagSettingsRepairResult> {
  const projection = buildGraphRagRuntimeSettingsProjection(input.config);
  const settingsPath = resolve(input.settingsPath);
  let parsed: ReturnType<typeof parseManagedSettings>;
  try {
    parsed = await readManagedSettingsFile(settingsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeManagedSettingsFile(settingsPath, projection.settings);
    return {
      decision: "rewritten",
      rewritten: true,
      sourceFingerprint: projection.sourceFingerprint,
      settingsPath,
      evidenceLocator: settingsPath,
      reason: "managed_projection_created",
    };
  }
  if (isValidManagedProjection(parsed, projection)) {
    return {
      decision: "already_valid",
      rewritten: false,
      sourceFingerprint: projection.sourceFingerprint,
      settingsPath,
      evidenceLocator: settingsPath,
      reason: "managed_projection_valid",
    };
  }
  if (!hasManagedMarker(parsed)) {
    throw new Error(ManagedProjectionError);
  }
  await writeManagedSettingsFile(settingsPath, projection.settings);
  return {
    decision: "rewritten",
    rewritten: true,
    sourceFingerprint: projection.sourceFingerprint,
    settingsPath,
    evidenceLocator: settingsPath,
    reason: "managed_projection_rewritten",
  };
}

export function ensureManagedGraphRagSettingsSync(input: {
  config: CollectionConfig;
  settingsPath: string;
}): ManagedGraphRagSettingsRepairResult {
  const projection = buildGraphRagRuntimeSettingsProjection(input.config);
  const settingsPath = resolve(input.settingsPath);
  let parsed: ReturnType<typeof parseManagedSettings>;
  try {
    parsed = readManagedSettingsFileSync(settingsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeManagedSettingsFileSync(settingsPath, projection.settings);
    return {
      decision: "rewritten",
      rewritten: true,
      sourceFingerprint: projection.sourceFingerprint,
      settingsPath,
      evidenceLocator: settingsPath,
      reason: "managed_projection_created",
    };
  }
  if (isValidManagedProjection(parsed, projection)) {
    return {
      decision: "already_valid",
      rewritten: false,
      sourceFingerprint: projection.sourceFingerprint,
      settingsPath,
      evidenceLocator: settingsPath,
      reason: "managed_projection_valid",
    };
  }
  if (!hasManagedMarker(parsed)) {
    throw new Error(ManagedProjectionError);
  }
  writeManagedSettingsFileSync(settingsPath, projection.settings);
  return {
    decision: "rewritten",
    rewritten: true,
    sourceFingerprint: projection.sourceFingerprint,
    settingsPath,
    evidenceLocator: settingsPath,
    reason: "managed_projection_rewritten",
  };
}

export async function assertManagedGraphRagSettings(input: {
  config: CollectionConfig;
  settingsPath: string;
}): Promise<void> {
  const parsed = await readManagedSettingsFile(input.settingsPath);
  const projection = buildGraphRagRuntimeSettingsProjection(input.config);
  if (!isValidManagedProjection(parsed, projection)) throw new Error(ManagedProjectionError);
}
