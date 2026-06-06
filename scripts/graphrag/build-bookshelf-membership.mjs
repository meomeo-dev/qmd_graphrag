#!/usr/bin/env node

import { parseArgs } from "node:util";

import {
  resolveBookshelfMembership,
  validateBookshelfMembership,
} from "../../dist/graphrag/upper-index/bookshelf-membership.js";

function usage() {
  return [
    "Usage:",
    "  node scripts/graphrag/build-bookshelf-membership.mjs \\",
    "    --graph-vault graph_vault \\",
    "    --bookshelf-id <id> \\",
    "    --book-id <bookId> --book-id <bookId> --book-id <bookId>",
    "",
    "Options:",
    "  --graph-vault <path>     graph_vault root, default graph_vault",
    "  --bookshelf-id <id>      catalog bookshelf id to materialize",
    "  --book-id <bookId>       repeat for each member book package",
    "  --policy-kind <kind>     user_explicit | deterministic_rule | taxonomy",
    "  --decided-by <actor>     bounded actor id, default local_cli_user",
  ].join("\n");
}

function listOption(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

async function main() {
  const parsed = parseArgs({
    options: {
      "graph-vault": { type: "string", default: "graph_vault" },
      "bookshelf-id": { type: "string" },
      "book-id": { type: "string", multiple: true },
      "policy-kind": { type: "string", default: "user_explicit" },
      "decided-by": { type: "string", default: "local_cli_user" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(usage());
    return;
  }
  const bookshelfId = parsed.values["bookshelf-id"];
  const bookIds = listOption(parsed.values["book-id"]);
  if (bookshelfId == null || bookIds.length === 0) {
    throw new Error(usage());
  }

  const result = await resolveBookshelfMembership({
    graphVault: parsed.values["graph-vault"],
    bookshelfId,
    bookIds,
    policy: {
      sourceKind: parsed.values["policy-kind"],
      decidedBy: parsed.values["decided-by"],
    },
  });
  const validation = await validateBookshelfMembership({
    graphVault: parsed.values["graph-vault"],
    bookshelfId,
  });
  if (!validation.ok) {
    process.exitCode = 1;
  }
  console.log(JSON.stringify({
    ok: validation.ok,
    bookshelfId: result.bookshelfId,
    generation: result.generation,
    memberCount: result.memberCount,
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
