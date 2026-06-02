import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import YAML from "yaml";

import type { BookArtifactKind, BookStage } from "../contracts/book-job.js";
import { BookArtifactManifestListSchema } from "../contracts/book-job.js";
import { resolveVaultRelativePath } from "../vault/path.js";
import { hashFile } from "./fingerprint.js";
import { refreshDurableTextFileChecksum } from "./durable-state-store.js";
import type { FileBookJobStateRepository } from "./repository.js";

export type GraphRagOutputDurableRefreshResult = {
  targetPath: string;
  artifactKind: BookArtifactKind;
  stage: BookStage;
  refreshStage: BookStage;
  checksum: string;
  previousChecksum: string | null;
  checksumRecoveryDecision: string;
  mutated: boolean;
};

type DurableGraphOutputJsonTarget = {
  name: string;
  kind: BookArtifactKind;
  artifactStage: BookStage;
  refreshStages: readonly BookStage[];
};

const DurableGraphOutputJsonTargets: readonly DurableGraphOutputJsonTarget[] = [
  {
    name: "context.json",
    kind: "graphrag_context_json",
    artifactStage: "graph_extract",
    refreshStages: ["graph_extract"],
  },
  {
    name: "stats.json",
    kind: "graphrag_stats_json",
    artifactStage: "graph_extract",
    refreshStages: ["graph_extract", "community_report", "embed"],
  },
];

export async function refreshGraphRagOutputJsonSidecars(input: {
  outputDir: string;
  repo?: FileBookJobStateRepository;
  bookId: string;
  stage: BookStage;
  producerRunId: string;
  reason: "stage_success" | "explicit_repair";
}): Promise<GraphRagOutputDurableRefreshResult[]> {
  input.repo?.assertCurrentBatchBookLease(input.bookId);
  const refreshed: GraphRagOutputDurableRefreshResult[] = [];
  for (const target of DurableGraphOutputJsonTargets) {
    if (!target.refreshStages.includes(input.stage)) continue;
    const targetPath = join(input.outputDir, target.name);
    if (!existsSync(targetPath)) continue;
    const result = await refreshDurableTextFileChecksum(targetPath, "json", {
      checksumRecoveryDecision: `graph_output_${input.reason}`,
      evidence: {
        bookId: input.bookId,
        stage: input.stage,
        refreshStage: input.stage,
        artifactStage: target.artifactStage,
        producerRunId: input.producerRunId,
        durableRefreshBoundary: input.reason,
        artifactKind: target.kind,
        targetMappingOwner: "graphOutputProducer",
      },
    });
    refreshed.push({
      targetPath,
      artifactKind: target.kind,
      stage: target.artifactStage,
      refreshStage: input.stage,
      checksum: result.checksum,
      previousChecksum: result.previousChecksum,
      checksumRecoveryDecision: result.checksumRecoveryDecision,
      mutated: result.mutated,
    });
  }
  input.repo?.assertCurrentBatchBookLease(input.bookId);
  return refreshed;
}

export async function repairGraphRagOutputJsonSidecarsFromArtifacts(input: {
  stateRootDir: string;
  bookId: string;
}): Promise<GraphRagOutputDurableRefreshResult[]> {
  const artifactManifestPath = join(
    input.stateRootDir,
    "books",
    input.bookId,
    "artifacts.yaml",
  );
  if (!existsSync(artifactManifestPath)) return [];
  const parsed = BookArtifactManifestListSchema.parse(
    YAML.parse(await readFile(artifactManifestPath, "utf8")),
  );
  const refreshed: GraphRagOutputDurableRefreshResult[] = [];
  for (const target of DurableGraphOutputJsonTargets) {
    const artifact = [...parsed.items]
      .reverse()
      .find((item) =>
        item.bookId === input.bookId &&
        item.kind === target.kind &&
        item.stage === target.artifactStage
      );
    if (artifact == null) continue;
    const targetPath = resolveVaultRelativePath(input.stateRootDir, artifact.path);
    if (targetPath == null || !existsSync(targetPath)) continue;
    const actual = await hashFile(targetPath);
    if (actual !== artifact.contentHash) continue;
    JSON.parse(await readFile(targetPath, "utf8"));
    const result = await refreshDurableTextFileChecksum(targetPath, "json", {
      expectedChecksum: artifact.contentHash,
      checksumRecoveryDecision: "artifact_evidence_checksum_refreshed",
      evidence: {
        bookId: input.bookId,
        stage: artifact.stage,
        refreshStage: artifact.stage,
        artifactStage: target.artifactStage,
        producerRunId: artifact.producerRunId,
        durableRefreshBoundary: "explicit_repair",
        artifactKind: artifact.kind,
        artifactId: artifact.artifactId,
        targetMappingOwner: "graphOutputProducer",
      },
    });
    refreshed.push({
      targetPath,
      artifactKind: target.kind,
      stage: target.artifactStage,
      refreshStage: artifact.stage,
      checksum: result.checksum,
      previousChecksum: result.previousChecksum,
      checksumRecoveryDecision: result.checksumRecoveryDecision,
      mutated: result.mutated,
    });
  }
  return refreshed;
}
