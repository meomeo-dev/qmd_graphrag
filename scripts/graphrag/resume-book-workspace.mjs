#!/usr/bin/env node

import { cwd } from "node:process";
import { basename, join, resolve } from "node:path";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import YAML from "yaml";

function required(value, name) {
  if (!value) {
    throw new Error(`missing required argument: --${name}`);
  }
  return value;
}

async function importRuntime() {
  const srcIndex = new URL("../../src/index.ts", import.meta.url);
  const srcCollections = new URL("../../src/collections.ts", import.meta.url);
  const srcMetadata = new URL("../../src/vault/metadata.ts", import.meta.url);
  const distIndex = new URL("../../dist/index.js", import.meta.url);
  const distCollections = new URL("../../dist/collections.js", import.meta.url);
  const distMetadata = new URL("../../dist/vault/metadata.js", import.meta.url);
  const useSource = existsSync(srcIndex) && existsSync(new URL("../../.git", import.meta.url));
  const [indexModule, collectionsModule, metadataModule] = await Promise.all([
    import(useSource ? srcIndex.href : distIndex.href),
    import(useSource ? srcCollections.href : distCollections.href),
    import(useSource ? srcMetadata.href : distMetadata.href),
  ]);
  return {
    FileBookJobStateRepository: indexModule.FileBookJobStateRepository,
    createQmdGraphRagRuntime: indexModule.createQmdGraphRagRuntime,
    createRunId: indexModule.createRunId,
    buildBookIdFromSourceHash: indexModule.buildBookIdFromSourceHash,
    hashFile: indexModule.hashFile,
    GraphRagWorkflowNameSchema: indexModule.GraphRagWorkflowNameSchema,
    assertGraphRagStageReportHealthy: indexModule.assertGraphRagStageReportHealthy,
    graphRagBookInputDir: indexModule.graphRagBookInputDir,
    graphRagBookOutputDir: indexModule.graphRagBookOutputDir,
    assertGraphRagStageArtifactsReady: indexModule.assertGraphRagStageArtifactsReady,
    graphRagIndexLogOffset: indexModule.graphRagIndexLogOffset,
    loadGraphQueryCapabilities: indexModule.loadGraphQueryCapabilities,
    syncGraphRagBookWorkspace: indexModule.syncGraphRagBookWorkspace,
    writeGraphRagOutputProducerManifest: indexModule.writeGraphRagOutputProducerManifest,
    writeManagedGraphRagSettings: indexModule.writeManagedGraphRagSettings,
    loadConfig: collectionsModule.loadConfig,
    setConfigSource: collectionsModule.setConfigSource,
    sanitizeVaultText: metadataModule.sanitizeVaultText,
  };
}

const { values } = parseArgs({
  options: {
    "state-root": { type: "string" },
    "source-path": { type: "string" },
    "source-identity-path": { type: "string" },
    "normalized-path": { type: "string" },
    "qmd-index-path": { type: "string" },
    config: { type: "string" },
    "python-bin": { type: "string" },
    "report-root": { type: "string" },
    "working-directory": { type: "string" },
    "query": { type: "string" },
    "query-method": { type: "string", default: "local" },
    "repair-local-artifact-gate-only": { type: "boolean", default: false },
    verbose: { type: "boolean", default: true },
  },
});

const stateRoot = resolve(required(values["state-root"], "state-root"));
const requestedSourcePath = values["source-path"]
  ? resolve(values["source-path"])
  : null;
const requestedSourceIdentityPath = values["source-identity-path"]
  ? String(values["source-identity-path"])
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
const reportRoot = values["report-root"]
  ? resolve(values["report-root"])
  : null;
if (reportRoot == null) {
  throw new Error("missing required argument: --report-root");
}

let GraphRagWorkflowNameSchemaRef;

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function errorText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function safeText(runtimeApi, value) {
  return runtimeApi.sanitizeVaultText(String(value)) ?? "[redacted]";
}

function stageWorkflows(stage) {
  if (GraphRagWorkflowNameSchemaRef == null) {
    throw new Error("GraphRAG workflow schema is not initialized");
  }
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
  return workflows.map((workflow) =>
    GraphRagWorkflowNameSchemaRef.parse(workflow)
  );
}

