"use client";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
	Handle,
	Position,
	useInternalNode,
	useNodeConnections,
	useNodeId,
} from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { Play, Square, XCircle } from "lucide-react";
import { AnimatedBorder } from "@/components/ui/animated-border";
import {
	getWorkflowHandleRule,
	type WorkflowHandleDataType,
} from "@/lib/workflow-connection-rules";
import {
	cancelNodeSimulationAtom,
	clearNodeSimulationResultAtom,
	isGeneratingAtom,
	insertNodeAtConnectionAtom,
	nodeSimulationResultsAtom,
	potentialConnectionAtom,
	removeConnectionSiteAtom,
	simulateNodeRunAtom,
	simulatingNodeIdsAtom,
	upsertConnectionSiteAtom,
	type WorkflowNodeType,
} from "@/lib/workflow-store";

export type NodeHandleSpec = {
	id?: string;
	position?: Position;
	className?: string;
	style?: CSSProperties;
	label?: string;
	dataType?: WorkflowHandleDataType;
	maxConnections?: number;
};

export type NodeProps = ComponentProps<typeof Card> & {
	handles: {
		target?: boolean;
		source?: boolean;
		targets?: NodeHandleSpec[];
		sources?: NodeHandleSpec[];
	};
	status?: "idle" | "running" | "success" | "error";
	selected?: boolean;
	runnable?: boolean;
	appendix?: ReactNode;
	appendixPosition?: "top" | "bottom" | "left" | "right";
};

