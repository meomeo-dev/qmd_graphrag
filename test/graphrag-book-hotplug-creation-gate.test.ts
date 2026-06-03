import { existsSync, readFileSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";

import { describe, expect, test } from "vitest";

import {
  validateBookHotplugPackage,
} from "../scripts/graphrag/book-hotplug-package.mjs";
import {
  runParallelRunnerFixture,
} from "./helpers/graphrag-runner-harness.ts";

function expectPackageFileWithSidecars(bookRoot: string, path: string): void {
  for (const suffix of ["", ".sha256", ".sha256.meta.json"]) {
    expect(existsSync(join(bookRoot, `${path}${suffix}`))).toBe(true);
  }
}

describe("GraphRAG hotplug creation quality gate", () => {
  test("book creation publishes only after package validation gates pass",
    async () => {
      const fixture = await runParallelRunnerFixture({
        concurrency: 1,
        runId: "hotplug-creation-quality-gate-fixture",
        bookCount: 1,
      });
      try {
        expect(
          fixture.result,
          fixture.result.stderr || fixture.result.stdout,
        ).toMatchObject({
          exitCode: 0,
          stderr: "",
        });

        const event = fixture.events.find((item) =>
          item.event === "book_hotplug_manifest_written"
        );
        expect(event).toBeDefined();
        const bookId = String(event?.metadata?.bookId);
        const bookRoot = join(fixture.stateRoot, "books", bookId);

        expectPackageFileWithSidecars(bookRoot, "BOOK_MANIFEST.json");
        expectPackageFileWithSidecars(bookRoot, "PUBLISH_READY.json");
        expectPackageFileWithSidecars(
          bookRoot,
          join("graphrag", "output", "qmd_graph_text_unit_identity.json"),
        );
        expectPackageFileWithSidecars(
          bookRoot,
          join("state", "hotplug-quality-gate.json"),
        );
        expectPackageFileWithSidecars(
          bookRoot,
          join("state", "hotplug-runtime-gate.json"),
        );

        const validation = validateBookHotplugPackage({ bookRoot });
        expect(validation.diagnostics).toEqual([]);
        expect(validation.ok).toBe(true);

        const qualityGate = JSON.parse(readFileSync(
          join(bookRoot, "state", "hotplug-quality-gate.json"),
          "utf8",
        ));
        expect(qualityGate).toMatchObject({
          bookId,
          status: "passed",
          copyDistributionAllowed: true,
          packageCopyContract: {
            manifestValid: true,
            publishMarkerValid: true,
            directorySensitivePayloadFree: true,
            requiredArtifactsPresent: true,
          },
        });

        const runtimeGate = JSON.parse(readFileSync(
          join(bookRoot, "state", "hotplug-runtime-gate.json"),
          "utf8",
        ));
        expect(runtimeGate).toMatchObject({
          bookId,
          copyDistributionAllowed: true,
          currentState: "visible_not_query_ready",
          queryReady: false,
        });
        expect(runtimeGate.diagnostics).toContain(
          "graph_visible_not_query_ready",
        );

        const graphIdentity = JSON.parse(readFileSync(
          join(bookRoot, "graphrag", "output", "qmd_graph_text_unit_identity.json"),
          "utf8",
        ));
        expect(graphIdentity.normalizedPath).toMatch(
          new RegExp(`^books/${bookId}/input/[^/]+\\.md$`),
        );

        const manifest = validation.manifest;
        expect(
          manifest.files.some((entry: { path?: string }) =>
            entry.path === "state/hotplug-quality-gate.json" ||
            entry.path === "state/hotplug-runtime-gate.json"
          ),
        ).toBe(false);
      } finally {
        if (process.env.QMD_GRAPHRAG_KEEP_HOTPLUG_TEST_TMP !== "1") {
          await rm(fixture.tmpRoot, { recursive: true, force: true });
        }
      }
    },
    240000);
});
