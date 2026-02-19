"use client";

import { useAtomValue } from "jotai";
import { Bug, ChevronDown, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	nodesAtom,
	edgesAtom,
	selectedNodeAtom,
	selectedEdgeAtom,
	isExecutingAtom,
	isLoadingAtom,
	isGeneratingAtom,
	isSavingAtom,
	currentWorkflowIdAtom,
	currentWorkflowNameAtom,
	currentWorkflowVisibilityAtom,
	currentWorkflowEngineTypeAtom,
	isWorkflowOwnerAtom,
	propertiesPanelActiveTabAtom,
	showMinimapAtom,
	selectedExecutionIdAtom,
	rightPanelWidthAtom,
	isPanelAnimatingAtom,
	hasSidebarBeenShownAtom,
	isSidebarCollapsedAtom,
	isTransitioningFromHomepageAtom,
	pendingIntegrationNodesAtom,
	newlyCreatedNodeIdAtom,
	triggerExecuteAtom,
	executionLogsAtom,
	hasUnsavedChangesAtom,
	workflowNotFoundAtom,
	canUndoAtom,
	canRedoAtom,
	currentRunningNodeIdAtom,
	daprPhaseAtom,
	daprProgressAtom,
	daprMessageAtom,
	daprInstanceIdAtom,
	approvalEventNameAtom,
	approvalExecutionIdAtom,
	approvalRespondedAtom,
	fitViewRequestAtom,
} from "@/lib/workflow-store";

type SectionProps = {
	title: string;
	defaultOpen?: boolean;
	children: React.ReactNode;
};

function Section({ title, defaultOpen = false, children }: SectionProps) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="border-b border-border/50 last:border-b-0">
			<button
				type="button"
				className="flex w-full items-center gap-1 px-2 py-1 text-left text-xs font-semibold hover:bg-muted/50"
				onClick={() => setOpen(!open)}
			>
				{open ? (
					<ChevronDown className="size-3 shrink-0" />
				) : (
					<ChevronRight className="size-3 shrink-0" />
				)}
				{title}
			</button>
			{open && <div className="px-2 pb-2">{children}</div>}
		</div>
	);
}

type RowProps = {
	label: string;
	value: unknown;
};

function Row({ label, value }: RowProps) {
	const formatted = useMemo(() => {
		if (value === null || value === undefined) return "null";
		if (typeof value === "boolean") return value ? "true" : "false";
		if (typeof value === "number") return String(value);
		if (typeof value === "string") return value || '""';
		if (value instanceof Set) return `Set(${value.size})`;
		if (value instanceof Map) return `Map(${value.size})`;
		if (Array.isArray(value)) return `Array(${value.length})`;
		if (typeof value === "object") return `{${Object.keys(value).length} keys}`;
		return String(value);
	}, [value]);

	const colorClass = useMemo(() => {
		if (value === null || value === undefined)
			return "text-muted-foreground/60";
		if (typeof value === "boolean")
			return value ? "text-green-500" : "text-red-400";
		if (typeof value === "number") return "text-blue-400";
		if (typeof value === "string") return "text-amber-500";
		return "text-purple-400";
	}, [value]);

	return (
		<div className="flex items-baseline justify-between gap-2 py-0.5 font-mono text-[10px] leading-tight">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className={`truncate text-right ${colorClass}`}>{formatted}</span>
		</div>
	);
}

export function DebugPanel() {
	const [open, setOpen] = useState(false);

	// Toggle via Ctrl+Shift+D
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.ctrlKey && e.shiftKey && e.key === "D") {
				e.preventDefault();
				setOpen((prev) => !prev);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, []);

	// Only in development
	if (process.env.NODE_ENV !== "development") return null;

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="pointer-events-auto fixed bottom-14 left-3 z-[100] flex size-8 items-center justify-center rounded-full border bg-background/90 shadow-sm backdrop-blur hover:bg-muted"
				title="Debug Panel (Ctrl+Shift+D)"
			>
				<Bug className="size-4 text-muted-foreground" />
			</button>
		);
	}

	return (
		<div className="pointer-events-auto fixed bottom-14 left-3 z-[100] flex max-h-[70vh] w-72 flex-col overflow-hidden rounded-lg border bg-background/95 shadow-lg backdrop-blur">
			<DebugPanelContent onClose={() => setOpen(false)} />
		</div>
	);
}

