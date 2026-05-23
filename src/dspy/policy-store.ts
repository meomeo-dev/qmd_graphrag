import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import YAML from "yaml";

import { QueryExpansionItemSchema, SchemaVersion } from "../contracts/common.js";
import type { QueryExpansionItem } from "../contracts/common.js";
import {
  DspyEvaluationReportSchema,
  DspyEvaluationDatasetSchema,
  DspyExpansionPolicySchema,
  DspyGeneratedExpansionRecordSchema,
  DspyMetricSpecSchema,
  DspyOptimizationArtifactSchema,
  DspyOptimizationRunSchema,
  DspyPointerLockErrorSchema,
  DspyPolicyPointerSchema,
  DspyPromotionDecisionSchema,
  DspyPromotionHistoryEntrySchema,
  DspyQueryExpansionProgramInputSchema,
  DspyQueryExpansionProgramOutputSchema,
  QueryExpansionFailurePolicySchema,
  VaultRelativePathSchema,
} from "../contracts/dspy.js";
import type {
  DspyEvaluationReport,
  DspyEvaluationDataset,
  DspyExpansionPolicy,
  DspyFingerprintSet,
  DspyGeneratedExpansionRecord,
  DspyMetricSpec,
  DspyOptimizationArtifact,
  DspyOptimizationRequestSummary,
  DspyOptimizationResponseSummary,
  DspyOptimizationRun,
  DspyPolicyPointer,
  DspyPointerLockError as DspyPointerLockErrorPayload,
  DspyPromotionDecision,
  DspyPromotionHistoryEntry,
  DspyQueryPromptOptimizationRequest,
  DspyQueryPromptOptimizationResponse,
  DspyExpansionFailureReason,
  QueryExpansionFailureAction,
  QueryExpansionFailurePolicy,
  QueryExpansionFailureReason,
} from "../contracts/dspy.js";
import { createDeterministicHash, createRunId } from "../job-state/fingerprint.js";

export const DSPY_POLICY_POINTER_RELATIVE_PATH =
  "dspy/policies/query-expansion/current.yaml";

const DefaultFailurePolicy: QueryExpansionFailurePolicy = {
  schemaVersion: SchemaVersion,
  defaultAction: "fallback_to_builtin_expander",
  reasonActions: {},
  strictSchema: true,
};

const NativeFallbackReasons = new Set<QueryExpansionFailureReason>([
  "pointer_missing",
  "decision_missing",
  "policy_unavailable",
]);

export type DspyPolicyStoreOptions = {
  graphVault: string;
  pointerPath?: string;
  failurePolicy?: QueryExpansionFailurePolicy;
  actor?: string;
  now?: () => Date;
};

export type RuntimeFingerprintInput = Partial<DspyFingerprintSet> & {
  model?: string;
  provider?: string;
  retrieval?: string;
  corpus?: string;
  index?: string;
  retriever?: string;
  reranker?: string;
  schema?: string;
};

export type DspyArtifactWriteInput = {
  request: DspyQueryPromptOptimizationRequest;
  response: DspyQueryPromptOptimizationResponse;
  fingerprints: RuntimeFingerprintInput;
  providerEnvRefs?: string[];
  runId?: string;
  metricVersion?: string;
  runtimeProjection?: DspyOptimizationArtifact["runtimeProjection"];
  maxExpansionItems?: number;
  metricSpec?: DspyMetricSpec;
};

export type DspyArtifactWriteResult = {
  run: DspyOptimizationRun;
  runPath: string;
  artifact: DspyOptimizationArtifact;
  artifactPath: string;
};

export type DspyPolicyEvaluationInput = {
  artifactPath: string;
  datasetId?: string;
  metricVersion?: string;
};

export type DspyMetricSpecWriteInput = {
  metricVersion: string;
  name?: string;
  description: string;
  maxMetricCalls?: number;
  maxTotalTokens?: number;
  maxExpansionItems?: number;
};

export type DspyEvaluationDatasetWriteInput = {
  datasetId: string;
  datasetPath?: string;
  trainsetPath?: string;
  valsetPath?: string;
  testsetPath?: string;
};

export type DspyRegistryWriteResult<T> = {
  value: T;
  path: string;
};

export type DspyPromotionInput = {
  artifactPath: string;
  reportPath: string;
  reason: string;
  failurePolicy?: QueryExpansionFailurePolicy;
};

export type DspyExpansionResult =
  | {
      status: "expanded";
      expansions: QueryExpansionItem[];
      policy: DspyExpansionPolicy;
    }
  | {
      status: "fallback";
      reason: DspyExpansionFailureReason;
    }
  | {
      status: "strict_refuse";
      reason: DspyExpansionFailureReason;
      message: string;
    };

export class DspyPointerLockError extends Error {
  readonly payload: DspyPointerLockErrorPayload;

  constructor(payload: DspyPointerLockErrorPayload) {
    super(payload.redactedMessage);
    this.name = "DspyPointerLockError";
    this.payload = payload;
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function loadYamlFile(path: string): unknown {
  return YAML.parse(readFileSync(path, "utf-8"));
}

function writeYamlFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = YAML.stringify(value, { indent: 2, lineWidth: 0 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, path);
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, path);
}

function withDirectoryLock<T>(
  lockPath: string,
  onLocked: () => DspyPointerLockErrorPayload,
  operation: () => T,
): T {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath, { recursive: false });
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === "EEXIST") {
      throw new DspyPointerLockError(onLocked());
    }
    throw error;
  }

  try {
    return operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function normalizeVaultRoot(graphVault: string): string {
  return resolve(graphVault);
}

function normalizeVaultRelative(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  return VaultRelativePathSchema.parse(normalized);
}

function toVaultRelative(graphVault: string, path: string): string {
  if (!isAbsolute(path)) return normalizeVaultRelative(path);
  const root = normalizeVaultRoot(graphVault);
  const rel = relative(root, resolve(path)).replace(/\\/g, "/");
  if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
    throw new Error(`path is outside graph_vault: ${path}`);
  }
  return normalizeVaultRelative(rel);
}

