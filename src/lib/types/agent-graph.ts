import type { Edge, Node } from "@xyflow/svelte";
import {
  DEFAULT_NEW_AGENT_SANDBOX_POLICY,
  hasExplicitSandboxPolicy,
  normalizeSandboxPolicy,
  type SandboxPolicy,
} from "$lib/workflows/sandbox-policy";

export const AGENT_GRAPH_VERSION = "v1" as const;

export const AGENT_STEP_TYPES = [
  "input",
  "plan",
  "decide",
  "tool_batch",
  "memory_read",
  "memory_write",
  "memory_compact",
  "approval_gate",
  "delegate",
  "sleep",
  "finish",
] as const;

export type AgentStepType = (typeof AGENT_STEP_TYPES)[number];

export const SIMPLE_AGENT_STEP_TYPES = [
  "input",
  "decide",
  "tool_batch",
  "memory_write",
  "finish",
] as const satisfies readonly AgentStepType[];

export interface AgentGraphNodeData extends Record<string, unknown> {
  label: string;
  stepType: AgentStepType;
  config?: Record<string, unknown>;
}

export type AgentGraphNode = Node<AgentGraphNodeData>;
export type AgentGraphEdge = Edge;

export interface AgentGraphDefinition {
  version: typeof AGENT_GRAPH_VERSION;
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
}

export interface AgentTaskBody extends Record<string, unknown> {
  prompt: string;
  mode: "execute_direct";
  agentRuntime: string;
  sandboxPolicy?: SandboxPolicy;
  workspaceRef?: string;
  sandboxName?: string;
  cwd?: string;
  maxTurns?: number;
  timeoutMinutes?: number;
  stopCondition?: string;
  requireFileChanges?: boolean;
  agentGraph: AgentGraphDefinition;
  agentConfig?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStepType(value: unknown): AgentStepType {
  return typeof value === "string" &&
    AGENT_STEP_TYPES.includes(value as AgentStepType)
    ? (value as AgentStepType)
    : "tool_batch";
}

function normalizeNode(input: unknown, index: number): AgentGraphNode | null {
  if (!isRecord(input)) return null;
  const id =
    typeof input.id === "string" && input.id.trim().length > 0
      ? input.id
      : `agent-step-${index + 1}`;
  const position = isRecord(input.position) ? input.position : {};
  const x =
    typeof position.x === "number" && Number.isFinite(position.x)
      ? position.x
      : 120;
  const y =
    typeof position.y === "number" && Number.isFinite(position.y)
      ? position.y
      : 80 + index * 120;
  const data = isRecord(input.data) ? input.data : {};
  const stepType = normalizeStepType(data.stepType ?? data.kind ?? input.type);
  const label =
    typeof data.label === "string" && data.label.trim().length > 0
      ? data.label
      : humanizeStepType(stepType);
  const config = isRecord(data.config) ? data.config : {};

  return {
    id,
    position: { x, y },
    data: {
      label,
      stepType,
      config,
    },
  };
}

function normalizeEdge(input: unknown, index: number): AgentGraphEdge | null {
  if (!isRecord(input)) return null;
  const source = typeof input.source === "string" ? input.source : "";
  const target = typeof input.target === "string" ? input.target : "";
  if (!source || !target) return null;
  const id =
    typeof input.id === "string" && input.id.trim().length > 0
      ? input.id
      : `${source}->${target}-${index}`;

  return {
    id,
    source,
    target,
    ...(typeof input.label === "string" && input.label.trim().length > 0
      ? { label: input.label }
      : {}),
  };
}

export function humanizeStepType(stepType: AgentStepType): string {
  return stepType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function createDefaultAgentGraph(): AgentGraphDefinition {
  return {
    version: AGENT_GRAPH_VERSION,
    nodes: [
      {
        id: "input",
        position: { x: 120, y: 60 },
        data: {
          label: "Input",
          stepType: "input",
          config: {},
        },
      },
      {
        id: "decide",
        position: { x: 120, y: 200 },
        data: {
          label: "Decide Next Step",
          stepType: "decide",
          config: {},
        },
      },
      {
        id: "tool-batch",
        position: { x: 120, y: 340 },
        data: {
          label: "Tool Batch",
          stepType: "tool_batch",
          config: {},
        },
      },
      {
        id: "memory-write",
        position: { x: 120, y: 480 },
        data: {
          label: "Persist Memory",
          stepType: "memory_write",
          config: {},
        },
      },
      {
        id: "finish",
        position: { x: 120, y: 620 },
        data: {
          label: "Finish",
          stepType: "finish",
          config: {},
        },
      },
    ],
    edges: [
      { id: "input->decide", source: "input", target: "decide" },
      { id: "decide->tool-batch", source: "decide", target: "tool-batch" },
      {
        id: "tool-batch->memory-write",
        source: "tool-batch",
        target: "memory-write",
      },
      { id: "memory-write->finish", source: "memory-write", target: "finish" },
    ],
  };
}

export function normalizeAgentGraph(input: unknown): AgentGraphDefinition {
  if (!isRecord(input)) {
    return createDefaultAgentGraph();
  }

  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  const nodes = rawNodes
    .map((node, index) => normalizeNode(node, index))
    .filter((node): node is AgentGraphNode => node !== null);
  const edges = rawEdges
    .map((edge, index) => normalizeEdge(edge, index))
    .filter((edge): edge is AgentGraphEdge => edge !== null);

  return {
    version:
      input.version === AGENT_GRAPH_VERSION
        ? AGENT_GRAPH_VERSION
        : AGENT_GRAPH_VERSION,
    nodes: nodes.length > 0 ? nodes : createDefaultAgentGraph().nodes,
    edges,
  };
}

export function cloneAgentGraph(input: unknown): AgentGraphDefinition {
  const normalized = normalizeAgentGraph(input);
  return {
    version: normalized.version,
    nodes: normalized.nodes.map((node) => ({
      id: node.id,
      position: {
        x: node.position.x,
        y: node.position.y,
      },
      data: {
        label: node.data.label,
        stepType: node.data.stepType,
        config: isRecord(node.data.config)
          ? JSON.parse(JSON.stringify(node.data.config))
          : {},
      },
    })),
    edges: normalized.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(typeof edge.label === "string" && edge.label.trim().length > 0
        ? { label: edge.label }
        : {}),
    })),
  };
}

