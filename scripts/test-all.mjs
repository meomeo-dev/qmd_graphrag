#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const responsesPython =
  process.env.QMD_GRAPHRAG_PYTHON ||
  (existsSync(join(root, ".venv-graphrag", "bin", "python"))
    ? join(root, ".venv-graphrag", "bin", "python")
    : (process.env.PYTHON || "python3"));

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
  const { env: extraEnv, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...(extraEnv ?? {}) },
    ...spawnOptions,
  });
  if (result.status !== 0) {
    console.error(`Test task failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

run("TypeScript build typecheck", process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json", "--noEmit"]);
run("Vitest suite under Node", process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--reporter=verbose", "--testTimeout", "60000", "test/"], { env: { CI: "true" } });
run("Bun test suite", "bun", ["test", "--timeout", "60000", "--preload", "./src/test-preload.ts", "test/"], { env: { CI: "true" } });
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
