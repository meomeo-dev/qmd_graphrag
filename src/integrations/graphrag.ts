import {
  GraphRagIndexRequestSchema,
  GraphRagQueryRequestSchema,
  GraphRagIndexResponseSchema,
  GraphRagQueryResponseSchema,
} from "../contracts/graphrag.js";
import type {
  GraphRagIndexRequest,
  GraphRagIndexResponse,
  GraphRagQueryRequest,
  GraphRagQueryResponse,
} from "../contracts/graphrag.js";
import { callPythonBridge } from "./python-bridge.js";

export async function runGraphRagQuery(
  request: GraphRagQueryRequest,
): Promise<GraphRagQueryResponse> {
  const parsed = GraphRagQueryRequestSchema.parse({
    ...request,
    responseType: request.responseType ?? "multiple paragraphs",
  });

  return callPythonBridge({
    command: "graphrag_query",
    pythonBin: parsed.environment?.pythonBin,
    workingDirectory: parsed.environment?.workingDirectory,
    request: parsed,
    responseSchema: GraphRagQueryResponseSchema,
  });
}

export async function runGraphRagIndex(
  request: GraphRagIndexRequest,
): Promise<GraphRagIndexResponse> {
  const parsed = GraphRagIndexRequestSchema.parse(request);

  return callPythonBridge({
    command: "graphrag_index",
    pythonBin: parsed.environment?.pythonBin,
    workingDirectory: parsed.environment?.workingDirectory,
    request: parsed,
    responseSchema: GraphRagIndexResponseSchema,
  });
}
