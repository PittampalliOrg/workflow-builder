import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	Copy,
	Eraser,
	Eye,
	EyeOff,
	FileCode,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";
import {
	getRequiredConnectionForAction,
	requiresConnectionForIntegration,
} from "@/lib/actions/connection-utils";
import { getNodeCodeFile } from "@/lib/code-generation";
import { connectionsAtom } from "@/lib/connections-store";
import {
	clearNodeStatusesAtom,
	currentWorkflowIdAtom,
	currentWorkflowNameAtom,
	deleteEdgeAtom,
	deleteNodeAtom,
	deleteSelectedItemsAtom,
	edgesAtom,
	isGeneratingAtom,
	isWorkflowOwnerAtom,
	morphNodeTypeAtom,
	newlyCreatedNodeIdAtom,
	nodesAtom,
	pendingIntegrationNodesAtom,
	propertiesPanelActiveTabAtom,
	selectedEdgeAtom,
	selectedNodeAtom,
	showClearDialogAtom,
	showDeleteDialogAtom,
	updateNodeDataAtom,
} from "@/lib/workflow-store";
import { usePiecesCatalog } from "@/lib/actions/pieces-store";
import type { IntegrationType } from "@/lib/actions/types";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { AiChatPanel } from "./ai-chat-panel";
import { ActionConfig } from "./config/action-config";
import { ActionGrid, type ActionSelection } from "./config/action-grid";
import { ActivityConfig } from "./config/activity-config";
import { ApprovalGateConfig } from "./config/approval-gate-config";
import { IfElseConfig } from "./config/if-else-config";
import { LoopUntilConfig } from "./config/loop-until-config";
import { NoteConfig } from "./config/note-config";
import { SetStateConfig } from "./config/set-state-config";
import { SubWorkflowConfig } from "./config/sub-workflow-config";
import { TimerConfig } from "./config/timer-config";
import { TransformConfig } from "./config/transform-config";
import { TriggerConfig } from "./config/trigger-config";
import { WhileConfig } from "./config/while-config";
import { WorkflowRuns } from "./workflow-runs";

// System actions that need integrations (not in plugin registry)
const SYSTEM_ACTION_INTEGRATIONS: Record<string, IntegrationType> = {
	"system/database-query": "database",
};

function buildConnectionAuthTemplate(externalId: string): string {
	return `{{connections['${externalId}']}}`;
}

