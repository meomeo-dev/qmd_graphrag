import { readFileSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { describe, expect, test } from "vitest";
import {
  mkProjectTmpDir,
  runBatchStatusJson,
  writeCompletedGraphBatchFixture,
  writeDurableJsonFixture,
  writeProviderAuthStoppedBatchFixture,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG EPUB batch runner - Provider Auth Reopen Policy", () => {
  test("ready auth can repeat an already reopened fingerprint after not-ready refailure", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-auth-repeat-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-auth-repeat";
    const { itemId } = await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });

    const readyResult = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
    });
    expect(readyResult.exitCode).toBe(0);
    const readySummary = JSON.parse(readyResult.stdout);
    const currentFingerprint =
      readySummary.items[0].currentProviderAuthFingerprint;
    expect(typeof currentFingerprint).toBe("string");

    const checkpointPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    checkpoint.metadata = {
      ...(checkpoint.metadata ?? {}),
      providerAuthFailureFingerprint: "shadowed-provider-auth-fingerprint",
      providerAuthReadinessStatus: "process_env_shadows_dotenv",
      providerAuthReopenedFingerprints: [currentFingerprint],
      providerAuthReopenAttemptCount: 1,
      lastProviderAuthReopenFingerprint: currentFingerprint,
      providerAuthReopenDecision: "blocked_provider_auth_fingerprint_unchanged",
      providerAuthReopenEligible: false,
      providerAuthReopenBlockedReason:
        "current_provider_auth_fingerprint_matches_failure",
    };
    await writeDurableJsonFixture(checkpointPath, checkpoint);

    const result = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
    });

    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      providerAuthReopenDecision: "reopen_provider_auth_config_changed",
      providerAuthReopenEligible: true,
      providerAuthReopenReason: "provider_auth_config_changed_key_present",
      providerAuthConfigChanged: true,
      providerAuthFailureFingerprint: "shadowed-provider-auth-fingerprint",
      currentProviderAuthFingerprint: currentFingerprint,
      providerAuthReadinessStatus: "ready",
      providerAuthReopenAttemptCount: 1,
    });
    expect(summary.items[0].providerAuthReopenBlockedReason).toBeUndefined();
  });

  test("status-json does not project stale durable metadata on completed item", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-completed-durable-stale-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "completed-durable-stale";
    const { itemId } = await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "completed stale durable projection",
    });

    const checkpointPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    checkpoint.metadata = {
      ...(checkpoint.metadata ?? {}),
      failureKind: "local_state_integrity",
      localFailureClass: "durable_checksum_missing",
      recoveryDecision: "stop_until_fixed",
      targetLocator: "graph_vault/catalog/provider-requests/old.json",
    };
    await writeDurableJsonFixture(checkpointPath, checkpoint);

    const result = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
    });

    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({ status: "completed" });
    expect(summary.items[0].failureKind).toBeUndefined();
    expect(summary.items[0].localFailureClass).toBeUndefined();
    expect(summary.items[0].targetLocator).toBeUndefined();
    expect(summary.items[0].recoveryDecision).toBe("none");
  });
});
