"use client";

import {
	ConnectionMode,
	MiniMap,
	SelectionMode,
	type Node,
	type OnNodeDrag,
	type NodeMouseHandler,
	type OnConnect,
	type OnConnectStartParams,
	type SelectionDragHandler,
	useReactFlow,
	type Connection as XYFlowConnection,
	type Edge as XYFlowEdge,
} from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Canvas } from "@/components/ai-elements/canvas";
import { Connection } from "@/components/ai-elements/connection";
import { Controls } from "@/components/ai-elements/controls";
import { ApprovalBanner } from "@/components/workflow/approval-banner";
import { WorkflowToolbar } from "@/components/workflow/workflow-toolbar";
import "@xyflow/react/dist/style.css";

import { PlayCircle, Zap } from "lucide-react";
import { nanoid } from "nanoid";
import { usePiecesCatalog } from "@/lib/actions/pieces-store";
import { buildCatalogFromIntegrations } from "@/lib/workflow-spec/catalog";
import {
	collectSelectionForClipboard,
	parseWorkflowClipboardPayload,
	remapClipboardPayloadForPaste,
	serializeWorkflowClipboardPayload,
} from "@/lib/workflow-clipboard";
import {
	areHandleTypesCompatible,
	getConnectionRulesForEdge,
	isHandleAtConnectionLimit,
} from "@/lib/workflow-connection-rules";
import { isEditableTarget } from "@/lib/keyboard";
import { validateWorkflowGraph } from "@/lib/workflow-validation/validate-workflow-graph";
import {
	activeWhileDropTargetAtom,
	addNodeAtom,
	autosaveAtom,
	canRedoAtom,
	canUndoAtom,
	checkForPotentialConnectionAtom,
	currentRunningNodeIdAtom,
	currentWorkflowIdAtom,
	deleteSelectedItemsAtom,
	edgesAtom,
	fitViewRequestAtom,
	groupSelectedNodesAtom,
	hasUnsavedChangesAtom,
	insertNodeAtConnectionAtom,
	isGeneratingAtom,
	isPanelAnimatingAtom,
	isTransitioningFromHomepageAtom,
	isWorkflowOwnerAtom,
	nodesAtom,
	onEdgesChangeAtom,
	onNodesChangeAtom,
	potentialConnectionAtom,
	propertiesPanelActiveTabAtom,
	pushHistorySnapshotAtom,
	redoAtom,
	resetPotentialConnectionAtom,
	rightPanelWidthAtom,
	selectedEdgeAtom,
	selectedNodeAtom,
	showMinimapAtom,
	undoAtom,
	ungroupNodeAtom,
	type WorkflowNode,
	type WorkflowNodeType,
} from "@/lib/workflow-store";
import type { DagreLayoutOptions } from "@/lib/workflow-layout/dagre-layout";
import { layoutWorkflowNodes } from "@/lib/workflow-layout/dagre-layout";
import { layoutWorkflowNodesElk } from "@/lib/workflow-layout/elk-layout";
import {
	WORKFLOW_NODE_SIZE,
	clampWhileChildPosition,
	getAbsolutePosition,
	isPointInsideWhileNode,
	isWhileBodyCandidate,
} from "@/lib/workflows/while-node";
import { Edge } from "../ai-elements/edge";
import { Panel } from "../ai-elements/panel";
import { CanvasAiChatInput } from "./canvas-ai-chat-input";
import { ActionNode } from "./nodes/action-node";
import { ActivityNode } from "./nodes/activity-node";
import { AddNode } from "./nodes/add-node";
import { ApprovalGateNode } from "./nodes/approval-gate-node";
import { GroupNode } from "./nodes/group-node";
import { IfElseNode } from "./nodes/if-else-node";
import { LoopUntilNode } from "./nodes/loop-until-node";
import { NoteNode } from "./nodes/note-node";
import { SetStateNode } from "./nodes/set-state-node";
import { TimerNode } from "./nodes/timer-node";
import { SubWorkflowNode } from "./nodes/sub-workflow-node";
import { TransformNode } from "./nodes/transform-node";
import { TriggerNode } from "./nodes/trigger-node";
import { WhileNode } from "./nodes/while-node";
import {
	parseStepTemplateNodeType,
	StepPalette,
	supportsInlineInsertion,
	WORKFLOW_NODE_TEMPLATE_MIME,
} from "./step-palette";
import {
	type ContextMenuState,
	useContextMenuHandlers,
	WorkflowContextMenu,
} from "./workflow-context-menu";

const nodeTemplates = [
	{
		type: "trigger" as WorkflowNodeType,
		label: "",
		description: "",
		displayLabel: "Trigger",
		icon: PlayCircle,
		defaultConfig: { triggerType: "Manual" },
	},
	{
		type: "action" as WorkflowNodeType,
		label: "",
		description: "",
		displayLabel: "Action",
		icon: Zap,
		defaultConfig: {},
	},
];

const edgeTypes = {
	animated: Edge.Animated,
	temporary: Edge.Temporary,
};

