/**
 * Tests for model router.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerLlmProvider,
  resolveModel,
  registerEmbeddingProvider,
  resolveEmbeddingModel,
  registerBuiltinProviders,
} from "../src/mastra/model-router.js";
import type { LanguageModel } from "ai";

// Minimal mock LanguageModel
function createMockModel(id: string): LanguageModel {
  return {
    specificationVersion: "v1",
    provider: "mock",
    modelId: id,
    doGenerate: async () => ({} as any),
    doStream: async () => ({} as any),
  } as unknown as LanguageModel;
}

describe("model-router", () => {
  beforeEach(() => {
    // Register a test provider for each test
    registerLlmProvider("test", (modelId) => createMockModel(modelId));
  });

  describe("resolveModel", () => {
    it("should pass through LanguageModel instances", () => {
      const model = createMockModel("direct");
      const resolved = resolveModel(model);
      expect(resolved).toBe(model);
    });

    it("should resolve provider/model strings", () => {
      const resolved = resolveModel("test/my-model") as any;
      expect(resolved.modelId).toBe("my-model");
    });

    it("should throw for invalid format (no slash)", () => {
      expect(() => resolveModel("no-slash")).toThrow(
        'expected "provider/model" format',
      );
    });

    it("should throw for unknown provider", () => {
      expect(() => resolveModel("unknown-provider/model")).toThrow(
        'Unknown LLM provider "unknown-provider"',
      );
    });

    it("should handle model IDs with slashes", () => {
      const resolved = resolveModel("test/org/model-name") as any;
      expect(resolved.modelId).toBe("org/model-name");
    });
  });

  describe("resolveEmbeddingModel", () => {
    it("should resolve embedding model strings", () => {
      registerEmbeddingProvider("test-embed", (id) => ({ id }) as any);
      const resolved = resolveEmbeddingModel("test-embed/text-embedding-3-small") as any;
      expect(resolved.id).toBe("text-embedding-3-small");
    });

    it("should pass through non-string values", () => {
      const model = { id: "direct-embed" } as any;
      const resolved = resolveEmbeddingModel(model);
      expect(resolved).toBe(model);
    });

    it("should throw for unknown embedding provider", () => {
      expect(() => resolveEmbeddingModel("missing/model")).toThrow(
        'Unknown embedding provider "missing"',
      );
    });
  });

  describe("registerBuiltinProviders", () => {
    it("should register openai provider without errors", () => {
      // @ai-sdk/openai is a hard dependency, so this should not throw
      expect(() => registerBuiltinProviders()).not.toThrow();
    });

    it("should allow resolving openai models after registration", () => {
      registerBuiltinProviders();
      // Should not throw (openai provider should be registered)
      const model = resolveModel("openai/gpt-4o");
      expect(model).toBeDefined();
    });
  });
});
