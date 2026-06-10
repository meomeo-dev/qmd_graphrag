import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, test } from "vitest";

function qmdCommandArgs(args: string[]): { bin: string; args: string[] } {
  const cliPath = join(process.cwd(), "src/cli/qmd.ts");
  return {
    bin: nodeScriptBin(),
    args: [
      join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
      cliPath,
      ...args,
    ],
  };
}

function nodeScriptBin(): string {
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

const roots: string[] = [];
const QMD_PROCESS_TIMEOUT_MS = 45_000;

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "qmd-dspy-cli-"));
  roots.push(root);
  mkdirSync(join(root, ".qmd"), { recursive: true });
  writeFileSync(join(root, ".qmd", "index.yaml"), "collections: {}\n");
  return root;
}

function qmdProcess(
  root: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
}> {
  const { bin, args: commandArgs } = qmdCommandArgs(args);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, "home"),
    PWD: root,
    QMD_DOCTOR_DEVICE_PROBE: "0",
    ...env,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }

  return new Promise((resolve) => {
    const child = spawn(bin, commandArgs, {
      cwd: root,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let spawnError: Error | undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const forceKillTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000);
      if (typeof forceKillTimer.unref === "function") forceKillTimer.unref();
    }, QMD_PROCESS_TIMEOUT_MS);
    if (typeof killTimer.unref === "function") killTimer.unref();

    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status, signal) => {
      settled = true;
      clearTimeout(killTimer);
      resolve({
        status,
        stdout,
        stderr,
        error: spawnError,
        signal,
        timedOut,
      });
    });
  });
}

