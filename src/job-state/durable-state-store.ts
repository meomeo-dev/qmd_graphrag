import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  appendFileSync,
  writeSync,
} from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  appendFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { hostname } from "node:os";

import YAML from "yaml";

import {
  durableTargetNormalizationEvidence,
  normalizeDurableTargetForMapping,
} from "./durable-target-normalizer.js";
import { hashText } from "./fingerprint.js";

const DurableLockStaleMs = 120_000;
const DurableLockWaitMs = 300_000;
const DurableDefaultLaneTimeoutMs = 120_000;
const DurableTempStaleMs = 24 * 60 * 60 * 1000;
const DurableReleaseOn = ["commit", "error", "cancellation", "lease_loss", "timeout"];
const DurableRecoveryLogName = ".durable-recovery.jsonl";
const DurableAdapterContract = Object.freeze({
  schemaVersion: "1.0.0",
  boundary: "shared-durable-state-store",
  guarantees: [
    "targetMapping",
    "exclusiveTempCreate",
    "ownerEvidence",
    "checksumCommitMeta",
    "targetGenerationFence",
    "guardedLockRelease",
    "preflightReconcile",
    "localStateFailureProjection",
  ],
});
const Host = hostname();
const SessionId = process.env.QMD_GRAPHRAG_RUNNER_SESSION_ID ??
  `process-${process.pid}`;
let testRenameEnoentInjected = false;
let testDirectoryFsyncFailureInjected = false;
let testDirectoryFsyncFailureMatchCount = 0;

const DurableTargetMappingTable = [
  {
    pattern: /\/graph_vault\/catalog\/books\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
  },
  {
    pattern: /\/graph_vault\/catalog\/runs\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
  },
  {
    pattern: /\/graph_vault\/catalog\/sources\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
  },
  {
    pattern: /\/graph_vault\/catalog\/document-identity-map\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
  },
  {
    pattern: /\/graph_vault\/catalog\/graph-capabilities\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "capabilityCatalog",
  },
  {
    pattern: /\/graph_vault\/catalog\/qmd-projection\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "qmdProjectionCatalog",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/(?:job|artifacts|checkpoints)\.yaml$/,
    lane: "checkpointWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
  },
  {
    pattern:
      /\/graph_vault\/books\/[^/]+\/state\/(?:job|artifacts|checkpoints)\.yaml$/,
    lane: "checkpointWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "bookHotplugPackage",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/state\/hotplug-quality-gate\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "bookHotplugPackage",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/state\/hotplug-runtime-gate\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "bookHotplugPackage",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/runs\/[^/]+\.yaml$/,
    lane: "checkpointWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "repository",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/graphrag\/runs\/[^/]+\.yaml$/,
    lane: "checkpointWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "bookHotplugPackage",
  },
  {
    pattern: /\/graph_vault\/settings\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "settingsProjection",
  },
  {
    pattern: /\/graph_vault\/catalog\/batch-runs\/[^/]+\/items\/[^/]+\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /\/graph_vault\/catalog\/batch-runs\/[^/]+\/manifest\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /\/graph_vault\/catalog\/batch-runs\/[^/]+\/events\.jsonl$/,
    lane: "eventWriterLane",
    durableKind: "jsonl",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /\/graph_vault\/catalog\/batch-runs\/[^/]+\/status\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /\/graph_vault\/catalog\/batch-runs\/[^/]+\/recovery-summary\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /\/graph_vault\/catalog\/batch-runs\/[^/]+\/coordinator-lock\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /\/graph_vault\/catalog\/batch-runs\/[^/]+\/provider-slots\/[^/]+\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /\/graph_vault\/catalog\/batch-runs\/[^/]+\/subprocesses\/[^/]+\.json$/,
    lane: "manifestWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /\/graph_vault\/catalog\/batch-runs\/[^/]+\/book-leases\/[^/]+\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "batchCoordinator",
  },
  {
    pattern: /\/graph_vault\/catalog\/provider-requests\/[^/]+\.json$/,
    lane: "catalogWriterLane",
    durableKind: "json",
    targetMappingOwner: "providerRequestFingerprint",
  },
  {
    pattern: /\/graph_vault\/catalog\/cost-accounting\.jsonl$/,
    lane: "eventWriterLane",
    durableKind: "jsonl",
    targetMappingOwner: "providerCostAccounting",
  },
  {
    pattern: /\/graph_vault\/dspy\/.+\.yaml$/,
    lane: "catalogWriterLane",
    durableKind: "yaml",
    targetMappingOwner: "dspyPolicyStore",
  },
  {
    pattern: /\/graph_vault\/dspy\/.+\.json$/,
    lane: "catalogWriterLane",
    durableKind: "json",
    targetMappingOwner: "dspyPolicyStore",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/qmd\/qmd_build_manifest\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "qmd",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/BOOK_MANIFEST\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "bookHotplugPackage",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/PUBLISH_READY\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "bookHotplugPackage",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/output\/qmd_output_manifest\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/graphrag\/output\/qmd_output_manifest\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
  },
  {
    pattern:
      /\/graph_vault\/books\/[^/]+\/output\/qmd_graph_text_unit_identity\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
  },
  {
    pattern:
      /\/graph_vault\/books\/[^/]+\/graphrag\/output\/qmd_graph_text_unit_identity\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/output\/context\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/graphrag\/output\/context\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/output\/stats\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
  },
  {
    pattern: /\/graph_vault\/books\/[^/]+\/graphrag\/output\/stats\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
  },
  {
    pattern:
      /\/graph_vault\/books\/[^/]+\/graphrag\/output\/artifact-metadata\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "bookHotplugPackage",
  },
  {
    pattern:
      /\/graph_vault\/books\/[^/]+\/graphrag\/output\/runtime-compatibility\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "bookHotplugPackage",
  },
  {
    pattern:
      /\/graph_vault\/books\/[^/]+\/output\/qmd_durable_output_repair\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
  },
  {
    pattern:
      /\/graph_vault\/books\/[^/]+\/graphrag\/output\/qmd_durable_output_repair\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "graphOutputProducer",
  },
  {
    pattern:
      /\/graph_vault\/books\/[^/]+\/output\/lancedb\/[^/]+\.lance\/qmd_row_count\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "artifactValidation",
  },
  {
    pattern:
      /\/graph_vault\/books\/[^/]+\/graphrag\/output\/lancedb\/[^/]+\.lance\/qmd_row_count\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "artifactValidation",
  },
  {
    pattern: /\/graph_vault\/output\/lancedb\/[^/]+\.lance\/qmd_row_count\.json$/,
    lane: "checkpointWriterLane",
    durableKind: "json",
    targetMappingOwner: "artifactValidation",
  },
];

export class DurableStateError extends Error {
  failureKind:
    | "local_state_integrity"
    | "local_state_lock_timeout";
  localFailureClass: string;
  retryable = false;
  recoveryDecision = "stop_until_fixed";
  failedStage = "durable_state";
  evidence: Record<string, unknown>;

