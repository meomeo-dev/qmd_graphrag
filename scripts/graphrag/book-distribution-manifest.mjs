import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

const SchemaVersion = "1.0.0";

function toPosixPath(path) {
  return String(path).split(sep).join("/");
}

function vaultRelative(stateRoot, path) {
  return toPosixPath(relative(stateRoot, path));
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function listFilesRecursive(rootPath, options = {}) {
  if (!existsSync(rootPath)) return [];
  const files = [];
  const visit = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (options.exclude?.(path, entry) === true) continue;
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit(rootPath);
  return files;
}

function sidecarsFor(path) {
  return [
    `${path}.sha256`,
    `${path}.sha256.meta.json`,
  ].filter((candidate) => existsSync(candidate));
}

function filesWithSidecars(paths) {
  return uniqueSorted(paths.flatMap((path) => [path, ...sidecarsFor(path)]));
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function fileEntry(stateRoot, path, role) {
  const entry = safeStat(path);
  return {
    path: vaultRelative(stateRoot, path),
    role,
    bytes: entry?.isFile() ? entry.size : undefined,
  };
}

function copyBookScopedNormalizedInput(input) {
  if (!existsSync(input.normalizedPath)) return null;
  const targetPath = join(
    input.stateRoot,
    "books",
    input.bookId,
    "input",
    basename(input.normalizedPath),
  );
  if (input.normalizedPath === targetPath) return targetPath;
  mkdirSync(dirname(targetPath), { recursive: true });
  if (!existsSync(targetPath)) copyFileSync(input.normalizedPath, targetPath);
  return targetPath;
}

function readRunIdsFromProducer(producer) {
  return uniqueSorted([
    producer?.producerRunId,
    ...Object.values(producer?.stageProducerRunIds ?? {}),
  ]);
}

function runRecordPaths(input, runIds) {
  return runIds
    .map((runId) => {
      const hotplugPath = join(
        input.stateRoot,
        "books",
        input.bookId,
        "graphrag",
        "runs",
        `${runId}.yaml`,
      );
      if (existsSync(hotplugPath)) return hotplugPath;
      return join(input.stateRoot, "books", input.bookId, "runs", `${runId}.yaml`);
    })
    .filter((path) => existsSync(path));
}

function firstExistingPath(paths) {
  return paths.find((path) => existsSync(path));
}

export function buildBookDistributionManifest(input) {
  const bookRoot = join(input.stateRoot, "books", input.bookId);
  const sourceRoot = join(bookRoot, "source");
  const legacySourceRoot = join(input.stateRoot, "sources", input.bookId);
  const outputRoot = join(bookRoot, "graphrag", "output");
  const legacyOutputRoot = join(bookRoot, "output");
  const qmdRoot = join(bookRoot, "qmd");
  const stateRoot = join(bookRoot, "state");
  const canonicalInputPath = copyBookScopedNormalizedInput(input);
  const primaryBookFiles = [
    firstExistingPath([join(stateRoot, "job.yaml"), join(bookRoot, "job.yaml")]),
    firstExistingPath([
      join(stateRoot, "artifacts.yaml"),
      join(bookRoot, "artifacts.yaml"),
    ]),
    firstExistingPath([
      join(stateRoot, "checkpoints.yaml"),
      join(bookRoot, "checkpoints.yaml"),
    ]),
    ...(canonicalInputPath == null ? [] : [canonicalInputPath]),
  ].filter((path) => typeof path === "string" && existsSync(path));
  const qmdFiles = listFilesRecursive(qmdRoot);
  const outputFiles = listFilesRecursive(outputRoot, {
    exclude: (path) => basename(path).includes(".corrupt-"),
  });
  const legacyOutputFiles = outputFiles.length > 0
    ? []
    : listFilesRecursive(legacyOutputRoot, {
        exclude: (path) => basename(path).includes(".corrupt-"),
      });
  const sourceFiles = listFilesRecursive(sourceRoot);
  const legacySourceFiles = sourceFiles.length > 0
    ? []
    : listFilesRecursive(legacySourceRoot);
  const runFiles = runRecordPaths(input, readRunIdsFromProducer(input.producer));
  const included = filesWithSidecars([
    ...sourceFiles,
    ...legacySourceFiles,
    ...primaryBookFiles,
    ...qmdFiles,
    ...outputFiles,
    ...legacyOutputFiles,
    ...runFiles,
  ]);
  const files = included.map((path) => {
    let role = "book_metadata";
    if (path.startsWith(sourceRoot) || path.startsWith(legacySourceRoot)) {
      role = "source";
    }
    else if (path.startsWith(qmdRoot)) role = "qmd";
    else if (canonicalInputPath != null && path.startsWith(dirname(canonicalInputPath))) {
      role = "book_scoped_input";
    } else if (path.startsWith(outputRoot) || path.startsWith(legacyOutputRoot)) {
      role = "graphrag_output";
    }
    else if (path.includes(`${sep}runs${sep}`)) role = "producer_run_evidence";
    return fileEntry(input.stateRoot, path, role);
  });
  const legacyNormalizedLocator = input.normalizedPath != null
    ? vaultRelative(input.stateRoot, input.normalizedPath)
    : undefined;
  return {
    schemaVersion: SchemaVersion,
    kind: "book_distribution_manifest",
    bookId: input.bookId,
    itemId: input.itemId,
    runId: input.runId,
    sourceHash: input.sourceHash,
    sourceRelativePath: input.sourceRelativePath,
    generatedAt: input.now(),
    portability: {
      closureRoot: `books/${input.bookId}`,
      sourceRoot: `books/${input.bookId}/source`,
      canonicalNormalizedPath: canonicalInputPath == null
        ? undefined
        : vaultRelative(input.stateRoot, canonicalInputPath),
      legacyNormalizedPath: legacyNormalizedLocator,
      qmdBuildManifestPath: `books/${input.bookId}/qmd/qmd_build_manifest.json`,
      graphOutputManifestPath:
        `books/${input.bookId}/graphrag/output/qmd_output_manifest.json`,
    },
    producerEvidence: {
      outputProducerRunId: input.producer?.producerRunId,
      stageProducerRunIds: input.producer?.stageProducerRunIds ?? {},
      presentRunRecordCount: runFiles.length,
      missingRunRecordIds: readRunIdsFromProducer(input.producer)
        .filter((runId) =>
          !existsSync(join(
            input.stateRoot,
            "books",
            input.bookId,
            "graphrag",
            "runs",
            `${runId}.yaml`,
          )) &&
          !existsSync(join(
            input.stateRoot,
            "books",
            input.bookId,
            "runs",
            `${runId}.yaml`,
          ))
        ),
    },
    files,
    exclusions: [
      ".env",
      "graph_vault/catalog/provider-requests/**",
      "graph_vault/catalog/provider-responses/**",
      "graph_vault/books/*/*.corrupt-*",
      "graph_vault/books/*/output/*.corrupt-*",
      "graph_vault/catalog/batch-runs/*/logs/**",
      "non-current book/source directories",
    ],
  };
}
