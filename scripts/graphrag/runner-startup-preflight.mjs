import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";

import YAML from "yaml";
import { z } from "zod";

export const StartupNextOperatorActionSchema = z.enum([
  "run_status_json",
  "run_explicit_repair",
  "run_migrate_only",
  "start_new_run_after_repair",
  "inspect_manual_state",
]);

export function createStartupRecoverySchema({
  DurableStateDiagnosticSchema,
  BatchRecoveryDecisionSchema,
}) {
  return z.object({
    runId: z.string().min(1).optional(),
    stage: z.string().min(1).optional(),
    scopeCount: z.number().int().nonnegative().optional(),
    targetCount: z.number().int().nonnegative().optional(),
    degradedTargetCount: z.number().int().nonnegative().optional(),
    mutationCount: z.number().int().nonnegative().optional(),
    firstSample: z.string().min(1).optional(),
    lastSample: z.string().min(1).optional(),
    firstBlocker: DurableStateDiagnosticSchema.optional(),
    decision: z.string().min(1).optional(),
    recoveryDecision: BatchRecoveryDecisionSchema.optional(),
    nextOperatorAction: StartupNextOperatorActionSchema.optional(),
    repairBoundary: z.string().min(1).optional(),
    repairScope: z.string().min(1).optional(),
    repairTargetFamily: z.string().min(1).optional(),
    maxScannedTargets: z.number().int().positive().optional(),
    maxMutationCount: z.number().int().nonnegative().optional(),
    limitHit: z.boolean().optional(),
    explicitRepairHint: z.string().min(1).optional(),
    providerRequestDiagnostics: z.array(DurableStateDiagnosticSchema).optional(),
    updatedAt: z.string().datetime().optional(),
  }).passthrough();
}

export function createStartupScanStats(scopeCount = 0) {
  return {
    scopeCount,
    targetCount: 0,
    degradedTargetCount: 0,
    mutationCount: 0,
  };
}

export function noteProviderRequestStartupScan(stats, scan) {
  if (stats == null) return;
  stats.targetCount += scan.scanned;
  stats.degradedTargetCount += scan.diagnostics.length;
  const first = scan.diagnostics[0];
  if (first == null) return;
  stats.firstSample ??= first.targetLocator;
  stats.lastSample = first.targetLocator;
}

export function noteStartupPrimaryTarget(stats, targetLocator) {
  if (stats == null) return;
  stats.targetCount += 1;
  stats.firstSample ??= targetLocator;
  stats.lastSample = targetLocator;
}

export function noteStartupDegradedTarget(stats) {
  if (stats != null) stats.degradedTargetCount += 1;
}

export function isBookScopedDurablePreflightMapping(mapping) {
  const patternSource = String(
    mapping.pattern?.source ?? mapping.targetMappingPattern ?? "",
  );
  return patternSource.includes("graph_vault\\/books") ||
    patternSource.includes("graph_vault/books");
}

export function isStartupPreflightMutationEvent(eventName) {
  const name = String(eventName ?? "");
  return /^durable_.*_(?:target_quarantined|checksum_backfilled|temp_reconciled)$/u
    .test(name) ||
    /^durable_.*_target_recovered$/u.test(name) ||
    /^durable_.*_(?:recovered|deleted|renamed|written|committed)$/u
      .test(name) ||
    name === "durable_checksum_meta_backfilled" ||
    name === "durable_checksum_meta_sidecar_quarantined" ||
    name.endsWith("_checksum_meta_committed");
}

export function startupRecoveryFromStats(stats, update = {}) {
  return {
    scopeCount: update.scopeCount ?? stats.scopeCount ?? 0,
    targetCount: update.targetCount ?? stats.targetCount ?? 0,
    degradedTargetCount:
      update.degradedTargetCount ?? stats.degradedTargetCount ?? 0,
    mutationCount: update.mutationCount ?? stats.mutationCount ?? 0,
    firstSample: update.firstSample ?? stats.firstSample,
    lastSample: update.lastSample ?? stats.lastSample,
    ...update,
  };
}

