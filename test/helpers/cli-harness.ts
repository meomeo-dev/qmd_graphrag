import { afterAll, beforeAll, beforeEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const qmdCommand = isBunRuntime
  ? { command: process.execPath, args: [qmdScript] }
  : { command: process.execPath, args: [tsxCli, qmdScript] };

export function qmdRunnerArgs(args: string[]): { command: string; args: string[] } {
  return { command: qmdCommand.command, args: [...qmdCommand.args, ...args] };
}

export type QmdRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type QmdRunOptions = {
  cwd?: string;
  env?: Record<string, string>;
  dbPath?: string;
  configDir?: string;
  timeoutMs?: number;
};

export function createCliTestHarness(): {
  readonly testDir: string;
  readonly testDbPath: string;
  readonly testConfigDir: string;
  readonly fixturesDir: string;
  runQmd: (args: string[], options?: QmdRunOptions) => Promise<QmdRunResult>;
  getFreshDbPath: () => string;
  createIsolatedTestEnv: (
    prefix: string,
  ) => Promise<{ dbPath: string; configDir: string }>;
} {
  let testDir = "";
  let testDbPath = "";
  let testConfigDir = "";
  let fixturesDir = "";
  let testCounter = 0;

  async function runQmd(
    args: string[],
    options: QmdRunOptions = {},
  ): Promise<QmdRunResult> {
    const workingDir = options.cwd || fixturesDir;
    const dbPath = options.dbPath || testDbPath;
    const configDir = options.configDir || testConfigDir;
    const runner = qmdRunnerArgs(args);
    const proc = spawn(runner.command, runner.args, {
      cwd: workingDir,
      env: {
        ...process.env,
        INDEX_PATH: dbPath,
        QMD_CONFIG_DIR: configDir,
        PWD: workingDir,
        QMD_DOCTOR_DEVICE_PROBE: "0",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let killedForTimeout = false;
    const timeout = setTimeout(() => {
      killedForTimeout = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 2000).unref();
    }, options.timeoutMs ?? 60000);
    timeout.unref();

    const stdoutPromise = new Promise<string>((resolve, reject) => {
      let data = "";
      proc.stdout?.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      proc.once("error", reject);
      proc.stdout?.once("end", () => resolve(data));
    });
    const stderrPromise = new Promise<string>((resolve, reject) => {
      let data = "";
      proc.stderr?.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      proc.once("error", reject);
      proc.stderr?.once("end", () => resolve(data));
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      proc.once("error", reject);
      proc.on("close", (code) => resolve(code ?? 1));
    });
    clearTimeout(timeout);
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    if (killedForTimeout) {
      return {
        stdout,
        stderr: `${stderr}\nqmd command timed out after ${options.timeoutMs ?? 60000}ms`
          .trim(),
        exitCode: exitCode || 124,
      };
    }

    return { stdout, stderr, exitCode };
  }

  function getFreshDbPath(): string {
    testCounter += 1;
    return join(testDir, `test-${testCounter}.sqlite`);
  }

  async function createIsolatedTestEnv(
    prefix: string,
  ): Promise<{ dbPath: string; configDir: string }> {
    testCounter += 1;
    const dbPath = join(testDir, `${prefix}-${testCounter}.sqlite`);
    const configDir = join(testDir, `${prefix}-config-${testCounter}`);
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    return { dbPath, configDir };
  }

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-test-"));
    testDbPath = join(testDir, "test.sqlite");
    testConfigDir = join(testDir, "config");
    fixturesDir = join(testDir, "fixtures");

    await mkdir(testConfigDir, { recursive: true });
    await mkdir(fixturesDir, { recursive: true });
    await mkdir(join(fixturesDir, "notes"), { recursive: true });
    await mkdir(join(fixturesDir, "docs"), { recursive: true });
    await writeFile(join(testConfigDir, "index.yml"), "collections: {}\n");

    await writeFile(
      join(fixturesDir, "README.md"),
      `# Test Project

This is a test project for QMD CLI testing.

## Features

- Full-text search with BM25
- Vector similarity search
- Hybrid search with reranking
`,
    );

    await writeFile(
      join(fixturesDir, "notes", "meeting.md"),
      `# Team Meeting Notes

Date: 2024-01-15

## Attendees
- Alice
- Bob
- Charlie

## Discussion Topics
- Project timeline review
- Resource allocation
- Technical debt prioritization

## Action Items
1. Alice to update documentation
2. Bob to fix authentication bug
3. Charlie to review pull requests
`,
    );

    await writeFile(
      join(fixturesDir, "notes", "ideas.md"),
      `# Product Ideas

## Feature Requests
- Dark mode support
- Keyboard shortcuts
- Export to PDF

## Technical Improvements
- Improve search performance
- Add caching layer
- Optimize database queries
`,
    );

    await writeFile(
      join(fixturesDir, "docs", "api.md"),
      `# API Documentation

## Endpoints

### GET /search
Search for documents.

Parameters:
- q: Search query (required)
- limit: Max results (default: 10)

### GET /document/:id
Retrieve a specific document.

### POST /index
Index new documents.
`,
    );

    await writeFile(
      join(fixturesDir, "test1.md"),
      `# Test Document 1

This is the first test document.

It has multiple lines for testing line numbers.
Line 6 is here.
Line 7 is here.
`,
    );

    await writeFile(
      join(fixturesDir, "test2.md"),
      `# Test Document 2

This is the second test document.
`,
    );
  });

  afterAll(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await writeFile(join(testConfigDir, "index.yml"), "collections: {}\n");
  });

  return {
    get testDir() { return testDir; },
    get testDbPath() { return testDbPath; },
    get testConfigDir() { return testConfigDir; },
    get fixturesDir() { return fixturesDir; },
    runQmd,
    getFreshDbPath,
    createIsolatedTestEnv,
  };
}
