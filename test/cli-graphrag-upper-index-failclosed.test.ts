import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildBookshelfGraph,
  validateBookshelfGraph,
} from "../src/graphrag/upper-index/bookshelf-graph.js";
import {
  resolveBookshelfMembership,
} from "../src/graphrag/upper-index/bookshelf-membership.js";
import { qmdRunnerArgs } from "./helpers/cli-harness.js";
import { writeReadyHotplugBook } from "./helpers/graphrag-hotplug-book-package.js";
import { mkProjectTmpDir } from "./helpers/graphrag-runner-harness.js";

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJsonWithSidecar(path: string, value: unknown): Promise<void> {
  const text = stableJson(value);
  await writeFile(path, text, "utf8");
  await writeFile(`${path}.sha256`, `${sha256Text(text)}\n`, "utf8");
}

async function runQmd(input: {
  cwd: string;
  dbPath: string;
  configDir: string;
  args: string[];
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const runner = qmdRunnerArgs(input.args);
  const child = spawn(runner.command, runner.args, {
    cwd: input.cwd,
    env: {
      ...process.env,
      INDEX_PATH: input.dbPath,
      QMD_CONFIG_DIR: input.configDir,
      PWD: input.cwd,
      QMD_DOCTOR_DEVICE_PROBE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  return { stdout, stderr, exitCode };
}

async function overwriteParquetColumn(input: {
  path: string;
  column: string;
  value: string;
}): Promise<void> {
  const script = [
    "import sys",
    "import pyarrow as pa",
    "import pyarrow.parquet as pq",
    "path, column, value = sys.argv[1], sys.argv[2], sys.argv[3]",
    "table = pq.read_table(path)",
    "arrays = []",
    "for name in table.column_names:",
    "    if name == column:",
    "        arrays.append(pa.array([value] * table.num_rows, type=pa.string()))",
    "    else:",
    "        arrays.append(table.column(name))",
    "pq.write_table(pa.table(arrays, names=table.column_names), path)",
  ].join("\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", [
      "-c",
      script,
      input.path,
      input.column,
      input.value,
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `python3 exited ${code ?? 1}`));
    });
  });
}

async function resolvePythonBin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [
      "-c",
      "import sys; print(sys.executable)",
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `python3 exited ${code ?? 1}`));
    });
  });
}