function normalizePointerRelative(graphVault: string, path: string): string {
  if (isAbsolute(path)) return toVaultRelative(graphVault, path);

  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (normalized.startsWith("dspy/")) return normalizeVaultRelative(normalized);
  if (normalized.startsWith("graph_vault/dspy/")) {
    return normalizeVaultRelative(normalized.slice("graph_vault/".length));
  }

  const vaultName = basename(normalizeVaultRoot(graphVault));
  const prefixed = `${vaultName}/`;
  if (normalized.startsWith(prefixed)) {
    return normalizeVaultRelative(normalized.slice(prefixed.length));
  }

  return normalizeVaultRelative(normalized);
}

function resolveVaultPath(graphVault: string, path: string): string {
  const rel = normalizeVaultRelative(path);
  const root = normalizeVaultRoot(graphVault);
  const resolved = resolve(root, rel);
  const relativePath = relative(root, resolved);
  if (
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    relativePath.length === 0
  ) {
    throw new Error(`path is outside graph_vault: ${path}`);
  }
  return resolved;
}

function maybeHashFile(graphVault: string, relativePath: string | undefined): string | undefined {
  if (!relativePath) return undefined;
  const absolute = resolveVaultPath(graphVault, relativePath);
  if (!existsSync(absolute)) return undefined;
  return sha256Text(readFileSync(absolute, "utf-8"));
}

function fileHashOrThrow(graphVault: string, relativePath: string): string {
  const absolute = resolveVaultPath(graphVault, relativePath);
  if (!existsSync(absolute)) {
    throw Object.assign(new Error(`artifact file missing: ${relativePath}`), {
      code: "ENOENT",
    });
  }
  return sha256Text(readFileSync(absolute, "utf-8"));
}

function parseGeneratedExpansionRecords(path: string): DspyGeneratedExpansionRecord[] {
  if (!existsSync(path)) {
    throw Object.assign(new Error(`generated expansion file missing: ${path}`), {
      code: "ENOENT",
    });
  }
  const records: DspyGeneratedExpansionRecord[] = [];
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as unknown;
    const normalized =
      typeof parsed === "object" && parsed != null && Array.isArray((parsed as any).output)
        ? {
            ...(parsed as Record<string, unknown>),
            output: ((parsed as any).output as unknown[]).map((item) => {
              if (Array.isArray(item)) {
                return { type: item[0], text: item[1] };
              }
              return item;
            }),
          }
        : parsed;
    records.push(DspyGeneratedExpansionRecordSchema.parse(normalized));
  }
  return records;
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function validateOutputItems(
  items: QueryExpansionItem[],
  maxExpansionItems: number,
): QueryExpansionItem[] {
  return items
    .map((item) => QueryExpansionItemSchema.parse(item))
    .filter((item) => item.text.trim().length > 0)
    .slice(0, maxExpansionItems);
}

function policyAction(
  policy: QueryExpansionFailurePolicy,
  reason: QueryExpansionFailureReason,
): QueryExpansionFailureAction {
  if (NativeFallbackReasons.has(reason)) {
    return "fallback_to_builtin_expander";
  }
  if (policy.strictSchema !== true) {
    return "strict_refuse";
  }
  return policy.reasonActions?.[reason] ?? policy.defaultAction;
}

function resolveFingerprints(input: RuntimeFingerprintInput): DspyFingerprintSet {
  return {
    modelFingerprint: input.modelFingerprint ?? input.model ?? "unspecified-model",
    providerFingerprint:
      input.providerFingerprint ?? input.provider ?? "unspecified-provider",
    retrievalConfigFingerprint:
      input.retrievalConfigFingerprint ?? input.retrieval ?? "unspecified-retrieval",
    corpusSnapshotFingerprint:
      input.corpusSnapshotFingerprint ?? input.corpus ?? "unspecified-corpus",
    indexSnapshotFingerprint:
      input.indexSnapshotFingerprint ?? input.index ?? "unspecified-index",
    retrieverFingerprint:
      input.retrieverFingerprint ?? input.retriever ?? "unspecified-retriever",
    rerankerFingerprint:
      input.rerankerFingerprint ?? input.reranker ?? "unspecified-reranker",
    schemaFingerprint:
      input.schemaFingerprint ?? input.schema ?? `schema:${SchemaVersion}`,
  };
}

function isStale(
  current: DspyFingerprintSet | undefined,
  policy: DspyFingerprintSet,
): boolean {
  if (!current) return false;
  return (
    current.modelFingerprint !== policy.modelFingerprint ||
    current.providerFingerprint !== policy.providerFingerprint ||
    current.retrievalConfigFingerprint !== policy.retrievalConfigFingerprint ||
    current.corpusSnapshotFingerprint !== policy.corpusSnapshotFingerprint ||
    current.indexSnapshotFingerprint !== policy.indexSnapshotFingerprint ||
    current.retrieverFingerprint !== policy.retrieverFingerprint ||
    current.rerankerFingerprint !== policy.rerankerFingerprint ||
    current.schemaFingerprint !== policy.schemaFingerprint
  );
}

function commandBasename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

function redactedDiagnosticText(value: string): string {
  return value
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, "[REDACTED_PATH]")
    .replace(/\/[^\s"']+/g, "[REDACTED_PATH]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED_SECRET]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_SECRET]")
    .slice(0, 4000);
}