export function summarizeAgentGraph(input: unknown): string {
  const graph = normalizeAgentGraph(input);
  const kinds = new Set(
    graph.nodes
      .map((node) => normalizeStepType(node.data?.stepType))
      .filter(Boolean),
  );
  const parts = [`${graph.nodes.length} steps`, `${graph.edges.length} edges`];
  if (kinds.size > 0) {
    parts.push(Array.from(kinds).slice(0, 3).map(humanizeStepType).join(", "));
  }
  return parts.join(" • ");
}

export function getAgentTaskBody(
  taskConfig: Record<string, unknown> | null | undefined,
): AgentTaskBody {
  if (!isRecord(taskConfig)) {
    return createDefaultAgentTaskBody();
  }
  const withBlock = isRecord(taskConfig.with) ? taskConfig.with : {};
  const body = isRecord(withBlock.body) ? withBlock.body : {};
  const agentConfig = isRecord(body.agentConfig)
    ? body.agentConfig
    : isRecord(withBlock.agentConfig)
      ? withBlock.agentConfig
      : {};
  const rawSandboxPolicy = hasExplicitSandboxPolicy(body.sandboxPolicy)
    ? body.sandboxPolicy
    : hasExplicitSandboxPolicy(withBlock.sandboxPolicy)
      ? withBlock.sandboxPolicy
      : undefined;

  return {
    prompt:
      typeof body.prompt === "string"
        ? body.prompt
        : typeof withBlock.prompt === "string"
          ? withBlock.prompt
          : "",
    mode: "execute_direct",
    agentRuntime:
      typeof body.agentRuntime === "string" && body.agentRuntime.trim()
        ? body.agentRuntime.trim()
        : typeof withBlock.agentRuntime === "string" &&
            withBlock.agentRuntime.trim()
          ? withBlock.agentRuntime.trim()
          : "dapr-agent-py",
    ...(rawSandboxPolicy
      ? {
          sandboxPolicy: normalizeSandboxPolicy(
            rawSandboxPolicy,
            DEFAULT_NEW_AGENT_SANDBOX_POLICY,
          ),
        }
      : {}),
    workspaceRef:
      typeof body.workspaceRef === "string"
        ? body.workspaceRef
        : typeof withBlock.workspaceRef === "string"
          ? withBlock.workspaceRef
          : undefined,
    sandboxName:
      typeof body.sandboxName === "string"
        ? body.sandboxName
        : typeof withBlock.sandboxName === "string"
          ? withBlock.sandboxName
          : undefined,
    cwd:
      typeof body.cwd === "string"
        ? body.cwd
        : typeof withBlock.cwd === "string"
          ? withBlock.cwd
          : undefined,
    maxTurns:
      typeof body.maxTurns === "number"
        ? body.maxTurns
        : typeof body.maxTurns === "string"
          ? Number.parseInt(body.maxTurns, 10) || undefined
          : typeof withBlock.maxTurns === "number"
            ? withBlock.maxTurns
            : typeof withBlock.maxTurns === "string"
              ? Number.parseInt(withBlock.maxTurns, 10) || undefined
              : undefined,
    timeoutMinutes:
      typeof body.timeoutMinutes === "number"
        ? body.timeoutMinutes
        : typeof body.timeoutMinutes === "string"
          ? Number.parseInt(body.timeoutMinutes, 10) || undefined
          : typeof withBlock.timeoutMinutes === "number"
            ? withBlock.timeoutMinutes
            : typeof withBlock.timeoutMinutes === "string"
              ? Number.parseInt(withBlock.timeoutMinutes, 10) || undefined
              : undefined,
    stopCondition:
      typeof body.stopCondition === "string"
        ? body.stopCondition
        : typeof withBlock.stopCondition === "string"
          ? withBlock.stopCondition
          : undefined,
    requireFileChanges:
      typeof body.requireFileChanges === "boolean"
        ? body.requireFileChanges
        : typeof withBlock.requireFileChanges === "boolean"
          ? withBlock.requireFileChanges
          : undefined,
    agentGraph: normalizeAgentGraph(body.agentGraph ?? withBlock.agentGraph),
    agentConfig,
  };
}

