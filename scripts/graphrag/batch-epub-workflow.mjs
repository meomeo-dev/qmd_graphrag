#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import YAML from "yaml";
import { z } from "zod";

const root = fileURLToPath(new URL("../..", import.meta.url));
const defaultSourceDir = join(root, "inbox", "软件工程与系统设计经典著作指南");
const timestamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);

const { values } = parseArgs({
  options: {
    "source-dir": { type: "string", default: defaultSourceDir },
    "state-root": { type: "string", default: join(root, "graph_vault") },
    "qmd-index-path": { type: "string", default: join(root, ".qmd", "index.sqlite") },
    config: { type: "string", default: join(root, ".qmd", "index.yml") },
    "python-bin": {
      type: "string",
      default: join(root, ".venv-graphrag", "bin", "python"),
    },
    "run-id": { type: "string", default: `epub-batch-${timestamp}` },
    "log-root": { type: "string", default: join("/tmp", `qmd-epub-batch-${timestamp}`) },
    query: {
      type: "string",
      default: "How does this book explain software design complexity?",
    },
    "max-command-attempts": { type: "string", default: "3" },
    "completed-manifest": { type: "string" },
    "skip-dotenv": { type: "boolean", default: false },
    "fail-fast": { type: "boolean", default: false },
    verbose: { type: "boolean", default: true },
  },
});

const SchemaVersion = "1.0.0";
const sourceDir = resolve(String(values["source-dir"]));
const stateRoot = resolve(String(values["state-root"]));
const qmdIndexPath = resolve(String(values["qmd-index-path"]));
const configPath = resolve(String(values.config));
const pythonBin = resolve(String(values["python-bin"]));
const runId = String(values["run-id"]);
const logRoot = resolve(String(values["log-root"]));
const query = String(values.query);
const completedManifestPath = values["completed-manifest"]
  ? resolve(String(values["completed-manifest"]))
  : null;
const maxCommandAttempts = Math.max(
  1,
  Number.parseInt(String(values["max-command-attempts"]), 10) || 3,
);
const failFast = Boolean(values["fail-fast"]);

const batchRoot = join(stateRoot, "catalog", "batch-runs", runId);
const itemRoot = join(batchRoot, "items");
const eventsPath = join(batchRoot, "events.jsonl");
const manifestPath = join(batchRoot, "manifest.json");
const requiredCommandCheckNames = [
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
const expectedCommandCheckCount = requiredCommandCheckNames.length;

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const JsonValueSchema = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
const BatchItemStatusSchema = z.enum([
  "pending",
  "running",
  "skipped",
  "completed",
  "failed",
]);
const BatchRunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "incomplete",
]);
const BatchFailureKindSchema = z.enum([
  "transient",
  "permanent",
  "unknown",
]);
const BatchRecoveryDecisionSchema = z.enum([
  "none",
  "retry_same_run_id",
  "continue_pending",
  "stop_until_fixed",
]);
const BatchCommandCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["passed", "failed"]),
  attempts: z.number().int().positive(),
  exitCode: z.number().int().nullable(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  attemptExhausted: z.boolean().optional(),
  providerStatusCode: z.number().int().positive().optional(),
  errorSummary: z.string().max(1000).optional(),
});
const BatchItemCheckpointSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  itemId: z.string().min(1),
  runId: z.string().min(1),
  status: BatchItemStatusSchema,
  sourceName: z.string().min(1),
  sourceRelativePath: z.string().min(1),
  sourceHash: z.string().min(1),
  normalizedPath: z.string().min(1),
  bookId: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  expectedCommandCheckCount: z.number().int().positive().optional(),
  maxCommandAttempts: z.number().int().positive().optional(),
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryExhausted: z.boolean().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  failedStage: z.string().min(1).optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  failedAt: z.string().datetime().optional(),
  errorSummary: z.string().max(1000).optional(),
  commandChecks: z.array(BatchCommandCheckSchema).default([]),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});
const BatchRunManifestSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  status: BatchRunStatusSchema,
  sourceRootName: z.string().min(1),
  stateRootLocator: z.string().min(1),
  qmdIndexLocator: z.string().min(1),
  configLocator: z.string().min(1),
  totalItems: z.number().int().nonnegative(),
  pendingItems: z.number().int().nonnegative().default(0),
  runningItems: z.number().int().nonnegative().default(0),
  completedItems: z.number().int().nonnegative(),
  skippedItems: z.number().int().nonnegative().default(0),
  importedCompletedItems: z.number().int().nonnegative().default(0),
  failedItems: z.number().int().nonnegative(),
  expectedCommandCheckCount: z.number().int().positive().optional(),
  maxCommandAttempts: z.number().int().positive().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  failedAt: z.string().datetime().optional(),
  itemIds: z.array(z.string().min(1)),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});
const BatchEventLogSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  runId: z.string().min(1),
  itemId: z.string().min(1).optional(),
  event: z.string().min(1),
  status: BatchItemStatusSchema.optional(),
  command: z.string().min(1).optional(),
  failureKind: BatchFailureKindSchema.optional(),
  retryable: z.boolean().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  attemptExhausted: z.boolean().optional(),
  providerStatusCode: z.number().int().positive().optional(),
  recoveryDecision: BatchRecoveryDecisionSchema.optional(),
  failedStage: z.string().min(1).optional(),
  at: z.string().datetime(),
  message: z.string().max(1000).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

function now() {
  return new Date().toISOString();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function slugify(name) {
  return name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-")
    .slice(0, 72)
    .replace(/^-|-$/g, "") || "book";
}

function redacted(message) {
  return redactExactEnvValues(String(message))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(OPENAI_API_KEY|JINA_API_KEY)=\S+/g, "$1=[REDACTED]")
    .replace(/(OPENAI_BASE_URL|JINA_API_BASE)=\S+/g, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
    .slice(0, 1000);
}

function redactLog(text) {
  return redactExactEnvValues(String(text))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(OPENAI_API_KEY|JINA_API_KEY)=\S+/g, "$1=[REDACTED]")
    .replace(/(OPENAI_BASE_URL|JINA_API_BASE)=\S+/g, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]");
}

function redactExactEnvValues(text) {
  let output = String(text);
  const secrets = Object.keys(process.env)
    .filter((key) =>
      /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|BASE_URL|API_BASE)/iu.test(key),
    )
    .map((key) => ({ key, value: process.env[key] }))
    .filter((item) => item.value && item.value.length >= 4)
    .sort((a, b) => b.value.length - a.value.length);
  for (const { key, value } of secrets) {
    output = output.split(value).join(`[REDACTED:${key}]`);
  }
  return output;
}

