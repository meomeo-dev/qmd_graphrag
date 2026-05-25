import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import YAML from "yaml";

import {
  buildGraphRagRuntimeSettingsProjection,
  assertGraphRagStageArtifactsReady,
  assertGraphRagStageReportHealthy,
  checkGraphRagStageReportHealth,
  FileBookJobStateRepository,
  graphRagIndexLogOffset,
  graphRagBookOutputDir,
  SchemaVersion,
  syncGraphRagBookWorkspace,
  writeGraphRagOutputProducerManifest,
  writeManagedGraphRagSettings,
} from "../src/index.js";
import type { CollectionConfig } from "../src/collections.js";
import { createStore } from "../src/store.js";

const TestPythonBin = existsSync(join(process.cwd(), ".venv-graphrag", "bin", "python"))
  ? join(process.cwd(), ".venv-graphrag", "bin", "python")
  : (process.env.PYTHON || "python3");
const HasLanceDbPython = spawnSync(TestPythonBin, [
  "-c",
  "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('lancedb') else 1)",
]).status === 0;
const lanceDbTest = HasLanceDbPython ? test : test.skip;

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qmd-graphrag-workspace-"));
}

async function writeMinimalGraphOutput(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const parquetScript = [
    "import pandas as pd, sys",
    "output_dir = sys.argv[1]",
    "pd.DataFrame([{'id':'graph-doc-1','title':'book.md','text_unit_ids':['tu-1','tu-2']}]).to_parquet(f'{output_dir}/documents.parquet')",
    "pd.DataFrame([{'id':'tu-1','document_id':'graph-doc-1'},{'id':'tu-2','document_id':'graph-doc-1'}]).to_parquet(f'{output_dir}/text_units.parquet')",
    "pd.DataFrame([{'community':'0','title':'report','full_content':'report'}]).to_parquet(f'{output_dir}/community_reports.parquet')",
    "for name in ['entities', 'relationships', 'communities']:",
    "    pd.DataFrame([{'id': f'{name}-1'}]).to_parquet(f'{output_dir}/{name}.parquet')",
  ].join("\n");
  const result = spawnSync(TestPythonBin, ["-c", parquetScript, outputDir], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  await writeFile(join(outputDir, "context.json"), '{"records":[]}', "utf8");
  await writeFile(join(outputDir, "stats.json"), '{"workflows":{}}', "utf8");
}

async function writeMultiDocumentGraphOutput(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const parquetScript = [
    "import pandas as pd, sys",
    "output_dir = sys.argv[1]",
    "pd.DataFrame([",
    "  {'id':'graph-doc-1','title':'book-a.md','text_unit_ids':['tu-1','tu-2']},",
    "  {'id':'graph-doc-2','title':'book-b.md','text_unit_ids':['tu-3']},",
    "]).to_parquet(f'{output_dir}/documents.parquet')",
    "pd.DataFrame([",
    "  {'id':'tu-1','document_id':'graph-doc-1'},",
    "  {'id':'tu-2','document_id':'graph-doc-1'},",
    "  {'id':'tu-3','document_id':'graph-doc-2'},",
    "]).to_parquet(f'{output_dir}/text_units.parquet')",
    "pd.DataFrame([{'community':'0','title':'report','full_content':'report'}]).to_parquet(f'{output_dir}/community_reports.parquet')",
    "for name in ['entities', 'relationships', 'communities']:",
    "    pd.DataFrame([{'id': f'{name}-1'}]).to_parquet(f'{output_dir}/{name}.parquet')",
  ].join("\n");
  const result = spawnSync(TestPythonBin, ["-c", parquetScript, outputDir], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  await writeFile(join(outputDir, "context.json"), '{"records":[]}', "utf8");
  await writeFile(join(outputDir, "stats.json"), '{"workflows":{}}', "utf8");
}

async function writeCompleteLanceDbSidecars(outputDir: string): Promise<void> {
  for (const tableName of [
    "entity_description.lance",
    "community_full_content.lance",
    "text_unit_text.lance",
  ]) {
    const tableDir = join(outputDir, "lancedb", tableName);
    await mkdir(join(tableDir, "data"), { recursive: true });
    await mkdir(join(tableDir, "_versions"), { recursive: true });
    await writeFile(join(tableDir, "data", "part-1.lance"), "rows", "utf8");
    await writeFile(join(tableDir, "_versions", "1.manifest"), "part-1.lance", "utf8");
    await writeFile(
      join(tableDir, "qmd_row_count.json"),
      JSON.stringify({ schemaVersion: SchemaVersion, rowCount: 1 }),
      "utf8",
    );
  }
}

describe("syncGraphRagBookWorkspace", () => {
  const projectConfig: CollectionConfig = {
    collections: {},
    models: {
      embed: "jina:jina-embeddings-v5-text-small",
      rerank: "jina:jina-reranker-v3",
      generate: "openai:gpt-5.4",
    },
    providers: {
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
        embedding_profile: "text",
        embedding_model: "jina-embeddings-v5-text-small",
        rerank_model: "jina-reranker-v3",
        embedding_query_task: "retrieval.query",
        embedding_document_task: "retrieval.passage",
        embedding_dimensions: 1024,
        embedding_normalized: true,
        embedding_type: "float",
        embedding_truncate: true,
      },
    },
    graphrag: {
      enabled: true,
      vault: "graph_vault",
      concurrent_requests: 5,
      default_method: "local",
      default_response_type: "multiple paragraphs",
    },
    query: {
      default_route: "qmd",
      allow_graph_upgrade: true,
      auto_route: {
        graph_coverage_threshold: 0.7,
        max_cost_class: "medium",
      },
    },
  };

  test("projects GraphRAG text input to include normalized markdown", () => {
    const projection = buildGraphRagRuntimeSettingsProjection(projectConfig);
    expect(projection.settings).toMatchObject({
      input: {
        type: "text",
        file_pattern: ".*\\.(md|markdown|txt)",
      },
    });
  });

  test("projects GraphRAG concurrent requests from project config", () => {
    const projection = buildGraphRagRuntimeSettingsProjection({
      ...projectConfig,
      graphrag: {
        ...projectConfig.graphrag,
        concurrent_requests: 4,
      },
    });
    expect(projection.settings.concurrent_requests).toBe(4);
    expect(projection.settings).toMatchObject({
      completion_models: {
        default_chat_model: {
          call_args: {
            qmd_responses_max_concurrency: 4,
          },
        },
      },
    });
  });

  test("defaults GraphRAG concurrent requests to API supported value", () => {
    const projection = buildGraphRagRuntimeSettingsProjection({
      ...projectConfig,
      graphrag: {
        ...projectConfig.graphrag,
        concurrent_requests: undefined,
      },
    });
    expect(projection.settings.concurrent_requests).toBe(5);
    expect(projection.settings).toMatchObject({
      completion_models: {
        default_chat_model: {
          call_args: {
            qmd_responses_max_concurrency: 5,
          },
        },
      },
    });
  });

  test("rejects invalid OpenAI Responses projection settings before runtime", () => {
    const invalidEndpoint: CollectionConfig = {
      ...projectConfig,
      providers: {
        ...projectConfig.providers,
        openai: {
          ...projectConfig.providers?.openai,
          response_api: {
            ...projectConfig.providers?.openai?.response_api,
            endpoint: "/v1/responses",
          },
        },
      },
    };
    const invalidStream: CollectionConfig = {
      ...projectConfig,
      providers: {
        ...projectConfig.providers,
        openai: {
          ...projectConfig.providers?.openai,
          response_api: {
            ...projectConfig.providers?.openai?.response_api,
            stream: false,
          },
        },
      },
    };
    const invalidStrict: CollectionConfig = {
      ...projectConfig,
      providers: {
        ...projectConfig.providers,
        openai: {
          ...projectConfig.providers?.openai,
          response_api: {
            ...projectConfig.providers?.openai?.response_api,
            strict_structured_output: false,
          },
        },
      },
    };

    expect(() =>
      buildGraphRagRuntimeSettingsProjection(invalidEndpoint),
    ).toThrow("/responses");
    expect(() =>
      buildGraphRagRuntimeSettingsProjection(invalidStream),
    ).toThrow("stream");
    expect(() =>
      buildGraphRagRuntimeSettingsProjection(invalidStrict),
    ).toThrow("strict");
  });

  test("projects Jina API base without unsupported placeholder fallback", () => {
    const projection = buildGraphRagRuntimeSettingsProjection({
      ...projectConfig,
      providers: {
        ...projectConfig.providers,
        jina: {
          ...projectConfig.providers?.jina,
          base_url_env: "JINA_API_BASE",
          base_url: "https://api.jina.ai",
        },
      },
    });

    const embedding = (projection.settings.embedding_models as any)
      .default_embedding_model;
    const queryEmbedding = (projection.settings.embedding_models as any)
      .query_embedding_model;
    expect(embedding.api_base).toBe("https://api.jina.ai/v1");
    expect(embedding.model).toBe("jina-embeddings-v5-text-small");
    expect(embedding.call_args.task).toBe("retrieval.passage");
    expect(embedding.call_args.normalized).toBe(true);
    expect(embedding.call_args.embedding_type).toBe("float");
    expect(queryEmbedding.model).toBe("jina-embeddings-v5-text-small");
    expect(queryEmbedding.call_args.task).toBe("retrieval.query");
    expect((projection.settings.local_search as any).embedding_model_id)
      .toBe("query_embedding_model");
    expect((projection.settings.drift_search as any).embedding_model_id)
      .toBe("query_embedding_model");
    expect((projection.settings.basic_search as any).embedding_model_id)
      .toBe("query_embedding_model");
  });

  test("projects multimodal Jina profile as the authoritative embedding model", () => {
    const projection = buildGraphRagRuntimeSettingsProjection({
      ...projectConfig,
      models: {
        ...projectConfig.models,
        embed: "jina:jina-embeddings-v5-text-small",
        rerank: "jina:jina-reranker-v3",
      },
      providers: {
        ...projectConfig.providers,
        jina: {
          ...projectConfig.providers?.jina,
          embedding_profile: "multimodal",
          embedding_document_task: "classification",
          embedding_dimensions: 512,
          embedding_normalized: false,
          embedding_type: "base64",
          embedding_truncate: false,
        },
      },
    });

    const embedding = (projection.settings.embedding_models as any)
      .default_embedding_model;
    const queryEmbedding = (projection.settings.embedding_models as any)
      .query_embedding_model;
    expect(embedding.model).toBe("jina-embeddings-v5-omni-small");
    expect((projection.settings.qmd_graphrag as any).jina.embedding_profile)
      .toBe("multimodal");
    expect(embedding.call_args.task).toBe("retrieval.passage");
    expect(embedding.call_args.dimensions).toBe(1024);
    expect(embedding.call_args.normalized).toBe(true);
    expect(embedding.call_args.embedding_type).toBe("float");
    expect(embedding.call_args.truncate).toBe(true);
    expect(queryEmbedding.model).toBe("jina-embeddings-v5-omni-small");
    expect(queryEmbedding.call_args.task).toBe("retrieval.query");
    expect(queryEmbedding.call_args.dimensions).toBe(1024);
    expect((projection.settings.vector_store as any).vector_size).toBe(1024);
  });

  test("includes provider request boundary in high-cost recovery fingerprints", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      await mkdir(join(graphVault, "output"), { recursive: true });

      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      await writeManagedGraphRagSettings({ config: projectConfig, graphVault });
      const first = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        metadata: {
          api_key: "opaque-redaction-marker",
          hostPath: root,
        },
      });
      await new FileBookJobStateRepository(graphVault).completeStage({
        bookId: first.job.bookId,
        stage: "graph_extract",
        runId: "run-extract-medium",
        inputFingerprint: first.stageFingerprints.graph_extract,
        providerFingerprint: first.job.providerFingerprint,
      });

      const changedConfig: CollectionConfig = {
        ...projectConfig,
        providers: {
          ...projectConfig.providers,
          openai: {
            ...projectConfig.providers?.openai,
            response_api: {
              ...projectConfig.providers?.openai?.response_api,
              reasoning_effort: "high",
            },
          },
        },
      };
      await writeManagedGraphRagSettings({ config: changedConfig, graphVault });
      const second = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        metadata: {
          api_key: "opaque-redaction-marker",
          hostPath: root,
        },
      });
      expect(second.resumePlan.nextStage).toBe("graph_extract");
      expect(second.resumePlan.staleStages).toContain("graph_extract");

      for (const file of [
        "documents.parquet",
        "text_units.parquet",
        "entities.parquet",
        "relationships.parquet",
        "communities.parquet",
      ]) {
        await writeFile(join(graphVault, "output", file), file, "utf8");
      }
      await writeFile(join(graphVault, "output", "context.json"), '{"records":[]}', "utf8");
      await writeFile(join(graphVault, "output", "stats.json"), '{"workflows":{}}', "utf8");
      const recovered = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        metadata: {
          api_key: "opaque-redaction-marker",
          hostPath: root,
        },
      });
      const jobRaw = await readFile(join(graphVault, "catalog", "books.yaml"), "utf8");
      const artifacts = YAML.parse(await readFile(
        join(graphVault, "books", recovered.job.bookId, "artifacts.yaml"),
        "utf8",
      )) as { items: Array<{ stage: string; providerFingerprint?: string }> };
      const checkpoints = YAML.parse(await readFile(
        join(graphVault, "books", recovered.job.bookId, "checkpoints.yaml"),
        "utf8",
      )) as { items: Array<{ stage: string; providerFingerprint?: string }> };
      const highCostStages = new Set([
        "graph_extract",
        "community_report",
        "embed",
        "query_ready",
      ]);

      expect(second.job.providerFingerprint).not.toBe(first.job.providerFingerprint);
      expect(second.stageFingerprints.graph_extract)
        .not.toBe(first.stageFingerprints.graph_extract);
      for (const item of artifacts.items.filter((artifact) =>
        highCostStages.has(artifact.stage) &&
        artifact.stageFingerprint === recovered.stageFingerprints[artifact.stage as keyof typeof recovered.stageFingerprints]
      )) {
        expect(item.providerFingerprint).toBe(recovered.job.providerFingerprint);
      }
      for (const item of checkpoints.items.filter((checkpoint) =>
        highCostStages.has(checkpoint.stage) &&
        checkpoint.inputFingerprint === recovered.stageFingerprints[checkpoint.stage as keyof typeof recovered.stageFingerprints]
      )) {
        expect(item.providerFingerprint).toBe(recovered.job.providerFingerprint);
      }
      expect(recovered.resumePlan.nextStage).toBe("graph_extract");
      expect(jobRaw).not.toContain("opaque-redaction-marker");
      expect(jobRaw).not.toContain(root);
      expect(jobRaw).toContain("providerBoundaryFingerprint");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not bootstrap GraphRAG stages from shared output", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      await mkdir(join(graphVault, "output"), { recursive: true });
      await mkdir(join(graphVault, "reports"), { recursive: true });

      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");

      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(
        join(graphVault, "settings.yaml"),
        [
          "completion_models:",
          "  default_chat_model:",
          "    type: openai_responses",
          "    model: gpt-5.4",
          "embedding_models:",
          "  default_embedding_model:",
          "    type: litellm",
          "    model: jina-embeddings-v5-text-small",
          "concurrent_requests: 1",
          "vector_store:",
          "  type: lancedb",
          "  db_uri: ./output/lancedb",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(graphVault, "prompts", "community_report_text.txt"),
        "prompt-a",
        "utf8",
      );
      await writeFile(
        join(graphVault, "prompts", "extract_graph.txt"),
        "prompt-b",
        "utf8",
      );

      for (const file of [
        "documents.parquet",
        "text_units.parquet",
        "entities.parquet",
        "relationships.parquet",
        "communities.parquet",
      ]) {
        await writeFile(join(graphVault, "output", file), file, "utf8");
      }
      await writeFile(
        join(graphVault, "output", "context.json"),
        '{"records":[]}',
        "utf8",
      );
      await writeFile(
        join(graphVault, "output", "stats.json"),
        '{"workflows":{}}',
        "utf8",
      );
      await writeFile(
        join(graphVault, "reports", "indexing-engine.log"),
        "partial run",
        "utf8",
      );

      const state = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
      });

      expect(state.resumePlan.nextStage).toBe("graph_extract");
      expect(state.resumePlan.completedStages).toEqual([
        "ingest",
        "normalize",
      ]);

      const repo = new FileBookJobStateRepository(graphVault);
      const checkpoints = await repo.listStageCheckpoints(state.job.bookId);
      const sourceArtifacts = state.artifacts.filter(
        (item) => item.kind === "source_epub",
      );

      expect(state.job.sourcePath).toMatch(/^sources\/.+\/source\.epub$/);
      expect(state.job.sourcePath).not.toContain(root);
      expect(state.job.metadata?.normalizedPath).toBe("input/book.md");
      expect(sourceArtifacts).toHaveLength(1);
      expect(sourceArtifacts[0]?.path).toBe(state.job.sourcePath);
      expect(checkpoints.map((item) => item.stage)).toEqual([
        "ingest",
        "normalize",
      ]);
      const records = await repo.listRunRecords(state.job.bookId);
      for (const checkpoint of checkpoints) {
        const record = records.find((item) => item.runId === checkpoint.runId);
        expect(record?.stage).toBe(checkpoint.stage);
      }
      expect(new Set(checkpoints.map((item) => item.runId)).size).toBe(
        checkpoints.length,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not mark embed complete from a partial LanceDB directory", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      await mkdir(join(graphVault, "output", "lancedb"), { recursive: true });
      await mkdir(
        join(graphVault, "output", "lancedb", "entity_description.lance", "data"),
        { recursive: true },
      );
      await mkdir(
        join(graphVault, "output", "lancedb", "entity_description.lance", "_versions"),
        { recursive: true },
      );

      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");

      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "settings.yaml"), "vector_store: {}\n", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");
      await writeFile(
        join(graphVault, "output", "community_reports.parquet"),
        "reports",
        "utf8",
      );
      await writeFile(
        join(
          graphVault,
          "output",
          "lancedb",
          "entity_description.lance",
          "data",
          "part.lance",
        ),
        "partial",
        "utf8",
      );
      await writeFile(
        join(
          graphVault,
          "output",
          "lancedb",
          "entity_description.lance",
          "_versions",
          "1.manifest",
        ),
        "partial",
        "utf8",
      );

      const state = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
      });

      expect(state.resumePlan.nextStage).toBe("graph_extract");
      expect(state.artifacts.some((item) => item.kind === "lancedb_index")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects GraphRAG stage reports with provider or partial-output errors", async () => {
    const root = await createWorkspace();
    try {
      const outputDir = join(root, "graph_vault", "books", "book-1", "output");
      const reportDir = join(outputDir, "reports");
      await mkdir(reportDir, { recursive: true });
      const logPath = join(reportDir, "indexing-engine.log");
      await writeFile(
        logPath,
        "2026-05-24 INFO old stage completed\n" +
          "2026-05-24 ERROR old Concurrency limit exceeded for user\n",
        "utf8",
      );
      const offset = await graphRagIndexLogOffset(outputDir);

      let health = await checkGraphRagStageReportHealth({
        outputDir,
        stage: "community_report",
        logStartOffset: offset,
      });
      expect(health.healthy).toBe(true);

      await writeFile(
        logPath,
        "2026-05-24 INFO old stage completed\n" +
          "2026-05-24 ERROR old Concurrency limit exceeded for user\n" +
          "2026-05-24 07:22:39.0811 - DEBUG - graphrag.api.index - " +
          "[{'text':'This book discusses timeout and connection reset errors'}]\n",
        "utf8",
      );
      health = await checkGraphRagStageReportHealth({
        outputDir,
        stage: "graph_extract",
        logStartOffset: offset,
      });
      expect(health.healthy).toBe(true);

      await writeFile(
        logPath,
        "2026-05-24 INFO old stage completed\n" +
          "2026-05-24 ERROR old Concurrency limit exceeded for user\n" +
          "2026-05-24 ERROR Community Report Extraction Error\n" +
          "2026-05-24 WARNING No report found for community: 16\n",
        "utf8",
      );
      health = await checkGraphRagStageReportHealth({
        outputDir,
        stage: "community_report",
        logStartOffset: offset,
      });
      expect(health).toMatchObject({
        healthy: false,
        stage: "community_report",
        failureKind: "partial_output",
      });
      await expect(assertGraphRagStageReportHealthy({
        outputDir,
        stage: "community_report",
        logStartOffset: offset,
      })).rejects.toThrow("GraphRAG stage report contains recoverable provider");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records GraphRAG text unit identity in the document identity map", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      await mkdir(join(graphVault, "output"), { recursive: true });
      await mkdir(join(graphVault, "reports"), { recursive: true });

      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");

      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "settings.yaml"), "vector_store: {}\n", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const initial = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        recordRecoveredStages: false,
      });
      const outputDir = graphRagBookOutputDir({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
      });
      await writeMinimalGraphOutput(outputDir);
      await writeCompleteLanceDbSidecars(outputDir);
      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "real-test-run",
        stage: "graph_extract",
      });
      const state = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        recordRecoveredStages: false,
      });

      const raw = YAML.parse(await readFile(
        join(graphVault, "catalog", "document-identity-map.yaml"),
        "utf8",
      )) as {
        items: Array<{
          documentId: string;
          graphDocumentId?: string;
          graphTextUnitIds?: string[];
        }>;
      };
      const identity = raw.items.find((item) => item.documentId === state.job.documentId);

      expect(identity?.graphDocumentId).toBe("graph-doc-1");
      expect(identity?.graphTextUnitIds).toEqual(["tu-1", "tu-2"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("repairs missing catalog graph identity from a validated sidecar", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });

      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeManagedGraphRagSettings({ config: projectConfig, graphVault });
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const initial = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        projectConfig,
        recordRecoveredStages: false,
      });
      const outputDir = graphRagBookOutputDir({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
      });
      await writeMultiDocumentGraphOutput(outputDir);
      await writeCompleteLanceDbSidecars(outputDir);
      for (const stage of [
        "graph_extract",
        "community_report",
        "embed",
      ] as const) {
        await writeGraphRagOutputProducerManifest({
          outputDir,
          bookId: initial.job.bookId,
          sourceHash: initial.job.sourceHash,
          documentId: initial.job.documentId,
          contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
          stageFingerprints: initial.stageFingerprints,
          providerFingerprint: initial.job.providerFingerprint!,
          producerRunId: `real-${stage}`,
          stage,
        });
      }
      await writeFile(
        join(outputDir, "qmd_graph_text_unit_identity.json"),
        JSON.stringify({
          schemaVersion: SchemaVersion,
          bookId: initial.job.bookId,
          sourceId: `sha256:${initial.job.sourceHash}`,
          sourceHash: initial.job.sourceHash,
          documentId: initial.job.documentId,
          contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
          normalizedPath: initial.job.normalizedPath,
          graphDocumentId: "graph-doc-1",
          graphTextUnitIds: ["tu-1", "tu-2"],
        }, null, 2),
        "utf8",
      );

      const synced = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        projectConfig,
        recordRecoveredStages: false,
      });
      const catalog = YAML.parse(await readFile(
        join(graphVault, "catalog", "document-identity-map.yaml"),
        "utf8",
      )) as {
        items: Array<{
          documentId: string;
          graphDocumentId?: string;
          graphTextUnitIds?: string[];
          metadata?: Record<string, unknown>;
        }>;
      };
      const identity = catalog.items.find((item) =>
        item.documentId === synced.job.documentId
      );

      expect(identity?.metadata?.qmdCorpusRegistered).toBe(true);
      expect(identity?.graphDocumentId).toBe("graph-doc-1");
      expect(identity?.graphTextUnitIds).toEqual(["tu-1", "tu-2"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects mismatched or stale GraphRAG identity sidecars", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });

      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeManagedGraphRagSettings({ config: projectConfig, graphVault });
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const initial = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        projectConfig,
        recordRecoveredStages: false,
      });
      const outputDir = graphRagBookOutputDir({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
      });
      await writeMultiDocumentGraphOutput(outputDir);
      await writeCompleteLanceDbSidecars(outputDir);
      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "real-graph-extract",
        stage: "graph_extract",
      });
      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "real-community-report",
        stage: "community_report",
      });
      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "real-embed",
        stage: "embed",
      });
      await writeFile(
        join(outputDir, "qmd_graph_text_unit_identity.json"),
        JSON.stringify({
          schemaVersion: SchemaVersion,
          bookId: initial.job.bookId,
          sourceId: `sha256:${initial.job.sourceHash}`,
          sourceHash: initial.job.sourceHash,
          documentId: initial.job.documentId,
          contentHash: "stale-content-hash",
          normalizedPath: initial.job.normalizedPath,
          graphDocumentId: "graph-doc-1",
          graphTextUnitIds: ["tu-1", "tu-2"],
        }, null, 2),
        "utf8",
      );

      await expect(syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        projectConfig,
        recordRecoveredStages: false,
      })).rejects.toThrow("sidecar does not match");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps producer manifest portable and stage-scoped", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "settings.yaml"), "vector_store: {}\n", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const initial = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        recordRecoveredStages: false,
      });
      const outputDir = graphRagBookOutputDir({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
      });
      await writeMinimalGraphOutput(outputDir);
      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "graph-run",
        stage: "graph_extract",
      });

      const manifest = JSON.parse(await readFile(
        join(outputDir, "qmd_output_manifest.json"),
        "utf8",
      ));
      expect(manifest.outputDir).toBe(`books/${initial.job.bookId}/output`);
      expect(manifest.outputDir).not.toContain(root);
      expect(manifest.stageProducerRunIds).toMatchObject({
        graph_extract: "graph-run",
      });

      const synced = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        recordRecoveredStages: false,
      });
      await expect(assertGraphRagStageArtifactsReady({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
        stage: "community_report",
        producerRunId: "graph-run",
        artifacts: synced.artifacts,
      })).rejects.toThrow("GraphRAG stage did not produce valid book-scoped artifacts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drops stale producer run ids when rewriting a producer manifest", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "settings.yaml"), "vector_store: {}\n", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const initial = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        recordRecoveredStages: false,
      });
      const outputDir = graphRagBookOutputDir({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
      });
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        join(outputDir, "qmd_output_manifest.json"),
        JSON.stringify({
          schemaVersion: SchemaVersion,
          bookId: "book-stale",
          sourceHash: "stale-source",
          documentId: "doc-stale",
          contentHash: "stale-content",
          stageFingerprints: initial.stageFingerprints,
          providerFingerprint: initial.job.providerFingerprint,
          outputDir: "books/book-stale/output",
          producerRunId: "stale-query-ready",
          stageProducerRunIds: {
            graph_extract: "stale-graph-extract",
            community_report: "stale-community-report",
            embed: "stale-embed",
          },
        }, null, 2),
        "utf8",
      );

      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "current-query-ready",
        stage: "query_ready",
      });

      const manifest = JSON.parse(await readFile(
        join(outputDir, "qmd_output_manifest.json"),
        "utf8",
      ));
      expect(manifest.bookId).toBe(initial.job.bookId);
      expect(manifest.stageProducerRunIds).toEqual({
        query_ready: "current-query-ready",
      });
      expect(JSON.stringify(manifest)).not.toContain("stale-");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts pyarrow parquet artifacts produced by a real GraphRAG stage", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "settings.yaml"), "vector_store: {}\n", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const initial = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        recordRecoveredStages: false,
      });
      const outputDir = graphRagBookOutputDir({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
      });
      await writeMinimalGraphOutput(outputDir);
      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "real-graph-run",
        stage: "graph_extract",
      });

      const synced = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        recordRecoveredStages: false,
      });
      await expect(assertGraphRagStageArtifactsReady({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
        stage: "graph_extract",
        producerRunId: "real-graph-run",
        artifacts: synced.artifacts,
      })).resolves.toEqual(
        expect.arrayContaining(
          synced.artifacts
            .filter((item) =>
              item.stage === "graph_extract" &&
              item.producerRunId === "real-graph-run" &&
              item.kind.endsWith("_parquet")
            )
            .map((item) => item.artifactId),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects graph_extract readiness when stats sidecar changes", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "settings.yaml"), "vector_store: {}\n", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const initial = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        recordRecoveredStages: false,
      });
      const outputDir = graphRagBookOutputDir({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
      });
      await writeMinimalGraphOutput(outputDir);
      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "graph-run",
        stage: "graph_extract",
      });
      const synced = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        recordRecoveredStages: false,
      });
      await writeFile(join(outputDir, "stats.json"), '{"workflows":{"later":1}}', "utf8");

      await expect(assertGraphRagStageArtifactsReady({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
        stage: "graph_extract",
        producerRunId: "graph-run",
        artifacts: synced.artifacts,
      })).rejects.toThrow("GraphRAG stage did not produce valid book-scoped artifacts");
      expect(
        synced.artifacts.some((artifact) =>
          artifact.kind === "graphrag_stats_json" &&
          artifact.producerRunId === "graph-run"
        ),
      ).toBe(true);

    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes query-ready from book-scoped validated artifacts", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      await mkdir(join(graphVault, "output"), { recursive: true });

      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeManagedGraphRagSettings({ config: projectConfig, graphVault });
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const initial = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        projectConfig,
      });
      const outputDir = graphRagBookOutputDir({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
      });
      await writeMinimalGraphOutput(outputDir);
      await writeCompleteLanceDbSidecars(outputDir);
      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "real-graph-extract",
        stage: "graph_extract",
      });
      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "real-community-report",
        stage: "community_report",
      });
      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "real-embed",
        stage: "embed",
      });

      const syncedArtifacts = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        projectConfig,
        recordRecoveredStages: false,
      });
      const repo = new FileBookJobStateRepository(graphVault);
      await repo.completeStage({
        bookId: syncedArtifacts.job.bookId,
        stage: "graph_extract",
        runId: "real-graph-extract",
        inputFingerprint: syncedArtifacts.stageFingerprints.graph_extract,
        stageFingerprint: syncedArtifacts.stageFingerprints.graph_extract,
        providerFingerprint: syncedArtifacts.job.providerFingerprint,
        artifactIds: syncedArtifacts.artifacts
          .filter((item) => item.stage === "graph_extract")
          .map((item) => item.artifactId),
      });
      await repo.completeStage({
        bookId: syncedArtifacts.job.bookId,
        stage: "community_report",
        runId: "real-community-report",
        inputFingerprint: syncedArtifacts.stageFingerprints.community_report,
        stageFingerprint: syncedArtifacts.stageFingerprints.community_report,
        providerFingerprint: syncedArtifacts.job.providerFingerprint,
        artifactIds: syncedArtifacts.artifacts
          .filter((item) => item.stage === "community_report")
          .map((item) => item.artifactId),
      });
      await repo.completeStage({
        bookId: syncedArtifacts.job.bookId,
        stage: "embed",
        runId: "real-embed",
        inputFingerprint: syncedArtifacts.stageFingerprints.embed,
        stageFingerprint: syncedArtifacts.stageFingerprints.embed,
        providerFingerprint: syncedArtifacts.job.providerFingerprint,
        artifactIds: syncedArtifacts.artifacts
          .filter((item) => item.stage === "embed")
          .map((item) => item.artifactId),
      });
      await repo.completeStage({
        bookId: syncedArtifacts.job.bookId,
        stage: "query_ready",
        runId: "real-query-ready",
        inputFingerprint: syncedArtifacts.stageFingerprints.query_ready,
        stageFingerprint: syncedArtifacts.stageFingerprints.query_ready,
        providerFingerprint: syncedArtifacts.job.providerFingerprint,
        artifactIds: syncedArtifacts.artifacts
          .filter((item) =>
            item.stage === "community_report" || item.stage === "embed"
          )
          .map((item) => item.artifactId),
      });
      const state = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        projectConfig,
        recordRecoveredStages: false,
      });
      const capabilities = await new FileBookJobStateRepository(graphVault)
        .listStageCheckpoints(state.job.bookId);
      const queryReady = capabilities.find((item) => item.stage === "query_ready");
      const queryReadyArtifactIds = await assertGraphRagStageArtifactsReady({
        stateRootDir: graphVault,
        bookId: syncedArtifacts.job.bookId,
        stage: "query_ready",
        producerRunId: "real-query-ready",
        artifacts: syncedArtifacts.artifacts,
        expectedProducerRunIds: {
          graph_extract: "real-graph-extract",
          community_report: "real-community-report",
          embed: "real-embed",
        },
        expectedStageFingerprints: syncedArtifacts.stageFingerprints,
        expectedProviderFingerprint: syncedArtifacts.job.providerFingerprint,
        expectedCorpusContentHash:
          syncedArtifacts.job.normalizedContentHash ?? syncedArtifacts.job.sourceHash,
      });

      expect(state.resumePlan.canQuery).toBe(true);
      expect(queryReady?.artifactIds).toHaveLength(2);
      expect(queryReadyArtifactIds).toEqual(expect.arrayContaining(
        queryReady?.artifactIds ?? [],
      ));
      await expect(assertGraphRagStageArtifactsReady({
        stateRootDir: graphVault,
        bookId: syncedArtifacts.job.bookId,
        stage: "query_ready",
        producerRunId: "real-query-ready",
        artifacts: syncedArtifacts.artifacts,
        expectedProducerRunIds: {
          graph_extract: "real-graph-extract",
          community_report: "old-community-report",
          embed: "real-embed",
        },
        expectedStageFingerprints: syncedArtifacts.stageFingerprints,
        expectedProviderFingerprint: syncedArtifacts.job.providerFingerprint,
        expectedCorpusContentHash:
          syncedArtifacts.job.normalizedContentHash ?? syncedArtifacts.job.sourceHash,
      })).rejects.toThrow(
        "query_ready producer did not produce valid book-scoped artifacts",
      );
      const qmdStore = createStore(join(root, ".qmd", "index.sqlite"));
      try {
        const row = qmdStore.db.prepare(`
          SELECT d.path, d.hash
          FROM documents d
          WHERE d.collection = 'books' AND d.active = 1
        `).get() as { path: string; hash: string } | undefined;
        expect(row?.path).toBe("book.md");
        expect(row?.hash).toBe(state.job.normalizedContentHash);
      } finally {
        qmdStore.close();
      }
      expect(state.artifacts.find((item) => item.kind === "lancedb_index")?.stage)
        .toBe("embed");
      const checkpoints = await repo.listStageCheckpoints(state.job.bookId);
      const records = await repo.listRunRecords(state.job.bookId);
      for (const checkpoint of checkpoints) {
        const record = records.find((item) => item.runId === checkpoint.runId);
        expect(record?.stage).toBe(checkpoint.stage);
      }
      expect(new Set(checkpoints.map((item) => item.runId)).size).toBe(
        checkpoints.length,
      );
      expect(
        state.artifacts.find((item) =>
          item.kind === "graphrag_community_reports_parquet"
        )?.stage,
      ).toBe("community_report");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  lanceDbTest(
    "writes row-count sidecars from real LanceDB tables with .lance directories",
    async () => {
      const root = await createWorkspace();
      try {
        const graphVault = join(root, "graph_vault");
        await mkdir(join(graphVault, "input"), { recursive: true });
        await mkdir(join(graphVault, "prompts"), { recursive: true });
        await mkdir(join(graphVault, "output"), { recursive: true });

        const sourcePath = join(root, "book.epub");
        const normalizedPath = join(graphVault, "input", "book.md");
        await writeFile(sourcePath, "epub-bytes", "utf8");
        await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
        await writeManagedGraphRagSettings({ config: projectConfig, graphVault });
        await writeFile(
          join(graphVault, "prompts", "extract_graph.txt"),
          "prompt",
          "utf8",
        );

        const initial = await syncGraphRagBookWorkspace({
          stateRootDir: graphVault,
          sourcePath,
          normalizedPath,
          settingsPath: join(graphVault, "settings.yaml"),
          promptsDir: join(graphVault, "prompts"),
          outputDir: join(graphVault, "output"),
          qmdIndexPath: join(root, ".qmd", "index.sqlite"),
          projectConfig,
          recordRecoveredStages: false,
        });
        const outputDir = graphRagBookOutputDir({
          stateRootDir: graphVault,
          bookId: initial.job.bookId,
        });
        await mkdir(outputDir, { recursive: true });

        const setupScript = [
          "import lancedb, pandas as pd, sys",
          "output_dir, lancedb_dir = sys.argv[1:3]",
          "pd.DataFrame([{'id':'graph-doc-1','title':'book.md','text_unit_ids':['tu-1']}]).to_parquet(f'{output_dir}/documents.parquet')",
          "pd.DataFrame([{'id':'tu-1','document_id':'graph-doc-1'}]).to_parquet(f'{output_dir}/text_units.parquet')",
          "pd.DataFrame([{'community':'0','title':'report','full_content':'report'}]).to_parquet(f'{output_dir}/community_reports.parquet')",
          "for name in ['entities', 'relationships', 'communities']:",
          "    pd.DataFrame([{'id': f'{name}-1'}]).to_parquet(f'{output_dir}/{name}.parquet')",
          "db = lancedb.connect(lancedb_dir)",
          "rows = [{'id':'row-1','text':'hello','vector':[0.1,0.2,0.3]}]",
          "for name in ['entity_description', 'community_full_content', 'text_unit_text']:",
          "    db.create_table(name, data=rows, mode='overwrite')",
        ].join("\n");
        const setup = spawnSync(TestPythonBin, [
          "-c",
          setupScript,
          outputDir,
          join(outputDir, "lancedb"),
        ], { encoding: "utf8" });
        expect(setup.status, setup.stderr).toBe(0);
        await writeFile(
          join(outputDir, "context.json"),
          '{"records":[]}',
          "utf8",
        );
        await writeFile(
          join(outputDir, "stats.json"),
          '{"workflows":{}}',
          "utf8",
        );
        await writeGraphRagOutputProducerManifest({
          outputDir,
          bookId: initial.job.bookId,
          sourceHash: initial.job.sourceHash,
          documentId: initial.job.documentId,
          contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
          stageFingerprints: initial.stageFingerprints,
          providerFingerprint: initial.job.providerFingerprint!,
          producerRunId: "real-lancedb-test-run",
        });

        const state = await syncGraphRagBookWorkspace({
          stateRootDir: graphVault,
          sourcePath,
          normalizedPath,
          settingsPath: join(graphVault, "settings.yaml"),
          promptsDir: join(graphVault, "prompts"),
          outputDir: join(graphVault, "output"),
          qmdIndexPath: join(root, ".qmd", "index.sqlite"),
          projectConfig,
        });
        const rowCountRaw = await readFile(
          join(
            outputDir,
            "lancedb",
            "entity_description.lance",
            "qmd_row_count.json",
          ),
          "utf8",
        );
        const rowCount = JSON.parse(rowCountRaw) as { rowCount?: number };

        expect(rowCount.rowCount).toBe(1);
        expect(state.resumePlan.nextStage).toBe("graph_extract");
        expect(state.artifacts.some((item) => item.kind === "lancedb_index"))
          .toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("canonicalizes legacy book ids and restores typed catalogs", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      await mkdir(join(graphVault, "output"), { recursive: true });

      const sourceName = "A Philosophy of Software Design (John K. Ousterhout).epub";
      const sourcePath = join(root, sourceName);
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "settings.yaml"), "vector_store: {}\n", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const repo = new FileBookJobStateRepository(graphVault);
      const oldState = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        sourceIdentityPath: sourceName,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        recordRecoveredStages: false,
      });
      const stableBookId = oldState.job.bookId;
      const legacyBookId = `a-philosophy-of-software-design-john-k-ousterhout-${
        oldState.job.sourceHash.slice(0, 12)
      }`;

      await rename(
        join(graphVault, "books", stableBookId),
        join(graphVault, "books", legacyBookId),
      );
      await mkdir(join(graphVault, "sources"), { recursive: true });
      await rename(
        join(graphVault, "sources", stableBookId),
        join(graphVault, "sources", legacyBookId),
      );
      for (const filePath of [
        join(graphVault, "books", legacyBookId, "job.yaml"),
        join(graphVault, "catalog", "books.yaml"),
        join(graphVault, "catalog", "sources.yaml"),
        join(graphVault, "catalog", "document-identity-map.yaml"),
      ]) {
        const raw = (await readFile(filePath, "utf8"))
          .split(stableBookId)
          .join(legacyBookId);
        await writeFile(filePath, raw, "utf8");
      }

      const state = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        sourceIdentityPath: sourceName,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        recordRecoveredStages: false,
      });
      const books = YAML.parse(await readFile(
        join(graphVault, "catalog", "books.yaml"),
        "utf8",
      )) as { items: Array<{ bookId?: string; sourcePath?: string }> };
      const sources = YAML.parse(await readFile(
        join(graphVault, "catalog", "sources.yaml"),
        "utf8",
      )) as { items: Array<{ metadata?: { bookId?: string } }> };
      const identities = YAML.parse(await readFile(
        join(graphVault, "catalog", "document-identity-map.yaml"),
        "utf8",
      )) as { items: Array<{ canonicalBookId?: string; metadata?: { bookId?: string } }> };

      expect(state.job.bookId).toBe(stableBookId);
      expect(state.job.sourcePath).toBe(`sources/${stableBookId}/source.epub`);
      expect(books.items.map((item) => item.bookId)).toEqual([stableBookId]);
      expect(books.items[0]?.sourcePath).toBe(`sources/${stableBookId}/source.epub`);
      expect(sources.items[0]?.metadata?.bookId).toBe(stableBookId);
      expect(identities.items[0]?.canonicalBookId).toBe(stableBookId);
      expect(identities.items[0]?.metadata?.bookId).toBe(stableBookId);
      expect(await repo.getBookJob(legacyBookId)).toBeNull();
      expect(await repo.getBookJob(stableBookId)).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deduplicates old and stable document identities during legacy remap", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });

      const sourceName = "A Philosophy of Software Design (John K. Ousterhout).epub";
      const sourcePath = join(root, sourceName);
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "settings.yaml"), "vector_store: {}\n", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const oldState = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        sourceIdentityPath: sourceName,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        recordRecoveredStages: false,
      });
      const stableBookId = oldState.job.bookId;
      const legacyBookId = `a-philosophy-of-software-design-john-k-ousterhout-${
        oldState.job.sourceHash.slice(0, 12)
      }`;
      const catalogPath = join(graphVault, "catalog", "document-identity-map.yaml");
      const catalog = YAML.parse(await readFile(catalogPath, "utf8")) as {
        items: Array<Record<string, unknown>>;
      };
      const stableIdentity = catalog.items[0]!;
      catalog.items.push({
        ...stableIdentity,
        canonicalBookId: legacyBookId,
        chunkIds: ["legacy-chunk"],
        graphDocumentId: "legacy-graph-doc",
        graphTextUnitIds: ["legacy-tu"],
        metadata: {
          bookId: legacyBookId,
          graphDocumentId: "legacy-graph-doc",
          graphTextUnitCount: 1,
        },
      });
      await writeFile(
        catalogPath,
        YAML.stringify({ schemaVersion: SchemaVersion, items: catalog.items }),
        "utf8",
      );
      await rename(
        join(graphVault, "books", stableBookId),
        join(graphVault, "books", legacyBookId),
      );
      await mkdir(join(graphVault, "sources"), { recursive: true });
      await rename(
        join(graphVault, "sources", stableBookId),
        join(graphVault, "sources", legacyBookId),
      );

      await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        sourceIdentityPath: sourceName,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        recordRecoveredStages: false,
      });
      const remapped = YAML.parse(await readFile(catalogPath, "utf8")) as {
        items: Array<{
          canonicalBookId?: string;
          documentId?: string;
          chunkIds?: string[];
          graphDocumentId?: string;
          graphTextUnitIds?: string[];
        }>;
      };
      const identities = remapped.items.filter((item) =>
        item.canonicalBookId === stableBookId &&
        item.documentId === oldState.job.documentId
      );

      expect(identities).toHaveLength(1);
      expect(identities[0]?.chunkIds?.length).toBeGreaterThan(0);
      expect(identities[0]?.graphDocumentId).toBe("legacy-graph-doc");
      expect(identities[0]?.graphTextUnitIds).toEqual(["legacy-tu"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects drifted GraphRAG settings when project config is supplied", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      await mkdir(join(graphVault, "output"), { recursive: true });

      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeManagedGraphRagSettings({ config: projectConfig, graphVault });
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const driftedConfig: CollectionConfig = {
        ...projectConfig,
        models: {
          ...projectConfig.models,
          generate: "openai:gpt-5.4-drifted",
        },
      };

      await expect(syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        projectConfig: driftedConfig,
      })).rejects.toThrow("managed projection");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects managed GraphRAG settings when projection body is mutated", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      await mkdir(join(graphVault, "output"), { recursive: true });

      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeManagedGraphRagSettings({ config: projectConfig, graphVault });
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const raw = await readFile(join(graphVault, "settings.yaml"), "utf8");
      const parsed = YAML.parse(raw) as Record<string, unknown>;
      parsed.concurrent_requests = 99;
      await writeFile(join(graphVault, "settings.yaml"), YAML.stringify(parsed), "utf8");

      await expect(syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        qmdIndexPath: join(root, ".qmd", "index.sqlite"),
        projectConfig,
      })).rejects.toThrow("managed projection");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects query-ready publication without qmd corpus registration", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      await mkdir(join(graphVault, "output"), { recursive: true });

      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "settings.yaml"), "vector_store: {}\n", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const initial = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
        recordRecoveredStages: false,
      });
      const outputDir = graphRagBookOutputDir({
        stateRootDir: graphVault,
        bookId: initial.job.bookId,
      });
      const documentsPath = join(outputDir, "documents.parquet");
      const textUnitsPath = join(outputDir, "text_units.parquet");
      const reportsPath = join(outputDir, "community_reports.parquet");
      await mkdir(outputDir, { recursive: true });

      const parquetScript = [
        "import pandas as pd, sys",
        "documents_path, text_units_path, reports_path = sys.argv[1:4]",
        "pd.DataFrame([{'id':'graph-doc-1','title':'book.md','text_unit_ids':['tu-1']}]).to_parquet(documents_path)",
        "pd.DataFrame([{'id':'tu-1','document_id':'graph-doc-1'}]).to_parquet(text_units_path)",
        "pd.DataFrame([{'community':'0','title':'report','full_content':'report'}]).to_parquet(reports_path)",
      ].join("\n");
      const result = spawnSync(TestPythonBin, [
        "-c",
        parquetScript,
        documentsPath,
        textUnitsPath,
        reportsPath,
      ], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);

      await writeFile(join(outputDir, "context.json"), '{"records":[]}', "utf8");
      await writeFile(join(outputDir, "stats.json"), '{"workflows":{}}', "utf8");
      await writeCompleteLanceDbSidecars(outputDir);
      await writeGraphRagOutputProducerManifest({
        outputDir,
        bookId: initial.job.bookId,
        sourceHash: initial.job.sourceHash,
        documentId: initial.job.documentId,
        contentHash: initial.job.normalizedContentHash ?? initial.job.sourceHash,
        stageFingerprints: initial.stageFingerprints,
        providerFingerprint: initial.job.providerFingerprint!,
        producerRunId: "real-query-ready-test-run",
      });

      await expect(syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
      })).rejects.toThrow("qmd corpus registration is required");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires current producer artifacts before completing GraphRAG stages", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "books", "book-1", "output"), {
        recursive: true,
      });
      const repo = new FileBookJobStateRepository(graphVault);
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await repo.registerBookSource({
        sourcePath,
        sourceIdentityPath: "book.epub",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
        stageFingerprints: { graph_extract: "fp-graph" },
        providerFingerprint: "provider-1",
        normalizedContentHash: "content-1",
      });
      const [oldArtifact] = await repo.recordArtifacts("book-1", [
        {
          stage: "graph_extract",
          kind: "graphrag_documents_parquet",
          path: join(graphVault, "books", "book-1", "output", "missing.parquet"),
          contentHash: "missing-hash",
          stageFingerprint: "fp-graph",
          providerFingerprint: "provider-1",
          producerRunId: "old-run",
        },
      ]);

      await expect(assertGraphRagStageArtifactsReady({
        stateRootDir: graphVault,
        bookId: "book-1",
        stage: "graph_extract",
        producerRunId: "new-run",
        artifacts: [oldArtifact!],
      })).rejects.toThrow("GraphRAG stage did not produce valid book-scoped artifacts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
