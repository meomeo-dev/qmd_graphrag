import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import YAML from "yaml";

import type {
  BookArtifactKind,
  BookArtifactManifest,
  BookJob,
  BookResumePlan,
  BookStage,
} from "../contracts/book-job.js";
import type { JsonValue } from "../contracts/common.js";
import {
  buildBookIdFromSourceHash,
  createDeterministicHash,
  createRunId,
  hashFile,
  hashText,
} from "./fingerprint.js";
import {
  FileBookJobStateRepository,
  type StageArtifactRequirementMap,
  type StageFingerprintMap,
} from "./repository.js";

const GRAPH_EXTRACT_KINDS = [
  "graphrag_documents_parquet",
  "graphrag_text_units_parquet",
  "graphrag_entities_parquet",
  "graphrag_relationships_parquet",
  "graphrag_communities_parquet",
  "graphrag_context_json",
  "graphrag_stats_json",
] as const;

const GRAPH_RAG_STAGE_ARTIFACT_REQUIREMENTS: StageArtifactRequirementMap = {
  ingest: ["source_epub"],
  normalize: ["normalized_markdown"],
  graph_extract: GRAPH_EXTRACT_KINDS,
  community_report: ["graphrag_community_reports_parquet"],
  embed: ["lancedb_index"],
  query_ready: ["graphrag_community_reports_parquet", "lancedb_index"],
};

const REQUIRED_LANCEDB_TABLES = [
  "entity_description.lance",
  "community_full_content.lance",
  "text_unit_text.lance",
] as const;

export type GraphRagBookWorkspacePaths = {
  stateRootDir: string;
  sourcePath: string;
  sourceIdentityPath?: string;
  normalizedPath: string;
  settingsPath: string;
  promptsDir: string;
  outputDir: string;
};

export type SyncGraphRagBookWorkspaceInput = GraphRagBookWorkspacePaths & {
  metadata?: Record<string, JsonValue>;
  recordRecoveredStages?: boolean;
};

export type GraphRagBookWorkspaceState = {
  job: BookJob;
  artifacts: BookArtifactManifest[];
  stageFingerprints: Record<BookStage, string>;
  resumePlan: BookResumePlan;
  bootstrapRunId: string;
};

