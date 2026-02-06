"use client";

/**
 * ExecutionFlow Component
 *
 * Main React Flow visualization for workflow execution events.
 * Vertical layout (top to bottom) matching Diagrid's design.
 */

import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type OnSelectionChangeFunc,
  type NodeMouseHandler,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { RefreshCw } from "lucide-react";

import type { DaprExecutionEvent } from "@/lib/types/workflow-ui";
import type {
  ExecutionFlowNode as ExecutionFlowNodeType,
  ExecutionNodeData,
  AppNode,
} from "@/lib/types/execution-graph";
import { mapExecutionEventsToGraph } from "@/lib/execution-graph-mapper";
import { ExecutionFlowNode } from "./execution-flow-node";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// ============================================================================
// Types
// ============================================================================

interface ExecutionFlowProps {
  events: DaprExecutionEvent[];
  onEventSelect?: (event: DaprExecutionEvent | null) => void;
  selectedEventId?: number | null;
  onRefresh?: () => void;
  className?: string;
}

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
  selectedEventId,
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
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

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
      <div className={cn("flex items-center justify-center h-full", className)}>
        <p className="text-muted-foreground">No execution events to display</p>
      </div>
    );
  }

  return (
    <div className={cn("relative h-full w-full min-h-[400px]", className)}>
      {/* Controls bar - Diagrid style */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-4">
        {onRefresh && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            className="text-teal-400 hover:text-teal-300 hover:bg-transparent gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        )}
        <div className="flex items-center gap-2">
          <Switch
            id="show-context"
            checked={showContext}
            onCheckedChange={setShowContext}
          />
          <label
            htmlFor="show-context"
            className="text-sm text-muted-foreground cursor-pointer"
          >
            Show context
          </label>
        </div>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        fitViewOptions={{
          padding: 0.3,
          maxZoom: 1.2,
        }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          className="!bg-[#1a1f2e]"
        />
        <Controls
          className="!bg-[#1e2433] !border !border-gray-700 !rounded-lg !shadow-sm [&>button]:!bg-[#1e2433] [&>button]:!border-gray-700 [&>button]:!text-gray-400 [&>button:hover]:!bg-gray-700"
          showInteractive={false}
        />
      </ReactFlow>
    </div>
  );
}
