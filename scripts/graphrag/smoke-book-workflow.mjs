#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
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

function qmdRunner() {
  const binPath = join(root, "bin", "qmd");
  if (existsSync(binPath)) {
    return { command: binPath, args: [] };
  }
  const sourceCli = join(root, "src", "cli", "qmd.ts");
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(sourceCli) && existsSync(tsxCli)) {
    return { command: process.execPath, args: [tsxCli, sourceCli] };
  }
  const distCli = join(root, "dist", "cli", "qmd.js");
  return { command: process.execPath, args: [distCli] };
}

function qmd(args, extraEnv = {}) {
  const runner = qmdRunner();
  run("qmd " + args.join(" "), runner.command, [...runner.args, ...args], {
    env: {
      INDEX_PATH: qmdIndexPath,
      QMD_CONFIG_DIR: dirname(configPath),
      QMD_DOCTOR_DEVICE_PROBE: "0",
      ...extraEnv,
    },
  });
}

function resumeRunnerArgs() {
  const scriptPath = join(root, "scripts", "graphrag", "resume-book-workspace.mjs");
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const useSourceRuntime = existsSync(join(root, ".git")) && existsSync(tsxCli);
  return useSourceRuntime
    ? ["--import", "tsx", scriptPath]
    : [scriptPath];
}

function normalizeEpubToMarkdown() {
  if (existsSync(normalizedPath)) return;
  mkdirSync(dirname(normalizedPath), { recursive: true });
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
  run("normalize EPUB to markdown", pythonBin, [
    "-c",
    script,
    sourcePath,
    normalizedPath,
  ]);
}

function runGraphResume() {
  requirePath(pythonBin, "GraphRAG Python");
  run("GraphRAG book resume/query", process.execPath, [
    ...resumeRunnerArgs(),
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
requirePath(sourcePath, "source EPUB");
mkdirSync(stateRoot, { recursive: true });
normalizeEpubToMarkdown();
requirePath(normalizedPath, "normalized markdown");

if (values.graph) {
  runGraphResume();
}

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
  qmd(["query", "--graphrag", "--json", query]);
}

console.log("Smoke workflow completed.");