function HandleWithInsert({
	handleType,
	id,
	position,
	className,
	style,
	label,
	dataType,
	maxConnections,
}: {
	handleType: "source" | "target";
	id?: string;
	position: Position;
	className?: string;
	style?: CSSProperties;
	label?: string;
	dataType?: WorkflowHandleDataType;
	maxConnections?: number;
}) {
	const nodeId = useNodeId();
	const insertNodeAtConnection = useSetAtom(insertNodeAtConnectionAtom);
	const upsertConnectionSite = useSetAtom(upsertConnectionSiteAtom);
	const removeConnectionSite = useSetAtom(removeConnectionSiteAtom);
	const potentialConnection = useAtomValue(potentialConnectionAtom);
	const isGenerating = useAtomValue(isGeneratingAtom);
	const internalNode = useInternalNode(nodeId ?? "");
	const connections = useNodeConnections({
		handleType,
		handleId: id,
	});

	const handleInfo = useMemo(() => {
		const bounds = internalNode?.internals.handleBounds?.[handleType];
		if (!bounds || bounds.length === 0) {
			return null;
		}

		if (id) {
			const byId = bounds.find((h) => h.id === id);
			if (byId) {
				return byId;
			}
		}

		return bounds.find((h) => h.position === position) ?? bounds[0] ?? null;
	}, [handleType, id, internalNode?.internals.handleBounds, position]);

	const handleRule = useMemo(() => {
		const defaultRule = getWorkflowHandleRule({
			nodeType: internalNode?.type as WorkflowNodeType | undefined,
			handleType,
			handleId: id,
		});
		return {
			...defaultRule,
			label: label ?? defaultRule.label,
			dataType: dataType ?? defaultRule.dataType,
			maxConnections: maxConnections ?? defaultRule.maxConnections,
		};
	}, [dataType, handleType, id, internalNode?.type, label, maxConnections]);

	const connectionSiteId = `${nodeId ?? "unknown"}:${handleType}:${id ?? "default"}`;
	const isPotentialConnection = potentialConnection?.id === connectionSiteId;
	const isAtConnectionLimit =
		typeof handleRule.maxConnections === "number" &&
		connections.length >= handleRule.maxConnections;
	const canInsert =
		Boolean(nodeId) &&
		Boolean(internalNode) &&
		Boolean(handleInfo) &&
		!isAtConnectionLimit &&
		!isGenerating &&
		(handleType === "source" || connections.length === 0);

	const handleCenter = useMemo(() => {
		if (!(internalNode && handleInfo)) {
			return null;
		}

		const baseX = internalNode.internals.positionAbsolute.x + handleInfo.x;
		const baseY = internalNode.internals.positionAbsolute.y + handleInfo.y;
		const width = handleInfo.width ?? 0;
		const height = handleInfo.height ?? 0;

		let x = baseX + width / 2;
		let y = baseY + height / 2;
		if (position === Position.Left) {
			x = baseX;
		} else if (position === Position.Right) {
			x = baseX + width;
		} else if (position === Position.Top) {
			y = baseY;
		} else if (position === Position.Bottom) {
			y = baseY + height;
		}

		return { x, y };
	}, [handleInfo, internalNode, position]);

	useEffect(() => {
		if (!(canInsert && handleCenter && nodeId)) {
			removeConnectionSite(connectionSiteId);
			return;
		}

		upsertConnectionSite({
			id: connectionSiteId,
			position: handleCenter,
			type: handleType,
			...(handleType === "source"
				? { source: { node: nodeId, handle: id ?? null } }
				: { target: { node: nodeId, handle: id ?? null } }),
		});

		return () => {
			removeConnectionSite(connectionSiteId);
		};
	}, [
		canInsert,
		connectionSiteId,
		handleCenter,
		handleType,
		id,
		nodeId,
		removeConnectionSite,
		upsertConnectionSite,
	]);

	const buttonStyle = useMemo(() => {
		if (!handleInfo) {
			return undefined;
		}

		const width = handleInfo.width ?? 0;
		const height = handleInfo.height ?? 0;
		const centerX = handleInfo.x + width / 2;
		const centerY = handleInfo.y + height / 2;
		const size = 24;
		const spacing = 8;

		switch (position) {
			case Position.Left:
				return {
					left: centerX - size - spacing,
					top: centerY - size / 2,
				};
			case Position.Right:
				return {
					left: centerX + spacing,
					top: centerY - size / 2,
				};
			case Position.Top:
				return {
					left: centerX - size / 2,
					top: centerY - size - spacing,
				};
			case Position.Bottom:
			default:
				return {
					left: centerX - size / 2,
					top: centerY + spacing,
				};
		}
	}, [handleInfo, position]);

	const labelStyle = useMemo(() => {
		if (!handleInfo) {
			return undefined;
		}

		const width = handleInfo.width ?? 0;
		const height = handleInfo.height ?? 0;
		const centerX = handleInfo.x + width / 2;
		const centerY = handleInfo.y + height / 2;
		const spacing = 10;

		switch (position) {
			case Position.Left:
				return {
					left: centerX + spacing,
					top: centerY - 8,
				};
			case Position.Right:
				return {
					left: centerX - 42,
					top: centerY - 8,
				};
			case Position.Top:
				return {
					left: centerX - 24,
					top: centerY + spacing,
				};
			case Position.Bottom:
			default:
				return {
					left: centerX - 24,
					top: centerY - spacing - 12,
				};
		}
	}, [handleInfo, position]);

	return (
		<>
			<Handle
				className={className}
				id={id}
				isConnectable={!isAtConnectionLimit}
				position={position}
				style={style}
				type={handleType}
			/>
			{handleRule.label ? (
				<div
					className="pointer-events-none absolute z-[5] rounded bg-background/80 px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground"
					style={labelStyle}
				>
					{handleRule.label}
				</div>
			) : null}
			{canInsert && handleCenter && nodeId ? (
				<button
					className={cn(
						"nodrag nopan absolute z-10 flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground",
						isPotentialConnection ? "border-primary text-primary" : "border-border",
					)}
					onClick={(event) => {
						event.stopPropagation();
						const xOffset = handleType === "source" ? 140 : -140;
						insertNodeAtConnection({
							position: { x: handleCenter.x + xOffset, y: handleCenter.y },
							...(handleType === "source"
								? { source: { node: nodeId, handle: id ?? null } }
								: { target: { node: nodeId, handle: id ?? null } }),
							nodeType: "action",
						});
					}}
					title="Insert step"
					type="button"
					style={buttonStyle}
				>
					<span className="relative -top-px text-sm leading-none">+</span>
				</button>
			) : null}
		</>
	);
}

