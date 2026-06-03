import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import YAML from "yaml";

import { writeHotplugTextAtomic } from "./book-hotplug-durable-writer.mjs";

const SchemaVersion = "1.0.0";
const ToolVersion = "book-hotplug-migration-state-v1";

const MigrationRootRelative = "catalog/book-package-migrations";

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

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function writeYamlWithSidecars(path, value, rootPath) {
  const text = YAML.stringify(value);
  const checksum = sha256Text(text);
  const targetLocator = rootPath == null
    ? toPosixPath(path)
    : toPosixPath(relative(rootPath, path));
  const operationId = `migration-state-${sha256Text(path).slice(0, 16)}`;
  const runnerSessionId = "book-hotplug-migration-state";
  writeHotplugTextAtomic(path, text, {
    operationId,
    runnerSessionId,
    targetLocator,
  });
  writeHotplugTextAtomic(`${path}.sha256`, `${checksum}\n`, {
    operationId: `${operationId}-checksum`,
    runnerSessionId,
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
      runnerSessionId,
      committedAt: nowDefault(),
    }, null, 2)}\n`,
    {
      operationId: `${operationId}-meta`,
      runnerSessionId,
      targetLocator: `${targetLocator}.sha256.meta.json`,
    },
  );
}

function listFilesRecursive(rootPath) {
  if (!existsSync(rootPath)) return [];
  const files = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(rootPath);
  return files;
}

function maybeFileEvidence(stateRoot, path) {
  const stats = safeStat(path);
  if (!stats?.isFile()) return null;
  return {
    locator: toPosixPath(relative(stateRoot, path)),
    bytes: stats.size,
    sha256: sha256File(path),
  };
}

function targetHotplugPathForLegacyFile(bookRoot, filePath) {
  const relativePath = toPosixPath(relative(bookRoot, filePath));
  if (relativePath.startsWith("output/")) {
    return join(bookRoot, "graphrag", relativePath);
  }
  if (relativePath.startsWith("runs/")) {
    return join(bookRoot, "graphrag", relativePath);
  }
  if (["job.yaml", "artifacts.yaml", "checkpoints.yaml"].includes(relativePath)) {
    return join(bookRoot, "state", relativePath);
  }
  return join(bookRoot, relativePath);
}

function copyMapEntriesForBook(input) {
  const roots = [
    join(input.bookRoot, "source"),
    join(input.bookRoot, "input"),
    join(input.bookRoot, "qmd"),
    join(input.bookRoot, "output"),
    join(input.bookRoot, "runs"),
  ];
  const looseStateFiles = ["job.yaml", "artifacts.yaml", "checkpoints.yaml"]
    .map((name) => join(input.bookRoot, name))
    .filter((path) => safeStat(path)?.isFile());
  const files = [
    ...roots.flatMap((root) => listFilesRecursive(root)),
    ...looseStateFiles,
  ].sort((left, right) => left.localeCompare(right));
  return files.map((sourcePath) => {
    const targetPath = targetHotplugPathForLegacyFile(input.bookRoot, sourcePath);
    const source = maybeFileEvidence(input.stateRoot, sourcePath);
    const target = maybeFileEvidence(input.stateRoot, targetPath);
    return {
      operation: sourcePath === targetPath ? "preserve_in_place" : "copy_to_hotplug_layout",
      source,
      target: target ?? {
        locator: toPosixPath(relative(input.stateRoot, targetPath)),
        bytes: null,
        sha256: null,
      },
      commitStatus: target == null ? "pending" : "committed",
      rollbackAction: sourcePath === targetPath
        ? "none_preserved_in_place"
        : "remove_target_copy_preserve_source",
    };
  });
}

function validateSidecar(path) {
  const diagnostics = [];
  if (!existsSync(path)) {
    return { ok: false, sha256: null, diagnostics: ["missing_file"] };
  }
  const sidecarPath = `${path}.sha256`;
  const metaPath = `${path}.sha256.meta.json`;
  if (!existsSync(sidecarPath)) diagnostics.push("missing_sha256_sidecar");
  if (!existsSync(metaPath)) diagnostics.push("missing_sha256_meta_sidecar");
  const actual = sha256File(path);
  if (existsSync(sidecarPath)) {
    const expected = readFileSync(sidecarPath, "utf8").trim();
    if (expected !== actual) diagnostics.push("sha256_sidecar_mismatch");
  }
  return { ok: diagnostics.length === 0, sha256: actual, diagnostics };
}

function stripBookPrefix(bookId, locator) {
  const normalized = toPosixPath(locator);
  for (const prefix of [
    `books/${bookId}/`,
    `graph_vault/books/${bookId}/`,
  ]) {
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  }
  return normalized;
}

function candidatePackagePaths(input, locator) {
  if (typeof locator !== "string" || locator.length === 0) return [];
  const normalized = toPosixPath(locator);
  const stripped = stripBookPrefix(input.bookId, normalized);
  const candidates = [];
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//u.test(normalized)) {
    candidates.push(join(input.stateRoot, normalized));
  }
  if (stripped !== normalized || stripped.startsWith("input/")) {
    candidates.push(join(input.bookRoot, stripped));
  }
  if (normalized.includes("/input/") || normalized.startsWith("input/")) {
    candidates.push(join(input.bookRoot, "input", basename(normalized)));
    candidates.push(join(input.stateRoot, "input", basename(normalized)));
  }
  candidates.push(join(input.bookRoot, normalized));
  return [...new Set(candidates)];
}

function firstReadableFile(paths) {
  for (const path of paths) {
    const stats = safeStat(path);
    if (stats?.isFile() && stats.size > 0) return { path, bytes: stats.size };
  }
  return null;
}

function locateCanonicalInput(input, distribution, qmdManifest) {
  const locators = [
    distribution?.portability?.canonicalNormalizedPath,
    qmdManifest?.canonicalBookNormalizedPath,
    qmdManifest?.normalizedPath,
    distribution?.portability?.legacyNormalizedPath,
  ].filter((locator) => typeof locator === "string" && locator.length > 0);
  for (const locator of locators) {
    const match = firstReadableFile(candidatePackagePaths(input, locator));
    if (match != null) {
      return {
        ok: true,
        locator,
        resolvedPath: toPosixPath(relative(input.stateRoot, match.path)),
        bytes: match.bytes,
      };
    }
  }
  const inputFiles = listFilesRecursive(join(input.bookRoot, "input"))
    .filter((path) => /\.(md|markdown|txt)$/iu.test(path));
  const match = firstReadableFile(inputFiles);
  return match == null
    ? { ok: false, locator: null, resolvedPath: null, bytes: 0 }
    : {
      ok: true,
      locator: toPosixPath(relative(input.bookRoot, match.path)),
      resolvedPath: toPosixPath(relative(input.stateRoot, match.path)),
      bytes: match.bytes,
    };
}

function sourceClosureEvidence(input, distribution) {
  const roots = [
    join(input.bookRoot, "source"),
    join(input.stateRoot, "sources", input.bookId),
  ];
  if (typeof distribution?.portability?.sourceRoot === "string") {
    roots.push(join(input.stateRoot, distribution.portability.sourceRoot));
  }
  const files = [];
  for (const root of [...new Set(roots)]) {
    for (const path of listFilesRecursive(root)) {
      const stats = safeStat(path);
      if (stats?.isFile() && stats.size > 0) {
        files.push({
          path: toPosixPath(relative(input.stateRoot, path)),
          bytes: stats.size,
          sha256: sha256File(path),
        });
      }
    }
  }
  return {
    ok: files.length > 0,
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.bytes, 0),
    files,
  };
}

function runEvidence(input, distribution, graphOutputManifest) {
  const declared = new Set();
  for (const source of [
    distribution?.producerEvidence?.stageProducerRunIds,
    graphOutputManifest?.stageProducerRunIds,
  ]) {
    if (source == null || typeof source !== "object") continue;
    for (const runId of Object.values(source)) {
      if (typeof runId === "string" && runId.length > 0) declared.add(runId);
    }
  }
  for (const runId of [
    distribution?.producerEvidence?.outputProducerRunId,
    graphOutputManifest?.producerRunId,
  ]) {
    if (typeof runId === "string" && runId.length > 0) declared.add(runId);
  }
  const present = [];
  const missing = [];
  for (const runId of [...declared].sort()) {
    const candidates = [
      join(input.bookRoot, "graphrag", "runs", `${runId}.yaml`),
      join(input.bookRoot, "runs", `${runId}.yaml`),
    ];
    if (candidates.some((path) => existsSync(path))) present.push(runId);
    else missing.push(runId);
  }
  return {
    ok: declared.size === 0 || missing.length === 0,
    declaredRunIds: [...declared].sort(),
    presentRunIds: present,
    missingRunIds: missing,
    producerProvenanceStatus: missing.length === 0
      ? "preserved_verified"
      : "missing_marked_not_query_ready",
  };
}

function artifactChecksumEvidence(input) {
  const parsed = readYamlOptional(join(input.bookRoot, "state", "artifacts.yaml")) ??
    readYamlOptional(join(input.bookRoot, "artifacts.yaml"));
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const graphItems = items.filter((item) => {
    if (item == null || typeof item !== "object") return false;
    if (item.bookId !== input.bookId) return false;
    if (typeof item.path !== "string") return false;
    return item.path.includes(`/output/`) ||
      item.path.includes(`/graphrag/output/`);
  });
  const withHash = graphItems.filter((item) =>
    typeof item.contentHash === "string" && item.contentHash.length > 0
  );
  return {
    ok: graphItems.length > 0 && withHash.length === graphItems.length,
    artifactCount: graphItems.length,
    checksumCount: withHash.length,
    missingChecksumCount: graphItems.length - withHash.length,
  };
}

function sourceHashPrefix(bookId) {
  const match = /^book-([0-9a-f]{12})-/u.exec(bookId);
  return match?.[1] ?? null;
}

function sourceHashFromExistingBookManifest(manifest) {
  if (manifest == null) return { sourceHash: null, diagnostics: [] };
  const identitySourceHash = typeof manifest?.identity?.sourceHash === "string" &&
    manifest.identity.sourceHash.length > 0
    ? manifest.identity.sourceHash
    : null;
  const sourceSourceHash = typeof manifest?.source?.sourceHash === "string" &&
    manifest.source.sourceHash.length > 0
    ? manifest.source.sourceHash
    : null;
  const sourceHashes = [...new Set(
    [identitySourceHash, sourceSourceHash].filter((value) => value != null),
  )];
  if (sourceHashes.length !== 1) {
    return {
      sourceHash: null,
      diagnostics: ["migration_manifest_identity_mismatch"],
    };
  }
  return { sourceHash: sourceHashes[0], diagnostics: [] };
}

function classifyBookDirectory(input) {
  const distributionPath = join(input.bookRoot, "distribution_manifest.json");
  const manifestPath = join(input.bookRoot, "BOOK_MANIFEST.json");
  const publishReadyPath = join(input.bookRoot, "PUBLISH_READY.json");
  const stagingRoot = join(
    input.stateRoot,
    ".staging",
    "book-hotplug-migrations",
    input.bookId,
  );
  const distribution = readJsonOptional(distributionPath);
  const existingBookManifest = readJsonOptional(manifestPath);
  const qmdManifest = readJsonOptional(
    join(input.bookRoot, "qmd", "qmd_build_manifest.json"),
  );
  const graphOutputManifest = readJsonOptional(
    join(input.bookRoot, "output", "qmd_output_manifest.json"),
  ) ?? readJsonOptional(
    join(input.bookRoot, "graphrag", "output", "qmd_output_manifest.json"),
  );
  const diagnostics = [];
  const hasHotplugManifest = existsSync(manifestPath) && existsSync(publishReadyPath);
  const hasPartialManifest = existsSync(manifestPath) !== existsSync(publishReadyPath);
  const hasStagingRoot = existsSync(stagingRoot);
  const distSidecar = validateSidecar(distributionPath);
  if (distribution == null) diagnostics.push("migration_distribution_manifest_missing");
  else if (!distSidecar.ok) {
    diagnostics.push(
      ...distSidecar.diagnostics.map((code) =>
        code === "missing_sha256_sidecar" ||
          code === "missing_sha256_meta_sidecar"
          ? "migration_manifest_sidecar_missing"
          : `migration_distribution_manifest_${code}`
      ),
    );
  }
  const existingManifestSourceHash =
    sourceHashFromExistingBookManifest(existingBookManifest);
  if (existingBookManifest != null) {
    diagnostics.push(...existingManifestSourceHash.diagnostics);
  }

  if (qmdManifest == null) diagnostics.push("migration_qmd_build_manifest_missing");
  if (graphOutputManifest == null) {
    diagnostics.push("migration_graphrag_output_manifest_missing");
  }
  const canonicalInput = locateCanonicalInput(input, distribution, qmdManifest);
  if (!canonicalInput.ok) diagnostics.push("migration_canonical_input_missing");
  const sourceClosure = sourceClosureEvidence(input, distribution);
  if (!sourceClosure.ok) diagnostics.push("migration_source_closure_missing");
  const producer = runEvidence(input, distribution, graphOutputManifest);
  if (!producer.ok) diagnostics.push("migration_producer_lineage_missing");
  const artifactChecksums = artifactChecksumEvidence(input);
  if (!artifactChecksums.ok) diagnostics.push("migration_artifact_checksum_missing");

  const criticalDiagnostics = diagnostics.filter((code) =>
    [
      "migration_distribution_manifest_missing",
      "migration_manifest_sidecar_missing",
      "migration_canonical_input_missing",
      "migration_source_closure_missing",
      "migration_artifact_checksum_missing",
      "migration_book_id_source_hash_conflict",
      "migration_manifest_identity_mismatch",
    ].includes(code)
  );
  const sourceHash = typeof distribution?.sourceHash === "string"
    ? distribution.sourceHash
    : null;
  if (
    sourceHash != null &&
    existingManifestSourceHash.sourceHash != null &&
    existingManifestSourceHash.sourceHash !== sourceHash
  ) {
    diagnostics.push("migration_book_id_source_hash_conflict");
  }
  const sourceRelativePath = typeof distribution?.sourceRelativePath === "string"
    ? distribution.sourceRelativePath
    : null;
  const eligible = distribution != null &&
    sourceHash != null &&
    sourceRelativePath != null &&
    criticalDiagnostics.length === 0 &&
    qmdManifest != null &&
    graphOutputManifest != null;

  const migrationState = hasPartialManifest
    ? "failed_interrupted"
    : hasStagingRoot && !hasHotplugManifest
      ? "partial_migration"
      : eligible
        ? hasHotplugManifest ? "already_migrated" : "legacy_only"
        : distribution == null ? "residue_quarantined" : "repair_required";
  return {
    schemaVersion: SchemaVersion,
    bookId: input.bookId,
    bookRoot: toPosixPath(relative(input.stateRoot, input.bookRoot)),
    migrationState,
    sourceHash,
    existingBookManifestSourceHash: existingManifestSourceHash.sourceHash,
    sourceHashPrefix: sourceHash?.slice(0, 12) ?? sourceHashPrefix(input.bookId),
    sourceRelativePath,
    mayGenerateBookManifest: eligible,
    diagnostics: [...new Set(diagnostics)].sort(),
    oldManifestSha256: distSidecar.sha256,
    existingBookManifestSha256: existsSync(manifestPath) ? sha256File(manifestPath) : null,
    canonicalInput,
    sourceClosure,
    producer,
    artifactChecksums,
    residueAction: eligible ? "none" : "quarantine_without_delete",
    rollbackAvailable: hasHotplugManifest,
    stagingRoot: hasStagingRoot
      ? toPosixPath(relative(input.stateRoot, stagingRoot))
      : null,
    rerunBehavior: hasHotplugManifest
      ? "verify_only_no_copy_no_identity_change"
      : migrationState === "partial_migration"
        ? "resume_from_copy_map_after_staging_validation"
        : migrationState === "failed_interrupted"
          ? "require_explicit_resume_or_restart_decision"
          : eligible ? "start_new_staged_migration" : "record_repair_diagnostic_only",
  };
}

function conflictRecords(classifications, generatedAt) {
  const records = [];
  const addRecord = (record) => {
    records.push({
      schemaVersion: SchemaVersion,
      decisionStatus: "manual_decision_required",
      decidedBy: "book-hotplug-migration-state",
      decidedAt: generatedAt,
      ...record,
    });
  };
  const byPrefix = new Map();
  for (const item of classifications) {
    const prefix = item.sourceHashPrefix;
    if (prefix == null) continue;
    const current = byPrefix.get(prefix) ?? [];
    current.push(item);
    byPrefix.set(prefix, current);
  }
  for (const [prefix, items] of byPrefix) {
    if (items.length < 2) continue;
    const completed = items.find((item) => item.mayGenerateBookManifest);
    if (completed == null) continue;
    for (const candidate of items.filter((item) => item.bookId !== completed.bookId)) {
      addRecord({
        decisionId: `decision-${prefix}-${candidate.bookId}`,
        conflictCode: "migration_source_hash_prefix_conflict",
        sourceBookId: candidate.bookId,
        targetBookId: completed.bookId,
        sourceHash: candidate.sourceHash ?? prefix,
        targetLiveRoot: completed.bookRoot,
        candidateRoot: candidate.bookRoot,
        oldManifestSha256: candidate.oldManifestSha256,
        candidateManifestSha256: candidate.existingBookManifestSha256,
        selectedAction: "keep_completed_quarantine_residue",
        decisionStatus: "default_applied",
        reason: "Completed package wins; residue stays in place and is not mounted.",
      });
    }
  }
  const bySourceHash = new Map();
  for (const item of classifications) {
    if (item.sourceHash == null) continue;
    const current = bySourceHash.get(item.sourceHash) ?? [];
    current.push(item);
    bySourceHash.set(item.sourceHash, current);
  }
  for (const [sourceHash, items] of bySourceHash) {
    const distinctBookIds = new Set(items.map((item) => item.bookId));
    if (distinctBookIds.size < 2) continue;
    for (const item of items) {
      addRecord({
        decisionId: `decision-duplicate-${sourceHash.slice(0, 12)}-${item.bookId}`,
        conflictCode: "migration_duplicate_source_hash",
        sourceBookId: item.bookId,
        targetBookId: item.bookId,
        sourceHash,
        targetLiveRoot: item.bookRoot,
        candidateRoot: item.bookRoot,
        oldManifestSha256: item.oldManifestSha256,
        candidateManifestSha256: item.existingBookManifestSha256,
        selectedAction: "duplicate_candidate_not_mounted",
        reason: "Same source hash appears under multiple book ids.",
      });
    }
  }
  for (const item of classifications) {
    if (item.diagnostics.includes("migration_book_id_source_hash_conflict")) {
      addRecord({
        decisionId: `decision-book-id-source-hash-${item.bookId}`,
        conflictCode: "migration_book_id_source_hash_conflict",
        sourceBookId: item.bookId,
        targetBookId: item.bookId,
        sourceHash: item.sourceHash,
        targetSourceHash: item.existingBookManifestSourceHash,
        targetLiveRoot: item.bookRoot,
        candidateRoot: item.bookRoot,
        oldManifestSha256: item.oldManifestSha256,
        candidateManifestSha256: item.existingBookManifestSha256,
        selectedAction: "fail_closed_no_publish",
        reason: "Existing BOOK_MANIFEST sourceHash disagrees with legacy sourceHash.",
      });
    }
    if (item.diagnostics.includes("migration_manifest_identity_mismatch")) {
      addRecord({
        decisionId: `decision-manifest-identity-${item.bookId}`,
        conflictCode: "migration_manifest_identity_mismatch",
        sourceBookId: item.bookId,
        targetBookId: item.bookId,
        sourceHash: item.sourceHash,
        targetSourceHash: item.existingBookManifestSourceHash,
        targetLiveRoot: item.bookRoot,
        candidateRoot: item.bookRoot,
        oldManifestSha256: item.oldManifestSha256,
        candidateManifestSha256: item.existingBookManifestSha256,
        selectedAction: "fail_closed_no_publish",
        reason: "Existing BOOK_MANIFEST has missing or inconsistent identity sourceHash.",
      });
    }
    if (item.migrationState === "partial_migration") {
      addRecord({
        decisionId: `decision-staging-${item.bookId}`,
        conflictCode: "migration_staging_target_exists",
        sourceBookId: item.bookId,
        targetBookId: item.bookId,
        sourceHash: item.sourceHash,
        targetLiveRoot: item.bookRoot,
        candidateRoot: item.stagingRoot,
        oldManifestSha256: item.oldManifestSha256,
        candidateManifestSha256: item.existingBookManifestSha256,
        selectedAction: "resume_if_copy_map_matches",
        decisionStatus: "resume_required",
        reason: "Staging root exists without a validated live package.",
      });
    }
    if (item.migrationState === "failed_interrupted") {
      addRecord({
        decisionId: `decision-live-partial-${item.bookId}`,
        conflictCode: "migration_target_generation_conflict",
        sourceBookId: item.bookId,
        targetBookId: item.bookId,
        sourceHash: item.sourceHash,
        targetLiveRoot: item.bookRoot,
        candidateRoot: item.bookRoot,
        oldManifestSha256: item.oldManifestSha256,
        candidateManifestSha256: item.existingBookManifestSha256,
        selectedAction: "fail_closed_no_publish",
        decisionStatus: "resume_required",
        reason: "Live root has an incomplete manifest/publish marker pair.",
      });
    }
    if (
      item.existingBookManifestSha256 != null &&
      item.sourceHash != null &&
      item.migrationState !== "already_migrated"
    ) {
      addRecord({
        decisionId: `decision-live-root-${item.bookId}`,
        conflictCode: "migration_target_live_root_exists",
        sourceBookId: item.bookId,
        targetBookId: item.bookId,
        sourceHash: item.sourceHash,
        targetLiveRoot: item.bookRoot,
        candidateRoot: item.bookRoot,
        oldManifestSha256: item.oldManifestSha256,
        candidateManifestSha256: item.existingBookManifestSha256,
        selectedAction: "keep_existing",
        reason: "Target live root already contains manifest evidence.",
      });
    }
  }
  return records.sort((left, right) =>
    `${left.conflictCode}:${left.sourceBookId}`.localeCompare(
      `${right.conflictCode}:${right.sourceBookId}`,
    )
  );
}

export function createHotplugMigrationRun(input) {
  const stateRoot = resolve(input.stateRoot);
  const booksRoot = join(stateRoot, "books");
  const generatedAt = input.now?.() ?? nowDefault();
  const migrationId = input.migrationId ??
    `hotplug-backfill-${generatedAt.replace(/[-:.TZ]/gu, "")}`;
  const bookIds = existsSync(booksRoot)
    ? readdirSync(booksRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((bookId) => input.bookId == null || bookId === input.bookId)
      .sort((left, right) => left.localeCompare(right))
    : [];
  const classifications = bookIds.map((bookId) =>
    classifyBookDirectory({
      stateRoot,
      bookId,
      bookRoot: join(booksRoot, bookId),
    })
  );
  const conflicts = conflictRecords(classifications, generatedAt);
  return {
    schemaVersion: SchemaVersion,
    kind: "qmd_graphrag_book_hotplug_migration_run",
    migrationId,
    toolVersion: input.toolVersion ?? ToolVersion,
    stateRoot: ".",
    generatedAt,
    classifications,
    conflicts,
    candidates: classifications.filter((item) => item.mayGenerateBookManifest),
    residues: classifications.filter((item) => !item.mayGenerateBookManifest),
  };
}

export function classifySingleBookForHotplugMigration(input) {
  const stateRoot = resolve(input.stateRoot);
  return classifyBookDirectory({
    stateRoot,
    bookId: input.bookId,
    bookRoot: join(stateRoot, "books", input.bookId),
  });
}

export function writeHotplugMigrationRunEvidence(input) {
  const stateRoot = resolve(input.stateRoot);
  const root = join(stateRoot, MigrationRootRelative);
  const migrationRoot = join(root, "migrations", input.run.migrationId);
  const classifications = input.run.classifications;
  const residues = classifications.filter((item) => !item.mayGenerateBookManifest);
  const counts = {
    totalDirectories: classifications.length,
    candidates: input.run.candidates.length,
    residues: residues.length,
    alreadyMigrated: classifications.filter((item) =>
      item.migrationState === "already_migrated"
    ).length,
    legacyOnly: classifications.filter((item) =>
      item.migrationState === "legacy_only"
    ).length,
    repairRequired: classifications.filter((item) =>
      item.migrationState === "repair_required"
    ).length,
    residueQuarantined: classifications.filter((item) =>
      item.migrationState === "residue_quarantined"
    ).length,
    partialMigration: classifications.filter((item) =>
      item.migrationState === "partial_migration"
    ).length,
    failedInterrupted: classifications.filter((item) =>
      item.migrationState === "failed_interrupted"
    ).length,
  };
  const plan = {
    schemaVersion: SchemaVersion,
    migrationId: input.run.migrationId,
    toolVersion: input.run.toolVersion,
    generatedAt: input.run.generatedAt,
    sourceTruthGate: [
      "distribution_manifest.json with checksum sidecars",
      "canonical input closure",
      "package or legacy source closure",
      "qmd build manifest",
      "GraphRAG output manifest",
      "producer run evidence",
      "artifact checksum evidence",
    ],
    protectedPaths: [
      "metadata/**",
      "state/user-overrides.yaml",
      "BOOK_MANIFEST.local-overrides.json",
    ],
    rollbackPlan: {
      beforePublish: "delete_staging_only",
      afterPublishBeforeProjection: "remove_new_live_root_and_restore_previous",
      afterProjectionCommit: "restore_previous_projection_generation_if_root_valid",
    },
  };
  const copyMap = {
    schemaVersion: SchemaVersion,
    migrationId: input.run.migrationId,
    entries: input.run.candidates.map((item) => ({
      bookId: item.bookId,
      sourceHash: item.sourceHash,
      oldManifestSha256: item.oldManifestSha256,
      newManifestSha256: item.existingBookManifestSha256,
      targetBookId: item.bookId,
      targetRoot: item.bookRoot,
      migrationStartedAt: input.run.generatedAt,
      migrationCompletedAt: input.completedAt ?? null,
      copyState: item.migrationState === "already_migrated"
        ? "committed"
        : "planned",
      mappedRoots: [
        { from: "source legacy closure", to: "source/" },
        { from: "input/", to: "input/" },
        { from: "qmd/", to: "qmd/" },
        { from: "output/", to: "graphrag/output/" },
        { from: "runs/", to: "graphrag/runs/" },
        { from: "job/artifacts/checkpoints", to: "state/" },
      ],
      files: copyMapEntriesForBook({
        stateRoot,
        bookRoot: join(stateRoot, item.bookRoot),
      }),
    })),
  };
  const manifestDiff = {
    schemaVersion: SchemaVersion,
    migrationId: input.run.migrationId,
    entries: input.run.candidates.map((item) => ({
      bookId: item.bookId,
      sourceHash: item.sourceHash,
      oldManifest: {
        path: `${item.bookRoot}/distribution_manifest.json`,
        sha256: item.oldManifestSha256,
      },
      newManifest: {
        path: `${item.bookRoot}/BOOK_MANIFEST.json`,
        sha256: item.existingBookManifestSha256,
      },
      publishMarker: {
        path: `${item.bookRoot}/PUBLISH_READY.json`,
      },
      checksumRegenerated: item.existingBookManifestSha256 != null,
      decisionStatus: item.migrationState === "already_migrated"
        ? "committed"
        : "planned",
    })),
  };
  const checkpoint = {
    schemaVersion: SchemaVersion,
    migrationId: input.run.migrationId,
    counts,
    states: classifications.map((item) => ({
      bookId: item.bookId,
      migrationState: item.migrationState,
      rerunBehavior: item.rerunBehavior,
      mayGenerateBookManifest: item.mayGenerateBookManifest,
      diagnostics: item.diagnostics,
    })),
  };
  const resumePlan = {
    schemaVersion: SchemaVersion,
    migrationId: input.run.migrationId,
    generatedAt: input.run.generatedAt,
    status: input.failed === 0 ? "ready" : "blocked_by_failures",
    resumable: counts.partialMigration > 0 || counts.failedInterrupted > 0,
    nextAction: counts.failedInterrupted > 0
      ? "require_explicit_resume_or_restart_decision"
      : counts.partialMigration > 0
        ? "validate_copy_map_then_resume"
        : "none",
    partialMigrationCount: counts.partialMigration,
    failedInterruptedCount: counts.failedInterrupted,
    repairRequiredCount: counts.repairRequired,
    pendingBookIds: classifications
      .filter((item) =>
        item.migrationState === "partial_migration" ||
        item.migrationState === "failed_interrupted" ||
        item.migrationState === "repair_required"
      )
      .map((item) => item.bookId),
    processedBookIds: (input.processed ?? []).map((item) => item.bookId),
    skippedBookIds: (input.skipped ?? []).map((item) => item.bookId),
    failureBookIds: (input.failures ?? []).map((item) => item.bookId),
    policy: "resume_from_evidence_without_promoting_unvalidated_package",
    items: classifications
      .filter((item) =>
        item.migrationState === "partial_migration" ||
        item.migrationState === "failed_interrupted"
      )
      .map((item) => ({
        bookId: item.bookId,
        migrationState: item.migrationState,
        rerunBehavior: item.rerunBehavior,
        stagingRoot: item.stagingRoot,
        liveRoot: item.bookRoot,
        copyMapPath: `migrations/${input.run.migrationId}/copy-map.yaml`,
        checkpointPath: `migrations/${input.run.migrationId}/checkpoint.yaml`,
        requiredDecision: item.migrationState === "failed_interrupted"
          ? "explicit_resume_or_restart_decision"
          : "validate_copy_map_then_resume",
        resumeAllowed: item.migrationState === "partial_migration",
        restartAllowed: item.migrationState === "failed_interrupted",
        publishAllowedBeforeValidation: false,
        diagnostics: item.diagnostics,
      })),
  };
  const validation = {
    schemaVersion: SchemaVersion,
    migrationId: input.run.migrationId,
    sourceTruth: classifications.map((item) => ({
      bookId: item.bookId,
      sourceHash: item.sourceHash,
      mayGenerateBookManifest: item.mayGenerateBookManifest,
      diagnostics: item.diagnostics,
      oldManifestSha256: item.oldManifestSha256,
      canonicalInput: item.canonicalInput,
      sourceClosure: {
        ok: item.sourceClosure.ok,
        fileCount: item.sourceClosure.fileCount,
        byteCount: item.sourceClosure.byteCount,
      },
      producerProvenanceStatus: item.producer.producerProvenanceStatus,
      artifactChecksums: item.artifactChecksums,
    })),
    packageResults: input.packageResults ?? [],
    quarantineResults: input.quarantineResults ?? [],
  };
  const commitRecord = {
    schemaVersion: SchemaVersion,
    migrationId: input.run.migrationId,
    decisionStatus: input.failed === 0 ? "committed" : "migration_failed",
    processed: input.processed ?? [],
    skipped: input.skipped ?? [],
    failed: input.failures ?? [],
    quarantinedResidues: input.quarantineResults ?? [],
    catalogRebuild: input.catalogRebuild ?? null,
    rollbackAvailable: true,
    legacyEvidencePreserved: true,
    completedAt: input.completedAt ?? nowDefault(),
  };
  const rollbackRecord = {
    schemaVersion: SchemaVersion,
    migrationId: input.run.migrationId,
    generatedAt: input.run.generatedAt,
    completedAt: input.completedAt ?? nowDefault(),
    status: input.failed === 0 ? "committed" : "migration_failed",
    rollbackRequired: input.failed > 0,
    rollbackAvailable: true,
    restoreCatalogProjection: input.failed > 0,
    removePublishedBookIds: classifications
      .filter((item) => item.migrationState === "failed_interrupted")
      .map((item) => item.bookId),
    preservePublishedBookIds: classifications
      .filter((item) =>
        item.migrationState === "already_migrated" ||
        item.migrationState === "legacy_only"
      )
      .map((item) => item.bookId),
    failureBookIds: (input.failures ?? []).map((item) => item.bookId),
    quarantineRoots: (input.quarantineResults ?? [])
      .filter((item) => typeof item.quarantineRoot === "string")
      .map((item) => item.quarantineRoot),
    rollbackPolicy: {
      beforePublish: "delete_uncommitted_staging_only",
      afterManifestBeforePublishMarker:
        "remove_publish_marker_and_keep_package_unmounted_until_validation_passes",
      afterPublishBeforeProjection:
        "remove_new_publish_marker_and_restore_previous_projection_generation",
      afterProjectionCommit:
        "restore_previous_projection_generation_if_current_package_invalid",
    },
    packageRoots: classifications.map((item) => ({
      bookId: item.bookId,
      migrationState: item.migrationState,
      liveRoot: item.bookRoot,
      stagingRoot: item.stagingRoot,
      rollbackAvailable: item.rollbackAvailable,
      previousManifestSha256: item.oldManifestSha256,
      currentManifestSha256: item.existingBookManifestSha256,
      publishMarkerExpected: item.migrationState === "already_migrated" ||
        item.migrationState === "legacy_only",
      actionOnFailure: item.migrationState === "partial_migration"
        ? "delete_or_resume_staging_only"
        : item.migrationState === "failed_interrupted"
          ? "remove_publish_marker_and_require_manual_decision"
          : item.rollbackAvailable
            ? "restore_previous_projection_generation"
            : "preserve_legacy_evidence",
    })),
    processed: input.processed ?? [],
    failed: input.failures ?? [],
    catalogRebuild: input.catalogRebuild ?? null,
  };
  const residueReport = {
    schemaVersion: SchemaVersion,
    migrationId: input.run.migrationId,
    generatedAt: input.run.generatedAt,
    residues: residues.map((item) => ({
      bookId: item.bookId,
      migrationState: item.migrationState,
      diagnostics: item.diagnostics,
      residueAction: item.residueAction,
      repairAllowed: true,
      exportAllowed: false,
      mountAllowed: false,
      deletePerformed: false,
    })),
  };

  writeYamlWithSidecars(join(migrationRoot, "plan.yaml"), plan, stateRoot);
  writeYamlWithSidecars(join(migrationRoot, "classification.yaml"), {
    schemaVersion: SchemaVersion,
    migrationId: input.run.migrationId,
    counts,
    items: classifications,
  }, stateRoot);
  writeYamlWithSidecars(join(migrationRoot, "copy-map.yaml"), copyMap, stateRoot);
  writeYamlWithSidecars(
    join(migrationRoot, "manifest-diff.yaml"),
    manifestDiff,
    stateRoot,
  );
  writeYamlWithSidecars(join(migrationRoot, "checkpoint.yaml"), checkpoint, stateRoot);
  writeYamlWithSidecars(join(migrationRoot, "resume-plan.yaml"), resumePlan, stateRoot);
  writeYamlWithSidecars(join(migrationRoot, "validation.yaml"), validation, stateRoot);
  writeYamlWithSidecars(
    join(migrationRoot, "rollback-record.yaml"),
    rollbackRecord,
    stateRoot,
  );
  writeYamlWithSidecars(
    join(migrationRoot, "commit-record.yaml"),
    commitRecord,
    stateRoot,
  );
  writeYamlWithSidecars(join(root, "residue-report.yaml"), residueReport, stateRoot);
  writeYamlWithSidecars(join(root, "book-conflicts.yaml"), {
    schemaVersion: SchemaVersion,
    migrationId: input.run.migrationId,
    items: input.run.conflicts,
  }, stateRoot);
  return {
    migrationRoot,
    resumePlanPath: join(migrationRoot, "resume-plan.yaml"),
    rollbackRecordPath: join(migrationRoot, "rollback-record.yaml"),
    residueReportPath: join(root, "residue-report.yaml"),
    conflictReportPath: join(root, "book-conflicts.yaml"),
  };
}
