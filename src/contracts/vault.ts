import { z } from "zod";

import {
  JsonValueSchema,
  SchemaVersion,
  buildEnvelopeSchema,
} from "./common.js";

export const VaultRestoreRequestSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  graphVault: z.string().min(1),
  targetIndexPath: z.string().min(1).optional(),
  mode: z.enum(["audit", "restore"]).default("audit"),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const VaultRestoreReportSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  graphVault: z.string().min(1),
  mode: z.enum(["audit", "restore"]),
  portable: z.boolean(),
  documentsPortable: z.boolean(),
  capabilitiesPortable: z.boolean(),
  sourceDocumentCount: z.number().int().nonnegative(),
  documentIdentityCount: z.number().int().nonnegative(),
  graphCapabilityCount: z.number().int().nonnegative(),
  restoredDocumentCount: z.number().int().nonnegative(),
  restoredCapabilityCount: z.number().int().nonnegative(),
  restoredCapabilityIds: z.array(z.string().min(1)),
  failedItems: z.array(z.object({
    itemId: z.string().min(1),
    stage: z.string().min(1),
    redactedMessage: z.string().min(1),
  })),
  missingRequiredPaths: z.array(z.string().min(1)),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export const VaultRestoreRequestEnvelopeSchema = buildEnvelopeSchema(
  "vault.restore_request",
  VaultRestoreRequestSchema,
);

export const VaultRestoreReportEnvelopeSchema = buildEnvelopeSchema(
  "vault.restore_report",
  VaultRestoreReportSchema,
);

export type VaultRestoreRequest = z.infer<typeof VaultRestoreRequestSchema>;
export type VaultRestoreReport = z.infer<typeof VaultRestoreReportSchema>;