function isValidConnectionForGraph(input: {
	connection: XYFlowConnection | XYFlowEdge;
	nodes: WorkflowNode[];
	edges: XYFlowEdge[];
}): boolean {
	const { connection, nodes, edges } = input;

	// Ensure we have both source and target
	if (!(connection.source && connection.target)) {
		return false;
	}

	// Prevent self-connections
	if (connection.source === connection.target) {
		return false;
	}

	const sourceNode = nodes.find((node) => node.id === connection.source);
	const targetNode = nodes.find((node) => node.id === connection.target);
	if (!(sourceNode && targetNode)) {
		return false;
	}

	// Trigger/group nodes cannot be targeted and group nodes cannot connect.
	if (
		targetNode.type === "trigger" ||
		targetNode.type === "group" ||
		sourceNode.type === "group"
	) {
		return false;
	}

	// Branch handles are reserved for if-else nodes.
	const isBranchHandle =
		connection.sourceHandle === "true" || connection.sourceHandle === "false";
	if (sourceNode.type !== "if-else" && isBranchHandle) {
		return false;
	}
	if (sourceNode.type === "if-else" && !isBranchHandle) {
		return false;
	}

	const connectionRules = getConnectionRulesForEdge({ nodes, connection });
	if (!connectionRules) {
		return false;
	}
	if (
		!areHandleTypesCompatible(
			connectionRules.sourceRule.dataType,
			connectionRules.targetRule,
		)
	) {
		return false;
	}
	if (
		isHandleAtConnectionLimit({
			edges,
			nodeId: connection.source,
			handleType: "source",
			handleId: connection.sourceHandle,
			rule: connectionRules.sourceRule,
		})
	) {
		return false;
	}
	if (
		isHandleAtConnectionLimit({
			edges,
			nodeId: connection.target,
			handleType: "target",
			handleId: connection.targetHandle,
			rule: connectionRules.targetRule,
		})
	) {
		return false;
	}

	// Prevent duplicate connections with same endpoint handles.
	const exists = edges.some(
		(edge) =>
			edge.source === connection.source &&
			edge.target === connection.target &&
			(edge.sourceHandle ?? null) === (connection.sourceHandle ?? null) &&
			(edge.targetHandle ?? null) === (connection.targetHandle ?? null),
	);
	if (exists) {
		return false;
	}

	return true;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: React Flow canvas requires complex setup
export function WorkflowCanvas() {
	const [nodes, setNodes] = useAtom(nodesAtom);
	const [edges, setEdges] = useAtom(edgesAtom);
	const isGenerating = useAtomValue(isGeneratingAtom);
	const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
	const showMinimap = useAtomValue(showMinimapAtom);
	const isOwner = useAtomValue(isWorkflowOwnerAtom);
	const rightPanelWidth = useAtomValue(rightPanelWidthAtom);
	const activeTab = useAtomValue(propertiesPanelActiveTabAtom);
	const isPanelAnimating = useAtomValue(isPanelAnimatingAtom);
	const currentRunningNodeId = useAtomValue(currentRunningNodeIdAtom);
	const [isTransitioningFromHomepage, setIsTransitioningFromHomepage] = useAtom(
		isTransitioningFromHomepageAtom,
	);
	const onNodesChange = useSetAtom(onNodesChangeAtom);
	const onEdgesChange = useSetAtom(onEdgesChangeAtom);
	const setSelectedNode = useSetAtom(selectedNodeAtom);
	const setSelectedEdge = useSetAtom(selectedEdgeAtom);
	const setActiveWhileDropTarget = useSetAtom(activeWhileDropTargetAtom);
	const canUndo = useAtomValue(canUndoAtom);
	const canRedo = useAtomValue(canRedoAtom);
	const undo = useSetAtom(undoAtom);
	const redo = useSetAtom(redoAtom);
	const addNode = useSetAtom(addNodeAtom);
	const deleteSelectedItems = useSetAtom(deleteSelectedItemsAtom);
	const pushHistorySnapshot = useSetAtom(pushHistorySnapshotAtom);
	const groupSelectedNodes = useSetAtom(groupSelectedNodesAtom);
	const ungroupNode = useSetAtom(ungroupNodeAtom);
	const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
	const triggerAutosave = useSetAtom(autosaveAtom);
	const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
	const checkForPotentialConnection = useSetAtom(
		checkForPotentialConnectionAtom,
	);
	const resetPotentialConnection = useSetAtom(resetPotentialConnectionAtom);
	const insertNodeAtConnection = useSetAtom(insertNodeAtConnectionAtom);
	const potentialConnection = useAtomValue(potentialConnectionAtom);
	const {
		screenToFlowPosition,
		fitView,
		getInternalNode,
		getIntersectingNodes,
		getViewport,
		setViewport,
	} = useReactFlow();

	const connectingNodeId = useRef<string | null>(null);
	const connectingHandleType = useRef<"source" | "target" | null>(null);
	const connectingHandleId = useRef<string | null>(null);
	const lastPointerScreenPosition = useRef<{ x: number; y: number } | null>(
		null,
	);
	const justCreatedNodeFromConnection = useRef(false);
	const viewportInitialized = useRef(false);
	const [isCanvasReady, setIsCanvasReady] = useState(false);
	const [paletteDragType, setPaletteDragType] =
		useState<WorkflowNodeType | null>(null);
	const [contextMenuState, setContextMenuState] =
		useState<ContextMenuState>(null);
	const { pieces, loaded } = usePiecesCatalog();

	const workflowCatalog = useMemo(
		() => (loaded ? buildCatalogFromIntegrations(pieces) : undefined),
		[loaded, pieces],
	);
	const workflowValidation = useMemo(
		() =>
			validateWorkflowGraph({
				nodes,
				edges,
				catalog: workflowCatalog,
			}),
		[nodes, edges, workflowCatalog],
	);
	const edgesWithValidation = useMemo(
		() =>
			edges.map((edge) => ({
				...edge,
				data: {
					...(edge.data as Record<string, unknown> | undefined),
					validationState: workflowValidation.edgeStates[edge.id] ?? "valid",
				},
			})),
		[edges, workflowValidation.edgeStates],
	);

	// Context menu handlers
	const { onNodeContextMenu, onEdgeContextMenu, onPaneContextMenu } =
		useContextMenuHandlers(screenToFlowPosition, setContextMenuState);

	const closeContextMenu = useCallback(() => {
		setContextMenuState(null);
	}, []);

	// Track which workflow we've fitted view for to prevent re-running
	const fittedViewForWorkflowRef = useRef<string | null | undefined>(undefined);
	// Track if we have real nodes (not just placeholder "add" node)
	const hasRealNodes = nodes.some((n) => n.type !== "add");
	const hadRealNodesRef = useRef(false);
	// Pre-shift viewport when transitioning from homepage (before sidebar animates)
	const hasPreShiftedRef = useRef(false);
	useEffect(() => {
		if (isTransitioningFromHomepage && !hasPreShiftedRef.current) {
			hasPreShiftedRef.current = true;

			// Check if sidebar is collapsed from cookie (atom may not be initialized yet)
			const collapsedCookie = document.cookie
				.split("; ")
				.find((row) => row.startsWith("sidebar-collapsed="));
			const isCollapsed = collapsedCookie?.split("=")[1] === "true";

			// Skip if sidebar is collapsed - content should stay centered
			if (isCollapsed) {
				return;
			}

			// Shift viewport left to center content in the future visible area
			// Default sidebar is 30%, so shift by 15% of window width
			const viewport = getViewport();
			const defaultSidebarPercent = 0.3;
			const shiftPixels = (window.innerWidth * defaultSidebarPercent) / 2;
			setViewport(
				{ ...viewport, x: viewport.x - shiftPixels },
				{ duration: 0 },
			);
		}
	}, [isTransitioningFromHomepage, getViewport, setViewport]);

	// Fit view when workflow changes (only on initial load, not home -> workflow)
	useEffect(() => {
		// Skip if we've already fitted view for this workflow
		if (fittedViewForWorkflowRef.current === currentWorkflowId) {
			return;
		}

		// Skip fitView for homepage -> workflow transition (viewport already set from homepage)
		if (isTransitioningFromHomepage && viewportInitialized.current) {
			fittedViewForWorkflowRef.current = currentWorkflowId;
			setIsCanvasReady(true);
			// Clear the flag after using it
			setIsTransitioningFromHomepage(false);
			return;
		}

		// Use fitView after a brief delay to ensure React Flow and nodes are ready
		setTimeout(() => {
			fitView({ maxZoom: 1, minZoom: 0.5, padding: 0.2, duration: 0 });
			fittedViewForWorkflowRef.current = currentWorkflowId;
			viewportInitialized.current = true;
			// Show canvas immediately so width animation can be seen
			setIsCanvasReady(true);
			// Clear the flag
			setIsTransitioningFromHomepage(false);
		}, 0);
	}, [
		currentWorkflowId,
		fitView,
		isTransitioningFromHomepage,
		setIsTransitioningFromHomepage,
	]);

	// Fit view when first real node is added on homepage
	useEffect(() => {
		if (currentWorkflowId) {
			return; // Only for homepage
		}
		// Check if we just got our first real node
		if (hasRealNodes && !hadRealNodesRef.current) {
			hadRealNodesRef.current = true;
			// Fit view to center the new node
			setTimeout(() => {
				fitView({ maxZoom: 1, minZoom: 0.5, padding: 0.2, duration: 0 });
				viewportInitialized.current = true;
				setIsCanvasReady(true);
			}, 0);
		} else if (!hasRealNodes) {
			// Reset when back to placeholder only
			hadRealNodesRef.current = false;
		}
	}, [currentWorkflowId, hasRealNodes, fitView]);

	// Watch fitViewRequestAtom for programmatic fitView (e.g. after auto-arrange)
	const fitViewRequest = useAtomValue(fitViewRequestAtom);
	useEffect(() => {
		if (fitViewRequest > 0) {
			fitView({ padding: 0.2, duration: 300, maxZoom: 1 });
		}
	}, [fitViewRequest, fitView]);

	// Keyboard shortcut for fit view (Cmd+/ or Ctrl+/)
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// Check for Cmd+/ (Mac) or Ctrl+/ (Windows/Linux)
			if ((event.metaKey || event.ctrlKey) && event.key === "/") {
				event.preventDefault();
				fitView({ padding: 0.2, duration: 300 });
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [fitView]);

	const autoLayoutPreferenceKey = useMemo(
		() => `workflow-builder:auto-layout:${currentWorkflowId ?? "homepage"}`,
		[currentWorkflowId],
	);

	const handleAutoArrange = useCallback(
		(
			layoutOptions: Pick<
				DagreLayoutOptions,
				"strategy" | "direction" | "maxColumns"
			>,
		) => {
			const flowWrapper = document.querySelector(".react-flow");
			const wrapperWidth = flowWrapper?.getBoundingClientRect().width;
			const viewport = getViewport();
			const viewportWidth =
				wrapperWidth && viewport.zoom > 0
					? wrapperWidth / viewport.zoom
					: undefined;

			const applyLayout = async () => {
				if (layoutOptions.strategy === "elk") {
					const nextNodes = await layoutWorkflowNodesElk(nodes, edges, {
						direction: layoutOptions.direction,
					});
					setNodes(nextNodes);
					setHasUnsavedChanges(true);
					triggerAutosave({ immediate: true });
					setTimeout(() => {
						fitView({ padding: 0.2, duration: 300, maxZoom: 1 });
					}, 0);
					return;
				}

				const nextNodes = layoutWorkflowNodes(nodes, edges, {
					strategy: layoutOptions.strategy,
					direction: layoutOptions.direction,
					viewportWidth,
					maxColumns: layoutOptions.maxColumns ?? 3,
				});
				setNodes(nextNodes);
				setHasUnsavedChanges(true);
				triggerAutosave({ immediate: true });

				setTimeout(() => {
					fitView({ padding: 0.2, duration: 300, maxZoom: 1 });
				}, 0);
			};

			void applyLayout();
		},
		[
			nodes,
			edges,
			setNodes,
			setHasUnsavedChanges,
			triggerAutosave,
			fitView,
			getViewport,
		],
	);

	const addNodeFromPaletteAtCenter = useCallback(
		(nodeType: WorkflowNodeType) => {
			const flowWrapper = document.querySelector(".react-flow");
			if (!flowWrapper) {
				return;
			}
			const rect = flowWrapper.getBoundingClientRect();
			const position = screenToFlowPosition({
				x: rect.left + rect.width / 2,
				y: rect.top + rect.height / 2,
			});
			insertNodeAtConnection({
				position,
				nodeType,
			});
			setActiveTab("properties");
		},
		[insertNodeAtConnection, screenToFlowPosition, setActiveTab],
	);

	const onPaletteDragOver = useCallback(
		(event: React.DragEvent) => {
			const hasPalettePayload = Array.from(event.dataTransfer.types).includes(
				WORKFLOW_NODE_TEMPLATE_MIME,
			);
			const nodeType =
				parseStepTemplateNodeType(
					event.dataTransfer.getData(WORKFLOW_NODE_TEMPLATE_MIME) ?? "",
				) ?? paletteDragType;
			if (!(nodeType || hasPalettePayload)) {
				return;
			}

			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			if (!nodeType) {
				return;
			}

			if (!supportsInlineInsertion(nodeType)) {
				resetPotentialConnection();
				return;
			}

			const position = screenToFlowPosition({
				x: event.clientX,
				y: event.clientY,
			});
			checkForPotentialConnection({ position });
		},
		[
			checkForPotentialConnection,
			paletteDragType,
			resetPotentialConnection,
			screenToFlowPosition,
		],
	);

	const onPaletteDrop = useCallback(
		(event: React.DragEvent) => {
			const nodeType =
				parseStepTemplateNodeType(
					event.dataTransfer.getData(WORKFLOW_NODE_TEMPLATE_MIME) ?? "",
				) ?? paletteDragType;
			if (!nodeType) {
				return;
			}

			event.preventDefault();
			const dropPosition = screenToFlowPosition({
				x: event.clientX,
				y: event.clientY,
			});
			const useInlineInsert =
				Boolean(potentialConnection) && supportsInlineInsertion(nodeType);

			insertNodeAtConnection({
				position: useInlineInsert
					? (potentialConnection?.position ?? dropPosition)
					: dropPosition,
				source: useInlineInsert ? potentialConnection?.source : undefined,
				target: useInlineInsert ? potentialConnection?.target : undefined,
				nodeType,
			});
			setActiveTab("properties");
			setPaletteDragType(null);
			resetPotentialConnection();
		},
		[
			insertNodeAtConnection,
			paletteDragType,
			potentialConnection,
			resetPotentialConnection,
			screenToFlowPosition,
			setActiveTab,
		],
	);

	const getPasteFlowPosition = useCallback(() => {
		if (lastPointerScreenPosition.current) {
			return screenToFlowPosition(lastPointerScreenPosition.current);
		}

		const flowWrapper = document.querySelector(".react-flow");
		if (!flowWrapper) {
			return { x: 0, y: 0 };
		}

		const rect = flowWrapper.getBoundingClientRect();
		return screenToFlowPosition({
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
		});
	}, [screenToFlowPosition]);

	const copySelectionToClipboard = useCallback(async () => {
		const payload = collectSelectionForClipboard(nodes, edges);
		if (!payload) {
			return false;
		}
		if (!navigator.clipboard?.writeText) {
			toast.error("Clipboard is not available");
			return false;
		}

		try {
			await navigator.clipboard.writeText(
				serializeWorkflowClipboardPayload(payload),
			);
			return true;
		} catch (error) {
			console.error("Failed to copy workflow selection:", error);
			toast.error("Failed to copy selection");
			return false;
		}
	}, [nodes, edges]);

	const cutSelectionToClipboard = useCallback(async () => {
		const hasSelectedEdges = edges.some((edge) => edge.selected);
		const payload = collectSelectionForClipboard(nodes, edges);

		if (!payload && !hasSelectedEdges) {
			return false;
		}

		if (payload) {
			const copied = await copySelectionToClipboard();
			if (!copied) {
				return false;
			}
		}

		deleteSelectedItems();
		return true;
	}, [copySelectionToClipboard, deleteSelectedItems, edges, nodes]);

	const pasteSelectionFromClipboard = useCallback(async () => {
		if (!navigator.clipboard?.readText) {
			toast.error("Clipboard is not available");
			return false;
		}

		try {
			const text = await navigator.clipboard.readText();
			const payload = parseWorkflowClipboardPayload(text);
			if (!payload) {
				return false;
			}

			const { nodes: pastedNodes, edges: pastedEdges } =
				remapClipboardPayloadForPaste(payload, getPasteFlowPosition());
			if (pastedNodes.length === 0) {
				return false;
			}

			const baseNodes = nodes.map((node) => ({ ...node, selected: false }));
			const candidateNodes = [...baseNodes, ...pastedNodes];
			const baseEdges = edges.map((edge) => ({ ...edge, selected: false }));
			const acceptedPastedEdges: XYFlowEdge[] = [];
			for (const edge of pastedEdges) {
				if (
					isValidConnectionForGraph({
						connection: edge,
						nodes: candidateNodes,
						edges: [...baseEdges, ...acceptedPastedEdges],
					})
				) {
					acceptedPastedEdges.push(edge);
				}
			}

			pushHistorySnapshot();
			setNodes(candidateNodes);
			setEdges([...baseEdges, ...acceptedPastedEdges]);
			setSelectedEdge(null);
			setSelectedNode(
				pastedNodes.length === 1 ? (pastedNodes[0]?.id ?? null) : null,
			);
			setHasUnsavedChanges(true);
			triggerAutosave({ immediate: true });
			return true;
		} catch (error) {
			console.error("Failed to paste workflow selection:", error);
			toast.error("Failed to paste selection");
			return false;
		}
	}, [
		edges,
		getPasteFlowPosition,
		nodes,
		pushHistorySnapshot,
		setEdges,
		setHasUnsavedChanges,
		setNodes,
		setSelectedEdge,
		setSelectedNode,
		triggerAutosave,
	]);

	useEffect(() => {
		const handleMouseMove = (event: MouseEvent) => {
			lastPointerScreenPosition.current = {
				x: event.clientX,
				y: event.clientY,
			};
		};

		window.addEventListener("mousemove", handleMouseMove, { passive: true });
		return () => {
			window.removeEventListener("mousemove", handleMouseMove);
		};
	}, []);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (isGenerating) {
				return;
			}

			const target = event.target;
			const editable = isEditableTarget(target);
			const hasModifier = event.metaKey || event.ctrlKey;
			const key = event.key.toLowerCase();

			if (!hasModifier) {
				return;
			}

			if (key === "z") {
				if (editable) {
					return;
				}
				event.preventDefault();
				if (event.shiftKey) {
					if (canRedo) {
						redo();
					}
					return;
				}
				if (canUndo) {
					undo();
				}
				return;
			}

			if (key === "y") {
				if (editable) {
					return;
				}
				event.preventDefault();
				if (canRedo) {
					redo();
				}
				return;
			}

			if (key === "g") {
				if (editable) {
					return;
				}
				event.preventDefault();
				if (event.shiftKey) {
					const selectedGroup = nodes.find(
						(node) => node.selected && node.type === "group",
					);
					if (selectedGroup) {
						ungroupNode(selectedGroup.id);
					}
					return;
				}
				groupSelectedNodes();
				return;
			}

			const hasSelectedText =
				typeof window.getSelection === "function" &&
				(window.getSelection()?.toString().length ?? 0) > 0;

			if (key === "c") {
				if (editable || hasSelectedText) {
					return;
				}
				event.preventDefault();
				void copySelectionToClipboard();
				return;
			}

			if (key === "x") {
				if (editable || hasSelectedText) {
					return;
				}
				event.preventDefault();
				void cutSelectionToClipboard();
				return;
			}

			if (key === "v") {
				if (editable) {
					return;
				}
				event.preventDefault();
				void pasteSelectionFromClipboard();
			}
		};

		window.addEventListener("keydown", handleKeyDown, true);
		return () => {
			window.removeEventListener("keydown", handleKeyDown, true);
		};
	}, [
		canRedo,
		canUndo,
		copySelectionToClipboard,
		cutSelectionToClipboard,
		groupSelectedNodes,
		isGenerating,
		nodes,
		pasteSelectionFromClipboard,
		redo,
		undo,
		ungroupNode,
	]);

	// Auto-focus on the currently running node during execution
	const prevRunningNodeIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (
			currentRunningNodeId &&
			currentRunningNodeId !== prevRunningNodeIdRef.current
		) {
			prevRunningNodeIdRef.current = currentRunningNodeId;
			const targetNode = nodes.find((n) => n.id === currentRunningNodeId);
			if (targetNode) {
				fitView({
					nodes: [targetNode],
					padding: 0.5,
					duration: 400,
					maxZoom: 1,
				});
			}
		} else if (!currentRunningNodeId) {
			prevRunningNodeIdRef.current = null;
		}
	}, [currentRunningNodeId, nodes, fitView]);

	const nodeTypes = useMemo(
		() => ({
			trigger: TriggerNode,
			action: ActionNode,
			add: AddNode,
			group: GroupNode,
			// Dapr workflow node types
			activity: ActivityNode,
			"approval-gate": ApprovalGateNode,
			timer: TimerNode,
			"loop-until": LoopUntilNode,
			while: WhileNode,
			"if-else": IfElseNode,
			note: NoteNode,
			"set-state": SetStateNode,
			transform: TransformNode,
			"sub-workflow": SubWorkflowNode,
		}),
		[],
	);

	const nodeHasHandle = useCallback(
		(nodeId: string, handleType: "source" | "target") => {
			const node = nodes.find((n) => n.id === nodeId);

			if (!node) {
				return false;
			}

			if (node.type === "add") {
				return false;
			}
			if (node.type === "note") {
				return false;
			}
			if (node.type === "group") {
				return false;
			}

			if (handleType === "target") {
				return node.type !== "trigger";
			}

			return true;
		},
		[nodes],
	);

	const onNodeDragStop = useCallback(
		(_event: unknown, draggedNode: Node) => {
			setActiveWhileDropTarget(null);
			if (draggedNode.type === "while") {
				return;
			}

			const currentNode = nodes.find((node) => node.id === draggedNode.id);
			if (!currentNode) {
				return;
			}

			const whileNodes = nodes.filter((node) => node.type === "while");
			if (whileNodes.length === 0) {
				return;
			}

			const nodeLookup = new Map(nodes.map((node) => [node.id, node] as const));
			const nodeWithDragPosition = {
				...currentNode,
				position: draggedNode.position,
				parentId: draggedNode.parentId,
			};
			nodeLookup.set(currentNode.id, nodeWithDragPosition);
			const internalDraggedNode = getInternalNode(currentNode.id);
			const draggedAbsoluteFromStore =
				internalDraggedNode?.internals.positionAbsolute;
			const draggedAbs =
				draggedAbsoluteFromStore &&
				typeof draggedAbsoluteFromStore.x === "number" &&
				typeof draggedAbsoluteFromStore.y === "number"
					? {
							x: draggedAbsoluteFromStore.x,
							y: draggedAbsoluteFromStore.y,
						}
					: getAbsolutePosition(nodeWithDragPosition, nodeLookup);
			const center = {
				x: draggedAbs.x + WORKFLOW_NODE_SIZE / 2,
				y: draggedAbs.y + WORKFLOW_NODE_SIZE / 2,
			};

			const intersectingWhile = getIntersectingNodes(draggedNode)
				.filter((node) => node.type === "while")
				.at(0);
			const containingWhile = intersectingWhile
				? whileNodes.find((node) => node.id === intersectingWhile.id)
				: whileNodes.find((whileNode) => {
						const whileAbs = getAbsolutePosition(whileNode, nodeLookup);
						return isPointInsideWhileNode(center, whileAbs);
					});
			const currentParent =
				currentNode.parentId &&
				nodes.find(
					(node) => node.id === currentNode.parentId && node.type === "while",
				);

			const shouldBind =
				Boolean(containingWhile) && isWhileBodyCandidate(currentNode);
			const needsUnbind = Boolean(currentParent) && !containingWhile;

			if (!shouldBind && !needsUnbind) {
				return;
			}

			let changed = false;
			const nextNodes = nodes.map((node) => {
				if (node.id !== currentNode.id) {
					return node;
				}

				if (shouldBind && containingWhile) {
					const hasExistingBody = nodes.some(
						(candidate) =>
							candidate.id !== currentNode.id &&
							candidate.parentId === containingWhile.id &&
							isWhileBodyCandidate(candidate),
					);
					if (hasExistingBody) {
						return node;
					}

					const whileAbs = getAbsolutePosition(containingWhile, nodeLookup);
					const relative = clampWhileChildPosition({
						x: draggedAbs.x - whileAbs.x,
						y: draggedAbs.y - whileAbs.y,
					});

					changed =
						node.parentId !== containingWhile.id ||
						node.extent !== "parent" ||
						node.position.x !== relative.x ||
						node.position.y !== relative.y;

					return {
						...node,
						parentId: containingWhile.id,
						extent: "parent" as const,
						position: relative,
					};
				}

				if (needsUnbind) {
					changed = Boolean(node.parentId || node.extent);
					return {
						...node,
						parentId: undefined,
						extent: undefined,
						position: draggedAbs,
					};
				}

				return node;
			});

			if (!changed) {
				return;
			}

			setNodes(nextNodes);
			setHasUnsavedChanges(true);
			triggerAutosave({ immediate: true });
		},
		[
			getIntersectingNodes,
			getInternalNode,
			nodes,
			setActiveWhileDropTarget,
			setNodes,
			setHasUnsavedChanges,
			triggerAutosave,
		],
	);

	const onNodeDragStart: OnNodeDrag = useCallback(
		(_event, draggedNode) => {
			setActiveWhileDropTarget(null);
			if (draggedNode.type === "add") {
				return;
			}
			pushHistorySnapshot();
		},
		[pushHistorySnapshot, setActiveWhileDropTarget],
	);

	const onNodeDrag: OnNodeDrag = useCallback(
		(_event, draggedNode) => {
			if (draggedNode.type === "while" || draggedNode.type === "add") {
				setActiveWhileDropTarget(null);
				return;
			}

			const currentNode = nodes.find((node) => node.id === draggedNode.id);
			if (!currentNode) {
				setActiveWhileDropTarget(null);
				return;
			}

			const intersectingWhile = getIntersectingNodes(draggedNode)
				.filter((node) => node.type === "while")
				.at(0);
			if (!intersectingWhile) {
				setActiveWhileDropTarget(null);
				return;
			}

			const whileNode = nodes.find((node) => node.id === intersectingWhile.id);
			if (!whileNode) {
				setActiveWhileDropTarget(null);
				return;
			}

			const isSupported = isWhileBodyCandidate(currentNode);
			const hasExistingBody = nodes.some(
				(node) =>
					node.id !== currentNode.id &&
					node.parentId === whileNode.id &&
					isWhileBodyCandidate(node),
			);

			setActiveWhileDropTarget({
				whileId: whileNode.id,
				draggedNodeId: currentNode.id,
				state: !isSupported
					? "unsupported"
					: hasExistingBody
						? "occupied"
						: "eligible",
			});
		},
		[getIntersectingNodes, nodes, setActiveWhileDropTarget],
	);

	const onSelectionDragStart: SelectionDragHandler = useCallback(
		(_event, selectedNodes) => {
			if (selectedNodes.length === 0) {
				return;
			}
			pushHistorySnapshot();
		},
		[pushHistorySnapshot],
	);

	const isValidConnection = useCallback(
		(connection: XYFlowConnection | XYFlowEdge) =>
			isValidConnectionForGraph({ connection, nodes, edges }),
		[edges, nodes],
	);

	const onConnect: OnConnect = useCallback(
		(connection: XYFlowConnection) => {
			if (!isValidConnection(connection)) {
				return;
			}
			const newEdge = {
				id: nanoid(),
				...connection,
				type: "animated",
			};
			setEdges([...edges, newEdge]);
			setHasUnsavedChanges(true);
			// Trigger immediate autosave when nodes are connected
			triggerAutosave({ immediate: true });
		},
		[edges, isValidConnection, setEdges, setHasUnsavedChanges, triggerAutosave],
	);

	const onNodeClick: NodeMouseHandler = useCallback(
		(_event, node) => {
			setSelectedNode(node.id);
		},
		[setSelectedNode],
	);

	const onConnectStart = useCallback(
		(_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
			connectingNodeId.current = params.nodeId;
			connectingHandleType.current = params.handleType;
			connectingHandleId.current = params.handleId ?? null;
		},
		[],
	);

	const getClientPosition = useCallback((event: MouseEvent | TouchEvent) => {
		const clientX =
			"changedTouches" in event
				? event.changedTouches[0].clientX
				: event.clientX;
		const clientY =
			"changedTouches" in event
				? event.changedTouches[0].clientY
				: event.clientY;
		return { clientX, clientY };
	}, []);

	const calculateMenuPosition = useCallback(
		(event: MouseEvent | TouchEvent, clientX: number, clientY: number) => {
			const reactFlowBounds = (event.target as Element)
				.closest(".react-flow")
				?.getBoundingClientRect();

			const adjustedX = reactFlowBounds
				? clientX - reactFlowBounds.left
				: clientX;
			const adjustedY = reactFlowBounds
				? clientY - reactFlowBounds.top
				: clientY;

			return { adjustedX, adjustedY };
		},
		[],
	);

	const handleConnectionToExistingNode = useCallback(
		(nodeElement: Element) => {
			const targetNodeId = nodeElement.getAttribute("data-id");
			const fromSource = connectingHandleType.current === "source";
			const requiredHandle = fromSource ? "target" : "source";
			const connectingId = connectingNodeId.current;

			if (
				targetNodeId &&
				connectingId &&
				targetNodeId !== connectingId &&
				nodeHasHandle(targetNodeId, requiredHandle)
			) {
				const sourceId = fromSource ? connectingId : targetNodeId;
				const targetId = fromSource ? targetNodeId : connectingId;
				onConnect({
					source: sourceId,
					target: targetId,
					sourceHandle: fromSource ? connectingHandleId.current : null,
					targetHandle: fromSource ? null : connectingHandleId.current,
				});
			}
		},
		[nodeHasHandle, onConnect],
	);

	const handleConnectionToNewNode = useCallback(
		(event: MouseEvent | TouchEvent, clientX: number, clientY: number) => {
			const sourceNodeId = connectingNodeId.current;
			if (!sourceNodeId) {
				return;
			}

			const { adjustedX, adjustedY } = calculateMenuPosition(
				event,
				clientX,
				clientY,
			);

			// Get the action template
			const actionTemplate = nodeTemplates.find((t) => t.type === "action");
			if (!actionTemplate) {
				return;
			}

			// Get the position in the flow coordinate system
			const position = screenToFlowPosition({
				x: adjustedX,
				y: adjustedY,
			});

			// Center the node vertically at the cursor position
			// Node height is 192px (h-48 in Tailwind)
			const nodeHeight = 192;
			position.y -= nodeHeight / 2;

			const newNode: WorkflowNode = {
				id: nanoid(),
				type: actionTemplate.type,
				position,
				data: {
					label: actionTemplate.label,
					description: actionTemplate.description,
					type: actionTemplate.type,
					config: actionTemplate.defaultConfig,
					status: "idle",
				},
				selected: true,
			};

			addNode(newNode);
			setSelectedNode(newNode.id);
			setActiveTab("properties");

			// Deselect all other nodes and select only the new node
			// Need to do this after a delay because panOnDrag will clear selection
			setTimeout(() => {
				setNodes((currentNodes) =>
					currentNodes.map((n) => ({
						...n,
						selected: n.id === newNode.id,
					})),
				);
			}, 50);

			// Create connection from the source node to the new node
			const fromSource = connectingHandleType.current === "source";

			const newEdge = {
				id: nanoid(),
				source: fromSource ? sourceNodeId : newNode.id,
				target: fromSource ? newNode.id : sourceNodeId,
				sourceHandle: fromSource ? connectingHandleId.current : null,
				targetHandle: fromSource ? null : connectingHandleId.current,
				type: "animated",
			};
			setEdges([...edges, newEdge]);
			setHasUnsavedChanges(true);
			// Trigger immediate autosave for the new edge
			triggerAutosave({ immediate: true });

			// Set flag to prevent immediate deselection
			justCreatedNodeFromConnection.current = true;
			setTimeout(() => {
				justCreatedNodeFromConnection.current = false;
			}, 100);
		},
		[
			calculateMenuPosition,
			screenToFlowPosition,
			addNode,
			edges,
			setEdges,
			setNodes,
			setSelectedNode,
			setActiveTab,
			setHasUnsavedChanges,
			triggerAutosave,
		],
	);

	const onConnectEnd = useCallback(
		(event: MouseEvent | TouchEvent) => {
			if (!connectingNodeId.current) {
				return;
			}

			// Get client position first
			const { clientX, clientY } = getClientPosition(event);

			// For touch events, use elementFromPoint to get the actual element at the touch position
			// For mouse events, use event.target as before
			const target =
				"changedTouches" in event
					? document.elementFromPoint(clientX, clientY)
					: (event.target as Element);

			if (!target) {
				connectingNodeId.current = null;
				connectingHandleType.current = null;
				connectingHandleId.current = null;
				return;
			}

			const nodeElement = target.closest(".react-flow__node");
			const isHandle = target.closest(".react-flow__handle");

			// Create connection on edge dragged over node release
			if (nodeElement && !isHandle && connectingHandleType.current) {
				handleConnectionToExistingNode(nodeElement);
				connectingNodeId.current = null;
				connectingHandleType.current = null;
				connectingHandleId.current = null;
				return;
			}

			if (!(nodeElement || isHandle)) {
				handleConnectionToNewNode(event, clientX, clientY);
			}

			connectingNodeId.current = null;
			connectingHandleType.current = null;
			connectingHandleId.current = null;
		},
		[
			getClientPosition,
			handleConnectionToExistingNode,
			handleConnectionToNewNode,
		],
	);

	const onPaneClick = useCallback(() => {
		// Don't deselect if we just created a node from a connection
		if (justCreatedNodeFromConnection.current) {
			return;
		}
		setActiveWhileDropTarget(null);
		setSelectedNode(null);
		setSelectedEdge(null);
		closeContextMenu();
	}, [
		setActiveWhileDropTarget,
		setSelectedNode,
		setSelectedEdge,
		closeContextMenu,
	]);

	const onSelectionChange = useCallback(
		({ nodes: selectedNodes }: { nodes: Node[] }) => {
			// Don't clear selection if we just created a node from a connection
			if (justCreatedNodeFromConnection.current && selectedNodes.length === 0) {
				return;
			}

			if (selectedNodes.length === 0) {
				setSelectedNode(null);
			} else if (selectedNodes.length === 1) {
				setSelectedNode(selectedNodes[0].id);
			}
		},
		[setSelectedNode],
	);

	return (
		<div
			className="relative h-full bg-background"
			data-testid="workflow-canvas"
			style={{
				opacity: isCanvasReady ? 1 : 0,
				width: rightPanelWidth ? `calc(100% - ${rightPanelWidth})` : "100%",
				transition: isPanelAnimating
					? "width 300ms ease-out, opacity 300ms"
					: "opacity 300ms",
			}}
		>
			{/* Toolbar */}
			<div className="pointer-events-auto">
				<WorkflowToolbar workflowId={currentWorkflowId ?? undefined} />
			</div>

			{/* Approval Banner */}
			<ApprovalBanner />

			{/* React Flow Canvas */}
			<Canvas
				className="bg-background"
				connectionLineComponent={Connection}
				connectionMode={ConnectionMode.Strict}
				edges={edgesWithValidation}
				edgeTypes={edgeTypes}
				elementsSelectable={!isGenerating}
				isValidConnection={isValidConnection}
				multiSelectionKeyCode="Shift"
				nodes={nodes}
				nodesConnectable={!isGenerating}
				nodesDraggable={!isGenerating}
				nodeTypes={nodeTypes}
				onConnect={isGenerating ? undefined : onConnect}
				onConnectEnd={isGenerating ? undefined : onConnectEnd}
				onConnectStart={isGenerating ? undefined : onConnectStart}
				onEdgeContextMenu={isGenerating ? undefined : onEdgeContextMenu}
				onEdgesChange={isGenerating ? undefined : onEdgesChange}
				onNodeClick={isGenerating ? undefined : onNodeClick}
				onNodeDrag={isGenerating ? undefined : onNodeDrag}
				onNodeDragStart={isGenerating ? undefined : onNodeDragStart}
				onNodeDragStop={isGenerating ? undefined : onNodeDragStop}
				onNodeContextMenu={isGenerating ? undefined : onNodeContextMenu}
				onNodesChange={isGenerating ? undefined : onNodesChange}
				onPaneClick={onPaneClick}
				onPaneContextMenu={isGenerating ? undefined : onPaneContextMenu}
				onDrop={isGenerating ? undefined : onPaletteDrop}
				onDragOver={isGenerating ? undefined : onPaletteDragOver}
				onSelectionDragStart={isGenerating ? undefined : onSelectionDragStart}
				onSelectionChange={isGenerating ? undefined : onSelectionChange}
				selectionMode={SelectionMode.Partial}
			>
				<Panel
					className="pointer-events-none border-none bg-transparent p-0"
					position="top-left"
				>
					<StepPalette
						className="pointer-events-auto ml-2 mt-14"
						disabled={isGenerating}
						onDragEnd={() => {
							setPaletteDragType(null);
							resetPotentialConnection();
						}}
						onDragStart={setPaletteDragType}
						onSelectNodeType={addNodeFromPaletteAtCenter}
					/>
				</Panel>
				<Panel
					className="workflow-controls-panel border-none bg-transparent p-0"
					position="bottom-left"
				>
					<Controls
						layoutPreferenceKey={autoLayoutPreferenceKey}
						onAutoArrange={isGenerating ? undefined : handleAutoArrange}
					/>
				</Panel>
				{showMinimap && (
					<MiniMap bgColor="var(--sidebar)" nodeStrokeColor="var(--border)" />
				)}
			</Canvas>

			{currentWorkflowId &&
				isOwner &&
				!(activeTab === "ai" && rightPanelWidth) && (
					<CanvasAiChatInput workflowId={currentWorkflowId} />
				)}

			{/* Context Menu */}
			<WorkflowContextMenu
				menuState={contextMenuState}
				onClose={closeContextMenu}
			/>
		</div>
	);
}
