"use client";

import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import {
	currentWorkflowNameAtom,
	edgesAtom,
	isGeneratingAtom,
	nodesAtom,
	selectedNodeAtom,
	workflowAiMessagesAtom,
	workflowAiMessagesLoadingAtom,
	workflowAiMessagesWorkflowIdAtom,
	type WorkflowAiMessage,
	type WorkflowEdge,
	type WorkflowNode,
} from "@/lib/workflow-store";

function isNodeIncomplete(node: WorkflowNode): boolean {
	const nodeType = node.data?.type;
	const config = node.data?.config || {};

	if (nodeType === "trigger") {
		return !config.triggerType;
	}

	if (nodeType === "action") {
		return !config.actionType;
	}

	return false;
}

export function useWorkflowAiChat(workflowId: string) {
	const [isGenerating, setIsGenerating] = useAtom(isGeneratingAtom);
	const [nodes, setNodes] = useAtom(nodesAtom);
	const [edges, setEdges] = useAtom(edgesAtom);
	const [currentWorkflowName, setCurrentWorkflowName] = useAtom(
		currentWorkflowNameAtom,
	);
	const setSelectedNode = useSetAtom(selectedNodeAtom);
	const [messages, setMessages] = useAtom(workflowAiMessagesAtom);
	const [isLoadingMessages, setIsLoadingMessages] = useAtom(
		workflowAiMessagesLoadingAtom,
	);
	const [messagesWorkflowId, setMessagesWorkflowId] = useAtom(
		workflowAiMessagesWorkflowIdAtom,
	);

	const realNodes = useMemo(
		() => nodes.filter((node) => node.type !== "add"),
		[nodes],
	);

	const isBlankWorkflow = useMemo(() => {
		if (edges.length > 0) {
			return false;
		}
		if (realNodes.length !== 1) {
			return false;
		}
		const onlyNode = realNodes[0];
		return onlyNode?.data?.type === "trigger";
	}, [edges.length, realNodes]);

	const refreshMessages = useCallback(async () => {
		setIsLoadingMessages(true);
		try {
			const response = await api.aiChat.getMessages(workflowId);
			setMessages(response.messages as WorkflowAiMessage[]);
			setMessagesWorkflowId(workflowId);
		} catch (error) {
			console.error("Failed to load AI chat messages:", error);
			toast.error("Failed to load AI chat history");
		} finally {
			setIsLoadingMessages(false);
		}
	}, [workflowId, setIsLoadingMessages, setMessages, setMessagesWorkflowId]);

	useEffect(() => {
		if (messagesWorkflowId === workflowId || isLoadingMessages) {
			return;
		}

		setMessages([]);
		void refreshMessages();
	}, [
		workflowId,
		messagesWorkflowId,
		isLoadingMessages,
		setMessages,
		refreshMessages,
	]);

	const submit = useCallback(
		async (prompt: string) => {
			const trimmedPrompt = prompt.trim();
			if (!trimmedPrompt || isGenerating) {
				return;
			}

			setIsGenerating(true);
			setMessagesWorkflowId(workflowId);

			const optimisticUserMessage: WorkflowAiMessage = {
				id: `tmp-user-${Date.now()}`,
				role: "user",
				content: trimmedPrompt,
				operations: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			setMessages((previous) => [...previous, optimisticUserMessage]);

			try {
				const existingWorkflow =
					realNodes.length > 0 && !isBlankWorkflow
						? {
								nodes: realNodes,
								edges,
								name: currentWorkflowName,
							}
						: undefined;

				const workflowData = await api.aiChat.generateStream(
					workflowId,
					trimmedPrompt,
					(partialData) => {
						const edgesWithAnimatedType = (partialData.edges || []).map(
							(edge) => ({
								...edge,
								type: "animated",
							}),
						);

						const triggerNodes = (partialData.nodes || []).filter(
							(node) => node.data?.type === "trigger",
						);

						let validEdges = edgesWithAnimatedType;

						if (triggerNodes.length > 1) {
							const firstTrigger = triggerNodes[0];
							const nonTriggerNodes = (partialData.nodes || []).filter(
								(node) => node.data?.type !== "trigger",
							);
							partialData.nodes = [firstTrigger, ...nonTriggerNodes];

							const removedTriggerIds = triggerNodes
								.slice(1)
								.map((node) => node.id);
							validEdges = edgesWithAnimatedType.filter(
								(edge) =>
									!removedTriggerIds.includes(edge.source) &&
									!removedTriggerIds.includes(edge.target),
							);
						}

						setNodes(partialData.nodes || []);
						setEdges(validEdges);
						if (partialData.name) {
							setCurrentWorkflowName(partialData.name);
						}
					},
					existingWorkflow,
				);

				const finalEdges = (workflowData.edges || []).map((edge) => ({
					...edge,
					type: "animated",
				}));

				const incompleteNodes = (workflowData.nodes || []).filter((node) =>
					isNodeIncomplete(node),
				);
				if (incompleteNodes.length > 0) {
					throw new Error(
						`Cannot create workflow: generated ${incompleteNodes.length} incomplete node(s).`,
					);
				}

				const selectedNode = workflowData.nodes?.find(
					(node: { id?: string; selected?: boolean }) => node.selected,
				);
				if (selectedNode?.id) {
					setSelectedNode(selectedNode.id);
				}

				await api.workflow.update(workflowId, {
					name: workflowData.name,
					description: workflowData.description,
					nodes: workflowData.nodes,
					edges: finalEdges as WorkflowEdge[],
				});

				await refreshMessages();
			} catch (error) {
				console.error("Failed to generate workflow from AI chat:", error);
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to generate workflow from chat",
				);
				await refreshMessages();
			} finally {
				setIsGenerating(false);
			}
		},
		[
			isGenerating,
			setIsGenerating,
			setMessagesWorkflowId,
			workflowId,
			setMessages,
			realNodes,
			isBlankWorkflow,
			edges,
			currentWorkflowName,
			setNodes,
			setEdges,
			setCurrentWorkflowName,
			setSelectedNode,
			refreshMessages,
		],
	);

	const scopedMessages = useMemo(
		() => (messagesWorkflowId === workflowId ? messages : []),
		[messagesWorkflowId, workflowId, messages],
	);

	return {
		isGenerating,
		isLoadingMessages:
			isLoadingMessages &&
			(messagesWorkflowId === workflowId || !messagesWorkflowId),
		messages: scopedMessages,
		refreshMessages,
		submit,
	};
}
