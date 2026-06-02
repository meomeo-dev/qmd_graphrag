import { describe, expect, test } from "vitest";

import {
  scanEventLogRecoveryNeed,
} from "../scripts/graphrag/event-log-recovery-policy.mjs";

const RunId = "event-log-scan-fixture";
const SchemaVersion = "1.0.0";

function eventLine(overrides = {}) {
  return JSON.stringify({
    schemaVersion: SchemaVersion,
    runId: RunId,
    eventId: "evt-1",
    sequence: 1,
    runnerSessionId: "runner-1",
    event: "batch_started",
    at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("GraphRAG runner event log recovery policy", () => {
  test("skips full recovery for canonical event logs", () => {
    const scan = scanEventLogRecoveryNeed([
      eventLine(),
      eventLine({
        eventId: "evt-2",
        sequence: 2,
        event: "batch_runner_configured",
      }),
      "",
    ], { runId: RunId, schemaVersion: SchemaVersion });

    expect(scan).toMatchObject({
      needsRecovery: false,
      retainedEventCount: 2,
      reason: "event_log_already_canonical",
    });
  });

  test("requires recovery for partial json tails", () => {
    expect(scanEventLogRecoveryNeed([
      eventLine(),
      "{\"schemaVersion\":",
    ], { runId: RunId, schemaVersion: SchemaVersion })).toMatchObject({
      needsRecovery: true,
      reason: "invalid_json_line",
      retainedEventCount: 1,
    });
  });

  test("requires recovery for duplicate ids and sequence drift", () => {
    expect(scanEventLogRecoveryNeed([
      eventLine(),
      eventLine({ sequence: 2 }),
    ], { runId: RunId, schemaVersion: SchemaVersion })).toMatchObject({
      needsRecovery: true,
      reason: "duplicate_event_id",
    });

    expect(scanEventLogRecoveryNeed([
      eventLine(),
      eventLine({ eventId: "evt-2", sequence: 5 }),
    ], { runId: RunId, schemaVersion: SchemaVersion })).toMatchObject({
      needsRecovery: true,
      reason: "non_monotonic_sequence",
    });
  });

  test("requires recovery when required runner fields are missing", () => {
    expect(scanEventLogRecoveryNeed([
      eventLine({ runnerSessionId: undefined }),
    ], { runId: RunId, schemaVersion: SchemaVersion })).toMatchObject({
      needsRecovery: true,
      reason: "missing_runner_session_id",
    });
  });
});
