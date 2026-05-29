import {
  existsSync,
  readFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SchemaVersion } from "../contracts/common.js";
import {
  ProviderCostAccountingSchema,
  type ProviderCostAccounting,
} from "../contracts/provider.js";
import {
  writeOpaqueFileDurableSync,
  writeQuarantineFileDurableSync,
} from "../job-state/durable-state-store.js";
import { sanitizeVaultMetadata } from "../vault/metadata.js";

export function buildProviderCostAccounting(
  input: Omit<ProviderCostAccounting, "schemaVersion">,
): ProviderCostAccounting {
  return ProviderCostAccountingSchema.parse({
    schemaVersion: SchemaVersion,
    ...input,
    metadata: sanitizeVaultMetadata(input.metadata),
  });
}

export async function appendProviderCostAccounting(
  graphVault: string,
  record: ProviderCostAccounting,
): Promise<void> {
  const parsed = ProviderCostAccountingSchema.parse({
    ...record,
    metadata: sanitizeVaultMetadata(record.metadata),
  });
  const path = join(resolve(graphVault), "catalog", "cost-accounting.jsonl");
  await mkdir(dirname(path), { recursive: true });
  const current = reconcileProviderCostAccounting(path);
  writeOpaqueFileDurableSync(path, `${current}${JSON.stringify(parsed)}\n`);
}

function reconcileProviderCostAccounting(path: string): string {
  if (!existsSync(path)) return "";
  const raw = readFileSync(path, "utf8");
  if (raw.length === 0) return "";

  const validLines: string[] = [];
  const lines = raw.split("\n");
  let corruptTail = false;
  for (const [index, line] of lines.entries()) {
    if (index === lines.length - 1 && line === "") continue;
    if (line.trim() === "") continue;
    try {
      const parsed = ProviderCostAccountingSchema.parse(JSON.parse(line));
      validLines.push(JSON.stringify(parsed));
    } catch {
      corruptTail = true;
      break;
    }
  }
  if (!corruptTail) return raw.endsWith("\n") ? raw : `${raw}\n`;

  const quarantinePath = `${path}.corrupt-${Date.now()}-${process.pid}`;
  writeQuarantineFileDurableSync(quarantinePath, raw);
  return validLines.length === 0 ? "" : `${validLines.join("\n")}\n`;
}
