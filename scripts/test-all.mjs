#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const responsesPython =
  process.env.QMD_GRAPHRAG_PYTHON ||
  (existsSync(join(root, ".venv-graphrag", "bin", "python"))
    ? join(root, ".venv-graphrag", "bin", "python")
    : (process.env.PYTHON || "python3"));
const jsTestEnv = {
  CI: "true",
  QMD_GRAPHRAG_TEST_SKIP_REAL_FSYNC: "1",
};

function canRun(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

function selectBridgeScopePython() {
  const candidates = [
    process.env.QMD_GRAPHRAG_TEST_PYTHON,
    process.env.PYTHON,
    "python",
    "python3",
    responsesPython,
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    if (canRun(candidate, ["-c", "import pandas, yaml, pydantic"])) return candidate;
  }
  throw new Error(
    "No Python interpreter can import pandas, pyyaml, and pydantic; " +
      "install python/requirements-test.txt",
  );
}

function run(label, command, args, options = {}) {
  console.log(`==> ${label}`);
  const {
    env: extraEnv,
    retriesOnTimeout = 0,
    timeout = 10 * 60 * 1000,
    ...spawnOptions
  } = options;
  let attempt = 0;
  while (true) {
    attempt += 1;
    if (attempt > 1) {
      console.log(`==> ${label} (retry ${attempt - 1}/${retriesOnTimeout})`);
    }
    const result = spawnSync(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ...(extraEnv ?? {}) },
      timeout,
      ...spawnOptions,
    });
    if (result.error != null) {
      const timedOut = result.error.code === "ETIMEDOUT";
      if (timedOut && attempt <= retriesOnTimeout) {
        console.error(`Test task timed out, retrying: ${label}`);
        continue;
      }
      console.error(`Test task failed: ${label}`);
      console.error(result.error.message);
      process.exit(result.signal === "SIGTERM" ? 124 : 1);
    }
    if (result.status !== 0) {
      console.error(`Test task failed: ${label}`);
      process.exit(result.status ?? 1);
    }
    return;
  }
}

function listVitestTestFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listVitestTestFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(relative(root, absolutePath));
    }
  }
  return files.sort();
}

function runVitestFiles(label, files, timeout = "60000") {
  const taskTimeout = Math.max(Number.parseInt(timeout, 10) * 4, 20 * 60 * 1000);
  run(label, process.execPath, [
    join(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--reporter=default",
    "--no-file-parallelism",
    "--maxWorkers=1",
    "--minWorkers=1",
    "--testTimeout",
    timeout,
    ...files,
  ], { env: jsTestEnv, timeout: taskTimeout });
}

function runBunTestFile(label, file, timeoutMs, testTimeout) {
  run(label, "bun", [
    "test",
    "--timeout",
    testTimeout,
    "--preload",
    "./src/test-preload.ts",
    "--max-concurrency",
    "1",
    file,
  ], {
    env: jsTestEnv,
    retriesOnTimeout: 1,
    timeout: timeoutMs,
  });
}

const vitestFiles = listVitestTestFiles(join(root, "test"));
const slowVitestFiles = new Set([
  "test/book-job-state.test.ts",
  "test/graphrag-book-state.test.ts",
  "test/graphrag-runner-concurrency.test.ts",
  "test/graphrag-output-durable.test.ts",
  "test/graphrag-runner-durable-publication.test.ts",
  "test/graphrag-runner-durable-state.test.ts",
  "test/graphrag-runner-provider-auth-stop.test.ts",
  "test/graphrag-runner-remote-running.test.ts",
  "test/graphrag-runner-status-recovery.test.ts",
  "test/graphrag-runner-query-ready-manifest.test.ts",
  "test/graphrag-runner-provider-auth-reopen.test.ts",
]);

const slowBunFiles = new Set([
  "test/book-job-state.test.ts",
  "test/graphrag-book-state.test.ts",
  "test/graphrag-runner-concurrency.test.ts",
  "test/graphrag-output-durable.test.ts",
  "test/graphrag-runner-durable-publication.test.ts",
  "test/graphrag-runner-durable-state.test.ts",
  "test/graphrag-runner-provider-auth-stop.test.ts",
  "test/graphrag-runner-remote-running.test.ts",
  "test/graphrag-runner-status-recovery.test.ts",
  "test/graphrag-runner-query-ready-manifest.test.ts",
  "test/graphrag-runner-provider-auth-reopen.test.ts",
  "test/graphrag-book-hotplug-creation-gate.test.ts",
  "test/dspy-cli.test.ts",
]);

run("TypeScript build typecheck", process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json", "--noEmit"]);
vitestFiles.forEach((file, index) => {
  const timeout = slowVitestFiles.has(file) ? "150000" : "60000";
  runVitestFiles(
    `Vitest file ${index + 1}/${vitestFiles.length}: ${file}`,
    [file],
    timeout,
  );
});
vitestFiles.forEach((file, index) => {
  const timeoutMs = slowBunFiles.has(file)
    ? 20 * 60 * 1000
    : 5 * 60 * 1000;
  const testTimeout = slowBunFiles.has(file) ? "150000" : "60000";
  runBunTestFile(
    `Bun test file ${index + 1}/${vitestFiles.length}: ${file}`,
    file,
    timeoutMs,
    testTimeout,
  );
});
run("Python bridge scope tests", selectBridgeScopePython(), ["test/python/test_graphrag_bridge_scope.py"], {
  env: {
    PYTHONPATH: [
      join(root, "python"),
      join(root, "vendor", "graphrag", "packages", "graphrag-llm"),
      process.env.PYTHONPATH,
    ].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
  },
});
run("Python Responses API adapter tests", responsesPython, ["test/python/test_graphrag_responses_completion.py"], {
  env: {
    PYTHONPATH: [
      join(root, "python"),
      join(root, "vendor", "graphrag", "packages", "graphrag-llm"),
      process.env.PYTHONPATH,
    ].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
  },
});
run("Package smoke", process.execPath, ["scripts/package-smoke.mjs"]);
run("Working tree whitespace check", "git", ["diff", "--check"]);
run("GraphRAG vendor subtree unchanged", "git", [
  "diff",
  "--exit-code",
  "--",
  "vendor/graphrag",
]);
