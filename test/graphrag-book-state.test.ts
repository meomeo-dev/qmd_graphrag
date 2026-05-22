import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import YAML from "yaml";

import {
  buildGraphRagRuntimeSettingsProjection,
  FileBookJobStateRepository,
  SchemaVersion,
  syncGraphRagBookWorkspace,
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

describe("syncGraphRagBookWorkspace", () => {
  const projectConfig: CollectionConfig = {
    collections: {},
    models: {
      embed: "jina:jina-embeddings-v3",
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
        embedding_model: "jina-embeddings-v3",
        rerank_model: "jina-reranker-v3",
      },
    },
    graphrag: {
      enabled: true,
      vault: "graph_vault",
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

  test("bootstraps recovered stages from a partial GraphRAG workspace", async () => {
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
          "    model: jina-embeddings-v3",
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

      expect(state.resumePlan.nextStage).toBe("community_report");
      expect(state.resumePlan.completedStages).toEqual([
        "ingest",
        "normalize",
        "graph_extract",
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
        "graph_extract",
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
      const documentsPath = join(graphVault, "output", "documents.parquet");
      const textUnitsPath = join(graphVault, "output", "text_units.parquet");

      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "settings.yaml"), "vector_store: {}\n", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

      const parquetScript = [
        "import pandas as pd, sys",
        "documents_path, text_units_path = sys.argv[1:3]",
        "pd.DataFrame([{'id':'graph-doc-1','title':'book.md','text_unit_ids':['tu-1','tu-2']}]).to_parquet(documents_path)",
        "pd.DataFrame([{'id':'tu-1','document_id':'graph-doc-1'},{'id':'tu-2','document_id':'graph-doc-1'}]).to_parquet(text_units_path)",
      ].join("\n");
      const result = spawnSync(TestPythonBin, [
        "-c",
        parquetScript,
        documentsPath,
        textUnitsPath,
      ], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);

      const state = await syncGraphRagBookWorkspace({
        stateRootDir: graphVault,
        sourcePath,
        normalizedPath,
        settingsPath: join(graphVault, "settings.yaml"),
        promptsDir: join(graphVault, "prompts"),
        outputDir: join(graphVault, "output"),
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

  test("bootstraps query-ready from validated community-report and embed artifacts", async () => {
    const root = await createWorkspace();
    try {
      const graphVault = join(root, "graph_vault");
      await mkdir(join(graphVault, "input"), { recursive: true });
      await mkdir(join(graphVault, "prompts"), { recursive: true });
      await mkdir(join(graphVault, "output"), { recursive: true });
      await mkdir(join(graphVault, "reports"), { recursive: true });

      const sourcePath = join(root, "book.epub");
      const normalizedPath = join(graphVault, "input", "book.md");
      const documentsPath = join(graphVault, "output", "documents.parquet");
      const textUnitsPath = join(graphVault, "output", "text_units.parquet");
      const reportsPath = join(graphVault, "output", "community_reports.parquet");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeManagedGraphRagSettings({ config: projectConfig, graphVault });
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

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

      for (const file of [
        "entities.parquet",
        "relationships.parquet",
        "communities.parquet",
      ]) {
        await writeFile(join(graphVault, "output", file), file, "utf8");
      }
      await writeFile(join(graphVault, "output", "context.json"), '{"records":[]}', "utf8");
      await writeFile(join(graphVault, "output", "stats.json"), '{"workflows":{}}', "utf8");
      for (const tableName of [
        "entity_description.lance",
        "community_full_content.lance",
        "text_unit_text.lance",
      ]) {
        const tableDir = join(graphVault, "output", "lancedb", tableName);
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
      const capabilities = await new FileBookJobStateRepository(graphVault)
        .listStageCheckpoints(state.job.bookId);
      const queryReady = capabilities.find((item) => item.stage === "query_ready");

      expect(state.resumePlan.canQuery).toBe(true);
      expect(queryReady?.artifactIds).toHaveLength(2);
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
      const repo = new FileBookJobStateRepository(graphVault);
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
          join(graphVault, "output"),
          join(graphVault, "output", "lancedb"),
        ], { encoding: "utf8" });
        expect(setup.status, setup.stderr).toBe(0);
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
            graphVault,
            "output",
            "lancedb",
            "entity_description.lance",
            "qmd_row_count.json",
          ),
          "utf8",
        );
        const rowCount = JSON.parse(rowCountRaw) as { rowCount?: number };

        expect(rowCount.rowCount).toBe(1);
        expect(state.resumePlan.canQuery).toBe(true);
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
      const documentsPath = join(graphVault, "output", "documents.parquet");
      const textUnitsPath = join(graphVault, "output", "text_units.parquet");
      const reportsPath = join(graphVault, "output", "community_reports.parquet");
      await writeFile(sourcePath, "epub-bytes", "utf8");
      await writeFile(normalizedPath, "# Book\n\nNormalized content", "utf8");
      await writeFile(join(graphVault, "settings.yaml"), "vector_store: {}\n", "utf8");
      await writeFile(join(graphVault, "prompts", "extract_graph.txt"), "prompt", "utf8");

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

      for (const tableName of [
        "entity_description.lance",
        "community_full_content.lance",
        "text_unit_text.lance",
      ]) {
        const tableDir = join(graphVault, "output", "lancedb", tableName);
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
});
