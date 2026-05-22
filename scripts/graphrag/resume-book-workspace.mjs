#!/usr/bin/env node

import { cwd } from "node:process";
import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import YAML from "yaml";

import {
  FileBookJobStateRepository,
  createQmdGraphRagRuntime,
  createRunId,
  GraphRagWorkflowNameSchema,
  loadGraphQueryCapabilities,
  syncGraphRagBookWorkspace,
  writeManagedGraphRagSettings,
} from "../../src/index.ts";
import {
  loadConfig,
  setConfigSource,
} from "../../src/collections.ts";

function required(value, name) {
  if (!value) {
    throw new Error(`missing required argument: --${name}`);
  }
  return value;
}

const { values } = parseArgs({
  options: {
    "state-root": { type: "string" },
    "source-path": { type: "string" },
    "normalized-path": { type: "string" },
    "qmd-index-path": { type: "string" },
    config: { type: "string" },
    "python-bin": { type: "string" },
    "working-directory": { type: "string" },
    "query": { type: "string" },
    "query-method": { type: "string", default: "local" },
    verbose: { type: "boolean", default: true },
  },
});

const stateRoot = resolve(required(values["state-root"], "state-root"));
const requestedSourcePath = values["source-path"]
  ? resolve(values["source-path"])
  : null;
const requestedNormalizedPath = values["normalized-path"]
  ? resolve(values["normalized-path"])
  : null;
const workingDirectory = resolve(values["working-directory"] ?? cwd());
const pythonBin = values["python-bin"]
  ? resolve(values["python-bin"])
  : resolve(workingDirectory, ".venv-graphrag/bin/python");
const qmdIndexPath = values["qmd-index-path"]
  ? resolve(values["qmd-index-path"])
  : resolve(workingDirectory, ".qmd/index.sqlite");
const configPath = values.config
  ? resolve(values.config)
  : resolve(workingDirectory, ".qmd/index.yml");

const runtime = createQmdGraphRagRuntime();
const repo = new FileBookJobStateRepository(stateRoot);

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function stageWorkflows(stage) {
  const workflowsByStage = {
    graph_extract: [
      "load_input_documents",
      "create_base_text_units",
      "create_final_documents",
      "extract_graph",
      "finalize_graph",
      "extract_covariates",
      "create_communities",
      "create_final_text_units",
    ],
    community_report: [
      "create_community_reports",
      "create_community_reports_text",
    ],
    embed: ["generate_text_embeddings"],
  };
  const workflows = workflowsByStage[stage];
  if (workflows == null) {
    return null;
  }
  return workflows.map((workflow) => GraphRagWorkflowNameSchema.parse(workflow));
}

function indexScopeFromSync(sync) {
  return {
    bookId: sync.job.bookId,
    sourceId: `sha256:${sync.job.sourceHash}`,
    documentId: sync.job.documentId,
    contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
    artifactIds: [],
  };
}

async function graphQueryScopeFromSync(sync) {
  const sourceId = `sha256:${sync.job.sourceHash}`;
  const capabilities = await loadGraphQueryCapabilities({
    graphVault: stateRoot,
    sourceIds: [sourceId],
    documentIds: [sync.job.documentId],
  });
  const scoped = capabilities.filter((capability) =>
    capability.bookId === sync.job.bookId
  );
  if (scoped.length === 0) {
    throw new Error(
      `no graph_query capability is ready for book ${sync.job.bookId}`,
    );
  }
  return {
    selectedBookIds: [...new Set(scoped.map((item) => item.bookId))],
    graphCapabilityIds: [...new Set(scoped.map((item) => item.capabilityId))],
    sourceIds: [...new Set(scoped.map((item) => item.sourceId))],
    documentIds: [...new Set(scoped.map((item) => item.documentId))],
    contentHashes: [...new Set(scoped.map((item) => item.contentHash))],
    artifactIds: [...new Set(scoped.flatMap((item) => item.artifactIds))],
  };
}

async function loadSingleBookDefaults() {
  const catalogPath = resolve(stateRoot, "catalog", "books.yaml");
  const raw = await readFile(catalogPath, "utf8");
  const catalog = YAML.parse(raw) ?? {};
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  if (items.length !== 1) {
    throw new Error(
      "missing --source-path/--normalized-path and catalog does not contain exactly one book",
    );
  }

  const [job] = items;
  const sourcePath =
    typeof job.sourcePath === "string"
      ? resolve(stateRoot, job.sourcePath)
      : null;
  const sourceIdentityPath =
    typeof job.metadata?.sourceIdentityPath === "string"
      ? basename(job.metadata.sourceIdentityPath)
      : typeof job.metadata?.sourceName === "string"
        ? job.metadata.sourceName
        : sourcePath == null
          ? null
          : basename(sourcePath);
  const normalizedPath =
    typeof job.metadata?.normalizedPath === "string"
      ? resolve(stateRoot, job.metadata.normalizedPath)
      : null;

  return { sourcePath, sourceIdentityPath, normalizedPath };
}

