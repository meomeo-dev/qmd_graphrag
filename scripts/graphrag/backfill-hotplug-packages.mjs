#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  buildBookHotplugPackage,
  validateBookHotplugPackage,
} from "./book-hotplug-package.mjs";
import {
  ensureBookScopedQmdIndex,
} from "./book-hotplug-qmd-index.mjs";
import {
  validateHotplugPackagePublishCandidate,
} from "./book-hotplug-publish-gate.mjs";
import {
  writeHotplugJsonWithSidecars,
} from "./book-hotplug-json-sidecars.mjs";
import {
  quarantineForbiddenHotplugPackageResidues,
} from "./book-hotplug-residue-quarantine.mjs";
import {
  hotplugNormalizedPathForBook,
  hotplugSourceHashForBook,
  hotplugSourceRelativePathForBook,
} from "./book-hotplug-package-source.mjs";
import {
  removeHotplugPublishMarkerForBookRoot,
} from "./book-hotplug-publish-marker.mjs";
import {
  buildRuntimeGateState,
  buildPostPublishQualityGate,
  graphRagNotQueryReadyFromGate,
  hotplugQualityGatePathForBookRoot,
  hotplugRuntimeGatePathForBookRoot,
} from "./book-hotplug-quality-gate.mjs";
import {
  createHotplugMigrationRun,
  writeHotplugMigrationRunEvidence,
} from "./book-hotplug-migration-state.mjs";
import {
  executeInterruptedMigrationRecovery,
} from "./book-hotplug-migration-executor.mjs";
import {
  rebuildCatalogFromBookHotplugPackages,
} from "../../dist/graphrag/book-hotplug-catalog.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

function now() {
  return new Date().toISOString();
}

function writeJsonWithSidecars(path, value) {
  writeHotplugJsonWithSidecars(path, value, {
    rootPath: root,
    runnerSessionId: "book-hotplug-backfill",
    committedAt: now(),
  });
}

function hotplugQualityGatePath(bookRoot) {
  return hotplugQualityGatePathForBookRoot(bookRoot);
}

function hotplugRuntimeGatePath(bookRoot) {
  return hotplugRuntimeGatePathForBookRoot(bookRoot);
}

function summarizeQuarantineResults(results) {
  return {
    totalBooks: results.length,
    booksWithQuarantine: results.filter((item) => item.count > 0).length,
    quarantinedFiles: results.reduce((total, item) => total + item.count, 0),
    items: results
      .filter((item) => item.count > 0)
      .map((item) => ({
        bookId: item.bookId,
        count: item.count,
        quarantineRoot: item.quarantineRoot,
      })),
  };
}

function summarizeCatalogRebuild(result) {
  if (result == null) return null;
  return {
    bookCount: result.bookCount,
    identityCount: result.identityCount,
    capabilityCount: result.capabilityCount,
  };
}

function existingPackageGeneration(bookRoot) {
  const manifestPath = join(bookRoot, "BOOK_MANIFEST.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const packageGeneration = manifest?.identity?.packageGeneration;
    return typeof packageGeneration === "string" && packageGeneration.length > 0
      ? packageGeneration
      : undefined;
  } catch {
    return undefined;
  }
}

function validateExistingHotplugPackage(bookRoot) {
  if (!existsSync(join(bookRoot, "BOOK_MANIFEST.json"))) return null;
  if (!existsSync(join(bookRoot, "PUBLISH_READY.json"))) return null;
  return validateBookHotplugPackage({ bookRoot });
}

function conflictRecordsByBookId(conflicts) {
  const byBookId = new Map();
  for (const conflict of conflicts) {
    const bookId = conflict.sourceBookId;
    if (typeof bookId !== "string" || bookId.length === 0) continue;
    const current = byBookId.get(bookId) ?? [];
    current.push(conflict);
    byBookId.set(bookId, current);
  }
  return byBookId;
}