export function Node({
	handles,
	className,
	status,
	selected,
	runnable,
	appendix,
	appendixPosition = "bottom",
	...props
}: NodeProps) {
	const nodeId = useNodeId();
	const sourceConnections = useNodeConnections({ handleType: "source" });
	const targetConnections = useNodeConnections({ handleType: "target" });
	const simulatingNodeIds = useAtomValue(simulatingNodeIdsAtom);
	const simulationResults = useAtomValue(nodeSimulationResultsAtom);
	const runSimulation = useSetAtom(simulateNodeRunAtom);
	const cancelSimulation = useSetAtom(cancelNodeSimulationAtom);
	const clearSimulationResult = useSetAtom(clearNodeSimulationResultAtom);
	const isGenerating = useAtomValue(isGeneratingAtom);

	const isSimulating = nodeId ? simulatingNodeIds.has(nodeId) : false;
	const simulationResult = nodeId ? simulationResults[nodeId] : undefined;

	return (
		<Card
			className={cn(
				"node-container relative size-full h-auto w-sm gap-0 rounded-md bg-card p-0 transition-all duration-200",
				status === "success" && "border-green-500 border-2",
				status === "error" && "border-red-500 border-2",
				className,
			)}
			{...props}
		>
			{status === "running" && <AnimatedBorder />}
			{runnable && nodeId ? (
				<div className="absolute left-2 top-2 z-20 flex items-center gap-1">
					<Button
						className="size-6 rounded-full p-0"
						disabled={isGenerating}
						onClick={(event) => {
							event.stopPropagation();
							if (isSimulating) {
								cancelSimulation(nodeId);
								return;
							}
							void runSimulation({ nodeId });
						}}
						size="icon"
						title={isSimulating ? "Cancel dry run" : "Dry run step"}
						variant="outline"
					>
						{isSimulating ? (
							<Square className="size-3.5" />
						) : (
							<Play className="size-3.5" />
						)}
					</Button>
					{simulationResult ? (
						<Button
							className="size-6 rounded-full p-0"
							onClick={(event) => {
								event.stopPropagation();
								clearSimulationResult(nodeId);
							}}
							size="icon"
							title="Clear dry run result"
							variant="outline"
						>
							<XCircle className="size-3.5" />
						</Button>
					) : null}
				</div>
			) : null}

			{handles.target && (
				<HandleWithInsert handleType="target" position={Position.Left} />
			)}
			{(handles.targets || []).map((h) => (
				<HandleWithInsert
					className={h.className}
					dataType={h.dataType}
					id={h.id}
					key={h.id || "target"}
					label={h.label}
					maxConnections={h.maxConnections}
					position={h.position ?? Position.Left}
					style={h.style}
					handleType="target"
				/>
			))}
			{handles.source && (
				<HandleWithInsert handleType="source" position={Position.Right} />
			)}
			{(handles.sources || []).map((h) => (
				<HandleWithInsert
					className={h.className}
					dataType={h.dataType}
					id={h.id}
					key={h.id || "source"}
					label={h.label}
					maxConnections={h.maxConnections}
					position={h.position ?? Position.Right}
					style={h.style}
					handleType="source"
				/>
			))}

			{props.children}

			{selected || simulationResult || appendix ? (
				<NodeAppendix position={appendixPosition}>
					{appendix ?? (
						<div className="w-full text-[10px] text-muted-foreground">
							<div className="flex items-center justify-between">
								<span>Inputs</span>
								<span>{targetConnections.length}</span>
							</div>
							<div className="flex items-center justify-between">
								<span>Outputs</span>
								<span>{sourceConnections.length}</span>
							</div>
							{simulationResult ? (
								<div
									className={cn(
										"mt-1 truncate font-medium",
										simulationResult.status === "success"
											? "text-green-600 dark:text-green-400"
											: "text-red-600 dark:text-red-400",
									)}
								>
									{simulationResult.summary}
								</div>
							) : null}
						</div>
					)}
				</NodeAppendix>
			) : null}
		</Card>
	);
}

export type NodeAppendixProps = ComponentProps<"div"> & {
	position?: "top" | "bottom" | "left" | "right";
};

export function NodeAppendix({
	children,
	className,
	position = "bottom",
	...props
}: NodeAppendixProps) {
	return (
		<div
			className={cn(
				"pointer-events-none absolute z-10 flex min-w-[120px] flex-col rounded-md border bg-card/90 p-1.5 text-card-foreground shadow-sm",
				position === "top" && "-my-1 left-1/2 -translate-x-1/2 -translate-y-full",
				position === "bottom" && "my-1 left-1/2 top-full -translate-x-1/2",
				position === "left" && "-mx-1 left-0 top-1/2 -translate-x-full -translate-y-1/2",
				position === "right" && "-mx-1 left-full top-1/2 -translate-y-1/2",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

export type NodeHeaderProps = ComponentProps<typeof CardHeader>;

export const NodeHeader = ({ className, ...props }: NodeHeaderProps) => (
  <CardHeader
    className={cn("gap-0.5 rounded-t-md border-b bg-secondary p-3!", className)}
    {...props}
  />
);

export type NodeTitleProps = ComponentProps<typeof CardTitle>;

export const NodeTitle = (props: NodeTitleProps) => <CardTitle {...props} />;

export type NodeDescriptionProps = ComponentProps<typeof CardDescription>;

export const NodeDescription = (props: NodeDescriptionProps) => (
  <CardDescription {...props} />
);

export type NodeActionProps = ComponentProps<typeof CardAction>;

export const NodeAction = (props: NodeActionProps) => <CardAction {...props} />;

export type NodeContentProps = ComponentProps<typeof CardContent>;

export const NodeContent = ({ className, ...props }: NodeContentProps) => (
  <CardContent className={cn("rounded-b-md bg-card p-3", className)} {...props} />
);

export type NodeFooterProps = ComponentProps<typeof CardFooter>;

export const NodeFooter = ({ className, ...props }: NodeFooterProps) => (
  <CardFooter
    className={cn("rounded-b-md border-t bg-secondary p-3!", className)}
    {...props}
  />
);
