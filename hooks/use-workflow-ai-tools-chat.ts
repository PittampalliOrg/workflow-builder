"use client";

import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useAtom, useSetAtom, useAtomValue } from "jotai";
import type { UIMessage } from "ai";
import { DefaultChatTransport, readUIMessageStream, generateId } from "ai";
import { toast } from "sonner";
import {
	nodesAtom,
	edgesAtom,
	selectedNodeAtom,
	isGeneratingAtom,
	currentWorkflowNameAtom,
	addNodeAtom,
	updateNodeDataAtom,
	deleteNodeAtom,
	addEdgeAtom,
	deleteEdgeAtom,
	clearWorkflowAtom,
	autoArrangeAtom,
	executionLogsAtom,
	currentWorkflowEngineTypeAtom,
	hasUnsavedChangesAtom,
	isExecutingAtom,
	currentRunningNodeIdAtom,
	daprPhaseAtom,
	daprMessageAtom,
	approvalEventNameAtom,
	approvalExecutionIdAtom,
} from "@/lib/workflow-store";
import { api } from "@/lib/api-client";
import type { WorkflowAiMentionRef } from "@/lib/ai/workflow-ai-tools";
import type { ExecutionLogEntry } from "@/lib/workflow-store";
import {
	dispatchCanvasToolResult,
	type CanvasAtomSetters,
} from "@/lib/ai/canvas-tool-dispatch";
import type { CanvasToolResult } from "@/lib/ai/canvas-tools";

export type ToolsChatStatus = "ready" | "submitted" | "streaming" | "error";

function prepareExecutionLogs(logs: Record<string, ExecutionLogEntry>) {
	return Object.values(logs).map((entry) => {
		let outputPreview: string | undefined;
		if (entry.output !== undefined) {
			const raw =
				typeof entry.output === "string"
					? entry.output
					: JSON.stringify(entry.output);
			outputPreview =
				raw.length > 300 ? raw.slice(0, 300) + "...[truncated]" : raw;
		}
		return {
			nodeId: entry.nodeId,
			nodeName: entry.nodeName,
			status: entry.status,
			actionType: entry.actionType,
			outputPreview,
		};
	});
}

