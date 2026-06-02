export function shouldScanBookScopedStartupTarget(input = {}) {
  if (input.statusJson === true || input.migrateOnly === true) return true;
  return input.checkpointStatus !== "completed";
}

export function shouldUsePersistedSummaryEvidence(input = {}) {
  if (input.statusJson === true || input.migrateOnly === true) return false;
  return input.itemStatus === "completed";
}
