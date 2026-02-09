"use client";

/**
 * WorkflowDefinitionGraph Component
 *
 * Dynamically visualizes the workflow definition structure using React Flow.
 * Builds the graph from actual execution history data.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { useMemo } from "react";
import "@xyflow/react/dist/style.css";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDaprWorkflow } from "@/hooks/use-monitor-workflows";
import type { DaprExecutionEvent } from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";

// ============================================================================
// Types
// ============================================================================

type WorkflowDefinitionGraphProps = {
  appId: string;
  /** Instance ID of a completed execution to derive the workflow structure from */
  sampleInstanceId?: string;
  className?: string;
};

interface DefinitionNodeData extends Record<string, unknown> {
  label: string;
  type: "start" | "activity" | "end";
}

type DefinitionNode = Node<DefinitionNodeData, "definitionNode">;

// ============================================================================
// Custom Node Component
// ============================================================================

function DefinitionNodeComponent({ data }: NodeProps<DefinitionNode>) {
  const { label, type } = data;

  const isStartOrEnd = type === "start" || type === "end";
  const bgColor = "rgba(45, 212, 191, 0.1)";
  const borderColor = "#2dd4bf";

  return (
    <>
      {type !== "start" && (
        <Handle
          className="!w-2 !h-2 !bg-teal-400 !border-0"
          position={Position.Top}
          type="target"
        />
      )}
      <div
        className={cn(
          "min-w-[160px] border-2 px-6 py-3 text-center transition-all",
          isStartOrEnd ? "rounded-full px-8" : "rounded-lg"
        )}
        style={{
          backgroundColor: bgColor,
          borderColor,
        }}
      >
        <span className="font-medium text-sm text-white">{label}</span>
      </div>
      {type !== "end" && (
        <Handle
          className="!w-2 !h-2 !bg-teal-400 !border-0"
          position={Position.Bottom}
          type="source"
        />
      )}
    </>
  );
}

const nodeTypes = {
  definitionNode: DefinitionNodeComponent,
};

// ============================================================================
// Graph Builder
// ============================================================================

/**
 * Build graph nodes and edges from execution history events.
 * Extracts unique task names and creates a sequential workflow graph.
 */
function buildGraphFromEvents(events: DaprExecutionEvent[]): {
  nodes: DefinitionNode[];
  edges: Edge[];
} {
  if (!events || events.length === 0) {
    return { nodes: [], edges: [] };
  }

  // Sort events by timestamp (chronological)
  const sortedEvents = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Extract unique task names from TaskCompleted events (in order)
  const taskNames: string[] = [];
  const seenTasks = new Set<string>();

  for (const event of sortedEvents) {
    if (
      event.eventType === "TaskCompleted" &&
      event.name &&
      !seenTasks.has(event.name)
    ) {
      seenTasks.add(event.name);
      taskNames.push(event.name);
    }
  }

  // Build nodes
  const nodes: DefinitionNode[] = [];
  const CENTER_X = 200;
  const VERTICAL_SPACING = 80;
  let yPosition = 0;

  // Start node
  nodes.push({
    id: "start",
    type: "definitionNode",
    position: { x: CENTER_X, y: yPosition },
    data: { label: "start", type: "start" },
  });
  yPosition += VERTICAL_SPACING;

  // Task nodes
  for (const taskName of taskNames) {
    nodes.push({
      id: `task-${taskName}`,
      type: "definitionNode",
      position: { x: CENTER_X, y: yPosition },
      data: { label: taskName, type: "activity" },
    });
    yPosition += VERTICAL_SPACING;
  }

  // End node
  nodes.push({
    id: "end",
    type: "definitionNode",
    position: { x: CENTER_X, y: yPosition },
    data: { label: "end", type: "end" },
  });

  // Build edges
  const edges: Edge[] = [];
  const allNodeIds = nodes.map((n) => n.id);

  for (let i = 0; i < allNodeIds.length - 1; i++) {
    edges.push({
      id: `e-${allNodeIds[i]}-${allNodeIds[i + 1]}`,
      source: allNodeIds[i],
      target: allNodeIds[i + 1],
      type: "smoothstep",
      style: { stroke: "#2dd4bf", strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#2dd4bf" },
    });
  }

  return { nodes, edges };
}

// ============================================================================
// Loading/Empty States
// ============================================================================

function GraphSkeleton() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 py-8">
      <Skeleton className="h-10 w-32 rounded-full" />
      <Skeleton className="h-12 w-1" />
      <Skeleton className="h-10 w-40 rounded-lg" />
      <Skeleton className="h-12 w-1" />
      <Skeleton className="h-10 w-40 rounded-lg" />
      <Skeleton className="h-12 w-1" />
      <Skeleton className="h-10 w-32 rounded-full" />
    </div>
  );
}

function EmptyGraph({
  message,
  subtext,
}: {
  message: string;
  subtext?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <p className="text-gray-400 text-sm">{message}</p>
      {subtext && <p className="text-gray-500 text-xs">{subtext}</p>}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function WorkflowDefinitionGraph({
  appId,
  sampleInstanceId,
  className,
}: WorkflowDefinitionGraphProps) {
  // Fetch workflow detail if we have a sample instance ID
  const { workflow, isLoading } = useDaprWorkflow(
    sampleInstanceId ? appId : "",
    sampleInstanceId || "",
    0 // No refresh needed
  );

  // Build graph from execution history
  const { nodes, edges } = useMemo(() => {
    if (!workflow?.executionHistory) {
      return { nodes: [], edges: [] };
    }
    return buildGraphFromEvents(workflow.executionHistory);
  }, [workflow?.executionHistory]);

  // Render content based on state
  const renderContent = () => {
    if (!sampleInstanceId) {
      return (
        <EmptyGraph message="No executions available to show workflow structure" />
      );
    }

    if (isLoading) {
      return <GraphSkeleton />;
    }

    if (nodes.length === 0) {
      return <EmptyGraph message="No workflow steps found" />;
    }

    return (
      <ReactFlow
        edges={edges}
        elementsSelectable={false}
        fitView
        fitViewOptions={{
          padding: 0.3,
          maxZoom: 1,
        }}
        maxZoom={1.5}
        minZoom={0.5}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodeTypes={nodeTypes}
        panOnDrag={true}
        proOptions={{ hideAttribution: true }}
        zoomOnScroll={true}
      >
        <Background
          className="!bg-[#1a1f2e]"
          gap={20}
          size={1}
          variant={BackgroundVariant.Dots}
        />
        <Controls
          className="!bg-[#1e2433] !border !border-gray-700 !rounded-lg [&>button]:!bg-[#1e2433] [&>button]:!border-gray-700 [&>button]:!text-gray-400 [&>button:hover]:!bg-gray-700"
          showInteractive={false}
        />
      </ReactFlow>
    );
  };

  return (
    <Card
      className={cn(
        "h-full min-h-[400px] border-gray-700 bg-[#1a1f2e]",
        className
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="font-medium text-base text-gray-200">
          Workflow Graph
        </CardTitle>
        <p className="text-gray-500 text-xs">
          Structure derived from execution:{" "}
          {sampleInstanceId?.substring(0, 8) || "N/A"}...
        </p>
      </CardHeader>
      <CardContent className="h-[350px] p-0">{renderContent()}</CardContent>
    </Card>
  );
}
