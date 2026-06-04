import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import YAML from "yaml";

import {
  writeHotplugJsonWithSidecars,
} from "./book-hotplug-json-sidecars.mjs";

const SchemaVersion = "1.0.0";

function toPosixPath(path) {
  return String(path).split(sep).join("/");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readJsonOptional(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readYamlOptional(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = YAML.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeIdList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter((item) => item.length > 0);
  }
  if (value == null) return [];
  const item = String(value);
  return item.length === 0 ? [] : [item];
}

function sourceIdFor(sourceHash) {
  return `sha256:${sourceHash}`;
}

function graphIdentitySidecarPath(outputDir) {
  return join(outputDir, "qmd_graph_text_unit_identity.json");
}

function graphOutputManifestPath(outputDir) {
  return join(outputDir, "qmd_output_manifest.json");
}

function sidecarsPresent(path) {
  return existsSync(`${path}.sha256`) && existsSync(`${path}.sha256.meta.json`);
}

function readGraphManifest(bookRoot) {
  return readJsonOptional(graphOutputManifestPath(join(bookRoot, "graphrag", "output")));
}

function readBookJob(stateRoot, bookId, sourceHash) {
  const catalog = readYamlOptional(join(stateRoot, "catalog", "books.yaml"));
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  return items.find((item) =>
    item != null &&
    typeof item === "object" &&
    item.bookId === bookId &&
    item.sourceHash === sourceHash
  ) ?? null;
}

function normalizedPathFrom(input, job) {
  if (
    typeof job?.normalizedPath === "string" &&
    job.normalizedPath.startsWith(`books/${input.bookId}/`)
  ) {
    return job.normalizedPath;
  }
  const absoluteNormalizedPath = input.normalizedPath == null
    ? null
    : resolve(input.normalizedPath);
  const bookInputDir = join(input.bookRoot, "input");
  const basenameCandidate = absoluteNormalizedPath == null
    ? "book.md"
    : basename(absoluteNormalizedPath);
  const bookScopedCandidate = join(bookInputDir, basenameCandidate);
  if (existsSync(bookScopedCandidate)) {
    return `books/${input.bookId}/input/${basenameCandidate}`;
  }
  return `books/${input.bookId}/input/${basenameCandidate}`;
}

function expectedIdentity(input) {
  const graphManifest = input.graphManifest ?? readGraphManifest(input.bookRoot);
  const job = input.job ?? readBookJob(input.stateRoot, input.bookId, input.sourceHash);
  const documentId = graphManifest?.documentId ?? job?.documentId;
  const contentHash = graphManifest?.contentHash ??
    job?.normalizedContentHash ??
    input.normalizedContentHash ??
    input.sourceHash;
  if (typeof documentId !== "string" || documentId.length === 0) {
    return null;
  }
  return {
    bookId: input.bookId,
    sourceId: sourceIdFor(input.sourceHash),
    sourceHash: input.sourceHash,
    documentId,
    contentHash,
    normalizedPath: normalizedPathFrom(input, job),
  };
}

function normalizeIdentity(candidate, expected) {
  if (candidate == null || typeof candidate !== "object" || expected == null) {
    return null;
  }
  const graphTextUnitIds = normalizeIdList(candidate.graphTextUnitIds);
  const graphDocumentId = String(candidate.graphDocumentId ?? "");
  const metadata = candidate.metadata != null &&
      typeof candidate.metadata === "object"
    ? candidate.metadata
    : undefined;
  const normalized = {
    schemaVersion: SchemaVersion,
    bookId: String(candidate.bookId ?? ""),
    sourceId: String(candidate.sourceId ?? ""),
    sourceHash: String(candidate.sourceHash ?? ""),
    documentId: String(candidate.documentId ?? ""),
    contentHash: String(candidate.contentHash ?? ""),
    normalizedPath: expected.normalizedPath,
    graphDocumentId,
    graphTextUnitIds,
    ...(metadata == null ? {} : { metadata }),
  };
  const matchesExpected =
    normalized.bookId === expected.bookId &&
    normalized.sourceId === expected.sourceId &&
    normalized.sourceHash === expected.sourceHash &&
    normalized.documentId === expected.documentId &&
    normalized.contentHash === expected.contentHash &&
    normalized.graphDocumentId.length > 0 &&
    normalized.graphTextUnitIds.length > 0;
  return matchesExpected ? normalized : null;
}

function identityFileMatches(path, identity) {
  const parsed = readJsonOptional(path);
  if (parsed == null) return false;
  return parsed.schemaVersion === identity.schemaVersion &&
    parsed.bookId === identity.bookId &&
    parsed.sourceId === identity.sourceId &&
    parsed.sourceHash === identity.sourceHash &&
    parsed.documentId === identity.documentId &&
    parsed.contentHash === identity.contentHash &&
    parsed.normalizedPath === identity.normalizedPath &&
    parsed.graphDocumentId === identity.graphDocumentId &&
    JSON.stringify(normalizeIdList(parsed.graphTextUnitIds)) ===
      JSON.stringify(identity.graphTextUnitIds) &&
    (
      identity.metadata == null ||
      JSON.stringify(parsed.metadata ?? {}) === JSON.stringify(identity.metadata)
    );
}

function identityFromCatalog(input, expected) {
  const catalog = readYamlOptional(join(input.stateRoot, "catalog", "document-identity-map.yaml"));
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const match = items.find((item) =>
    item != null &&
    typeof item === "object" &&
    item.canonicalBookId === expected.bookId &&
    item.sourceId === expected.sourceId &&
    item.sourceHash === expected.sourceHash &&
    item.documentId === expected.documentId &&
    item.contentHash === expected.contentHash
  );
  if (match == null) return null;
  return normalizeIdentity({
    schemaVersion: SchemaVersion,
    bookId: expected.bookId,
    sourceId: expected.sourceId,
    sourceHash: expected.sourceHash,
    documentId: expected.documentId,
    contentHash: expected.contentHash,
    normalizedPath: match.normalizedPath ?? expected.normalizedPath,
    graphDocumentId: match.graphDocumentId,
    graphTextUnitIds: match.graphTextUnitIds,
  }, expected);
}

function testFallbackIdentity(input, expected) {
  if (input.allowTestFallback !== true) return null;
  const digest = sha256Text([
    expected.bookId,
    expected.documentId,
    expected.contentHash,
    expected.normalizedPath,
  ].join(":"));
  return {
    schemaVersion: SchemaVersion,
    ...expected,
    graphDocumentId: `graph-doc-${expected.documentId}`,
    graphTextUnitIds: [`tu-${digest.slice(0, 16)}`],
    metadata: {
      identityProvenance: "test_hook_synthetic",
      publishAllowed: false,
    },
  };
}

function ensureWritableIdentity(input, identity) {
  const targetPath = graphIdentitySidecarPath(join(input.bookRoot, "graphrag", "output"));
  mkdirSync(join(input.bookRoot, "graphrag", "output"), { recursive: true });
  writeHotplugJsonWithSidecars(targetPath, identity, {
    rootPath: input.stateRoot,
    runnerSessionId: input.runnerSessionId ?? "book-hotplug-creation-identity",
  });
  return targetPath;
}

export function ensureBookCreationGraphTextUnitIdentity(input) {
  const stateRoot = resolve(input.stateRoot);
  const bookRoot = join(stateRoot, "books", input.bookId);
  const expected = expectedIdentity({ ...input, stateRoot, bookRoot });
  if (expected == null) {
    throw new Error(`GraphRAG identity expected fields missing: ${input.bookId}`);
  }

  const outputDir = join(bookRoot, "graphrag", "output");
  const targetPath = graphIdentitySidecarPath(outputDir);
  const candidates = [
    readJsonOptional(targetPath),
    identityFromCatalog({ ...input, stateRoot, bookRoot }, expected),
    testFallbackIdentity(input, expected),
  ];
  const identity = candidates
    .map((candidate) => normalizeIdentity(candidate, expected))
    .find((candidate) => candidate != null);

  if (identity == null) {
    throw new Error(`GraphRAG text unit identity missing: ${input.bookId}`);
  }
  if (
    !existsSync(targetPath) ||
    !sidecarsPresent(targetPath) ||
    !identityFileMatches(targetPath, identity)
  ) {
    ensureWritableIdentity({ ...input, stateRoot, bookRoot }, identity);
  }
  return {
    path: toPosixPath(relative(stateRoot, targetPath)),
    identity,
  };
}
