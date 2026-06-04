#!/usr/bin/env node

import { cwd } from "node:process";
import { basename, join, resolve } from "node:path";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import YAML from "yaml";
import {
  cleanHotplugStageOutputFiles,
  hotplugStageClosureRebuildStage,
  missingHotplugStageOutputFiles,
} from "./hotplug-stage-closure.mjs";
import {
  convergeHotplugOrphanRunningStages,
} from "./hotplug-orphan-stage-convergence.mjs";

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
    cleanFailedGraphRagStageOutputs: indexModule.cleanFailedGraphRagStageOutputs,
    graphRagBookInputDir: indexModule.graphRagBookInputDir,
    graphRagBookOutputDir: indexModule.graphRagBookOutputDir,
    assertGraphRagStageArtifactsReady: indexModule.assertGraphRagStageArtifactsReady,
    graphRagIndexLogOffset: indexModule.graphRagIndexLogOffset,
    loadGraphQueryCapabilities: indexModule.loadGraphQueryCapabilities,
    refreshGraphRagStageOutputDurableSidecars:
      indexModule.refreshGraphRagStageOutputDurableSidecars,
    syncGraphRagBookWorkspace: indexModule.syncGraphRagBookWorkspace,
    writeGraphRagOutputProducerManifest: indexModule.writeGraphRagOutputProducerManifest,
    DurableStateError: indexModule.DurableStateError,
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

function numberEnv(name) {
  const value = process.env[name];
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function durableFailureEnvelope(runtimeApi, error) {
  if (!runtimeApi?.DurableStateError || !(error instanceof runtimeApi.DurableStateError)) {
    return null;
  }
  const evidence = error.evidence ?? {};
  const output = {
    marker: "QMD_GRAPHRAG_DURABLE_FAILURE",
    schemaVersion: "1.0.0",
    status: "failed",
    failureKind: error.failureKind ?? "local_state_integrity",
    localFailureClass: error.localFailureClass,
    retryable: false,
    recoveryDecision: error.recoveryDecision ?? "stop_until_fixed",
    failedStage: process.env.QMD_GRAPHRAG_COMMAND_NAME ?? error.failedStage ??
      "resume-book",
    targetLocator: evidence.targetLocator,
    redactedEvidenceLocator: evidence.redactedEvidenceLocator,
    lane: evidence.lane,
    targetMappingOwner: evidence.targetMappingOwner,
    laneTimeoutMs: evidence.laneTimeoutMs,
    releaseOn: evidence.releaseOn,
    tempId: evidence.tempId,
    operationId: evidence.operationId,
    failedSyscall: evidence.failedSyscall,
    errno: evidence.errno,
    renameCause: evidence.renameCause,
    lockOwnerEvidence: evidence.lockOwnerEvidence,
    checksumRecoveryDecision: evidence.checksumRecoveryDecision,
    cleanupReason: evidence.cleanupReason,
    fsyncTarget: evidence.fsyncTarget,
    fsyncErrno: evidence.fsyncErrno,
    fsyncPlatform: evidence.fsyncPlatform,
    durableMode: evidence.durableMode,
    primaryTargetLocator: evidence.primaryTargetLocator,
    auxiliaryTargetLocator: evidence.auxiliaryTargetLocator,
    auxiliarySidecarKind: evidence.auxiliarySidecarKind,
    sidecarTargetLocator: evidence.sidecarTargetLocator,
    sidecarKind: evidence.sidecarKind,
    checksumExpected: evidence.checksumExpected,
    checksumActual: evidence.checksumActual,
    repairAllowed: evidence.repairAllowed,
    statusJsonDecision: evidence.statusJsonDecision,
    diagnosticClass: evidence.diagnosticClass,
    evidenceIncomplete: evidence.evidenceIncomplete,
    evidenceIncompleteReason: evidence.evidenceIncompleteReason,
    unavailableFieldSentinels: evidence.unavailableFieldSentinels,
    completedPublishRule: evidence.completedPublishRule ?? "forbidden",
    itemId: evidence.itemId ?? process.env.QMD_GRAPHRAG_ITEM_ID,
    bookId: evidence.bookId ?? process.env.QMD_GRAPHRAG_BOOK_ID,
    workerId: evidence.workerId ?? process.env.QMD_GRAPHRAG_WORKER_ID,
    leaseGeneration: evidence.leaseGeneration ??
      numberEnv("QMD_GRAPHRAG_BOOK_LEASE_GENERATION"),
    bookLeaseGeneration: evidence.bookLeaseGeneration,
    ownerPid: evidence.ownerPid,
    ownerHost: evidence.ownerHost,
    runnerSessionId: evidence.runnerSessionId,
    createdAt: evidence.createdAt,
    expiresAt: evidence.expiresAt,
    targetGeneration: evidence.targetGeneration,
    fencingTokenHash: evidence.fencingTokenHash,
  };
  return Object.fromEntries(
    Object.entries(output).filter(([, value]) => value !== undefined),
  );
}

function stageFailureKind(error) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    message.includes("partial-output") ||
    message.includes("partial output") ||
    message.includes("no report found for community") ||
    message.includes("community report extraction error") ||
    message.includes("error generating community report")
  ) {
    return "partial_output";
  }
  if (
    message.includes("concurrency limit") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("service unavailable") ||
    message.includes("gateway timeout") ||
    message.includes("bad gateway") ||
    message.includes("connection reset") ||
    message.includes("socket hang up")
  ) {
    return "transient";
  }
  return undefined;
}

