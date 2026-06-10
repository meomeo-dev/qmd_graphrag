import { expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { existsSync, readFileSync, readdirSync } from "fs";
import { delimiter, dirname, join, relative } from "path";
import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { createHash } from "crypto";
import YAML from "yaml";
import { classifyFailure } from "../../scripts/graphrag/batch-failure-classifier.mjs";
import { SchemaVersion } from "../../src/contracts/common.ts";
import {
  hashLanceDbDirectoryContents,
} from "../../src/job-state/artifact-validation.ts";
import { hashFile } from "../../src/job-state/fingerprint.ts";
import { sanitizeVaultText } from "../../src/vault/metadata.ts";
import {
  ensureBookScopedQmdIndex,
} from "../../scripts/graphrag/book-hotplug-qmd-index.mjs";
import { projectRoot } from "./cli-harness.ts";

export { classifyFailure, projectRoot, sanitizeVaultText };

const MinimalParquetFixture = Buffer.from(
  "UEFSMRUEFRIVFkwVAhUAEgAACSAFAAAAcm93LTEVABUSFRYsFQIVEBUGFQYcNgAoBXJvdy0xGAVyb3ctMRERAAAACSACAAAAAgEBAgAVBBksNQAYBnNjaGVtYRUCABUMJQIYAmlkJQBMHAAAABYCGRwZHCYAHBUMGTUABhAZGAJpZBUCFgIWigEWkgEmOiYIHDYAKAVyb3ctMRgFcm93LTEREQAZLBUEFQAVAgAVABUQFQIAPBYKGQYZJgACAAAAFooBFgImCBaSAQAZHBgMQVJST1c6c2NoZW1hGKABLy8vLy8zQUFBQUFRQUFBQUFBQUtBQXdBQmdBRkFBZ0FDZ0FBQUFBQkJBQU1BQUFBQ0FBSUFBQUFCQUFJQUFBQUJBQUFBQUVBQUFBVUFBQUFFQUFVQUFnQUJnQUhBQXdBQUFBUUFCQUFBQUFBQUFFRkVBQUFBQmdBQUFBRUFBQUFBQUFBQUFJQUFBQnBaQUFBQkFBRUFBUUFBQUFBQUFBQQAYIHBhcnF1ZXQtY3BwLWFycm93IHZlcnNpb24gMjIuMC4wGRwcAAAAWgEAAFBBUjE=",
  "base64",
);

export async function mkProjectTmpDir(prefix: string): Promise<string> {
  const root = join(projectRoot, ".tmp-tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

export const requiredBatchCommandCheckNames = [
  "qmd-version",
  "qmd-status",
  "qmd-doctor-json",
  "qmd-pull",
  "qmd-update",
  "qmd-embed",
  "qmd-ls-books",
  "qmd-search-json",
  "qmd-search-csv",
  "qmd-search-md",
  "qmd-search-xml",
  "qmd-search-files",
  "qmd-vsearch-json",
  "qmd-query-json",
  "qmd-query-auto-json",
  "qmd-query-graphrag-json",
  "qmd-get-book",
  "qmd-multi-get-json",
  "qmd-collection-list",
  "qmd-collection-show-books",
  "qmd-context-list",
  "qmd-skills-list-json",
  "qmd-skills-get-json",
  "qmd-skills-path-json",
  "qmd-skill-show",
  "qmd-dspy-status-json",
  "qmd-cleanup",
];

export function passedBatchCommandChecks() {
  return requiredBatchCommandCheckNames.map((name) => ({
    name,
    status: "passed",
    attempts: 1,
    exitCode: 0,
    stdoutBytes: 1,
    stderrBytes: 0,
    startedAt: "2026-05-23T00:00:00.000Z",
    completedAt: "2026-05-23T00:00:01.000Z",
  }));
}

export function batchBookId(sourceHash: string, sourceRelativePath: string): string {
  const pathHash = createHash("sha256")
    .update(sourceRelativePath.normalize("NFKC").toLowerCase())
    .digest("hex");
  return `book-${sourceHash.slice(0, 12)}-${pathHash.slice(0, 8)}`;
}

export function stableJsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function stableTextHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isDurableAuxiliaryJsonEntry(entry: string): boolean {
  return entry.endsWith(".owner.json") ||
    entry.endsWith(".sha256.meta.json") ||
    entry.includes(".tmp-") ||
    entry.includes(".corrupt-");
}

export function durablePrimaryJsonEntries(path: string): string[] {
  return readdirSync(path)
    .filter((name) => name.endsWith(".json") && !isDurableAuxiliaryJsonEntry(name));
}

export function nodeScriptBin(): string {
  if (!process.versions.bun) return process.execPath;
  const names = process.platform === "win32"
    ? ["node.exe", "node.cmd", "node"]
    : ["node"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "node";
}

export async function writeDurableTextFixture(
  path: string,
  text: string,
  meta: Record<string, unknown> = {},
): Promise<string> {
  const checksum = stableTextHash(text);
  const operationId = `fixture-${stableTextHash(path).slice(0, 16)}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
  await writeFile(`${path}.sha256`, `${checksum}\n`, "utf8");
  await writeFile(
    `${path}.sha256.meta.json`,
    `${JSON.stringify({
      checksum,
      targetLocator: relative(projectRoot, path),
      absoluteTargetLocator: path,
      checksumPath: relative(projectRoot, `${path}.sha256`),
      checksumRecoveryDecision: "committed",
      commitState: "committed",
      operationId,
      runnerSessionId: "fixture-runner",
      fencingTokenHash: stableTextHash(`fixture-fence:${path}`),
      targetGeneration: 1,
      committedAt: "2026-05-23T00:00:00.000Z",
      ...meta,
    }, null, 2)}\n`,
    "utf8",
  );
  return text;
}

export async function writeDurableJsonFixture(
  path: string,
  value: unknown,
  meta: Record<string, unknown> = {},
): Promise<string> {
  return writeDurableTextFixture(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    meta,
  );
}

export async function writeDurableYamlFixture(
  path: string,
  value: unknown,
  meta: Record<string, unknown> = {},
): Promise<string> {
  return writeDurableTextFixture(path, YAML.stringify(value), meta);
}

export async function writeQmdBuildFixture(input: {
  tmpRoot: string;
  stateRoot: string;
  configDir: string;
  runId: string;
  itemId: string;
  bookId: string;
  sourceName?: string;
  sourceRelativePath: string;
  sourceHash: string;
  normalizedPath: string;
}): Promise<void> {
  const normalizedContent = "# Book\n\nSoftware design complexity.\n";
  const normalizedContentHash = createHash("sha256")
    .update(normalizedContent)
    .digest("hex");
  const qmdIndexPath = join(input.tmpRoot, "index.sqlite");
  const configPath = join(input.configDir, "index.yml");
  await mkdir(dirname(input.normalizedPath), { recursive: true });
  await writeFile(input.normalizedPath, normalizedContent);
  await writeFile(qmdIndexPath, `qmd index for ${input.bookId}\n`);
  await mkdir(join(input.stateRoot, "books", input.bookId, "qmd"), {
    recursive: true,
  });
  await writeDurableJsonFixture(
    join(input.stateRoot, "books", input.bookId, "qmd", "qmd_build_manifest.json"),
    {
      schemaVersion: SchemaVersion,
      kind: "qmd_build_manifest",
      itemId: input.itemId,
      runId: input.runId,
      bookId: input.bookId,
      sourceName: input.sourceName ?? "Book.epub",
      sourceRelativePath: input.sourceRelativePath,
      sourceHash: input.sourceHash,
      normalizedPath: relative(projectRoot, input.normalizedPath),
      normalizedContentHash,
      qmdIndexLocator: relative(projectRoot, qmdIndexPath),
      qmdIndexHash: createHash("sha256")
        .update(readFileSync(qmdIndexPath))
        .digest("hex"),
      configLocator: relative(projectRoot, configPath),
      configHash: createHash("sha256")
        .update(readFileSync(configPath))
        .digest("hex"),
      commandCheckNames: requiredBatchCommandCheckNames,
      commandCheckFingerprint: stableJsonHash(requiredBatchCommandCheckNames),
      producerRunId: "qmd-build-run",
      createdAt: "2026-05-23T00:00:00.000Z",
    },
  );
  await ensureBookScopedQmdIndex({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    normalizedPath: input.normalizedPath,
    normalizedContentHash,
    sourceQmdIndexPath: qmdIndexPath,
    rootPath: projectRoot,
    now: () => "2026-05-23T00:00:00.000Z",
    toolVersion: "test-qmd-build-fixture",
  });
}

export async function writeBookScopedQmdIndexFixture(input: {
  stateRoot: string;
  bookId: string;
  normalizedPath: string;
  normalizedContentHash?: string;
}): Promise<void> {
  await ensureBookScopedQmdIndex({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    normalizedPath: input.normalizedPath,
    normalizedContentHash: input.normalizedContentHash,
    rootPath: projectRoot,
    now: () => "2026-05-23T00:00:00.000Z",
    toolVersion: "test-fixture",
  });
}

export async function writeMinimalParquetFixture(path: string): Promise<void> {
  await writeFile(path, MinimalParquetFixture);
}

export async function writeCompleteLanceDbFixture(root: string): Promise<void> {
  for (const tableName of [
    "entity_description.lance",
    "community_full_content.lance",
    "text_unit_text.lance",
  ]) {
    const tableDir = join(root, tableName);
    await mkdir(join(tableDir, "data"), { recursive: true });
    await mkdir(join(tableDir, "_versions"), { recursive: true });
    await writeFile(join(tableDir, "data", "part-1.lance"), "rows", "utf8");
    await writeFile(
      join(tableDir, "_versions", "1.manifest"),
      "part-1.lance",
      "utf8",
    );
    await writeDurableJsonFixture(
      join(tableDir, "qmd_row_count.json"),
      { schemaVersion: SchemaVersion, rowCount: 1 },
    );
  }
}

export async function writeMinimalEpubFixture(path: string, title = "Book"): Promise<void> {
  const script = [
    "import zipfile",
    "import sys",
    "path, title = sys.argv[1:3]",
    "entries = {",
    " 'META-INF/container.xml': '<?xml version=\"1.0\"?><container xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles><rootfile full-path=\"OPS/package.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>',",
    " 'OPS/package.opf': '<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\" unique-identifier=\"bookid\"><metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>' + title + '</dc:title></metadata><manifest><item id=\"chap1\" href=\"chapter.xhtml\" media-type=\"application/xhtml+xml\"/></manifest><spine><itemref idref=\"chap1\"/></spine></package>',",
    " 'OPS/chapter.xhtml': '<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><h1>' + title + '</h1><p>Software design complexity.</p></body></html>',",
    "}",
    "with zipfile.ZipFile(path, 'w') as zf:",
    "  for name, body in entries.items():",
    "    zf.writestr(name, body)",
  ].join("\n");
  await new Promise<void>((resolveResult, reject) => {
    const proc = spawn("python3", ["-c", script, path, title]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
    proc.on("close", (exitCode) => {
      if (exitCode === 0) resolveResult();
      else reject(new Error(stderr || `python3 exited ${exitCode}`));
    });
    proc.on("error", reject);
  });
}

export async function writeProviderAuthReopenGraphFixture(input: {
  stateRoot: string;
  bookId: string;
  sourceHash: string;
  contentHash?: string;
}): Promise<void> {
  const outputRel = join("books", input.bookId, "graphrag", "output");
  const outputDir = join(input.stateRoot, outputRel);
  const contentHash = input.contentHash ?? input.sourceHash;
  const documentId = `doc-${input.sourceHash.slice(0, 12)}`;
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
    documents: `${input.bookId}:graph_extract:documents`,
    textUnits: `${input.bookId}:graph_extract:text_units`,
    entities: `${input.bookId}:graph_extract:entities`,
    relationships: `${input.bookId}:graph_extract:relationships`,
    communities: `${input.bookId}:graph_extract:communities`,
    context: `${input.bookId}:graph_extract:context`,
    stats: `${input.bookId}:graph_extract:stats`,
    reports: `${input.bookId}:community_report:reports`,
    lancedb: `${input.bookId}:embed:lancedb`,
  };
  await mkdir(outputDir, { recursive: true });
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
    bookId: input.bookId,
    artifactIds,
    stageFingerprints,
    providerFingerprint,
    corpusContentHash: contentHash,
  });
  await writeDurableJsonFixture(
    join(outputDir, "qmd_output_manifest.json"),
    {
      schemaVersion: SchemaVersion,
      bookId: input.bookId,
      sourceHash: input.sourceHash,
      documentId,
      contentHash,
      stageFingerprints,
      providerFingerprint,
      outputDir: outputRel,
      producerRunId: "run-query-ready",
      stageProducerRunIds: {
        graph_extract: "run-graph-extract",
        community_report: "run-community-report",
        embed: "run-embed",
      },
    },
  );
  await writeDurableJsonFixture(
    join(outputDir, "qmd_graph_text_unit_identity.json"),
    {
      schemaVersion: SchemaVersion,
      bookId: input.bookId,
      sourceId: `sha256:${input.sourceHash}`,
      sourceHash: input.sourceHash,
      documentId,
      contentHash,
      normalizedPath: `books/${input.bookId}/input/book.md`,
      graphDocumentId: `graph-doc-${input.bookId}`,
      graphTextUnitIds: [`tu-${input.bookId}`],
    },
  );
  await mkdir(join(input.stateRoot, "catalog"), { recursive: true });
  await mkdir(join(input.stateRoot, "books", input.bookId), { recursive: true });
  await mkdir(join(input.stateRoot, "books", input.bookId, "state"), {
    recursive: true,
  });
  await mkdir(join(input.stateRoot, "books", input.bookId, "graphrag", "runs"), {
    recursive: true,
  });
  const booksPath = join(input.stateRoot, "catalog", "books.yaml");
  const existingBooks = existsSync(booksPath)
    ? YAML.parse(readFileSync(booksPath, "utf8"))
    : { schemaVersion: SchemaVersion, items: [] };
  const nextBook = {
    schemaVersion: SchemaVersion,
    bookId: input.bookId,
    documentId,
    sourcePath: `books/${input.bookId}/source/source.epub`,
    sourceHash: input.sourceHash,
    normalizedContentHash: contentHash,
    normalizedPath: `books/${input.bookId}/input/book.md`,
    configFingerprint: "config-fp",
    promptFingerprint: "prompt-fp",
    modelFingerprint: "model-fp",
    stageFingerprints,
    providerFingerprint,
    overallStatus: "succeeded",
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:01.000Z",
  };
  await writeDurableYamlFixture(
    booksPath,
    {
      schemaVersion: SchemaVersion,
      items: [
        ...(existingBooks.items ?? []).filter(
          (item: { bookId?: string }) => item.bookId !== input.bookId,
        ),
        nextBook,
      ],
    },
  );
  await writeDurableYamlFixture(
    join(input.stateRoot, "books", input.bookId, "state", "job.yaml"),
    nextBook,
  );
  await writeDurableYamlFixture(
    join(input.stateRoot, "books", input.bookId, "state", "artifacts.yaml"),
    { schemaVersion: SchemaVersion, items: graphArtifacts },
  );
  await writeDurableYamlFixture(
    join(input.stateRoot, "books", input.bookId, "state", "checkpoints.yaml"),
    {
      schemaVersion: SchemaVersion,
      items: [
        {
          schemaVersion: SchemaVersion,
          bookId: input.bookId,
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
          bookId: input.bookId,
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
          bookId: input.bookId,
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
          bookId: input.bookId,
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
  for (const run of [
    {
      runId: "run-graph-extract",
      stage: "graph_extract",
      artifactIds: [
        artifactIds.documents, artifactIds.textUnits, artifactIds.entities,
        artifactIds.relationships, artifactIds.communities,
        artifactIds.context, artifactIds.stats,
      ],
    },
    {
      runId: "run-community-report",
      stage: "community_report",
      artifactIds: [artifactIds.reports],
    },
    {
      runId: "run-embed",
      stage: "embed",
      artifactIds: [artifactIds.lancedb],
    },
    {
      runId: "run-query-ready",
      stage: "query_ready",
      artifactIds: [artifactIds.reports, artifactIds.lancedb],
    },
  ]) {
    await writeDurableYamlFixture(
      join(
        input.stateRoot,
        "books",
        input.bookId,
        "graphrag",
        "runs",
        `${run.runId}.yaml`,
      ),
      {
        schemaVersion: SchemaVersion,
        runId: run.runId,
        bookId: input.bookId,
        stage: run.stage,
        status: "succeeded",
        attemptCount: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        finishedAt: "2026-05-23T00:00:01.000Z",
        inputFingerprint: stageFingerprints[run.stage as keyof typeof stageFingerprints],
        artifactIds: run.artifactIds,
        metadata: {
          stageFingerprint: stageFingerprints[run.stage as keyof typeof stageFingerprints],
          providerFingerprint,
        },
      },
    );
  }
}

export async function writeProviderAuthStoppedBatchFixture(input: {
  tmpRoot: string;
  sourceDir: string;
  stateRoot: string;
  configDir: string;
  runId: string;
  sourceName?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ itemId: string; bookId: string; sourceHash: string; sourceRelativePath: string }> {
  await mkdir(input.sourceDir, { recursive: true });
  await mkdir(input.configDir, { recursive: true });
  await mkdir(join(input.stateRoot, "catalog", "batch-runs", input.runId, "items"), {
    recursive: true,
  });
  await writeFile(join(input.configDir, "index.yml"), "collections: {}\n");
  await writeFile(
    join(input.tmpRoot, ".env"),
    [
      "OPENAI_API_KEY=file-openai-key",
      "OPENAI_BASE_URL=https://api.openai.example",
      "JINA_API_KEY=file-jina-key",
      "JINA_API_BASE=https://api.jina.example",
    ].join("\n"),
  );
  await writeFile(
    join(input.stateRoot, ".env"),
    [
      "OPENAI_API_KEY=file-openai-key",
      "OPENAI_BASE_URL=https://api.openai.example",
      "JINA_API_KEY=file-jina-key",
      "JINA_API_BASE=https://api.jina.example",
    ].join("\n"),
  );
  const sourcePath = join(input.sourceDir, input.sourceName ?? "A-Auth.epub");
  await writeMinimalEpubFixture(sourcePath, "A Auth");
  const sourceHash = createHash("sha256")
    .update(readFileSync(sourcePath))
    .digest("hex");
  const sourceRelativePath = relative(projectRoot, sourcePath);
  const itemId = `item-${sourceHash.slice(0, 12)}-${
    createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
  }`;
  const bookId = batchBookId(sourceHash, sourceRelativePath);
  await writeDurableJsonFixture(
    join(input.stateRoot, "catalog", "batch-runs", input.runId, "manifest.json"),
    {
      schemaVersion: SchemaVersion,
      runId: input.runId,
      status: "failed",
      sourceRootName: "source",
      stateRootLocator: ".tmp-tests/unused/graph_vault",
      qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
      configLocator: ".tmp-tests/unused/config/index.yml",
      totalItems: 1,
      pendingItems: 0,
      runningItems: 0,
      completedItems: 0,
      skippedItems: 0,
      importedCompletedItems: 0,
      failedItems: 1,
      startedAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:01:00.000Z",
      itemIds: [itemId],
    },
  );
  const providerError =
    "Error code: 401 - {'code': 'INVALID_API_KEY', " +
    "'message': 'Invalid API key'}";
  await writeDurableJsonFixture(
    join(input.stateRoot, "catalog", "batch-runs", input.runId, "items", `${itemId}.json`),
    {
      schemaVersion: SchemaVersion,
      itemId,
      runId: input.runId,
      status: "failed",
      sourceName: input.sourceName ?? "A-Auth.epub",
      sourceRelativePath,
      sourceIdentityPath: sourceRelativePath,
      sourceHash,
      normalizedPath: join(".tmp-tests", "graph_vault", "input", "a-auth.md"),
      bookId,
      attempts: 1,
      failedAt: "2026-05-23T00:10:00.000Z",
      failureKind: "permanent",
      retryable: false,
      retryExhausted: true,
      recoveryDecision: "stop_until_fixed",
      failedStage: "resume-book-1",
      errorSummary: providerError,
      commandChecks: [{
        name: "resume-book-1",
        status: "failed",
        attempts: 1,
        exitCode: 1,
        stdoutBytes: 0,
        stderrBytes: 120,
        startedAt: "2026-05-23T00:00:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        failureKind: "permanent",
        retryable: false,
        attemptExhausted: true,
        providerStatusCode: 401,
        recoveryDecision: "stop_until_fixed",
        errorSummary: providerError,
      }],
      metadata: input.metadata,
    },
  );
  return { itemId, bookId, sourceHash, sourceRelativePath };
}

export async function runBatchStatusJson(input: {
  tmpRoot: string;
  sourceDir: string;
  stateRoot: string;
  logRoot: string;
  configDir: string;
  runId: string;
  env?: Record<string, string>;
  args?: string[];
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveResult) => {
    const proc = spawn(nodeScriptBin(), [
      join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
      "--source-dir",
      input.sourceDir,
      "--state-root",
      input.stateRoot,
      "--log-root",
      input.logRoot,
      "--config",
      join(input.configDir, "index.yml"),
      "--qmd-index-path",
      join(input.tmpRoot, "index.sqlite"),
      "--run-id",
      input.runId,
      "--status-json",
      ...(input.args ?? []),
    ], {
      cwd: input.tmpRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(input.env ?? {}),
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
    proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
    proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
  });
}

export async function runBatchMigrateOnly(input: {
  tmpRoot: string;
  sourceDir: string;
  stateRoot: string;
  logRoot: string;
  configDir: string;
  runId: string;
  env?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveResult) => {
    const proc = spawn(nodeScriptBin(), [
      join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
      "--source-dir",
      input.sourceDir,
      "--state-root",
      input.stateRoot,
      "--log-root",
      input.logRoot,
      "--config",
      join(input.configDir, "index.yml"),
      "--qmd-index-path",
      join(input.tmpRoot, "index.sqlite"),
      "--run-id",
      input.runId,
      "--skip-dotenv",
      "--migrate-only",
    ], {
      cwd: input.tmpRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(input.env ?? {}),
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
    proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
    proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
  });
}

export async function graphArtifactManifests(input: {
  outputDir: string;
  outputRel: string;
  bookId: string;
  corpusContentHash: string;
  artifactIds: Record<string, string>;
  stageFingerprints: Record<string, string>;
  providerFingerprint: string;
}) {
  const specs = [
    [input.artifactIds.documents, "graph_extract", "graphrag_documents_parquet", "documents.parquet"],
    [input.artifactIds.textUnits, "graph_extract", "graphrag_text_units_parquet", "text_units.parquet"],
    [input.artifactIds.entities, "graph_extract", "graphrag_entities_parquet", "entities.parquet"],
    [input.artifactIds.relationships, "graph_extract", "graphrag_relationships_parquet", "relationships.parquet"],
    [input.artifactIds.communities, "graph_extract", "graphrag_communities_parquet", "communities.parquet"],
    [input.artifactIds.context, "graph_extract", "graphrag_context_json", "context.json"],
    [input.artifactIds.stats, "graph_extract", "graphrag_stats_json", "stats.json"],
    [input.artifactIds.reports, "community_report", "graphrag_community_reports_parquet", "community_reports.parquet"],
  ] as const;
  const artifacts = [];
  for (const [artifactId, stage, kind, artifactPath] of specs) {
    artifacts.push({
      schemaVersion: SchemaVersion,
      artifactId,
      bookId: input.bookId,
      stage,
      kind,
      path: join(input.outputRel, artifactPath),
      contentHash: await hashFile(join(input.outputDir, artifactPath)),
      stageFingerprint: input.stageFingerprints[stage],
      providerFingerprint: input.providerFingerprint,
      producerRunId: stage === "graph_extract"
        ? "run-graph-extract"
        : "run-community-report",
      createdAt: "2026-05-23T00:00:00.000Z",
      metadata: { corpusContentHash: input.corpusContentHash },
    });
  }
  artifacts.push({
    schemaVersion: SchemaVersion,
    artifactId: input.artifactIds.lancedb,
    bookId: input.bookId,
    stage: "embed",
    kind: "lancedb_index",
    path: join(input.outputRel, "lancedb"),
    contentHash: await hashLanceDbDirectoryContents(join(input.outputDir, "lancedb")),
    stageFingerprint: input.stageFingerprints.embed,
    providerFingerprint: input.providerFingerprint,
    producerRunId: "run-embed",
    createdAt: "2026-05-23T00:00:00.000Z",
    metadata: { corpusContentHash: input.corpusContentHash },
  });
  return artifacts;
}

export async function writeCompletedGraphBatchFixture(input: {
  tmpRoot: string;
  sourceDir: string;
  stateRoot: string;
  configDir: string;
  runId: string;
  sourceBytes: string;
  commandChecks?: ReturnType<typeof passedBatchCommandChecks>;
}) {
  const sourceHash = createHash("sha256")
    .update(input.sourceBytes)
    .digest("hex");
  const sourcePath = join(input.sourceDir, "Book.epub");
  const sourceRelativePath = relative(projectRoot, sourcePath);
  const bookId = batchBookId(sourceHash, sourceRelativePath);
  const itemId = `item-${sourceHash.slice(0, 12)}-${
    stableTextHash(sourceRelativePath).slice(0, 8)
  }`;
  const outputRel = join("books", bookId, "graphrag", "output");
  const outputDir = join(input.stateRoot, outputRel);
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
  await mkdir(input.sourceDir, { recursive: true });
  await mkdir(input.configDir, { recursive: true });
  await mkdir(join(input.stateRoot, "catalog", "batch-runs", input.runId, "items"), {
    recursive: true,
  });
  await mkdir(outputDir, { recursive: true });
  await writeFile(sourcePath, input.sourceBytes);
  await writeFile(join(input.configDir, "index.yml"), "collections: {}\n");
  const normalizedPath = join(input.stateRoot, "books", bookId, "input", "book.md");
  await writeQmdBuildFixture({
    tmpRoot: input.tmpRoot,
    stateRoot: input.stateRoot,
    configDir: input.configDir,
    runId: input.runId,
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
      outputDir: outputRel,
      producerRunId: "run-query-ready",
      stageProducerRunIds: {
        graph_extract: "run-graph-extract",
        community_report: "run-community-report",
        embed: "run-embed",
      },
    },
  );
  await writeDurableJsonFixture(
    join(outputDir, "qmd_graph_text_unit_identity.json"),
    {
      schemaVersion: SchemaVersion,
      bookId,
      sourceId: `sha256:${sourceHash}`,
      sourceHash,
      documentId,
      contentHash,
      normalizedPath: `books/${bookId}/input/book.md`,
      graphDocumentId: `graph-doc-${bookId}`,
      graphTextUnitIds: [`tu-${bookId}`],
    },
  );
  await mkdir(join(input.stateRoot, "books", bookId), { recursive: true });
  await mkdir(join(input.stateRoot, "catalog"), { recursive: true });
  await writeDurableYamlFixture(
    join(input.stateRoot, "catalog", "books.yaml"),
    {
      schemaVersion: SchemaVersion,
      items: [{
        schemaVersion: SchemaVersion,
        bookId,
        documentId,
        sourcePath: `books/${bookId}/source/source.epub`,
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
  const bookJob = {
    schemaVersion: SchemaVersion,
    bookId,
    documentId,
    sourcePath: `books/${bookId}/source/source.epub`,
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
  };
  await writeDurableYamlFixture(
    join(input.stateRoot, "books", bookId, "state", "job.yaml"),
    bookJob,
  );
  await writeDurableYamlFixture(
    join(input.stateRoot, "books", bookId, "state", "artifacts.yaml"),
    { schemaVersion: SchemaVersion, items: graphArtifacts },
  );
  await writeDurableYamlFixture(
    join(input.stateRoot, "books", bookId, "state", "checkpoints.yaml"),
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
    join(input.stateRoot, "catalog", "batch-runs", input.runId, "manifest.json"),
    {
      schemaVersion: SchemaVersion,
      runId: input.runId,
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
    join(
      input.stateRoot,
      "catalog",
      "batch-runs",
      input.runId,
      "items",
      `${itemId}.json`,
    ),
    {
      schemaVersion: SchemaVersion,
      itemId,
      runId: input.runId,
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
      commandChecks: input.commandChecks ?? passedBatchCommandChecks(),
    },
  );
  return { sourceHash, sourcePath, sourceRelativePath, bookId, itemId };
}


export async function runParallelRunnerFixture(input: {
  concurrency: number;
  runId: string;
  openaiProviderConcurrency?: number;
  commandCheckNames?: string[];
  bookCount?: number;
}): Promise<{
  tmpRoot: string;
  stateRoot: string;
  result: { stdout: string; stderr: string; exitCode: number | null };
  events: Array<Record<string, unknown>>;
  resumeEvents: Array<{ name: string; phase: string; at: number }>;
}> {
  const tmpRoot = await mkProjectTmpDir(`qmd-batch-workers-${input.concurrency}-`);
  const sourceDir = join(tmpRoot, "source");
  const stateRoot = join(tmpRoot, "graph_vault");
  const logRoot = join(tmpRoot, "logs");
  const configDir = join(tmpRoot, "config");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
  const bookCount = input.bookCount ?? 2;
  const sourcePaths = Array.from({ length: bookCount }, (_, index) => {
    const suffix = String.fromCharCode("A".charCodeAt(0) + index);
    return join(sourceDir, `Parallel-${suffix}.epub`);
  });
  for (const [index, sourcePath] of sourcePaths.entries()) {
    const suffix = String.fromCharCode("A".charCodeAt(0) + index);
    await writeMinimalEpubFixture(sourcePath, `Parallel ${suffix}`);
  }
  for (const sourcePath of sourcePaths) {
    const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    const bookId = batchBookId(sourceHash, relative(projectRoot, sourcePath));
    await writeProviderAuthReopenGraphFixture({ stateRoot, bookId, sourceHash });
  }

  const resumeEventsPath = join(tmpRoot, "resume-events.jsonl");
  const resumeScript = join(tmpRoot, "fake-parallel-resume.mjs");
  await writeFile(
    resumeScript,
    [
      "import { appendFileSync } from 'node:fs';",
      "import { createHash } from 'node:crypto';",
      "const args = process.argv.slice(2);",
      "const value = (name) => {",
      "  const index = args.indexOf(name);",
      "  return index >= 0 ? args[index + 1] : '';",
      "};",
      "const sourcePath = value('--source-path');",
      "const relativePath = process.env.PROJECT_ROOT && sourcePath.startsWith(process.env.PROJECT_ROOT + '/')",
      "  ? sourcePath.slice(process.env.PROJECT_ROOT.length + 1)",
      "  : sourcePath;",
      "const sourceHash = createHash('sha256').update(",
      "  await import('node:fs').then((fs) => fs.readFileSync(sourcePath)),",
      ").digest('hex');",
      "const pathHash = createHash('sha256')",
      "  .update(relativePath.normalize('NFKC').toLowerCase())",
      "  .digest('hex');",
      "const bookId = `book-${sourceHash.slice(0, 12)}-${pathHash.slice(0, 8)}`;",
      "const name = sourcePath.split('/').pop();",
      "appendFileSync(process.env.RESUME_EVENTS_PATH, JSON.stringify({",
      "  name, phase: 'start', at: Date.now()",
      "}) + '\\n');",
      "await new Promise((resolve) => setTimeout(resolve, 600));",
      "appendFileSync(process.env.RESUME_EVENTS_PATH, JSON.stringify({",
      "  name, phase: 'end', at: Date.now()",
      "}) + '\\n');",
      "console.log(JSON.stringify({ status: 'ready', bookId }));",
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
    const proc = spawn(nodeScriptBin(), [
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
      input.runId,
      "--skip-dotenv",
      "--book-concurrency",
      String(input.concurrency),
      "--openai-provider-concurrency",
      String(input.openaiProviderConcurrency ?? 2),
      "--jina-provider-concurrency",
      "2",
      "--local-cpu-concurrency",
      "2",
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
        QMD_GRAPHRAG_TEST_COMMAND_CHECK_NAMES:
          (input.commandCheckNames ?? [
            "qmd-version",
            "qmd-query-auto-json",
            "qmd-query-graphrag-json",
          ]).join(","),
        RESUME_EVENTS_PATH: resumeEventsPath,
        PROJECT_ROOT: projectRoot,
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
    proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
    proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
  });
  const eventsPath = join(stateRoot, "catalog", "batch-runs", input.runId, "events.jsonl");
  const events = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const resumeEvents = readFileSync(resumeEventsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { tmpRoot, stateRoot, result, events, resumeEvents };
}

export async function waitForFile(path: string, timeoutMs = 10000): Promise<void> {
  const startedAt = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for file: ${path}`);
    }
    await sleep(50);
  }
}


export async function writeGraphRagPromptFixtures(stateRoot: string): Promise<void> {
  const promptDir = join(stateRoot, "prompts");
  await mkdir(promptDir, { recursive: true });
  for (const name of [
    "extract_graph.txt",
    "summarize_descriptions.txt",
    "community_report_graph.txt",
    "community_report_text.txt",
    "local_search_system_prompt.txt",
    "global_search_map_system_prompt.txt",
    "global_search_reduce_system_prompt.txt",
    "global_search_knowledge_system_prompt.txt",
    "drift_search_system_prompt.txt",
    "drift_search_reduce_prompt.txt",
    "basic_search_system_prompt.txt",
  ]) {
    await writeFile(join(promptDir, name), "prompt\n");
  }
}

export function runBatchWorkflow(input: {
  tmpRoot: string;
  sourceDir: string;
  stateRoot: string;
  logRoot: string;
  configDir: string;
  runId: string;
  statusJson?: boolean;
  maxResumePasses?: number;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveResult) => {
    let settled = false;
    const workflowTimeoutMs = input.timeoutMs ?? 60_000;
    const proc = spawn(nodeScriptBin(), [
      join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
      "--source-dir", input.sourceDir,
      "--state-root", input.stateRoot,
      "--log-root", input.logRoot,
      "--config", join(input.configDir, "index.yml"),
      "--qmd-index-path", join(input.tmpRoot, "index.sqlite"),
      "--run-id", input.runId,
      "--skip-dotenv",
      "--book-concurrency", "1",
      "--max-command-attempts", "1",
      "--max-resume-passes", String(input.maxResumePasses ?? 1),
      ...(input.statusJson === true ? ["--status-json"] : []),
    ], {
      cwd: input.tmpRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(input.env ?? {}),
      },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      stderr += `\nrunBatchWorkflow timeout after ${workflowTimeoutMs}ms\n`;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) proc.kill("SIGKILL");
      }, 2_000).unref();
    }, workflowTimeoutMs);
    timeout.unref();
    proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
    proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
    proc.on("close", (exitCode) => {
      settled = true;
      clearTimeout(timeout);
      resolveResult({ stdout, stderr, exitCode });
    });
  });
}

