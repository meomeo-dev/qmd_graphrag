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
    return {
      ...check,
      failureKind: check.failureKind ?? failure.failureKind,
      retryable: check.retryable ?? failure.retryable,
      retryAfterSeconds: check.retryAfterSeconds ?? failure.retryAfterSeconds,
      attemptExhausted,
      providerStatusCode: check.providerStatusCode ?? failure.providerStatusCode,
      recoveryDecision: check.recoveryDecision ??
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
  const retryable = checkpoint.retryable ?? inferredFailure?.retryable;
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
    failureKind: checkpoint.failureKind ?? inferredFailure?.failureKind,
    retryable,
    retryExhausted: checkpoint.retryExhausted ??
      (checkpoint.status === "failed" && retryable === false ? true : undefined),
    recoveryDecision: checkpoint.recoveryDecision ??
      (checkpoint.status === "failed"
        ? (inferredFailure?.retryable ? "retry_same_run_id" : "stop_until_fixed")
        : "none"),
    failedStage: checkpoint.failedStage ?? firstFailedCheck?.name,
    commandChecks,
  };
}
