import { describe, expect, test } from "vitest";

import { DspyQueryPromptOptimizationRequestSchema } from "../../src/contracts/dspy.js";
import {
  GraphRagIndexRequestSchema,
  GraphRagQueryRequestSchema,
} from "../../src/contracts/graphrag.js";
import { JinaRerankRequestSchema } from "../../src/contracts/jina.js";

describe("GraphRAG contracts", () => {
  test("accepts a local query request", () => {
    const parsed = GraphRagQueryRequestSchema.parse({
      rootDir: "/tmp/graphrag-root",
      method: "local",
      query: "What changed in the roadmap?",
      responseType: "multiple paragraphs",
      communityLevel: 2,
    });

    expect(parsed.method).toBe("local");
    expect(parsed.communityLevel).toBe(2);
  });

  test("accepts a standard index request", () => {
    const parsed = GraphRagIndexRequestSchema.parse({
      rootDir: "/tmp/graphrag-root",
      method: "standard",
      skipValidation: true,
      workflows: ["generate_text_embeddings"],
    });

    expect(parsed.method).toBe("standard");
    expect(parsed.skipValidation).toBe(true);
    expect(parsed.workflows).toEqual(["generate_text_embeddings"]);
  });
});

describe("DSPy contracts", () => {
  test("accepts an optimization request", () => {
    const parsed = DspyQueryPromptOptimizationRequestSchema.parse({
      optimizer: "gepa",
      trainsetPath: "/tmp/train.jsonl",
      model: "openai/gpt-4.1-mini",
      savePromptPath: "/tmp/best_prompt.txt",
    });

    expect(parsed.optimizer).toBe("gepa");
    expect(parsed.savePromptPath).toContain("best_prompt");
  });
});

describe("Jina contracts", () => {
  test("accepts a rerank request", () => {
    const parsed = JinaRerankRequestSchema.parse({
      model: "jina-reranker-v3",
      query: "how to configure authentication",
      documents: ["weather report", "set AUTH_SECRET"],
      return_documents: false,
    });

    expect(parsed.model).toBe("jina-reranker-v3");
    expect(parsed.documents).toHaveLength(2);
  });
});
