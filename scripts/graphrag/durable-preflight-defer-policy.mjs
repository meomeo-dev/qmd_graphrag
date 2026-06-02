import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";

export function durablePreflightDeferReopenDecision(input) {
  const checkpoint = input?.checkpoint;
  const projectRoot = input?.projectRoot;
  if (checkpoint?.status !== "failed") return notCandidate();
  if (checkpoint.failureKind !== "local_state_integrity") return notCandidate();
  if (checkpoint.retryable !== false) return notCandidate();
  if (checkpoint.recoveryDecision !== "stop_until_fixed") return notCandidate();
  if (checkpoint.localFailureClass !== "durable_preflight_live_lock") {
    return notCandidate();
  }
  if (checkpoint.failedStage !== "before_resume_book") return notCandidate();

  const targetLocator = firstNonEmptyString(
    checkpoint.targetLocator,
    checkpoint.primaryTargetLocator,
    checkpoint.metadata?.targetLocator,
    checkpoint.metadata?.primaryTargetLocator,
    checkpoint.lockOwnerEvidence?.targetLocator,
    checkpoint.metadata?.lockOwnerEvidence?.targetLocator,
  );
  if (projectRoot == null || targetLocator == null) {
    return blocked("missing_target_locator");
  }
  const targetPath = resolveProjectLocator(projectRoot, targetLocator);
  if (targetPath == null) return blocked("target_outside_project", { targetLocator });

  const lockOwner = checkpoint.lockOwnerEvidence ??
    checkpoint.metadata?.lockOwnerEvidence;
  if (!lockOwnerHasDeferralFence(lockOwner)) {
    return blocked("missing_deferral_fence", { targetLocator });
  }
  const lockPath = `${targetPath}.lock`;
  if (existsSync(lockPath)) {
    return blocked("lock_still_present", { targetLocator, lockPath });
  }

  return {
    candidate: true,
    reopen: true,
    decision: "reopen_deferred_durable_preflight_live_lock",
    reason: "before_resume_book_live_lock_released",
    targetLocator,
    lockPath,
    operationId: lockOwner.operationId,
    runnerSessionId: lockOwner.runnerSessionId,
  };
}

function notCandidate() {
  return { candidate: false, reopen: false };
}

function blocked(reason, extra = {}) {
  return {
    candidate: true,
    reopen: false,
    decision: `blocked_${reason}`,
    reason,
    ...extra,
  };
}

function lockOwnerHasDeferralFence(owner) {
  if (owner == null || typeof owner !== "object" || Array.isArray(owner)) {
    return false;
  }
  return typeof owner.runnerSessionId === "string" &&
    owner.runnerSessionId.length > 0 &&
    typeof owner.operationId === "string" &&
    owner.operationId.length > 0;
}

function firstNonEmptyString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function resolveProjectLocator(projectRoot, locator) {
  const normalizedLocator = normalizeProjectLocator(projectRoot, locator);
  if (normalizedLocator == null || normalizedLocator.includes("\0")) return null;
  if (normalizedLocator.startsWith("/") ||
    normalizedLocator.split(/[\\/]/).includes("..")) {
    return null;
  }
  const resolved = normalize(join(projectRoot, normalizedLocator));
  const normalizedRoot = trimTrailingSeparator(normalize(projectRoot));
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${sep}`)) {
    return null;
  }
  return resolved;
}

function normalizeProjectLocator(projectRoot, locator) {
  const value = String(locator);
  const projectRootPrefix = "[PROJECT_ROOT]";
  if (value.startsWith(projectRootPrefix)) {
    return value.slice(projectRootPrefix.length).replace(/^[/\\]+/u, "");
  }
  const normalizedRoot = trimTrailingSeparator(normalize(projectRoot));
  const normalizedValue = normalize(value);
  if (normalizedValue === normalizedRoot) return "";
  if (normalizedValue.startsWith(`${normalizedRoot}${sep}`)) {
    return normalizedValue.slice(normalizedRoot.length + 1);
  }
  return value;
}

function trimTrailingSeparator(value) {
  if (value === sep) return value;
  return value.endsWith(sep) ? value.slice(0, -1) : value;
}
