import { SchemaVersion } from "../../contracts/common.js";
import type { GraphCapability } from "../../contracts/graph-enhancement.js";
import type { GraphRagSearchMethod } from "../../contracts/graphrag.js";

import { packageLocator, type UpperScopeKind } from "./upper-package-paths.js";

export function upperGraphQueryCapabilityId(input: {
  scopeKind: UpperScopeKind;
  scopeId: string;
  generation: string;
  method?: GraphRagSearchMethod;
}): string {
  return [
    input.scopeKind,
    input.scopeId,
    input.generation,
    input.method ?? "global",
    "graph_query",
  ].join(":");
}

export function upperGraphQueryCapability(input: {
  scopeKind: UpperScopeKind;
  scopeId: string;
  generation: string;
  createdAt: string;
  manifestSha256: string;
  method?: GraphRagSearchMethod;
}): GraphCapability {
  const method = input.method ?? "global";
  const scopeKey = `${input.scopeKind}:${input.scopeId}`;
  return {
    schemaVersion: SchemaVersion,
    capabilityId: upperGraphQueryCapabilityId({ ...input, method }),
    kind: "graph_query",
    bookId: scopeKey,
    sourceId: scopeKey,
    documentId: `${scopeKey}:${input.generation}`,
    contentHash: input.manifestSha256,
    method,
    ready: true,
    readinessSource: "validated_checkpoint_plus_validated_manifest",
    artifactIds: [
      packageLocator({
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        generation: input.generation,
        relativePath: "community_reports.parquet",
      }),
      packageLocator({
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        generation: input.generation,
        relativePath: "evidence_map.parquet",
      }),
    ],
    createdAt: input.createdAt,
    metadata: {
      projectionSource: `${input.scopeKind}_manifest`,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      generation: input.generation,
      sourceName: input.scopeId,
    },
  };
}
