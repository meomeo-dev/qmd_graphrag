import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export const GRAPH_EXTRACT_HOTPLUG_OUTPUT_FILES = [
  "documents.parquet",
  "text_units.parquet",
  "entities.parquet",
  "relationships.parquet",
  "communities.parquet",
  "context.json",
  "stats.json",
];

export const COMMUNITY_REPORT_HOTPLUG_OUTPUT_FILES = [
  "community_reports.parquet",
];

export function missingHotplugStageOutputFiles(outputDir, stage) {
  const requiredFiles = stage === "graph_extract"
    ? GRAPH_EXTRACT_HOTPLUG_OUTPUT_FILES
    : stage === "community_report"
      ? COMMUNITY_REPORT_HOTPLUG_OUTPUT_FILES
      : [];
  return requiredFiles.filter((file) => !existsSync(join(outputDir, file)));
}

export function hotplugStageClosureRebuildStage(outputDir, resumePlan) {
  const completedStages = new Set(resumePlan?.completedStages ?? []);
  if (
    completedStages.has("graph_extract") &&
    missingHotplugStageOutputFiles(outputDir, "graph_extract").length > 0
  ) {
    return "graph_extract";
  }
  if (
    completedStages.has("community_report") &&
    missingHotplugStageOutputFiles(outputDir, "community_report").length > 0
  ) {
    return "community_report";
  }
  return null;
}

export async function cleanHotplugStageOutputFiles(outputDir, stage) {
  const files = stage === "graph_extract"
    ? [
        ...GRAPH_EXTRACT_HOTPLUG_OUTPUT_FILES,
        "qmd_graph_text_unit_identity.json",
        "qmd_output_manifest.json",
      ]
    : stage === "community_report"
      ? COMMUNITY_REPORT_HOTPLUG_OUTPUT_FILES
      : [];
  const deletedLocators = [];
  for (const file of files) {
    const path = join(outputDir, file);
    if (!existsSync(path)) continue;
    await rm(path, { force: true, recursive: true });
    deletedLocators.push(file);
  }
  return {
    cleaned: deletedLocators.length > 0,
    deletedLocators,
    reason: deletedLocators.length > 0
      ? "hotplug stage output closure was incomplete"
      : undefined,
  };
}
