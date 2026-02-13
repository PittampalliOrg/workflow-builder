import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import { SimpleNode } from "./SimpleNode";
import type { Workflow } from "../App";
import type { WorkflowApi } from "../hooks/useWorkflowApi";

interface Props {
  workflow: Workflow | null;
  loading: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  api: WorkflowApi;
  onRefresh: () => void;
}

const nodeTypes = { default: SimpleNode };

export function GraphView({
  workflow,
  loading,
  selectedNodeId,
  onSelectNode,
  api,
  onRefresh,
}: Props) {
  const nodes: Node[] = useMemo(() => {
    if (!workflow) return [];
    return workflow.nodes.map((n) => ({
      id: n.id,
      type: "default",
      position: n.position,
      data: n.data,
      selected: n.id === selectedNodeId,
    }));
  }, [workflow, selectedNodeId]);

  const edges: Edge[] = useMemo(() => {
    if (!workflow) return [];
    return workflow.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      type: "smoothstep",
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: { strokeWidth: 2 },
    }));
  }, [workflow]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      onSelectNode(node.id);
    },
    [onSelectNode],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (!workflow) return;
      api
        .updateNode(workflow.id, node.id, {
          position_x: node.position.x,
          position_y: node.position.y,
        })
        .catch(() => {});
    },
    [workflow, api],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!workflow || !connection.source || !connection.target) return;
      api
        .connectNodes(
          workflow.id,
          connection.source,
          connection.target,
          connection.sourceHandle ?? undefined,
          connection.targetHandle ?? undefined,
        )
        .then(() => onRefresh())
        .catch(() => {});
    },
    [workflow, api, onRefresh],
  );

  const onPaneClick = useCallback(() => {
    onSelectNode(null);
  }, [onSelectNode]);

  if (!workflow) {
    return (
      <div className="graph-empty">
        <svg width="36" height="36" viewBox="0 0 48 48" fill="none">
          <rect x="6" y="8" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
          <rect x="28" y="8" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
          <rect x="17" y="30" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M13 18v6l11 6M35 18v6l-11 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <p>Select a workflow to view its graph</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="graph-empty">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="graph-container">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onPaneClick={onPaneClick}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