async function resolveWorkspaceInputs() {
  if (requestedSourcePath && requestedNormalizedPath) {
    return {
      sourcePath: requestedSourcePath,
      sourceIdentityPath: basename(requestedSourcePath),
      normalizedPath: requestedNormalizedPath,
    };
  }

  const defaults = await loadSingleBookDefaults();
  const sourcePath = requestedSourcePath ?? defaults.sourcePath;
  const normalizedPath = requestedNormalizedPath ?? defaults.normalizedPath;
  if (!sourcePath) {
    throw new Error("missing required argument: --source-path");
  }
  if (!normalizedPath) {
    throw new Error("missing required argument: --normalized-path");
  }
  return {
    sourcePath,
    sourceIdentityPath: defaults.sourceIdentityPath ?? sourcePath,
    normalizedPath,
  };
}

async function run() {
  setConfigSource({ configPath });
  const projectConfig = loadConfig();
  await writeManagedGraphRagSettings({
    config: projectConfig,
    graphVault: stateRoot,
  });
  const { sourcePath, sourceIdentityPath, normalizedPath } =
    await resolveWorkspaceInputs();
  const sync = await syncGraphRagBookWorkspace({
    stateRootDir: stateRoot,
    sourcePath,
    sourceIdentityPath,
    normalizedPath,
    settingsPath: resolve(stateRoot, "settings.yaml"),
    promptsDir: resolve(stateRoot, "prompts"),
    outputDir: resolve(stateRoot, "output"),
    qmdIndexPath,
    projectConfig,
    metadata: {
      smoke: true,
    },
  });

  const nextStage = sync.resumePlan.nextStage;
  if (nextStage == null) {
    let queryResult = null;
    if (values.query) {
      queryResult = await runtime.graphQuery({
        rootDir: stateRoot,
        method: values["query-method"],
        query: values.query,
        responseType: "multiple paragraphs",
        capabilityScope: await graphQueryScopeFromSync(sync),
        verbose: values.verbose,
        environment: {
          pythonBin,
          workingDirectory,
        },
      });
    }

    printJson({
      status: "ready",
      bookId: sync.job.bookId,
      nextStage: null,
      completedStages: sync.resumePlan.completedStages,
      queryResult,
    });
    return;
  }

  if (nextStage === "query_ready") {
    const refreshed = await syncGraphRagBookWorkspace({
      stateRootDir: stateRoot,
      sourcePath,
      sourceIdentityPath,
      normalizedPath,
      settingsPath: resolve(stateRoot, "settings.yaml"),
      promptsDir: resolve(stateRoot, "prompts"),
      outputDir: resolve(stateRoot, "output"),
      qmdIndexPath,
      projectConfig,
      metadata: {
        smoke: true,
      },
    });

    printJson({
      status: refreshed.resumePlan.nextStage == null ? "ready" : "blocked",
      bookId: sync.job.bookId,
      startedStage: nextStage,
      nextStage: refreshed.resumePlan.nextStage,
      completedStages: refreshed.resumePlan.completedStages,
      queryResult: null,
    });
    return;
  }

  if (nextStage === "ingest" || nextStage === "normalize") {
    printJson({
      status: "blocked",
      bookId: sync.job.bookId,
      startedStage: null,
      nextStage,
      completedStages: sync.resumePlan.completedStages,
      queryResult: null,
      reason: `${nextStage} is a qmd_graphrag workspace materialization stage; rerun with valid --source-path and --normalized-path before GraphRAG workflows`,
    });
    return;
  }

  const workflows = stageWorkflows(nextStage);
  if (workflows == null) {
    throw new Error(
      `resume script cannot map nextStage=${nextStage} to GraphRAG workflows`,
    );
  }

  const runId = createRunId(nextStage);
  const inputFingerprint = sync.stageFingerprints[nextStage];

  await repo.startStage({
    bookId: sync.job.bookId,
    stage: nextStage,
    runId,
    inputFingerprint,
    metadata: {
      workflows,
      resumedFrom: nextStage,
    },
  });

  try {
    const indexResult = await runtime.graphIndex({
      rootDir: stateRoot,
      method: "standard",
      indexScope: indexScopeFromSync(sync),
      skipValidation: true,
      verbose: values.verbose,
      workflows,
      environment: {
        pythonBin,
        workingDirectory,
      },
    });

    const refreshed = await syncGraphRagBookWorkspace({
      stateRootDir: stateRoot,
      sourcePath,
      sourceIdentityPath,
      normalizedPath,
      settingsPath: resolve(stateRoot, "settings.yaml"),
      promptsDir: resolve(stateRoot, "prompts"),
      outputDir: resolve(stateRoot, "output"),
      qmdIndexPath,
      projectConfig,
      metadata: {
        smoke: true,
      },
    });

    let queryResult = null;
    if (values.query && refreshed.resumePlan.nextStage == null) {
      queryResult = await runtime.graphQuery({
        rootDir: stateRoot,
        method: values["query-method"],
        query: values.query,
        responseType: "multiple paragraphs",
        capabilityScope: await graphQueryScopeFromSync(refreshed),
        verbose: values.verbose,
        environment: {
          pythonBin,
          workingDirectory,
        },
      });
    }

    printJson({
      status: "completed",
      runId,
      bookId: sync.job.bookId,
      startedStage: nextStage,
      nextStage: refreshed.resumePlan.nextStage,
      completedStages: refreshed.resumePlan.completedStages,
      outputs: indexResult.outputs,
      queryResult,
    });
  } catch (error) {
    await repo.failStage({
      bookId: sync.job.bookId,
      stage: nextStage,
      runId,
      inputFingerprint,
      errorSummary: error instanceof Error ? error.message : String(error),
      metadata: {
        resumedFrom: nextStage,
      },
    });
    throw error;
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