export async function expectDurableSubprocessEnvelopeIncomplete(input: {
  prefix: string;
  runId: string;
  resumeScriptLines: string[];
  expectedSentinels: string[];
}): Promise<void> {
  const tmpRoot = await mkProjectTmpDir("qmd-batch-child-partial-envelope-");
  const sourceDir = join(tmpRoot, "source");
  const stateRoot = join(tmpRoot, "graph_vault");
  const logRoot = join(tmpRoot, "logs");
  const configDir = join(tmpRoot, "config");
  const runId = input.runId;
  try {
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeGraphRagPromptFixtures(stateRoot);
    await writeMinimalEpubFixture(join(sourceDir, "Partial.epub"), "Partial");
    const resumeScript = join(tmpRoot, `${input.prefix}.mjs`);
    await writeFile(resumeScript, input.resumeScriptLines.join("\n"));
    const result = await runBatchWorkflow({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
      env: {
        QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
        QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
        QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
      },
      timeoutMs: 90_000,
    });
    const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const itemFile = durablePrimaryJsonEntries(join(runRoot, "items"))[0];
    const checkpoint = JSON.parse(readFileSync(
      join(runRoot, "items", itemFile),
      "utf8",
    ));
    const failedCheck = checkpoint.commandChecks.at(-1);
    const statusResult = await runBatchWorkflow({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
      statusJson: true,
    });
    const statusSummary = JSON.parse(statusResult.stdout);
    const diagnostic = statusSummary.durableStateFailures.find(
      (item: Record<string, unknown>) =>
        item.localFailureClass === "durable_subprocess_evidence_incomplete",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(failedCheck).toMatchObject({
      failureKind: "local_state_integrity",
      localFailureClass: "durable_subprocess_evidence_incomplete",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
      failedStage: "resume-book-1",
      evidenceIncomplete: true,
      completedPublishRule: "forbidden",
    });
    expect(failedCheck.unavailableFieldSentinels)
      .toEqual(expect.arrayContaining(input.expectedSentinels));
    expect(failedCheck.evidenceIncompleteReason).toContain("missing:");
    expect(checkpoint.localFailureClass)
      .toBe("durable_subprocess_evidence_incomplete");
    expect(statusResult.exitCode).toBe(0);
    expect(diagnostic).toMatchObject({
      itemId: checkpoint.itemId,
      bookId: checkpoint.bookId,
      activeCommand: "resume-book-1",
      evidenceIncomplete: true,
    });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}
