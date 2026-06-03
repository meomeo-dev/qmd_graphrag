import { join } from "node:path";

import {
  classifySingleBookForHotplugMigration,
} from "./book-hotplug-migration-state.mjs";

export function hotplugQualityGatePathForBookRoot(bookRoot) {
  return join(bookRoot, "state", "hotplug-quality-gate.json");
}

export function hotplugRuntimeGatePathForBookRoot(bookRoot) {
  return join(bookRoot, "state", "hotplug-runtime-gate.json");
}

export function hotplugQualityGatePathForBook(stateRoot, bookId) {
  return hotplugQualityGatePathForBookRoot(join(stateRoot, "books", bookId));
}

export function prePublishHotplugQualityGate(input) {
  return classifySingleBookForHotplugMigration({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
  });
}

export function graphRagNotQueryReadyFromGate(gate) {
  return gate.producer?.ok !== true;
}

export function buildPrePublishQualityGateFailure(input) {
  return {
    schemaVersion: "1.0.0",
    kind: "qmd_graphrag_book_hotplug_quality_gate",
    bookId: input.bookId,
    status: "failed",
    phase: "pre_publish_source_truth",
    checkedAt: input.checkedAt,
    mayGenerateBookManifest: false,
    diagnostics: input.gate.diagnostics,
    sourceHash: input.gate.sourceHash,
    sourceClosure: sourceClosureSummary(input.gate),
    canonicalInput: input.gate.canonicalInput,
    artifactChecksums: input.gate.artifactChecksums,
    producerProvenanceStatus: input.gate.producer.producerProvenanceStatus,
    copyDistributionAllowed: false,
    backfillHotplugPackageCompatibility: "failed_pre_publish_source_truth",
    packageCopyContract: {
      manifestValid: false,
      publishMarkerValid: false,
      directorySensitivePayloadFree: null,
      requiredArtifactsPresent: false,
    },
    repairAction: "repair_source_truth_before_publish",
  };
}

export function buildPostPublishQualityGate(input) {
  if (!input.validation.ok) {
    return {
      schemaVersion: "1.0.0",
      kind: "qmd_graphrag_book_hotplug_quality_gate",
      bookId: input.bookId,
      status: "failed",
      phase: input.phase ?? "post_publish_package_validation",
      checkedAt: input.checkedAt,
      mayGenerateBookManifest: true,
      diagnostics: input.validation.diagnostics,
      copyDistributionAllowed: false,
      backfillHotplugPackageCompatibility: "failed_package_validation",
      packageCopyContract: {
        manifestValid: false,
        publishMarkerValid: false,
        directorySensitivePayloadFree: !input.validation.diagnostics.some((code) =>
          String(code).startsWith("forbidden_sensitive_material")
        ),
        requiredArtifactsPresent: !input.validation.diagnostics.some((code) =>
          String(code).startsWith("missing_required_file")
        ),
      },
      repairAction: "repair_package_closure_before_distribution",
    };
  }
  const manifest = input.validation.manifest ?? input.manifest;
  return {
    schemaVersion: "1.0.0",
    kind: "qmd_graphrag_book_hotplug_quality_gate",
    bookId: input.bookId,
    status: "passed",
    phase: input.phase ?? "post_publish_package_validation",
    checkedAt: input.checkedAt,
    mayGenerateBookManifest: true,
    copyDistributionAllowed: true,
    backfillHotplugPackageCompatibility: "passed",
    packageCopyContract: {
      manifestValid: true,
      publishMarkerValid: true,
      directorySensitivePayloadFree: true,
      requiredArtifactsPresent: true,
    },
    queryReady: manifest?.graphrag?.queryReady === true,
    qmdReadyState: manifest?.qmd?.qmdReadyState,
    graphRagReadyState: manifest?.graphrag?.graphRagReadyState,
    diagnostics: input.validation.diagnostics,
    manifestSha256: manifest?.checksums?.manifestSha256,
    packageGeneration: manifest?.identity?.packageGeneration,
    fileCount: manifest?.files?.length ?? 0,
    producerProvenanceStatus: input.gate.producer.producerProvenanceStatus,
    sourceClosure: sourceClosureSummary(input.gate),
    canonicalInput: input.gate.canonicalInput,
    artifactChecksums: input.gate.artifactChecksums,
  };
}

export function buildRuntimeGateState(input) {
  const validationOk = input.validation?.ok === true;
  const manifest = input.validation?.manifest ?? input.manifest;
  const queryReady = manifest?.graphrag?.queryReady === true;
  const validationDiagnostics = input.validation?.diagnostics ?? [];
  const gateDiagnostics = input.gate?.diagnostics ?? [];
  const status = validationOk
    ? queryReady ? "query_ready" : "visible_not_query_ready"
    : "quarantined";
  const diagnostics = [...new Set([
    ...validationDiagnostics,
    ...(!validationOk ? [] : queryReady ? [] : [
      "graph_visible_not_query_ready",
      ...(gateDiagnostics.length === 0
        ? ["graph_query_ready_gate_not_satisfied"]
        : gateDiagnostics),
    ]),
  ])];
  return {
    schemaVersion: "1.0.0",
    kind: "qmd_graphrag_book_hotplug_runtime_gate",
    bookId: input.bookId,
    checkedAt: input.checkedAt,
    packageGeneration: manifest?.identity?.packageGeneration,
    transitions: [
      {
        state: "copied",
        status: "observed",
        at: input.checkedAt,
      },
      {
        state: "candidate",
        status: input.candidateValidationOk === false ? "failed" : "passed",
        at: input.checkedAt,
      },
      {
        state: "validated",
        status: validationOk ? "passed" : "failed",
        at: input.checkedAt,
        diagnostics,
      },
      {
        state: "mounted",
        status: validationOk ? "allowed" : "blocked",
        at: input.checkedAt,
      },
      {
        state: status,
        status: validationOk ? "allowed" : "blocked",
        at: input.checkedAt,
        diagnostics,
      },
    ],
    currentState: status,
    queryReady,
    copyDistributionAllowed: validationOk,
    diagnostics,
    rollback: {
      projectionRollbackRequired: !validationOk,
      packageRootRollbackRequired: false,
      recoveryAction: validationOk
        ? "none"
        : "quarantine_package_until_validation_passes",
    },
  };
}

export function qualityGateFailureMessage(bookId, diagnostics) {
  return `BOOK_MANIFEST quality gate failed for ${bookId}: ${
    diagnostics.join(",") || "unknown_failure"
  }`;
}

export function validationFailureMessage(bookId, diagnostics) {
  return `BOOK_MANIFEST validation failed for ${bookId}: ${
    diagnostics.join(",") || "unknown_failure"
  }`;
}

function sourceClosureSummary(gate) {
  return {
    ok: gate.sourceClosure.ok,
    fileCount: gate.sourceClosure.fileCount,
    byteCount: gate.sourceClosure.byteCount,
  };
}