export function createDefaultAgentTaskBody(label = "Agent"): AgentTaskBody {
  const agentName = sanitizeAgentName(label);
  return {
    prompt: "",
    mode: "execute_direct",
    agentRuntime: "dapr-agent-py",
    sandboxPolicy: { ...DEFAULT_NEW_AGENT_SANDBOX_POLICY },
    workspaceRef: "",
    sandboxName: "",
    cwd: "/sandbox",
    maxTurns: 120,
    timeoutMinutes: 120,
    agentGraph: createDefaultAgentGraph(),
    agentConfig: {
      name: agentName,
      instructions: "",
      modelSpec: "",
      tools: [],
      runtime: "dapr-agent-py",
      profileRef: {
        templateId: "builtin:default-sandbox-agent",
        templateVersion: 1,
        slug: "default-sandbox-agent",
        source: "builtin",
      },
      runtimeOverridePolicy: {
        allowToolNarrowing: true,
        allowServerAdditions: false,
        allowCredentialBinding: true,
        allowSkillAdditions: false,
        allowSkillNarrowing: true,
      },
      profileSnapshot: {
        mcpServers: [],
        skills: [],
        runtimeOverridePolicy: {
          allowToolNarrowing: true,
          allowServerAdditions: false,
          allowCredentialBinding: true,
          allowSkillAdditions: false,
          allowSkillNarrowing: true,
        },
      },
      mcpConnectionMode: "explicit",
      mcpServers: [],
      skills: [],
      loop: {
        strategy: "graph_v1",
      },
      memory: {
        backend: "dapr_state",
        sessionId: "",
      },
      configuration: {
        storeName: "",
        configName: agentName,
        keys: [],
      },
    },
  };
}

export function sanitizeAgentName(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base || "agent"}-runtime`;
}

export function isAgentTaskConfig(
  taskConfig: Record<string, unknown> | null | undefined,
): boolean {
  return (
    typeof taskConfig?.call === "string" && taskConfig.call === "durable/run"
  );
}

export function normalizeAgentTaskConfig(
  taskConfig: Record<string, unknown> | null | undefined,
  label = "Agent",
): Record<string, unknown> {
  const existing = isRecord(taskConfig) ? taskConfig : {};
  const isNewTaskConfig = Object.keys(existing).length === 0;
  const withBlock = isRecord(existing.with) ? existing.with : {};
  const body = getAgentTaskBody(existing);
  const sandboxPolicy = body.sandboxPolicy
    ? normalizeSandboxPolicy(body.sandboxPolicy, DEFAULT_NEW_AGENT_SANDBOX_POLICY)
    : isNewTaskConfig
      ? { ...DEFAULT_NEW_AGENT_SANDBOX_POLICY }
      : undefined;
  const normalizedBody = {
    ...createDefaultAgentTaskBody(label),
    ...body,
    sandboxPolicy,
    agentGraph: normalizeAgentGraph(body.agentGraph),
    agentConfig: {
      ...((createDefaultAgentTaskBody(label).agentConfig as Record<
        string,
        unknown
      >) || {}),
      ...(isRecord(body.agentConfig) ? body.agentConfig : {}),
    },
  };

  return {
    ...existing,
    call: "durable/run",
    with: {
      ...withBlock,
      prompt: normalizedBody.prompt,
      mode: normalizedBody.mode,
      agentRuntime: normalizedBody.agentRuntime,
      ...(normalizedBody.sandboxPolicy
        ? { sandboxPolicy: normalizedBody.sandboxPolicy }
        : {}),
      workspaceRef: normalizedBody.workspaceRef || "",
      sandboxName: normalizedBody.sandboxName || "",
      cwd: normalizedBody.cwd || "/sandbox",
      ...(normalizedBody.maxTurns !== undefined
        ? { maxTurns: normalizedBody.maxTurns }
        : {}),
      ...(normalizedBody.timeoutMinutes !== undefined
        ? { timeoutMinutes: normalizedBody.timeoutMinutes }
        : {}),
      ...(normalizedBody.stopCondition
        ? { stopCondition: normalizedBody.stopCondition }
        : {}),
      ...(normalizedBody.requireFileChanges !== undefined
        ? { requireFileChanges: normalizedBody.requireFileChanges }
        : {}),
      agentGraph: normalizedBody.agentGraph,
      agentConfig: normalizedBody.agentConfig,
      body: {
        ...normalizedBody,
        ...(normalizedBody.sandboxPolicy
          ? { sandboxPolicy: normalizedBody.sandboxPolicy }
          : {}),
      },
    },
  };
}
