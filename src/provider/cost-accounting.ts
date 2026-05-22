import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SchemaVersion } from "../contracts/common.js";
import {
  ProviderCostAccountingSchema,
  type ProviderCostAccounting,
} from "../contracts/provider.js";
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
  await appendFile(path, `${JSON.stringify(parsed)}\n`, "utf8");
}
