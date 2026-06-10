#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function run(label, command, args, options = {}) {
  console.log(`==> ${label}`);
  const { quiet, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: quiet ? "pipe" : "inherit",
    shell: process.platform === "win32",
    ...spawnOptions,
  });
  if (result.status !== 0) {
    console.error(`Package smoke failed: ${label}`);
    if (quiet) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }
}

function assertPath(path, label = path) {
  const full = join(root, path);
  if (!existsSync(full)) {
    console.error(`Package smoke failed: missing ${label} (${path})`);
    process.exit(1);
  }
  return full;
}

function listMjsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = normalize(join(dir, entry.name));
    if (entry.isDirectory()) {
      files.push(...listMjsFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(path);
    }
  }
  return files;
}

run("build compiled package", process.execPath, ["scripts/build.mjs"]);
run("AST grammar runtime packages", process.execPath, ["scripts/check-package-grammars.mjs"]);

for (const entry of pkg.files ?? []) {
  assertPath(entry.replace(/\/$/, ""), `package.json files[] entry ${entry}`);
}

const packageEntries = pkg.files ?? [];
const packageFiles = new Set(packageEntries.filter((entry) => !entry.endsWith("/")));
const packageDirs = packageEntries
  .filter((entry) => entry.endsWith("/"))
  .map((entry) => normalize(entry));
const packagedMjsFiles = [
  ...packageFiles,
  ...packageDirs.flatMap((entry) => listMjsFiles(entry.replace(/\/$/, ""))),
].filter((entry) => entry.endsWith(".mjs"));

function isPackagedPath(path) {
  const normalizedPath = normalize(path);
  if (packageFiles.has(normalizedPath)) return true;
  return packageDirs.some((entry) => normalizedPath.startsWith(entry));
}

for (const entry of packagedMjsFiles) {
  const source = readFileSync(join(root, entry), "utf8");
  const imports = [...source.matchAll(/\bimport\s+(?:[^"']+\s+from\s+)?["'](\.[^"']+)["']/g)]
    .map((match) => normalize(join(dirname(entry), match[1])));
  for (const imported of imports) {
    if (!isPackagedPath(imported)) {
      console.error(
        `Package smoke failed: ${entry} imports ${imported} outside files[]`,
      );
      process.exit(1);
    }
  }
}

for (const [name, binPath] of Object.entries(pkg.bin ?? {})) {
  const full = assertPath(binPath, `bin ${name}`);
  const mode = statSync(full).mode;
  if ((mode & 0o111) === 0) {
    console.error(`Package smoke failed: bin ${name} is not executable (${binPath})`);
    process.exit(1);
  }
}

assertPath("dist/index.js", "compiled main export");
assertPath("dist/index.d.ts", "compiled type export");
assertPath("dist/cli/qmd.js", "compiled CLI");

run("compiled CLI under Node", process.execPath, ["dist/cli/qmd.js", "--help"], { quiet: true });
run("package wrapper", "sh", ["bin/qmd", "--help"], { quiet: true });

if (process.env.QMD_SKIP_BUN_SMOKE === "1") {
  console.log("==> compiled CLI under Bun (skipped by QMD_SKIP_BUN_SMOKE=1)");
} else {
  run("compiled CLI under Bun", "bun", ["dist/cli/qmd.js", "--help"], { quiet: true });
}
