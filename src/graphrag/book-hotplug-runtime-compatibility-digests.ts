import { createHash } from "node:crypto";

export type RuntimeCompatibilityFileEntry = {
  path: string;
  bytes: number | null;
  sha256: string | null;
};

export type RuntimeCompatibilitySchemaDigests = {
  outputManifestSchemaDigest: string;
  parquetSchemaDigest: string;
  lancedbSchemaDigest: string;
  artifactMetadataSchemaDigest: string;
};

const SchemaVersion = "1.0.0";

const ParquetArtifacts = [
  "graphrag/output/documents.parquet",
  "graphrag/output/text_units.parquet",
  "graphrag/output/entities.parquet",
  "graphrag/output/relationships.parquet",
  "graphrag/output/communities.parquet",
  "graphrag/output/community_reports.parquet",
] as const;

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function digestRows(rows: readonly unknown[]): string {
  return sha256Text(`${JSON.stringify(rows, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stageFingerprintKeys(graphManifest: unknown): string[] {
  if (!isRecord(graphManifest)) return [];
  const stageFingerprints = graphManifest.stageFingerprints;
  return isRecord(stageFingerprints)
    ? Object.keys(stageFingerprints).sort()
    : [];
}

function fileByPath(
  files: readonly RuntimeCompatibilityFileEntry[],
  path: string,
): RuntimeCompatibilityFileEntry | undefined {
  return files.find((entry) => entry.path === path);
}

function requiredFileDigest(
  files: readonly RuntimeCompatibilityFileEntry[],
  paths: readonly string[],
): string {
  return digestRows(paths.map((path) => {
    const entry = fileByPath(files, path);
    return {
      path,
      bytes: entry?.bytes ?? null,
      sha256: entry?.sha256 ?? null,
    };
  }));
}

function lancedbDigest(files: readonly RuntimeCompatibilityFileEntry[]): string {
  const entry = fileByPath(files, "graphrag/output/lancedb");
  return digestRows([{
    path: "graphrag/output/lancedb",
    sha256: entry?.sha256 ?? null,
  }]);
}

export function buildRuntimeCompatibilitySchemaDigests(input: {
  files: readonly RuntimeCompatibilityFileEntry[];
  graphManifest: unknown;
}): RuntimeCompatibilitySchemaDigests {
  const graphManifest = isRecord(input.graphManifest)
    ? input.graphManifest
    : null;
  return {
    outputManifestSchemaDigest: digestRows([{
      schemaVersion: graphManifest?.schemaVersion ?? null,
      stageFingerprintKeys: stageFingerprintKeys(graphManifest),
      hasProviderFingerprint:
        typeof graphManifest?.providerFingerprint === "string",
      hasContentHash: typeof graphManifest?.contentHash === "string",
    }]),
    parquetSchemaDigest: requiredFileDigest(input.files, ParquetArtifacts),
    lancedbSchemaDigest: lancedbDigest(input.files),
    artifactMetadataSchemaDigest: digestRows([{
      schemaVersion: SchemaVersion,
      requiredFields: [
        "artifactId",
        "bookId",
        "stage",
        "kind",
        "path",
        "contentHash",
        "fileSha256",
        "bytes",
        "producerRunId",
        "producerStep",
        "producerToolVersion",
        "producerSchemaVersion",
        "upstreamArtifactHashes",
        "createdAt",
      ],
    }]),
  };
}

export function runtimeCompatibilityDigestDiagnostics(input: {
  actual: RuntimeCompatibilitySchemaDigests;
  expected: RuntimeCompatibilitySchemaDigests;
}): string[] {
  const diagnostics: string[] = [];
  for (const field of [
    "outputManifestSchemaDigest",
    "parquetSchemaDigest",
    "lancedbSchemaDigest",
    "artifactMetadataSchemaDigest",
  ] as const) {
    if (input.actual[field] !== input.expected[field]) {
      diagnostics.push(`runtime_compatibility_digest_mismatch:${field}`);
    }
  }
  return diagnostics;
}
