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
import { Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WorkflowRuntimeGraph } from "@/lib/types/workflow-graph";
import { cn } from "@/lib/utils";

type WorkflowDefinitionGraphProps = {
	graph?: WorkflowRuntimeGraph;
	className?: string;
	onNodeSelect?: (nodeId: string | null) => void;
	showContext?: boolean;
	onShowContextChange?: (v: boolean) => void;
};

type RuntimeNode = Node<
	WorkflowRuntimeGraph["nodes"][number]["data"] & { showContext?: boolean },
	"workflowRuntimeNode"
>;

function getNodePalette(status: RuntimeNode["data"]["status"]) {
	switch (status) {
		case "running":
			return {
				border: "#38bdf8",
				background: "rgba(56, 189, 248, 0.08)",
				badge: "bg-sky-500/20 text-sky-700 dark:text-sky-200",
			};
		case "success":
			return {
				border: "#22c55e",
				background: "rgba(34, 197, 94, 0.08)",
				badge: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-200",
			};
		case "error":
			return {
				border: "#ef4444",
				background: "rgba(239, 68, 68, 0.08)",
				badge: "bg-red-500/20 text-red-700 dark:text-red-200",
			};
		case "waiting":
			return {
				border: "#f59e0b",
				background: "rgba(245, 158, 11, 0.08)",
				badge: "bg-amber-500/20 text-amber-700 dark:text-amber-100",
			};
		default:
			return {
				border: "#64748b",
				background: "rgba(100, 116, 139, 0.08)",
				badge: "bg-slate-500/20 text-slate-700 dark:text-slate-200",
			};
	}
}

