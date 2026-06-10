import { beforeEach, describe, expect, test } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import {
  existsSync,
  lstatSync,
  readFileSync,
  symlinkSync,
} from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  resolveEmbedModelForCli,
  resolveRerankModelForCli,
} from "../../src/cli/qmd.ts";
import { openDatabase } from "../../src/db.ts";
import { SchemaVersion } from "../../src/contracts/common.ts";
import {
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
  JINA_MULTIMODAL_EMBEDDING_MODEL,
  JINA_MULTIMODAL_RERANK_MODEL,
} from "../../src/llm.ts";
import { setConfigSource } from "../../src/collections.ts";
import { createCliTestHarness, projectRoot } from "../helpers/cli-harness.ts";

const harness = createCliTestHarness();

describe("CLI Help", () => {
  test("shows help with --help flag", async () => {
    const { stdout, exitCode } = await harness.runQmd(["--help"]);
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
    const { stdout, exitCode } = await harness.runQmd([]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Usage:");
  });
});



describe("CLI Skills", () => {
  test("lists bundled runtime skills", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd(["skills", "list"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd");
    expect(stdout).toContain("Search local markdown knowledge bases");
  });

  test("gets version-matched runtime skill content", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd(["skills", "get", "qmd"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# QMD - Query Markdown Documents");
    expect(stdout).toContain("## MCP Tool: `query`");
    expect(stdout).not.toContain("This file is a discovery stub");
  });

  test("gets runtime skill with supplementary references", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd(["skills", "get", "qmd", "--full"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# QMD - Query Markdown Documents");
    expect(stdout).toContain("--- references/mcp-setup.md ---");
    expect(stdout).toContain("# QMD MCP Server Setup");
  });

  test("prints canonical repository skill path", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd(["skills", "path", "qmd"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/skills\/qmd$/);
  });

  test("legacy skill show prints the canonical skill", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd(["skill", "show"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# QMD - Query Markdown Documents");
    expect(stdout).toContain("## MCP Tool: `query`");
    expect(stdout).not.toContain("This file is a discovery stub");
  });

  test("legacy skill install writes a qmd skill show bootstrap", async () => {
    const installDir = join(harness.testDir, "skill-install-target");
    await mkdir(installDir, { recursive: true });

    const { stdout, stderr, exitCode } = await harness.runQmd(["skill", "install", "--yes"], { cwd: installDir });
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
    const { stderr, exitCode } = await harness.runQmd(["embed", "--max-docs-per-batch", "0"]);
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
    const { stderr, exitCode } = await harness.runQmd(["embed", "--max-batch-mb", "0"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("maxBatchBytes");
  });
});

describe("CLI Skill Commands", () => {
  test("shows embedded skill with --skill alias", async () => {
    const { stdout, exitCode } = await harness.runQmd(["--skill"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("QMD Skill");
    expect(stdout).toContain("name: qmd");
    expect(stdout).toContain("allowed-tools: Bash(qmd:*), mcp__qmd__*");
  });

  test("shows skill help with -h", async () => {
    const { stdout, exitCode } = await harness.runQmd(["skill", "-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: qmd skill <show|install> [options]");
    expect(stdout).toContain("install");
    expect(stdout).toContain("--global");
  });

  test("installs the skill into the current project", async () => {
    const projectDir = join(harness.testDir, "skill-project");
    await mkdir(projectDir, { recursive: true });

    const { stdout, exitCode } = await harness.runQmd(["skill", "install"], { cwd: projectDir });
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
    const fakeHome = join(harness.testDir, "skill-home");
    await mkdir(fakeHome, { recursive: true });

    const { stdout, exitCode } = await harness.runQmd(["skill", "install", "--global", "--yes"], {
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
    const fakeHome = join(harness.testDir, "skill-home-shared");
    await mkdir(join(fakeHome, ".agents"), { recursive: true });
    await mkdir(join(fakeHome, ".claude"), { recursive: true });
    symlinkSync(join(fakeHome, ".agents", "skills"), join(fakeHome, ".claude", "skills"), "dir");

    const { stdout, exitCode } = await harness.runQmd(["skill", "install", "--global", "--yes"], {
      env: { HOME: fakeHome },
    });
    expect(exitCode).toBe(0);

    const skillDir = join(fakeHome, ".agents", "skills", "qmd");
    expect(lstatSync(skillDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain("!`qmd skill show`");
    expect(stdout).toContain(`✓ Claude already sees the skill via ${join(fakeHome, ".claude", "skills")}`);
  });

  test("refuses to overwrite an existing install without --force", async () => {
    const projectDir = join(harness.testDir, "skill-project-force");
    await mkdir(projectDir, { recursive: true });

    const first = await harness.runQmd(["skill", "install"], { cwd: projectDir });
    expect(first.exitCode).toBe(0);

    const second = await harness.runQmd(["skill", "install"], { cwd: projectDir });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("Skill already exists");
    expect(second.stderr).toContain("--force");
  });
});

describe("CLI Init Command", () => {
  test("creates a project-local .qmd index", async () => {
    const projectDir = join(harness.testDir, "init-project");
    await mkdir(projectDir, { recursive: true });

    const { stdout, exitCode } = await harness.runQmd(["init"], { cwd: projectDir });
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
    const fakeHome = join(harness.testDir, "init-home");
    await mkdir(fakeHome, { recursive: true });

    const { stderr, exitCode } = await harness.runQmd(["init"], {
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
    const { stdout, exitCode } = await harness.runQmd(["collection", "add", "."]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collection:");
    expect(stdout).toContain("Indexed:");
  });

  test("adds files with custom glob pattern", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd(["collection", "add", ".", "--mask", "notes/*.md"]);
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
    await harness.runQmd(["collection", "add", "."]);
    // Remove it
    await harness.runQmd(["collection", "remove", "fixtures"]);
    // Re-add
    const { stdout, exitCode } = await harness.runQmd(["collection", "add", "."]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collection 'fixtures' created successfully");
  });
});

describe("CLI Status Command", () => {
  beforeEach(async () => {
    // Ensure we have indexed files
    await harness.runQmd(["collection", "add", "."]);
  });

  test("qmd doctor reports core index health checks", async () => {
    const { stdout, exitCode } = await harness.runQmd(["doctor"]);
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

    const configText = readFileSync(join(harness.testConfigDir, "index.yml"), "utf-8");
    expect(configText).toContain("models:");
    expect(configText).toContain(DEFAULT_EMBED_MODEL_URI);
    expect(configText).toContain(DEFAULT_GENERATE_MODEL_URI);
    expect(configText).toContain(DEFAULT_RERANK_MODEL_URI);
    expect(configText).toContain("providers:");
    expect(configText).toContain("graphrag:");
    expect(configText).toContain("query:");
  }, 20000);

  test("qmd doctor --json emits structured diagnostics", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd(["doctor", "--json"], {
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
    const env = await harness.createIsolatedTestEnv("doctor-json-invalid-config");
    await writeFile(join(env.configDir, "index.yml"), "collections:\n  bad: [unterminated\n");

    const { stdout, stderr, exitCode } = await harness.runQmd(["doctor", "--json"], {
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
    const env = await harness.createIsolatedTestEnv("doctor-no-collections");
    const { stdout, exitCode } = await harness.runQmd(["doctor"], { dbPath: env.dbPath, configDir: env.configDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("index config");
    expect(stdout).toContain("no collections configured");
    expect(stdout).toContain("qmd collection add .");
  }, 20000);

  test("qmd doctor reports invalid index.yml without crashing", async () => {
    const env = await harness.createIsolatedTestEnv("doctor-invalid-config");
    await writeFile(join(env.configDir, "index.yml"), "collections:\n  bad: [unterminated\n");

    const { stdout, exitCode } = await harness.runQmd(["doctor"], { dbPath: env.dbPath, configDir: env.configDir });
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
    const env = await harness.createIsolatedTestEnv("doctor-custom-models");
    await writeFile(join(env.configDir, "index.yml"), `collections: {}\nmodels:\n  embed: hf:example/custom-embed/custom.gguf\n  generate: ${DEFAULT_GENERATE_MODEL_URI}\n  rerank: hf:example/custom-rerank/custom.gguf\n`);

    const { stdout, exitCode } = await harness.runQmd(["doctor"], { dbPath: env.dbPath, configDir: env.configDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("model defaults");
    expect(stdout).toContain("non-default model configuration");
    expect(stdout).toContain("index hf:example/custom-embed/custom.gguf");
    expect(stdout).toContain("index hf:example/custom-rerank/custom.gguf");
    expect(stdout).toContain("might be ok");
    expect(stdout).toContain("qmd pull");
  }, 20000);

  test("qmd doctor identifies cached non-GGUF model files", async () => {
    const env = await harness.createIsolatedTestEnv("doctor-invalid-model-cache");
    const model = "hf:example/custom-model/custom.gguf";
    await writeFile(join(env.configDir, "index.yml"), `collections: {}\nmodels:\n  embed: ${model}\n  generate: ${model}\n  rerank: ${model}\n`);
    const cacheRoot = join(env.configDir, "cache");
    const modelCacheDir = join(cacheRoot, "qmd", "models");
    await mkdir(modelCacheDir, { recursive: true });
    const badModelPath = join(modelCacheDir, "custom.gguf");
    await writeFile(badModelPath, "<!doctype html><html>blocked</html>");

    const { stdout, exitCode } = await harness.runQmd(["doctor"], {
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
  }, 90000);

  test("qmd doctor says when models are overridden by env", async () => {
    const env = await harness.createIsolatedTestEnv("doctor-env-models");
    await writeFile(join(env.configDir, "index.yml"), "collections: {}\n");

    const customEmbed = "hf:example/env-embed/custom.gguf";
    const { stdout, exitCode } = await harness.runQmd(["doctor"], {
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
    const env = await harness.createIsolatedTestEnv("doctor-jina-profile-env-models");
    await writeFile(join(env.configDir, "index.yml"), YAML.stringify({
      collections: {},
      providers: {
        jina: {
          embedding_profile: "multimodal",
        },
      },
    }));

    const { stdout, exitCode } = await harness.runQmd(["doctor"], {
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
    const env = await harness.createIsolatedTestEnv("doctor-force-cpu");
    const { stdout, exitCode } = await harness.runQmd(["doctor"], {
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
    const env = await harness.createIsolatedTestEnv("doctor-env-overrides");
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

    const { stdout, exitCode } = await harness.runQmd(["doctor"], {
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
    const db = openDatabase(harness.testDbPath);
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

    const { stdout, exitCode } = await harness.runQmd(["doctor"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("embedding fingerprints");
    expect(stdout).toContain("mixed named embedding fingerprints");
    expect(stdout).toContain("stale1");
  }, 20000);

  test("shows index status", async () => {
    const { stdout, exitCode } = await harness.runQmd(["status"]);
    expect(exitCode).toBe(0);
    // Should show collection info
    expect(stdout).toContain("Collection");
  });

  test("status omits device probing details; doctor owns GPU diagnostics", async () => {
    const { stdout, exitCode } = await harness.runQmd(["status"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Device");
    expect(stdout).not.toContain("QMD_STATUS_DEVICE_PROBE");
    expect(stdout).not.toContain("not probed");
  });
});

describe("CLI Search Command", () => {
  beforeEach(async () => {
    // Ensure we have indexed files
    await harness.runQmd(["collection", "add", "."]);
  });

  test("searches for documents with BM25", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "meeting"]);
    expect(exitCode).toBe(0);
    // Should find meeting.md
    expect(stdout.toLowerCase()).toContain("meeting");
  });

  test("searches with limit option", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "-n", "1", "test"]);
    expect(exitCode).toBe(0);
  });

  test("searches with all results option", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "--all", "the"]);
    expect(exitCode).toBe(0);
  });

  test("returns no results message for non-matching query", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "xyznonexistent123"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No results");
  });

  test("returns empty JSON array for non-matching query with --json", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "xyznonexistent123", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  test("returns CSV header only for non-matching query with --csv", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "xyznonexistent123", "--csv"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("docid,score,file,title,context,line,snippet");
  });

  test("returns empty XML container for non-matching query with --xml", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "xyznonexistent123", "--xml"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("<results></results>");
  });

  test("returns empty output for non-matching query with --md", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "xyznonexistent123", "--md"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("returns empty output for non-matching query with --files", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "xyznonexistent123", "--files"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("returns min-score threshold message for default CLI output", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "test", "--min-score", "2"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No results found above minimum score threshold.");
  });

  test("returns format-safe empty output when --min-score filters all results", async () => {
    const json = await harness.runQmd(["search", "test", "--json", "--min-score", "2"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([]);

    const csv = await harness.runQmd(["search", "test", "--csv", "--min-score", "2"]);
    expect(csv.exitCode).toBe(0);
    expect(csv.stdout.trim()).toBe("docid,score,file,title,context,line,snippet");

    const xml = await harness.runQmd(["search", "test", "--xml", "--min-score", "2"]);
    expect(xml.exitCode).toBe(0);
    expect(xml.stdout.trim()).toBe("<results></results>");

    const md = await harness.runQmd(["search", "test", "--md", "--min-score", "2"]);
    expect(md.exitCode).toBe(0);
    expect(md.stdout.trim()).toBe("");

    const files = await harness.runQmd(["search", "test", "--files", "--min-score", "2"]);
    expect(files.exitCode).toBe(0);
    expect(files.stdout.trim()).toBe("");
  });

  test("requires query argument", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd(["search"]);
    expect(exitCode).toBe(1);
    // Error message goes to stderr
    expect(stderr).toContain("Usage:");
  });

  test("--json --full includes line field for round-tripping to qmd get", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "meeting", "--json", "--full", "-n", "1"]);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].line).toBeTypeOf("number");
    expect(results[0].line).toBeGreaterThan(0);
    expect(results[0].body).toBeTypeOf("string");
  });

  test("vsearch does not emit query expansion diagnostics", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd(
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
