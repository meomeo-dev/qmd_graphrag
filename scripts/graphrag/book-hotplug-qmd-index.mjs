import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  createStore,
  extractTitle,
  hashContent,
  upsertStoreCollection,
} from "../../dist/store.js";
import { writeHotplugJsonWithSidecars } from "./book-hotplug-json-sidecars.mjs";
import { writeHotplugTextAtomic } from "./book-hotplug-durable-writer.mjs";

const CollectionName = "books";
const QmdIndexSchema = "qmd-book-index-v1";
const OptionalSqliteVecWarning = "sqlite-vec extension is unavailable";

function toPosixPath(path) {
  return String(path).split(sep).join("/");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function safeUnlink(path) {
  rmSync(path, { force: true });
}

function cleanupSqliteTransientFiles(indexPath) {
  for (const path of [`${indexPath}-shm`, `${indexPath}-wal`]) {
    safeUnlink(path);
  }
}

function withOptionalSqliteVecWarningSuppressed(fn) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    const message = args.map((arg) => String(arg)).join(" ");
    if (message.includes(OptionalSqliteVecWarning)) return;
    originalWarn(...args);
  };
  try {
    return fn();
  } finally {
    console.warn = originalWarn;
  }
}

function writeBinaryChecksumSidecars(path, checksum, options) {
  const targetLocator = rootRelative(options.rootPath, path);
  const operationId = `hotplug-qmd-index-${checksum.slice(0, 16)}`;
  writeHotplugTextAtomic(`${path}.sha256`, `${checksum}\n`, {
    operationId: `${operationId}-checksum`,
    runnerSessionId: "book-hotplug-qmd-index",
    targetLocator: `${targetLocator}.sha256`,
  });
  writeHotplugTextAtomic(
    `${path}.sha256.meta.json`,
    `${JSON.stringify({
      checksum,
      targetLocator,
      checksumPath: `${targetLocator}.sha256`,
      checksumRecoveryDecision: "committed",
      commitState: "committed",
      operationId,
      runnerSessionId: "book-hotplug-qmd-index",
      committedAt: options.committedAt,
    }, null, 2)}\n`,
    {
      operationId: `${operationId}-meta`,
      runnerSessionId: "book-hotplug-qmd-index",
      targetLocator: `${targetLocator}.sha256.meta.json`,
    },
  );
}

export function bookScopedQmdIndexPath(bookRoot) {
  return join(bookRoot, "qmd", "index", "qmd_book_index.sqlite");
}

export function bookScopedQmdIndexMetaPath(bookRoot) {
  return join(bookRoot, "qmd", "index", "qmd_book_index.meta.json");
}

function qmdBuildManifestPath(bookRoot) {
  return join(bookRoot, "qmd", "qmd_build_manifest.json");
}

export function packageQmdDocumentPath(normalizedPath) {
  return toPosixPath(join("input", basename(normalizedPath)));
}

function rootRelative(stateRoot, path) {
  return toPosixPath(relative(stateRoot, path));
}

function packageRelative(bookRoot, path) {
  return toPosixPath(relative(bookRoot, path));
}

function sourceDbPath(input) {
  const candidates = [
    input.sourceQmdIndexPath,
    join(input.rootPath, ".qmd", "index.sqlite"),
    join(input.stateRoot, ".qmd", "index.sqlite"),
  ].filter((path) => typeof path === "string" && path.length > 0);
  return candidates.find((path) => existsSync(path)) ?? null;
}

function unavailableVectorCopy(sourcePath, reason) {
  return {
    source: sourcePath,
    copiedRows: 0,
    modelCount: 0,
    unavailableReason: reason,
  };
}

function vectorDimensions(db) {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE name = 'vectors_vec'",
  ).get();
  const match = typeof row?.sql === "string"
    ? row.sql.match(/float\[(\d+)\]/u)
    : null;
  return match?.[1] == null ? null : Number.parseInt(match[1], 10);
}

function decodeFloat32Vector(buffer, dimensions) {
  if (!Buffer.isBuffer(buffer) || buffer.length < dimensions * 4) return null;
  const values = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    values[index] = buffer.readFloatLE(index * 4);
  }
  return values;
}

