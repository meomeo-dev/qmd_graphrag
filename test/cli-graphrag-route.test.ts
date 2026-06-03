import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const MinimalParquetFixture = Buffer.from(
  "UEFSMRUEFRIVFkwVAhUAEgAACSAFAAAAcm93LTEVABUSFRYsFQIVEBUGFQYcNgAoBXJvdy0xGAVyb3ctMRERAAAACSACAAAAAgEBAgAVBBksNQAYBnNjaGVtYRUCABUMJQIYAmlkJQBMHAAAABYCGRwZHCYAHBUMGTUABhAZGAJpZBUCFgIWigEWkgEmOiYIHDYAKAVyb3ctMRgFcm93LTEREQAZLBUEFQAVAgAVABUQFQIAPBYKGQYZJgACAAAAFooBFgImCBaSAQAZHBgMQVJST1c6c2NoZW1hGKABLy8vLy8zQUFBQUFRQUFBQUFBQUtBQXdBQmdBRkFBZ0FDZ0FBQUFBQkJBQU1BQUFBQ0FBSUFBQUFCQUFJQUFBQUJBQUFBQUVBQUFBVUFBQUFFQUFVQUFnQUJnQUhBQXdBQUFBUUFCQUFBQUFBQUFFRkVBQUFBQmdBQUFBRUFBQUFBQUFBQUFJQUFBQnBaQUFBQkFBRUFBUUFBQUFBQUFBQQAYIHBhcnF1ZXQtY3BwLWFycm93IHZlcnNpb24gMjIuMC4wGRwcAAAAWgEAAFBBUjE=",
  "base64",
);

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
  bridgeRequestLog: string;
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
      QMD_FAKE_BRIDGE_REQUEST_LOG: workspace.bridgeRequestLog,
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
  if (process.env.QMD_FAKE_BRIDGE_REQUEST_LOG) {
    require("node:fs").appendFileSync(
      process.env.QMD_FAKE_BRIDGE_REQUEST_LOG,
      JSON.stringify({ command, request }) + "\\n",
      "utf8"
    );
  }
  const scope = request.capabilityScope || {};
  const artifactIds = scope.artifactIds || [];
  const reportArtifactId =
    artifactIds.find((artifactId) => String(artifactId).includes("report")) ||
    artifactIds[0] ||
    "artifact-cli-report";
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
      artifactId: reportArtifactId,
      locator: { path: "graph/books/book-cli/community-report.md", lineStart: 3 },
      quote: "Graph-only CLI projected evidence",
      score: 0.97,
      metadata: {
        title: "CLI Graph Community Report",
        requestDataDir: request.dataDir || null,
        requestRootDir: request.rootDir || null
      }
    }]
  };
  process.stdout.write(JSON.stringify(response));
});
`,
    "utf8",
  );
  await chmod(path, 0o755);
}

async function readLastBridgeRequest(
  workspace: Workspace,
): Promise<Record<string, unknown>> {
  const raw = await readFile(workspace.bridgeRequestLog, "utf8");
  const lastLine = raw.trim().split(/\r?\n/u).at(-1);
  if (lastLine == null) throw new Error("missing fake bridge request log");
  const entry = JSON.parse(lastLine) as { request?: Record<string, unknown> };
  return entry.request ?? {};
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

async function writeMinimalParquetFixture(path: string): Promise<void> {
  await writeFile(path, MinimalParquetFixture);
}

const GraphExtractArtifactKinds = [
  ["documents.parquet", "graphrag_documents_parquet"],
  ["text_units.parquet", "graphrag_text_units_parquet"],
  ["entities.parquet", "graphrag_entities_parquet"],
  ["relationships.parquet", "graphrag_relationships_parquet"],
  ["communities.parquet", "graphrag_communities_parquet"],
] as const;

type GraphBookFixture = {
  bookId: string;
  sourceId: string;
  sourceHash: string;
  documentId: string;
  contentHash: string;
  normalizedPath: string;
  graphExtractArtifactIds: string[];
  reportArtifactId: string;
  lancedbArtifactId: string;
  reportHash: string;
  lancedbHash: string;
  graphTextUnitId: string;
  graphDocumentId: string;
  stageFingerprints: Record<string, string>;
  providerFingerprint: string;
  runIds: Record<string, string>;
};

function checkpointFixture(input: GraphBookFixture, stage: string) {
  return {
    schemaVersion: SchemaVersion,
    bookId: input.bookId,
    stage,
    status: "succeeded",
    attemptCount: 1,
    runId: input.runIds[stage],
    inputFingerprint: input.stageFingerprints[stage],
    contentHash: input.contentHash,
    stageFingerprint: input.stageFingerprints[stage],
    providerFingerprint: input.providerFingerprint,
    artifactIds: stage === "graph_extract"
      ? input.graphExtractArtifactIds
      : stage === "community_report"
      ? [input.reportArtifactId]
      : stage === "embed"
        ? [input.lancedbArtifactId]
        : stage === "query_ready"
          ? [input.reportArtifactId, input.lancedbArtifactId]
          : [],
    finishedAt: "2026-05-22T00:00:00.000Z",
  };
}

async function writeGraphBookFixture(
  graphVault: string,
  input: Omit<GraphBookFixture, "reportHash" | "lancedbHash">,
): Promise<GraphBookFixture> {
  const outputDir = join(graphVault, "books", input.bookId, "graphrag", "output");
  await mkdir(outputDir, { recursive: true });
  await mkdir(join(graphVault, "books", input.bookId, "state"), {
    recursive: true,
  });
  await mkdir(join(graphVault, "books", input.bookId, "graphrag", "runs"), {
    recursive: true,
  });
  const reportPath = join(outputDir, "community_reports.parquet");
  const lancedbPath = join(outputDir, "lancedb");
  for (const [fileName] of GraphExtractArtifactKinds) {
    await writeMinimalParquetFixture(join(outputDir, fileName));
  }
  await writeFile(join(outputDir, "context.json"), "{}", "utf8");
  await writeFile(
    join(outputDir, "stats.json"),
    JSON.stringify({ schemaVersion: SchemaVersion, bookId: input.bookId, documents: 1 }),
    "utf8",
  );
  await writeMinimalParquetFixture(reportPath);
  await writeLanceDbFixture(lancedbPath);
  const fixture = {
    ...input,
    reportHash: await hashFile(reportPath),
    lancedbHash: await hashLanceDbDirectoryContents(lancedbPath),
  };

  await writeFile(
    join(graphVault, "books", fixture.bookId, "state", "checkpoints.yaml"),
    YAML.stringify({
      schemaVersion: SchemaVersion,
      items: [
        checkpointFixture(fixture, "graph_extract"),
        checkpointFixture(fixture, "community_report"),
        checkpointFixture(fixture, "embed"),
        checkpointFixture(fixture, "query_ready"),
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(graphVault, "books", fixture.bookId, "state", "artifacts.yaml"),
    YAML.stringify({
      schemaVersion: SchemaVersion,
      items: [
        ...await Promise.all(GraphExtractArtifactKinds.map(
          async ([fileName, kind], index) => ({
            schemaVersion: SchemaVersion,
            artifactId: fixture.graphExtractArtifactIds[index],
            bookId: fixture.bookId,
            stage: "graph_extract",
            kind,
            path: `books/${fixture.bookId}/graphrag/output/${fileName}`,
            contentHash: await hashFile(join(outputDir, fileName)),
            stageFingerprint: fixture.stageFingerprints.graph_extract,
            providerFingerprint: fixture.providerFingerprint,
            producerRunId: fixture.runIds.graph_extract,
            createdAt: "2026-05-22T00:00:00.000Z",
            metadata: { corpusContentHash: fixture.contentHash },
          }),
        )),
        {
          schemaVersion: SchemaVersion,
          artifactId: fixture.graphExtractArtifactIds[5]!,
          bookId: fixture.bookId,
          stage: "graph_extract",
          kind: "graphrag_context_json",
          path: `books/${fixture.bookId}/graphrag/output/context.json`,
          contentHash: await hashFile(join(outputDir, "context.json")),
          stageFingerprint: fixture.stageFingerprints.graph_extract,
          providerFingerprint: fixture.providerFingerprint,
          producerRunId: fixture.runIds.graph_extract,
          createdAt: "2026-05-22T00:00:00.000Z",
          metadata: { corpusContentHash: fixture.contentHash },
        },
        {
          schemaVersion: SchemaVersion,
          artifactId: fixture.graphExtractArtifactIds[6]!,
          bookId: fixture.bookId,
          stage: "graph_extract",
          kind: "graphrag_stats_json",
          path: `books/${fixture.bookId}/graphrag/output/stats.json`,
          contentHash: await hashFile(join(outputDir, "stats.json")),
          stageFingerprint: fixture.stageFingerprints.graph_extract,
          providerFingerprint: fixture.providerFingerprint,
          producerRunId: fixture.runIds.graph_extract,
          createdAt: "2026-05-22T00:00:00.000Z",
          metadata: { corpusContentHash: fixture.contentHash },
        },
        {
          schemaVersion: SchemaVersion,
          artifactId: fixture.reportArtifactId,
          bookId: fixture.bookId,
          stage: "community_report",
          kind: "graphrag_community_reports_parquet",
          path: `books/${fixture.bookId}/graphrag/output/community_reports.parquet`,
          contentHash: fixture.reportHash,
          stageFingerprint: fixture.stageFingerprints.community_report,
          providerFingerprint: fixture.providerFingerprint,
          producerRunId: fixture.runIds.community_report,
          createdAt: "2026-05-22T00:00:00.000Z",
          metadata: { corpusContentHash: fixture.contentHash },
        },
        {
          schemaVersion: SchemaVersion,
          artifactId: fixture.lancedbArtifactId,
          bookId: fixture.bookId,
          stage: "embed",
          kind: "lancedb_index",
          path: `books/${fixture.bookId}/graphrag/output/lancedb`,
          contentHash: fixture.lancedbHash,
          stageFingerprint: fixture.stageFingerprints.embed,
          providerFingerprint: fixture.providerFingerprint,
          producerRunId: fixture.runIds.embed,
          createdAt: "2026-05-22T00:00:00.000Z",
          metadata: { corpusContentHash: fixture.contentHash },
        },
      ],
    }),
    "utf8",
  );

  for (const run of [
    {
      runId: fixture.runIds.graph_extract,
      stage: "graph_extract",
      artifactIds: fixture.graphExtractArtifactIds,
    },
    {
      runId: fixture.runIds.community_report,
      stage: "community_report",
      artifactIds: [fixture.reportArtifactId],
    },
    {
      runId: fixture.runIds.embed,
      stage: "embed",
      artifactIds: [fixture.lancedbArtifactId],
    },
    {
      runId: fixture.runIds.query_ready,
      stage: "query_ready",
      artifactIds: [fixture.reportArtifactId, fixture.lancedbArtifactId],
    },
  ]) {
    await writeFile(
      join(
        graphVault,
        "books",
        fixture.bookId,
        "graphrag",
        "runs",
        `${run.runId}.yaml`,
      ),
      YAML.stringify({
        schemaVersion: SchemaVersion,
        runId: run.runId,
        bookId: fixture.bookId,
        stage: run.stage,
        status: "succeeded",
        attemptCount: 1,
        startedAt: "2026-05-22T00:00:00.000Z",
        finishedAt: "2026-05-22T00:00:01.000Z",
        inputFingerprint: fixture.stageFingerprints[run.stage],
        artifactIds: run.artifactIds,
        metadata: {
          stageFingerprint: fixture.stageFingerprints[run.stage],
          providerFingerprint: fixture.providerFingerprint,
        },
      }),
      "utf8",
    );
  }

  return fixture;
}

async function createWorkspace(options: {
  includeSecondGraphReadyBook?: boolean;
} = {}): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "qmd-cli-graphrag-"));
  const dbPath = join(root, "index.sqlite");
  const configDir = join(root, "config");
  const graphVault = join(root, "graph_vault");
  const fakeBridge = join(root, "fake-graphrag-bridge.js");
  const bridgeRequestLog = join(root, "fake-graphrag-bridge-requests.jsonl");
  await mkdir(configDir, { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFakeBridge(fakeBridge);

  const body = [
    "# Graph Ready Book",
    "",
    "This book explains how architecture decisions relate across chapters.",
  ].join("\n");
  const secondBody = [
    "# Second Graph Ready Book",
    "",
    "This second book also explains how architecture decisions relate across chapters.",
  ].join("\n");
  const relativePath = "docs/graph-ready.md";
  const secondRelativePath = "docs/second-graph-ready.md";
  const sourcePath = join(root, relativePath);
  const secondSourcePath = join(root, secondRelativePath);
  await writeFile(sourcePath, body, "utf8");
  if (options.includeSecondGraphReadyBook) {
    await writeFile(secondSourcePath, secondBody, "utf8");
  }
  const contentHash = await hashContent(body);
  const secondContentHash = await hashContent(secondBody);
  const sourceHash = sha256Text(body);
  const secondSourceHash = sha256Text(secondBody);
  const documentId = `doc-${contentHash.slice(0, 12)}`;
  const secondDocumentId = `doc-${secondContentHash.slice(0, 12)}`;
  const sourceId = `sha256:${sourceHash}`;
  const secondSourceId = `sha256:${secondSourceHash}`;
  const bookId = "book-cli";
  const secondBookId = "book-cli-second";
  const reportArtifactId = "artifact-cli-report";
  const secondReportArtifactId = "artifact-cli-second-report";
  const lancedbArtifactId = "artifact-cli-lancedb";
  const secondLancedbArtifactId = "artifact-cli-second-lancedb";
  const graphExtractArtifactIds = [
    "artifact-cli-documents",
    "artifact-cli-text-units",
    "artifact-cli-entities",
    "artifact-cli-relationships",
    "artifact-cli-communities",
    "artifact-cli-context",
    "artifact-cli-stats",
  ];
  const secondGraphExtractArtifactIds = graphExtractArtifactIds.map((item) =>
    item.replace("artifact-cli-", "artifact-cli-second-")
  );
  const providerFingerprint = "provider-openai-responses-jina";
  const stageFingerprints = {
    graph_extract: "stage-graph-extract",
    community_report: "stage-community-report",
    embed: "stage-embed",
    query_ready: "stage-query-ready",
  };
  const secondStageFingerprints = {
    graph_extract: "stage-second-graph-extract",
    community_report: "stage-second-community-report",
    embed: "stage-second-embed",
    query_ready: "stage-second-query-ready",
  };

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
    if (options.includeSecondGraphReadyBook) {
      insertContent(store.db, secondContentHash, secondBody, now);
      insertDocument(
        store.db,
        "docs",
        secondRelativePath,
        extractTitle(secondBody, secondRelativePath),
        secondContentHash,
        now,
        now,
      );
    }
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
  const fixtures: GraphBookFixture[] = [];
  fixtures.push(await writeGraphBookFixture(graphVault, {
    bookId,
    sourceId,
    sourceHash,
    documentId,
    contentHash,
    normalizedPath: relativePath,
    graphExtractArtifactIds,
    reportArtifactId,
    lancedbArtifactId,
    graphTextUnitId: "tu-cli",
    graphDocumentId: "graph-doc-cli",
    stageFingerprints,
    providerFingerprint,
    runIds: {
      graph_extract: "run-cli-graph-extract",
      community_report: "run-cli-community-report",
      embed: "run-cli-embed",
      query_ready: "run-cli-query-ready",
    },
  }));
  if (options.includeSecondGraphReadyBook) {
    fixtures.push(await writeGraphBookFixture(graphVault, {
      bookId: secondBookId,
      sourceId: secondSourceId,
      sourceHash: secondSourceHash,
      documentId: secondDocumentId,
      contentHash: secondContentHash,
      normalizedPath: secondRelativePath,
      graphExtractArtifactIds: secondGraphExtractArtifactIds,
      reportArtifactId: secondReportArtifactId,
      lancedbArtifactId: secondLancedbArtifactId,
      graphTextUnitId: "tu-cli-second",
      graphDocumentId: "graph-doc-cli-second",
      stageFingerprints: secondStageFingerprints,
      providerFingerprint,
      runIds: {
        graph_extract: "run-cli-second-graph-extract",
        community_report: "run-cli-second-community-report",
        embed: "run-cli-second-embed",
        query_ready: "run-cli-second-query-ready",
      },
    }));
  }

  await writeFile(
    join(graphVault, "catalog", "books.yaml"),
    YAML.stringify({
      schemaVersion: SchemaVersion,
      items: fixtures.map((fixture) => ({
        schemaVersion: SchemaVersion,
        bookId: fixture.bookId,
        documentId: fixture.documentId,
        sourcePath: `input/${fixture.bookId}.epub`,
        sourceHash: fixture.sourceHash,
        normalizedContentHash: fixture.contentHash,
        normalizedPath: fixture.normalizedPath,
        normalizationPolicyVersion: "qmd-sqlite-content-v1",
        configFingerprint: "config-fp",
        promptFingerprint: "prompt-fp",
        modelFingerprint: "model-fp",
        stageFingerprints: fixture.stageFingerprints,
        providerFingerprint: fixture.providerFingerprint,
        currentStage: "query_ready",
        overallStatus: "succeeded",
        lastSuccessRunId: fixture.runIds.query_ready,
        createdAt: "2026-05-22T00:00:00.000Z",
        updatedAt: "2026-05-22T00:00:00.000Z",
        metadata: { sourceName: `${fixture.bookId}.epub` },
      })),
    }),
    "utf8",
  );
  await writeFile(
    join(graphVault, "catalog", "graph-capabilities.yaml"),
    YAML.stringify({
      schemaVersion: SchemaVersion,
      items: [
        {
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
        },
        ...(options.includeSecondGraphReadyBook ? [{
          schemaVersion: SchemaVersion,
          capabilityId: "book-cli-second:graph_query",
          kind: "graph_query",
          bookId: secondBookId,
          sourceId: secondSourceId,
          documentId: secondDocumentId,
          contentHash: secondContentHash,
          ready: true,
          readinessSource: "validated_checkpoint_plus_validated_manifest" as const,
          artifactIds: [secondReportArtifactId, secondLancedbArtifactId],
          createdAt: "2026-05-22T00:00:00.000Z",
        }] : []),
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(graphVault, "catalog", "document-identity-map.yaml"),
    YAML.stringify({
      schemaVersion: SchemaVersion,
      items: [
        {
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
          metadata: {
            qmdCorpusRegistered: true,
            qmdCollection: "docs",
            qmdRelativePath: relativePath,
          },
        },
        ...(options.includeSecondGraphReadyBook ? [{
          schemaVersion: SchemaVersion,
          sourceId: secondSourceId,
          sourceHash: secondSourceHash,
          canonicalBookId: secondBookId,
          documentId: secondDocumentId,
          contentHash: secondContentHash,
          normalizationPolicyVersion: "qmd-sqlite-content-v1",
          normalizedPath: secondRelativePath,
          chunkIds: [],
          graphDocumentId: "graph-doc-cli-second",
          graphTextUnitIds: ["tu-cli-second"],
          metadata: {
            qmdCorpusRegistered: true,
            qmdCollection: "docs",
            qmdRelativePath: secondRelativePath,
          },
        }] : []),
      ],
    }),
    "utf8",
  );

  const workspace = {
    root,
    dbPath,
    configDir,
    graphVault,
    fakeBridge,
    bridgeRequestLog,
  };
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
    expect(answer.routeDecision.selectedBookIds).toEqual(["book-cli"]);
    expect(answer.evidence[0].metadata?.title).toBe("CLI Graph Community Report");
    expect(answer.evidence[0].metadata?.requestDataDir).toBeUndefined();
    const bridgeRequest = await readLastBridgeRequest(workspace);
    expect(bridgeRequest.dataDir).toBe(
      join(workspace.graphVault, "books", "book-cli", "graphrag", "output"),
    );
    expect(JSON.stringify(answer)).not.toContain(workspace.graphVault);
  }, 30000);

  test("qmd query --graphrag non-json formats project unified evidence", async () => {
    const workspace = await createWorkspace();
    const baseArgs = [
      "query",
      "--graphrag",
      "--no-rerank",
      "How do architecture decisions relate across chapters?",
    ];

    const markdown = await runQmd(workspace, [...baseArgs, "--md"]);
    expect(markdown.exitCode, markdown.stderr).toBe(0);
    expect(markdown.stdout).toContain("# Answer");
    expect(markdown.stdout).toContain("GraphRAG CLI answer from fake bridge");
    expect(markdown.stdout).toContain("graphCapabilityId");
    expect(markdown.stdout).toContain("book-cli:graph_query");
    expect(markdown.stdout).toContain("documentId");
    expect(markdown.stdout).toContain("contentHash");
    expect(markdown.stdout).toContain("artifact-cli-report");
    expect(markdown.stdout).toContain("Graph-only CLI projected evidence");
    expect(markdown.stdout).not.toContain(workspace.graphVault);

    const csv = await runQmd(workspace, [...baseArgs, "--csv"]);
    expect(csv.exitCode, csv.stderr).toBe(0);
    expect(csv.stdout).toContain("evidenceId,score,path,title,sourceId");
    expect(csv.stdout).toContain("cli-graph-evidence-1");
    expect(csv.stdout).toContain("book-cli:graph_query");
    expect(csv.stdout).toContain("artifact-cli-report");
    expect(csv.stdout).toContain("Graph-only CLI projected evidence");
    expect(csv.stdout).not.toContain(workspace.graphVault);

    const xml = await runQmd(workspace, [...baseArgs, "--xml"]);
    expect(xml.exitCode, xml.stderr).toBe(0);
    expect(xml.stdout).toContain('<answer route="graphrag">');
    expect(xml.stdout).toContain("GraphRAG CLI answer from fake bridge");
    expect(xml.stdout).toContain('evidenceId="cli-graph-evidence-1"');
    expect(xml.stdout).toContain('graphCapabilityId="book-cli:graph_query"');
    expect(xml.stdout).toContain('artifactId="artifact-cli-report"');
    expect(xml.stdout).not.toContain(workspace.graphVault);

    const files = await runQmd(workspace, [...baseArgs, "--files"]);
    expect(files.exitCode, files.stderr).toBe(0);
    expect(files.stdout).toContain("book-cli:graph_query");
    expect(files.stdout).toContain("doc-");
    expect(files.stdout).toContain("sha256:");
    expect(files.stdout).toContain("artifact-cli-report");
    expect(files.stdout).not.toContain(workspace.graphVault);
  }, 60000);

  test("qmd query --mode auto upgrades to GraphRAG when coverage and intent match", async () => {
    const workspace = await createWorkspace();
    const result = await runQmd(workspace, [
      "query",
      "--mode",
      "auto",
      "--json",
      "--no-rerank",
      [
        "intent: relationships across chapters",
        "lex: architecture decisions relate across chapters",
      ].join("\n"),
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.routeDecision.requestedRoute).toBe("auto");
    expect(answer.routeDecision.selectedRoute).toBe("graphrag");
    expect(answer.routeDecision.reasonCode).toBe("graph_upgrade");
    expect(answer.routeDecision.refusalReasons).toEqual([]);
    expect(answer.answerText).toBe("GraphRAG CLI answer from fake bridge");
    expect(answer.routeDecision.selectedBookIds).toEqual(["book-cli"]);
    expect(answer.routeDecision.graphArtifactIds).toEqual(expect.arrayContaining([
      "artifact-cli-documents",
      "artifact-cli-text-units",
      "artifact-cli-entities",
      "artifact-cli-relationships",
      "artifact-cli-communities",
      "artifact-cli-context",
      "artifact-cli-stats",
      "artifact-cli-report",
      "artifact-cli-lancedb",
    ]));
    expect(JSON.stringify(answer)).not.toContain(workspace.graphVault);
  }, 30000);

  test("qmd query --mode auto does not upgrade when stats artifact is missing", async () => {
    const workspace = await createWorkspace();
    const artifactsPath = join(
      workspace.graphVault,
      "books",
      "book-cli",
      "state",
      "artifacts.yaml",
    );
    const checkpointsPath = join(
      workspace.graphVault,
      "books",
      "book-cli",
      "state",
      "checkpoints.yaml",
    );
    for (const path of [artifactsPath, checkpointsPath]) {
      const parsed = YAML.parse(readFileSync(path, "utf8")) as {
        items: Array<Record<string, unknown>>;
      };
      parsed.items = parsed.items.filter((item) =>
        item.artifactId !== "artifact-cli-stats"
      );
      for (const item of parsed.items) {
        if (Array.isArray(item.artifactIds)) {
          item.artifactIds = item.artifactIds.filter((artifactId) =>
            artifactId !== "artifact-cli-stats"
          );
        }
      }
      await writeFile(path, YAML.stringify(parsed), "utf8");
    }

    const result = await runQmd(workspace, [
      "query",
      "--mode",
      "auto",
      "--json",
      "--no-rerank",
      [
        "intent: relationships across chapters",
        "lex: architecture decisions relate across chapters",
      ].join("\n"),
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.routeDecision.requestedRoute).toBe("auto");
    expect(answer.routeDecision.selectedRoute).toBe("qmd");
    expect(answer.routeDecision.refusalReasons).toContain("no_graph_ready_candidate");
    expect(answer.routeDecision.graphCapabilityIds).toEqual([]);
  }, 30000);

  test("qmd query --graphrag rejects multiple books without a graph book id", async () => {
    const workspace = await createWorkspace({ includeSecondGraphReadyBook: true });
    const result = await runQmd(workspace, [
      "query",
      "--graphrag",
      "--json",
      "--no-rerank",
      "How do architecture decisions relate across chapters?",
    ]);

    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error).toMatchObject({
      route: "graphrag",
      stage: "route",
      provider: "graphrag",
      capability: "graph_query",
      code: "ambiguous_graph_book_scope",
      retryable: false,
      redactedMessage:
        "qmd query --graphrag requires --graph-book-id when multiple " +
        "graph-ready books match the request.",
    });
    expect(result.stdout).toBe("");
  }, 30000);

  test("qmd query --graphrag uses the selected book scoped output", async () => {
    const workspace = await createWorkspace({ includeSecondGraphReadyBook: true });
    const result = await runQmd(workspace, [
      "query",
      "--graphrag",
      "--graph-book-id",
      "book-cli-second",
      "--json",
      "--no-rerank",
      "How do architecture decisions relate across chapters?",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.routeDecision.selectedBookIds).toEqual(["book-cli-second"]);
    expect(answer.evidence[0].bookId).toBe("book-cli-second");
    expect(answer.evidence[0].metadata?.requestDataDir).toBeUndefined();
    const bridgeRequest = await readLastBridgeRequest(workspace);
    expect(bridgeRequest.dataDir).toBe(
      join(workspace.graphVault, "books", "book-cli-second", "graphrag", "output"),
    );
    expect(JSON.stringify(answer)).not.toContain(workspace.graphVault);
  }, 30000);

  test("qmd query --graphrag recreates managed settings projection for a fresh vault",
    async () => {
      const workspace = await createWorkspace();
      const settingsPath = join(workspace.graphVault, "settings.yaml");
      const checksumPath = `${settingsPath}.sha256`;
      const checksumMetaPath = `${checksumPath}.meta.json`;

      for (const path of [settingsPath, checksumPath, checksumMetaPath]) {
        if (existsSync(path)) {
          await rm(path, { force: true });
        }
      }

      const result = await runQmd(workspace, [
        "query",
        "--graphrag",
        "--json",
        "--no-rerank",
        "How do architecture decisions relate across chapters?",
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
      const answer = JSON.parse(result.stdout);
      expect(answer.routeDecision.selectedRoute).toBe("graphrag");
      expect(answer.answerText).toBe("GraphRAG CLI answer from fake bridge");

      const settingsRaw = await readFile(settingsPath, "utf8");
      expect(settingsRaw).toContain("managed_by: qmd_graphrag");
      expect(existsSync(checksumPath)).toBe(true);
      expect(existsSync(checksumMetaPath)).toBe(true);
    }, 30000);

  test("qmd query --mode auto rejects ambiguous multi-book graph upgrade", async () => {
    const workspace = await createWorkspace({ includeSecondGraphReadyBook: true });
    const result = await runQmd(workspace, [
      "query",
      "--mode",
      "auto",
      "--json",
      "--no-rerank",
      [
        "intent: relationships across chapters",
        "lex: architecture decisions relate across chapters",
      ].join("\n"),
    ]);

    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error).toMatchObject({
      route: "auto",
      stage: "route",
      provider: "graphrag",
      capability: "graph_query",
      code: "ambiguous_graph_book_scope",
      retryable: false,
      redactedMessage:
        "GraphRAG auto upgrade requires exactly one graph-ready book.",
    });
    expect(result.stdout).toBe("");
  }, 30000);

  test("qmd query --mode auto can be scoped to one graph book", async () => {
    const workspace = await createWorkspace({ includeSecondGraphReadyBook: true });
    const result = await runQmd(workspace, [
      "query",
      "--mode",
      "auto",
      "--graph-book-id",
      "book-cli-second",
      "--json",
      "--no-rerank",
      [
        "intent: relationships across chapters",
        "lex: architecture decisions relate across chapters",
      ].join("\n"),
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.routeDecision.requestedRoute).toBe("auto");
    expect(answer.routeDecision.selectedRoute).toBe("graphrag");
    expect(answer.routeDecision.selectedBookIds).toEqual(["book-cli-second"]);
    expect(answer.evidence[0].bookId).toBe("book-cli-second");
    expect(answer.routeDecision.graphCapabilityIds).toEqual([
      "book-cli-second:graph_query",
    ]);
    expect(JSON.stringify(answer)).not.toContain(workspace.graphVault);
  }, 30000);
});
