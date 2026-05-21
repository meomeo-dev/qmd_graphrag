import {
  mkdir,
  mkdtemp,
  rename,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import YAML from "yaml";

import {
  FileBookJobStateRepository,
  SchemaVersion,
  buildBookId,
  buildBookIdFromSourceHash,
  createDeterministicHash,
  normalizeBookSlug,
} from "../src/index.js";

async function createFixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qmd-graphrag-book-state-"));
}

describe("FileBookJobStateRepository", () => {
  test("registers a book and persists catalog entry", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      expect(job.bookId).toContain("book");
      expect(job.sourcePath).toBe(sourcePath);
      expect(job.overallStatus).toBe("pending");

      const catalogRaw = await readFile(
        join(root, "graph_vault", "catalog", "books.yaml"),
        "utf8",
      );
      const catalog = YAML.parse(catalogRaw) as {
        schemaVersion: string;
        items: Array<{ bookId: string }>;
      };
      expect(catalog.schemaVersion).toBe(SchemaVersion);
      expect(catalog.items.map((item) => item.bookId)).toContain(job.bookId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps book identity stable across device paths for identical source content", async () => {
    const root = await createFixtureDir();
    try {
      const firstRepo = new FileBookJobStateRepository(join(root, "a", "graph_vault"));
      const secondRepo = new FileBookJobStateRepository(join(root, "b", "graph_vault"));
      const firstSourcePath = join(root, "a", "book.epub");
      const secondSourcePath = join(root, "b", "book.epub");
      await mkdir(join(root, "a"), { recursive: true });
      await mkdir(join(root, "b"), { recursive: true });
      await writeFile(firstSourcePath, "fixture epub content", "utf8");
      await writeFile(secondSourcePath, "fixture epub content", "utf8");

      const first = await firstRepo.registerBookSource({
        sourcePath: firstSourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const second = await secondRepo.registerBookSource({
        sourcePath: secondSourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      expect(second.bookId).toBe(first.bookId);
      expect(second.sourceHash).toBe(first.sourceHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("content-hash book identity differs from legacy path identity", async () => {
    const sourcePath = "/vault/input/book.epub";
    const sourceHash = "abcdef1234567890";

    expect(buildBookIdFromSourceHash(sourcePath, sourceHash)).toBe(
      "book-abcdef123456",
    );
    expect(buildBookId(sourcePath)).not.toBe("book-abcdef123456");
  });

  test("preserves dotted author initials when deriving a book slug", () => {
    const sourceName = "A Philosophy of Software Design (John K. Ousterhout).epub";

    expect(normalizeBookSlug(sourceName)).toBe(
      "a-philosophy-of-software-design-john-k-ousterhout",
    );
    expect(buildBookIdFromSourceHash(sourceName, "9f587b71073a0000")).toBe(
      "a-philosophy-of-software-design-john-k-ousterhout-9f587b71073a",
    );
  });

  test("stores a caller-provided vault-relative source path", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        canonicalSourcePath: "sources/book-123/source.epub",
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      expect(job.sourcePath).toBe("sources/book-123/source.epub");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tracks stage progress and computes resume plan from failure point", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      const ingestFp = createDeterministicHash(["book", "ingest", 1]);
      const normalizeFp = createDeterministicHash(["book", "normalize", 1]);
      const extractFp = createDeterministicHash(["book", "graph_extract", 1]);

      await repo.startStage({
        bookId: job.bookId,
        stage: "ingest",
        runId: "run-ingest-1",
        inputFingerprint: ingestFp,
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "ingest",
        runId: "run-ingest-1",
        inputFingerprint: ingestFp,
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "normalize",
        runId: "run-normalize-1",
        inputFingerprint: normalizeFp,
      });
      await repo.failStage({
        bookId: job.bookId,
        stage: "graph_extract",
        runId: "run-extract-1",
        inputFingerprint: extractFp,
        errorSummary: "gateway 502",
      });

      const plan = await repo.getResumePlan(job.bookId, {
        ingest: ingestFp,
        normalize: normalizeFp,
        graph_extract: extractFp,
      });

      expect(plan.nextStage).toBe("graph_extract");
      expect(plan.canQuery).toBe(false);
      expect(plan.completedStages).toEqual(["ingest", "normalize"]);
      expect(
        plan.stageStates.find((item) => item.stage === "graph_extract")?.reason,
      ).toBe("failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("marks downstream stages stale when upstream fingerprint changes", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      await repo.completeStage({
        bookId: job.bookId,
        stage: "ingest",
        runId: "run-ingest-1",
        inputFingerprint: "fp-ingest-v1",
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "normalize",
        runId: "run-normalize-1",
        inputFingerprint: "fp-normalize-v1",
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "graph_extract",
        runId: "run-extract-1",
        inputFingerprint: "fp-extract-v1",
      });

      const plan = await repo.getResumePlan(job.bookId, {
        ingest: "fp-ingest-v1",
        normalize: "fp-normalize-v2",
        graph_extract: "fp-extract-v1",
      });

      expect(plan.nextStage).toBe("normalize");
      expect(plan.staleStages).toContain("normalize");
      expect(plan.staleStages).toContain("graph_extract");
      expect(
        plan.stageStates.find((item) => item.stage === "normalize")?.reason,
      ).toBe("stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deduplicates stable artifacts across bootstrap runs", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      await writeFile(sourcePath, "fixture epub content", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      const artifactPath = join(root, "graph_vault", "input", "book.md");
      await mkdir(join(root, "graph_vault", "input"), { recursive: true });
      await writeFile(artifactPath, "# Book", "utf8");
      const first = await repo.recordArtifacts(job.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: artifactPath,
          contentHash: "content-hash-1",
          producerRunId: "bootstrap-1",
        },
      ]);
      const second = await repo.recordArtifacts(job.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: artifactPath,
          contentHash: "content-hash-1",
          producerRunId: "bootstrap-2",
        },
      ]);

      expect(second[0]?.artifactId).toBe(first[0]?.artifactId);
      expect(await repo.listArtifacts(job.bookId)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires checkpoint artifacts to exist before a stage is resumable", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      const artifactPath = join(root, "graph_vault", "input", "book.md");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await mkdir(join(root, "graph_vault", "input"), { recursive: true });
      await writeFile(artifactPath, "# Book", "utf8");

      const job = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });

      const [artifact] = await repo.recordArtifacts(job.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: artifactPath,
          contentHash: "content-hash-1",
          producerRunId: "run-normalize-1",
        },
      ]);
      await repo.completeStage({
        bookId: job.bookId,
        stage: "ingest",
        runId: "run-ingest-1",
        inputFingerprint: "fp-ingest-v1",
      });
      await repo.completeStage({
        bookId: job.bookId,
        stage: "normalize",
        runId: "run-normalize-1",
        inputFingerprint: "fp-normalize-v1",
        artifactIds: [artifact.artifactId],
      });

      await unlink(artifactPath);

      const plan = await repo.getResumePlan(
        job.bookId,
        {
          ingest: "fp-ingest-v1",
          normalize: "fp-normalize-v1",
        },
        { normalize: ["normalized_markdown"] },
      );

      const normalizeState = plan.stageStates.find(
        (item) => item.stage === "normalize",
      );
      expect(plan.nextStage).toBe("normalize");
      expect(normalizeState?.reason).toBe("artifact_missing");
      expect(normalizeState?.missingArtifactIds).toEqual([artifact.artifactId]);
      expect(normalizeState?.missingArtifactKinds).toEqual(["normalized_markdown"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates legacy path book state to portable content identity", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourcePath = join(root, "book.epub");
      const artifactPath = join(root, "graph_vault", "input", "book.md");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await mkdir(join(root, "graph_vault", "input"), { recursive: true });
      await writeFile(artifactPath, "# Book", "utf8");

      const stableJob = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const [stableArtifact] = await repo.recordArtifacts(stableJob.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: artifactPath,
          contentHash: "content-hash-1",
          producerRunId: "run-normalize-1",
        },
      ]);
      await repo.completeStage({
        bookId: stableJob.bookId,
        stage: "normalize",
        runId: "run-normalize-1",
        inputFingerprint: "fp-normalize-v1",
        artifactIds: [stableArtifact.artifactId],
      });

      const legacyBookId = buildBookId(sourcePath);
      await rename(
        join(root, "graph_vault", "books", stableJob.bookId),
        join(root, "graph_vault", "books", legacyBookId),
      );
      const legacyArtifacts = (await readFile(
        join(root, "graph_vault", "books", legacyBookId, "artifacts.yaml"),
        "utf8",
      )).split(stableJob.bookId).join(legacyBookId);
      await writeFile(
        join(root, "graph_vault", "books", legacyBookId, "artifacts.yaml"),
        legacyArtifacts,
        "utf8",
      );
      const legacyCheckpoints = (await readFile(
        join(root, "graph_vault", "books", legacyBookId, "checkpoints.yaml"),
        "utf8",
      )).split(stableJob.bookId).join(legacyBookId);
      await writeFile(
        join(root, "graph_vault", "books", legacyBookId, "checkpoints.yaml"),
        legacyCheckpoints,
        "utf8",
      );
      const legacyJob = (await readFile(
        join(root, "graph_vault", "books", legacyBookId, "job.yaml"),
        "utf8",
      )).split(stableJob.bookId).join(legacyBookId);
      await writeFile(
        join(root, "graph_vault", "books", legacyBookId, "job.yaml"),
        legacyJob,
        "utf8",
      );

      const migratedJob = await repo.registerBookSource({
        sourcePath,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const [migratedArtifact] = await repo.listArtifacts(migratedJob.bookId);
      const [migratedCheckpoint] = await repo.listStageCheckpoints(
        migratedJob.bookId,
      );

      expect(migratedJob.bookId).toBe(stableJob.bookId);
      expect(migratedArtifact?.bookId).toBe(stableJob.bookId);
      expect(migratedArtifact?.artifactId).toBe(stableArtifact.artifactId);
      expect(migratedCheckpoint?.bookId).toBe(stableJob.bookId);
      expect(migratedCheckpoint?.artifactIds).toEqual([stableArtifact.artifactId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates truncated dotted-name book state to full source identity", async () => {
    const root = await createFixtureDir();
    try {
      const repo = new FileBookJobStateRepository(join(root, "graph_vault"));
      const sourceName = "A Philosophy of Software Design (John K. Ousterhout).epub";
      const sourcePath = join(root, sourceName);
      const artifactPath = join(root, "graph_vault", "input", "book.md");
      await writeFile(sourcePath, "fixture epub content", "utf8");
      await mkdir(join(root, "graph_vault", "input"), { recursive: true });
      await writeFile(artifactPath, "# Book", "utf8");

      const stableJob = await repo.registerBookSource({
        sourcePath,
        sourceIdentityPath: sourceName,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const [stableArtifact] = await repo.recordArtifacts(stableJob.bookId, [
        {
          stage: "normalize",
          kind: "normalized_markdown",
          path: artifactPath,
          contentHash: "content-hash-1",
          producerRunId: "run-normalize-1",
        },
      ]);

      const truncatedBookId = buildBookIdFromSourceHash(
        "A Philosophy of Software Design (John K",
        stableJob.sourceHash,
      );
      await rename(
        join(root, "graph_vault", "books", stableJob.bookId),
        join(root, "graph_vault", "books", truncatedBookId),
      );
      for (const fileName of ["artifacts.yaml", "job.yaml"]) {
        const filePath = join(root, "graph_vault", "books", truncatedBookId, fileName);
        const raw = (await readFile(filePath, "utf8"))
          .split(stableJob.bookId)
          .join(truncatedBookId);
        await writeFile(filePath, raw, "utf8");
      }

      const migratedJob = await repo.registerBookSource({
        sourcePath,
        sourceIdentityPath: sourceName,
        configFingerprint: "cfg-1",
        promptFingerprint: "prompt-1",
        modelFingerprint: "model-1",
      });
      const [migratedArtifact] = await repo.listArtifacts(migratedJob.bookId);

      expect(migratedJob.bookId).toBe(stableJob.bookId);
      expect(migratedArtifact?.bookId).toBe(stableJob.bookId);
      expect(migratedArtifact?.artifactId).toBe(stableArtifact.artifactId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
