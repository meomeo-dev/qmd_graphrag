/**
 * CLI Integration Tests
 *
 * Tests all qmd CLI commands using a temporary test database via INDEX_PATH.
 * These tests spawn actual qmd processes to verify end-to-end functionality.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chmod, copyFile, mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { hostname, tmpdir } from "os";
import { join, dirname, relative, sep } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { createHash } from "crypto";
import YAML from "yaml";
import {
  buildEditorUri,
  termLink,
  resolveEmbedModelForCli,
  resolveRerankModelForCli,
} from "../src/cli/qmd.ts";
import { openDatabase } from "../src/db.ts";
import { SchemaVersion } from "../src/contracts/common.ts";
import {
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
  JINA_MULTIMODAL_EMBEDDING_MODEL,
  JINA_MULTIMODAL_RERANK_MODEL,
} from "../src/llm.ts";
import { setConfigSource } from "../src/collections.ts";
import { classifyFailure } from "../scripts/graphrag/batch-failure-classifier.mjs";
import {
  hashLanceDbDirectoryContents,
} from "../src/job-state/artifact-validation.ts";
import { hashFile } from "../src/job-state/fingerprint.ts";
import { sanitizeVaultText } from "../src/vault/metadata.ts";

const MinimalParquetFixture = Buffer.from(
  "UEFSMRUEFRIVFkwVAhUAEgAACSAFAAAAcm93LTEVABUSFRYsFQIVEBUGFQYcNgAoBXJvdy0xGAVyb3ctMRERAAAACSACAAAAAgEBAgAVBBksNQAYBnNjaGVtYRUCABUMJQIYAmlkJQBMHAAAABYCGRwZHCYAHBUMGTUABhAZGAJpZBUCFgIWigEWkgEmOiYIHDYAKAVyb3ctMRgFcm93LTEREQAZLBUEFQAVAgAVABUQFQIAPBYKGQYZJgACAAAAFooBFgImCBaSAQAZHBgMQVJST1c6c2NoZW1hGKABLy8vLy8zQUFBQUFRQUFBQUFBQUtBQXdBQmdBRkFBZ0FDZ0FBQUFBQkJBQU1BQUFBQ0FBSUFBQUFCQUFJQUFBQUJBQUFBQUVBQUFBVUFBQUFFQUFVQUFnQUJnQUhBQXdBQUFBUUFCQUFBQUFBQUFFRkVBQUFBQmdBQUFBRUFBQUFBQUFBQUFJQUFBQnBaQUFBQkFBRUFBUUFBQUFBQUFBQQAYIHBhcnF1ZXQtY3BwLWFycm93IHZlcnNpb24gMjIuMC4wGRwcAAAAWgEAAFBBUjE=",
  "base64",
);

// Test fixtures directory and database path
let testDir: string;
let testDbPath: string;
let testConfigDir: string;
let fixturesDir: string;
let testCounter = 0; // Unique counter for each test run

// Get the directory where this test file lives
const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const qmdCommand = isBunRuntime
  ? { command: process.execPath, args: [qmdScript] }
  : { command: process.execPath, args: [tsxCli, qmdScript] };

function qmdRunnerArgs(args: string[]): { command: string; args: string[] } {
  return { command: qmdCommand.command, args: [...qmdCommand.args, ...args] };
}

// Helper to run qmd command with test database
async function runQmd(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    dbPath?: string;
    configDir?: string;
    timeoutMs?: number;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const workingDir = options.cwd || fixturesDir;
  const dbPath = options.dbPath || testDbPath;
  const configDir = options.configDir || testConfigDir;
  const runner = qmdRunnerArgs(args);
  const proc = spawn(runner.command, runner.args, {
    cwd: workingDir,
    env: {
      ...process.env,
      INDEX_PATH: dbPath,
      QMD_CONFIG_DIR: configDir, // Use test config directory
      PWD: workingDir, // Must explicitly set PWD since getPwd() checks this
      QMD_DOCTOR_DEVICE_PROBE: "0", // Keep integration tests deterministic on CI hosts without usable GPU backends.
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
      stderr: `${stderr}\nqmd command timed out after ${options.timeoutMs ?? 60000}ms`.trim(),
      exitCode: exitCode || 124,
    };
  }

  return { stdout, stderr, exitCode };
}

// Get a fresh database path for isolated tests
function getFreshDbPath(): string {
  testCounter++;
  return join(testDir, `test-${testCounter}.sqlite`);
}

// Create an isolated test environment (db + config dir)
async function createIsolatedTestEnv(prefix: string): Promise<{ dbPath: string; configDir: string }> {
  testCounter++;
  const dbPath = join(testDir, `${prefix}-${testCounter}.sqlite`);
  const configDir = join(testDir, `${prefix}-config-${testCounter}`);
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
  return { dbPath, configDir };
}

// Setup test fixtures
beforeAll(async () => {
  // Create temp directory structure
  testDir = await mkdtemp(join(tmpdir(), "qmd-test-"));
  testDbPath = join(testDir, "test.sqlite");
  testConfigDir = join(testDir, "config");
  fixturesDir = join(testDir, "fixtures");

  await mkdir(testConfigDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(join(fixturesDir, "notes"), { recursive: true });
  await mkdir(join(fixturesDir, "docs"), { recursive: true });

  // Create empty YAML config for tests
  await writeFile(
    join(testConfigDir, "index.yml"),
    "collections: {}\n"
  );

  // Create test markdown files
  await writeFile(
    join(fixturesDir, "README.md"),
    `# Test Project

This is a test project for QMD CLI testing.

## Features

- Full-text search with BM25
- Vector similarity search
- Hybrid search with reranking
`
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
`
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
`
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
`
  );

  // Create test files for path normalization tests
  await writeFile(
    join(fixturesDir, "test1.md"),
    `# Test Document 1

This is the first test document.

It has multiple lines for testing line numbers.
Line 6 is here.
Line 7 is here.
`
  );

  await writeFile(
    join(fixturesDir, "test2.md"),
    `# Test Document 2

This is the second test document.
`
  );
});

// Cleanup after all tests
afterAll(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
  }
});

// Reset YAML config before each test to ensure isolation
beforeEach(async () => {
  // Reset to empty collections config
  await writeFile(
    join(testConfigDir, "index.yml"),
    "collections: {}\n"
  );
});

describe("CLI Help", () => {
  test("shows help with --help flag", async () => {
    const { stdout, exitCode } = await runQmd(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("qmd collection add");
    expect(stdout).toContain("qmd search");
    expect(stdout).toContain("qmd query --graphrag");
    expect(stdout).toContain("--mode <qmd|auto>");
    expect(stdout).toContain("--no-gpu");
    expect(stdout).toContain("qmd skill show/install");
  });

  test("shows help with no arguments", async () => {
    const { stdout, exitCode } = await runQmd([]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Usage:");
  });
});



describe("CLI Skills", () => {
  test("lists bundled runtime skills", async () => {
    const { stdout, stderr, exitCode } = await runQmd(["skills", "list"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd");
    expect(stdout).toContain("Search local markdown knowledge bases");
  });

  test("gets version-matched runtime skill content", async () => {
    const { stdout, stderr, exitCode } = await runQmd(["skills", "get", "qmd"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# QMD - Query Markdown Documents");
    expect(stdout).toContain("## MCP Tool: `query`");
    expect(stdout).not.toContain("This file is a discovery stub");
  });

  test("gets runtime skill with supplementary references", async () => {
    const { stdout, stderr, exitCode } = await runQmd(["skills", "get", "qmd", "--full"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# QMD - Query Markdown Documents");
    expect(stdout).toContain("--- references/mcp-setup.md ---");
    expect(stdout).toContain("# QMD MCP Server Setup");
  });

  test("prints canonical repository skill path", async () => {
    const { stdout, stderr, exitCode } = await runQmd(["skills", "path", "qmd"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/skills\/qmd$/);
  });

  test("legacy skill show prints the canonical skill", async () => {
    const { stdout, stderr, exitCode } = await runQmd(["skill", "show"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# QMD - Query Markdown Documents");
    expect(stdout).toContain("## MCP Tool: `query`");
    expect(stdout).not.toContain("This file is a discovery stub");
  });

  test("legacy skill install writes a qmd skill show bootstrap", async () => {
    const installDir = join(testDir, "skill-install-target");
    await mkdir(installDir, { recursive: true });

    const { stdout, stderr, exitCode } = await runQmd(["skill", "install", "--yes"], { cwd: installDir });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Installed QMD skill");

    const installedSkillDir = join(installDir, ".agents", "skills", "qmd");
    const installed = readFileSync(join(installedSkillDir, "SKILL.md"), "utf8");
    expect(installed).toContain("# QMD - Query Markdown Documents");
    expect(installed).toContain("!`qmd skill show`");
    expect(installed).toContain("qmd get");
    expect(installed).not.toContain("## MCP Tool: `query`");
    expect(readFileSync(join(installedSkillDir, "references", "mcp-setup.md"), "utf8")).toContain("# QMD MCP Server Setup");
  });
});

describe("CLI Embed", () => {
  test("prefers QMD_EMBED_MODEL for qmd embed when the index has no model pin", () => {
    const prev = process.env.QMD_EMBED_MODEL;
    process.env.QMD_EMBED_MODEL = "hf:env/embed-model.gguf";
    setConfigSource({ config: { collections: {} } });

    try {
      expect(resolveEmbedModelForCli()).toBe("hf:env/embed-model.gguf");
    } finally {
      setConfigSource();
      if (prev === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = prev;
    }
  });

  test("falls back to the default embed model when QMD_EMBED_MODEL is unset", () => {
    const prev = process.env.QMD_EMBED_MODEL;
    delete process.env.QMD_EMBED_MODEL;
    setConfigSource({ config: { collections: {} } });

    try {
      expect(resolveEmbedModelForCli()).toBe(DEFAULT_EMBED_MODEL_URI);
    } finally {
      setConfigSource();
      if (prev === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = prev;
    }
  });

  test("Jina embedding profile drives active embed and rerank model selection", () => {
    const prevEmbed = process.env.QMD_EMBED_MODEL;
    const prevRerank = process.env.QMD_RERANK_MODEL;
    process.env.QMD_EMBED_MODEL = "jina:jina-embeddings-v5-text-small";
    process.env.QMD_RERANK_MODEL = "jina:jina-reranker-v3";
    setConfigSource({
      config: {
        collections: {},
        models: {
          embed: "jina:jina-embeddings-v5-text-small",
          rerank: "jina:jina-reranker-v3",
        },
        providers: {
          jina: {
            embedding_profile: "multimodal",
          },
        },
      },
    });

    try {
      expect(resolveEmbedModelForCli()).toBe(`jina:${JINA_MULTIMODAL_EMBEDDING_MODEL}`);
      expect(resolveRerankModelForCli()).toBe(`jina:${JINA_MULTIMODAL_RERANK_MODEL}`);
    } finally {
      setConfigSource();
      if (prevEmbed === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = prevEmbed;
      if (prevRerank === undefined) delete process.env.QMD_RERANK_MODEL;
      else process.env.QMD_RERANK_MODEL = prevRerank;
    }
  });

  test("rejects invalid --max-docs-per-batch", async () => {
    const { stderr, exitCode } = await runQmd(["embed", "--max-docs-per-batch", "0"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("maxDocsPerBatch");
    const payload = JSON.parse(stderr);
    expect(payload.schemaVersion).toBe(SchemaVersion);
    expect(payload.route).toBe("qmd");
    expect(payload.stage).toBe("route");
    expect(payload.code).toBe("cli_error");
    expect(payload.retryable).toBe(false);
    expect(payload.redactedMessage).toContain("maxDocsPerBatch");
    expect(payload.metadata.diagnosticHint).toContain("qmd doctor");
  });

  test("rejects invalid --max-batch-mb", async () => {
    const { stderr, exitCode } = await runQmd(["embed", "--max-batch-mb", "0"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("maxBatchBytes");
  });
});

describe("CLI Skill Commands", () => {
  test("shows embedded skill with --skill alias", async () => {
    const { stdout, exitCode } = await runQmd(["--skill"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("QMD Skill");
    expect(stdout).toContain("name: qmd");
    expect(stdout).toContain("allowed-tools: Bash(qmd:*), mcp__qmd__*");
  });

  test("shows skill help with -h", async () => {
    const { stdout, exitCode } = await runQmd(["skill", "-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: qmd skill <show|install> [options]");
    expect(stdout).toContain("install");
    expect(stdout).toContain("--global");
  });

  test("installs the skill into the current project", async () => {
    const projectDir = join(testDir, "skill-project");
    await mkdir(projectDir, { recursive: true });

    const { stdout, exitCode } = await runQmd(["skill", "install"], { cwd: projectDir });
    expect(exitCode).toBe(0);

    const skillDir = join(projectDir, ".agents", "skills", "qmd");
    const installed = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(installed).toContain("# QMD - Query Markdown Documents");
    expect(installed).toContain("!`qmd skill show`");
    expect(existsSync(join(projectDir, ".claude", "skills", "qmd"))).toBe(false);
    expect(stdout).toContain(`✓ Installed QMD skill to ${skillDir}`);
    expect(stdout).toContain("Tip: create a Claude symlink manually");
  });

  test("installs globally and creates the Claude symlink with --yes", async () => {
    const fakeHome = join(testDir, "skill-home");
    await mkdir(fakeHome, { recursive: true });

    const { stdout, exitCode } = await runQmd(["skill", "install", "--global", "--yes"], {
      env: { HOME: fakeHome },
    });
    expect(exitCode).toBe(0);

    const skillDir = join(fakeHome, ".agents", "skills", "qmd");
    const claudeLink = join(fakeHome, ".claude", "skills", "qmd");

    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain("!`qmd skill show`");
    expect(lstatSync(claudeLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(claudeLink, "SKILL.md"), "utf-8")).toContain("!`qmd skill show`");
    expect(stdout).toContain(`✓ Installed QMD skill to ${skillDir}`);
    expect(stdout).toContain(`✓ Linked Claude skill at ${claudeLink}`);
  });

  test("skips Claude qmd symlink when .claude/skills already points to .agents/skills", async () => {
    const fakeHome = join(testDir, "skill-home-shared");
    await mkdir(join(fakeHome, ".agents"), { recursive: true });
    await mkdir(join(fakeHome, ".claude"), { recursive: true });
    symlinkSync(join(fakeHome, ".agents", "skills"), join(fakeHome, ".claude", "skills"), "dir");

    const { stdout, exitCode } = await runQmd(["skill", "install", "--global", "--yes"], {
      env: { HOME: fakeHome },
    });
    expect(exitCode).toBe(0);

    const skillDir = join(fakeHome, ".agents", "skills", "qmd");
    expect(lstatSync(skillDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain("!`qmd skill show`");
    expect(stdout).toContain(`✓ Claude already sees the skill via ${join(fakeHome, ".claude", "skills")}`);
  });

  test("refuses to overwrite an existing install without --force", async () => {
    const projectDir = join(testDir, "skill-project-force");
    await mkdir(projectDir, { recursive: true });

    const first = await runQmd(["skill", "install"], { cwd: projectDir });
    expect(first.exitCode).toBe(0);

    const second = await runQmd(["skill", "install"], { cwd: projectDir });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("Skill already exists");
    expect(second.stderr).toContain("--force");
  });
});

describe("CLI Init Command", () => {
  test("creates a project-local .qmd index", async () => {
    const projectDir = join(testDir, "init-project");
    await mkdir(projectDir, { recursive: true });

    const { stdout, exitCode } = await runQmd(["init"], { cwd: projectDir });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("ready to go with new local index");
    expect(existsSync(join(projectDir, ".qmd", "index.yml"))).toBe(true);
    expect(existsSync(join(projectDir, ".qmd", "index.sqlite"))).toBe(true);
    const configText = readFileSync(join(projectDir, ".qmd", "index.yml"), "utf-8");
    expect(configText).toContain("collections: {}");
    expect(configText).toContain("models:");
    expect(configText).toContain("providers:");
    expect(configText).toContain("graphrag:");
    expect(configText).toContain("query:");

    const initConfig = YAML.parse(configText);
    const repositoryConfig = YAML.parse(
      readFileSync(join(projectRoot, ".qmd", "index.yml"), "utf-8"),
    );
    expect(initConfig.models).toEqual(repositoryConfig.models);
    expect(initConfig.providers).toEqual(repositoryConfig.providers);
    expect(initConfig.embedding).toEqual(repositoryConfig.embedding);
    expect(initConfig.graphrag).toMatchObject({
      enabled: repositoryConfig.graphrag.enabled,
      vault: repositoryConfig.graphrag.vault,
      concurrent_requests: repositoryConfig.graphrag.concurrent_requests,
      default_method: repositoryConfig.graphrag.default_method,
      default_response_type: repositoryConfig.graphrag.default_response_type,
    });
    expect(initConfig.query).toEqual(repositoryConfig.query);
  });

  test("refuses to initialize in HOME", async () => {
    const fakeHome = join(testDir, "init-home");
    await mkdir(fakeHome, { recursive: true });

    const { stderr, exitCode } = await runQmd(["init"], {
      cwd: fakeHome,
      env: { HOME: fakeHome },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Refusing to initialize a local index in $HOME");
    expect(stderr).toContain("global index is automatically created");
    expect(existsSync(join(fakeHome, ".qmd", "index.yml"))).toBe(false);
  });
});

describe("CLI Add Command", () => {
  test("adds files from current directory", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "add", "."]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collection:");
    expect(stdout).toContain("Indexed:");
  });

  test("adds files with custom glob pattern", async () => {
    const { stdout, stderr, exitCode } = await runQmd(["collection", "add", ".", "--mask", "notes/*.md"]);
    if (exitCode !== 0) {
      console.error("Command failed:", stderr);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collection:");
    // Should find meeting.md and ideas.md in notes/
    expect(stdout).toContain("notes/*.md");
  });

  test("can recreate collection with remove and add", async () => {
    // First add
    await runQmd(["collection", "add", "."]);
    // Remove it
    await runQmd(["collection", "remove", "fixtures"]);
    // Re-add
    const { stdout, exitCode } = await runQmd(["collection", "add", "."]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collection 'fixtures' created successfully");
  });
});

describe("CLI Status Command", () => {
  beforeEach(async () => {
    // Ensure we have indexed files
    await runQmd(["collection", "add", "."]);
  });

  test("qmd doctor reports core index health checks", async () => {
    const { stdout, exitCode } = await runQmd(["doctor"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("QMD Doctor");
    expect(stdout).toContain("SQLite runtime");
    expect(stdout).toContain("sqlite-vec");
    expect(stdout).toContain("environment overrides");
    expect(stdout).toContain("INDEX_PATH");
    expect(stdout).toContain("overrides the SQLite index path");
    expect(stdout).toContain("QMD_CONFIG_DIR");
    expect(stdout).toContain("overrides the QMD config directory");
    expect(stdout).toContain("model defaults");
    expect(stdout).toContain("model cache");
    expect(stdout).toContain("device mode");
    expect(stdout).toContain("device probe");
    expect(stdout).toContain("embedding freshness");
    expect(stdout).toContain("embedding fingerprints");
    expect(stdout).toContain("embedding vector sample");
    expect(stdout).toContain("please run qmd embed again");

    const configText = readFileSync(join(testConfigDir, "index.yml"), "utf-8");
    expect(configText).toContain("models:");
    expect(configText).toContain(DEFAULT_EMBED_MODEL_URI);
    expect(configText).toContain(DEFAULT_GENERATE_MODEL_URI);
    expect(configText).toContain(DEFAULT_RERANK_MODEL_URI);
    expect(configText).toContain("providers:");
    expect(configText).toContain("graphrag:");
    expect(configText).toContain("query:");
  }, 20000);

  test("qmd doctor --json emits structured diagnostics", async () => {
    const { stdout, stderr, exitCode } = await runQmd(["doctor", "--json"], {
      env: { QMD_DOCTOR_DEVICE_PROBE: "0" },
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const payload = JSON.parse(stdout) as {
      schemaVersion: string;
      runtime: string;
      checks: { label: string; ok: boolean; details: string }[];
      environmentOverrides: {
        name: string;
        value: string;
        valueRedacted: boolean;
        consequence: string;
      }[];
      nextSteps: string[];
    };
    expect(payload.schemaVersion).toBe("qmd.doctor.v1");
    expect(payload.runtime).toMatch(/sqlite/);
    expect(payload.checks.some((check) => check.label === "SQLite runtime")).toBe(true);
    expect(payload.checks.some((check) => check.label === "embedding freshness")).toBe(true);
    expect(payload.environmentOverrides.some((override) => override.name === "INDEX_PATH")).toBe(true);
    expect(payload.environmentOverrides.every((override) => override.value === "[redacted]")).toBe(true);
    expect(payload.environmentOverrides.every((override) => override.valueRedacted)).toBe(true);
    expect(payload.nextSteps.some((step) => step.includes("QMD_DOCTOR_DEVICE_PROBE"))).toBe(true);
  }, 20000);

  test("qmd doctor --json redacts invalid config diagnostics", async () => {
    const env = await createIsolatedTestEnv("doctor-json-invalid-config");
    await writeFile(join(env.configDir, "index.yml"), "collections:\n  bad: [unterminated\n");

    const { stdout, stderr, exitCode } = await runQmd(["doctor", "--json"], {
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const payload = JSON.parse(stdout) as {
      checks: { label: string; ok: boolean; details: string }[];
      nextSteps: string[];
    };
    const indexConfig = payload.checks.find((check) => check.label === "index config");
    expect(indexConfig?.ok).toBe(false);
    expect(indexConfig?.details).toContain("invalid index.yml at index.yml");
    expect(indexConfig?.details).not.toContain(env.configDir);
    expect(payload.nextSteps.join("\n")).not.toContain(env.configDir);
  }, 20000);

  test("qmd doctor warns when no collections are configured", async () => {
    const env = await createIsolatedTestEnv("doctor-no-collections");
    const { stdout, exitCode } = await runQmd(["doctor"], { dbPath: env.dbPath, configDir: env.configDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("index config");
    expect(stdout).toContain("no collections configured");
    expect(stdout).toContain("qmd collection add .");
  }, 20000);

  test("qmd doctor reports invalid index.yml without crashing", async () => {
    const env = await createIsolatedTestEnv("doctor-invalid-config");
    await writeFile(join(env.configDir, "index.yml"), "collections:\n  bad: [unterminated\n");

    const { stdout, exitCode } = await runQmd(["doctor"], { dbPath: env.dbPath, configDir: env.configDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("index config");
    expect(stdout).toContain("invalid index.yml at");
    const diagnosticLines = stdout
      .split("\n")
      .filter(line => !line.includes("Index:") && !line.includes("INDEX_PATH=") && !line.includes("QMD_CONFIG_DIR="));
    expect(diagnosticLines.join("\n")).not.toContain(env.configDir);
    expect(stdout).toContain("index.yml");
    expect(stdout).toContain("fix the YAML");
  }, 20000);

  test("qmd doctor warns when configured models differ from code defaults", async () => {
    const env = await createIsolatedTestEnv("doctor-custom-models");
    await writeFile(join(env.configDir, "index.yml"), `collections: {}\nmodels:\n  embed: hf:example/custom-embed/custom.gguf\n  generate: ${DEFAULT_GENERATE_MODEL_URI}\n  rerank: hf:example/custom-rerank/custom.gguf\n`);

    const { stdout, exitCode } = await runQmd(["doctor"], { dbPath: env.dbPath, configDir: env.configDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("model defaults");
    expect(stdout).toContain("non-default model configuration");
    expect(stdout).toContain("index hf:example/custom-embed/custom.gguf");
    expect(stdout).toContain("index hf:example/custom-rerank/custom.gguf");
    expect(stdout).toContain("might be ok");
    expect(stdout).toContain("qmd pull");
  }, 20000);

  test("qmd doctor identifies cached non-GGUF model files", async () => {
    const env = await createIsolatedTestEnv("doctor-invalid-model-cache");
    const model = "hf:example/custom-model/custom.gguf";
    await writeFile(join(env.configDir, "index.yml"), `collections: {}\nmodels:\n  embed: ${model}\n  generate: ${model}\n  rerank: ${model}\n`);
    const cacheRoot = join(env.configDir, "cache");
    const modelCacheDir = join(cacheRoot, "qmd", "models");
    await mkdir(modelCacheDir, { recursive: true });
    const badModelPath = join(modelCacheDir, "custom.gguf");
    await writeFile(badModelPath, "<!doctype html><html>blocked</html>");

    const { stdout, exitCode } = await runQmd(["doctor"], {
      dbPath: env.dbPath,
      configDir: env.configDir,
      env: {
        XDG_CACHE_HOME: cacheRoot,
        QMD_DOCTOR_DEVICE_PROBE: "0",
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("model cache");
    expect(stdout).toContain("invalid 1");
    expect(stdout).toContain("HTML page, not a GGUF model");
    expect(stdout).toContain("qmd pull --refresh");
  }, 20000);

  test("qmd doctor says when models are overridden by env", async () => {
    const env = await createIsolatedTestEnv("doctor-env-models");
    await writeFile(join(env.configDir, "index.yml"), "collections: {}\n");

    const customEmbed = "hf:example/env-embed/custom.gguf";
    const { stdout, exitCode } = await runQmd(["doctor"], {
      dbPath: env.dbPath,
      configDir: env.configDir,
      env: { QMD_EMBED_MODEL: customEmbed },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("model defaults");
    expect(stdout).toContain(`env QMD_EMBED_MODEL=${customEmbed}`);
    expect(stdout).toContain("might be ok");
    expect(stdout).toContain("environment overrides");
    expect(stdout).toContain(`QMD_EMBED_MODEL=${customEmbed}`);
    expect(stdout).toContain("sets the active embed model");
  }, 20000);

  test("qmd doctor reports Jina model env overrides ignored by profile", async () => {
    const env = await createIsolatedTestEnv("doctor-jina-profile-env-models");
    await writeFile(join(env.configDir, "index.yml"), YAML.stringify({
      collections: {},
      providers: {
        jina: {
          embedding_profile: "multimodal",
        },
      },
    }));

    const { stdout, exitCode } = await runQmd(["doctor"], {
      dbPath: env.dbPath,
      configDir: env.configDir,
      env: {
        QMD_EMBED_MODEL: "jina:jina-embeddings-v5-text-small",
        QMD_RERANK_MODEL: "jina:jina-reranker-v3",
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("providers.jina.embedding_profile=multimodal owns");
    expect(stdout).toContain("ignored");
    expect(stdout).toContain("jina:jina-embeddings-v5-omni-small");
    expect(stdout).toContain("jina:jina-reranker-m0");
  }, 20000);

  test("qmd doctor shows CPU-forced device mode with QMD_FORCE_CPU=1", async () => {
    const env = await createIsolatedTestEnv("doctor-force-cpu");
    const { stdout, exitCode } = await runQmd(["doctor"], {
      dbPath: env.dbPath,
      configDir: env.configDir,
      env: {
        QMD_FORCE_CPU: "1",
        QMD_DOCTOR_DEVICE_PROBE: "0",
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("QMD_FORCE_CPU=1");
    expect(stdout).toContain("forces llama.cpp to bypass GPU backends");
    expect(stdout).toContain("device mode: CPU forced (QMD_FORCE_CPU)");
  }, 20000);

  test("qmd doctor lists known environment overrides and consequences", async () => {
    const env = await createIsolatedTestEnv("doctor-env-overrides");
    const overrides = {
      XDG_CACHE_HOME: join(env.configDir, "cache"),
      QMD_DOCTOR_DEVICE_PROBE: "0",
      QMD_FORCE_CPU: "1",
      QMD_LLAMA_GPU: "metal",
      QMD_EMBED_PARALLELISM: "2",
      QMD_EXPAND_CONTEXT_SIZE: "4096",
      QMD_RERANK_CONTEXT_SIZE: "8192",
      QMD_EMBED_CONTEXT_SIZE: "1024",
      QMD_EDITOR_URI: "vscode://file/{file}:{line}:{col}",
      QMD_SKILLS_DIR: "/tmp/qmd-skills",
      QMD_DISABLE_DARWIN_QUERY_JSON_SAFE_EXIT: "1",
      NO_COLOR: "1",
      CI: "1",
      HF_ENDPOINT: "https://hf-mirror.com",
      WSL_DISTRO_NAME: "Ubuntu",
      WSL_INTEROP: "1",
    };

    const { stdout, exitCode } = await runQmd(["doctor"], {
      dbPath: env.dbPath,
      configDir: env.configDir,
      env: overrides,
    });
    expect(exitCode).toBe(0);
    for (const name of Object.keys(overrides)) {
      expect(stdout).toContain(name);
    }
    expect(stdout).toContain("forces llama.cpp to bypass GPU backends");
    expect(stdout).toContain("moves the default index cache");
    expect(stdout).toContain("disables real LLM operations");
    expect(stdout).toContain("changes Hugging Face download endpoint");
  }, 20000);

  test("qmd doctor flags mixed embedding fingerprints", async () => {
    const db = openDatabase(testDbPath);
    const doc = db.prepare(`SELECT hash FROM documents WHERE active = 1 LIMIT 1`).get() as { hash: string };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at)
      VALUES (?, 0, 0, ?, 'stale1', 2, ?)
    `).run(doc.hash, resolveEmbedModelForCli(), now);
    db.prepare(`
      INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at)
      VALUES (?, 1, 1, ?, 'stale2', 2, ?)
    `).run(doc.hash, resolveEmbedModelForCli(), now);
    db.close();

    const { stdout, exitCode } = await runQmd(["doctor"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("embedding fingerprints");
    expect(stdout).toContain("mixed named embedding fingerprints");
    expect(stdout).toContain("stale1");
  }, 20000);

  test("shows index status", async () => {
    const { stdout, exitCode } = await runQmd(["status"]);
    expect(exitCode).toBe(0);
    // Should show collection info
    expect(stdout).toContain("Collection");
  });

  test("status omits device probing details; doctor owns GPU diagnostics", async () => {
    const { stdout, exitCode } = await runQmd(["status"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Device");
    expect(stdout).not.toContain("QMD_STATUS_DEVICE_PROBE");
    expect(stdout).not.toContain("not probed");
  });
});

describe("CLI Search Command", () => {
  beforeEach(async () => {
    // Ensure we have indexed files
    await runQmd(["collection", "add", "."]);
  });

  test("searches for documents with BM25", async () => {
    const { stdout, exitCode } = await runQmd(["search", "meeting"]);
    expect(exitCode).toBe(0);
    // Should find meeting.md
    expect(stdout.toLowerCase()).toContain("meeting");
  });

  test("searches with limit option", async () => {
    const { stdout, exitCode } = await runQmd(["search", "-n", "1", "test"]);
    expect(exitCode).toBe(0);
  });

  test("searches with all results option", async () => {
    const { stdout, exitCode } = await runQmd(["search", "--all", "the"]);
    expect(exitCode).toBe(0);
  });

  test("returns no results message for non-matching query", async () => {
    const { stdout, exitCode } = await runQmd(["search", "xyznonexistent123"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No results");
  });

  test("returns empty JSON array for non-matching query with --json", async () => {
    const { stdout, exitCode } = await runQmd(["search", "xyznonexistent123", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  test("returns CSV header only for non-matching query with --csv", async () => {
    const { stdout, exitCode } = await runQmd(["search", "xyznonexistent123", "--csv"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("docid,score,file,title,context,line,snippet");
  });

  test("returns empty XML container for non-matching query with --xml", async () => {
    const { stdout, exitCode } = await runQmd(["search", "xyznonexistent123", "--xml"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("<results></results>");
  });

  test("returns empty output for non-matching query with --md", async () => {
    const { stdout, exitCode } = await runQmd(["search", "xyznonexistent123", "--md"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("returns empty output for non-matching query with --files", async () => {
    const { stdout, exitCode } = await runQmd(["search", "xyznonexistent123", "--files"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("returns min-score threshold message for default CLI output", async () => {
    const { stdout, exitCode } = await runQmd(["search", "test", "--min-score", "2"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No results found above minimum score threshold.");
  });

  test("returns format-safe empty output when --min-score filters all results", async () => {
    const json = await runQmd(["search", "test", "--json", "--min-score", "2"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([]);

    const csv = await runQmd(["search", "test", "--csv", "--min-score", "2"]);
    expect(csv.exitCode).toBe(0);
    expect(csv.stdout.trim()).toBe("docid,score,file,title,context,line,snippet");

    const xml = await runQmd(["search", "test", "--xml", "--min-score", "2"]);
    expect(xml.exitCode).toBe(0);
    expect(xml.stdout.trim()).toBe("<results></results>");

    const md = await runQmd(["search", "test", "--md", "--min-score", "2"]);
    expect(md.exitCode).toBe(0);
    expect(md.stdout.trim()).toBe("");

    const files = await runQmd(["search", "test", "--files", "--min-score", "2"]);
    expect(files.exitCode).toBe(0);
    expect(files.stdout.trim()).toBe("");
  });

  test("requires query argument", async () => {
    const { stdout, stderr, exitCode } = await runQmd(["search"]);
    expect(exitCode).toBe(1);
    // Error message goes to stderr
    expect(stderr).toContain("Usage:");
  });

  test("--json --full includes line field for round-tripping to qmd get", async () => {
    const { stdout, exitCode } = await runQmd(["search", "meeting", "--json", "--full", "-n", "1"]);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].line).toBeTypeOf("number");
    expect(results[0].line).toBeGreaterThan(0);
    expect(results[0].body).toBeTypeOf("string");
  });

  test("vsearch does not emit query expansion diagnostics", async () => {
    const { stdout, stderr, exitCode } = await runQmd(
      ["vsearch", "--json", "meeting"],
      {
        env: {
          OPENAI_API_KEY: "",
          OPENAI_BASE_URL: "http://127.0.0.1:9",
        },
        timeoutMs: 20000,
      },
    );

    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.schemaVersion).toBe(SchemaVersion);
    expect(payload.query).toBe("meeting");
    expect(Array.isArray(payload.results)).toBe(true);
    for (const result of payload.results) {
      expect(result).toMatchObject({ source: "vec" });
      expect(result.candidateId).toBeTypeOf("string");
      expect(result.retrievalScore).toBeTypeOf("number");
    }
    expect(stderr).not.toContain("Searching 2 vector queries");
    expect(stderr).not.toContain("lex:");
    expect(stderr).not.toContain("hyde:");
    expect(stderr).not.toContain("OpenAI Responses");
  }, 25000);
});

describe("GraphRAG EPUB batch runner", () => {
  async function mkProjectTmpDir(prefix: string): Promise<string> {
    const root = join(projectRoot, ".tmp-tests");
    await mkdir(root, { recursive: true });
    return mkdtemp(join(root, prefix));
  }

  const requiredBatchCommandCheckNames = [
    "qmd-version",
    "qmd-status",
    "qmd-doctor-json",
    "qmd-pull",
    "qmd-update",
    "qmd-embed",
    "qmd-ls-books",
    "qmd-search-json",
    "qmd-search-csv",
    "qmd-search-md",
    "qmd-search-xml",
    "qmd-search-files",
    "qmd-vsearch-json",
    "qmd-query-json",
    "qmd-query-auto-json",
    "qmd-query-graphrag-json",
    "qmd-get-book",
    "qmd-multi-get-json",
    "qmd-collection-list",
    "qmd-collection-show-books",
    "qmd-context-list",
    "qmd-skills-list-json",
    "qmd-skills-get-json",
    "qmd-skills-path-json",
    "qmd-skill-show",
    "qmd-dspy-status-json",
    "qmd-cleanup",
  ];

  function passedBatchCommandChecks() {
    return requiredBatchCommandCheckNames.map((name) => ({
      name,
      status: "passed",
      attempts: 1,
      exitCode: 0,
      stdoutBytes: 1,
      stderrBytes: 0,
      startedAt: "2026-05-23T00:00:00.000Z",
      completedAt: "2026-05-23T00:00:01.000Z",
    }));
  }

  function batchBookId(sourceHash: string, sourceRelativePath: string): string {
    const pathHash = createHash("sha256")
      .update(sourceRelativePath.normalize("NFKC").toLowerCase())
      .digest("hex");
    return `book-${sourceHash.slice(0, 12)}-${pathHash.slice(0, 8)}`;
  }

  async function writeMinimalParquetFixture(path: string): Promise<void> {
    await writeFile(path, MinimalParquetFixture);
  }

  async function writeCompleteLanceDbFixture(root: string): Promise<void> {
    for (const tableName of [
      "entity_description.lance",
      "community_full_content.lance",
      "text_unit_text.lance",
    ]) {
      const tableDir = join(root, tableName);
      await mkdir(join(tableDir, "data"), { recursive: true });
      await mkdir(join(tableDir, "_versions"), { recursive: true });
      await writeFile(join(tableDir, "data", "part-1.lance"), "rows", "utf8");
      await writeFile(
        join(tableDir, "_versions", "1.manifest"),
        "part-1.lance",
        "utf8",
      );
      await writeFile(
        join(tableDir, "qmd_row_count.json"),
        JSON.stringify({ schemaVersion: SchemaVersion, rowCount: 1 }),
        "utf8",
      );
    }
  }

  async function graphArtifactManifests(input: {
    outputDir: string;
    outputRel: string;
    bookId: string;
    corpusContentHash: string;
    artifactIds: Record<string, string>;
    stageFingerprints: Record<string, string>;
    providerFingerprint: string;
  }) {
    const specs = [
      [input.artifactIds.documents, "graph_extract", "graphrag_documents_parquet", "documents.parquet"],
      [input.artifactIds.textUnits, "graph_extract", "graphrag_text_units_parquet", "text_units.parquet"],
      [input.artifactIds.entities, "graph_extract", "graphrag_entities_parquet", "entities.parquet"],
      [input.artifactIds.relationships, "graph_extract", "graphrag_relationships_parquet", "relationships.parquet"],
      [input.artifactIds.communities, "graph_extract", "graphrag_communities_parquet", "communities.parquet"],
      [input.artifactIds.context, "graph_extract", "graphrag_context_json", "context.json"],
      [input.artifactIds.stats, "graph_extract", "graphrag_stats_json", "stats.json"],
      [input.artifactIds.reports, "community_report", "graphrag_community_reports_parquet", "community_reports.parquet"],
    ] as const;
    const artifacts = [];
    for (const [artifactId, stage, kind, artifactPath] of specs) {
      artifacts.push({
        schemaVersion: SchemaVersion,
        artifactId,
        bookId: input.bookId,
        stage,
        kind,
        path: join(input.outputRel, artifactPath),
        contentHash: await hashFile(join(input.outputDir, artifactPath)),
        stageFingerprint: input.stageFingerprints[stage],
        providerFingerprint: input.providerFingerprint,
        producerRunId: stage === "graph_extract"
          ? "run-graph-extract"
          : "run-community-report",
        createdAt: "2026-05-23T00:00:00.000Z",
        metadata: { corpusContentHash: input.corpusContentHash },
      });
    }
    artifacts.push({
      schemaVersion: SchemaVersion,
      artifactId: input.artifactIds.lancedb,
      bookId: input.bookId,
      stage: "embed",
      kind: "lancedb_index",
      path: join(input.outputRel, "lancedb"),
      contentHash: await hashLanceDbDirectoryContents(join(input.outputDir, "lancedb")),
      stageFingerprint: input.stageFingerprints.embed,
      providerFingerprint: input.providerFingerprint,
      producerRunId: "run-embed",
      createdAt: "2026-05-23T00:00:00.000Z",
      metadata: { corpusContentHash: input.corpusContentHash },
    });
    return artifacts;
  }

  async function writeCompletedGraphBatchFixture(input: {
    tmpRoot: string;
    sourceDir: string;
    stateRoot: string;
    configDir: string;
    runId: string;
    sourceBytes: string;
    commandChecks?: ReturnType<typeof passedBatchCommandChecks>;
  }) {
    const sourceHash = createHash("sha256")
      .update(input.sourceBytes)
      .digest("hex");
    const sourcePath = join(input.sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const outputRel = join("books", bookId, "output");
    const outputDir = join(input.stateRoot, outputRel);
    const documentId = `doc-${sourceHash.slice(0, 12)}`;
    const contentHash = sourceHash;
    const stageFingerprints = {
      ingest: "fp-ingest",
      normalize: "fp-normalize",
      graph_extract: "fp-graph-extract",
      community_report: "fp-community-report",
      embed: "fp-embed",
      query_ready: "fp-query-ready",
    };
    const providerFingerprint = "provider-fp";
    const artifactIds = {
      documents: `${bookId}:graph_extract:documents`,
      textUnits: `${bookId}:graph_extract:text_units`,
      entities: `${bookId}:graph_extract:entities`,
      relationships: `${bookId}:graph_extract:relationships`,
      communities: `${bookId}:graph_extract:communities`,
      context: `${bookId}:graph_extract:context`,
      stats: `${bookId}:graph_extract:stats`,
      reports: `${bookId}:community_report:reports`,
      lancedb: `${bookId}:embed:lancedb`,
    };
    await mkdir(input.sourceDir, { recursive: true });
    await mkdir(input.configDir, { recursive: true });
    await mkdir(join(input.stateRoot, "catalog", "batch-runs", input.runId, "items"), {
      recursive: true,
    });
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, input.sourceBytes);
    await writeFile(join(input.configDir, "index.yml"), "collections: {}\n");
    for (const name of [
      "documents.parquet", "text_units.parquet", "entities.parquet",
      "relationships.parquet", "communities.parquet", "community_reports.parquet",
    ]) {
      await writeMinimalParquetFixture(join(outputDir, name));
    }
    await writeFile(join(outputDir, "context.json"), "{}", "utf8");
    await writeFile(join(outputDir, "stats.json"), "{}", "utf8");
    await writeCompleteLanceDbFixture(join(outputDir, "lancedb"));
    const graphArtifacts = await graphArtifactManifests({
      outputDir,
      outputRel,
      bookId,
      artifactIds,
      stageFingerprints,
      providerFingerprint,
      corpusContentHash: contentHash,
    });
    await writeFile(
      join(outputDir, "qmd_output_manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        bookId,
        sourceHash,
        documentId,
        contentHash,
        stageFingerprints,
        providerFingerprint,
        outputDir: `books/${bookId}/output`,
        producerRunId: "run-query-ready",
        stageProducerRunIds: {
          graph_extract: "run-graph-extract",
          community_report: "run-community-report",
          embed: "run-embed",
        },
      }),
    );
    await mkdir(join(input.stateRoot, "books", bookId), { recursive: true });
    await mkdir(join(input.stateRoot, "catalog"), { recursive: true });
    await writeFile(
      join(input.stateRoot, "catalog", "books.yaml"),
      YAML.stringify({
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          bookId,
          documentId,
          sourcePath: `sources/${bookId}/source.epub`,
          sourceHash,
          normalizedContentHash: contentHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          configFingerprint: "config-fp",
          promptFingerprint: "prompt-fp",
          modelFingerprint: "model-fp",
          stageFingerprints,
          providerFingerprint,
          overallStatus: "succeeded",
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:01.000Z",
        }],
      }),
    );
    await writeFile(
      join(input.stateRoot, "books", bookId, "artifacts.yaml"),
      YAML.stringify({ schemaVersion: SchemaVersion, items: graphArtifacts }),
    );
    await writeFile(
      join(input.stateRoot, "books", bookId, "checkpoints.yaml"),
      YAML.stringify({
        schemaVersion: SchemaVersion,
        items: [
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "graph_extract",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-graph-extract",
            inputFingerprint: "fp-graph-extract",
            contentHash,
            stageFingerprint: "fp-graph-extract",
            providerFingerprint,
            artifactIds: [
              artifactIds.documents, artifactIds.textUnits, artifactIds.entities,
              artifactIds.relationships, artifactIds.communities,
              artifactIds.context, artifactIds.stats,
            ],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "community_report",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-community-report",
            inputFingerprint: "fp-community-report",
            contentHash,
            stageFingerprint: "fp-community-report",
            providerFingerprint,
            artifactIds: [artifactIds.reports],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "embed",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-embed",
            inputFingerprint: "fp-embed",
            contentHash,
            stageFingerprint: "fp-embed",
            providerFingerprint,
            artifactIds: [artifactIds.lancedb],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "query_ready",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-query-ready",
            inputFingerprint: "fp-query-ready",
            contentHash,
            stageFingerprint: "fp-query-ready",
            providerFingerprint,
            artifactIds: [artifactIds.reports, artifactIds.lancedb],
          },
        ],
      }),
    );
    await writeFile(
      join(input.stateRoot, "catalog", "batch-runs", input.runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId: input.runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(
        input.stateRoot,
        "catalog",
        "batch-runs",
        input.runId,
        "items",
        `${itemId}.json`,
      ),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId: input.runId,
        status: "completed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 1,
        qmdBuildStatus: { status: "succeeded" },
        graphBuildStatus: { status: "succeeded" },
        graphQueryStatus: { status: "succeeded" },
        commandChecks: input.commandChecks ?? passedBatchCommandChecks(),
      }),
    );
    return { sourceHash, sourcePath, sourceRelativePath, bookId, itemId };
  }

  test("keeps batch state typed and raw logs outside graph_vault", () => {
    const script = readFileSync(
      join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
      "utf8",
    );
    const contract = readFileSync(
      join(projectRoot, "src", "contracts", "batch-run.ts"),
      "utf8",
    );

    expect(contract).toContain("BatchRunManifestSchema");
    expect(contract).toContain("BatchItemCheckpointSchema");
    expect(contract).toContain("BatchEventLogSchema");
    expect(contract).toContain("\"skipped\"");
    expect(contract).toContain("BatchFailureKindSchema");
    expect(contract).toContain("BatchRecoveryDecisionSchema");
    expect(contract).toContain("pendingItems");
    expect(contract).toContain("runningItems");
    expect(contract).toContain("skippedItems");
    expect(contract).toContain("expectedCommandCheckCount");
    expect(contract).toContain("maxResumePasses");
    expect(contract).toContain("nextRetryAt");
    expect(contract).toContain("retryBudgetSeconds");
    expect(contract).toContain("commandTimeoutSeconds");
    expect(contract).toContain("runnerSessionId");
    expect(contract).toContain("providerStatusCode");
    expect(contract).toContain("retryAfterSeconds");
    expect(contract).toContain("providerRecoveryWaitCount");
    expect(contract).toContain("providerRecoveryReason");
    expect(contract).toContain("recoveryDecision: BatchRecoveryDecisionSchema");
    expect(script).toContain("\"completed-manifest\"");
    expect(script).toContain("\"heartbeat-interval-seconds\"");
    expect(script).toContain("\"fail-fast\"");
    expect(script).toContain("\"migrate-only\"");
    expect(script).toContain("\"status-json\"");
    expect(script).toContain("\"max-resume-passes\"");
    expect(script).toContain("\"max-transient-command-attempts\"");
    expect(script).toContain("\"command-timeout-seconds\"");
    expect(script).toContain("default: \"21600\"");
    expect(script).toContain("startCommandHeartbeatMonitor");
    expect(script).toContain("currentCommandStartedAt");
    expect(script).toContain("withJsonFileLock");
    expect(script).toContain("withCheckpointPersistenceInvariants");
    expect(script).toContain("renameSync");
    expect(script).toContain("const start = epochMs(checkpoint.retryStartedAt)");
    expect(script).toContain("recovery-summary.json");
    expect(script).toContain("item_retry_deferred");
    expect(script).toContain("item_provider_recovery_wait");
    expect(script).toContain("item_retry_window_deferred");
    expect(script).toContain("batch_wait_retry_window");
    expect(script).toContain("item_running_recovered");
    expect(script).toContain("batch_state_migrated");
    expect(script).toContain("raw_log_migrated");
    expect(script).toContain("\"--report-root\"");
    expect(script).toContain("assertNoBookScopedRawReports");
    expect(script).toContain("BatchRunManifestSchema.parse");
    expect(script).toContain("withBuildStatusSnapshot(item, checkpoint)");
    expect(script).toContain("BatchEventLogSchema.parse");
    expect(script).toContain("command_attempt_budget_exhausted");
    expect(script).toContain("command_retry_exhausted");
    expect(script).toContain("batch_incomplete");
    expect(script).toContain("if (canRecoverInThisRun) {");
    expect(script).toContain("persistFailFastInterruptedManifest");
    expect(script).toContain("interruptedByFailFast: true");
    expect(script).toContain("validateCommandChecks(checks)");
    expect(script).toContain("--log-root must be outside graph_vault");
    expect(script).toContain("resume-book-workspace.mjs");
    expect(script).toContain("resume-book did not reach ready");
    expect(script).toContain("repair-local-artifact-gate-");
    expect(script).toContain("--repair-local-artifact-gate-only");
    expect(script).toContain("item_local_artifact_gate_repair");
    expect(script).toContain("item_local_artifact_gate_repair_blocked");
    expect(script).toContain("localArtifactGateRepairCompleted");
    expect(script).toContain("qmd-query-graphrag-json");
    expect(script).toContain("redactLog(stdout)");
    expect(script).toContain("redactLog(stderr)");
    expect(script).toContain("redactUrlCredentials");
    expect(script).toContain("console.error(redactLog");
    expect(script).not.toContain("metadata: {\\n      logRoot,");
  });

  test("keeps query_ready resume stage ordered and fail-safe", () => {
    const script = readFileSync(
      join(projectRoot, "scripts", "graphrag", "resume-book-workspace.mjs"),
      "utf8",
    );
    const queryReadyStart = script.indexOf('if (nextStage === "query_ready")');
    const startStage = script.indexOf("await repo.startStage", queryReadyStart);
    const writeManifest = script.indexOf(
      "await runtimeApi.writeGraphRagOutputProducerManifest",
      queryReadyStart,
    );
    const completeStage = script.indexOf("await repo.completeStage", queryReadyStart);
    const failStage = script.indexOf("await repo.failStage", queryReadyStart);
    const safeError = script.indexOf("errorSummary: safeText", failStage);

    expect(queryReadyStart).toBeGreaterThanOrEqual(0);
    expect(startStage).toBeGreaterThan(queryReadyStart);
    expect(writeManifest).toBeGreaterThan(startStage);
    expect(completeStage).toBeGreaterThan(writeManifest);
    expect(failStage).toBeGreaterThan(completeStage);
    expect(safeError).toBeGreaterThan(failStage);
    expect(script).toContain('console.error("[redacted]")');
  });

  test("updates batch checkpoint heartbeat while long commands run", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-command-heartbeat-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "command-heartbeat-fixture";
    const sourceBytes = "heartbeat fixture";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const normalizedPath = join(
      stateRoot,
      "input",
      `book-${sourceHash.slice(0, 10)}.md`,
    );
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const checkpointPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );

    await mkdir(sourceDir, { recursive: true });
    await mkdir(dirname(normalizedPath), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(normalizedPath, "# Book\n\nHeartbeat fixture.\n");
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const resumeScript = join(tmpRoot, "fake-slow-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "setTimeout(() => {",
        "  console.log(JSON.stringify({ status: 'blocked', reason: 'test blocked' }));",
        "}, 3000);",
      ].join("\n"),
    );

    const resultPromise = new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--heartbeat-interval-seconds",
        "1",
        "--max-resume-passes",
        "1",
      ], {
        env: {
          ...process.env,
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    let heartbeatCheckpoint: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(250);
      if (!existsSync(checkpointPath)) continue;
      const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
      if (checkpoint.currentCommand === "resume-book-1") {
        heartbeatCheckpoint = checkpoint;
        break;
      }
    }

    const statusDuringRun = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });
    const result = await resultPromise;
    const finalCheckpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    const recoverySummary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(heartbeatCheckpoint).toMatchObject({
      status: "running",
      currentCommand: "resume-book-1",
    });
    const statusSummary = JSON.parse(statusDuringRun.stdout);
    expect(statusDuringRun.exitCode).toBe(0);
    expect(statusDuringRun.stderr).toBe("");
    expect(statusSummary.items[0]).toMatchObject({
      status: "running",
      currentCommand: "resume-book-1",
    });
    expect(heartbeatCheckpoint?.currentCommandStartedAt).toEqual(expect.any(String));
    expect(heartbeatCheckpoint?.runnerHeartbeatAt).toEqual(expect.any(String));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(finalCheckpoint.currentCommand).toBeUndefined();
    expect(finalCheckpoint.currentCommandStartedAt).toBeUndefined();
    expect(finalCheckpoint.commandChecks).toHaveLength(1);
    expect(finalCheckpoint.commandChecks[0]).toMatchObject({
      name: "resume-book-1",
      status: "passed",
    });
    expect(recoverySummary.items[0].currentCommand).toBeUndefined();
    expect(recoverySummary.items[0].currentCommandStartedAt).toBeUndefined();
    expect(events.some((event) =>
      event.event === "command_start" &&
      event.command === "resume-book-1"
    )).toBe(true);
  }, 15000);

  test("rejects raw log directories that still resolve inside graph_vault", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "qmd-batch-log-root-"));
    const sourceDir = join(tmpRoot, "empty-source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          join(stateRoot, "..logs"),
          "--skip-dotenv",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--log-root must be outside graph_vault");
  });

  test("rejects symlinked raw log directories that resolve inside graph_vault", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "qmd-batch-log-symlink-"));
    const sourceDir = join(tmpRoot, "empty-source");
    const stateRoot = join(tmpRoot, "graph_vault");
    await mkdir(join(stateRoot, "logs"), { recursive: true });
    symlinkSync(join(stateRoot, "logs"), join(tmpRoot, "logs-link"));
    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          join(tmpRoot, "logs-link"),
          "--skip-dotenv",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--log-root must be outside graph_vault");
  });

  test("completed-manifest annotates default work but does not skip real builds", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-skipped-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "skipped-fixture";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const sourceBytes = "still processed when seeded";
    await writeFile(join(sourceDir, "Book.epub"), sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const completedManifest = join(tmpRoot, "completed.json");
    const { createHash } = await import("crypto");
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await writeFile(
      completedManifest,
      JSON.stringify([{ source: "Book.epub", sourceHash }]),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--completed-manifest",
          completedManifest,
          "--run-id",
          runId,
          "--skip-dotenv",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const batchRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const manifest = JSON.parse(readFileSync(join(batchRoot, "manifest.json"), "utf8"));
    const eventLines = readFileSync(join(batchRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const [checkpointName] = readdirSync(join(batchRoot, "items"));
    const checkpoint = JSON.parse(
      readFileSync(join(batchRoot, "items", checkpointName), "utf8"),
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(manifest).toMatchObject({
      schemaVersion: SchemaVersion,
      runId,
      status: "failed",
      totalItems: 1,
      pendingItems: 0,
      runningItems: 0,
      completedItems: 0,
      skippedItems: 0,
      importedCompletedItems: 1,
      failedItems: 1,
      expectedCommandCheckCount: 27,
    });
    expect(checkpoint).toMatchObject({
      schemaVersion: SchemaVersion,
      runId,
      status: "failed",
      sourceName: "Book.epub",
      sourceHash,
      bookId: batchBookId(sourceHash, relative(projectRoot, join(sourceDir, "Book.epub"))),
      expectedCommandCheckCount: 27,
      metadata: {
        seedMatchMode: "source_name_and_hash",
        importedCompletedMode: "audit_only",
      },
    });
    expect(eventLines.some((event) => event.event === "item_skipped")).toBe(false);
    expect(eventLines.some((event) => event.event === "command_start")).toBe(true);
    expect(eventLines.at(-1)).toMatchObject({
      event: "batch_incomplete",
      recoveryDecision: "stop_until_fixed",
    });
  });

  test("keeps transient and permanent provider recovery decisions typed", () => {
    const script = readFileSync(
      join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
      "utf8",
    );

    expect(classifyFailure("HTTP 400 timeout")).toMatchObject({
      failureKind: "permanent",
      retryable: false,
      providerStatusCode: 400,
    });
    expect(classifyFailure("HTTP 409 conflict")).toMatchObject({
      failureKind: "permanent",
      retryable: false,
      providerStatusCode: 409,
    });
    expect(classifyFailure("HTTP 429 retry-after: 7")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 429,
      retryAfterSeconds: 7,
    });
    expect(classifyFailure("HTTP 500")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 500,
    });
    expect(classifyFailure("HTTP 599")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 599,
    });
    expect(classifyFailure("status code: 429")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 429,
    });
    expect(classifyFailure("error code: 500")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 500,
    });
    expect(classifyFailure("(599)")).toMatchObject({
      failureKind: "transient",
      retryable: true,
      providerStatusCode: 599,
    });
    expect(classifyFailure("timeout without status")).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure("openai.APIError: stream_read_error")).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "litellm.APIConnectionError: Jina_aiException - Cannot connect to host " +
      "api.jina.ai:443 ssl:<ssl.SSLContext object> [None]",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure("httpx.ConnectError: [Errno 8] nodename nor servname"))
      .toMatchObject({
        failureKind: "transient",
        retryable: true,
      });
    expect(classifyFailure("aiohttp.ClientConnectorError: getaddrinfo failed"))
      .toMatchObject({
        failureKind: "transient",
        retryable: true,
      });
    expect(classifyFailure("urllib3 ReadTimeoutError: read reset by peer"))
      .toMatchObject({
        failureKind: "transient",
        retryable: true,
      });
    expect(classifyFailure(
      "Responses API transient error kind=server_error status_code=unknown",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "Responses API transient error kind=rate_limit_exceeded status_code=unknown",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure("GraphRAG stage report partial-output failure")).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "GraphRAG stage did not produce valid book-scoped artifacts: " +
      "{\"missingArtifactKinds\":[\"graphrag_documents_parquet\"]} " +
      "litellm.APIConnectionError",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure(
      "GraphRAG index workflow failed: " +
      "[{\"workflow\":\"create_community_reports_text\"," +
      "\"errorMessage\":\"'float' object is not subscriptable\"}] " +
      "Cannot connect to host api.jina.ai",
    )).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(classifyFailure("No report found for community: 16")).toMatchObject({
      failureKind: "transient",
      retryable: true,
    });
    expect(script).not.toContain("function isTransient(");
    expect(script).toContain("function recoveryDecisionForBatch(checkpoints)");
    expect(script).toContain("item.status !== \"completed\"");
    expect(script).toContain("item.recoveryDecision === \"retry_same_run_id\"");
    expect(script).toContain("checkpoint?.status === \"failed\" && checkpoint.retryable === false");
    expect(script).not.toContain("event: \"item_retry_exhausted\"");
    expect(script).toContain("recoverProviderTransientCheckpoint(item, checkpoint)");
    expect(script).toContain("transientBudgetAvailable(running)");
    expect(script).toContain("if (options.allowTransientBudget) {");
    expect(script).toContain("throw Object.assign(new Error(check.errorSummary)");
    expect(script).toContain("failedStage: name");
    expect(script).toContain("markItemRunning(item, starting, checkpoints, manifest)");
  });

  test("classifies query-ready projection failures as local artifact gates", () => {
    expect(classifyFailure(
      "GraphRAG document identity is missing for query_ready: doc-fd8875181a17",
    )).toMatchObject({
      failureKind: "permanent",
      retryable: false,
    });
    expect(classifyFailure(
      "capabilityScope references unknown or not-ready graphCapabilityId(s): " +
      "book-356ff4920cdf-0bbd8bdb:graph_query",
    )).toMatchObject({
      failureKind: "permanent",
      retryable: false,
    });
    expect(classifyFailure(
      "GraphRAG document identity sidecar does not match query_ready",
    )).toMatchObject({
      failureKind: "permanent",
      retryable: false,
    });
    expect(classifyFailure(
      "GraphRAG document identity sidecar evidence is invalid for query_ready: " +
      "doc-fd8875181a17",
    )).toMatchObject({
      failureKind: "permanent",
      retryable: false,
    });
    expect(classifyFailure(
      "graph_vault/settings.yaml is not the managed projection of .qmd/index.yml",
    )).toMatchObject({
      failureKind: "permanent",
      retryable: false,
    });
    const repairScript = readFileSync(
      join(projectRoot, "scripts", "graphrag", "resume-book-workspace.mjs"),
      "utf8",
    );
    expect(repairScript).toContain(
      "graphrag document identity sidecar evidence is invalid for query_ready",
    );
    expect(repairScript).toContain(
      "graphrag document identity sidecar does not match query_ready",
    );
    expect(repairScript).toContain(
      "graph_vault/settings.yaml is not the managed projection of .qmd/index.yml",
    );
  });

  test("repair-only validates query-ready projection without graph query calls", () => {
    const script = readFileSync(
      join(projectRoot, "scripts", "graphrag", "resume-book-workspace.mjs"),
      "utf8",
    );
    const repairOnlyStart = script.indexOf(
      "async function runRepairLocalArtifactGateOnly",
    );
    const runStart = script.indexOf("async function run()", repairOnlyStart);
    const repairOnlyBody = script.slice(repairOnlyStart, runStart);

    expect(repairOnlyStart).toBeGreaterThanOrEqual(0);
    expect(repairOnlyBody).toContain("completeProducerStageFromEvidence");
    expect(repairOnlyBody).toContain("graphQueryScopeFromSync");
    expect(repairOnlyBody).toContain("graph_identity_projection_missing");
    expect(repairOnlyBody).toContain("graph_query_capability_projection_missing");
    expect(repairOnlyBody).not.toContain("runtime.graphQuery");
  });

  test("status-json starts transient retry budget at first failure", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-long-run-first-transient-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "long-run-first-transient";
    const sourceBytes = "long running graph before first transient";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T03:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        failedAt: new Date().toISOString(),
        failureKind: "transient",
        retryable: true,
        retryExhausted: true,
        recoveryDecision: "retry_same_run_id",
        failedStage: "resume-book-1",
        errorSummary: "HTTP 503 Retry-After: 180 Service temporarily unavailable",
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 3,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 64,
          startedAt: "2026-05-23T03:00:00.000Z",
          completedAt: "2026-05-23T03:01:00.000Z",
          failureKind: "transient",
          retryable: true,
          attemptExhausted: true,
          providerStatusCode: 503,
          retryAfterSeconds: 180,
          recoveryDecision: "retry_same_run_id",
          errorSummary: "HTTP 503 Retry-After: 180 Service temporarily unavailable",
        }],
      }),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventsExist = existsSync(eventLogPath);
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      waitingForProviderRecovery: true,
      providerRecoveryReason: "transient_failure_recovered",
    });
    expect(summary.items[0].providerRecoveryReason)
      .not.toBe("retry_budget_window_elapsed");
    expect(eventsExist).toBe(false);
  });

  test("fail-fast transient failure persists recoverable pending checkpoint", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-fail-fast-transient-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "fail-fast-transient-fixture";
    const sourceBytes = "fail fast transient";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const normalizedPath = join(
      stateRoot,
      "input",
      `book-${sourceHash.slice(0, 10)}.md`,
    );
    await mkdir(dirname(normalizedPath), { recursive: true });
    await writeFile(normalizedPath, "# Book\n\nFail-fast transient fixture.\n");
    const resumeScript = join(tmpRoot, "fake-transient-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "console.error('HTTP 503 upstream unavailable');",
        "process.exit(1);",
      ].join("\n"),
    );

    const result = await new Promise<{
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--fail-fast",
        "--max-transient-command-attempts",
        "2",
      ], {
        env: {
          ...process.env,
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
        },
      });
      let stderr = "";
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const manifest = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      "utf8",
    ));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("HTTP 503 upstream unavailable");
    expect(manifest.status).toBe("incomplete");
    expect(checkpoint).toMatchObject({
      status: "pending",
      bookId,
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      failedStage: "resume-book-1",
    });
    expect(checkpoint.nextRetryAt).toEqual(expect.any(String));
    expect(checkpoint.commandChecks.at(-1)).toMatchObject({
      name: "resume-book-1",
      status: "failed",
      failureKind: "transient",
      retryable: true,
      attemptExhausted: false,
      recoveryDecision: "retry_same_run_id",
    });
  });

  test("migrate-only backfills typed fields into legacy failure events", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-migrate-events-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "migrate-events-fixture";
    const sourceBytes = "legacy failed event";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(join(stateRoot, "reports"), { recursive: true });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const leakedReportText =
      "raw https://user:password@gateway.example/responses?api_key=raw-key" +
      " Bearer raw-token sk-raw-secret /var/tmp/qmd-secret/query.log";
    await writeFile(join(stateRoot, "reports", "query.log"), leakedReportText);
    await writeFile(join(stateRoot, "reports", "report.txt"), "raw provider report");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        completedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        normalizedPath: join(
          ".tmp-tests",
          "graph_vault",
          "input",
          "book.md",
        ),
        attempts: 1,
        failedAt: "2026-05-23T00:01:00.000Z",
        errorSummary: "HTTP 503 Retry-After: 180 Service temporarily unavailable",
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 3,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 12,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          errorSummary: "HTTP 503 Retry-After: 180 Service temporarily unavailable",
        }],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        itemId,
        event: "command_failed",
        command: "resume-book-1",
        at: "2026-05-23T00:01:00.000Z",
        message: "HTTP 503 Retry-After: 180 Service temporarily unavailable",
        recoveryDecision: "retry_same_run_id",
        metadata: { attempt: 3, exitCode: 1 },
      }) + "\n",
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--migrate-only",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const eventLines = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const recoverySummary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const migrated = eventLines.find((event) => event.event === "command_failed");
    const exhausted = eventLines.find(
      (event) => event.event === "command_retry_exhausted",
    );
    const rawLogEvent = eventLines.find((event) => event.event === "raw_log_migrated");
    const remainingRawReports = readdirSync(join(stateRoot, "reports"));
    const movedRawReports = readdirSync(join(logRoot, "graph_vault_reports"));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(migrated).toMatchObject({
      failureKind: "transient",
      retryable: true,
      attemptExhausted: true,
      providerStatusCode: 503,
      retryAfterSeconds: 180,
      recoveryDecision: "retry_same_run_id",
      failedStage: "resume-book-1",
    });
    expect(exhausted).toBeUndefined();
    expect(recoverySummary).toMatchObject({
      schemaVersion: SchemaVersion,
      runId,
      recoveryDecision: "retry_same_run_id",
      retryPolicy: {
        maxCommandAttempts: 3,
        maxTransientCommandAttempts: 12,
        retryBudgetSeconds: 7200,
        maxProviderRecoveryWaits: 3,
        commandTimeoutSeconds: 21600,
      },
    });
    expect(recoverySummary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      waitingForProviderRecovery: true,
      failedStage: "resume-book-1",
      providerStatusCode: 503,
      retryAfterSeconds: 180,
    });
    expect(rawLogEvent).toMatchObject({
      event: "raw_log_migrated",
      metadata: {
        sourceLocator: "graph_vault/reports/query.log",
        targetLogRootName: "logs",
      },
    });
    expect(remainingRawReports).toEqual([]);
    expect(movedRawReports.filter((name) => name.endsWith("query.log")))
      .toHaveLength(1);
    expect(movedRawReports.filter((name) => name.endsWith("report.txt")))
      .toHaveLength(1);
    const movedQueryLogName = movedRawReports.find((name) => name.endsWith("query.log"));
    expect(movedQueryLogName).toBeDefined();
    const movedQueryLog = readFileSync(
      join(logRoot, "graph_vault_reports", movedQueryLogName ?? ""),
      "utf8",
    );
    expect(movedQueryLog).toContain("//[REDACTED]@");
    expect(movedQueryLog).toContain("api_key=[REDACTED]");
    expect(movedQueryLog).toContain("Bearer [REDACTED]");
    expect(movedQueryLog).toContain("sk-[REDACTED]");
    expect(movedQueryLog).toContain("[ABS_PATH]");
    expect(movedQueryLog).not.toContain("user:password");
    expect(movedQueryLog).not.toContain("raw-key");
    expect(movedQueryLog).not.toContain("raw-token");
    expect(movedQueryLog).not.toContain("sk-raw-secret");
    expect(movedQueryLog).not.toContain(tmpRoot);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("migrate-only rewrites absolute GraphRAG output manifests to locators", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-migrate-output-manifest-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "migrate-output-manifest-fixture";
    const sourceBytes = "absolute output manifest";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const outputRel = join("books", bookId, "output");
    const outputDir = join(stateRoot, outputRel);
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(
      join(outputDir, "qmd_output_manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        bookId,
        sourceHash,
        documentId: `doc-${sourceHash.slice(0, 12)}`,
        contentHash: sourceHash,
        stageFingerprints: {
          ingest: "fp-ingest",
          normalize: "fp-normalize",
          graph_extract: "fp-graph-extract",
          community_report: "fp-community-report",
          embed: "fp-embed",
          query_ready: "fp-query-ready",
        },
        providerFingerprint: "provider-fp",
        outputDir,
        producerRunId: "run-query-ready",
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "pending",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 0,
        commandChecks: [],
      }),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--migrate-only",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const manifest = JSON.parse(readFileSync(
      join(outputDir, "qmd_output_manifest.json"),
      "utf8",
    ));
    const eventsRaw = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(manifest.outputDir).toBe(`books/${bookId}/output`);
    expect(JSON.stringify(manifest)).not.toContain(tmpRoot);
    expect(eventsRaw).toContain("graph_output_manifest_migrated");
  });

  test("status-json emits recovery summary without running work", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-status-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "status-json-fixture";
    const sourceBytes = "status only";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(join(sourceDir, "Book.epub"), sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, join(sourceDir, "Book.epub"));
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "pending",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        recoveryDecision: "retry_same_run_id",
        failureKind: "transient",
        retryable: true,
        nextRetryAt: "2026-05-23T00:05:00.000Z",
        retryDelaySeconds: 240,
        commandChecks: [],
      }),
    );
    const checkpointPath = join(
      stateRoot,
      "catalog",
      "batch-runs",
      runId,
      "items",
      `${itemId}.json`,
    );
    const checkpointBeforeStatusJson = readFileSync(checkpointPath, "utf8");

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      schemaVersion: SchemaVersion,
      runId,
      recoveryDecision: "retry_same_run_id",
      retryableItemCount: 1,
      nextRetryAt: "2026-05-23T00:05:00.000Z",
    });
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      qmdBuildStatus: { status: "pending" },
      graphBuildStatus: { status: "pending" },
      failureKind: "transient",
      retryable: true,
      nextRetryAt: "2026-05-23T00:05:00.000Z",
    });
    expect(readFileSync(checkpointPath, "utf8")).toBe(checkpointBeforeStatusJson);
    expect(existsSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
    )).toBe(false);
  });

  test("keeps GraphRAG resume failures out of qmd build evidence", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-qmd-graph-state-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "qmd-graph-state-isolation-fixture";
    const sourceBytes = "state isolation";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const qmdChecks = passedBatchCommandChecks();
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "pending",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        failureKind: "transient",
        retryable: true,
        recoveryDecision: "retry_same_run_id",
        failedStage: "resume-book-2",
        errorSummary: "GraphRAG stage report partial-output failure",
        commandChecks: [
          {
            name: "resume-book-2",
            status: "failed",
            attempts: 1,
            exitCode: 1,
            stdoutBytes: 0,
            stderrBytes: 64,
            startedAt: "2026-05-23T00:00:00.000Z",
            completedAt: "2026-05-23T00:01:00.000Z",
            failureKind: "transient",
            retryable: true,
            attemptExhausted: false,
            recoveryDecision: "retry_same_run_id",
            errorSummary: "GraphRAG stage report partial-output failure",
          },
          ...qmdChecks,
        ],
      }),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      qmdBuildStatus: {
        status: "succeeded",
        stage: "qmd-query-json",
      },
      graphBuildStatus: {
        status: "pending",
        stage: "graph_extract",
        reason: "real_graphrag_stage_missing",
      },
      failureKind: "transient",
      retryable: true,
      recoveryDecision: "retry_same_run_id",
      failedStage: "resume-book-2",
    });
  });

  test("status-json continues pending items when another item is permanent failed", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-status-mixed-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "status-json-mixed-failure";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sources = [
      ["Failed.epub", "permanent failure"],
      ["Pending.epub", "still pending"],
    ];
    const itemIds: string[] = [];
    for (const [name, body] of sources) {
      const sourcePath = join(sourceDir, name);
      const sourceHash = createHash("sha256").update(body).digest("hex");
      const sourceRelativePath = relative(projectRoot, sourcePath);
      const itemId = `item-${sourceHash.slice(0, 12)}-${
        createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
      }`;
      await writeFile(sourcePath, body);
      itemIds.push(itemId);
      await writeFile(
        join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
        JSON.stringify({
          schemaVersion: SchemaVersion,
          itemId,
          runId,
          status: name === "Failed.epub" ? "failed" : "pending",
          sourceName: name,
          sourceRelativePath,
          sourceHash,
          normalizedPath: join(".tmp-tests", "graph_vault", "input", `${name}.md`),
          bookId: batchBookId(sourceHash, sourceRelativePath),
          attempts: name === "Failed.epub" ? 1 : 0,
          ...(name === "Failed.epub"
            ? {
                failureKind: "permanent",
                retryable: false,
                recoveryDecision: "stop_until_fixed",
                failedStage: "graphrag-build",
                errorSummary: "HTTP 400 invalid request",
              }
            : { recoveryDecision: "none" }),
          commandChecks: [],
        }),
      );
    }
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 2,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds,
      }),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("continue_pending");
    expect(summary.counts).toMatchObject({ failed: 1, pending: 1 });
  });

  test("status-json projects exhausted transient failures as provider recovery wait", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-status-exhausted-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "status-json-exhausted";
    const sourceBytes = "exhausted transient";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 12,
        retryStartedAt: "2026-05-23T00:00:00.000Z",
        failedAt: "2026-05-23T03:00:00.000Z",
        failureKind: "transient",
        retryable: true,
        retryExhausted: true,
        recoveryDecision: "retry_same_run_id",
        failedStage: "resume-book-2",
        errorSummary: "GraphRAG stage report partial-output failure",
        commandChecks: [
          {
            name: "resume-book-1",
            status: "failed",
            attempts: 3,
            exitCode: 1,
            stdoutBytes: 0,
            stderrBytes: 48,
            startedAt: "2026-05-23T00:00:00.000Z",
            completedAt: "2026-05-23T00:01:00.000Z",
            failureKind: "transient",
            retryable: true,
            attemptExhausted: true,
            providerStatusCode: 500,
            retryAfterSeconds: 60,
            recoveryDecision: "retry_same_run_id",
            errorSummary: "HTTP 500 Retry-After: 60",
          },
          {
            name: "resume-book-2",
            status: "failed",
            attempts: 3,
            exitCode: 1,
            stdoutBytes: 0,
            stderrBytes: 64,
            startedAt: "2026-05-23T02:59:00.000Z",
            completedAt: "2026-05-23T03:00:00.000Z",
            failureKind: "transient",
            retryable: true,
            attemptExhausted: true,
            providerStatusCode: 503,
            retryAfterSeconds: 180,
            recoveryDecision: "retry_same_run_id",
            errorSummary: "HTTP 503 Retry-After: 180",
          },
        ],
      }),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventsExist = existsSync(eventLogPath);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      recoveryDecision: "retry_same_run_id",
      retryableItemCount: 1,
    });
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      qmdBuildStatus: { status: "pending" },
      graphBuildStatus: { status: "pending" },
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      waitingForProviderRecovery: true,
      providerStatusCode: 503,
      retryAfterSeconds: 180,
    });
    expect(checkpoint).toMatchObject({
      retryable: true,
      retryExhausted: true,
      recoveryDecision: "retry_same_run_id",
    });
    expect(eventsExist).toBe(false);
  });

  test("normal run exits after provider recovery wait limit", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-provider-wait-limit-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "provider-wait-limit";
    const sourceBytes = "provider wait limit";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "pending",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 12,
        retryStartedAt: "2026-05-23T00:00:00.000Z",
        failureKind: "transient",
        retryable: true,
        retryExhausted: false,
        recoveryDecision: "retry_same_run_id",
        failedStage: "resume-book-2",
        nextRetryAt: "2099-01-01T00:00:00.000Z",
        retryDelaySeconds: 300,
        errorSummary: "GraphRAG stage report partial-output failure",
        commandChecks: [],
        metadata: {
          waitingForProviderRecovery: true,
          providerRecoveryWaitCount: 9,
          maxProviderRecoveryWaits: 1,
        },
      }),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--max-provider-recovery-waits",
          "1",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const eventsRaw = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    );
    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const manifest = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      "utf8",
    ));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(eventsRaw).toContain("batch_provider_recovery_wait_limit");
    expect(manifest.status).toBe("incomplete");
    expect(checkpoint).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      nextRetryAt: "2099-01-01T00:00:00.000Z",
      retryDelaySeconds: 300,
      metadata: {
        providerRecoveryWaitCount: 1,
        maxProviderRecoveryWaits: 1,
        providerRecoveryWaitLimitReached: true,
      },
    });
  });

  test("status-json recovers legacy stop-until-fixed transient failures", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-legacy-stop-transient-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "legacy-stop-transient";
    const sourceBytes = "legacy transient stop";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 3,
        retryStartedAt: "2026-05-23T00:00:00.000Z",
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "transient",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: "Concurrency limit exceeded for account, please retry later",
        commandChecks: [],
      }),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.retryableItemCount).toBe(1);
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      waitingForProviderRecovery: true,
      providerRecoveryWaitCount: 1,
      maxProviderRecoveryWaits: 3,
      providerRecoveryReason: "retry_budget_window_elapsed",
    });
  });

  test("status-json recovers legacy Jina APIConnectionError as provider transient", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-legacy-jina-transient-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "legacy-jina-transient";
    const sourceBytes = "legacy jina transient";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const errorSummary =
      "Error: GraphRAG index workflow failed: " +
      "[{\"workflow\":\"generate_text_embeddings\",\"errorMessage\":\"" +
      "litellm.APIConnectionError: Jina_aiException - Cannot connect to host " +
      "api.jina.ai:443 ssl:<ssl.SSLContext object> [None]\"}]";
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 3,
        retryStartedAt: "2026-05-23T00:00:00.000Z",
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "unknown",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-2",
        errorSummary,
        commandChecks: [{
          name: "resume-book-2",
          status: "failed",
          attempts: 12,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: errorSummary.length,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:10:00.000Z",
          failureKind: "unknown",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary,
        }],
      }),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.retryableItemCount).toBe(1);
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      failedStage: "resume-book-2",
      waitingForProviderRecovery: true,
      providerRecoveryWaitCount: 1,
      maxProviderRecoveryWaits: 3,
      providerRecoveryReason: "retry_budget_window_elapsed",
    });
  });

  test("status-json keeps local GraphRAG artifact gate failures stop-until-fixed", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-artifact-gap-local-gate-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "artifact-gap-local-gate";
    const sourceBytes = "artifact gap local gate";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const errorSummary =
      "GraphRAG stage did not produce valid book-scoped artifacts: " +
      JSON.stringify({
        bookId: batchBookId(sourceHash, sourceRelativePath),
        stage: "graph_extract",
        missingArtifactKinds: [
          "graphrag_documents_parquet",
          "graphrag_text_units_parquet",
        ],
      });
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 4,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "transient",
        retryable: true,
        retryExhausted: false,
        recoveryDecision: "retry_same_run_id",
        failedStage: "resume-book-1",
        errorSummary,
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 12,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "transient",
          retryable: true,
          attemptExhausted: true,
          recoveryDecision: "retry_same_run_id",
          errorSummary,
        }],
      }),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("stop_until_fixed");
    expect(summary.retryableItemCount).toBe(0);
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      failureKind: "permanent",
      retryable: false,
      retryExhausted: true,
      recoveryDecision: "stop_until_fixed",
      waitingForProviderRecovery: false,
    });
  });

  test("normal run stops repair-only when local artifact gate is blocked", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-repair-blocked-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "repair-blocked";
    const blockedBytes = "repair blocked local gate";
    const repairedBytes = "repair repaired local gate";
    const blockedHash = createHash("sha256").update(blockedBytes).digest("hex");
    const repairedHash = createHash("sha256").update(repairedBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const repairedSourcePath = join(sourceDir, "A-Repaired.epub");
    const blockedSourcePath = join(sourceDir, "B-Blocked.epub");
    await writeFile(blockedSourcePath, blockedBytes);
    await writeFile(repairedSourcePath, repairedBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const blockedRelativePath = relative(projectRoot, blockedSourcePath);
    const repairedRelativePath = relative(projectRoot, repairedSourcePath);
    const blockedItemId = `item-${blockedHash.slice(0, 12)}-${
      createHash("sha256").update(blockedRelativePath).digest("hex").slice(0, 8)
    }`;
    const repairedItemId = `item-${repairedHash.slice(0, 12)}-${
      createHash("sha256").update(repairedRelativePath).digest("hex").slice(0, 8)
    }`;
    const blockedErrorSummary =
      "GraphRAG stage did not produce valid book-scoped artifacts: " +
      JSON.stringify({
        bookId: batchBookId(blockedHash, blockedRelativePath),
        stage: "graph_extract",
        missingArtifactKinds: ["graphrag_documents_parquet"],
      });
    const repairedErrorSummary =
      "GraphRAG stage did not produce valid book-scoped artifacts: " +
      JSON.stringify({
        bookId: batchBookId(repairedHash, repairedRelativePath),
        stage: "graph_extract",
        missingArtifactKinds: ["graphrag_documents_parquet"],
      });
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 2,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 2,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [blockedItemId, repairedItemId],
      }),
    );
    await writeFile(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${blockedItemId}.json`,
      ),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId: blockedItemId,
        runId,
        status: "failed",
        sourceName: "B-Blocked.epub",
        sourceRelativePath: blockedRelativePath,
        sourceIdentityPath: blockedRelativePath,
        sourceHash: blockedHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(blockedHash, blockedRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: blockedErrorSummary,
        commandChecks: [],
        metadata: {
          localArtifactGateRepairCompleted: true,
        },
      }),
    );
    await writeFile(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${repairedItemId}.json`,
      ),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId: repairedItemId,
        runId,
        status: "failed",
        sourceName: "A-Repaired.epub",
        sourceRelativePath: repairedRelativePath,
        sourceIdentityPath: repairedRelativePath,
        sourceHash: repairedHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book-2.md"),
        bookId: batchBookId(repairedHash, repairedRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: repairedErrorSummary,
        commandChecks: [],
        metadata: {
          localArtifactGateRepairBlocked: true,
          localArtifactGateRepairBlockedReason: "old blocked reason",
        },
      }),
    );
    const resumeScript = join(
      tmpRoot,
      "scripts",
      "graphrag",
      "resume-book-workspace.mjs",
    );
    await mkdir(dirname(resumeScript), { recursive: true });
    await writeFile(
      resumeScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { basename } from 'node:path';",
        "const sourceIndex = process.argv.indexOf('--source-path');",
        "const sourcePath = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : '';",
        "const sourceName = basename(sourcePath);",
        "const marker = process.env.QMD_FAKE_RESUME_MARKER;",
        "const isRepairOnly = process.argv.includes('--repair-local-artifact-gate-only');",
        "if (marker) writeFileSync(marker, `${sourceName}:${isRepairOnly}\\n`, { flag: 'a' });",
        "if (sourceName === 'B-Blocked.epub') {",
        "console.log(JSON.stringify({",
        "  status: 'blocked',",
        `  bookId: '${batchBookId(blockedHash, blockedRelativePath)}',`,
        "  startedStage: null,",
        "  nextStage: null,",
        "  completedStages: ['ingest', 'normalize', 'graph_extract'],",
        "  queryResult: null,",
        "  repairOnly: true,",
        "  repairedLocalArtifactGate: false,",
        "  reason: 'local artifact gate failure checkpoint not found',",
        "}));",
        "} else {",
        "console.log(JSON.stringify({",
        "  status: 'repaired',",
        `  bookId: '${batchBookId(repairedHash, repairedRelativePath)}',`,
        "  startedStage: null,",
        "  nextStage: null,",
        "  completedStages: ['ingest', 'normalize', 'graph_extract'],",
        "  queryResult: null,",
        "  repairOnly: true,",
        "  repairedLocalArtifactGate: true,",
        "  repairReason: 'graph_identity_projection_missing',",
        "  repairedProjection: 'document_identity_map',",
        `  repairEvidenceLocator: 'graph_vault/books/${batchBookId(repairedHash, repairedRelativePath)}/output/qmd_graph_text_unit_identity.json',`,
        "  reusedProducerRunIds: {",
        "    graph_extract: 'run-graph-extract',",
        "    community_report: 'run-community-report',",
        "    embed: 'run-embed',",
        "  },",
        "}));",
        "}",
      ].join("\n"),
    );
    const markerPath = join(tmpRoot, "fake-resume-count.txt");

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--max-resume-passes",
        "24",
      ], {
        env: {
          ...process.env,
          QMD_FAKE_RESUME_MARKER: markerPath,
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const blockedCheckpoint = JSON.parse(readFileSync(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${blockedItemId}.json`,
      ),
      "utf8",
    ));
    const repairedCheckpoint = JSON.parse(readFileSync(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${repairedItemId}.json`,
      ),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const blockedRepairStarts = events.filter((event) =>
      event.itemId === blockedItemId &&
      event.event === "command_start" &&
      event.command?.startsWith("repair-local-artifact-gate-")
    );
    const blockedSkips = events.filter((event) =>
      event.itemId === blockedItemId &&
      event.event === "item_local_artifact_gate_repair_blocked_skip"
    );
    const repairedNormalizeStarts = events.filter((event) =>
      event.itemId === repairedItemId &&
      event.event === "command_start" &&
      event.command === "normalize-epub"
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain("did not reach ready after 24 passes");
    expect(readFileSync(markerPath, "utf8").trim().split("\n")).toEqual([
      "A-Repaired.epub:true",
      "B-Blocked.epub:true",
    ]);
    expect(blockedRepairStarts).toHaveLength(1);
    expect(blockedSkips.length).toBeGreaterThanOrEqual(1);
    expect(blockedCheckpoint.metadata?.localArtifactGateRepairBlocked).toBe(true);
    expect(repairedNormalizeStarts.length).toBeGreaterThanOrEqual(1);
    expect(events.some((event) =>
      event.itemId === blockedItemId &&
      event.event === "item_local_artifact_gate_repair_blocked"
    )).toBe(true);
    expect(blockedCheckpoint).toMatchObject({
      status: "pending",
      recoveryDecision: "continue_pending",
      errorSummary: "local artifact gate failure checkpoint not found",
      failureKind: "permanent",
      retryable: false,
      failedStage: "resume-book-1",
      metadata: {
        localArtifactGateRepairBlocked: true,
        localArtifactGateRepairBlockedReason:
          "local artifact gate failure checkpoint not found",
      },
    });
    expect(blockedCheckpoint.metadata?.localArtifactGateRepairCompleted)
      .toBeUndefined();
    expect(blockedCheckpoint.failedAt).toBeUndefined();
    expect(blockedCheckpoint.retryExhausted).toBeUndefined();
    expect(repairedCheckpoint.metadata?.localArtifactGateRepairCompleted).toBe(true);
    expect(repairedCheckpoint.metadata?.localArtifactGateRepairBlocked)
      .toBeUndefined();
    expect(repairedCheckpoint.metadata?.localArtifactGateRepairBlockedReason)
      .toBeUndefined();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("repair-only blocked can reopen a real GraphRAG rebuild", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-repair-real-rebuild-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "repair-real-rebuild";
    const sourceBytes = "repair requires real graphrag rebuild";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(join(stateRoot, "input"), { recursive: true });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(
      join(stateRoot, "input", `book-${sourceHash.slice(0, 10)}.md`),
      "# Book\n\nAlready normalized.\n",
    );
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const blockedErrorSummary =
      "GraphRAG stage did not produce valid book-scoped artifacts: " +
      JSON.stringify({
        bookId,
        stage: "graph_extract",
        missingArtifactKinds: ["graphrag_documents_parquet"],
      });
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: blockedErrorSummary,
        commandChecks: [],
      }),
    );
    const resumeScript = join(
      tmpRoot,
      "scripts",
      "graphrag",
      "resume-book-workspace.mjs",
    );
    await mkdir(dirname(resumeScript), { recursive: true });
    await writeFile(
      resumeScript,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { basename } from 'node:path';",
        "const sourceIndex = process.argv.indexOf('--source-path');",
        "const sourcePath = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : '';",
        "const sourceName = basename(sourcePath);",
        "const marker = process.env.QMD_FAKE_RESUME_MARKER;",
        "const isRepairOnly = process.argv.includes('--repair-local-artifact-gate-only');",
        "if (marker) writeFileSync(marker, `${sourceName}:${isRepairOnly}\\n`, { flag: 'a' });",
        "if (isRepairOnly) {",
        "  console.log(JSON.stringify({",
        "    status: 'blocked',",
        `    bookId: '${bookId}',`,
        "    startedStage: null,",
        "    nextStage: 'graph_extract',",
        "    completedStages: ['ingest', 'normalize'],",
        "    queryResult: null,",
        "    repairOnly: true,",
        "    repairedLocalArtifactGate: false,",
        "    requiresRealRebuild: true,",
        "    rebuildStage: 'graph_extract',",
        "    reason: 'real GraphRAG rebuild required for graph_extract',",
        "  }));",
        "} else {",
        "  console.error('normal GraphRAG rebuild attempted');",
        "  process.exit(1);",
        "}",
      ].join("\n"),
    );
    const markerPath = join(tmpRoot, "fake-resume-count.txt");

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
      ], {
        env: {
          ...process.env,
          QMD_FAKE_RESUME_MARKER: markerPath,
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const blockedSkips = events.filter((event) =>
      event.itemId === itemId &&
      event.event === "item_local_artifact_gate_repair_blocked_skip"
    );
    const normalResumeStarts = events.filter((event) =>
      event.itemId === itemId &&
      event.event === "command_start" &&
      event.command === "resume-book-1"
    );
    const repairBlockedEvent = events.find((event) =>
      event.itemId === itemId &&
      event.event === "item_local_artifact_gate_repair_blocked"
    );
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(markerPath, "utf8").trim().split("\n")).toEqual([
      "Book.epub:true",
      "Book.epub:false",
    ]);
    expect(blockedSkips).toHaveLength(0);
    expect(normalResumeStarts).toHaveLength(1);
    expect(repairBlockedEvent).toMatchObject({
      failureKind: "transient",
      retryable: true,
      attemptExhausted: false,
      recoveryDecision: "retry_same_run_id",
      failedStage: "graph_extract",
      metadata: {
        requiresRealRebuild: true,
        rebuildStage: "graph_extract",
      },
    });
    expect(checkpoint).toMatchObject({
      status: "failed",
      failedStage: "resume-book-1",
      recoveryDecision: "stop_until_fixed",
      metadata: {
        localArtifactGateRepairRequiresRealRebuild: true,
        localArtifactGateRepairRebuildStage: "graph_extract",
      },
    });
    expect(checkpoint.metadata?.localArtifactGateRepairBlocked).toBeUndefined();
    expect(checkpoint.metadata?.localArtifactGateRepairBlockedReason)
      .toBeUndefined();
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      localArtifactGateRepairRequiresRealRebuild: true,
      localArtifactGateRepairRebuildStage: "graph_extract",
    });
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test.each([
    {
      name: "document identity",
      failureText:
        "GraphRAG document identity is missing for query_ready: doc-fd8875181a17",
      repairReason: "graph_identity_projection_missing",
      repairedProjection: "document_identity_map",
      evidenceSuffix: "output/qmd_graph_text_unit_identity.json",
    },
    {
      name: "graph capability",
      failureText:
        "capabilityScope references unknown or not-ready graphCapabilityId(s): " +
        "book-356ff4920cdf-0bbd8bdb:graph_query",
      repairReason: "graph_query_capability_projection_missing",
      repairedProjection: "graph_capability",
      evidenceSuffix: "checkpoints.yaml#query_ready",
    },
    {
      name: "document identity sidecar mismatch",
      failureText:
        "GraphRAG document identity sidecar does not match query_ready",
      repairReason: "graph_identity_projection_missing",
      repairedProjection: "document_identity_map",
      evidenceSuffix: "output/qmd_graph_text_unit_identity.json",
    },
    {
      name: "document identity sidecar invalid evidence",
      failureText:
        "GraphRAG document identity sidecar evidence is invalid for query_ready",
      repairReason: "graph_identity_projection_missing",
      repairedProjection: "document_identity_map",
      evidenceSuffix: "output/qmd_graph_text_unit_identity.json",
    },
    {
      name: "managed settings projection",
      failureText:
        "graph_vault/settings.yaml is not the managed projection of .qmd/index.yml",
      repairReason: "graph_query_capability_projection_missing",
      repairedProjection: "graph_capability",
      evidenceSuffix: "checkpoints.yaml#query_ready",
    },
  ])("reopens query-ready $name projection gate failures with fixed repair metadata", async ({
    failureText,
    repairReason,
    repairedProjection,
    evidenceSuffix,
  }) => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-query-ready-reopen-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "query-ready-reopen";
    const sourceBytes = "query ready projection reopen";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: failureText,
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 128,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "permanent",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary: failureText,
        }],
      }),
    );
    const resumeScript = join(
      tmpRoot,
      "scripts",
      "graphrag",
      "resume-book-workspace.mjs",
    );
    await mkdir(dirname(resumeScript), { recursive: true });
    await writeFile(
      resumeScript,
      [
        "console.log(JSON.stringify({",
        "  status: 'repaired',",
        `  bookId: '${bookId}',`,
        "  startedStage: null,",
        "  nextStage: null,",
        "  completedStages: ['graph_extract', 'community_report', 'embed', 'query_ready'],",
        "  queryResult: null,",
        "  repairOnly: true,",
        "  repairedLocalArtifactGate: true,",
        `  repairReason: '${repairReason}',`,
        `  repairedProjection: '${repairedProjection}',`,
        `  repairEvidenceLocator: 'graph_vault/books/${bookId}/${evidenceSuffix}',`,
        "  reusedProducerRunIds: {",
        "    graph_extract: 'run-graph-extract',",
        "    community_report: 'run-community-report',",
        "    embed: 'run-embed',",
        "    query_ready: 'run-query-ready',",
        "  },",
        "  settingsProjectionRepair: {",
        "    decision: 'already_valid',",
        "    rewritten: false,",
        "    sourceFingerprint: 'settings-source-fp',",
        `    settingsPath: '${join(stateRoot, "settings.yaml")}',`,
        `    evidenceLocator: '${join(stateRoot, "settings.yaml")}',`,
        "    reason: 'managed_projection_valid',",
        "  },",
        "}));",
      ].join("\n"),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
      ], {
        env: {
          ...process.env,
          QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
          QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const redactionRoot = projectRoot.endsWith(sep) ? projectRoot : `${projectRoot}${sep}`;
    const redactedPath = (path: string) =>
      path.split(redactionRoot).join("[PROJECT_ROOT]");
    const expectedRepairMetadata = {
      reopenedFromStatus: "failed",
      reopenedToStatus: "pending",
      reopenedFromRecoveryDecision: "stop_until_fixed",
      repairReason,
      repairFailureText: failureText,
      repairedProjection,
      repairEvidenceLocator: `graph_vault/books/${bookId}/${evidenceSuffix}`,
      reusedProducerRunIds: {
        graph_extract: "run-graph-extract",
        community_report: "run-community-report",
        embed: "run-embed",
        query_ready: "run-query-ready",
      },
      normalCommandChecksRequired: true,
      settingsProjectionDecision: "already_valid",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: "settings-source-fp",
      settingsProjectionProjectConfigLocator:
        redactedPath(join(configDir, "index.yml")),
      settingsProjectionLocator: redactedPath(join(stateRoot, "settings.yaml")),
      settingsProjectionEvidenceLocator:
        redactedPath(join(stateRoot, "settings.yaml")),
      settingsProjectionReason: "managed_projection_valid",
    };

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint.status).toBe("failed");
    expect(checkpoint.failedStage).toBe("normalize-epub");
    expect(checkpoint.commandChecks[0]?.name).toBe("normalize-epub");
    expect(checkpoint.metadata).toMatchObject({
      localArtifactGateRepairCompleted: true,
      ...expectedRepairMetadata,
      waitingForProviderRecovery: false,
    });
    expect(events.some((event) =>
      event.itemId === itemId &&
      event.event === "item_local_artifact_gate_repair_reopened" &&
      event.status === "pending" &&
      event.metadata?.normalCommandChecksRequired === true &&
      event.metadata?.repairReason === repairReason &&
      event.metadata?.repairedProjection === repairedProjection
    )).toBe(true);
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      ...expectedRepairMetadata,
    });
    expect(events.some((event) =>
      event.itemId === itemId &&
      event.event === "item_start"
    )).toBe(true);
    expect(checkpoint.status).not.toBe("completed");
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("mixed data compatibility and local projection text still stops batch", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-mixed-data-compat-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "mixed-data-compat";
    const sourceBytes = "mixed data compatibility failure";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const compatibilityError =
      "GraphRAG community text-unit context references missing text units: tu-1";
    const localProjectionError =
      "GraphRAG document identity is missing for query_ready: doc-fd8875181a17";
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "data_compatibility",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-2",
        errorSummary: compatibilityError,
        commandChecks: [{
          name: "resume-book-2",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 128,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "permanent",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary: localProjectionError,
        }],
      }),
    );
    const resumeScript = join(tmpRoot, "should-not-run.mjs");
    await writeFile(
      resumeScript,
      "throw new Error('repair runner should not be invoked');\n",
      "utf8",
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
            QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "failed",
      failureKind: "data_compatibility",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
    });
    expect(events.some((event) =>
      event.event === "item_local_artifact_gate_repair"
    )).toBe(false);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_data_compatibility_failure" &&
      event.itemId === itemId
    )).toBe(true);
  });

  test("mixed provider failure and local projection text does not repair", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-mixed-provider-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "mixed-provider";
    const sourceBytes = "mixed provider failure";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const providerError = "HTTP 401 upstream unauthorized";
    const localProjectionError =
      "GraphRAG document identity is missing for query_ready: doc-fd8875181a17";
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: localProjectionError,
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 128,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "permanent",
          retryable: false,
          attemptExhausted: true,
          providerStatusCode: 401,
          recoveryDecision: "stop_until_fixed",
          errorSummary: providerError,
        }],
      }),
    );
    const resumeScript = join(tmpRoot, "should-not-run.mjs");
    await writeFile(
      resumeScript,
      "throw new Error('repair runner should not be invoked');\n",
      "utf8",
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
            QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "failed",
      failureKind: "permanent",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
    });
    expect(checkpoint.commandChecks[0]).toMatchObject({
      providerStatusCode: 401,
    });
    expect(events.some((event) =>
      event.event === "item_local_artifact_gate_repair"
    )).toBe(false);
    expect(events.some((event) =>
      event.event === "item_failed_not_retryable" &&
      event.itemId === itemId
    )).toBe(true);
  });

  test("settings projection rejection is observable in checkpoint events and summary", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-settings-reject-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "settings-projection-reject";
    const sourceBytes = "settings projection rejection";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const normalizedPath = join(
      stateRoot,
      "input",
      `book-${sourceHash.slice(0, 10)}.md`,
    );
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(dirname(normalizedPath), { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(normalizedPath, "# Book\n\nSettings rejection fixture.\n");
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const resumeScript = join(tmpRoot, "fake-settings-reject-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "console.error(",
        "  'Error: graph_vault/settings.yaml is not the managed projection of .qmd/index.yml',",
        ");",
        "process.exit(1);",
      ].join("\n"),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--max-resume-passes",
          "1",
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
            QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const commandFailed = events.find((event) =>
      event.event === "command_failed" && event.itemId === itemId
    );
    const commandExhausted = events.find((event) =>
      event.event === "command_attempt_budget_exhausted" && event.itemId === itemId
    );
    const itemFailed = events.find((event) =>
      event.event === "item_failed" && event.itemId === itemId
    );
    const settingsSourceFingerprint = createHash("sha256")
      .update(JSON.stringify({
        embedding: {},
        graphrag: {},
        models: {},
        providers: {},
        query: {},
      }))
      .digest("hex");
    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "failed",
      recoveryDecision: "stop_until_fixed",
      metadata: {
        settingsProjectionDecision: "rejected_user_owned",
        settingsProjectionRewritten: false,
        settingsProjectionSourceFingerprint: settingsSourceFingerprint,
        settingsProjectionReason:
          "settings_projection_rejected_user_owned_or_invalid",
      },
    });
    expect(commandFailed?.metadata).toMatchObject({
      settingsProjectionDecision: "rejected_user_owned",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
      settingsProjectionReason:
        "settings_projection_rejected_user_owned_or_invalid",
    });
    expect(commandExhausted?.metadata).toMatchObject({
      settingsProjectionDecision: "rejected_user_owned",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
      settingsProjectionReason:
        "settings_projection_rejected_user_owned_or_invalid",
    });
    expect(itemFailed?.metadata).toMatchObject({
      activeCommand: "resume-book-1",
      command: "resume-book-1",
      settingsProjectionDecision: "rejected_user_owned",
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
    });
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      activeCommand: "repair-local-artifact-gate-1",
      settingsProjectionDecision: "rejected_user_owned",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
      settingsProjectionProjectConfigLocator: join(configDir, "index.yml"),
      settingsProjectionLocator: join(stateRoot, "settings.yaml"),
      settingsProjectionEvidenceLocator: join(stateRoot, "settings.yaml"),
      settingsProjectionReason:
        "settings_projection_rejected_user_owned_or_invalid",
    });
  });

  test("invalid source settings projection rejection is observable", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-settings-invalid-source-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "settings-projection-invalid-source";
    const sourceBytes = "settings projection invalid source";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const normalizedPath = join(
      stateRoot,
      "input",
      `book-${sourceHash.slice(0, 10)}.md`,
    );
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(dirname(normalizedPath), { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(normalizedPath, "# Book\n\nInvalid source fixture.\n");
    await writeFile(
      join(configDir, "index.yml"),
      [
        "collections: {}",
        "providers:",
        "  jina:",
        "    embedding_profile: audio",
      ].join("\n"),
    );
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const resumeScript = join(tmpRoot, "fake-settings-invalid-source-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "console.error(",
        "  \"TypeError: Cannot read properties of undefined (reading 'queryTask')\",",
        ");",
        "process.exit(1);",
      ].join("\n"),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--max-resume-passes",
          "1",
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
            QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const itemFailed = events.find((event) =>
      event.event === "item_failed" && event.itemId === itemId
    );
    const settingsSourceFingerprint = createHash("sha256")
      .update(JSON.stringify({
        embedding: {},
        graphrag: {},
        models: {},
        providers: { jina: { embedding_profile: "audio" } },
        query: {},
      }))
      .digest("hex");
    await rm(tmpRoot, { recursive: true, force: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint.metadata).toMatchObject({
      settingsProjectionDecision: "rejected_invalid_source",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
      settingsProjectionReason: "settings_projection_rejected_invalid_source",
    });
    expect(itemFailed?.metadata).toMatchObject({
      activeCommand: "resume-book-1",
      settingsProjectionDecision: "rejected_invalid_source",
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
    });
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      settingsProjectionDecision: "rejected_invalid_source",
      settingsProjectionRewritten: false,
      settingsProjectionSourceFingerprint: settingsSourceFingerprint,
      settingsProjectionProjectConfigLocator: join(configDir, "index.yml"),
      settingsProjectionEvidenceLocator: join(configDir, "index.yml"),
      settingsProjectionReason: "settings_projection_rejected_invalid_source",
    });
  });

  test("blocks repaired local projection output that lacks required metadata", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-repair-missing-meta-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "repair-missing-meta";
    const sourceBytes = "missing repair metadata";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const failureText =
      "GraphRAG document identity is missing for query_ready: doc-fd8875181a17";
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-1",
        errorSummary: failureText,
        commandChecks: [],
      }),
    );
    const resumeScript = join(tmpRoot, "fake-repair-missing-meta.mjs");
    await writeFile(
      resumeScript,
      [
        "console.log(JSON.stringify({",
        "  status: 'repaired',",
        `  bookId: '${bookId}',`,
        "  repairOnly: true,",
        "  repairedLocalArtifactGate: true",
        "}));",
      ].join("\n"),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
            QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "pending",
      recoveryDecision: "continue_pending",
      retryable: false,
      metadata: {
        localArtifactGateRepairBlocked: true,
      },
    });
    expect(checkpoint.metadata?.localArtifactGateRepairCompleted).toBeUndefined();
    expect(checkpoint.metadata?.repairReason).toBeUndefined();
    expect(events.some((event) =>
      event.event === "item_local_artifact_gate_repair_reopened"
    )).toBe(false);
    expect(events.some((event) =>
      event.event === "item_local_artifact_gate_repair_blocked" &&
      event.metadata?.repairedLocalArtifactGate === false
    )).toBe(true);
  });

  test("status-json hydrates event-proven repair-only blocked loops", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-repair-loop-hydrate-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "repair-loop-hydrate";
    const sourceBytes = "event proven repair loop";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 3,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "repair-local-artifact-gate",
        errorSummary: "resume-book did not reach ready after 24 passes",
        commandChecks: [{
          name: "resume-book-1",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 128,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "permanent",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary: "GraphRAG stage did not produce valid book-scoped artifacts",
        }],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      [
        JSON.stringify({
          schemaVersion: SchemaVersion,
          runId,
          itemId,
          event: "local_artifact_gate_repair_pass_completed",
          status: "running",
          at: "2026-05-23T00:09:00.000Z",
          metadata: {
            pass: 24,
            command: "repair-local-artifact-gate-24",
            resumeStatus: "blocked",
            nextStage: null,
          },
        }),
      ].join("\n") + "\n",
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("continue_pending");
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      recoveryDecision: "continue_pending",
      failureKind: "permanent",
      retryable: false,
      failedStage: "repair-local-artifact-gate",
      waitingForProviderRecovery: false,
    });
  });

  test("status-json recovers orphaned running item to retryable pending", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-orphan-running-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "orphan-running-fixture";
    const sourceBytes = "orphaned running";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 1,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "running",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        runnerSessionId: "dead-session",
        runnerHost: hostname(),
        runnerPid: 999999,
        runnerHeartbeatAt: "2026-05-23T00:01:00.000Z",
        commandChecks: [],
      }),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventsExist = existsSync(eventLogPath);
    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.counts).toMatchObject({ pending: 1 });
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      qmdBuildStatus: { status: "pending" },
      graphBuildStatus: { status: "pending" },
      failureKind: "transient",
      retryable: true,
      recoveryDecision: "retry_same_run_id",
      failedStage: "runner_orphaned",
    });
    expect(checkpoint).toMatchObject({
      status: "running",
      runnerSessionId: "dead-session",
      runnerHost: hostname(),
      attempts: 1,
    });
    expect(eventsExist).toBe(false);
  });

  test("non-transient GraphRAG data compatibility failure stops before next book", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-data-compat-stop-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "data-compat-stop";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(sourceDir, "A-Failed.epub"), "failed data compat");
    await writeFile(join(sourceDir, "B-Pending.epub"), "pending should not run");

    const firstPath = join(sourceDir, "A-Failed.epub");
    const secondPath = join(sourceDir, "B-Pending.epub");
    const firstHash = createHash("sha256")
      .update("failed data compat")
      .digest("hex");
    const secondHash = createHash("sha256")
      .update("pending should not run")
      .digest("hex");
    const firstRelativePath = relative(projectRoot, firstPath);
    const secondRelativePath = relative(projectRoot, secondPath);
    const firstItemId = `item-${firstHash.slice(0, 12)}-${
      createHash("sha256").update(firstRelativePath).digest("hex").slice(0, 8)
    }`;
    const secondItemId = `item-${secondHash.slice(0, 12)}-${
      createHash("sha256").update(secondRelativePath).digest("hex").slice(0, 8)
    }`;
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 2,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [firstItemId, secondItemId],
      }),
    );
    const compatibilityError =
      "GraphRAG community text-unit context references missing text units: " +
      "tu-missing";
    await writeFile(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${firstItemId}.json`,
      ),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId: firstItemId,
        runId,
        status: "failed",
        sourceName: "A-Failed.epub",
        sourceRelativePath: firstRelativePath,
        sourceIdentityPath: firstRelativePath,
        sourceHash: firstHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "failed.md"),
        bookId: batchBookId(firstHash, firstRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "data_compatibility",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-2",
        errorSummary: compatibilityError,
        commandChecks: [{
          name: "resume-book-2",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 120,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "data_compatibility",
          retryable: false,
          attemptExhausted: true,
          recoveryDecision: "stop_until_fixed",
          errorSummary: compatibilityError,
        }],
      }),
    );
    await writeFile(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${secondItemId}.json`,
      ),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId: secondItemId,
        runId,
        status: "pending",
        sourceName: "B-Pending.epub",
        sourceRelativePath: secondRelativePath,
        sourceIdentityPath: secondRelativePath,
        sourceHash: secondHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "pending.md"),
        bookId: batchBookId(secondHash, secondRelativePath),
        attempts: 0,
        recoveryDecision: "none",
        commandChecks: [],
      }),
    );

    const result = await new Promise<{
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
      ]);
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
    });

    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const summary = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    ));
    const secondCheckpoint = JSON.parse(readFileSync(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${secondItemId}.json`,
      ),
      "utf8",
    ));

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(events.some((event) =>
      event.event === "batch_stopped_after_data_compatibility_failure" &&
      event.itemId === firstItemId &&
      event.failureKind === "data_compatibility"
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_non_transient_failure" &&
      event.itemId === firstItemId &&
      event.failureKind === "data_compatibility"
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "command_start" &&
      event.itemId === secondItemId
    )).toBe(false);
    expect(secondCheckpoint.status).toBe("pending");
    expect(secondCheckpoint.attempts).toBe(0);
    expect(summary.recoveryDecision).toBe("stop_until_fixed");
    expect(summary.counts).toMatchObject({ failed: 1, pending: 1 });
  });

  test("pure float data compatibility failure remains stop-until-fixed", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-float-data-compat-stop-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "float-data-compat-stop";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(sourceDir, "Book.epub"), "float data compat");

    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const sourceHash = createHash("sha256").update("float data compat").digest("hex");
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    const compatibilityError =
      "create_community_reports_text failed: 'float' object is not subscriptable";
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "data_compatibility",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-2",
        errorSummary: compatibilityError,
        commandChecks: [],
      }),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "failed",
      failureKind: "data_compatibility",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
    });
    expect(events.some((event) =>
      event.event === "item_data_compatibility_recovered"
    )).toBe(false);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_data_compatibility_failure" &&
      event.itemId === itemId
    )).toBe(true);
  });

  test("data compatibility stop scans all items before sorted pending work", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-data-compat-global-stop-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "data-compat-global-stop";
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(sourceDir, "A-Pending.epub"), "pending sorts first");
    await writeFile(join(sourceDir, "B-Failed.epub"), "failed sorts second");

    const pendingPath = join(sourceDir, "A-Pending.epub");
    const failedPath = join(sourceDir, "B-Failed.epub");
    const pendingHash = createHash("sha256")
      .update("pending sorts first")
      .digest("hex");
    const failedHash = createHash("sha256")
      .update("failed sorts second")
      .digest("hex");
    const pendingRelativePath = relative(projectRoot, pendingPath);
    const failedRelativePath = relative(projectRoot, failedPath);
    const pendingItemId = `item-${pendingHash.slice(0, 12)}-${
      createHash("sha256").update(pendingRelativePath).digest("hex").slice(0, 8)
    }`;
    const failedItemId = `item-${failedHash.slice(0, 12)}-${
      createHash("sha256").update(failedRelativePath).digest("hex").slice(0, 8)
    }`;
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 2,
        pendingItems: 1,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [pendingItemId, failedItemId],
      }),
    );
    await writeFile(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${pendingItemId}.json`,
      ),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId: pendingItemId,
        runId,
        status: "pending",
        sourceName: "A-Pending.epub",
        sourceRelativePath: pendingRelativePath,
        sourceIdentityPath: pendingRelativePath,
        sourceHash: pendingHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "pending.md"),
        bookId: batchBookId(pendingHash, pendingRelativePath),
        attempts: 0,
        recoveryDecision: "none",
        commandChecks: [],
      }),
    );
    const compatibilityError =
      "GraphRAG community text-unit context references missing text units: " +
      "tu-missing";
    await writeFile(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${failedItemId}.json`,
      ),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId: failedItemId,
        runId,
        status: "failed",
        sourceName: "B-Failed.epub",
        sourceRelativePath: failedRelativePath,
        sourceIdentityPath: failedRelativePath,
        sourceHash: failedHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "failed.md"),
        bookId: batchBookId(failedHash, failedRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "data_compatibility",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-2",
        errorSummary: compatibilityError,
        commandChecks: [],
      }),
    );

    const result = await new Promise<{
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
      ]);
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
    });

    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const pendingCheckpoint = JSON.parse(readFileSync(
      join(
        stateRoot,
        "catalog",
        "batch-runs",
        runId,
        "items",
        `${pendingItemId}.json`,
      ),
      "utf8",
    ));

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(events.some((event) =>
      event.event === "batch_stopped_after_data_compatibility_failure" &&
      event.itemId === failedItemId
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "batch_stopped_after_non_transient_failure" &&
      event.itemId === failedItemId
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "command_start" &&
      event.itemId === pendingItemId
    )).toBe(false);
    expect(pendingCheckpoint.status).toBe("pending");
    expect(pendingCheckpoint.attempts).toBe(0);
  });

  test("summary does not project stale provider wait on non-transient failures", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-stale-provider-wait-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "stale-provider-wait";
    const sourceBytes = "stale provider wait";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:10:00.000Z",
        failureKind: "data_compatibility",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "resume-book-2",
        errorSummary: "GraphRAG community text-unit context references missing text units",
        commandChecks: [],
        metadata: {
          waitingForProviderRecovery: true,
        },
      }),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.items[0]).toMatchObject({
      status: "failed",
      failureKind: "data_compatibility",
      retryable: false,
      recoveryDecision: "stop_until_fixed",
    });
    expect(summary.items[0].waitingForProviderRecovery).toBe(false);
    expect(summary.items[0].providerRecoveryWaitCount).toBeUndefined();
    expect(summary.items[0].maxProviderRecoveryWaits).toBeUndefined();
    expect(summary.items[0].providerRecoveryReason).toBeUndefined();
  });

  test("status-json does not steal fresh remote running items", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-remote-running-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "remote-running-fixture";
    const sourceBytes = "remote running";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 1,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "running",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        runnerSessionId: "remote-session",
        runnerHost: "other-host.example",
        runnerPid: 12345,
        runnerHeartbeatAt: new Date().toISOString(),
        commandChecks: [],
      }),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventLog = existsSync(eventLogPath) ? readFileSync(eventLogPath, "utf8") : "";
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.counts).toMatchObject({ running: 1 });
    expect(summary.recoveryDecision).toBe("continue_pending");
    expect(summary.items[0]).toMatchObject({
      status: "running",
      runnerHost: "other-host.example",
    });
    expect(checkpoint.status).toBe("running");
    expect(eventLog).not.toContain("item_running_recovered");
  });

  test("status-json projects stale remote running items as retryable pending", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-stale-remote-running-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "stale-remote-running-fixture";
    const sourceBytes = "stale remote running";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 1,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "running",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        runnerSessionId: "stale-remote-session",
        runnerHost: "other-host.example",
        runnerPid: 12345,
        runnerHeartbeatAt: "2026-05-23T00:01:00.000Z",
        commandChecks: [],
      }),
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventLog = existsSync(eventLogPath) ? readFileSync(eventLogPath, "utf8") : "";
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.counts).toMatchObject({ pending: 1 });
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      runnerHost: "other-host.example",
      failureKind: "transient",
      retryable: true,
      recoveryDecision: "retry_same_run_id",
      failedStage: "runner_orphaned",
    });
    expect(checkpoint.status).toBe("running");
    expect(eventLog).not.toContain("item_running_recovered");
  });

  test("normal run does not steal fresh remote running items", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-remote-running-run-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "remote-running-run-fixture";
    const sourceBytes = "remote running normal run";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 1,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "running",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        runnerSessionId: "remote-session",
        runnerHost: "other-host.example",
        runnerPid: 12345,
        runnerHeartbeatAt: new Date().toISOString(),
        commandChecks: [],
      }),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(checkpoint).toMatchObject({
      status: "running",
      runnerSessionId: "remote-session",
      runnerHost: "other-host.example",
      attempts: 1,
    });
    expect(events.some((event) => event.event === "item_running_observed"))
      .toBe(true);
    expect(events.some((event) => event.event === "item_start")).toBe(false);
  });

  test("normal run recovers stale remote running items before processing", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-stale-remote-running-run-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "stale-remote-running-run-fixture";
    const sourceBytes = "stale remote running normal run";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const normalizedPath = join(
      stateRoot,
      "input",
      `book-${sourceHash.slice(0, 10)}.md`,
    );
    await mkdir(dirname(normalizedPath), { recursive: true });
    await writeFile(normalizedPath, "# Book\n\nStale remote running fixture.\n");
    const resumeScript = join(tmpRoot, "fake-stale-remote-resume.mjs");
    await writeFile(
      resumeScript,
      [
        "console.error('permanent GraphRAG failure after stale lease recovery');",
        "process.exit(1);",
      ].join("\n"),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 1,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "running",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        runnerSessionId: "stale-remote-session",
        runnerHost: "other-host.example",
        runnerPid: 12345,
        runnerHeartbeatAt: "2026-05-23T00:01:00.000Z",
        commandChecks: [],
      }),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--max-resume-passes",
          "1",
        ], {
          env: {
            ...process.env,
            QMD_GRAPHRAG_TEST_RESUME_RUNNER: "1",
            QMD_GRAPHRAG_RESUME_RUNNER: resumeScript,
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const events = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(events.some((event) => event.event === "item_running_recovered"))
      .toBe(true);
    expect(events.some((event) => event.event === "item_start")).toBe(true);
    expect(checkpoint).toMatchObject({
      status: "failed",
      attempts: 2,
      metadata: {
        orphanedRunnerRecovered: true,
        orphanedRunnerHost: "other-host.example",
      },
    });
  });

  test("migrate-only reopens completed items without real GraphRAG evidence", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-reopen-completed-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "reopen-completed-fixture";
    const sourceBytes = "legacy completed item";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const commandChecks = passedBatchCommandChecks();

    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "completed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(
          ".tmp-tests",
          "graph_vault",
          "input",
          "book.md",
        ),
        bookId,
        attempts: 1,
        expectedCommandCheckCount: 27,
        maxCommandAttempts: 3,
        maxResumePasses: 8,
        completedAt: "2026-05-23T00:01:00.000Z",
        commandChecks,
      }),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--migrate-only",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const batchRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const manifest = JSON.parse(readFileSync(join(batchRoot, "manifest.json"), "utf8"));
    const checkpoint = JSON.parse(
      readFileSync(join(batchRoot, "items", `${itemId}.json`), "utf8"),
    );
    const events = readFileSync(join(batchRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(manifest).toMatchObject({
      status: "running",
      pendingItems: 1,
      completedItems: 0,
      failedItems: 0,
    });
    expect(checkpoint).toMatchObject({
      status: "pending",
      recoveryDecision: "continue_pending",
      qmdBuildStatus: { status: "succeeded" },
      graphBuildStatus: {
        status: "pending",
        stage: "graph_extract",
        reason: "real_graphrag_stage_missing",
      },
      metadata: {
        reopenedFromCompleted: true,
      },
    });
    expect(events.some((event) => event.event === "item_completed_reopened"))
      .toBe(true);
  });

  test("non-migrate runs reopen skipped items for real build", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-reopen-skipped-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "reopen-skipped-fixture";
    const sourceBytes = "legacy skipped item";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;

    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "running",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 1,
        importedCompletedItems: 1,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "skipped",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 0,
        recoveryDecision: "none",
        commandChecks: [],
        metadata: {
          importedCompletedMode: "skip_for_migration",
        },
      }),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--command-timeout-seconds",
          "1",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const batchRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const manifest = JSON.parse(readFileSync(join(batchRoot, "manifest.json"), "utf8"));
    const checkpoint = JSON.parse(
      readFileSync(join(batchRoot, "items", `${itemId}.json`), "utf8"),
    );
    const events = readFileSync(join(batchRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(manifest.skippedItems).toBe(0);
    expect(checkpoint.status).not.toBe("skipped");
    expect(checkpoint.metadata).toMatchObject({
      reopenedSkippedForRealBuild: true,
    });
    expect(events.some((event) =>
      event.event === "item_skipped_reopened" &&
      event.itemId === itemId
    )).toBe(true);
    expect(events.some((event) => event.event === "item_skipped")).toBe(false);
  });

  test("status-json accepts portable book-scoped GraphRAG producer evidence", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-graph-evidence-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "graph-evidence-fixture";
    const sourceBytes = "completed with graph evidence";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const outputRel = join("books", bookId, "output");
    const outputDir = join(stateRoot, outputRel);
    const documentId = `doc-${sourceHash.slice(0, 12)}`;
    const contentHash = sourceHash;
    const stageFingerprints = {
      ingest: "fp-ingest",
      normalize: "fp-normalize",
      graph_extract: "fp-graph-extract",
      community_report: "fp-community-report",
      embed: "fp-embed",
      query_ready: "fp-query-ready",
    };
    const providerFingerprint = "provider-fp";
    const artifactIds = {
      documents: `${bookId}:graph_extract:documents`,
      textUnits: `${bookId}:graph_extract:text_units`,
      entities: `${bookId}:graph_extract:entities`,
      relationships: `${bookId}:graph_extract:relationships`,
      communities: `${bookId}:graph_extract:communities`,
      context: `${bookId}:graph_extract:context`,
      stats: `${bookId}:graph_extract:stats`,
      reports: `${bookId}:community_report:reports`,
      lancedb: `${bookId}:embed:lancedb`,
    };
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    for (const name of [
      "documents.parquet", "text_units.parquet", "entities.parquet",
      "relationships.parquet", "communities.parquet", "community_reports.parquet",
    ]) {
      await writeMinimalParquetFixture(join(outputDir, name));
    }
    await writeFile(join(outputDir, "context.json"), "{}", "utf8");
    await writeFile(join(outputDir, "stats.json"), "{}", "utf8");
    await writeCompleteLanceDbFixture(join(outputDir, "lancedb"));
    const graphArtifacts = await graphArtifactManifests({
      outputDir,
      outputRel,
      bookId,
      artifactIds,
      stageFingerprints,
      providerFingerprint,
      corpusContentHash: contentHash,
    });
    await writeFile(
      join(outputDir, "qmd_output_manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        bookId,
        sourceHash,
        documentId,
        contentHash,
        stageFingerprints,
        providerFingerprint,
        outputDir: `books/${bookId}/output`,
        producerRunId: "run-query-ready",
        stageProducerRunIds: {
          graph_extract: "run-graph-extract",
          community_report: "run-community-report",
          embed: "run-embed",
        },
      }),
    );
    await mkdir(join(stateRoot, "books", bookId), { recursive: true });
    await mkdir(join(stateRoot, "catalog"), { recursive: true });
    await writeFile(
      join(stateRoot, "catalog", "books.yaml"),
      YAML.stringify({
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          bookId,
          documentId,
          sourcePath: `sources/${bookId}/source.epub`,
          sourceHash,
          normalizedContentHash: contentHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          configFingerprint: "config-fp",
          promptFingerprint: "prompt-fp",
          modelFingerprint: "model-fp",
          stageFingerprints,
          providerFingerprint,
          overallStatus: "succeeded",
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:01.000Z",
        }],
      }),
    );
    await writeFile(
      join(stateRoot, "books", bookId, "artifacts.yaml"),
      YAML.stringify({ schemaVersion: SchemaVersion, items: graphArtifacts }),
    );
    await writeFile(
      join(stateRoot, "books", bookId, "checkpoints.yaml"),
      YAML.stringify({
        schemaVersion: SchemaVersion,
        items: [
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "graph_extract",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-graph-extract",
            inputFingerprint: "fp-graph-extract",
            contentHash,
            stageFingerprint: "fp-graph-extract",
            providerFingerprint,
            artifactIds: [
              artifactIds.documents, artifactIds.textUnits, artifactIds.entities,
              artifactIds.relationships, artifactIds.communities,
              artifactIds.context, artifactIds.stats,
            ],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "community_report",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-community-report",
            inputFingerprint: "fp-community-report",
            contentHash,
            stageFingerprint: "fp-community-report",
            providerFingerprint,
            artifactIds: [artifactIds.reports],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "embed",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-embed",
            inputFingerprint: "fp-embed",
            contentHash,
            stageFingerprint: "fp-embed",
            providerFingerprint,
            artifactIds: [artifactIds.lancedb],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "query_ready",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-query-ready",
            inputFingerprint: "fp-query-ready",
            contentHash,
            stageFingerprint: "fp-query-ready",
            providerFingerprint,
            artifactIds: [artifactIds.reports, artifactIds.lancedb],
          },
        ],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "completed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 1,
        qmdBuildStatus: { status: "succeeded" },
        commandChecks: passedBatchCommandChecks(),
      }),
    );

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--status-json",
        ]);
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventsExist = existsSync(eventLogPath);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      recoveryDecision: "none",
      counts: { completed: 1 },
    });
    expect(summary.items[0]).toMatchObject({
      status: "completed",
      qmdBuildStatus: { status: "succeeded" },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
    });

    await writeFile(join(outputDir, "documents.parquet"), "", "utf8");
    const missingCoreResult = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });
    const missingCoreSummary = JSON.parse(missingCoreResult.stdout);
    expect(missingCoreResult.exitCode).toBe(0);
    expect(missingCoreResult.stderr).toBe("");
    expect(missingCoreSummary.items[0].graphBuildStatus).toMatchObject({
      status: "stale",
      stage: "graph_extract",
      reason: "stage_artifact_invalid:content_hash_mismatch",
    });
    expect(missingCoreSummary.items[0].graphBuildStatus.reason)
      .not.toContain("stats");
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("status-json reopens completed items when GraphRAG query check failed", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-graph-query-failed-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "graph-query-failed-fixture";
    const sourceBytes = "completed with failed graph query";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const outputRel = join("books", bookId, "output");
    const outputDir = join(stateRoot, outputRel);
    const documentId = `doc-${sourceHash.slice(0, 12)}`;
    const contentHash = sourceHash;
    const stageFingerprints = {
      ingest: "fp-ingest",
      normalize: "fp-normalize",
      graph_extract: "fp-graph-extract",
      community_report: "fp-community-report",
      embed: "fp-embed",
      query_ready: "fp-query-ready",
    };
    const providerFingerprint = "provider-fp";
    const artifactIds = {
      documents: `${bookId}:graph_extract:documents`,
      textUnits: `${bookId}:graph_extract:text_units`,
      entities: `${bookId}:graph_extract:entities`,
      relationships: `${bookId}:graph_extract:relationships`,
      communities: `${bookId}:graph_extract:communities`,
      context: `${bookId}:graph_extract:context`,
      stats: `${bookId}:graph_extract:stats`,
      reports: `${bookId}:community_report:reports`,
      lancedb: `${bookId}:embed:lancedb`,
    };
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    for (const name of [
      "documents.parquet", "text_units.parquet", "entities.parquet",
      "relationships.parquet", "communities.parquet", "community_reports.parquet",
    ]) {
      await writeMinimalParquetFixture(join(outputDir, name));
    }
    await writeFile(join(outputDir, "context.json"), "{}", "utf8");
    await writeFile(join(outputDir, "stats.json"), "{}", "utf8");
    await writeCompleteLanceDbFixture(join(outputDir, "lancedb"));
    const graphArtifacts = await graphArtifactManifests({
      outputDir,
      outputRel,
      bookId,
      artifactIds,
      stageFingerprints,
      providerFingerprint,
      corpusContentHash: contentHash,
    });
    await writeFile(
      join(outputDir, "qmd_output_manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        bookId,
        sourceHash,
        documentId,
        contentHash,
        stageFingerprints,
        providerFingerprint,
        outputDir: `books/${bookId}/output`,
        producerRunId: "run-query-ready",
        stageProducerRunIds: {
          graph_extract: "run-graph-extract",
          community_report: "run-community-report",
          embed: "run-embed",
        },
      }),
    );
    await mkdir(join(stateRoot, "books", bookId), { recursive: true });
    await mkdir(join(stateRoot, "catalog"), { recursive: true });
    await writeFile(
      join(stateRoot, "catalog", "books.yaml"),
      YAML.stringify({
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          bookId,
          documentId,
          sourcePath: `sources/${bookId}/source.epub`,
          sourceHash,
          normalizedContentHash: contentHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          configFingerprint: "config-fp",
          promptFingerprint: "prompt-fp",
          modelFingerprint: "model-fp",
          stageFingerprints,
          providerFingerprint,
          overallStatus: "succeeded",
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:01.000Z",
        }],
      }),
    );
    await writeFile(
      join(stateRoot, "books", bookId, "artifacts.yaml"),
      YAML.stringify({ schemaVersion: SchemaVersion, items: graphArtifacts }),
    );
    await writeFile(
      join(stateRoot, "books", bookId, "checkpoints.yaml"),
      YAML.stringify({
        schemaVersion: SchemaVersion,
        items: [
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "graph_extract",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-graph-extract",
            inputFingerprint: "fp-graph-extract",
            contentHash,
            stageFingerprint: "fp-graph-extract",
            providerFingerprint,
            artifactIds: [
              artifactIds.documents, artifactIds.textUnits, artifactIds.entities,
              artifactIds.relationships, artifactIds.communities,
              artifactIds.context, artifactIds.stats,
            ],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "community_report",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-community-report",
            inputFingerprint: "fp-community-report",
            contentHash,
            stageFingerprint: "fp-community-report",
            providerFingerprint,
            artifactIds: [artifactIds.reports],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "embed",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-embed",
            inputFingerprint: "fp-embed",
            contentHash,
            stageFingerprint: "fp-embed",
            providerFingerprint,
            artifactIds: [artifactIds.lancedb],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "query_ready",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-query-ready",
            inputFingerprint: "fp-query-ready",
            contentHash,
            stageFingerprint: "fp-query-ready",
            providerFingerprint,
            artifactIds: [artifactIds.reports, artifactIds.lancedb],
          },
        ],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    const commandChecks = passedBatchCommandChecks().map((check) =>
      check.name === "qmd-query-graphrag-json"
        ? {
            ...check,
            status: "failed",
            exitCode: 1,
            stderrBytes: 32,
            failureKind: "transient",
            retryable: true,
            attemptExhausted: false,
            recoveryDecision: "retry_same_run_id",
            errorSummary: "GraphRAG query provider failed",
          }
        : check
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "completed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 1,
        qmdBuildStatus: { status: "succeeded" },
        commandChecks,
      }),
    );

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--status-json",
        ]);
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
      },
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("retry_same_run_id");
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "transient",
      retryable: true,
      retryExhausted: false,
      recoveryDecision: "retry_same_run_id",
      failedStage: "qmd-query-graphrag-json",
      qmdBuildStatus: { status: "succeeded" },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
      graphQueryStatus: {
        status: "failed",
        stage: "qmd-query-graphrag-json",
        reason: "graph_query_command_check_failed",
      },
    });
  });

  test("status-json reopens completed items with incomplete command check set", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-incomplete-command-checks-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "incomplete-command-checks-fixture";
    const sourceBytes = "completed with incomplete command checks";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const outputRel = join("books", bookId, "output");
    const outputDir = join(stateRoot, outputRel);
    const documentId = `doc-${sourceHash.slice(0, 12)}`;
    const contentHash = sourceHash;
    const stageFingerprints = {
      ingest: "fp-ingest",
      normalize: "fp-normalize",
      graph_extract: "fp-graph-extract",
      community_report: "fp-community-report",
      embed: "fp-embed",
      query_ready: "fp-query-ready",
    };
    const providerFingerprint = "provider-fp";
    const artifactIds = {
      documents: `${bookId}:graph_extract:documents`,
      textUnits: `${bookId}:graph_extract:text_units`,
      entities: `${bookId}:graph_extract:entities`,
      relationships: `${bookId}:graph_extract:relationships`,
      communities: `${bookId}:graph_extract:communities`,
      context: `${bookId}:graph_extract:context`,
      stats: `${bookId}:graph_extract:stats`,
      reports: `${bookId}:community_report:reports`,
      lancedb: `${bookId}:embed:lancedb`,
    };
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    for (const name of [
      "documents.parquet", "text_units.parquet", "entities.parquet",
      "relationships.parquet", "communities.parquet", "community_reports.parquet",
    ]) {
      await writeMinimalParquetFixture(join(outputDir, name));
    }
    await writeFile(join(outputDir, "context.json"), "{}", "utf8");
    await writeFile(join(outputDir, "stats.json"), "{}", "utf8");
    await writeCompleteLanceDbFixture(join(outputDir, "lancedb"));
    const graphArtifacts = await graphArtifactManifests({
      outputDir,
      outputRel,
      bookId,
      artifactIds,
      stageFingerprints,
      providerFingerprint,
      corpusContentHash: contentHash,
    });
    await writeFile(
      join(outputDir, "qmd_output_manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        bookId,
        sourceHash,
        documentId,
        contentHash,
        stageFingerprints,
        providerFingerprint,
        outputDir: `books/${bookId}/output`,
        producerRunId: "run-query-ready",
        stageProducerRunIds: {
          graph_extract: "run-graph-extract",
          community_report: "run-community-report",
          embed: "run-embed",
        },
      }),
    );
    await mkdir(join(stateRoot, "books", bookId), { recursive: true });
    await mkdir(join(stateRoot, "catalog"), { recursive: true });
    await writeFile(
      join(stateRoot, "catalog", "books.yaml"),
      YAML.stringify({
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          bookId,
          documentId,
          sourcePath: `sources/${bookId}/source.epub`,
          sourceHash,
          normalizedContentHash: contentHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          configFingerprint: "config-fp",
          promptFingerprint: "prompt-fp",
          modelFingerprint: "model-fp",
          stageFingerprints,
          providerFingerprint,
          overallStatus: "succeeded",
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:01.000Z",
        }],
      }),
    );
    await writeFile(
      join(stateRoot, "books", bookId, "artifacts.yaml"),
      YAML.stringify({ schemaVersion: SchemaVersion, items: graphArtifacts }),
    );
    await writeFile(
      join(stateRoot, "books", bookId, "checkpoints.yaml"),
      YAML.stringify({
        schemaVersion: SchemaVersion,
        items: [
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "graph_extract",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-graph-extract",
            inputFingerprint: "fp-graph-extract",
            contentHash,
            stageFingerprint: "fp-graph-extract",
            providerFingerprint,
            artifactIds: [
              artifactIds.documents, artifactIds.textUnits, artifactIds.entities,
              artifactIds.relationships, artifactIds.communities,
              artifactIds.context, artifactIds.stats,
            ],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "community_report",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-community-report",
            inputFingerprint: "fp-community-report",
            contentHash,
            stageFingerprint: "fp-community-report",
            providerFingerprint,
            artifactIds: [artifactIds.reports],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "embed",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-embed",
            inputFingerprint: "fp-embed",
            contentHash,
            stageFingerprint: "fp-embed",
            providerFingerprint,
            artifactIds: [artifactIds.lancedb],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "query_ready",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-query-ready",
            inputFingerprint: "fp-query-ready",
            contentHash,
            stageFingerprint: "fp-query-ready",
            providerFingerprint,
            artifactIds: [artifactIds.reports, artifactIds.lancedb],
          },
        ],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "completed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 1,
        qmdBuildStatus: { status: "succeeded" },
        graphBuildStatus: { status: "succeeded" },
        graphQueryStatus: { status: "succeeded" },
        commandChecks: passedBatchCommandChecks()
          .filter((check) => check.name !== "qmd-cleanup"),
      }),
    );

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--status-json",
        ]);
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
      },
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("continue_pending");
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failedStage: "qmd-cleanup",
      qmdBuildStatus: { status: "pending" },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
      graphQueryStatus: { status: "succeeded" },
    });
  });

  test("status-json reopens completed non-transient failed checks with valid schema", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-nontransient-reopen-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "nontransient-reopen-fixture";
    const commandChecks = passedBatchCommandChecks().map((check) =>
      check.name === "qmd-search-json"
        ? {
            ...check,
            status: "failed",
            exitCode: 1,
            stderrBytes: 64,
            failureKind: "permanent",
            retryable: false,
            attemptExhausted: true,
            recoveryDecision: "stop_until_fixed",
            errorSummary: "search output contract mismatch",
          }
        : check
    );
    await writeCompletedGraphBatchFixture({
      tmpRoot,
      sourceDir,
      stateRoot,
      configDir,
      runId,
      sourceBytes: "completed with non-transient failed check",
      commandChecks,
    });

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolveResult) => {
      const proc = spawn(process.execPath, [
        join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
        "--source-dir",
        sourceDir,
        "--state-root",
        stateRoot,
        "--log-root",
        logRoot,
        "--config",
        join(configDir, "index.yml"),
        "--qmd-index-path",
        join(tmpRoot, "index.sqlite"),
        "--run-id",
        runId,
        "--skip-dotenv",
        "--status-json",
      ]);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
      proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
    });

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("continue_pending");
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      failureKind: "permanent",
      retryable: false,
      recoveryDecision: "continue_pending",
      failedStage: "qmd-search-json",
      qmdBuildStatus: {
        status: "failed",
        stage: "qmd-search-json",
        reason: "qmd_command_check_failed",
      },
      graphBuildStatus: { status: "succeeded", stage: "query_ready" },
      graphQueryStatus: { status: "succeeded" },
    });
    expect(summary.items[0].retryExhausted).toBeUndefined();
  });

  test("status-json reopens completed items with stale GraphRAG producer lineage", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-stale-producer-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "stale-producer-fixture";
    const sourceBytes = "completed with stale graph evidence";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = join(sourceDir, "Book.epub");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const bookId = batchBookId(sourceHash, sourceRelativePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const outputRel = join("books", bookId, "output");
    const outputDir = join(stateRoot, outputRel);
    const documentId = `doc-${sourceHash.slice(0, 12)}`;
    const contentHash = sourceHash;
    const stageFingerprints = {
      ingest: "fp-ingest",
      normalize: "fp-normalize",
      graph_extract: "fp-graph-extract",
      community_report: "fp-community-report",
      embed: "fp-embed",
      query_ready: "fp-query-ready",
    };
    const providerFingerprint = "provider-fp";
    const artifactIds = {
      documents: `${bookId}:graph_extract:documents`,
      textUnits: `${bookId}:graph_extract:text_units`,
      entities: `${bookId}:graph_extract:entities`,
      relationships: `${bookId}:graph_extract:relationships`,
      communities: `${bookId}:graph_extract:communities`,
      context: `${bookId}:graph_extract:context`,
      stats: `${bookId}:graph_extract:stats`,
      reports: `${bookId}:community_report:reports`,
      lancedb: `${bookId}:embed:lancedb`,
    };
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    for (const name of [
      "documents.parquet", "text_units.parquet", "entities.parquet",
      "relationships.parquet", "communities.parquet", "community_reports.parquet",
    ]) {
      await writeMinimalParquetFixture(join(outputDir, name));
    }
    await writeFile(join(outputDir, "context.json"), "{}", "utf8");
    await writeFile(join(outputDir, "stats.json"), "{}", "utf8");
    await writeCompleteLanceDbFixture(join(outputDir, "lancedb"));
    const graphArtifacts = await graphArtifactManifests({
      outputDir,
      outputRel,
      bookId,
      artifactIds,
      stageFingerprints,
      providerFingerprint,
      corpusContentHash: contentHash,
    }).then((items) => items.map((artifact) =>
      artifact.artifactId === artifactIds.reports
        ? { ...artifact, producerRunId: "wrong-community-report-run" }
        : artifact
    ));
    await writeFile(
      join(outputDir, "qmd_output_manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        bookId,
        sourceHash,
        documentId,
        contentHash,
        stageFingerprints,
        providerFingerprint,
        outputDir: outputDir,
        producerRunId: "run-query-ready",
        stageProducerRunIds: {
          graph_extract: "run-graph-extract",
          community_report: "run-community-report",
          embed: "run-embed",
        },
      }),
    );
    await mkdir(join(stateRoot, "books", bookId), { recursive: true });
    await mkdir(join(stateRoot, "catalog"), { recursive: true });
    await writeFile(
      join(stateRoot, "catalog", "books.yaml"),
      YAML.stringify({
        schemaVersion: SchemaVersion,
        items: [{
          schemaVersion: SchemaVersion,
          bookId,
          documentId,
          sourcePath: `sources/${bookId}/source.epub`,
          sourceHash,
          metadata: { sourceIdentityPath: sourceRelativePath },
          normalizedContentHash: contentHash,
          normalizedPath: `books/${bookId}/input/book.md`,
          configFingerprint: "config-fp",
          promptFingerprint: "prompt-fp",
          modelFingerprint: "model-fp",
          stageFingerprints,
          providerFingerprint,
          overallStatus: "succeeded",
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:01.000Z",
        }],
      }),
    );
    await writeFile(
      join(stateRoot, "books", bookId, "artifacts.yaml"),
      YAML.stringify({ schemaVersion: SchemaVersion, items: graphArtifacts }),
    );
    await writeFile(
      join(stateRoot, "books", bookId, "checkpoints.yaml"),
      YAML.stringify({
        schemaVersion: SchemaVersion,
        items: [
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "graph_extract",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-graph-extract",
            inputFingerprint: "fp-graph-extract",
            contentHash,
            stageFingerprint: "fp-graph-extract",
            providerFingerprint,
            artifactIds: [
              artifactIds.documents, artifactIds.textUnits, artifactIds.entities,
              artifactIds.relationships, artifactIds.communities,
              artifactIds.context, artifactIds.stats,
            ],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "community_report",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-community-report",
            inputFingerprint: "fp-community-report",
            contentHash,
            stageFingerprint: "fp-community-report",
            providerFingerprint,
            artifactIds: [artifactIds.reports],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "embed",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-embed",
            inputFingerprint: "fp-embed",
            contentHash,
            stageFingerprint: "fp-embed",
            providerFingerprint,
            artifactIds: [artifactIds.lancedb],
          },
          {
            schemaVersion: SchemaVersion,
            bookId,
            stage: "query_ready",
            status: "succeeded",
            attemptCount: 1,
            runId: "run-query-ready",
            inputFingerprint: "fp-query-ready",
            contentHash,
            stageFingerprint: "fp-query-ready",
            providerFingerprint,
            artifactIds: [artifactIds.reports, artifactIds.lancedb],
          },
        ],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "completed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId,
        attempts: 1,
        qmdBuildStatus: { status: "succeeded" },
        commandChecks: passedBatchCommandChecks(),
      }),
    );

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--status-json",
        ]);
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
        proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
        proc.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode }));
      },
    );

    const checkpoint = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      "utf8",
    ));
    const eventLogPath = join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl");
    const eventsExist = existsSync(eventLogPath);
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.recoveryDecision).toBe("continue_pending");
    expect(summary.items[0]).toMatchObject({
      status: "pending",
      qmdBuildStatus: { status: "succeeded" },
      graphBuildStatus: {
        status: "stale",
        stage: "community_report",
      },
    });
    expect(summary.items[0].graphBuildStatus.reason).toMatch(
      /stage_artifact_producer_run_mismatch:community_report/u,
    );
    expect(checkpoint.status).toBe("completed");
    expect(eventsExist).toBe(false);
  });

  test("keeps checkpoints unique for duplicate EPUB content", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-duplicate-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "duplicate-fixture";
    const sourceBytes = "same content";
    const { createHash } = await import("crypto");
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(sourceDir, "A.epub"), sourceBytes);
    await writeFile(join(sourceDir, "B.epub"), sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const completedManifest = join(tmpRoot, "completed.json");
    await writeFile(
      completedManifest,
      JSON.stringify([
        { source: "A.epub", sourceHash },
        { source: "B.epub", sourceHash },
      ]),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--completed-manifest",
          completedManifest,
          "--run-id",
          runId,
          "--skip-dotenv",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const batchRoot = join(stateRoot, "catalog", "batch-runs", runId);
    const itemRoot = join(batchRoot, "items");
    const manifest = JSON.parse(readFileSync(join(batchRoot, "manifest.json"), "utf8"));
    const checkpoints = readdirSync(itemRoot).sort();
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(manifest).toMatchObject({
      status: "failed",
      totalItems: 2,
      pendingItems: 0,
      runningItems: 0,
      completedItems: 0,
      skippedItems: 0,
      importedCompletedItems: 2,
      failedItems: 2,
      expectedCommandCheckCount: 27,
    });
    expect(checkpoints).toHaveLength(2);
    expect(new Set(checkpoints).size).toBe(2);
  });

  test("reconciles an existing manifest when source EPUBs grow", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-grow-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "grow-fixture";
    const { createHash } = await import("crypto");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId), { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(sourceDir, "A.epub"), "book-a");
    await writeFile(join(sourceDir, "B.epub"), "book-b");
    const hashA = createHash("sha256").update("book-a").digest("hex");
    const hashB = createHash("sha256").update("book-b").digest("hex");
    const completedManifest = join(tmpRoot, "completed.json");
    await writeFile(
      completedManifest,
      JSON.stringify([
        { source: "A.epub", sourceHash: hashA },
        { source: "B.epub", sourceHash: hashB },
      ]),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "completed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/old/graph_vault",
        qmdIndexLocator: ".tmp-tests/old/index.sqlite",
        configLocator: ".tmp-tests/old/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 1,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 0,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        completedAt: "2026-05-23T00:01:00.000Z",
        itemIds: ["stale-item"],
      }),
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--completed-manifest",
          completedManifest,
          "--run-id",
          runId,
          "--skip-dotenv",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const manifest = JSON.parse(readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      "utf8",
    ));
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(manifest).toMatchObject({
      status: "failed",
      totalItems: 2,
      pendingItems: 0,
      completedItems: 0,
      skippedItems: 0,
      importedCompletedItems: 2,
      failedItems: 2,
    });
    expect(manifest.itemIds).toHaveLength(2);
    expect(manifest.itemIds).not.toContain("stale-item");
  });

  test("redacts exact environment values from preflight errors", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "qmd-batch-redact-"));
    const sourceDir = join(tmpRoot, "empty-source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const secretBase = join(tmpRoot, "secret-config-path");
    await mkdir(sourceDir, { recursive: true });
    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          join(tmpRoot, "logs"),
          "--config",
          secretBase,
          "--skip-dotenv",
        ], {
          env: {
            ...process.env,
            OPENAI_BASE_URL: secretBase,
          },
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain(secretBase);
    expect(result.stderr).toContain("[REDACTED:OPENAI_BASE_URL]");
  });

  test("redacts URL credentials from batch logs and recovery summaries", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-batch-url-redact-");
    const sourceDir = join(tmpRoot, "source");
    const stateRoot = join(tmpRoot, "graph_vault");
    const logRoot = join(tmpRoot, "logs");
    const configDir = join(tmpRoot, "config");
    const runId = "url-redact-fixture";
    const sourceBytes = "url secret redaction";
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(stateRoot, "catalog", "batch-runs", runId, "items"), {
      recursive: true,
    });
    const sourcePath = join(sourceDir, "Book.epub");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    const sourceRelativePath = relative(projectRoot, sourcePath);
    const itemId = `item-${sourceHash.slice(0, 12)}-${
      createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 8)
    }`;
    const leakedUrl =
      "https://gateway.example/responses?api_key=url-secret&token=tok-secret&safe=ok";
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "manifest.json"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        status: "failed",
        sourceRootName: "source",
        stateRootLocator: ".tmp-tests/unused/graph_vault",
        qmdIndexLocator: ".tmp-tests/unused/index.sqlite",
        configLocator: ".tmp-tests/unused/config/index.yml",
        totalItems: 1,
        pendingItems: 0,
        runningItems: 0,
        completedItems: 0,
        skippedItems: 0,
        importedCompletedItems: 0,
        failedItems: 1,
        startedAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
        itemIds: [itemId],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "items", `${itemId}.json`),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        itemId,
        runId,
        status: "failed",
        sourceName: "Book.epub",
        sourceRelativePath,
        sourceIdentityPath: sourceRelativePath,
        sourceHash,
        normalizedPath: join(".tmp-tests", "graph_vault", "input", "book.md"),
        bookId: batchBookId(sourceHash, sourceRelativePath),
        attempts: 1,
        failedAt: "2026-05-23T00:01:00.000Z",
        failureKind: "permanent",
        retryable: false,
        retryExhausted: true,
        recoveryDecision: "stop_until_fixed",
        failedStage: "qmd-query-graphrag-json",
        errorSummary: `provider leaked ${leakedUrl}`,
        commandChecks: [{
          name: "qmd-query-graphrag-json",
          status: "failed",
          attempts: 1,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 12,
          startedAt: "2026-05-23T00:00:00.000Z",
          completedAt: "2026-05-23T00:01:00.000Z",
          failureKind: "permanent",
          retryable: false,
          errorSummary: `stderr ${leakedUrl}`,
        }],
      }),
    );
    await writeFile(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      JSON.stringify({
        schemaVersion: SchemaVersion,
        runId,
        itemId,
        event: "command_failed",
        command: "qmd-query-graphrag-json",
        at: "2026-05-23T00:01:00.000Z",
        message: `event ${leakedUrl}`,
        metadata: { requestUrl: leakedUrl },
      }) + "\n",
    );

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult) => {
        const proc = spawn(process.execPath, [
          join(projectRoot, "scripts", "graphrag", "batch-epub-workflow.mjs"),
          "--source-dir",
          sourceDir,
          "--state-root",
          stateRoot,
          "--log-root",
          logRoot,
          "--config",
          join(configDir, "index.yml"),
          "--qmd-index-path",
          join(tmpRoot, "index.sqlite"),
          "--run-id",
          runId,
          "--skip-dotenv",
          "--migrate-only",
        ]);
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        proc.on("close", (exitCode) => resolveResult({ stderr, exitCode }));
      },
    );

    const eventRaw = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "events.jsonl"),
      "utf8",
    );
    const summaryRaw = readFileSync(
      join(stateRoot, "catalog", "batch-runs", runId, "recovery-summary.json"),
      "utf8",
    );
    await rm(tmpRoot, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const raw of [eventRaw, summaryRaw]) {
      expect(raw).not.toContain("url-secret");
      expect(raw).not.toContain("tok-secret");
      expect(raw).toContain("api_key=[REDACTED]");
      expect(raw).toContain("token=[REDACTED]");
      expect(raw).toContain("safe=ok");
    }
  });

  test("sanitizes vault text secrets, urls, and absolute paths", () => {
    const previous = process.env.QMD_TEST_BASE_URL;
    process.env.QMD_TEST_BASE_URL = "https://secret-gateway.example/responses";
    try {
      const input = [
        "bearer sk-test-secret",
        "https://secret-gateway.example/responses",
        "https://public-gateway.example/responses",
        "/Users/jin/projects/qmd_graphrag/.env",
        "C:\\Users\\jin\\secret.env",
      ].join(" ");
      const sanitized = sanitizeVaultText(input) ?? "";
      expect(sanitized).toContain("[redacted-secret]");
      expect(sanitized).toContain("[redacted-url]");
      expect(sanitized).toContain("[redacted-path]");
      expect(sanitized).not.toContain("secret-gateway");
      expect(sanitized).not.toContain("/Users/jin");
      expect(sanitized).not.toContain("C:\\Users");
      expect(sanitized).not.toContain("sk-test-secret");
    } finally {
      if (previous == null) {
        delete process.env.QMD_TEST_BASE_URL;
      } else {
        process.env.QMD_TEST_BASE_URL = previous;
      }
    }
  });
});

describe("CLI Unified Query Route", () => {
  let localDbPath: string;
  let localConfigDir: string;

  beforeAll(async () => {
    const env = await createIsolatedTestEnv("unified-query");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;
    const addResult = await runQmd(
      ["collection", "add", ".", "--name", "fixtures"],
      { dbPath: localDbPath, configDir: localConfigDir },
    );
    if (addResult.exitCode !== 0) {
      throw new Error(`Failed to add collection: ${addResult.stderr}`);
    }
  });

  test("qmd query --mode auto --json emits UnifiedAnswer", async () => {
    const { stdout, stderr, exitCode } = await runQmd(
      [
        "query",
        "--mode",
        "auto",
        "--json",
        "--no-rerank",
        "lex: Full-text search with BM25",
      ],
      { dbPath: localDbPath, configDir: localConfigDir },
    );
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("Expanding query");

    const answer = JSON.parse(stdout);
    expect(answer.schemaVersion).toBe("1.0.0");
    expect(answer.routeDecision.requestedRoute).toBe("auto");
    expect(answer.routeDecision.selectedRoute).toBe("qmd");
    expect(Array.isArray(answer.evidence)).toBe(true);
  }, 20000);

  test("qmd query --mode auto non-json output exposes route decision", async () => {
    const { stdout, exitCode } = await runQmd(
      [
        "query",
        "--mode",
        "auto",
        "--no-rerank",
        "lex: Full-text search with BM25",
      ],
      { dbPath: localDbPath, configDir: localConfigDir },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("QueryRouteDecision:");
    expect(stdout).toContain("selectedRoute: qmd");
    expect(stdout).toContain("reasonCode: qmd_retrieval");
    expect(stdout).toContain("refusalReasons:");
    expect(stdout).toContain("qmd://fixtures/");
  }, 20000);

  test("qmd query --json emits UnifiedAnswer on the default qmd route", async () => {
    const query = "lex: Full-text search with BM25";
    const { stdout, exitCode } = await runQmd(
      [
        "query",
        "--json",
        "--no-rerank",
        query,
      ],
      { dbPath: localDbPath, configDir: localConfigDir },
    );
    expect(exitCode).toBe(0);

    const answer = JSON.parse(stdout);
    expect(answer.schemaVersion).toBe("1.0.0");
    expect(answer.query).toBe(query);
    expect(answer.routeDecision.requestedRoute).toBe("qmd");
    expect(answer.routeDecision.selectedRoute).toBe("qmd");
    expect(Array.isArray(answer.evidence)).toBe(true);
  }, 20000);

  test("qmd query rejects graph-only default route in project config", async () => {
    const env = await createIsolatedTestEnv("graph-default-route");
    await writeFile(
      join(env.configDir, "index.yml"),
      "collections: {}\nquery:\n  default_route: graphrag\n",
    );
    const { stderr, exitCode } = await runQmd(
      [
        "query",
        "--json",
        "--no-rerank",
        "lex: Full-text search with BM25",
      ],
      { dbPath: env.dbPath, configDir: env.configDir },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("query.default_route must be qmd or auto");
    expect(stderr).toContain("--graphrag");
  }, 20000);

  test("qmd query --mode auto preserves auto decision when graph upgrade is disabled", async () => {
    const env = await createIsolatedTestEnv("auto-upgrade-disabled");
    await writeFile(
      join(env.configDir, "index.yml"),
      "collections: {}\nquery:\n  allow_graph_upgrade: false\n",
    );
    const addResult = await runQmd(
      ["collection", "add", ".", "--name", "fixtures"],
      { dbPath: env.dbPath, configDir: env.configDir },
    );
    expect(addResult.exitCode).toBe(0);

    const { stdout, exitCode } = await runQmd(
      [
        "query",
        "--mode",
        "auto",
        "--json",
        "--no-rerank",
        "lex: Full-text search with BM25",
      ],
      { dbPath: env.dbPath, configDir: env.configDir },
    );
    expect(exitCode).toBe(0);

    const answer = JSON.parse(stdout);
    expect(answer.routeDecision.requestedRoute).toBe("auto");
    expect(answer.routeDecision.selectedRoute).toBe("qmd");
    expect(answer.routeDecision.refusalReasons).toContain(
      "graph_upgrade_disabled",
    );
  }, 20000);

  test("qmd query non-json output is projected from UnifiedAnswer evidence", async () => {
    const { stdout, exitCode } = await runQmd(
      [
        "query",
        "--no-rerank",
        "lex: Full-text search with BM25",
      ],
      { dbPath: localDbPath, configDir: localConfigDir },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd://fixtures/");
    expect(stdout).toContain("Full-text search");
    expect(stdout).toContain("Score:");
  }, 20000);

  test("qmd query --graphrag emits a single typed query error", async () => {
    await mkdir(join(fixturesDir, "graph_vault"), { recursive: true });
    const { stderr, exitCode } = await runQmd(
      [
        "query",
        "--graphrag",
        "--json",
        "--no-rerank",
        "lex: Full-text search with BM25",
      ],
      { dbPath: localDbPath, configDir: localConfigDir },
    );

    expect(exitCode).toBe(1);
    const error = JSON.parse(stderr);
    expect(error.schemaVersion).toBe(SchemaVersion);
    expect(error.route).toBe("graphrag");
    expect(error.stage).toBe("graph_capability");
    expect(error.capability).toBe("graph_query");
    expect(error.code).toBe("capability_missing");
    expect(error.redactedMessage).toContain("No graph_query capability");
    expect(error.graphCapabilityError).toMatchObject({
      route: "graphrag",
      capability: "graph_query",
      code: "capability_missing",
      queriedScope: "graph_enhanced_subset",
    });
  }, 20000);
});

describe("CLI Get Command", () => {
  beforeEach(async () => {
    // Ensure we have indexed files
    await runQmd(["collection", "add", "."]);
  });

  test("retrieves document content by path", async () => {
    const { stdout, exitCode } = await runQmd(["get", "README.md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Project");
  });

  test("retrieves document from subdirectory", async () => {
    const { stdout, exitCode } = await runQmd(["get", "notes/meeting.md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Team Meeting");
  });

  test("handles non-existent file", async () => {
    const { stdout, exitCode } = await runQmd(["get", "nonexistent.md"]);
    // Should indicate file not found
    expect(exitCode).toBe(1);
  });

  test("clamps negative --from to top of file (no silent tail content)", async () => {
    const baseline = await runQmd(["get", "README.md"]);
    const negative = await runQmd(["get", "README.md", "--from", "-19"]);
    expect(negative.exitCode).toBe(0);
    expect(negative.stdout).toBe(baseline.stdout);
  });
});

describe("CLI Multi-Get Command", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use fresh database for each test
    localDbPath = getFreshDbPath();
    // Ensure we have indexed files
    const addResult = await runQmd(["collection", "add", ".", "--name", "fixtures"], { dbPath: localDbPath });
    if (addResult.exitCode !== 0) {
      throw new Error(`Failed to add collection: ${addResult.stderr}`);
    }
  });

  test("retrieves multiple documents by pattern", async () => {
    // Test glob pattern matching
    const { stdout, stderr, exitCode } = await runQmd(["multi-get", "notes/*.md"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    // Should contain content from both notes files
    expect(stdout).toContain("Meeting");
    expect(stdout).toContain("Ideas");
  });

  test("retrieves documents by comma-separated paths", async () => {
    const { stdout, exitCode } = await runQmd([
      "multi-get",
      "README.md,notes/meeting.md",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Project");
    expect(stdout).toContain("Team Meeting");
  });
});

describe("CLI Update Command", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = getFreshDbPath();
    // Ensure we have indexed files
    await runQmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("updates all collections", async () => {
    const { stdout, exitCode } = await runQmd(["update"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Updating");
  });

  test("deactivates stale docs when collection has zero matching files", async () => {
    const { dbPath, configDir } = await createIsolatedTestEnv("update-empty");
    const collectionDir = join(testDir, `update-empty-${Date.now()}`);
    await mkdir(collectionDir, { recursive: true });

    const docPath = join(collectionDir, "only.md");
    const token = `stale-proof-${Date.now()}`;
    await writeFile(
      docPath,
      `---
date: 2026-03-06
---
# Empty Collection Deactivation
${token}
`
    );

    const add = await runQmd(
      ["collection", "add", collectionDir, "--name", "empty-check"],
      { dbPath, configDir }
    );
    expect(add.exitCode).toBe(0);

    const before = await runQmd(["get", "qmd://empty-check/only.md"], { dbPath, configDir });
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain(token);

    unlinkSync(docPath);

    const update = await runQmd(["update"], { dbPath, configDir });
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("0 new, 0 updated, 0 unchanged, 1 removed");

    const after = await runQmd(["get", "qmd://empty-check/only.md"], { dbPath, configDir });
    expect(after.exitCode).toBe(1);
  });
});

describe("CLI Add-Context Command", () => {
  let localDbPath: string;
  let localConfigDir: string;
  const collName = "fixtures";

  beforeAll(async () => {
    const env = await createIsolatedTestEnv("context-cmd");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    // Add collection with known name
    const { exitCode, stderr } = await runQmd(
      ["collection", "add", fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);
  });

  test("adds context to a path", async () => {
    // Add context to the collection root using virtual path
    const { stdout, exitCode } = await runQmd([
      "context",
      "add",
      `qmd://${collName}/`,
      "Personal notes and meeting logs",
    ], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Added context");
  });

  test("requires path and text arguments", async () => {
    const { stderr, exitCode } = await runQmd(["context", "add"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(1);
    // Error message goes to stderr
    expect(stderr).toContain("Usage:");
  });
});

describe("CLI Cleanup Command", () => {
  beforeEach(async () => {
    // Ensure we have indexed files
    await runQmd(["collection", "add", "."]);
  });

  test("cleans up orphaned entries", async () => {
    const { stdout, exitCode } = await runQmd(["cleanup"]);
    expect(exitCode).toBe(0);
  });
});

describe("CLI Error Handling", () => {
  test("handles unknown command", async () => {
    const { stderr, exitCode } = await runQmd(["unknowncommand"]);
    expect(exitCode).toBe(1);
    // Should indicate unknown command and point users to diagnostics
    expect(stderr).toContain("Unknown command");
    expect(stderr).toContain("qmd doctor");
  });

  test("uses INDEX_PATH environment variable", async () => {
    // Verify the test DB path is being used by creating a separate index
    const customDbPath = join(testDir, "custom.sqlite");
    const { exitCode } = await runQmd(["collection", "add", "."], {
      env: { INDEX_PATH: customDbPath },
    });
    expect(exitCode).toBe(0);

    // The custom database should exist
    expect(existsSync(customDbPath)).toBe(true);
  });
});

describe("CLI Output Formats", () => {
  beforeEach(async () => {
    await runQmd(["collection", "add", "."]);
  });

  test("search with --json flag outputs JSON", async () => {
    const { stdout, exitCode } = await runQmd(["search", "--json", "test"]);
    expect(exitCode).toBe(0);
    // Should be valid JSON
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("search with --files flag outputs file paths", async () => {
    const { stdout, exitCode } = await runQmd(["search", "--files", "meeting"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(".md");
  });

  test("search output includes snippets by default", async () => {
    const { stdout, exitCode } = await runQmd(["search", "API"]);
    expect(exitCode).toBe(0);
    // If results found, should have snippet content
    if (!stdout.includes("No results")) {
      expect(stdout.toLowerCase()).toContain("api");
    }
  });
});

describe("CLI Search with Collection Filter", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = getFreshDbPath();
    // Create multiple collections with explicit names
    await runQmd(["collection", "add", ".", "--name", "notes", "--mask", "notes/*.md"], { dbPath: localDbPath });
    await runQmd(["collection", "add", ".", "--name", "docs", "--mask", "docs/*.md"], { dbPath: localDbPath });
  });

  test("filters search by collection name", async () => {
    const { stdout, stderr, exitCode } = await runQmd([
      "search",
      "-c",
      "notes",
      "meeting",
    ], { dbPath: localDbPath });
    if (exitCode !== 0) {
      console.log("Collection filter search failed:");
      console.log("stdout:", stdout);
      console.log("stderr:", stderr);
    }
    expect(exitCode).toBe(0);
  });
});

describe("CLI Context Management", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = getFreshDbPath();
    // Index some files first
    await runQmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("add global context with /", async () => {
    const { stdout, exitCode } = await runQmd([
      "context",
      "add",
      "/",
      "Global system context",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Set global context");
    expect(stdout).toContain("Global system context");
  });

  test("list contexts", async () => {
    // Add a global context first
    await runQmd([
      "context",
      "add",
      "/",
      "Test context",
    ], { dbPath: localDbPath });

    const { stdout, exitCode } = await runQmd([
      "context",
      "list",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Configured Contexts");
    expect(stdout).toContain("Test context");
  });

  test("add context to virtual path", async () => {
    // Collection name should be "fixtures" (basename of the fixtures directory)
    const { stdout, exitCode } = await runQmd([
      "context",
      "add",
      "qmd://fixtures/notes",
      "Context for notes subdirectory",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Added context for: qmd://fixtures/notes");
  });

  test("remove global context", async () => {
    // Add a global context first
    await runQmd([
      "context",
      "add",
      "/",
      "Global context to remove",
    ], { dbPath: localDbPath });

    const { stdout, exitCode } = await runQmd([
      "context",
      "rm",
      "/",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Removed");
  });

  test("remove virtual path context", async () => {
    // Add a context first
    await runQmd([
      "context",
      "add",
      "qmd://fixtures/notes",
      "Context to remove",
    ], { dbPath: localDbPath });

    const { stdout, exitCode } = await runQmd([
      "context",
      "rm",
      "qmd://fixtures/notes",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Removed context for: qmd://fixtures/notes");
  });

  test("fails to remove non-existent context", async () => {
    const { stdout, stderr, exitCode } = await runQmd([
      "context",
      "rm",
      "qmd://nonexistent/path",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr || stdout).toContain("not found");
  });
});

describe("CLI ls Command", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = getFreshDbPath();
    // Index some files first
    await runQmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("lists all collections", async () => {
    const { stdout, exitCode } = await runQmd(["ls"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collections:");
    expect(stdout).toContain("qmd://fixtures/");
  });

  test("lists files in a collection", async () => {
    const { stdout, exitCode } = await runQmd(["ls", "fixtures"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    // handelize preserves original case
    expect(stdout).toContain("qmd://fixtures/README.md");
    expect(stdout).toContain("qmd://fixtures/notes/meeting.md");
  });

  test("lists files with path prefix", async () => {
    const { stdout, exitCode } = await runQmd(["ls", "fixtures/notes"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd://fixtures/notes/meeting.md");
    expect(stdout).toContain("qmd://fixtures/notes/ideas.md");
    // Should not include files outside the prefix (case preserved)
    expect(stdout).not.toContain("qmd://fixtures/README.md");
  });

  test("lists files with virtual path", async () => {
    const { stdout, exitCode } = await runQmd(["ls", "qmd://fixtures/docs"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd://fixtures/docs/api.md");
  });

  test("continues to normalize extra slashes for normal collection virtual paths", async () => {
    const { stdout, stderr, exitCode } = await runQmd(["ls", "qmd:///fixtures/docs"], { dbPath: localDbPath });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd://fixtures/docs/api.md");
  });

  test("lists an absolute-path collection from a qmd:/// virtual path", async () => {
    const env = await createIsolatedTestEnv("absolute-qmd-path");
    const absoluteDir = await mkdtemp(join(tmpdir(), "qmd-absolute-collection-"));
    await writeFile(join(absoluteDir, "root.md"), "# Absolute collection\n");
    await writeFile(
      join(env.configDir, "index.yml"),
      `collections:\n  "${absoluteDir}":\n    path: "${absoluteDir}"\n    pattern: "**/*.md"\n`
    );

    const update = await runQmd(["update"], {
      cwd: absoluteDir,
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(update.exitCode).toBe(0);

    const { stdout, stderr, exitCode } = await runQmd(["ls", `qmd://${absoluteDir}/`], {
      cwd: absoluteDir,
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`qmd://${absoluteDir}/root.md`);
  });

  test("lists an absolute-path collection from a raw path using the longest prefix match", async () => {
    const env = await createIsolatedTestEnv("absolute-raw-path");
    const parentCollectionName = await mkdtemp(join(tmpdir(), "qmd-absolute-parent-name-"));
    const childCollectionName = join(parentCollectionName, "nested");
    const parentDataDir = await mkdtemp(join(tmpdir(), "qmd-absolute-parent-data-"));
    const childDataDir = await mkdtemp(join(tmpdir(), "qmd-absolute-child-data-"));
    await writeFile(join(parentDataDir, "parent.md"), "# Parent collection\n");
    await writeFile(join(childDataDir, "child.md"), "# Child collection\n");
    await writeFile(
      join(env.configDir, "index.yml"),
      `collections:\n  "${parentCollectionName}":\n    path: "${parentDataDir}"\n    pattern: "**/*.md"\n  "${childCollectionName}":\n    path: "${childDataDir}"\n    pattern: "**/*.md"\n`
    );

    const update = await runQmd(["update"], {
      cwd: parentDataDir,
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(update.exitCode).toBe(0);

    const { stdout, stderr, exitCode } = await runQmd(["ls", `${childCollectionName}/`], {
      cwd: childDataDir,
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`qmd://${childCollectionName}/child.md`);
    expect(stdout).not.toContain("No files found");
    expect(stdout).not.toContain(`qmd://${parentCollectionName}/parent.md`);
  });

  test("handles non-existent collection", async () => {
    const { stderr, exitCode } = await runQmd(["ls", "nonexistent"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found");
  });
});

describe("CLI Collection Commands", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = getFreshDbPath();
    // Index some files first to create a collection
    await runQmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("lists collections", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collections");
    expect(stdout).toContain("fixtures");
    expect(stdout).toContain("qmd://fixtures/");
    expect(stdout).toContain("Pattern:");
    expect(stdout).toContain("Files:");
  });

  test("removes a collection", async () => {
    // First verify the collection exists
    const { stdout: listBefore } = await runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(listBefore).toContain("fixtures");

    // Remove it
    const { stdout, exitCode } = await runQmd(["collection", "remove", "fixtures"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Removed collection 'fixtures'");
    expect(stdout).toContain("Deleted");

    // Verify it's gone
    const { stdout: listAfter } = await runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(listAfter).not.toContain("fixtures");
  });

  test("handles removing non-existent collection", async () => {
    const { stderr, exitCode } = await runQmd(["collection", "remove", "nonexistent"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found");
  });

  test("handles missing remove argument", async () => {
    const { stderr, exitCode } = await runQmd(["collection", "remove"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });

  test("handles unknown subcommand", async () => {
    const { stderr, exitCode } = await runQmd(["collection", "invalid"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown subcommand");
  });

  test("renames a collection", async () => {
    // First verify the collection exists
    const { stdout: listBefore } = await runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(listBefore).toContain("qmd://fixtures/");

    // Rename it
    const { stdout, exitCode } = await runQmd(["collection", "rename", "fixtures", "my-fixtures"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Renamed collection 'fixtures' to 'my-fixtures'");
    expect(stdout).toContain("qmd://fixtures/");
    expect(stdout).toContain("qmd://my-fixtures/");

    // Verify the new name exists and old name is gone
    const { stdout: listAfter } = await runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(listAfter).toContain("qmd://my-fixtures/");
    expect(listAfter).not.toContain("qmd://fixtures/"); // Old collection should not appear
  });

  test("handles renaming non-existent collection", async () => {
    const { stderr, exitCode } = await runQmd(["collection", "rename", "nonexistent", "newname"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found");
  });

  test("handles renaming to existing collection name", async () => {
    // Create a second collection in a temp directory
    const tempDir = await mkdtemp(join(tmpdir(), "qmd-second-"));
    await writeFile(join(tempDir, "test.md"), "# Test");
    const addResult = await runQmd(["collection", "add", tempDir, "--name", "second"], { dbPath: localDbPath });

    if (addResult.exitCode !== 0) {
      console.error("Failed to add second collection:", addResult.stderr);
    }
    expect(addResult.exitCode).toBe(0);

    // Verify both collections exist
    const { stdout: listBoth } = await runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(listBoth).toContain("qmd://fixtures/");
    expect(listBoth).toContain("qmd://second/");

    // Try to rename fixtures to second (which already exists)
    const { stderr, exitCode } = await runQmd(["collection", "rename", "fixtures", "second"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection name already exists");
  });

  test("handles missing rename arguments", async () => {
    const { stderr: stderr1, exitCode: exitCode1 } = await runQmd(["collection", "rename"], { dbPath: localDbPath });
    expect(exitCode1).toBe(1);
    expect(stderr1).toContain("Usage:");

    const { stderr: stderr2, exitCode: exitCode2 } = await runQmd(["collection", "rename", "fixtures"], { dbPath: localDbPath });
    expect(exitCode2).toBe(1);
    expect(stderr2).toContain("Usage:");
  });
});

// =============================================================================
// Collection Ignore Patterns
// =============================================================================

describe("collection ignore patterns", () => {
  let localDbPath: string;
  let localConfigDir: string;
  let ignoreTestDir: string;

  beforeAll(async () => {
    const env = await createIsolatedTestEnv("ignore-patterns");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    // Create directory structure with subdirectories to ignore
    ignoreTestDir = join(testDir, "ignore-fixtures");
    await mkdir(join(ignoreTestDir, "notes"), { recursive: true });
    await mkdir(join(ignoreTestDir, "sessions"), { recursive: true });
    await mkdir(join(ignoreTestDir, "sessions", "2026-03"), { recursive: true });
    await mkdir(join(ignoreTestDir, "archive"), { recursive: true });

    // Files that should be indexed
    await writeFile(join(ignoreTestDir, "readme.md"), "# Main readme\nThis should be indexed.");
    await writeFile(join(ignoreTestDir, "notes", "note1.md"), "# Note 1\nThis is a personal note.");

    // Files that should be ignored
    await writeFile(join(ignoreTestDir, "sessions", "session1.md"), "# Session 1\nThis session should be ignored.");
    await writeFile(join(ignoreTestDir, "sessions", "2026-03", "session2.md"), "# Session 2\nNested session should also be ignored.");
    await writeFile(join(ignoreTestDir, "archive", "old.md"), "# Old stuff\nThis archive file should be ignored.");
  });

  test("ignore patterns exclude matching files from indexing", async () => {
    // Write YAML config with ignore patterns
    await writeFile(
      join(localConfigDir, "index.yml"),
      `collections:
  ignoretst:
    path: ${ignoreTestDir}
    pattern: "**/*.md"
    ignore:
      - "sessions/**"
      - "archive/**"
`
    );

    const { stdout, exitCode } = await runQmd(["update"], {
      cwd: ignoreTestDir,
      dbPath: localDbPath,
      configDir: localConfigDir,
    });
    expect(exitCode).toBe(0);
    // Should index 2 files (readme.md + notes/note1.md), not 5
    expect(stdout).toContain("2 new");
  });

  test("ignored files are not searchable", async () => {
    const { stdout, exitCode } = await runQmd(["search", "session", "-n", "10"], {
      cwd: ignoreTestDir,
      dbPath: localDbPath,
      configDir: localConfigDir,
    });
    // Should find no results since sessions/ was ignored
    if (exitCode === 0) {
      expect(stdout).not.toContain("session1");
      expect(stdout).not.toContain("session2");
    }
  });

  test("non-ignored files are searchable", async () => {
    const { stdout, exitCode } = await runQmd(["search", "personal note", "-n", "10"], {
      cwd: ignoreTestDir,
      dbPath: localDbPath,
      configDir: localConfigDir,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("note1");
  });

  test("status shows ignore patterns", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "list"], {
      cwd: ignoreTestDir,
      dbPath: localDbPath,
      configDir: localConfigDir,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Ignore:");
    expect(stdout).toContain("sessions/**");
    expect(stdout).toContain("archive/**");
  });

  test("collection without ignore indexes all files", async () => {
    // Create a second collection without ignore
    const env2 = await createIsolatedTestEnv("no-ignore");
    await writeFile(
      join(env2.configDir, "index.yml"),
      `collections:
  allfiles:
    path: ${ignoreTestDir}
    pattern: "**/*.md"
`
    );

    const { stdout, exitCode } = await runQmd(["update"], {
      cwd: ignoreTestDir,
      dbPath: env2.dbPath,
      configDir: env2.configDir,
    });
    expect(exitCode).toBe(0);
    // Should index all 5 files
    expect(stdout).toContain("5 new");
  });
});

// =============================================================================
// Output Format Tests - qmd:// URIs, context, and docid
// =============================================================================

describe("search output formats", () => {
  let localDbPath: string;
  let localConfigDir: string;
  const collName = "fixtures";

  beforeAll(async () => {
    const env = await createIsolatedTestEnv("output-format");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    // Add collection
    const { exitCode, stderr } = await runQmd(
      ["collection", "add", fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);

    // Add context
    await runQmd(["context", "add", `qmd://${collName}/`, "Test fixtures for QMD"], { dbPath: localDbPath, configDir: localConfigDir });
  });

  test("search --json includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await runQmd(["search", "test", "--json", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    const results = JSON.parse(stdout);
    expect(results.length).toBeGreaterThan(0);

    const result = results[0];
    expect(result.file).toMatch(new RegExp(`^qmd://${collName}/`));
    expect(result.docid).toMatch(/^#[a-f0-9]{6}$/);
    expect(result.context).toBe("Test fixtures for QMD");
    // Ensure no full filesystem paths
    expect(result.file).not.toMatch(/^\/Users\//);
    expect(result.file).not.toMatch(/^\/home\//);
  });

  test("custom-index search links include ?index= and can be passed back to qmd get", async () => {
    const env = await createIsolatedTestEnv("custom-index-links");
    const customColl = "fixtures-alt";
    const customIndex = "release-notes";
    const customCacheDir = join(testDir, `cache-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(customCacheDir, { recursive: true });

    const sharedEnv = {
      INDEX_PATH: "",
      XDG_CACHE_HOME: customCacheDir,
    };

    const addResult = await runQmd(
      ["--index", customIndex, "collection", "add", fixturesDir, "--name", customColl],
      { dbPath: env.dbPath, configDir: env.configDir, env: sharedEnv }
    );
    expect(addResult.exitCode).toBe(0);

    const searchResult = await runQmd(
      ["--index", customIndex, "search", "test", "--json", "-n", "1"],
      { dbPath: env.dbPath, configDir: env.configDir, env: sharedEnv }
    );
    expect(searchResult.exitCode).toBe(0);

    const results = JSON.parse(searchResult.stdout);
    const file = results[0]?.file;
    expect(file).toMatch(new RegExp(`^qmd://${customColl}/.+\\?index=${customIndex}$`));

    const getResult = await runQmd(
      ["get", file, "-l", "2"],
      { dbPath: env.dbPath, configDir: env.configDir, env: sharedEnv }
    );
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout.trim().length).toBeGreaterThan(0);
  });

  test("search --files includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await runQmd(["search", "test", "--files", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // Format: #docid,score,qmd://collection/path,"context"
    expect(stdout).toMatch(new RegExp(`^#[a-f0-9]{6},[\\d.]+,qmd://${collName}/`, "m"));
    expect(stdout).toContain("Test fixtures for QMD");
    // Ensure no full filesystem paths
    expect(stdout).not.toMatch(/\/Users\//);
    expect(stdout).not.toMatch(/\/home\//);
  });

  test("search --csv includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await runQmd(["search", "test", "--csv", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // Header should include context
    expect(stdout).toMatch(/^docid,score,file,title,context,line,snippet$/m);
    // Data rows should have qmd:// paths and context
    expect(stdout).toMatch(new RegExp(`#[a-f0-9]{6},[\\d.]+,qmd://${collName}/`));
    expect(stdout).toContain("Test fixtures for QMD");
    // Ensure no full filesystem paths
    expect(stdout).not.toMatch(/\/Users\//);
    expect(stdout).not.toMatch(/\/home\//);
  });

  test("search --md includes docid and context", async () => {
    const { stdout, exitCode } = await runQmd(["search", "test", "--md", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    expect(stdout).toMatch(/\*\*docid:\*\* `#[a-f0-9]{6}`/);
    expect(stdout).toContain("**context:** Test fixtures for QMD");
  });

  test("search --xml includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await runQmd(["search", "test", "--xml", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    expect(stdout).toMatch(new RegExp(`<file docid="#[a-f0-9]{6}" name="qmd://${collName}/`));
    expect(stdout).toContain('context="Test fixtures for QMD"');
    // Ensure no full filesystem paths
    expect(stdout).not.toMatch(/\/Users\//);
    expect(stdout).not.toMatch(/\/home\//);
  });

  test("search default CLI format includes plain qmd:// path, docid, and context in non-TTY mode", async () => {
    const { stdout, exitCode } = await runQmd(["search", "test", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // runQmd uses piped stdio, so stdout is non-TTY and should not contain OSC 8 links.
    expect(stdout).toMatch(new RegExp(`^qmd://${collName}/.*#[a-f0-9]{6}`, "m"));
    expect(stdout).toContain("Context: Test fixtures for QMD");
    expect(stdout).not.toContain("\x1b]8;;");
    // Ensure no full filesystem paths
    expect(stdout).not.toMatch(/\/Users\//);
    expect(stdout).not.toMatch(/\/home\//);
  });
});

describe("editor URI templates", () => {
  test("buildEditorUri expands path, line, and col placeholders", () => {
    const uri = buildEditorUri(
      "vscode://file/{path}:{line}:{col}",
      "/tmp/my notes/readme.md",
      42,
      1,
    );

    expect(uri).toBe("vscode://file//tmp/my%20notes/readme.md:42:1");
  });

  test("buildEditorUri supports {column} alias", () => {
    const uri = buildEditorUri(
      "cursor://file/{path}:{line}:{column}",
      "/tmp/docs/api.md",
      7,
      3,
    );

    expect(uri).toBe("cursor://file//tmp/docs/api.md:7:3");
  });

  test("termLink returns plain text when stdout is not a TTY", () => {
    const linked = termLink("docs/api.md:12", "vscode://file//tmp/docs/api.md:12:1", false);

    expect(linked).toBe("docs/api.md:12");
  });

  test("termLink emits OSC 8 hyperlinks when stdout is a TTY", () => {
    const linked = termLink("docs/api.md:12", "vscode://file//tmp/docs/api.md:12:1", true);

    expect(linked).toBe("\x1b]8;;vscode://file//tmp/docs/api.md:12:1\x07docs/api.md:12\x1b]8;;\x07");
  });
});

// =============================================================================
// Get Command Path Normalization Tests
// =============================================================================

describe("get command path normalization", () => {
  let localDbPath: string;
  let localConfigDir: string;
  const collName = "fixtures";

  beforeAll(async () => {
    const env = await createIsolatedTestEnv("get-paths");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    const { exitCode, stderr } = await runQmd(
      ["collection", "add", fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);
  });

  test("get with qmd://collection/path format", async () => {
    const { stdout, exitCode } = await runQmd(["get", `qmd://${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with collection/path format (no scheme)", async () => {
    const { stdout, exitCode } = await runQmd(["get", `${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with //collection/path format", async () => {
    const { stdout, exitCode } = await runQmd(["get", `//${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with qmd:////collection/path format (extra slashes)", async () => {
    const { stdout, exitCode } = await runQmd(["get", `qmd:////${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with path:line format", async () => {
    const { stdout, exitCode } = await runQmd(["get", `${collName}/test1.md:3`, "-l", "2"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    // Should start from line 3, not line 1
    expect(stdout).not.toMatch(/^# Test Document 1$/m);
  });

  test("get with qmd://path:line format", async () => {
    const { stdout, exitCode } = await runQmd(["get", `qmd://${collName}/test1.md:3`, "-l", "2"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    // Should start from line 3, not line 1
    expect(stdout).not.toMatch(/^# Test Document 1$/m);
  });
});

// =============================================================================
// Status and Collection List - No Full Paths
// =============================================================================

describe("status and collection list hide filesystem paths", () => {
  let localDbPath: string;
  let localConfigDir: string;
  const collName = "fixtures";

  beforeAll(async () => {
    const env = await createIsolatedTestEnv("status-paths");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    const { exitCode, stderr } = await runQmd(
      ["collection", "add", fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);
  });

  test("status does not show full filesystem paths", async () => {
    const { stdout, exitCode } = await runQmd(["status"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // Should show qmd:// URIs
    expect(stdout).toContain(`qmd://${collName}/`);
    // Should NOT show full filesystem paths (except for the index location which is ok)
    const lines = stdout.split('\n').filter(l => !l.includes('Index:'));
    const pathLines = lines.filter(l => l.includes('/Users/') || l.includes('/home/') || l.includes('/tmp/'));
    expect(pathLines.length).toBe(0);
  });

  test("doctor does not show full filesystem paths", async () => {
    const { stdout, exitCode } = await runQmd(["doctor"], {
      dbPath: localDbPath,
      configDir: localConfigDir,
      env: { QMD_DOCTOR_DEVICE_PROBE: "0" },
    });
    expect(exitCode).toBe(0);

    expect(stdout).toContain("QMD Doctor");
    const lines = stdout.split('\n').filter(l => !l.includes('Index:') && !l.includes('INDEX_PATH=') && !l.includes('QMD_CONFIG_DIR='));
    const pathLines = lines.filter(l => l.includes('/Users/') || l.includes('/home/') || l.includes('/tmp/'));
    expect(pathLines.length).toBe(0);
  }, 20000);

  test("collection list does not show full filesystem paths", async () => {
    const { stdout, exitCode } = await runQmd(["collection", "list"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // Should show qmd:// URIs
    expect(stdout).toContain(`qmd://${collName}/`);
    // Should NOT show Path: lines with filesystem paths
    expect(stdout).not.toMatch(/Path:\s+\//);
  });
});

// =============================================================================
// MCP HTTP Daemon Lifecycle
// =============================================================================

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
    return runQmd(args, {
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
      cwd: fixturesDir,
      env: {
        ...process.env,
        INDEX_PATH: daemonDbPath,
        QMD_CONFIG_DIR: daemonConfigDir,
        PWD: fixturesDir,
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

    const addResult = await runQmd(
      ["--index", customIndex, "collection", "add", fixturesDir, "--name", "mcp-fixtures"],
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

    const updateResult = await runQmd(
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