function stripKnownBookExtension(path: string): string {
  return basename(path).replace(/\.(epub|md|markdown|txt)$/iu, "");
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(entryPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function hashDirectoryContents(rootDir: string): Promise<string> {
  const files = await listFilesRecursive(rootDir);
  const payload = await Promise.all(
    files.map(async (path) => {
      return {
        path: path.slice(rootDir.length + 1),
        hash: await hashFile(path),
      };
    }),
  );
  return createDeterministicHash(payload);
}

async function parseSettingsFingerprint(
  settingsPath: string,
): Promise<{
  configFingerprint: string;
  modelFingerprint: string;
  stageConfigFingerprint: Record<BookStage, string>;
}> {
  const raw = await readFile(settingsPath, "utf8");
  const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
  const completionModels = parsed.completion_models;
  const embeddingModels = parsed.embedding_models;
  const vectorStore = parsed.vector_store;

  return {
    configFingerprint: hashText(raw),
    modelFingerprint: createDeterministicHash({
      completion_models: completionModels,
      embedding_models: embeddingModels,
    }),
    stageConfigFingerprint: {
      ingest: createDeterministicHash({
        input: parsed.input,
        input_storage: parsed.input_storage,
      }),
      normalize: createDeterministicHash({
        input: parsed.input,
        input_storage: parsed.input_storage,
      }),
      graph_extract: createDeterministicHash({
        extract_graph: parsed.extract_graph,
        summarize_descriptions: parsed.summarize_descriptions,
        completion_models: completionModels,
      }),
      community_report: createDeterministicHash({
        community_reports: parsed.community_reports,
        completion_models: completionModels,
      }),
      embed: createDeterministicHash({
        embed_text: parsed.embed_text,
        embedding_models: embeddingModels,
        vector_store: vectorStore,
      }),
      query_ready: createDeterministicHash({
        local_search: parsed.local_search,
        global_search: parsed.global_search,
        drift_search: parsed.drift_search,
        basic_search: parsed.basic_search,
        vector_store: vectorStore,
        completion_models: completionModels,
        embedding_models: embeddingModels,
      }),
    },
  };
}

function deriveStageFingerprints(input: {
  sourceHash: string;
  normalizedContentHash: string;
  promptFingerprintByStage: Record<BookStage, string>;
  stageConfigFingerprint: Record<BookStage, string>;
}): Record<BookStage, string> {
  const ingest = createDeterministicHash([
    "ingest",
    input.sourceHash,
    input.stageConfigFingerprint.ingest,
  ]);
  const normalize = createDeterministicHash([
    "normalize",
    input.sourceHash,
    input.normalizedContentHash,
    input.stageConfigFingerprint.normalize,
  ]);
  const graphExtract = createDeterministicHash([
    "graph_extract",
    normalize,
    input.stageConfigFingerprint.graph_extract,
    input.promptFingerprintByStage.graph_extract,
  ]);
  const communityReport = createDeterministicHash([
    "community_report",
    graphExtract,
    input.stageConfigFingerprint.community_report,
    input.promptFingerprintByStage.community_report,
  ]);
  const embed = createDeterministicHash([
    "embed",
    communityReport,
    input.stageConfigFingerprint.embed,
  ]);
  const queryReady = createDeterministicHash([
    "query_ready",
    embed,
    input.stageConfigFingerprint.query_ready,
  ]);

  return {
    ingest,
    normalize,
    graph_extract: graphExtract,
    community_report: communityReport,
    embed,
    query_ready: queryReady,
  };
}

async function artifactForFile(
  path: string,
  stage: BookStage,
  kind: Parameters<FileBookJobStateRepository["recordArtifacts"]>[1][number]["kind"],
  producerRunId: string,
) {
  return {
    stage,
    kind,
    path,
    contentHash: await hashFile(path),
    producerRunId,
  };
}

async function materializeSourceInVault(input: {
  sourcePath: string;
  sourceHash: string;
  stateRootDir: string;
  bookId: string;
}): Promise<string> {
  const extension = extname(input.sourcePath) || ".epub";
  const sourceDir = join(resolve(input.stateRootDir), "sources", input.bookId);
  const vaultSourcePath = join(sourceDir, `source${extension}`);
  await mkdir(sourceDir, { recursive: true });

  try {
    const existingHash = await hashFile(vaultSourcePath);
    if (existingHash === input.sourceHash) {
      return vaultSourcePath;
    }
  } catch {
    // Missing or unreadable materialized source is replaced below.
  }

  await copyFile(input.sourcePath, vaultSourcePath);
  return vaultSourcePath;
}

async function maybeArtifactForPath(
  path: string,
  stage: BookStage,
  kind: Parameters<FileBookJobStateRepository["recordArtifacts"]>[1][number]["kind"],
  producerRunId: string,
) {
  try {
    const entry = await stat(path);
    if (!entry.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  return artifactForFile(path, stage, kind, producerRunId);
}

async function maybeArtifactForDirectory(
  path: string,
  stage: BookStage,
  kind: Parameters<FileBookJobStateRepository["recordArtifacts"]>[1][number]["kind"],
  producerRunId: string,
) {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    stage,
    kind,
    path,
    contentHash: await hashDirectoryContents(path),
    producerRunId,
  };
}

async function isCompleteLanceDbDirectory(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  for (const tableName of REQUIRED_LANCEDB_TABLES) {
    const tableDir = join(path, tableName);
    try {
      const [tableEntry, dataFiles, versionFiles] = await Promise.all([
        stat(tableDir),
        readdir(join(tableDir, "data")),
        readdir(join(tableDir, "_versions")),
      ]);
      if (
        !tableEntry.isDirectory() ||
        !dataFiles.some((item) => item.endsWith(".lance")) ||
        !versionFiles.some((item) => item.endsWith(".manifest"))
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

async function collectWorkspaceArtifacts(
  paths: GraphRagBookWorkspacePaths,
  vaultSourcePath: string,
  producerRunId: string,
) {
  const normalizedPath = resolve(paths.normalizedPath);
  const outputDir = resolve(paths.outputDir);

  const artifacts = await Promise.all([
    artifactForFile(vaultSourcePath, "ingest", "source_epub", producerRunId),
    maybeArtifactForPath(
      normalizedPath,
      "normalize",
      "normalized_markdown",
      producerRunId,
    ),
    maybeArtifactForPath(
      join(outputDir, "documents.parquet"),
      "graph_extract",
      "graphrag_documents_parquet",
      producerRunId,
    ),
    maybeArtifactForPath(
      join(outputDir, "text_units.parquet"),
      "graph_extract",
      "graphrag_text_units_parquet",
      producerRunId,
    ),
    maybeArtifactForPath(
      join(outputDir, "entities.parquet"),
      "graph_extract",
      "graphrag_entities_parquet",
      producerRunId,
    ),
    maybeArtifactForPath(
      join(outputDir, "relationships.parquet"),
      "graph_extract",
      "graphrag_relationships_parquet",
      producerRunId,
    ),
    maybeArtifactForPath(
      join(outputDir, "communities.parquet"),
      "graph_extract",
      "graphrag_communities_parquet",
      producerRunId,
    ),
    maybeArtifactForPath(
      join(outputDir, "context.json"),
      "graph_extract",
      "graphrag_context_json",
      producerRunId,
    ),
    maybeArtifactForPath(
      join(outputDir, "stats.json"),
      "graph_extract",
      "graphrag_stats_json",
      producerRunId,
    ),
    maybeArtifactForPath(
      join(outputDir, "community_reports.parquet"),
      "community_report",
      "graphrag_community_reports_parquet",
      producerRunId,
    ),
    isCompleteLanceDbDirectory(join(outputDir, "lancedb")).then((isComplete) =>
      isComplete
        ? maybeArtifactForDirectory(
            join(outputDir, "lancedb"),
            "embed",
            "lancedb_index",
            producerRunId,
          )
        : null,
    ),
    maybeArtifactForPath(
      join(resolve(paths.stateRootDir), "reports", "indexing-engine.log"),
      "graph_extract",
      "index_log",
      producerRunId,
    ),
  ]);

  return artifacts.filter((item) => item != null);
}

function groupArtifactsByStage(artifacts: BookArtifactManifest[]) {
  const grouped = new Map<BookStage, BookArtifactManifest[]>();
  for (const artifact of artifacts) {
    const items = grouped.get(artifact.stage) ?? [];
    items.push(artifact);
    grouped.set(artifact.stage, items);
  }
  return grouped;
}

function hasKinds(
  artifacts: BookArtifactManifest[],
  kinds: readonly BookArtifactKind[],
): boolean {
  const artifactKinds = new Set(artifacts.map((artifact) => artifact.kind));
  return kinds.every((kind) => artifactKinds.has(kind));
}

async function bootstrapRecoveredStages(input: {
  repo: FileBookJobStateRepository;
  bookId: string;
  stageFingerprints: StageFingerprintMap;
  artifacts: BookArtifactManifest[];
  bootstrapRunId: string;
}) {
  const byStage = groupArtifactsByStage(input.artifacts);
  const existing = new Map(
    (await input.repo.listStageCheckpoints(input.bookId)).map((item) => [
      item.stage,
      item,
    ]),
  );

  const maybeComplete = async (
    stage: BookStage,
    shouldComplete: boolean,
    artifactIds = (byStage.get(stage) ?? []).map((artifact) => artifact.artifactId),
  ) => {
    if (!shouldComplete) {
      return;
    }
    const checkpoint = existing.get(stage);
    const expectedFingerprint =
      input.stageFingerprints[stage] ?? createDeterministicHash([stage]);
    const isReusableSucceededCheckpoint =
      checkpoint?.status === "succeeded" &&
      checkpoint.inputFingerprint === expectedFingerprint &&
      checkpoint.metadata?.bootstrap !== true &&
      artifactIds.every((artifactId) => checkpoint.artifactIds.includes(artifactId));

    if (isReusableSucceededCheckpoint) {
      return;
    }
    await input.repo.completeStage({
      bookId: input.bookId,
      stage,
      runId: input.bootstrapRunId,
      inputFingerprint: expectedFingerprint,
      artifactIds,
      metadata: {
        bootstrap: true,
      },
    });
  };

  await maybeComplete("ingest", (byStage.get("ingest")?.length ?? 0) > 0);
  await maybeComplete("normalize", (byStage.get("normalize")?.length ?? 0) > 0);
  await maybeComplete(
    "graph_extract",
    hasKinds(byStage.get("graph_extract") ?? [], GRAPH_EXTRACT_KINDS),
  );
  await maybeComplete(
    "community_report",
    hasKinds(byStage.get("community_report") ?? [], [
      "graphrag_community_reports_parquet",
    ]),
  );
  await maybeComplete("embed", hasKinds(byStage.get("embed") ?? [], ["lancedb_index"]));
  await maybeComplete(
    "query_ready",
    hasKinds(byStage.get("community_report") ?? [], [
      "graphrag_community_reports_parquet",
    ]) && hasKinds(byStage.get("embed") ?? [], ["lancedb_index"]),
    [
      ...(byStage.get("community_report") ?? []),
      ...(byStage.get("embed") ?? []),
    ].map((artifact) => artifact.artifactId),
  );
}

export async function syncGraphRagBookWorkspace(
  input: SyncGraphRagBookWorkspaceInput,
): Promise<GraphRagBookWorkspaceState> {
  const repo = new FileBookJobStateRepository(input.stateRootDir);
  const sourcePath = resolve(input.sourcePath);
  const sourceIdentityPath = basename(input.sourceIdentityPath ?? sourcePath);
  const normalizedPath = resolve(input.normalizedPath);
  const bootstrapRunId = createRunId("bootstrap");

  const [sourceHash, normalizedContentHash, promptFingerprint, settings] =
    await Promise.all([
      hashFile(sourcePath),
      hashFile(normalizedPath),
      hashDirectoryContents(resolve(input.promptsDir)),
      parseSettingsFingerprint(resolve(input.settingsPath)),
    ]);

  const promptFingerprintByStage: Record<BookStage, string> = {
    ingest: createDeterministicHash(["ingest", "no-prompt"]),
    normalize: createDeterministicHash(["normalize", "no-prompt"]),
    graph_extract: createDeterministicHash([
      promptFingerprint,
      "extract_graph.txt",
      "summarize_descriptions.txt",
    ]),
    community_report: createDeterministicHash([
      promptFingerprint,
      "community_report_graph.txt",
      "community_report_text.txt",
    ]),
    embed: createDeterministicHash(["embed", "no-prompt"]),
    query_ready: createDeterministicHash([
      promptFingerprint,
      "local_search_system_prompt.txt",
      "global_search_map_system_prompt.txt",
      "global_search_reduce_system_prompt.txt",
      "global_search_knowledge_system_prompt.txt",
      "drift_search_system_prompt.txt",
      "drift_search_reduce_prompt.txt",
      "basic_search_system_prompt.txt",
    ]),
  };

  const stageFingerprints = deriveStageFingerprints({
    sourceHash,
    normalizedContentHash,
    promptFingerprintByStage,
    stageConfigFingerprint: settings.stageConfigFingerprint,
  });
  const bookId = buildBookIdFromSourceHash(sourceIdentityPath, sourceHash);
  const vaultSourcePath = await materializeSourceInVault({
    sourcePath,
    sourceHash,
    stateRootDir: input.stateRootDir,
    bookId,
  });

  const job = await repo.registerBookSource({
    sourcePath,
    sourceIdentityPath,
    canonicalSourcePath: repo.relativePath(vaultSourcePath),
    normalizedContentHash,
    configFingerprint: settings.configFingerprint,
    promptFingerprint,
    modelFingerprint: settings.modelFingerprint,
    metadata: {
      sourceIdentityPath,
      sourcePath: repo.relativePath(vaultSourcePath),
      normalizedPath: repo.relativePath(normalizedPath),
      sourceName: stripKnownBookExtension(sourceIdentityPath),
      ...(input.metadata ?? {}),
    },
  });

  const artifacts = await collectWorkspaceArtifacts(
    input,
    vaultSourcePath,
    bootstrapRunId,
  );
  const recordedArtifacts = await repo.recordArtifacts(job.bookId, artifacts);

  if (input.recordRecoveredStages !== false) {
    await bootstrapRecoveredStages({
      repo,
      bookId: job.bookId,
      stageFingerprints,
      artifacts: recordedArtifacts,
      bootstrapRunId,
    });
  }

  const resumePlan = await repo.getResumePlan(
    job.bookId,
    stageFingerprints,
    GRAPH_RAG_STAGE_ARTIFACT_REQUIREMENTS,
  );
  return {
    job,
    artifacts: await repo.listArtifacts(job.bookId),
    stageFingerprints,
    resumePlan,
    bootstrapRunId,
  };
}
