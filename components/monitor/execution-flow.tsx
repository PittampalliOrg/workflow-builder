"use client";

/**
 * ExecutionFlow Component
 *
 * Main React Flow visualization for workflow execution events.
 * Vertical layout (top to bottom) matching Diagrid's design.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  type NodeMouseHandler,
  type OnSelectionChangeFunc,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";
import "@xyflow/react/dist/style.css";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { mapExecutionEventsToGraph } from "@/lib/execution-graph-mapper";
import type {
  AppNode,
  ExecutionFlowNode as ExecutionFlowNodeType,
  ExecutionNodeData,
} from "@/lib/types/execution-graph";
import type { DaprExecutionEvent } from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";
import { ExecutionFlowNode } from "./execution-flow-node";

// ============================================================================
// Types
// ============================================================================

type ExecutionFlowProps = {
  events: DaprExecutionEvent[];
  onEventSelect?: (event: DaprExecutionEvent | null) => void;
  onRefresh?: () => void;
  className?: string;
};

// ============================================================================
// Node Types Registration
// ============================================================================

const nodeTypes = {
  executionEvent: ExecutionFlowNode,
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
// Main Component
// ============================================================================

export function ExecutionFlow({
  events,
  onEventSelect,
  onRefresh,
  className,
}: ExecutionFlowProps) {
  const [showContext, setShowContext] = useState(false);

  // Transform events to graph
  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => mapExecutionEventsToGraph(events),
    [events]
  );

  // React Flow state
  const [nodes, _setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, _setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Handle node selection
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes }) => {
      if (selectedNodes.length > 0 && onEventSelect) {
        const selectedNode = selectedNodes[0] as ExecutionFlowNodeType;
        const event = events.find(
          (e) => e.eventId === selectedNode.data.eventId
        );
        onEventSelect(event || null);
      } else if (onEventSelect) {
        onEventSelect(null);
      }
    },
    [events, onEventSelect]
  );

  // Handle node click
  const onNodeClick: NodeMouseHandler<AppNode> = useCallback(
    (_, node) => {
      if (onEventSelect && node.type === "executionEvent") {
        const data = node.data as ExecutionNodeData;
        const event = events.find((e) => e.eventId === data.eventId);
        onEventSelect(event || null);
      }
    },
    [events, onEventSelect]
  );

  // Handle pane click (deselect)
  const onPaneClick = useCallback(() => {
    if (onEventSelect) {
      onEventSelect(null);
    }
  }, [onEventSelect]);

  // Empty state
  if (events.length === 0) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <p className="text-muted-foreground">No execution events to display</p>
      </div>
    );
  }

  return (
    <div className={cn("relative h-full min-h-[400px] w-full", className)}>
      {/* Controls bar - Diagrid style */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-4">
        {onRefresh && (
          <Button
            className="gap-2 text-teal-400 hover:bg-transparent hover:text-teal-300"
            onClick={onRefresh}
            size="sm"
            variant="ghost"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        )}
        <div className="flex items-center gap-2">
          <Switch
            checked={showContext}
            id="show-context"
            onCheckedChange={setShowContext}
          />
          <label
            className="cursor-pointer text-muted-foreground text-sm"
            htmlFor="show-context"
          >
            Show context
          </label>
        </div>
      </div>

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
        onSelectionChange={onSelectionChange}
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
