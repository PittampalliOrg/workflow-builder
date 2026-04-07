import type { LoopPolicy, LoopToolChoice } from "../types/loop-policy.js";

type AgentGraphNodeConfig = Record<string, unknown>;

type AgentGraphNode = {
  id?: string;
  data?: {
    label?: string;
    stepType?: string;
    config?: AgentGraphNodeConfig;
  };
};

type StrategyTurnInput = {
  turn: number;
  agentGraph?: Record<string, unknown>;
  appendInstructions?: string;
  activeTools?: string[];
  approvalRequiredTools?: string[];
  toolChoice?: LoopToolChoice;
};

type StrategyCompactionInput = {
  agentGraph?: Record<string, unknown>;
  preserveRecentMessages?: number;
  minMessagesToCompact?: number;
  maxSummaryItems?: number;
};

export interface AgentLoopStrategy {
  readonly name: string;
  prepareTurn(input: StrategyTurnInput): {
    appendInstructions?: string;
    activeTools?: string[];
    approvalRequiredTools?: string[];
    toolChoice?: LoopToolChoice;
  };
  resolveCompaction?(input: StrategyCompactionInput): {
    preserveRecentMessages?: number;
    minMessagesToCompact?: number;
    maxSummaryItems?: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => asString(item)).filter(Boolean) as string[])];
}

function getGraphNodes(agentGraph: unknown): AgentGraphNode[] {
  const record = asRecord(agentGraph);
  return Array.isArray(record?.nodes) ? (record.nodes as AgentGraphNode[]) : [];
}

function getToolChoice(value: unknown): LoopToolChoice | undefined {
  if (value === "auto" || value === "required" || value === "none") {
    return value;
  }
  const record = asRecord(value);
  if (!record || record.type !== "tool") return undefined;
  const toolName = asString(record.toolName);
  return toolName ? { type: "tool", toolName } : undefined;
}

