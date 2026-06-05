export function classifyFailure(text) {
  const message = String(text).toLowerCase();
  const retryAfterMatch = message.match(/retry-after[:\s-]*(\d+)/iu);
  const retryAfterSeconds = retryAfterMatch
    ? Number.parseInt(retryAfterMatch[1], 10)
    : undefined;
  const durableFailure = classifyLocalDurableStateFailure(message);
  if (durableFailure != null) {
    return {
      ...durableFailure,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  const providerStatusCode = extractProviderStatusCode(message);
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
  if (isSqliteBusyOrLockedFailureText(message)) {
    return {
      failureKind: "transient",
      retryable: true,
      localRetryClass: "sqlite_busy_or_locked",
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

function classifyLocalDurableStateFailure(message) {
  if (isLocalStateLockTimeoutFailureText(message)) {
    return {
      failureKind: "local_state_lock_timeout",
      retryable: false,
      localFailureClass: "durable_state_lock_timeout",
      recoveryDecision: "stop_until_fixed",
    };
  }
  const localFailureClass = localDurableFailureClass(message);
  if (localFailureClass == null) return null;
  return {
    failureKind: "local_state_integrity",
    retryable: false,
    localFailureClass,
    recoveryDecision: "stop_until_fixed",
  };
}

function localDurableFailureClass(message) {
  if (
    message.includes("durable_temp_rename_enoent") ||
    (
      message.includes("enoent") &&
      message.includes("rename") &&
      (
        message.includes(".tmp-") ||
        message.includes("writeyamlfile") ||
        message.includes("writejson") ||
        message.includes("durable")
      )
    )
  ) {
    return "durable_temp_rename_enoent";
  }
  if (
    message.includes("durable_temp_create_collision") ||
    (
      message.includes("eexist") &&
      message.includes(".tmp-") &&
      message.includes("durable")
    )
  ) {
    return "durable_temp_create_collision";
  }
  if (
    message.includes("durable_live_temp_deleted") ||
    (
      message.includes("live temp") &&
      (message.includes("deleted") || message.includes("reconciled"))
    )
  ) {
    return "durable_live_temp_deleted";
  }
  if (
    message.includes("durable_directory_fsync_unsupported") ||
    (
      message.includes("directory fsync") &&
      message.includes("unsupported")
    )
  ) {
    return "durable_directory_fsync_unsupported";
  }
  if (
    message.includes("durable_directory_fsync_uncertain") ||
    message.includes("durable directory fsync failed") ||
    (
      message.includes("directory fsync") &&
      (message.includes("failed") || message.includes("uncertain"))
    )
  ) {
    return "durable_directory_fsync_uncertain";
  }
  if (
    message.includes("durable_fsync_failed") ||
    (
      message.includes("fsync") &&
      message.includes("failed") &&
      message.includes("durable")
    )
  ) {
    return "durable_fsync_failed";
  }
  if (
    message.includes("target_new_checksum_old") ||
    message.includes("target-new/checksum-old")
  ) {
    return "durable_checksum_window_recovered";
  }
  if (
    message.includes("target_new_checksum_missing") ||
    message.includes("target-new/checksum-missing")
  ) {
    return "durable_checksum_missing";
  }
  if (
    message.includes("durable_checksum_mismatch") ||
    message.includes("durable yaml checksum mismatch") ||
    message.includes("durable json target checksum mismatch") ||
    (
      message.includes("checksum_mismatch") &&
      message.includes("durable")
    )
  ) {
    return "durable_checksum_mismatch";
  }
  if (
    message.includes("durable_target_invalid") ||
    message.includes("durable json target invalid") ||
    message.includes("durable yaml target invalid") ||
    message.includes("invalid durable json target") ||
    message.includes("invalid durable yaml target")
  ) {
    return "durable_target_invalid";
  }
  return message.includes("local_state_integrity")
    ? "durable_state_integrity"
    : null;
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

export function isSqliteBusyOrLockedFailureText(text) {
  const message = String(text ?? "").toLowerCase();
  return [
    "sqlite_busy",
    "sqlite_locked",
    "database is locked",
    "database table is locked",
    "database is busy",
  ].some((token) => message.includes(token));
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
    "kind=responses_output_none",
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
    "connection was closed unexpectedly",
    "connection closed unexpectedly",
    "socket hang up",
    "socket connection was closed unexpectedly",
    "socket connection closed",
    "socket closed unexpectedly",
    "ssl error",
    "tls error",
    "certificate verification error",
    "certificate verify failed",
    "cert_verify_failed",
    "ssl certificate",
    "tls certificate",
    "unable to get local issuer certificate",
    "self signed certificate",
    "x509:",
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

export function isLocalStateLockTimeoutFailureText(text) {
  const message = String(text ?? "").toLowerCase();
  return (
    message.includes("timed out waiting for durable yaml lock") ||
    message.includes("timed out waiting for json file lock") ||
    message.includes("timed out waiting for qmd index lock") ||
    message.includes("local_state_lock_timeout")
  );
}

export function isLocalStateIntegrityFailureText(text) {
  const message = String(text ?? "").toLowerCase();
  return localDurableFailureClass(message) != null;
}

export function isLocalArtifactGateFailureText(text) {
  const message = String(text ?? "").toLowerCase();
  return (
    message.includes("query_ready requires completed graph_extract") ||
    message.includes("query_ready checkpoint requires completed graphrag producer stages") ||
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
