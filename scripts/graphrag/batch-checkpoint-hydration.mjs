import {
  classifyFailure,
  isLocalArtifactGateFailureText,
} from "./batch-failure-classifier.mjs";

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
  maxProviderRecoveryWaits,
  commandTimeoutSeconds,
  defaultBookId,
}) {
  if (
    checkpoint.metadata?.localArtifactGateRepairCompleted === true &&
    checkpoint.status === "pending"
  ) {
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
      maxProviderRecoveryWaits:
        checkpoint.maxProviderRecoveryWaits ?? maxProviderRecoveryWaits,
      commandTimeoutSeconds: checkpoint.commandTimeoutSeconds ?? commandTimeoutSeconds,
      failedAt: undefined,
      errorSummary: undefined,
      failureKind: undefined,
      retryable: undefined,
      retryExhausted: undefined,
      recoveryDecision: "continue_pending",
      failedStage: undefined,
      nextRetryAt: undefined,
      retryDelaySeconds: undefined,
      commandChecks: [],
      metadata: {
        ...(checkpoint.metadata ?? {}),
        waitingForProviderRecovery: false,
      },
    };
  }
  const commandChecks = (checkpoint.commandChecks ?? []).map((check) => {
    if (check.status !== "failed") return check;
    const failure = classifyFailure(check.errorSummary ?? checkpoint.errorSummary ?? "");
    const knownFailure = failure.failureKind !== "unknown";
    const failureKind = knownFailure
      ? failure.failureKind
      : check.failureKind ?? failure.failureKind;
    const retryable = knownFailure
      ? failure.retryable
      : check.retryable ?? failure.retryable;
    const recoverLegacyTransient = knownFailure && failure.retryable === true;
    const attemptExhausted = recoverLegacyTransient
      ? false
      : check.attemptExhausted ?? true;
    return {
      ...check,
      failureKind,
      retryable,
      retryAfterSeconds: check.retryAfterSeconds ?? failure.retryAfterSeconds,
      attemptExhausted,
      providerStatusCode: check.providerStatusCode ?? failure.providerStatusCode,
      recoveryDecision: knownFailure
        ? (retryable ? "retry_same_run_id" : "stop_until_fixed")
        : check.recoveryDecision ??
          (attemptExhausted ? "stop_until_fixed" :
            retryable ? "retry_same_run_id" : "stop_until_fixed"),
    };
  });
  const firstFailedCheck = commandChecks.find((check) => check.status === "failed");
  const failedCheckTexts = commandChecks
    .map((check) => check.errorSummary)
    .filter(Boolean);
  const latestFailureText = failedCheckTexts.at(-1) ?? checkpoint.errorSummary ?? "";
  const failureText = isLocalArtifactGateFailureText(latestFailureText)
    ? latestFailureText
    : [
        checkpoint.errorSummary,
        ...failedCheckTexts,
      ].filter(Boolean).join("\n");
  const canClassifyCheckpoint =
    checkpoint.status === "failed" ||
    (
      checkpoint.status === "pending" &&
      (checkpoint.errorSummary != null || firstFailedCheck != null)
    );
  const inferredFailure = canClassifyCheckpoint
    ? classifyFailure(failureText)
    : null;
  const knownFailure = inferredFailure != null &&
    inferredFailure.failureKind !== "unknown";
  const retryable = knownFailure
    ? inferredFailure.retryable
    : checkpoint.retryable ?? inferredFailure?.retryable;
  const recoverLegacyTransient = knownFailure && inferredFailure.retryable === true;
  const status = knownFailure && retryable === false ? "failed" : checkpoint.status;
  return {
    ...checkpoint,
    status,
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
    maxProviderRecoveryWaits:
      checkpoint.maxProviderRecoveryWaits ?? maxProviderRecoveryWaits,
    commandTimeoutSeconds: checkpoint.commandTimeoutSeconds ?? commandTimeoutSeconds,
    failureKind: knownFailure
      ? inferredFailure.failureKind
      : checkpoint.failureKind ?? inferredFailure?.failureKind,
    retryable,
    retryExhausted: recoverLegacyTransient
      ? false
      : knownFailure && retryable === false
        ? true
        : checkpoint.retryExhausted ??
          (status === "failed" && retryable === false ? true : undefined),
    recoveryDecision: knownFailure
      ? (retryable ? "retry_same_run_id" : "stop_until_fixed")
      : checkpoint.recoveryDecision ??
        (status === "failed"
          ? (inferredFailure?.retryable ? "retry_same_run_id" : "stop_until_fixed")
          : "none"),
    failedStage: checkpoint.failedStage ?? firstFailedCheck?.name,
    failedAt: status === "failed"
      ? checkpoint.failedAt ?? checkpoint.runnerHeartbeatAt
      : checkpoint.failedAt,
    nextRetryAt: knownFailure && retryable === false
      ? undefined
      : checkpoint.nextRetryAt,
    retryDelaySeconds: knownFailure && retryable === false
      ? undefined
      : checkpoint.retryDelaySeconds,
    metadata: knownFailure && retryable === false
      ? {
          ...(checkpoint.metadata ?? {}),
          waitingForProviderRecovery: false,
          reclassifiedByCurrentFailureClassifier: true,
        }
      : checkpoint.metadata,
    commandChecks,
  };
}
