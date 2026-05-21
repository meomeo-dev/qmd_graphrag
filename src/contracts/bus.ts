import { z } from "zod";

import { DspyOptimizationEnvelopeSchema } from "./dspy.js";
import {
  GraphRagIndexEnvelopeSchema,
  GraphRagQueryEnvelopeSchema,
} from "./graphrag.js";

export const DataBusEnvelopeSchema = z.union([
  GraphRagQueryEnvelopeSchema,
  GraphRagIndexEnvelopeSchema,
  DspyOptimizationEnvelopeSchema,
]);

export type DataBusEnvelope = z.infer<typeof DataBusEnvelopeSchema>;

