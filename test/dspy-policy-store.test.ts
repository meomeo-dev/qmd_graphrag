import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { SchemaVersion } from "../src/contracts/common.js";
import { buildDspyRuntimeFingerprints } from "../src/dspy/fingerprints.js";
import { DspyPolicyStore } from "../src/dspy/policy-store.js";

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
        stdoutTail: [`wrote ${emitPath} sk-secret123`],
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
    expect(runBody).not.toContain("sk-secret123");
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

  test("honors configured pointer_ref and strict failure policy", async () => {
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
    expect(result.status).toBe("strict_refuse");
    expect(result.reason).toBe("pointer_missing");
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
    const artifact = readFileSync(artifactPath, "utf8")
      .replace(/generatedExpansionHash: .+\n/, "");
    writeFileSync(artifactPath, artifact, "utf8");
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
    const artifact = readFileSync(artifactPath, "utf8")
      .replace(/generatedExpansionPath: .+\n/, "")
      .replace(/generatedExpansionHash: .+\n/, "");
    writeFileSync(artifactPath, artifact, "utf8");

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
    const artifact = readFileSync(artifactPath, "utf8")
      .replace(/generatedExpansionHash: .+\n/, "");
    writeFileSync(artifactPath, artifact, "utf8");
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
    const artifact = readFileSync(artifactPath, "utf8")
      .replace(/generatedExpansionHash: .+\n/, "");
    writeFileSync(artifactPath, artifact, "utf8");
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
