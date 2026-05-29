import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const SchemaVersion = "1.0.0";

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function batchItemId(sourceHash: string, sourceRelativePath: string): string {
  return `item-${sourceHash.slice(0, 12)}-${sha256Text(sourceRelativePath).slice(0, 8)}`;
}

function batchBookId(sourceHash: string, sourceRelativePath: string): string {
  const pathHash = sha256Text(sourceRelativePath.normalize("NFKC").toLowerCase());
  return `book-${sourceHash.slice(0, 12)}-${pathHash.slice(0, 8)}`;
}

async function mkProjectTmpDir(prefix: string): Promise<string> {
  const tmpRoot = join(projectRoot, ".tmp-tests");
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(join(tmpRoot, prefix));
}

async function writeDurableTextFixture(path: string, text: string): Promise<void> {
  const checksum = sha256Text(text);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
  await writeFile(`${path}.sha256`, `${checksum}\n`, "utf8");
  await writeFile(`${path}.sha256.meta.json`, `${JSON.stringify({
    checksum,
    targetLocator: relative(projectRoot, path),
    absoluteTargetLocator: path,
    checksumPath: relative(projectRoot, `${path}.sha256`),
    checksumRecoveryDecision: "committed",
    commitState: "committed",
    operationId: `fixture-${sha256Text(path).slice(0, 16)}`,
    runnerSessionId: "fixture-runner",
    fencingTokenHash: sha256Text(`fixture-fence:${path}`),
    targetGeneration: 1,
    committedAt: "2026-05-23T00:00:00.000Z",
  }, null, 2)}\n`, "utf8");
}

