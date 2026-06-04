import { existsSync } from "node:fs";
import { join } from "node:path";

const ConvergeableStages = new Set(["community_report"]);

function stageOutputExists(outputDir, stage) {
  if (stage === "community_report") {
    return existsSync(join(outputDir, "community_reports.parquet"));
  }
  return false;
}

function runningCheckpointForStage(resumePlan, stage) {
  return (resumePlan?.stageStates ?? []).find((item) =>
    item.stage === stage &&
    item.checkpointStatus === "running" &&
    typeof item.runId === "string" &&
    item.runId.length > 0
  ) ?? null;
}

export async function convergeHotplugOrphanRunningStages({
  runtimeApi,
  repo,
  sync,
  scopedOutputDir,
  resync,
}) {
  let current = sync;
  const converged = [];
  for (const stage of ConvergeableStages) {
    const checkpoint = runningCheckpointForStage(current.resumePlan, stage);
    if (checkpoint == null || !stageOutputExists(scopedOutputDir, stage)) {
      continue;
    }

    await runtimeApi.writeGraphRagOutputProducerManifest({
      outputDir: scopedOutputDir,
      repo,
      bookId: current.job.bookId,
      sourceHash: current.job.sourceHash,
      documentId: current.job.documentId,
      contentHash: current.job.normalizedContentHash ?? current.job.sourceHash,
      stageFingerprints: current.stageFingerprints,
      providerFingerprint: current.job.providerFingerprint,
      producerRunId: checkpoint.runId,
      stage,
    });
    await runtimeApi.refreshGraphRagStageOutputDurableSidecars({
      outputDir: scopedOutputDir,
      repo,
      bookId: current.job.bookId,
      stage,
      producerRunId: checkpoint.runId,
    });

    const refreshed = await resync();
    current = refreshed.sync;
    const artifactIds = await runtimeApi.assertGraphRagStageArtifactsReady({
      stateRootDir: repo.rootDir,
      bookId: current.job.bookId,
      stage,
      producerRunId: checkpoint.runId,
      artifacts: current.artifacts,
      expectedStageFingerprints: current.job.stageFingerprints,
      expectedProviderFingerprint: current.job.providerFingerprint,
      expectedCorpusContentHash:
        current.job.normalizedContentHash ?? current.job.sourceHash,
    });
    await repo.completeStage({
      bookId: current.job.bookId,
      stage,
      runId: checkpoint.runId,
      inputFingerprint: current.stageFingerprints[stage],
      contentHash: current.job.normalizedContentHash ?? current.job.sourceHash,
      stageFingerprint: current.stageFingerprints[stage],
      providerFingerprint: current.job.providerFingerprint,
      artifactIds,
      metadata: {
        recoveredFromOrphanRunningStage: true,
        graphWorkspace: "book_scoped",
        repairMode: "hotplug_orphan_running_stage_convergence",
      },
    });
    const completed = await resync();
    current = completed.sync;
    converged.push({ stage, runId: checkpoint.runId, artifactIds });
  }
  return {
    sync: current,
    converged,
  };
}
