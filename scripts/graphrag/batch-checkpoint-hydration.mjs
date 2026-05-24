import { classifyFailure } from "./batch-failure-classifier.mjs";

export function hydrateBatchCheckpoint({
  item,
  checkpoint,
  expectedCommandCheckCount,
  maxCommandAttempts,
  defaultBookId,
}) {
  const commandChecks = (checkpoint.commandChecks ?? []).map((check) => {
    if (check.status !== "failed") return check;
    const failure = classifyFailure(check.errorSummary ?? checkpoint.errorSummary ?? "");
    return {
      ...check,
      failureKind: check.failureKind ?? failure.failureKind,
      retryable: check.retryable ?? failure.retryable,
      retryAfterSeconds: check.retryAfterSeconds ?? failure.retryAfterSeconds,
      attemptExhausted: check.attemptExhausted ?? true,
      providerStatusCode: check.providerStatusCode ?? failure.providerStatusCode,
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
  return {
    ...checkpoint,
    sourceHash: checkpoint.sourceHash ?? item.sourceHash,
    bookId: checkpoint.bookId ?? item.bookId ?? defaultBookId,
    expectedCommandCheckCount:
      checkpoint.expectedCommandCheckCount ?? expectedCommandCheckCount,
    maxCommandAttempts: checkpoint.maxCommandAttempts ?? maxCommandAttempts,
    failureKind: checkpoint.failureKind ?? inferredFailure?.failureKind,
    retryable: checkpoint.retryable ?? inferredFailure?.retryable,
    retryExhausted: checkpoint.retryExhausted ??
      (checkpoint.status === "failed" ? true : undefined),
    recoveryDecision: checkpoint.recoveryDecision ??
      (checkpoint.status === "failed"
        ? (inferredFailure?.retryable ? "retry_same_run_id" : "stop_until_fixed")
        : "none"),
    failedStage: checkpoint.failedStage ?? firstFailedCheck?.name,
    commandChecks,
  };
}
