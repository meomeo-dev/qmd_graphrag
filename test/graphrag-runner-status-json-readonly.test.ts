import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
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

async function writeDurableText(path: string, text: string): Promise<void> {
  const checksum = sha256Text(text);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
  await writeFile(`${path}.sha256`, `${checksum}\n`, "utf8");
  await writeFile(`${path}.sha256.meta.json`, `${JSON.stringify({
    checksum,
    targetLocator: relative(projectRoot, path),
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

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  await writeDurableText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeDurableYaml(path: string, value: unknown): Promise<void> {
  await writeDurableText(path, YAML.stringify(value));
}

function catalogSnapshot(path: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const child = join(current, name);
      const locator = relative(path, child);
      const stats = statSync(child);
      if (stats.isDirectory()) {
        snapshot[locator] = "dir";
        visit(child);
      } else {
        const digest = createHash("sha256")
          .update(readFileSync(child))
          .digest("hex");
        snapshot[locator] = `file:${stats.size}:${digest}`;
      }
    }
  };
  visit(path);
  return snapshot;
}

function expectChecksumMetaRepairFields(
  surface: Record<string, unknown> | undefined,
  input: {
    expected: string | null;
    actual: string;
    decision: string;
  },
): void {
  expect(surface).toMatchObject({
    checksumExpected: input.expected,
    checksumActual: input.actual,
    checksumRecoveryDecision: input.decision,
    repairAllowed: true,
  });
}

function runBatch(input: {
  tmpRoot: string;
  sourceDir: string;
  stateRoot: string;
  logRoot: string;
  configDir: string;
  runId: string;
  statusJson?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveResult) => {
    let settled = false;
    const workflowTimeoutMs = input.timeoutMs ?? 90_000;
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
      stderr += `\nrunBatch timeout after ${workflowTimeoutMs}ms\n`;
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

async function writeStatusFixture(input: {
  tmpRoot: string;
  sourceDir: string;
  stateRoot: string;
  configDir: string;
  runId: string;
}): Promise<{ bookId: string; itemId: string; booksPath: string; catalogDir: string }> {
  await mkdir(input.sourceDir, { recursive: true });
  await mkdir(input.configDir, { recursive: true });
  await writeFile(join(input.configDir, "index.yml"), "collections: {}\n");
  const sourcePath = join(input.sourceDir, "Readonly.epub");
  await writeFile(sourcePath, "status json readonly\n", "utf8");
  const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
  const sourceRelativePath = relative(projectRoot, sourcePath);
  const itemId = batchItemId(sourceHash, sourceRelativePath);
  const bookId = batchBookId(sourceHash, sourceRelativePath);
  const catalogDir = join(input.stateRoot, "catalog");
  const runRoot = join(catalogDir, "batch-runs", input.runId);
  const booksPath = join(catalogDir, "books.yaml");

  await writeDurableYaml(booksPath, {
    schemaVersion: SchemaVersion,
    items: [{
      schemaVersion: SchemaVersion,
      bookId,
      documentId: `doc-${bookId}`,
      sourcePath: sourceRelativePath,
      sourceHash,
      sourceIdentityPath: sourceRelativePath,
      normalizedContentHash: sourceHash,
      normalizedPath: `books/${bookId}/input/book.md`,
      configFingerprint: "config-fp",
      promptFingerprint: "prompt-fp",
      modelFingerprint: "model-fp",
      overallStatus: "running",
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:01.000Z",
    }],
  });
  await writeDurableJson(join(runRoot, "manifest.json"), {
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
  await writeDurableJson(join(runRoot, "items", `${itemId}.json`), {
    schemaVersion: SchemaVersion,
    itemId,
    runId: input.runId,
    status: "pending",
    sourceName: "Readonly.epub",
    sourceRelativePath,
    sourceIdentityPath: sourceRelativePath,
    sourceHash,
    normalizedPath: `books/${bookId}/input/book.md`,
    bookId,
    attempts: 1,
    recoveryDecision: "continue_pending",
    commandChecks: [],
  });
  return { bookId, itemId, booksPath, catalogDir };
}

describe("GraphRAG runner status-json durable read-only", () => {
  test("status-json reports missing books checksum meta without state mutation",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-status-readonly-meta-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "status-json-readonly-meta-fixture";
      try {
        const fixture = await writeStatusFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
        });
        await unlink(`${fixture.booksPath}.sha256.meta.json`);
        const before = catalogSnapshot(fixture.catalogDir);

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
          statusJson: true,
        });
        const after = catalogSnapshot(fixture.catalogDir);
        const summary = JSON.parse(result.stdout);
        const diagnostic = summary.durableStateFailures.find(
          (item: { targetLocator?: string }) =>
            item.targetLocator?.endsWith("catalog/books.yaml"),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(after).toEqual(before);
        expect(existsSync(`${fixture.booksPath}.sha256.meta.json`)).toBe(false);
        expect(existsSync(`${fixture.booksPath}.lock`)).toBe(false);
        expect(Object.keys(after).some((name) => name.includes(".tmp-"))).toBe(false);
        expect(diagnostic).toMatchObject({
          localFailureClass: "durable_checksum_meta_missing",
          recoveryDecision: "metadata_missing_read_only",
          checksumRecoveryDecision: "metadata_missing_read_only",
          statusJsonDecision: "read_only_degraded",
          repairAllowed: false,
          directoryTargetLocator: expect.stringContaining("catalog"),
          directoryDurableKind: "directory",
          primaryDurableKind: "yaml",
          lane: "catalogWriterLane",
          targetMappingOwner: "repository",
          primaryTargetLocator: expect.stringContaining("catalog/books.yaml"),
          sidecarTargetLocator: expect.stringContaining(
            "catalog/books.yaml.sha256.meta.json",
          ),
          sidecarKind: "checksum_meta",
          fsyncTarget: expect.stringContaining("catalog"),
          fsyncPlatform: expect.any(String),
          fsyncErrno: "not_attempted_read_only",
          unavailableFieldSentinels: ["fsyncErrno"],
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000);

  test("status-json reports provider request mismatch without state mutation",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-status-provider-request-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "status-json-provider-request-fixture";
      const providerRequestDir = join(stateRoot, "catalog", "provider-requests");
      const providerRequestPath = join(providerRequestDir, "request-a.json");
      try {
        const fixture = await writeStatusFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
        });
        await writeDurableJson(providerRequestPath, {
          schemaVersion: SchemaVersion,
          provider: "fixture",
          requestHash: "request-a",
        });
        await writeFile(`${providerRequestPath}.sha256`, `${"0".repeat(64)}\n`);
        const before = catalogSnapshot(fixture.catalogDir);

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
          statusJson: true,
        });
        const after = catalogSnapshot(fixture.catalogDir);
        const summary = JSON.parse(result.stdout);
        const diagnostic = summary.durableStateFailures.find(
          (item: { diagnosticClass?: string }) =>
            item.diagnosticClass === "provider_request_durable_degraded",
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(after).toEqual(before);
        expect(diagnostic).toMatchObject({
          localFailureClass: "durable_checksum_mismatch",
          recoveryDecision: "continue_with_diagnostic_unless_catalog_blocked",
          statusJsonDecision: "read_only_capped_diagnostic",
          diagnosticClass: "provider_request_durable_degraded",
          normalRunnerAction: "no_primary_quarantine",
          scannedTargetCount: 1,
          degradedTargetCount: 1,
          maxRunnerStartMutationCount: 0,
          repairAllowed: false,
        });
        expect(diagnostic.sampleTargetLocators[0]).toContain(
          "catalog/provider-requests/request-a.json",
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000);

  test("repair writer records successful checksum meta backfill evidence",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-status-meta-backfill-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "checksum-meta-backfill-fixture";
      try {
        const fixture = await writeStatusFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
        });
        await unlink(`${fixture.booksPath}.sha256.meta.json`);
        const actual = sha256Text(readFileSync(fixture.booksPath, "utf8"));

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
        });
        const events = readFileSync(
          join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
          "utf8",
        ).trim().split("\n").map((line) => JSON.parse(line));
        const backfillEvent = events.find((event) =>
          event.event === "durable_checksum_meta_backfilled" &&
          event.checksumRecoveryDecision === "metadata_backfilled"
        );

        expect(result.exitCode).not.toBe(0);
        expect(backfillEvent).toMatchObject({
          status: "pending",
          primaryTargetLocator: expect.stringContaining("catalog/books.yaml"),
          sidecarTargetLocator: expect.stringContaining(
            "catalog/books.yaml.sha256.meta.json",
          ),
          sidecarKind: "checksum_meta",
        });
        expectChecksumMetaRepairFields(backfillEvent, {
          expected: actual,
          actual,
          decision: "metadata_backfilled",
        });
        expect(existsSync(`${fixture.booksPath}.sha256.meta.json`)).toBe(true);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30000);

  test("repair writer reports derived parent directory fsync failure evidence",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-status-meta-dir-fsync-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "checksum-meta-dir-fsync-fixture";
      try {
        const fixture = await writeStatusFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
        });
        await unlink(`${fixture.booksPath}.sha256.meta.json`);

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
          env: {
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_PATTERN:
              "catalog/books.yaml.sha256.meta.json",
          },
        });
        const events = readFileSync(
          join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
          "utf8",
        ).trim().split("\n").map((line) => JSON.parse(line));
        const durableFailure = events.find((event) =>
          event.event === "durable_replace_failed" &&
          event.localFailureClass === "durable_directory_fsync_uncertain"
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("durable directory fsync failed");
        expect(durableFailure).toMatchObject({
          failureKind: "local_state_integrity",
          recoveryDecision: "stop_until_fixed",
          directoryTargetLocator: expect.stringContaining("catalog"),
          directoryDurableKind: "directory",
          primaryDurableKind: "yaml",
          primaryTargetLocator: expect.stringContaining("catalog/books.yaml"),
          sidecarTargetLocator: expect.stringContaining(
            "catalog/books.yaml.sha256.meta.json",
          ),
          sidecarKind: "checksum_meta",
          lane: "catalogWriterLane",
          targetMappingOwner: "repository",
          fsyncTarget: expect.stringContaining("catalog"),
          fsyncErrno: "EIO",
          fsyncPlatform: expect.any(String),
          completedPublishRule: "forbidden",
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000);

  test("repair writer reports checksum sidecar parent directory fsync evidence",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-status-checksum-dir-fsync-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "checksum-dir-fsync-fixture";
      try {
        const fixture = await writeStatusFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
        });
        const actual = sha256Text(readFileSync(fixture.booksPath, "utf8"));
        const pendingMeta = JSON.parse(
          readFileSync(`${fixture.booksPath}.sha256.meta.json`, "utf8"),
        );
        await writeFile(`${fixture.booksPath}.sha256.meta.json`, `${JSON.stringify({
          ...pendingMeta,
          checksum: actual,
          commitState: "target_rename_pending",
          checksumRecoveryDecision: "target_rename_pending",
        }, null, 2)}\n`, "utf8");
        await unlink(`${fixture.booksPath}.sha256`);

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
          env: {
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_PATTERN:
              "catalog/books.yaml.sha256",
            QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_AFTER_MATCHES: "1",
          },
        });
        const events = readFileSync(
          join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
          "utf8",
        ).trim().split("\n").map((line) => JSON.parse(line));
        const durableFailure = events.find((event) =>
          event.event === "durable_replace_failed" &&
          event.localFailureClass === "durable_directory_fsync_uncertain"
        );

        expect(result.exitCode).not.toBe(0);
        expect(durableFailure).toMatchObject({
          failureKind: "local_state_integrity",
          recoveryDecision: "stop_until_fixed",
          directoryDurableKind: "directory",
          primaryDurableKind: "yaml",
          primaryTargetLocator: expect.stringContaining("catalog/books.yaml"),
          sidecarTargetLocator: expect.stringContaining("catalog/books.yaml.sha256"),
          sidecarKind: "checksum",
          lane: "catalogWriterLane",
          targetMappingOwner: "repository",
          fsyncErrno: "EIO",
          fsyncPlatform: expect.any(String),
          completedPublishRule: "forbidden",
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000);

  test("repair writer quarantines invalid checksum meta sidecar only",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-status-meta-invalid-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "checksum-meta-invalid-fixture";
      try {
        const fixture = await writeStatusFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
        });
        const primaryBefore = readFileSync(fixture.booksPath, "utf8");
        const actual = sha256Text(primaryBefore);
        await writeFile(`${fixture.booksPath}.sha256.meta.json`, "{invalid\n");

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
        });
        const events = readFileSync(
          join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
          "utf8",
        ).trim().split("\n").map((line) => JSON.parse(line));
        const quarantineEvent = events.find((event) =>
          event.event === "durable_checksum_meta_sidecar_quarantined"
        );
        const backfillEvent = events.find((event) =>
          event.event === "durable_checksum_meta_backfilled" &&
          event.checksumRecoveryDecision === "checksum_meta_sidecar_repaired"
        );
        const catalogNames = readdirSync(fixture.catalogDir);

        expect(result.exitCode).not.toBe(0);
        expect(readFileSync(fixture.booksPath, "utf8")).toBe(primaryBefore);
        expect(catalogNames.some((name) =>
          name.startsWith("books.yaml.corrupt-")
        )).toBe(false);
        expect(catalogNames.some((name) =>
          name.startsWith("books.yaml.sha256.meta.json.corrupt-")
        )).toBe(true);
        expect(quarantineEvent).toMatchObject({
          localFailureClass: "durable_checksum_meta_invalid",
          primaryTargetLocator: expect.stringContaining("catalog/books.yaml"),
          sidecarTargetLocator: expect.stringContaining(
            "catalog/books.yaml.sha256.meta.json",
          ),
          sidecarKind: "checksum_meta",
        });
        expectChecksumMetaRepairFields(quarantineEvent, {
          expected: null,
          actual,
          decision: "checksum_meta_sidecar_repaired",
        });
        expect(backfillEvent).toMatchObject({
          primaryTargetLocator: expect.stringContaining("catalog/books.yaml"),
          sidecarKind: "checksum_meta",
        });
        expectChecksumMetaRepairFields(backfillEvent, {
          expected: actual,
          actual,
          decision: "checksum_meta_sidecar_repaired",
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000);

  test("repair writer quarantines conflicting checksum meta sidecar only",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-status-meta-conflict-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "checksum-meta-conflict-fixture";
      try {
        const fixture = await writeStatusFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
        });
        const primaryBefore = readFileSync(fixture.booksPath, "utf8");
        const actual = sha256Text(primaryBefore);
        await writeFile(`${fixture.booksPath}.sha256.meta.json`, `${JSON.stringify({
          checksum: "stale",
          checksumRecoveryDecision: "committed",
          commitState: "committed",
          operationId: "fixture-stale-meta",
          runnerSessionId: "fixture-runner",
          fencingTokenHash: "fixture-fence",
          targetGeneration: 1,
        }, null, 2)}\n`, "utf8");

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
          timeoutMs: 90_000,
        });
        const events = readFileSync(
          join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
          "utf8",
        ).trim().split("\n").map((line) => JSON.parse(line));
        const quarantineEvent = events.find((event) =>
          event.event === "durable_checksum_meta_sidecar_quarantined"
        );
        const backfillEvent = events.find((event) =>
          event.event === "durable_checksum_meta_backfilled" &&
          event.checksumRecoveryDecision === "checksum_meta_sidecar_repaired"
        );
        const catalogNames = readdirSync(fixture.catalogDir);

        expect(result.exitCode).not.toBe(0);
        expect(readFileSync(fixture.booksPath, "utf8")).toBe(primaryBefore);
        expect(catalogNames.some((name) =>
          name.startsWith("books.yaml.corrupt-")
        )).toBe(false);
        expect(catalogNames.some((name) =>
          name.startsWith("books.yaml.sha256.meta.json.corrupt-")
        )).toBe(true);
        expect(quarantineEvent).toMatchObject({
          localFailureClass: "durable_checksum_meta_conflict",
          primaryTargetLocator: expect.stringContaining("catalog/books.yaml"),
          sidecarKind: "checksum_meta",
        });
        expectChecksumMetaRepairFields(quarantineEvent, {
          expected: "stale",
          actual,
          decision: "checksum_meta_sidecar_repaired",
        });
        expectChecksumMetaRepairFields(backfillEvent, {
          expected: actual,
          actual,
          decision: "checksum_meta_sidecar_repaired",
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000);

  test("repair writer classifies checksum meta sidecar rename ENOENT",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-status-meta-enoent-");
      const sourceDir = join(tmpRoot, "source");
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const configDir = join(tmpRoot, "config");
      const runId = "checksum-meta-rename-enoent-fixture";
      try {
        const fixture = await writeStatusFixture({
          tmpRoot,
          sourceDir,
          stateRoot,
          configDir,
          runId,
        });
        await unlink(`${fixture.booksPath}.sha256.meta.json`);
        const actual = sha256Text(readFileSync(fixture.booksPath, "utf8"));

        const result = await runBatch({
          tmpRoot,
          sourceDir,
          stateRoot,
          logRoot,
          configDir,
          runId,
          env: {
            QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
            QMD_GRAPHRAG_TEST_RENAME_ENOENT_ONCE_PATTERN:
              "books.yaml.sha256.meta.json",
          },
        });
        const eventRaw = readFileSync(
          join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
          "utf8",
        );
        const events = eventRaw.trim().split("\n").map((line) => JSON.parse(line));
        const durableFailure = events.find((event) =>
          event.event === "durable_replace_failed" &&
          event.localFailureClass === "durable_temp_rename_enoent"
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("durable_temp_rename_enoent");
        expect(durableFailure).toMatchObject({
          failureKind: "local_state_integrity",
          localFailureClass: "durable_temp_rename_enoent",
          recoveryDecision: "stop_until_fixed",
          failedSyscall: "rename",
          errno: "ENOENT",
          primaryTargetLocator: expect.stringContaining("catalog/books.yaml"),
          sidecarTargetLocator: expect.stringContaining(
            "catalog/books.yaml.sha256.meta.json",
          ),
          sidecarKind: "checksum_meta",
        });
        expectChecksumMetaRepairFields(durableFailure, {
          expected: actual,
          actual,
          decision: "metadata_backfilled",
        });
        expect(durableFailure.tempId).toEqual(expect.any(String));
        expect(durableFailure.operationId).toEqual(expect.any(String));
        expect(existsSync(fixture.booksPath)).toBe(true);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120000);
});
