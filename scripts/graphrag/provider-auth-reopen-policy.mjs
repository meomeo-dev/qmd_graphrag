const READY_STATUS = "ready";

export function alreadyReopenedFingerprintCanRepeat(input) {
  const currentFingerprint = nonEmptyString(input.currentFingerprint);
  const failureFingerprint = nonEmptyString(input.failureFingerprint);
  if (currentFingerprint == null) return false;
  if (failureFingerprint === currentFingerprint) return false;
  if (!Array.isArray(input.reopenedFingerprints)) return false;
  if (!input.reopenedFingerprints.includes(currentFingerprint)) return false;
  const latestFailureReadinessStatus = nonEmptyString(
    input.latestFailureReadinessStatus,
  );
  return latestFailureReadinessStatus != null &&
    latestFailureReadinessStatus !== READY_STATUS;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
