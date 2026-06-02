import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import YAML from "yaml";
import { buildEditorUri, termLink } from "../../src/cli/qmd.ts";
import { SchemaVersion } from "../../src/contracts/common.ts";
import { createCliTestHarness } from "../helpers/cli-harness.ts";

const harness = createCliTestHarness();

describe("CLI Unified Query Route", () => {
  let localDbPath: string;
  let localConfigDir: string;

  beforeAll(async () => {
    const env = await harness.createIsolatedTestEnv("unified-query");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;
    const addResult = await harness.runQmd(
      ["collection", "add", ".", "--name", "fixtures"],
      { dbPath: localDbPath, configDir: localConfigDir },
    );
    if (addResult.exitCode !== 0) {
      throw new Error(`Failed to add collection: ${addResult.stderr}`);
    }
  });

  test("qmd query --mode auto --json emits UnifiedAnswer", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd(
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
    const { stdout, exitCode } = await harness.runQmd(
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
    const { stdout, exitCode } = await harness.runQmd(
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
    const env = await harness.createIsolatedTestEnv("graph-default-route");
    await writeFile(
      join(env.configDir, "index.yml"),
      "collections: {}\nquery:\n  default_route: graphrag\n",
    );
    const { stderr, exitCode } = await harness.runQmd(
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
    const env = await harness.createIsolatedTestEnv("auto-upgrade-disabled");
    await writeFile(
      join(env.configDir, "index.yml"),
      "collections: {}\nquery:\n  allow_graph_upgrade: false\n",
    );
    const addResult = await harness.runQmd(
      ["collection", "add", ".", "--name", "fixtures"],
      { dbPath: env.dbPath, configDir: env.configDir },
    );
    expect(addResult.exitCode).toBe(0);

    const { stdout, exitCode } = await harness.runQmd(
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
    const { stdout, exitCode } = await harness.runQmd(
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
    await mkdir(join(harness.fixturesDir, "graph_vault"), { recursive: true });
    const { stderr, exitCode } = await harness.runQmd(
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
    await harness.runQmd(["collection", "add", "."]);
  });

  test("retrieves document content by path", async () => {
    const { stdout, exitCode } = await harness.runQmd(["get", "README.md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Project");
  });

  test("retrieves document from subdirectory", async () => {
    const { stdout, exitCode } = await harness.runQmd(["get", "notes/meeting.md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Team Meeting");
  });

  test("handles non-existent file", async () => {
    const { stdout, exitCode } = await harness.runQmd(["get", "nonexistent.md"]);
    // Should indicate file not found
    expect(exitCode).toBe(1);
  });

  test("clamps negative --from to top of file (no silent tail content)", async () => {
    const baseline = await harness.runQmd(["get", "README.md"]);
    const negative = await harness.runQmd(["get", "README.md", "--from", "-19"]);
    expect(negative.exitCode).toBe(0);
    expect(negative.stdout).toBe(baseline.stdout);
  });
});

describe("CLI Multi-Get Command", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use fresh database for each test
    localDbPath = harness.getFreshDbPath();
    // Ensure we have indexed files
    const addResult = await harness.runQmd(["collection", "add", ".", "--name", "fixtures"], { dbPath: localDbPath });
    if (addResult.exitCode !== 0) {
      throw new Error(`Failed to add collection: ${addResult.stderr}`);
    }
  });

  test("retrieves multiple documents by pattern", async () => {
    // Test glob pattern matching
    const { stdout, stderr, exitCode } = await harness.runQmd(["multi-get", "notes/*.md"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    // Should contain content from both notes files
    expect(stdout).toContain("Meeting");
    expect(stdout).toContain("Ideas");
  });

  test("retrieves documents by comma-separated paths", async () => {
    const { stdout, exitCode } = await harness.runQmd([
      "multi-get",
      "README.md,notes/meeting.md",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Project");
    expect(stdout).toContain("Team Meeting");
  });

  test("retrieves one document by exact virtual path", async () => {
    const { stdout, exitCode } = await harness.runQmd([
      "multi-get",
      "qmd://fixtures/notes/meeting.md",
      "-l",
      "1",
      "--max-bytes",
      "4096",
      "--json",
    ], { dbPath: localDbPath });
    const payload = JSON.parse(stdout);

    expect(exitCode).toBe(0);
    expect(payload[0]).toMatchObject({
      file: "qmd://fixtures/notes/meeting.md",
    });
    expect(payload[0].skipped).toBeUndefined();
    expect(payload[0].body).toContain("Meeting");
  });
});

describe("CLI Update Command", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = harness.getFreshDbPath();
    // Ensure we have indexed files
    await harness.runQmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("updates all collections", async () => {
    const { stdout, exitCode } = await harness.runQmd(["update"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Updating");
  });

  test("deactivates stale docs when collection has zero matching files", async () => {
    const { dbPath, configDir } = await harness.createIsolatedTestEnv("update-empty");
    const collectionDir = join(harness.testDir, `update-empty-${Date.now()}`);
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

    const add = await harness.runQmd(
      ["collection", "add", collectionDir, "--name", "empty-check"],
      { dbPath, configDir }
    );
    expect(add.exitCode).toBe(0);

    const before = await harness.runQmd(["get", "qmd://empty-check/only.md"], { dbPath, configDir });
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain(token);

    unlinkSync(docPath);

    const update = await harness.runQmd(["update"], { dbPath, configDir });
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("0 new, 0 updated, 0 unchanged, 1 removed");

    const after = await harness.runQmd(["get", "qmd://empty-check/only.md"], { dbPath, configDir });
    expect(after.exitCode).toBe(1);
  });
});

describe("CLI Add-Context Command", () => {
  let localDbPath: string;
  let localConfigDir: string;
  const collName = "fixtures";

  beforeAll(async () => {
    const env = await harness.createIsolatedTestEnv("context-cmd");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    // Add collection with known name
    const { exitCode, stderr } = await harness.runQmd(
      ["collection", "add", harness.fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);
  });

  test("adds context to a path", async () => {
    // Add context to the collection root using virtual path
    const { stdout, exitCode } = await harness.runQmd([
      "context",
      "add",
      `qmd://${collName}/`,
      "Personal notes and meeting logs",
    ], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Added context");
  });

  test("requires path and text arguments", async () => {
    const { stderr, exitCode } = await harness.runQmd(["context", "add"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(1);
    // Error message goes to stderr
    expect(stderr).toContain("Usage:");
  });
});

describe("CLI Cleanup Command", () => {
  beforeEach(async () => {
    // Ensure we have indexed files
    await harness.runQmd(["collection", "add", "."]);
  });

  test("cleans up orphaned entries", async () => {
    const { stdout, exitCode } = await harness.runQmd(["cleanup"]);
    expect(exitCode).toBe(0);
  });
});

describe("CLI Error Handling", () => {
  test("handles unknown command", async () => {
    const { stderr, exitCode } = await harness.runQmd(["unknowncommand"]);
    expect(exitCode).toBe(1);
    // Should indicate unknown command and point users to diagnostics
    expect(stderr).toContain("Unknown command");
    expect(stderr).toContain("qmd doctor");
  });

  test("uses INDEX_PATH environment variable", async () => {
    // Verify the test DB path is being used by creating a separate index
    const customDbPath = join(harness.testDir, "custom.sqlite");
    const { exitCode } = await harness.runQmd(["collection", "add", "."], {
      env: { INDEX_PATH: customDbPath },
    });
    expect(exitCode).toBe(0);

    // The custom database should exist
    expect(existsSync(customDbPath)).toBe(true);
  });
});

describe("CLI Output Formats", () => {
  beforeEach(async () => {
    await harness.runQmd(["collection", "add", "."]);
  });

  test("search with --json flag outputs JSON", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "--json", "test"]);
    expect(exitCode).toBe(0);
    // Should be valid JSON
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("search with --files flag outputs file paths", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "--files", "meeting"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(".md");
  });

  test("search output includes snippets by default", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "API"]);
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
    localDbPath = harness.getFreshDbPath();
    // Create multiple collections with explicit names
    await harness.runQmd(["collection", "add", ".", "--name", "notes", "--mask", "notes/*.md"], { dbPath: localDbPath });
    await harness.runQmd(["collection", "add", ".", "--name", "docs", "--mask", "docs/*.md"], { dbPath: localDbPath });
  });

  test("filters search by collection name", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd([
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
    localDbPath = harness.getFreshDbPath();
    // Index some files first
    await harness.runQmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("add global context with /", async () => {
    const { stdout, exitCode } = await harness.runQmd([
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
    await harness.runQmd([
      "context",
      "add",
      "/",
      "Test context",
    ], { dbPath: localDbPath });

    const { stdout, exitCode } = await harness.runQmd([
      "context",
      "list",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Configured Contexts");
    expect(stdout).toContain("Test context");
  });

  test("add context to virtual path", async () => {
    // Collection name should be "fixtures" (basename of the fixtures directory)
    const { stdout, exitCode } = await harness.runQmd([
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
    await harness.runQmd([
      "context",
      "add",
      "/",
      "Global context to remove",
    ], { dbPath: localDbPath });

    const { stdout, exitCode } = await harness.runQmd([
      "context",
      "rm",
      "/",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Removed");
  });

  test("remove virtual path context", async () => {
    // Add a context first
    await harness.runQmd([
      "context",
      "add",
      "qmd://fixtures/notes",
      "Context to remove",
    ], { dbPath: localDbPath });

    const { stdout, exitCode } = await harness.runQmd([
      "context",
      "rm",
      "qmd://fixtures/notes",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Removed context for: qmd://fixtures/notes");
  });

  test("fails to remove non-existent context", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd([
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
    localDbPath = harness.getFreshDbPath();
    // Index some files first
    await harness.runQmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("lists all collections", async () => {
    const { stdout, exitCode } = await harness.runQmd(["ls"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collections:");
    expect(stdout).toContain("qmd://fixtures/");
  });

  test("lists files in a collection", async () => {
    const { stdout, exitCode } = await harness.runQmd(["ls", "fixtures"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    // handelize preserves original case
    expect(stdout).toContain("qmd://fixtures/README.md");
    expect(stdout).toContain("qmd://fixtures/notes/meeting.md");
  });

  test("lists files with path prefix", async () => {
    const { stdout, exitCode } = await harness.runQmd(["ls", "fixtures/notes"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd://fixtures/notes/meeting.md");
    expect(stdout).toContain("qmd://fixtures/notes/ideas.md");
    // Should not include files outside the prefix (case preserved)
    expect(stdout).not.toContain("qmd://fixtures/README.md");
  });

  test("lists files with virtual path", async () => {
    const { stdout, exitCode } = await harness.runQmd(["ls", "qmd://fixtures/docs"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd://fixtures/docs/api.md");
  });

  test("continues to normalize extra slashes for normal collection virtual paths", async () => {
    const { stdout, stderr, exitCode } = await harness.runQmd(["ls", "qmd:///fixtures/docs"], { dbPath: localDbPath });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd://fixtures/docs/api.md");
  });

  test("lists an absolute-path collection from a qmd:/// virtual path", async () => {
    const env = await harness.createIsolatedTestEnv("absolute-qmd-path");
    const absoluteDir = await mkdtemp(join(tmpdir(), "qmd-absolute-collection-"));
    await writeFile(join(absoluteDir, "root.md"), "# Absolute collection\n");
    await writeFile(
      join(env.configDir, "index.yml"),
      `collections:\n  "${absoluteDir}":\n    path: "${absoluteDir}"\n    pattern: "**/*.md"\n`
    );

    const update = await harness.runQmd(["update"], {
      cwd: absoluteDir,
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(update.exitCode).toBe(0);

    const { stdout, stderr, exitCode } = await harness.runQmd(["ls", `qmd://${absoluteDir}/`], {
      cwd: absoluteDir,
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`qmd://${absoluteDir}/root.md`);
  });

  test("lists an absolute-path collection from a raw path using the longest prefix match", async () => {
    const env = await harness.createIsolatedTestEnv("absolute-raw-path");
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

    const update = await harness.runQmd(["update"], {
      cwd: parentDataDir,
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(update.exitCode).toBe(0);

    const { stdout, stderr, exitCode } = await harness.runQmd(["ls", `${childCollectionName}/`], {
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
    const { stderr, exitCode } = await harness.runQmd(["ls", "nonexistent"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found");
  });
});

describe("CLI Collection Commands", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = harness.getFreshDbPath();
    // Index some files first to create a collection
    await harness.runQmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("lists collections", async () => {
    const { stdout, exitCode } = await harness.runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collections");
    expect(stdout).toContain("fixtures");
    expect(stdout).toContain("qmd://fixtures/");
    expect(stdout).toContain("Pattern:");
    expect(stdout).toContain("Files:");
  });

  test("removes a collection", async () => {
    // First verify the collection exists
    const { stdout: listBefore } = await harness.runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(listBefore).toContain("fixtures");

    // Remove it
    const { stdout, exitCode } = await harness.runQmd(["collection", "remove", "fixtures"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Removed collection 'fixtures'");
    expect(stdout).toContain("Deleted");

    // Verify it's gone
    const { stdout: listAfter } = await harness.runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(listAfter).not.toContain("fixtures");
  });

  test("handles removing non-existent collection", async () => {
    const { stderr, exitCode } = await harness.runQmd(["collection", "remove", "nonexistent"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found");
  });

  test("handles missing remove argument", async () => {
    const { stderr, exitCode } = await harness.runQmd(["collection", "remove"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });

  test("handles unknown subcommand", async () => {
    const { stderr, exitCode } = await harness.runQmd(["collection", "invalid"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown subcommand");
  });

  test("renames a collection", async () => {
    // First verify the collection exists
    const { stdout: listBefore } = await harness.runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(listBefore).toContain("qmd://fixtures/");

    // Rename it
    const { stdout, exitCode } = await harness.runQmd(["collection", "rename", "fixtures", "my-fixtures"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Renamed collection 'fixtures' to 'my-fixtures'");
    expect(stdout).toContain("qmd://fixtures/");
    expect(stdout).toContain("qmd://my-fixtures/");

    // Verify the new name exists and old name is gone
    const { stdout: listAfter } = await harness.runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(listAfter).toContain("qmd://my-fixtures/");
    expect(listAfter).not.toContain("qmd://fixtures/"); // Old collection should not appear
  });

  test("handles renaming non-existent collection", async () => {
    const { stderr, exitCode } = await harness.runQmd(["collection", "rename", "nonexistent", "newname"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found");
  });

  test("handles renaming to existing collection name", async () => {
    // Create a second collection in a temp directory
    const tempDir = await mkdtemp(join(tmpdir(), "qmd-second-"));
    await writeFile(join(tempDir, "test.md"), "# Test");
    const addResult = await harness.runQmd(["collection", "add", tempDir, "--name", "second"], { dbPath: localDbPath });

    if (addResult.exitCode !== 0) {
      console.error("Failed to add second collection:", addResult.stderr);
    }
    expect(addResult.exitCode).toBe(0);

    // Verify both collections exist
    const { stdout: listBoth } = await harness.runQmd(["collection", "list"], { dbPath: localDbPath });
    expect(listBoth).toContain("qmd://fixtures/");
    expect(listBoth).toContain("qmd://second/");

    // Try to rename fixtures to second (which already exists)
    const { stderr, exitCode } = await harness.runQmd(["collection", "rename", "fixtures", "second"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection name already exists");
  });

  test("handles missing rename arguments", async () => {
    const { stderr: stderr1, exitCode: exitCode1 } = await harness.runQmd(["collection", "rename"], { dbPath: localDbPath });
    expect(exitCode1).toBe(1);
    expect(stderr1).toContain("Usage:");

    const { stderr: stderr2, exitCode: exitCode2 } = await harness.runQmd(["collection", "rename", "fixtures"], { dbPath: localDbPath });
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
    const env = await harness.createIsolatedTestEnv("ignore-patterns");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    // Create directory structure with subdirectories to ignore
    ignoreTestDir = join(harness.testDir, "ignore-fixtures");
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

    const { stdout, exitCode } = await harness.runQmd(["update"], {
      cwd: ignoreTestDir,
      dbPath: localDbPath,
      configDir: localConfigDir,
    });
    expect(exitCode).toBe(0);
    // Should index 2 files (readme.md + notes/note1.md), not 5
    expect(stdout).toContain("2 new");
  });

  test("ignored files are not searchable", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "session", "-n", "10"], {
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
    const { stdout, exitCode } = await harness.runQmd(["search", "personal note", "-n", "10"], {
      cwd: ignoreTestDir,
      dbPath: localDbPath,
      configDir: localConfigDir,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("note1");
  });

  test("status shows ignore patterns", async () => {
    const { stdout, exitCode } = await harness.runQmd(["collection", "list"], {
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
    const env2 = await harness.createIsolatedTestEnv("no-ignore");
    await writeFile(
      join(env2.configDir, "index.yml"),
      `collections:
  allfiles:
    path: ${ignoreTestDir}
    pattern: "**/*.md"
`
    );

    const { stdout, exitCode } = await harness.runQmd(["update"], {
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
    const env = await harness.createIsolatedTestEnv("output-format");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    // Add collection
    const { exitCode, stderr } = await harness.runQmd(
      ["collection", "add", harness.fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);

    // Add context
    await harness.runQmd(["context", "add", `qmd://${collName}/`, "Test fixtures for QMD"], { dbPath: localDbPath, configDir: localConfigDir });
  });

  test("search --json includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "test", "--json", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
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
    const env = await harness.createIsolatedTestEnv("custom-index-links");
    const customColl = "fixtures-alt";
    const customIndex = "release-notes";
    const customCacheDir = join(harness.testDir, `cache-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(customCacheDir, { recursive: true });

    const sharedEnv = {
      INDEX_PATH: "",
      XDG_CACHE_HOME: customCacheDir,
    };

    const addResult = await harness.runQmd(
      ["--index", customIndex, "collection", "add", harness.fixturesDir, "--name", customColl],
      { dbPath: env.dbPath, configDir: env.configDir, env: sharedEnv }
    );
    expect(addResult.exitCode).toBe(0);

    const searchResult = await harness.runQmd(
      ["--index", customIndex, "search", "test", "--json", "-n", "1"],
      { dbPath: env.dbPath, configDir: env.configDir, env: sharedEnv }
    );
    expect(searchResult.exitCode).toBe(0);

    const results = JSON.parse(searchResult.stdout);
    const file = results[0]?.file;
    expect(file).toMatch(new RegExp(`^qmd://${customColl}/.+\\?index=${customIndex}$`));

    const getResult = await harness.runQmd(
      ["get", file, "-l", "2"],
      { dbPath: env.dbPath, configDir: env.configDir, env: sharedEnv }
    );
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout.trim().length).toBeGreaterThan(0);
  });

  test("search --files includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "test", "--files", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // Format: #docid,score,qmd://collection/path,"context"
    expect(stdout).toMatch(new RegExp(`^#[a-f0-9]{6},[\\d.]+,qmd://${collName}/`, "m"));
    expect(stdout).toContain("Test fixtures for QMD");
    // Ensure no full filesystem paths
    expect(stdout).not.toMatch(/\/Users\//);
    expect(stdout).not.toMatch(/\/home\//);
  });

  test("search --csv includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "test", "--csv", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
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
    const { stdout, exitCode } = await harness.runQmd(["search", "test", "--md", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    expect(stdout).toMatch(/\*\*docid:\*\* `#[a-f0-9]{6}`/);
    expect(stdout).toContain("**context:** Test fixtures for QMD");
  });

  test("search --xml includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "test", "--xml", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    expect(stdout).toMatch(new RegExp(`<file docid="#[a-f0-9]{6}" name="qmd://${collName}/`));
    expect(stdout).toContain('context="Test fixtures for QMD"');
    // Ensure no full filesystem paths
    expect(stdout).not.toMatch(/\/Users\//);
    expect(stdout).not.toMatch(/\/home\//);
  });

  test("search default CLI format includes plain qmd:// path, docid, and context in non-TTY mode", async () => {
    const { stdout, exitCode } = await harness.runQmd(["search", "test", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
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
    const env = await harness.createIsolatedTestEnv("get-paths");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    const { exitCode, stderr } = await harness.runQmd(
      ["collection", "add", harness.fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);
  });

  test("get with qmd://collection/path format", async () => {
    const { stdout, exitCode } = await harness.runQmd(["get", `qmd://${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with collection/path format (no scheme)", async () => {
    const { stdout, exitCode } = await harness.runQmd(["get", `${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with //collection/path format", async () => {
    const { stdout, exitCode } = await harness.runQmd(["get", `//${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with qmd:////collection/path format (extra slashes)", async () => {
    const { stdout, exitCode } = await harness.runQmd(["get", `qmd:////${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with path:line format", async () => {
    const { stdout, exitCode } = await harness.runQmd(["get", `${collName}/test1.md:3`, "-l", "2"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    // Should start from line 3, not line 1
    expect(stdout).not.toMatch(/^# Test Document 1$/m);
  });

  test("get with qmd://path:line format", async () => {
    const { stdout, exitCode } = await harness.runQmd(["get", `qmd://${collName}/test1.md:3`, "-l", "2"], { dbPath: localDbPath, configDir: localConfigDir });
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
    const env = await harness.createIsolatedTestEnv("status-paths");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    const { exitCode, stderr } = await harness.runQmd(
      ["collection", "add", harness.fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);
  });

  test("status does not show full filesystem paths", async () => {
    const { stdout, exitCode } = await harness.runQmd(["status"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // Should show qmd:// URIs
    expect(stdout).toContain(`qmd://${collName}/`);
    // Should NOT show full filesystem paths (except for the index location which is ok)
    const lines = stdout.split('\n').filter(l => !l.includes('Index:'));
    const pathLines = lines.filter(l => l.includes('/Users/') || l.includes('/home/') || l.includes('/tmp/'));
    expect(pathLines.length).toBe(0);
  });

  test("doctor does not show full filesystem paths", async () => {
    const { stdout, exitCode } = await harness.runQmd(["doctor"], {
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
    const { stdout, exitCode } = await harness.runQmd(["collection", "list"], { dbPath: localDbPath, configDir: localConfigDir });
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