  constructor(
    message: string,
    input: {
      localFailureClass: string;
      failureKind?: "local_state_integrity" | "local_state_lock_timeout";
      cause?: Error;
      evidence?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "DurableStateError";
    this.failureKind = input.failureKind ?? "local_state_integrity";
    this.localFailureClass = input.localFailureClass;
    this.evidence = input.evidence ?? {};
    if (input.cause != null) {
      this.cause = input.cause;
    }
  }
}

export function durableChecksumPath(path: string): string {
  return `${path}.sha256`;
}

export function durableChecksumMetaPath(path: string): string {
  return `${durableChecksumPath(path)}.meta.json`;
}

function readDurableChecksumSync(path: string): string | undefined {
  try {
    return readFileSync(durableChecksumPath(path), "utf8").trim();
  } catch {
    return undefined;
  }
}

export async function readYamlFileDurable<T>(
  path: string,
  schema: { parse(input: unknown): T },
  fallback: T,
): Promise<T> {
  rejectDurableAuxiliaryTarget(path);
  return withDurableFileLock(path, () =>
    readYamlFileDurableUnlocked(path, schema, fallback)
  );
}

export async function readYamlFileDurableUnlocked<T>(
  path: string,
  schema: { parse(input: unknown): T },
  fallback: T,
): Promise<T> {
  rejectDurableAuxiliaryTarget(path);
  try {
    await reconcileDurableTextFileUnlocked(path, "yaml");
    return schema.parse(YAML.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function readYamlUnknownDurable(
  path: string,
): Promise<unknown | null> {
  rejectDurableAuxiliaryTarget(path);
  return withDurableFileLock(path, () => readYamlUnknownDurableUnlocked(path));
}

export async function readYamlUnknownDurableUnlocked(
  path: string,
): Promise<unknown | null> {
  rejectDurableAuxiliaryTarget(path);
  try {
    await reconcileDurableTextFileUnlocked(path, "yaml");
    return YAML.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readYamlUnknownDurableSync(path: string): unknown | null {
  rejectDurableAuxiliaryTarget(path);
  return withDurableFileLockSync(path, () => {
    try {
      reconcileDurableTextFileUnlockedSync(path, "yaml");
      return YAML.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
}

export async function writeYamlFileDurable(
  path: string,
  value: unknown,
): Promise<void> {
  rejectDurableAuxiliaryTarget(path);
  await withDurableFileLock(path, () => writeYamlFileDurableUnlocked(path, value));
}

export async function writeYamlFileDurableUnlocked(
  path: string,
  value: unknown,
): Promise<void> {
  rejectDurableAuxiliaryTarget(path);
  const text = YAML.stringify(value, { indent: 2, lineWidth: 88 });
  await writeTextFileDurableUnlocked(path, text, "yaml");
}

export async function updateYamlFileDurable<T>(
  path: string,
  schema: { parse(input: unknown): T },
  fallback: T,
  update: (current: T) => T | Promise<T>,
): Promise<T> {
  rejectDurableAuxiliaryTarget(path);
  return withDurableFileLock(path, async () => {
    const current = await readYamlFileDurableUnlocked(path, schema, fallback);
    const next = await update(current);
    await writeYamlFileDurableUnlocked(path, next);
    return next;
  });
}

export async function updateYamlUnknownDurable<T>(
  path: string,
  readCurrent: () => Promise<T>,
  update: (current: T) => T | Promise<T>,
): Promise<T> {
  rejectDurableAuxiliaryTarget(path);
  return withDurableFileLock(path, async () => {
    const current = await readCurrent();
    const next = await update(current);
    await writeYamlFileDurableUnlocked(path, next);
    return next;
  });
}

export async function readJsonFileDurable(path: string): Promise<unknown> {
  rejectDurableAuxiliaryTarget(path);
  await reconcileDurableTextFile(path, "json");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function writeJsonFileDurable(
  path: string,
  text: string,
): Promise<void> {
  rejectDurableAuxiliaryTarget(path);
  JSON.parse(text);
  await writeTextFileDurable(path, text, "json");
}

export function writeJsonFileDurableSync(path: string, text: string): void {
  rejectDurableAuxiliaryTarget(path);
  JSON.parse(text);
  writeTextFileDurableSync(path, text, "json");
}

export function writeYamlFileDurableSync(
  path: string,
  value: unknown,
): void {
  rejectDurableAuxiliaryTarget(path);
  const text = YAML.stringify(value, { indent: 2, lineWidth: 88 });
  writeTextFileDurableSync(path, text, "yaml");
}

export function writeOpaqueFileDurableSync(
  path: string,
  content: string | Buffer,
): void {
  rejectDurableAuxiliaryTarget(path);
  writeOpaqueFileDurableUncheckedSync(path, content);
}

export function writeQuarantineFileDurableSync(
  path: string,
  content: string | Buffer,
): void {
  if (!basename(path).includes(".corrupt-")) {
    throw new DurableStateError(`durable quarantine target rejected: ${path}`, {
      localFailureClass: "durable_quarantine_target_rejected",
      evidence: {
        targetLocator: path,
        redactedEvidenceLocator: redactedLocator(path),
        durableMode: "strict",
      },
    });
  }
  writeOpaqueFileDurableUncheckedSync(path, content);
}

function writeOpaqueFileDurableUncheckedSync(
  path: string,
  content: string | Buffer,
): void {
  withDurableFileLockSync(path, () => {
    mkdirSyncRecursive(dirname(path));
    const operation = newOperationEvidence(path, "opaque");
    const tempPath = `${path}.tmp-${operation.tempId}`;
    const ownerPath = `${tempPath}.owner.json`;
    try {
      writeJsonSidecarSync(ownerPath, operation, operation);
      writeFileDurableSync(tempPath, content, "wx", operation);
      renameWithEvidenceSync(tempPath, path, operation);
      rmSync(ownerPath, { force: true });
      fsyncDirectoryStrictSync(dirname(path), operation);
    } catch (error) {
      rmSync(tempPath, { force: true });
      rmSync(ownerPath, { force: true });
      throw classifyDurableWriteError(error, operation);
    }
  });
}

export async function reconcileDurableTextFile(
  path: string,
  kind: "yaml" | "json",
): Promise<void> {
  rejectDurableAuxiliaryTarget(path);
  await withDurableFileLock(path, () => reconcileDurableTextFileUnlocked(path, kind));
}

export type DurableChecksumRefreshResult = {
  path: string;
  checksum: string;
  previousChecksum: string | null;
  checksumRecoveryDecision: string;
  mutated: boolean;
};

export async function refreshDurableTextFileChecksum(
  path: string,
  kind: "yaml" | "json",
  input: {
    checksumRecoveryDecision?: string;
    expectedChecksum?: string;
    evidence?: Record<string, unknown>;
  } = {},
): Promise<DurableChecksumRefreshResult> {
  rejectDurableAuxiliaryTarget(path);
  return withDurableFileLock(path, async () => {
    await removeStaleDurableTempsUnlocked(path);
    await removeStaleDurableTempsUnlocked(durableChecksumPath(path));
    const raw = await readFile(path, "utf8");
    validateText(kind, raw, path);
    const actual = hashText(raw);
    const decision = input.checksumRecoveryDecision ??
      "writer_boundary_checksum_refreshed";
    if (
      input.expectedChecksum != null &&
      input.expectedChecksum !== actual
    ) {
      throw new DurableStateError(
        `durable checksum refresh evidence mismatch: ${path}`,
        {
          localFailureClass: "durable_checksum_refresh_evidence_mismatch",
          evidence: {
            ...newOperationEvidence(path, "checksum-refresh"),
            checksumExpected: input.expectedChecksum,
            checksumActual: actual,
            checksumRecoveryDecision: "stop_until_fixed",
            recoveryDecision: "stop_until_fixed",
            repairAllowed: true,
            ...input.evidence,
          },
        },
      );
    }
    const checksumPath = durableChecksumPath(path);
    const previousChecksum = existsSync(checksumPath)
      ? readFileSync(checksumPath, "utf8").trim()
      : null;
    const metaState = readChecksumMetaState(path);
    const metaNeedsRepair = metaState.status !== "present" ||
      checksumMetaIsPending(metaState.meta) ||
      checksumMetaIsInvalid(actual, metaState.meta);
    if (previousChecksum === actual) {
      if (metaNeedsRepair) {
        await reconcileDurableTextFileUnlocked(path, kind);
        await appendChecksumRefreshRecord(path, actual, previousChecksum, {
          checksumRecoveryDecision: "checksum_meta_refreshed",
          ...input.evidence,
        });
      }
      return {
        path,
        checksum: actual,
        previousChecksum,
        checksumRecoveryDecision: metaNeedsRepair
          ? "checksum_meta_refreshed"
          : "committed",
        mutated: metaNeedsRepair,
      };
    }
    await backfillChecksum(path, actual, decision);
    await appendChecksumRefreshRecord(path, actual, previousChecksum, {
      checksumRecoveryDecision: decision,
      ...input.evidence,
    });
    return {
      path,
      checksum: actual,
      previousChecksum,
      checksumRecoveryDecision: decision,
      mutated: true,
    };
  });
}

async function writeTextFileDurable(
  path: string,
  text: string,
  kind: "yaml" | "json",
): Promise<void> {
  rejectDurableAuxiliaryTarget(path);
  await withDurableFileLock(path, () => writeTextFileDurableUnlocked(path, text, kind));
}

async function writeTextFileDurableUnlocked(
  path: string,
  text: string,
  kind: "yaml" | "json",
): Promise<void> {
  rejectDurableAuxiliaryTarget(path);
  await mkdir(dirname(path), { recursive: true });
  validateText(kind, text, path);
  await reconcileDurableTextFileUnlocked(path, kind);
  const operation = newOperationEvidence(path, kind);
  const tempPath = `${path}.tmp-${operation.tempId}`;
  const ownerPath = `${tempPath}.owner.json`;
  const checksumPath = durableChecksumPath(path);
  const checksum = hashText(text);
  const commitEvidence = { ...operation, checksum };
  const checksumOperation = {
    ...newOperationEvidence(checksumPath, "checksum", {
      ...sidecarEvidence(checksumPath),
      checksum,
      checksumRecoveryDecision: "committed",
    }),
    tempId: `${operation.tempId}-checksum`,
  };
  const checksumTempPath = `${checksumPath}.tmp-${
    stringValue(checksumOperation.tempId) ?? operation.tempId
  }`;
  const checksumOwnerPath = `${checksumTempPath}.owner.json`;
  try {
    await writeJsonSidecar(ownerPath, commitEvidence, operation);
    await writeFileDurable(tempPath, text, "wx", operation);
    await writeJsonAtomicSidecar(durableChecksumMetaPath(path), {
      ...commitEvidence,
      checksumRecoveryDecision: "target_rename_pending",
      commitState: "target_rename_pending",
    });
    await renameWithEvidence(tempPath, path, operation);
    const checksumMeta = {
      ...commitEvidence,
      checksum,
      checksumPath,
      checksumRecoveryDecision: "committed",
      commitState: "committed",
      committedAt: new Date().toISOString(),
    };
    await writeJsonSidecar(checksumOwnerPath, checksumOperation, checksumOperation);
    await writeFileDurable(
      checksumTempPath,
      `${checksum}\n`,
      "wx",
      checksumOperation,
    );
    await renameWithEvidence(checksumTempPath, checksumPath, checksumOperation);
    await writeJsonAtomicSidecar(durableChecksumMetaPath(path), checksumMeta);
    await rm(ownerPath, { force: true });
    await rm(checksumOwnerPath, { force: true });
    await fsyncDirectoryStrict(dirname(path), checksumOperation);
  } catch (error) {
    await rm(tempPath, { force: true });
    await rm(ownerPath, { force: true });
    await rm(checksumTempPath, { force: true });
    await rm(checksumOwnerPath, { force: true });
    throw classifyDurableWriteError(error, operation);
  }
}

function writeTextFileDurableSync(
  path: string,
  text: string,
  kind: "yaml" | "json",
): void {
  rejectDurableAuxiliaryTarget(path);
  withDurableFileLockSync(path, () => {
    mkdirSyncRecursive(dirname(path));
    validateText(kind, text, path);
    reconcileDurableTextFileUnlockedSync(path, kind);
    const operation = newOperationEvidence(path, kind);
    const tempPath = `${path}.tmp-${operation.tempId}`;
    const ownerPath = `${tempPath}.owner.json`;
    const checksumPath = durableChecksumPath(path);
    const checksum = hashText(text);
    const commitEvidence = { ...operation, checksum };
    const checksumOperation = {
      ...newOperationEvidence(checksumPath, "checksum", {
        ...sidecarEvidence(checksumPath),
        checksum,
        checksumRecoveryDecision: "committed",
      }),
      tempId: `${operation.tempId}-checksum`,
    };
    const checksumTempPath = `${checksumPath}.tmp-${
      stringValue(checksumOperation.tempId) ?? operation.tempId
    }`;
    const checksumOwnerPath = `${checksumTempPath}.owner.json`;
    try {
      writeJsonSidecarSync(ownerPath, commitEvidence, operation);
      writeFileDurableSync(tempPath, text, "wx", operation);
      writeJsonAtomicSidecarSync(durableChecksumMetaPath(path), {
        ...commitEvidence,
        checksumRecoveryDecision: "target_rename_pending",
        commitState: "target_rename_pending",
      });
      renameWithEvidenceSync(tempPath, path, operation);
      const checksumMeta = {
        ...commitEvidence,
        checksum,
        checksumPath,
        checksumRecoveryDecision: "committed",
        commitState: "committed",
        committedAt: new Date().toISOString(),
      };
      writeJsonSidecarSync(
        checksumOwnerPath,
        checksumOperation,
        checksumOperation,
      );
      writeFileDurableSync(
        checksumTempPath,
        `${checksum}\n`,
        "wx",
        checksumOperation,
      );
      renameWithEvidenceSync(checksumTempPath, checksumPath, checksumOperation);
      writeJsonAtomicSidecarSync(durableChecksumMetaPath(path), checksumMeta);
      rmSync(ownerPath, { force: true });
      rmSync(checksumOwnerPath, { force: true });
      fsyncDirectoryStrictSync(dirname(path), checksumOperation);
    } catch (error) {
      rmSync(tempPath, { force: true });
      rmSync(ownerPath, { force: true });
      rmSync(checksumTempPath, { force: true });
      rmSync(checksumOwnerPath, { force: true });
      throw classifyDurableWriteError(error, operation);
    }
  });
}

async function reconcileDurableTextFileUnlocked(
  path: string,
  kind: "yaml" | "json",
): Promise<void> {
  rejectDurableAuxiliaryTarget(path);
  await mkdir(dirname(path), { recursive: true });
  await removeStaleDurableTempsUnlocked(path);
  await removeStaleDurableTempsUnlocked(durableChecksumPath(path));
  if (!existsSync(path)) return;

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
    validateText(kind, raw, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    await quarantineTarget(path, "invalid", error);
    return;
  }

  const actual = hashText(raw);
  const checksumPath = durableChecksumPath(path);
  const metaState = readChecksumMetaState(path);
  const meta = metaState.meta;
  if (metaState.status === "invalid") {
    await quarantineChecksumMetaSidecar(path, actual, "checksum_meta_invalid", {
      checksumExpected: null,
      checksumActual: actual,
      checksumRecoveryDecision: "checksum_meta_sidecar_repaired",
    });
    await writeChecksumMeta(path, actual, "checksum_meta_sidecar_repaired");
    return;
  }
  if (!existsSync(checksumPath)) {
    if (meta != null && !checksumCommitEvidenceMatches(path, actual, meta)) {
      await quarantineTarget(path, "checksum_mismatch", undefined, {
        checksumExpected: null,
        checksumActual: actual,
        checksumRecoveryDecision: "stop_until_fixed",
      });
    }
    await backfillChecksum(path, actual, "target_new_checksum_missing");
    return;
  }
  const expected = readFileSync(checksumPath, "utf8").trim();
  if (expected === actual) {
    if (meta == null) {
      await writeChecksumMeta(path, actual, "metadata_backfilled");
      return;
    }
    if (checksumMetaIsPending(meta)) {
      if (!checksumCommitEvidenceMatches(path, actual, meta)) {
        await quarantineTarget(path, "checksum_mismatch", undefined, {
          checksumExpected: stringValue(meta?.checksum),
          checksumActual: actual,
          checksumRecoveryDecision: "stop_until_fixed",
        });
      }
      if (meta.checksum !== actual) {
        await backfillChecksum(path, actual, "abandoned_pending_commit_recovered");
        return;
      }
      await writeJsonAtomicSidecar(
        durableChecksumMetaPath(path),
        committedChecksumMeta(path, actual, "pending_meta_committed"),
      );
      return;
    }
    if (checksumMetaIsInvalid(actual, meta)) {
      await quarantineChecksumMetaSidecar(path, actual, "checksum_meta_conflict", {
        checksumExpected: stringValue(meta.checksum),
        checksumActual: actual,
        checksumRecoveryDecision: "checksum_meta_sidecar_repaired",
      });
      await writeChecksumMeta(path, actual, "checksum_meta_sidecar_repaired");
    }
    return;
  }
  if (checksumCommitEvidenceMatches(path, actual, meta)) {
    await backfillChecksum(path, actual, "target_new_checksum_old");
    return;
  }
  await quarantineTarget(path, "checksum_mismatch", undefined, {
    checksumExpected: expected,
    checksumActual: actual,
    checksumRecoveryDecision: "stop_until_fixed",
  });
}

function reconcileDurableTextFileUnlockedSync(
  path: string,
  kind: "yaml" | "json",
): void {
  rejectDurableAuxiliaryTarget(path);
  mkdirSyncRecursive(dirname(path));
  removeStaleDurableTempsUnlockedSync(path);
  removeStaleDurableTempsUnlockedSync(durableChecksumPath(path));
  if (!existsSync(path)) return;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
    validateText(kind, raw, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    quarantineTargetSync(path, "invalid", error);
  }

  const actual = hashText(raw);
  const checksumPath = durableChecksumPath(path);
  const metaState = readChecksumMetaState(path);
  const meta = metaState.meta;
  if (metaState.status === "invalid") {
    quarantineChecksumMetaSidecarSync(path, actual, "checksum_meta_invalid", {
      checksumExpected: null,
      checksumActual: actual,
      checksumRecoveryDecision: "checksum_meta_sidecar_repaired",
    });
    writeChecksumMetaSync(path, actual, "checksum_meta_sidecar_repaired");
    return;
  }
  if (!existsSync(checksumPath)) {
    if (meta != null && !checksumCommitEvidenceMatches(path, actual, meta)) {
      quarantineTargetSync(path, "checksum_mismatch", undefined, {
        checksumExpected: null,
        checksumActual: actual,
        checksumRecoveryDecision: "stop_until_fixed",
      });
    }
    backfillChecksumSync(path, actual, "target_new_checksum_missing");
    return;
  }
  const expected = readFileSync(checksumPath, "utf8").trim();
  if (expected === actual) {
    if (meta == null) {
      writeChecksumMetaSync(path, actual, "metadata_backfilled");
      return;
    }
    if (checksumMetaIsPending(meta)) {
      if (!checksumCommitEvidenceMatches(path, actual, meta)) {
        quarantineTargetSync(path, "checksum_mismatch", undefined, {
          checksumExpected: stringValue(meta?.checksum),
          checksumActual: actual,
          checksumRecoveryDecision: "stop_until_fixed",
        });
      }
      if (meta.checksum !== actual) {
        backfillChecksumSync(path, actual, "abandoned_pending_commit_recovered");
        return;
      }
      writeJsonAtomicSidecarSync(
        durableChecksumMetaPath(path),
        committedChecksumMeta(path, actual, "pending_meta_committed"),
      );
      return;
    }
    if (checksumMetaIsInvalid(actual, meta)) {
      quarantineChecksumMetaSidecarSync(path, actual, "checksum_meta_conflict", {
        checksumExpected: stringValue(meta.checksum),
        checksumActual: actual,
        checksumRecoveryDecision: "checksum_meta_sidecar_repaired",
      });
      writeChecksumMetaSync(path, actual, "checksum_meta_sidecar_repaired");
    }
    return;
  }
  if (checksumCommitEvidenceMatches(path, actual, meta)) {
    backfillChecksumSync(path, actual, "target_new_checksum_old");
    return;
  }
  quarantineTargetSync(path, "checksum_mismatch", undefined, {
    checksumExpected: expected,
    checksumActual: actual,
    checksumRecoveryDecision: "stop_until_fixed",
  });
}

async function withDurableFileLock<T>(
  path: string,
  callback: () => Promise<T>,
): Promise<T> {
  const lockPath = `${path}.lock`;
  const startedAt = Date.now();
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    const owner = newLockOwner(path);
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleDurableLock(lockPath);
      if (Date.now() - startedAt > DurableLockWaitMs) {
        const lockOwnerEvidence = await readJsonSidecar(lockPath);
        const mapping = durableTargetMapping(path, "lock");
        throw new DurableStateError(
          `timed out waiting for durable state lock: ${path}`,
          {
            failureKind: "local_state_lock_timeout",
            localFailureClass: "durable_state_lock_timeout",
            evidence: {
              targetLocator: path,
              lockPath,
              waitMs: Date.now() - startedAt,
              ...mapping,
              lockOwnerEvidence,
              durableMode: "strict",
              completedPublishRule: "forbidden",
              redactedEvidenceLocator: redactedLocator(path),
            },
          },
        );
      }
      await delay(25);
      continue;
    }

    try {
      assertDurableLockStillOwned(lockPath, owner);
      const result = await callback();
      assertDurableLockStillOwned(lockPath, owner);
      return result;
    } finally {
      try {
        await handle.close();
      } catch {
        // Lock recovery handles orphan handles.
      }
      await releaseDurableFileLock(lockPath, owner);
    }
  }
}

function withDurableFileLockSync<T>(
  path: string,
  callback: () => T,
): T {
  const lockPath = `${path}.lock`;
  const startedAt = Date.now();
  mkdirSyncRecursive(dirname(path));
  for (;;) {
    let fd: number | null = null;
    const owner = newLockOwner(path);
    try {
      fd = openSync(lockPath, "wx");
      writeSync(fd, `${JSON.stringify(owner)}\n`, undefined, "utf8");
      fsyncSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      removeStaleDurableLockSync(lockPath);
      if (Date.now() - startedAt > DurableLockWaitMs) {
        const lockOwnerEvidence = readJsonSidecarSync(lockPath);
        const mapping = durableTargetMapping(path, "lock");
        throw new DurableStateError(
          `timed out waiting for durable state lock: ${path}`,
          {
            failureKind: "local_state_lock_timeout",
            localFailureClass: "durable_state_lock_timeout",
            evidence: {
              targetLocator: path,
              lockPath,
              waitMs: Date.now() - startedAt,
              ...mapping,
              lockOwnerEvidence,
              durableMode: "strict",
              completedPublishRule: "forbidden",
              redactedEvidenceLocator: redactedLocator(path),
            },
          },
        );
      }
      sleepSync(25);
      continue;
    } finally {
      if (fd != null) closeSync(fd);
    }

    try {
      assertDurableLockStillOwned(lockPath, owner);
      const result = callback();
      assertDurableLockStillOwned(lockPath, owner);
      return result;
    } finally {
      releaseDurableFileLockSync(lockPath, owner);
    }
  }
}

async function releaseDurableFileLock(
  lockPath: string,
  owner: Record<string, unknown>,
): Promise<void> {
  try {
    if (!durableLockOwnedBy(lockPath, owner)) return;
    await rm(lockPath, { force: true });
    await fsyncDirectoryStrict(dirname(lockPath), owner);
  } catch {
    // Lock recovery handles orphaned locks and concurrent stale cleanup.
  }
}

function releaseDurableFileLockSync(
  lockPath: string,
  owner: Record<string, unknown>,
): void {
  try {
    if (!durableLockOwnedBy(lockPath, owner)) return;
    rmSync(lockPath, { force: true });
    fsyncDirectoryStrictSync(dirname(lockPath), owner);
  } catch {
    // Lock recovery handles orphaned locks and concurrent stale cleanup.
  }
}

async function appendDurableRecoveryRecord(
  directory: string,
  record: Record<string, unknown>,
): Promise<void> {
  const recoveryDirectory = durableRecoveryRecordDirectory(directory);
  await mkdir(recoveryDirectory, { recursive: true });
  await appendFile(
    join(recoveryDirectory, DurableRecoveryLogName),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}

function appendDurableRecoveryRecordSync(
  directory: string,
  record: Record<string, unknown>,
): void {
  const recoveryDirectory = durableRecoveryRecordDirectory(directory);
  mkdirSyncRecursive(recoveryDirectory);
  appendFileSync(
    join(recoveryDirectory, DurableRecoveryLogName),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}

function durableRecoveryRecordDirectory(directory: string): string {
  const normalized = directory.split("\\").join("/");
  const match = /^(.*\/graph_vault)\/books\/([^/]+)(?:\/|$)/u.exec(normalized);
  if (match == null) return directory;
  const graphVault = match[1];
  const bookId = match[2];
  if (graphVault == null || bookId == null) return directory;
  const recoveryId = hashText(relative(graphVault, directory)).slice(0, 16);
  return join(
    graphVault,
    ".local",
    "book-runtime",
    bookId,
    "durable-recovery",
    recoveryId,
  );
}

async function removeStaleDurableLock(path: string): Promise<void> {
  try {
    const entry = await stat(path);
    const owner = await readJsonSidecar(path);
    const ownerDeadSameHost = durableLockOwnerDeadSameHost(owner);
    if (
      (durableLockOwnerExpired(owner, entry) || ownerDeadSameHost) &&
      durableLockOwnerHasRecoveryFence(owner) &&
      durableLockOwnerLocal(owner) &&
      !durableLockOwnerAlive(owner)
    ) {
      const staleAgeMs = Math.floor(Date.now() - entry.mtimeMs);
      await rm(path, { force: true });
      await appendDurableRecoveryRecord(dirname(path), {
        event: "durable_lock_recovered",
        targetLocator: path,
        lockPath: path,
        recoveredAt: new Date().toISOString(),
        staleAgeMs,
        recoveryDecision: "stale_lock_removed",
        lockOwnerEvidence: owner,
      });
      await fsyncDirectoryStrict(dirname(path), {
        targetLocator: path,
        operationId: "lock-recovery",
        tempId: "lock-recovery",
        lockOwnerEvidence: owner,
        staleAgeMs,
        checksumRecoveryDecision: "stale_lock_removed",
        durableAdapterContract: DurableAdapterContract,
      });
    }
  } catch {
    // Missing or concurrently removed locks are expected under contention.
  }
}

function removeStaleDurableLockSync(path: string): void {
  try {
    const entry = statSync(path);
    const owner = readJsonSidecarSync(path);
    const ownerDeadSameHost = durableLockOwnerDeadSameHost(owner);
    if (
      (durableLockOwnerExpired(owner, entry) || ownerDeadSameHost) &&
      durableLockOwnerHasRecoveryFence(owner) &&
      durableLockOwnerLocal(owner) &&
      !durableLockOwnerAlive(owner)
    ) {
      const staleAgeMs = Math.floor(Date.now() - entry.mtimeMs);
      rmSync(path, { force: true });
      appendDurableRecoveryRecordSync(dirname(path), {
        event: "durable_lock_recovered",
        targetLocator: path,
        lockPath: path,
        recoveredAt: new Date().toISOString(),
        staleAgeMs,
        recoveryDecision: "stale_lock_removed",
        lockOwnerEvidence: owner,
      });
      fsyncDirectoryStrictSync(dirname(path), {
        targetLocator: path,
        operationId: "lock-recovery",
        tempId: "lock-recovery",
        lockOwnerEvidence: owner,
        staleAgeMs,
        checksumRecoveryDecision: "stale_lock_removed",
        durableAdapterContract: DurableAdapterContract,
      });
    }
  } catch {
    // Missing or concurrently removed locks are expected under contention.
  }
}

async function removeStaleDurableTempsUnlocked(path: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dirname(path));
  } catch {
    return;
  }
  const prefix = `${basename(path)}.tmp-`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry.endsWith(".owner.json")) continue;
    const tempPath = join(dirname(path), entry);
    try {
      const tempEntry = await stat(tempPath);
      const owner = await readJsonSidecar(`${tempPath}.owner.json`);
      if (!durableTempOwnerMatchesTarget(owner, path)) continue;
      const ownerCreatedAtMs = durableTempOwnerCreatedAtMs(owner);
      if (ownerCreatedAtMs == null) continue;
      if (!durableTempOwnerHasCleanupFence(owner)) continue;
      if (durableTempTargetGenerationAdvanced(owner, path)) continue;
      const newestEvidenceMs = Math.max(tempEntry.mtimeMs, ownerCreatedAtMs);
      if (Date.now() - newestEvidenceMs <= DurableTempStaleMs) continue;
      const ownerPid = numberValue(owner?.ownerPid ?? owner?.pid);
      const ownerHost = stringValue(owner?.ownerHost ?? owner?.host);
      const ownerAlive = ownerHost === Host && processAlive(ownerPid);
      if (ownerAlive) continue;
      const ownerExpiryMs = durableTempOwnerExpiresAtMs(owner);
      const leaseExpired = ownerExpiryMs != null && Date.now() > ownerExpiryMs;
      const localOwnerDead = ownerHost === Host && !processAlive(ownerPid);
      if (!leaseExpired && !localOwnerDead) continue;
      await rm(tempPath, { force: true });
      await rm(`${tempPath}.owner.json`, { force: true });
      const staleAgeMs = Math.floor(Date.now() - newestEvidenceMs);
      const cleanupReason = leaseExpired
        ? "owner_lease_expired"
        : "owner_dead_stale_temp";
      await fsyncDirectoryStrict(dirname(tempPath), {
        targetLocator: path,
        operationId: stringValue(owner?.operationId) ?? "temp-cleanup",
        tempId: stringValue(owner?.tempId) ?? "temp-cleanup",
        lockOwnerEvidence: owner,
        checksumRecoveryDecision: "stale_temp_removed",
        cleanupReason,
        staleAgeMs,
        durableAdapterContract: DurableAdapterContract,
      });
      await appendDurableRecoveryRecord(dirname(path), {
        event: "durable_temp_recovered",
        targetLocator: path,
        tempPath,
        operationId: stringValue(owner?.operationId) ?? "temp-cleanup",
        tempId: stringValue(owner?.tempId) ?? "temp-cleanup",
        cleanupReason,
        staleAgeMs,
        lockOwnerEvidence: owner,
        recoveredAt: new Date().toISOString(),
        recoveryDecision: "stale_temp_removed",
        durableAdapterContract: DurableAdapterContract,
      });
    } catch {
      // Missing or concurrently removed temp files are expected under recovery.
    }
  }
}

function removeStaleDurableTempsUnlockedSync(path: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dirname(path));
  } catch {
    return;
  }
  const prefix = `${basename(path)}.tmp-`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry.endsWith(".owner.json")) continue;
    const tempPath = join(dirname(path), entry);
    try {
      const tempEntry = statSync(tempPath);
      const owner = readJsonSidecarSync(`${tempPath}.owner.json`);
      if (!durableTempOwnerMatchesTarget(owner, path)) continue;
      const ownerCreatedAtMs = durableTempOwnerCreatedAtMs(owner);
      if (ownerCreatedAtMs == null) continue;
      if (!durableTempOwnerHasCleanupFence(owner)) continue;
      if (durableTempTargetGenerationAdvanced(owner, path)) continue;
      const newestEvidenceMs = Math.max(tempEntry.mtimeMs, ownerCreatedAtMs);
      if (Date.now() - newestEvidenceMs <= DurableTempStaleMs) continue;
      const ownerPid = numberValue(owner?.ownerPid ?? owner?.pid);
      const ownerHost = stringValue(owner?.ownerHost ?? owner?.host);
      const ownerAlive = ownerHost === Host && processAlive(ownerPid);
      if (ownerAlive) continue;
      const ownerExpiryMs = durableTempOwnerExpiresAtMs(owner);
      const leaseExpired = ownerExpiryMs != null && Date.now() > ownerExpiryMs;
      const localOwnerDead = ownerHost === Host && !processAlive(ownerPid);
      if (!leaseExpired && !localOwnerDead) continue;
      rmSync(tempPath, { force: true });
      rmSync(`${tempPath}.owner.json`, { force: true });
      const staleAgeMs = Math.floor(Date.now() - newestEvidenceMs);
      const cleanupReason = leaseExpired
        ? "owner_lease_expired"
        : "owner_dead_stale_temp";
      fsyncDirectoryStrictSync(dirname(tempPath), {
        targetLocator: path,
        operationId: stringValue(owner?.operationId) ?? "temp-cleanup",
        tempId: stringValue(owner?.tempId) ?? "temp-cleanup",
        lockOwnerEvidence: owner,
        checksumRecoveryDecision: "stale_temp_removed",
        cleanupReason,
        staleAgeMs,
        durableAdapterContract: DurableAdapterContract,
      });
      appendDurableRecoveryRecordSync(dirname(path), {
        event: "durable_temp_recovered",
        targetLocator: path,
        tempPath,
        operationId: stringValue(owner?.operationId) ?? "temp-cleanup",
        tempId: stringValue(owner?.tempId) ?? "temp-cleanup",
        cleanupReason,
        staleAgeMs,
        lockOwnerEvidence: owner,
        recoveredAt: new Date().toISOString(),
        recoveryDecision: "stale_temp_removed",
        durableAdapterContract: DurableAdapterContract,
      });
    } catch {
      // Missing or concurrently removed temp files are expected under recovery.
    }
  }
}

async function backfillChecksum(
  path: string,
  checksum: string,
  decision: string,
): Promise<void> {
  const checksumPath = durableChecksumPath(path);
  const operation: Record<string, unknown> = {
    ...newOperationEvidence(checksumPath, "checksum"),
    ...sidecarEvidence(checksumPath),
    checksum,
    checksumRecoveryDecision: decision,
  };
  const tempPath = `${checksumPath}.tmp-${String(operation.tempId)}`;
  try {
    await writeJsonSidecar(`${tempPath}.owner.json`, operation, operation);
    await writeFileDurable(tempPath, `${checksum}\n`, "wx", operation);
    await renameWithEvidence(tempPath, checksumPath, operation);
    await writeJsonAtomicSidecar(durableChecksumMetaPath(path), operation);
    await rm(`${tempPath}.owner.json`, { force: true });
    await fsyncDirectoryStrict(dirname(path), operation);
  } catch (error) {
    await rm(tempPath, { force: true });
    await rm(`${tempPath}.owner.json`, { force: true });
    throw classifyDurableWriteError(error, operation);
  }
}

function backfillChecksumSync(
  path: string,
  checksum: string,
  decision: string,
): void {
  const checksumPath = durableChecksumPath(path);
  const operation: Record<string, unknown> = {
    ...newOperationEvidence(checksumPath, "checksum"),
    ...sidecarEvidence(checksumPath),
    checksum,
    checksumRecoveryDecision: decision,
  };
  const tempPath = `${checksumPath}.tmp-${String(operation.tempId)}`;
  try {
    writeJsonSidecarSync(`${tempPath}.owner.json`, operation, operation);
    writeFileDurableSync(tempPath, `${checksum}\n`, "wx", operation);
    renameWithEvidenceSync(tempPath, checksumPath, operation);
    writeJsonAtomicSidecarSync(durableChecksumMetaPath(path), operation);
    rmSync(`${tempPath}.owner.json`, { force: true });
    fsyncDirectoryStrictSync(dirname(path), operation);
  } catch (error) {
    rmSync(tempPath, { force: true });
    rmSync(`${tempPath}.owner.json`, { force: true });
    throw classifyDurableWriteError(error, operation);
  }
}

async function appendChecksumRefreshRecord(
  path: string,
  checksum: string,
  previousChecksum: string | null,
  extra: Record<string, unknown>,
): Promise<void> {
  await appendDurableRecoveryRecord(dirname(path), {
    event: "durable_checksum_refreshed",
    targetLocator: path,
    checksum,
    previousChecksum,
    refreshedAt: new Date().toISOString(),
    recoveryDecision: "continue_pending",
    repairAllowed: true,
    ...extra,
  });
}

async function writeChecksumMeta(
  path: string,
  checksum: string,
  decision: string,
): Promise<void> {
  await writeJsonAtomicSidecar(durableChecksumMetaPath(path), {
    ...newOperationEvidence(path, "checksum"),
    checksum,
    checksumRecoveryDecision: decision,
  });
}

function writeChecksumMetaSync(
  path: string,
  checksum: string,
  decision: string,
): void {
  writeJsonAtomicSidecarSync(durableChecksumMetaPath(path), {
    ...newOperationEvidence(path, "checksum"),
    checksum,
    checksumRecoveryDecision: decision,
  });
}

async function writeJsonAtomicSidecar(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  const operation = newOperationEvidence(
    path,
    "json-sidecar",
    checksumMetaWriteEvidence(path, value),
  );
  const tempPath = `${path}.tmp-${operation.tempId}`;
  const ownerPath = `${tempPath}.owner.json`;
  try {
    await writeJsonSidecar(ownerPath, operation, operation);
    await writeFileDurable(
      tempPath,
      `${JSON.stringify(value, null, 2)}\n`,
      "wx",
      operation,
    );
    await renameWithEvidence(tempPath, path, operation);
    await rm(ownerPath, { force: true });
    await fsyncDirectoryStrict(dirname(path), operation);
  } catch (error) {
    await rm(tempPath, { force: true });
    await rm(ownerPath, { force: true });
    throw classifyDurableWriteError(error, operation);
  }
}

function writeJsonAtomicSidecarSync(
  path: string,
  value: Record<string, unknown>,
): void {
  const operation = newOperationEvidence(
    path,
    "json-sidecar",
    checksumMetaWriteEvidence(path, value),
  );
  const tempPath = `${path}.tmp-${operation.tempId}`;
  const ownerPath = `${tempPath}.owner.json`;
  try {
    writeJsonSidecarSync(ownerPath, operation, operation);
    writeFileDurableSync(
      tempPath,
      `${JSON.stringify(value, null, 2)}\n`,
      "wx",
      operation,
    );
    renameWithEvidenceSync(tempPath, path, operation);
    rmSync(ownerPath, { force: true });
    fsyncDirectoryStrictSync(dirname(path), operation);
  } catch (error) {
    rmSync(tempPath, { force: true });
    rmSync(ownerPath, { force: true });
    throw classifyDurableWriteError(error, operation);
  }
}

async function writeJsonSidecar(
  path: string,
  value: Record<string, unknown>,
  operation = newOperationEvidence(path, "json-sidecar"),
): Promise<void> {
  await writeFileDurable(path, `${JSON.stringify(value, null, 2)}\n`, "wx", operation);
}

function writeJsonSidecarSync(
  path: string,
  value: Record<string, unknown>,
  operation = newOperationEvidence(path, "json-sidecar"),
): void {
  writeFileDurableSync(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    "wx",
    operation,
  );
}

async function writeFileDurable(
  path: string,
  text: string | Buffer,
  flag: "w" | "wx" = "w",
  operation: Record<string, unknown> = newOperationEvidence(path, "file"),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, flag);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
    throw durableFileFsyncError(path, error, operation);
  } finally {
    await handle?.close();
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    throw durableFileFsyncError(path, error, operation);
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function writeFileDurableSync(
  path: string,
  text: string | Buffer,
  flag: "w" | "wx" = "w",
  operation: Record<string, unknown> = newOperationEvidence(path, "file"),
): void {
  mkdirSyncRecursive(dirname(path));
  let fd: number | null = null;
  try {
    fd = openSync(path, flag);
    if (Buffer.isBuffer(text)) {
      writeSync(fd, text);
    } else {
      writeSync(fd, text, undefined, "utf8");
    }
    fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
    throw durableFileFsyncError(path, error, operation);
  } finally {
    if (fd != null) closeSync(fd);
  }
  let readFd: number | null = null;
  try {
    readFd = openSync(path, "r");
    fsyncSync(readFd);
  } catch (error) {
    throw durableFileFsyncError(path, error, operation);
  } finally {
    if (readFd != null) closeSync(readFd);
  }
}

async function renameWithEvidence(
  from: string,
  to: string,
  operation: Record<string, unknown>,
): Promise<void> {
  try {
    if (shouldInjectRenameEnoent(to, operation)) await rm(from, { force: true });
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DurableStateError(
        `local_state_integrity durable_temp_rename_enoent: ${to}`,
        {
          localFailureClass: "durable_temp_rename_enoent",
          cause: error as Error,
          evidence: {
            ...operation,
            failedSyscall: "rename",
            errno: "ENOENT",
            renameCause: inferRenameEnoentCause(from, to, operation),
            completedPublishRule: "forbidden",
            redactedEvidenceLocator: redactedLocator(to),
          },
        },
      );
    }
    throw error;
  }
}

function renameWithEvidenceSync(
  from: string,
  to: string,
  operation: Record<string, unknown>,
): void {
  try {
    if (shouldInjectRenameEnoent(to, operation)) rmSync(from, { force: true });
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DurableStateError(
        `local_state_integrity durable_temp_rename_enoent: ${to}`,
        {
          localFailureClass: "durable_temp_rename_enoent",
          cause: error as Error,
          evidence: {
            ...operation,
            failedSyscall: "rename",
            errno: "ENOENT",
            renameCause: inferRenameEnoentCause(from, to, operation),
            completedPublishRule: "forbidden",
            redactedEvidenceLocator: redactedLocator(to),
          },
        },
      );
    }
    throw error;
  }
}

