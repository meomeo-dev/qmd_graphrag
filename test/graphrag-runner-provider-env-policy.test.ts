import { describe, expect, test } from "vitest";
import { rm } from "fs/promises";
import { join } from "path";
import {
  mkProjectTmpDir,
  runBatchStatusJson,
  writeProviderAuthStoppedBatchFixture,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG EPUB batch runner - Provider Env Policy", () => {
  test("status-json uses graph_vault dotenv over stale shell provider env", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-env-policy-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-env-policy";
    await writeProviderAuthStoppedBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
    });

    const result = await runBatchStatusJson({
      tmpRoot,
      sourceDir,
      stateRoot,
      logRoot,
      configDir,
      runId,
      env: {
        OPENAI_API_KEY: "stale-shell-openai-key",
        OPENAI_BASE_URL: "https://stale.openai.example",
        JINA_API_KEY: "stale-shell-jina-key",
        JINA_API_BASE: "https://stale.jina.example",
      },
    });

    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      providerAuthReopenDecision: "reopen_legacy_provider_auth_key_present",
      providerAuthReopenEligible: true,
      providerAuthReadinessStatus: "ready",
      providerAuthCredentialSources: {
        OPENAI_API_KEY: "graph_vault_dotenv_overrides_shell_env",
        OPENAI_BASE_URL: "graph_vault_dotenv_overrides_shell_env",
        JINA_API_KEY: "graph_vault_dotenv_overrides_shell_env",
        JINA_API_BASE: "graph_vault_dotenv_overrides_shell_env",
      },
    });
    expect(summary.items[0].providerAuthShadowedEnvNames ?? []).toEqual([]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("stale-shell-openai-key");
    expect(serialized).not.toContain("file-openai-key");
    expect(serialized).not.toContain("https://stale.openai.example");
    expect(serialized).not.toContain("https://api.openai.example");
  });
});
