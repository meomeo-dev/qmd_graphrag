#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../..", import.meta.url));
const defaultSource = join(
  root,
  "inbox",
  "软件工程与系统设计经典著作指南",
  "A Philosophy of Software Design (John K. Ousterhout).epub",
);
const defaultNormalized = join(
  root,
  "graph_vault",
  "input",
  "a-philosophy-of-software-design.md",
);

const { values } = parseArgs({
  options: {
    "source-path": { type: "string", default: defaultSource },
    "normalized-path": { type: "string", default: defaultNormalized },
    "state-root": { type: "string", default: join(root, "graph_vault") },
    "qmd-index-path": { type: "string", default: join(root, ".qmd", "index.sqlite") },
    config: { type: "string", default: join(root, ".qmd", "index.yml") },
    "python-bin": {
      type: "string",
      default: join(root, ".venv-graphrag", "bin", "python"),
    },
    query: {
      type: "string",
      default: "According to A Philosophy of Software Design, what is deep module design and why does it matter?",
    },
    graph: { type: "boolean", default: false },
    mutating: { type: "boolean", default: false },
    "skip-dotenv": { type: "boolean", default: false },
  },
});

function loadDotenv() {
  if (values["skip-dotenv"]) return;
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const separator = body.indexOf("=");
    if (separator <= 0) continue;
    const key = body.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || process.env[key] != null) {
      continue;
    }
    let value = body.slice(separator + 1).trim();
    const quote = value[0];
    if (
      (quote === "\"" || quote === "'") &&
      value.endsWith(quote) &&
      value.length >= 2
    ) {
      value = value.slice(1, -1);
    } else {
      const commentIndex = value.search(/\s#/u);
      if (commentIndex >= 0) value = value.slice(0, commentIndex).trimEnd();
    }
    process.env[key] = value;
  }
}

function run(label, command, args, options = {}) {
  console.log(`==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.status !== 0) {
    console.error(`Smoke task failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

function requirePath(path, label) {
  if (!existsSync(path)) {
    console.error(`Smoke precondition failed: missing ${label} (${path})`);
    process.exit(1);
  }
}

function qmd(args, extraEnv = {}) {
  run("qmd " + args.join(" "), process.execPath, [
    "--import",
    "tsx",
    "src/cli/qmd.ts",
    ...args,
  ], {
    env: {
      QMD_DOCTOR_DEVICE_PROBE: "0",
      ...extraEnv,
    },
  });
}

loadDotenv();

const sourcePath = resolve(String(values["source-path"]));
const normalizedPath = resolve(String(values["normalized-path"]));
const stateRoot = resolve(String(values["state-root"]));
const qmdIndexPath = resolve(String(values["qmd-index-path"]));
const configPath = resolve(String(values.config));
const pythonBin = resolve(String(values["python-bin"]));
const query = String(values.query);

requirePath(configPath, "qmd config");
requirePath(stateRoot, "graph vault");
requirePath(sourcePath, "source EPUB");
requirePath(normalizedPath, "normalized markdown");

qmd(["--version"]);
qmd(["status"]);
qmd(["doctor"]);
qmd(["ls", "books"]);
qmd(["search", "--json", "deep module"]);
qmd(["query", "--json", query]);
qmd(["query", "--mode", "auto", "--json", query]);
qmd(["vsearch", "--json", "deep module"]);
qmd(["get", `qmd://books/${basename(normalizedPath)}`, "-l", "5"]);
qmd(["multi-get", "books/*.md", "-l", "1", "--json"]);
qmd(["collection", "list"]);
qmd(["context", "list"]);
qmd(["skills", "list", "--json"]);
qmd(["skill", "show"]);
qmd(["dspy", "status", "--json"]);

if (values.mutating) {
  qmd(["update"]);
  qmd(["embed", "--max-docs-per-batch", "1"]);
}

if (values.graph) {
  requirePath(pythonBin, "GraphRAG Python");
  run("GraphRAG book resume/query", process.execPath, [
    "--import",
    "tsx",
    "scripts/graphrag/resume-book-workspace.mjs",
    "--state-root",
    stateRoot,
    "--source-path",
    sourcePath,
    "--normalized-path",
    normalizedPath,
    "--qmd-index-path",
    qmdIndexPath,
    "--config",
    configPath,
    "--python-bin",
    pythonBin,
    "--working-directory",
    root,
    "--query",
    query,
    "--query-method",
    "local",
  ]);
  qmd(["query", "--graphrag", "--json", query]);
}

console.log("Smoke workflow completed.");