function inferRenameEnoentCause(
  from: string,
  to: string,
  operation: Record<string, unknown>,
): string {
  const tempExists = existsSync(from);
  const targetExists = existsSync(to);
  const currentChecksum = readDurableChecksumSync(to);
  if (
    currentChecksum != null &&
    stringValue(operation.targetChecksumBefore) != null &&
    currentChecksum !== operation.targetChecksumBefore
  ) {
    return "generation_advanced";
  }
  if (operation.tempCreateCollision === true) return "temp_collision";
  if (
    operation.cleanupReason === "live_temp_deleted" ||
    operation.cleanupReason === "owner_alive"
  ) {
    return "reconciler_mistaken_deletion";
  }
  if (
    operation.fencingTokenMismatch === true ||
    operation.staleWriter === true ||
    operation.leaseGenerationChanged === true
  ) {
    return "concurrent_takeover";
  }
  if (!tempExists && targetExists) return "generation_advanced";
  return "filesystem_or_external_mutation";
}

function shouldInjectRenameEnoent(
  to: string,
  operation: Record<string, unknown>,
): boolean {
  if (
    process.env.QMD_GRAPHRAG_ENABLE_TEST_HOOKS !== "1" ||
    testRenameEnoentInjected
  ) {
    return false;
  }
  const exactTarget = process.env.QMD_GRAPHRAG_TEST_RENAME_ENOENT_ONCE_TARGET ??
    "";
  const pattern = process.env.QMD_GRAPHRAG_TEST_RENAME_ENOENT_ONCE_PATTERN ?? "";
  if (exactTarget !== "") {
    if (to !== exactTarget) return false;
  } else if (pattern === "" || !to.includes(pattern)) {
    return false;
  }
  const kind = stringValue(operation.kind);
  if (
    (kind == null || !kind.includes("quarantine")) &&
    process.env.QMD_GRAPHRAG_TEST_ALLOW_NON_QUARANTINE_RENAME_ENOENT !== "1"
  ) {
    return false;
  }
  testRenameEnoentInjected = true;
  return true;
}

