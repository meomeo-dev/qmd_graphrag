import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import YAML from "yaml";

import {
  type BookArtifactKind,
  BookArtifactManifestListSchema,
  BookJobCatalogSchema,
  BookJobCheckpointListSchema,
  type BookArtifactManifest,
  type BookStage,
} from "../contracts/book-job.js";
import { DocumentIdentityCatalogSchema } from "../contracts/corpus.js";
import type { DocumentIdentityMap } from "../contracts/corpus.js";
import {
  GraphCapabilityCatalogSchema,
  GraphCapabilitySchema,
  type GraphCapability,
} from "../contracts/graph-enhancement.js";
import { SchemaVersion } from "../contracts/common.js";
import type { QmdRetrievalCandidate } from "../contracts/qmd-query.js";
import {
  GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  QUERY_READY_ARTIFACT_KINDS,
  validateBookArtifactSet,
} from "../job-state/artifact-validation.js";
import { sanitizeVaultMetadata } from "../vault/metadata.js";

const QUERY_READY_PRODUCER_REQUIRED_KINDS = {
  graph_extract: GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  community_report: ["graphrag_community_reports_parquet"],
  embed: ["lancedb_index"],
} as const satisfies Record<
  "graph_extract" | "community_report" | "embed",
  readonly string[]
>;

const QUERY_READY_LINEAGE_ARTIFACT_KINDS = [
  ...GRAPH_EXTRACT_CORE_ARTIFACT_KINDS,
  ...QUERY_READY_ARTIFACT_KINDS,
] as const satisfies readonly BookArtifactKind[];

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function filterArtifactIdsByKinds(
  artifactIds: readonly string[],
  artifacts: readonly BookArtifactManifest[],
  kinds: readonly BookArtifactKind[],
): string[] {
  const kindSet = new Set<BookArtifactKind>(kinds);
  return artifactIds.filter((artifactId) => {
    const artifact = artifacts.find((candidate) =>
      candidate.artifactId === artifactId
    );
    return artifact != null && kindSet.has(artifact.kind);
  });
}

export type ResolveGraphCapabilitiesInput = {
  graphVault: string;
  documentIds?: readonly (string | null | undefined)[];
  sourceIds?: readonly (string | null | undefined)[];
};

