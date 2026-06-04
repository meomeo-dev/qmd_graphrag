import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import YAML from "yaml";

const SchemaVersion = "1.0.0";

const ForbiddenPackagePathPatterns = [
  /^\.env$/u,
  /(?:^|\/)\.env$/u,
  /(?:^|\/)provider-requests(?:\/|$)/u,
  /(?:^|\/)provider-responses(?:\/|$)/u,
  /^(?:graphrag\/output|output)\/reports(?:\/|$)/u,
  /(?:^|\/)logs(?:\/|$)/u,
  /(?:^|\/)debug(?:\/|$)/u,
  /(?:^|\/)trace(?:\/|$)/u,
  /(?:^|\/)\.durable-recovery\.jsonl$/u,
  /\.lock$/u,
  /\.corrupt-[^/]+$/u,
  /(?:^|\/)\.DS_Store$/u,
];

function toPosixPath(path) {
  return String(path).split(sep).join("/");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function nowDefault() {
  return new Date().toISOString();
}

export function isForbiddenHotplugPackagePath(path) {
  const normalized = toPosixPath(path);
  return ForbiddenPackagePathPatterns.some((pattern) => pattern.test(normalized));
}

function listForbiddenFiles(bookRoot) {
  if (!existsSync(bookRoot)) return [];
  const files = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relativePath = toPosixPath(relative(bookRoot, path));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && isForbiddenHotplugPackagePath(relativePath)) {
        files.push(path);
      }
    }
  };
  visit(bookRoot);
  return files;
}

function writeYamlWithSidecars(path, value, rootPath) {
  const text = YAML.stringify(value);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  const checksum = sha256Text(text);
  const targetLocator = toPosixPath(relative(rootPath, path));
  writeFileSync(`${path}.sha256`, `${checksum}\n`, "utf8");
  writeFileSync(
    `${path}.sha256.meta.json`,
    `${JSON.stringify({
      checksum,
      targetLocator,
      checksumPath: `${targetLocator}.sha256`,
      checksumRecoveryDecision: "committed",
      commitState: "committed",
      operationId: `hotplug-quarantine-${sha256Text(path).slice(0, 16)}`,
      runnerSessionId: "book-hotplug-residue-quarantine",
      committedAt: nowDefault(),
    }, null, 2)}\n`,
    "utf8",
  );
}

export function quarantineForbiddenHotplugPackageResidues(input) {
  const stateRoot = resolve(input.stateRoot);
  const bookRoot = join(stateRoot, "books", input.bookId);
  const migrationId = input.migrationId ?? `manual-${nowDefault().replace(/[-:.TZ]/gu, "")}`;
  const quarantineRoot = join(
    stateRoot,
    "catalog",
    "book-package-migrations",
    "quarantine",
    migrationId,
    input.bookId,
  );
  const quarantinedAt = input.now?.() ?? nowDefault();
  const entries = [];
  for (const sourcePath of listForbiddenFiles(bookRoot)) {
    const stats = statSync(sourcePath);
    const relativePath = toPosixPath(relative(bookRoot, sourcePath));
    const targetPath = join(quarantineRoot, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    const sourceSha256 = sha256File(sourcePath);
    renameSync(sourcePath, targetPath);
    entries.push({
      schemaVersion: SchemaVersion,
      bookId: input.bookId,
      reason: "forbidden_sensitive_material",
      sourceLocator: toPosixPath(relative(stateRoot, sourcePath)),
      quarantineLocator: toPosixPath(relative(stateRoot, targetPath)),
      bytes: stats.size,
      sha256: sourceSha256,
      status: "quarantined_without_delete",
      quarantinedAt,
    });
  }
  if (entries.length > 0 || input.writeEmptyReport === true) {
    const reportPath = join(quarantineRoot, "quarantine-report.yaml");
    writeYamlWithSidecars(reportPath, {
      schemaVersion: SchemaVersion,
      migrationId,
      bookId: input.bookId,
      generatedAt: quarantinedAt,
      entries,
    }, stateRoot);
  }
  return {
    bookId: input.bookId,
    migrationId,
    quarantineRoot: toPosixPath(relative(stateRoot, quarantineRoot)),
    count: entries.length,
    entries,
  };
}