async function quarantineTarget(
  path: string,
  reason: string,
  cause?: unknown,
  extra: Record<string, unknown> = {},
): Promise<never> {
  const operation = {
    ...newOperationEvidence(path, "quarantine"),
    localFailureClass: reason === "checksum_mismatch"
      ? "durable_checksum_mismatch"
      : "durable_target_invalid",
    checksumRecoveryDecision: "stop_until_fixed",
    ...extra,
  };
  const quarantinePath = `${path}.corrupt-${Date.now()}`;
  await renameWithEvidence(path, quarantinePath, operation);
  await fsyncDirectoryStrict(dirname(path), operation);
  const targetLabel = durableTargetLabel(path);
  const message = reason === "checksum_mismatch"
    ? `durable ${targetLabel} checksum mismatch: ${path}`
    : `invalid durable ${targetLabel} target: ${path}`;
  throw new DurableStateError(message, {
    localFailureClass: String(operation.localFailureClass),
    cause: cause instanceof Error ? cause : undefined,
    evidence: {
      ...operation,
      quarantineLocator: quarantinePath,
      redactedEvidenceLocator: redactedLocator(path),
    },
  });
}

function quarantineTargetSync(
  path: string,
  reason: string,
  cause?: unknown,
  extra: Record<string, unknown> = {},
): never {
  const operation = {
    ...newOperationEvidence(path, "quarantine"),
    localFailureClass: reason === "checksum_mismatch"
      ? "durable_checksum_mismatch"
      : "durable_target_invalid",
    checksumRecoveryDecision: "stop_until_fixed",
    ...extra,
  };
  const quarantinePath = `${path}.corrupt-${Date.now()}`;
  renameWithEvidenceSync(path, quarantinePath, operation);
  fsyncDirectoryStrictSync(dirname(path), operation);
  const targetLabel = durableTargetLabel(path);
  const message = reason === "checksum_mismatch"
    ? `durable ${targetLabel} checksum mismatch: ${path}`
    : `invalid durable ${targetLabel} target: ${path}`;
  throw new DurableStateError(message, {
    localFailureClass: String(operation.localFailureClass),
    cause: cause instanceof Error ? cause : undefined,
    evidence: {
      ...operation,
      quarantineLocator: quarantinePath,
      redactedEvidenceLocator: redactedLocator(path),
    },
  });
}

