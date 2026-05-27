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
  const typedQueryFailure = classifyTypedQueryFailure(text);
  if (typedQueryFailure != null) {
    return {
      ...typedQueryFailure,
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

function classifyTypedQueryFailure(text) {
  const payload = parseTypedQueryErrorPayload(text);
  if (payload == null) return null;
  if (
    payload.provider === "graphrag" &&
    payload.stage === "graphrag_query" &&
    payload.capability === "graph_query" &&
    payload.code === "provider_unavailable"
  ) {
    return { failureKind: "transient", retryable: true };
  }
  if (payload.retryable === true) {
    return { failureKind: "transient", retryable: true };
  }
  return null;
}

function parseTypedQueryErrorPayload(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  for (const candidate of jsonObjectCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.schemaVersion === "1.0.0" &&
        typeof parsed.route === "string" &&
        typeof parsed.stage === "string" &&
        typeof parsed.code === "string" &&
        typeof parsed.retryable === "boolean"
      ) {
        return parsed;
      }
    } catch {
      // Keep scanning: command stderr can wrap a JSON payload in extra text.
    }
  }
  return null;
}

function jsonObjectCandidates(raw) {
  const candidates = [raw];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  return [...new Set(candidates)];
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
    "an error occurred while processing your request. you can retry your request",
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
    "ssl",
    "unexpected_eof_while_reading",
    "eof occurred in violation of protocol",
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
    message.includes("artifact_not_book_scoped_graph_output") ||
    message.includes("graphrag document identity is missing for query_ready") ||
    message.includes("graphrag document identity sidecar evidence is invalid for query_ready") ||
    message.includes("graphrag document identity sidecar does not match query_ready") ||
    message.includes("graph_vault/settings.yaml is not the managed projection of .qmd/index.yml") ||
    message.includes("capabilityscope references unknown or not-ready graphcapabilityid") ||
    message.includes("no graph_query capability is ready for book")
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
