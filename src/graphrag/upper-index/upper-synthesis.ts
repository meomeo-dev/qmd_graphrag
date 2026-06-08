import {
  GraphRagQueryResponseSchema,
  type GraphRagEvidence,
  type GraphRagQueryResponse,
  type GraphRagQueryRuntimeAggregate,
  type GraphRagQueryRuntimeMetrics,
  type GraphRagSearchMethod,
} from "../../contracts/graphrag.js";
import { sanitizeVaultMetadata, sanitizeVaultText } from "../../vault/metadata.js";

export type UpperSynthesisErrorCode =
  | "budget_exceeded_narrow_scope_required"
  | "upper_index_runtime_error";

export class UpperSynthesisError extends Error {
  readonly code: UpperSynthesisErrorCode;
  readonly diagnostics: string[];

  constructor(
    code: UpperSynthesisErrorCode,
    message: string,
    diagnostics: string[] = [],
  ) {
    super(message);
    this.name = "UpperSynthesisError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export type UpperSynthesisScopeKind = "bookshelf" | "library";

export const UpperSynthesisDefaultMaxOutputTokens = 512;

export type UpperSynthesisRunnerInput = {
  scopeKind: UpperSynthesisScopeKind;
  scopeId: string;
  generation: string;
  query: string;
  method: GraphRagSearchMethod;
  prompt: string;
  evidence: readonly GraphRagEvidence[];
  estimatedInputTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
};

export type UpperSynthesisRunnerOutput = {
  text: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
};

export type UpperSynthesisRunner = (
  input: UpperSynthesisRunnerInput,
) => Promise<UpperSynthesisRunnerOutput>;

export type ApplyUpperSynthesisInput = {
  enabled?: boolean;
  scopeKind: UpperSynthesisScopeKind;
  scopeId: string;
  generation: string;
  query: string;
  method: GraphRagSearchMethod;
  upperResponse: GraphRagQueryResponse;
  maxInputTokens: number;
  requestedMaxInputTokens?: number;
  maxOutputTokens: number;
  requestedMaxOutputTokens?: number;
  runner?: UpperSynthesisRunner;
};

type PromptBuildResult = {
  prompt: string;
  evidence: GraphRagEvidence[];
  estimatedInputTokens: number;
  truncatedEvidenceCount: number;
};

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function evidenceTitle(evidence: GraphRagEvidence): string | null {
  const metadata = evidence.metadata ?? {};
  const title =
    metadata.upperCommunityReportTitle ??
    metadata.title ??
    metadata.name ??
    null;
  return typeof title === "string" && title.trim().length > 0
    ? title.trim()
    : null;
}

function evidenceSnippet(evidence: GraphRagEvidence): string {
  const quote = sanitizeVaultText(evidence.quote ?? "") ?? "";
  const title = evidenceTitle(evidence);
  const parts = [
    `EvidenceId: ${evidence.evidenceId}`,
    `BookId: ${evidence.bookId}`,
    `DocumentId: ${evidence.documentId}`,
    `ContentHash: ${evidence.contentHash}`,
    title == null ? null : `Title: ${title}`,
    `Quote: ${quote.slice(0, 1200)}`,
  ].filter((item): item is string => item != null);
  return parts.join("\n");
}

function buildPrompt(input: {
  scopeKind: UpperSynthesisScopeKind;
  scopeId: string;
  generation: string;
  query: string;
  evidence: readonly GraphRagEvidence[];
  maxInputTokens: number;
  maxOutputTokens: number;
}): PromptBuildResult {
  const header = [
    "Answer the user query using only the selected upper GraphRAG evidence.",
    "Do not claim exhaustive library coverage.",
    "Cite evidence ids inline when making claims.",
    `Keep the answer within ${input.maxOutputTokens} output tokens.`,
    "Prefer 3 concise bullets when the query does not require more detail.",
    `ScopeKind: ${input.scopeKind}`,
    `ScopeId: ${input.scopeId}`,
    `Generation: ${input.generation}`,
    `Query: ${sanitizeVaultText(input.query) ?? "[redacted]"}`,
    "",
    "Selected evidence:",
  ].join("\n");
  let prompt = `${header}\n`;
  let estimatedInputTokens = estimateTokens(prompt);
  const selected: GraphRagEvidence[] = [];
  for (const evidence of input.evidence) {
    const next = `\n---\n${evidenceSnippet(evidence)}\n`;
    const nextTokens = estimateTokens(next);
    if (
      selected.length > 0 &&
      estimatedInputTokens + nextTokens > input.maxInputTokens
    ) {
      break;
    }
    if (
      selected.length === 0 &&
      estimatedInputTokens + nextTokens > input.maxInputTokens
    ) {
      throw new UpperSynthesisError(
        "budget_exceeded_narrow_scope_required",
        "Upper synthesis cannot fit the first selected evidence item.",
        [
          `estimated_input_tokens:${estimatedInputTokens + nextTokens}`,
          `max_input_tokens:${input.maxInputTokens}`,
        ],
      );
    }
    prompt += next;
    estimatedInputTokens += nextTokens;
    selected.push(evidence);
  }
  return {
    prompt,
    evidence: selected,
    estimatedInputTokens,
    truncatedEvidenceCount: Math.max(0, input.evidence.length - selected.length),
  };
}

function emptyAggregate(): GraphRagQueryRuntimeAggregate {
  return {
    modelCount: 0,
    attemptedRequestCount: 0,
    successfulResponseCount: 0,
    failedResponseCount: 0,
    requestsWithRetries: 0,
    retryCount: 0,
    streamingResponseCount: 0,
    loggedComputeDurationMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    unattributedWallDurationMs: 0,
  };
}

function addAggregate(
  left: GraphRagQueryRuntimeAggregate,
  right: GraphRagQueryRuntimeAggregate,
): GraphRagQueryRuntimeAggregate {
  return {
    modelCount: left.modelCount + right.modelCount,
    attemptedRequestCount:
      left.attemptedRequestCount + right.attemptedRequestCount,
    successfulResponseCount:
      left.successfulResponseCount + right.successfulResponseCount,
    failedResponseCount: left.failedResponseCount + right.failedResponseCount,
    requestsWithRetries: left.requestsWithRetries + right.requestsWithRetries,
    retryCount: left.retryCount + right.retryCount,
    streamingResponseCount:
      left.streamingResponseCount + right.streamingResponseCount,
    loggedComputeDurationMs:
      left.loggedComputeDurationMs + right.loggedComputeDurationMs,
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    unattributedWallDurationMs:
      left.unattributedWallDurationMs + right.unattributedWallDurationMs,
  };
}

function mergeRuntimeMetrics(input: {
  base?: GraphRagQueryRuntimeMetrics;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}): GraphRagQueryRuntimeMetrics {
  const synthesisAggregate: GraphRagQueryRuntimeAggregate = {
    ...emptyAggregate(),
    modelCount: 1,
    attemptedRequestCount: 1,
    successfulResponseCount: 1,
    loggedComputeDurationMs: input.durationMs,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens: input.promptTokens + input.completionTokens,
  };
  const aggregate = addAggregate(
    input.base?.aggregate ?? emptyAggregate(),
    synthesisAggregate,
  );
  const stages = [
    ...(input.base?.stages ?? []),
    {
      name: "upper.llm_synthesis",
      durationMs: input.durationMs,
      status: "succeeded" as const,
    },
  ].slice(0, 16);
  const modelMetrics = [
    ...(input.base?.modelMetrics ?? []),
    {
      model: input.model,
      attemptedRequestCount: 1,
      successfulResponseCount: 1,
      failedResponseCount: 0,
      requestsWithRetries: 0,
      retryCount: 0,
      streamingResponseCount: 0,
      loggedComputeDurationMs: input.durationMs,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.promptTokens + input.completionTokens,
      cacheHitRate: 0,
    },
  ].slice(0, 32);
  return {
    kind: "graphrag_query_runtime_metrics",
    scope: "current_invocation",
    totalDurationMs: (input.base?.totalDurationMs ?? 0) + input.durationMs,
    stages,
    modelMetrics,
    aggregate,
  };
}

function synthesisEvidence(input: {
  scopeKind: UpperSynthesisScopeKind;
  scopeId: string;
  generation: string;
  evidence: GraphRagEvidence;
  truncatedEvidenceCount: number;
}): GraphRagEvidence {
  return {
    ...input.evidence,
    metadata: sanitizeVaultMetadata({
      ...(input.evidence.metadata ?? {}),
      upperSynthesis: true,
      upperScopeKind: input.scopeKind,
      upperScopeId: input.scopeId,
      upperGeneration: input.generation,
      synthesisInputEvidence: true,
      truncatedSynthesisEvidenceCount: input.truncatedEvidenceCount,
    }),
  };
}

function resolveRequestedBudget(input: {
  packageMaxInputTokens: number;
  packageMaxOutputTokens: number;
  requestedMaxInputTokens?: number;
  requestedMaxOutputTokens?: number;
}): { maxInputTokens: number; maxOutputTokens: number } {
  const diagnostics: string[] = [];
  if (
    !Number.isInteger(input.packageMaxInputTokens) ||
    input.packageMaxInputTokens <= 0
  ) {
    diagnostics.push(`invalid_package_synthesis_input_budget:${
      input.packageMaxInputTokens
    }`);
  }
  if (
    !Number.isInteger(input.packageMaxOutputTokens) ||
    input.packageMaxOutputTokens <= 0
  ) {
    diagnostics.push(`invalid_package_synthesis_output_budget:${
      input.packageMaxOutputTokens
    }`);
  }
  if (input.requestedMaxInputTokens != null) {
    if (
      !Number.isInteger(input.requestedMaxInputTokens) ||
      input.requestedMaxInputTokens <= 0
    ) {
      diagnostics.push(
        `invalid_requested_synthesis_input_tokens:${
          input.requestedMaxInputTokens
        }`,
      );
    } else if (input.requestedMaxInputTokens > input.packageMaxInputTokens) {
      diagnostics.push(
        `requested_synthesis_input_tokens_exceeds_package_budget:` +
          `${input.requestedMaxInputTokens}:max:${input.packageMaxInputTokens}`,
      );
    }
  }
  if (input.requestedMaxOutputTokens != null) {
    if (
      !Number.isInteger(input.requestedMaxOutputTokens) ||
      input.requestedMaxOutputTokens <= 0
    ) {
      diagnostics.push(
        `invalid_requested_synthesis_output_tokens:${
          input.requestedMaxOutputTokens
        }`,
      );
    } else if (input.requestedMaxOutputTokens > input.packageMaxOutputTokens) {
      diagnostics.push(
        `requested_synthesis_output_tokens_exceeds_package_budget:` +
          `${input.requestedMaxOutputTokens}:max:${input.packageMaxOutputTokens}`,
      );
    }
  }
  if (diagnostics.length > 0) {
    throw new UpperSynthesisError(
      "budget_exceeded_narrow_scope_required",
      "Upper synthesis budget cannot exceed the package-local fixed budget.",
      diagnostics,
    );
  }
  return {
    maxInputTokens:
      input.requestedMaxInputTokens ?? input.packageMaxInputTokens,
    maxOutputTokens:
      input.requestedMaxOutputTokens ?? input.packageMaxOutputTokens,
  };
}

export async function applyUpperSynthesis(
  input: ApplyUpperSynthesisInput,
): Promise<GraphRagQueryResponse> {
  if (input.enabled !== true) return input.upperResponse;
  if (input.runner == null) {
    throw new UpperSynthesisError(
      "upper_index_runtime_error",
      "Upper synthesis requested but no LLM synthesis runner is configured.",
      ["upper_synthesis_runner_missing"],
    );
  }
  const budget = resolveRequestedBudget({
    packageMaxInputTokens: input.maxInputTokens,
    packageMaxOutputTokens: input.maxOutputTokens,
    requestedMaxInputTokens: input.requestedMaxInputTokens,
    requestedMaxOutputTokens: input.requestedMaxOutputTokens,
  });
  const prompt = buildPrompt({
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    generation: input.generation,
    query: input.query,
    evidence: input.upperResponse.evidence,
    maxInputTokens: budget.maxInputTokens,
    maxOutputTokens: budget.maxOutputTokens,
  });
  const startedAt = Date.now();
  let output: UpperSynthesisRunnerOutput;
  try {
    output = await input.runner({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      generation: input.generation,
      query: input.query,
      method: input.method,
      prompt: prompt.prompt,
      evidence: prompt.evidence,
      estimatedInputTokens: prompt.estimatedInputTokens,
      maxInputTokens: budget.maxInputTokens,
      maxOutputTokens: budget.maxOutputTokens,
    });
  } catch (error) {
    const diagnostic = error instanceof Error ? error.name : typeof error;
    throw new UpperSynthesisError(
      "upper_index_runtime_error",
      "Upper synthesis failed while invoking the configured LLM runner.",
      [`upper_synthesis_runner_failed:${diagnostic}`],
    );
  }
  const durationMs = output.durationMs ?? Math.max(0, Date.now() - startedAt);
  const answerText = sanitizeVaultText(output.text) ?? "";
  if (answerText.trim().length === 0) {
    throw new UpperSynthesisError(
      "upper_index_runtime_error",
      "Upper synthesis returned an empty answer.",
      ["upper_synthesis_empty_response"],
    );
  }
  const promptTokens = output.promptTokens ?? prompt.estimatedInputTokens;
  const completionTokens = output.completionTokens ?? estimateTokens(answerText);
  if (promptTokens > budget.maxInputTokens) {
    throw new UpperSynthesisError(
      "budget_exceeded_narrow_scope_required",
      "Upper synthesis prompt tokens exceeded the active fixed budget.",
      [
        `upper_synthesis_prompt_tokens:${promptTokens}`,
        `max_synthesis_input_tokens:${budget.maxInputTokens}`,
      ],
    );
  }
  if (completionTokens > budget.maxOutputTokens) {
    throw new UpperSynthesisError(
      "budget_exceeded_narrow_scope_required",
      "Upper synthesis completion tokens exceeded the active fixed budget.",
      [
        `upper_synthesis_completion_tokens:${completionTokens}`,
        `max_synthesis_output_tokens:${budget.maxOutputTokens}`,
      ],
    );
  }
  return GraphRagQueryResponseSchema.parse({
    ...input.upperResponse,
    responseText: answerText,
    evidence: prompt.evidence.map((evidence) =>
      synthesisEvidence({
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        generation: input.generation,
        evidence,
        truncatedEvidenceCount: prompt.truncatedEvidenceCount,
      })
    ),
    providerDetail: {
      provider: "graphrag",
      method: input.method,
      runtimeMetrics: mergeRuntimeMetrics({
        base: input.upperResponse.providerDetail?.runtimeMetrics,
        model: output.model ?? "upper-synthesis-runner",
        promptTokens,
        completionTokens,
        durationMs,
      }),
    },
  });
}
