export function lockOwnerPid(owner) {
  const pid = Number.parseInt(String(owner?.ownerPid ?? owner?.pid ?? ""), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function lockOwnerHost(owner) {
  return String(owner?.ownerHost ?? owner?.runnerHost ?? owner?.host ?? "");
}

export function lockOwnerIsLocal(owner, localHost) {
  const host = lockOwnerHost(owner);
  return host === "" || host === localHost;
}

export function lockOwnerExpired(owner, entry, fallbackTtlMs, nowMs = Date.now()) {
  const expiresAt = Date.parse(String(owner?.expiresAt ?? ""));
  return Number.isFinite(expiresAt)
    ? nowMs > expiresAt
    : nowMs - entry.mtimeMs > fallbackTtlMs;
}

export function lockOwnerHasRecoveryFence(owner) {
  return Number.isInteger(owner?.generation) &&
    typeof owner?.fencingTokenHash === "string" &&
    owner.fencingTokenHash.length > 0 &&
    typeof owner?.runnerSessionId === "string" &&
    owner.runnerSessionId.length > 0 &&
    typeof owner?.operationId === "string" &&
    owner.operationId.length > 0;
}

export function staleLockRecoveryDecision({
  owner,
  entry,
  localHost,
  processAlive,
  fallbackTtlMs,
  nowMs = Date.now(),
}) {
  const pid = lockOwnerPid(owner);
  const ownerLocal = lockOwnerIsLocal(owner, localHost);
  const expired = lockOwnerExpired(owner, entry, fallbackTtlMs, nowMs);
  const hasFence = lockOwnerHasRecoveryFence(owner);
  const alive = ownerLocal && pid != null ? processAlive(pid) : false;
  const deadSameHostOwner = ownerLocal && pid != null && !alive;
  const recoverable = hasFence && ownerLocal && !alive &&
    (expired || deadSameHostOwner);
  const needsFence = expired || deadSameHostOwner;
  return {
    recoverable,
    expired,
    hasFence,
    alive,
    deadSameHostOwner,
    ownerLocal,
    pid,
    reason: recoverable
      ? "stale_lock_removed"
      : needsFence && !hasFence
        ? "stale_lock_recovery_fence_missing"
        : "lock_owner_live_or_unexpired",
  };
}