export function startupRecoveryMergePolicy(update = {}) {
  const decision = update.decision;
  const clearsBlockingOutcome = [
    "created_before_preflight",
    "startup_preflight_passed",
    "continue_with_provider_request_diagnostic",
    "migrate_only_repair_preflight_passed",
  ].includes(decision);
  const preservesRepairContext =
    update.repairBoundary != null ||
    update.repairScope != null ||
    update.repairTargetFamily != null ||
    decision === "migrate_only_repair_preflight_passed" ||
    decision === "migrate_only_repair_limit_reached";
  return { clearsBlockingOutcome, preservesRepairContext };
}

export function buildStartupPreflightFailureManifest(input) {
  const blocker = input.DurableStateDiagnosticSchema.parse(input.withoutUndefined({
    failureKind: input.durableError.failureKind ?? "local_state_integrity",
    retryable: false,
    recoveryDecision: input.durableError.recoveryDecision ?? "stop_until_fixed",
    failedStage: input.durableError.failedStage ?? "runner_start",
    localFailureClass: input.durableError.localFailureClass,
    ...input.durableProjection(input.durableError.evidence),
  }));
  const current = input.manifest.metadata?.startupRecovery ?? {};
  const nextOperatorAction = blocker.repairAllowed === true &&
    blocker.durableMode === "migrate_only_repair_boundary"
    ? "run_migrate_only"
    : "run_explicit_repair";
  const explicitRepairHint = nextOperatorAction === "run_migrate_only"
    ? "rerun migrate-only with a larger explicit repair bound"
    : "run explicit repair or migrate-only before starting a new run";
  const repairBoundary = {
    repairBoundary: current.repairBoundary,
    repairScope: current.repairScope,
    repairTargetFamily: current.repairTargetFamily,
    maxScannedTargets: current.maxScannedTargets,
    maxMutationCount: current.maxMutationCount,
  };
  return input.BatchRunManifestSchema.parse(input.withoutUndefined({
    ...input.manifest,
    status: "failed",
    pendingItems: input.manifest.totalItems,
    runningItems: 0,
    completedItems: 0,
    skippedItems: 0,
    failedItems: 0,
    activeProviderSlots: 0,
    activeSubprocesses: 0,
    activeBookLeases: 0,
    updatedAt: input.now(),
    failedAt: input.now(),
    completedAt: undefined,
    durableFailureSummary: {
      ...blocker,
      recoveryDecision: "stop_until_fixed",
    },
    metadata: {
      ...(input.manifest.metadata ?? {}),
      startupRecovery: input.StartupRecoverySchema.parse(input.withoutUndefined(
        startupRecoveryFromStats(input.stats, {
          ...repairBoundary,
          runId: input.manifest.runId,
          stage: "runner_start",
          firstSample: input.stats.firstSample ?? blocker.targetLocator,
          lastSample: input.stats.lastSample ?? blocker.targetLocator,
          firstBlocker: blocker,
          decision: current.repairBoundary === "migrate_only"
            ? "migrate_only_repair_limit_reached"
            : "blocked_before_claim",
          recoveryDecision: "stop_until_fixed",
          nextOperatorAction,
          limitHit: current.repairBoundary === "migrate_only"
            ? true
            : current.limitHit,
          explicitRepairHint,
          updatedAt: input.now(),
        }),
      )),
    },
  }));
}

export function recoveryDecisionForStartupSummary(manifest) {
  const startupRecovery = manifest.metadata?.startupRecovery;
  if (
    startupRecovery?.decision === "blocked_before_claim" &&
    startupRecovery?.recoveryDecision === "stop_until_fixed"
  ) {
    return "stop_until_fixed";
  }
  return undefined;
}