async function quarantineChecksumMetaSidecar(
  path: string,
  checksum: string,
  reason: "checksum_meta_invalid" | "checksum_meta_conflict",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const metaPath = durableChecksumMetaPath(path);
  const operation = checksumMetaSidecarQuarantineEvidence(
    path,
    checksum,
    reason,
    extra,
  );
  const quarantinePath = `${metaPath}.corrupt-${Date.now()}`;
  await renameWithEvidence(metaPath, quarantinePath, operation);
  await fsyncDirectoryStrict(dirname(metaPath), operation);
  await appendDurableRecoveryRecord(dirname(path), {
    ...operation,
    event: "durable_checksum_meta_sidecar_quarantined",
    status: "pending",
    quarantineLocator: quarantinePath,
    recoveredAt: new Date().toISOString(),
  });
}

function quarantineChecksumMetaSidecarSync(
  path: string,
  checksum: string,
  reason: "checksum_meta_invalid" | "checksum_meta_conflict",
  extra: Record<string, unknown> = {},
): void {
  const metaPath = durableChecksumMetaPath(path);
  const operation = checksumMetaSidecarQuarantineEvidence(
    path,
    checksum,
    reason,
    extra,
  );
  const quarantinePath = `${metaPath}.corrupt-${Date.now()}`;
  renameWithEvidenceSync(metaPath, quarantinePath, operation);
  fsyncDirectoryStrictSync(dirname(metaPath), operation);
  appendDurableRecoveryRecordSync(dirname(path), {
    ...operation,
    event: "durable_checksum_meta_sidecar_quarantined",
    status: "pending",
    quarantineLocator: quarantinePath,
    recoveredAt: new Date().toISOString(),
  });
}

