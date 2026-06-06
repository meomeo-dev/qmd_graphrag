import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { SchemaVersion } from "../../src/contracts/common.js";
import { GraphRagIndexResponseSchema } from "../../src/contracts/graphrag.js";
import {
  PythonBridgeTimeoutError,
  callPythonBridge,
} from "../../src/integrations/python-bridge.js";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qmd-python-bridge-early-stop-"));
}

async function writeFakeBridge(
  workspace: string,
  body: string,
): Promise<string> {
  const scriptPath = join(workspace, "fake-python-bridge.mjs");
  await writeFile(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', async () => {",
      body,
      "});",
    ].join("\n"),
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delayMs(50);
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
}

describe("Python bridge GraphRAG stage early stop", () => {
  test("registers batch subprocess records with provider slot fencing", async () => {
    const workspace = await createWorkspace();
    const registryDir = join(workspace, "subprocesses");
    const previousEnv = {
      QMD_GRAPHRAG_RUN_ID: process.env.QMD_GRAPHRAG_RUN_ID,
      QMD_GRAPHRAG_ITEM_ID: process.env.QMD_GRAPHRAG_ITEM_ID,
      QMD_GRAPHRAG_BOOK_ID: process.env.QMD_GRAPHRAG_BOOK_ID,
      QMD_GRAPHRAG_WORKER_ID: process.env.QMD_GRAPHRAG_WORKER_ID,
      QMD_GRAPHRAG_RUNNER_SESSION_ID:
        process.env.QMD_GRAPHRAG_RUNNER_SESSION_ID,
      QMD_GRAPHRAG_RUNNER_HOST: process.env.QMD_GRAPHRAG_RUNNER_HOST,
      QMD_GRAPHRAG_RUNNER_PID: process.env.QMD_GRAPHRAG_RUNNER_PID,
      QMD_GRAPHRAG_SUBPROCESS_REGISTRY_DIR:
        process.env.QMD_GRAPHRAG_SUBPROCESS_REGISTRY_DIR,
      QMD_GRAPHRAG_PROVIDER_SLOT_ID: process.env.QMD_GRAPHRAG_PROVIDER_SLOT_ID,
      QMD_GRAPHRAG_PROVIDER_SLOT_PROVIDER:
        process.env.QMD_GRAPHRAG_PROVIDER_SLOT_PROVIDER,
      QMD_GRAPHRAG_PROVIDER_SLOT_GENERATION:
        process.env.QMD_GRAPHRAG_PROVIDER_SLOT_GENERATION,
      QMD_GRAPHRAG_PROVIDER_SLOT_FENCING_TOKEN:
        process.env.QMD_GRAPHRAG_PROVIDER_SLOT_FENCING_TOKEN,
      QMD_GRAPHRAG_INHERIT_PARENT_PROCESS_GROUP:
        process.env.QMD_GRAPHRAG_INHERIT_PARENT_PROCESS_GROUP,
    };
    try {
      process.env.QMD_GRAPHRAG_RUN_ID = "bridge-registry-run";
      process.env.QMD_GRAPHRAG_ITEM_ID = "item-bridge";
      process.env.QMD_GRAPHRAG_BOOK_ID = "book-bridge";
      process.env.QMD_GRAPHRAG_WORKER_ID = "worker-bridge";
      process.env.QMD_GRAPHRAG_RUNNER_SESSION_ID = "runner-session";
      process.env.QMD_GRAPHRAG_RUNNER_HOST = "host-bridge";
      process.env.QMD_GRAPHRAG_RUNNER_PID = String(process.pid);
      process.env.QMD_GRAPHRAG_SUBPROCESS_REGISTRY_DIR = registryDir;
      process.env.QMD_GRAPHRAG_PROVIDER_SLOT_ID = "openai-slot-1";
      process.env.QMD_GRAPHRAG_PROVIDER_SLOT_PROVIDER = "openai";
      process.env.QMD_GRAPHRAG_PROVIDER_SLOT_GENERATION = "7";
      process.env.QMD_GRAPHRAG_PROVIDER_SLOT_FENCING_TOKEN = "slot-token-7";
      const fakeBridge = await writeFakeBridge(
        workspace,
        [
          "process.stdout.write(JSON.stringify({",
          `  schemaVersion: ${JSON.stringify(SchemaVersion)},`,
          "  method: 'standard',",
          "  outputs: [{ workflow: 'extract_graph', hasError: false, stateKeys: [] }],",
          "}));",
        ].join("\n"),
      );

      await callPythonBridge({
        command: "graphrag_index",
        pythonBin: fakeBridge,
        workingDirectory: workspace,
        request: {},
        responseSchema: GraphRagIndexResponseSchema,
      });

      const records = await Promise.all(
        (await readdir(registryDir))
          .filter((entry) => entry.endsWith(".json") && !entry.includes(".sha256"))
          .map(async (entry) =>
            JSON.parse(await readFile(join(registryDir, entry), "utf8"))
          ),
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        schemaVersion: SchemaVersion,
        runId: "bridge-registry-run",
        command: "python-bridge:graphrag_index",
        itemId: "item-bridge",
        bookId: "book-bridge",
        workerId: "worker-bridge",
        runnerSessionId: "runner-session",
        runnerHost: "host-bridge",
        runnerPid: process.pid,
        providerSlotId: "openai-slot-1",
        providerSlotProvider: "openai",
        providerSlotGeneration: 7,
        providerSlotFencingToken: "slot-token-7",
        status: "exited",
        exitCode: 0,
      });
      expect(records[0].processGroup).toBe(process.platform !== "win32");
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("inherits parent process group when managed by the batch runner", async () => {
    const workspace = await createWorkspace();
    const registryDir = join(workspace, "subprocesses");
    const previousEnv = {
      QMD_GRAPHRAG_RUN_ID: process.env.QMD_GRAPHRAG_RUN_ID,
      QMD_GRAPHRAG_RUNNER_SESSION_ID:
        process.env.QMD_GRAPHRAG_RUNNER_SESSION_ID,
      QMD_GRAPHRAG_RUNNER_PID: process.env.QMD_GRAPHRAG_RUNNER_PID,
      QMD_GRAPHRAG_SUBPROCESS_REGISTRY_DIR:
        process.env.QMD_GRAPHRAG_SUBPROCESS_REGISTRY_DIR,
      QMD_GRAPHRAG_INHERIT_PARENT_PROCESS_GROUP:
        process.env.QMD_GRAPHRAG_INHERIT_PARENT_PROCESS_GROUP,
    };
    try {
      process.env.QMD_GRAPHRAG_RUN_ID = "bridge-inherit-run";
      process.env.QMD_GRAPHRAG_RUNNER_SESSION_ID = "runner-session";
      process.env.QMD_GRAPHRAG_RUNNER_PID = String(process.pid);
      process.env.QMD_GRAPHRAG_SUBPROCESS_REGISTRY_DIR = registryDir;
      process.env.QMD_GRAPHRAG_INHERIT_PARENT_PROCESS_GROUP = "1";
      const fakeBridge = await writeFakeBridge(
        workspace,
        [
          "process.stdout.write(JSON.stringify({",
          `  schemaVersion: ${JSON.stringify(SchemaVersion)},`,
          "  method: 'standard',",
          "  outputs: [{ workflow: 'extract_graph', hasError: false, stateKeys: [] }],",
          "}));",
        ].join("\n"),
      );

      await callPythonBridge({
        command: "graphrag_index",
        pythonBin: fakeBridge,
        workingDirectory: workspace,
        request: {},
        responseSchema: GraphRagIndexResponseSchema,
      });

      const records = await Promise.all(
        (await readdir(registryDir))
          .filter((entry) => entry.endsWith(".json") && !entry.includes(".sha256"))
          .map(async (entry) =>
            JSON.parse(await readFile(join(registryDir, entry), "utf8"))
          ),
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        runId: "bridge-inherit-run",
        command: "python-bridge:graphrag_index",
        processGroup: false,
        status: "exited",
        exitCode: 0,
      });
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("projects provider env vars from project dotenv into python bridge child",
    async () => {
      const workspace = await createWorkspace();
      const qmdDir = join(workspace, ".qmd");
      await mkdir(qmdDir, { recursive: true });
      await writeFile(join(qmdDir, "index.yml"), "collections: {}\n", "utf8");
      await writeFile(
        join(workspace, ".env"),
        [
          "OPENAI_API_KEY=dotenv-openai-key",
          "OPENAI_BASE_URL=http://127.0.0.1:19999",
          "JINA_API_KEY=dotenv-jina-key",
          "JINA_API_BASE=https://dotenv.example.invalid",
          "",
        ].join("\n"),
        "utf8",
      );
      const envDumpPath = join(workspace, "env-dump.json");
      const previousEnv = {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
        JINA_API_KEY: process.env.JINA_API_KEY,
        JINA_API_BASE: process.env.JINA_API_BASE,
      };
      try {
        process.env.OPENAI_API_KEY = "parent-openai-key";
        process.env.OPENAI_BASE_URL = "http://127.0.0.1:18888";
        process.env.JINA_API_KEY = "parent-jina-key";
        process.env.JINA_API_BASE = "https://parent.example.invalid";
        const fakeBridge = await writeFakeBridge(
          workspace,
          [
            `const dumpPath = ${JSON.stringify(envDumpPath)};`,
            "const { writeFileSync } = await import('node:fs');",
            "writeFileSync(dumpPath, JSON.stringify({",
            "  openaiApiKey: process.env.OPENAI_API_KEY ?? null,",
            "  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? null,",
            "  jinaApiKey: process.env.JINA_API_KEY ?? null,",
            "  jinaApiBase: process.env.JINA_API_BASE ?? null,",
            "}), 'utf8');",
            "process.stdout.write(JSON.stringify({",
            `  schemaVersion: ${JSON.stringify(SchemaVersion)},`,
            "  method: 'standard',",
            "  outputs: [{ workflow: 'extract_graph', hasError: false, stateKeys: [] }],",
            "}));",
          ].join("\n"),
        );

        await callPythonBridge({
          command: "graphrag_index",
          pythonBin: fakeBridge,
          workingDirectory: workspace,
          request: {},
          responseSchema: GraphRagIndexResponseSchema,
        });

        const dumped = JSON.parse(await readFile(envDumpPath, "utf8")) as Record<
          string,
          string | null
        >;
        expect(dumped).toEqual({
          openaiApiKey: "dotenv-openai-key",
          openaiBaseUrl: "http://127.0.0.1:19999",
          jinaApiKey: "dotenv-jina-key",
          jinaApiBase: "https://dotenv.example.invalid",
        });
      } finally {
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value == null) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(workspace, { recursive: true, force: true });
      }
    });

  test("ignores old partial-output log history before the current offset", async () => {
    const workspace = await createWorkspace();
    const reportDir = join(workspace, "reports");
    await mkdir(reportDir, { recursive: true });
    const logPath = join(reportDir, "indexing-engine.log");
    await writeFile(
      logPath,
      "2026-05-25 ERROR Community Report Extraction Error stale\n",
      "utf8",
    );
    const logStartOffset = (await stat(logPath)).size;
    const fakeBridge = await writeFakeBridge(
      workspace,
      [
        "process.stdout.write(JSON.stringify({",
        `  schemaVersion: ${JSON.stringify(SchemaVersion)},`,
        "  method: 'standard',",
        "  outputs: [{ workflow: 'create_community_reports', hasError: false, stateKeys: [] }],",
        "}));",
      ].join("\n"),
    );

    const response = await callPythonBridge({
      command: "graphrag_index",
      pythonBin: fakeBridge,
      workingDirectory: workspace,
      request: {},
      responseSchema: GraphRagIndexResponseSchema,
      earlyStop: {
        kind: "graphrag_stage_report",
        stage: "community_report",
        reportDir,
        outputDir: workspace,
        logStartOffset,
        logLocator: "graphrag-reports/book/community_report/indexing-engine.log",
      },
    });

    expect(response.outputs[0]?.workflow).toBe("create_community_reports");
  });

  test("terminates the current child and rejects instead of parsing prior stdout", async () => {
    const workspace = await createWorkspace();
    const reportDir = join(workspace, "reports");
    await mkdir(reportDir, { recursive: true });
    const logPath = join(reportDir, "indexing-engine.log");
    await writeFile(logPath, "", "utf8");
    const fakeBridge = await writeFakeBridge(
      workspace,
      [
        "process.stdout.write(JSON.stringify({",
        `  schemaVersion: ${JSON.stringify(SchemaVersion)},`,
        "  method: 'standard',",
        "  outputs: [{ workflow: 'create_community_reports', hasError: false, stateKeys: [] }],",
        "}));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const call = callPythonBridge({
      command: "graphrag_index",
      pythonBin: fakeBridge,
      workingDirectory: workspace,
      request: {},
      responseSchema: GraphRagIndexResponseSchema,
      earlyStop: {
        kind: "graphrag_stage_report",
        stage: "community_report",
        reportDir,
        outputDir: workspace,
        logStartOffset: 0,
        logLocator: "graphrag-reports/book/community_report/indexing-engine.log",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 350));
    await writeFile(
      logPath,
      "2026-05-25 ERROR No report found for community 7 /Users/private/key\n",
      "utf8",
    );

    await expect(call).rejects.toThrow("GraphRAG stage report partial-output failure");
    await expect(call).rejects.toThrow('"failureKind":"partial_output"');
    await expect(call).rejects.toThrow(
      "graphrag-reports/book/community_report/indexing-engine.log",
    );
  });

  test("times out and terminates a stuck python bridge child", async () => {
    const workspace = await createWorkspace();
    try {
      const pidPath = join(workspace, "bridge.pid");
      const fakeBridge = await writeFakeBridge(
        workspace,
        [
          "const { writeFileSync } = await import('node:fs');",
          `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid), 'utf8');`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      await expect(callPythonBridge({
        command: "graphrag_index",
        pythonBin: fakeBridge,
        workingDirectory: workspace,
        request: {},
        responseSchema: GraphRagIndexResponseSchema,
        timeoutMs: 200,
      })).rejects.toBeInstanceOf(PythonBridgeTimeoutError);

      const pid = Number(await readFile(pidPath, "utf8"));
      await waitForPidExit(pid);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("redacts unsafe locators and evidence from early-stop errors", async () => {
    const workspace = await createWorkspace();
    const previousSecret = process.env.QMD_TEST_BRIDGE_SECRET;
    process.env.QMD_TEST_BRIDGE_SECRET = "exact-env-secret";
    try {
      const reportDir = join(workspace, "reports");
      await mkdir(reportDir, { recursive: true });
      const logPath = join(reportDir, "indexing-engine.log");
      await writeFile(logPath, "", "utf8");
      const fakeBridge = await writeFakeBridge(
        workspace,
        "setInterval(() => {}, 1000);",
      );

      const call = callPythonBridge({
        command: "graphrag_index",
        pythonBin: fakeBridge,
        workingDirectory: workspace,
        request: {},
        responseSchema: GraphRagIndexResponseSchema,
        earlyStop: {
          kind: "graphrag_stage_report",
          stage: "community_report",
          reportDir,
          outputDir: workspace,
          logStartOffset: 0,
          logLocator: "/Users/private/graph.log?token=locator-secret",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 350));
      await writeFile(
        logPath,
        [
          "2026-05-25 ERROR Community Report Extraction Error " +
            "Bearer raw-token sk-raw-secret api_key=abc123",
          "2026-05-25 ERROR Community Report Extraction Error " +
            "/home/jin/private /tmp/qmd-secret C:\\Users\\jin\\secret.env",
          "2026-05-25 ERROR Community Report Extraction Error " +
            "https://example.com/path?api_key=url-secret&token=url-token",
          "2026-05-25 ERROR Community Report Extraction Error exact-env-secret",
          "2026-05-25 ERROR Community Report Extraction Error " +
            "request_body={\"prompt\":\"private-provider-payload\"}",
          "2026-05-25 ERROR Community Report Extraction Error " +
            "provider_request_payload='raw provider request text'",
          "2026-05-25 ERROR Community Report Extraction Error " +
            "raw_response=provider-response-body",
        ].join("\n"),
        "utf8",
      );

      let message = "";
      try {
        await call;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("GraphRAG stage report partial-output failure");
      expect(message).toContain('"logLocator":"[redacted-path]"');
      expect(message).not.toContain("/Users/private");
      expect(message).not.toContain("/home/jin");
      expect(message).not.toContain("/tmp/qmd-secret");
      expect(message).not.toContain("C:\\Users\\jin");
      expect(message).not.toContain("raw-token");
      expect(message).not.toContain("sk-raw-secret");
      expect(message).not.toContain("abc123");
      expect(message).not.toContain("url-secret");
      expect(message).not.toContain("url-token");
      expect(message).not.toContain("exact-env-secret");
      expect(message).not.toContain("private-provider-payload");
      expect(message).not.toContain("raw provider request text");
      expect(message).not.toContain("provider-response-body");
      expect(message).toContain("[redacted-secret]");
      expect(message).toContain("[redacted-provider-payload]");
      expect(message).toContain("[redacted-url]");
      expect(message).toContain("[redacted-path]");
    } finally {
      if (previousSecret == null) {
        delete process.env.QMD_TEST_BRIDGE_SECRET;
      } else {
        process.env.QMD_TEST_BRIDGE_SECRET = previousSecret;
      }
    }
  });

  test("does not start the watcher for non-community stages", async () => {
    const workspace = await createWorkspace();
    const reportDir = join(workspace, "reports");
    await mkdir(reportDir, { recursive: true });
    const logPath = join(reportDir, "indexing-engine.log");
    await writeFile(
      logPath,
      "2026-05-25 ERROR No report found for community 7\n",
      "utf8",
    );
    const fakeBridge = await writeFakeBridge(
      workspace,
      [
        "process.stdout.write(JSON.stringify({",
        `  schemaVersion: ${JSON.stringify(SchemaVersion)},`,
        "  method: 'standard',",
        "  outputs: [{ workflow: 'extract_graph', hasError: false, stateKeys: [] }],",
        "}));",
      ].join("\n"),
    );

    const response = await callPythonBridge({
      command: "graphrag_index",
      pythonBin: fakeBridge,
      workingDirectory: workspace,
      request: {},
      responseSchema: GraphRagIndexResponseSchema,
      earlyStop: {
        kind: "graphrag_stage_report",
        stage: "graph_extract",
        reportDir,
        outputDir: workspace,
        logStartOffset: 0,
        logLocator: "graphrag-reports/book/graph_extract/indexing-engine.log",
      },
    });

    expect(response.outputs[0]?.workflow).toBe("extract_graph");
    expect(await readFile(logPath, "utf8")).toContain("No report found");
  });
});
