"use client";

/**
 * CNCF Serverless Workflow 1.0 Task Node Components
 *
 * One node component per SW 1.0 task type, plus start/end structural nodes.
 * These replace the custom node types (action, trigger, if-else, etc.)
 */

import type { NodeProps } from "@xyflow/react";
import { Position } from "@xyflow/react";
import {
  ArrowRightLeft,
  Bot,
  Check,
  CircleDot,
  CircleOff,
  Clock,
  GitBranch,
  GitFork,
  Globe,
  Headphones,
  Layers,
  type LucideIcon,
  Megaphone,
  OctagonAlert,
  Play,
  Repeat,
  Send,
  Settings2,
  Shield,
  Square,
  Variable,
  XCircle,
  Zap,
} from "lucide-react";
import { memo } from "react";
import {
  Node,
  NodeDescription,
  NodeTitle,
} from "@/components/ai-elements/node";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Shared types and helpers
// ---------------------------------------------------------------------------

interface SWNodeData {
  label: string;
  description?: string;
  taskType: string;
  taskConfig: Record<string, unknown>;
  status?: "idle" | "running" | "success" | "error" | "skipped";
  enabled?: boolean;
}

type SWNodeProps = NodeProps & {
  data?: SWNodeData;
  id: string;
};

const StatusBadge = ({ status }: { status?: string }) => {
  if (!status || status === "idle" || status === "running") return null;
  return (
    <div
      className={cn(
        "absolute top-2 right-2 rounded-full p-1",
        status === "success" && "bg-green-500/50",
        status === "error" && "bg-red-500/50",
        status === "skipped" && "bg-gray-500/50",
      )}
    >
      {status === "success" && <Check className="size-3.5 text-white" strokeWidth={2.5} />}
      {status === "error" && <XCircle className="size-3.5 text-white" strokeWidth={2.5} />}
      {status === "skipped" && <CircleOff className="size-3.5 text-white" strokeWidth={1.5} />}
    </div>
  );
};

/** Generic task node factory */
function makeTaskNode(
  displayName: string,
  Icon: LucideIcon,
  iconColor: string,
  options?: {
    handles?: { target: boolean; source: boolean };
    sources?: Array<{ id: string; label: string; position: typeof Position.Right; style: React.CSSProperties }>;
    subtitle?: (config: Record<string, unknown>) => string | undefined;
  },
) {
  const TaskNode = memo(({ data, selected, id }: SWNodeProps) => {
    if (!data) return null;

    const title = data.label || displayName;
    const config = data.taskConfig || (data as unknown as { config?: Record<string, unknown> }).config || {};
    const subtitle = options?.subtitle?.(config) || data.description || displayName;
    const status = data.status;
    const handles = options?.handles ?? { target: true, source: true };

    return (
      <Node
        className={cn(
          "flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
          selected && "border-primary",
          data.enabled === false && "opacity-50",
        )}
        data-testid={`sw-${displayName.toLowerCase()}-node-${id}`}
        handles={options?.sources ? { target: handles.target, sources: options.sources } : handles}
        runnable
        selected={selected}
        status={status}
      >
        <StatusBadge status={status} />
        <div className="flex flex-col items-center justify-center gap-3 p-6">
          <Icon className={cn("size-12", iconColor)} strokeWidth={1.5} />
          <div className="flex flex-col items-center gap-1 text-center">
            <NodeTitle className="text-base">{title}</NodeTitle>
            {subtitle && <NodeDescription className="text-xs">{subtitle}</NodeDescription>}
          </div>
        </div>
      </Node>
    );
  });
  TaskNode.displayName = `${displayName}Node`;
  return TaskNode;
}

// ---------------------------------------------------------------------------
// Structural nodes
// ---------------------------------------------------------------------------

export const StartNode = makeTaskNode("Start", Play, "text-blue-500", {
  handles: { target: false, source: true },
  subtitle: (config) => (config.document as { title?: string })?.title || "Workflow start",
});

export const EndNode = makeTaskNode("End", Square, "text-gray-400", {
  handles: { target: true, source: false },
});

// ---------------------------------------------------------------------------
// SW 1.0 task type nodes
// ---------------------------------------------------------------------------

/** call task - HTTP/gRPC/function invocation */
export const CallNode = makeTaskNode("Call", Globe, "text-amber-300", {
  subtitle: (config) => {
    const call = config.call as string;
    if (call === "http") {
      const args = config.with as { method?: string; endpoint?: unknown } | undefined;
      const method = args?.method || "HTTP";
      return method.toUpperCase();
    }
    return call || "Call";
  },
});

