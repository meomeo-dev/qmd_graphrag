import { basename, dirname, join, relative, sep } from "node:path";

export const GRAPH_OUTPUT_STATS_OBSERVABILITY_REFRESH_DECISION =
  "graph_output_stats_observability_refreshed";

const GraphRagStatsWorkflowNames = new Set([
  "load_input_documents",
  "create_base_text_units",
  "create_final_documents",
  "extract_graph",
  "extract_graph_nlp",
  "finalize_graph",
  "extract_covariates",
  "prune_graph",
  "create_communities",
  "create_final_text_units",
  "create_community_reports",
  "create_community_reports_text",
  "generate_text_embeddings",
]);

const GraphRagStatsNumericFields = [
  "total_runtime",
  "num_documents",
  "update_documents",
  "input_load_time",
];

export function graphOutputStatsRepairDecision(input) {
  const target = graphOutputStatsTarget(input?.path, input?.stateRoot);
  if (target == null) return null;
  if (input?.repairBoundary !== "migrate_only") return null;
  const artifact = input.artifact;
  if (!artifactMatchesStatsTarget(artifact, target)) return null;
  if (!statsArtifactEvidenceMatches(input, artifact)) return null;
  if (!isGraphRagStatsObject(input.parsed)) return null;
  return {
    checksumRecoveryDecision:
      GRAPH_OUTPUT_STATS_OBSERVABILITY_REFRESH_DECISION,
    reason: "mutable_graphrag_stats_observability_rewrite",
    bookId: target.bookId,
    stateRelativeLocator: target.stateRelativeLocator,
    artifactId: artifact.artifactId,
    artifactKind: artifact.kind,
    producerRunId: artifact.producerRunId,
    artifactStage: artifact.stage,
  };
}

export function graphOutputStatsCorruptPrimaryPath(corruptPath, stateRoot) {
  if (!/^stats\.json\.corrupt-\d+$/u.test(basename(String(corruptPath)))) {
    return null;
  }
  const primaryPath = join(dirname(corruptPath), "stats.json");
  return graphOutputStatsTarget(primaryPath, stateRoot) == null
    ? null
    : primaryPath;
}

export function graphOutputStatsCorruptSortKey(corruptPath) {
  const match = /\.corrupt-(\d+)$/u.exec(basename(String(corruptPath)));
  return match == null ? 0 : Number.parseInt(match[1], 10) || 0;
}

function graphOutputStatsTarget(path, stateRoot) {
  if (typeof path !== "string" || typeof stateRoot !== "string") return null;
  const stateRelativeLocator = relative(stateRoot, path).split(sep).join("/");
  const match = /^books\/([^/]+)\/output\/stats\.json$/u
    .exec(stateRelativeLocator);
  if (match == null) return null;
  return {
    bookId: match[1],
    stateRelativeLocator,
  };
}

function artifactMatchesStatsTarget(artifact, target) {
  return artifact != null &&
    artifact.bookId === target.bookId &&
    artifact.stage === "graph_extract" &&
    artifact.kind === "graphrag_stats_json" &&
    artifact.path === target.stateRelativeLocator;
}

function statsArtifactEvidenceMatches(input, artifact) {
  const expected = input?.expectedChecksum;
  if (typeof expected === "string" && expected.length > 0) {
    return expected === artifact.contentHash;
  }
  const meta = input?.checksumMeta;
  if (meta == null || typeof meta !== "object") return true;
  if (meta.targetMappingOwner != null &&
    meta.targetMappingOwner !== "graphOutputProducer") {
    return false;
  }
  return meta.checksum == null || meta.checksum === artifact.contentHash;
}

function isGraphRagStatsObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const workflows = value.workflows;
  if (workflows == null || typeof workflows !== "object" || Array.isArray(workflows)) {
    return false;
  }
  const workflowEntries = Object.entries(workflows);
  const hasKnownWorkflow = workflowEntries
    .some(([name]) => GraphRagStatsWorkflowNames.has(name));
  const workflowsHaveMetricShape = workflowEntries.every(([, metrics]) =>
    metrics != null &&
    typeof metrics === "object" &&
    !Array.isArray(metrics) &&
    Object.values(metrics).some((metric) => typeof metric === "number")
  );
  const hasTopLevelStats = GraphRagStatsNumericFields
    .some((field) => typeof value[field] === "number");
  if (workflowEntries.length === 0) return hasTopLevelStats;
  return workflowsHaveMetricShape && (hasKnownWorkflow || hasTopLevelStats);
}