function pointerLockPayload(input: {
  pointerPath: string;
  lockPath: string;
  message: string;
}): DspyPointerLockErrorPayload {
  return DspyPointerLockErrorSchema.parse({
    schemaVersion: SchemaVersion,
    code: "dspy_pointer_lock_unavailable",
    pointerPath: input.pointerPath,
    lockPath: input.lockPath,
    redactedMessage: redactedDiagnosticText(input.message),
  });
}

function registrySlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "record";
  return `${normalized}-${createDeterministicHash(value).slice(0, 12)}`;
}

function countJsonlRecords(path: string | undefined): number {
  if (!path || !existsSync(path)) return 0;
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .length;
}

function requestSummary(
  request: DspyQueryPromptOptimizationRequest,
): DspyOptimizationRequestSummary {
  return {
    optimizer: request.optimizer,
    model: request.model,
    reflectionModel: request.reflectionModel,
    trainsetHash: sha256File(request.trainsetPath) ?? sha256Text(request.trainsetPath),
    valsetHash: request.valsetPath
      ? sha256File(request.valsetPath) ?? sha256Text(request.valsetPath)
      : undefined,
    auto: request.auto,
    maxMetricCalls: request.maxMetricCalls,
    limit: request.limit,
    valLimit: request.valLimit,
  };
}

function responseSummary(input: {
  response: DspyQueryPromptOptimizationResponse;
  savedPromptPath?: string;
  emitPath?: string;
}): DspyOptimizationResponseSummary {
  return {
    optimizer: input.response.optimizer,
    command: input.response.command.map(commandBasename),
    savedPromptPath: input.savedPromptPath,
    emitPath: input.emitPath,
    stdoutTail: input.response.stdoutTail.slice(-20).map(redactedDiagnosticText),
  };
}

function readPointerFile(path: string): DspyPolicyPointer | null {
  if (!existsSync(path)) return null;
  return DspyPolicyPointerSchema.parse(loadYamlFile(path));
}

