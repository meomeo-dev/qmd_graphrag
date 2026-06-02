const defaultClaimPreflightDelayMs = 1000;
const maxClaimPreflightDelayMs = 5000;
const deferrableDurablePreflightStages = new Set([
  "before_claim",
  "before_resume_book",
]);

export class ClaimPreflightDeferredError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ClaimPreflightDeferredError";
    this.evidence = options.evidence;
    this.delayMs = options.delayMs ?? defaultClaimPreflightDelayMs;
  }
}

export function claimPreflightBlockerCanDefer(stage, blocker) {
  if (!deferrableDurablePreflightStages.has(stage)) return false;
  if (blocker?.localFailureClass !== "durable_preflight_live_lock") return false;
  if (blocker?.reason !== "lock_owner_live_or_unexpired") return false;
  const owner = blocker.lockOwnerEvidence;
  if (owner == null || typeof owner !== "object" || Array.isArray(owner)) {
    return false;
  }
  return typeof owner.runnerSessionId === "string" &&
    owner.runnerSessionId.length > 0 &&
    typeof owner.operationId === "string" &&
    owner.operationId.length > 0;
}

export function claimPreflightDelayMs(blocker, nowMs = Date.now()) {
  const expiresAtMs = Date.parse(String(blocker?.lockOwnerEvidence?.expiresAt ?? ""));
  if (!Number.isFinite(expiresAtMs)) return defaultClaimPreflightDelayMs;
  const remainingMs = Math.max(0, expiresAtMs - nowMs);
  return Math.min(
    maxClaimPreflightDelayMs,
    Math.max(defaultClaimPreflightDelayMs, Math.ceil(remainingMs / 20)),
  );
}

export function claimPreflightDeferralKey(error) {
  const evidence = error?.evidence ?? {};
  return [
    evidence.targetLocator ?? "unknown-target",
    evidence.operationId ?? "unknown-operation",
  ].join(":");
}