function reusableRunIdForStage(sync, stage) {
  const checkpoint = sync.resumePlan.stageStates
    .find((item) => item.stage === stage);
  const runId = checkpoint?.checkpointStatus === "failed" ||
      checkpoint?.checkpointStatus === "running" ||
      checkpoint?.checkpointStatus === "pending"
    ? checkpoint?.runId
    : undefined;
  if (typeof runId === "string" && runId.length > 0) {
    return runId;
  }
  return null;
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

async function queryReadyProducerArtifacts(runtimeApi, repo, sync) {
  const checkpoints = await repo.listStageCheckpoints(sync.job.bookId);
  const checkpointByStage = new Map(checkpoints.map((item) => [item.stage, item]));
  const graphExtract = checkpointByStage.get("graph_extract");
  const communityReport = checkpointByStage.get("community_report");
  const embed = checkpointByStage.get("embed");
  if (
    graphExtract?.status !== "succeeded" ||
    communityReport?.status !== "succeeded" ||
    embed?.status !== "succeeded" ||
    typeof graphExtract.runId !== "string" ||
    typeof communityReport.runId !== "string" ||
    typeof embed.runId !== "string"
  ) {
    throw new Error(
      "query_ready requires completed graph_extract, community_report and embed stages",
    );
  }
  const expectedCorpusContentHash = sync.job.normalizedContentHash ?? sync.job.sourceHash;
  const artifacts = sync.artifacts.filter((artifact) =>
    (
      artifact.stage === "graph_extract" &&
      artifact.producerRunId === graphExtract.runId
    ) ||
    (
      artifact.kind === "graphrag_community_reports_parquet" &&
      artifact.stage === "community_report" &&
      artifact.producerRunId === communityReport.runId
    ) ||
    (
      artifact.kind === "lancedb_index" &&
      artifact.stage === "embed" &&
      artifact.producerRunId === embed.runId
    )
  );
  const artifactIds = await runtimeApi.assertGraphRagStageArtifactsReady({
    stateRootDir: stateRoot,
    bookId: sync.job.bookId,
    stage: "query_ready",
    producerRunId: "query_ready-readiness",
    artifacts,
    expectedProducerRunIds: {
      graph_extract: graphExtract.runId,
      community_report: communityReport.runId,
      embed: embed.runId,
    },
    expectedStageFingerprints: sync.job.stageFingerprints,
    expectedProviderFingerprint: sync.job.providerFingerprint,
    expectedCorpusContentHash,
  });
  return {
    artifactIds,
    producerRunIds: {
      graph_extract: graphExtract.runId,
      community_report: communityReport.runId,
      embed: embed.runId,
    },
  };
}

function isLocalArtifactGateError(value) {
  const message = String(value ?? "").toLowerCase();
  return (
    message.includes("did not produce valid book-scoped artifacts") ||
    message.includes("missingartifactkinds") ||
    message.includes("missing artifact kinds") ||
    message.includes("missingartifactids") ||
    message.includes("missing artifact ids") ||
    message.includes("invalidartifacts") ||
    message.includes("invalid artifacts") ||
    message.includes("stage_artifact_") ||
    message.includes("graph_output_producer_") ||
    message.includes("bootstrap_stage_requires_real_rebuild") ||
    message.includes("real_graphrag_stage_missing") ||
    message.includes("artifact_identity_mismatch") ||
    message.includes("artifact_stage_mismatch") ||
    message.includes("artifact_kind_not_allowed") ||
    message.includes("content_hash_mismatch") ||
    message.includes("parquet_") ||
    message.includes("lancedb_") ||
    message.includes("producer_run_id_mismatch") ||
    message.includes("stage_fingerprint_mismatch") ||
    message.includes("provider_fingerprint_mismatch") ||
    message.includes("corpus_content_hash_mismatch") ||
    message.includes("artifact_not_book_scoped_graph_output")
  );
}

async function graphQueryScopeFromSync(sync, loadGraphQueryCapabilities) {
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
      ? job.metadata.sourceIdentityPath
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
      sourceIdentityPath: requestedSourceIdentityPath ?? basename(requestedSourcePath),
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
    sourceIdentityPath: requestedSourceIdentityPath ?? defaults.sourceIdentityPath ??
      sourcePath,
    normalizedPath,
  };
}