function classifyFailure(text) {
  const message = String(text).toLowerCase();
  const statusCodeMatch = message.match(
    /(?:status|code|error code)[:\s-]*([45]\d\d)|\(([45]\d\d)\)/iu,
  );
  const providerStatusCode = statusCodeMatch
    ? Number.parseInt(statusCodeMatch[1] ?? statusCodeMatch[2], 10)
    : undefined;
  const retryAfterMatch = message.match(/retry-after[:\s-]*(\d+)/iu);
  const retryAfterSeconds = retryAfterMatch
    ? Number.parseInt(retryAfterMatch[1], 10)
    : undefined;
  if (
    providerStatusCode === 400 ||
    providerStatusCode === 401 ||
    providerStatusCode === 403 ||
    providerStatusCode === 404 ||
    providerStatusCode === 422
  ) {
    return {
      failureKind: "permanent",
      retryable: false,
      providerStatusCode,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  if (
    providerStatusCode === 429 ||
    providerStatusCode === 500 ||
    providerStatusCode === 502 ||
    providerStatusCode === 503 ||
    providerStatusCode === 504
  ) {
    return {
      failureKind: "transient",
      retryable: true,
      providerStatusCode,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  const transient =
    message.includes("concurrency limit") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable") ||
    message.includes("timeout") ||
    message.includes("(429)") ||
    message.includes("(500)") ||
    message.includes("(502)") ||
    message.includes("(503)") ||
    message.includes("(504)") ||
    message.includes("status 429") ||
    message.includes("status 500") ||
    message.includes("status 502") ||
    message.includes("status 503") ||
    message.includes("status 504");
  if (transient) {
    return {
      failureKind: "transient",
      retryable: true,
      ...(providerStatusCode ? { providerStatusCode } : {}),
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  return {
    failureKind: "unknown",
    retryable: false,
    ...(providerStatusCode ? { providerStatusCode } : {}),
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureDirs() {
  mkdirSync(stateRoot, { recursive: true });
  const relativeLogRoot = relative(stateRoot, logRoot);
  const isInsideStateRoot =
    relativeLogRoot === "" ||
    (!relativeLogRoot.startsWith(`..${sep}`) &&
      relativeLogRoot !== ".." &&
      !isAbsolute(relativeLogRoot));
  if (isInsideStateRoot) {
    throw new Error("--log-root must be outside graph_vault");
  }
  mkdirSync(logRoot, { recursive: true });
  const realStateRoot = realpathSync(stateRoot);
  const realLogRoot = realpathSync(logRoot);
  const relativeRealLogRoot = relative(realStateRoot, realLogRoot);
  const isReallyInsideStateRoot =
    relativeRealLogRoot === "" ||
    (!relativeRealLogRoot.startsWith(`..${sep}`) &&
      relativeRealLogRoot !== ".." &&
      !isAbsolute(relativeRealLogRoot));
  if (isReallyInsideStateRoot) {
    throw new Error("--log-root must be outside graph_vault");
  }
  mkdirSync(batchRoot, { recursive: true });
  mkdirSync(itemRoot, { recursive: true });
  mkdirSync(join(stateRoot, "input"), { recursive: true });
}

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

function event(payload) {
  const item = BatchEventLogSchema.parse({
    schemaVersion: SchemaVersion,
    runId,
    at: now(),
    ...payload,
  });
  writeFileSync(eventsPath, JSON.stringify(item) + "\n", {
    flag: "a",
    encoding: "utf8",
  });
  if (values.verbose) {
    const parts = [item.event, item.itemId, item.command, item.status]
      .filter(Boolean)
      .join(" ");
    process.stdout.write(`${parts}\n`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeTypedJson(path, schema, value) {
  const parsed = schema.parse(value);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return parsed;
}

function loadCatalogBySourceHash() {
  const catalogPath = join(stateRoot, "catalog", "books.yaml");
  if (!existsSync(catalogPath)) return new Map();
  const catalog = YAML.parse(readFileSync(catalogPath, "utf8")) ?? {};
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  return new Map(items
    .filter((item) => typeof item.sourceHash === "string")
    .map((item) => [item.sourceHash, item]));
}

function normalizedPathFor(sourcePath, sourceHash, catalogByHash) {
  const catalogItem = catalogByHash.get(sourceHash);
  if (typeof catalogItem?.normalizedPath === "string") {
    return join(stateRoot, catalogItem.normalizedPath);
  }
  const stem = basename(sourcePath, ".epub");
  return join(stateRoot, "input", `${slugify(stem)}-${sourceHash.slice(0, 10)}.md`);
}

function loadCompletedSeed() {
  if (completedManifestPath == null || !existsSync(completedManifestPath)) {
    return new Map();
  }
  const raw = readJson(completedManifestPath);
  if (!Array.isArray(raw)) {
    throw new Error(`completed manifest must be an array: ${completedManifestPath}`);
  }
  return new Map(raw
    .filter((item) => typeof item.source === "string")
    .map((item) => [item.source, item]));
}

function itemIdFor(sourceHash, sourceRelativePath) {
  return `item-${sourceHash.slice(0, 12)}-${sha256Text(sourceRelativePath).slice(0, 8)}`;
}

function defaultBookIdFor(sourceHash) {
  return `book-${sourceHash.slice(0, 12)}`;
}

function discoverItems() {
  const catalogByHash = loadCatalogBySourceHash();
  return readdirSync(sourceDir)
    .filter((name) => name.toLowerCase().endsWith(".epub"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const sourcePath = join(sourceDir, name);
      const sourceHash = sha256File(sourcePath);
      const catalogItem = catalogByHash.get(sourceHash);
      const normalizedPath = normalizedPathFor(sourcePath, sourceHash, catalogByHash);
      const sourceRelativePath = relative(root, sourcePath);
      return {
        itemId: itemIdFor(sourceHash, sourceRelativePath),
        sourceName: name,
        sourcePath,
        sourceHash,
        normalizedPath,
        normalizedRel: relative(root, normalizedPath),
        sourceRelativePath,
        bookId: typeof catalogItem?.bookId === "string"
          ? catalogItem.bookId
          : defaultBookIdFor(sourceHash),
      };
    });
}

function makeManifest(items) {
  return {
    schemaVersion: SchemaVersion,
    runId,
    status: "running",
    sourceRootName: basename(sourceDir),
    stateRootLocator: relative(root, stateRoot),
    qmdIndexLocator: relative(root, qmdIndexPath),
    configLocator: relative(root, configPath),
    totalItems: items.length,
    pendingItems: items.length,
    runningItems: 0,
    completedItems: 0,
    skippedItems: 0,
    importedCompletedItems: 0,
    failedItems: 0,
    expectedCommandCheckCount,
    maxCommandAttempts,
    startedAt: now(),
    updatedAt: now(),
    itemIds: items.map((item) => item.itemId),
    metadata: {
      logRootName: basename(logRoot),
    },
  };
}

function loadManifest(items) {
  if (existsSync(manifestPath)) {
    return BatchRunManifestSchema.parse(readJson(manifestPath));
  }
  const manifest = makeManifest(items);
  return writeTypedJson(manifestPath, BatchRunManifestSchema, manifest);
}

function itemPath(item) {
  return join(itemRoot, `${item.itemId}.json`);
}

function defaultCheckpoint(item, completedSeed = new Map()) {
  const seed = completedSeed.get(item.sourceName);
  const seedHash = typeof seed?.sourceHash === "string" ? seed.sourceHash : undefined;
  const shouldSkip = seed && (seedHash == null || seedHash === item.sourceHash);
  if (shouldSkip) {
    return {
      schemaVersion: SchemaVersion,
      itemId: item.itemId,
      runId,
      status: "skipped",
      sourceName: item.sourceName,
      sourceRelativePath: item.sourceRelativePath,
      sourceHash: item.sourceHash,
      normalizedPath: item.normalizedRel,
      bookId: item.bookId,
      attempts: 0,
      expectedCommandCheckCount,
      maxCommandAttempts,
      recoveryDecision: "none",
      commandChecks: [],
      metadata: {
        seededFromCompletedManifest: basename(completedManifestPath),
        seedMatchMode: seedHash == null ? "source_name_only" : "source_name_and_hash",
      },
    };
  }
  return {
    schemaVersion: SchemaVersion,
    itemId: item.itemId,
    runId,
    status: "pending",
    sourceName: item.sourceName,
    sourceRelativePath: item.sourceRelativePath,
    sourceHash: item.sourceHash,
    normalizedPath: item.normalizedRel,
    bookId: item.bookId,
    attempts: 0,
    expectedCommandCheckCount,
    maxCommandAttempts,
    recoveryDecision: "none",
    commandChecks: [],
  };
}

function hydrateCheckpoint(item, checkpoint) {
  const failureText = [
    checkpoint.errorSummary,
    ...(checkpoint.commandChecks ?? []).map((check) => check.errorSummary),
  ].filter(Boolean).join("\n");
  const inferredFailure = checkpoint.status === "failed"
    ? classifyFailure(failureText)
    : null;
  return {
    ...checkpoint,
    sourceHash: checkpoint.sourceHash ?? item.sourceHash,
    bookId: checkpoint.bookId ?? item.bookId ?? defaultBookIdFor(item.sourceHash),
    expectedCommandCheckCount:
      checkpoint.expectedCommandCheckCount ?? expectedCommandCheckCount,
    maxCommandAttempts: checkpoint.maxCommandAttempts ?? maxCommandAttempts,
    failureKind: checkpoint.failureKind ?? inferredFailure?.failureKind,
    retryable: checkpoint.retryable ?? inferredFailure?.retryable,
    retryExhausted: checkpoint.retryExhausted ??
      (checkpoint.status === "failed" ? true : undefined),
    recoveryDecision: checkpoint.recoveryDecision ??
      (inferredFailure?.retryable ? "retry_same_run_id" : "none"),
  };
}

function loadCheckpoint(item, completedSeed) {
  const path = itemPath(item);
  if (!existsSync(path)) {
    const checkpoint = defaultCheckpoint(item, completedSeed);
    return writeTypedJson(path, BatchItemCheckpointSchema, checkpoint);
  }
  const checkpoint = hydrateCheckpoint(item, readJson(path));
  return BatchItemCheckpointSchema.parse(checkpoint);
}

function saveCheckpoint(item, checkpoint) {
  return writeTypedJson(itemPath(item), BatchItemCheckpointSchema, checkpoint);
}

function updateManifest(manifest, checkpoints) {
  const pending = checkpoints.filter((item) => item.status === "pending").length;
  const running = checkpoints.filter((item) => item.status === "running").length;
  const completed = checkpoints.filter((item) => item.status === "completed").length;
  const skipped = checkpoints.filter((item) => item.status === "skipped").length;
  const failed = checkpoints.filter((item) => item.status === "failed").length;
  manifest.pendingItems = pending;
  manifest.runningItems = running;
  manifest.completedItems = completed;
  manifest.skippedItems = skipped;
  manifest.importedCompletedItems = skipped;
  manifest.failedItems = failed;
  manifest.expectedCommandCheckCount = expectedCommandCheckCount;
  manifest.maxCommandAttempts = maxCommandAttempts;
  manifest.updatedAt = now();
  if (failed > 0) {
    manifest.status = "failed";
    manifest.failedAt = manifest.failedAt ?? now();
    delete manifest.completedAt;
  } else if (completed === manifest.totalItems) {
    manifest.status = "completed";
    manifest.completedAt = manifest.completedAt ?? now();
    delete manifest.failedAt;
  } else if (pending === 0 && running === 0) {
    manifest.status = "incomplete";
    delete manifest.completedAt;
    delete manifest.failedAt;
  } else {
    manifest.status = "running";
    delete manifest.completedAt;
    delete manifest.failedAt;
  }
  return writeTypedJson(manifestPath, BatchRunManifestSchema, manifest);
}

function recoveryDecisionForBatch(checkpoints) {
  if (checkpoints.some((item) => item.status === "failed" && item.retryable === true)) {
    return "retry_same_run_id";
  }
  if (checkpoints.some((item) => item.status === "pending" || item.status === "running")) {
    return "continue_pending";
  }
  if (checkpoints.some((item) => item.status === "failed")) {
    return "stop_until_fixed";
  }
  return "none";
}

function qmdRunner() {
  return { command: join(root, "bin", "qmd"), args: [] };
}

function resumeRunnerArgs() {
  const scriptPath = join(root, "scripts", "graphrag", "resume-book-workspace.mjs");
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const useSourceRuntime = existsSync(join(root, ".git")) && existsSync(tsxCli);
  return useSourceRuntime
    ? ["--import", "tsx", scriptPath]
    : [scriptPath];
}

function runCommand(item, name, command, args, options = {}) {
  const attempts = options.attempts ?? 1;
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = now();
    event({
      itemId: item.itemId,
      event: "command_start",
      command: name,
      metadata: { attempt },
    });
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
      shell: process.platform === "win32",
      env: {
        ...process.env,
        INDEX_PATH: qmdIndexPath,
        QMD_CONFIG_DIR: dirname(configPath),
        QMD_GRAPH_VAULT: stateRoot,
        QMD_DOCTOR_DEVICE_PROBE: "0",
        ...(options.env ?? {}),
      },
    });
    const completedAt = now();
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    writeFileSync(join(logRoot, `${item.itemId}-${name}.out`), redactLog(stdout));
    writeFileSync(join(logRoot, `${item.itemId}-${name}.err`), redactLog(stderr));
    const failureText = stderr || stdout || result.error?.message || "";
    const failure = result.status === 0 ? null : classifyFailure(failureText);
    const check = {
      name,
      status: result.status === 0 ? "passed" : "failed",
      attempts: attempt,
      exitCode: result.status,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      startedAt,
      completedAt,
      ...(result.status === 0
        ? {}
        : {
            ...failure,
            attemptExhausted: attempt >= attempts || !failure?.retryable,
            errorSummary: redacted(failureText),
          }),
    };
    last = { check, stdout, stderr, result };
    if (result.status === 0) {
      event({ itemId: item.itemId, event: "command_ok", command: name });
      return last;
    }
    event({
      itemId: item.itemId,
      event: "command_failed",
      command: name,
      message: check.errorSummary,
      failureKind: check.failureKind,
      retryable: check.retryable,
      retryAfterSeconds: check.retryAfterSeconds,
      attemptExhausted: check.attemptExhausted,
      providerStatusCode: check.providerStatusCode,
      metadata: { attempt, exitCode: result.status },
    });
    if (attempt >= attempts || !check.retryable) break;
    const delayMs = Math.max(
      (check.retryAfterSeconds ?? 0) * 1000,
      1000 * 2 ** (attempt - 1),
    );
    event({
      itemId: item.itemId,
      event: "command_retry_scheduled",
      command: name,
      failureKind: check.failureKind,
      retryable: check.retryable,
      retryAfterSeconds: check.retryAfterSeconds,
      recoveryDecision: "retry_same_run_id",
      metadata: { attempt, nextAttempt: attempt + 1, delayMs },
    });
    sleep(delayMs);
  }
  const summary = last?.check?.errorSummary ?? `${name} failed`;
  if (last?.check?.status === "failed") {
    event({
      itemId: item.itemId,
      event: "command_retry_exhausted",
      command: name,
      failureKind: last.check.failureKind,
      retryable: last.check.retryable,
      retryAfterSeconds: last.check.retryAfterSeconds,
      attemptExhausted: true,
      providerStatusCode: last.check.providerStatusCode,
      recoveryDecision: last.check.retryable ? "retry_same_run_id" : "stop_until_fixed",
      message: last.check.errorSummary,
    });
  }
  throw Object.assign(new Error(summary), { commandCheck: last?.check });
}

function qmd(item, name, args, attempts = 1) {
  const runner = qmdRunner();
  return runCommand(item, name, runner.command, [...runner.args, ...args], {
    attempts,
  });
}

function parseResumeOutput(stdout) {
  const text = stdout.trim();
  if (!text) throw new Error("resume-book produced empty stdout");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("\n{");
    if (start >= 0) return JSON.parse(text.slice(start + 1));
    throw new Error("resume-book stdout did not contain a JSON object");
  }
}

function requirePath(path, label) {
  if (!existsSync(path)) {
    throw new Error(`missing ${label}: ${path}`);
  }
}

function normalizeEpubToMarkdown(item) {
  if (existsSync(item.normalizedPath)) return;
  mkdirSync(dirname(item.normalizedPath), { recursive: true });
  const script = String.raw`
import html
import posixpath
import re
import sys
import zipfile
from html.parser import HTMLParser
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

source_path, output_path = sys.argv[1:3]

class MarkdownExtractor(HTMLParser):
    block_tags = {
        "address", "article", "aside", "blockquote", "br", "dd", "div", "dl",
        "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5",
        "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
        "table", "tr", "ul",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.stack = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        self.stack.append(tag)
        if tag in {"script", "style", "noscript"}:
            self.skip += 1
            return
        if tag in self.block_tags:
            self.parts.append("\n")
        if tag == "li":
            self.parts.append("- ")
        if re.fullmatch(r"h[1-6]", tag):
            self.parts.append("#" * int(tag[1]) + " ")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in {"script", "style", "noscript"} and self.skip:
            self.skip -= 1
        if tag in self.block_tags:
            self.parts.append("\n")
        if self.stack:
            self.stack.pop()

    def handle_data(self, data):
        if self.skip:
            return
        text = re.sub(r"\s+", " ", html.unescape(data)).strip()
        if text:
            self.parts.append(text + " ")

    def markdown(self):
        text = "".join(self.parts)
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip() + "\n"

def xml_text(root, xpath, ns):
    item = root.find(xpath, ns)
    if item is None or item.text is None:
        raise ValueError(f"missing EPUB metadata: {xpath}")
    return item.text

def read_epub_html(zf):
    container = ET.fromstring(zf.read("META-INF/container.xml"))
    ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
    opf_path = container.find(".//c:rootfile", ns).attrib["full-path"]
    opf_dir = str(PurePosixPath(opf_path).parent)
    if opf_dir == ".":
        opf_dir = ""
    package = ET.fromstring(zf.read(opf_path))
    ns = {"opf": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
    title = xml_text(package, ".//dc:title", ns)
    manifest = {
        item.attrib["id"]: item.attrib
        for item in package.findall(".//opf:manifest/opf:item", ns)
        if "id" in item.attrib and "href" in item.attrib
    }
    output = [f"# {title}\n"]
    for itemref in package.findall(".//opf:spine/opf:itemref", ns):
        item = manifest.get(itemref.attrib.get("idref", ""))
        if not item:
            continue
        media_type = item.get("media-type", "")
        if "html" not in media_type and "xhtml" not in media_type:
            continue
        href = posixpath.normpath(posixpath.join(opf_dir, item["href"]))
        data = zf.read(href)
        parser = MarkdownExtractor()
        parser.feed(data.decode("utf-8", errors="replace"))
        section = parser.markdown()
        if section:
            output.append(section)
    return "\n\n".join(output)

with zipfile.ZipFile(source_path) as zf:
    markdown = read_epub_html(zf)

with open(output_path, "w", encoding="utf-8") as handle:
    handle.write(markdown)
`;
  runCommand(item, "normalize-epub", pythonBin, [
    "-c",
    script,
    item.sourcePath,
    item.normalizedPath,
  ]);
}

function runGraphResume(item) {
  requirePath(pythonBin, "GraphRAG Python");
  const maxResumePasses = 8;
  let lastResult = null;
  for (let pass = 1; pass <= maxResumePasses; pass += 1) {
    const result = runCommand(item, `resume-book-${pass}`, process.execPath, [
      ...resumeRunnerArgs(),
      "--state-root",
      stateRoot,
      "--source-path",
      item.sourcePath,
      "--normalized-path",
      item.normalizedPath,
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
    ], { attempts: maxCommandAttempts });
    lastResult = result;

    let resume;
    try {
      resume = parseResumeOutput(result.stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(message), { commandCheck: result.check });
    }
    event({
      itemId: item.itemId,
      event: "resume_pass_completed",
      status: resume.status === "ready" ? "completed" : "running",
      metadata: {
        pass,
        resumeStatus: resume.status,
        nextStage: resume.nextStage,
      },
    });
    if (resume.status === "ready" && resume.nextStage == null) return;
  }

  throw Object.assign(
    new Error(`resume-book did not reach ready after ${maxResumePasses} passes`),
    { commandCheck: lastResult?.check },
  );
}

function parseBookIdFromResume(item) {
  for (let pass = 8; pass >= 1; pass -= 1) {
    const path = join(logRoot, `${item.itemId}-resume-book-${pass}.out`);
    if (!existsSync(path)) continue;
    try {
      const parsed = parseResumeOutput(readFileSync(path, "utf8"));
      if (typeof parsed.bookId === "string") return parsed.bookId;
    } catch {
      continue;
    }
  }
  return undefined;
}

function validateCommandChecks(commandChecks) {
  const names = commandChecks.map((check) => check.name);
  const unique = new Set(names);
  const missing = requiredCommandCheckNames.filter((name) => !unique.has(name));
  const unexpected = names.filter((name) => !requiredCommandCheckNames.includes(name));
  const failed = commandChecks.filter((check) => check.status !== "passed");
  if (
    commandChecks.length !== expectedCommandCheckCount ||
    unique.size !== expectedCommandCheckCount ||
    missing.length ||
    unexpected.length ||
    failed.length
  ) {
    throw new Error(
      `invalid command check set: expected=${expectedCommandCheckCount} ` +
      `actual=${commandChecks.length} missing=${missing.join(",") || "none"} ` +
      `unexpected=${unexpected.join(",") || "none"} failed=${failed.length}`,
    );
  }
}

function runCliChecks(item) {
  const checks = [];
  const record = (result) => checks.push(result.check);
  record(qmd(item, "qmd-version", ["--version"]));
  record(qmd(item, "qmd-status", ["status"]));
  record(qmd(item, "qmd-doctor-json", ["doctor", "--json"]));
  record(qmd(item, "qmd-pull", ["pull"]));
  record(qmd(item, "qmd-update", ["update"]));
  record(qmd(item, "qmd-embed", ["embed", "--max-docs-per-batch", "1"], maxCommandAttempts));
  record(qmd(item, "qmd-ls-books", ["ls", "books"]));
  record(qmd(item, "qmd-search-json", ["search", "--json", "software design complexity"]));
  record(qmd(item, "qmd-search-csv", ["search", "--csv", "software design complexity"]));
  record(qmd(item, "qmd-search-md", ["search", "--md", "software design complexity"]));
  record(qmd(item, "qmd-search-xml", ["search", "--xml", "software design complexity"]));
  record(qmd(item, "qmd-search-files", ["search", "--files", "software design complexity"]));
  record(qmd(item, "qmd-vsearch-json", ["vsearch", "--json", "software design complexity"], maxCommandAttempts));
  record(qmd(item, "qmd-query-json", ["query", "--json", query], maxCommandAttempts));
  record(qmd(item, "qmd-query-auto-json", ["query", "--mode", "auto", "--json", query], maxCommandAttempts));
  record(qmd(item, "qmd-query-graphrag-json", ["query", "--graphrag", "--json", query], maxCommandAttempts));
  record(qmd(item, "qmd-get-book", ["get", `qmd://books/${basename(item.normalizedPath)}`, "-l", "5"]));
  record(qmd(item, "qmd-multi-get-json", ["multi-get", "books/*.md", "-l", "1", "--json"]));
  record(qmd(item, "qmd-collection-list", ["collection", "list"]));
  record(qmd(item, "qmd-collection-show-books", ["collection", "show", "books"]));
  record(qmd(item, "qmd-context-list", ["context", "list"]));
  record(qmd(item, "qmd-skills-list-json", ["skills", "list", "--json"]));
  record(qmd(item, "qmd-skills-get-json", ["skills", "get", "qmd", "--json"]));
  record(qmd(item, "qmd-skills-path-json", ["skills", "path", "qmd", "--json"]));
  record(qmd(item, "qmd-skill-show", ["skill", "show"]));
  record(qmd(item, "qmd-dspy-status-json", ["dspy", "status", "--json"]));
  record(qmd(item, "qmd-cleanup", ["cleanup"]));
  validateCommandChecks(checks);
  return checks;
}

function runItem(item, checkpoint) {
  const startedAt = now();
  const running = {
    ...checkpoint,
    status: "running",
    attempts: checkpoint.attempts + 1,
    startedAt: checkpoint.startedAt ?? startedAt,
    failedAt: undefined,
    errorSummary: undefined,
    failureKind: undefined,
    retryable: undefined,
    retryExhausted: undefined,
    recoveryDecision: "none",
    failedStage: undefined,
    expectedCommandCheckCount,
    maxCommandAttempts,
  };
  saveCheckpoint(item, running);
  event({ itemId: item.itemId, event: "item_start", status: "running" });

  normalizeEpubToMarkdown(item);
  runGraphResume(item);
  const commandChecks = runCliChecks(item);
  const completed = {
    ...running,
    status: "completed",
    bookId: parseBookIdFromResume(item) ?? running.bookId,
    completedAt: now(),
    failedAt: undefined,
    errorSummary: undefined,
    failureKind: undefined,
    retryable: undefined,
    retryExhausted: undefined,
    recoveryDecision: "none",
    failedStage: undefined,
    commandChecks,
  };
  saveCheckpoint(item, completed);
  event({ itemId: item.itemId, event: "item_completed", status: "completed" });
  return completed;
}

function main() {
  loadDotenv();
  ensureDirs();
  requirePath(sourceDir, "source directory");
  requirePath(configPath, "qmd config");
  const items = discoverItems();
  if (items.length === 0) {
    throw new Error(`no EPUB files found in ${sourceDir}`);
  }
  let manifest = loadManifest(items);
  const completedSeed = loadCompletedSeed();
  const checkpoints = new Map(items.map((item) => [
    item.itemId,
    loadCheckpoint(item, completedSeed),
  ]));
  manifest = updateManifest(manifest, Array.from(checkpoints.values()));

  for (const item of items) {
    const checkpoint = checkpoints.get(item.itemId);
    if (checkpoint?.status === "completed") {
      event({ itemId: item.itemId, event: "item_skip_completed", status: "completed" });
      continue;
    }
    if (checkpoint?.status === "skipped") {
      event({
        itemId: item.itemId,
        event: "item_skipped",
        status: "skipped",
        metadata: checkpoint.metadata,
      });
      continue;
    }
    if (checkpoint?.status === "failed" && checkpoint.retryable === false) {
      event({
        itemId: item.itemId,
        event: "item_failed_not_retryable",
        status: "failed",
        failureKind: checkpoint.failureKind ?? "unknown",
        retryable: false,
        recoveryDecision: "stop_until_fixed",
        failedStage: checkpoint.failedStage,
        message: checkpoint.errorSummary,
      });
      continue;
    }
    if (checkpoint?.status === "failed" && checkpoint.retryable === true) {
      event({
        itemId: item.itemId,
        event: "item_retry_same_run_id",
        status: "running",
        failureKind: checkpoint.failureKind ?? "transient",
        retryable: true,
        recoveryDecision: "retry_same_run_id",
        failedStage: checkpoint.failedStage,
      });
    }

    try {
      const completed = runItem(item, checkpoint ?? defaultCheckpoint(item, completedSeed));
      checkpoints.set(item.itemId, completed);
      manifest = updateManifest(manifest, Array.from(checkpoints.values()));
    } catch (error) {
      const running = existsSync(itemPath(item))
        ? loadCheckpoint(item, completedSeed)
        : checkpoint ?? defaultCheckpoint(item, completedSeed);
      const commandCheck = error?.commandCheck;
      const failureKind = commandCheck?.failureKind ?? "unknown";
      const retryable = commandCheck?.retryable ?? false;
      const failed = {
        ...running,
        status: "failed",
        failedAt: now(),
        errorSummary: redacted(error instanceof Error ? error.message : String(error)),
        failureKind,
        retryable,
        retryExhausted: Boolean(commandCheck?.attemptExhausted),
        recoveryDecision: retryable ? "retry_same_run_id" : "stop_until_fixed",
        failedStage: commandCheck?.name,
      };
      if (commandCheck) {
        failed.commandChecks = [
          ...(failed.commandChecks ?? []),
          commandCheck,
        ];
      }
      saveCheckpoint(item, failed);
      checkpoints.set(item.itemId, failed);
      manifest = updateManifest(manifest, Array.from(checkpoints.values()));
      event({
        itemId: item.itemId,
        event: "item_failed",
        status: "failed",
        message: failed.errorSummary,
        failureKind: failed.failureKind,
        retryable: failed.retryable,
        attemptExhausted: failed.retryExhausted,
        providerStatusCode: commandCheck?.providerStatusCode,
        retryAfterSeconds: commandCheck?.retryAfterSeconds,
        recoveryDecision: failed.recoveryDecision,
        failedStage: failed.failedStage,
      });
      if (failFast) throw error;
    }
  }

  manifest = updateManifest(manifest, Array.from(checkpoints.values()));
  if (manifest.status === "completed") {
    event({ event: "batch_completed", status: "completed" });
    return;
  }
  const finalCheckpoints = Array.from(checkpoints.values());
  event({
    event: "batch_incomplete",
    recoveryDecision: recoveryDecisionForBatch(finalCheckpoints),
    metadata: {
      pendingItems: manifest.pendingItems,
      runningItems: manifest.runningItems,
      completedItems: manifest.completedItems,
      skippedItems: manifest.skippedItems,
      failedItems: manifest.failedItems,
    },
  });
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(redactLog(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 1;
}
