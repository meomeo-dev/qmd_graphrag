import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { SchemaVersion } from "../../src/contracts/common.ts";
import {
  createCliTestHarness,
  projectRoot,
  qmdRunnerArgs,
} from "../helpers/cli-harness.ts";

const harness = createCliTestHarness();

describe("mcp http daemon", () => {
  let daemonTestDir: string;
  let daemonCacheDir: string; // XDG_CACHE_HOME value (the qmd/ subdir is created automatically)
  let daemonDbPath: string;
  let daemonConfigDir: string;

  // Track spawned PIDs for cleanup
  const spawnedPids: number[] = [];

  /** Get path to PID file inside the test cache dir */
  function pidPath(): string {
    return join(daemonCacheDir, "qmd", "mcp.pid");
  }

  /** Run qmd with test-isolated env (cache, db, config) */
  async function runDaemonQmd(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return harness.runQmd(args, {
      dbPath: daemonDbPath,
      configDir: daemonConfigDir,
      env: { XDG_CACHE_HOME: daemonCacheDir },
    });
  }

  /** Spawn a foreground HTTP server (non-blocking) and return the process */
  function spawnHttpServer(
    port: number,
    options: { args?: string[]; env?: Record<string, string> } = {},
  ): import("child_process").ChildProcess {
    const runner = qmdRunnerArgs([...(options.args ?? []), "mcp", "--http", "--port", String(port)]);
    const proc = spawn(runner.command, runner.args, {
      cwd: harness.fixturesDir,
      env: {
        ...process.env,
        INDEX_PATH: daemonDbPath,
        QMD_CONFIG_DIR: daemonConfigDir,
        PWD: harness.fixturesDir,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (proc.pid) spawnedPids.push(proc.pid);
    return proc;
  }

  /** Wait for HTTP server to become ready */
  async function waitForServer(port: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        if (res.ok) return true;
      } catch { /* not ready yet */ }
      await sleep(200);
    }
    return false;
  }

  /** Pick a random high port unlikely to conflict */
  function randomPort(): number {
    return 10000 + Math.floor(Math.random() * 50000);
  }

  async function waitForPidExit(pid: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await sleep(100);
    }
    throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
  }

  async function terminatePid(pid: number): Promise<void> {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    try {
      await waitForPidExit(pid, 5000);
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      await waitForPidExit(pid, 5000);
    }
  }

  beforeAll(async () => {
    daemonTestDir = await mkdtemp(join(tmpdir(), "qmd-daemon-test-"));
    daemonCacheDir = join(daemonTestDir, "cache");
    daemonDbPath = join(daemonTestDir, "test.sqlite");
    daemonConfigDir = join(daemonTestDir, "config");

    await mkdir(join(daemonCacheDir, "qmd"), { recursive: true });
    await mkdir(daemonConfigDir, { recursive: true });
    await writeFile(join(daemonConfigDir, "index.yml"), "collections: {}\n");
  });

  afterAll(async () => {
    // Kill any leftover spawned processes
    for (const pid of spawnedPids) {
      await terminatePid(pid);
    }
    // Also clean up via PID file if present
    try {
      const pf = pidPath();
      if (existsSync(pf)) {
        const pid = parseInt(readFileSync(pf, "utf-8").trim());
        await terminatePid(pid);
        unlinkSync(pf);
      }
    } catch {}

    await rm(daemonTestDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Foreground HTTP
  // -------------------------------------------------------------------------

  test("foreground HTTP server starts and responds to health check", async () => {
    const port = randomPort();
    const proc = spawnHttpServer(port);

    try {
      const ready = await waitForServer(port);
      expect(ready).toBe(true);

      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    } finally {
      const closed = new Promise(r => proc.once("close", r));
      proc.kill("SIGTERM");
      await closed;
    }
  });

  test("foreground HTTP server honors --index when selecting the store", async () => {
    const customIndex = "mcp-alt-index";
    const customCacheDir = join(daemonTestDir, `cache-index-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const customConfigDir = join(daemonTestDir, `config-index-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(customCacheDir, { recursive: true });
    await mkdir(customConfigDir, { recursive: true });

    const addResult = await harness.runQmd(
      ["--index", customIndex, "collection", "add", harness.fixturesDir, "--name", "mcp-fixtures"],
      {
        dbPath: daemonDbPath,
        configDir: customConfigDir,
        env: {
          INDEX_PATH: "",
          XDG_CACHE_HOME: customCacheDir,
        },
      },
    );
    expect(addResult.exitCode).toBe(0);

    const updateResult = await harness.runQmd(
      ["--index", customIndex, "update"],
      {
        dbPath: daemonDbPath,
        configDir: customConfigDir,
        env: {
          INDEX_PATH: "",
          XDG_CACHE_HOME: customCacheDir,
        },
      },
    );
    expect(updateResult.exitCode).toBe(0);

    const port = randomPort();
    const proc = spawnHttpServer(port, {
      args: ["--index", customIndex],
      env: {
        INDEX_PATH: "",
        XDG_CACHE_HOME: customCacheDir,
        QMD_CONFIG_DIR: customConfigDir,
      },
    });

    try {
      const ready = await waitForServer(port);
      expect(ready).toBe(true);

      const res = await fetch(`http://localhost:${port}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searches: [{ type: "lex", query: "authentication" }], limit: 5, rerank: false }),
      });
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.error.schemaVersion).toBe(SchemaVersion);
      expect(body.error.code).toBe("endpoint_retired");
      expect(body.error.redactedMessage).toContain("REST query endpoint retired");
      expect(body.replacement).toContain("/mcp");
    } finally {
      const closed = new Promise(r => proc.once("close", r));
      proc.kill("SIGTERM");
      await closed;
    }
  }, 10000);

  // -------------------------------------------------------------------------
  // Daemon lifecycle
  // -------------------------------------------------------------------------

  test("--daemon writes PID file and starts server", async () => {
    const port = randomPort();
    const { stdout, exitCode } = await runDaemonQmd([
      "mcp", "--http", "--daemon", "--port", String(port),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`http://localhost:${port}/mcp`);

    // PID file should exist
    expect(existsSync(pidPath())).toBe(true);

    const pid = parseInt(readFileSync(pidPath(), "utf-8").trim());
    spawnedPids.push(pid);

    // Server should be reachable
    const ready = await waitForServer(port);
    expect(ready).toBe(true);

    // Clean up
    await terminatePid(pid);
    try { unlinkSync(pidPath()); } catch {}
  });

  test("stop kills daemon and removes PID file", async () => {
    const port = randomPort();
    // Start daemon
    const { exitCode: startCode } = await runDaemonQmd([
      "mcp", "--http", "--daemon", "--port", String(port),
    ]);
    expect(startCode).toBe(0);

    const pid = parseInt(readFileSync(pidPath(), "utf-8").trim());
    spawnedPids.push(pid);

    await waitForServer(port);

    // Stop it
    const { stdout: stopOut, exitCode: stopCode } = await runDaemonQmd(["mcp", "stop"]);
    expect(stopCode).toBe(0);
    expect(stopOut).toContain("Stopped");

    // PID file should be gone
    expect(existsSync(pidPath())).toBe(false);

    // Process should be dead
    await sleep(500);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("stop handles dead PID gracefully (cleans stale file)", async () => {
    // Write a PID file pointing to a dead process
    writeFileSync(pidPath(), "999999999");

    const { stdout, exitCode } = await runDaemonQmd(["mcp", "stop"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("stale");

    // PID file should be cleaned up
    expect(existsSync(pidPath())).toBe(false);
  });

  test("--daemon rejects if already running", async () => {
    const port = randomPort();
    // Start first daemon
    const { exitCode: firstCode } = await runDaemonQmd([
      "mcp", "--http", "--daemon", "--port", String(port),
    ]);
    expect(firstCode).toBe(0);

    const pid = parseInt(readFileSync(pidPath(), "utf-8").trim());
    spawnedPids.push(pid);

    await waitForServer(port);

    // Try to start second daemon — should fail
    const { stderr, exitCode } = await runDaemonQmd([
      "mcp", "--http", "--daemon", "--port", String(port + 1),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Already running");

    // Clean up first daemon
    await terminatePid(pid);
    try { unlinkSync(pidPath()); } catch {}
  });

  test("--daemon cleans stale PID file and starts fresh", async () => {
    // Write a stale PID file
    writeFileSync(pidPath(), "999999999");

    const port = randomPort();
    const { exitCode, stdout } = await runDaemonQmd([
      "mcp", "--http", "--daemon", "--port", String(port),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`http://localhost:${port}/mcp`);

    const pid = parseInt(readFileSync(pidPath(), "utf-8").trim());
    spawnedPids.push(pid);
    expect(pid).not.toBe(999999999);

    // Clean up
    const ready = await waitForServer(port);
    expect(ready).toBe(true);
    await terminatePid(pid);
    try { unlinkSync(pidPath()); } catch {}
  });
});

// =============================================================================
// MCP stdio stdout hygiene
// =============================================================================

describe("mcp stdio launcher", () => {
  test("sets native llama/ggml quiet env before Node starts so stdout stays JSON-RPC only", async () => {
    const tempPackage = await mkdtemp(join(tmpdir(), "qmd-bin-mcp-"));
    try {
      await mkdir(join(tempPackage, "bin"), { recursive: true });
      await mkdir(join(tempPackage, "dist", "cli"), { recursive: true });
      await writeFile(join(tempPackage, "dist", "cli", "qmd.js"), "// fixture\n");
      await mkdir(join(tempPackage, "fake-bin"), { recursive: true });

      const qmdBin = join(tempPackage, "bin", "qmd");
      await copyFile(join(projectRoot, "bin", "qmd"), qmdBin);
      await chmod(qmdBin, 0o755);

      // Force the wrapper down the Node branch, then put our fake `node` first
      // in PATH. The fake node behaves like the native llama/ggml layer: it
      // writes a non-JSON stdout line unless qmd pre-seeded the documented
      // quiet env vars before launching JS.
      await writeFile(join(tempPackage, "package-lock.json"), "{}\n");
      const fakeNode = join(tempPackage, "fake-bin", "node");
      await writeFile(fakeNode, `#!/bin/sh
if [ "\${GGML_BACKEND_SILENT:-}" != "1" ]; then
  printf 'llama.cpp native log on stdout\\n'
fi
printf '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\\n'
`);
      await chmod(fakeNode, 0o755);

      const proc = spawn(qmdBin, ["mcp"], {
        cwd: tempPackage,
        env: {
          ...process.env,
          PATH: `${join(tempPackage, "fake-bin")}:${process.env.PATH}`,
          LLAMA_LOG_LEVEL: "",
          GGML_LOG_LEVEL: "",
          GGML_BACKEND_SILENT: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const exitCode = await new Promise<number>((resolve, reject) => {
        proc.once("error", reject);
        proc.on("close", (code) => resolve(code ?? 1));
      });

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const lines = stdout.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      await rm(tempPackage, { recursive: true, force: true });
    }
  });
});