export function durableReadOnlyTempDiagnostic(temporaryPath, input) {
  const base = durableReadOnlyPathDiagnosticBase(
    temporaryPath,
    "temp",
    input.context,
  );
  return {
    ...base,
    ...input.ownerProjection,
    targetLocator: base.targetLocator,
    redactedEvidenceLocator: base.redactedEvidenceLocator,
    localFailureClass: "durable_preflight_unresolved_temp",
    reason: input.decision?.reason ?? "book_scoped_temp_present",
    diagnosticClass: "book_scoped_temp_present",
    statusJsonDecision: "fail_closed_projection",
    checksumRecoveryDecision: "stop_until_fixed",
    lockOwnerEvidence: input.decision?.lockOwnerEvidence,
    cleanupReason: input.decision?.reason ?? "book_scoped_temp_present",
    repairAllowed: false,
    completedPublishRule: "forbidden",
    normalRunnerAction: "no_book_scoped_mutation",
    durableMode: "read_only_blocking_diagnostic",
    maxRunnerStartMutationCount: 0,
  };
}

export function durableReadOnlyLockDiagnostic(lockPath, input) {
  const base = durableReadOnlyPathDiagnosticBase(lockPath, "lock", input.context);
  return {
    ...base,
    lane: input.owner?.lane ?? base.lane,
    targetMappingOwner: input.owner?.targetMappingOwner ?? base.targetMappingOwner,
    laneTimeoutMs: input.owner?.laneTimeoutMs ?? base.laneTimeoutMs,
    releaseOn: input.owner?.releaseOn ?? base.releaseOn,
    operationId: input.owner?.operationId,
    localFailureClass: "durable_preflight_live_lock",
    reason: input.reason ?? "book_scoped_lock_present",
    targetLocator: input.owner?.targetLocator ?? base.targetLocator,
    diagnosticClass: "book_scoped_lock_present",
    statusJsonDecision: "fail_closed_projection",
    checksumRecoveryDecision: "stop_until_fixed",
    lockOwnerEvidence: input.lockOwnerEvidence,
  };
}

export function durableReadOnlyPrimaryDiagnostic(path, kind, context) {
  const mode = "read_only_blocking_diagnostic";
  const base = durableReadOnlyPrimaryDiagnosticBase(path, kind, mode, context);
  try {
    const text = readFileSync(path, "utf8");
    if (kind === "json") {
      JSON.parse(text);
    } else {
      YAML.parse(text);
    }
    const checksumPath = context.durableChecksumPath(path);
    const expected = existsSync(checksumPath)
      ? readFileSync(checksumPath, "utf8").trim()
      : null;
    const actual = context.sha256Text(text);
    const checksumEvidence = {
      checksumExpected: expected,
      checksumActual: actual,
    };
    if (expected == null) {
      return {
        ...base,
        ...checksumEvidence,
        sidecarTargetLocator: relative(context.root, checksumPath),
        sidecarKind: "checksum",
        localFailureClass: "durable_checksum_missing",
        statusJsonDecision: "fail_closed_projection",
        diagnosticClass: "checksum_missing",
        checksumRecoveryDecision: "target_new_checksum_missing",
      };
    }
    if (expected !== actual) {
      return checksumMetaDiagnostic(path, base, checksumEvidence, {
        context,
        localFailureClass: "durable_checksum_mismatch",
        diagnosticClass: "checksum_mismatch",
      });
    }
    const metaState = context.readChecksumMetaState(path);
    if (metaState.status === "missing") {
      return checksumMetaDiagnostic(path, base, checksumEvidence, {
        context,
        localFailureClass: "durable_checksum_meta_missing",
        diagnosticClass: "checksum_meta_missing",
      });
    }
    if (metaState.status === "invalid") {
      return checksumMetaDiagnostic(path, base, checksumEvidence, {
        context,
        localFailureClass: "durable_checksum_meta_invalid",
        diagnosticClass: "checksum_meta_invalid",
      });
    }
    if (context.checksumMetaIsInvalid(path, actual, metaState.meta)) {
      return checksumMetaDiagnostic(path, base, {
        checksumExpected: metaState.meta?.checksum ?? expected,
        checksumActual: actual,
      }, {
        context,
        localFailureClass: "durable_checksum_meta_conflict",
        diagnosticClass: "checksum_meta_conflict",
      });
    }
  } catch (error) {
    return {
      ...base,
      checksumExpected: null,
      localFailureClass: "durable_target_invalid",
      statusJsonDecision: "fail_closed_projection",
      diagnosticClass: `${kind}_target_invalid`,
      checksumRecoveryDecision: "stop_until_fixed",
      evidenceIncomplete: true,
      evidenceIncompleteReason:
        error instanceof SyntaxError || error?.name === "YAMLParseError"
          ? `invalid_${kind}`
          : "read_only_inspection_failed",
    };
  }
  return null;
}

