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
  syncGraphRagBookWorkspace,
} from "../../src/index.ts";

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

const runtime = createQmdGraphRagRuntime();
const repo = new FileBookJobStateRepository(stateRoot);

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
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

  if (!["community_report", "embed", "query_ready"].includes(nextStage)) {
    throw new Error(
      `resume script only supports post-graph-extract continuation, got nextStage=${nextStage}`,
    );
  }

  const runId = createRunId(nextStage);
  const inputFingerprint = sync.stageFingerprints[nextStage];
  const workflows =
    nextStage === "embed"
      ? ["generate_text_embeddings"]
      : ["create_community_reports_text", "generate_text_embeddings"];

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