async function runQmd(
  root: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<string> {
  const result = await qmdProcess(root, args, env);
  if (result.status !== 0) {
    const command = ["qmd", ...args].join(" ");
    let failure = `exit status ${result.status}`;
    if (result.signal) failure += ` signal ${result.signal}`;
    if (result.timedOut) {
      failure = `timed out after ${QMD_PROCESS_TIMEOUT_MS}ms`;
      if (result.signal) failure += ` signal ${result.signal}`;
    }
    if (result.error != null) {
      failure = `${result.error.name}: ${result.error.message}`;
    }
    throw new Error(
      `qmd failed (${failure}) for ${command}\n` +
        `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function readLocalConfig(root: string): any {
  return YAML.parse(readFileSync(join(root, ".qmd", "index.yaml"), "utf-8"));
}

function writeExpansionRecords(root: string): string {
  const recordsPath = join(root, "records.jsonl");
  writeFileSync(
    recordsPath,
    JSON.stringify({
      query: "hexagonal architecture",
      output: [{ type: "lex", text: "ports adapters architecture" }],
    }) + "\n",
  );
  return recordsPath;
}

async function promoteImportedPolicy(root: string, graphVault = "graph_vault") {
  const recordsPath = writeExpansionRecords(root);
  const imported = JSON.parse(await runQmd(root, [
    "dspy",
    "import-expansion-records",
    "--records",
    recordsPath,
    "--graph-vault",
    graphVault,
  ]));
  const report = JSON.parse(await runQmd(root, [
    "dspy",
    "evaluate-expansion-policy",
    "--artifact",
    imported.artifactPath,
    "--graph-vault",
    graphVault,
  ]));
  await runQmd(root, [
    "dspy",
    "promote-expansion-policy",
    "--artifact",
    imported.artifactPath,
    "--report",
    `dspy/reports/${report.reportId}.yaml`,
    "--graph-vault",
    graphVault,
  ]);
  return { imported, report };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("qmd dspy CLI", () => {
  test("loads project .env before running CLI commands", async () => {
    const root = tempProject();
    writeFileSync(join(root, ".env"), "QMD_DSPY_DOTENV_TEST=loaded-from-dotenv\n");
    const trainsetPath = join(root, "train.jsonl");
    writeFileSync(trainsetPath, JSON.stringify({ query: "hexagonal architecture" }) + "\n");
    const fakePython = join(root, "fake-python.js");
    writeFileSync(fakePython, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
if (process.env.QMD_DSPY_DOTENV_TEST !== "loaded-from-dotenv") {
  throw new Error("project .env was not loaded into the DSPy bridge environment");
}
fs.mkdirSync(path.dirname(request.savePromptPath), { recursive: true });
fs.writeFileSync(request.savePromptPath, "dotenv optimized prompt");
fs.writeFileSync(request.emitPath, JSON.stringify({
  query: "hexagonal architecture",
  output: [{ type: "lex", text: "ports adapters architecture" }]
}) + "\\n");
process.stdout.write(JSON.stringify({
  schemaVersion: "1.0.0",
  optimizer: request.optimizer,
  command: ["fake-python", "dspy_gepa.py"],
  savedPromptPath: request.savePromptPath,
  emitPath: request.emitPath,
  stdoutTail: ["dotenv optimize complete"]
}));
`);
    chmodSync(fakePython, 0o755);

    const output = JSON.parse(await runQmd(root, [
      "dspy",
      "optimize-query-prompt",
      "--trainset",
      trainsetPath,
      "--graph-vault",
      "graph_vault",
      "--python-bin",
      fakePython,
    ], { QMD_DSPY_DOTENV_TEST: undefined }));

    expect(output.runPath).toMatch(/^dspy\/runs\/.*\/run.yaml$/);
  });

  test("runs optimize-query-prompt through the CLI bridge with a fake python",
    async () => {
    const root = tempProject();
    const trainsetPath = join(root, "train.jsonl");
    writeFileSync(trainsetPath, JSON.stringify({
      query: "hexagonal architecture",
      output: [{ type: "lex", text: "ports adapters architecture" }],
    }) + "\n");
    const fakePython = join(root, "fake-python.js");
    writeFileSync(fakePython, `#!/usr/bin/env node
const fs = require("fs");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
if (request.provider.endpoint !== "/responses") {
  throw new Error("expected /responses endpoint");
}
if (request.provider.stream !== true) {
  throw new Error("expected Responses API stream mode");
}
if (request.provider.apiKeyEnv !== "OPENAI_API_KEY") {
  throw new Error("expected OPENAI_API_KEY env ref");
}
if (request.provider.baseUrlEnv !== "OPENAI_BASE_URL") {
  throw new Error("expected OPENAI_BASE_URL env ref");
}
const savePrompt = request.savePromptPath;
const emit = request.emitPath;
fs.mkdirSync(require("path").dirname(savePrompt), { recursive: true });
fs.writeFileSync(savePrompt, "fake optimized prompt");
fs.writeFileSync(emit, JSON.stringify({
  query: "hexagonal architecture",
  output: [{ type: "lex", text: "ports adapters architecture" }]
}) + "\\n");
process.stdout.write(JSON.stringify({
  schemaVersion: "1.0.0",
  optimizer: request.optimizer,
  command: ["fake-python", "dspy_gepa.py"],
  savedPromptPath: savePrompt,
  emitPath: emit,
  stdoutTail: ["fake optimize complete"]
}));
`);
    chmodSync(fakePython, 0o755);

    const output = JSON.parse(await runQmd(root, [
      "dspy",
      "optimize-query-prompt",
      "--trainset",
      trainsetPath,
      "--graph-vault",
      "graph_vault",
      "--python-bin",
      fakePython,
    ]));

    expect(output.runPath).toMatch(/^dspy\/runs\/.*\/run.yaml$/);
    expect(output.artifactPath).toMatch(/^dspy\/artifacts\//);
    expect(existsSync(join(root, "graph_vault", output.runPath))).toBe(true);
    expect(existsSync(join(root, "graph_vault", output.artifactPath))).toBe(true);
  });

  test("registers metric and dataset registries used by optimize and evaluate",
    async () => {
    const root = tempProject();
    const trainsetPath = join(root, "train.jsonl");
    const valsetPath = join(root, "val.jsonl");
    writeFileSync(trainsetPath, JSON.stringify({
      query: "hexagonal architecture",
      output: [{ type: "lex", text: "ports adapters architecture" }],
    }) + "\n");
    writeFileSync(valsetPath, JSON.stringify({
      query: "dependency inversion",
      output: [{ type: "vec", text: "stable dependency boundaries" }],
    }) + "\n");
    const fakePython = join(root, "fake-python.js");
    writeFileSync(fakePython, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
fs.mkdirSync(path.dirname(request.savePromptPath), { recursive: true });
fs.writeFileSync(request.savePromptPath, "registry optimized prompt");
fs.writeFileSync(request.emitPath, JSON.stringify({
  query: "hexagonal architecture",
  output: [{ type: "lex", text: "ports adapters architecture" }]
}) + "\\n");
process.stdout.write(JSON.stringify({
  schemaVersion: "1.0.0",
  optimizer: request.optimizer,
  command: ["fake-python", "dspy_gepa.py"],
  savedPromptPath: request.savePromptPath,
  emitPath: request.emitPath,
  stdoutTail: ["registry optimize complete"]
}));
`);
    chmodSync(fakePython, 0o755);

    const metric = JSON.parse(await runQmd(root, [
      "dspy",
      "register-metric-spec",
      "--metric",
      "metric-v1",
      "--description",
      "schema-valid query expansion metric",
      "--max-expansion-items",
      "3",
      "--graph-vault",
      "graph_vault",
    ]));
    const dataset = JSON.parse(await runQmd(root, [
      "dspy",
      "register-evaluation-dataset",
      "--dataset",
      "dataset-v1",
      "--trainset",
      trainsetPath,
      "--valset",
      valsetPath,
      "--graph-vault",
      "graph_vault",
    ]));
    const output = JSON.parse(await runQmd(root, [
      "dspy",
      "optimize-query-prompt",
      "--dataset",
      "dataset-v1",
      "--metric",
      "metric-v1",
      "--python-bin",
      fakePython,
      "--graph-vault",
      "graph_vault",
    ]));
    const report = JSON.parse(await runQmd(root, [
      "dspy",
      "evaluate-expansion-policy",
      "--artifact",
      output.artifactPath,
      "--dataset",
      "dataset-v1",
      "--metric",
      "metric-v1",
      "--graph-vault",
      "graph_vault",
    ]));

    expect(metric.metricPath).toMatch(/^dspy\/metrics\//);
    expect(dataset.datasetPath).toMatch(/^dspy\/datasets\//);
    expect(existsSync(join(root, "graph_vault", metric.metricPath))).toBe(true);
    expect(existsSync(join(root, "graph_vault", dataset.datasetPath))).toBe(true);
    expect(report.datasetId).toBe("dataset-v1");
    expect(report.metricVersion).toBe("metric-v1");
    expect(report.metrics.metric_max_expansion_items).toBe(3);
  });

  test("imports, evaluates, promotes, disables, and rollbacks a policy", async () => {
    const root = tempProject();
    const recordsPath = join(root, "records.jsonl");
    writeFileSync(
      recordsPath,
      JSON.stringify({
        query: "hexagonal architecture",
        output: [
          { type: "lex", text: "ports adapters architecture" },
          { type: "vec", text: "dependency inversion boundaries" },
        ],
      }) + "\n",
    );

    const graphVault = "graph_vault";
    const importOutput = JSON.parse(await runQmd(root, [
      "dspy",
      "import-expansion-records",
      "--records",
      recordsPath,
      "--graph-vault",
      graphVault,
    ]));
    expect(importOutput.artifactPath).toMatch(/^dspy\/artifacts\//);
    expect(existsSync(join(root, graphVault, importOutput.artifactPath))).toBe(true);

    const report = JSON.parse(await runQmd(root, [
      "dspy",
      "evaluate-expansion-policy",
      "--artifact",
      importOutput.artifactPath,
      "--graph-vault",
      graphVault,
    ]));
    expect(report.schemaValidity).toBe(true);
    expect(report.promotability).toBe("promotable");

    const reportPath = `dspy/reports/${report.reportId}.yaml`;
    const decision = JSON.parse(await runQmd(root, [
      "dspy",
      "promote-expansion-policy",
      "--artifact",
      importOutput.artifactPath,
      "--report",
      reportPath,
      "--graph-vault",
      graphVault,
      "--strict-refuse",
    ]));
    expect(decision.promotionStatus).toBe("promoted");

    const promotedConfig = readLocalConfig(root);
    expect(promotedConfig.graphrag.vault).toBe(graphVault);
    expect(promotedConfig.query.expansion_policy).toMatchObject({
      provider: "dspy",
      policy_ref: "graph_vault/dspy/policies/query-expansion/current.yaml",
      failure_policy: "strict_refuse",
      strict_schema: true,
    });

    const status = JSON.parse(await runQmd(root, [
      "dspy",
      "status",
      "--graph-vault",
      graphVault,
    ]));
    expect(status.pointer.provider).toBe("dspy");
    expect(status.pointer.active).toBe(true);

    const disabled = JSON.parse(await runQmd(root, [
      "dspy",
      "disable-expansion-policy",
      "--graph-vault",
      graphVault,
    ]));
    expect(disabled.active).toBe(false);
    expect(readLocalConfig(root).query.expansion_policy.provider).toBe("builtin");

    const rolledBack = JSON.parse(await runQmd(root, [
      "dspy",
      "rollback-expansion-policy",
      "--graph-vault",
      graphVault,
    ]));
    expect(rolledBack.provider).toBe("dspy");
    expect(rolledBack.active).toBe(true);
    expect(readLocalConfig(root).query.expansion_policy).toMatchObject({
      provider: "dspy",
      policy_ref: "graph_vault/dspy/policies/query-expansion/current.yaml",
      failure_policy: "strict_refuse",
    });
  });

  test("writes portable policy_ref for nested graph_vault override", async () => {
    const root = tempProject();
    const recordsPath = join(root, "records.jsonl");
    writeFileSync(
      recordsPath,
      JSON.stringify({
        query: "hexagonal architecture",
        output: [{ type: "lex", text: "ports adapters architecture" }],
      }) + "\n",
    );
    const graphVault = join("vaults", "graph_vault");
    const imported = JSON.parse(await runQmd(root, [
      "dspy",
      "import-expansion-records",
      "--records",
      recordsPath,
      "--graph-vault",
      graphVault,
    ]));
    const report = JSON.parse(await runQmd(root, [
      "dspy",
      "evaluate-expansion-policy",
      "--artifact",
      imported.artifactPath,
      "--graph-vault",
      graphVault,
    ]));

    await runQmd(root, [
      "dspy",
      "promote-expansion-policy",
      "--artifact",
      imported.artifactPath,
      "--report",
      `dspy/reports/${report.reportId}.yaml`,
      "--graph-vault",
      graphVault,
    ]);
    const config = readLocalConfig(root);
    expect(config.graphrag.vault).toBe(graphVault);
    expect(config.query.expansion_policy.policy_ref).toBe(
      "graph_vault/dspy/policies/query-expansion/current.yaml",
    );

    const status = JSON.parse(await runQmd(root, [
      "dspy",
      "status",
      "--graph-vault",
      graphVault,
    ]));
    expect(status.pointer.active).toBe(true);
  });

  test("restores pointer when promote config write fails", async () => {
    const root = tempProject();
    const recordsPath = writeExpansionRecords(root);
    const imported = JSON.parse(await runQmd(root, [
      "dspy",
      "import-expansion-records",
      "--records",
      recordsPath,
      "--graph-vault",
      "graph_vault",
    ]));
    const report = JSON.parse(await runQmd(root, [
      "dspy",
      "evaluate-expansion-policy",
      "--artifact",
      imported.artifactPath,
      "--graph-vault",
      "graph_vault",
    ]));

    const failed = await qmdProcess(root, [
      "dspy",
      "promote-expansion-policy",
      "--artifact",
      imported.artifactPath,
      "--report",
      `dspy/reports/${report.reportId}.yaml`,
      "--graph-vault",
      "graph_vault",
    ], { QMD_TEST_FAIL_DSPY_CONFIG_WRITE: "1" });

    expect(failed.status).not.toBe(0);
    const status = JSON.parse(await runQmd(root, [
      "dspy",
      "status",
      "--graph-vault",
      "graph_vault",
    ]));
    expect(status.pointer).toBeNull();
  });

  test("restores pointer when disable config write fails", async () => {
    const root = tempProject();
    await promoteImportedPolicy(root);

    const failed = await qmdProcess(root, [
      "dspy",
      "disable-expansion-policy",
      "--graph-vault",
      "graph_vault",
    ], { QMD_TEST_FAIL_DSPY_CONFIG_WRITE: "1" });

    expect(failed.status).not.toBe(0);
    const status = JSON.parse(await runQmd(root, [
      "dspy",
      "status",
      "--graph-vault",
      "graph_vault",
    ]));
    expect(status.pointer.provider).toBe("dspy");
    expect(status.pointer.active).toBe(true);
    expect(readLocalConfig(root).query.expansion_policy.provider).toBe("dspy");
  });

  test("restores pointer when rollback config write fails", async () => {
    const root = tempProject();
    await promoteImportedPolicy(root);
    await runQmd(root, [
      "dspy",
      "disable-expansion-policy",
      "--graph-vault",
      "graph_vault",
    ]);
    expect(readLocalConfig(root).query.expansion_policy.provider).toBe("builtin");

    const failed = await qmdProcess(root, [
      "dspy",
      "rollback-expansion-policy",
      "--graph-vault",
      "graph_vault",
    ], { QMD_TEST_FAIL_DSPY_CONFIG_WRITE: "1" });

    expect(failed.status).not.toBe(0);
    const status = JSON.parse(await runQmd(root, [
      "dspy",
      "status",
      "--graph-vault",
      "graph_vault",
    ]));
    expect(status.pointer.provider).toBe("disabled");
    expect(status.pointer.active).toBe(false);
    expect(readLocalConfig(root).query.expansion_policy.provider).toBe("builtin");
  });
});
