/**
 * Model Router — resolves "provider/model" strings to AI SDK 6 LanguageModel instances.
 *
 * No new dependencies: uses existing `ai` and `@ai-sdk/openai`.
 * Additional providers can be registered at runtime via registerLlmProvider().
 */

import type { LanguageModel, EmbeddingModel } from "ai";

type ModelFactory = (modelId: string) => LanguageModel;
type EmbeddingFactory = (modelId: string) => EmbeddingModel;

const llmProviders = new Map<string, ModelFactory>();
const embeddingProviders = new Map<string, EmbeddingFactory>();

/**
 * Register a provider that can create LanguageModel instances.
 *
 * @param name - Provider name (e.g., "openai", "anthropic")
 * @param factory - Function that takes a model ID and returns a LanguageModel
 */
export function registerLlmProvider(
  name: string,
  factory: ModelFactory,
): void {
  llmProviders.set(name, factory);
}

/**
 * Register a provider that can create EmbeddingModel instances.
 */
export function registerEmbeddingProvider(
  name: string,
  factory: EmbeddingFactory,
): void {
  embeddingProviders.set(name, factory);
}

/**
 * Resolve a model spec to a LanguageModel instance.
 *
 * @param spec - Either a "provider/model" string (e.g., "openai/gpt-4o")
 *               or an existing LanguageModel instance (passed through).
 */
export function resolveModel(spec: string | LanguageModel): LanguageModel {
  if (typeof spec !== "string") return spec;

  const slashIndex = spec.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid model spec "${spec}": expected "provider/model" format`,
    );
  }

  const providerName = spec.slice(0, slashIndex);
  const modelId = spec.slice(slashIndex + 1);
  const factory = llmProviders.get(providerName);

  if (!factory) {
    const available = [...llmProviders.keys()].join(", ") || "(none)";
    throw new Error(
      `Unknown LLM provider "${providerName}". Registered providers: ${available}`,
    );
  }

  return factory(modelId);
}

/**
 * Resolve an embedding model spec to an EmbeddingModel instance.
 */
export function resolveEmbeddingModel(
  spec: string | EmbeddingModel,
): EmbeddingModel {
  if (typeof spec !== "string") return spec;

  const slashIndex = spec.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid embedding model spec "${spec}": expected "provider/model" format`,
    );
  }

  const providerName = spec.slice(0, slashIndex);
  const modelId = spec.slice(slashIndex + 1);
  const factory = embeddingProviders.get(providerName);

  if (!factory) {
    const available = [...embeddingProviders.keys()].join(", ") || "(none)";
    throw new Error(
      `Unknown embedding provider "${providerName}". Registered providers: ${available}`,
    );
  }

  return factory(modelId);
}

/**
 * Auto-register the built-in @ai-sdk/openai provider.
 * Called during startup; safe if @ai-sdk/openai is already a dependency.
 */
export function registerBuiltinProviders(): void {
  // @ai-sdk/openai is a hard dependency — always available
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { openai } = require("@ai-sdk/openai") as {
      openai: { chat: (id: string) => LanguageModel; embedding: (id: string) => EmbeddingModel };
    };
    registerLlmProvider("openai", (modelId) => openai.chat(modelId));
    registerEmbeddingProvider("openai", (modelId) => openai.embedding(modelId));
    console.log("[model-router] Registered built-in provider: openai");
  } catch {
    console.warn(
      "[model-router] @ai-sdk/openai not available, skipping builtin registration",
    );
  }
}
