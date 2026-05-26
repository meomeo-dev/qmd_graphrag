import type {
  DspyQueryPromptOptimizationRequest,
  DspyQueryPromptOptimizationResponse,
} from "./contracts/dspy.js";
import type {
  GraphRagIndexRequest,
  GraphRagIndexResponse,
  GraphRagQueryRequest,
  GraphRagQueryResponse,
} from "./contracts/graphrag.js";
import { optimizeQueryPrompt } from "./integrations/dspy.js";
import { runGraphRagIndex, runGraphRagQuery } from "./integrations/graphrag.js";
import type { GraphRagIndexRuntimeOptions } from "./integrations/graphrag.js";

export type QmdGraphRagRuntime = {
  graphIndex(
    request: GraphRagIndexRequest,
    runtimeOptions?: GraphRagIndexRuntimeOptions,
  ): Promise<GraphRagIndexResponse>;
  graphQuery(
    request: GraphRagQueryRequest,
  ): Promise<GraphRagQueryResponse>;
  optimizeQueryPrompt(
    request: DspyQueryPromptOptimizationRequest,
  ): Promise<DspyQueryPromptOptimizationResponse>;
};

export function createQmdGraphRagRuntime(): QmdGraphRagRuntime {
  return {
    graphIndex: runGraphRagIndex,
    graphQuery: runGraphRagQuery,
    optimizeQueryPrompt,
  };
}