function checksumMetaSidecarQuarantineEvidence(
  path: string,
  checksum: string,
  reason: "checksum_meta_invalid" | "checksum_meta_conflict",
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const metaPath = durableChecksumMetaPath(path);
  return {
    ...newOperationEvidence(metaPath, "checksum-meta-quarantine"),
    ...sidecarEvidence(metaPath),
    localFailureClass: reason === "checksum_meta_invalid"
      ? "durable_checksum_meta_invalid"
      : "durable_checksum_meta_conflict",
    checksumExpected: extra.checksumExpected ?? checksum,
    checksumActual: extra.checksumActual ?? checksum,
    checksumRecoveryDecision: "checksum_meta_sidecar_repaired",
    repairAllowed: true,
    durableMode: "strict",
    completedPublishRule: "forbidden",
    ...extra,
  };
}

async function fsyncDirectoryStrict(
  path: string,
  operation: Record<string, unknown>,
): Promise<void> {
  let fd: number | null = null;
  const fsyncOperation = directoryFsyncEvidence(path, operation);
  try {
    maybeInjectDirectoryFsyncFailure(path, fsyncOperation);
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const fsyncErrno = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new DurableStateError(`durable directory fsync failed: ${path}`, {
      localFailureClass: "durable_directory_fsync_uncertain",
      cause: error as Error,
      evidence: {
        ...fsyncOperation,
        fsyncTarget: path,
        fsyncErrno,
        fsyncPlatform: process.platform,
        unavailableFieldSentinels:
          fsyncErrnoSentinel(fsyncErrno) ? ["fsyncErrno"] : undefined,
        durableMode: "strict",
        completedPublishRule: "forbidden",
        redactedEvidenceLocator: redactedLocator(path),
      },
    });
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function fsyncDirectoryStrictSync(
  path: string,
  operation: Record<string, unknown>,
): void {
  let fd: number | null = null;
  const fsyncOperation = directoryFsyncEvidence(path, operation);
  try {
    maybeInjectDirectoryFsyncFailure(path, fsyncOperation);
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const fsyncErrno = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new DurableStateError(`durable directory fsync failed: ${path}`, {
      localFailureClass: "durable_directory_fsync_uncertain",
      cause: error as Error,
      evidence: {
        ...fsyncOperation,
        fsyncTarget: path,
        fsyncErrno,
        fsyncPlatform: process.platform,
        unavailableFieldSentinels:
          fsyncErrnoSentinel(fsyncErrno) ? ["fsyncErrno"] : undefined,
        durableMode: "strict",
        completedPublishRule: "forbidden",
        redactedEvidenceLocator: redactedLocator(path),
      },
    });
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function fsyncErrnoSentinel(errno: string): boolean {
  return errno === "" ||
    ["unknown", "unsupported", "unavailable", "platform_no_errno"]
      .includes(errno);
}

function maybeInjectDirectoryFsyncFailure(
  path: string,
  operation: Record<string, unknown>,
): void {
  if (process.env.QMD_GRAPHRAG_ENABLE_TEST_HOOKS !== "1") return;
  if (testDirectoryFsyncFailureInjected) return;
  const pattern = process.env
    .QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_PATTERN ?? "";
  if (pattern === "") return;
  const candidates = [
    path,
    stringValue(operation.directoryTargetLocator),
    stringValue(operation.targetLocator),
    stringValue(operation.primaryTargetLocator),
    stringValue(operation.sidecarTargetLocator),
    stringValue(operation.fsyncTarget),
  ].filter((value): value is string => value != null && value.length > 0);
  if (!candidates.some((candidate) => candidate.includes(pattern))) return;
  testDirectoryFsyncFailureMatchCount += 1;
  const afterMatches = Math.max(
    0,
    Number.parseInt(
      process.env.QMD_GRAPHRAG_TEST_DIRECTORY_FSYNC_FAILURE_AFTER_MATCHES ??
        "0",
      10,
    ) || 0,
  );
  if (testDirectoryFsyncFailureMatchCount <= afterMatches) return;
  testDirectoryFsyncFailureInjected = true;
  const error = new Error("injected directory fsync failure") as Error & {
    code?: string;
  };
  error.code = "EIO";
  throw error;
}

function directoryFsyncEvidence(
  path: string,
  operation: Record<string, unknown>,
): Record<string, unknown> {
  const primaryTargetLocator =
    stringValue(operation.primaryTargetLocator) ??
    stringValue(operation.targetLocator);
  const primaryDurableKind =
    stringValue(operation.primaryDurableKind) ??
    stringValue(operation.durableKind) ??
    stringValue(operation.kind);
  return {
    ...operation,
    directoryTargetLocator: path,
    directoryDurableKind: "directory",
    primaryTargetLocator,
    primaryDurableKind,
    fsyncTarget: path,
    targetMappingRule:
      operation.targetMappingRule === "nonProductionDefault"
        ? operation.targetMappingRule
        : "derivedDirectoryFsync",
  };
}

function durableFileFsyncError(
  path: string,
  error: unknown,
  operation: Record<string, unknown>,
): DurableStateError {
  return new DurableStateError(`durable file fsync failed: ${path}`, {
    localFailureClass: "durable_fsync_failed",
    cause: error as Error,
    evidence: {
      ...operation,
      fsyncTarget: path,
      fsyncErrno: (error as NodeJS.ErrnoException).code ?? "unknown",
      fsyncPlatform: process.platform,
      durableMode: "strict",
      completedPublishRule: "forbidden",
      redactedEvidenceLocator: redactedLocator(path),
    },
  });
}

function classifyDurableWriteError(
  error: unknown,
  operation: Record<string, unknown>,
): unknown {
  if (error instanceof DurableStateError) return error;
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    return new DurableStateError(
      `local_state_integrity durable_temp_create_collision: ${operation.targetLocator}`,
      {
        localFailureClass: "durable_temp_create_collision",
        cause: error as Error,
        evidence: {
          ...operation,
          errno: "EEXIST",
          redactedEvidenceLocator: redactedLocator(
            String(operation.targetLocator ?? ""),
          ),
        },
      },
    );
  }
  return error;
}

function validateText(kind: "yaml" | "json", text: string, path: string): void {
  if (kind === "json") {
    JSON.parse(text);
    return;
  }
  YAML.parse(text);
}

function rejectDurableAuxiliaryTarget(path: string): void {
  if (!isDurableAuxiliaryPath(path)) return;
  throw new DurableStateError(`durable auxiliary target rejected: ${path}`, {
    localFailureClass: "durable_auxiliary_target_rejected",
    evidence: {
      targetLocator: path,
      redactedEvidenceLocator: redactedLocator(path),
      durableMode: "strict",
    },
  });
}

function isDurableAuxiliaryPath(path: string): boolean {
  const name = basename(path);
  return name.endsWith(".owner.json") ||
    name.endsWith(".sha256") ||
    name.endsWith(".sha256.meta.json") ||
    name.endsWith(".lock") ||
    name.includes(".tmp-") ||
    name.includes(".corrupt-");
}

function durableTargetLabel(path: string): "JSON" | "YAML" {
  return path.endsWith(".json") ? "JSON" : "YAML";
}

function checksumCommitEvidenceMatches(
  path: string,
  checksum: string,
  meta: Record<string, unknown> | null,
): boolean {
  if (meta == null || meta.checksum !== checksum) return false;
  if (stringValue(meta.operationId) == null) return false;
  if (stringValue(meta.runnerSessionId) == null) return false;
  if (stringValue(meta.fencingTokenHash) == null) return false;
  if (numberValue(meta.targetGeneration) == null) return false;
  const locator = stringValue(meta.targetLocator);
  return locator == null || locator === path || basename(locator) === basename(path);
}

function checksumMetaIsPending(meta: Record<string, unknown> | null): boolean {
  return meta?.commitState === "target_rename_pending" ||
    meta?.checksumRecoveryDecision === "target_rename_pending";
}

function committedChecksumMeta(
  path: string,
  checksum: string,
  decision: string,
): Record<string, unknown> {
  return {
    ...newOperationEvidence(path, "checksum"),
    checksum,
    checksumPath: durableChecksumPath(path),
    checksumRecoveryDecision: decision,
    commitState: "committed",
    committedAt: new Date().toISOString(),
  };
}

function checksumMetaIsInvalid(
  checksum: string,
  meta: Record<string, unknown> | null,
): boolean {
  return meta != null && meta.checksum !== checksum;
}

function durableLockOwnerExpired(
  owner: Record<string, unknown> | null,
  entry: { mtimeMs: number },
): boolean {
  if (owner == null) return false;
  const expiresAt = stringValue(owner.expiresAt);
  const expiryMs = expiresAt == null ? NaN : Date.parse(expiresAt);
  if (Number.isFinite(expiryMs)) return Date.now() > expiryMs;
  return Date.now() - entry.mtimeMs > DurableLockStaleMs;
}

function durableLockOwnerHasRecoveryFence(
  owner: Record<string, unknown> | null,
): boolean {
  return numberValue(owner?.generation) != null &&
    stringValue(owner?.fencingTokenHash) != null &&
    stringValue(owner?.runnerSessionId) != null &&
    stringValue(owner?.operationId) != null;
}

function durableLockOwnerLocal(owner: Record<string, unknown> | null): boolean {
  const ownerHost = stringValue(owner?.ownerHost ?? owner?.runnerHost ?? owner?.host);
  return ownerHost == null || ownerHost === Host;
}

function durableLockOwnerAlive(owner: Record<string, unknown> | null): boolean {
  const ownerPid = numberValue(owner?.ownerPid ?? owner?.pid);
  return durableLockOwnerLocal(owner) && ownerPid != null && processAlive(ownerPid);
}

function durableLockOwnerDeadSameHost(owner: Record<string, unknown> | null): boolean {
  const ownerPid = numberValue(owner?.ownerPid ?? owner?.pid);
  return durableLockOwnerLocal(owner) && ownerPid != null && !processAlive(ownerPid);
}

function durableTempOwnerMatchesTarget(
  owner: Record<string, unknown> | null,
  path: string,
): boolean {
  if (owner == null) return false;
  const locator = stringValue(owner.targetLocator);
  return locator === path || locator === basename(path);
}

function durableTempOwnerCreatedAtMs(
  owner: Record<string, unknown> | null,
): number | null {
  const createdAt = stringValue(owner?.createdAt);
  if (createdAt == null) return null;
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs) ? createdAtMs : null;
}

function durableTempOwnerExpiresAtMs(
  owner: Record<string, unknown> | null,
): number | null {
  const expiresAt = stringValue(owner?.expiresAt);
  if (expiresAt == null) return null;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) ? expiresAtMs : null;
}

function durableTempOwnerHasCleanupFence(
  owner: Record<string, unknown> | null,
): boolean {
  return numberValue(owner?.leaseGeneration) != null &&
    numberValue(owner?.targetGeneration) != null &&
    stringValue(owner?.targetChecksumBefore) != null &&
    stringValue(owner?.fencingTokenHash) != null;
}

function durableTempTargetGenerationAdvanced(
  owner: Record<string, unknown> | null,
  path: string,
): boolean {
  return readDurableChecksumSync(path) !== stringValue(owner?.targetChecksumBefore);
}

function assertDurableLockStillOwned(
  lockPath: string,
  expected: Record<string, unknown>,
): void {
  const current = readJsonSidecarSync(lockPath);
  if (durableLockOwnerMatches(current, expected)) {
    return;
  }
  throw new DurableStateError(`durable lock fencing rejected: ${lockPath}`, {
    localFailureClass: "stale_writer_commit_rejected",
    evidence: {
      targetLocator: expected.targetLocator,
      lockPath,
      lockOwnerEvidence: {
        expected,
        current,
      },
      lane: expected.lane,
      targetMappingOwner: expected.targetMappingOwner,
      operationId: expected.operationId,
      durableMode: "strict",
      completedPublishRule: "forbidden",
      redactedEvidenceLocator: redactedLocator(lockPath),
    },
  });
}

function durableLockOwnedBy(
  lockPath: string,
  expected: Record<string, unknown>,
): boolean {
  return durableLockOwnerMatches(readJsonSidecarSync(lockPath), expected);
}

function durableLockOwnerMatches(
  current: Record<string, unknown> | null,
  expected: Record<string, unknown>,
): boolean {
  return current != null &&
    current.operationId === expected.operationId &&
    current.runnerSessionId === expected.runnerSessionId &&
    current.generation === expected.generation &&
    current.fencingTokenHash === expected.fencingTokenHash;
}

function newOperationEvidence(
  path: string,
  kind: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const operationId = randomUUID();
  const tempId = `${process.pid}-${Date.now()}-${operationId}`;
  const mapping = durableTargetMapping(path, kind);
  const normalization = normalizeDurableTargetForMapping(path);
  return {
    tempId,
    operationId,
    targetLocator: path,
    kind,
    ...mapping,
    primaryTargetLocator:
      mapping.primaryTargetLocator ?? normalization.primaryTargetLocator,
    ...extra,
    runnerSessionId: SessionId,
    runId: stringEnv("QMD_GRAPHRAG_RUN_ID"),
    workerId: stringEnv("QMD_GRAPHRAG_WORKER_ID"),
    itemId: stringEnv("QMD_GRAPHRAG_ITEM_ID"),
    bookId: stringEnv("QMD_GRAPHRAG_BOOK_ID"),
    ownerPid: process.pid,
    ownerHost: Host,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + DurableLockStaleMs).toISOString(),
    leaseGeneration: numberEnv("QMD_GRAPHRAG_BOOK_LEASE_GENERATION"),
    targetGeneration: numberEnv("QMD_GRAPHRAG_BOOK_LEASE_GENERATION") ?? 1,
    targetChecksumBefore: readDurableChecksumSync(path) ?? null,
    completedPublishRule: "forbidden",
    fencingTokenHash: hashOptional(
      process.env.QMD_GRAPHRAG_BOOK_FENCING_TOKEN ??
        process.env.QMD_GRAPHRAG_ITEM_FENCING_TOKEN,
    ) ?? hashText([
      "durable-state-store",
      SessionId,
      path,
      String(numberEnv("QMD_GRAPHRAG_BOOK_LEASE_GENERATION") ?? 1),
    ].join(":")),
    durableAdapterContract: DurableAdapterContract,
  };
}

