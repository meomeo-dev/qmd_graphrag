import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";

import type { ZodType } from "zod";

import type { BookStage } from "../contracts/book-job.js";
import { writeJsonFileDurableSync } from "../job-state/durable-state-store.js";
import { resolveProjectPath } from "../utils/package-paths.js";
import { sanitizeVaultText } from "../vault/metadata.js";
import { projectDotenvEnvOverlay } from "../env/project-dotenv.js";

export type PythonBridgeEarlyStop = {
  kind: "graphrag_stage_report";
  stage: BookStage;
  reportDir: string;
  logStartOffset: number;
  outputDir: string;
  logLocator: string;
};

type PythonBridgeCallOptions<TRequest, TResponse> = {
  command: string;
  pythonBin?: string;
  request: TRequest;
  responseSchema: ZodType<TResponse>;
  workingDirectory?: string;
  earlyStop?: PythonBridgeEarlyStop;
};

const GRAPH_RAG_COMMUNITY_PARTIAL_LOG_PATTERN =
  /Community Report Extraction Error|error generating community report|No report found for community/iu;
const GRAPH_RAG_ACTIONABLE_LOG_LEVEL_PATTERN =
  /(?:\s-\s|\b)(?:WARNING|ERROR|CRITICAL|EXCEPTION)(?:\s-\s|\b)/iu;
const GRAPH_RAG_NON_ACTIONABLE_LOG_LEVEL_PATTERN =
  /(?:\s-\s|\b)(?:DEBUG|INFO)(?:\s-\s|\b)/iu;
const GRAPH_RAG_EARLY_STOP_POLL_INTERVAL_MS = 250;
const GRAPH_RAG_EARLY_STOP_KILL_GRACE_MS = 2000;
const GRAPH_RAG_EARLY_STOP_MAX_EVIDENCE = 20;
const GRAPH_RAG_EARLY_STOP_MAX_LINE_LENGTH = 240;
const GRAPH_RAG_PROVIDER_PAYLOAD_ASSIGNMENT_PATTERN =
  /\b(?:raw|payload|body|provider[_-]?request|provider[_-]?response|provider[_-]?request[_-]?body|provider[_-]?response[_-]?body|provider[_-]?request[_-]?payload|provider[_-]?response[_-]?payload|raw[_-]?request|raw[_-]?response|request[_-]?body|response[_-]?body|request[_-]?payload|response[_-]?payload)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|\[[^\]]*\]|[^,\s}]+)/giu;
const PYTHON_BRIDGE_INHERIT_PARENT_PROCESS_GROUP =
  "QMD_GRAPHRAG_INHERIT_PARENT_PROCESS_GROUP";

type EarlyStopWatcher = {
  stop(): void;
};

type BridgeSubprocessRecord = {
  schemaVersion: "1.0.0";
  runId: string;
  subprocessId: string;
  runnerSessionId: string;
  runnerHost: string;
  runnerPid: number;
  pid?: number;
  command: string;
  itemId?: string;
  bookId?: string;
  workerId?: string;
  providerSlotId?: string;
  providerSlotProvider?: "openai" | "jina" | "local_cpu" | "qmd_index_writer";
  providerSlotGeneration?: number;
  providerSlotFencingToken?: string;
  processGroup: boolean;
  startedAt: string;
  heartbeatAt: string;
  status: "running" | "exited" | "killed" | "quarantined" | "spawn_error";
  exitCode?: number | null;
  signal?: string | null;
  completedAt?: string;
};

