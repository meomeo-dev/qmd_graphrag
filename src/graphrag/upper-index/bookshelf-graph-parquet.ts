import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  BookshelfQueryBridgeResponseSchema,
  ParquetInspectionSchema,
  type BookshelfQueryBridgeResponse,
  type ParquetInspection,
} from "./bookshelf-graph-contracts.js";

export function defaultBookshelfGraphBridgePath(): string {
  return fileURLToPath(
    new URL(
      "../../../scripts/graphrag/bookshelf-graph-parquet-bridge.py",
      import.meta.url,
    ),
  );
}

export async function runBookshelfGraphParquetBridge(input: {
  mode: "build" | "build-library" | "inspect";
  pythonBin: string;
  bridgePath: string;
  payload: unknown;
}): Promise<ParquetInspection> {
  const output = await new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolveResult, reject) => {
      const child = spawn(input.pythonBin, [input.bridgePath, input.mode], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        resolveResult({ stdout, stderr, code: code ?? 1 });
      });
      child.stdin.end(JSON.stringify(input.payload));
    },
  );
  if (output.code !== 0) {
    throw new Error(
      `upper_index_runtime_error:parquet_bridge_failed:${output.stderr.trim()}`,
    );
  }
  const parsed = ParquetInspectionSchema.safeParse(JSON.parse(output.stdout));
  if (!parsed.success) {
    throw new Error("upper_quality_gate_failed:parquet_bridge_response_invalid");
  }
  return parsed.data;
}

export async function runBookshelfGraphQueryBridge(input: {
  pythonBin: string;
  bridgePath: string;
  payload: unknown;
}): Promise<BookshelfQueryBridgeResponse> {
  const output = await new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolveResult, reject) => {
      const child = spawn(input.pythonBin, [input.bridgePath, "query"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        resolveResult({ stdout, stderr, code: code ?? 1 });
      });
      child.stdin.end(JSON.stringify(input.payload));
    },
  );
  if (output.code !== 0) {
    throw new Error(
      `upper_index_runtime_error:parquet_bridge_failed:${output.stderr.trim()}`,
    );
  }
  const parsed = BookshelfQueryBridgeResponseSchema.safeParse(
    JSON.parse(output.stdout),
  );
  if (!parsed.success) {
    throw new Error("upper_quality_gate_failed:bookshelf_query_response_invalid");
  }
  return parsed.data;
}
