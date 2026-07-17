export type AgentModelProvider =
  | "anthropic"
  | "openai"
  | "foundry"
  | "together"
  | "nvidia"
  | "googleai"
  | "alibaba"
  | "deepseek"
  | "zai"
  | "kimi"
  | "huggingface"
  | "mistral"
  | "ollama"
  | "echo";

export type AgentModelOption = {
  value: string;
  label: string;
  provider: AgentModelProvider;
  iconProvider: string;
  component: string;
  contextWindowTokens?: number;
  reasoningEffort?: "max";
  sweBenchCapable?: boolean;
};

export const AGENT_MODEL_OPTIONS: AgentModelOption[] = [
  {
    value: "anthropic/claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "anthropic",
    iconProvider: "anthropic",
    component: "llm-anthropic-opus",
  },
  {
    value: "anthropic/claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    iconProvider: "anthropic",
    component: "llm-anthropic-sonnet",
  },
  {
    value: "anthropic/claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    iconProvider: "anthropic",
    component: "llm-anthropic-haiku",
  },
  {
    value: "openai/gpt-5.5",
    label: "GPT-5.5",
    provider: "openai",
    iconProvider: "openai",
    component: "llm-openai-gpt5",
  },
  {
    value: "openai/o3",
    label: "o3",
    provider: "openai",
    iconProvider: "openai",
    component: "llm-openai-o3",
  },
  {
    value: "nvidia/meta/llama-3.1-8b-instruct",
    label: "NVIDIA Llama 3.1 8B",
    provider: "nvidia",
    iconProvider: "llama",
    component: "llm-nvidia-llama31-8b",
  },
  {
    value: "nvidia/mistralai/mistral-medium-3.5-128b",
    label: "NVIDIA Mistral Medium 3.5",
    provider: "nvidia",
    iconProvider: "mistral",
    component: "llm-nvidia-mistral-medium-35-128b",
  },
  {
    value: "nvidia/mistralai/devstral-2-123b-instruct-2512",
    label: "NVIDIA Devstral 2 123B",
    provider: "nvidia",
    iconProvider: "mistral",
    component: "llm-nvidia-devstral-2-123b",
  },
  {
    value: "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
    label: "NVIDIA Qwen3-Coder 480B",
    provider: "nvidia",
    iconProvider: "qwen",
    component: "llm-nvidia-qwen3-coder-480b",
  },
  {
    value: "nvidia/z-ai/glm4.7",
    label: "NVIDIA GLM 4.7",
    provider: "nvidia",
    iconProvider: "zai",
    component: "llm-nvidia-glm47",
  },
  {
    value: "foundry/DeepSeek-V4-Flash",
    label: "Foundry DeepSeek V4 Flash",
    provider: "foundry",
    iconProvider: "deepseek",
    component: "llm-foundry-deepseek-v4-flash",
  },
  {
    value: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "deepseek",
    iconProvider: "deepseek",
    component: "llm-deepseek-v4-pro",
  },
  {
    value: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "deepseek",
    iconProvider: "deepseek",
    component: "llm-deepseek-v4-flash",
  },
  {
    value: "zai/glm-5.2",
    label: "Z.AI GLM 5.2",
    provider: "zai",
    iconProvider: "zai",
    component: "llm-glm-5.2",
  },
  {
    // Faster GLM-5 family variants on the SAME coding-plan endpoint/quota as
    // glm-5.2 (direct zai_adapter, non-vision). Smoke-tested ~1.6x (turbo) and
    // ~3x (5.1) faster than glm-5.2 — handy for quick proof/iteration runs.
    value: "zai/glm-5-turbo",
    label: "Z.AI GLM-5 Turbo (fast)",
    provider: "zai",
    iconProvider: "zai",
    component: "llm-glm-5-turbo",
  },
  {
    value: "zai/glm-5.1",
    label: "Z.AI GLM 5.1 (fast)",
    provider: "zai",
    iconProvider: "zai",
    component: "llm-glm-5.1",
  },
  {
    // Z.AI VLM (vision) — routes to the pay-as-you-go /paas/v4 endpoint (see
    // zai_adapter._zai_base_url). Used as a screenshot-judging visual critic.
    value: "zai/glm-5v-turbo",
    label: "Z.AI GLM-5V Turbo (vision)",
    provider: "zai",
    iconProvider: "zai",
    component: "llm-glm-5v-turbo",
  },
  {
    value: "alibaba/qwen3-coder-plus",
    label: "Alibaba Qwen3-Coder Plus",
    provider: "alibaba",
    iconProvider: "qwen",
    component: "llm-alibaba-qwen3-coder-plus",
    sweBenchCapable: true,
  },
  {
    value: "kimi/kimi-k3",
    label: "Kimi K3",
    provider: "kimi",
    iconProvider: "moonshotai",
    component: "llm-kimi-k3",
    contextWindowTokens: 1_048_576,
    reasoningEffort: "max",
    sweBenchCapable: true,
  },
  {
    value: "together/zai-org/GLM-5.1",
    label: "Together GLM-5.1",
    provider: "together",
    iconProvider: "zai",
    component: "llm-together-glm-51",
  },
  {
    value: "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
    label: "Together Qwen3-Coder 480B",
    provider: "together",
    iconProvider: "qwen",
    component: "llm-together-qwen3-coder-480b",
  },
  {
    value: "together/deepseek-ai/DeepSeek-V4-Pro",
    label: "Together DeepSeek V4 Pro",
    provider: "together",
    iconProvider: "deepseek",
    component: "llm-together-deepseek-v4-pro",
    sweBenchCapable: false,
  },
  {
    value: "googleai/gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview",
    provider: "googleai",
    iconProvider: "google",
    component: "llm-google-gemini",
  },
  {
    value: "deepseek/default",
    label: "DeepSeek Default",
    provider: "deepseek",
    iconProvider: "deepseek",
    component: "llm-deepseek",
    sweBenchCapable: false,
  },
  {
    value: "huggingface/meta-llama/Meta-Llama-3-8B",
    label: "Meta Llama 3 8B",
    provider: "huggingface",
    iconProvider: "llama",
    component: "llm-huggingface-llama3",
  },
  {
    value: "ollama/llama3.2:3b",
    label: "Llama 3.2 3B (Ollama, ryzen)",
    provider: "ollama",
    iconProvider: "llama",
    component: "llm-ollama-llama32-3b",
  },
  {
    value: "echo/local",
    label: "Local Echo",
    provider: "echo",
    iconProvider: "inference",
    component: "llm-echo",
  },
];

