import { describe, expect, test } from "vitest";

import {
  normalizeDurableTargetForMapping as normalizeRunnerTarget,
} from "../scripts/graphrag/durable-target-normalizer.mjs";
import {
  normalizeDurableTargetForMapping,
} from "../src/job-state/durable-target-normalizer.js";

describe("durable target normalization", () => {
  test("keeps primary targets unchanged", () => {
    const target = "graph_vault/catalog/cost-accounting.jsonl";

    expect(normalizeDurableTargetForMapping(target)).toEqual({
      targetLocator: target,
      primaryTargetLocator: target,
      isAuxiliary: false,
      auxiliaryTargetLocator: undefined,
      auxiliarySidecarKind: undefined,
      sidecarTargetLocator: undefined,
      sidecarKind: undefined,
    });
  });

  test("maps JSONL temp owner sidecars back to their primary target", () => {
    const target =
      "graph_vault/catalog/cost-accounting.jsonl.tmp-pid-now-id.owner.json";

    expect(normalizeDurableTargetForMapping(target)).toMatchObject({
      targetLocator: target,
      primaryTargetLocator: "graph_vault/catalog/cost-accounting.jsonl",
      isAuxiliary: true,
      auxiliaryTargetLocator: target,
      auxiliarySidecarKind: "temp_owner",
    });
  });

  test("maps checksum temp owners through the checksum sidecar to primary", () => {
    const target =
      "graph_vault/catalog/books.yaml.sha256.tmp-pid-now-id.owner.json";

    expect(normalizeDurableTargetForMapping(target)).toMatchObject({
      targetLocator: target,
      primaryTargetLocator: "graph_vault/catalog/books.yaml",
      isAuxiliary: true,
      auxiliaryTargetLocator: target,
      auxiliarySidecarKind: "temp_owner",
      sidecarTargetLocator: "graph_vault/catalog/books.yaml.sha256",
      sidecarKind: "checksum",
    });
  });

  test("maps checksum meta temp owners through the meta sidecar to primary", () => {
    const target =
      "graph_vault/catalog/books.yaml.sha256.meta.json.tmp-pid.owner.json";

    expect(normalizeDurableTargetForMapping(target)).toMatchObject({
      primaryTargetLocator: "graph_vault/catalog/books.yaml",
      auxiliarySidecarKind: "temp_owner",
      sidecarTargetLocator: "graph_vault/catalog/books.yaml.sha256.meta.json",
      sidecarKind: "checksum_meta",
    });
  });

  test("maps corrupt quarantine targets back to their primary target", () => {
    const target = "graph_vault/catalog/cost-accounting.jsonl.corrupt-123-456";

    expect(normalizeDurableTargetForMapping(target)).toMatchObject({
      targetLocator: target,
      primaryTargetLocator: "graph_vault/catalog/cost-accounting.jsonl",
      auxiliaryTargetLocator: target,
      auxiliarySidecarKind: "corrupt_quarantine",
      isAuxiliary: true,
    });
  });

  test("preserves unknown primary identity while stripping auxiliary suffixes", () => {
    const target = "graph_vault/catalog/unknown.jsonl.tmp-pid.owner.json";

    expect(normalizeDurableTargetForMapping(target)).toMatchObject({
      targetLocator: target,
      primaryTargetLocator: "graph_vault/catalog/unknown.jsonl",
      auxiliaryTargetLocator: target,
      auxiliarySidecarKind: "temp_owner",
      isAuxiliary: true,
    });
  });

  test("keeps runner and shared store normalization in parity", () => {
    const targets = [
      "graph_vault/catalog/cost-accounting.jsonl",
      "graph_vault/catalog/cost-accounting.jsonl.tmp-pid.owner.json",
      "graph_vault/catalog/cost-accounting.jsonl.corrupt-123",
      "graph_vault/catalog/books.yaml.sha256",
      "graph_vault/catalog/books.yaml.sha256.tmp-pid.owner.json",
      "graph_vault/catalog/books.yaml.sha256.meta.json",
      "graph_vault/catalog/books.yaml.sha256.meta.json.tmp-pid.owner.json",
      "graph_vault/catalog/books.yaml.lock",
    ];

    for (const target of targets) {
      expect(normalizeRunnerTarget(target)).toEqual(
        normalizeDurableTargetForMapping(target),
      );
    }
  });
});