function copyVectorRows(input) {
  const sourcePath = sourceDbPath(input);
  if (sourcePath == null) {
    return { source: null, copiedRows: 0, modelCount: 0 };
  }

  let source;
  const sourceLocator = rootRelative(input.rootPath, sourcePath);
  try {
    source = withOptionalSqliteVecWarningSuppressed(() => createStore(sourcePath));
  } catch (error) {
    return unavailableVectorCopy(
      sourceLocator,
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    const dimensions = vectorDimensions(source.db);
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      return unavailableVectorCopy(sourceLocator, "source_vector_table_missing");
    }
    input.target.ensureVecTable(dimensions);
    const rows = source.db.prepare(`
      SELECT
        cv.hash,
        cv.seq,
        cv.pos,
        cv.model,
        cv.embed_fingerprint AS embedFingerprint,
        cv.total_chunks AS totalChunks,
        cv.embedded_at AS embeddedAt,
        vv.embedding AS embedding
      FROM content_vectors cv
      JOIN vectors_vec vv ON vv.hash_seq = cv.hash || '_' || cv.seq
      WHERE cv.hash = ?
      ORDER BY cv.model, cv.seq
    `).all(input.contentHash);
    const modelNames = new Set();
    for (const row of rows) {
      const embedding = decodeFloat32Vector(row.embedding, dimensions);
      if (embedding == null) continue;
      input.target.insertEmbedding(
        row.hash,
        Number(row.seq),
        Number(row.pos),
        embedding,
        String(row.model),
        String(row.embeddedAt),
        Number(row.totalChunks ?? 1),
        typeof row.embedFingerprint === "string" ? row.embedFingerprint : "",
      );
      modelNames.add(String(row.model));
    }
    return {
      source: sourceLocator,
      copiedRows: rows.length,
      modelCount: modelNames.size,
    };
  } catch (error) {
    return unavailableVectorCopy(
      sourceLocator,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    source.close();
  }
}

export async function ensureBookScopedQmdIndex(input) {
  const stateRoot = resolve(input.stateRoot);
  const rootPath = resolve(input.rootPath ?? join(import.meta.dirname, "..", ".."));
  const bookRoot = resolve(stateRoot, "books", input.bookId);
  const normalizedPath = resolve(input.normalizedPath);
  const indexPath = bookScopedQmdIndexPath(bookRoot);
  const metaPath = bookScopedQmdIndexMetaPath(bookRoot);
  const documentPath = packageQmdDocumentPath(normalizedPath);
  const now = input.now?.() ?? new Date().toISOString();
  const content = readFileSync(normalizedPath, "utf8");
  const contentHash = await hashContent(content);

  mkdirSync(dirname(indexPath), { recursive: true });
  for (const path of [
    indexPath,
    `${indexPath}.sha256`,
    `${indexPath}.sha256.meta.json`,
  ]) {
    safeUnlink(path);
  }
  cleanupSqliteTransientFiles(indexPath);

  const target = withOptionalSqliteVecWarningSuppressed(() => createStore(indexPath));
  let vectorCopy;
  try {
    upsertStoreCollection(target.db, CollectionName, {
      path: "input",
      pattern: "**/*.md",
      context: { "/": "Book-scoped qmd index bundled with a hotplug package." },
    });
    target.insertContent(contentHash, content, now);
    target.insertDocument(
      CollectionName,
      documentPath,
      extractTitle(content, basename(normalizedPath)),
      contentHash,
      now,
      now,
    );
    vectorCopy = copyVectorRows({ ...input, rootPath, stateRoot, target, contentHash });
    target.db.exec("PRAGMA optimize");
    target.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    target.close();
  }
  cleanupSqliteTransientFiles(indexPath);

  const stats = statSync(indexPath);
  const indexSha256 = sha256File(indexPath);
  writeBinaryChecksumSidecars(indexPath, indexSha256, {
    rootPath,
    committedAt: now,
  });
  writeHotplugJsonWithSidecars(metaPath, {
    schemaVersion: "1.0.0",
    kind: "qmd_graphrag_book_qmd_index_metadata",
    bookId: input.bookId,
    qmdIndexSchema: QmdIndexSchema,
    indexPath: packageRelative(bookRoot, indexPath),
    documentPath,
    normalizedPath: documentPath,
    normalizedContentHash: input.normalizedContentHash ?? sha256File(normalizedPath),
    qmdContentHash: contentHash,
    indexSha256,
    indexBytes: stats.size,
    collection: CollectionName,
    vectorRowsCopied: vectorCopy.copiedRows,
    vectorModelCount: vectorCopy.modelCount,
    vectorSourceIndex: vectorCopy.source,
    vectorUnavailableReason: vectorCopy.unavailableReason,
    vectorCompleteness: vectorCopy.copiedRows > 0 ? "copied" : "not_available",
    createdAt: now,
    toolVersion: input.toolVersion ?? "book-hotplug-qmd-index-v1",
  }, {
    rootPath,
    runnerSessionId: "book-hotplug-qmd-index",
    committedAt: now,
  });
  const qmdManifestPath = qmdBuildManifestPath(bookRoot);
  if (existsSync(qmdManifestPath)) {
    writeHotplugJsonWithSidecars(qmdManifestPath, {
      ...readJson(qmdManifestPath),
      normalizedPath: documentPath,
      canonicalBookNormalizedPath: documentPath,
      normalizedContentHash: input.normalizedContentHash ?? sha256File(normalizedPath),
      qmdIndexLocator: packageRelative(bookRoot, indexPath),
      qmdIndexHash: indexSha256,
      qmdIndexBytes: stats.size,
      qmdIndexVectorRows: vectorCopy.copiedRows,
      qmdIndexVectorCompleteness: vectorCopy.copiedRows > 0
        ? "copied"
        : "not_available",
    }, {
      rootPath,
      runnerSessionId: "book-hotplug-qmd-index",
      committedAt: now,
    });
  }
  return {
    indexPath,
    metaPath,
    indexSha256,
    indexBytes: stats.size,
    documentPath,
    qmdContentHash: contentHash,
    vectorRowsCopied: vectorCopy.copiedRows,
    vectorModelCount: vectorCopy.modelCount,
    vectorCompleteness: vectorCopy.copiedRows > 0 ? "copied" : "not_available",
  };
}