function getExternalIdFromAuthTemplate(
	auth: string | undefined,
): string | undefined {
	if (!auth) return undefined;
	const match = auth.match(/\{\{connections\['([^']+)'\]\}\}/);
	return match?.[1];
}

function applyConnectionConfig(
	config: Record<string, unknown> | undefined,
	integration: { id: string; externalId?: string },
): Record<string, unknown> {
	return {
		...(config ?? {}),
		integrationId: integration.id,
		...(integration.externalId
			? { auth: buildConnectionAuthTemplate(integration.externalId) }
			: {}),
	};
}

function clearConnectionConfig(
	config: Record<string, unknown> | undefined,
): Record<string, unknown> {
	return {
		...(config ?? {}),
		integrationId: undefined,
		auth: undefined,
	};
}

// Multi-selection panel component
const MultiSelectionPanel = ({
	selectedNodes,
	selectedEdges,
	onDelete,
}: {
	selectedNodes: { id: string; selected?: boolean }[];
	selectedEdges: { id: string; selected?: boolean }[];
	onDelete: () => void;
}) => {
	const [showDeleteAlert, setShowDeleteAlert] = useState(false);

	const nodeText = selectedNodes.length === 1 ? "node" : "nodes";
	const edgeText = selectedEdges.length === 1 ? "line" : "lines";
	const selectionParts: string[] = [];

	if (selectedNodes.length > 0) {
		selectionParts.push(`${selectedNodes.length} ${nodeText}`);
	}
	if (selectedEdges.length > 0) {
		selectionParts.push(`${selectedEdges.length} ${edgeText}`);
	}

	const selectionText = selectionParts.join(" and ");

	const handleDelete = () => {
		onDelete();
		setShowDeleteAlert(false);
	};

	return (
		<>
			<div className="flex size-full flex-col">
				<div className="flex h-14 w-full shrink-0 items-center border-b bg-transparent px-4">
					<h2 className="font-semibold text-foreground">Properties</h2>
				</div>
				<div className="flex-1 space-y-4 overflow-y-auto p-4">
					<div className="space-y-2">
						<Label>Selection</Label>
						<p className="text-muted-foreground text-sm">
							{selectionText} selected
						</p>
					</div>

					<div className="flex items-center gap-2 pt-4">
						<Button
							className="text-muted-foreground"
							onClick={() => setShowDeleteAlert(true)}
							size="sm"
							variant="ghost"
						>
							<Trash2 className="mr-2 size-4" />
							Delete
						</Button>
					</div>
				</div>
			</div>

			<AlertDialog onOpenChange={setShowDeleteAlert} open={showDeleteAlert}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete Selected Items</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete {selectionText}? This action
							cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Complex UI logic with multiple conditions
export const PanelInner = () => {
	const { findActionById } = usePiecesCatalog();
	const [selectedNodeId] = useAtom(selectedNodeAtom);
	const [selectedEdgeId] = useAtom(selectedEdgeAtom);
	const [nodes] = useAtom(nodesAtom);
	const edges = useAtomValue(edgesAtom);
	const [isGenerating] = useAtom(isGeneratingAtom);
	const [currentWorkflowId] = useAtom(currentWorkflowIdAtom);
	const [currentWorkflowName, setCurrentWorkflowName] = useAtom(
		currentWorkflowNameAtom,
	);
	const isOwner = useAtomValue(isWorkflowOwnerAtom);
	const updateNodeData = useSetAtom(updateNodeDataAtom);
	const deleteNode = useSetAtom(deleteNodeAtom);
	const deleteEdge = useSetAtom(deleteEdgeAtom);
	const deleteSelectedItems = useSetAtom(deleteSelectedItemsAtom);
	const setShowClearDialog = useSetAtom(showClearDialogAtom);
	const setShowDeleteDialog = useSetAtom(showDeleteDialogAtom);
	const clearNodeStatuses = useSetAtom(clearNodeStatusesAtom);
	const setPendingIntegrationNodes = useSetAtom(pendingIntegrationNodesAtom);
	const morphNodeType = useSetAtom(morphNodeTypeAtom);
	const [newlyCreatedNodeId, setNewlyCreatedNodeId] = useAtom(
		newlyCreatedNodeIdAtom,
	);
	const [showDeleteNodeAlert, setShowDeleteNodeAlert] = useState(false);
	const [showDeleteEdgeAlert, setShowDeleteEdgeAlert] = useState(false);
	const [showDeleteRunsAlert, setShowDeleteRunsAlert] = useState(false);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [activeTab, setActiveTab] = useAtom(propertiesPanelActiveTabAtom);
	const refreshRunsRef = useRef<(() => Promise<void>) | null>(null);
	const autoSelectAbortControllersRef = useRef<Record<string, AbortController>>(
		{},
	);
	const selectedNode = nodes.find((node) => node.id === selectedNodeId);
	const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);

	// Count multiple selections
	const selectedNodes = nodes.filter((node) => node.selected);
	const selectedEdges = edges.filter((edge) => edge.selected);
	const hasMultipleSelections = selectedNodes.length + selectedEdges.length > 1;
	const showInlineChatSplit = !!selectedNode && !!currentWorkflowId && isOwner;

	// Switch to Properties tab if Code tab is hidden for the selected node
	useEffect(() => {
		if (!selectedNode || activeTab !== "code") {
			return;
		}

		const isConditionAction =
			selectedNode.data.config?.actionType === "system/condition";
		const isManualTrigger =
			selectedNode.data.type === "trigger" &&
			selectedNode.data.config?.triggerType === "Manual";

		if (isConditionAction || isManualTrigger) {
			setActiveTab("properties");
		}
	}, [selectedNode, activeTab, setActiveTab]);

	// Workflow-level tabs only support properties/ai/runs.
	useEffect(() => {
		if (selectedNode) {
			return;
		}

		const valid =
			activeTab === "properties" ||
			(isOwner && (activeTab === "ai" || activeTab === "runs"));

		if (!valid) {
			setActiveTab("properties");
		}
	}, [selectedNode, activeTab, isOwner, setActiveTab]);

	// AI tab is now allowed when a node is selected, so no forced switch needed.

	// Auto-fix invalid integration references when a node is selected
	const globalIntegrations = useAtomValue(connectionsAtom);
	useEffect(() => {
		if (!(selectedNode && isOwner)) {
			return;
		}

		const actionType = selectedNode.data.config?.actionType as
			| string
			| undefined;
		const currentIntegrationId = selectedNode.data.config?.integrationId as
			| string
			| undefined;
		const currentAuth = selectedNode.data.config?.auth as string | undefined;
		const authExternalId = getExternalIdFromAuthTemplate(currentAuth);

		// Skip if no action type
		if (!actionType) {
			return;
		}

		// Get the required integration type for this action
		const action = findActionById(actionType);
		const actionRequiredIntegration =
			getRequiredConnectionForAction(actionType);
		const rawIntegrationType: IntegrationType | undefined =
			actionRequiredIntegration ||
			action?.integration ||
			SYSTEM_ACTION_INTEGRATIONS[actionType];
		const integrationType = requiresConnectionForIntegration(rawIntegrationType)
			? rawIntegrationType
			: undefined;

		if (!integrationType) {
			return;
		}

		const availableIntegrations = globalIntegrations.filter(
			(i) => i.pieceName === integrationType,
		);

		const hasAnyConnectionConfig =
			!!currentIntegrationId || !!authExternalId || !!currentAuth;

		// If there is no connection configured yet, only auto-select when there is
		// exactly one available connection. Never clear an already-empty config,
		// since that creates an infinite update loop.
		if (!hasAnyConnectionConfig) {
			if (availableIntegrations.length === 1) {
				const newConfig = applyConnectionConfig(
					selectedNode.data.config,
					availableIntegrations[0],
				);
				updateNodeData({ id: selectedNode.id, data: { config: newConfig } });
			}
			return;
		}

		// 1) If auth points at an existing connection, ensure integrationId matches it.
		if (authExternalId) {
			const byExternalId = availableIntegrations.find(
				(i) => i.externalId === authExternalId,
			);
			if (byExternalId) {
				if (currentIntegrationId !== byExternalId.id) {
					const newConfig = applyConnectionConfig(
						selectedNode.data.config,
						byExternalId,
					);
					updateNodeData({ id: selectedNode.id, data: { config: newConfig } });
				}
				return;
			}

			// Auth references a deleted/unknown connection. Clear it once.
			const newConfig = clearConnectionConfig(selectedNode.data.config);
			updateNodeData({ id: selectedNode.id, data: { config: newConfig } });
			return;
		}

		// 2) If integrationId is set but no longer exists, replace or clear it.
		if (currentIntegrationId) {
			const integrationExists = globalIntegrations.some(
				(i) => i.id === currentIntegrationId,
			);
			if (integrationExists) {
				// Ensure auth is present for runtime execution.
				const selected = globalIntegrations.find(
					(i) => i.id === currentIntegrationId,
				);
				if (selected?.externalId && !authExternalId) {
					const newConfig = applyConnectionConfig(
						selectedNode.data.config,
						selected,
					);
					updateNodeData({ id: selectedNode.id, data: { config: newConfig } });
				}
				return;
			}
		}

		if (availableIntegrations.length === 1) {
			// Auto-select the only available integration
			const newConfig = applyConnectionConfig(
				selectedNode.data.config,
				availableIntegrations[0],
			);
			updateNodeData({ id: selectedNode.id, data: { config: newConfig } });
		} else if (availableIntegrations.length === 0) {
			// No integrations available - clear the invalid reference
			if (currentIntegrationId || currentAuth) {
				const newConfig = clearConnectionConfig(selectedNode.data.config);
				updateNodeData({ id: selectedNode.id, data: { config: newConfig } });
			}
		}
		// If multiple integrations exist, let the user choose manually
	}, [selectedNode, globalIntegrations, isOwner, updateNodeData]);

	const handleDelete = () => {
		if (selectedNodeId) {
			deleteNode(selectedNodeId);
			setShowDeleteNodeAlert(false);
		}
	};

	const handleToggleEnabled = () => {
		if (selectedNode) {
			const currentEnabled = selectedNode.data.enabled ?? true;
			updateNodeData({
				id: selectedNode.id,
				data: { enabled: !currentEnabled },
			});
		}
	};

	const handleDeleteEdge = () => {
		if (selectedEdgeId) {
			deleteEdge(selectedEdgeId);
			setShowDeleteEdgeAlert(false);
		}
	};

	const handleDeleteAllRuns = async () => {
		if (!currentWorkflowId) {
			return;
		}

		try {
			await api.workflow.deleteExecutions(currentWorkflowId);
			clearNodeStatuses();
			setShowDeleteRunsAlert(false);
		} catch (error) {
			console.error("Failed to delete runs:", error);
			const errorMessage =
				error instanceof Error ? error.message : "Failed to delete runs";
			toast.error(errorMessage);
		}
	};

	const handleUpdateLabel = (label: string) => {
		if (selectedNode) {
			updateNodeData({ id: selectedNode.id, data: { label } });
		}
	};

	const handleUpdateDescription = (description: string) => {
		if (selectedNode) {
			updateNodeData({ id: selectedNode.id, data: { description } });
		}
	};
	const autoSelectIntegration = useCallback(
		async (
			nodeId: string,
			actionType: string,
			currentConfig: Record<string, unknown>,
			abortSignal: AbortSignal,
		) => {
			// Get integration type - check plugin registry first, then system actions
			const action = findActionById(actionType);
			const actionRequiredIntegration =
				getRequiredConnectionForAction(actionType);
			const rawIntegrationType: IntegrationType | undefined =
				actionRequiredIntegration ||
				action?.integration ||
				SYSTEM_ACTION_INTEGRATIONS[actionType];
			const integrationType = requiresConnectionForIntegration(
				rawIntegrationType,
			)
				? rawIntegrationType
				: undefined;

			if (!integrationType) {
				// No integration needed, remove from pending
				setPendingIntegrationNodes((prev: Set<string>) => {
					const next = new Set(prev);
					next.delete(nodeId);
					return next;
				});
				return;
			}

			try {
				const all = await api.appConnection
					.list({ projectId: "default", limit: 1000 })
					.then((r) => r.data);

				// Check if this operation was aborted (actionType changed)
				if (abortSignal.aborted) {
					return;
				}

				const filtered = all.filter((i) => i.pieceName === integrationType);

				// Auto-select if only one integration exists
				if (filtered.length === 1 && !abortSignal.aborted) {
					const newConfig = applyConnectionConfig(
						{ ...currentConfig, actionType },
						filtered[0],
					);
					updateNodeData({ id: nodeId, data: { config: newConfig } });
				}
			} catch (error) {
				console.error("Failed to auto-select integration:", error);
			} finally {
				// Always remove from pending set when done (unless aborted)
				if (!abortSignal.aborted) {
					setPendingIntegrationNodes((prev: Set<string>) => {
						const next = new Set(prev);
						next.delete(nodeId);
						return next;
					});
				}
			}
		},
		[updateNodeData, setPendingIntegrationNodes],
	);

	const handleUpdateConfig = (key: string, value: unknown) => {
		if (selectedNode) {
			let newConfig: Record<string, unknown> = {
				...selectedNode.data.config,
				[key]:
					value === "" && (key === "integrationId" || key === "auth")
						? undefined
						: value,
			};

			// When action type changes, clear the integrationId since it may not be valid for the new action
			if (key === "actionType" && selectedNode.data.config?.integrationId) {
				newConfig = clearConnectionConfig(newConfig);
			}

			updateNodeData({ id: selectedNode.id, data: { config: newConfig } });

			// When action type changes, auto-select integration if only one exists
			if (key === "actionType" && typeof value === "string") {
				// Cancel any pending auto-select operation for this node
				const existingController =
					autoSelectAbortControllersRef.current[selectedNode.id];
				if (existingController) {
					existingController.abort();
				}

				// Create new AbortController for this operation
				const newController = new AbortController();
				autoSelectAbortControllersRef.current[selectedNode.id] = newController;

				// Add to pending set before starting async check
				setPendingIntegrationNodes((prev: Set<string>) =>
					new Set(prev).add(selectedNode.id),
				);
				autoSelectIntegration(
					selectedNode.id,
					value,
					newConfig,
					newController.signal,
				);
			}
		}
	};

	const handleUpdateWorkspaceName = async (newName: string) => {
		setCurrentWorkflowName(newName);

		// Save to database if workflow exists
		if (currentWorkflowId) {
			try {
				await api.workflow.update(currentWorkflowId, {
					name: newName,
					nodes,
					edges,
				});
			} catch (error) {
				console.error("Failed to update workflow name:", error);
				toast.error("Failed to update workspace name");
			}
		}
	};

	const handleRefreshRuns = async () => {
		setIsRefreshing(true);
		try {
			if (refreshRunsRef.current) {
				await refreshRunsRef.current();
			}
		} catch (error) {
			console.error("Failed to refresh runs:", error);
			toast.error("Failed to refresh runs");
		} finally {
			setIsRefreshing(false);
		}
	};

	// If multiple items are selected, show multi-selection properties
	if (hasMultipleSelections) {
		const canShowChat = !!currentWorkflowId && isOwner;
		return canShowChat ? (
			<ResizablePanelGroup
				autoSaveId="multi-select-chat-split"
				className="size-full"
				direction="vertical"
			>
				<ResizablePanel defaultSize={60} minSize={20}>
					<MultiSelectionPanel
						onDelete={deleteSelectedItems}
						selectedEdges={selectedEdges}
						selectedNodes={selectedNodes}
					/>
				</ResizablePanel>
				<ResizableHandle withHandle />
				<ResizablePanel defaultSize={40} minSize={25}>
					<AiChatPanel workflowId={currentWorkflowId!} />
				</ResizablePanel>
			</ResizablePanelGroup>
		) : (
			<MultiSelectionPanel
				onDelete={deleteSelectedItems}
				selectedEdges={selectedEdges}
				selectedNodes={selectedNodes}
			/>
		);
	}

	// If an edge is selected, show edge properties
	if (selectedEdge) {
		return (
			<>
				<div className="flex size-full flex-col">
					<div className="flex h-14 w-full shrink-0 items-center border-b bg-transparent px-4">
						<h2 className="font-semibold text-foreground">Properties</h2>
					</div>
					<div className="flex-1 space-y-4 overflow-y-auto p-4">
						<div className="space-y-2">
							<Label className="ml-1" htmlFor="edge-id">
								Edge ID
							</Label>
							<Input disabled id="edge-id" value={selectedEdge.id} />
						</div>
						<div className="space-y-2">
							<Label className="ml-1" htmlFor="edge-source">
								Source
							</Label>
							<Input disabled id="edge-source" value={selectedEdge.source} />
						</div>
						<div className="space-y-2">
							<Label className="ml-1" htmlFor="edge-target">
								Target
							</Label>
							<Input disabled id="edge-target" value={selectedEdge.target} />
						</div>

						{isOwner && (
							<div className="flex items-center gap-2 pt-4">
								<Button
									className="text-muted-foreground"
									onClick={() => setShowDeleteEdgeAlert(true)}
									size="sm"
									variant="ghost"
								>
									<Trash2 className="mr-2 size-4" />
									Delete
								</Button>
							</div>
						)}
					</div>
				</div>

				<AlertDialog
					onOpenChange={setShowDeleteEdgeAlert}
					open={showDeleteEdgeAlert}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete Edge</AlertDialogTitle>
							<AlertDialogDescription>
								Are you sure you want to delete this connection? This action
								cannot be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={handleDeleteEdge}>
								Delete
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</>
		);
	}

	// If no node is selected, show workspace properties and runs
	if (!selectedNode) {
		return (
			<>
				<Tabs
					className="size-full"
					defaultValue="properties"
					onValueChange={setActiveTab}
					value={activeTab}
				>
					<TabsList className="h-14 w-full shrink-0 rounded-none border-b bg-transparent px-4 py-2.5">
						<TabsTrigger
							className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
							value="properties"
						>
							Properties
						</TabsTrigger>
						{isOwner && (
							<TabsTrigger
								className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
								value="ai"
							>
								AI
							</TabsTrigger>
						)}
						{isOwner && (
							<TabsTrigger
								className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
								value="runs"
							>
								Runs
							</TabsTrigger>
						)}
					</TabsList>
					<TabsContent
						className="flex flex-col overflow-hidden"
						value="properties"
					>
						<div className="flex-1 space-y-4 overflow-y-auto p-4">
							<div className="space-y-2">
								<Label className="ml-1" htmlFor="workflow-name">
									Workflow Name
								</Label>
								<Input
									disabled={!isOwner}
									id="workflow-name"
									onChange={(e) => handleUpdateWorkspaceName(e.target.value)}
									value={currentWorkflowName}
								/>
							</div>
							<div className="space-y-2">
								<Label className="ml-1" htmlFor="workflow-id">
									Workflow ID
								</Label>
								<div className="flex items-center gap-1">
									<Input
										className="font-mono text-xs"
										id="workflow-id"
										readOnly
										value={currentWorkflowId || "Not saved"}
									/>
									{currentWorkflowId && (
										<Button
											className="shrink-0"
											onClick={() => {
												navigator.clipboard.writeText(currentWorkflowId);
												toast.success("Workflow ID copied");
											}}
											size="icon"
											title="Copy Workflow ID"
											variant="ghost"
										>
											<Copy className="size-4" />
										</Button>
									)}
								</div>
							</div>
							{!isOwner && (
								<div className="rounded-lg border border-muted bg-muted/30 p-3">
									<p className="text-muted-foreground text-sm">
										You are viewing a public workflow. Duplicate it to make
										changes.
									</p>
								</div>
							)}
							{isOwner && (
								<div className="flex items-center gap-2 pt-4">
									<Button
										className="text-muted-foreground"
										onClick={() => setShowClearDialog(true)}
										size="sm"
										variant="ghost"
									>
										<Eraser className="mr-2 size-4" />
										Clear
									</Button>
									<Button
										className="text-muted-foreground"
										onClick={() => setShowDeleteDialog(true)}
										size="sm"
										variant="ghost"
									>
										<Trash2 className="mr-2 size-4" />
										Delete
									</Button>
								</div>
							)}
						</div>
					</TabsContent>
					{isOwner && (
						<TabsContent className="flex flex-col overflow-hidden" value="ai">
							<div className="flex-1 min-h-0">
								{currentWorkflowId ? (
									<AiChatPanel workflowId={currentWorkflowId} />
								) : (
									<div className="p-4 text-muted-foreground text-sm">
										Save this workflow to enable AI chat.
									</div>
								)}
							</div>
						</TabsContent>
					)}
					{isOwner && (
						<TabsContent className="flex flex-col overflow-hidden" value="runs">
							{/* Actions in content header */}
							<div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
								<Button
									className="text-muted-foreground"
									disabled={isRefreshing}
									onClick={handleRefreshRuns}
									size="sm"
									variant="ghost"
								>
									<RefreshCw
										className={`mr-2 size-4 ${isRefreshing ? "animate-spin" : ""}`}
									/>
									Refresh
								</Button>
								<Button
									className="text-muted-foreground"
									onClick={() => setShowDeleteRunsAlert(true)}
									size="sm"
									variant="ghost"
								>
									<Eraser className="mr-2 size-4" />
									Clear All
								</Button>
							</div>
							<div className="flex-1 space-y-4 overflow-y-auto p-4">
								<WorkflowRuns
									isActive={activeTab === "runs"}
									onRefreshRef={refreshRunsRef}
								/>
							</div>
						</TabsContent>
					)}
				</Tabs>

				<AlertDialog
					onOpenChange={setShowDeleteRunsAlert}
					open={showDeleteRunsAlert}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete All Runs</AlertDialogTitle>
							<AlertDialogDescription>
								Are you sure you want to delete all workflow runs? This action
								cannot be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={handleDeleteAllRuns}>
								Delete
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</>
		);
	}

	const renderNodeConfigContent = (inSplit: boolean) => (
		<div
			className={inSplit ? "size-full overflow-y-auto" : "flex flex-1 flex-col"}
		>
			{/* Action selection - full height flex layout */}
			{selectedNode.data.type === "action" &&
				!selectedNode.data.config?.actionType &&
				isOwner && (
					<div
						className={`flex min-h-0 flex-col px-4 pt-4 ${inSplit ? "size-full" : "flex-1"}`}
					>
						<ActionGrid
							disabled={isGenerating}
							isNewlyCreated={selectedNode?.id === newlyCreatedNodeId}
							onSelectAction={(selection: ActionSelection) => {
								// Handle Dapr activity selection - morph node type
								if (
									selection.isDaprActivity &&
									selection.nodeType &&
									selection.nodeType !== "action"
								) {
									morphNodeType({
										id: selectedNode.id,
										nodeType: selection.nodeType,
										data: {
											label:
												selection.nodeType === "activity"
													? selection.activityName || "Activity"
													: selection.nodeType === "approval-gate"
														? "Approval Gate"
														: selection.nodeType === "timer"
															? "Timer"
															: selection.nodeType === "loop-until"
																? "Loop Until"
																: selection.nodeType === "while"
																	? "While"
																	: selection.nodeType === "if-else"
																		? "If / Else"
																		: selection.nodeType === "note"
																			? "Note"
																			: selection.nodeType === "set-state"
																				? "Set State"
																				: selection.nodeType === "transform"
																					? "Transform"
																					: "Step",
											config:
												selection.nodeType === "activity"
													? { activityName: selection.activityName }
													: selection.nodeType === "loop-until"
														? {
																loopStartNodeId: "",
																maxIterations: 10,
																delaySeconds: 0,
																onMaxIterations: "fail",
																operator: "EXISTS",
																left: "",
																right: "",
															}
														: selection.nodeType === "while"
															? {
																	expression: "",
																	maxIterations: 20,
																	delaySeconds: 0,
																	onMaxIterations: "continue",
																}
															: selection.nodeType === "if-else"
																? {
																		operator: "EXISTS",
																		left: "",
																		right: "",
																	}
																: selection.nodeType === "note"
																	? { text: "" }
																	: selection.nodeType === "set-state"
																		? {
																				entries: [{ key: "", value: "" }],
																			}
																		: selection.nodeType === "transform"
																			? { templateJson: "{\n  \n}" }
																			: {},
										},
									});
								} else {
									// Regular action selection
									handleUpdateConfig("actionType", selection.actionType);
								}
								// Clear newly created tracking once action is selected
								if (selectedNode?.id === newlyCreatedNodeId) {
									setNewlyCreatedNodeId(null);
								}
							}}
						/>
					</div>
				)}

			{/* Other content - scrollable */}
			{!(
				selectedNode.data.type === "action" &&
				!selectedNode.data.config?.actionType &&
				isOwner
			) && (
				<div
					className={`space-y-4 p-4 ${inSplit ? "" : "flex-1 overflow-y-auto"}`}
				>
					{selectedNode.data.type === "trigger" && (
						<TriggerConfig
							config={selectedNode.data.config || {}}
							disabled={isGenerating || !isOwner}
							onUpdateConfig={handleUpdateConfig}
							workflowId={currentWorkflowId ?? undefined}
						/>
					)}

					{selectedNode.data.type === "action" &&
						!selectedNode.data.config?.actionType &&
						!isOwner && (
							<div className="rounded-lg border border-muted bg-muted/30 p-3">
								<p className="text-muted-foreground text-sm">
									No action configured for this step.
								</p>
							</div>
						)}

					{selectedNode.data.type === "action" &&
					selectedNode.data.config?.actionType ? (
						<ActionConfig
							config={selectedNode.data.config || {}}
							disabled={isGenerating || !isOwner}
							isOwner={isOwner}
							onUpdateConfig={handleUpdateConfig}
						/>
					) : null}

					{/* Dapr Activity Config */}
					{selectedNode.type === "activity" && (
						<ActivityConfig
							config={selectedNode.data.config || {}}
							disabled={isGenerating || !isOwner}
							onUpdateConfig={handleUpdateConfig}
						/>
					)}

					{/* Dapr Approval Gate Config */}
					{selectedNode.type === "approval-gate" && (
						<ApprovalGateConfig
							config={selectedNode.data.config || {}}
							disabled={isGenerating || !isOwner}
							onUpdateConfig={handleUpdateConfig}
						/>
					)}

					{/* Dapr Timer Config */}
					{selectedNode.type === "timer" && (
						<TimerConfig
							config={selectedNode.data.config || {}}
							disabled={isGenerating || !isOwner}
							onUpdateConfig={handleUpdateConfig}
						/>
					)}

					{/* Dapr Loop Until Config */}
					{selectedNode.type === "loop-until" && (
						<LoopUntilConfig
							config={selectedNode.data.config || {}}
							disabled={isGenerating || !isOwner}
							onUpdateConfig={handleUpdateConfig}
						/>
					)}

					{/* While Config */}
					{selectedNode.type === "while" && (
						<WhileConfig
							nodeId={selectedNode.id}
							config={selectedNode.data.config || {}}
							disabled={isGenerating || !isOwner}
							onUpdateConfig={handleUpdateConfig}
						/>
					)}

					{/* If/Else Config */}
					{selectedNode.type === "if-else" && (
						<IfElseConfig
							config={selectedNode.data.config || {}}
							disabled={isGenerating || !isOwner}
							onUpdateConfig={handleUpdateConfig}
						/>
					)}

					{/* Note Config */}
					{selectedNode.type === "note" && (
						<NoteConfig
							config={selectedNode.data.config || {}}
							disabled={isGenerating || !isOwner}
							onUpdateConfig={handleUpdateConfig}
						/>
					)}

					{/* Set State Config */}
					{selectedNode.type === "set-state" && (
						<SetStateConfig
							config={selectedNode.data.config || {}}
							disabled={isGenerating || !isOwner}
							onUpdateConfig={handleUpdateConfig}
						/>
					)}

					{/* Transform Config */}
					{selectedNode.type === "transform" && (
						<TransformConfig
							config={selectedNode.data.config || {}}
							disabled={isGenerating || !isOwner}
							onUpdateConfig={handleUpdateConfig}
						/>
					)}

					{/* Sub-Workflow Config */}
					{selectedNode.type === "sub-workflow" && (
						<SubWorkflowConfig
							config={selectedNode.data.config || {}}
							currentWorkflowId={currentWorkflowId ?? undefined}
							disabled={isGenerating || !isOwner}
							onUpdateConfig={handleUpdateConfig}
						/>
					)}

					{selectedNode.data.type !== "action" ||
					selectedNode.data.config?.actionType ? (
						<>
							<div className="space-y-2">
								<Label className="ml-1" htmlFor="label">
									Label
								</Label>
								<Input
									disabled={isGenerating || !isOwner}
									id="label"
									onChange={(e) => handleUpdateLabel(e.target.value)}
									value={selectedNode.data.label}
								/>
							</div>

							<div className="space-y-2">
								<Label className="ml-1" htmlFor="description">
									Description
								</Label>
								<Input
									disabled={isGenerating || !isOwner}
									id="description"
									onChange={(e) => handleUpdateDescription(e.target.value)}
									placeholder="Optional description"
									value={selectedNode.data.description || ""}
								/>
							</div>
						</>
					) : null}

					{!isOwner && (
						<div className="rounded-lg border border-muted bg-muted/30 p-3">
							<p className="text-muted-foreground text-sm">
								You are viewing a public workflow. Duplicate it to make changes.
							</p>
						</div>
					)}

					{/* Actions moved into content */}
					{isOwner && (
						<div className="flex items-center gap-2 pt-4">
							{selectedNode.data.type === "action" && (
								<Button
									className="text-muted-foreground"
									onClick={handleToggleEnabled}
									size="sm"
									variant="ghost"
								>
									{selectedNode.data.enabled === false ? (
										<>
											<EyeOff className="mr-2 size-4" />
											Disabled
										</>
									) : (
										<>
											<Eye className="mr-2 size-4" />
											Enabled
										</>
									)}
								</Button>
							)}
							<Button
								className="text-muted-foreground"
								onClick={() => setShowDeleteNodeAlert(true)}
								size="sm"
								variant="ghost"
							>
								<Trash2 className="mr-2 size-4" />
								Delete
							</Button>
						</div>
					)}
				</div>
			)}
		</div>
	);

	return (
		<>
			<Tabs
				className="size-full"
				data-testid="properties-panel"
				defaultValue="properties"
				onValueChange={setActiveTab}
				value={activeTab}
			>
				<TabsList className="h-14 w-full shrink-0 rounded-none border-b bg-transparent px-4 py-2.5">
					<TabsTrigger
						className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
						value="properties"
					>
						Properties
					</TabsTrigger>
					<TabsTrigger
						className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
						value="code"
					>
						Code
					</TabsTrigger>
					{isOwner && (
						<TabsTrigger
							className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
							value="ai"
						>
							AI
						</TabsTrigger>
					)}
					{isOwner && (
						<TabsTrigger
							className="bg-transparent text-muted-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none"
							value="runs"
						>
							Runs
						</TabsTrigger>
					)}
				</TabsList>
				<TabsContent
					className="flex flex-col overflow-hidden"
					value="properties"
				>
					{showInlineChatSplit ? (
						<ResizablePanelGroup
							autoSaveId="node-config-chat-split"
							className="flex-1"
							direction="vertical"
						>
							<ResizablePanel defaultSize={60} minSize={20}>
								{renderNodeConfigContent(true)}
							</ResizablePanel>
							<ResizableHandle withHandle />
							<ResizablePanel defaultSize={40} minSize={25}>
								<AiChatPanel workflowId={currentWorkflowId!} />
							</ResizablePanel>
						</ResizablePanelGroup>
					) : (
						renderNodeConfigContent(false)
					)}
				</TabsContent>
				<TabsContent
					className="flex flex-col overflow-hidden data-[state=inactive]:hidden"
					forceMount
					value="code"
				>
					{(() => {
						const file = getNodeCodeFile(selectedNode);
						if (!file) {
							return null;
						}

						return (
							<>
								<div className="flex shrink-0 items-center justify-between border-b bg-muted/30 px-3 pb-2">
									<div className="flex items-center gap-2">
										<FileCode className="size-3.5 text-muted-foreground" />
										<code className="text-muted-foreground text-xs">
											{file.filename}
										</code>
									</div>
									<Button
										className="text-muted-foreground"
										onClick={() => {
											navigator.clipboard.writeText(file.content);
											toast.success("Code copied to clipboard");
										}}
										size="sm"
										variant="ghost"
									>
										<Copy className="mr-2 size-4" />
										Copy
									</Button>
								</div>
								<div className="flex-1 overflow-hidden">
									<CodeEditor
										height="100%"
										language={file.language}
										options={{
											readOnly: true,
											minimap: { enabled: false },
											scrollBeyondLastLine: false,
											fontSize: 13,
											lineNumbers: "on",
											folding: false,
											wordWrap: "off",
											padding: { top: 16, bottom: 16 },
										}}
										value={file.content}
									/>
								</div>
							</>
						);
					})()}
				</TabsContent>
				{isOwner && (
					<TabsContent className="flex flex-col overflow-hidden" value="ai">
						<div className="flex-1 min-h-0">
							{currentWorkflowId ? (
								<AiChatPanel workflowId={currentWorkflowId} />
							) : (
								<div className="p-4 text-muted-foreground text-sm">
									Save this workflow to enable AI chat.
								</div>
							)}
						</div>
					</TabsContent>
				)}
				{isOwner && (
					<TabsContent className="flex flex-col overflow-hidden" value="runs">
						{/* Actions in content header */}
						<div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
							<Button
								className="text-muted-foreground"
								disabled={isRefreshing}
								onClick={handleRefreshRuns}
								size="sm"
								variant="ghost"
							>
								<RefreshCw
									className={`mr-2 size-4 ${isRefreshing ? "animate-spin" : ""}`}
								/>
								Refresh
							</Button>
							<Button
								className="text-muted-foreground"
								onClick={() => setShowDeleteRunsAlert(true)}
								size="sm"
								variant="ghost"
							>
								<Eraser className="mr-2 size-4" />
								Clear All
							</Button>
						</div>
						<div className="flex-1 space-y-4 overflow-y-auto p-4">
							<WorkflowRuns
								isActive={activeTab === "runs"}
								onRefreshRef={refreshRunsRef}
							/>
						</div>
					</TabsContent>
				)}
			</Tabs>

			<AlertDialog
				onOpenChange={setShowDeleteRunsAlert}
				open={showDeleteRunsAlert}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete All Runs</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete all workflow runs? This action
							cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={handleDeleteAllRuns}>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				onOpenChange={setShowDeleteNodeAlert}
				open={showDeleteNodeAlert}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete Step</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete this node? This action cannot be
							undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
};
export const NodeConfigPanel = () => (
	<div className="hidden size-full flex-col bg-background md:flex">
		<PanelInner />
	</div>
);
