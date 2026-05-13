export type AgentModelProvider =
  | "anthropic"
  | "openai"
  | "foundry"
  | "together"
  | "nvidia"
  | "googleai"
  | "alibaba"
  | "deepseek"
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
  sweBenchCapable?: boolean;
};

export const AGENT_MODEL_OPTIONS: AgentModelOption[] = [
  {
    value: "anthropic/claude-opus-4-7",
    label: "Claude Opus 4.7",
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
    value: "openai/gpt-5.4",
    label: "GPT-5.4",
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
    value: "nvidia/moonshotai/kimi-k2-thinking",
    label: "NVIDIA Kimi K2 Thinking",
    provider: "nvidia",
    iconProvider: "moonshotai",
    component: "llm-nvidia-kimi-k2-thinking",
  },
  {
    value: "nvidia/moonshotai/kimi-k2-instruct-0905",
    label: "NVIDIA Kimi K2 0905",
    provider: "nvidia",
    iconProvider: "moonshotai",
    component: "llm-nvidia-kimi-k2-0905",
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
    value: "alibaba/qwen3-coder-plus",
    label: "Alibaba Qwen3-Coder Plus",
    provider: "alibaba",
    iconProvider: "qwen",
    component: "llm-alibaba-qwen3-coder-plus",
    sweBenchCapable: true,
  },
  {
    value: "kimi/kimi-k2.6",
    label: "Kimi K2.6",
    provider: "kimi",
    iconProvider: "moonshotai",
    component: "llm-kimi-k26",
    sweBenchCapable: true,
  },
  {
    value: "kimi/kimi-k2.5",
    label: "Kimi K2.5",
    provider: "kimi",
    iconProvider: "moonshotai",
    component: "llm-kimi-k25",
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
  "anthropic/claude-opus-4-7": "anthropic/claude-opus-4-7",
  "claude-opus-4-7": "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4-6": "anthropic/claude-opus-4-7",
  "claude-opus-4-6": "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5-20251001": "anthropic/claude-haiku-4-5-20251001",
  "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4-5-20251001",
  "anthropic/claude-haiku-4-5": "anthropic/claude-haiku-4-5-20251001",
  "claude-haiku-4-5": "anthropic/claude-haiku-4-5-20251001",
  "openai/gpt-5.4": "openai/gpt-5.4",
  "gpt-5.4": "openai/gpt-5.4",
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
  "nvidia/moonshotai/kimi-k2-thinking": "nvidia/moonshotai/kimi-k2-thinking",
  "moonshotai/kimi-k2-thinking": "nvidia/moonshotai/kimi-k2-thinking",
  "kimi-k2-thinking": "nvidia/moonshotai/kimi-k2-thinking",
  "nvidia/moonshotai/kimi-k2-instruct-0905":
    "nvidia/moonshotai/kimi-k2-instruct-0905",
  "moonshotai/kimi-k2-instruct-0905": "nvidia/moonshotai/kimi-k2-instruct-0905",
  "kimi-k2-instruct-0905": "nvidia/moonshotai/kimi-k2-instruct-0905",
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
  "alibaba/qwen3-coder-plus": "alibaba/qwen3-coder-plus",
  "qwen3-coder-plus": "alibaba/qwen3-coder-plus",
  "qwen/qwen3-coder-plus": "alibaba/qwen3-coder-plus",
  "dashscope/qwen3-coder-plus": "alibaba/qwen3-coder-plus",
  "kimi/kimi-k2.6": "kimi/kimi-k2.6",
  "kimi-k2.6": "kimi/kimi-k2.6",
  "moonshot/kimi-k2.6": "kimi/kimi-k2.6",
  "kimi/kimi-k2.5": "kimi/kimi-k2.5",
  "kimi-k2.5": "kimi/kimi-k2.5",
  "moonshot/kimi-k2.5": "kimi/kimi-k2.5",
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
