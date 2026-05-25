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
  if (isProviderTransientFailureText(message)) {
    return {
      failureKind: "transient",
      retryable: true,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  if (isGraphRagDataCompatibilityFailureText(message)) {
    return {
      failureKind: "data_compatibility",
      retryable: false,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  if (isLocalArtifactGateFailureText(message)) {
    return {
      failureKind: "permanent",
      retryable: false,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  return {
    failureKind: "unknown",
    retryable: false,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

export function isProviderTransientFailureText(text) {
  const message = String(text ?? "").toLowerCase();
  return [
    "concurrency limit",
    "partial-output",
    "partial output",
    "no report found for community",
    "community report extraction error",
    "error generating community report",
    "graphrag stage report",
    "rate limit",
    "temporarily unavailable",
    "kind=server_error",
    "kind=rate_limit_exceeded",
    "kind=timeout",
    "stream_read_error",
    "timeout",
    "timed out",
    "service unavailable",
    "gateway timeout",
    "bad gateway",
    "apiconnectionerror",
    "api connection error",
    "connectionerror",
    "connecterror",
    "connecttimeout",
    "readtimeout",
    "clientconnectorerror",
    "serverdisconnectederror",
    "remote protocol error",
    "jin_aiexception",
    "jina_aiexception",
    "jina_ai exception",
    "cannot connect to host",
    "network error",
    "fetch failed",
    "connection reset",
    "connection reset by peer",
    "read reset",
    "connection aborted",
    "connection refused",
    "connection error",
    "socket hang up",
    "ssl error",
    "tls error",
    "temporary failure in name resolution",
    "getaddrinfo",
    "dns",
    "httpx.",
    "aiohttp.",
    "urllib3.",
    "econnreset",
    "econnrefused",
    "enotfound",
    "etimedout",
    "eai_again",
    "eai_nodata",
  ].some((token) => message.includes(token));
}

export function isGraphRagDataCompatibilityFailureText(text) {
  const message = String(text ?? "").toLowerCase();
  return (
    (
      message.includes("create_community_reports_text") ||
      message.includes("community_reports_text") ||
      message.includes("graph rag text-unit context") ||
      message.includes("graphrag text-unit context") ||
      message.includes("community text-unit context")
    ) &&
    (
      message.includes("'float' object is not subscriptable") ||
      message.includes("references missing text units") ||
      message.includes("no resolvable community rows") ||
      message.includes("no resolvable text-unit rows")
    )
  );
}

export function isLocalArtifactGateFailureText(text) {
  const message = String(text ?? "").toLowerCase();
  return (
    message.includes("missingartifactkinds") ||
    message.includes("missing artifact kinds") ||
    message.includes("missingartifactids") ||
    message.includes("missing artifact ids") ||
    message.includes("invalidartifacts") ||
    message.includes("invalid artifacts") ||
    message.includes("did not produce valid book-scoped artifacts") ||
    message.includes("stage_artifact_") ||
    message.includes("graph_output_producer_") ||
    message.includes("bootstrap_stage_requires_real_rebuild") ||
    message.includes("real_graphrag_stage_missing") ||
    message.includes("artifact_identity_mismatch") ||
    message.includes("artifact_stage_mismatch") ||
    message.includes("artifact_kind_not_allowed") ||
    message.includes("content_hash_mismatch") ||
    message.includes("parquet_") ||
    message.includes("lancedb_") ||
    message.includes("producer_run_id_mismatch") ||
    message.includes("stage_fingerprint_mismatch") ||
    message.includes("provider_fingerprint_mismatch") ||
    message.includes("corpus_content_hash_mismatch") ||
    message.includes("artifact_not_book_scoped_graph_output")
  );
}

function extractProviderStatusCode(message) {
  const patterns = [
    /\bhttp\s+([45]\d\d)\b/iu,
    /\bstatus\s+code[:\s-]*([45]\d\d)\b/iu,
    /\bstatus_code[:=\s-]*([45]\d\d)\b/iu,
    /\berror\s+code[:\s-]*([45]\d\d)\b/iu,
    /\berror_code[:=\s-]*([45]\d\d)\b/iu,
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
