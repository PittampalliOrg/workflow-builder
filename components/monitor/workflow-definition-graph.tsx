"use client";

import {
	Background,
	BackgroundVariant,
	Controls,
	type Edge,
	Handle,
	MarkerType,
	type Node,
	type NodeMouseHandler,
	type NodeProps,
	Position,
	ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WorkflowRuntimeGraph } from "@/lib/types/workflow-graph";
import { cn } from "@/lib/utils";

type WorkflowDefinitionGraphProps = {
	graph?: WorkflowRuntimeGraph;
	className?: string;
	onNodeSelect?: (nodeId: string | null) => void;
};

type RuntimeNode = Node<
	WorkflowRuntimeGraph["nodes"][number]["data"],
	"workflowRuntimeNode"
>;

function getNodePalette(status: RuntimeNode["data"]["status"]) {
	switch (status) {
		case "running":
			return {
				border: "#38bdf8",
				background: "rgba(56, 189, 248, 0.14)",
				badge: "bg-sky-500/20 text-sky-200",
			};
		case "success":
			return {
				border: "#22c55e",
				background: "rgba(34, 197, 94, 0.14)",
				badge: "bg-emerald-500/20 text-emerald-200",
			};
		case "error":
			return {
				border: "#ef4444",
				background: "rgba(239, 68, 68, 0.14)",
				badge: "bg-red-500/20 text-red-200",
			};
		case "waiting":
			return {
				border: "#f59e0b",
				background: "rgba(245, 158, 11, 0.14)",
				badge: "bg-amber-500/20 text-amber-100",
			};
		default:
			return {
				border: "#64748b",
				background: "rgba(100, 116, 139, 0.14)",
				badge: "bg-slate-500/20 text-slate-200",
			};
	}
}

function RuntimeNodeComponent({ data, selected }: NodeProps<RuntimeNode>) {
	const palette = getNodePalette(data.status);
	const isDecision = data.type === "if-else";
	const showTargetHandle = data.type !== "trigger";

	return (
		<>
			{showTargetHandle && (
				<Handle
					className="!h-2 !w-2 !border-0"
					position={Position.Top}
					style={{ backgroundColor: palette.border }}
					type="target"
				/>
			)}
			<div
				className={cn(
					"min-w-[190px] rounded-xl border-2 px-4 py-3 text-left shadow-sm transition-all",
					selected &&
						"ring-2 ring-sky-400 ring-offset-2 ring-offset-background",
					data.isCurrent && "shadow-sky-500/20",
				)}
				style={{
					backgroundColor: palette.background,
					borderColor: palette.border,
				}}
			>
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="truncate font-medium text-sm text-white">
							{data.label}
						</div>
						<div className="mt-1 text-[11px] uppercase tracking-wide text-slate-300">
							{data.type}
						</div>
					</div>
					<div
						className={cn(
							"rounded-full px-2 py-0.5 font-medium text-[10px] uppercase tracking-wide",
							palette.badge,
						)}
					>
						{data.status}
					</div>
				</div>
				{data.description ? (
					<p className="mt-2 line-clamp-2 text-xs text-slate-300">
						{data.description}
					</p>
				) : null}
				{data.error ? (
					<p className="mt-2 line-clamp-2 text-xs text-red-200">{data.error}</p>
				) : null}
			</div>
			{isDecision ? (
				<>
					<Handle
						className="!h-2 !w-2 !border-0"
						id="true"
						position={Position.Bottom}
						style={{
							backgroundColor: palette.border,
							left: "32%",
						}}
						type="source"
					/>
					<Handle
						className="!h-2 !w-2 !border-0"
						id="false"
						position={Position.Bottom}
						style={{
							backgroundColor: palette.border,
							left: "68%",
						}}
						type="source"
					/>
				</>
			) : (
				<Handle
					className="!h-2 !w-2 !border-0"
					position={Position.Bottom}
					style={{ backgroundColor: palette.border }}
					type="source"
				/>
			)}
		</>
	);
}

const nodeTypes = {
	workflowRuntimeNode: RuntimeNodeComponent,
};

function toReactFlowGraph(graph: WorkflowRuntimeGraph): {
	nodes: RuntimeNode[];
	edges: Edge[];
} {
	return {
		nodes: graph.nodes.map((node) => ({
			id: node.id,
			type: "workflowRuntimeNode",
			position: node.position,
			data: node.data,
		})),
		edges: graph.edges.map((edge) => {
			const color =
				edge.status === "active"
					? "#38bdf8"
					: edge.status === "traversed"
						? "#22c55e"
						: "#64748b";
			return {
				id: edge.id,
				source: edge.source,
				target: edge.target,
				sourceHandle: edge.sourceHandle ?? undefined,
				targetHandle: edge.targetHandle ?? undefined,
				type: "smoothstep",
				label: edge.label,
				animated: edge.status === "active",
				style: {
					stroke: color,
					strokeWidth: edge.status === "active" ? 3 : 2,
				},
				labelStyle: {
					fill: "#cbd5e1",
					fontSize: 11,
					fontWeight: 600,
				},
				markerEnd: {
					type: MarkerType.ArrowClosed,
					color,
				},
			};
		}),
	};
}

export function WorkflowDefinitionGraph({
	graph,
	className,
	onNodeSelect,
}: WorkflowDefinitionGraphProps) {
	const flowGraph = useMemo(
		() => (graph ? toReactFlowGraph(graph) : { nodes: [], edges: [] }),
		[graph],
	);

	const handleNodeClick: NodeMouseHandler = useCallback(
		(_, node) => {
			onNodeSelect?.(node.id);
		},
		[onNodeSelect],
	);

	const handlePaneClick = useCallback(() => {
		onNodeSelect?.(null);
	}, [onNodeSelect]);

	return (
		<Card
			className={cn(
				"h-full min-h-[400px] border-gray-700 bg-[#1a1f2e]",
				className,
			)}
		>
			<CardHeader className="pb-2">
				<CardTitle className="font-medium text-base text-gray-200">
					Workflow Graph
				</CardTitle>
				<p className="text-gray-500 text-xs">
					{graph
						? `${graph.source === "definition+runtime" ? "Definition with runtime overlay" : "Definition-only graph"} · ${graph.layout} layout`
						: "No workflow graph available"}
				</p>
			</CardHeader>
			<CardContent className="h-[420px] p-0">
				{graph ? (
					<ReactFlow
						edges={flowGraph.edges}
						elementsSelectable={true}
						fitView
						fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }}
						maxZoom={1.6}
						minZoom={0.3}
						nodes={flowGraph.nodes}
						nodesConnectable={false}
						nodesDraggable={false}
						nodeTypes={nodeTypes}
						onNodeClick={handleNodeClick}
						onPaneClick={handlePaneClick}
						panOnDrag
						proOptions={{ hideAttribution: true }}
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
				) : (
					<div className="flex h-full items-center justify-center text-sm text-slate-400">
						No workflow graph available
					</div>
				)}
			</CardContent>
		</Card>
	);
}