function stageFailureMetadata(error) {
  const failureKind = stageFailureKind(error);
  return failureKind == null ? {} : { failureKind };
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
  const artifacts = currentArtifactsForSync(sync.artifacts, sync).filter((artifact) =>
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
  const lineageArtifactIds = [...new Set([
    ...artifacts.map((artifact) => artifact.artifactId),
    ...artifactIds,
  ])];
  return {
    artifactIds,
    lineageArtifactIds,
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
    message.includes("query_ready requires completed graph_extract") ||
    message.includes("query_ready checkpoint requires completed graphrag producer stages") ||
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
    message.includes("artifact_not_book_scoped_graph_output") ||
    message.includes("graphrag document identity is missing for query_ready") ||
    message.includes("graphrag document identity sidecar evidence is invalid for query_ready") ||
    message.includes("graphrag document identity sidecar does not match query_ready") ||
    message.includes("graph_vault/settings.yaml is not the managed projection of .qmd/index.yml") ||
    message.includes("capabilityscope references unknown or not-ready graphcapabilityid") ||
    message.includes("no graph_query capability is ready for book")
  );
}

function producerRunIdsFromCheckpoints(checkpoints) {
  return Object.fromEntries(
    ["graph_extract", "community_report", "embed", "query_ready"]
      .flatMap((stage) => {
        const checkpoint = checkpoints.find((item) =>
          item.stage === stage &&
          item.status === "succeeded" &&
          typeof item.runId === "string"
        );
        return checkpoint == null ? [] : [[stage, checkpoint.runId]];
      }),
  );
}

function producerRunIdsFromManifest(manifest) {
  const values = manifest?.stageProducerRunIds;
  if (values == null || typeof values !== "object") return {};
  return Object.fromEntries(
    ["graph_extract", "community_report", "embed", "query_ready"]
      .filter((stage) => typeof values[stage] === "string")
      .map((stage) => [stage, values[stage]]),
  );
}

function graphRagBookOutputLocator(bookId) {
  return `books/${bookId}/graphrag/output`;
}

function outputProducerManifestMatchesSync(manifest, sync) {
  if (manifest == null || typeof manifest !== "object") return false;
  const contentHash = sync.job.normalizedContentHash ?? sync.job.sourceHash;
  const stages = ["graph_extract", "community_report", "embed", "query_ready"];
  return manifest.schemaVersion === "1.0.0" &&
    manifest.bookId === sync.job.bookId &&
    manifest.sourceHash === sync.job.sourceHash &&
    manifest.documentId === sync.job.documentId &&
    manifest.contentHash === contentHash &&
    manifest.providerFingerprint === sync.job.providerFingerprint &&
    manifest.outputDir === graphRagBookOutputLocator(sync.job.bookId) &&
    stages.every((stage) =>
      manifest.stageFingerprints?.[stage] === sync.stageFingerprints[stage]
    );
}

function mergeProducerRunIds(...items) {
  return Object.assign({}, ...items);
}

function isArtifactCurrentForSync(artifact, sync) {
  const expectedContentHash = sync.job.normalizedContentHash ?? sync.job.sourceHash;
  if (artifact.bookId !== sync.job.bookId) return false;
  if (artifact.stageFingerprint !== sync.stageFingerprints[artifact.stage]) {
    return false;
  }
  if (artifact.providerFingerprint !== sync.job.providerFingerprint) {
    return false;
  }
  if (
    (String(artifact.kind).startsWith("graphrag_") ||
      artifact.kind === "lancedb_index") &&
    artifact.metadata?.corpusContentHash !== expectedContentHash
  ) {
    return false;
  }
  return true;
}

function currentArtifactsForSync(artifacts, sync) {
  return artifacts.filter((artifact) => isArtifactCurrentForSync(artifact, sync));
}

async function readOutputProducerManifest(outputDir) {
  try {
    return JSON.parse(
      await readFile(resolve(outputDir, "qmd_output_manifest.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

function localArtifactGateFailureCheckpoint(checkpoints) {
  return checkpoints.find((item) =>
    item.status === "failed" &&
    typeof item.runId === "string" &&
    isLocalArtifactGateError(item.errorSummary)
  ) ?? null;
}

function localArtifactGateProjectionFailureCheckpoint(checkpoints) {
  return checkpoints.find((item) =>
    item.status === "failed" &&
    isLocalArtifactGateError(item.errorSummary)
  ) ?? null;
}

async function completeProducerStageFromEvidence({
  runtimeApi,
  repo,
  sync,
  stage,
  producerRunId,
  sourceMetadata,
}) {
  if (typeof producerRunId !== "string" || producerRunId.length === 0) {
    return false;
  }
  const checkpoints = await repo.listStageCheckpoints(sync.job.bookId);
  const existing = checkpoints.find((item) => item.stage === stage);
  if (
    existing?.status === "succeeded" &&
    existing.runId === producerRunId
  ) {
    return false;
  }
  const artifacts = await repo.listArtifacts(sync.job.bookId);
  const currentArtifacts = currentArtifactsForSync(artifacts, sync);
  const artifactIds = await runtimeApi.assertGraphRagStageArtifactsReady({
    stateRootDir: stateRoot,
    bookId: sync.job.bookId,
    stage,
    producerRunId,
    artifacts: currentArtifacts,
    expectedStageFingerprints: sync.job.stageFingerprints,
    expectedProviderFingerprint: sync.job.providerFingerprint,
    expectedCorpusContentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
  });
  await repo.completeStage({
    bookId: sync.job.bookId,
    stage,
    runId: producerRunId,
    inputFingerprint: sync.stageFingerprints[stage],
    contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
    stageFingerprint: sync.stageFingerprints[stage],
    providerFingerprint: sync.job.providerFingerprint,
    artifactIds,
    metadata: {
      ...(existing?.metadata ?? {}),
      recoveredFromLocalArtifactGateFailure: true,
      graphWorkspace: "book_scoped",
      repairMode: "producer_manifest_and_checkpoint_only",
      sourceFailureStage: sourceMetadata?.stage,
      sourceFailureRunId: sourceMetadata?.runId,
      sourceFailureSummary: sourceMetadata?.errorSummary,
    },
  });
  return true;
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

async function graphQueryScopeFromReadyBook(runtimeApi, repo, sync) {
  const queryReady = (await repo.listStageCheckpoints(sync.job.bookId))
    .find((item) =>
      item.stage === "query_ready" &&
      item.status === "succeeded" &&
      Array.isArray(item.artifactIds) &&
      item.artifactIds.length > 0
    );
  if (queryReady == null) {
    return graphQueryScopeFromSync(sync, runtimeApi.loadGraphQueryCapabilities);
  }
  const producerArtifacts = await queryReadyProducerArtifacts(
    runtimeApi,
    repo,
    sync,
  );
  await repo.publishQueryReadyGraphCapabilities(sync.job.bookId);
  return {
    selectedBookIds: [sync.job.bookId],
    graphCapabilityIds: [`${sync.job.bookId}:graph_query`],
    sourceIds: [`sha256:${sync.job.sourceHash}`],
    documentIds: [sync.job.documentId],
    contentHashes: [sync.job.normalizedContentHash ?? sync.job.sourceHash],
    artifactIds: producerArtifacts.lineageArtifactIds,
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
  if (resolve(normalizedPath) === target) {
    return target;
  }
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
    outputDir: runtimeApi.graphRagBookOutputDir({
      stateRootDir: stateRoot,
      bookId: runtimeApi.buildBookIdFromSourceHash(
        sourceIdentityPath,
        await runtimeApi.hashFile(sourcePath),
      ),
    }),
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

function settingsProjectionRepairForOutput(sync) {
  const repair = sync.settingsProjectionRepair;
  if (repair == null) return undefined;
  return {
    decision: repair.decision,
    rewritten: repair.rewritten,
    sourceFingerprint: repair.sourceFingerprint,
    settingsPath: repair.settingsPath,
    evidenceLocator: repair.evidenceLocator,
    reason: repair.reason,
  };
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
      repo,
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

async function restoreProducerManifestFromEvidence({
  runtimeApi,
  repo,
  sync,
  scopedOutputDir,
}) {
  const checkpoints = await repo.listStageCheckpoints(sync.job.bookId);
  const currentManifest = await readOutputProducerManifest(scopedOutputDir);
  const manifestProducerRunIds = outputProducerManifestMatchesSync(
    currentManifest,
    sync,
  )
    ? producerRunIdsFromManifest(currentManifest)
    : {};
  const producerRunIds = mergeProducerRunIds(
    manifestProducerRunIds,
    producerRunIdsFromCheckpoints(checkpoints),
  );
  for (const stage of ["graph_extract", "community_report", "embed", "query_ready"]) {
    const producerRunId = producerRunIds[stage];
    if (typeof producerRunId !== "string") continue;
    await runtimeApi.writeGraphRagOutputProducerManifest({
      outputDir: scopedOutputDir,
      repo,
      bookId: sync.job.bookId,
      sourceHash: sync.job.sourceHash,
      documentId: sync.job.documentId,
      contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
      stageFingerprints: sync.stageFingerprints,
      providerFingerprint: sync.job.providerFingerprint,
      producerRunId,
      stage,
    });
  }
  return producerRunIds;
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
    repo,
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

async function repairQueryReadyProjectionIfPossible({
  runtimeApi,
  repo,
  projectConfig,
  sourcePath,
  sourceIdentityPath,
  normalizedPath,
  sync,
  scopedOutputDir,
  producerRunIds,
}) {
  if (
    sync.resumePlan.nextStage != null &&
    sync.resumePlan.nextStage !== "query_ready"
  ) {
    return null;
  }

  const queryReadyArtifacts = await queryReadyProducerArtifacts(runtimeApi, repo, sync);
  const queryReadyCheckpoint = (await repo.listStageCheckpoints(sync.job.bookId))
    .find((item) => item.stage === "query_ready");
  const runId = queryReadyCheckpoint?.runId ??
    producerRunIds.query_ready ??
    runtimeApi.createRunId("query_ready");

  await repo.completeStage({
    bookId: sync.job.bookId,
    stage: "query_ready",
    runId,
    inputFingerprint: sync.stageFingerprints.query_ready,
    contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
    stageFingerprint: sync.stageFingerprints.query_ready,
    providerFingerprint: sync.job.providerFingerprint,
    artifactIds: queryReadyArtifacts.artifactIds,
    metadata: {
      ...(queryReadyCheckpoint?.metadata ?? {}),
      graphWorkspace: "book_scoped",
      readinessSource: "local_artifact_gate_repair",
      producerRunIds: queryReadyArtifacts.producerRunIds,
      recoveredFromLocalArtifactGateFailure: true,
      repairMode: "query_ready_projection_only",
    },
  });

  const refreshed = await syncCurrentBook(
    runtimeApi,
    projectConfig,
    sourcePath,
    sourceIdentityPath,
    normalizedPath,
  );
  const restoredProducerRunIds = await restoreProducerManifestFromEvidence({
    runtimeApi,
    repo,
    sync: refreshed.sync,
    scopedOutputDir: refreshed.scopedOutputDir,
  });
  const mergedProducerRunIds = mergeProducerRunIds(
    producerRunIds,
    restoredProducerRunIds,
    { query_ready: runId },
  );
  await graphQueryScopeFromSync(
    refreshed.sync,
    runtimeApi.loadGraphQueryCapabilities,
  );

  return {
    sync: refreshed.sync,
    scopedOutputDir: refreshed.scopedOutputDir,
    producerRunIds: mergedProducerRunIds,
    repairedCheckpointStages: ["query_ready"],
  };
}

async function runRepairLocalArtifactGateOnly(runtimeApi, repo) {
  runtimeApi.setConfigSource({ configPath });
  const projectConfig = runtimeApi.loadConfig();
  const { sourcePath, sourceIdentityPath, normalizedPath } =
    await resolveWorkspaceInputs();
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
      requiresRealRebuild: false,
      settingsProjectionRepair: undefined,
      reason: "book state not found for local artifact gate repair",
    });
    return;
  }
  let checkpoints = await repo.listStageCheckpoints(bookId);
  let checkpoint = localArtifactGateFailureCheckpoint(checkpoints);
  let { sync, scopedOutputDir } = await syncCurrentBook(
    runtimeApi,
    projectConfig,
    sourcePath,
    sourceIdentityPath,
    normalizedPath,
  );
  let producerRunIds = await restoreProducerManifestFromEvidence({
    runtimeApi,
    repo,
    sync,
    scopedOutputDir,
  });
  if (checkpoint == null) {
    try {
      const repairedProjection = await repairQueryReadyProjectionIfPossible({
        runtimeApi,
        repo,
        projectConfig,
        sourcePath,
        sourceIdentityPath,
        normalizedPath,
        sync,
        scopedOutputDir,
        producerRunIds,
      });
      if (repairedProjection != null) {
        sync = repairedProjection.sync;
        scopedOutputDir = repairedProjection.scopedOutputDir ?? scopedOutputDir;
        producerRunIds = repairedProjection.producerRunIds;
        checkpoints = await repo.listStageCheckpoints(bookId);
        printJson({
          status: "repaired",
          bookId,
          startedStage: null,
          nextStage: sync.resumePlan.nextStage,
          completedStages: checkpoints
            .filter((item) => item.status === "succeeded")
            .map((item) => item.stage),
          queryResult: null,
          repairOnly: true,
          repairedLocalArtifactGate: true,
          requiresRealRebuild: false,
          repairReason: "graph_query_capability_projection_missing",
          repairedProjection: "graph_capability",
          repairEvidenceLocator:
            `graph_vault/books/${bookId}/state/checkpoints.yaml#query_ready`,
          reusedProducerRunIds: producerRunIds,
          repairedCheckpointStages:
            repairedProjection.repairedCheckpointStages,
          repairedFailedStage: null,
          settingsProjectionRepair: settingsProjectionRepairForOutput(sync),
        });
        return;
      }
    } catch (error) {
      const reason = safeText(runtimeApi, error instanceof Error
        ? error.message
        : String(error));
      printJson({
        status: "blocked",
        bookId,
        startedStage: null,
        nextStage: sync.resumePlan.nextStage,
        completedStages: checkpoints
          .filter((item) => item.status === "succeeded")
          .map((item) => item.stage),
        queryResult: null,
        repairOnly: true,
        repairedLocalArtifactGate: false,
        requiresRealRebuild: false,
        rebuildStage: null,
        settingsProjectionRepair: settingsProjectionRepairForOutput(sync),
        reason,
      });
      return;
    }
    printJson({
      status: "blocked",
      bookId,
      startedStage: null,
      nextStage: sync.resumePlan.nextStage,
      completedStages: checkpoints
        .filter((item) => item.status === "succeeded")
        .map((item) => item.stage),
      queryResult: null,
      repairOnly: true,
      repairedLocalArtifactGate: false,
      requiresRealRebuild: sync.resumePlan.nextStage != null,
      rebuildStage:
        checkpoints.find((item) => item.status === "failed")?.stage ??
        sync.resumePlan.nextStage ??
        null,
      settingsProjectionRepair: settingsProjectionRepairForOutput(sync),
      reason: "local artifact gate failure checkpoint not found",
    });
    return;
  }

  let repairedCheckpointStages = [];
  for (const stage of ["graph_extract", "community_report", "embed"]) {
    const repaired = await completeProducerStageFromEvidence({
      runtimeApi,
      repo,
      sync,
      stage,
      producerRunId: producerRunIds[stage],
      sourceMetadata: checkpoint,
    });
    if (repaired) {
      repairedCheckpointStages.push(stage);
      ({ sync, scopedOutputDir } = await syncCurrentBook(
        runtimeApi,
        projectConfig,
        sourcePath,
        sourceIdentityPath,
        normalizedPath,
      ));
      producerRunIds = mergeProducerRunIds(
        producerRunIds,
        await restoreProducerManifestFromEvidence({
          runtimeApi,
          repo,
          sync,
          scopedOutputDir,
        }),
      );
    }
  }
  for (let repairPass = 0; repairPass < 3; repairPass += 1) {
    const repaired = await repairLocalArtifactGateFailureIfPossible({
      runtimeApi,
      repo,
      sync,
      scopedOutputDir,
    });
    if (!repaired) break;
    repairedCheckpointStages.push(sync.resumePlan.nextStage);
    ({ sync, scopedOutputDir } = await syncCurrentBook(
      runtimeApi,
      projectConfig,
      sourcePath,
      sourceIdentityPath,
      normalizedPath,
    ));
    producerRunIds = mergeProducerRunIds(
      producerRunIds,
      await restoreProducerManifestFromEvidence({
        runtimeApi,
        repo,
        sync,
        scopedOutputDir,
      }),
    );
  }

  checkpoints = await repo.listStageCheckpoints(bookId);
  checkpoint = localArtifactGateProjectionFailureCheckpoint(checkpoints) ?? checkpoint;
  let repairReason = "graph_query_capability_projection_missing";
  let repairEvidenceLocator =
    `graph_vault/books/${bookId}/graphrag/output/qmd_output_manifest.json`;
  let repairedProjection = "graph_capability";
  try {
    await graphQueryScopeFromSync(sync, runtimeApi.loadGraphQueryCapabilities);
    repairReason = "graph_identity_projection_missing";
    repairedProjection = "document_identity_map";
    repairEvidenceLocator =
      `graph_vault/books/${bookId}/graphrag/output/qmd_graph_text_unit_identity.json`;
  } catch {
    if (sync.resumePlan.nextStage === "query_ready") {
      const queryReadyArtifacts = await queryReadyProducerArtifacts(
        runtimeApi,
        repo,
        sync,
      );
      const runId = producerRunIds.query_ready ?? runtimeApi.createRunId("query_ready");
      await repo.completeStage({
        bookId,
        stage: "query_ready",
        runId,
        inputFingerprint: sync.stageFingerprints.query_ready,
        contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
        stageFingerprint: sync.stageFingerprints.query_ready,
        providerFingerprint: sync.job.providerFingerprint,
        artifactIds: queryReadyArtifacts.artifactIds,
        metadata: {
          graphWorkspace: "book_scoped",
          readinessSource: "local_artifact_gate_repair",
          producerRunIds: queryReadyArtifacts.producerRunIds,
          recoveredFromLocalArtifactGateFailure: true,
          repairMode: "query_ready_projection_only",
        },
      });
      producerRunIds = mergeProducerRunIds(producerRunIds, { query_ready: runId });
      ({ sync, scopedOutputDir } = await syncCurrentBook(
        runtimeApi,
        projectConfig,
        sourcePath,
        sourceIdentityPath,
        normalizedPath,
      ));
      await restoreProducerManifestFromEvidence({
        runtimeApi,
        repo,
        sync,
        scopedOutputDir,
      });
      repairReason = "graph_query_capability_projection_missing";
      repairedProjection = "graph_capability";
      repairEvidenceLocator =
        `graph_vault/books/${bookId}/state/checkpoints.yaml#query_ready`;
      await graphQueryScopeFromSync(sync, runtimeApi.loadGraphQueryCapabilities);
    } else {
      printJson({
        status: "blocked",
        bookId,
        startedStage: null,
        nextStage: sync.resumePlan.nextStage,
        completedStages: sync.resumePlan.completedStages,
        queryResult: null,
        repairOnly: true,
        repairedLocalArtifactGate: false,
        requiresRealRebuild: true,
        rebuildStage: sync.resumePlan.nextStage ?? null,
        repairedCheckpointStages,
        repairedFailedStage: checkpoint?.stage,
        reusedProducerRunIds: producerRunIds,
        settingsProjectionRepair: settingsProjectionRepairForOutput(sync),
        reason: `real GraphRAG rebuild required for ${
          sync.resumePlan.nextStage ?? "unknown"
        }`,
      });
      return;
    }
  }
  checkpoints = await repo.listStageCheckpoints(bookId);

  printJson({
    status: "repaired",
    bookId,
    startedStage: null,
    nextStage: sync.resumePlan.nextStage,
    completedStages: checkpoints
      .filter((item) => item.status === "succeeded")
      .map((item) => item.stage),
    queryResult: null,
    repairOnly: true,
    repairedLocalArtifactGate: true,
    requiresRealRebuild: false,
    repairReason,
    repairedProjection,
    repairEvidenceLocator,
    reusedProducerRunIds: producerRunIds,
    repairedCheckpointStages,
    repairedFailedStage: checkpoint?.stage,
    settingsProjectionRepair: settingsProjectionRepairForOutput(sync),
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
  const resyncCurrent = () => syncCurrentBook(
    runtimeApi,
    projectConfig,
    sourcePath,
    sourceIdentityPath,
    normalizedPath,
  );
  let orphanStageConvergence = [];
  const convergence = await convergeHotplugOrphanRunningStages({
    runtimeApi,
    repo,
    sync,
    scopedOutputDir,
    resync: resyncCurrent,
  });
  if (convergence.converged.length > 0) {
    orphanStageConvergence = convergence.converged;
    ({ sync, scopedInputDir, scopedOutputDir } = await resyncCurrent());
  }

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

  const hotplugClosureRebuildStage = hotplugStageClosureRebuildStage(
    scopedOutputDir,
    sync.resumePlan,
  );
  const hotplugClosureRepair = hotplugClosureRebuildStage == null
    ? undefined
    : {
        stage: hotplugClosureRebuildStage,
        missingFiles: missingHotplugStageOutputFiles(
          scopedOutputDir,
          hotplugClosureRebuildStage,
        ),
      };
  const nextStage = hotplugClosureRebuildStage ?? sync.resumePlan.nextStage;
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
      orphanStageConvergence,
      hotplugClosureRepair,
      settingsProjectionRepair: settingsProjectionRepairForOutput(sync),
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
    let readyProjectionRepair = null;
    let queryCapabilityScope = null;
    if (values.query) {
      try {
        queryCapabilityScope = await graphQueryScopeFromReadyBook(
          runtimeApi,
          repo,
          sync,
        );
      } catch {
        const producerRunIds = await restoreProducerManifestFromEvidence({
          runtimeApi,
          repo,
          sync,
          scopedOutputDir,
        });
        const repaired = await repairQueryReadyProjectionIfPossible({
          runtimeApi,
          repo,
          projectConfig,
          sourcePath,
          sourceIdentityPath,
          normalizedPath,
          sync,
          scopedOutputDir,
          producerRunIds,
        });
        if (repaired != null) {
          sync = repaired.sync;
          scopedOutputDir = repaired.scopedOutputDir ?? scopedOutputDir;
          readyProjectionRepair = {
            repairReason: "graph_query_capability_projection_missing",
            repairedProjection: "graph_capability",
            repairedCheckpointStages: repaired.repairedCheckpointStages,
          };
          queryCapabilityScope = await graphQueryScopeFromReadyBook(
            runtimeApi,
            repo,
            sync,
          );
        } else {
          throw new Error(
            `no graph_query capability is ready for book ${sync.job.bookId}`,
          );
        }
      }
    }
    let queryResult = null;
    if (values.query) {
      queryResult = await runtime.graphQuery({
        rootDir: stateRoot,
        dataDir: scopedOutputDir,
        method: values["query-method"],
        query: values.query,
        responseType: "multiple paragraphs",
        capabilityScope: queryCapabilityScope,
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
      orphanStageConvergence,
      readyProjectionRepair,
      settingsProjectionRepair: settingsProjectionRepairForOutput(sync),
      hotplugClosureRepair,
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
        repo,
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
      orphanStageConvergence,
      settingsProjectionRepair: settingsProjectionRepairForOutput(refreshed),
      hotplugClosureRepair,
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
      orphanStageConvergence,
      settingsProjectionRepair: settingsProjectionRepairForOutput(sync),
      hotplugClosureRepair,
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
  const previousStageCheckpoint = await repo.getStageCheckpoint(
    sync.job.bookId,
    nextStage,
  );
  const residualCleanup = hotplugClosureRebuildStage === nextStage
    ? await cleanHotplugStageOutputFiles(scopedOutputDir, nextStage)
    : await runtimeApi.cleanFailedGraphRagStageOutputs({
        outputDir: scopedOutputDir,
        stage: nextStage,
        previousCheckpoint: previousStageCheckpoint,
      });

  await repo.startStage({
    bookId: sync.job.bookId,
    stage: nextStage,
    runId,
    inputFingerprint,
    metadata: {
      workflows,
      resumedFrom: nextStage,
      ...(hotplugClosureRepair == null ? {} : { hotplugClosureRepair }),
      residualCleanup,
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
    }, {
      earlyStop: {
        stage: nextStage,
        logStartOffset: stageLogStartOffset,
        logLocator: join("graphrag-reports", sync.job.bookId, nextStage, "indexing-engine.log"),
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
      repo,
      bookId: sync.job.bookId,
      sourceHash: sync.job.sourceHash,
      documentId: sync.job.documentId,
      contentHash: sync.job.normalizedContentHash ?? sync.job.sourceHash,
      stageFingerprints: sync.stageFingerprints,
      providerFingerprint: sync.job.providerFingerprint,
      producerRunId: runId,
      stage: nextStage,
    });
    const durableOutputRefresh =
      await runtimeApi.refreshGraphRagStageOutputDurableSidecars({
        outputDir: scopedOutputDir,
        repo,
        bookId: sync.job.bookId,
        stage: nextStage,
        producerRunId: runId,
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
        ...(hotplugClosureRepair == null ? {} : { hotplugClosureRepair }),
        residualCleanup,
        stageReportHealth,
        durableOutputRefresh,
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
        capabilityScope: await graphQueryScopeFromReadyBook(
          runtimeApi,
          repo,
          refreshed,
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
      orphanStageConvergence,
      settingsProjectionRepair: settingsProjectionRepairForOutput(refreshed),
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
        residualCleanup,
        ...stageFailureMetadata(error),
      },
    });
    throw error;
  }
}

run().catch((error) => {
  importRuntime()
    .then((runtimeApi) => {
      const envelope = durableFailureEnvelope(runtimeApi, error);
      if (envelope != null) {
        console.error(
          `QMD_GRAPHRAG_DURABLE_FAILURE ${JSON.stringify(envelope)}`,
        );
      }
      console.error(safeText(runtimeApi, errorText(error)));
    })
    .catch(() => {
      console.error("[redacted]");
    });
  process.exitCode = 1;
});
