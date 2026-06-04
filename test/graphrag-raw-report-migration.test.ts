import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  migrateBookScopedRawReports,
  migrateGraphVaultRawReports,
} from "../scripts/graphrag/raw-report-migration.mjs";
import {
  mkProjectTmpDir,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG raw report migration", () => {
  test("migrates only the target book before package publication", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-raw-report-book-scope-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      const bookA = "book-a";
      const bookB = "book-b";
      await mkdir(
        join(stateRoot, "books", bookA, "graphrag", "output", "reports"),
        { recursive: true },
      );
      await mkdir(
        join(stateRoot, "books", bookB, "graphrag", "output", "reports"),
        { recursive: true },
      );
      await writeFile(
        join(
          stateRoot,
          "books",
          bookA,
          "graphrag",
          "output",
          "reports",
          "query.log",
        ),
        "book-a secret-token\n",
        "utf8",
      );
      await writeFile(
        join(
          stateRoot,
          "books",
          bookB,
          "graphrag",
          "output",
          "reports",
          "query.log",
        ),
        "book-b secret-token\n",
        "utf8",
      );
      const events: unknown[] = [];

      migrateBookScopedRawReports({
        stateRoot,
        logRoot,
        bookId: bookA,
        nowMs: () => 12345,
        redactLog: (text: string) => text.replaceAll("secret-token", "[REDACTED]"),
        emitEvent: (event: unknown) => events.push(event),
      });

      expect(existsSync(join(
        stateRoot,
        "books",
        bookA,
        "graphrag",
        "output",
        "reports",
        "query.log",
      ))).toBe(false);
      expect(existsSync(join(
        stateRoot,
        "books",
        bookB,
        "graphrag",
        "output",
        "reports",
        "query.log",
      ))).toBe(true);
      const movedNames = readdirSync(join(logRoot, "graph_vault_reports"));
      expect(movedNames).toEqual([
        "12345-book-a-graphrag-output-reports-query.log",
      ]);
      const movedText = readFileSync(
        join(logRoot, "graph_vault_reports", movedNames[0]),
        "utf8",
      );
      expect(movedText).toContain("[REDACTED]");
      expect(movedText).not.toContain("secret-token");
      expect(events).toEqual([
        expect.objectContaining({
          event: "raw_log_migrated",
          metadata: expect.objectContaining({
            sourceLocator:
              "graph_vault/books/book-a/graphrag/output/reports/query.log",
            targetFileName:
              "12345-book-a-graphrag-output-reports-query.log",
          }),
        }),
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("keeps same-name book report logs distinct in global migration", async () => {
    const tmpRoot = await mkProjectTmpDir("qmd-raw-report-global-scope-");
    try {
      const stateRoot = join(tmpRoot, "graph_vault");
      const logRoot = join(tmpRoot, "logs");
      for (const bookId of ["book-a", "book-b"]) {
        await mkdir(
          join(stateRoot, "books", bookId, "graphrag", "output", "reports"),
          { recursive: true },
        );
        await writeFile(
          join(
            stateRoot,
            "books",
            bookId,
            "graphrag",
            "output",
            "reports",
            "query.log",
          ),
          `${bookId} log\n`,
          "utf8",
        );
      }

      migrateGraphVaultRawReports({
        stateRoot,
        logRoot,
        items: [{ bookId: "book-a" }, { bookId: "book-b" }],
        nowMs: () => 67890,
      });

      expect(readdirSync(join(logRoot, "graph_vault_reports")).sort())
        .toEqual([
          "67890-book-a-graphrag-output-reports-query.log",
          "67890-book-b-graphrag-output-reports-query.log",
        ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
