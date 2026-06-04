import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

function toPosixPath(path) {
  return String(path).split(sep).join("/");
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function defaultRedactLog(text) {
  return String(text);
}

function scopedTargetName(scope, name) {
  return scope == null || scope === "" ? name : `${scope}-${name}`;
}

function migrateEntry(input) {
  const stat = safeStat(input.source);
  if (stat == null) return;
  if (stat.isDirectory()) {
    for (const child of readdirSync(input.source)) {
      migrateEntry({
        ...input,
        source: join(input.source, child),
        target: join(input.target, child),
        sourceLocator: `${input.sourceLocator}/${child}`,
      });
    }
    rmSync(input.source, { recursive: true, force: true });
    return;
  }
  if (!stat.isFile()) return;
  mkdirSync(dirname(input.target), { recursive: true });
  const rawLog = readFileSync(input.source, "utf8");
  writeFileSync(input.target, input.redactLog(rawLog), "utf8");
  unlinkSync(input.source);
  input.emitEvent?.({
    event: "raw_log_migrated",
    metadata: {
      sourceLocator: input.sourceLocator,
      targetLogRootName: basename(input.logRoot),
      targetFileName: toPosixPath(relative(input.targetDir, input.target)),
    },
  });
}

export function bookScopedRawReportDirectories(stateRoot, bookId) {
  return [
    {
      reportsDir: join(stateRoot, "books", bookId, "graphrag", "output", "reports"),
      sourceLocator: `graph_vault/books/${bookId}/graphrag/output/reports`,
      targetScope: `${bookId}-graphrag-output-reports`,
    },
    {
      reportsDir: join(stateRoot, "books", bookId, "output", "reports"),
      sourceLocator: `graph_vault/books/${bookId}/output/reports`,
      targetScope: `${bookId}-output-reports`,
    },
  ];
}

export function graphVaultRawReportDirectories(stateRoot, items) {
  return [
    {
      reportsDir: join(stateRoot, "reports"),
      sourceLocator: "graph_vault/reports",
      targetScope: "",
    },
    ...items.flatMap((item) =>
      bookScopedRawReportDirectories(stateRoot, item.bookId)
    ),
  ];
}

export function migrateRawReportDirectories(input) {
  const targetDir = join(input.logRoot, "graph_vault_reports");
  const migratedAt = input.nowMs?.() ?? Date.now();
  const redactLog = input.redactLog ?? defaultRedactLog;
  let migratedCount = 0;
  for (const directory of input.directories) {
    if (!existsSync(directory.reportsDir)) continue;
    mkdirSync(targetDir, { recursive: true });
    for (const name of readdirSync(directory.reportsDir)) {
      const source = join(directory.reportsDir, name);
      const targetName = scopedTargetName(directory.targetScope, name);
      const target = join(targetDir, `${migratedAt}-${targetName}`);
      migrateEntry({
        source,
        target,
        sourceLocator: `${directory.sourceLocator}/${name}`,
        targetDir,
        logRoot: input.logRoot,
        redactLog,
        emitEvent: input.emitEvent,
      });
      migratedCount += 1;
    }
  }
  return {
    targetDir,
    migratedCount,
  };
}

export function migrateGraphVaultRawReports(input) {
  return migrateRawReportDirectories({
    ...input,
    directories: graphVaultRawReportDirectories(input.stateRoot, input.items ?? []),
  });
}

export function migrateBookScopedRawReports(input) {
  return migrateRawReportDirectories({
    ...input,
    directories: bookScopedRawReportDirectories(input.stateRoot, input.bookId),
  });
}

export function bookScopedRawReportResiduals(input) {
  const residuals = [];
  for (const item of input.items ?? []) {
    for (const candidate of bookScopedRawReportDirectories(input.stateRoot, item.bookId)) {
      if (!existsSync(candidate.reportsDir)) continue;
      const residualNames = readdirSync(candidate.reportsDir);
      if (residualNames.length === 0) continue;
      residuals.push({
        bookId: item.bookId,
        sourceName: item.sourceName,
        residualCount: residualNames.length,
        sourceLocator: candidate.sourceLocator,
      });
    }
  }
  return residuals;
}
