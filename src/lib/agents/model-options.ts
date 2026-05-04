export type AgentModelProvider =
  | "anthropic"
  | "openai"
  | "nvidia"
  | "googleai"
  | "deepseek"
  | "huggingface"
  | "mistral"
  | "echo";

export type AgentModelOption = {
  value: string;
  label: string;
  provider: AgentModelProvider;
  iconProvider: string;
  component: string;
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
  },
  {
    value: "huggingface/meta-llama/Meta-Llama-3-8B",
    label: "Meta Llama 3 8B",
    provider: "huggingface",
    iconProvider: "llama",
    component: "llm-huggingface-llama3",
  },
  {
    value: "mistral/open-mistral-7b",
    label: "Open Mistral 7B",
    provider: "mistral",
    iconProvider: "mistral",
    component: "llm-mistral-open",
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
  "googleai/gemini-3.1-pro-preview": "googleai/gemini-3.1-pro-preview",
  "google/gemini-3.1-pro-preview": "googleai/gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview": "googleai/gemini-3.1-pro-preview",
  "deepseek/default": "deepseek/default",
  "huggingface/meta-llama/Meta-Llama-3-8B":
    "huggingface/meta-llama/Meta-Llama-3-8B",
  "meta-llama/Meta-Llama-3-8B": "huggingface/meta-llama/Meta-Llama-3-8B",
  "mistral/open-mistral-7b": "mistral/open-mistral-7b",
  "open-mistral-7b": "mistral/open-mistral-7b",
  "echo/local": "echo/local",
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