function buildGraphInstructions(nodes: AgentGraphNode[]): string | undefined {
  const lines = nodes
    .map((node) => {
      const stepType = asString(node.data?.stepType) ?? "tool_batch";
      const label = asString(node.data?.label) ?? stepType;
      const config = asRecord(node.data?.config) ?? {};
      const notes: string[] = [];
      const activeTools = asStringArray(config.activeTools);
      const approvals = asStringArray(config.approvalRequiredTools);
      const memoryQuery = asString(config.query);
      const doneToolName = asString(config.doneToolName);
      if (activeTools.length > 0) notes.push(`tools=${activeTools.join(", ")}`);
      if (approvals.length > 0) notes.push(`approval=${approvals.join(", ")}`);
      if (memoryQuery) notes.push(`memory=${memoryQuery}`);
      if (doneToolName) notes.push(`doneTool=${doneToolName}`);
      return `- ${label} [${stepType}]${notes.length > 0 ? `: ${notes.join(" | ")}` : ""}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  return [
    "Follow the configured durable agent graph.",
    "Graph steps:",
    ...lines,
  ].join("\n");
}

export function buildLoopPolicyFromAgentGraph(
  agentGraph: unknown,
): LoopPolicy | undefined {
  const nodes = getGraphNodes(agentGraph);
  if (nodes.length === 0) return undefined;

  const activeTools = new Set<string>();
  const approvalRequiredTools = new Set<string>();
  let toolChoice: LoopToolChoice | undefined;
  let checkpointEverySteps: number | undefined;
  let preserveRecentMessages: number | undefined;
  let minMessagesToCompact: number | undefined;
  let doneToolName: string | undefined;
  let doneToolResponseField: string | undefined;

  for (const node of nodes) {
    const stepType = asString(node.data?.stepType);
    const config = asRecord(node.data?.config) ?? {};
    if (stepType === "tool_batch") {
      for (const toolName of asStringArray(config.activeTools)) {
        activeTools.add(toolName);
      }
      toolChoice = getToolChoice(config.toolChoice) ?? toolChoice;
    }
    if (stepType === "approval_gate") {
      for (const toolName of asStringArray(config.approvalRequiredTools)) {
        approvalRequiredTools.add(toolName);
      }
    }
    if (stepType === "memory_compact") {
      checkpointEverySteps =
        asNumber(config.checkpointEverySteps) ?? checkpointEverySteps;
      preserveRecentMessages =
        asNumber(config.preserveRecentMessages) ?? preserveRecentMessages;
      minMessagesToCompact =
        asNumber(config.minMessagesToCompact) ?? minMessagesToCompact;
    }
    if (stepType === "finish") {
      doneToolName = asString(config.doneToolName) ?? doneToolName;
      doneToolResponseField =
        asString(config.responseField) ?? doneToolResponseField;
    }
  }

  const appendInstructions = buildGraphInstructions(nodes);
  if (
    activeTools.size === 0 &&
    approvalRequiredTools.size === 0 &&
    !toolChoice &&
    !checkpointEverySteps &&
    preserveRecentMessages == null &&
    minMessagesToCompact == null &&
    !doneToolName &&
    !appendInstructions
  ) {
    return undefined;
  }

  return {
    ...(activeTools.size > 0 ? { defaultActiveTools: [...activeTools] } : {}),
    ...(approvalRequiredTools.size > 0
      ? { approvalRequiredTools: [...approvalRequiredTools] }
      : {}),
    ...(toolChoice ? { defaultToolChoice: toolChoice } : {}),
    ...(appendInstructions
      ? {
          prepareStep: {
            appendInstructions,
          },
        }
      : {}),
    ...((checkpointEverySteps || preserveRecentMessages || minMessagesToCompact) && {
      compaction: {
        enabled: true,
        ...(checkpointEverySteps ? { checkpointEverySteps } : {}),
        ...(preserveRecentMessages != null
          ? { preserveRecentMessages: Math.max(1, Math.floor(preserveRecentMessages)) }
          : {}),
        ...(minMessagesToCompact != null
          ? { minMessagesToCompact: Math.max(1, Math.floor(minMessagesToCompact)) }
          : {}),
      },
    }),
    ...(doneToolName
      ? {
          doneTool: {
            enabled: true,
            name: doneToolName,
            ...(doneToolResponseField
              ? { responseField: doneToolResponseField }
              : {}),
          },
        }
      : {}),
  };
}

export class DefaultAgentLoopStrategy implements AgentLoopStrategy {
  readonly name = "default";

  prepareTurn(input: StrategyTurnInput) {
    return {
      ...(input.appendInstructions
        ? { appendInstructions: input.appendInstructions }
        : {}),
      ...(input.activeTools?.length ? { activeTools: input.activeTools } : {}),
      ...(input.approvalRequiredTools?.length
        ? { approvalRequiredTools: input.approvalRequiredTools }
        : {}),
      ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    };
  }
}

export class GraphAgentLoopStrategy implements AgentLoopStrategy {
  readonly name = "graph_v1";

  prepareTurn(input: StrategyTurnInput) {
    const graphPolicy = buildLoopPolicyFromAgentGraph(input.agentGraph);
    const graphInstructions = graphPolicy?.prepareStep?.appendInstructions;
    const combinedInstructions = [
      graphInstructions,
      input.appendInstructions,
    ].filter((value): value is string => Boolean(value && value.trim()));
    return {
      ...(combinedInstructions.length > 0
        ? { appendInstructions: combinedInstructions.join("\n\n") }
        : {}),
      ...((graphPolicy?.defaultActiveTools?.length || input.activeTools?.length) && {
        activeTools: [
          ...new Set([
            ...(input.activeTools ?? []),
            ...(graphPolicy?.defaultActiveTools ?? []),
          ]),
        ],
      }),
      ...((graphPolicy?.approvalRequiredTools?.length ||
        input.approvalRequiredTools?.length) && {
        approvalRequiredTools: [
          ...new Set([
            ...(input.approvalRequiredTools ?? []),
            ...(graphPolicy?.approvalRequiredTools ?? []),
          ]),
        ],
      }),
      ...(input.toolChoice
        ? { toolChoice: input.toolChoice }
        : graphPolicy?.defaultToolChoice
          ? { toolChoice: graphPolicy.defaultToolChoice }
          : {}),
    };
  }

  resolveCompaction(input: StrategyCompactionInput) {
    const graphPolicy = buildLoopPolicyFromAgentGraph(input.agentGraph);
    return {
      preserveRecentMessages:
        input.preserveRecentMessages ??
        graphPolicy?.compaction?.preserveRecentMessages,
      minMessagesToCompact:
        input.minMessagesToCompact ??
        graphPolicy?.compaction?.minMessagesToCompact,
      maxSummaryItems: input.maxSummaryItems,
    };
  }
}

export function createDefaultLoopStrategies(): Record<string, AgentLoopStrategy> {
  const defaultStrategy = new DefaultAgentLoopStrategy();
  const graphStrategy = new GraphAgentLoopStrategy();
  return {
    [defaultStrategy.name]: defaultStrategy,
    [graphStrategy.name]: graphStrategy,
  };
}