async function writeDurableJsonFixture(path: string, value: unknown): Promise<void> {
  await writeDurableTextFixture(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeMinimalBatchFixture(input: {
  tmpRoot: string;
  sourceDir: string;
  stateRoot: string;
  configDir: string;
  runId: string;
  sourceName: string;
}): Promise<{ itemId: string; runRoot: string; sourcePath: string }> {
  await mkdir(input.sourceDir, { recursive: true });
  await mkdir(input.configDir, { recursive: true });
  await writeFile(join(input.configDir, "index.yml"), "collections: {}\n");
  const sourcePath = join(input.sourceDir, input.sourceName);
  await writeFile(sourcePath, "synthetic epub bytes\n", "utf8");
  const sourceBytes = readFileSync(sourcePath);
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  const sourceRelativePath = relative(projectRoot, sourcePath);
  const itemId = batchItemId(sourceHash, sourceRelativePath);
  const runRoot = join(input.stateRoot, "catalog", "batch-runs", input.runId);
  await writeDurableJsonFixture(join(runRoot, "manifest.json"), {
    schemaVersion: SchemaVersion,
    runId: input.runId,
    status: "running",
    sourceRootName: "source",
    stateRootLocator: relative(projectRoot, input.stateRoot),
    qmdIndexLocator: relative(projectRoot, join(input.tmpRoot, "index.sqlite")),
    configLocator: relative(projectRoot, join(input.configDir, "index.yml")),
    totalItems: 1,
    pendingItems: 1,
    runningItems: 0,
    completedItems: 0,
    skippedItems: 0,
    importedCompletedItems: 0,
    failedItems: 0,
    startedAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
    itemIds: [itemId],
  });
  return { itemId, runRoot, sourcePath };
}

async function runBatch(input: {
  tmpRoot: string;
  sourceDir: string;
  stateRoot: string;
  logRoot: string;
  configDir: string;
  runId: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveResult) => {
    const proc = spawn(process.execPath, [
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
      "--book-concurrency",
      "1",
      "--max-command-attempts",
      "1",
      "--max-resume-passes",
      "1",
    ], {
      cwd: input.tmpRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
  });
}

describe("GraphRAG runner durable preflight", () => {
  test("runner-start preflight blocks mapped book run YAML checksum fault",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-runner-yaml-preflight-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "runner-yaml-preflight-fixture";
      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      const sourcePath = join(sourceDir, "Mapped-Yaml.epub");
      try {
        await mkdir(sourceDir, { recursive: true });
        await mkdir(configDir, { recursive: true });
        await writeFile(join(configDir, "index.yml"), "collections: {}\n");
        await writeFile(sourcePath, "synthetic epub bytes\n", "utf8");

        const sourceBytes = readFileSync(sourcePath);
        const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
        const sourceRelativePath = relative(projectRoot, sourcePath);
        const itemId = batchItemId(sourceHash, sourceRelativePath);
        const bookId = batchBookId(sourceHash, sourceRelativePath);
        const mappedYamlPath = join(stateRoot, "books", bookId, "runs", "legacy.yaml");
        await writeDurableTextFixture(mappedYamlPath, [
          "schemaVersion: 1.0.0",
          "runId: legacy",
          "stage: ingest",
          "",
        ].join("\n"));
        await writeFile(`${mappedYamlPath}.sha256`, `${"0".repeat(64)}\n`, "utf8");
        await writeDurableJsonFixture(join(runRoot, "manifest.json"), {
          schemaVersion: SchemaVersion,
          runId,
          status: "running",
          sourceRootName: "source",
          stateRootLocator: relative(projectRoot, stateRoot),
          qmdIndexLocator: relative(projectRoot, join(tmpRoot, "index.sqlite")),
          configLocator: relative(projectRoot, join(configDir, "index.yml")),
          totalItems: 1,
          pendingItems: 1,
          runningItems: 0,
          completedItems: 0,
          skippedItems: 0,
          importedCompletedItems: 0,
          failedItems: 0,
          startedAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:00.000Z",
          itemIds: [itemId],
        });

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
        });
        const eventRaw = readFileSync(join(runRoot, "events.jsonl"), "utf8");
        const events = eventRaw
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const preflight = events.find((event) =>
          event.event === "durable_preflight_blocked"
        );
        const quarantineEntry = readdirSync(dirname(mappedYamlPath))
          .find((entry) => entry.startsWith("legacy.yaml.corrupt-"));

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toContain("durable_preflight_blocked");
        expect(preflight).toMatchObject({
          failureKind: "local_state_integrity",
          localFailureClass: "durable_checksum_mismatch",
          retryable: false,
          recoveryDecision: "stop_until_fixed",
          failedStage: "runner_start",
          checksumRecoveryDecision: "stop_until_fixed",
        });
        expect(preflight?.targetLocator).toContain("books/");
        expect(preflight?.targetLocator).toContain("runs/legacy.yaml");
        expect(eventRaw).toContain("durable_yaml_target_quarantined");
        expect(quarantineEntry).toBeDefined();
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30000);

  test("runner-start reports provider request mismatch without quarantine",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-provider-request-preflight-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "provider-request-preflight-fixture";
      const providerRequestDir = join(stateRoot, "catalog", "provider-requests");
      const providerRequestPath = join(providerRequestDir, "request-a.json");
      try {
        const fixture = await writeMinimalBatchFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
          sourceName: "Provider-Request.epub",
        });
        await writeDurableJsonFixture(providerRequestPath, {
          schemaVersion: SchemaVersion,
          provider: "fixture",
          requestHash: "request-a",
        });
        await writeFile(`${providerRequestPath}.sha256`, `${"0".repeat(64)}\n`);

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
        });
        const providerRequestEntries = readdirSync(providerRequestDir);
        const eventRaw = readFileSync(join(fixture.runRoot, "events.jsonl"), "utf8");
        const manifest = JSON.parse(
          readFileSync(join(fixture.runRoot, "manifest.json"), "utf8"),
        );
        const diagnostic =
          manifest.metadata?.startupRecovery?.providerRequestDiagnostics?.[0];

        expect(result.stdout).not.toContain("durable_json_target_quarantined");
        expect(eventRaw).not.toContain("durable_json_target_quarantined");
        expect(providerRequestEntries.some((entry) =>
          entry.startsWith("request-a.json.corrupt-")
        )).toBe(false);
        expect(diagnostic).toMatchObject({
          localFailureClass: "durable_checksum_mismatch",
          diagnosticClass: "provider_request_durable_degraded",
          statusJsonDecision: "read_only_capped_diagnostic",
          normalRunnerAction: "no_primary_quarantine",
          scannedTargetCount: 1,
          degradedTargetCount: 1,
          maxRunnerStartMutationCount: 0,
        });
        expect(diagnostic.sampleTargetLocators[0]).toContain(
          "catalog/provider-requests/request-a.json",
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30000);
});