export function useWorkflowAiToolsChat(workflowId: string) {
	const [messages, setMessages] = useState<UIMessage[]>([]);
	const [status, setStatus] = useState<ToolsChatStatus>("ready");
	const [error, setError] = useState<string | null>(null);
	const [isLoadingMessages, setIsLoadingMessages] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	const [nodes] = useAtom(nodesAtom);
	const [edges] = useAtom(edgesAtom);
	const [isGenerating, setIsGenerating] = useAtom(isGeneratingAtom);
	const [workflowName, setWorkflowName] = useAtom(currentWorkflowNameAtom);

	// Read-only atoms for context injection
	const selectedNodeId = useAtomValue(selectedNodeAtom);
	const executionLogs = useAtomValue(executionLogsAtom);
	const engineType = useAtomValue(currentWorkflowEngineTypeAtom);
	const hasUnsavedChanges = useAtomValue(hasUnsavedChangesAtom);
	const isExecuting = useAtomValue(isExecutingAtom);
	const currentRunningNodeId = useAtomValue(currentRunningNodeIdAtom);
	const daprPhase = useAtomValue(daprPhaseAtom);
	const daprMessage = useAtomValue(daprMessageAtom);
	const approvalEventName = useAtomValue(approvalEventNameAtom);
	const approvalExecutionId = useAtomValue(approvalExecutionIdAtom);

	const addNode = useSetAtom(addNodeAtom);
	const updateNodeData = useSetAtom(updateNodeDataAtom);
	const deleteNode = useSetAtom(deleteNodeAtom);
	const addEdge = useSetAtom(addEdgeAtom);
	const deleteEdge = useSetAtom(deleteEdgeAtom);
	const setSelectedNode = useSetAtom(selectedNodeAtom);
	const clearWorkflow = useSetAtom(clearWorkflowAtom);
	const autoArrange = useSetAtom(autoArrangeAtom);

	// Build atom setters object for the dispatcher
	const atomSetters = useMemo<CanvasAtomSetters>(
		() => ({
			addNode,
			updateNodeData,
			deleteNode,
			addEdge,
			deleteEdge,
			setWorkflowName: setWorkflowName,
			setSelectedNode,
			getNodes: () => nodesRef.current,
			clearWorkflow,
			autoArrange,
		}),
		[
			addNode,
			updateNodeData,
			deleteNode,
			addEdge,
			deleteEdge,
			setWorkflowName,
			setSelectedNode,
			clearWorkflow,
			autoArrange,
		],
	);

	// Track which tool call IDs have been dispatched to avoid double-dispatch
	const dispatchedToolCallsRef = useRef(new Set<string>());
	const mentionRefsRef = useRef<WorkflowAiMentionRef[]>([]);

	// Derive selected node IDs from React Flow's selection state
	const selectedNodeIds = useMemo(
		() => nodes.filter((n) => n.selected).map((n) => n.id),
		[nodes],
	);

	// Keep refs fresh with latest canvas state so transport body reads current values
	const nodesRef = useRef(nodes);
	const edgesRef = useRef(edges);
	const nameRef = useRef(workflowName);
	const selectedNodeIdRef = useRef(selectedNodeId);
	const selectedNodeIdsRef = useRef(selectedNodeIds);
	const executionLogsRef = useRef(executionLogs);
	const engineTypeRef = useRef(engineType);
	const hasUnsavedChangesRef = useRef(hasUnsavedChanges);
	const isExecutingRef = useRef(isExecuting);
	const currentRunningNodeIdRef = useRef(currentRunningNodeId);
	const daprPhaseRef = useRef(daprPhase);
	const daprMessageRef = useRef(daprMessage);
	const approvalEventNameRef = useRef(approvalEventName);
	const approvalExecutionIdRef = useRef(approvalExecutionId);
	nodesRef.current = nodes;
	edgesRef.current = edges;
	nameRef.current = workflowName;
	selectedNodeIdRef.current = selectedNodeId;
	selectedNodeIdsRef.current = selectedNodeIds;
	executionLogsRef.current = executionLogs;
	engineTypeRef.current = engineType;
	hasUnsavedChangesRef.current = hasUnsavedChanges;
	isExecutingRef.current = isExecuting;
	currentRunningNodeIdRef.current = currentRunningNodeId;
	daprPhaseRef.current = daprPhase;
	daprMessageRef.current = daprMessage;
	approvalEventNameRef.current = approvalEventName;
	approvalExecutionIdRef.current = approvalExecutionId;

	const makeTransportBody = useCallback(() => {
		const logs = executionLogsRef.current;
		const hasLogs = Object.keys(logs).length > 0;
		return {
			mentionRefs: mentionRefsRef.current,
			canvasState: {
				// Existing fields
				nodes: nodesRef.current.filter((n) => n.type !== "add"),
				edges: edgesRef.current,
				name: nameRef.current,
				// Tier 1: always included
				selectedNodeId: selectedNodeIdRef.current,
				...(selectedNodeIdsRef.current.length > 1 && {
					selectedNodeIds: selectedNodeIdsRef.current,
				}),
				engineType: engineTypeRef.current,
				hasUnsavedChanges: hasUnsavedChangesRef.current,
				// Tier 2: conditional
				...(isExecutingRef.current && { isExecuting: true }),
				...(isExecutingRef.current &&
					currentRunningNodeIdRef.current && {
						currentRunningNodeId: currentRunningNodeIdRef.current,
					}),
				...(hasLogs && {
					executionLogs: prepareExecutionLogs(logs),
				}),
				// Tier 3: Dapr-specific
				...(daprPhaseRef.current && {
					daprPhase: daprPhaseRef.current,
					daprMessage: daprMessageRef.current || undefined,
				}),
				...(approvalEventNameRef.current && {
					approvalEventName: approvalEventNameRef.current,
					approvalExecutionId: approvalExecutionIdRef.current,
				}),
			},
		};
	}, []);

	// Custom fetch that auto-refreshes the session token on 401 (mirrors apiCall behaviour)
	const fetchWithRefresh: typeof globalThis.fetch = useCallback(
		async (input, init) => {
			let response = await globalThis.fetch(input, init);
			if (response.status === 401) {
				const refreshRes = await globalThis.fetch("/api/v1/auth/refresh", {
					method: "POST",
				});
				if (refreshRes.ok) {
					response = await globalThis.fetch(input, init);
				}
			}
			return response;
		},
		[],
	);

	const transportRef = useRef(
		new DefaultChatTransport({
			api: `/api/workflows/${workflowId}/ai-chat/tools`,
			body: makeTransportBody,
			fetch: fetchWithRefresh,
		}),
	);

	const loadMessages = useCallback(async () => {
		setIsLoadingMessages(true);
		try {
			const response = await api.aiChat.getToolMessages(workflowId);
			setMessages(response.messages as UIMessage[]);
		} catch (loadError) {
			console.error("[ai-tools-chat] Failed to load history:", loadError);
			toast.error("Failed to load AI chat history");
		} finally {
			setIsLoadingMessages(false);
		}
	}, [workflowId]);

	useEffect(() => {
		transportRef.current = new DefaultChatTransport({
			api: `/api/workflows/${workflowId}/ai-chat/tools`,
			body: makeTransportBody,
			fetch: fetchWithRefresh,
		});
		setMessages([]);
		setStatus("ready");
		setError(null);
		dispatchedToolCallsRef.current.clear();
		mentionRefsRef.current = [];
		void loadMessages();
	}, [workflowId, makeTransportBody, fetchWithRefresh, loadMessages]);

	const sendMessage = useCallback(
		async ({
			text,
			mentionRefs,
		}: {
			text: string;
			mentionRefs?: WorkflowAiMentionRef[];
		}) => {
			if (!text.trim() || isGenerating) return;

			mentionRefsRef.current = mentionRefs ?? [];

			const userMessage: UIMessage = {
				id: generateId(),
				role: "user",
				parts: [{ type: "text", text }],
			};

			const updatedMessages = [...messages, userMessage];
			setMessages(updatedMessages);
			setStatus("submitted");
			setError(null);
			setIsGenerating(true);

			const abortController = new AbortController();
			abortRef.current = abortController;

			try {
				const chunkStream = await transportRef.current.sendMessages({
					chatId: `ai-tools-${workflowId}`,
					messageId: undefined,
					messages: updatedMessages,
					abortSignal: abortController.signal,
					trigger: "submit-message",
				});

				setStatus("streaming");

				const messageStream = readUIMessageStream({
					stream: chunkStream,
				});

				let latestMessages = updatedMessages;
				for await (const message of messageStream) {
					const existingIdx = latestMessages.findIndex(
						(m) => m.id === message.id,
					);
					if (existingIdx >= 0) {
						latestMessages = [
							...latestMessages.slice(0, existingIdx),
							message,
							...latestMessages.slice(existingIdx + 1),
						];
					} else {
						latestMessages = [...latestMessages, message];
					}
					setMessages([...latestMessages]);

					// Process tool result parts for canvas dispatch
					for (const part of message.parts || []) {
						if (
							(part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
							"state" in part &&
							part.state === "output-available" &&
							"toolCallId" in part &&
							"output" in part
						) {
							const toolCallId = part.toolCallId as string;
							if (!dispatchedToolCallsRef.current.has(toolCallId)) {
								dispatchedToolCallsRef.current.add(toolCallId);
								const output = part.output as CanvasToolResult;
								if (output && typeof output.op === "string") {
									// presentOptions is UI-only, no canvas dispatch needed
									if (output.op !== "presentOptions") {
										dispatchCanvasToolResult(output, atomSetters);
									}
								}
							}
						}
					}
				}

				setStatus("ready");
			} catch (err) {
				if ((err as Error).name !== "AbortError") {
					console.error("[ai-tools-chat] Error:", err);
					const msg = err instanceof Error ? err.message : "Unknown error";
					setError(msg);
					setStatus("error");
				}
			} finally {
				abortRef.current = null;
				mentionRefsRef.current = [];
				setIsGenerating(false);
			}
		},
		[messages, isGenerating, setIsGenerating, workflowId, atomSetters],
	);

	const clearMessages = useCallback(() => {
		setMessages([]);
		setStatus("ready");
		setError(null);
		dispatchedToolCallsRef.current.clear();
		mentionRefsRef.current = [];
	}, []);

	const clearConversation = useCallback(async () => {
		if (isGenerating) {
			return;
		}
		try {
			await api.aiChat.clear(workflowId);
			clearMessages();
			toast.success("AI chat history cleared");
		} catch (clearError) {
			console.error("[ai-tools-chat] Failed to clear history:", clearError);
			toast.error("Failed to clear AI chat history");
		}
	}, [clearMessages, isGenerating, workflowId]);

	// Reactive snapshot of context sent to the LLM (for debug display)
	const contextSnapshot = useMemo(() => {
		const logs = executionLogs;
		const hasLogs = Object.keys(logs).length > 0;
		return {
			selectedNodeId,
			selectedNodeIds: selectedNodeIds.length > 1 ? selectedNodeIds : undefined,
			engineType,
			hasUnsavedChanges,
			isExecuting,
			currentRunningNodeId: isExecuting ? currentRunningNodeId : null,
			executionLogs: hasLogs ? prepareExecutionLogs(logs) : undefined,
			daprPhase,
			daprMessage: daprPhase ? daprMessage : undefined,
			approvalEventName,
			approvalExecutionId: approvalEventName ? approvalExecutionId : undefined,
		};
	}, [
		selectedNodeId,
		selectedNodeIds,
		engineType,
		hasUnsavedChanges,
		isExecuting,
		currentRunningNodeId,
		executionLogs,
		daprPhase,
		daprMessage,
		approvalEventName,
		approvalExecutionId,
	]);

	return {
		messages,
		sendMessage,
		status,
		error,
		isGenerating,
		isLoadingMessages,
		clearMessages,
		clearConversation,
		contextSnapshot,
		nodes,
	};
}