async function materializeScopedGraphInput(inputDir, normalizedPath) {
  await mkdir(inputDir, { recursive: true });
  const target = resolve(inputDir, basename(normalizedPath));
  await copyFile(normalizedPath, target);
  return target;
}

async function syncCurrentBook(
  runtimeApi,
  projectConfig,
  sourcePath,
  sourceIdentityPath,
  normalizedPath,
) {
  const sync = await runtimeApi.syncGraphRagBookWorkspace({
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
  const scopedInputDir = runtimeApi.graphRagBookInputDir({
    stateRootDir: stateRoot,
    bookId: sync.job.bookId,
  });
  await materializeScopedGraphInput(scopedInputDir, normalizedPath);
  const scopedOutputDir = runtimeApi.graphRagBookOutputDir({
    stateRootDir: stateRoot,
    bookId: sync.job.bookId,
  });
  return { sync, scopedInputDir, scopedOutputDir };
}

async function refreshOutputProducerManifestFromCheckpoints(
  runtimeApi,
  repo,
  sync,
  scopedOutputDir,
) {
  const checkpoints = await repo.listStageCheckpoints(sync.job.bookId);
  for (const stage of ["graph_extract", "community_report", "embed", "query_ready"]) {
    const checkpoint = checkpoints.find((item) =>
      item.stage === stage && item.status === "succeeded" &&
      typeof item.runId === "string"
    );
    if (checkpoint == null) continue;
    await runtimeApi.writeGraphRagOutputProducerManifest({
      outputDir: scopedOutputDir,
      bookId: sync.job.bookId,
      sourceHash: sync.job.sourceHash,
      documentId: sync.job.documentId,
      contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
      stageFingerprints: sync.stageFingerprints,
      providerFingerprint: sync.job.providerFingerprint,
      producerRunId: checkpoint.runId,
      stage,
    });
  }
}

async function repairLocalArtifactGateFailureIfPossible({
  runtimeApi,
  repo,
  sync,
  scopedOutputDir,
}) {
  const nextStage = sync.resumePlan.nextStage;
  if (!["graph_extract", "community_report", "embed"].includes(nextStage)) {
    return false;
  }
  const checkpoints = await repo.listStageCheckpoints(sync.job.bookId);
  const checkpoint = checkpoints.find((item) => item.stage === nextStage);
  if (
    checkpoint == null ||
    checkpoint.status !== "failed" ||
    typeof checkpoint.runId !== "string" ||
    !isLocalArtifactGateError(checkpoint.errorSummary)
  ) {
    return false;
  }

  await runtimeApi.writeGraphRagOutputProducerManifest({
    outputDir: scopedOutputDir,
    bookId: sync.job.bookId,
    sourceHash: sync.job.sourceHash,
    documentId: sync.job.documentId,
    contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
    stageFingerprints: sync.stageFingerprints,
    providerFingerprint: sync.job.providerFingerprint,
    producerRunId: checkpoint.runId,
    stage: nextStage,
  });
  const artifactIds = await runtimeApi.assertGraphRagStageArtifactsReady({
    stateRootDir: stateRoot,
    bookId: sync.job.bookId,
    stage: nextStage,
    producerRunId: checkpoint.runId,
    artifacts: sync.artifacts,
    expectedStageFingerprints: sync.job.stageFingerprints,
    expectedProviderFingerprint: sync.job.providerFingerprint,
    expectedCorpusContentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
  });
  await repo.completeStage({
    bookId: sync.job.bookId,
    stage: nextStage,
    runId: checkpoint.runId,
    inputFingerprint: sync.stageFingerprints[nextStage],
    contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
    stageFingerprint: sync.stageFingerprints[nextStage],
    providerFingerprint: sync.job.providerFingerprint,
    artifactIds,
    metadata: {
      ...(checkpoint.metadata ?? {}),
      recoveredFromLocalArtifactGateFailure: true,
      graphWorkspace: "book_scoped",
    },
  });
  return true;
}

async function runRepairLocalArtifactGateOnly(runtimeApi, repo) {
  const { sourcePath, sourceIdentityPath } = await resolveWorkspaceInputs();
  const sourceHash = await runtimeApi.hashFile(sourcePath);
  const bookId = runtimeApi.buildBookIdFromSourceHash(
    sourceIdentityPath,
    sourceHash,
  );
  const job = await repo.getBookJob(bookId);
  if (job == null) {
    printJson({
      status: "blocked",
      bookId,
      startedStage: null,
      nextStage: null,
      completedStages: [],
      queryResult: null,
      repairOnly: true,
      repairedLocalArtifactGate: false,
      reason: "book state not found for local artifact gate repair",
    });
    return;
  }
  const checkpoints = await repo.listStageCheckpoints(bookId);
  const checkpoint = checkpoints.find((item) =>
    ["graph_extract", "community_report", "embed"].includes(item.stage) &&
    item.status === "failed" &&
    typeof item.runId === "string" &&
    isLocalArtifactGateError(item.errorSummary)
  );
  if (checkpoint == null) {
    printJson({
      status: "blocked",
      bookId,
      startedStage: null,
      nextStage: null,
      completedStages: checkpoints
        .filter((item) => item.status === "succeeded")
        .map((item) => item.stage),
      queryResult: null,
      repairOnly: true,
      repairedLocalArtifactGate: false,
      reason: "local artifact gate failure checkpoint not found",
    });
    return;
  }
  const scopedOutputDir = runtimeApi.graphRagBookOutputDir({
    stateRootDir: stateRoot,
    bookId,
  });
  await runtimeApi.writeGraphRagOutputProducerManifest({
    outputDir: scopedOutputDir,
    bookId,
    sourceHash: job.sourceHash,
    documentId: job.documentId,
    contentHash: job.normalizedContentHash ?? job.sourceHash,
    stageFingerprints: job.stageFingerprints,
    providerFingerprint: job.providerFingerprint,
    producerRunId: checkpoint.runId,
    stage: checkpoint.stage,
  });
  const artifacts = await repo.listArtifacts(bookId);
  const artifactIds = await runtimeApi.assertGraphRagStageArtifactsReady({
    stateRootDir: stateRoot,
    bookId,
    stage: checkpoint.stage,
    producerRunId: checkpoint.runId,
    artifacts,
    expectedStageFingerprints: job.stageFingerprints,
    expectedProviderFingerprint: job.providerFingerprint,
    expectedCorpusContentHash: job.normalizedContentHash ?? job.sourceHash,
  });
  await repo.completeStage({
    bookId,
    stage: checkpoint.stage,
    runId: checkpoint.runId,
    inputFingerprint: checkpoint.inputFingerprint,
    contentHash: job.normalizedContentHash ?? job.sourceHash,
    stageFingerprint: job.stageFingerprints?.[checkpoint.stage] ??
      checkpoint.stageFingerprint,
    providerFingerprint: job.providerFingerprint ?? checkpoint.providerFingerprint,
    artifactIds,
    metadata: {
      ...(checkpoint.metadata ?? {}),
      recoveredFromLocalArtifactGateFailure: true,
      graphWorkspace: "book_scoped",
      repairMode: "producer_manifest_and_checkpoint_only",
    },
  });
  printJson({
    status: "repaired",
    bookId,
    startedStage: null,
    nextStage: checkpoint.stage,
    completedStages: checkpoints
      .filter((item) => item.status === "succeeded")
      .map((item) => item.stage),
    queryResult: null,
    repairOnly: true,
    repairedLocalArtifactGate: true,
  });
}

async function run() {
  const runtimeApi = await importRuntime();
  GraphRagWorkflowNameSchemaRef = runtimeApi.GraphRagWorkflowNameSchema;
  const repo = new runtimeApi.FileBookJobStateRepository(stateRoot);
  if (values["repair-local-artifact-gate-only"]) {
    await runRepairLocalArtifactGateOnly(runtimeApi, repo);
    return;
  }
  const runtime = runtimeApi.createQmdGraphRagRuntime();

  runtimeApi.setConfigSource({ configPath });
  const projectConfig = runtimeApi.loadConfig();
  await runtimeApi.writeManagedGraphRagSettings({
    config: projectConfig,
    graphVault: stateRoot,
  });
  const { sourcePath, sourceIdentityPath, normalizedPath } =
    await resolveWorkspaceInputs();
  let {
    sync,
    scopedInputDir,
    scopedOutputDir,
  } = await syncCurrentBook(
    runtimeApi,
    projectConfig,
    sourcePath,
    sourceIdentityPath,
    normalizedPath,
  );

  let repairedLocalArtifactGate = false;
  for (let repairPass = 0; repairPass < 3; repairPass += 1) {
    const repaired = await repairLocalArtifactGateFailureIfPossible({
      runtimeApi,
      repo,
      sync,
      scopedOutputDir,
    });
    if (!repaired) break;
    repairedLocalArtifactGate = true;
    ({ sync, scopedInputDir, scopedOutputDir } = await syncCurrentBook(
      runtimeApi,
      projectConfig,
      sourcePath,
      sourceIdentityPath,
      normalizedPath,
    ));
  }

  const nextStage = sync.resumePlan.nextStage;
  if (values["repair-local-artifact-gate-only"]) {
    printJson({
      status: repairedLocalArtifactGate
        ? "repaired"
        : nextStage == null ? "ready" : "blocked",
      bookId: sync.job.bookId,
      startedStage: null,
      nextStage,
      completedStages: sync.resumePlan.completedStages,
      queryResult: null,
      repairOnly: true,
      repairedLocalArtifactGate,
      reason: repairedLocalArtifactGate || nextStage == null
        ? undefined
        : "local artifact gate repair did not complete the next stage",
    });
    return;
  }
  if (nextStage == null) {
    await refreshOutputProducerManifestFromCheckpoints(
      runtimeApi,
      repo,
      sync,
      scopedOutputDir,
    );
    let queryResult = null;
    if (values.query) {
      queryResult = await runtime.graphQuery({
        rootDir: stateRoot,
        dataDir: scopedOutputDir,
        method: values["query-method"],
        query: values.query,
        responseType: "multiple paragraphs",
        capabilityScope: await graphQueryScopeFromSync(
          sync,
          runtimeApi.loadGraphQueryCapabilities,
        ),
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
    await refreshOutputProducerManifestFromCheckpoints(
      runtimeApi,
      repo,
      sync,
      scopedOutputDir,
    );
    const runId = reusableRunIdForStage(sync, nextStage) ??
      runtimeApi.createRunId(nextStage);
    const inputFingerprint = sync.stageFingerprints[nextStage];
    await repo.startStage({
      bookId: sync.job.bookId,
      stage: nextStage,
      runId,
      inputFingerprint,
      contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
      stageFingerprint: inputFingerprint,
      providerFingerprint: sync.job.providerFingerprint,
      metadata: {
        graphWorkspace: "book_scoped",
        readinessSource: "real_stage_checkpoints",
      },
    });
    let refreshed;
    try {
      await runtimeApi.writeGraphRagOutputProducerManifest({
        outputDir: scopedOutputDir,
        bookId: sync.job.bookId,
        sourceHash: sync.job.sourceHash,
        documentId: sync.job.documentId,
        contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
        stageFingerprints: sync.stageFingerprints,
        providerFingerprint: sync.job.providerFingerprint,
        producerRunId: runId,
        stage: nextStage,
      });
      const queryReadyArtifacts = await queryReadyProducerArtifacts(
        runtimeApi,
        repo,
        sync,
      );
      await repo.completeStage({
        bookId: sync.job.bookId,
        stage: nextStage,
        runId,
        inputFingerprint,
        contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
        stageFingerprint: inputFingerprint,
        providerFingerprint: sync.job.providerFingerprint,
        artifactIds: queryReadyArtifacts.artifactIds,
        metadata: {
          graphWorkspace: "book_scoped",
          readinessSource: "real_stage_checkpoints",
          producerRunIds: queryReadyArtifacts.producerRunIds,
        },
      });
      ({ sync: refreshed } = await syncCurrentBook(
        runtimeApi,
        projectConfig,
        sourcePath,
        sourceIdentityPath,
        normalizedPath,
      ));
    } catch (error) {
      await repo.failStage({
        bookId: sync.job.bookId,
        stage: nextStage,
        runId,
        inputFingerprint,
        contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
        stageFingerprint: inputFingerprint,
        providerFingerprint: sync.job.providerFingerprint,
        errorSummary: safeText(runtimeApi, error instanceof Error
          ? error.message
          : String(error)),
        metadata: {
          graphWorkspace: "book_scoped",
          readinessSource: "real_stage_checkpoints",
        },
      });
      throw error;
    }

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

  const runId = reusableRunIdForStage(sync, nextStage) ??
    runtimeApi.createRunId(nextStage);
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
    const stageLogStartOffset = await runtimeApi.graphRagIndexLogOffset(
      scopedOutputDir,
      join(reportRoot, sync.job.bookId, nextStage),
    );
    const indexResult = await runtime.graphIndex({
      rootDir: stateRoot,
      inputDir: scopedInputDir,
      dataDir: scopedOutputDir,
      reportDir: join(reportRoot, sync.job.bookId, nextStage),
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
    const stageReportHealth = await runtimeApi.assertGraphRagStageReportHealthy({
      outputDir: scopedOutputDir,
      reportDir: join(reportRoot, sync.job.bookId, nextStage),
      stage: nextStage,
      logStartOffset: stageLogStartOffset,
    });

    await runtimeApi.writeGraphRagOutputProducerManifest({
      outputDir: scopedOutputDir,
      bookId: sync.job.bookId,
      sourceHash: sync.job.sourceHash,
      documentId: sync.job.documentId,
      contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
      stageFingerprints: sync.stageFingerprints,
      providerFingerprint: sync.job.providerFingerprint,
      producerRunId: runId,
      stage: nextStage,
    });

    const { sync: stageSynced } = await syncCurrentBook(
      runtimeApi,
      projectConfig,
      sourcePath,
      sourceIdentityPath,
      normalizedPath,
    );
    const stageArtifactIds = await runtimeApi.assertGraphRagStageArtifactsReady({
      stateRootDir: stateRoot,
      bookId: sync.job.bookId,
      stage: nextStage,
      producerRunId: runId,
      artifacts: stageSynced.artifacts,
      expectedStageFingerprints: sync.job.stageFingerprints,
      expectedProviderFingerprint: sync.job.providerFingerprint,
      expectedCorpusContentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
    });
    await repo.completeStage({
      bookId: sync.job.bookId,
      stage: nextStage,
      runId,
      inputFingerprint,
      contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
      stageFingerprint: sync.stageFingerprints[nextStage],
      providerFingerprint: sync.job.providerFingerprint,
      artifactIds: stageArtifactIds,
      metadata: {
        workflows,
        resumedFrom: nextStage,
        graphWorkspace: "book_scoped",
        stageReportHealth,
      },
    });

    const { sync: refreshed } = await syncCurrentBook(
      runtimeApi,
      projectConfig,
      sourcePath,
      sourceIdentityPath,
      normalizedPath,
    );

    let queryResult = null;
    if (values.query && refreshed.resumePlan.nextStage == null) {
      queryResult = await runtime.graphQuery({
        rootDir: stateRoot,
        dataDir: scopedOutputDir,
        method: values["query-method"],
        query: values.query,
        responseType: "multiple paragraphs",
        capabilityScope: await graphQueryScopeFromSync(
          refreshed,
          runtimeApi.loadGraphQueryCapabilities,
        ),
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
      contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
      stageFingerprint: sync.stageFingerprints[nextStage],
      providerFingerprint: sync.job.providerFingerprint,
      errorSummary: safeText(runtimeApi, error instanceof Error
        ? error.message
        : String(error)),
      metadata: {
        resumedFrom: nextStage,
        graphWorkspace: "book_scoped",
      },
    });
    throw error;
  }
}

run().catch((error) => {
  importRuntime()
    .then((runtimeApi) => {
      console.error(safeText(runtimeApi, errorText(error)));
    })
    .catch(() => {
      console.error("[redacted]");
    });
  process.exitCode = 1;
});
