import { z } from "zod";

export const SchemaVersion = "1.0.0" as const;

export const JsonPrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const QueryKindSchema = z.enum(["lex", "vec", "hyde"]);

export const QueryExpansionItemSchema = z.object({
  type: QueryKindSchema,
  text: z.string().min(1),
});

export type QueryKind = z.infer<typeof QueryKindSchema>;
export type QueryExpansionItem = z.infer<typeof QueryExpansionItemSchema>;

export const BridgeEnvironmentSchema = z.object({
  pythonBin: z.string().min(1).optional(),
  graphragRepoPath: z.string().min(1).optional(),
  dspyRepoPath: z.string().min(1).optional(),
  workingDirectory: z.string().min(1).optional(),
});

export type BridgeEnvironment = z.infer<typeof BridgeEnvironmentSchema>;

export function buildEnvelopeSchema<const TKind extends string, TPayload extends z.ZodType>(
  kind: TKind,
  payload: TPayload,
) {
  return z.object({
    schemaVersion: z.literal(SchemaVersion),
    kind: z.literal(kind),
    payload,
  });
}

export const QueryExpansionItemEnvelopeSchema = buildEnvelopeSchema(
  "qmd.query_expansion.item",
  QueryExpansionItemSchema,
);