function DebugPanelContent({ onClose }: { onClose: () => void }) {
	// Canvas data
	const nodes = useAtomValue(nodesAtom);
	const edges = useAtomValue(edgesAtom);
	const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
	const currentWorkflowName = useAtomValue(currentWorkflowNameAtom);
	const currentWorkflowVisibility = useAtomValue(currentWorkflowVisibilityAtom);
	const engineType = useAtomValue(currentWorkflowEngineTypeAtom);
	const isOwner = useAtomValue(isWorkflowOwnerAtom);

	// Selection
	const selectedNode = useAtomValue(selectedNodeAtom);
	const selectedEdge = useAtomValue(selectedEdgeAtom);
	const newlyCreatedNodeId = useAtomValue(newlyCreatedNodeIdAtom);
	const pendingIntegrationNodes = useAtomValue(pendingIntegrationNodesAtom);

	// UI state
	const activeTab = useAtomValue(propertiesPanelActiveTabAtom);
	const showMinimap = useAtomValue(showMinimapAtom);
	const rightPanelWidth = useAtomValue(rightPanelWidthAtom);
	const isPanelAnimating = useAtomValue(isPanelAnimatingAtom);
	const hasSidebarBeenShown = useAtomValue(hasSidebarBeenShownAtom);
	const isSidebarCollapsed = useAtomValue(isSidebarCollapsedAtom);
	const isTransitioning = useAtomValue(isTransitioningFromHomepageAtom);
	const fitViewRequest = useAtomValue(fitViewRequestAtom);

	// Loading/saving
	const isExecuting = useAtomValue(isExecutingAtom);
	const isLoading = useAtomValue(isLoadingAtom);
	const isGenerating = useAtomValue(isGeneratingAtom);
	const isSaving = useAtomValue(isSavingAtom);
	const hasUnsavedChanges = useAtomValue(hasUnsavedChangesAtom);
	const triggerExecute = useAtomValue(triggerExecuteAtom);
	const workflowNotFound = useAtomValue(workflowNotFoundAtom);

	// Undo/redo
	const canUndo = useAtomValue(canUndoAtom);
	const canRedo = useAtomValue(canRedoAtom);

	// Execution
	const executionLogs = useAtomValue(executionLogsAtom);
	const selectedExecutionId = useAtomValue(selectedExecutionIdAtom);
	const currentRunningNodeId = useAtomValue(currentRunningNodeIdAtom);

	// Dapr
	const daprPhase = useAtomValue(daprPhaseAtom);
	const daprProgress = useAtomValue(daprProgressAtom);
	const daprMessage = useAtomValue(daprMessageAtom);
	const daprInstanceId = useAtomValue(daprInstanceIdAtom);

	// Approval
	const approvalEventName = useAtomValue(approvalEventNameAtom);
	const approvalExecutionId = useAtomValue(approvalExecutionIdAtom);
	const approvalResponded = useAtomValue(approvalRespondedAtom);

	// Derived
	const nodeTypeCounts = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const node of nodes) {
			const t = (node.data?.type || node.type || "unknown") as string;
			counts[t] = (counts[t] || 0) + 1;
		}
		return counts;
	}, [nodes]);

	const selectedNodeData = useMemo(
		() => (selectedNode ? nodes.find((n) => n.id === selectedNode) : null),
		[selectedNode, nodes],
	);

	const executionLogCount = useMemo(
		() => Object.keys(executionLogs).length,
		[executionLogs],
	);

	const [copyFeedback, setCopyFeedback] = useState(false);
	const handleCopyState = useCallback(() => {
		const state = {
			workflow: {
				id: currentWorkflowId,
				name: currentWorkflowName,
				visibility: currentWorkflowVisibility,
				engine: engineType,
				isOwner,
			},
			nodes: nodes.length,
			edges: edges.length,
			nodeTypeCounts,
			selection: { node: selectedNode, edge: selectedEdge },
			flags: {
				isExecuting,
				isLoading,
				isGenerating,
				isSaving,
				hasUnsavedChanges,
				workflowNotFound,
			},
			dapr: {
				phase: daprPhase,
				progress: daprProgress,
				instanceId: daprInstanceId,
			},
		};
		navigator.clipboard.writeText(JSON.stringify(state, null, 2));
		setCopyFeedback(true);
		setTimeout(() => setCopyFeedback(false), 1500);
	}, [
		currentWorkflowId,
		currentWorkflowName,
		currentWorkflowVisibility,
		engineType,
		isOwner,
		nodes.length,
		edges.length,
		nodeTypeCounts,
		selectedNode,
		selectedEdge,
		isExecuting,
		isLoading,
		isGenerating,
		isSaving,
		hasUnsavedChanges,
		workflowNotFound,
		daprPhase,
		daprProgress,
		daprInstanceId,
	]);

	return (
		<>
			{/* Header */}
			<div className="flex items-center justify-between border-b px-2 py-1.5">
				<div className="flex items-center gap-1.5">
					<Bug className="size-3.5 text-muted-foreground" />
					<span className="font-semibold text-xs">Jotai State</span>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={handleCopyState}
						className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
					>
						{copyFeedback ? "Copied!" : "Copy"}
					</button>
					<button
						type="button"
						onClick={onClose}
						className="rounded p-0.5 hover:bg-muted"
					>
						<X className="size-3.5" />
					</button>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto">
				<Section title="Workflow" defaultOpen>
					<Row label="id" value={currentWorkflowId} />
					<Row label="name" value={currentWorkflowName} />
					<Row label="visibility" value={currentWorkflowVisibility} />
					<Row label="engine" value={engineType} />
					<Row label="isOwner" value={isOwner} />
					<Row label="notFound" value={workflowNotFound} />
				</Section>

				<Section title="Canvas" defaultOpen>
					<Row label="nodes" value={nodes.length} />
					<Row label="edges" value={edges.length} />
					{Object.entries(nodeTypeCounts).map(([type, count]) => (
						<Row key={type} label={`  ${type}`} value={count} />
					))}
				</Section>

				<Section title="Selection">
					<Row label="selectedNode" value={selectedNode} />
					<Row label="selectedEdge" value={selectedEdge} />
					<Row label="nodeLabel" value={selectedNodeData?.data?.label} />
					<Row label="nodeType" value={selectedNodeData?.data?.type} />
					<Row
						label="actionType"
						value={
							selectedNodeData?.data?.config?.actionType as string | undefined
						}
					/>
					<Row label="newlyCreated" value={newlyCreatedNodeId} />
					<Row label="pendingIntegrations" value={pendingIntegrationNodes} />
				</Section>

				<Section title="Flags">
					<Row label="isExecuting" value={isExecuting} />
					<Row label="isLoading" value={isLoading} />
					<Row label="isGenerating" value={isGenerating} />
					<Row label="isSaving" value={isSaving} />
					<Row label="hasUnsavedChanges" value={hasUnsavedChanges} />
					<Row label="triggerExecute" value={triggerExecute} />
					<Row label="canUndo" value={canUndo} />
					<Row label="canRedo" value={canRedo} />
				</Section>

				<Section title="UI">
					<Row label="activeTab" value={activeTab} />
					<Row label="rightPanelWidth" value={rightPanelWidth} />
					<Row label="showMinimap" value={showMinimap} />
					<Row label="isPanelAnimating" value={isPanelAnimating} />
					<Row label="sidebarCollapsed" value={isSidebarCollapsed} />
					<Row label="sidebarShown" value={hasSidebarBeenShown} />
					<Row label="transitioning" value={isTransitioning} />
					<Row label="fitViewRequest" value={fitViewRequest} />
				</Section>

				<Section title="Execution">
					<Row label="selectedExecution" value={selectedExecutionId} />
					<Row label="currentRunningNode" value={currentRunningNodeId} />
					<Row label="executionLogs" value={executionLogCount} />
				</Section>

				<Section title="Dapr">
					<Row label="phase" value={daprPhase} />
					<Row label="progress" value={daprProgress} />
					<Row label="message" value={daprMessage} />
					<Row label="instanceId" value={daprInstanceId} />
				</Section>

				<Section title="Approval">
					<Row label="eventName" value={approvalEventName} />
					<Row label="executionId" value={approvalExecutionId} />
					<Row label="responded" value={approvalResponded} />
				</Section>
			</div>
		</>
	);
}
