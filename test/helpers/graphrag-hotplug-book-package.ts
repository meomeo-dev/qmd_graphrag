import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildBookHotplugPackage,
  validateBookHotplugPackage,
} from "../../scripts/graphrag/book-hotplug-package.mjs";
import {
  buildPostPublishQualityGate,
  buildRuntimeGateState,
  prePublishHotplugQualityGate,
} from "../../scripts/graphrag/book-hotplug-quality-gate.mjs";
import {
  writeBookScopedQmdIndexFixture,
  writeDurableJsonFixture,
  writeProviderAuthReopenGraphFixture,
} from "./graphrag-runner-harness.js";

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function writeReadyHotplugBook(input: {
  stateRoot: string;
  bookId: string;
  title: string;
}): Promise<void> {
  const sourceText = `epub:${input.title}`;
  const normalizedText = `# ${input.title}\n\nArchitecture and software design.\n`;
  const sourceHash = sha256Text(sourceText);
  const normalizedHash = sha256Text(normalizedText);
  const bookRoot = join(input.stateRoot, "books", input.bookId);
  await writeProviderAuthReopenGraphFixture({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    contentHash: normalizedHash,
  });
  await mkdir(join(bookRoot, "input"), { recursive: true });
  await mkdir(join(bookRoot, "qmd"), { recursive: true });
  await mkdir(join(bookRoot, "source"), { recursive: true });
  await writeFile(join(bookRoot, "input", "book.md"), normalizedText, "utf8");
  await writeFile(join(bookRoot, "source", "source.epub"), sourceText, "utf8");
  await writeDurableJsonFixture(join(bookRoot, "qmd", "qmd_build_manifest.json"), {
    schemaVersion: "1.0.0",
    kind: "qmd_build_manifest",
    itemId: `item-${input.bookId}`,
    runId: `run-${input.bookId}`,
    bookId: input.bookId,
    sourceName: `${input.title}.epub`,
    sourceRelativePath: `books/${input.bookId}/source/source.epub`,
    sourceHash,
    canonicalBookNormalizedPath: `books/${input.bookId}/input/book.md`,
    normalizedContentHash: normalizedHash,
    configHash: "config-hash",
    normalizationPolicyVersion: "graphrag-normalized-markdown-v1",
  });
  await writeDurableJsonFixture(
    join(bookRoot, "graphrag", "output", "qmd_graph_text_unit_identity.json"),
    {
      schemaVersion: "1.0.0",
      bookId: input.bookId,
      sourceId: `sha256:${sourceHash}`,
      sourceHash,
      documentId: `doc-${sourceHash.slice(0, 12)}`,
      contentHash: normalizedHash,
      normalizedPath: `books/${input.bookId}/input/book.md`,
      graphDocumentId: `graph-doc-${input.bookId}`,
      graphTextUnitIds: [`tu-${input.bookId}`],
      metadata: {
        title: input.title,
        identityProvenance: "package_source",
        publishAllowed: true,
      },
    },
  );
  await writeBookScopedQmdIndexFixture({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    normalizedPath: join(bookRoot, "input", "book.md"),
    normalizedContentHash: normalizedHash,
  });
  const built = buildBookHotplugPackage({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
    sourceHash,
    sourceRelativePath: `books/${input.bookId}/source/source.epub`,
    now: () => "2026-06-06T00:00:00.000Z",
    toolVersion: "test",
  });
  await writeDurableJsonFixture(join(bookRoot, "BOOK_MANIFEST.json"), built.manifest);
  await writeDurableJsonFixture(join(bookRoot, "PUBLISH_READY.json"), built.publishReady);
  const validation = validateBookHotplugPackage({ bookRoot });
  if (!validation.ok) {
    throw new Error(`fixture_package_invalid:${validation.diagnostics.join(",")}`);
  }
  const gate = prePublishHotplugQualityGate({
    stateRoot: input.stateRoot,
    bookId: input.bookId,
  });
  await writeDurableJsonFixture(
    join(bookRoot, "state", "hotplug-quality-gate.json"),
    buildPostPublishQualityGate({
      bookId: input.bookId,
      gate,
      validation,
      manifest: built.manifest,
      checkedAt: "2026-06-06T00:00:01.000Z",
    }),
  );
  await writeDurableJsonFixture(
    join(bookRoot, "state", "hotplug-runtime-gate.json"),
    buildRuntimeGateState({
      bookId: input.bookId,
      gate,
      validation,
      manifest: built.manifest,
      checkedAt: "2026-06-06T00:00:01.000Z",
      candidateValidationOk: true,
    }),
  );
}
