import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import YAML from "yaml";

import type { CollectionConfig } from "../collections.js";
import { createDeterministicHash } from "../job-state/fingerprint.js";

const ManagedBy = "qmd_graphrag";
const ResponsesEndpoint = "/responses";

export type GraphRagRuntimeSettingsProjection = {
  sourceFingerprint: string;
  settings: Record<string, unknown>;
};

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
  const settings = {
    qmd_graphrag: {
      managed_by: ManagedBy,
      source_fingerprint: sourceFingerprint,
      jina: {
        api_base: jinaApiBase(jina.base_url),
        default_base_url: jinaApiBase(jina.base_url),
        embedding_endpoint: jina.embedding_endpoint ?? "/v1/embeddings",
        rerank_endpoint: jina.rerank_endpoint ?? "/v1/rerank",
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
          max_completion_tokens: 4096,
        },
      },
    },
    concurrent_requests: 2,
    embedding_models: {
      default_embedding_model: {
        type: "litellm",
        model_provider: "jina_ai",
        model: jina.embedding_model ?? modelName(
          config.models?.embed,
          "jina-embeddings-v3",
        ),
        api_key: envPlaceholder(jina.api_key_env, "JINA_API_KEY"),
        api_base: jinaLiteLlmApiBase(jina.base_url),
        call_args: {
          default_base_url: jinaApiBase(jina.base_url),
          embedding_endpoint: jina.embedding_endpoint ?? "/v1/embeddings",
        },
      },
    },
    input: { type: "text" },
    input_storage: { type: "file", base_dir: "./input" },
    output_storage: { type: "file", base_dir: "./output" },
    reporting: { type: "file", base_dir: "./reports" },
    cache: { type: "json", storage: { type: "file", base_dir: "./cache" } },
    vector_store: {
      type: "lancedb",
      db_uri: "./output/lancedb",
      vector_size: 1024,
    },
    embed_text: { embedding_model_id: "default_embedding_model" },
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
      embedding_model_id: "default_embedding_model",
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
      embedding_model_id: "default_embedding_model",
      prompt: "prompts/drift_search_system_prompt.txt",
      reduce_prompt: "prompts/drift_search_reduce_prompt.txt",
    },
    basic_search: {
      completion_model_id: "default_chat_model",
      embedding_model_id: "default_embedding_model",
      prompt: "prompts/basic_search_system_prompt.txt",
    },
  };

  return { sourceFingerprint, settings };
}

export async function writeManagedGraphRagSettings(input: {
  config: CollectionConfig;
  graphVault: string;
}): Promise<string> {
  const projection = buildGraphRagRuntimeSettingsProjection(input.config);
  const settingsPath = join(resolve(input.graphVault), "settings.yaml");
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, YAML.stringify(projection.settings), "utf8");
  return settingsPath;
}

export function writeManagedGraphRagSettingsSync(input: {
  config: CollectionConfig;
  graphVault: string;
}): string {
  const projection = buildGraphRagRuntimeSettingsProjection(input.config);
  const settingsPath = join(resolve(input.graphVault), "settings.yaml");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, YAML.stringify(projection.settings), "utf8");
  return settingsPath;
}

export async function assertManagedGraphRagSettings(input: {
  config: CollectionConfig;
  settingsPath: string;
}): Promise<void> {
  const raw = await readFile(input.settingsPath, "utf8");
  const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown> & {
    qmd_graphrag?: {
      managed_by?: unknown;
      source_fingerprint?: unknown;
    };
  };
  const projection = buildGraphRagRuntimeSettingsProjection(input.config);
  const header = parsed.qmd_graphrag;
  if (
    header?.managed_by !== ManagedBy ||
    header.source_fingerprint !== projection.sourceFingerprint ||
    createDeterministicHash(parsed) !== createDeterministicHash(projection.settings)
  ) {
    throw new Error(
      "graph_vault/settings.yaml is not the managed projection of .qmd/index.yml",
    );
  }
}
