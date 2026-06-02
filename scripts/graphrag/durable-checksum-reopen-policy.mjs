import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, relative, sep } from "node:path";

const FIXED_CHECKSUM_DECISIONS = new Set([
  "artifact_evidence_checksum_refreshed",
  "graph_output_stats_observability_refreshed",
  "target_new_checksum_old",
  "target_new_checksum_missing",
  "abandoned_pending_commit_recovered",
  "pending_meta_committed",
]);

export function durableChecksumReopenDecision(input) {
  const checkpoint = input?.checkpoint;
  const projectRoot = input?.projectRoot;
  if (checkpoint?.status !== "failed") return notCandidate();
  if (checkpoint.failureKind !== "local_state_integrity") return notCandidate();
  if (checkpoint.retryable !== false) return notCandidate();
  if (checkpoint.recoveryDecision !== "stop_until_fixed") return notCandidate();
  if (checkpoint.localFailureClass !== "durable_checksum_mismatch") return notCandidate();
  const targetLocator = firstNonEmptyString(
    checkpoint.primaryTargetLocator,
    checkpoint.targetLocator,
    checkpoint.metadata?.primaryTargetLocator,
    checkpoint.metadata?.targetLocator,
  );
  if (projectRoot == null || targetLocator == null) {
    return blocked("missing_target_locator");
  }
  const targetPath = resolveProjectLocator(projectRoot, targetLocator);
  if (targetPath == null) return blocked("target_outside_project");
  const checksumPath = `${targetPath}.sha256`;
  const metaPath = `${checksumPath}.meta.json`;
  if (!existsSync(targetPath)) return blocked("target_missing", { targetLocator });
  if (!existsSync(checksumPath)) {
    return blocked("checksum_sidecar_missing", { targetLocator });
  }
  if (!existsSync(metaPath)) {
    return blocked("checksum_meta_missing", { targetLocator });
  }
  let targetBytes;
  let expected;
  let meta;
  try {
    targetBytes = readFileSync(targetPath);
    expected = readFileSync(checksumPath, "utf8").trim();
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return blocked("checksum_evidence_unreadable", { targetLocator });
  }
  const actual = createHash("sha256").update(targetBytes).digest("hex");
  if (!isSha256(expected) || expected !== actual) {
    return blocked("checksum_still_mismatched", {
      targetLocator,
      checksumExpected: expected || undefined,
      checksumActual: actual,
    });
  }
  if (meta?.checksum !== actual) {
    return blocked("checksum_meta_still_mismatched", {
      targetLocator,
      checksumExpected: meta?.checksum,
      checksumActual: actual,
    });
  }
  const fixedDecision = firstNonEmptyString(meta.checksumRecoveryDecision);
  if (!FIXED_CHECKSUM_DECISIONS.has(fixedDecision)) {
    return blocked("checksum_meta_lacks_repair_decision", {
      targetLocator,
      checksumRecoveryDecision: fixedDecision,
    });
  }
  const failureActual = firstNonEmptyString(
    checkpoint.checksumActual,
    checkpoint.metadata?.checksumActual,
  );
  if (failureActual != null && failureActual !== actual) {
    return blocked("fixed_checksum_not_original_failure_actual", {
      targetLocator,
      checksumExpected: failureActual,
      checksumActual: actual,
    });
  }
  return {
    candidate: true,
    reopen: true,
    decision: "reopen_fixed_durable_checksum",
    reason: "checksum_sidecar_matches_current_target_after_explicit_repair",
    targetLocator,
    sidecarTargetLocator: relative(projectRoot, checksumPath).split(sep).join("/"),
    checksumMetaLocator: relative(projectRoot, metaPath).split(sep).join("/"),
    checksum: actual,
    checksumRecoveryDecision: fixedDecision,
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

function firstNonEmptyString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function resolveProjectLocator(projectRoot, locator) {
  if (locator.includes("\0")) return null;
  if (locator.startsWith("/") || locator.split(/[\\/]/).includes("..")) return null;
  const resolved = normalize(join(projectRoot, locator));
  const normalizedRoot = trimTrailingSeparator(normalize(projectRoot));
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${sep}`)) {
    return null;
  }
  return resolved;
}

function trimTrailingSeparator(value) {
  if (value === sep) return value;
  return value.endsWith(sep) ? value.slice(0, -1) : value;
}
