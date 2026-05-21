import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  FileBookJobStateRepository,
  syncGraphRagBookWorkspace,
} from "../src/index.js";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qmd-graphrag-workspace-"));
}

describe("syncGraphRagBookWorkspace", () => {
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
        "context.json",
        "stats.json",
      ]) {
        await writeFile(join(graphVault, "output", file), file, "utf8");
      }
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
});