function pythonBridgeUsesProcessGroup(): boolean {
  return (
    process.platform !== "win32" &&
    process.env[PYTHON_BRIDGE_INHERIT_PARENT_PROCESS_GROUP] !== "1"
  );
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalString(value: string | undefined): string | undefined {
  return value == null || value === "" ? undefined : value;
}

function optionalProvider(
  value: string | undefined,
): BridgeSubprocessRecord["providerSlotProvider"] | undefined {
  if (
    value === "openai" ||
    value === "jina" ||
    value === "local_cpu" ||
    value === "qmd_index_writer"
  ) {
    return value;
  }
  return undefined;
}

function bridgeSubprocessRecordPath(subprocessId: string): string | null {
  const root = optionalString(process.env.QMD_GRAPHRAG_SUBPROCESS_REGISTRY_DIR);
  return root == null ? null : join(root, `${subprocessId}.json`);
}

function buildBridgeSubprocessRecord(input: {
  subprocessId: string;
  command: string;
  startedAt: string;
  pid?: number;
  status: BridgeSubprocessRecord["status"];
  completedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  processGroup: boolean;
}): BridgeSubprocessRecord | null {
  const runId = optionalString(process.env.QMD_GRAPHRAG_RUN_ID);
  const runnerSessionId = optionalString(process.env.QMD_GRAPHRAG_RUNNER_SESSION_ID);
  const runnerPid = parsePositiveInteger(process.env.QMD_GRAPHRAG_RUNNER_PID);
  if (runId == null || runnerSessionId == null || runnerPid == null) return null;
  return {
    schemaVersion: "1.0.0",
    runId,
    subprocessId: input.subprocessId,
    runnerSessionId,
    runnerHost: optionalString(process.env.QMD_GRAPHRAG_RUNNER_HOST) ?? hostname(),
    runnerPid,
    pid: input.pid,
    command: input.command,
    itemId: optionalString(process.env.QMD_GRAPHRAG_ITEM_ID),
    bookId: optionalString(process.env.QMD_GRAPHRAG_BOOK_ID),
    workerId: optionalString(process.env.QMD_GRAPHRAG_WORKER_ID),
    providerSlotId: optionalString(process.env.QMD_GRAPHRAG_PROVIDER_SLOT_ID),
    providerSlotProvider: optionalProvider(
      process.env.QMD_GRAPHRAG_PROVIDER_SLOT_PROVIDER,
    ),
    providerSlotGeneration: parsePositiveInteger(
      process.env.QMD_GRAPHRAG_PROVIDER_SLOT_GENERATION,
    ),
    providerSlotFencingToken: optionalString(
      process.env.QMD_GRAPHRAG_PROVIDER_SLOT_FENCING_TOKEN,
    ),
    processGroup: input.processGroup,
    startedAt: input.startedAt,
    heartbeatAt: new Date().toISOString(),
    status: input.status,
    exitCode: input.exitCode,
    signal: input.signal,
    completedAt: input.completedAt,
  };
}

function writeBridgeSubprocessRecord(record: BridgeSubprocessRecord | null): void {
  if (record == null) return;
  const path = bridgeSubprocessRecordPath(record.subprocessId);
  if (path == null) return;
  writeJsonFileDurableSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

function terminatePythonBridgeChild(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  processGroup: boolean,
): void {
  try {
    if (child.pid != null && processGroup) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to direct child termination below.
  }
  try {
    child.kill(signal);
  } catch {
    // Process may have already exited.
  }
}

function isActionableGraphRagPartialOutputLine(line: string): boolean {
  return GRAPH_RAG_ACTIONABLE_LOG_LEVEL_PATTERN.test(line) &&
    !GRAPH_RAG_NON_ACTIONABLE_LOG_LEVEL_PATTERN.test(line) &&
    GRAPH_RAG_COMMUNITY_PARTIAL_LOG_PATTERN.test(line);
}

function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function sanitizeGraphRagBridgeText(value: string): string {
  const redactedAssignments = value
    .replaceAll(/\r?\n/gu, " ")
    .replaceAll(
      GRAPH_RAG_PROVIDER_PAYLOAD_ASSIGNMENT_PATTERN,
      "[redacted-provider-payload]",
    )
    .replaceAll(
      /\b(api[_-]?key|authorization|bearer|token|password|secret|credential)\b\s*[:=]\s*[^,\s&}]+/giu,
      "$1=[redacted-secret]",
    )
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted-secret]")
    .replaceAll(/sk-[A-Za-z0-9._-]+/gu, "sk-[redacted-secret]");
  return sanitizeVaultText(redactedAssignments)?.trim() ?? "[redacted]";
}

function sanitizeGraphRagLogEvidence(line: string): string {
  return truncateText(
    sanitizeGraphRagBridgeText(line),
    GRAPH_RAG_EARLY_STOP_MAX_LINE_LENGTH,
  );
}

function sanitizeGraphRagLogLocator(locator: string): string {
  const normalized = locator.replaceAll("\\", "/").trim();
  const hasPathTraversal = normalized.split("/").some((segment) => segment === "..");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    hasPathTraversal
  ) {
    return "[redacted-path]";
  }
  return truncateText(
    sanitizeGraphRagBridgeText(normalized),
    GRAPH_RAG_EARLY_STOP_MAX_LINE_LENGTH,
  );
}

function buildGraphRagEarlyStopError(input: {
  stage: BookStage;
  logLocator: string;
  logStartOffset: number;
  logEndOffset: number;
  evidence: string[];
}): Error {
  return new Error(
    "GraphRAG stage report partial-output failure: " +
      JSON.stringify({
        stage: input.stage,
        failureKind: "partial_output",
        logLocator: sanitizeGraphRagLogLocator(input.logLocator),
        logStartOffset: input.logStartOffset,
        logEndOffset: input.logEndOffset,
        evidence: input.evidence,
      }),
  );
}

