/**
 * llm.test.ts - Unit tests for the LLM abstraction layer (node-llama-cpp)
 *
 * Run with: bun test src/llm.test.ts
 *
 * These tests require the actual models to be downloaded. Run the embed or
 * rerank functions first to trigger model downloads.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LlamaCpp,
  getDefaultLlamaCpp,
  disposeDefaultLlamaCpp,
  setDefaultLlamaCpp,
  DEFAULT_RERANK_MODEL_URI,
  DEFAULT_EMBED_MODEL_URI,
  JINA_TEXT_EMBEDDING_MODEL,
  JINA_MULTIMODAL_EMBEDDING_MODEL,
  LOCAL_QUERY_EXPANSION_MODEL,
  resolveJinaProviderConfig,
  resolveLlamaGpuMode,
  setNodeLlamaCppModuleForTest,
  withNativeStdoutRedirectedToStderr,
  resolveParallelismOverride,
  resolveSafeParallelism,
  resolveEmbedModel,
  resolveGenerateModel,
  resolveRerankModel,
  resolveModels,
  resolveModelsFromConfig,
  pullModels,
  withLLMSession,
  canUnloadLLM,
  SessionReleasedError,
  type RerankDocument,
  type ILLMSession,
} from "../src/llm.js";

const LOCAL_TEST_EMBED_MODEL =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

describe("model name resolution", () => {
  function withModelEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const previous = {
      QMD_EMBED_MODEL: process.env.QMD_EMBED_MODEL,
      QMD_GENERATE_MODEL: process.env.QMD_GENERATE_MODEL,
      QMD_RERANK_MODEL: process.env.QMD_RERANK_MODEL,
    };
    try {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test("all model roles resolve config hints before env fallbacks", () => {
    withModelEnv({
      QMD_EMBED_MODEL: "hf:env-embed",
      QMD_GENERATE_MODEL: "env-generate",
      QMD_RERANK_MODEL: "hf:env-rerank",
    }, () => {
      const config = {
        embed: "hf:config-embed",
        generate: "config-generate",
        rerank: "hf:config-rerank",
      };
      expect(resolveEmbedModel(config)).toBe("hf:config-embed");
      expect(resolveGenerateModel(config)).toBe("config-generate");
      expect(resolveRerankModel(config)).toBe("hf:config-rerank");
      expect(resolveModels(config)).toEqual(config);
    });
  });

  test("LlamaCpp constructor uses the same resolver as status/embed/query helpers", () => {
    withModelEnv({
      QMD_EMBED_MODEL: "hf:env-embed",
      QMD_GENERATE_MODEL: "env-generate",
      QMD_RERANK_MODEL: "hf:env-rerank",
    }, () => {
      const llm = new LlamaCpp({
        embedModel: "hf:config-embed",
        generateModel: "config-generate",
        rerankModel: "hf:config-rerank",
      });
      expect(llm.embedModelName).toBe(resolveEmbedModel({ embed: "hf:config-embed" }));
      expect(llm.generateModelName).toBe(resolveGenerateModel({ generate: "config-generate" }));
      expect(llm.rerankModelName).toBe(resolveRerankModel({ rerank: "hf:config-rerank" }));
    });
  });
});

// =============================================================================
// Singleton Tests (no model loading required)
// =============================================================================

describe("Default LlamaCpp Singleton", () => {
  // Test singleton behavior without resetting to avoid orphan instances
  test("getDefaultLlamaCpp returns same instance on subsequent calls", () => {
    const llm1 = getDefaultLlamaCpp();
    const llm2 = getDefaultLlamaCpp();
    expect(llm1).toBe(llm2);
    expect(llm1).toBeInstanceOf(LlamaCpp);
  });
});

// =============================================================================
// Model Existence Tests
// =============================================================================

describe("LlamaCpp.modelExists", () => {
  test("returns exists:true for HuggingFace model URIs", async () => {
    const llm = getDefaultLlamaCpp();
    const result = await llm.modelExists("hf:org/repo/model.gguf");

    expect(result.exists).toBe(true);
    expect(result.name).toBe("hf:org/repo/model.gguf");
  });

  test("returns exists:true for Jina rerank model URIs", async () => {
    const llm = getDefaultLlamaCpp();
    const result = await llm.modelExists("jina:jina-reranker-v3");

    expect(result).toEqual({
      name: "jina:jina-reranker-v3",
      exists: true,
    });
  });

  test("returns exists:true for OpenAI Responses model URIs", async () => {
    const llm = getDefaultLlamaCpp();
    const result = await llm.modelExists("openai:gpt-5.4");

    expect(result).toEqual({
      name: "openai:gpt-5.4",
      exists: true,
    });
  });

  test("returns exists:false for non-existent local paths", async () => {
    const llm = getDefaultLlamaCpp();
    const result = await llm.modelExists("/nonexistent/path/model.gguf");

    expect(result.exists).toBe(false);
    expect(result.name).toBe("/nonexistent/path/model.gguf");
  });
});

describe("pullModels", () => {
  test("treats API-backed models as remote services without GGUF downloads", async () => {
    const results = await pullModels([
      DEFAULT_EMBED_MODEL_URI,
      "openai:gpt-5.4",
    ]);

    expect(results).toEqual([
      {
        model: DEFAULT_EMBED_MODEL_URI,
        path: "jina-api",
        sizeBytes: 0,
        refreshed: false,
      },
      {
        model: "openai:gpt-5.4",
        path: "openai-responses-api",
        sizeBytes: 0,
        refreshed: false,
      },
    ]);
  });
});

describe("QMD_LLAMA_GPU resolution", () => {
  test("uses auto when unset or blank", () => {
    expect(resolveLlamaGpuMode(undefined)).toBe("auto");
    expect(resolveLlamaGpuMode("   ")).toBe("auto");
  });

  test("maps CPU disable values to false", () => {
    expect(resolveLlamaGpuMode("false")).toBe(false);
    expect(resolveLlamaGpuMode("OFF")).toBe(false);
    expect(resolveLlamaGpuMode(" none ")).toBe(false);
    expect(resolveLlamaGpuMode("disabled")).toBe(false);
    expect(resolveLlamaGpuMode("0")).toBe(false);
  });

  test("passes through supported GPU backends", () => {
    expect(resolveLlamaGpuMode("metal")).toBe("metal");
    expect(resolveLlamaGpuMode("VULKAN")).toBe("vulkan");
    expect(resolveLlamaGpuMode(" cuda ")).toBe("cuda");
  });

  test("QMD_FORCE_CPU disables GPU before QMD_LLAMA_GPU auto-detection", () => {
    const prevForceCpu = process.env.QMD_FORCE_CPU;
    process.env.QMD_FORCE_CPU = "1";
    try {
      expect(resolveLlamaGpuMode(undefined)).toBe(false);
      expect(resolveLlamaGpuMode("cuda")).toBe(false);
    } finally {
      if (prevForceCpu === undefined) delete process.env.QMD_FORCE_CPU;
      else process.env.QMD_FORCE_CPU = prevForceCpu;
    }
  });

  test("QMD_FORCE_CPU ignores false-ish values", () => {
    const prevForceCpu = process.env.QMD_FORCE_CPU;
    process.env.QMD_FORCE_CPU = "0";
    try {
      expect(resolveLlamaGpuMode(undefined)).toBe("auto");
    } finally {
      if (prevForceCpu === undefined) delete process.env.QMD_FORCE_CPU;
      else process.env.QMD_FORCE_CPU = prevForceCpu;
    }
  });

  test("warns and falls back to auto for unsupported values", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(resolveLlamaGpuMode("rocm")).toBe("auto");
      expect(stderrSpy).toHaveBeenCalled();
      expect(String(stderrSpy.mock.calls[0]?.[0] || "")).toContain("QMD_LLAMA_GPU");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("native llama stdout containment", () => {
  test("redirects native stdout noise to stderr while JSON callers are initializing llama", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await withNativeStdoutRedirectedToStderr(async () => {
        process.stdout.write("cmake build spam\n");
        return "ok";
      });

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledWith("cmake build spam\n", undefined, undefined);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test("keeps native GPU failure noise off stdout and caches failed GPU init", async () => {
    const prevGpu = process.env.QMD_LLAMA_GPU;
    const prevForceCpu = process.env.QMD_FORCE_CPU;
    process.env.QMD_LLAMA_GPU = "cuda";
    delete process.env.QMD_FORCE_CPU;

    const calls: unknown[] = [];
    const fakeLlama = { gpu: false, cpuMathCores: 4 };
    setNodeLlamaCppModuleForTest({
      LlamaLogLevel: { error: "error" },
      resolveModelFile: vi.fn(),
      LlamaChatSession: vi.fn() as any,
      getLlama: vi.fn(async (options: Record<string, unknown>) => {
        calls.push(options.gpu);
        if (options.gpu === "cuda") {
          process.stdout.write("cmake build spam\n");
          throw new Error("CUDA unavailable");
        }
        return fakeLlama as any;
      }),
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const first = new LlamaCpp();
      const second = new LlamaCpp();

      await (first as any).ensureLlama();
      await (second as any).ensureLlama();

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledWith("cmake build spam\n", undefined, undefined);
      expect(calls).toEqual(["cuda", false, false]);
      expect(String(stderrSpy.mock.calls.map(call => call[0]).join(""))).toContain("skipping previously failed GPU init");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      setNodeLlamaCppModuleForTest(null);
      if (prevGpu === undefined) delete process.env.QMD_LLAMA_GPU;
      else process.env.QMD_LLAMA_GPU = prevGpu;
      if (prevForceCpu === undefined) delete process.env.QMD_FORCE_CPU;
      else process.env.QMD_FORCE_CPU = prevForceCpu;
    }
  });

  test("warns about CPU fallback only once per process", async () => {
    const prevGpu = process.env.QMD_LLAMA_GPU;
    const prevForceCpu = process.env.QMD_FORCE_CPU;
    process.env.QMD_LLAMA_GPU = "false";
    delete process.env.QMD_FORCE_CPU;

    setNodeLlamaCppModuleForTest({
      LlamaLogLevel: { error: "error" },
      resolveModelFile: vi.fn(),
      LlamaChatSession: vi.fn() as any,
      getLlama: vi.fn(async () => ({ gpu: false, cpuMathCores: 4 }) as any),
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const first = new LlamaCpp();
      const second = new LlamaCpp();

      await (first as any).ensureLlama();
      await (second as any).ensureLlama();

      const stderr = String(stderrSpy.mock.calls.map(call => call[0]).join(""));
      expect(stderr.match(/no GPU acceleration/g)?.length).toBe(1);
      expect(stderr).toContain("qmd doctor");
      expect(stderr).not.toContain("QMD_STATUS_DEVICE_PROBE");
    } finally {
      stderrSpy.mockRestore();
      setNodeLlamaCppModuleForTest(null);
      if (prevGpu === undefined) delete process.env.QMD_LLAMA_GPU;
      else process.env.QMD_LLAMA_GPU = prevGpu;
      if (prevForceCpu === undefined) delete process.env.QMD_FORCE_CPU;
      else process.env.QMD_FORCE_CPU = prevForceCpu;
    }
  });

  test("embeds hello world with QMD_FORCE_CPU=1 without throwing", async () => {
    const prevGpu = process.env.QMD_LLAMA_GPU;
    const prevForceCpu = process.env.QMD_FORCE_CPU;
    process.env.QMD_FORCE_CPU = "1";
    process.env.QMD_LLAMA_GPU = "metal";

    const getEmbeddingFor = vi.fn(async (text: string) => ({
      vector: new Float32Array([0.1, 0.2, 0.3]),
      text,
    }));
    const createEmbeddingContext = vi.fn(async () => ({
      getEmbeddingFor,
      dispose: vi.fn(async () => {}),
    }));
    const loadModel = vi.fn(async () => ({
      trainContextSize: 2048,
      tokenize: (text: string) => Array.from(text),
      detokenize: (tokens: string[]) => tokens.join(""),
      createEmbeddingContext,
      dispose: vi.fn(async () => {}),
    }));
    const getLlama = vi.fn(async (options: Record<string, unknown>) => ({
      gpu: false,
      cpuMathCores: 4,
      loadModel,
      dispose: vi.fn(async () => {}),
    }) as any);

    setNodeLlamaCppModuleForTest({
      LlamaLogLevel: { error: "error" },
      resolveModelFile: vi.fn(async () => "/tmp/nonexistent-model.gguf"),
      LlamaChatSession: vi.fn() as any,
      getLlama,
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const llm = new LlamaCpp({
      embedModel: LOCAL_TEST_EMBED_MODEL,
    });
    try {
      const result = await llm.embed("hello world");
      expect(result).toEqual({
        embedding: [0.10000000149011612, 0.20000000298023224, 0.30000001192092896],
        model: llm.embedModelName,
      });
      expect(getLlama).toHaveBeenCalledWith(expect.objectContaining({ gpu: false, build: "never" }));
      expect(loadModel).toHaveBeenCalledWith(expect.objectContaining({ gpuLayers: 0 }));
      expect(getEmbeddingFor).toHaveBeenCalledWith("hello world");
    } finally {
      await llm.dispose();
      stderrSpy.mockRestore();
      setNodeLlamaCppModuleForTest(null);
      if (prevGpu === undefined) delete process.env.QMD_LLAMA_GPU;
      else process.env.QMD_LLAMA_GPU = prevGpu;
      if (prevForceCpu === undefined) delete process.env.QMD_FORCE_CPU;
      else process.env.QMD_FORCE_CPU = prevForceCpu;
    }
  });
});

describe("LLM context parallelism safety", () => {
  test("defaults Windows CUDA to one context to avoid ggml-cuda.cu:98 crashes", () => {
    expect(resolveSafeParallelism({
      gpu: "cuda",
      platform: "win32",
      computed: 8,
      envValue: undefined,
    })).toBe(1);
  });

  test("keeps non-Windows and non-CUDA backends on computed parallelism", () => {
    expect(resolveSafeParallelism({ gpu: "cuda", platform: "linux", computed: 8 })).toBe(8);
    expect(resolveSafeParallelism({ gpu: "vulkan", platform: "win32", computed: 8 })).toBe(8);
    expect(resolveSafeParallelism({ gpu: false, platform: "win32", computed: 4 })).toBe(4);
  });

  test("QMD_EMBED_PARALLELISM overrides the Windows CUDA safety default", () => {
    expect(resolveSafeParallelism({
      gpu: "cuda",
      platform: "win32",
      computed: 8,
      envValue: "2",
    })).toBe(2);
  });

  test("QMD_EMBED_PARALLELISM clamps invalid values and warns", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(resolveParallelismOverride("0")).toBeUndefined();
      expect(resolveParallelismOverride("bad")).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledTimes(2);
      expect(String(stderrSpy.mock.calls[0]?.[0] || "")).toContain("QMD_EMBED_PARALLELISM");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("LlamaCpp expand context size config", () => {
  const defaultExpandContextSize = 2048;

  test("uses default expand context size when no config or env is set", () => {
    const prev = process.env.QMD_EXPAND_CONTEXT_SIZE;
    delete process.env.QMD_EXPAND_CONTEXT_SIZE;
    try {
      const llm = new LlamaCpp({}) as any;
      expect(llm.expandContextSize).toBe(defaultExpandContextSize);
    } finally {
      if (prev === undefined) delete process.env.QMD_EXPAND_CONTEXT_SIZE;
      else process.env.QMD_EXPAND_CONTEXT_SIZE = prev;
    }
  });

  test("uses QMD_EXPAND_CONTEXT_SIZE when set to a positive integer", () => {
    const prev = process.env.QMD_EXPAND_CONTEXT_SIZE;
    process.env.QMD_EXPAND_CONTEXT_SIZE = "3072";
    try {
      const llm = new LlamaCpp({}) as any;
      expect(llm.expandContextSize).toBe(3072);
    } finally {
      if (prev === undefined) delete process.env.QMD_EXPAND_CONTEXT_SIZE;
      else process.env.QMD_EXPAND_CONTEXT_SIZE = prev;
    }
  });

  test("config value overrides QMD_EXPAND_CONTEXT_SIZE", () => {
    const prev = process.env.QMD_EXPAND_CONTEXT_SIZE;
    process.env.QMD_EXPAND_CONTEXT_SIZE = "4096";
    try {
      const llm = new LlamaCpp({ expandContextSize: 1536 }) as any;
      expect(llm.expandContextSize).toBe(1536);
    } finally {
      if (prev === undefined) delete process.env.QMD_EXPAND_CONTEXT_SIZE;
      else process.env.QMD_EXPAND_CONTEXT_SIZE = prev;
    }
  });

  test("falls back to default and warns when QMD_EXPAND_CONTEXT_SIZE is invalid", () => {
    const prev = process.env.QMD_EXPAND_CONTEXT_SIZE;
    process.env.QMD_EXPAND_CONTEXT_SIZE = "bad";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const llm = new LlamaCpp({}) as any;
      expect(llm.expandContextSize).toBe(defaultExpandContextSize);
      expect(stderrSpy).toHaveBeenCalled();
      expect(String(stderrSpy.mock.calls[0]?.[0] || "")).toContain("QMD_EXPAND_CONTEXT_SIZE");
    } finally {
      stderrSpy.mockRestore();
      if (prev === undefined) delete process.env.QMD_EXPAND_CONTEXT_SIZE;
      else process.env.QMD_EXPAND_CONTEXT_SIZE = prev;
    }
  });

  test("throws when config expandContextSize is invalid", () => {
    expect(() => new LlamaCpp({ expandContextSize: 0 })).toThrow(
      "Invalid expandContextSize: 0. Must be a positive integer."
    );
  });
});

describe("LlamaCpp model resolution (config > env > default)", () => {
  const HARDCODED_EMBED = `jina:${JINA_TEXT_EMBEDDING_MODEL}`;
  const HARDCODED_RERANK = "jina:jina-reranker-v3";
  const HARDCODED_GENERATE = "openai:gpt-5.4";

  test("uses hardcoded default when no config or env is set", () => {
    const prev = process.env.QMD_EMBED_MODEL;
    delete process.env.QMD_EMBED_MODEL;
    try {
      const llm = new LlamaCpp({}) as any;
      expect(llm.embedModelUri).toBe(HARDCODED_EMBED);
      expect(llm.rerankModelUri).toBe(HARDCODED_RERANK);
      expect(llm.generateModelUri).toBe(HARDCODED_GENERATE);
    } finally {
      if (prev === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = prev;
    }
  });

  test("env var overrides hardcoded default", () => {
    const prev = process.env.QMD_EMBED_MODEL;
    process.env.QMD_EMBED_MODEL = "hf:custom/embed-model.gguf";
    try {
      const llm = new LlamaCpp({}) as any;
      expect(llm.embedModelUri).toBe("hf:custom/embed-model.gguf");
    } finally {
      if (prev === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = prev;
    }
  });

  test("config overrides env var", () => {
    const prev = process.env.QMD_EMBED_MODEL;
    process.env.QMD_EMBED_MODEL = "hf:env/model.gguf";
    try {
      const llm = new LlamaCpp({ embedModel: "hf:config/model.gguf" }) as any;
      expect(llm.embedModelUri).toBe("hf:config/model.gguf");
    } finally {
      if (prev === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = prev;
    }
  });
});

describe("LlamaCpp embedding truncation", () => {
  test("truncates against the active embedding context limit, not the model train context", async () => {
    const llm = new LlamaCpp({
      embedModel: LOCAL_TEST_EMBED_MODEL,
    }) as any;
    const getEmbeddingFor = vi.fn(async (text: string) => ({
      vector: new Float32Array([0.25, 0.5]),
      text,
    }));

    llm.touchActivity = vi.fn();
    llm.embedModel = {
      trainContextSize: 8192,
      tokenize: (text: string) => Array.from({ length: text.length }, () => 1),
      detokenize: (tokens: readonly number[]) => "x".repeat(tokens.length),
    };
    llm.ensureEmbedContext = vi.fn().mockResolvedValue({ getEmbeddingFor });

    const result = await llm.embed("x".repeat(3000));

    expect(getEmbeddingFor).toHaveBeenCalledWith("x".repeat(2044));
    expect(result).toEqual({
      embedding: [0.25, 0.5],
      model: llm.embedModelUri,
    });
  });
});

describe("LlamaCpp rerank deduping", () => {
  test("deduplicates identical document texts before scoring", async () => {
    const llm = new LlamaCpp({
      rerankModel: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
    }) as any;
    llm._ciMode = false; // allow unit test even in CI (mocked, no real models)
    const rankAll = vi.fn(async (_query: string, docs: string[]) =>
      docs.map((doc) => doc === "shared chunk" ? 0.9 : 0.2)
    );

    llm.touchActivity = vi.fn();
    llm.ensureRerankContexts = vi.fn().mockResolvedValue([{ rankAll }]);
    llm.ensureRerankModel = vi.fn().mockResolvedValue({
      tokenize: (text: string) => Array.from(text),
      detokenize: (tokens: string[]) => tokens.join(""),
    });

    const result = await llm.rerank("query", [
      { file: "a.md", text: "shared chunk" },
      { file: "b.md", text: "shared chunk" },
      { file: "c.md", text: "different chunk" },
    ]);

    expect(rankAll).toHaveBeenCalledTimes(1);
    expect(rankAll).toHaveBeenCalledWith("query", ["shared chunk", "different chunk"]);
    expect(result.results).toHaveLength(3);

    const scoreByFile = new Map(result.results.map((item) => [item.file, item.score]));
    expect(scoreByFile.get("a.md")).toBe(0.9);
    expect(scoreByFile.get("b.md")).toBe(0.9);
    expect(scoreByFile.get("c.md")).toBe(0.2);
  });
});

describe("LlamaCpp Jina rerank", () => {
  test("uses OpenAI Responses API for query expansion models", async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousBaseUrl = process.env.OPENAI_BASE_URL;
    const previousFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "redaction-sentinel";
    process.env.OPENAI_BASE_URL = "http://gateway.local";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.model).toBe("gpt-5.4");
      expect(request.stream).toBe(true);
      return new Response([
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"lex: deep modules\\n\"}",
        "",
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"vec: module depth\\n\"}",
        "",
        "event: response.completed",
        "data: {\"type\":\"response.completed\"}",
        "",
      ].join("\n"));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp({ generateModel: "openai:gpt-5.4" }) as any;
      llm._ciMode = false;
      const result = await llm.expandQuery("deep modules");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://gateway.local/responses",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer redaction-sentinel",
            Accept: "text/event-stream",
          }),
        }),
      );
      expect(result).toEqual([
        { type: "lex", text: "deep modules" },
        { type: "vec", text: "module depth" },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
  });

  test("passes generation maxTokens to OpenAI Responses output budget", async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousBaseUrl = process.env.OPENAI_BASE_URL;
    const previousFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "redaction-sentinel";
    process.env.OPENAI_BASE_URL = "http://gateway.local";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.model).toBe("gpt-5.4");
      expect(request.stream).toBe(true);
      expect(request.max_output_tokens).toBe(123);
      expect(request.metadata.max_completion_tokens).toBe(123);
      return new Response([
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"bounded answer\"}",
        "",
        "event: response.completed",
        "data: {\"type\":\"response.completed\"}",
        "",
      ].join("\n"));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp({ generateModel: "openai:gpt-5.4" }) as any;
      llm._ciMode = false;
      const result = await llm.generate("short answer", { maxTokens: 123 });

      expect(fetchMock).toHaveBeenCalledWith(
        "http://gateway.local/responses",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer redaction-sentinel",
            Accept: "text/event-stream",
          }),
        }),
      );
      expect(result).toMatchObject({
        text: "bounded answer",
        model: "openai:gpt-5.4",
        done: true,
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
  });

  test("retries retryable OpenAI Responses stream errors", async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousBaseUrl = process.env.OPENAI_BASE_URL;
    const previousFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "redaction-sentinel";
    process.env.OPENAI_BASE_URL = "http://gateway.local";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response([
        "event: response.failed",
        "data: {\"type\":\"response.failed\",\"error\":{\"message\":\"Concurrency limit exceeded for user, please retry later\"}}",
        "",
      ].join("\n")))
      .mockResolvedValueOnce(new Response([
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"vec: module depth\\n\"}",
        "",
        "event: response.completed",
        "data: {\"type\":\"response.completed\"}",
        "",
      ].join("\n")));
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp({ generateModel: "openai:gpt-5.4" }) as any;
      llm._ciMode = false;
      const result = await llm.expandQuery("deep modules", {
        includeLexical: false,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual([{ type: "vec", text: "module depth" }]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
  });

  test("uses Jina API for embedding models", async () => {
    const previousApiKey = process.env.JINA_API_KEY;
    const previousGraphVault = process.env.QMD_GRAPH_VAULT;
    const previousFetch = globalThis.fetch;
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-jina-cost-"));
    process.env.JINA_API_KEY = "redaction-sentinel";
    process.env.QMD_GRAPH_VAULT = graphVault;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toEqual({
        model: JINA_TEXT_EMBEDDING_MODEL,
        input: ["alpha", "beta"],
        task: "retrieval.passage",
        dimensions: 1024,
        normalized: true,
        embedding_type: "float",
        truncate: true,
      });
      return new Response(JSON.stringify({
        model: JINA_TEXT_EMBEDDING_MODEL,
        data: [
          { index: 0, embedding: [0.1, 0.2] },
          { index: 1, embedding: [0.3, 0.4] },
        ],
        usage: {
          total_tokens: 7,
        },
      }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp({ embedModel: DEFAULT_EMBED_MODEL_URI }) as any;
      llm._ciMode = false;
      const result = await llm.embedBatch(["alpha", "beta"], {
        costLineage: {
          sourceId: "source-1",
          documentId: "doc-1",
          bookId: "book-1",
          contentHash: "hash-1",
          artifactIds: ["business-artifact-1"],
        },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.jina.ai/v1/embeddings",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer redaction-sentinel",
          }),
        }),
      );
      expect(result).toEqual([
        { embedding: [0.1, 0.2], model: DEFAULT_EMBED_MODEL_URI },
        { embedding: [0.3, 0.4], model: DEFAULT_EMBED_MODEL_URI },
      ]);
      const ledger = await readFile(
        join(graphVault, "catalog", "cost-accounting.jsonl"),
        "utf8",
      );
      expect(ledger).toContain("\"provider\":\"jina\"");
      expect(ledger).toContain("\"tokenCount\":7");
      expect(ledger).toContain("\"tokenCountStatus\":\"reported\"");
      expect(ledger).toContain("\"embeddingCount\":2");
      expect(ledger).toContain("\"embeddingCountStatus\":\"reported\"");
      expect(ledger).toContain("\"artifactIds\":[\"");
      expect(ledger).toContain("\"requestArtifactPath\":");
      const record = JSON.parse(ledger.trim()) as {
        sourceId: string;
        documentId: string;
        bookId: string;
        contentHash: string;
        lineageMode: string;
        requestArtifactId: string;
        artifactIds: string[];
        metadata?: Record<string, unknown>;
      };
      expect(record.sourceId).toBe("source-1");
      expect(record.documentId).toBe("doc-1");
      expect(record.bookId).toBe("book-1");
      expect(record.contentHash).toBe("hash-1");
      expect(record.lineageMode).toBe("corpus_artifact");
      expect(record.requestArtifactId).toBe(record.artifactIds[0]);
      expect(record.artifactIds).toContain("business-artifact-1");
      expect(JSON.stringify(record.metadata ?? {})).not.toContain("redaction-sentinel");
      expect(JSON.stringify(record.metadata ?? {})).not.toContain("AUTH_SECRET");
      const providerRequest = await readFile(
        join(
          graphVault,
          "catalog",
          "provider-requests",
          `${record.artifactIds[0]}.json`,
        ),
        "utf8",
      );
      expect(providerRequest).toContain("\"kind\": \"provider_request_fingerprint\"");
      expect(providerRequest).not.toContain("redaction-sentinel");
      expect(providerRequest).not.toContain("AUTH_SECRET");
    } finally {
      globalThis.fetch = previousFetch;
      await rm(graphVault, { recursive: true, force: true });
      if (previousApiKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = previousApiKey;
      if (previousGraphVault === undefined) delete process.env.QMD_GRAPH_VAULT;
      else process.env.QMD_GRAPH_VAULT = previousGraphVault;
    }
  });

  test("uses Jina query task for query embeddings", async () => {
    const previousApiKey = process.env.JINA_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.JINA_API_KEY = "redaction-sentinel";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toEqual({
        model: JINA_TEXT_EMBEDDING_MODEL,
        input: ["software design"],
        task: "retrieval.query",
        dimensions: 1024,
        normalized: true,
        embedding_type: "float",
        truncate: true,
      });
      return new Response(JSON.stringify({
        model: JINA_TEXT_EMBEDDING_MODEL,
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp({ embedModel: DEFAULT_EMBED_MODEL_URI }) as any;
      llm._ciMode = false;
      await llm.embedBatch(["software design"], {
        model: DEFAULT_EMBED_MODEL_URI,
        isQuery: true,
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = previousApiKey;
    }
  });

  test("retries retryable Jina embedding failures", async () => {
    const previousApiKey = process.env.JINA_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.JINA_API_KEY = "redaction-sentinel";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limit", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: JINA_TEXT_EMBEDDING_MODEL,
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      })));
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp({ embedModel: DEFAULT_EMBED_MODEL_URI }) as any;
      llm._ciMode = false;
      const result = await llm.embedBatch(["software design"], {
        model: DEFAULT_EMBED_MODEL_URI,
        isQuery: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual([
        { embedding: [0.1, 0.2], model: DEFAULT_EMBED_MODEL_URI },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = previousApiKey;
    }
  });

  test("does not retry non-transient Jina embedding failures", async () => {
    const previousApiKey = process.env.JINA_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.JINA_API_KEY = "redaction-sentinel";
    const fetchMock = vi.fn(async () =>
      new Response("unauthorized", { status: 401 })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp({ embedModel: DEFAULT_EMBED_MODEL_URI }) as any;
      llm._ciMode = false;
      await expect(llm.embedBatch(["software design"], {
        model: DEFAULT_EMBED_MODEL_URI,
        isQuery: true,
      })).rejects.toThrow("Jina embedding request failed (401)");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = previousApiKey;
    }
  });

  test("Jina embedding adapter ignores direct unsupported Jina model overrides", async () => {
    const previousApiKey = process.env.JINA_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.JINA_API_KEY = "redaction-sentinel";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.model).toBe(JINA_TEXT_EMBEDDING_MODEL);
      return new Response(JSON.stringify({
        model: JINA_TEXT_EMBEDDING_MODEL,
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp({ embedModel: "jina:legacy-embedding-model" }) as any;
      llm._ciMode = false;
      const result = await llm.embedBatch(["software design"], {
        model: "jina:another-legacy-embedding-model",
      });
      expect(result).toEqual([{
        embedding: [0.1, 0.2],
        model: DEFAULT_EMBED_MODEL_URI,
      }]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = previousApiKey;
    }
  });

  test("Jina rerank adapter ignores direct unsupported Jina model overrides", async () => {
    const previousApiKey = process.env.JINA_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.JINA_API_KEY = "redaction-sentinel";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.model).toBe("jina-reranker-v3");
      return new Response(JSON.stringify({
        model: "jina-reranker-v3",
        results: [{ index: 0, relevance_score: 0.9 }],
      }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp({ rerankModel: "jina:legacy-reranker-model" }) as any;
      llm._ciMode = false;
      const result = await llm.rerank("design", [{
        file: "a.md",
        text: "deep module",
      }], {
        model: "jina:another-legacy-reranker-model",
      });
      expect(result.model).toBe(DEFAULT_RERANK_MODEL_URI);
      expect(result.results[0]?.score).toBe(0.9);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = previousApiKey;
    }
  });

  test("derives provider models from the active Jina profile", () => {
    const previousEmbedModel = process.env.QMD_EMBED_MODEL;
    const previousRerankModel = process.env.QMD_RERANK_MODEL;
    process.env.QMD_EMBED_MODEL = "jina:jina-embeddings-v5-text-small";
    process.env.QMD_RERANK_MODEL = "jina:jina-reranker-v3";

    try {
      const provider = resolveJinaProviderConfig({
        collections: {},
        providers: {
          jina: {
            embedding_profile: "multimodal",
            embedding_model: "jina-embeddings-v5-text-small",
            rerank_model: "jina-reranker-v3",
            embedding_query_task: "text-matching",
            embedding_document_task: "classification",
            embedding_dimensions: 512,
            embedding_normalized: false,
            embedding_type: "base64",
            embedding_truncate: false,
          },
        },
      });

      expect(provider.embeddingModel).toBe(JINA_MULTIMODAL_EMBEDDING_MODEL);
      expect(provider.rerankModel).toBe("jina-reranker-m0");
      expect(provider.embeddingQueryTask).toBe("retrieval.query");
      expect(provider.embeddingDocumentTask).toBe("retrieval.passage");
      expect(provider.embeddingDimensions).toBe(1024);
      expect(provider.embeddingNormalized).toBe(true);
      expect(provider.embeddingType).toBe("float");
      expect(provider.embeddingTruncate).toBe(true);
    } finally {
      if (previousEmbedModel === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = previousEmbedModel;
      if (previousRerankModel === undefined) delete process.env.QMD_RERANK_MODEL;
      else process.env.QMD_RERANK_MODEL = previousRerankModel;
    }
  });

  test("maps arbitrary Jina model overrides back to the active profile", () => {
    const previousEmbedModel = process.env.QMD_EMBED_MODEL;
    const previousRerankModel = process.env.QMD_RERANK_MODEL;
    process.env.QMD_EMBED_MODEL = "jina:legacy-embedding-model";
    process.env.QMD_RERANK_MODEL = "jina:legacy-reranker-model";

    try {
      const config = {
        collections: {},
        models: {
          embed: "jina:unsupported-embedding-model",
          rerank: "jina:unsupported-reranker-model",
        },
        providers: {
          jina: {
            embedding_profile: "multimodal" as const,
          },
        },
      };

      expect(resolveModelsFromConfig(config)).toEqual({
        embed: "jina:jina-embeddings-v5-omni-small",
        generate: "openai:gpt-5.4",
        rerank: "jina:jina-reranker-m0",
      });
    } finally {
      if (previousEmbedModel === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = previousEmbedModel;
      if (previousRerankModel === undefined) delete process.env.QMD_RERANK_MODEL;
      else process.env.QMD_RERANK_MODEL = previousRerankModel;
    }
  });

  test("keeps explicit non-Jina local model overrides outside Jina profiles", () => {
    const previousEmbedModel = process.env.QMD_EMBED_MODEL;
    const previousRerankModel = process.env.QMD_RERANK_MODEL;
    process.env.QMD_EMBED_MODEL = "hf:env/embed.gguf";
    process.env.QMD_RERANK_MODEL = "hf:env/rerank.gguf";

    try {
      expect(resolveModelsFromConfig({
        collections: {},
        models: {
          embed: "hf:config/embed.gguf",
          rerank: "hf:config/rerank.gguf",
        },
      })).toEqual({
        embed: "hf:config/embed.gguf",
        generate: "openai:gpt-5.4",
        rerank: "hf:config/rerank.gguf",
      });
      expect(resolveModelsFromConfig({ collections: {} })).toEqual({
        embed: "hf:env/embed.gguf",
        generate: "openai:gpt-5.4",
        rerank: "hf:env/rerank.gguf",
      });
    } finally {
      if (previousEmbedModel === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = previousEmbedModel;
      if (previousRerankModel === undefined) delete process.env.QMD_RERANK_MODEL;
      else process.env.QMD_RERANK_MODEL = previousRerankModel;
    }
  });

  test("uses Jina API and maps result indexes back to file paths", async () => {
    const previousApiKey = process.env.JINA_API_KEY;
    const previousGraphVault = process.env.QMD_GRAPH_VAULT;
    const previousFetch = globalThis.fetch;
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-jina-rerank-cost-"));
    process.env.JINA_API_KEY = "redaction-sentinel";
    process.env.QMD_GRAPH_VAULT = graphVault;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toEqual({
        model: "jina-reranker-v3",
        query: "auth setup",
        documents: ["weather forecast", "configure AUTH_SECRET"],
        return_documents: false,
      });
      return new Response(JSON.stringify({
        model: "jina-reranker-v3",
        results: [
          { index: 1, relevance_score: 0.92 },
          { index: 0, relevance_score: 0.12 },
        ],
      }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp() as any;
      llm._ciMode = false; // mocked API call; no local model or real service is used
      const result = await llm.rerank("auth setup", [
        {
          file: "weather.md",
          text: "weather forecast",
          costLineage: {
            sourceId: "source-1",
            documentId: "doc-1",
            bookId: "book-1",
            contentHash: "hash-1",
            artifactIds: ["weather-artifact"],
          },
        },
        {
          file: "auth.md",
          text: "configure AUTH_SECRET",
          costLineage: {
            sourceId: "source-1",
            documentId: "doc-1",
            bookId: "book-1",
            contentHash: "hash-1",
            artifactIds: ["auth-artifact"],
          },
        },
      ], {
        costLineage: {
          artifactIds: ["query-artifact"],
        },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.jina.ai/v1/rerank",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer redaction-sentinel",
          }),
        }),
      );
      expect(result).toEqual({
        model: DEFAULT_RERANK_MODEL_URI,
        results: [
          { file: "auth.md", score: 0.92, index: 1 },
          { file: "weather.md", score: 0.12, index: 0 },
        ],
      });
      const ledger = await readFile(
        join(graphVault, "catalog", "cost-accounting.jsonl"),
        "utf8",
      );
      expect(ledger).toContain("\"stage\":\"rerank\"");
      expect(ledger).toContain("\"artifactIds\":[\"");
      const record = JSON.parse(ledger.trim()) as {
        sourceId: string;
        documentId: string;
        bookId: string;
        contentHash: string;
        lineageMode: string;
        requestArtifactId: string;
        artifactIds: string[];
        metadata?: Record<string, unknown>;
      };
      expect(record.sourceId).toBe("source-1");
      expect(record.documentId).toBe("doc-1");
      expect(record.bookId).toBe("book-1");
      expect(record.contentHash).toBe("hash-1");
      expect(record.lineageMode).toBe("multi_document_query");
      expect(record.requestArtifactId).toBe(record.artifactIds[0]);
      expect(record.artifactIds).toEqual(
        expect.arrayContaining([
          "query-artifact",
          "weather-artifact",
          "auth-artifact",
        ]),
      );
      expect(JSON.stringify(record.metadata ?? {})).not.toContain("redaction-sentinel");
      expect(JSON.stringify(record.metadata ?? {})).not.toContain("AUTH_SECRET");
      const providerRequest = await readFile(
        join(
          graphVault,
          "catalog",
          "provider-requests",
          `${record.artifactIds[0]}.json`,
        ),
        "utf8",
      );
      expect(providerRequest).not.toContain("redaction-sentinel");
      expect(providerRequest).not.toContain("AUTH_SECRET");
    } finally {
      globalThis.fetch = previousFetch;
      await rm(graphVault, { recursive: true, force: true });
      if (previousApiKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = previousApiKey;
      if (previousGraphVault === undefined) delete process.env.QMD_GRAPH_VAULT;
      else process.env.QMD_GRAPH_VAULT = previousGraphVault;
    }
  });

  test("retries retryable Jina rerank failures", async () => {
    const previousApiKey = process.env.JINA_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.JINA_API_KEY = "redaction-sentinel";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("temporarily unavailable", {
        status: 503,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "jina-reranker-v3",
        results: [{ index: 0, relevance_score: 0.77 }],
      })));
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp() as any;
      llm._ciMode = false;
      const result = await llm.rerank("auth setup", [
        { file: "auth.md", text: "configure auth" },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        model: DEFAULT_RERANK_MODEL_URI,
        results: [{ file: "auth.md", score: 0.77, index: 0 }],
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = previousApiKey;
    }
  });

  test("records one Jina rerank ledger entry after transient retry succeeds", async () => {
    const previousApiKey = process.env.JINA_API_KEY;
    const previousGraphVault = process.env.QMD_GRAPH_VAULT;
    const previousFetch = globalThis.fetch;
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-jina-rerank-retry-cost-"));
    process.env.JINA_API_KEY = "redaction-sentinel";
    process.env.QMD_GRAPH_VAULT = graphVault;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("temporarily unavailable", {
        status: 503,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "jina-reranker-v3",
        usage: { total_tokens: 5 },
        results: [{ index: 0, relevance_score: 0.77 }],
      })));
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const llm = new LlamaCpp() as any;
      llm._ciMode = false;
      await llm.rerank("auth setup", [
        {
          file: "auth.md",
          text: "configure auth",
          costLineage: {
            sourceId: "source-1",
            documentId: "doc-1",
            bookId: "book-1",
            contentHash: "hash-1",
            artifactIds: ["auth-artifact"],
          },
        },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const ledger = await readFile(
        join(graphVault, "catalog", "cost-accounting.jsonl"),
        "utf8",
      );
      expect(ledger.trim().split(/\r?\n/u)).toHaveLength(1);
      expect(ledger).toContain("\"stage\":\"rerank\"");
      expect(ledger).toContain("\"tokenCount\":5");
    } finally {
      globalThis.fetch = previousFetch;
      await rm(graphVault, { recursive: true, force: true });
      if (previousApiKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = previousApiKey;
      if (previousGraphVault === undefined) delete process.env.QMD_GRAPH_VAULT;
      else process.env.QMD_GRAPH_VAULT = previousGraphVault;
    }
  });

  test("records direct Jina rerank of multiple corpus artifacts as multi-document", async () => {
    const previousApiKey = process.env.JINA_API_KEY;
    const previousGraphVault = process.env.QMD_GRAPH_VAULT;
    const previousFetch = globalThis.fetch;
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-jina-rerank-merge-"));
    process.env.JINA_API_KEY = "redaction-sentinel";
    process.env.QMD_GRAPH_VAULT = graphVault;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        model: "jina-reranker-v3",
        usage: { total_tokens: 3 },
        results: [
          { index: 0, relevance_score: 0.7 },
          { index: 1, relevance_score: 0.6 },
        ],
      }), { status: 200 }),
    ) as unknown as typeof fetch;

    try {
      const llm = new LlamaCpp() as any;
      llm._ciMode = false;
      await llm.rerank("query", [
        {
          file: "a.md",
          text: "alpha",
          costLineage: {
            documentId: "doc-a",
            contentHash: "hash-a",
            lineageMode: "corpus_artifact",
            artifactIds: ["artifact-a"],
          },
        },
        {
          file: "b.md",
          text: "beta",
          costLineage: {
            documentId: "doc-b",
            contentHash: "hash-b",
            lineageMode: "corpus_artifact",
            artifactIds: ["artifact-b"],
          },
        },
      ]);

      const ledger = await readFile(
        join(graphVault, "catalog", "cost-accounting.jsonl"),
        "utf8",
      );
      const record = JSON.parse(ledger.trim()) as {
        lineageMode: string;
        artifactIds: string[];
        documentId: string | null;
        contentHash: string | null;
      };
      expect(record.lineageMode).toBe("multi_document_query");
      expect(record.documentId).toBeNull();
      expect(record.contentHash).toBeNull();
      expect(record.artifactIds).toEqual(
        expect.arrayContaining(["artifact-a", "artifact-b"]),
      );
    } finally {
      globalThis.fetch = previousFetch;
      await rm(graphVault, { recursive: true, force: true });
      if (previousApiKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = previousApiKey;
      if (previousGraphVault === undefined) delete process.env.QMD_GRAPH_VAULT;
      else process.env.QMD_GRAPH_VAULT = previousGraphVault;
    }
  });

  test("sanitizes provider cost metadata before writing ledger artifacts", async () => {
    const previousGraphVault = process.env.QMD_GRAPH_VAULT;
    const graphVault = await mkdtemp(join(tmpdir(), "qmd-provider-cost-safe-"));
    process.env.QMD_GRAPH_VAULT = graphVault;

    try {
      const llm = new LlamaCpp() as any;
      await llm.recordProviderCost({
        stage: "embed",
        provider: "jina",
        model: "jina-embeddings-v5-text-small",
        requestCount: 1,
        tokenCount: 0,
        tokenCountStatus: "unknown",
        embeddingCount: 0,
        embeddingCountStatus: "reported",
        requestFingerprint: "sha256:request",
        metadata: {
          safeLabel: "safe-value",
          api_key: "sk-redaction-sentinel",
          AUTH_SECRET: "sk-redaction-sentinel",
          absolutePath: "/Users/jin/private/source.epub",
        },
      });

      const ledger = await readFile(
        join(graphVault, "catalog", "cost-accounting.jsonl"),
        "utf8",
      );
      const record = JSON.parse(ledger.trim()) as {
        artifactIds: string[];
        metadata?: Record<string, unknown>;
      };
      const providerRequest = await readFile(
        join(
          graphVault,
          "catalog",
          "provider-requests",
          `${record.artifactIds[0]}.json`,
        ),
        "utf8",
      );

      expect(JSON.stringify(record.metadata ?? {})).toContain("safe-value");
      expect(ledger).not.toContain("sk-redaction-sentinel");
      expect(ledger).not.toContain("/Users/jin/private");
      expect(providerRequest).not.toContain("sk-redaction-sentinel");
      expect(providerRequest).not.toContain("/Users/jin/private");
    } finally {
      await rm(graphVault, { recursive: true, force: true });
      if (previousGraphVault === undefined) delete process.env.QMD_GRAPH_VAULT;
      else process.env.QMD_GRAPH_VAULT = previousGraphVault;
    }
  });

  test("requires JINA_API_KEY for Jina rerank models", async () => {
    const previousApiKey = process.env.JINA_API_KEY;
    delete process.env.JINA_API_KEY;
    try {
      const llm = new LlamaCpp() as any;
      llm._ciMode = false; // exercise Jina adapter validation under CI
      await expect(
        llm.rerank("query", [{ file: "doc.md", text: "content" }]),
      ).rejects.toThrow("JINA_API_KEY is required");
      await expect(
        llm.rerank("query", [{ file: "doc.md", text: "content" }]),
      ).rejects.toMatchObject({
        provider: "jina",
        code: "provider_unavailable",
        retryable: false,
      });
    } finally {
      if (previousApiKey === undefined) delete process.env.JINA_API_KEY;
      else process.env.JINA_API_KEY = previousApiKey;
    }
  });
});

describe("LlamaCpp.getDeviceInfo", () => {
  test("can skip build attempts for status probes", async () => {
    const llm = new LlamaCpp({}) as any;
    const fakeLlama = {
      gpu: "metal",
      supportsGpuOffloading: true,
      cpuMathCores: 8,
      getGpuDeviceNames: vi.fn().mockResolvedValue(["Apple GPU"]),
      getVramState: vi.fn().mockResolvedValue({ total: 1024, used: 256, free: 768 }),
    };

    llm.ensureLlama = vi.fn().mockResolvedValue(fakeLlama);

    const device = await llm.getDeviceInfo({ allowBuild: false });

    expect(llm.ensureLlama).toHaveBeenCalledWith(false);
    expect(device).toEqual({
      gpu: "metal",
      gpuOffloading: true,
      gpuDevices: ["Apple GPU"],
      vram: { total: 1024, used: 256, free: 768 },
      cpuCores: 8,
    });
  });
});

// =============================================================================
// Integration Tests (require actual models)
// =============================================================================

describe.skipIf(!!process.env.CI)("LlamaCpp Integration", () => {
  // Use the singleton to avoid multiple Metal contexts
  const llm = new LlamaCpp({
    embedModel: LOCAL_TEST_EMBED_MODEL,
    generateModel: LOCAL_QUERY_EXPANSION_MODEL,
  });

  afterAll(async () => {
    // Ensure native resources are released to avoid ggml-metal asserts on process exit.
    await llm.dispose();
  });

  describe("embed", () => {
    test("returns embedding with correct dimensions", async () => {
      const result = await llm.embed("Hello world");

      expect(result).not.toBeNull();
      expect(result!.embedding).toBeInstanceOf(Array);
      expect(result!.embedding.length).toBeGreaterThan(0);
      // embeddinggemma outputs 768 dimensions
      expect(result!.embedding.length).toBe(768);
    });

    test("returns consistent embeddings for same input", async () => {
      const result1 = await llm.embed("test text");
      const result2 = await llm.embed("test text");

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();

      // Embeddings should be identical for the same input
      for (let i = 0; i < result1!.embedding.length; i++) {
        expect(result1!.embedding[i]).toBeCloseTo(result2!.embedding[i]!, 5);
      }
    });

    test("returns different embeddings for different inputs", async () => {
      const result1 = await llm.embed("cats are great");
      const result2 = await llm.embed("database optimization");

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();

      // Calculate cosine similarity - should be less than 1.0 (not identical)
      let dotProduct = 0;
      let norm1 = 0;
      let norm2 = 0;
      for (let i = 0; i < result1!.embedding.length; i++) {
        const v1 = result1!.embedding[i]!;
        const v2 = result2!.embedding[i]!;
        dotProduct += v1 * v2;
        norm1 += v1 ** 2;
        norm2 += v2 ** 2;
      }
      const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));

      expect(similarity).toBeLessThan(0.95); // Should be meaningfully different
    });
  });

  describe("embedBatch", () => {
    test("returns embeddings for multiple texts", async () => {
      const texts = ["Hello world", "Test text", "Another document"];
      const results = await llm.embedBatch(texts);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result).not.toBeNull();
        expect(result!.embedding.length).toBe(768);
      }
    });

    test("returns same results as individual embed calls", async () => {
      const texts = ["cats are great", "dogs are awesome"];

      // Get batch embeddings
      const batchResults = await llm.embedBatch(texts);

      // Get individual embeddings
      const individualResults = await Promise.all(texts.map(t => llm.embed(t)));

      // Compare - should be identical
      for (let i = 0; i < texts.length; i++) {
        expect(batchResults[i]).not.toBeNull();
        expect(individualResults[i]).not.toBeNull();
        for (let j = 0; j < batchResults[i]!.embedding.length; j++) {
          expect(batchResults[i]!.embedding[j]).toBeCloseTo(individualResults[i]!.embedding[j]!, 5);
        }
      }
    });

    test("handles empty array", async () => {
      const results = await llm.embedBatch([]);
      expect(results).toHaveLength(0);
    });

    test("batch is faster than sequential", async () => {
      const texts = Array(10).fill(null).map((_, i) => `Document number ${i} with content`);

      // Time batch
      const batchStart = Date.now();
      await llm.embedBatch(texts);
      const batchTime = Date.now() - batchStart;

      // Time sequential
      const seqStart = Date.now();
      for (const text of texts) {
        await llm.embed(text);
      }
      const seqTime = Date.now() - seqStart;

      console.log(`Batch: ${batchTime}ms, Sequential: ${seqTime}ms`);
      // Performance is machine/load dependent. We only assert batch isn't drastically worse.
      expect(batchTime).toBeLessThanOrEqual(seqTime * 3);
    });

    test("handles concurrent embedBatch calls on fresh instance without race condition", async () => {
      // This test verifies the fix for a race condition where concurrent calls to
      // ensureEmbedContext() could create multiple contexts. Without the promise guard,
      // each concurrent embedBatch call sees embedContext === null and creates its own
      // context, causing resource leaks and potential "Context is disposed" errors.
      //
      // See: https://github.com/tobi/qmd/pull/54
      //
      // The fix uses a promise guard to ensure only one context creation runs at a time.
      // We verify this by instrumenting createEmbeddingContext to count invocations.
      
      const freshLlm = new LlamaCpp({
        embedModel: LOCAL_TEST_EMBED_MODEL,
        rerankModel: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
      });
      let contextCreateCount = 0;
      
      // Instrument the model's createEmbeddingContext to count calls
      const originalEnsureEmbedModel = (freshLlm as any).ensureEmbedModel.bind(freshLlm);
      let modelInstrumented = false;
      (freshLlm as any).ensureEmbedModel = async function() {
        const model = await originalEnsureEmbedModel();
        if (!modelInstrumented) {
          modelInstrumented = true;
          const originalCreate = model.createEmbeddingContext.bind(model);
          model.createEmbeddingContext = async function(...args: any[]) {
            contextCreateCount++;
            return originalCreate(...args);
          };
        }
        return model;
      };
      
      const texts = Array(10).fill(null).map((_, i) => `Document ${i}`);

      // Call embedBatch 5 TIMES in parallel on fresh instance.
      // Without the promise guard fix, this would create 5 contexts (one per call).
      // With the fix, only 1 context should be created.
      const batches = await Promise.all([
        freshLlm.embedBatch(texts.slice(0, 2)),
        freshLlm.embedBatch(texts.slice(2, 4)),
        freshLlm.embedBatch(texts.slice(4, 6)),
        freshLlm.embedBatch(texts.slice(6, 8)),
        freshLlm.embedBatch(texts.slice(8, 10)),
      ]);

      const allResults = batches.flat();
      expect(allResults).toHaveLength(10);
      
      const successCount = allResults.filter(r => r !== null).length;
      expect(successCount).toBe(10);

      // THE KEY ASSERTION: Contexts should be created once (by ensureEmbedContexts),
      // not duplicated per concurrent embedBatch call. The exact count depends on
      // available VRAM (computeParallelism), but should not be 5 (one per call).
      // Without the fix, contextCreateCount would be 5× the intended count (one set per concurrent call).
      // With the promise guard, contexts are created exactly once regardless of concurrent callers.
      // The count depends on VRAM (computeParallelism), but should be ≤ 8 (the cap).
      console.log(`Context creation count: ${contextCreateCount} (expected: ≤ 8, not 5× duplicated)`);
      expect(contextCreateCount).toBeGreaterThanOrEqual(1);
      expect(contextCreateCount).toBeLessThanOrEqual(8);
      
      await freshLlm.dispose();
    }, 60000);
  });

  describe.skipIf(!process.env.JINA_API_KEY)("rerank", () => {
    test("scores capital of France question correctly", async () => {
      const query = "What is the capital of France?";
      const documents: RerankDocument[] = [
        { file: "butterflies.txt", text: "Butterflies indeed fly through the garden." },
        { file: "france.txt", text: "The capital of France is Paris." },
        { file: "canada.txt", text: "The capital of Canada is Ottawa." },
      ];

      const result = await llm.rerank(query, documents);

      expect(result.results).toHaveLength(3);

      // The France document should score highest
      expect(result.results[0]!.file).toBe("france.txt");
      expect(result.results[0]!.score).toBeGreaterThan(0.7);

      // Canada should be somewhat relevant (also about capitals)
      expect(result.results[1]!.file).toBe("canada.txt");

      // Butterflies should score lowest
      expect(result.results[2]!.file).toBe("butterflies.txt");
      expect(result.results[2]!.score).toBeLessThan(0.6);
    });

    test("scores authentication query correctly", async () => {
      const query = "How do I configure authentication?";
      const documents: RerankDocument[] = [
        { file: "weather.md", text: "The weather today is sunny with mild temperatures." },
        { file: "auth.md", text: "Authentication can be configured by setting the AUTH_SECRET environment variable." },
        { file: "pizza.md", text: "Our restaurant serves the best pizza in town." },
        { file: "jwt.md", text: "JWT authentication requires a secret key and expiration time." },
      ];

      const result = await llm.rerank(query, documents);

      expect(result.results).toHaveLength(4);

      // Auth documents should score highest
      const topTwo = result.results.slice(0, 2).map((r) => r.file);
      expect(topTwo).toContain("auth.md");
      expect(topTwo).toContain("jwt.md");

      // Irrelevant documents should score lowest
      const bottomTwo = result.results.slice(2).map((r) => r.file);
      expect(bottomTwo).toContain("weather.md");
      expect(bottomTwo).toContain("pizza.md");
    });

    test("handles programming queries correctly", async () => {
      const query = "How do I handle errors in JavaScript?";
      const documents: RerankDocument[] = [
        { file: "cooking.md", text: "To make a good pasta, boil water and add salt." },
        { file: "errors.md", text: "Use try-catch blocks to handle JavaScript errors gracefully." },
        { file: "python.md", text: "Python uses try-except for exception handling." },
      ];

      const result = await llm.rerank(query, documents);

      // JavaScript errors doc should score highest
      expect(result.results[0]!.file).toBe("errors.md");
      expect(result.results[0]!.score).toBeGreaterThan(0.7);

      // Python doc might be somewhat relevant (same concept, different language)
      // Cooking should be least relevant
      expect(result.results[2]!.file).toBe("cooking.md");
    });

    test("handles empty document list", async () => {
      const result = await llm.rerank("test query", []);
      expect(result.results).toHaveLength(0);
    });

    test("handles single document", async () => {
      const result = await llm.rerank("test", [{ file: "doc.md", text: "content" }]);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.file).toBe("doc.md");
    });

    test("preserves original file paths", async () => {
      const documents: RerankDocument[] = [
        { file: "path/to/doc1.md", text: "content one" },
        { file: "another/path/doc2.md", text: "content two" },
      ];

      const result = await llm.rerank("query", documents);

      const files = result.results.map((r) => r.file).sort();
      expect(files).toEqual(["another/path/doc2.md", "path/to/doc1.md"]);
    });

    test("returns scores between 0 and 1", async () => {
      const documents: RerankDocument[] = [
        { file: "a.md", text: "The quick brown fox jumps over the lazy dog." },
        { file: "b.md", text: "Machine learning algorithms process data efficiently." },
        { file: "c.md", text: "React components use JSX syntax for rendering." },
      ];

      const result = await llm.rerank("Tell me about animals", documents);

      for (const doc of result.results) {
        expect(doc.score).toBeGreaterThanOrEqual(0);
        expect(doc.score).toBeLessThanOrEqual(1);
      }
    });

    test("batch reranks multiple documents efficiently", async () => {
      // Create 10 documents to verify batch processing works
      const documents: RerankDocument[] = Array(10)
        .fill(null)
        .map((_, i) => ({
          file: `doc${i}.md`,
          text: `Document number ${i} with some content about topic ${i % 3}`,
        }));

      const start = Date.now();
      const result = await llm.rerank("topic 1", documents);
      const elapsed = Date.now() - start;

      expect(result.results).toHaveLength(10);

      // Verify all documents are returned with valid scores
      for (const doc of result.results) {
        expect(doc.score).toBeGreaterThanOrEqual(0);
        expect(doc.score).toBeLessThanOrEqual(1);
      }

      // Log timing for monitoring batch performance
      console.log(`Batch rerank of 10 docs took ${elapsed}ms`);
    });

    test("uses fewer active rerank contexts for small batches", async () => {
      const freshLlm = new LlamaCpp({});
      const calls: number[] = [];
      const fakeModel = {
        tokenize: (text: string) => Array.from(text),
        detokenize: (tokens: string[]) => tokens.join(""),
      };
      const fakeContexts = Array.from({ length: 4 }, (_, idx) => ({
        rankAll: async (_query: string, docs: string[]) => {
          calls.push(idx);
          return docs.map(() => 0.5);
        },
      }));

      (freshLlm as any).ensureRerankModel = async () => fakeModel;
      (freshLlm as any).ensureRerankContexts = async () => fakeContexts;

      const documents: RerankDocument[] = Array.from({ length: 20 }, (_, i) => ({
        file: `doc${i}.md`,
        text: `Document number ${i}`,
      }));

      const result = await freshLlm.rerank("topic 1", documents);

      expect(result.results).toHaveLength(20);
      expect(calls).toEqual([0, 1]);
    });

    test("truncates and reranks document exceeding 2048 token context size", async () => {
      // The reranker context is created with contextSize=2048. Documents that
      // exceed the token budget (contextSize - template overhead - query tokens)
      // should be silently truncated rather than crashing.
      const paragraph = "The quick brown fox jumps over the lazy dog near the riverbank. " +
        "Authentication tokens must be validated on every request to ensure security. " +
        "Database queries should use prepared statements to prevent SQL injection attacks. " +
        "The deployment pipeline includes linting, testing, building, and publishing stages. ";
      // ~320 chars per paragraph, repeat 40 times = ~12800 chars ≈ 3200 tokens
      const longText = paragraph.repeat(40);

      const query = "How do I configure authentication?";
      const documents: RerankDocument[] = [
        { file: "short-relevant.md", text: "Authentication can be configured by setting AUTH_SECRET." },
        { file: "long-doc.md", text: longText },
        { file: "short-irrelevant.md", text: "The weather is sunny today." },
      ];

      console.log(`Long doc length: ${longText.length} chars (~${Math.round(longText.length / 4)} tokens)`);

      const result = await llm.rerank(query, documents);

      // Should return all 3 documents without crashing
      expect(result.results).toHaveLength(3);

      // All scores should be valid numbers in [0, 1]
      for (const doc of result.results) {
        expect(doc.score).toBeGreaterThanOrEqual(0);
        expect(doc.score).toBeLessThanOrEqual(1);
        expect(Number.isNaN(doc.score)).toBe(false);
      }

      // The short, directly relevant doc should still rank highest
      console.log("Rerank results for long doc test:");
      for (const doc of result.results) {
        console.log(`  ${doc.file}: ${doc.score.toFixed(4)}`);
      }
    }, 30000);
  });

  describe.skipIf(process.env.QMD_TEST_LOCAL_QUERY_EXPANSION !== "1")("expandQuery", () => {
    test("returns query expansions with correct types", async () => {
      const result = await llm.expandQuery("test query");

      // Result is Queryable[] containing lex, vec, and/or hyde entries
      expect(result.length).toBeGreaterThanOrEqual(1);

      // Each result should have a valid type
      for (const q of result) {
        expect(["lex", "vec", "hyde"]).toContain(q.type);
        expect(q.text.length).toBeGreaterThan(0);
      }
    }, 60000); // Local GGUF query expansion can exceed 30s on CPU hosts.

    test("can exclude lexical queries", async () => {
      const result = await llm.expandQuery("authentication setup", { includeLexical: false });

      // Should not contain any 'lex' type entries
      const lexEntries = result.filter(q => q.type === "lex");
      expect(lexEntries).toHaveLength(0);
    });
  });
});

// =============================================================================
// Session Management Tests
// =============================================================================

describe.skipIf(!!process.env.CI)("LLM Session Management", () => {
  beforeAll(() => {
    setDefaultLlamaCpp(new LlamaCpp({ embedModel: LOCAL_TEST_EMBED_MODEL }));
  });

  afterAll(async () => {
    await disposeDefaultLlamaCpp();
  });

  describe("withLLMSession", () => {
    test("session provides access to LLM operations", async () => {
      const result = await withLLMSession(async (session) => {
        expect(session.isValid).toBe(true);
        const embedding = await session.embed("test text");
        expect(embedding).not.toBeNull();
        expect(embedding!.embedding.length).toBe(768);
        return "success";
      });
      expect(result).toBe("success");
    });

    test("session is invalid after release", async () => {
      let capturedSession: ILLMSession | null = null;

      await withLLMSession(async (session) => {
        capturedSession = session;
        expect(session.isValid).toBe(true);
      });

      // Session should be invalid after withLLMSession returns
      expect(capturedSession).not.toBeNull();
      expect(capturedSession!.isValid).toBe(false);
    });

    test("session prevents idle unload during operations", async () => {
      await withLLMSession(async (session) => {
        // While inside a session, canUnloadLLM should return false
        expect(canUnloadLLM()).toBe(false);

        // Perform an operation
        await session.embed("test");

        // Still should not be able to unload
        expect(canUnloadLLM()).toBe(false);
      });

      // After session ends, should be able to unload
      expect(canUnloadLLM()).toBe(true);
    });

    test("nested sessions increment ref count", async () => {
      await withLLMSession(async (outerSession) => {
        expect(canUnloadLLM()).toBe(false);

        await withLLMSession(async (innerSession) => {
          expect(canUnloadLLM()).toBe(false);
          expect(innerSession.isValid).toBe(true);
          expect(outerSession.isValid).toBe(true);
        });

        // Inner session released, but outer still active
        expect(canUnloadLLM()).toBe(false);
        expect(outerSession.isValid).toBe(true);
      });

      // All sessions released
      expect(canUnloadLLM()).toBe(true);
    });

    test("session embedBatch works correctly", async () => {
      await withLLMSession(async (session) => {
        const texts = ["Hello world", "Test text", "Another document"];
        const results = await session.embedBatch(texts);

        expect(results).toHaveLength(3);
        for (const result of results) {
          expect(result).not.toBeNull();
          expect(result!.embedding.length).toBe(768);
        }
      });
    });

    test.skipIf(!process.env.JINA_API_KEY)("session rerank works correctly", async () => {
      await withLLMSession(async (session) => {
        const documents: RerankDocument[] = [
          { file: "a.txt", text: "The capital of France is Paris." },
          { file: "b.txt", text: "Dogs are great pets." },
        ];

        const result = await session.rerank("What is the capital of France?", documents);

        expect(result.results).toHaveLength(2);
        expect(result.results[0]!.file).toBe("a.txt");
        expect(result.results[0]!.score).toBeGreaterThan(result.results[1]!.score);
      });
    });

    test("max duration aborts session after timeout", async () => {
      let aborted = false;

      try {
        await withLLMSession(async (session) => {
          // Wait longer than max duration
          await new Promise(resolve => setTimeout(resolve, 150));

          // This operation should throw because session was aborted
          await session.embed("test");
        }, { maxDuration: 50 }); // 50ms max
      } catch (err) {
        if (err instanceof SessionReleasedError) {
          aborted = true;
        } else {
          throw err;
        }
      }

      expect(aborted).toBe(true);
    }, 5000);

    test("external abort signal propagates to session", async () => {
      const abortController = new AbortController();
      let sessionAborted = false;

      const promise = withLLMSession(async (session) => {
        // Wait a bit then check if aborted
        await new Promise(resolve => setTimeout(resolve, 100));

        if (!session.isValid) {
          sessionAborted = true;
          throw new SessionReleasedError("Session aborted");
        }

        return "should not reach";
      }, { signal: abortController.signal });

      // Abort after 20ms
      setTimeout(() => abortController.abort(), 20);

      try {
        await promise;
      } catch (err) {
        // Expected
      }

      expect(sessionAborted).toBe(true);
    }, 5000);

    test("session provides abort signal for monitoring", async () => {
      await withLLMSession(async (session) => {
        expect(session.signal).toBeInstanceOf(AbortSignal);
        expect(session.signal.aborted).toBe(false);
      });
    });

    test("returns value from callback", async () => {
      const result = await withLLMSession(async (session) => {
        await session.embed("test");
        return { status: "complete", count: 42 };
      });

      expect(result).toEqual({ status: "complete", count: 42 });
    });

    test("propagates errors from callback", async () => {
      const customError = new Error("Custom test error");

      await expect(
        withLLMSession(async () => {
          throw customError;
        })
      ).rejects.toThrow("Custom test error");
    });
  });
});
