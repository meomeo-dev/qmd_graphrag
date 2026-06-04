#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  buildBookHotplugPackage,
  validateBookHotplugPackage,
} from "./book-hotplug-package.mjs";
import {
  validateHotplugPackagePublishCandidate,
} from "./book-hotplug-publish-gate.mjs";
import {
  writeHotplugJsonWithSidecars,
} from "./book-hotplug-json-sidecars.mjs";
import {
  removeHotplugPublishMarkerForBookRoot,
} from "./book-hotplug-publish-marker.mjs";
import {
  buildPostPublishQualityGate,
  buildPrePublishQualityGateFailure,
  buildRuntimeGateState,
  graphRagNotQueryReadyFromGate,
  hotplugQualityGatePathForBookRoot,
  hotplugRuntimeGatePathForBookRoot,
  prePublishHotplugQualityGate,
  qualityGateFailureMessage,
  validationFailureMessage,
} from "./book-hotplug-quality-gate.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

function now() {
  return new Date().toISOString();
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required argument: --${name}`);
  }
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function existingPackageGeneration(bookRoot) {
  const path = join(bookRoot, "BOOK_MANIFEST.json");
  if (!existsSync(path)) return undefined;
  const value = readJson(path)?.identity?.packageGeneration;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sourceRelativePathForBook(bookRoot) {
  const qmdManifestPath = join(bookRoot, "qmd", "qmd_build_manifest.json");
  if (existsSync(qmdManifestPath)) {
    const value = readJson(qmdManifestPath)?.sourceRelativePath;
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error(`source relative path not found for ${bookRoot}`);
}

function sourceHashForBook(bookRoot) {
  const qmdManifestPath = join(bookRoot, "qmd", "qmd_build_manifest.json");
  if (existsSync(qmdManifestPath)) {
    const value = readJson(qmdManifestPath)?.sourceHash;
    if (typeof value === "string" && value.length > 0) return value;
  }
  throw new Error(`source hash not found for ${bookRoot}`);
}

function writeJsonWithSidecars(path, value) {
  return writeHotplugJsonWithSidecars(path, value, {
    rootPath: root,
    runnerSessionId: "publish-hotplug-book-package",
    committedAt: now(),
  });
}

function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value == null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, withoutUndefined(item)]),
  );
}

function publishBookPackage(input) {
  const bookRoot = join(input.stateRoot, "books", input.bookId);
  const gate = prePublishHotplugQualityGate({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
  });
  const qualityGatePath = hotplugQualityGatePathForBookRoot(bookRoot);
  const runtimeGatePath = hotplugRuntimeGatePathForBookRoot(bookRoot);
  if (!gate.mayGenerateBookManifest) {
    const qualityGate = buildPrePublishQualityGateFailure({
      bookId: input.bookId,
      gate,
      checkedAt: now(),
    });
    writeJsonWithSidecars(qualityGatePath, qualityGate);
    throw new Error(qualityGateFailureMessage(input.bookId, gate.diagnostics));
  }

  const { manifest, publishReady } = buildBookHotplugPackage({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash: sourceHashForBook(bookRoot),
    sourceRelativePath: sourceRelativePathForBook(bookRoot),
    forceGraphRagNotQueryReady: graphRagNotQueryReadyFromGate(gate),
    packageGeneration: existingPackageGeneration(bookRoot),
    now,
    toolVersion: "publish-hotplug-book-package-v1",
  });
  const parsedManifest = withoutUndefined(manifest);
  const parsedPublishReady = withoutUndefined(publishReady);
  const candidateValidation = validateHotplugPackagePublishCandidate({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    manifest: parsedManifest,
    publishReady: parsedPublishReady,
  });
  if (!candidateValidation.ok) {
    const qualityGate = buildPostPublishQualityGate({
      bookId: input.bookId,
      gate,
      validation: candidateValidation,
      manifest: parsedManifest,
      checkedAt: now(),
      phase: "pre_live_publish_package_validation",
    });
    writeJsonWithSidecars(qualityGatePath, qualityGate);
    writeJsonWithSidecars(
      runtimeGatePath,
      buildRuntimeGateState({
        bookId: input.bookId,
        gate,
        validation: candidateValidation,
        manifest: parsedManifest,
        checkedAt: now(),
        candidateValidationOk: false,
      }),
    );
    throw new Error(
      validationFailureMessage(input.bookId, candidateValidation.diagnostics),
    );
  }

  removeHotplugPublishMarkerForBookRoot(bookRoot);
  writeJsonWithSidecars(join(bookRoot, "BOOK_MANIFEST.json"), parsedManifest);
  const qualityGate = buildPostPublishQualityGate({
    bookId: input.bookId,
    gate,
    validation: candidateValidation,
    manifest: parsedManifest,
    checkedAt: now(),
  });
  writeJsonWithSidecars(qualityGatePath, qualityGate);
  writeJsonWithSidecars(
    runtimeGatePath,
    buildRuntimeGateState({
      bookId: input.bookId,
      gate,
      validation: candidateValidation,
      manifest: parsedManifest,
      checkedAt: now(),
      candidateValidationOk: true,
    }),
  );
  writeJsonWithSidecars(join(bookRoot, "PUBLISH_READY.json"), parsedPublishReady);
  const liveValidation = validateBookHotplugPackage({ bookRoot });
  if (!liveValidation.ok) {
    removeHotplugPublishMarkerForBookRoot(bookRoot);
    throw new Error(
      validationFailureMessage(input.bookId, liveValidation.diagnostics),
    );
  }
  return {
    bookId: input.bookId,
    manifestPath: join(bookRoot, "BOOK_MANIFEST.json"),
    publishReadyPath: join(bookRoot, "PUBLISH_READY.json"),
    qualityGatePath,
    fileCount: parsedManifest.files?.length ?? 0,
    copyDistributionAllowed: qualityGate.copyDistributionAllowed,
    graphRagReadyState: qualityGate.graphRagReadyState,
  };
}

const { values } = parseArgs({
  options: {
    "state-root": { type: "string", default: join(root, "graph_vault") },
    "book-id": { type: "string" },
  },
});

const result = publishBookPackage({
  stateRoot: resolve(String(values["state-root"])),
  bookId: required(values["book-id"], "book-id"),
});
console.log(JSON.stringify(result, null, 2));
