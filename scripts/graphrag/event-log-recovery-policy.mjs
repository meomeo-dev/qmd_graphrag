export function scanEventLogRecoveryNeed(lines, options = {}) {
  const { runId, schemaVersion } = options;
  const seenEventIds = new Set();
  let retainedEventCount = 0;
  let lineIndex = 0;

  for (const line of lines) {
    lineIndex += 1;
    if (!line.trim()) continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return recoveryNeeded("invalid_json_line", lineIndex, retainedEventCount);
    }

    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return recoveryNeeded("invalid_event_object", lineIndex, retainedEventCount);
    }

    retainedEventCount += 1;

    if (schemaVersion != null && parsed.schemaVersion !== schemaVersion) {
      return recoveryNeeded(
        "schema_version_mismatch",
        lineIndex,
        retainedEventCount,
      );
    }
    if (runId != null && parsed.runId !== runId) {
      return recoveryNeeded("run_id_mismatch", lineIndex, retainedEventCount);
    }
    if (typeof parsed.event !== "string" || parsed.event.trim() === "") {
      return recoveryNeeded("missing_event_name", lineIndex, retainedEventCount);
    }
    if (typeof parsed.at !== "string" || parsed.at.trim() === "") {
      return recoveryNeeded("missing_event_time", lineIndex, retainedEventCount);
    }
    if (typeof parsed.eventId !== "string" || parsed.eventId.trim() === "") {
      return recoveryNeeded("missing_event_id", lineIndex, retainedEventCount);
    }
    if (seenEventIds.has(parsed.eventId)) {
      return recoveryNeeded("duplicate_event_id", lineIndex, retainedEventCount);
    }
    if (parsed.sequence !== retainedEventCount) {
      return recoveryNeeded("non_monotonic_sequence", lineIndex, retainedEventCount);
    }
    if (
      typeof parsed.runnerSessionId !== "string" ||
      parsed.runnerSessionId.trim() === ""
    ) {
      return recoveryNeeded(
        "missing_runner_session_id",
        lineIndex,
        retainedEventCount,
      );
    }

    seenEventIds.add(parsed.eventId);
  }

  return {
    needsRecovery: false,
    retainedEventCount,
    reason: "event_log_already_canonical",
  };
}

function recoveryNeeded(reason, lineIndex, retainedEventCount) {
  return {
    needsRecovery: true,
    retainedEventCount,
    reason,
    diagnostics: [{ lineIndex, reason }],
  };
}
