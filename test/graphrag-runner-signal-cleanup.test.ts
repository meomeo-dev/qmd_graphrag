import { spawn } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");

async function mkProjectTmpDir(prefix: string): Promise<string> {
  const tmpRoot = join(projectRoot, ".tmp-tests");
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(join(tmpRoot, prefix));
}

async function waitForFile(path: string, timeoutMs = 10000): Promise<void> {
  const startedAt = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExit(
  proc: ReturnType<typeof spawn>,
  timeoutMs = 10000,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("process did not exit"));
    }, timeoutMs);
    timer.unref();
    proc.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({ exitCode, signal });
    });
  });
}

async function writeMinimalEpubFixture(path: string, title: string): Promise<void> {
  const script = [
    "import zipfile",
    "import sys",
    "path, title = sys.argv[1:3]",
    "entries = {",
    " 'META-INF/container.xml': '<?xml version=\"1.0\"?><container xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles><rootfile full-path=\"OPS/package.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>',",
    " 'OPS/package.opf': '<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\" unique-identifier=\"bookid\"><metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>' + title + '</dc:title></metadata><manifest><item id=\"chap1\" href=\"chapter.xhtml\" media-type=\"application/xhtml+xml\"/></manifest><spine><itemref idref=\"chap1\"/></spine></package>',",
    " 'OPS/chapter.xhtml': '<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><h1>' + title + '</h1><p>Software design complexity.</p></body></html>',",
    "}",
    "with zipfile.ZipFile(path, 'w') as zf:",
    "  for name, body in entries.items():",
    "    zf.writestr(name, body)",
  ].join("\n");
  await new Promise<void>((resolveResult, reject) => {
    const proc = spawn("python3", ["-c", script, path, title]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("close", (exitCode) => {
      if (exitCode === 0) resolveResult();
      else reject(new Error(stderr || `python3 exited ${exitCode}`));
    });
    proc.on("error", reject);
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("GraphRAG runner signal cleanup", () => {
  test("SIGTERM cleanup terminates detached resume child", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-signal-cleanup-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "signal-cleanup-fixture";
    const childPidPath = join(tmpRoot, "resume-child.pid");
    const resumeStartedPath = join(tmpRoot, "resume-started");
    let runner: ReturnType<typeof spawn> | null = null;
    try {
      await mkdir(sourceDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "index.yml"), "collections: {}\n");
      await writeMinimalEpubFixture(join(sourceDir, "Signal.epub"), "Signal");

      const resumeScript = join(tmpRoot, "fake-signal-resume.mjs");
      await writeFile(resumeScript, [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.CHILD_PID_PATH, String(process.pid));",
        "writeFileSync(process.env.RESUME_STARTED_PATH, 'started\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"));

      runner = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir", sourceDir,
        "--state-root", stateRoot,
        "--log-root", logRoot,
        "--config", join(configDir, "index.yml"),
        "--qmd-index-path", join(tmpRoot, "index.sqlite"),
        "--run-id", runId,
        "--skip-dotenv",
        "--book-concurrency", "1",
        "--max-command-attempts", "1",
        "--max-resume-passes", "1",
      ], {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          QMD_GRAPHRAG_ENABLE_TEST_HOOKS: "1",
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          CHILD_PID_PATH: childPidPath,
          RESUME_STARTED_PATH: resumeStartedPath,
        },
      });
      runner.stdout.resume();
      runner.stderr.resume();

      await waitForFile(resumeStartedPath, 30000);
      const childPid = Number(readFileSync(childPidPath, "utf8"));
      expect(processAlive(childPid)).toBe(true);
      runner.kill("SIGTERM");
      const result = await waitForExit(runner);
      runner = null;
      await new Promise((resolve) => setTimeout(resolve, 250));

      const runRoot = join(stateRoot, "catalog", "batch-runs", runId);
      const events = readFileSync(join(runRoot, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const subprocessDir = join(runRoot, "subprocesses");
      const subprocess = readdirSync(subprocessDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(subprocessDir, name), "utf8")))
        .find((record) => record.pid === childPid);
      const itemDir = join(runRoot, "items");
      const item = readdirSync(itemDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(itemDir, name), "utf8")))
        .find((record) => record.sourceName === "Signal.epub");

      expect(result.exitCode).toBe(1);
      expect(events.some((event) =>
        event.event === "batch_stop_requested" &&
        event.metadata?.reason === "runner_signal_SIGTERM"
      )).toBe(true);
      expect(events.some((event) =>
        event.event === "batch_active_subprocesses_terminating" &&
        event.metadata?.reason === "runner_signal_SIGTERM"
      )).toBe(true);
      expect(subprocess).toBeDefined();
      expect(["killed", "exited"]).toContain(subprocess.status);
      expect(item).toMatchObject({
        status: "pending",
        recoveryDecision: "continue_pending",
      });
      expect(item.failureKind).toBeUndefined();
      expect(processAlive(childPid)).toBe(false);
    } finally {
      if (runner?.pid != null) {
        try {
          runner.kill("SIGKILL");
        } catch {
          // The runner may already have exited.
        }
      }
      if (existsSync(childPidPath)) {
        const childPid = Number(readFileSync(childPidPath, "utf8"));
        if (Number.isInteger(childPid) && processAlive(childPid)) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // The child may already have exited.
          }
        }
      }
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 30000);
});
