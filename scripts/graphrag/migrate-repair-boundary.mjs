export function migrateRepairLimits(input = {}) {
  return {
    maxScannedTargets: positiveInt(input.maxScannedTargets, 200),
    maxMutationCount: positiveInt(input.maxMutationCount, 1),
  };
}

export function migrateRepairPreflightOptions(input) {
  if (input.migrateOnly !== true) return {};
  return {
    bookScopedRepairBoundary: true,
    maxScannedTargets: input.limits.maxScannedTargets,
    maxMutationCount: input.limits.maxMutationCount,
  };
}

export function migrateRepairStartupUpdate(input) {
  if (input.migrateOnly !== true) {
    return {
      decision: input.providerRequestDiagnostics.length > 0
        ? "continue_with_provider_request_diagnostic"
        : "startup_preflight_passed",
    };
  }
  const limitHit = input.stats.repairLimitHit === true;
  return {
    decision: limitHit
      ? "migrate_only_repair_limit_reached"
      : "migrate_only_repair_preflight_passed",
    repairBoundary: "migrate_only",
    repairScope: "batch_items_book_scoped_durable_targets",
    repairTargetFamily: "book_scoped_durable_state",
    maxScannedTargets: input.limits.maxScannedTargets,
    maxMutationCount: input.limits.maxMutationCount,
    limitHit,
    nextOperatorAction: limitHit ? "run_migrate_only" : "run_status_json",
    explicitRepairHint: limitHit
      ? "rerun migrate-only with a larger explicit repair bound"
      : "run status-json or normal runner_start read-only preflight",
  };
}

export function migrateRepairLimitBlocker(input) {
  const mutationLimitHit = input.limitKind === "mutation";
  return {
    localFailureClass: mutationLimitHit
      ? "durable_repair_mutation_limit_reached"
      : "durable_repair_scan_limit_exceeded",
    recoveryDecision: "stop_until_fixed",
    targetLocator: input.targetLocator,
    redactedEvidenceLocator: input.redactedEvidenceLocator,
    checksumRecoveryDecision: "stop_until_fixed",
    durableMode: "migrate_only_repair_boundary",
    repairAllowed: true,
    diagnosticClass: mutationLimitHit
      ? "migrate_repair_mutation_limit_reached"
      : "migrate_repair_scan_limit_exceeded",
    normalRunnerAction: "explicit_repair_boundary",
    scannedTargetCount: input.scannedTargetCount,
    maxRunnerStartScannedTargets: input.maxScannedTargets,
    maxMutationCount: input.maxMutationCount,
    limitHit: true,
  };
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