async function readYaml(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf8");
    return YAML.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function normalizeIdentitySet(
  values: readonly (string | null | undefined)[] | undefined,
): Set<string> {
  return new Set((values ?? []).filter((value): value is string => !!value));
}

function matchesRequestedScope(
  capability: GraphCapability,
  documentIds: Set<string>,
  sourceIds: Set<string>,
): boolean {
  const hasScope = documentIds.size > 0 || sourceIds.size > 0;
  if (!hasScope) return true;
  return documentIds.has(capability.documentId) || sourceIds.has(capability.sourceId);
}

function methodCapabilities(
  base: Omit<GraphCapability, "capabilityId" | "kind" | "method">,
): GraphCapability[] {
  return [
    GraphCapabilitySchema.parse({
      ...base,
      capabilityId: `${base.bookId}:graph_query`,
      kind: "graph_query",
    }),
    GraphCapabilitySchema.parse({
      ...base,
      capabilityId: `${base.bookId}:local_search`,
      kind: "local_search",
      method: "local",
    }),
    GraphCapabilitySchema.parse({
      ...base,
      capabilityId: `${base.bookId}:global_search`,
      kind: "global_search",
      method: "global",
    }),
    GraphCapabilitySchema.parse({
      ...base,
      capabilityId: `${base.bookId}:drift_search`,
      kind: "drift_search",
      method: "drift",
    }),
    GraphCapabilitySchema.parse({
      ...base,
      capabilityId: `${base.bookId}:community_reports`,
      kind: "community_reports",
    }),
  ];
}

async function validateQueryReadyArtifacts(
  graphVault: string,
  bookId: string,
  artifactIds: readonly string[],
): Promise<boolean> {
  const booksRaw = await readYaml(join(graphVault, "catalog", "books.yaml"));
  const booksResult = BookJobCatalogSchema.safeParse(booksRaw);
  if (!booksResult.success) return false;
  const book = booksResult.data.items.find((item) => item.bookId === bookId);
  if (
    book == null ||
    book.stageFingerprints == null ||
    book.providerFingerprint == null
  ) {
    return false;
  }

  const checkpointsRaw = await readYaml(
    join(graphVault, "books", bookId, "checkpoints.yaml"),
  );
  const checkpointsResult = BookJobCheckpointListSchema.safeParse(checkpointsRaw);
  if (!checkpointsResult.success) return false;
  const checkpointByStage = new Map(
    checkpointsResult.data.items
      .filter((checkpoint) => checkpoint.status === "succeeded")
      .map((checkpoint) => [checkpoint.stage, checkpoint]),
  );
  const graphExtractRunId = checkpointByStage.get("graph_extract")?.runId;
  const communityReportRunId = checkpointByStage.get("community_report")?.runId;
  const embedRunId = checkpointByStage.get("embed")?.runId;
  if (
    graphExtractRunId == null ||
    communityReportRunId == null ||
    embedRunId == null
  ) {
    return false;
  }
  const expectedProducerRunIds: Partial<Record<BookStage, string>> = {
    graph_extract: graphExtractRunId,
    community_report: communityReportRunId,
    embed: embedRunId,
  };
  const expectedContentHash = book.normalizedContentHash ?? book.sourceHash;

  for (const stage of [
    "graph_extract",
    "community_report",
    "embed",
    "query_ready",
  ] as const) {
    const checkpoint = checkpointByStage.get(stage);
    if (
      checkpoint == null ||
      checkpoint.contentHash !== expectedContentHash ||
      checkpoint.stageFingerprint !== book.stageFingerprints[stage] ||
      checkpoint.providerFingerprint !== book.providerFingerprint
    ) {
      return false;
    }
  }

  const artifactsRaw = await readYaml(join(graphVault, "books", bookId, "artifacts.yaml"));
  if (artifactsRaw == null) return false;
  const artifactsResult = BookArtifactManifestListSchema.safeParse(artifactsRaw);
  if (!artifactsResult.success) return false;
  const artifacts = artifactsResult.data.items;
  const byId = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const selectedArtifacts = artifactIds
    .map((artifactId) => byId.get(artifactId))
    .filter((artifact): artifact is BookArtifactManifest => artifact != null);
  if (selectedArtifacts.length !== artifactIds.length) return false;
  if (selectedArtifacts.some((artifact) =>
    artifact.bookId !== bookId
  )) {
    return false;
  }

  for (const stage of ["graph_extract", "community_report", "embed"] as const) {
    const checkpoint = checkpointByStage.get(stage);
    if (checkpoint == null) return false;
    const producerValidation = await validateBookArtifactSet({
      graphVault,
      bookId,
      artifactIds: filterArtifactIdsByKinds(
        checkpoint.artifactIds,
        artifacts,
        QUERY_READY_PRODUCER_REQUIRED_KINDS[stage],
      ),
      artifacts,
      requiredKinds: QUERY_READY_PRODUCER_REQUIRED_KINDS[stage],
      allowedKinds: QUERY_READY_PRODUCER_REQUIRED_KINDS[stage],
      requireBookScopedGraphOutput: true,
      expectedProducerRunIds: { [stage]: checkpoint.runId },
      expectedStageFingerprints: book.stageFingerprints,
      expectedProviderFingerprint: book.providerFingerprint,
      expectedCorpusContentHash: expectedContentHash,
    });
    if (!producerValidation.isSatisfied) return false;
  }

  const queryReadyCheckpoint = checkpointByStage.get("query_ready");
  if (queryReadyCheckpoint == null) return false;
  const queryReadyValidation = await validateBookArtifactSet({
    graphVault,
    bookId,
    artifactIds: queryReadyCheckpoint.artifactIds,
    artifacts,
    requiredKinds: QUERY_READY_ARTIFACT_KINDS,
    allowedKinds: QUERY_READY_ARTIFACT_KINDS,
    requireBookScopedGraphOutput: true,
    expectedProducerRunIds,
    expectedStageFingerprints: book.stageFingerprints,
    expectedProviderFingerprint: book.providerFingerprint,
    expectedCorpusContentHash: expectedContentHash,
  });
  if (!queryReadyValidation.isSatisfied) return false;

  const validation = await validateBookArtifactSet({
    graphVault,
    bookId,
    artifactIds,
    artifacts,
    requiredKinds: QUERY_READY_LINEAGE_ARTIFACT_KINDS,
    allowedKinds: QUERY_READY_LINEAGE_ARTIFACT_KINDS,
    requireBookScopedGraphOutput: true,
    expectedProducerRunIds,
    expectedStageFingerprints: book.stageFingerprints,
    expectedProviderFingerprint: book.providerFingerprint,
    expectedCorpusContentHash: expectedContentHash,
  });
  return validation.isSatisfied;
}

async function loadQueryReadyLineageArtifactIds(
  graphVault: string,
  bookId: string,
): Promise<string[] | null> {
  const checkpointsRaw = await readYaml(
    join(graphVault, "books", bookId, "checkpoints.yaml"),
  );
  const checkpointsResult = BookJobCheckpointListSchema.safeParse(checkpointsRaw);
  if (!checkpointsResult.success) return null;
  const checkpointByStage = new Map(
    checkpointsResult.data.items
      .filter((checkpoint) => checkpoint.status === "succeeded")
      .map((checkpoint) => [checkpoint.stage, checkpoint]),
  );
  const artifactsRaw = await readYaml(join(graphVault, "books", bookId, "artifacts.yaml"));
  const artifactsResult = BookArtifactManifestListSchema.safeParse(artifactsRaw);
  if (!artifactsResult.success) return null;
  const artifacts = artifactsResult.data.items;
  const ids = [
    ...filterArtifactIdsByKinds(
      checkpointByStage.get("graph_extract")?.artifactIds ?? [],
      artifacts,
      QUERY_READY_PRODUCER_REQUIRED_KINDS.graph_extract,
    ),
    ...filterArtifactIdsByKinds(
      checkpointByStage.get("community_report")?.artifactIds ?? [],
      artifacts,
      QUERY_READY_PRODUCER_REQUIRED_KINDS.community_report,
    ),
    ...filterArtifactIdsByKinds(
      checkpointByStage.get("embed")?.artifactIds ?? [],
      artifacts,
      QUERY_READY_PRODUCER_REQUIRED_KINDS.embed,
    ),
    ...filterArtifactIdsByKinds(
      checkpointByStage.get("query_ready")?.artifactIds ?? [],
      artifacts,
      QUERY_READY_ARTIFACT_KINDS,
    ),
  ];
  return ids.length > 0 ? uniqueStrings(ids) : null;
}

function isSubsetOf(
  values: readonly string[],
  allowedValues: readonly string[],
): boolean {
  const allowed = new Set(allowedValues);
  return values.every((value) => allowed.has(value));
}

export async function loadExplicitCapabilityCatalog(
  graphVault: string,
): Promise<GraphCapability[]> {
  const catalogPath = join(graphVault, "catalog", "graph-capabilities.yaml");
  const parsed = await readYaml(catalogPath);
  if (parsed == null) return [];
  return GraphCapabilityCatalogSchema.parse(parsed).items;
}

async function filterValidatedCapabilities(
  graphVault: string,
  capabilities: readonly GraphCapability[],
): Promise<GraphCapability[]> {
  const identityRaw = await readYaml(
    join(graphVault, "catalog", "document-identity-map.yaml"),
  );
  const identities = identityRaw == null
    ? []
    : DocumentIdentityCatalogSchema.parse(identityRaw).items;
  const result: GraphCapability[] = [];
  for (const capability of capabilities) {
    if (!capability.ready) continue;
    if (!capabilityHasGraphIdentity(capability, identities)) {
      continue;
    }
    const lineageArtifactIds = await loadQueryReadyLineageArtifactIds(
      graphVault,
      capability.bookId,
    );
    if (
      lineageArtifactIds == null ||
      !isSubsetOf(capability.artifactIds, lineageArtifactIds)
    ) {
      continue;
    }
    if (!(await validateQueryReadyArtifacts(
      graphVault,
      capability.bookId,
      lineageArtifactIds,
    ))) {
      continue;
    }
    result.push(GraphCapabilitySchema.parse({
      ...capability,
      artifactIds: lineageArtifactIds,
      metadata: sanitizeVaultMetadata({
        ...(capability.metadata ?? {}),
        lineageProjectionSource: "validated_checkpoint_plus_validated_manifest",
      }),
    }));
  }
  return result;
}

function capabilityHasGraphIdentity(
  capability: GraphCapability,
  identities: readonly DocumentIdentityMap[],
): boolean {
  const identity = identities.find((item) =>
    item.canonicalBookId === capability.bookId &&
    item.documentId === capability.documentId &&
    item.contentHash === capability.contentHash &&
    item.sourceId === capability.sourceId
  );
  return identity?.graphDocumentId != null &&
    identity.metadata?.qmdCorpusRegistered === true &&
    identity.graphTextUnitIds != null &&
    identity.graphTextUnitIds.length > 0;
}

async function deriveCapabilitiesFromBookState(
  graphVault: string,
): Promise<GraphCapability[]> {
  const booksRaw = await readYaml(join(graphVault, "catalog", "books.yaml"));
  if (booksRaw == null) return [];
  const books = BookJobCatalogSchema.parse(booksRaw).items;
  const identityRaw = await readYaml(
    join(graphVault, "catalog", "document-identity-map.yaml"),
  );
  const identities = identityRaw == null
    ? []
    : DocumentIdentityCatalogSchema.parse(identityRaw).items;
  const capabilities: GraphCapability[] = [];

  for (const book of books) {
    const lineageArtifactIds = await loadQueryReadyLineageArtifactIds(
      graphVault,
      book.bookId,
    );
    if (lineageArtifactIds == null) continue;
    if (!(await validateQueryReadyArtifacts(
      graphVault,
      book.bookId,
      lineageArtifactIds,
    ))) {
      continue;
    }

    const expectedContentHash = book.normalizedContentHash ?? book.sourceHash;
    const expectedSourceId = `sha256:${book.sourceHash}`;
    const identity = identities.find((item) =>
      item.canonicalBookId === book.bookId &&
      item.sourceId === expectedSourceId &&
      item.sourceHash === book.sourceHash &&
      item.documentId === book.documentId &&
      item.contentHash === expectedContentHash
    );
    if (
      identity == null ||
      identity.metadata?.qmdCorpusRegistered !== true ||
      identity.graphDocumentId == null ||
      identity.graphTextUnitIds == null ||
      identity.graphTextUnitIds.length === 0
    ) {
      continue;
    }
    const contentHash = identity.contentHash;
    const sourceId = identity.sourceId;
    const documentId = identity.documentId;
    const sourceName = typeof book.metadata?.sourceName === "string"
      ? book.metadata.sourceName
      : undefined;

    capabilities.push(...methodCapabilities({
      schemaVersion: SchemaVersion,
      bookId: book.bookId,
      sourceId,
      documentId,
      contentHash,
      ready: true,
      readinessSource: "validated_checkpoint_plus_validated_manifest",
      artifactIds: lineageArtifactIds,
      createdAt: new Date(0).toISOString(),
      metadata: sanitizeVaultMetadata({
        projectionSource: "book_state",
        ...(sourceName ? { sourceName } : {}),
      }),
    }));
  }

  return capabilities;
}

export async function loadGraphCapabilities(
  input: ResolveGraphCapabilitiesInput,
): Promise<GraphCapability[]> {
  const graphVault = resolve(input.graphVault);
  const documentIds = normalizeIdentitySet(input.documentIds);
  const sourceIds = normalizeIdentitySet(input.sourceIds);
  const explicit = await loadExplicitCapabilityCatalog(graphVault);
  const [derived, validatedExplicit] = await Promise.all([
    deriveCapabilitiesFromBookState(graphVault),
    filterValidatedCapabilities(graphVault, explicit),
  ]);
  const byCapabilityId = new Map<string, GraphCapability>();
  for (const capability of derived) {
    byCapabilityId.set(capability.capabilityId, capability);
  }
  const derivedSemanticKeys = new Set(derived.map(capabilitySemanticKey));
  for (const capability of validatedExplicit) {
    if (
      byCapabilityId.has(capability.capabilityId) ||
      derivedSemanticKeys.has(capabilitySemanticKey(capability))
    ) {
      continue;
    }
    byCapabilityId.set(capability.capabilityId, capability);
  }
  const capabilities = [...byCapabilityId.values()];

  return capabilities
    .filter((capability) => capability.ready)
    .filter((capability) => matchesRequestedScope(capability, documentIds, sourceIds));
}

export async function loadGraphQueryCapabilities(
  input: ResolveGraphCapabilitiesInput,
): Promise<GraphCapability[]> {
  return (await loadGraphCapabilities(input)).filter(
    (capability) => capability.kind === "graph_query",
  );
}

export async function recordGraphCapability(
  graphVault: string,
  capability: GraphCapability,
): Promise<GraphCapability[]> {
  const root = resolve(graphVault);
  const catalogPath = join(root, "catalog", "graph-capabilities.yaml");
  const parsedCapability = GraphCapabilitySchema.parse(capability);
  const sanitizedCapability = GraphCapabilitySchema.parse({
    ...parsedCapability,
    metadata: sanitizeVaultMetadata(parsedCapability.metadata),
  });
  const existing = await loadExplicitCapabilityCatalog(root);
  const items = [
    ...existing.filter((item) =>
      item.capabilityId !== sanitizedCapability.capabilityId,
    ),
    sanitizedCapability,
  ].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  const catalog = GraphCapabilityCatalogSchema.parse({
    schemaVersion: SchemaVersion,
    items,
  });

  await mkdir(join(root, "catalog"), { recursive: true });
  await writeFile(catalogPath, YAML.stringify(catalog), "utf8");
  return catalog.items;
}

function capabilitySemanticKey(capability: GraphCapability): string {
  return [
    capability.bookId,
    capability.kind,
    capability.method ?? "",
  ].join("\0");
}

function candidateMatchesCapability(input: {
  candidate: QmdRetrievalCandidate;
  capability: GraphCapability;
  uniqueContentHashes: ReadonlySet<string>;
}): boolean {
  const { candidate, capability, uniqueContentHashes } = input;
  if (candidate.documentId != null && candidate.documentId === capability.documentId) {
    return true;
  }
  if (candidate.sourceId != null && candidate.sourceId === capability.sourceId) {
    return true;
  }
  if (
    candidate.contentHash != null &&
    uniqueContentHashes.has(candidate.contentHash) &&
    candidate.contentHash === capability.contentHash
  ) {
    return true;
  }
  return false;
}

export async function resolveCandidateGraphCapabilities(input: {
  graphVault: string;
  candidates: readonly QmdRetrievalCandidate[];
}): Promise<Map<string, GraphCapability[]>> {
  const capabilities = await loadGraphQueryCapabilities({
    graphVault: input.graphVault,
  });
  const contentHashCounts = new Map<string, number>();
  for (const capability of capabilities) {
    contentHashCounts.set(
      capability.contentHash,
      (contentHashCounts.get(capability.contentHash) ?? 0) + 1,
    );
  }
  const uniqueContentHashes = new Set(
    [...contentHashCounts.entries()]
      .filter(([, count]) => count === 1)
      .map(([contentHash]) => contentHash),
  );
  const byCandidateId = new Map<string, GraphCapability[]>();

  for (const candidate of input.candidates) {
    const matches = capabilities.filter((capability) =>
      candidateMatchesCapability({
        candidate,
        capability,
        uniqueContentHashes,
      }),
    );
    if (matches.length > 0) {
      byCandidateId.set(candidate.candidateId, matches);
    }
  }

  return byCandidateId;
}