function sidecarEvidence(path: string): Record<string, unknown> {
  if (path.endsWith(".sha256.meta.json")) {
    const primaryPath = path.slice(0, -".sha256.meta.json".length);
    return {
      primaryTargetLocator: primaryPath,
      primaryDurableKind: primaryDurableKindForPath(primaryPath),
      sidecarTargetLocator: path,
      sidecarKind: "checksum_meta",
    };
  }
  if (path.endsWith(".sha256")) {
    const primaryPath = path.slice(0, -".sha256".length);
    return {
      primaryTargetLocator: primaryPath,
      primaryDurableKind: primaryDurableKindForPath(primaryPath),
      sidecarTargetLocator: path,
      sidecarKind: "checksum",
    };
  }
  return {};
}

function primaryDurableKindForPath(path: string): string {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".jsonl")) return "jsonl";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".sqlite")) return "sqlite";
  return "file";
}

function checksumMetaWriteEvidence(
  path: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (!path.endsWith(".sha256.meta.json")) return sidecarEvidence(path);
  const checksum = stringValue(value.checksum);
  const hasExpected = Object.hasOwn(value, "checksumExpected");
  return {
    ...sidecarEvidence(path),
    checksum,
    checksumExpected: hasExpected
      ? (stringValue(value.checksumExpected) ?? null)
      : checksum ?? null,
    checksumActual: stringValue(value.checksumActual) ?? checksum,
    checksumRecoveryDecision: stringValue(value.checksumRecoveryDecision),
    repairAllowed: typeof value.repairAllowed === "boolean"
      ? value.repairAllowed
      : true,
  };
}

