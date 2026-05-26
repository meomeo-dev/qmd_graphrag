import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { SchemaVersion } from "../../src/contracts/common.js";
import { GraphRagIndexResponseSchema } from "../../src/contracts/graphrag.js";
import { callPythonBridge } from "../../src/integrations/python-bridge.js";

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

describe("Python bridge GraphRAG stage early stop", () => {
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
