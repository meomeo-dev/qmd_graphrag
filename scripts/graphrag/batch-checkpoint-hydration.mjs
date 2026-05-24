import { classifyFailure } from "./batch-failure-classifier.mjs";

export function hydrateBatchCheckpoint({
  item,
  checkpoint,
  expectedCommandCheckCount,
  maxCommandAttempts,
  maxTransientCommandAttempts,
  maxResumePasses,
  retryBaseDelaySeconds,
  retryMaxDelaySeconds,
  retryBudgetSeconds,
  commandTimeoutSeconds,
  defaultBookId,
}) {
  const commandChecks = (checkpoint.commandChecks ?? []).map((check) => {
    if (check.status !== "failed") return check;
    const failure = classifyFailure(check.errorSummary ?? checkpoint.errorSummary ?? "");
    const attemptExhausted = check.attemptExhausted ?? true;
    const recoverLegacyTransient =
      failure.retryable === true &&
      (check.retryable === false ||
        check.failureKind === "unknown" ||
        check.recoveryDecision === "stop_until_fixed");
    const reclassifyLegacyKnown =
      check.failureKind === "unknown" && failure.failureKind !== "unknown";
    return {
      ...check,
      failureKind: recoverLegacyTransient || reclassifyLegacyKnown
        ? failure.failureKind
        : check.failureKind ?? failure.failureKind,
      retryable: recoverLegacyTransient ? true : check.retryable ?? failure.retryable,
      retryAfterSeconds: check.retryAfterSeconds ?? failure.retryAfterSeconds,
      attemptExhausted: recoverLegacyTransient ? false : attemptExhausted,
      providerStatusCode: check.providerStatusCode ?? failure.providerStatusCode,
      recoveryDecision: recoverLegacyTransient ? "retry_same_run_id" : check.recoveryDecision ??
        (attemptExhausted ? "stop_until_fixed" :
          failure.retryable ? "retry_same_run_id" : "stop_until_fixed"),
    };
  });
  const firstFailedCheck = commandChecks.find((check) => check.status === "failed");
  const failureText = [
    checkpoint.errorSummary,
    ...commandChecks.map((check) => check.errorSummary),
  ].filter(Boolean).join("\n");
  const inferredFailure = checkpoint.status === "failed"
    ? classifyFailure(failureText)
    : null;
  const recoverLegacyTransient =
    checkpoint.status === "failed" &&
    inferredFailure?.retryable === true &&
    (checkpoint.retryable === false ||
      checkpoint.failureKind === "unknown" ||
      checkpoint.recoveryDecision === "stop_until_fixed");
  const reclassifyLegacyKnown =
    checkpoint.failureKind === "unknown" &&
    inferredFailure != null &&
    inferredFailure.failureKind !== "unknown";
  const retryable = recoverLegacyTransient ? true :
    checkpoint.retryable ?? inferredFailure?.retryable;
  return {
    ...checkpoint,
    sourceHash: checkpoint.sourceHash ?? item.sourceHash,
    bookId: checkpoint.bookId ?? item.bookId ?? defaultBookId,
    expectedCommandCheckCount:
      checkpoint.expectedCommandCheckCount ?? expectedCommandCheckCount,
    maxCommandAttempts: checkpoint.maxCommandAttempts ?? maxCommandAttempts,
    maxTransientCommandAttempts:
      checkpoint.maxTransientCommandAttempts ?? maxTransientCommandAttempts,
    maxResumePasses: checkpoint.maxResumePasses ?? maxResumePasses,
    retryBaseDelaySeconds:
      checkpoint.retryBaseDelaySeconds ?? retryBaseDelaySeconds,
    retryMaxDelaySeconds: checkpoint.retryMaxDelaySeconds ?? retryMaxDelaySeconds,
    retryBudgetSeconds: checkpoint.retryBudgetSeconds ?? retryBudgetSeconds,
    commandTimeoutSeconds: checkpoint.commandTimeoutSeconds ?? commandTimeoutSeconds,
    failureKind: recoverLegacyTransient || reclassifyLegacyKnown
      ? inferredFailure?.failureKind
      : checkpoint.failureKind ?? inferredFailure?.failureKind,
    retryable,
    retryExhausted: recoverLegacyTransient ? false : checkpoint.retryExhausted ??
      (checkpoint.status === "failed" && retryable === false ? true : undefined),
    recoveryDecision: recoverLegacyTransient ? "retry_same_run_id" : checkpoint.recoveryDecision ??
      (checkpoint.status === "failed"
        ? (inferredFailure?.retryable ? "retry_same_run_id" : "stop_until_fixed")
        : "none"),
    failedStage: checkpoint.failedStage ?? firstFailedCheck?.name,
    commandChecks,
  };
}
