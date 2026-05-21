import {
  DspyQueryPromptOptimizationRequestSchema,
  DspyQueryPromptOptimizationResponseSchema,
} from "../contracts/dspy.js";
import type {
  DspyQueryPromptOptimizationRequest,
  DspyQueryPromptOptimizationResponse,
} from "../contracts/dspy.js";
import { callPythonBridge } from "./python-bridge.js";

export async function optimizeQueryPrompt(
  request: DspyQueryPromptOptimizationRequest,
): Promise<DspyQueryPromptOptimizationResponse> {
  const parsed = DspyQueryPromptOptimizationRequestSchema.parse(request);

  return callPythonBridge({
    command: "dspy_optimize_query_prompt",
    pythonBin: parsed.environment?.pythonBin,
    workingDirectory: parsed.environment?.workingDirectory,
    request: parsed,
    responseSchema: DspyQueryPromptOptimizationResponseSchema,
  });
}
