export function classifyFailure(text) {
  const message = String(text).toLowerCase();
  const providerStatusCode = extractProviderStatusCode(message);
  const retryAfterMatch = message.match(/retry-after[:\s-]*(\d+)/iu);
  const retryAfterSeconds = retryAfterMatch
    ? Number.parseInt(retryAfterMatch[1], 10)
    : undefined;
  if (
    providerStatusCode === 429 ||
    (providerStatusCode != null &&
      providerStatusCode >= 500 &&
      providerStatusCode <= 599)
  ) {
    return {
      failureKind: "transient",
      retryable: true,
      providerStatusCode,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  if (
    providerStatusCode != null &&
    providerStatusCode >= 400 &&
    providerStatusCode <= 499
  ) {
    return {
      failureKind: "permanent",
      retryable: false,
      providerStatusCode,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  const transient =
    message.includes("concurrency limit") ||
    message.includes("partial-output") ||
    message.includes("partial output") ||
    message.includes("no report found for community") ||
    message.includes("community report extraction error") ||
    message.includes("error generating community report") ||
    message.includes("graphrag stage report") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("service unavailable") ||
    message.includes("gateway timeout") ||
    message.includes("bad gateway") ||
    message.includes("network error") ||
    message.includes("fetch failed") ||
    message.includes("connection reset") ||
    message.includes("connection aborted") ||
    message.includes("connection refused") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("eai_again");
  if (transient) {
    return {
      failureKind: "transient",
      retryable: true,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  return {
    failureKind: "unknown",
    retryable: false,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

function extractProviderStatusCode(message) {
  const patterns = [
    /\bhttp\s+([45]\d\d)\b/iu,
    /\bstatus\s+code[:\s-]*([45]\d\d)\b/iu,
    /\berror\s+code[:\s-]*([45]\d\d)\b/iu,
    /\bstatus[:\s-]*([45]\d\d)\b/iu,
    /\bcode[:\s-]*([45]\d\d)\b/iu,
    /\(([45]\d\d)\)/iu,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return Number.parseInt(match[1], 10);
  }
  return undefined;
}
