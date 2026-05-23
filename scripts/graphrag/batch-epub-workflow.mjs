#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import YAML from "yaml";

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

const batchRoot = join(stateRoot, "catalog", "batch-runs", runId);
const itemRoot = join(batchRoot, "items");
const eventsPath = join(batchRoot, "events.jsonl");
const manifestPath = join(batchRoot, "manifest.json");

function now() {
  return new Date().toISOString();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
  return String(message)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(OPENAI_API_KEY|JINA_API_KEY)=\S+/g, "$1=[REDACTED]")
    .replace(/(OPENAI_BASE_URL|JINA_API_BASE)=\S+/g, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
    .slice(0, 1000);
}

function redactLog(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(OPENAI_API_KEY|JINA_API_KEY)=\S+/g, "$1=[REDACTED]")
    .replace(/(OPENAI_BASE_URL|JINA_API_BASE)=\S+/g, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]");
}

function isTransient(text) {
  const message = String(text).toLowerCase();
  return (
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
    message.includes("status 504")
  );
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureDirs() {
  const relativeLogRoot = relative(stateRoot, logRoot);
  if (relativeLogRoot === "" || !relativeLogRoot.startsWith("..")) {
    throw new Error("--log-root must be outside graph_vault");
  }
  mkdirSync(batchRoot, { recursive: true });
  mkdirSync(itemRoot, { recursive: true });
  mkdirSync(logRoot, { recursive: true });
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
  const item = {
    schemaVersion: SchemaVersion,
    runId,
    at: now(),
    ...payload,
  };
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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
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

function itemIdFor(sourceHash) {
  return `item-${sourceHash.slice(0, 12)}`;
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
      return {
        itemId: itemIdFor(sourceHash),
        sourceName: name,
        sourcePath,
        sourceHash,
        normalizedPath,
        normalizedRel: relative(root, normalizedPath),
        sourceRelativePath: relative(root, sourcePath),
        bookId: typeof catalogItem?.bookId === "string"
          ? catalogItem.bookId
          : undefined,
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
    completedItems: 0,
    failedItems: 0,
    startedAt: now(),
    updatedAt: now(),
    itemIds: items.map((item) => item.itemId),
    metadata: {
      logRootName: basename(logRoot),
    },
  };
}

function loadManifest(items) {
  if (existsSync(manifestPath)) return readJson(manifestPath);
  const manifest = makeManifest(items);
  writeJson(manifestPath, manifest);
  return manifest;
}

function itemPath(item) {
  return join(itemRoot, `${item.itemId}.json`);
}

function defaultCheckpoint(item, completedSeed = new Map()) {
  const seed = completedSeed.get(item.sourceName);
  if (seed) {
    return {
      schemaVersion: SchemaVersion,
      itemId: item.itemId,
      runId,
      status: "completed",
      sourceName: item.sourceName,
      sourceRelativePath: item.sourceRelativePath,
      sourceHash: item.sourceHash,
      normalizedPath: item.normalizedRel,
      bookId: item.bookId,
      attempts: 0,
      completedAt: now(),
      commandChecks: [],
      metadata: {
        seededFromCompletedManifest: basename(completedManifestPath),
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
    commandChecks: [],
  };
}

function loadCheckpoint(item, completedSeed) {
  const path = itemPath(item);
  if (!existsSync(path)) {
    const checkpoint = defaultCheckpoint(item, completedSeed);
    writeJson(path, checkpoint);
    return checkpoint;
  }
  return readJson(path);
}

function saveCheckpoint(item, checkpoint) {
  writeJson(itemPath(item), checkpoint);
}

function updateManifest(manifest, checkpoints) {
  const completed = checkpoints.filter((item) => item.status === "completed").length;
  const failed = checkpoints.filter((item) => item.status === "failed").length;
  manifest.completedItems = completed;
  manifest.failedItems = failed;
  manifest.updatedAt = now();
  if (failed > 0) {
    manifest.status = "failed";
    manifest.failedAt = manifest.failedAt ?? now();
    delete manifest.completedAt;
  } else if (completed === manifest.totalItems) {
    manifest.status = "completed";
    manifest.completedAt = manifest.completedAt ?? now();
    delete manifest.failedAt;
  } else {
    manifest.status = "running";
    delete manifest.completedAt;
    delete manifest.failedAt;
  }
  writeJson(manifestPath, manifest);
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
        : { errorSummary: redacted(stderr || stdout || result.error?.message || "") }),
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
      metadata: { attempt, exitCode: result.status },
    });
    if (attempt >= attempts || !isTransient(`${stderr}\n${stdout}`)) break;
    sleep(1000 * 2 ** (attempt - 1));
  }
  const summary = last?.check?.errorSummary ?? `${name} failed`;
  throw Object.assign(new Error(summary), { commandCheck: last?.check });
}

function qmd(item, name, args, attempts = 1) {
  const runner = qmdRunner();
  return runCommand(item, name, runner.command, [...runner.args, ...args], {
    attempts,
  });
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
  runCommand(item, "resume-book", process.execPath, [
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
}

function parseBookIdFromResume(item) {
  const path = join(logRoot, `${item.itemId}-resume-book.out`);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.bookId === "string" ? parsed.bookId : undefined;
  } catch {
    return undefined;
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
  };
  saveCheckpoint(item, running);
  event({ itemId: item.itemId, event: "item_start", status: "running" });

  normalizeEpubToMarkdown(item);
  runGraphResume(item);
  const commandChecks = runCliChecks(item);
  const completed = {
    ...running,
    status: "completed",
    bookId: parseBookIdFromResume(item),
    completedAt: now(),
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
  const manifest = loadManifest(items);
  const completedSeed = loadCompletedSeed();
  const checkpoints = new Map(items.map((item) => [
    item.itemId,
    loadCheckpoint(item, completedSeed),
  ]));
  updateManifest(manifest, Array.from(checkpoints.values()));

  for (const item of items) {
    const checkpoint = checkpoints.get(item.itemId);
    if (checkpoint?.status === "completed") {
      event({ itemId: item.itemId, event: "item_skip_completed", status: "completed" });
      continue;
    }

    try {
      const completed = runItem(item, checkpoint ?? defaultCheckpoint(item, completedSeed));
      checkpoints.set(item.itemId, completed);
      updateManifest(manifest, Array.from(checkpoints.values()));
    } catch (error) {
      const failed = {
        ...(checkpoints.get(item.itemId) ?? defaultCheckpoint(item, completedSeed)),
        status: "failed",
        failedAt: now(),
        errorSummary: redacted(error instanceof Error ? error.message : String(error)),
      };
      if (error?.commandCheck) {
        failed.commandChecks = [
          ...(failed.commandChecks ?? []),
          error.commandCheck,
        ];
      }
      saveCheckpoint(item, failed);
      checkpoints.set(item.itemId, failed);
      updateManifest(manifest, Array.from(checkpoints.values()));
      event({
        itemId: item.itemId,
        event: "item_failed",
        status: "failed",
        message: failed.errorSummary,
      });
      throw error;
    }
  }

  updateManifest(manifest, Array.from(checkpoints.values()));
  event({ event: "batch_completed", status: "completed" });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
