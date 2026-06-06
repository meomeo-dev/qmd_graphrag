#!/usr/bin/env node

import { parseArgs } from "node:util";

import {
  buildBookshelfGraph,
  validateBookshelfGraph,
} from "../../dist/graphrag/upper-index/bookshelf-graph.js";

function usage() {
  return [
    "Usage:",
    "  node scripts/graphrag/build-bookshelf-graph.mjs \\",
    "    --graph-vault graph_vault \\",
    "    --bookshelf-id <id>",
    "",
    "Options:",
    "  --graph-vault <path>        graph_vault root, default graph_vault",
    "  --bookshelf-id <id>         materialized bookshelf id",
    "  --python-bin <path>         python executable, default python3",
    "  --max-reports-per-book <n>  bounded source reports per member, default 8",
    "  --max-semantic-units <n>    fixed query candidate budget, default 32",
    "  --max-edges <n>             upper semantic edge cap, default 96",
  ].join("\n");
}

function numberOption(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got ${value}`);
  }
  return parsed;
}

async function main() {
  const parsed = parseArgs({
    options: {
      "graph-vault": { type: "string", default: "graph_vault" },
      "bookshelf-id": { type: "string" },
      "python-bin": { type: "string", default: "python3" },
      "max-reports-per-book": { type: "string" },
      "max-semantic-units": { type: "string" },
      "max-edges": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(usage());
    return;
  }
  const bookshelfId = parsed.values["bookshelf-id"];
  if (bookshelfId == null) throw new Error(usage());

  const result = await buildBookshelfGraph({
    graphVault: parsed.values["graph-vault"],
    bookshelfId,
    pythonBin: parsed.values["python-bin"],
    maxReportsPerBook: numberOption(parsed.values["max-reports-per-book"], 8),
    maxSemanticUnits: numberOption(parsed.values["max-semantic-units"], 32),
    maxEdges: numberOption(parsed.values["max-edges"], 96),
  });
  const validation = await validateBookshelfGraph({
    graphVault: parsed.values["graph-vault"],
    bookshelfId,
    pythonBin: parsed.values["python-bin"],
  });
  if (!validation.ok) process.exitCode = 1;
  console.log(JSON.stringify({
    ok: validation.ok,
    bookshelfId: result.bookshelfId,
    generation: result.generation,
    root: result.root,
    readyState: result.qualityGate.readyState,
    queryReady: result.qualityGate.queryReady,
    semanticUnitCount: validation.semanticUnitCount,
    evidenceMapCount: validation.evidenceMapCount,
    diagnostics: validation.diagnostics,
  }, null, 2));
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
});
