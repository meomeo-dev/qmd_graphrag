import type { CollectionConfig } from "../collections.js";
import type { DspyFingerprintSet } from "../contracts/dspy.js";
import { SchemaVersion } from "../contracts/common.js";
import { createDeterministicHash } from "../job-state/fingerprint.js";

export type DspyRuntimeFingerprintDefaults = {
  generateModel: string;
  embedModel: string;
  rerankModel: string;
};

export function dspyProviderEnvRefs(config: CollectionConfig): string[] {
  const openai = config.providers?.openai;
  const jina = config.providers?.jina;
  return Array.from(new Set([
    openai?.api_key_env ?? "OPENAI_API_KEY",
    openai?.base_url_env ?? "OPENAI_BASE_URL",
    jina?.api_key_env ?? "JINA_API_KEY",
    jina?.base_url_env ?? "JINA_API_BASE",
  ])).sort();
}

export function buildDspyRuntimeFingerprints(
  config: CollectionConfig,
  defaults: DspyRuntimeFingerprintDefaults,
): DspyFingerprintSet {
  const openai = config.providers?.openai ?? {};
  const responseApi = openai.response_api ?? {};
  const jina = config.providers?.jina ?? {};
  const query = config.query ?? {};
  const autoRoute = query.auto_route ?? {};
  const graph = config.graphrag ?? {};
  const model = {
    generate: config.models?.generate ?? defaults.generateModel,
    embed: config.models?.embed ?? defaults.embedModel,
    rerank: config.models?.rerank ?? defaults.rerankModel,
  };

  return {
    modelFingerprint: createDeterministicHash({
      generate: model.generate,
    }),
    providerFingerprint: createDeterministicHash({
      openai: {
        apiKeyEnv: openai.api_key_env ?? "OPENAI_API_KEY",
        baseUrlEnv: openai.base_url_env ?? "OPENAI_BASE_URL",
        endpoint: responseApi.endpoint ?? "/responses",
        stream: responseApi.stream ?? true,
        reasoningEffort: responseApi.reasoning_effort ?? "medium",
        strictStructuredOutput: responseApi.strict_structured_output ?? true,
      },
      jina: {
        apiKeyEnv: jina.api_key_env ?? "JINA_API_KEY",
        baseUrlEnv: jina.base_url_env ?? "JINA_API_BASE",
        baseUrl: jina.base_url ?? "https://api.jina.ai",
        embeddingEndpoint: jina.embedding_endpoint ?? "/v1/embeddings",
        rerankEndpoint: jina.rerank_endpoint ?? "/v1/rerank",
        embeddingModel: jina.embedding_model ?? "jina-embeddings-v3",
        rerankModel: jina.rerank_model ?? "jina-reranker-v3",
      },
    }),
    retrievalConfigFingerprint: createDeterministicHash({
      query: {
        defaultRoute: query.default_route ?? "qmd",
        allowGraphUpgrade: query.allow_graph_upgrade ?? true,
        autoRoute: {
          graphCoverageThreshold: autoRoute.graph_coverage_threshold ?? 0.7,
          maxCostClass: autoRoute.max_cost_class ?? "medium",
        },
        expansionPolicyProvider: query.expansion_policy?.provider ?? "builtin",
        expansionFailurePolicy:
          query.expansion_policy?.failure_policy ?? "fallback_to_builtin_expander",
        expansionStrictSchema: query.expansion_policy?.strict_schema ?? true,
      },
      graph: {
        enabled: graph.enabled ?? true,
        defaultMethod: graph.default_method ?? "local",
        defaultResponseType:
          graph.default_response_type ?? "multiple paragraphs",
      },
      models: {
        embed: model.embed,
        rerank: model.rerank,
      },
    }),
    corpusSnapshotFingerprint: createDeterministicHash({
      collections: Object.entries(config.collections ?? {})
        .map(([name, collection]) => ({
          name,
          pattern: collection.pattern,
          ignore: collection.ignore ?? [],
          includeByDefault: collection.includeByDefault ?? true,
          context: collection.context ?? {},
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      globalContext: config.global_context ?? null,
    }),
    indexSnapshotFingerprint: createDeterministicHash({
      collections: Object.keys(config.collections ?? {}).sort(),
      chunking: "qmd-default",
    }),
    retrieverFingerprint: createDeterministicHash({
      embedModel: model.embed,
      vectorStore: "qmd-sqlite-vec",
    }),
    rerankerFingerprint: createDeterministicHash({
      rerankModel: model.rerank,
    }),
    schemaFingerprint: createDeterministicHash({
      schemaVersion: SchemaVersion,
      dspyProgram: "query-expansion-v1",
    }),
  };
}
