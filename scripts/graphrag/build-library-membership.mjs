#!/usr/bin/env node

import { parseArgs } from "node:util";

import {
  resolveLibraryMembership,
  validateLibraryMembership,
} from "../../dist/graphrag/upper-index/library-membership.js";

function usage() {
  return [
    "Usage:",
    "  node scripts/graphrag/build-library-membership.mjs \\",
    "    --graph-vault graph_vault \\",
    "    --library-id <id> \\",
    "    --bookshelf-id <id> --bookshelf-id <id>",
    "",
    "Options:",
    "  --graph-vault <path>      graph_vault root, default graph_vault",
    "  --library-id <id>         catalog library id to materialize",
    "  --bookshelf-id <id>       repeat for each materialized bookshelf",
    "  --shelf-limit <n>         partition limit, default 32",
    "  --direct-book-limit <n>   direct book limit, default 0",
    "  --policy-kind <kind>      user_explicit | deterministic_rule | taxonomy",
    "  --decided-by <actor>      bounded actor id, default local_cli_user",
  ].join("\n");
}

function listOption(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function numberOption(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative integer, got ${value}`);
  }
  return parsed;
}

async function main() {
  const parsed = parseArgs({
    options: {
      "graph-vault": { type: "string", default: "graph_vault" },
      "library-id": { type: "string" },
      "bookshelf-id": { type: "string", multiple: true },
      "shelf-limit": { type: "string" },
      "direct-book-limit": { type: "string" },
      "policy-kind": { type: "string", default: "user_explicit" },
      "decided-by": { type: "string", default: "local_cli_user" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(usage());
    return;
  }
  const libraryId = parsed.values["library-id"];
  const bookshelfIds = listOption(parsed.values["bookshelf-id"]);
  if (libraryId == null || bookshelfIds.length === 0) {
    throw new Error(usage());
  }

  const result = await resolveLibraryMembership({
    graphVault: parsed.values["graph-vault"],
    libraryId,
    bookshelfIds,
    shelfLimit: numberOption(parsed.values["shelf-limit"], 32),
    directBookLimit: numberOption(parsed.values["direct-book-limit"], 0),
    policy: {
      sourceKind: parsed.values["policy-kind"],
      decidedBy: parsed.values["decided-by"],
    },
  });
  const validation = await validateLibraryMembership({
    graphVault: parsed.values["graph-vault"],
    libraryId,
  });
  if (!validation.ok) process.exitCode = 1;
  console.log(JSON.stringify({
    ok: validation.ok,
    libraryId: result.libraryId,
    generation: result.generation,
    bookshelfCount: result.bookshelfCount,
    directBookCount: result.directBookCount,
    root: result.root,
    readyState: result.qualityGate.readyState,
    queryReady: result.qualityGate.queryReady,
    diagnostics: validation.diagnostics,
  }, null, 2));
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
});