function createGraphRagStageReportWatcher(
  options: PythonBridgeEarlyStop,
  onEarlyStop: (error: Error) => void,
): EarlyStopWatcher | null {
  if (options.kind !== "graphrag_stage_report" || options.stage !== "community_report") {
    return null;
  }
  const logPath = join(options.reportDir, "indexing-engine.log");
  let cursor = Math.max(0, options.logStartOffset);
  let stopped = false;
  let polling = false;
  const evidence: string[] = [];

  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const entry = await stat(logPath).catch(() => null);
      if (entry == null || !entry.isFile()) return;
      if (entry.size < cursor) {
        cursor = entry.size;
        return;
      }
      if (entry.size === cursor) return;

      const raw = await readFile(logPath).catch(() => null);
      if (raw == null) return;
      const nextCursor = Math.min(raw.length, entry.size);
      const segment = raw.subarray(cursor, nextCursor).toString("utf8");
      cursor = nextCursor;
      for (const line of segment.split(/\r?\n/u)) {
        if (!isActionableGraphRagPartialOutputLine(line)) continue;
        evidence.push(sanitizeGraphRagLogEvidence(line));
        if (evidence.length >= GRAPH_RAG_EARLY_STOP_MAX_EVIDENCE) break;
      }
      if (evidence.length > 0) {
        stopped = true;
        onEarlyStop(buildGraphRagEarlyStopError({
          stage: options.stage,
          logLocator: options.logLocator,
          logStartOffset: options.logStartOffset,
          logEndOffset: cursor,
          evidence: evidence.slice(0, GRAPH_RAG_EARLY_STOP_MAX_EVIDENCE),
        }));
      }
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => {
    void poll();
  }, GRAPH_RAG_EARLY_STOP_POLL_INTERVAL_MS);
  timer.unref?.();
  void poll();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

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
  const dotenvOverlay = projectDotenvEnvOverlay(
    options.workingDirectory ?? process.cwd(),
    [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "JINA_API_KEY",
      "JINA_API_BASE",
    ],
  );

  return new Promise<TResponse>((resolve, reject) => {
    const subprocessId = `python-bridge-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const processGroup = pythonBridgeUsesProcessGroup();
    const child = spawn(pythonBin, [scriptPath, options.command], {
      cwd: options.workingDirectory,
      env: {
        ...process.env,
        ...dotenvOverlay,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: processGroup,
    });
    try {
      writeBridgeSubprocessRecord(buildBridgeSubprocessRecord({
        subprocessId,
        command: `python-bridge:${options.command}`,
        startedAt,
        pid: child.pid,
        status: "running",
        processGroup,
      }));
    } catch (error) {
      terminatePythonBridgeChild(child, "SIGTERM", processGroup);
      setTimeout(() => {
        terminatePythonBridgeChild(child, "SIGKILL", processGroup);
      }, GRAPH_RAG_EARLY_STOP_KILL_GRACE_MS).unref?.();
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let finished = false;
    let earlyStopError: Error | null = null;
    let watcher: EarlyStopWatcher | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      watcher?.stop();
      watcher = null;
      if (killTimer != null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const rejectOnce = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (value: TResponse) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    };

    const terminateCurrentChild = () => {
      if (child.exitCode != null || child.signalCode != null) return;
      terminatePythonBridgeChild(child, "SIGTERM", processGroup);
      killTimer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) {
          terminatePythonBridgeChild(child, "SIGKILL", processGroup);
        }
      }, GRAPH_RAG_EARLY_STOP_KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const requestEarlyStop = (error: Error) => {
      if (earlyStopError != null || finished) return;
      earlyStopError = error;
      watcher?.stop();
      watcher = null;
      terminateCurrentChild();
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (earlyStopError != null) return;
      writeBridgeSubprocessRecord(buildBridgeSubprocessRecord({
        subprocessId,
        command: `python-bridge:${options.command}`,
        startedAt,
        pid: child.pid,
        status: "spawn_error",
        completedAt: new Date().toISOString(),
        processGroup,
      }));
      rejectOnce(error);
    });

    child.on("close", (code, signal) => {
      cleanup();
      writeBridgeSubprocessRecord(buildBridgeSubprocessRecord({
        subprocessId,
        command: `python-bridge:${options.command}`,
        startedAt,
        pid: child.pid,
        status: signal == null ? "exited" : "killed",
        exitCode: code,
        signal,
        completedAt: new Date().toISOString(),
        processGroup,
      }));
      if (finished) return;
      if (earlyStopError != null) {
        rejectOnce(earlyStopError);
        return;
      }
      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `python bridge exited with code ${code}`;
        rejectOnce(new Error(message));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolveOnce(options.responseSchema.parse(parsed));
      } catch (error) {
        rejectOnce(
          new Error(
            `failed to parse python bridge response: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });

    child.stdin.on("error", (error) => {
      if (earlyStopError != null) return;
      rejectOnce(error);
    });
    child.stdin.end(JSON.stringify(options.request), () => {
      if (finished || options.earlyStop == null) return;
      watcher = createGraphRagStageReportWatcher(options.earlyStop, requestEarlyStop);
    });
  });
}
