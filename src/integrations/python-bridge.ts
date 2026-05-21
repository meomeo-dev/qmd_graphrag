import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { ZodType } from "zod";

import { resolveProjectPath } from "../utils/package-paths.js";

type PythonBridgeCallOptions<TRequest, TResponse> = {
  command: string;
  pythonBin?: string;
  request: TRequest;
  responseSchema: ZodType<TResponse>;
  workingDirectory?: string;
};

export async function callPythonBridge<TRequest, TResponse>(
  options: PythonBridgeCallOptions<TRequest, TResponse>,
): Promise<TResponse> {
  const scriptPath = resolveProjectPath("python/qmd_graphrag/bridge.py");
  const bundledPython = resolveProjectPath(".venv-graphrag/bin/python");
  const pythonBin =
    options.pythonBin ||
    process.env.QMD_GRAPHRAG_PYTHON ||
    (existsSync(bundledPython) ? bundledPython : undefined) ||
    process.env.PYTHON ||
    "python3";

  return new Promise<TResponse>((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath, options.command], {
      cwd: options.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `python bridge exited with code ${code}`;
        reject(new Error(message));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve(options.responseSchema.parse(parsed));
      } catch (error) {
        reject(
          new Error(
            `failed to parse python bridge response: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });

    child.stdin.write(JSON.stringify(options.request));
    child.stdin.end();
  });
}
