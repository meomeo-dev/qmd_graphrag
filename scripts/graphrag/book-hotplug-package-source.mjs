import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

function toPosixPath(path) {
  return String(path).split(sep).join("/");
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function bookManifestPath(bookRoot) {
  return join(bookRoot, "BOOK_MANIFEST.json");
}

function distributionManifestPath(bookRoot) {
  return join(bookRoot, "distribution_manifest.json");
}

function qmdBuildManifestPath(bookRoot) {
  return join(bookRoot, "qmd", "qmd_build_manifest.json");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null))];
}

function sourceHashFromBookManifest(manifest) {
  const values = unique([
    nonEmptyString(manifest?.identity?.sourceHash),
    nonEmptyString(manifest?.source?.sourceHash),
  ]);
  if (values.length > 1) {
    throw new Error("BOOK_MANIFEST sourceHash fields disagree");
  }
  return values[0] ?? null;
}

function requireSingleSourceHash(bookRoot, values) {
  const hashes = unique(values);
  if (hashes.length === 1) return hashes[0];
  if (hashes.length > 1) {
    throw new Error(`source hash conflict in package metadata: ${bookRoot}`);
  }
  throw new Error(`source hash not found for ${bookRoot}`);
}

function packageRelativeLocator(bookId, locator) {
  const normalized = toPosixPath(locator);
  for (const prefix of [
    `graph_vault/books/${bookId}/`,
    `books/${bookId}/`,
  ]) {
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  }
  return normalized.replace(/^graph_vault\//u, "");
}

function candidatePackagePaths(bookRoot, bookId, locator) {
  if (typeof locator !== "string" || locator.length === 0) return [];
  const stripped = packageRelativeLocator(bookId, locator);
  const candidates = [];
  if (
    stripped.startsWith("input/") ||
    stripped.startsWith("source/") ||
    stripped.startsWith("qmd/") ||
    stripped.startsWith("graphrag/") ||
    stripped.startsWith("state/") ||
    stripped.startsWith("metadata/")
  ) {
    candidates.push(join(bookRoot, stripped));
  }
  if (stripped.includes("/input/") || stripped.startsWith("input/")) {
    candidates.push(join(bookRoot, "input", basename(stripped)));
  }
  candidates.push(join(bookRoot, stripped));
  return [...new Set(candidates)];
}

function firstReadableFile(paths) {
  for (const path of paths) {
    try {
      const stats = statSync(path);
      if (stats.isFile() && stats.size > 0) return path;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function firstInputMarkdown(bookRoot) {
  const inputRoot = join(bookRoot, "input");
  if (!existsSync(inputRoot)) return null;
  const pending = [inputRoot];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && /\.(md|markdown|txt)$/iu.test(entry.name)) {
        return path;
      }
    }
  }
  return null;
}

export function hotplugSourceHashForBook(bookRoot) {
  const qmdManifest = readJsonIfExists(qmdBuildManifestPath(bookRoot));
  const bookManifest = readJsonIfExists(bookManifestPath(bookRoot));
  const distributionManifest = readJsonIfExists(distributionManifestPath(bookRoot));
  return requireSingleSourceHash(bookRoot, [
    nonEmptyString(qmdManifest?.sourceHash),
    sourceHashFromBookManifest(bookManifest),
    nonEmptyString(distributionManifest?.sourceHash),
  ]);
}

export function hotplugSourceRelativePathForBook(bookRoot) {
  const qmdManifest = readJsonIfExists(qmdBuildManifestPath(bookRoot));
  const bookManifest = readJsonIfExists(bookManifestPath(bookRoot));
  const distributionManifest = readJsonIfExists(distributionManifestPath(bookRoot));
  const value = nonEmptyString(qmdManifest?.sourceRelativePath) ??
    nonEmptyString(bookManifest?.source?.sourcePath) ??
    nonEmptyString(distributionManifest?.sourceRelativePath);
  if (value == null) throw new Error(`source relative path not found for ${bookRoot}`);
  return value;
}

export function hotplugNormalizedPathForBook(bookRoot, bookId) {
  const qmdManifest = readJsonIfExists(qmdBuildManifestPath(bookRoot));
  const bookManifest = readJsonIfExists(bookManifestPath(bookRoot));
  const locators = [
    qmdManifest?.canonicalBookNormalizedPath,
    qmdManifest?.normalizedPath,
    bookManifest?.input?.canonicalNormalizedPath,
  ];
  for (const locator of locators) {
    const match = firstReadableFile(candidatePackagePaths(bookRoot, bookId, locator));
    if (match != null) return match;
  }
  const fallback = firstInputMarkdown(bookRoot);
  if (fallback != null) return fallback;
  throw new Error(`normalized path not found for ${bookRoot}`);
}
