const OutcomeProjectionFields = new Set([
  "failureKind",
  "retryable",
  "retryExhausted",
  "recoveryDecision",
]);

export function diagnosticProjectionOnly(projection) {
  if (projection == null || typeof projection !== "object") return {};
  return Object.fromEntries(
    Object.entries(projection)
      .filter(([key, value]) =>
        value !== undefined && !OutcomeProjectionFields.has(key)
      ),
  );
}