function durableReadOnlyPathDiagnosticBase(path, kind, context) {
  const directoryMapping = safeDurableMapping(
    context,
    dirname(path),
    "directory-fsync",
  );
  const mapping = safeDurableMapping(context, path, kind) ?? directoryMapping ?? {};
  const targetLocator = relative(context.root, path);
  const directoryTargetLocator = relative(context.root, dirname(path))
    .split(sep)
    .join("/");
  return {
    ...mapping,
    lane: mapping.lane ?? directoryMapping.lane,
    targetMappingOwner:
      mapping.targetMappingOwner ?? directoryMapping.targetMappingOwner,
    targetLocator,
    redactedEvidenceLocator: basename(path),
    directoryTargetLocator,
    directoryDurableKind: "directory",
    primaryDurableKind: mapping.durableKind ?? kind,
    failedStage: "runner_start",
    failureKind: "local_state_integrity",
    retryable: false,
    recoveryDecision: "stop_until_fixed",
    repairAllowed: false,
    completedPublishRule: "forbidden",
    normalRunnerAction: "no_book_scoped_mutation",
    durableMode: "read_only_blocking_diagnostic",
    maxRunnerStartMutationCount: 0,
    fsyncTarget: directoryTargetLocator,
    fsyncPlatform: process.platform,
    fsyncErrno: "not_attempted_read_only",
    unavailableFieldSentinels: ["fsyncErrno"],
  };
}

function safeDurableMapping(context, path, kind) {
  try {
    return context.durableTargetMapping(path, kind);
  } catch {
    return null;
  }
}

function checksumMetaDiagnostic(path, base, checksumEvidence, input) {
  return {
    ...base,
    ...checksumEvidence,
    sidecarTargetLocator: relative(
      input.context.root,
      input.context.durableChecksumMetaPath(path),
    ),
    sidecarKind: "checksum_meta",
    localFailureClass: input.localFailureClass,
    statusJsonDecision: "fail_closed_projection",
    diagnosticClass: input.diagnosticClass,
    checksumRecoveryDecision: "stop_until_fixed",
  };
}

function durableReadOnlyPrimaryDiagnosticBase(path, kind, mode, context) {
  const mapping = context.durableTargetMapping(path, kind);
  const directoryMapping = context.durableTargetMapping(dirname(path), "directory-fsync");
  const primaryTargetLocator = relative(context.root, path);
  const directoryTargetLocator = relative(context.root, dirname(path))
    .split(sep)
    .join("/");
  return {
    ...mapping,
    lane: mapping.lane ?? directoryMapping.lane,
    targetMappingOwner:
      mapping.targetMappingOwner ?? directoryMapping.targetMappingOwner,
    targetLocator: primaryTargetLocator,
    primaryTargetLocator,
    redactedEvidenceLocator: basename(path),
    directoryTargetLocator,
    directoryDurableKind: "directory",
    primaryDurableKind: mapping.durableKind,
    failedStage: "runner_start",
    failureKind: "local_state_integrity",
    retryable: false,
    recoveryDecision: "stop_until_fixed",
    repairAllowed: false,
    completedPublishRule: "forbidden",
    normalRunnerAction: "no_book_scoped_mutation",
    durableMode: mode,
    maxRunnerStartMutationCount: 0,
    fsyncTarget: directoryTargetLocator,
    fsyncPlatform: process.platform,
    fsyncErrno: "not_attempted_read_only",
    unavailableFieldSentinels: ["fsyncErrno"],
  };
}
