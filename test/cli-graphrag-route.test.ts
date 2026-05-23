import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, test } from "vitest";
import YAML from "yaml";

import { SchemaVersion } from "../src/contracts/common.js";
import {
  createStore,
  extractTitle,
  hashContent,
  insertContent,
  insertDocument,
  syncConfigToDb,
} from "../src/store.js";
import { hashLanceDbDirectoryContents } from "../src/job-state/artifact-validation.js";
import { hashFile } from "../src/job-state/fingerprint.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const qmdCommand = isBunRuntime
  ? { command: process.execPath, args: [qmdScript] }
  : { command: process.execPath, args: [tsxCli, qmdScript] };

type Workspace = {
  root: string;
  dbPath: string;
  configDir: string;
  graphVault: string;
  fakeBridge: string;
};

const workspaces: Workspace[] = [];

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runQmd(
  workspace: Workspace,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = spawn(qmdCommand.command, [...qmdCommand.args, ...args], {
    cwd: workspace.root,
    env: {
      ...process.env,
      INDEX_PATH: workspace.dbPath,
      QMD_CONFIG_DIR: workspace.configDir,
      QMD_GRAPHRAG_PYTHON: workspace.fakeBridge,
      PWD: workspace.root,
      QMD_DOCTOR_DEVICE_PROBE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  return { stdout, stderr, exitCode };
}

async function writeFakeBridge(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
const command = process.argv[process.argv.length - 1];
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(raw || "{}");
  if (command !== "graphrag_query") {
    console.error("unsupported command");
    process.exit(1);
  }
  const scope = request.capabilityScope || {};
  const response = {
    schemaVersion: "${SchemaVersion}",
    method: request.method || "local",
    responseText: "GraphRAG CLI answer from fake bridge",
    evidence: [{
      evidenceId: "cli-graph-evidence-1",
      graphCapabilityId: (scope.graphCapabilityIds || ["book-cli:graph_query"])[0],
      sourceId: (scope.sourceIds || ["source-cli"])[0],
      documentId: (scope.documentIds || ["doc-cli"])[0],
      bookId: (scope.selectedBookIds || ["book-cli"])[0],
      contentHash: (scope.contentHashes || ["content-cli"])[0],
      graphTextUnitId: "tu-cli",
      artifactId: (scope.artifactIds || ["artifact-cli-report"])[0],
      locator: { path: "graph/books/book-cli/community-report.md", lineStart: 3 },
      quote: "Graph-only CLI projected evidence",
      score: 0.97,
      metadata: { title: "CLI Graph Community Report" }
    }]
  };
  process.stdout.write(JSON.stringify(response));
});
`,
    "utf8",
  );
  await chmod(path, 0o755);
}

async function writeLanceDbFixture(root: string): Promise<void> {
  for (const tableName of [
    "entity_description.lance",
    "community_full_content.lance",
    "text_unit_text.lance",
  ]) {
    const tableDir = join(root, tableName);
    await mkdir(join(tableDir, "data"), { recursive: true });
    await writeFile(join(tableDir, "data", "part-1.lance"), "rows", "utf8");
    await writeFile(
      join(tableDir, "qmd_row_count.json"),
      JSON.stringify({ schemaVersion: SchemaVersion, rowCount: 1 }),
      "utf8",
    );
  }
}

async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "qmd-cli-graphrag-"));
  const dbPath = join(root, "index.sqlite");
  const configDir = join(root, "config");
  const graphVault = join(root, "graph_vault");
  const fakeBridge = join(root, "fake-graphrag-bridge.js");
  await mkdir(configDir, { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFakeBridge(fakeBridge);

  const body = [
    "# Graph Ready Book",
    "",
    "This book explains how architecture decisions relate across chapters.",
  ].join("\n");
  const relativePath = "docs/graph-ready.md";
  const sourcePath = join(root, relativePath);
  await writeFile(sourcePath, body, "utf8");
  const contentHash = await hashContent(body);
  const sourceHash = sha256Text(body);
  const documentId = `doc-${contentHash.slice(0, 12)}`;
  const sourceId = `sha256:${sourceHash}`;
  const bookId = "book-cli";
  const reportArtifactId = "artifact-cli-report";
  const lancedbArtifactId = "artifact-cli-lancedb";

  const store = createStore(dbPath);
  try {
    const now = new Date("2026-05-22T00:00:00.000Z").toISOString();
    insertContent(store.db, contentHash, body, now);
    insertDocument(
      store.db,
      "docs",
      relativePath,
      extractTitle(body, relativePath),
      contentHash,
      now,
      now,
    );
    syncConfigToDb(store.db, {
      collections: {
        docs: {
          path: join(root, "docs"),
          pattern: "**/*.md",
        },
      },
      query: {
        allow_graph_upgrade: true,
        auto_route: {
          graph_coverage_threshold: 0.5,
          max_cost_class: "medium",
        },
      },
      graphrag: {
        vault: "graph_vault",
        default_method: "local",
        default_response_type: "multiple paragraphs",
      },
    });
  } finally {
    store.close();
  }
  await writeFile(
    join(configDir, "index.yml"),
    YAML.stringify({
      collections: {
        docs: {
          path: join(root, "docs"),
          pattern: "**/*.md",
        },
      },
      query: {
        allow_graph_upgrade: true,
        auto_route: {
          graph_coverage_threshold: 0.5,
          max_cost_class: "medium",
        },
      },
      graphrag: {
        vault: "graph_vault",
        default_method: "local",
        default_response_type: "multiple paragraphs",
      },
    }),
    "utf8",
  );

  await mkdir(join(graphVault, "catalog"), { recursive: true });
  await mkdir(join(graphVault, "books", bookId, "output"), { recursive: true });
  const reportPath = join(graphVault, "books", bookId, "output", "community_reports.parquet");
  const lancedbPath = join(graphVault, "books", bookId, "output", "lancedb");
  await writeFile(reportPath, "community reports", "utf8");
  await writeLanceDbFixture(lancedbPath);
  const reportHash = await hashFile(reportPath);
  const lancedbHash = await hashLanceDbDirectoryContents(lancedbPath);

  await writeFile(
    join(graphVault, "books", bookId, "checkpoints.yaml"),
    YAML.stringify({
      schemaVersion: SchemaVersion,
      items: [{
        schemaVersion: SchemaVersion,
        bookId,
        stage: "query_ready",
        status: "succeeded",
        attemptCount: 1,
        inputFingerprint: "fp-query-ready",
        contentHash,
        stageFingerprint: "stage-query-ready",
        providerFingerprint: "provider-openai-responses-jina",
        artifactIds: [reportArtifactId, lancedbArtifactId],
        finishedAt: "2026-05-22T00:00:00.000Z",
      }],
    }),
    "utf8",
  );
  await writeFile(
    join(graphVault, "books", bookId, "artifacts.yaml"),
    YAML.stringify({
      schemaVersion: SchemaVersion,
      items: [
        {
          schemaVersion: SchemaVersion,
          artifactId: reportArtifactId,
          bookId,
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: `books/${bookId}/output/community_reports.parquet`,
          contentHash: reportHash,
          stageFingerprint: "stage-community-report",
          providerFingerprint: "provider-openai-responses-jina",
          producerRunId: "run-cli",
          createdAt: "2026-05-22T00:00:00.000Z",
        },
        {
          schemaVersion: SchemaVersion,
          artifactId: lancedbArtifactId,
          bookId,
          stage: "embed",
          kind: "lancedb_index",
          path: `books/${bookId}/output/lancedb`,
          contentHash: lancedbHash,
          stageFingerprint: "stage-embed",
          providerFingerprint: "provider-openai-responses-jina",
          producerRunId: "run-cli",
          createdAt: "2026-05-22T00:00:00.000Z",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(graphVault, "catalog", "graph-capabilities.yaml"),
    YAML.stringify({
      schemaVersion: SchemaVersion,
      items: [{
        schemaVersion: SchemaVersion,
        capabilityId: "book-cli:graph_query",
        kind: "graph_query",
        bookId,
        sourceId,
        documentId,
        contentHash,
        ready: true,
        readinessSource: "validated_checkpoint_plus_validated_manifest",
        artifactIds: [reportArtifactId, lancedbArtifactId],
        createdAt: "2026-05-22T00:00:00.000Z",
      }],
    }),
    "utf8",
  );
  await writeFile(
    join(graphVault, "catalog", "document-identity-map.yaml"),
    YAML.stringify({
      schemaVersion: SchemaVersion,
      items: [{
        schemaVersion: SchemaVersion,
        sourceId,
        sourceHash,
        canonicalBookId: bookId,
        documentId,
        contentHash,
        normalizationPolicyVersion: "qmd-sqlite-content-v1",
        normalizedPath: relativePath,
        chunkIds: [],
        graphDocumentId: "graph-doc-cli",
        graphTextUnitIds: ["tu-cli"],
        metadata: { qmdCorpusRegistered: true },
      }],
    }),
    "utf8",
  );

  const workspace = { root, dbPath, configDir, graphVault, fakeBridge };
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  while (workspaces.length > 0) {
    const workspace = workspaces.pop()!;
    if (existsSync(workspace.root)) {
      await rm(workspace.root, { recursive: true, force: true });
    }
  }
});

describe("CLI GraphRAG unified route", () => {
  test("qmd query --graphrag --json returns a unified GraphRAG answer", async () => {
    const workspace = await createWorkspace();
    const result = await runQmd(workspace, [
      "query",
      "--graphrag",
      "--json",
      "--no-rerank",
      "How do architecture decisions relate across chapters?",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.routeDecision.requestedRoute).toBe("graphrag");
    expect(answer.routeDecision.selectedRoute).toBe("graphrag");
    expect(answer.answerText).toBe("GraphRAG CLI answer from fake bridge");
    expect(answer.evidence[0].graphCapabilityId).toBe("book-cli:graph_query");
    expect(answer.evidence[0].quote).toContain("Graph-only CLI");
  }, 30000);

  test("qmd query --mode auto upgrades to GraphRAG when coverage and intent match", async () => {
    const workspace = await createWorkspace();
    const result = await runQmd(workspace, [
      "query",
      "--mode",
      "auto",
      "--json",
      "--no-rerank",
      "How do architecture decisions relate across chapters?",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.routeDecision.requestedRoute).toBe("auto");
    expect(answer.routeDecision.selectedRoute).toBe("graphrag");
    expect(answer.routeDecision.reasonCode).toBe("graph_upgrade");
    expect(answer.routeDecision.refusalReasons).toEqual([]);
    expect(answer.answerText).toBe("GraphRAG CLI answer from fake bridge");
  }, 30000);
});