/** set task - variable assignment */
export const SetNode = makeTaskNode("Set", Variable, "text-purple-400", {
  subtitle: (config) => {
    const set = config.set as Record<string, unknown> | undefined;
    if (set) {
      const keys = Object.keys(set);
      return keys.length > 0 ? keys.join(", ") : "Set variables";
    }
    return "Set variables";
  },
});

/** switch task - conditional branching */
export const SwitchNode = makeTaskNode("Switch", GitBranch, "text-pink-400", {
  sources: [
    { id: "true", label: "true", position: Position.Right, style: { top: "35%" } },
    { id: "false", label: "false", position: Position.Right, style: { top: "65%" } },
  ],
  subtitle: (config) => {
    const cases = config.switch as Array<Record<string, unknown>> | undefined;
    if (cases) return `${cases.length} case${cases.length !== 1 ? "s" : ""}`;
    return "Conditional";
  },
});

/** wait task - delay/timer */
export const WaitNode = makeTaskNode("Wait", Clock, "text-sky-400", {
  subtitle: (config) => {
    const wait = config.wait;
    if (typeof wait === "string") return wait;
    if (typeof wait === "object" && wait) {
      const d = wait as Record<string, number>;
      const parts = [];
      if (d.hours) parts.push(`${d.hours}h`);
      if (d.minutes) parts.push(`${d.minutes}m`);
      if (d.seconds) parts.push(`${d.seconds}s`);
      return parts.join(" ") || "Wait";
    }
    return "Wait";
  },
});

/** emit task - publish event */
export const EmitNode = makeTaskNode("Emit", Send, "text-green-400", {
  subtitle: (config) => {
    const emit = config.emit as { event?: { with?: { type?: string } } } | undefined;
    return emit?.event?.with?.type || "Emit event";
  },
});

/** listen task - wait for event */
export const ListenNode = makeTaskNode("Listen", Headphones, "text-cyan-400", {
  subtitle: () => "Wait for event",
});

/** for task - iteration loop */
export const ForNode = makeTaskNode("For", Repeat, "text-orange-400", {
  subtitle: (config) => {
    const forDef = config.for as { each?: string; in?: string } | undefined;
    if (forDef?.each && forDef?.in) return `${forDef.each} in ${forDef.in}`;
    return "Loop";
  },
});

/** fork task - parallel execution */
export const ForkNode = makeTaskNode("Fork", GitFork, "text-indigo-400", {
  subtitle: (config) => {
    const fork = config.fork as { branches?: unknown[] } | undefined;
    if (fork?.branches) return `${fork.branches.length} branches`;
    return "Parallel";
  },
});

/** try task - error handling */
export const TryNode = makeTaskNode("Try", Shield, "text-yellow-400", {
  subtitle: () => "Error handling",
});

/** run task - shell/script/container/workflow */
export const RunNode = makeTaskNode("Run", Zap, "text-emerald-400", {
  subtitle: (config) => {
    const run = config.run as Record<string, unknown> | undefined;
    if (!run) return "Run";
    if ("workflow" in run) return "Child workflow";
    if ("shell" in run) return "Shell command";
    if ("script" in run) return "Script";
    if ("container" in run) return "Container";
    return "Run";
  },
});

/** raise task - throw error */
export const RaiseNode = makeTaskNode("Raise", OctagonAlert, "text-red-400", {
  subtitle: (config) => {
    const raise = config.raise as { error?: { title?: string } } | undefined;
    return raise?.error?.title || "Raise error";
  },
});

/** do task - sequential sub-tasks */
export const DoNode = makeTaskNode("Do", Layers, "text-teal-400", {
  subtitle: (config) => {
    const tasks = config.do as unknown[] | undefined;
    if (tasks) return `${tasks.length} sub-task${tasks.length !== 1 ? "s" : ""}`;
    return "Sequential tasks";
  },
});

// ---------------------------------------------------------------------------
// Node type registry
// ---------------------------------------------------------------------------

/**
 * Registry mapping SW 1.0 task types to node components.
 * Used in workflow-canvas.tsx to register with @xyflow/react.
 */
export const swNodeTypes = {
  // Structural
  start: StartNode,
  end: EndNode,
  // SW 1.0 task types
  call: CallNode,
  set: SetNode,
  switch: SwitchNode,
  wait: WaitNode,
  emit: EmitNode,
  listen: ListenNode,
  for: ForNode,
  fork: ForkNode,
  try: TryNode,
  run: RunNode,
  raise: RaiseNode,
  do: DoNode,
} as const;
