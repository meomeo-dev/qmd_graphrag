import { execFileSync, spawnSync } from "node:child_process";
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
import { join } from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, test } from "vitest";

function qmdCommandArgs(args: string[]): { bin: string; args: string[] } {
  const cliPath = join(process.cwd(), "src/cli/qmd.ts");
  if (process.versions.bun) {
    return { bin: process.execPath, args: [cliPath, ...args] };
  }
  return {
    bin: process.execPath,
    args: [
      join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
      cliPath,
      ...args,
    ],
  };
}

const roots: string[] = [];

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
) {
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
  return spawnSync(bin, commandArgs, {
    cwd: root,
    encoding: "utf-8",
    env: childEnv,
  });
}

function runQmd(
  root: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): string {
  const result = qmdProcess(root, args, env);
  if (result.status !== 0) {
    throw new Error(
      `qmd failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
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

function promoteImportedPolicy(root: string, graphVault = "graph_vault") {
  const recordsPath = writeExpansionRecords(root);
  const imported = JSON.parse(runQmd(root, [
    "dspy",
    "import-expansion-records",
    "--records",
    recordsPath,
    "--graph-vault",
    graphVault,
  ]));
  const report = JSON.parse(runQmd(root, [
    "dspy",
    "evaluate-expansion-policy",
    "--artifact",
    imported.artifactPath,
    "--graph-vault",
    graphVault,
  ]));
  runQmd(root, [
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
  test("loads project .env before running CLI commands", () => {
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

    const output = JSON.parse(runQmd(root, [
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

  test("runs optimize-query-prompt through the CLI bridge with a fake python", () => {
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

    const output = JSON.parse(runQmd(root, [
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

  test("registers metric and dataset registries used by optimize and evaluate", () => {
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

    const metric = JSON.parse(runQmd(root, [
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
    const dataset = JSON.parse(runQmd(root, [
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
    const output = JSON.parse(runQmd(root, [
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
    const report = JSON.parse(runQmd(root, [
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

  test("imports, evaluates, promotes, disables, and rollbacks a policy", () => {
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
    const importOutput = JSON.parse(runQmd(root, [
      "dspy",
      "import-expansion-records",
      "--records",
      recordsPath,
      "--graph-vault",
      graphVault,
    ]));
    expect(importOutput.artifactPath).toMatch(/^dspy\/artifacts\//);
    expect(existsSync(join(root, graphVault, importOutput.artifactPath))).toBe(true);

    const report = JSON.parse(runQmd(root, [
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
    const decision = JSON.parse(runQmd(root, [
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

    const status = JSON.parse(runQmd(root, [
      "dspy",
      "status",
      "--graph-vault",
      graphVault,
    ]));
    expect(status.pointer.provider).toBe("dspy");
    expect(status.pointer.active).toBe(true);

    const disabled = JSON.parse(runQmd(root, [
      "dspy",
      "disable-expansion-policy",
      "--graph-vault",
      graphVault,
    ]));
    expect(disabled.active).toBe(false);
    expect(readLocalConfig(root).query.expansion_policy.provider).toBe("builtin");

    const rolledBack = JSON.parse(runQmd(root, [
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

  test("writes portable policy_ref for nested graph_vault override", () => {
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
    const imported = JSON.parse(runQmd(root, [
      "dspy",
      "import-expansion-records",
      "--records",
      recordsPath,
      "--graph-vault",
      graphVault,
    ]));
    const report = JSON.parse(runQmd(root, [
      "dspy",
      "evaluate-expansion-policy",
      "--artifact",
      imported.artifactPath,
      "--graph-vault",
      graphVault,
    ]));

    runQmd(root, [
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

    const status = JSON.parse(runQmd(root, [
      "dspy",
      "status",
      "--graph-vault",
      graphVault,
    ]));
    expect(status.pointer.active).toBe(true);
  });

  test("restores pointer when promote config write fails", () => {
    const root = tempProject();
    const recordsPath = writeExpansionRecords(root);
    const imported = JSON.parse(runQmd(root, [
      "dspy",
      "import-expansion-records",
      "--records",
      recordsPath,
      "--graph-vault",
      "graph_vault",
    ]));
    const report = JSON.parse(runQmd(root, [
      "dspy",
      "evaluate-expansion-policy",
      "--artifact",
      imported.artifactPath,
      "--graph-vault",
      "graph_vault",
    ]));

    const failed = qmdProcess(root, [
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
    const status = JSON.parse(runQmd(root, [
      "dspy",
      "status",
      "--graph-vault",
      "graph_vault",
    ]));
    expect(status.pointer).toBeNull();
  });

  test("restores pointer when disable config write fails", () => {
    const root = tempProject();
    promoteImportedPolicy(root);

    const failed = qmdProcess(root, [
      "dspy",
      "disable-expansion-policy",
      "--graph-vault",
      "graph_vault",
    ], { QMD_TEST_FAIL_DSPY_CONFIG_WRITE: "1" });

    expect(failed.status).not.toBe(0);
    const status = JSON.parse(runQmd(root, [
      "dspy",
      "status",
      "--graph-vault",
      "graph_vault",
    ]));
    expect(status.pointer.provider).toBe("dspy");
    expect(status.pointer.active).toBe(true);
    expect(readLocalConfig(root).query.expansion_policy.provider).toBe("dspy");
  });

  test("restores pointer when rollback config write fails", () => {
    const root = tempProject();
    promoteImportedPolicy(root);
    runQmd(root, [
      "dspy",
      "disable-expansion-policy",
      "--graph-vault",
      "graph_vault",
    ]);
    expect(readLocalConfig(root).query.expansion_policy.provider).toBe("builtin");

    const failed = qmdProcess(root, [
      "dspy",
      "rollback-expansion-policy",
      "--graph-vault",
      "graph_vault",
    ], { QMD_TEST_FAIL_DSPY_CONFIG_WRITE: "1" });

    expect(failed.status).not.toBe(0);
    const status = JSON.parse(runQmd(root, [
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