function RuntimeNodeComponent({ data, selected }: NodeProps<RuntimeNode>) {
	const palette = getNodePalette(data.status);
	const isDecision = data.type === "if-else";
	const labelLower = data.label?.toLowerCase() ?? "";
	const isStartOrEnd =
		data.type === "trigger" ||
		labelLower === "start" ||
		labelLower === "end";
	const isEnd = labelLower === "end";
	const isStart = data.type === "trigger" || labelLower === "start";
	const isActivity = data.type === "action" || data.type === "activity";

	// --- Start / End pill nodes ---
	if (isStartOrEnd) {
		return (
			<>
				{!isStart && (
					<Handle
						className="!h-2 !w-2 !border-0"
						position={Position.Top}
						style={{ backgroundColor: palette.border }}
						type="target"
					/>
				)}
				<div
					className={cn(
						"min-w-[120px] rounded-full border-2 border-dashed px-6 py-2.5 text-center shadow-sm transition-all",
						selected &&
							"ring-2 ring-sky-400 ring-offset-2 ring-offset-background",
					)}
					style={{
						borderColor: palette.border,
						backgroundColor: palette.background,
					}}
				>
					<div className="font-medium text-sm text-gray-900 dark:text-white">
						{data.label}
					</div>
				</div>
				{!isEnd && (
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

	// --- Activity / Action nodes ---
	if (isActivity) {
		return (
			<>
				<Handle
					className="!h-2 !w-2 !border-0"
					position={Position.Top}
					style={{ backgroundColor: palette.border }}
					type="target"
				/>
				<div
					className={cn(
						"min-w-[190px] flex items-center rounded-lg border-2 shadow-sm transition-all",
						selected &&
							"ring-2 ring-sky-400 ring-offset-2 ring-offset-background",
						data.isCurrent && "shadow-sky-500/20",
					)}
					style={{
						borderColor: palette.border,
						backgroundColor: palette.background,
					}}
				>
					<div className="flex-1 px-4 py-3 min-w-0">
						<div className="truncate font-medium text-sm text-gray-900 dark:text-white">
							{data.label}
						</div>
						{data.showContext && data.description ? (
							<p className="mt-2 text-xs text-gray-500 dark:text-slate-300">
								{data.description}
							</p>
						) : data.description ? (
							<p className="mt-2 line-clamp-2 text-xs text-gray-500 dark:text-slate-300">
								{data.description}
							</p>
						) : null}
						{data.showContext &&
							data.config &&
							Object.keys(data.config).length > 0 && (
								<div className="mt-2 space-y-0.5">
									{Object.entries(data.config)
										.slice(0, 5)
										.map(([key, val]) => (
											<div
												key={key}
												className="text-[10px] text-gray-400 dark:text-slate-400 truncate"
											>
												<span className="font-medium">{key}:</span>{" "}
												{typeof val === "string"
													? val
													: JSON.stringify(val)}
											</div>
										))}
								</div>
							)}
						{data.error ? (
							<p className="mt-2 line-clamp-2 text-xs text-red-600 dark:text-red-200">
								{data.error}
							</p>
						) : null}
					</div>
					{/* Activity icon badge on right side */}
					<div
						className="flex h-full items-center rounded-r-md px-2 py-3"
						style={{ backgroundColor: palette.border }}
					>
						<svg
							className="size-4 text-white"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
						>
							<path d="M6 3v18M18 3v18M6 12h12" />
						</svg>
					</div>
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

	// --- All other node types (if-else, timer, approval-gate, etc.) ---
	return (
		<>
			<Handle
				className="!h-2 !w-2 !border-0"
				position={Position.Top}
				style={{ backgroundColor: palette.border }}
				type="target"
			/>
			<div
				className={cn(
					"min-w-[190px] rounded-lg border-2 px-4 py-3 text-left shadow-sm transition-all",
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
						<div className="truncate font-medium text-sm text-gray-900 dark:text-white">
							{data.label}
						</div>
						<div className="mt-0.5 text-[11px] uppercase tracking-wide text-gray-500 dark:text-slate-300">
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
					<p
						className={cn(
							"mt-2 text-xs text-gray-500 dark:text-slate-300",
							!data.showContext && "line-clamp-2",
						)}
					>
						{data.description}
					</p>
				) : null}
				{data.showContext &&
					data.config &&
					Object.keys(data.config).length > 0 && (
						<div className="mt-2 space-y-0.5">
							{Object.entries(data.config)
								.slice(0, 5)
								.map(([key, val]) => (
									<div
										key={key}
										className="text-[10px] text-gray-400 dark:text-slate-400 truncate"
									>
										<span className="font-medium">{key}:</span>{" "}
										{typeof val === "string"
											? val
											: JSON.stringify(val)}
									</div>
								))}
						</div>
					)}
				{data.error ? (
					<p className="mt-2 line-clamp-2 text-xs text-red-600 dark:text-red-200">
						{data.error}
					</p>
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

function toReactFlowGraph(
	graph: WorkflowRuntimeGraph,
	showContext?: boolean,
): {
	nodes: RuntimeNode[];
	edges: Edge[];
} {
	return {
		nodes: graph.nodes.map((node) => ({
			id: node.id,
			type: "workflowRuntimeNode",
			position: node.position,
			data: { ...node.data, showContext: showContext ?? false },
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
					...(edge.status === "traversed"
						? { strokeDasharray: "8 4" }
						: {}),
				},
				labelStyle: {
					fill: "#374151",
					fontSize: 11,
					fontWeight: 600,
				},
				labelBgStyle: {
					fill: "white",
					fillOpacity: 0.85,
				},
				labelBgPadding: [4, 6] as [number, number],
				labelBgBorderRadius: 4,
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
	showContext,
}: WorkflowDefinitionGraphProps) {
	const [isFullscreen, setIsFullscreen] = useState(false);

	const flowGraph = useMemo(
		() =>
			graph
				? toReactFlowGraph(graph, showContext)
				: { nodes: [], edges: [] },
		[graph, showContext],
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
				"border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950",
				isFullscreen
					? "fixed inset-0 z-50 rounded-none"
					: "h-full min-h-[400px]",
				className,
			)}
		>
			<CardHeader className="pb-2">
				<CardTitle className="font-medium text-base text-foreground">
					Workflow Graph
				</CardTitle>
				<p className="text-gray-500 text-xs">
					{graph
						? `${graph.source === "definition+runtime" ? "Definition with runtime overlay" : "Definition-only graph"} · ${graph.layout} layout`
						: "No workflow graph available"}
				</p>
			</CardHeader>
			<CardContent
				className={cn(
					"p-0 relative",
					isFullscreen ? "h-[calc(100vh-60px)]" : "h-[420px]",
				)}
			>
				{graph ? (
					<>
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
								className="!bg-white dark:!bg-gray-950"
								color="transparent"
								gap={20}
								size={0}
								variant={BackgroundVariant.Dots}
							/>
							<Controls
								className="!bg-white dark:!bg-gray-900 !border !border-gray-200 dark:!border-gray-700 !rounded-lg [&>button]:!bg-white dark:[&>button]:!bg-gray-900 [&>button]:!border-gray-200 dark:[&>button]:!border-gray-700 [&>button]:!text-gray-600 dark:[&>button]:!text-gray-400 [&>button:hover]:!bg-gray-100 dark:[&>button:hover]:!bg-gray-700"
								showInteractive={false}
							/>
						</ReactFlow>
						<button
							type="button"
							className="absolute top-2 right-2 z-10 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
							onClick={() => setIsFullscreen((f) => !f)}
						>
							{isFullscreen ? (
								<Minimize2 className="size-4" />
							) : (
								<Maximize2 className="size-4" />
							)}
						</button>
					</>
				) : (
					<div className="flex h-full items-center justify-center text-sm text-slate-400">
						No workflow graph available
					</div>
				)}
			</CardContent>
		</Card>
	);
}
