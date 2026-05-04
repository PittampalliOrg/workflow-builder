import { describe, expect, it } from "vitest";
import {
  AGENT_MODEL_OPTIONS,
  agentModelLabel,
  canonicalAgentModelSpec,
  isSupportedAgentModelSpec,
} from "./model-options";

describe("agent model options", () => {
  it("advertises only Dapr components supported by dapr-agent-py today", () => {
    expect(AGENT_MODEL_OPTIONS.map((option) => option.value)).toEqual([
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5-20251001",
      "openai/gpt-5.4",
      "openai/o3",
      "nvidia/meta/llama-3.1-8b-instruct",
      "nvidia/mistralai/mistral-medium-3.5-128b",
      "nvidia/mistralai/devstral-2-123b-instruct-2512",
      "nvidia/moonshotai/kimi-k2-thinking",
      "nvidia/moonshotai/kimi-k2-instruct-0905",
      "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
      "nvidia/z-ai/glm4.7",
      "foundry/DeepSeek-V4-Flash",
      "together/zai-org/GLM-5.1",
      "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      "together/deepseek-ai/DeepSeek-V4-Pro",
      "googleai/gemini-3.1-pro-preview",
      "deepseek/default",
      "huggingface/meta-llama/Meta-Llama-3-8B",
      "echo/local",
    ]);
  });

  it("canonicalizes legacy and short aliases to the dropdown values", () => {
    expect(canonicalAgentModelSpec("claude-opus-4-7")).toBe(
      "anthropic/claude-opus-4-7",
    );
    expect(canonicalAgentModelSpec("claude-opus-4-6")).toBe(
      "anthropic/claude-opus-4-7",
    );
    expect(canonicalAgentModelSpec("claude-haiku-4-5")).toBe(
      "anthropic/claude-haiku-4-5-20251001",
    );
    expect(canonicalAgentModelSpec("gpt-5.4")).toBe("openai/gpt-5.4");
    expect(canonicalAgentModelSpec("o3")).toBe("openai/o3");
    expect(canonicalAgentModelSpec("meta/llama-3.1-8b-instruct")).toBe(
      "nvidia/meta/llama-3.1-8b-instruct",
    );
    expect(canonicalAgentModelSpec("mistral-medium-3.5-128b")).toBe(
      "nvidia/mistralai/mistral-medium-3.5-128b",
    );
    expect(
      canonicalAgentModelSpec("mistralai/devstral-2-123b-instruct-2512"),
    ).toBe("nvidia/mistralai/devstral-2-123b-instruct-2512");
    expect(canonicalAgentModelSpec("kimi-k2-thinking")).toBe(
      "nvidia/moonshotai/kimi-k2-thinking",
    );
    expect(canonicalAgentModelSpec("qwen3-coder-480b-a35b-instruct")).toBe(
      "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
    );
    expect(canonicalAgentModelSpec("glm4.7")).toBe("nvidia/z-ai/glm4.7");
    expect(canonicalAgentModelSpec("DeepSeek-V4-Flash")).toBe(
      "foundry/DeepSeek-V4-Flash",
    );
    expect(canonicalAgentModelSpec("GLM-5.1")).toBe(
      "together/zai-org/GLM-5.1",
    );
    expect(
      canonicalAgentModelSpec("Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8"),
    ).toBe("together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8");
    expect(canonicalAgentModelSpec("DeepSeek-V4-Pro")).toBe(
      "together/deepseek-ai/DeepSeek-V4-Pro",
    );
    expect(canonicalAgentModelSpec("google/gemini-3.1-pro-preview")).toBe(
      "googleai/gemini-3.1-pro-preview",
    );
    expect(canonicalAgentModelSpec("meta-llama/Meta-Llama-3-8B")).toBe(
      "huggingface/meta-llama/Meta-Llama-3-8B",
    );
  });

  it("does not bless models without a mapped Dapr runtime component", () => {
    expect(isSupportedAgentModelSpec("gpt-5-mini")).toBe(false);
    expect(isSupportedAgentModelSpec("openai/gpt-5.3-codex")).toBe(false);
    expect(isSupportedAgentModelSpec("ollama/llama3.2")).toBe(false);
    expect(isSupportedAgentModelSpec("mistral/open-mistral-7b")).toBe(false);
    expect(isSupportedAgentModelSpec("foundry/Kimi-K2.6")).toBe(false);
  });

  it("formats known aliases with their canonical label", () => {
    expect(agentModelLabel("claude-opus-4-6")).toBe("Claude Opus 4.7");
    expect(agentModelLabel("openai/o3")).toBe("o3");
    expect(agentModelLabel("meta/llama-3.1-8b-instruct")).toBe(
      "NVIDIA Llama 3.1 8B",
    );
    expect(agentModelLabel("mistral-medium-3.5-128b")).toBe(
      "NVIDIA Mistral Medium 3.5",
    );
    expect(agentModelLabel("kimi-k2-thinking")).toBe("NVIDIA Kimi K2 Thinking");
    expect(agentModelLabel("DeepSeek-V4-Flash")).toBe(
      "Foundry DeepSeek V4 Flash",
    );
    expect(agentModelLabel("GLM-5.1")).toBe("Together GLM-5.1");
    expect(agentModelLabel("DeepSeek-V4-Pro")).toBe(
      "Together DeepSeek V4 Pro",
    );
    expect(agentModelLabel("google/gemini-3.1-pro-preview")).toBe(
      "Gemini 3.1 Pro Preview",
    );
  });
});
