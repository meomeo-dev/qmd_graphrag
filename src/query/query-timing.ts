import { performance } from "node:perf_hooks";

import { SchemaVersion, type JsonValue } from "../contracts/common.js";
import type {
  GraphRagProviderDetail,
  GraphRagQueryRuntimeMetrics,
} from "../contracts/graphrag.js";

export type QueryTimingStageStatus = "succeeded" | "failed";

export type QueryTimingStage = {
  name: string;
  startedOffsetMs: number;
  durationMs: number;
  status: QueryTimingStageStatus;
  metadata?: Record<string, JsonValue>;
};

export type QueryTimingReport = {
  schemaVersion: typeof SchemaVersion;
  kind: "qmd_query_timing";
  totalDurationMs: number;
  stages: QueryTimingStage[];
  metadata?: Record<string, JsonValue>;
};

function roundDurationMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

export class QueryTimingRecorder {
  private readonly startedAt = performance.now();
  private readonly stages: QueryTimingStage[] = [];
  private metadata: Record<string, JsonValue>;

  constructor(metadata: Record<string, JsonValue> = {}) {
    this.metadata = metadata;
  }

  addMetadata(metadata: Record<string, JsonValue>): void {
    this.metadata = {
      ...this.metadata,
      ...metadata,
    };
  }

  measure<T>(
    name: string,
    action: () => T | Promise<T>,
    metadata?: Record<string, JsonValue>,
  ): T | Promise<T> {
    const startedAt = performance.now();
    const record = (status: QueryTimingStageStatus): void => {
      this.stages.push({
        name,
        startedOffsetMs: roundDurationMs(startedAt - this.startedAt),
        durationMs: roundDurationMs(performance.now() - startedAt),
        status,
        ...(metadata == null ? {} : { metadata }),
      });
    };

    try {
      const value = action();
      if (isPromiseLike(value)) {
        return value.then(
          (result) => {
            record("succeeded");
            return result;
          },
          (error: unknown) => {
            record("failed");
            throw error;
          },
        );
      }
      record("succeeded");
      return value;
    } catch (error) {
      record("failed");
      throw error;
    }
  }

  report(metadata: Record<string, JsonValue> = {}): QueryTimingReport {
    const mergedMetadata = {
      ...this.metadata,
      ...metadata,
    };
    return {
      schemaVersion: SchemaVersion,
      kind: "qmd_query_timing",
      totalDurationMs: roundDurationMs(performance.now() - this.startedAt),
      stages: [...this.stages],
      ...(Object.keys(mergedMetadata).length === 0
        ? {}
        : { metadata: mergedMetadata }),
    };
  }
}

export function formatQueryTimingReport(report: QueryTimingReport): string {
  const lines = [
    `Query timing: total=${report.totalDurationMs.toFixed(2)}ms`,
  ];
  for (const stage of [...report.stages].sort(
    (left, right) => left.startedOffsetMs - right.startedOffsetMs,
  )) {
    const status = stage.status === "succeeded" ? "ok" : "failed";
    lines.push(
      `  - ${stage.name}: ${stage.durationMs.toFixed(2)}ms ` +
        `@+${stage.startedOffsetMs.toFixed(2)}ms (${status})`,
    );
  }
  return lines.join("\n");
}

export function formatGraphRagRuntimeMetrics(
  detail: GraphRagProviderDetail | undefined,
): string | null {
  const metrics = detail?.runtimeMetrics;
  if (metrics == null) return null;

  const lines = [
    "GraphRAG runtime metrics:",
    `  - total: ${metrics.totalDurationMs.toFixed(2)}ms`,
  ];
  if (metrics.stages.length > 0) {
    lines.push("  - provider stages:");
    for (const stage of metrics.stages) {
      const status = stage.status === "succeeded" ? "ok" : "failed";
      lines.push(
        `    - ${stage.name}: ${stage.durationMs.toFixed(2)}ms (${status})`,
      );
    }
  }
  lines.push(...formatRuntimeAggregate(metrics));
  if (metrics.modelMetrics.length > 0) {
    lines.push("  - model calls:");
    for (const model of metrics.modelMetrics) {
      lines.push(
        `    - ${model.model}: requests=${model.attemptedRequestCount}, ` +
          `compute=${model.loggedComputeDurationMs.toFixed(2)}ms, ` +
          `tokens=${model.totalTokens}, retries=${model.retryCount}`,
      );
    }
  }
  return lines.join("\n");
}

function formatRuntimeAggregate(metrics: GraphRagQueryRuntimeMetrics): string[] {
  const aggregate = metrics.aggregate;
  return [
    "  - aggregate:",
    `    - requests: attempted=${aggregate.attemptedRequestCount}, ` +
      `succeeded=${aggregate.successfulResponseCount}, ` +
      `failed=${aggregate.failedResponseCount}`,
    `    - retries: requestsWithRetries=${aggregate.requestsWithRetries}, ` +
      `retryCount=${aggregate.retryCount}`,
    `    - logged LLM/embedding compute: ` +
      `${aggregate.loggedComputeDurationMs.toFixed(2)}ms`,
    `    - unattributed wall time: ` +
      `${aggregate.unattributedWallDurationMs.toFixed(2)}ms`,
    `    - tokens: prompt=${aggregate.promptTokens}, ` +
      `completion=${aggregate.completionTokens}, total=${aggregate.totalTokens}`,
  ];
}
