#!/usr/bin/env node

import { parseArgs } from "node:util";

import {
  buildLibraryGraph,
  validateLibraryGraph,
} from "../../dist/graphrag/upper-index/library-graph.js";

function usage() {
  return [
    "Usage:",
    "  node scripts/graphrag/build-library-graph.mjs \\",
    "    --graph-vault graph_vault \\",
    "    --library-id <id>",
    "",
    "Options:",
    "  --graph-vault <path>         graph_vault root, default graph_vault",
    "  --library-id <id>            materialized library id",
    "  --python-bin <path>          python executable, default python3",
    "  --max-reports-per-shelf <n>  bounded source reports per shelf, default 8",
    "  --max-semantic-units <n>     fixed query candidate budget, default 32",
    "  --max-edges <n>              upper semantic edge cap, default 96",
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
      "library-id": { type: "string" },
      "python-bin": { type: "string", default: "python3" },
      "max-reports-per-shelf": { type: "string" },
      "max-semantic-units": { type: "string" },
      "max-edges": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(usage());
    return;
  }
  const libraryId = parsed.values["library-id"];
  if (libraryId == null) throw new Error(usage());

  const result = await buildLibraryGraph({
    graphVault: parsed.values["graph-vault"],
    libraryId,
    pythonBin: parsed.values["python-bin"],
    maxReportsPerShelf: numberOption(parsed.values["max-reports-per-shelf"], 8),
    maxSemanticUnits: numberOption(parsed.values["max-semantic-units"], 32),
    maxEdges: numberOption(parsed.values["max-edges"], 96),
  });
  const validation = await validateLibraryGraph({
    graphVault: parsed.values["graph-vault"],
    libraryId,
    pythonBin: parsed.values["python-bin"],
  });
  if (!validation.ok) process.exitCode = 1;
  console.log(JSON.stringify({
    ok: validation.ok,
    libraryId: result.libraryId,
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