export const CUSTOM_AGENT_MODEL_SELECT_VALUE = "__custom_agent_model__";

const AGENT_MODEL_ALIASES: Record<string, string> = {
  "anthropic/claude-opus-4-8": "anthropic/claude-opus-4-8",
  "claude-opus-4-8": "anthropic/claude-opus-4-8",
  "anthropic/claude-opus-4-7": "anthropic/claude-opus-4-8",
  "claude-opus-4-7": "anthropic/claude-opus-4-8",
  "anthropic/claude-opus-4-6": "anthropic/claude-opus-4-8",
  "claude-opus-4-6": "anthropic/claude-opus-4-8",
  "anthropic/claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5-20251001": "anthropic/claude-haiku-4-5-20251001",
  "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4-5-20251001",
  "anthropic/claude-haiku-4-5": "anthropic/claude-haiku-4-5-20251001",
  "claude-haiku-4-5": "anthropic/claude-haiku-4-5-20251001",
  "openai/gpt-5.5": "openai/gpt-5.5",
  "gpt-5.5": "openai/gpt-5.5",
  "openai/gpt-5.4": "openai/gpt-5.5",
  "gpt-5.4": "openai/gpt-5.5",
  "openai/o3": "openai/o3",
  o3: "openai/o3",
  "nvidia/meta/llama-3.1-8b-instruct": "nvidia/meta/llama-3.1-8b-instruct",
  "meta/llama-3.1-8b-instruct": "nvidia/meta/llama-3.1-8b-instruct",
  "nvidia/mistralai/mistral-medium-3.5-128b":
    "nvidia/mistralai/mistral-medium-3.5-128b",
  "mistralai/mistral-medium-3.5-128b":
    "nvidia/mistralai/mistral-medium-3.5-128b",
  "mistral-medium-3.5-128b": "nvidia/mistralai/mistral-medium-3.5-128b",
  "nvidia/mistralai/devstral-2-123b-instruct-2512":
    "nvidia/mistralai/devstral-2-123b-instruct-2512",
  "mistralai/devstral-2-123b-instruct-2512":
    "nvidia/mistralai/devstral-2-123b-instruct-2512",
  "devstral-2-123b-instruct-2512":
    "nvidia/mistralai/devstral-2-123b-instruct-2512",
  "nvidia/qwen/qwen3-coder-480b-a35b-instruct":
    "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
  "qwen/qwen3-coder-480b-a35b-instruct":
    "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
  "qwen3-coder-480b-a35b-instruct":
    "nvidia/qwen/qwen3-coder-480b-a35b-instruct",
  "nvidia/z-ai/glm4.7": "nvidia/z-ai/glm4.7",
  "z-ai/glm4.7": "nvidia/z-ai/glm4.7",
  "glm4.7": "nvidia/z-ai/glm4.7",
  "foundry/DeepSeek-V4-Flash": "foundry/DeepSeek-V4-Flash",
  "DeepSeek-V4-Flash": "foundry/DeepSeek-V4-Flash",
  "deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "zai/glm-5.2": "zai/glm-5.2",
  "z-ai/glm-5.2": "zai/glm-5.2",
  "glm-5.2": "zai/glm-5.2",
  "glm5.2": "zai/glm-5.2",
  "alibaba/qwen3-coder-plus": "alibaba/qwen3-coder-plus",
  "qwen3-coder-plus": "alibaba/qwen3-coder-plus",
  "qwen/qwen3-coder-plus": "alibaba/qwen3-coder-plus",
  "dashscope/qwen3-coder-plus": "alibaba/qwen3-coder-plus",
  "kimi/kimi-k3": "kimi/kimi-k3",
  "kimi-k3": "kimi/kimi-k3",
  "moonshot/kimi-k3": "kimi/kimi-k3",
  "together/zai-org/GLM-5.1": "together/zai-org/GLM-5.1",
  "zai-org/GLM-5.1": "together/zai-org/GLM-5.1",
  "GLM-5.1": "together/zai-org/GLM-5.1",
  "glm-5.1": "together/zai-org/GLM-5.1",
  "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8":
    "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
  "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8":
    "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
  "qwen3-coder-480b-a35b-instruct-fp8":
    "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
  "together/deepseek-ai/DeepSeek-V4-Pro":
    "together/deepseek-ai/DeepSeek-V4-Pro",
  "deepseek-ai/DeepSeek-V4-Pro": "together/deepseek-ai/DeepSeek-V4-Pro",
  "DeepSeek-V4-Pro": "together/deepseek-ai/DeepSeek-V4-Pro",
  "googleai/gemini-3-pro-preview": "googleai/gemini-3.1-pro-preview",
  "google/gemini-3-pro-preview": "googleai/gemini-3.1-pro-preview",
  "gemini-3-pro-preview": "googleai/gemini-3.1-pro-preview",
  "googleai/gemini-3.1-pro-preview": "googleai/gemini-3.1-pro-preview",
  "google/gemini-3.1-pro-preview": "googleai/gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview": "googleai/gemini-3.1-pro-preview",
  "deepseek/default": "deepseek/default",
  "huggingface/meta-llama/Meta-Llama-3-8B":
    "huggingface/meta-llama/Meta-Llama-3-8B",
  "meta-llama/Meta-Llama-3-8B": "huggingface/meta-llama/Meta-Llama-3-8B",
  "echo/local": "echo/local",
  "ollama/llama3.2:3b": "ollama/llama3.2:3b",
  "llama3.2:3b": "ollama/llama3.2:3b",
  "llama3.2": "ollama/llama3.2:3b",
};

export function canonicalAgentModelSpec(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return AGENT_MODEL_ALIASES[trimmed] ?? null;
}

export function agentModelOptionFor(
  value: string | null | undefined,
): AgentModelOption | null {
  const canonical = canonicalAgentModelSpec(value);
  if (!canonical) return null;
  return (
    AGENT_MODEL_OPTIONS.find((option) => option.value === canonical) ?? null
  );
}

export function agentModelLabel(value: string | null | undefined): string {
  const option = agentModelOptionFor(value);
  if (option) return option.label;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || "Select model";
}

export function agentModelSelectValue(
  value: string | null | undefined,
): string {
  return canonicalAgentModelSpec(value) ?? CUSTOM_AGENT_MODEL_SELECT_VALUE;
}

export function isSupportedAgentModelSpec(
  value: string | null | undefined,
): boolean {
  return canonicalAgentModelSpec(value) !== null;
}
// rebuild trigger 2026-05-09T17:32:00
