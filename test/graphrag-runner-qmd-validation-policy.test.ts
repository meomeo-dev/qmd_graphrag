import { describe, expect, test } from "vitest";
import {
  qmdIndexLockedCommandNamesFor,
  qmdIndexWriterCommandCheckNames,
  qmdMultiGetJsonArgsForNormalizedPath,
  qmdMultiGetMaxBytes,
  qmdValidationOutputMaxBufferBytes,
} from "../scripts/graphrag/qmd-validation-policy.mjs";
import {
  requiredBatchCommandCheckNames,
} from "./helpers/graphrag-runner-harness.ts";

describe("GraphRAG runner qmd validation policy", () => {
  test("only qmd validation writer commands hold qmd index writer lock", () => {
    const locked = qmdIndexLockedCommandNamesFor(requiredBatchCommandCheckNames);
    const readOnlyCommands = requiredBatchCommandCheckNames.filter((name) =>
      !qmdIndexWriterCommandCheckNames.includes(name)
    );

    expect([...locked].sort()).toEqual([...qmdIndexWriterCommandCheckNames].sort());
    expect(readOnlyCommands).toContain("qmd-multi-get-json");
    expect(readOnlyCommands.some((name) => locked.has(name))).toBe(false);
  });

  test("multi-get validation is scoped to current book and output bounded", () => {
    const args = qmdMultiGetJsonArgsForNormalizedPath(
      "/tmp/qmd/graph_vault/input/Clean Architecture.md",
    );

    expect(args).toEqual([
      "multi-get",
      "qmd://books/Clean Architecture.md",
      "-l",
      "1",
      "--max-bytes",
      qmdMultiGetMaxBytes,
      "--json",
    ]);
    expect(args).not.toContain("books/*.md");
    expect(qmdValidationOutputMaxBufferBytes).toBeLessThanOrEqual(1024 * 1024);
  });
});
