"use client";

/**
 * TaskDagGraph Component
 *
 * React Flow visualization for task dependencies as a DAG (Directed Acyclic Graph).
 * Tasks flow from left to right based on their dependency relationships.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { useCallback, useMemo } from "react";
import "@xyflow/react/dist/style.css";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import type {
  DaprAgentTask,
  DaprAgentTaskStatus,
} from "@/lib/types/workflow-ui";
import { getTaskStatusColor } from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";

// ============================================================================
// Types
// ============================================================================

type TaskDagGraphProps = {
  tasks: DaprAgentTask[];
  onTaskSelect?: (task: DaprAgentTask | null) => void;
  className?: string;
};

interface TaskNodeData extends Record<string, unknown> {
  id: string;
  subject: string;
  status: DaprAgentTaskStatus;
  description?: string;
  blockedBy: string[];
  blocks: string[];
}

type TaskNode = Node<TaskNodeData, "task">;

// ============================================================================
// Task Node Component
// ============================================================================

function TaskStatusIcon({ status }: { status: DaprAgentTaskStatus }) {
  const colorClass = getTaskStatusColor(status);

  switch (status) {
    case "pending":
      return <Circle className={cn("h-4 w-4", colorClass)} />;
    case "in_progress":
      return <Loader2 className={cn("h-4 w-4 animate-spin", colorClass)} />;
    case "completed":
      return <CheckCircle2 className={cn("h-4 w-4", colorClass)} />;
    case "failed":
      return <XCircle className={cn("h-4 w-4", colorClass)} />;
    default:
      return <Circle className={cn("h-4 w-4", colorClass)} />;
  }
}

function TaskNodeComponent({
  data,
  selected,
}: {
  data: TaskNodeData;
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-[180px] max-w-[220px] rounded-lg border-2 px-4 py-3 transition-all",
        "bg-[#1e2433]",
        selected
          ? "border-teal-400 shadow-lg shadow-teal-500/20"
          : "border-gray-600 hover:border-gray-500"
      )}
    >
      <Handle
        className="!bg-gray-500 !border-gray-400 !w-2 !h-2"
        position={Position.Left}
        type="target"
      />

      <div className="mb-1 flex items-center gap-2">
        <TaskStatusIcon status={data.status} />
        <span className="font-mono text-gray-400 text-xs">#{data.id}</span>
      </div>

      <p
        className="truncate font-medium text-gray-200 text-sm"
        title={data.subject}
      >
        {data.subject}
      </p>

      <Handle
        className="!bg-teal-500 !border-teal-400 !w-2 !h-2"
        position={Position.Right}
        type="source"
      />
    </div>
  );
}

// ============================================================================
// Node Types Registration
// ============================================================================

const nodeTypes = {
  task: TaskNodeComponent,
};

// ============================================================================
// Default Edge Options
// ============================================================================

const defaultEdgeOptions = {
  type: "smoothstep",
  style: { stroke: "#2dd4bf", strokeWidth: 2 },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: "#2dd4bf",
  },
};

// ============================================================================
// Graph Layout Algorithm
// ============================================================================

function calculateTaskLayout(tasks: DaprAgentTask[]): {
  nodes: TaskNode[];
  edges: Edge[];
} {
  const NODE_WIDTH = 200;
  const NODE_HEIGHT = 80;
  const HORIZONTAL_GAP = 80;
  const VERTICAL_GAP = 40;

  // Build dependency graph and calculate levels
  const taskMap = new Map<string, DaprAgentTask>();
  const levels = new Map<string, number>();
  const inDegree = new Map<string, number>();

  // Initialize
  for (const task of tasks) {
    taskMap.set(task.id, task);
    inDegree.set(task.id, task.blockedBy.length);
  }

  // Calculate levels using topological sort
  const queue: string[] = [];

  // Start with tasks that have no dependencies
  for (const task of tasks) {
    if (task.blockedBy.length === 0) {
      queue.push(task.id);
      levels.set(task.id, 0);
    }
  }

  while (queue.length > 0) {
    const taskId = queue.shift()!;
    const task = taskMap.get(taskId)!;
    const currentLevel = levels.get(taskId) || 0;

    // Process tasks that depend on this one
    for (const blockedId of task.blocks) {
      if (!taskMap.has(blockedId)) {
        continue;
      }

      const blockedLevel = levels.get(blockedId);
      if (blockedLevel === undefined || blockedLevel <= currentLevel) {
        levels.set(blockedId, currentLevel + 1);
      }

      const degree = (inDegree.get(blockedId) || 0) - 1;
      inDegree.set(blockedId, degree);

      if (degree <= 0 && !queue.includes(blockedId)) {
        queue.push(blockedId);
      }
    }
  }

  // Handle any tasks that weren't processed (disconnected or circular)
  for (const task of tasks) {
    if (!levels.has(task.id)) {
      levels.set(task.id, 0);
    }
  }

  // Group tasks by level
  const tasksByLevel = new Map<number, DaprAgentTask[]>();
  for (const task of tasks) {
    const level = levels.get(task.id) || 0;
    if (!tasksByLevel.has(level)) {
      tasksByLevel.set(level, []);
    }
    tasksByLevel.get(level)?.push(task);
  }

  // Calculate positions
  const nodes: TaskNode[] = [];
  const sortedLevels = Array.from(tasksByLevel.keys()).sort((a, b) => a - b);

  for (const level of sortedLevels) {
    const levelTasks = tasksByLevel.get(level)!;
    const levelHeight = levelTasks.length * (NODE_HEIGHT + VERTICAL_GAP);
    const startY = -levelHeight / 2;

    levelTasks.forEach((task, idx) => {
      nodes.push({
        id: task.id,
        type: "task",
        position: {
          x: level * (NODE_WIDTH + HORIZONTAL_GAP),
          y: startY + idx * (NODE_HEIGHT + VERTICAL_GAP),
        },
        data: {
          id: task.id,
          subject: task.subject,
          status: task.status,
          description: task.description,
          blockedBy: task.blockedBy,
          blocks: task.blocks,
        },
      });
    });
  }

  // Create edges
  const edges: Edge[] = [];
  for (const task of tasks) {
    for (const blockedId of task.blocks) {
      if (taskMap.has(blockedId)) {
        edges.push({
          id: `${task.id}-${blockedId}`,
          source: task.id,
          target: blockedId,
        });
      }
    }
  }

  return { nodes, edges };
}

// ============================================================================
// Main Component
// ============================================================================

export function TaskDagGraph({
  tasks,
  onTaskSelect,
  className,
}: TaskDagGraphProps) {
  // Generate graph layout
  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => calculateTaskLayout(tasks),
    [tasks]
  );

  // React Flow state
  const [nodes, _setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, _setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Handle node click
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (onTaskSelect) {
        const task = tasks.find((t) => t.id === node.id);
        onTaskSelect(task || null);
      }
    },
    [tasks, onTaskSelect]
  );

  // Handle pane click (deselect)
  const onPaneClick = useCallback(() => {
    if (onTaskSelect) {
      onTaskSelect(null);
    }
  }, [onTaskSelect]);

  // Empty state
  if (tasks.length === 0) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <p className="text-muted-foreground">No tasks to display</p>
      </div>
    );
  }

  return (
    <div className={cn("relative h-full min-h-[300px] w-full", className)}>
      <ReactFlow
        defaultEdgeOptions={defaultEdgeOptions}
        edges={edges}
        fitView
        fitViewOptions={{
          padding: 0.3,
          maxZoom: 1.2,
        }}
        maxZoom={2}
        minZoom={0.3}
        nodes={nodes}
        nodeTypes={nodeTypes}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodesChange={onNodesChange}
        onPaneClick={onPaneClick}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          className="!bg-[#1a1f2e]"
          gap={20}
          size={1}
          variant={BackgroundVariant.Dots}
        />
        <Controls
          className="!bg-[#1e2433] !border !border-gray-700 !rounded-lg !shadow-sm [&>button]:!bg-[#1e2433] [&>button]:!border-gray-700 [&>button]:!text-gray-400 [&>button:hover]:!bg-gray-700"
          showInteractive={false}
        />
      </ReactFlow>
    </div>
  );
}
