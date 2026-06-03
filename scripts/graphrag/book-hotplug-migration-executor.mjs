import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  writeHotplugJsonWithSidecars,
} from "./book-hotplug-json-sidecars.mjs";
import {
  validateBookHotplugPackage,
} from "./book-hotplug-package.mjs";
import {
  removeHotplugPublishMarkerForBookRoot,
} from "./book-hotplug-publish-marker.mjs";

const SchemaVersion = "1.0.0";

function toPosixPath(path) {
  return String(path).split(sep).join("/");
}

function nowDefault() {
  return new Date().toISOString();
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function listFilesRecursive(rootPath) {
  if (!existsSync(rootPath)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(rootPath);
  return files.sort((left, right) => left.localeCompare(right));
}

function removeFileWithSidecars(path) {
  rmSync(path, { force: true });
  rmSync(`${path}.sha256`, { force: true });
  rmSync(`${path}.sha256.meta.json`, { force: true });
}

function hasProtectedUserMetadata(path) {
  return [
    join(path, "metadata"),
    join(path, "state", "user-overrides.yaml"),
    join(path, "BOOK_MANIFEST.local-overrides.json"),
  ].some((candidate) => existsSync(candidate));
}

function writeExecutionRecord(stateRoot, migrationId, value) {
  const root = join(
    stateRoot,
    "catalog",
    "book-package-migrations",
    "migrations",
    migrationId,
  );
  mkdirSync(root, { recursive: true });
  const path = join(root, "execution-record.json");
  writeHotplugJsonWithSidecars(path, value, {
    rootPath: stateRoot,
    runnerSessionId: "book-hotplug-migration-executor",
  });
  return path;
}

function stagingRootFor(stateRoot, bookId) {
  return join(stateRoot, ".staging", "book-hotplug-migrations", bookId);
}

function executionItemBase(stateRoot, item) {
  return {
    bookId: item.bookId,
    migrationState: item.migrationState,
    liveRoot: item.bookRoot,
    stagingRoot: item.stagingRoot,
    diagnostics: item.diagnostics,
    rerunBehavior: item.rerunBehavior,
    absoluteLiveRoot: join(stateRoot, item.bookRoot),
    absoluteStagingRoot: item.stagingRoot == null
      ? null
      : join(stateRoot, item.stagingRoot),
  };
}

function resumePartialMigration(stateRoot, item, options) {
  const base = executionItemBase(stateRoot, item);
  if (item.migrationState !== "partial_migration") {
    return { ...base, action: "none", status: "not_applicable" };
  }
  if (options.resumeInterrupted !== true) {
    return {
      ...base,
      action: "resume_partial",
      status: "blocked",
      reason: "resume_interrupted_flag_required",
    };
  }
  const stagingRoot = stagingRootFor(stateRoot, item.bookId);
  if (!existsSync(stagingRoot)) {
    return {
      ...base,
      action: "resume_partial",
      status: "blocked",
      reason: "staging_root_missing",
    };
  }
  if (hasProtectedUserMetadata(stagingRoot)) {
    return {
      ...base,
      action: "resume_partial",
      status: "blocked",
      reason: "protected_user_metadata_in_staging",
    };
  }
  const removedFiles = listFilesRecursive(stagingRoot)
    .map((path) => toPosixPath(relative(stateRoot, path)));
  rmSync(stagingRoot, { recursive: true, force: true });
  return {
    ...base,
    action: "resume_partial",
    status: "executed",
    decision: "deleted_uncommitted_staging_then_reenter_backfill",
    removedFiles,
  };
}

function rollbackFailedInterrupted(stateRoot, item, options) {
  const base = executionItemBase(stateRoot, item);
  if (item.migrationState !== "failed_interrupted") {
    return { ...base, action: "none", status: "not_applicable" };
  }
  if (options.rollbackInterrupted !== true) {
    return {
      ...base,
      action: "rollback_interrupted",
      status: "blocked",
      reason: "rollback_interrupted_flag_required",
    };
  }
  const liveRoot = join(stateRoot, item.bookRoot);
  const manifestPath = join(liveRoot, "BOOK_MANIFEST.json");
  const hasManifest = safeStat(manifestPath)?.isFile() === true;
  const existingValidation = hasManifest
    ? validateBookHotplugPackage({ bookRoot: liveRoot })
    : null;
  if (hasProtectedUserMetadata(liveRoot)) {
    return {
      ...base,
      action: "rollback_interrupted",
      status: "blocked",
      reason: "protected_user_metadata_in_live_root",
    };
  }
  removeHotplugPublishMarkerForBookRoot(liveRoot);
  const removedStaging = existsSync(stagingRootFor(stateRoot, item.bookId));
  if (removedStaging) {
    rmSync(stagingRootFor(stateRoot, item.bookId), { recursive: true, force: true });
  }
  if (hasManifest && existingValidation?.ok !== true) {
    removeFileWithSidecars(manifestPath);
  }
  return {
    ...base,
    action: "rollback_interrupted",
    status: "executed",
    decision: "removed_publish_marker_and_uncommitted_staging",
    removedStaging,
    manifestPreserved: hasManifest && existsSync(manifestPath),
    removedInvalidManifest: hasManifest && !existsSync(manifestPath),
  };
}

export function executeInterruptedMigrationRecovery(input) {
  const stateRoot = resolve(input.stateRoot);
  const migrationId = input.migrationRun.migrationId;
  const generatedAt = input.now?.() ?? nowDefault();
  const items = input.migrationRun.classifications.flatMap((item) => {
    if (item.migrationState === "partial_migration") {
      return [resumePartialMigration(stateRoot, item, input)];
    }
    if (item.migrationState === "failed_interrupted") {
      return [rollbackFailedInterrupted(stateRoot, item, input)];
    }
    return [];
  });
  const blocked = items.filter((item) => item.status === "blocked");
  const executed = items.filter((item) => item.status === "executed");
  const record = {
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_book_hotplug_migration_execution_record",
    migrationId,
    generatedAt,
    status: blocked.length > 0 ? "blocked" : "executed",
    resumeInterrupted: input.resumeInterrupted === true,
    rollbackInterrupted: input.rollbackInterrupted === true,
    executedCount: executed.length,
    blockedCount: blocked.length,
    items,
  };
  const recordPath = writeExecutionRecord(stateRoot, migrationId, record);
  return {
    ...record,
    recordPath: toPosixPath(relative(stateRoot, recordPath)),
  };
}
