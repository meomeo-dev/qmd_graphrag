import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import YAML from "yaml";

import { SchemaVersion } from "../src/contracts/common.js";
import { loadGraphQueryCapabilities } from "../src/graphrag/capability-catalog.js";
import {
  validateHotplugRuntimeQueryGate,
} from "../src/graphrag/book-hotplug-runtime-gate.js";
import {
  createStore,
  extractTitle,
  insertContent,
  insertDocument,
  syncConfigToDb,
} from "../src/store.js";
import { qmdRunnerArgs } from "./helpers/cli-harness.js";
import { writeReadyHotplugBook } from "./helpers/graphrag-hotplug-book-package.js";

const workspaces: string[] = [];

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeStuckBridge(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  setInterval(() => {}, 1000);
});
`,
    "utf8",
  );
  await chmod(path, 0o755);
}

async function runQmd(input: {
  cwd: string;
  dbPath: string;
  configDir: string;
  graphVault: string;
  fakeBridge: string;
  args: string[];
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const runner = qmdRunnerArgs(input.args);
  const child = spawn(runner.command, runner.args, {
    cwd: input.cwd,
    env: {
      ...process.env,
      INDEX_PATH: input.dbPath,
      QMD_CONFIG_DIR: input.configDir,
      QMD_GRAPHRAG_PYTHON: input.fakeBridge,
      QMD_GRAPHRAG_QUERY_TIMEOUT_MS: "300",
      QMD_DOCTOR_DEVICE_PROBE: "0",
      PWD: input.cwd,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let killedForTimeout = false;
  const timeout = setTimeout(() => {
    killedForTimeout = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }, 10_000);
  timeout.unref();

  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(timeout);

  return {
    stdout,
    stderr: killedForTimeout
      ? `${stderr}\nqmd command timed out after 10000ms`.trim()
      : stderr,
    exitCode: killedForTimeout ? exitCode || 124 : exitCode,
  };
}

async function createGraphReadyWorkspace(): Promise<{
  root: string;
  dbPath: string;
  configDir: string;
  graphVault: string;
  fakeBridge: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "qmd-cli-graphrag-timeout-"));
  workspaces.push(root);
  const dbPath = join(root, "index.sqlite");
  const configDir = join(root, "config");
  const graphVault = join(root, "graph_vault");
  const fakeBridge = join(root, "stuck-graphrag-bridge.js");
  const bookId = "book-cli-timeout";
  const title = "Architecture Timeout";
  const relativePath = "docs/architecture-timeout.md";
  const normalizedText = `# ${title}\n\nArchitecture and software design.\n`;
  const normalizedHash = sha256Text(normalizedText);

  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(root, relativePath), normalizedText, "utf8");
  await writeStuckBridge(fakeBridge);
  await writeReadyHotplugBook({ stateRoot: graphVault, bookId, title });

  const store = createStore(dbPath);
  try {
    const now = "2026-06-06T00:00:00.000Z";
    insertContent(store.db, normalizedHash, normalizedText, now);
    insertDocument(
      store.db,
      "docs",
      relativePath,
      extractTitle(normalizedText, relativePath),
      normalizedHash,
      now,
      now,
    );
    syncConfigToDb(store.db, {
      collections: {
        docs: { path: join(root, "docs"), pattern: "**/*.md" },
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
        docs: { path: join(root, "docs"), pattern: "**/*.md" },
      },
      graphrag: {
        vault: "graph_vault",
        default_method: "local",
        default_response_type: "multiple paragraphs",
      },
    }),
    "utf8",
  );

  return { root, dbPath, configDir, graphVault, fakeBridge };
}

function parseTypedJson(stderr: string): Record<string, unknown> {
  const start = stderr.indexOf("{");
  if (start < 0) throw new Error(`missing JSON error: ${stderr}`);
  return JSON.parse(stderr.slice(start)) as Record<string, unknown>;
}

afterEach(async () => {
  while (workspaces.length > 0) {
    const workspace = workspaces.pop()!;
    if (existsSync(workspace)) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

describe("CLI GraphRAG provider timeout", () => {
  test("qmd query --graphrag returns typed JSON when the bridge times out",
    async () => {
      const workspace = await createGraphReadyWorkspace();
      const runtimeGate = await validateHotplugRuntimeQueryGate({
        graphVault: workspace.graphVault,
        bookId: "book-cli-timeout",
      });
      expect(runtimeGate.ok, runtimeGate.diagnostics.join(",")).toBe(true);
      const capabilities = await loadGraphQueryCapabilities({
        graphVault: workspace.graphVault,
        bookIds: ["book-cli-timeout"],
      });
      expect(capabilities.map((capability) => capability.capabilityId))
        .toContain("book-cli-timeout:graph_query");
      const result = await runQmd({
        ...workspace,
        args: [
          "query",
          "--graphrag",
          "--graph-vault",
          workspace.graphVault,
          "--graph-book-id",
          "book-cli-timeout",
          "--json",
          "--no-rerank",
          "Architecture and software design",
        ],
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout.trim()).toBe("");
      expect(result.stderr).not.toContain("qmd command timed out");

      const error = parseTypedJson(result.stderr);
      expect(error).toMatchObject({
        schemaVersion: SchemaVersion,
        route: "graphrag",
        stage: "graphrag_query",
        provider: "graphrag",
        capability: "graph_query",
        code: "provider_unavailable",
        retryable: true,
      });
      expect(String(error.redactedMessage)).toContain(
        "GraphRAG query provider failed before returning a response.",
      );
    },
    20_000);
});
