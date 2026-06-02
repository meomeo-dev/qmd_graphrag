import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { describe, expect, test } from "vitest";
import {
  runBatchStatusJson,
  stableTextHash,
  writeCompletedGraphBatchFixture,
} from "./helpers/graphrag-runner-harness.ts";

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

async function writeMinimalEpubFixture(path: string, title = "Book"): Promise<void> {
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
  await writeMinimalEpubFixture(sourcePath, input.sourceName);
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
  extraArgs?: string[];
  env?: Record<string, string>;
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
      ...(input.extraArgs ?? []),
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
  test("completed manifest clears stale durable failure summary", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-clear-stale-durable-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "clear-stale-durable-summary-fixture";
    await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "completed stale durable summary",
    });
    const manifestPath = join(stateRoot, "catalog", "batch-runs", runId, "manifest.json");
    const fixtureItemsRoot = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
    );
    const fixtureItemName = readdirSync(fixtureItemsRoot)
      .find((name) => name.endsWith(".json"));
    const fixtureItemPath = join(fixtureItemsRoot, fixtureItemName!);
    const fixtureItem = JSON.parse(readFileSync(fixtureItemPath, "utf8"));
    await writeDurableJsonFixture(fixtureItemPath, {
      ...fixtureItem,
      metadata: {
        ...(fixtureItem.metadata ?? {}),
        failureKind: "local_state_integrity",
        localFailureClass: "durable_preflight_live_lock",
        targetLocator: "graph_vault/catalog/runs.yaml",
        recoveryDecision: "stop_until_fixed",
      },
    });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    await writeDurableJsonFixture(manifestPath, {
      ...manifest,
      durableFailureSummary: {
        localFailureClass: "durable_preflight_live_lock",
        targetLocator: "graph_vault/catalog/runs.yaml",
        recoveryDecision: "stop_until_fixed",
      },
    });

    const result = await runBatch({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
    });
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const after = JSON.parse(readFileSync(manifestPath, "utf8"));
    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(summary.recoveryDecision).toBe("none");
    expect(summary.counts).toEqual({ completed: 1 });
    expect(after.durableFailureSummary).toBeUndefined();
  });

  test("status-json scans provider request diagnostics beyond the first 200 records",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-request-full-scan-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "provider-request-full-scan-fixture";
      await writeCompletedGraphBatchFixture({
        tmpRoot,
        sourceDir,
        stateRoot,
        configDir,
        runId,
        sourceBytes: "provider request full scan",
      });
      const providerRoot = join(stateRoot, "catalog", "provider-requests");
      await mkdir(providerRoot, { recursive: true });
      for (let index = 0; index < 205; index += 1) {
        const name = `${String(index).padStart(64, "0")}.json`;
        const path = join(providerRoot, name);
        const text = `${JSON.stringify({ index }, null, 2)}\n`;
        await writeFile(path, text, "utf8");
        if (index < 204) {
          const checksum = stableTextHash(text);
          await writeFile(`${path}.sha256`, `${checksum}\n`, "utf8");
          await writeFile(`${path}.sha256.meta.json`, `${JSON.stringify({
            checksum,
            targetLocator: relative(projectRoot, path),
            absoluteTargetLocator: path,
            checksumPath: relative(projectRoot, `${path}.sha256`),
            checksumRecoveryDecision: "committed",
            commitState: "committed",
            operationId: `fixture-provider-${index}`,
            runnerSessionId: "fixture-runner",
            fencingTokenHash: stableTextHash(`provider-${index}`),
            targetGeneration: 1,
            committedAt: "2026-05-23T00:00:00.000Z",
          }, null, 2)}\n`, "utf8");
        }
      }

      const result = await runBatchStatusJson({
        tmpRoot,
        sourceDir,
        stateRoot,
        logRoot,
        configDir,
        runId,
      });
      const summary = JSON.parse(result.stdout);
      await rm(tmpRoot, { recursive: true, force: true });

      expect(result.exitCode).toBe(0);
      const diagnostic = summary.durableStateFailures.find((item) =>
        item.localFailureClass === "durable_checksum_missing" &&
        item.scannedTargetCount === 205
      );
      expect(diagnostic).toMatchObject({
        localFailureClass: "durable_checksum_missing",
        scannedTargetCount: 205,
        degradedTargetCount: 1,
        scanTruncated: false,
      });
    });

  test("runner-start blocks mapped book YAML checksum fault read-only",
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
        const manifest = JSON.parse(
          readFileSync(join(runRoot, "manifest.json"), "utf8"),
        );
        const recovery = JSON.parse(
          readFileSync(join(runRoot, "recovery-summary.json"), "utf8"),
        );

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
        expect(eventRaw).not.toContain("durable_yaml_target_quarantined");
        expect(eventRaw).not.toContain("durable_yaml_checksum_backfilled");
        expect(eventRaw).not.toContain("durable_checksum_meta_backfilled");
        expect(quarantineEntry).toBeUndefined();
        expect(manifest).toMatchObject({
          status: "failed",
          runningItems: 0,
          failedItems: 0,
          activeProviderSlots: 0,
          activeSubprocesses: 0,
          activeBookLeases: 0,
        });
        expect(manifest.failedAt).toEqual(expect.any(String));
        expect(manifest.metadata.startupRecovery).toMatchObject({
          runId,
          stage: "runner_start",
          decision: "blocked_before_claim",
          recoveryDecision: "stop_until_fixed",
          mutationCount: 0,
          degradedTargetCount: 1,
          nextOperatorAction: "run_explicit_repair",
        });
        expect(manifest.metadata.startupRecovery.targetCount).toBeGreaterThan(0);
        expect(manifest.metadata.startupRecovery.firstBlocker).toMatchObject({
          localFailureClass: "durable_checksum_mismatch",
          targetLocator: expect.stringContaining("books/"),
          durableMode: "read_only_blocking_diagnostic",
          normalRunnerAction: "no_book_scoped_mutation",
          maxRunnerStartMutationCount: 0,
        });
        expect(recovery).toMatchObject({
          recoveryDecision: "stop_until_fixed",
          startupRecovery: {
            decision: "blocked_before_claim",
            mutationCount: 0,
            nextOperatorAction: "run_explicit_repair",
          },
        });
        expect(recovery.startupRecovery.firstBlocker.targetLocator)
          .toContain("runs/legacy.yaml");
        expect(recovery.startupRecovery.firstBlocker.durableMode)
          .toBe("read_only_blocking_diagnostic");
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
          extraArgs: [
            "--migrate-only",
            "--migrate-repair-max-mutations",
            "2",
          ],
        });
        const providerRequestEntries = readdirSync(providerRequestDir);
        const eventRaw = readFileSync(join(fixture.runRoot, "events.jsonl"), "utf8");
        const manifest = JSON.parse(
          readFileSync(join(fixture.runRoot, "manifest.json"), "utf8"),
        );
        const diagnostic =
          manifest.metadata?.startupRecovery?.providerRequestDiagnostics?.[0];

        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain("durable_json_target_quarantined");
        expect(eventRaw).not.toContain("durable_json_target_quarantined");
        expect(providerRequestEntries.some((entry) =>
          entry.startsWith("request-a.json.corrupt-")
        )).toBe(false);
        expect(diagnostic).toMatchObject({
          localFailureClass: "durable_checksum_mismatch",
          diagnosticClass: "provider_request_durable_degraded",
          statusJsonDecision: "read_only_diagnostic",
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

  test("runner-start blocks mapped book temp read-only without cleanup",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-runner-temp-preflight-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "runner-temp-preflight-fixture";
      const sourceName = "Book-Temp.epub";
      try {
        const fixture = await writeMinimalBatchFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
          sourceName,
        });
        const sourceBytes = readFileSync(fixture.sourcePath);
        const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
        const sourceRelativePath = relative(projectRoot, fixture.sourcePath);
        const bookId = batchBookId(sourceHash, sourceRelativePath);
        const targetPath = join(stateRoot, "books", bookId, "runs", "temp.yaml");
        await writeDurableTextFixture(targetPath, "stage: ingest\n");
        const tempPath = `${targetPath}.tmp-startup-readonly`;
        await writeFile(tempPath, "stale temp\n", "utf8");
        await writeFile(`${tempPath}.owner.json`, `${JSON.stringify({
          tempId: "startup-readonly",
          targetLocator: relative(projectRoot, targetPath),
          absoluteTargetLocator: targetPath,
          lane: "bookStateWriterLane",
          targetMappingOwner: "bookRunState",
          operationId: "startup-readonly-op",
          ownerPid: 999999,
          ownerHost: "fixture-host",
          createdAt: "2026-05-23T00:00:00.000Z",
          expiresAt: "2026-05-23T00:00:01.000Z",
          leaseGeneration: 1,
          targetGeneration: 1,
          targetChecksumBefore: sha256Text("stage: ingest\n"),
          fencingTokenHash: sha256Text("startup-readonly-fence"),
          durableMode: "strict",
        }, null, 2)}\n`, "utf8");
        const staleDate = new Date("2026-05-23T00:00:00.000Z");
        await utimes(tempPath, staleDate, staleDate);
        await utimes(`${tempPath}.owner.json`, staleDate, staleDate);

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
        });
        const eventRaw = readFileSync(join(fixture.runRoot, "events.jsonl"), "utf8");
        const manifest = JSON.parse(
          readFileSync(join(fixture.runRoot, "manifest.json"), "utf8"),
        );

        expect(result.exitCode).not.toBe(0);
        expect(eventRaw).toContain("durable_preflight_blocked");
        expect(eventRaw).not.toContain("durable_yaml_temp_reconciled");
        expect(manifest.metadata.startupRecovery).toMatchObject({
          decision: "blocked_before_claim",
          mutationCount: 0,
          degradedTargetCount: 1,
        });
        expect(manifest.metadata.startupRecovery.firstBlocker).toMatchObject({
          localFailureClass: "durable_preflight_unresolved_temp",
          cleanupReason: "owner_lease_expired",
          durableMode: "read_only_blocking_diagnostic",
          normalRunnerAction: "no_book_scoped_mutation",
          maxRunnerStartMutationCount: 0,
        });
        expect(manifest.metadata.startupRecovery.firstBlocker.targetLocator)
          .toContain("books/");
        expect(readdirSync(dirname(tempPath))).toContain("temp.yaml.tmp-startup-readonly");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30000);

  test("migrate-only repairs missing book output checksum sidecar",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-runner-book-output-repair-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "book-output-checksum-repair-fixture";
      try {
        const fixture = await writeMinimalBatchFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
          sourceName: "Book-Output.epub",
        });
        const sourceBytes = readFileSync(fixture.sourcePath);
        const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
        const sourceRelativePath = relative(projectRoot, fixture.sourcePath);
        const bookId = batchBookId(sourceHash, sourceRelativePath);
        const contextPath = join(stateRoot, "books", bookId, "output", "context.json");
        const contextText = "{}\n";
        await mkdir(dirname(contextPath), { recursive: true });
        await writeFile(contextPath, contextText, "utf8");

        const first = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
        });
        const repair = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
          extraArgs: [
            "--migrate-only",
            "--migrate-repair-max-mutations",
            "2",
          ],
        });
        const eventRaw = readFileSync(join(fixture.runRoot, "events.jsonl"), "utf8");
        const manifest = JSON.parse(
          readFileSync(join(fixture.runRoot, "manifest.json"), "utf8"),
        );
        const recovery = JSON.parse(
          readFileSync(join(fixture.runRoot, "recovery-summary.json"), "utf8"),
        );

        expect(first.exitCode).not.toBe(0);
        expect(first.stdout).toContain("durable_preflight_blocked");
        expect(repair.exitCode).toBe(0);
        expect(readFileSync(`${contextPath}.sha256`, "utf8").trim())
          .toBe(sha256Text(contextText));
        expect(existsSync(`${contextPath}.sha256.meta.json`)).toBe(true);
        expect(eventRaw).toContain("durable_json_checksum_backfilled");
        expect(eventRaw).toContain("durable_checksum_meta_backfilled");
        expect(eventRaw).not.toContain("context.json.corrupt-");
        expect(manifest.metadata.startupRecovery).toMatchObject({
          decision: "migrate_only_repair_preflight_passed",
          repairBoundary: "migrate_only",
          repairTargetFamily: "book_scoped_durable_state",
          mutationCount: 2,
          maxScannedTargets: 200,
          maxMutationCount: 2,
          limitHit: false,
          nextOperatorAction: "run_status_json",
        });
        expect(manifest.metadata.startupRecovery.firstBlocker).toBeUndefined();
        expect(manifest.metadata.startupRecovery.recoveryDecision).toBeUndefined();
        expect(recovery.startupRecovery).toMatchObject({
          repairBoundary: "migrate_only",
          mutationCount: 2,
          limitHit: false,
        });
        expect(recovery.startupRecovery.firstBlocker).toBeUndefined();
        expect(recovery.recoveryDecision).toBe("continue_pending");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30000);

  test("migrate-only repairs changed book output checksum with artifact evidence",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-runner-book-output-mismatch-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "book-output-checksum-mismatch-fixture";
      try {
        const fixture = await writeMinimalBatchFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
          sourceName: "Book-Output-Mismatch.epub",
        });
        const sourceHash = createHash("sha256")
          .update(readFileSync(fixture.sourcePath))
          .digest("hex");
        const sourceRelativePath = relative(projectRoot, fixture.sourcePath);
        const bookId = batchBookId(sourceHash, sourceRelativePath);
        const statsPath = join(stateRoot, "books", bookId, "output", "stats.json");
        const oldStats = "{ \"old\": true }\n";
        const newStats = "{ \"new\": true }\n";
        await writeDurableTextFixture(statsPath, oldStats);
        await writeFile(statsPath, newStats, "utf8");
        await writeDurableTextFixture(
          join(stateRoot, "books", bookId, "artifacts.yaml"),
          [
            "schemaVersion: 1.0.0",
            "items:",
            "  - schemaVersion: 1.0.0",
            "    artifactId: stats-artifact",
            `    bookId: ${bookId}`,
            "    stage: graph_extract",
            "    kind: graphrag_stats_json",
            "    path: " + `books/${bookId}/output/stats.json`,
            `    contentHash: ${sha256Text(newStats)}`,
            "    stageFingerprint: graph-stage",
            "    providerFingerprint: provider-fingerprint",
            "    producerRunId: graph-run",
            "    createdAt: 2026-05-23T00:00:00.000Z",
            "    metadata:",
            "      corpusContentHash: corpus-hash",
            "",
          ].join("\n"),
        );

        const first = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
        });
        const repair = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
          extraArgs: [
            "--migrate-only",
            "--migrate-repair-max-mutations",
            "3",
          ],
        });
        const eventRaw = readFileSync(join(fixture.runRoot, "events.jsonl"), "utf8");

        expect(first.exitCode).not.toBe(0);
        expect(first.stdout).toContain("durable_preflight_blocked");
        expect(eventRaw).toContain("durable_checksum_mismatch");
        expect(repair.exitCode).toBe(0);
        expect(readFileSync(`${statsPath}.sha256`, "utf8").trim())
          .toBe(sha256Text(newStats));
        expect(JSON.parse(readFileSync(`${statsPath}.sha256.meta.json`, "utf8")))
          .toMatchObject({
            checksum: sha256Text(newStats),
            checksumRecoveryDecision: "artifact_evidence_checksum_refreshed",
          });
        expect(eventRaw).toContain("graph_output_json_checksum_refreshed");
        expect(eventRaw).not.toContain("stats.json.corrupt-");
        expect(readdirSync(dirname(statsPath)).some((entry) =>
          entry.startsWith("stats.json.corrupt-")
        )).toBe(false);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30000);

  test("migrate-only restores mutable stats quarantine after later stage rewrite",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-runner-stats-quarantine-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "stats-quarantine-repair-fixture";
      try {
        const fixture = await writeMinimalBatchFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
          sourceName: "Stats-Quarantine.epub",
        });
        const sourceHash = createHash("sha256")
          .update(readFileSync(fixture.sourcePath))
          .digest("hex");
        const sourceRelativePath = relative(projectRoot, fixture.sourcePath);
        const bookId = batchBookId(sourceHash, sourceRelativePath);
        const statsPath = join(stateRoot, "books", bookId, "output", "stats.json");
        const oldStats = "{ \"workflows\": { \"extract_graph\": { \"overall\": 1 } } }\n";
        const newStats = [
          "{",
          "  \"total_runtime\": 0,",
          "  \"num_documents\": 0,",
          "  \"update_documents\": 0,",
          "  \"input_load_time\": 0,",
          "  \"workflows\": {",
          "    \"create_community_reports\": {",
          "      \"overall\": 2,",
          "      \"peak_memory_bytes\": 3,",
          "      \"memory_delta_bytes\": 4,",
          "      \"tracemalloc_overhead_bytes\": 5",
          "    }",
          "  }",
          "}",
          "",
        ].join("\n");
        await writeDurableTextFixture(statsPath, oldStats);
        await writeFile(`${statsPath}.corrupt-1780302661869`, newStats, "utf8");
        await rm(statsPath, { force: true });
        await writeDurableTextFixture(
          join(stateRoot, "books", bookId, "artifacts.yaml"),
          [
            "schemaVersion: 1.0.0",
            "items:",
            "  - schemaVersion: 1.0.0",
            "    artifactId: stats-artifact",
            `    bookId: ${bookId}`,
            "    stage: graph_extract",
            "    kind: graphrag_stats_json",
            "    path: " + `books/${bookId}/output/stats.json`,
            `    contentHash: ${sha256Text(oldStats)}`,
            "    stageFingerprint: graph-stage",
            "    providerFingerprint: provider-fingerprint",
            "    producerRunId: graph-run",
            "    createdAt: 2026-05-23T00:00:00.000Z",
            "    metadata:",
            "      corpusContentHash: corpus-hash",
            "",
          ].join("\n"),
        );

        const repair = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
          extraArgs: [
            "--migrate-only",
            "--migrate-repair-max-scanned-targets",
            "1000",
            "--migrate-repair-max-mutations",
            "3",
          ],
        });
        const eventRaw = readFileSync(join(fixture.runRoot, "events.jsonl"), "utf8");

        expect(repair.exitCode).toBe(0);
        expect(readFileSync(statsPath, "utf8")).toBe(newStats);
        expect(readFileSync(`${statsPath}.sha256`, "utf8").trim())
          .toBe(sha256Text(newStats));
        expect(JSON.parse(readFileSync(`${statsPath}.sha256.meta.json`, "utf8")))
          .toMatchObject({
            checksum: sha256Text(newStats),
            checksumRecoveryDecision: "graph_output_stats_observability_refreshed",
          });
        expect(eventRaw).toContain("durable_json_target_recovered");
        expect(eventRaw).toContain("graph_output_json_checksum_refreshed");
        expect(readdirSync(dirname(statsPath)).some((entry) =>
          entry.startsWith("stats.json.corrupt-")
        )).toBe(false);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30000);

  test("runner-start blocks mapped book lock read-only and fail-fast",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-runner-lock-preflight-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "runner-lock-preflight-fixture";
      const sourceName = "Book-Lock.epub";
      try {
        const fixture = await writeMinimalBatchFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
          sourceName,
        });
        const sourceBytes = readFileSync(fixture.sourcePath);
        const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
        const sourceRelativePath = relative(projectRoot, fixture.sourcePath);
        const bookId = batchBookId(sourceHash, sourceRelativePath);
        const firstPath = join(stateRoot, "books", bookId, "runs", "a.yaml");
        const secondPath = join(stateRoot, "books", bookId, "runs", "b.yaml");
        await writeDurableTextFixture(firstPath, "stage: a\n");
        await writeDurableTextFixture(secondPath, "stage: b\n");
        await writeFile(`${firstPath}.lock`, `${JSON.stringify({
          targetLocator: relative(projectRoot, firstPath),
          lane: "bookStateWriterLane",
          targetMappingOwner: "bookRunState",
          laneTimeoutMs: 120000,
          releaseOn: ["process_exit"],
          operationId: "first-lock-op",
          pid: 999999,
          expiresAt: "2999-01-01T00:00:00.000Z",
        }, null, 2)}\n`, "utf8");
        await writeFile(`${secondPath}.sha256`, `${"0".repeat(64)}\n`, "utf8");

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
        });
        const eventRaw = readFileSync(join(fixture.runRoot, "events.jsonl"), "utf8");
        const manifest = JSON.parse(
          readFileSync(join(fixture.runRoot, "manifest.json"), "utf8"),
        );

        expect(result.exitCode).not.toBe(0);
        expect(eventRaw).toContain("durable_preflight_blocked");
        expect(manifest.metadata.startupRecovery).toMatchObject({
          decision: "blocked_before_claim",
          mutationCount: 0,
          degradedTargetCount: 1,
        });
        expect(manifest.metadata.startupRecovery.firstBlocker).toMatchObject({
          localFailureClass: "durable_preflight_live_lock",
          durableMode: "read_only_blocking_diagnostic",
          normalRunnerAction: "no_book_scoped_mutation",
          maxRunnerStartMutationCount: 0,
        });
        expect(manifest.metadata.startupRecovery.firstBlocker.targetLocator)
          .toContain("runs/a.yaml");
        expect(manifest.metadata.startupRecovery.firstBlocker.targetLocator)
          .not.toContain("runs/b.yaml");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30000);

  test("migrate-only removes fenced stale book lock",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-runner-lock-repair-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "runner-lock-repair-fixture";
      const sourceName = "Book-Lock-Repair.epub";
      try {
        const fixture = await writeMinimalBatchFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
          sourceName,
        });
        const sourceHash = createHash("sha256")
          .update(readFileSync(fixture.sourcePath))
          .digest("hex");
        const sourceRelativePath = relative(projectRoot, fixture.sourcePath);
        const bookId = batchBookId(sourceHash, sourceRelativePath);
        const runStatePath = join(stateRoot, "books", bookId, "runs", "stale.yaml");
        const lockPath = `${runStatePath}.lock`;
        await writeDurableTextFixture(runStatePath, "stage: stale-lock\n");
        await writeFile(lockPath, `${JSON.stringify({
          targetLocator: relative(projectRoot, runStatePath),
          lane: "bookStateWriterLane",
          targetMappingOwner: "bookRunState",
          laneTimeoutMs: 120000,
          releaseOn: ["commit", "error", "cancellation"],
          operationId: "stale-lock-op",
          pid: 999999,
          runnerSessionId: "dead-runner-session",
          generation: 1,
          fencingTokenHash: sha256Text("stale-lock-fence"),
          expiresAt: "2026-05-23T00:00:01.000Z",
        }, null, 2)}\n`, "utf8");

        const first = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
        });
        const repair = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
          extraArgs: [
            "--migrate-only",
            "--migrate-repair-max-mutations",
            "2",
          ],
        });
        const eventRaw = readFileSync(join(fixture.runRoot, "events.jsonl"), "utf8");
        const manifest = JSON.parse(
          readFileSync(join(fixture.runRoot, "manifest.json"), "utf8"),
        );

        expect(first.exitCode).not.toBe(0);
        expect(first.stdout).toContain("durable_preflight_blocked");
        expect(repair.exitCode).toBe(0);
        expect(existsSync(lockPath)).toBe(false);
        expect(eventRaw).toContain("durable_lock_recovered");
        expect(manifest.metadata.startupRecovery).toMatchObject({
          decision: "migrate_only_repair_preflight_passed",
          repairBoundary: "migrate_only",
          mutationCount: 1,
          limitHit: false,
          nextOperatorAction: "run_status_json",
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30000);

  test("runner-start removes fenced stale catalog lock",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-runner-start-catalog-lock-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "runner-start-catalog-lock-fixture";
      try {
        const completed = await writeCompletedGraphBatchFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
          sourceBytes: "catalog lock completed fixture",
        });
        const catalogPath = join(stateRoot, "catalog", "document-identity-map.yaml");
        const lockPath = `${catalogPath}.lock`;
        await writeDurableTextFixture(catalogPath, [
          "schemaVersion: 1.0.0",
          "items: []",
          "",
        ].join("\n"));
        await writeFile(lockPath, `${JSON.stringify({
          pid: 999999,
          runnerSessionId: "dead-catalog-lock-session",
          runnerHost: hostname(),
          targetLocator: relative(projectRoot, catalogPath),
          lockPath: relative(projectRoot, lockPath),
          lane: "catalogWriterLane",
          targetMappingOwner: "repository",
          durableKind: "json-lock",
          laneTimeoutMs: 120000,
          releaseOn: ["commit", "error", "cancellation", "lease_loss", "timeout"],
          generation: 1,
          fencingTokenHash: sha256Text("dead-catalog-lock-fence"),
          operationId: "dead-catalog-lock-op",
          acquiredAt: "2026-05-23T00:00:00.000Z",
          heartbeatAt: "2026-05-23T00:00:00.000Z",
          expiresAt: "2026-05-23T00:00:01.000Z",
        }, null, 2)}\n`, "utf8");
        const old = new Date("2026-05-23T00:00:02.000Z");
        await utimes(lockPath, old, old);

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
        });
        const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
        const eventRaw = readFileSync(join(runRoot, "events.jsonl"), "utf8");
        const manifest = JSON.parse(
          readFileSync(join(runRoot, "manifest.json"), "utf8"),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(existsSync(lockPath)).toBe(false);
        expect(eventRaw).toContain("durable_lock_recovered");
        expect(eventRaw).not.toContain("durable_preflight_blocked");
        expect(manifest).toMatchObject({
          status: "completed",
          completedItems: 1,
          pendingItems: 0,
          failedItems: 0,
          itemIds: [completed.itemId],
        });
      } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  },
  30000);

  test("runner-start removes fenced same-host dead catalog lock before expiry",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-runner-start-dead-catalog-lock-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "runner-start-dead-catalog-lock-fixture";
      try {
        const completed = await writeCompletedGraphBatchFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
          sourceBytes: "catalog dead lock completed fixture",
        });
        const catalogPath = join(stateRoot, "catalog", "document-identity-map.yaml");
        const lockPath = `${catalogPath}.lock`;
        await writeDurableTextFixture(catalogPath, [
          "schemaVersion: 1.0.0",
          "items: []",
          "",
        ].join("\n"));
        await writeFile(lockPath, `${JSON.stringify({
          pid: 999999,
          runnerSessionId: "dead-same-host-catalog-lock-session",
          runnerHost: hostname(),
          targetLocator: relative(projectRoot, catalogPath),
          lockPath: relative(projectRoot, lockPath),
          lane: "catalogWriterLane",
          targetMappingOwner: "repository",
          durableKind: "json-lock",
          laneTimeoutMs: 120000,
          releaseOn: ["commit", "error", "cancellation", "lease_loss", "timeout"],
          generation: 1,
          fencingTokenHash: sha256Text("dead-same-host-catalog-lock-fence"),
          operationId: "dead-same-host-catalog-lock-op",
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        }, null, 2)}\n`, "utf8");

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
        });
        const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
        const eventRaw = readFileSync(join(runRoot, "events.jsonl"), "utf8");
        const manifest = JSON.parse(
          readFileSync(join(runRoot, "manifest.json"), "utf8"),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(existsSync(lockPath)).toBe(false);
        expect(eventRaw).toContain("durable_lock_recovered");
        expect(eventRaw).not.toContain("durable_preflight_blocked");
        expect(manifest).toMatchObject({
          status: "completed",
          completedItems: 1,
          pendingItems: 0,
          failedItems: 0,
          itemIds: [completed.itemId],
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30000);
});