function conflictCodes(records) {
  return [...new Set(records.map((record) => record.conflictCode))]
    .filter((code) => typeof code === "string" && code.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function blockingConflictMessage(records) {
  const codes = conflictCodes(records);
  return `blocked_by_conflict:${codes.join(",") || "unknown_conflict"}`;
}

function isHardIdentityConflict(record) {
  return [
    "migration_book_id_source_hash_conflict",
    "migration_manifest_identity_mismatch",
  ].includes(record?.conflictCode);
}

function hasHardIdentityConflict(records) {
  return records.some((record) => isHardIdentityConflict(record));
}

async function backfillBookPackage(input) {
  const manifestPath = join(input.bookRoot, "BOOK_MANIFEST.json");
  const publishReadyPath = join(input.bookRoot, "PUBLISH_READY.json");
  await ensureBookScopedQmdIndex({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    normalizedPath: hotplugNormalizedPathForBook(input.bookRoot, input.bookId),
    rootPath: root,
    now,
    toolVersion: "book-hotplug-backfill-v1",
  });
  const { manifest, publishReady } = buildBookHotplugPackage({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash: input.sourceHash,
    sourceRelativePath: input.sourceRelativePath,
    forceGraphRagNotQueryReady: input.forceGraphRagNotQueryReady,
    packageGeneration: existingPackageGeneration(input.bookRoot),
    now,
    toolVersion: "book-hotplug-backfill-v1",
  });
  const candidateValidation = validateHotplugPackagePublishCandidate({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    manifest,
    publishReady,
  });
  if (!candidateValidation.ok) return candidateValidation;
  removeHotplugPublishMarkerForBookRoot(input.bookRoot);
  writeJsonWithSidecars(manifestPath, manifest);
  return { ...candidateValidation, publishReady };
}

function writeBackfillQualityGateEvidence(input) {
  const checkedAt = now();
  const qualityGate = buildPostPublishQualityGate({
    bookId: input.book.bookId,
    gate: input.book.classification,
    validation: input.validation,
    manifest: input.validation.manifest,
    checkedAt,
    phase: input.phase,
  });
  writeJsonWithSidecars(hotplugQualityGatePath(input.book.path), qualityGate);
  writeJsonWithSidecars(
    hotplugRuntimeGatePath(input.book.path),
    buildRuntimeGateState({
      bookId: input.book.bookId,
      gate: input.book.classification,
      validation: input.validation,
      manifest: input.validation.manifest,
      checkedAt,
      candidateValidationOk: input.candidateValidationOk ?? true,
    }),
  );
  return qualityGate;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "state-root": { type: "string", default: join(root, "graph_vault") },
      "book-id": { type: "string" },
      "only-missing": { type: "boolean", default: true },
      "force": { type: "boolean", default: false },
      "refresh-existing": { type: "boolean", default: false },
      "rebuild-catalog": { type: "boolean", default: false },
      "fail-fast": { type: "boolean", default: false },
      "resume-interrupted": { type: "boolean", default: false },
      "rollback-interrupted": { type: "boolean", default: false },
    },
  });

  const stateRoot = resolve(String(values["state-root"]));
  const explicitBookId = values["book-id"] == null
    ? null
    : String(values["book-id"]);
  const onlyMissing = Boolean(values["only-missing"]);
  const force = Boolean(values.force);
  const refreshExisting = Boolean(values["refresh-existing"]);
  const rebuildCatalog = Boolean(values["rebuild-catalog"]);
  const failFast = Boolean(values["fail-fast"]);
  const resumeInterrupted = Boolean(values["resume-interrupted"]);
  const rollbackInterrupted = Boolean(values["rollback-interrupted"]);
  let migrationRun = createHotplugMigrationRun({
    stateRoot,
    bookId: explicitBookId,
    now,
    toolVersion: "book-hotplug-backfill-v1",
  });
  let interruptedRecovery = null;
  if (resumeInterrupted || rollbackInterrupted) {
    interruptedRecovery = executeInterruptedMigrationRecovery({
      stateRoot,
      migrationRun,
      resumeInterrupted,
      rollbackInterrupted,
      now,
    });
    if (interruptedRecovery.blockedCount > 0) {
      const summary = {
        stateRoot,
        migrationId: migrationRun.migrationId,
        discovered: migrationRun.classifications.length,
        scannedDirectories: migrationRun.classifications.length,
        residueCount: migrationRun.residues.length,
        conflictCount: migrationRun.conflicts.length,
        processed: 0,
        skipped: 0,
        failed: interruptedRecovery.blockedCount,
        failures: interruptedRecovery.items
          .filter((item) => item.status === "blocked")
          .map((item) => ({
            bookId: item.bookId,
            error: item.reason ?? "interrupted_recovery_blocked",
          })),
        processedItems: [],
        skippedItems: [],
        packageResults: interruptedRecovery.items.map((item) => ({
          bookId: item.bookId,
          status: item.status,
          diagnostics: item.status === "blocked"
            ? [item.reason ?? "interrupted_recovery_blocked"]
            : [],
        })),
        quarantineResults: [],
        catalogRebuild: null,
        interruptedRecovery,
        evidence: writeHotplugMigrationRunEvidence({
          stateRoot,
          run: migrationRun,
          processed: [],
          skipped: [],
          failures: interruptedRecovery.items
            .filter((item) => item.status === "blocked")
            .map((item) => ({
              bookId: item.bookId,
              error: item.reason ?? "interrupted_recovery_blocked",
            })),
          packageResults: interruptedRecovery.items.map((item) => ({
            bookId: item.bookId,
            status: item.status,
            diagnostics: item.status === "blocked"
              ? [item.reason ?? "interrupted_recovery_blocked"]
              : [],
          })),
          quarantineResults: [],
          catalogRebuild: null,
          failed: interruptedRecovery.blockedCount,
          completedAt: now(),
        }),
      };
      console.error(JSON.stringify({
        status: "interrupted_recovery_blocked",
        blockedCount: interruptedRecovery.blockedCount,
        recordPath: interruptedRecovery.recordPath,
      }));
      console.log(JSON.stringify(summary, null, 2));
      process.exit(1);
    }
    migrationRun = createHotplugMigrationRun({
      stateRoot,
      bookId: explicitBookId,
      now,
      toolVersion: "book-hotplug-backfill-v1",
    });
  }
  const conflictsByBookId = conflictRecordsByBookId(migrationRun.conflicts);
  const classificationsByBookId = new Map(
    migrationRun.classifications.map((candidate) => [candidate.bookId, candidate]),
  );
  const candidateBookIds = new Set(
    migrationRun.candidates.map((candidate) => candidate.bookId),
  );
  for (const [bookId, conflicts] of conflictsByBookId) {
    if (hasHardIdentityConflict(conflicts)) candidateBookIds.add(bookId);
  }
  const books = [...candidateBookIds]
    .sort((left, right) => left.localeCompare(right))
    .map((bookId) => {
      const classification = classificationsByBookId.get(bookId);
      if (classification == null) {
        throw new Error(`migration classification missing for bookId: ${bookId}`);
      }
      return {
        bookId,
        path: join(stateRoot, classification.bookRoot),
        classification,
      };
    });

  const summary = {
    stateRoot,
    migrationId: migrationRun.migrationId,
    discovered: books.length,
    scannedDirectories: migrationRun.classifications.length,
    residueCount: migrationRun.residues.length,
    conflictCount: migrationRun.conflicts.length,
    processed: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    processedItems: [],
    skippedItems: [],
    packageResults: [],
    quarantineResults: [],
    catalogRebuild: null,
    interruptedRecovery,
    evidence: null,
  };

  for (const book of books) {
    const manifestPath = join(book.path, "BOOK_MANIFEST.json");
    const publishReadyPath = join(book.path, "PUBLISH_READY.json");
    const existingValidation = validateExistingHotplugPackage(book.path);
    const blockingConflicts = conflictsByBookId.get(book.bookId) ?? [];
    if (
      blockingConflicts.length > 0 &&
      (existingValidation == null || hasHardIdentityConflict(blockingConflicts))
    ) {
      const message = blockingConflictMessage(blockingConflicts);
      summary.failed += 1;
      summary.failures.push({
        bookId: book.bookId,
        error: message,
      });
      summary.skipped += 1;
      summary.skippedItems.push({
        bookId: book.bookId,
        reason: "blocked_by_conflict",
        conflictCodes: conflictCodes(blockingConflicts),
        manifestPath: relative(root, manifestPath),
      });
      summary.packageResults.push({
        bookId: book.bookId,
        status: "blocked_by_conflict",
        diagnostics: [message],
      });
      console.error(JSON.stringify({
        bookId: book.bookId,
        status: "blocked_by_conflict",
        error: message,
      }));
      if (failFast) break;
      continue;
    }
    if (
      onlyMissing &&
      !force &&
      existsSync(manifestPath) &&
      existsSync(`${manifestPath}.sha256`) &&
      existsSync(`${manifestPath}.sha256.meta.json`) &&
      existsSync(publishReadyPath)
    ) {
      if (existingValidation == null || !existingValidation.ok) {
        const diagnostics = existingValidation?.diagnostics ??
          ["existing_package_validation_missing"];
        if (existingValidation != null) {
          writeBackfillQualityGateEvidence({
            book,
            validation: existingValidation,
            phase: "backfill_existing_package_validation",
          });
        }
        summary.failed += 1;
        summary.failures.push({
          bookId: book.bookId,
          error: diagnostics.join(","),
        });
        summary.packageResults.push({
          bookId: book.bookId,
          status: "failed",
          diagnostics,
        });
        console.error(
          JSON.stringify({
            bookId: book.bookId,
            status: "failed",
            error: diagnostics.join(","),
          }),
        );
        if (failFast) break;
        continue;
      }
      const qualityGate = writeBackfillQualityGateEvidence({
        book,
        validation: existingValidation,
        phase: "backfill_existing_package_validation",
      });
      summary.skipped += 1;
      summary.skippedItems.push({
        bookId: book.bookId,
        reason: "already_migrated",
        manifestPath: relative(root, manifestPath),
        qualityGatePath: relative(root, hotplugQualityGatePath(book.path)),
        copyDistributionAllowed: qualityGate.copyDistributionAllowed,
      });
      summary.packageResults.push({
        bookId: book.bookId,
        status: "valid",
        diagnostics: [],
      });
      continue;
    }
    try {
      if (!book.classification.mayGenerateBookManifest) {
        throw new Error(
          `source-of-truth gate failed: ${
            book.classification.diagnostics.join(",") || "not_eligible"
          }`,
        );
      }
      const quarantine = quarantineForbiddenHotplugPackageResidues({
        stateRoot,
        bookId: book.bookId,
        migrationId: migrationRun.migrationId,
        now,
      });
      summary.quarantineResults.push(quarantine);
      const reusableExistingValidation = !refreshExisting && existingValidation?.ok
        ? existingValidation
        : null;
      const validation = reusableExistingValidation ?? await backfillBookPackage({
        stateRoot,
        bookId: book.bookId,
        bookRoot: book.path,
        sourceHash: hotplugSourceHashForBook(book.path),
        sourceRelativePath: hotplugSourceRelativePathForBook(book.path),
        forceGraphRagNotQueryReady:
          graphRagNotQueryReadyFromGate(book.classification),
      });
      if (!validation.ok) {
        throw new Error(validation.diagnostics.join(","));
      }
      const qualityGate = writeBackfillQualityGateEvidence({
        book,
        validation,
        phase: "backfill_package_validation",
      });
      if (reusableExistingValidation == null) {
        writeJsonWithSidecars(publishReadyPath, validation.publishReady);
        const liveValidation = validateExistingHotplugPackage(book.path);
        if (liveValidation == null || !liveValidation.ok) {
          removeHotplugPublishMarkerForBookRoot(book.path);
          const diagnostics = liveValidation?.diagnostics ??
            ["live_package_validation_failed_after_publish_marker"];
          throw new Error(diagnostics.join(","));
        }
      }
      const packageAction = reusableExistingValidation != null
        ? "verified_existing"
        : refreshExisting && existingValidation?.ok
          ? "refreshed_existing"
          : "backfilled";
      summary.processed += 1;
      summary.processedItems.push({
        bookId: book.bookId,
        action: packageAction,
        manifestPath: relative(root, manifestPath),
        publishReadyPath: relative(root, publishReadyPath),
      });
      summary.packageResults.push({
        bookId: book.bookId,
        status: "valid",
        diagnostics: [],
      });
      console.log(
        JSON.stringify({
          bookId: book.bookId,
          status: packageAction,
          manifestPath: relative(root, manifestPath),
          publishReadyPath: relative(root, publishReadyPath),
        }),
      );
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      summary.failures.push({
        bookId: book.bookId,
        error: message,
      });
      summary.packageResults.push({
        bookId: book.bookId,
        status: "failed",
        diagnostics: [message],
      });
      console.error(
        JSON.stringify({
          bookId: book.bookId,
          status: "failed",
          error: message,
        }),
      );
      if (failFast) break;
    }
  }

  if (summary.failed === 0 && rebuildCatalog) {
    summary.catalogRebuild = await rebuildCatalogFromBookHotplugPackages(stateRoot);
  }
  summary.evidence = writeHotplugMigrationRunEvidence({
    stateRoot,
    run: migrationRun,
    processed: summary.processedItems,
    skipped: summary.skippedItems,
    failures: summary.failures,
    packageResults: summary.packageResults,
    quarantineResults: summary.quarantineResults,
    catalogRebuild: summary.catalogRebuild,
    failed: summary.failed,
    completedAt: now(),
  });

  console.log(JSON.stringify({
    ...summary,
    quarantineResults: summarizeQuarantineResults(summary.quarantineResults),
    catalogRebuild: summarizeCatalogRebuild(summary.catalogRebuild),
  }, null, 2));
  process.exit(summary.failed > 0 ? 1 : 0);
}

await main();