function missingVaultPath(path: string): DspyExpansionFailureReason {
  if (path.includes("/promotions/")) return "decision_missing";
  if (path.includes("/artifacts/")) return "artifact_missing";
  if (path.includes("/artifact-files/")) return "generated_expansion_missing";
  return "artifact_missing";
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class DspyPolicyStore {
  readonly graphVault: string;
  private readonly pointerRelative: string;
  private readonly fallbackFailurePolicy?: QueryExpansionFailurePolicy;
  private readonly actor: string;
  private readonly now: () => Date;

  constructor(options: DspyPolicyStoreOptions) {
    this.graphVault = normalizeVaultRoot(options.graphVault);
    this.pointerRelative = options.pointerPath
      ? normalizePointerRelative(this.graphVault, options.pointerPath)
      : DSPY_POLICY_POINTER_RELATIVE_PATH;
    this.fallbackFailurePolicy = options.failurePolicy
      ? QueryExpansionFailurePolicySchema.parse(options.failurePolicy)
      : undefined;
    this.actor = options.actor ?? "qmd";
    this.now = options.now ?? (() => new Date());
  }

  static defaultFailurePolicy(): QueryExpansionFailurePolicy {
    return QueryExpansionFailurePolicySchema.parse(DefaultFailurePolicy);
  }

  pointerRelativePath(): string {
    return this.pointerRelative;
  }

  pointerPath(): string {
    return resolveVaultPath(this.graphVault, this.pointerRelativePath());
  }

  pointerLockRelativePath(): string {
    return normalizeVaultRelative(`${this.pointerRelativePath()}.lock`);
  }

  pointerLockPath(): string {
    return resolveVaultPath(this.graphVault, this.pointerLockRelativePath());
  }

  resolvePath(path: string): string {
    return resolveVaultPath(this.graphVault, path);
  }

  toRelativePath(path: string): string {
    return toVaultRelative(this.graphVault, path);
  }

  loadPointer(): DspyPolicyPointer | null {
    return readPointerFile(this.pointerPath());
  }

  restorePointerForCliFailure(
    previousPointer: DspyPolicyPointer | null,
    _reason: string,
  ): void {
    if (previousPointer) {
      writeYamlFile(this.pointerPath(), DspyPolicyPointerSchema.parse(previousPointer));
      return;
    }
    rmSync(this.pointerPath(), { force: true });
  }

  loadArtifact(path: string): DspyOptimizationArtifact {
    return DspyOptimizationArtifactSchema.parse(loadYamlFile(this.resolvePath(path)));
  }

  loadReport(path: string): DspyEvaluationReport {
    return DspyEvaluationReportSchema.parse(loadYamlFile(this.resolvePath(path)));
  }

  loadDecision(path: string): DspyPromotionDecision {
    return DspyPromotionDecisionSchema.parse(loadYamlFile(this.resolvePath(path)));
  }

  metricSpecPath(metricVersion: string): string {
    return normalizeVaultRelative(`dspy/metrics/${registrySlug(metricVersion)}.yaml`);
  }

  datasetPath(datasetId: string): string {
    return normalizeVaultRelative(`dspy/datasets/${registrySlug(datasetId)}.yaml`);
  }

  loadMetricSpec(metricVersion: string): DspyMetricSpec | null {
    const metricsDir = this.resolvePath("dspy/metrics");
    if (!existsSync(metricsDir)) return null;
    for (const name of readdirSync(metricsDir)) {
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      const spec = DspyMetricSpecSchema.parse(
        loadYamlFile(join(metricsDir, name)),
      );
      if (spec.metricVersion === metricVersion) return spec;
    }
    return null;
  }

  loadEvaluationDataset(datasetId: string): DspyEvaluationDataset | null {
    const datasetsDir = this.resolvePath("dspy/datasets");
    if (!existsSync(datasetsDir)) return null;
    for (const name of readdirSync(datasetsDir)) {
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      const dataset = DspyEvaluationDatasetSchema.parse(
        loadYamlFile(join(datasetsDir, name)),
      );
      if (dataset.datasetId === datasetId) return dataset;
    }
    return null;
  }

  writeMetricSpec(
    input: DspyMetricSpecWriteInput,
  ): DspyRegistryWriteResult<DspyMetricSpec> {
    const metric = DspyMetricSpecSchema.parse({
      schemaVersion: SchemaVersion,
      metricVersion: input.metricVersion,
      name: input.name ?? input.metricVersion,
      description: redactedDiagnosticText(input.description),
      maxMetricCalls: input.maxMetricCalls,
      maxTotalTokens: input.maxTotalTokens,
      maxExpansionItems: input.maxExpansionItems ?? 8,
    });
    const path = this.metricSpecPath(metric.metricVersion);
    writeYamlFile(this.resolvePath(path), metric);
    return { value: metric, path };
  }

  writeEvaluationDataset(
    input: DspyEvaluationDatasetWriteInput,
  ): DspyRegistryWriteResult<DspyEvaluationDataset> {
    const createdAt = nowIso(this.now);
    const copyDatasetFile = (
      sourcePath: string | undefined,
      role: "dataset" | "train" | "val" | "test",
    ): { path?: string; hash?: string; count: number } => {
      if (!sourcePath) return { count: 0 };
      const source = resolve(sourcePath);
      if (!existsSync(source)) {
        throw new Error(`DSPy dataset source does not exist: ${sourcePath}`);
      }
      const hash = sha256File(source)!;
      const ext = source.endsWith(".jsonl") ? ".jsonl" : "";
      const target = normalizeVaultRelative(
        `dspy/dataset-files/${registrySlug(input.datasetId)}/${role}-${hash.slice(0, 16)}${ext}`,
      );
      const targetPath = this.resolvePath(target);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, readFileSync(source));
      return { path: target, hash, count: countJsonlRecords(source) };
    };

    const datasetFile = copyDatasetFile(input.datasetPath, "dataset");
    const trainset = copyDatasetFile(input.trainsetPath, "train");
    const valset = copyDatasetFile(input.valsetPath, "val");
    const testset = copyDatasetFile(input.testsetPath, "test");
    const queryCount = datasetFile.count + trainset.count + valset.count + testset.count;
    const dataset = DspyEvaluationDatasetSchema.parse({
      schemaVersion: SchemaVersion,
      datasetId: input.datasetId,
      datasetPath: datasetFile.path,
      trainsetPath: trainset.path,
      valsetPath: valset.path,
      testsetPath: testset.path,
      trainsetHash: trainset.hash,
      valsetHash: valset.hash,
      testsetHash: testset.hash,
      queryCount,
      createdAt,
    });
    const path = this.datasetPath(dataset.datasetId);
    writeYamlFile(this.resolvePath(path), dataset);
    return { value: dataset, path };
  }

  writeOptimizationArtifact(input: DspyArtifactWriteInput): DspyArtifactWriteResult {
    const createdAt = nowIso(this.now);
    const runId = input.runId ?? createRunId("dspy-optimize", this.now());
    const runDir = normalizeVaultRelative(`dspy/runs/${runId}`);
    const fingerprints = resolveFingerprints(input.fingerprints);
    const metricVersion =
      input.metricSpec?.metricVersion ??
      input.metricVersion ??
      "dspy-query-expansion-schema-v1";
    const maxExpansionItems =
      input.maxExpansionItems ??
      input.metricSpec?.maxExpansionItems ??
      8;
    const promptSourceHash = sha256File(input.response.savedPromptPath);
    const generatedSourceHash = sha256File(input.response.emitPath);
    const reqSummary = requestSummary(input.request);
    const resSummarySeed = {
      optimizer: input.response.optimizer,
      command: input.response.command.map(commandBasename),
      savedPromptHash: promptSourceHash ?? null,
      generatedExpansionHash: generatedSourceHash ?? null,
    };
    const artifactHash = createDeterministicHash({
      requestSummary: reqSummary,
      responseSummary: resSummarySeed,
      fingerprints,
      metricVersion,
      maxExpansionItems,
    });
    const artifactId = `dspy-artifact-${artifactHash.slice(0, 16)}`;
    const artifactPath = normalizeVaultRelative(`dspy/artifacts/${artifactId}.yaml`);
    const promptArtifactPath = input.response.savedPromptPath
      ? this.copyExternalArtifact(input.response.savedPromptPath, artifactId, "prompt.txt")
      : undefined;
    const generatedExpansionPath = input.response.emitPath
      ? this.copyExternalArtifact(input.response.emitPath, artifactId, "generated.jsonl")
      : undefined;

    const artifact = DspyOptimizationArtifactSchema.parse({
      schemaVersion: SchemaVersion,
      artifactId,
      optimizer: input.request.optimizer,
      programName: "query_expansion",
      signatureVersion: "query-expansion-v1",
      runtimeProjection: input.runtimeProjection ?? "generated_expansion_records",
      requestMode: "online_policy",
      promotability: "promotable",
      promotionStatus: "candidate",
      createdAt,
      artifactHash,
      promptArtifactPath,
      promptArtifactHash: maybeHashFile(this.graphVault, promptArtifactPath),
      generatedExpansionPath,
      generatedExpansionHash: maybeHashFile(this.graphVault, generatedExpansionPath),
      providerCallLedgerPath: normalizeVaultRelative(`dspy/ledgers/${artifactId}.jsonl`),
      fingerprints,
      metricVersion,
      trainsetHash: reqSummary.trainsetHash,
      valsetHash: reqSummary.valsetHash,
      maxExpansionItems,
      providerEnvRefs: input.providerEnvRefs ?? [
        "JINA_API_BASE",
        "JINA_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
      ],
      stdoutTail: input.response.stdoutTail.slice(-20).map(redactedDiagnosticText),
    });
    const resSummary = responseSummary({
      response: input.response,
      savedPromptPath: promptArtifactPath,
      emitPath: generatedExpansionPath,
    });

    const run = DspyOptimizationRunSchema.parse({
      schemaVersion: SchemaVersion,
      runId,
      optimizer: input.request.optimizer,
      programName: "query_expansion",
      signatureVersion: artifact.signatureVersion,
      status: "succeeded",
      startedAt: createdAt,
      completedAt: createdAt,
      requestFingerprint: createDeterministicHash(reqSummary),
      responseFingerprint: createDeterministicHash(resSummary),
      requestSummary: reqSummary,
      responseSummary: resSummary,
      artifactId,
      runDir,
    });

    const runPath = normalizeVaultRelative(`${runDir}/run.yaml`);
    writeYamlFile(this.resolvePath(runPath), run);
    writeYamlFile(this.resolvePath(artifactPath), artifact);

    return { run, runPath, artifact, artifactPath };
  }

  evaluateExpansionPolicy(input: DspyPolicyEvaluationInput): DspyEvaluationReport {
    const artifactRelativePath = this.toRelativePath(input.artifactPath);
    const artifact = this.loadArtifact(artifactRelativePath);
    const dataset = input.datasetId
      ? this.loadEvaluationDataset(input.datasetId)
      : null;
    const metricSpec = input.metricVersion
      ? this.loadMetricSpec(input.metricVersion)
      : this.loadMetricSpec(artifact.metricVersion);
    const createdAt = nowIso(this.now);
    const reportId = `dspy-report-${createDeterministicHash({
      artifactId: artifact.artifactId,
      createdAt,
      datasetId: dataset?.datasetId ?? input.datasetId ?? null,
    }).slice(0, 16)}`;
    let totalRecords = 0;
    let validRecords = 0;
    let invalidRecords = 0;
    let failureReason: string | undefined;

    if (artifact.generatedExpansionPath) {
      try {
        const records = parseGeneratedExpansionRecords(
          this.resolvePath(artifact.generatedExpansionPath),
        );
        totalRecords = records.length;
        validRecords = records.filter((record) => record.output.length > 0).length;
        invalidRecords = totalRecords - validRecords;
      } catch (error) {
        failureReason = error instanceof Error ? error.message : String(error);
        invalidRecords = 1;
      }
    } else {
      failureReason = "artifact has no generatedExpansionPath";
      invalidRecords = 1;
    }

    const schemaValidity = invalidRecords === 0;
    const report = DspyEvaluationReportSchema.parse({
      schemaVersion: SchemaVersion,
      reportId,
      artifactId: artifact.artifactId,
      artifactHash: artifact.artifactHash,
      datasetId: dataset?.datasetId ?? input.datasetId,
      metricVersion: metricSpec?.metricVersion ?? input.metricVersion ?? artifact.metricVersion,
      createdAt,
      schemaValidity,
      promotability: schemaValidity && totalRecords > 0 ? "promotable" : "not_promotable",
      totalRecords,
      validRecords,
      invalidRecords,
      metrics: {
        schema_validity: schemaValidity,
        valid_record_ratio:
          totalRecords === 0 ? 0 : Number((validRecords / totalRecords).toFixed(6)),
        ...(dataset ? { dataset_query_count: dataset.queryCount } : {}),
        ...(metricSpec ? { metric_max_expansion_items: metricSpec.maxExpansionItems } : {}),
      },
      failureReason,
    });

    const reportPath = normalizeVaultRelative(`dspy/reports/${reportId}.yaml`);
    writeYamlFile(this.resolvePath(reportPath), report);
    return report;
  }

  promoteExpansionPolicy(input: DspyPromotionInput): DspyPromotionDecision {
    return withDirectoryLock(
      this.pointerLockPath(),
      () => pointerLockPayload({
        pointerPath: this.pointerRelativePath(),
        lockPath: this.pointerLockRelativePath(),
        message: "DSPy pointer is locked by another writer",
      }),
      () => this.promoteExpansionPolicyLocked(input),
    );
  }

  private promoteExpansionPolicyLocked(
    input: DspyPromotionInput,
  ): DspyPromotionDecision {
    const artifactPath = this.toRelativePath(input.artifactPath);
    const reportPath = this.toRelativePath(input.reportPath);
    const artifact = this.loadArtifact(artifactPath);
    const report = this.loadReport(reportPath);
    if (artifact.artifactId !== report.artifactId) {
      throw new Error("report does not reference the selected DSPy artifact");
    }
    if (!report.schemaValidity || report.promotability !== "promotable") {
      throw new Error("DSPy report is not promotable");
    }
    if (artifact.promotability !== "promotable" || artifact.requestMode !== "online_policy") {
      throw new Error("DSPy artifact is not promotable as an online policy");
    }
    this.validateArtifactFiles(artifact);

    const previousPointer = this.loadPointer();
    const decidedAt = nowIso(this.now);
    const decisionId = `dspy-decision-${createDeterministicHash({
      artifactId: artifact.artifactId,
      reportId: report.reportId,
      decidedAt,
    }).slice(0, 16)}`;
    const historyEntryId = `dspy-history-${createDeterministicHash({
      decisionId,
      previousPointer,
    }).slice(0, 16)}`;
    const decisionPath = normalizeVaultRelative(`dspy/promotions/${decisionId}.yaml`);
    const reportHash = sha256Text(YAML.stringify(report, { lineWidth: 0 }));

    const pointerAfter = DspyPolicyPointerSchema.parse({
      schemaVersion: SchemaVersion,
      pointerId: "query-expansion-current",
      provider: "dspy",
      active: true,
      currentDecisionId: decisionId,
      currentDecisionPath: decisionPath,
      failurePolicy: input.failurePolicy ?? DspyPolicyStore.defaultFailurePolicy(),
      updatedAt: decidedAt,
    });

    const decision = DspyPromotionDecisionSchema.parse({
      schemaVersion: SchemaVersion,
      decisionId,
      artifactId: artifact.artifactId,
      artifactHash: artifact.artifactHash,
      artifactPath,
      reportId: report.reportId,
      reportHash,
      reportPath,
      previousDecisionId: previousPointer?.currentDecisionId ?? null,
      previousPointerState: previousPointer,
      historyEntryId,
      decisionReason: input.reason,
      promotionStatus: "promoted",
      gateVerdict: "promote",
      decidedAt,
    });

    const history = DspyPromotionHistoryEntrySchema.parse({
      schemaVersion: SchemaVersion,
      historyEntryId,
      eventType: "promote",
      pointerBefore: previousPointer,
      pointerAfter,
      decisionId,
      actor: this.actor,
      createdAt: decidedAt,
    });

    writeYamlFile(this.resolvePath(decisionPath), decision);
    this.writeHistory(history);
    writeYamlFile(this.pointerPath(), pointerAfter);
    return decision;
  }

  disableExpansionPolicy(reason = "disabled by operator"): DspyPolicyPointer {
    return withDirectoryLock(
      this.pointerLockPath(),
      () => pointerLockPayload({
        pointerPath: this.pointerRelativePath(),
        lockPath: this.pointerLockRelativePath(),
        message: "DSPy pointer is locked by another writer",
      }),
      () => this.disableExpansionPolicyLocked(reason),
    );
  }

  private disableExpansionPolicyLocked(reason: string): DspyPolicyPointer {
    const before = this.loadPointer();
    if (before?.provider === "disabled" && !before.active) {
      return before;
    }
    const updatedAt = nowIso(this.now);
    const after = DspyPolicyPointerSchema.parse({
      schemaVersion: SchemaVersion,
      pointerId: "query-expansion-current",
      provider: "disabled",
      active: false,
      failurePolicy: before?.failurePolicy ?? DspyPolicyStore.defaultFailurePolicy(),
      updatedAt,
    });
    const history = DspyPromotionHistoryEntrySchema.parse({
      schemaVersion: SchemaVersion,
      historyEntryId: `dspy-history-${createDeterministicHash({
        event: "disable",
        updatedAt,
        before,
      }).slice(0, 16)}`,
      eventType: "disable",
      pointerBefore: before,
      pointerAfter: after,
      actor: this.actor,
      createdAt: updatedAt,
      recoveryMarker: reason,
    });
    this.writeHistory(history);
    writeYamlFile(this.pointerPath(), after);
    return after;
  }

  rollbackExpansionPolicy(): DspyPolicyPointer {
    return withDirectoryLock(
      this.pointerLockPath(),
      () => pointerLockPayload({
        pointerPath: this.pointerRelativePath(),
        lockPath: this.pointerLockRelativePath(),
        message: "DSPy pointer is locked by another writer",
      }),
      () => this.rollbackExpansionPolicyLocked(),
    );
  }

  private rollbackExpansionPolicyLocked(): DspyPolicyPointer {
    const before = this.loadPointer();
    if (!before?.currentDecisionPath) {
      const disabledHistory = this.restorableDisableHistoryEntry(before);
      const restored = disabledHistory?.pointerBefore;
      if (!restored) {
        throw new Error("no active DSPy policy pointer to rollback");
      }
      const after = DspyPolicyPointerSchema.parse({
        ...restored,
        updatedAt: nowIso(this.now),
      });
      const history = DspyPromotionHistoryEntrySchema.parse({
        schemaVersion: SchemaVersion,
        historyEntryId: `dspy-history-${createDeterministicHash({
          event: "rollback-disabled",
          before,
          after,
        }).slice(0, 16)}`,
        eventType: "rollback",
        pointerBefore: before,
        pointerAfter: after,
        decisionId: after.currentDecisionId,
        actor: this.actor,
        createdAt: after.updatedAt,
      });
      this.writeHistory(history);
      writeYamlFile(this.pointerPath(), after);
      return after;
    }
    const currentDecision = this.loadDecision(before.currentDecisionPath);
    const updatedAt = nowIso(this.now);
    const after = DspyPolicyPointerSchema.parse(
      currentDecision.previousPointerState
        ? {
            ...currentDecision.previousPointerState,
            updatedAt,
          }
        : {
            schemaVersion: SchemaVersion,
            pointerId: "query-expansion-current",
            provider: "builtin",
            active: false,
            failurePolicy: before.failurePolicy,
            updatedAt,
          },
    );
    const history = DspyPromotionHistoryEntrySchema.parse({
      schemaVersion: SchemaVersion,
      historyEntryId: `dspy-history-${createDeterministicHash({
        event: "rollback",
        before,
        after,
      }).slice(0, 16)}`,
      eventType: "rollback",
      pointerBefore: before,
      pointerAfter: after,
      decisionId: currentDecision.decisionId,
      actor: this.actor,
      createdAt: after.updatedAt,
    });
    this.writeHistory(history);
    writeYamlFile(this.pointerPath(), after);
    return after;
  }

  loadRuntimePolicy(
    currentFingerprints?: DspyFingerprintSet,
  ): DspyExpansionPolicy | null {
    const pointer = this.loadPointer();
    if (!pointer?.active || pointer.provider !== "dspy") return null;
    if (!pointer.currentDecisionPath) return null;
    let decision: DspyPromotionDecision;
    try {
      decision = this.loadDecision(pointer.currentDecisionPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new DspyPolicyFailure("decision_missing", "DSPy decision file is missing");
      }
      throw error;
    }
    if (
      pointer.currentDecisionId !== decision.decisionId ||
      decision.promotionStatus !== "promoted" ||
      decision.gateVerdict !== "promote"
    ) {
      throw new DspyPolicyFailure(
        "policy_unavailable",
        "DSPy decision is not an active promoted decision",
      );
    }
    let artifact: DspyOptimizationArtifact;
    try {
      artifact = this.loadArtifact(decision.artifactPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new DspyPolicyFailure("artifact_missing", "DSPy artifact file is missing");
      }
      throw error;
    }
    if (
      decision.artifactId !== artifact.artifactId ||
      decision.artifactHash !== artifact.artifactHash ||
      artifact.artifactId !== `dspy-artifact-${artifact.artifactHash.slice(0, 16)}`
    ) {
      throw new DspyPolicyFailure(
        "artifact_invalid",
        "DSPy decision artifact identity is invalid",
      );
    }
    this.validateArtifactFiles(artifact);

    if (isStale(currentFingerprints, artifact.fingerprints)) {
      throw new DspyPolicyFailure("artifact_stale", "DSPy policy is stale");
    }

    return DspyExpansionPolicySchema.parse({
      schemaVersion: SchemaVersion,
      policyId: pointer.pointerId,
      provider: "dspy",
      decisionId: decision.decisionId,
      artifactId: artifact.artifactId,
      artifactHash: artifact.artifactHash,
      runtimeProjection: artifact.runtimeProjection,
      promptArtifactPath: artifact.promptArtifactPath,
      generatedExpansionPath: artifact.generatedExpansionPath,
      fingerprints: artifact.fingerprints,
      failurePolicy: pointer.failurePolicy,
      maxExpansionItems: artifact.maxExpansionItems,
    });
  }

  expandQuery(
    query: string,
    intent?: string,
    currentFingerprints?: DspyFingerprintSet,
  ): DspyExpansionResult {
    let pointer: DspyPolicyPointer | null = null;
    try {
      pointer = this.loadPointer();
      if (!pointer) {
        return this.failure(
          this.fallbackFailurePolicy ?? DspyPolicyStore.defaultFailurePolicy(),
          "pointer_missing",
        );
      }
      if (!pointer.active || pointer.provider !== "dspy") {
        return this.failure(
          pointer.failurePolicy ??
            this.fallbackFailurePolicy ??
            DspyPolicyStore.defaultFailurePolicy(),
          "policy_unavailable",
        );
      }

      const policy = this.loadRuntimePolicy(currentFingerprints);
      if (!policy) {
        return this.failure(pointer.failurePolicy, "policy_unavailable");
      }
      DspyQueryExpansionProgramInputSchema.parse({
        schemaVersion: SchemaVersion,
        query,
        intent,
        policyId: policy.policyId,
        fingerprints: currentFingerprints ?? policy.fingerprints,
      });
      if (!policy.generatedExpansionPath) {
        return this.failure(policy.failurePolicy, "generated_expansion_missing");
      }

      let records: DspyGeneratedExpansionRecord[];
      try {
        records = parseGeneratedExpansionRecords(
          this.resolvePath(policy.generatedExpansionPath),
        );
      } catch (error) {
        if (isMissingFileError(error)) {
          return this.failure(policy.failurePolicy, "generated_expansion_missing", error);
        }
        if (error instanceof SyntaxError) {
          return this.failure(policy.failurePolicy, "runtime_error", error);
        }
        return this.failure(policy.failurePolicy, "runtime_output_schema_invalid", error);
      }
      const normalizedQuery = normalizeQuery(query);
      const normalizedIntent = intent == null ? null : normalizeQuery(intent);
      const match =
        records.find((record) => normalizeQuery(record.query) === normalizedQuery) ??
        (normalizedIntent
          ? records.find((record) => normalizeQuery(record.query) === normalizedIntent)
          : undefined);

      if (!match) return this.failure(policy.failurePolicy, "policy_unavailable");
      const expansions = validateOutputItems(match.output, policy.maxExpansionItems);
      if (expansions.length === 0) {
        return this.failure(policy.failurePolicy, "runtime_output_schema_invalid");
      }
      DspyQueryExpansionProgramOutputSchema.parse({
        schemaVersion: SchemaVersion,
        output: expansions,
      });
      return { status: "expanded", expansions, policy };
    } catch (error) {
      const reason = error instanceof DspyPolicyFailure
        ? error.reason
        : isMissingFileError(error)
          ? missingVaultPath(error instanceof Error ? error.message : "")
          : "artifact_invalid";
      const failurePolicy =
        pointer?.failurePolicy ??
        this.fallbackFailurePolicy ??
        DspyPolicyStore.defaultFailurePolicy();
      return this.failure(failurePolicy, reason, error);
    }
  }

  private failure(
    policy: QueryExpansionFailurePolicy,
    reason: DspyExpansionFailureReason,
    error?: unknown,
  ): DspyExpansionResult {
    if (reason === "artifact_invalid") {
      const message = error instanceof Error ? error.message : "DSPy artifact is invalid";
      return { status: "strict_refuse", reason, message };
    }
    const action = policyAction(policy, reason);
    if (action === "strict_refuse") {
      const message = error instanceof Error ? error.message : `DSPy policy failure: ${reason}`;
      return { status: "strict_refuse", reason, message };
    }
    return { status: "fallback", reason };
  }

  private copyExternalArtifact(path: string, artifactId: string, filename: string): string {
    const source = resolve(path);
    if (!existsSync(source)) {
      throw new Error(`DSPy artifact source does not exist: ${path}`);
    }
    const target = normalizeVaultRelative(`dspy/artifact-files/${artifactId}/${filename}`);
    const body = readFileSync(source);
    const targetPath = this.resolvePath(target);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, body);
    return target;
  }

  private validateArtifactFiles(artifact: DspyOptimizationArtifact): void {
    if (artifact.promptArtifactPath && artifact.promptArtifactHash) {
      let actual: string;
      try {
        actual = fileHashOrThrow(this.graphVault, artifact.promptArtifactPath);
      } catch (error) {
        if (isMissingFileError(error)) {
          throw new DspyPolicyFailure("artifact_invalid", "prompt artifact file missing");
        }
        throw error;
      }
      if (actual !== artifact.promptArtifactHash) {
        throw new DspyPolicyFailure("artifact_invalid", "prompt artifact hash mismatch");
      }
    }
    if (artifact.generatedExpansionPath && artifact.generatedExpansionHash) {
      let actual: string;
      try {
        actual = fileHashOrThrow(this.graphVault, artifact.generatedExpansionPath);
      } catch (error) {
        if (isMissingFileError(error)) {
          throw new DspyPolicyFailure(
            "generated_expansion_missing",
            "generated expansion artifact file missing",
          );
        }
        throw error;
      }
      if (actual !== artifact.generatedExpansionHash) {
        throw new DspyPolicyFailure(
          "artifact_invalid",
          "generated expansion artifact hash mismatch",
        );
      }
    }
    if (artifact.compiledProgramPath && artifact.compiledProgramHash) {
      let actual: string;
      try {
        actual = fileHashOrThrow(this.graphVault, artifact.compiledProgramPath);
      } catch (error) {
        if (isMissingFileError(error)) {
          throw new DspyPolicyFailure("artifact_invalid", "compiled program file missing");
        }
        throw error;
      }
      if (actual !== artifact.compiledProgramHash) {
        throw new DspyPolicyFailure("artifact_invalid", "compiled program hash mismatch");
      }
    }
  }

  private writeHistory(entry: DspyPromotionHistoryEntry): void {
    const path = normalizeVaultRelative(`dspy/history/${entry.historyEntryId}.yaml`);
    writeYamlFile(this.resolvePath(path), entry);
  }

  private latestHistoryEntry(
    eventType: DspyPromotionHistoryEntry["eventType"],
  ): DspyPromotionHistoryEntry | null {
    return this.historyEntries()
      .filter((entry) => entry.eventType === eventType)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }

  private restorableDisableHistoryEntry(
    pointer: DspyPolicyPointer | null,
  ): DspyPromotionHistoryEntry | null {
    if (pointer?.provider !== "disabled" || pointer.active) return null;
    return this.historyEntries()
      .filter((entry) =>
        entry.eventType === "disable" &&
        entry.pointerAfter?.updatedAt === pointer.updatedAt &&
        entry.pointerAfter.provider === "disabled" &&
        !entry.pointerAfter.active &&
        entry.pointerBefore?.provider === "dspy" &&
        entry.pointerBefore.active &&
        entry.pointerBefore.currentDecisionPath != null
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }

  private historyEntries(): DspyPromotionHistoryEntry[] {
    const historyDir = this.resolvePath("dspy/history");
    if (!existsSync(historyDir)) return [];
    return readdirSync(historyDir)
      .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
      .map((name) => {
        try {
          return DspyPromotionHistoryEntrySchema.parse(
            loadYamlFile(join(historyDir, name)),
          );
        } catch {
          return null;
        }
      })
      .filter((entry): entry is DspyPromotionHistoryEntry => entry != null);
  }

  writeSyntheticArtifact(input: {
    records: DspyGeneratedExpansionRecord[];
    fingerprints?: RuntimeFingerprintInput;
    providerEnvRefs?: string[];
    reason?: string;
  }): DspyArtifactWriteResult {
    const recordsBody = input.records
      .map((record) => JSON.stringify(DspyGeneratedExpansionRecordSchema.parse(record)))
      .join("\n") + "\n";
    const recordsHash = sha256Text(recordsBody);
    const generatedPath = normalizeVaultRelative(
      `dspy/manual/generated-${recordsHash.slice(0, 16)}.jsonl`,
    );
    const generatedAbsolutePath = this.resolvePath(generatedPath);
    mkdirSync(dirname(generatedAbsolutePath), { recursive: true });
    writeFileSync(generatedAbsolutePath, recordsBody, "utf-8");
    const pseudoRequest = {
      optimizer: "gepa" as const,
      trainsetPath: generatedAbsolutePath,
      model: "manual/dspy-policy",
      emitPath: generatedAbsolutePath,
      provider: {
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrlEnv: "OPENAI_BASE_URL",
        endpoint: "/responses" as const,
        stream: true as const,
        model: "gpt-5.4",
        reasoningEffort: "medium" as const,
        strictStructuredOutput: true as const,
      },
    };
    const pseudoResponse = {
      schemaVersion: SchemaVersion,
      optimizer: "gepa" as const,
      command: ["manual", "dspy-policy"],
      emitPath: generatedAbsolutePath,
      stdoutTail: [input.reason ?? "manual DSPy policy artifact"],
    };
    return this.writeOptimizationArtifact({
      request: pseudoRequest,
      response: pseudoResponse,
      fingerprints: input.fingerprints ?? {},
      providerEnvRefs: input.providerEnvRefs,
    });
  }
}

class DspyPolicyFailure extends Error {
  readonly reason: DspyExpansionFailureReason;

  constructor(reason: DspyExpansionFailureReason, message: string) {
    super(message);
    this.name = "DspyPolicyFailure";
    this.reason = reason;
  }
}
