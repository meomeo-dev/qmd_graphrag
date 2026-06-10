import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import YAML from "yaml";

import { SchemaVersion } from "../src/contracts/common.js";
import { buildDspyRuntimeFingerprints } from "../src/dspy/fingerprints.js";
import {
  DspyPointerLockError,
  DspyPolicyStore,
} from "../src/dspy/policy-store.js";
import { writeDurableYamlFixture } from "./helpers/graphrag-runner-harness.ts";

async function makeVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qmd-dspy-policy-"));
}

function record(query: string) {
  return {
    query,
    output: [
      { type: "lex" as const, text: `${query} keywords` },
      { type: "vec" as const, text: `${query} semantic phrase` },
    ],
  };
}

async function writeRecords(path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify(record("hexagonal architecture"))}\n`, "utf8");
}

describe("DSPy policy store", () => {
  test("rejects absolute paths as vault-relative scalar values", () => {
    const store = new DspyPolicyStore({ graphVault: "/tmp/graph_vault" });
    expect(() => store.resolvePath("/tmp/outside.yaml")).toThrow(/vault-relative/);
    expect(() => store.resolvePath("../outside.yaml")).toThrow(/vault-relative/);
    expect(() => store.resolvePath("~/outside.yaml")).toThrow(/vault-relative/);
    expect(() => store.resolvePath("file:artifact.yaml")).toThrow(/vault-relative/);
    expect(() => store.resolvePath("mailto:foo")).toThrow(/vault-relative/);
    expect(() => store.resolvePath("C:artifact.yaml")).toThrow(/vault-relative/);
  });

  test("writes artifact, report, promotion pointer, and online expansion", async () => {
    const vault = await makeVault();
    const sourceDir = join(vault, "source");
    await mkdir(sourceDir, { recursive: true });
    const emitPath = join(sourceDir, "generated.jsonl");
    const promptPath = join(sourceDir, "prompt.txt");
    await writeRecords(emitPath);
    await writeFile(promptPath, "expand queries", "utf8");

    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
        savePromptPath: promptPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        savedPromptPath: promptPath,
        stdoutTail: [`wrote ${emitPath} Bearer opaque-redaction-marker`],
      },
      fingerprints: {},
    });

    const report = store.evaluateExpansionPolicy({
      artifactPath: result.artifactPath,
    });
    const reportPath = `dspy/reports/${report.reportId}.yaml`;
    const decision = store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath,
      reason: "test promotion",
    });

    expect(decision.promotionStatus).toBe("promoted");
    expect(existsSync(join(vault, store.pointerRelativePath()))).toBe(true);
    const runBody = readFileSync(join(vault, result.runPath), "utf8");
    expect(runBody).not.toContain(vault);
    expect(runBody).not.toContain("opaque-redaction-marker");
    expect(runBody).toContain("requestFingerprint:");

    const expanded = store.expandQuery("hexagonal architecture");
    expect(expanded.status).toBe("expanded");
    if (expanded.status === "expanded") {
      expect(expanded.expansions.map((item) => item.type)).toEqual(["lex", "vec"]);
    }
  });

  test("keeps artifact identity stable across source path relocations", async () => {
    const vault = await makeVault();
    const left = join(vault, "left");
    const right = join(vault, "right");
    await mkdir(left, { recursive: true });
    await mkdir(right, { recursive: true });
    const leftEmit = join(left, "generated.jsonl");
    const rightEmit = join(right, "generated.jsonl");
    const leftTrain = join(left, "train.jsonl");
    const rightTrain = join(right, "train.jsonl");
    await writeRecords(leftEmit);
    await writeRecords(rightEmit);
    await writeFile(leftTrain, JSON.stringify({ query: "hexagonal architecture" }), "utf8");
    await writeFile(rightTrain, JSON.stringify({ query: "hexagonal architecture" }), "utf8");

    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const first = store.writeOptimizationArtifact({
      runId: "run-a",
      request: {
        optimizer: "gepa",
        trainsetPath: leftTrain,
        model: "openai/gpt-5.4",
        emitPath: leftEmit,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath: leftEmit,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const second = store.writeOptimizationArtifact({
      runId: "run-b",
      request: {
        optimizer: "gepa",
        trainsetPath: rightTrain,
        model: "openai/gpt-5.4",
        emitPath: rightEmit,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath: rightEmit,
        stdoutTail: [],
      },
      fingerprints: {},
    });

    expect(first.artifact.artifactId).toBe(second.artifact.artifactId);
    expect(first.artifactPath).toBe(second.artifactPath);
    expect(first.run.runId).toBe("run-a");
    expect(second.run.runId).toBe("run-b");
  });

  test("keeps synthetic import artifact identity stable across repeated imports", async () => {
    const vault = await makeVault();
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const records = [record("hexagonal architecture")];

    const first = store.writeSyntheticArtifact({ records });
    const second = store.writeSyntheticArtifact({ records });

    expect(first.artifact.artifactId).toBe(second.artifact.artifactId);
    expect(first.artifactPath).toBe(second.artifactPath);
    expect(first.artifact.generatedExpansionPath).toBe(
      second.artifact.generatedExpansionPath,
    );
  });

  test("fails closed on invalid artifact hash", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
        provider: {
          apiKeyEnv: "OPENAI_API_KEY",
          baseUrlEnv: "OPENAI_BASE_URL",
          endpoint: "/responses",
          stream: true,
          model: "gpt-5.4",
          reasoningEffort: "medium",
          strictStructuredOutput: true,
        },
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const report = store.evaluateExpansionPolicy({
      artifactPath: result.artifactPath,
    });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });

    const artifactFile = join(vault, result.artifact.generatedExpansionPath!);
    await writeFile(artifactFile, `${readFileSync(artifactFile, "utf8")}tamper\n`, "utf8");

    const expanded = store.expandQuery("hexagonal architecture");
    expect(expanded.status).toBe("strict_refuse");
    if (expanded.status === "strict_refuse") {
      expect(expanded.reason).toBe("artifact_invalid");
    }
  });

  test("disable and rollback preserve pointer transitions", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });

    const disabled = store.disableExpansionPolicy();
    expect(disabled.active).toBe(false);
    expect(store.expandQuery("hexagonal architecture").status).toBe("fallback");

    const disabledAgain = store.disableExpansionPolicy();
    expect(disabledAgain).toEqual(disabled);
    expect(store.expandQuery("hexagonal architecture").status).toBe("fallback");

    const rolledBack = store.rollbackExpansionPolicy();
    expect(rolledBack.active).toBe(true);
    expect(store.expandQuery("hexagonal architecture").status).toBe("expanded");
  });

  test("fails pointer mutations with a typed lock error when writer lock exists", async () => {
    const vault = await makeVault();
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    mkdirSync(store.pointerLockPath(), { recursive: true });

    try {
      expect(() => store.disableExpansionPolicy()).toThrow(DspyPointerLockError);
    } finally {
      rmSync(store.pointerLockPath(), { recursive: true, force: true });
    }

    mkdirSync(store.pointerLockPath(), { recursive: true });
    try {
      store.disableExpansionPolicy();
    } catch (error) {
      expect(error).toBeInstanceOf(DspyPointerLockError);
      const payload = (error as DspyPointerLockError).payload;
      expect(payload.code).toBe("dspy_pointer_lock_unavailable");
      expect(payload.pointerPath).toBe(store.pointerRelativePath());
      expect(payload.lockPath).toBe(store.pointerLockRelativePath());
    } finally {
      rmSync(store.pointerLockPath(), { recursive: true, force: true });
    }
  });

  test("rollback from disabled restores only the current disable transition", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });

    store.disableExpansionPolicy();
    expect(store.rollbackExpansionPolicy().provider).toBe("dspy");
    expect(store.rollbackExpansionPolicy().provider).toBe("builtin");
    store.disableExpansionPolicy();

    expect(() => store.rollbackExpansionPolicy()).toThrow(
      /no active DSPy policy pointer to rollback/,
    );
    expect(store.loadPointer()?.provider).toBe("disabled");
  });

  test("rollback after first promotion returns to builtin pointer", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });

    const rolledBack = store.rollbackExpansionPolicy();
    expect(rolledBack.provider).toBe("builtin");
    expect(rolledBack.active).toBe(false);
    expect(store.expandQuery("hexagonal architecture").status).toBe("fallback");
  });

  test("restores previous pointer after CLI-side config write failure", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });
    const previousPointer = store.loadPointer();

    store.disableExpansionPolicy();
    expect(store.loadPointer()?.provider).toBe("disabled");
    store.restorePointerForCliFailure(previousPointer, "config write failed");

    expect(store.loadPointer()).toEqual(previousPointer);
    expect(store.expandQuery("hexagonal architecture").status).toBe("expanded");
  });

  test("resolves promoted policy after graph_vault relocation", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });

    const relocatedParent = await makeVault();
    const relocatedVault = join(relocatedParent, "copied_graph_vault");
    await cp(vault, relocatedVault, { recursive: true });
    const relocatedStore = new DspyPolicyStore({
      graphVault: relocatedVault,
      actor: "test",
    });

    const expanded = relocatedStore.expandQuery("hexagonal architecture");
    expect(expanded.status).toBe("expanded");
  });

  test("registers metric specs and evaluation datasets in graph_vault", async () => {
    const vault = await makeVault();
    const trainsetPath = join(vault, "train.jsonl");
    const valsetPath = join(vault, "val.jsonl");
    await writeRecords(trainsetPath);
    await writeRecords(valsetPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });

    const metric = store.writeMetricSpec({
      metricVersion: "metric-v1",
      description: "schema-valid query expansion metric",
      maxMetricCalls: 12,
      maxExpansionItems: 5,
    });
    const dataset = store.writeEvaluationDataset({
      datasetId: "dataset-v1",
      trainsetPath,
      valsetPath,
    });

    expect(existsSync(join(vault, metric.path))).toBe(true);
    expect(existsSync(join(vault, dataset.path))).toBe(true);
    expect(store.loadMetricSpec("metric-v1")?.maxExpansionItems).toBe(5);
    expect(store.loadEvaluationDataset("dataset-v1")?.queryCount).toBe(2);
    expect(dataset.value.trainsetPath).toMatch(/^dspy\/dataset-files\//);
    expect(dataset.value.valsetHash).toBeTruthy();
  });

  test("applies registered metric and dataset during artifact evaluation", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    const trainsetPath = join(vault, "train.jsonl");
    await writeRecords(emitPath);
    await writeRecords(trainsetPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const metric = store.writeMetricSpec({
      metricVersion: "metric-v1",
      description: "schema-valid query expansion metric",
      maxExpansionItems: 3,
    });
    store.writeEvaluationDataset({
      datasetId: "dataset-v1",
      trainsetPath,
    });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath,
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
      metricSpec: metric.value,
    });

    const report = store.evaluateExpansionPolicy({
      artifactPath: result.artifactPath,
      datasetId: "dataset-v1",
      metricVersion: "metric-v1",
    });

    expect(result.artifact.metricVersion).toBe("metric-v1");
    expect(result.artifact.maxExpansionItems).toBe(3);
    expect(report.datasetId).toBe("dataset-v1");
    expect(report.metricVersion).toBe("metric-v1");
    expect(report.metrics.dataset_query_count).toBe(1);
  });

  test("honors configured pointer_ref and preserves native fallback for missing pointer", async () => {
    const vault = await makeVault();
    const store = new DspyPolicyStore({
      graphVault: vault,
      pointerPath: "graph_vault/dspy/policies/query-expansion/current.yaml",
      failurePolicy: {
        schemaVersion: SchemaVersion,
        defaultAction: "strict_refuse",
        reasonActions: {},
        strictSchema: true,
      },
    });
    expect(store.pointerRelativePath()).toBe("dspy/policies/query-expansion/current.yaml");
    const result = store.expandQuery("missing pointer");
    expect(result.status).toBe("fallback");
    expect(result.reason).toBe("pointer_missing");
  });

  test("requires active pointer to reference a promoted decision", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    const decision = store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });
    const decisionPath = join(vault, "dspy", "promotions", `${decision.decisionId}.yaml`);
    await writeDurableYamlFixture(decisionPath, {
      ...YAML.parse(readFileSync(decisionPath, "utf8")),
      promotionStatus: "rejected",
    });

    const unavailable = store.expandQuery("hexagonal architecture");
    expect(unavailable.status).toBe("fallback");
    expect(unavailable.reason).toBe("policy_unavailable");
  });

  test("requires pointer decision id to match the loaded promoted decision", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });
    const pointerPath = join(vault, store.pointerRelativePath());
    await writeDurableYamlFixture(pointerPath, {
      ...YAML.parse(readFileSync(pointerPath, "utf8")),
      currentDecisionId: "dspy-decision-mismatch",
    });

    const unavailable = store.expandQuery("hexagonal architecture");
    expect(unavailable.status).toBe("fallback");
    expect(unavailable.reason).toBe("policy_unavailable");
  });

  test("fails closed when a promoted decision references a mismatched artifact hash", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    const decision = store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });
    const decisionPath = join(vault, "dspy", "promotions", `${decision.decisionId}.yaml`);
    await writeDurableYamlFixture(decisionPath, {
      ...YAML.parse(readFileSync(decisionPath, "utf8")),
      artifactHash: "mismatched-artifact-hash",
    });

    const refused = store.expandQuery("hexagonal architecture");
    expect(refused.status).toBe("strict_refuse");
    if (refused.status === "strict_refuse") {
      expect(refused.reason).toBe("artifact_invalid");
    }
  });

  test("detects stale runtime fingerprints when supplied", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: { model: "model-a" },
    });
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });

    const stale = store.expandQuery("hexagonal architecture", undefined, {
      modelFingerprint: "model-b",
      providerFingerprint: "unspecified-provider",
      retrievalConfigFingerprint: "unspecified-retrieval",
      corpusSnapshotFingerprint: "unspecified-corpus",
      indexSnapshotFingerprint: "unspecified-index",
      retrieverFingerprint: "unspecified-retriever",
      rerankerFingerprint: "unspecified-reranker",
      schemaFingerprint: `schema:${SchemaVersion}`,
    });
    expect(stale.status).toBe("fallback");
    expect(stale.reason).toBe("artifact_stale");
  });

  test("runtime fingerprints change with provider and retrieval config", () => {
    const base = buildDspyRuntimeFingerprints({
      collections: {},
      models: {
        generate: "gpt-5.4",
        embed: "jina:jina-embeddings-v3",
        rerank: "jina:jina-reranker-v3",
      },
      providers: {
        openai: {
          api_key_env: "OPENAI_API_KEY",
          base_url_env: "OPENAI_BASE_URL",
          response_api: {
            endpoint: "/responses",
            stream: true,
            reasoning_effort: "medium",
            strict_structured_output: true,
          },
        },
      },
      query: {
        default_route: "qmd",
        allow_graph_upgrade: true,
        expansion_policy: { provider: "builtin" },
      },
    }, {
      generateModel: "default-generate",
      embedModel: "default-embed",
      rerankModel: "default-rerank",
    });
    const changedProvider = buildDspyRuntimeFingerprints({
      collections: {},
      models: {
        generate: "gpt-5.4",
        embed: "jina:jina-embeddings-v3",
        rerank: "jina:jina-reranker-v3",
      },
      providers: {
        openai: {
          api_key_env: "ALT_OPENAI_API_KEY",
          base_url_env: "OPENAI_BASE_URL",
          response_api: {
            endpoint: "/responses",
            stream: true,
            reasoning_effort: "medium",
            strict_structured_output: true,
          },
        },
      },
      query: {
        default_route: "qmd",
        allow_graph_upgrade: true,
        expansion_policy: { provider: "builtin" },
      },
    }, {
      generateModel: "default-generate",
      embedModel: "default-embed",
      rerankModel: "default-rerank",
    });
    const changedRetrieval = buildDspyRuntimeFingerprints({
      collections: {},
      models: {
        generate: "gpt-5.4",
        embed: "jina:jina-embeddings-v3",
        rerank: "jina:jina-reranker-v3",
      },
      providers: {
        openai: {
          api_key_env: "OPENAI_API_KEY",
          base_url_env: "OPENAI_BASE_URL",
          response_api: {
            endpoint: "/responses",
            stream: true,
            reasoning_effort: "medium",
            strict_structured_output: true,
          },
        },
      },
      query: {
        default_route: "auto",
        allow_graph_upgrade: true,
        expansion_policy: { provider: "builtin" },
      },
    }, {
      generateModel: "default-generate",
      embedModel: "default-embed",
      rerankModel: "default-rerank",
    });

    expect(changedProvider.providerFingerprint).not.toBe(
      base.providerFingerprint,
    );
    expect(changedRetrieval.retrievalConfigFingerprint).not.toBe(
      base.retrievalConfigFingerprint,
    );
  });

  test("classifies missing decision and artifact files separately", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    const decision = store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });

    rmSync(join(vault, decision.artifactPath));
    const missingArtifact = store.expandQuery("hexagonal architecture");
    expect(missingArtifact.status).toBe("fallback");
    expect(missingArtifact.reason).toBe("artifact_missing");

    const second = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const secondReport = store.evaluateExpansionPolicy({ artifactPath: second.artifactPath });
    const secondDecision = store.promoteExpansionPolicy({
      artifactPath: second.artifactPath,
      reportPath: `dspy/reports/${secondReport.reportId}.yaml`,
      reason: "test promotion",
    });
    rmSync(join(vault, "dspy", "promotions", `${secondDecision.decisionId}.yaml`));
    const missingDecision = store.expandQuery("hexagonal architecture");
    expect(missingDecision.status).toBe("fallback");
    expect(missingDecision.reason).toBe("decision_missing");
  });

  test("classifies missing generated expansion files separately", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const artifactPath = join(vault, result.artifactPath);
    const artifact = YAML.parse(readFileSync(artifactPath, "utf8"));
    delete artifact.generatedExpansionHash;
    await writeDurableYamlFixture(artifactPath, artifact);
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });

    rmSync(join(vault, result.artifact.generatedExpansionPath!));
    const expanded = store.expandQuery("hexagonal architecture");
    expect(expanded.status).toBe("fallback");
    expect(expanded.reason).toBe("generated_expansion_missing");
  });

  test("classifies artifact without generated expansion path separately", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });
    const artifactPath = join(vault, result.artifactPath);
    const artifact = YAML.parse(readFileSync(artifactPath, "utf8"));
    delete artifact.generatedExpansionPath;
    delete artifact.generatedExpansionHash;
    await writeDurableYamlFixture(artifactPath, artifact);

    const expanded = store.expandQuery("hexagonal architecture");
    expect(expanded.status).toBe("fallback");
    expect(expanded.reason).toBe("generated_expansion_missing");
  });

  test("classifies generated expansion runtime errors", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const artifactPath = join(vault, result.artifactPath);
    const artifact = YAML.parse(readFileSync(artifactPath, "utf8"));
    delete artifact.generatedExpansionHash;
    await writeDurableYamlFixture(artifactPath, artifact);
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });
    writeFileSync(join(vault, result.artifact.generatedExpansionPath!), "{bad\n");

    const expanded = store.expandQuery("hexagonal architecture");
    expect(expanded.status).toBe("fallback");
    expect(expanded.reason).toBe("runtime_error");
  });

  test("classifies generated expansion schema errors separately", async () => {
    const vault = await makeVault();
    const emitPath = join(vault, "generated.jsonl");
    await writeRecords(emitPath);
    const store = new DspyPolicyStore({ graphVault: vault, actor: "test" });
    const result = store.writeOptimizationArtifact({
      request: {
        optimizer: "gepa",
        trainsetPath: "train.jsonl",
        model: "openai/gpt-5.4",
        emitPath,
      },
      response: {
        schemaVersion: SchemaVersion,
        optimizer: "gepa",
        command: ["dspy"],
        emitPath,
        stdoutTail: [],
      },
      fingerprints: {},
    });
    const artifactPath = join(vault, result.artifactPath);
    const artifact = YAML.parse(readFileSync(artifactPath, "utf8"));
    delete artifact.generatedExpansionHash;
    await writeDurableYamlFixture(artifactPath, artifact);
    const report = store.evaluateExpansionPolicy({ artifactPath: result.artifactPath });
    store.promoteExpansionPolicy({
      artifactPath: result.artifactPath,
      reportPath: `dspy/reports/${report.reportId}.yaml`,
      reason: "test promotion",
    });
    writeFileSync(
      join(vault, result.artifact.generatedExpansionPath!),
      `${JSON.stringify({ query: "hexagonal architecture", output: [{ type: "bad" }] })}\n`,
    );

    const expanded = store.expandQuery("hexagonal architecture");
    expect(expanded.status).toBe("fallback");
    expect(expanded.reason).toBe("runtime_output_schema_invalid");
  });
});