function newLockOwner(path: string): Record<string, unknown> {
  const mapping = durableTargetMapping(path, "lock");
  return {
    pid: process.pid,
    host: Host,
    runnerSessionId: SessionId,
    generation: numberEnv("QMD_GRAPHRAG_BOOK_LEASE_GENERATION") ?? 1,
    fencingTokenHash: hashOptional(
      process.env.QMD_GRAPHRAG_BOOK_FENCING_TOKEN ??
        process.env.QMD_GRAPHRAG_ITEM_FENCING_TOKEN,
    ) ?? hashText([
      "durable-state-lock",
      SessionId,
      path,
      String(numberEnv("QMD_GRAPHRAG_BOOK_LEASE_GENERATION") ?? 1),
    ].join(":")),
    targetLocator: path,
    ...mapping,
    operationId: randomUUID(),
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + DurableLockStaleMs).toISOString(),
    createdAt: new Date().toISOString(),
    durableAdapterContract: DurableAdapterContract,
  };
}

async function readJsonSidecar(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readJsonSidecarSync(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readChecksumMetaState(path: string): {
  status: "missing" | "invalid" | "present";
  meta: Record<string, unknown> | null;
  error?: unknown;
} {
  const metaPath = durableChecksumMetaPath(path);
  try {
    return {
      status: "present",
      meta: JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", meta: null };
    }
    return { status: "invalid", meta: null, error };
  }
}

function mkdirSyncRecursive(path: string): void {
  mkdirSync(path, { recursive: true });
}

function processAlive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || pid == null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberEnv(name: string): number | undefined {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringEnv(name: string): string | undefined {
  const value = process.env[name];
  return value == null || value === "" ? undefined : value;
}

function hashOptional(value: string | undefined): string | undefined {
  return value == null || value === "" ? undefined : hashText(value);
}

function durableTargetMapping(
  path: string,
  kind: string,
): Record<string, unknown> {
  const normalized = path.split("\\").join("/");
  const normalization = normalizeDurableTargetForMapping(normalized);
  const mappingPath = normalization.primaryTargetLocator;
  const fileName = basename(path);
  const mapped = DurableTargetMappingTable.find(({ pattern }) =>
    pattern.test(mappingPath)
  );
  if (mapped == null && isProductionDurableTarget(mappingPath, kind)) {
    throw new DurableStateError(`durable target mapping missing: ${path}`, {
      localFailureClass: "durable_target_mapping_missing",
      evidence: {
        targetLocator: path,
        ...durableTargetNormalizationEvidence(normalization),
        durableKind: kind,
        durableMode: "strict",
        completedPublishRule: "forbidden",
        redactedEvidenceLocator: fileName,
      },
    });
  }
  const owner = mapped?.targetMappingOwner ?? inferTargetMappingOwner(normalized);
  const lane = mapped?.lane ?? inferTargetMappingLane(normalized);
  const durableKind = kind === "lock"
    ? "json-lock"
    : mapped?.durableKind ?? kind;
  return {
    targetMappingRule: mapped == null ? "nonProductionDefault" : "explicit",
    targetMappingPattern: mapped?.pattern.source,
    ...durableTargetNormalizationEvidence(normalization),
    lane,
    targetMappingOwner: owner,
    durableKind,
    laneTimeoutMs: DurableDefaultLaneTimeoutMs,
    releaseOn: DurableReleaseOn,
    redactedEvidenceLocator: fileName,
    durableMode: "strict",
  };
}

function isProductionDurableTarget(path: string, kind: string): boolean {
  return path.includes("/graph_vault/") ||
    path.endsWith("/.qmd/index.sqlite") ||
    path.endsWith("/index.sqlite") ||
    kind === "sqlite-lock";
}

function inferTargetMappingLane(path: string): string {
  if (path.endsWith("/index.sqlite") || path.endsWith("/.qmd/index.sqlite")) {
    return "qmdIndexWriterLane";
  }
  if (path.includes("/batch-runs/") && path.includes("/items/")) {
    return "checkpointWriterLane";
  }
  if (path.includes("/batch-runs/") && path.includes("/book-leases/")) {
    return "checkpointWriterLane";
  }
  if (path.includes("/books/")) return "checkpointWriterLane";
  if (path.endsWith("/settings.yaml")) return "catalogWriterLane";
  if (path.includes("/catalog/batch-runs/")) return "manifestWriterLane";
  if (path.includes("/catalog/")) return "catalogWriterLane";
  return "durableStateStoreLane";
}

function inferTargetMappingOwner(path: string): string {
  if (path.endsWith("/index.sqlite") || path.endsWith("/.qmd/index.sqlite")) {
    return "qmd";
  }
  if (path.endsWith("/settings.yaml")) return "settingsProjection";
  if (path.includes("/graph-capabilities.yaml")) return "capabilityCatalog";
  if (path.includes("/batch-runs/")) return "batchCoordinator";
  if (path.includes("/dspy/")) return "dspyPolicyStore";
  return "repository";
}

function redactedLocator(path: string): string {
  return basename(path);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function sleepSync(ms: number): void {
  const array = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(array, 0, 0, ms);
}
