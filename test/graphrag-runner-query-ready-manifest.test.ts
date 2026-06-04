import { describe, expect, test } from "vitest";
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from "fs/promises";
import {
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { hostname, tmpdir } from "os";
import { dirname, join, relative, sep } from "path";
import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { createHash } from "crypto";
import YAML from "yaml";
import { SchemaVersion } from "../src/contracts/common.ts";
import {
  batchBookId,
  classifyFailure,
  durablePrimaryJsonEntries,
  expectDurableSubprocessEnvelopeIncomplete,
  graphArtifactManifests,
  mkProjectTmpDir,
  passedBatchCommandChecks,
  projectRoot,
  requiredBatchCommandCheckNames,
  runBatchMigrateOnly,
  runBatchStatusJson,
  runBatchWorkflow,
  runParallelRunnerFixture,
  sanitizeVaultText,
  stableJsonHash,
  stableTextHash,
  waitForFile,
  writeCompleteLanceDbFixture,
  writeCompletedGraphBatchFixture,
  writeDurableJsonFixture,
  writeDurableTextFixture,
  writeDurableYamlFixture,
  writeGraphRagPromptFixtures,
  writeMinimalEpubFixture,
  writeMinimalParquetFixture,
  writeQmdBuildFixture,
  writeProviderAuthReopenGraphFixture,
  writeProviderAuthStoppedBatchFixture,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG EPUB batch runner - Query Ready And Manifest", () => {
  test("status-json preserves completed checkpoint book identity during catalog drift", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-checkpoint-identity-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "checkpoint-identity-fixture";
    const fixture = await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "completed with persisted checkpoint identity",
    });
    const driftBookId = `${fixture.bookId}-catalog-drift`;
    const catalogPath = join(stateRoot, "catalog", "books.yaml");
    const catalog = YAML.parse(readFileSync(catalogPath, "utf8"));
    catalog.items.push({
      ...catalog.items[0],
      bookId: driftBookId,
      documentId: `doc-${driftBookId}`,
      sourcePath: `sources/${driftBookId}/source.epub`,
      normalizedPath: `books/${driftBookId}/input/book.md`,
      metadata: { sourceIdentityPath: fixture.sourceRelativePath },
      createdAt: "2026-05-23T00:00:02.000Z",
      updatedAt: "2026-05-23T00:00:03.000Z",
    });
    await writeDurableYamlFixture(catalogPath, catalog);

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${fixture.itemId}.json`),
      "utf8",
    ));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      recoveryDecision: "none",
      counts: { completed: 1 },
    });
    expect(summary.items[0]).toMatchObject({
      status: "completed",
      bookId: fixture.bookId,
      qmdBuildStatus: { status: "succeeded", bookId: fixture.bookId },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
      graphQueryStatus: { status: "succeeded" },
      commandCheckStatus: { status: "succeeded" },
    });
    expect(summary.items[0].bookId).not.toBe(driftBookId);
    expect(checkpoint).toMatchObject({
      status: "completed",
      bookId: fixture.bookId,
    });
  });

  test("migrate-only reopens completed item when terminal evidence checksum is corrupt",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-terminal-corrupt-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "terminal-evidence-corrupt-fixture";
      const fixture = await writeCompletedGraphBatchFixture({
        tmpRoot,
        sourceDir,
        stateRoot,
        configDir,
        runId,
        sourceBytes: "completed with corrupt terminal evidence checksum",
      });
      const manifestPath = join(
        stateRoot,
        "books",
        fixture.bookId,
        "output",
        "qmd_output_manifest.json",
      );
      await writeFile(`${manifestPath}.sha256`, `${"0".repeat(64)}\n`, "utf8");

      const result = await runBatchMigrateOnly({
        tmpRoot,
        sourceDir,
        stateRoot,
        logRoot,
        configDir,
        runId,
      });
      const checkpoint = JSON.parse(readFileSync(
        join(stateRoot, "catalog", "batch-runs", runId, "items", `${fixture.itemId}.json`),
        "utf8",
      ));
      const outputEntries = readdirSync(dirname(manifestPath));
      const eventRaw = readFileSync(
        join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
        "utf8",
      );
      await rm(tmpRoot, { recursive: true, force: true });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("durable preflight blocked runner_start");
      expect(result.stdout).toContain("durable_json_target_quarantined failed");
      expect(checkpoint).toMatchObject({
        status: "completed",
        graphBuildStatus: { status: "succeeded" },
      });
      expect(outputEntries.some((entry) =>
        entry.startsWith("qmd_output_manifest.json.corrupt-")
      )).toBe(true);
      expect(eventRaw).toContain("durable_json_target_quarantined");
      expect(eventRaw).not.toContain("\"event\":\"item_completed\"");
    });

  test("migrate-only rejects corrupt LanceDB row-count durable checksum",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-row-count-corrupt-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "row-count-corrupt-fixture";
      const fixture = await writeCompletedGraphBatchFixture({
        tmpRoot,
        sourceDir,
        stateRoot,
        configDir,
        runId,
        sourceBytes: "completed with corrupt row-count checksum",
      });
      const rowCountPath = join(
        stateRoot,
        "books",
        fixture.bookId,
        "output",
        "lancedb",
        "entity_description.lance",
        "qmd_row_count.json",
      );
      const rowCountChecksumPath = `${rowCountPath}.sha256`;
      await writeFile(rowCountChecksumPath, `${"0".repeat(64)}\n`, "utf8");
      await writeFile(
        `${rowCountChecksumPath}.meta.json`,
        `${JSON.stringify({ checksum: "stale" }, null, 2)}\n`,
        "utf8",
      );

      const result = await runBatchMigrateOnly({
        tmpRoot,
        sourceDir,
        stateRoot,
        logRoot,
        configDir,
        runId,
      });
      const checkpoint = JSON.parse(readFileSync(
        join(stateRoot, "catalog", "batch-runs", runId, "items", `${fixture.itemId}.json`),
        "utf8",
      ));
      const tableEntries = readdirSync(dirname(rowCountPath));
      const eventRaw = readFileSync(
        join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
        "utf8",
      );
      await rm(tmpRoot, { recursive: true, force: true });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("durable preflight blocked runner_start");
      expect(result.stdout).toContain("durable_json_target_quarantined failed");
      expect(checkpoint).toMatchObject({
        status: "completed",
        graphBuildStatus: { status: "succeeded" },
      });
      expect(tableEntries.some((entry) =>
        entry.startsWith("qmd_row_count.json.corrupt-")
      )).toBe(true);
      expect(eventRaw).toContain("durable_json_target_quarantined");
      expect(eventRaw).not.toContain("\"event\":\"item_completed\"");
    });

  test("status-json reopens completed checkpoint using persisted invalid book identity", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-checkpoint-identity-invalid-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "checkpoint-identity-invalid-fixture";
    const fixture = await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "completed with invalid persisted checkpoint identity",
    });
    const driftBookId = `${fixture.bookId}-catalog-drift`;
    const oldNormalizedPath = join(stateRoot, "input", "book.md");
    await writeProviderAuthReopenGraphFixture({
      stateRoot,
      bookId: driftBookId,
      sourceHash: fixture.sourceHash,
    });
    await writeQmdBuildFixture({
      tmpRoot,
      stateRoot,
      configDir,
      runId,
      itemId: fixture.itemId,
      bookId: driftBookId,
      sourceRelativePath: fixture.sourceRelativePath,
      sourceHash: fixture.sourceHash,
      normalizedPath: oldNormalizedPath,
    });
    await rm(
      join(stateRoot, "books", fixture.bookId, "qmd", "qmd_build_manifest.json"),
      { force: true },
    );
    const stageFingerprints = {
      ingest: "fp-ingest",
      normalize: "fp-normalize",
      graph_extract: "fp-graph-extract",
      community_report: "fp-community-report",
      embed: "fp-embed",
      query_ready: "fp-query-ready",
    };
    await writeDurableYamlFixture(
      join(stateRoot, "catalog", "books.yaml"),
      {
        schemaVersion: SchemaVersion,
        items: [
          {
            schemaVersion: SchemaVersion,
            bookId: fixture.bookId,
            documentId: `doc-${fixture.sourceHash.slice(0, 12)}`,
            sourcePath: `sources/${fixture.bookId}/source.epub`,
            sourceHash: fixture.sourceHash,
            normalizedContentHash: fixture.sourceHash,
            normalizedPath: `books/${fixture.bookId}/input/book.md`,
            configFingerprint: "config-fp",
            promptFingerprint: "prompt-fp",
            modelFingerprint: "model-fp",
            stageFingerprints,
            providerFingerprint: "provider-fp",
            overallStatus: "succeeded",
            createdAt: "2026-05-23T00:00:00.000Z",
            updatedAt: "2026-05-23T00:00:01.000Z",
          },
          {
            schemaVersion: SchemaVersion,
            bookId: driftBookId,
            documentId: `doc-${driftBookId}`,
            sourcePath: `sources/${driftBookId}/source.epub`,
            sourceHash: fixture.sourceHash,
            metadata: { sourceIdentityPath: fixture.sourceRelativePath },
            normalizedContentHash: fixture.sourceHash,
            normalizedPath: `books/${driftBookId}/input/book.md`,
            configFingerprint: "config-fp",
            promptFingerprint: "prompt-fp",
            modelFingerprint: "model-fp",
            stageFingerprints,
            providerFingerprint: "provider-fp",
            overallStatus: "succeeded",
            createdAt: "2026-05-23T00:00:02.000Z",
            updatedAt: "2026-05-23T00:00:03.000Z",
          },
        ],
      },
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${fixture.itemId}.json`),
      "utf8",
    ));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      recoveryDecision: "continue_pending",
      counts: { pending: 1 },
    });
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      bookId: fixture.bookId,
      qmdBuildStatus: {
        status: "pending",
        reason: "qmd_build_manifest_missing",
      },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
      commandCheckStatus: { status: "succeeded" },
    });
    expect(summary.items[0].bookId).not.toBe(driftBookId);
    expect(checkpoint).toMatchObject({
      status: "completed",
      bookId: fixture.bookId,
    });
  });

  test("normal run uses checkpoint identity after catalog drift", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-checkpoint-identity-run-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "checkpoint-identity-normal-run";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourcePath = join(sourceDir, "Book.epub");
    await writeMinimalEpubFixture(sourcePath, "Checkpoint Identity");
    const sourceHash = createHash("sha256")
      .update(readFileSync(sourcePath))
      .digest("hex");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const persistedSourceIdentityPath = join(
      ".tmp-tests",
      "legacy",
      "persisted-source.epub",
    );
    const persistedBookId = batchBookId(sourceHash, persistedSourceIdentityPath);
    const driftBookId = `${persistedBookId}-catalog-drift`;
    const persistedNormalizedPath = join(stateRoot, "input", "persisted-book.md");
    await writeProviderAuthReopenGraphFixture({
      stateRoot,
      bookId: persistedBookId,
      sourceHash,
    });
    const catalogPath = join(stateRoot, "catalog", "books.yaml");
    const catalog = YAML.parse(readFileSync(catalogPath, "utf8"));
    catalog.items.push({
      ...catalog.items[0],
      bookId: driftBookId,
      documentId: `doc-${driftBookId}`,
      sourcePath: `sources/${driftBookId}/source.epub`,
      metadata: { sourceIdentityPath: sourceRelativePath },
      normalizedPath: `books/${driftBookId}/input/book.md`,
      createdAt: "2026-05-23T00:00:02.000Z",
      updatedAt: "2026-05-23T00:00:03.000Z",
    });
    await writeDurableYamlFixture(catalogPath, catalog);
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      },
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "pending",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: persistedSourceIdentityPath,
        sourceHash,
        normalizedPath: relative(projectRoot, persistedNormalizedPath),
        bookId: persistedBookId,
        attempts: 0,
        recoveryDecision: "continue_pending",
        commandChecks: [],
      },
    );

    const resumeCapturePath = join(tmpRoot, "resume-capture.json");
    const resumeScript = join(tmpRoot, "fake-ready-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "const value = (name) => {",
        "  const index = args.indexOf(name);",
        "  return index >= 0 ? args[index + 1] : '';",
        "};",
        "const capture = {",
        "  sourceIdentityPath: value('--source-identity-path'),",
        "  normalizedPath: value('--normalized-path'),",
        "};",
        "writeFileSync(process.env.RESUME_CAPTURE_PATH, JSON.stringify(capture));",
        "if (capture.sourceIdentityPath !== process.env.EXPECTED_SOURCE_IDENTITY_PATH) {",
        "  console.error('unexpected source identity: ' + capture.sourceIdentityPath);",
        "  process.exit(2);",
        "}",
        "if (capture.normalizedPath !== process.env.EXPECTED_NORMALIZED_PATH) {",
        "  console.error('unexpected normalized path: ' + capture.normalizedPath);",
        "  process.exit(3);",
        "}",
        "console.log(JSON.stringify({ status: 'ready', bookId: process.env.EXPECTED_BOOK_ID }));",
      ].join("\n"),
    );
    const qmdScript = join(tmpRoot, "fake-qmd.mjs");
    await writeFile(
      qmdScript,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const args = process.argv.slice(2);",
        "if (process.env.INDEX_PATH) {",
        "  mkdirSync(dirname(process.env.INDEX_PATH), { recursive: true });",
        "  writeFileSync(process.env.INDEX_PATH, 'fake qmd index\\n');",
        "}",
        "if (args.includes('--version')) console.log('qmd-test 1.0.0');",
        "else if (args.includes('--json')) console.log('{}');",
        "else if (args.includes('--csv')) console.log('title');",
        "else if (args.includes('--xml')) console.log('<ok/>');",
        "else if (args.includes('--md')) console.log('# ok');",
        "else console.log('ok');",
      ].join("\n"),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--max-command-attempts",
        "1",
        "--max-resume-passes",
        "1",
      ], {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          QMD_GRAPHRAG_TEST_QMD_RUNNER: "1",
          QMD_GRAPHRAG_QMD_RUNNER: qmdScript,
          RESUME_CAPTURE_PATH: resumeCapturePath,
          EXPECTED_SOURCE_IDENTITY_PATH: persistedSourceIdentityPath,
          EXPECTED_NORMALIZED_PATH: persistedNormalizedPath,
          EXPECTED_BOOK_ID: persistedBookId,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const capture = JSON.parse(readFileSync(resumeCapturePath, "utf8"));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(capture).toMatchObject({
      sourceIdentityPath: persistedSourceIdentityPath,
      normalizedPath: persistedNormalizedPath,
    });
    expect(checkpoint).toMatchObject({
      status: "completed",
      bookId: persistedBookId,
      sourceIdentityPath: persistedSourceIdentityPath,
      normalizedPath: relative(projectRoot, persistedNormalizedPath),
      qmdBuildStatus: {
        status: "succeeded",
        bookId: persistedBookId,
      },
      graphBuildStatus: {
        status: "succeeded",
        stage: "query_ready",
      },
      graphQueryStatus: { status: "succeeded" },
    });
    expect(checkpoint.bookId).not.toBe(driftBookId);
    expect(checkpoint.commandChecks.map((check: { name: string }) => check.name))
      .toEqual([
        ...requiredBatchCommandCheckNames.filter((name) =>
          name !== "qmd-query-auto-json" &&
          name !== "qmd-query-graphrag-json"
        ),
        "qmd-query-auto-json",
        "qmd-query-graphrag-json",
      ]);
  });

  test("status-json reopens completed items when GraphRAG query check failed", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-graph-query-failed-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "graph-query-failed-fixture";
    const sourceBytes = "completed with failed graph query";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const outputRel = join("books", bookId, "graphrag", "output");
    const outputDir = join(stateRoot, outputRel);
    const documentId = `doc-${sourceHash.slice(0, 12)}`;
    const contentHash = sourceHash;
    const stageFingerprints = {
      ingest: "fp-ingest",
      normalize: "fp-normalize",
      graph_extract: "fp-graph-extract",
      community_report: "fp-community-report",
      embed: "fp-embed",
      query_ready: "fp-query-ready",
    };
    const providerFingerprint = "provider-fp";
    const artifactIds = {
      documents: `${bookId}:graph_extract:documents`,
      textUnits: `${bookId}:graph_extract:text_units`,
      entities: `${bookId}:graph_extract:entities`,
      relationships: `${bookId}:graph_extract:relationships`,
      communities: `${bookId}:graph_extract:communities`,
      context: `${bookId}:graph_extract:context`,
      stats: `${bookId}:graph_extract:stats`,
      reports: `${bookId}:community_report:reports`,
      lancedb: `${bookId}:embed:lancedb`,
    };
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const normalizedPath = join(stateRoot, "books", bookId, "input", "book.md");
    await writeQmdBuildFixture({
      tmpRoot,
      stateRoot,
      configDir,
      runId,
      itemId,
      bookId,
      sourceRelativePath,
      sourceHash,
      normalizedPath,
    });
    for (const name of [
      "documents.parquet", "text_units.parquet", "entities.parquet",
      "relationships.parquet", "communities.parquet", "community_reports.parquet",
    ]) {
      await writeMinimalParquetFixture(join(outputDir, name));
    }
    await writeDurableJsonFixture(join(outputDir, "context.json"), {});
    await writeDurableJsonFixture(join(outputDir, "stats.json"), {});
    await writeCompleteLanceDbFixture(join(outputDir, "lancedb"));
    const graphArtifacts = await graphArtifactManifests({
      outputDir,
      outputRel,
      bookId,
      artifactIds,
      stageFingerprints,
      providerFingerprint,
      corpusContentHash: contentHash,
    });
    await writeDurableJsonFixture(
      join(outputDir, "qmd_output_manifest.json"),
      {
        schemaVersion: SchemaVersion,
        bookId,
        sourceHash,
        documentId,
        contentHash,
        stageFingerprints,
        providerFingerprint,
        outputDir: `books/${bookId}/graphrag/output`,
        producerRunId: "run-query-ready",
        stageProducerRunIds: {
          graph_extract: "run-graph-extract",
          community_report: "run-community-report",
          embed: "run-embed",
        },
      },
    );
    await mkdir(join(stateRoot, "books", bookId), { recursive: true });
    await mkdir(join(stateRoot, "catalog"), { recursive: true });
    await writeDurableYamlFixture(
      join(stateRoot, "catalog", "books.yaml"),
      {
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          bookId,
          documentId,
          sourcePath: `sources/${bookId}/source.epub`,
          sourceHash,
          normalizedContentHash: contentHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          configFingerprint: "config-fp",
          promptFingerprint: "prompt-fp",
          modelFingerprint: "model-fp",
          stageFingerprints,
          providerFingerprint,
          overallStatus: "succeeded",
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:01.000Z",
        }],
      },
    );
    await writeDurableYamlFixture(
      join(stateRoot, "books", bookId, "state", "artifacts.yaml"),
      { schemaVersion: SchemaVersion, items: graphArtifacts },
    );
    await writeDurableYamlFixture(
      join(stateRoot, "books", bookId, "state", "checkpoints.yaml"),
      {
        schemaVersion: SchemaVersion,
        items: [
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "graph_extract",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-graph-extract",
            inputFingerprint: "fp-graph-extract",
            contentHash,
            stageFingerprint: "fp-graph-extract",
            providerFingerprint,
            artifactIds: [
              artifactIds.documents, artifactIds.textUnits, artifactIds.entities,
              artifactIds.relationships, artifactIds.communities,
              artifactIds.context, artifactIds.stats,
            ],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "community_report",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-community-report",
            inputFingerprint: "fp-community-report",
            contentHash,
            stageFingerprint: "fp-community-report",
            providerFingerprint,
            artifactIds: [artifactIds.reports],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "embed",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-embed",
            inputFingerprint: "fp-embed",
            contentHash,
            stageFingerprint: "fp-embed",
            providerFingerprint,
            artifactIds: [artifactIds.lancedb],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "query_ready",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-query-ready",
            inputFingerprint: "fp-query-ready",
            contentHash,
            stageFingerprint: "fp-query-ready",
            providerFingerprint,
            artifactIds: [artifactIds.reports, artifactIds.lancedb],
          },
        ],
      },
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      },
    );
    const commandChecks = passedBatchCommandChecks().map((check) =>
      check.name === "qmd-query-graphrag-json"
        ? {
            ...check,
            status: "failed",
            exitCode: 1,
            stderrBytes: 32,
            failureKind: "transient",
            retryable: true,
            attemptExhausted: false,
            recoveryDecision: "retry_same_run_id",
            errorSummary: "GraphRAG query provider failed",
          }
        : check
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "completed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: relative(projectRoot, normalizedPath),
        bookId,
        attempts: 1,
        qmdBuildStatus: { status: "succeeded" },
        commandChecks,
      },
    );

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--status-json",
        ]);
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
      },
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      failedStage: "qmd-query-graphrag-json",
      qmdBuildStatus: { status: "succeeded" },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
      graphQueryStatus: {
        status: "failed",
        stage: "qmd-query-graphrag-json",
        reason: "graph_query_command_check_failed",
      },
    });
  });

  test("normal run keeps qmd build succeeded when GraphRAG query check fails", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-qmd-build-before-query-fail-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "qmd-build-before-query-fail-fixture";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourcePath = join(sourceDir, "Book.epub");
    await writeMinimalEpubFixture(sourcePath, "QMD Build Before Query Failure");
    const sourceHash = createHash("sha256")
      .update(readFileSync(sourcePath))
      .digest("hex");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    await writeProviderAuthReopenGraphFixture({ stateRoot, bookId, sourceHash });

    const resumeScript = join(tmpRoot, "fake-ready-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "console.log(JSON.stringify({ status: 'ready', bookId: process.env.TEST_BOOK_ID }));",
      ].join("\n"),
    );
    const qmdScript = join(tmpRoot, "fake-qmd-query-fail.mjs");
    const graphQueryError = {
      schemaVersion: "1.0.0",
      route: "graphrag",
      stage: "graphrag_query",
      provider: "graphrag",
      capability: "graph_query",
      code: "provider_unavailable",
      retryable: false,
      redactedMessage:
        "GraphRAG query provider failed before returning a response.",
    };
    await writeFile(
      qmdScript,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const args = process.argv.slice(2);",
        "if (process.env.INDEX_PATH) {",
        "  mkdirSync(dirname(process.env.INDEX_PATH), { recursive: true });",
        "  writeFileSync(process.env.INDEX_PATH, 'fake qmd index\\n');",
        "}",
        "if (args.includes('--graphrag')) {",
        `  console.error(${JSON.stringify(JSON.stringify(graphQueryError, null, 2))});`,
        "  process.exit(1);",
        "}",
        "if (args.includes('--version')) console.log('qmd-test 1.0.0');",
        "else if (args.includes('--json')) console.log('{}');",
        "else if (args.includes('--csv')) console.log('title');",
        "else if (args.includes('--xml')) console.log('<ok/>');",
        "else if (args.includes('--md')) console.log('# ok');",
        "else console.log('ok');",
      ].join("\n"),
    );

    const result = await new Promise<{
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--fail-fast",
        "--max-command-attempts",
        "1",
        "--max-resume-passes",
        "1",
        "--retry-base-delay-seconds",
        "1",
        "--retry-max-delay-seconds",
        "1",
        "--retry-budget-seconds",
        "60",
      ], {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          QMD_GRAPHRAG_TEST_QMD_RUNNER: "1",
          QMD_GRAPHRAG_QMD_RUNNER: qmdScript,
          TEST_BOOK_ID: bookId,
        },
      });
      let stderr = "";
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
    });

    const checkpointPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    const qmdBuildManifestPath = join(
      stateRoot,
      "books",
      bookId,
      "qmd",
      "qmd_build_manifest.json",
    );
    const qmdBuildManifest = JSON.parse(
      readFileSync(qmdBuildManifestPath, "utf8"),
    );
    const statusResult = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
      args: ["--skip-dotenv"],
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("\"stage\": \"graphrag_query\"");
    expect(qmdBuildManifest).toMatchObject({
      kind: "qmd_build_manifest",
      itemId,
      runId,
      bookId,
      commandCheckNames: expect.not.arrayContaining([
        "qmd-query-auto-json",
        "qmd-query-graphrag-json",
      ]),
    });
    expect(qmdBuildManifest.commandCheckNames).toHaveLength(
      requiredBatchCommandCheckNames.length - 2,
    );
    expect(checkpoint).toMatchObject({
      status: "pending",
      bookId,
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      failedStage: "qmd-query-graphrag-json",
      qmdBuildStatus: { status: "succeeded", bookId },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
      graphQueryStatus: {
        status: "failed",
        stage: "qmd-query-graphrag-json",
      },
    });
    expect(checkpoint.commandChecks.map((check: { name: string }) => check.name))
      .toEqual([
        ...requiredBatchCommandCheckNames.filter((name) =>
          name !== "qmd-query-auto-json" &&
          name !== "qmd-query-graphrag-json"
        ),
        "qmd-query-auto-json",
        "qmd-query-graphrag-json",
      ]);
    const summary = JSON.parse(statusResult.stdout);
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stderr).toBe("");
    expect(summary).toMatchObject({
      recoveryDecision: "retry_same_run_id",
      retryableItemCount: 1,
      counts: { pending: 1 },
    });
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      qmdBuildStatus: { status: "succeeded", bookId },
      commandCheckStatus: {
        status: "failed",
        stage: "qmd-query-graphrag-json",
      },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
      graphQueryStatus: {
        status: "failed",
        stage: "qmd-query-graphrag-json",
      },
    });
  });

  test("status-json reopens completed items with incomplete command check set", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-incomplete-command-checks-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "incomplete-command-checks-fixture";
    const sourceBytes = "completed with incomplete command checks";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const outputRel = join("books", bookId, "graphrag", "output");
    const outputDir = join(stateRoot, outputRel);
    const documentId = `doc-${sourceHash.slice(0, 12)}`;
    const contentHash = sourceHash;
    const stageFingerprints = {
      ingest: "fp-ingest",
      normalize: "fp-normalize",
      graph_extract: "fp-graph-extract",
      community_report: "fp-community-report",
      embed: "fp-embed",
      query_ready: "fp-query-ready",
    };
    const providerFingerprint = "provider-fp";
    const artifactIds = {
      documents: `${bookId}:graph_extract:documents`,
      textUnits: `${bookId}:graph_extract:text_units`,
      entities: `${bookId}:graph_extract:entities`,
      relationships: `${bookId}:graph_extract:relationships`,
      communities: `${bookId}:graph_extract:communities`,
      context: `${bookId}:graph_extract:context`,
      stats: `${bookId}:graph_extract:stats`,
      reports: `${bookId}:community_report:reports`,
      lancedb: `${bookId}:embed:lancedb`,
    };
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const normalizedPath = join(stateRoot, "books", bookId, "input", "book.md");
    await writeQmdBuildFixture({
      tmpRoot,
      stateRoot,
      configDir,
      runId,
      itemId,
      bookId,
      sourceRelativePath,
      sourceHash,
      normalizedPath,
    });
    for (const name of [
      "documents.parquet", "text_units.parquet", "entities.parquet",
      "relationships.parquet", "communities.parquet", "community_reports.parquet",
    ]) {
      await writeMinimalParquetFixture(join(outputDir, name));
    }
    await writeDurableJsonFixture(join(outputDir, "context.json"), {});
    await writeDurableJsonFixture(join(outputDir, "stats.json"), {});
    await writeCompleteLanceDbFixture(join(outputDir, "lancedb"));
    const graphArtifacts = await graphArtifactManifests({
      outputDir,
      outputRel,
      bookId,
      artifactIds,
      stageFingerprints,
      providerFingerprint,
      corpusContentHash: contentHash,
    });
    await writeDurableJsonFixture(
      join(outputDir, "qmd_output_manifest.json"),
      {
        schemaVersion: SchemaVersion,
        bookId,
        sourceHash,
        documentId,
        contentHash,
        stageFingerprints,
        providerFingerprint,
        outputDir: `books/${bookId}/graphrag/output`,
        producerRunId: "run-query-ready",
        stageProducerRunIds: {
          graph_extract: "run-graph-extract",
          community_report: "run-community-report",
          embed: "run-embed",
        },
      },
    );
    await mkdir(join(stateRoot, "books", bookId), { recursive: true });
    await mkdir(join(stateRoot, "catalog"), { recursive: true });
    await writeDurableYamlFixture(
      join(stateRoot, "catalog", "books.yaml"),
      {
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          bookId,
          documentId,
          sourcePath: `sources/${bookId}/source.epub`,
          sourceHash,
          normalizedContentHash: contentHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          configFingerprint: "config-fp",
          promptFingerprint: "prompt-fp",
          modelFingerprint: "model-fp",
          stageFingerprints,
          providerFingerprint,
          overallStatus: "succeeded",
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:01.000Z",
        }],
      },
    );
    await writeDurableYamlFixture(
      join(stateRoot, "books", bookId, "state", "artifacts.yaml"),
      { schemaVersion: SchemaVersion, items: graphArtifacts },
    );
    await writeDurableYamlFixture(
      join(stateRoot, "books", bookId, "state", "checkpoints.yaml"),
      {
        schemaVersion: SchemaVersion,
        items: [
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "graph_extract",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-graph-extract",
            inputFingerprint: "fp-graph-extract",
            contentHash,
            stageFingerprint: "fp-graph-extract",
            providerFingerprint,
            artifactIds: [
              artifactIds.documents, artifactIds.textUnits, artifactIds.entities,
              artifactIds.relationships, artifactIds.communities,
              artifactIds.context, artifactIds.stats,
            ],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "community_report",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-community-report",
            inputFingerprint: "fp-community-report",
            contentHash,
            stageFingerprint: "fp-community-report",
            providerFingerprint,
            artifactIds: [artifactIds.reports],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "embed",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-embed",
            inputFingerprint: "fp-embed",
            contentHash,
            stageFingerprint: "fp-embed",
            providerFingerprint,
            artifactIds: [artifactIds.lancedb],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "query_ready",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-query-ready",
            inputFingerprint: "fp-query-ready",
            contentHash,
            stageFingerprint: "fp-query-ready",
            providerFingerprint,
            artifactIds: [artifactIds.reports, artifactIds.lancedb],
          },
        ],
      },
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      },
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "completed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: relative(projectRoot, normalizedPath),
        bookId,
        attempts: 1,
        qmdBuildStatus: { status: "succeeded" },
        graphBuildStatus: { status: "succeeded" },
        graphQueryStatus: { status: "succeeded" },
        commandChecks: passedBatchCommandChecks()
          .filter((check) => check.name !== "qmd-cleanup"),
      },
    );

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--status-json",
        ]);
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
      },
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("continue_pending");
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failedStage: "qmd-cleanup",
      qmdBuildStatus: { status: "succeeded" },
      commandCheckStatus: {
        status: "pending",
        stage: "qmd-cleanup",
        reason: "command_check_missing",
      },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
      graphQueryStatus: { status: "succeeded" },
    });
  });
  test("reconciles an existing manifest when source EPUBs grow", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-grow-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "grow-fixture";
    const { createHash } = await import("crypto");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId), { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(sourceDir, "A.epub"), "book-a");
    await writeFile(join(sourceDir, "B.epub"), "book-b");
    const hashA = createHash("sha256").update("book-a").digest("hex");
    const hashB = createHash("sha256").update("book-b").digest("hex");
    const completedManifest = join(tmpRoot, "completed.json");
    await writeFile(
      completedManifest,
      JSON.stringify([
        { source: "A.epub", sourceHash: hashA },
        { source: "B.epub", sourceHash: hashB },
      ]),
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/old/graph_vault",
        qmdIndexLocator: ".tmp-tests/old/index.sqlite",
        configLocator: ".tmp-tests/old/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: ["stale-item"],
      },
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--completed-manifest",
          completedManifest,
          "--run-id",
          runId,
          "--skip-dotenv",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const manifest = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      "utf8",
    ));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(manifest).toMatchObject({
      status: "failed",
      totalItems: 2,
      pendingItems: 0,
      completedItems: 0,
      skippedItems: 0,
      importedCompletedItems: 2,
      failedItems: 2,
    });
    expect(manifest.itemIds).toHaveLength(2);
    expect(manifest.itemIds).not.toContain("stale-item");
  });

  test("rebuilds manifest mismatched with durable checkpoints", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-manifest-rebuild-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "manifest-rebuild-fixture";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourcePath = join(sourceDir, "Book.epub");
    await writeMinimalEpubFixture(sourcePath, "Manifest Rebuild");
    const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      {
        schemaVersion: SchemaVersion,
        runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/old/graph_vault",
        qmdIndexLocator: ".tmp-tests/old/index.sqlite",
        configLocator: ".tmp-tests/old/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      },
    );
    await writeDurableJsonFixture(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      {
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "pending",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 0,
        commandChecks: [],
      },
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--migrate-only",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summaryPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "recovery-summary.json",
    );
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(summary.manifest).toMatchObject({
      status: "running",
      totalItems: 1,
      pendingItems: 1,
      completedItems: 0,
      failedItems: 0,
    });
    expect(events.some((event) =>
      event.event === "manifest_rebuilt" &&
      event.metadata?.reason === "manifest_checkpoint_projection_mismatch"
    )).toBe(true);
  });
});