async function refreshManifestFileRecord(input: {
  root: string;
  manifestName: string;
  relativePath: string;
}): Promise<void> {
  const artifactPath = join(input.root, input.relativePath);
  const bytes = await readFile(artifactPath);
  const sha256 = sha256Buffer(bytes);
  await writeFile(`${artifactPath}.sha256`, `${sha256}\n`, "utf8");

  const manifestPath = join(input.root, input.manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const file = manifest.files.find(
    (item: { path: string }) => item.path === input.relativePath,
  );
  if (file == null) {
    throw new Error(`manifest_file_record_missing:${input.relativePath}`);
  }
  file.bytes = bytes.byteLength;
  file.sha256 = sha256;
  await writeJsonWithSidecar(manifestPath, manifest);
}

async function readBookshelfCurrentRoot(
  graphVault: string,
  bookshelfId: string,
): Promise<string> {
  const current = JSON.parse(
    await readFile(
      join(graphVault, "bookshelves", bookshelfId, "CURRENT.json"),
      "utf8",
    ),
  );
  return join(graphVault, "bookshelves", bookshelfId, current.current);
}

async function updateUpperPublishPointers(input: {
  packageRoot: string;
  manifestName: string;
  generationManifestPath: string;
}): Promise<void> {
  const manifestSha256 = sha256Buffer(await readFile(input.generationManifestPath));
  await writeFile(`${input.generationManifestPath}.sha256`, `${manifestSha256}\n`);
  const rootManifestPath = join(input.packageRoot, input.manifestName);
  const rootManifest = JSON.parse(await readFile(input.generationManifestPath, "utf8"));
  await writeJsonWithSidecar(rootManifestPath, rootManifest);

  const currentPath = join(input.packageRoot, "CURRENT.json");
  const current = JSON.parse(await readFile(currentPath, "utf8"));
  current.manifestSha256 = manifestSha256;
  await writeJsonWithSidecar(currentPath, current);

  const publishReadyPath = join(input.packageRoot, "PUBLISH_READY.json");
  const publishReady = JSON.parse(await readFile(publishReadyPath, "utf8"));
  publishReady.manifestSha256 = manifestSha256;
  await writeJsonWithSidecar(publishReadyPath, publishReady);
}

describe("GraphRAG upper index CLI fail-closed behavior", () => {
  test("qmd query --bookshelf-id returns typed error for polluted upper parquet",
    async () => {
      const tmpRoot = await mkProjectTmpDir("qmd-cli-upper-failclosed-");
      try {
        const graphVault = join(tmpRoot, "graph_vault");
        const configDir = join(tmpRoot, "config");
        const dbPath = join(tmpRoot, "index.sqlite");
        const pythonBin = await resolvePythonBin();
        await mkdir(configDir, { recursive: true });
        await writeFile(join(configDir, "index.yml"), "collections: {}\n");

        const bookIds = ["book-cli-up-a", "book-cli-up-b", "book-cli-up-c"];
        for (const [index, bookId] of bookIds.entries()) {
          await writeReadyHotplugBook({
            stateRoot: graphVault,
            bookId,
            title: `CLI Upper Fail Closed ${index + 1}`,
          });
        }
        await resolveBookshelfMembership({
          graphVault,
          bookshelfId: "architecture-core",
          bookIds,
          now: () => "2026-06-06T00:00:32.000Z",
        });
        await buildBookshelfGraph({
          graphVault,
          bookshelfId: "architecture-core",
          maxReportsPerBook: 2,
          maxSemanticUnits: 16,
          maxEdges: 32,
          now: () => "2026-06-06T00:00:33.000Z",
        });

        const currentRoot = await readBookshelfCurrentRoot(
          graphVault,
          "architecture-core",
        );
        const leakedPath = "/Users/jin/private/query.log";
        const leakedToken = "Bearer testtoken12345678";
        await overwriteParquetColumn({
          path: join(currentRoot, "community_reports.parquet"),
          column: "summary",
          value: [
            "providerRequestPayload rawPrompt",
            leakedToken,
            leakedPath,
          ].join(" "),
        });
        await refreshManifestFileRecord({
          root: currentRoot,
          manifestName: "BOOKSHELF_MANIFEST.json",
          relativePath: "community_reports.parquet",
        });
        await updateUpperPublishPointers({
          packageRoot: join(graphVault, "bookshelves", "architecture-core"),
          manifestName: "BOOKSHELF_MANIFEST.json",
          generationManifestPath: join(currentRoot, "BOOKSHELF_MANIFEST.json"),
        });
        const validation = await validateBookshelfGraph({
          graphVault,
          bookshelfId: "architecture-core",
        });
        expect(validation.diagnostics).toContain(
          "sensitive_payload_detected:community_reports.parquet:summary:provider_payload",
        );

        const result = await runQmd({
          cwd: tmpRoot,
          dbPath,
          configDir,
          args: [
            "query",
            "--bookshelf-id",
            "architecture-core",
            "--graph-vault",
            graphVault,
            "--python-bin",
            pythonBin,
            "--json",
            "--timing",
            "--no-rerank",
            "What is architecture testing?",
          ],
        });

        expect(result.exitCode, result.stderr).toBe(65);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain(leakedPath);
        expect(result.stderr).not.toContain(leakedToken);
        const error = JSON.parse(result.stderr);
        expect(error).toMatchObject({
          route: "graphrag",
          stage: "graph_capability",
          provider: "graphrag",
          capability: "graph_query",
          code: "upper_quality_gate_failed",
          exitCode: 65,
          scopeKind: "bookshelf",
          scopeId: "architecture-core",
          retryable: false,
          remediationCommand:
            "node scripts/graphrag/build-bookshelf-graph.mjs " +
            "--graph-vault <path> --bookshelf-id architecture-core",
          timingAvailable: true,
        });
        expect(error.metadata.diagnostics).toContain(
          "sensitive_payload_detected:community_reports.parquet:summary:provider_payload",
        );
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    60000,
  );
});
