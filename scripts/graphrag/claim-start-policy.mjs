const claimStableFields = [
  "status",
  "attempts",
  "completedAt",
  "failedAt",
  "runnerSessionId",
  "runnerHeartbeatAt",
];

export function claimStartCheckpointChanged(current, expected) {
  if (current == null || expected == null) return false;
  return claimStableFields.some((field) => current[field] !== expected[field]);
}

export function claimStartConflictMetadata(current, expected) {
  const changedFields = claimStableFields
    .filter((field) => current?.[field] !== expected?.[field]);
  return {
    reason: "checkpoint_changed_before_item_start",
    changedFields,
    currentStatus: current?.status,
    expectedStatus: expected?.status,
    currentAttempts: current?.attempts,
    expectedAttempts: expected?.attempts,
    currentRecoveryDecision: current?.recoveryDecision,
    expectedRecoveryDecision: expected?.recoveryDecision,
  };
}
