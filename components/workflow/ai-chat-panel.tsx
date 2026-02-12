"use client";

import { useAtom, useSetAtom } from "jotai";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { api, type WorkflowAiChatMessage } from "@/lib/api-client";
import {
	currentWorkflowNameAtom,
	edgesAtom,
	isGeneratingAtom,
	nodesAtom,
	selectedNodeAtom,
	type WorkflowEdge,
	type WorkflowNode,
} from "@/lib/workflow-store";

type AiChatPanelProps = {
	workflowId: string;
};

function formatTimestamp(iso: string): string {
	return new Date(iso).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

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

export function AiChatPanel({ workflowId }: AiChatPanelProps) {
	const [isGenerating, setIsGenerating] = useAtom(isGeneratingAtom);
	const [nodes, setNodes] = useAtom(nodesAtom);
	const [edges, setEdges] = useAtom(edgesAtom);
	const [currentWorkflowName, setCurrentWorkflowName] = useAtom(
		currentWorkflowNameAtom,
	);
	const setSelectedNode = useSetAtom(selectedNodeAtom);

	const [messages, setMessages] = useState<WorkflowAiChatMessage[]>([]);
	const [isLoadingMessages, setIsLoadingMessages] = useState(true);

	const realNodes = useMemo(
		() => nodes.filter((node) => node.type !== "add"),
		[nodes],
	);

	const loadMessages = useCallback(async () => {
		setIsLoadingMessages(true);
		try {
			const response = await api.aiChat.getMessages(workflowId);
			setMessages(response.messages);
		} catch (error) {
			console.error("Failed to load AI chat messages:", error);
			toast.error("Failed to load AI chat history");
		} finally {
			setIsLoadingMessages(false);
		}
	}, [workflowId]);

	useEffect(() => {
		loadMessages();
	}, [loadMessages]);

	const handleSubmit = useCallback(
		async (prompt: string) => {
			if (!prompt.trim() || isGenerating) {
				return;
			}

			setIsGenerating(true);

			const optimisticUserMessage: WorkflowAiChatMessage = {
				id: `tmp-user-${Date.now()}`,
				role: "user",
				content: prompt.trim(),
				operations: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			setMessages((previous) => [...previous, optimisticUserMessage]);

			try {
				const existingWorkflow =
					realNodes.length > 0
						? {
								nodes: realNodes,
								edges,
								name: currentWorkflowName,
							}
						: undefined;

				const workflowData = await api.aiChat.generateStream(
					workflowId,
					prompt,
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

				await loadMessages();
			} catch (error) {
				console.error("Failed to generate workflow from AI chat:", error);
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to generate workflow from chat",
				);
				await loadMessages();
			} finally {
				setIsGenerating(false);
			}
		},
		[
			isGenerating,
			realNodes,
			edges,
			currentWorkflowName,
			workflowId,
			setIsGenerating,
			setNodes,
			setEdges,
			setCurrentWorkflowName,
			setSelectedNode,
			loadMessages,
		],
	);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex-1 space-y-3 overflow-y-auto p-4">
				{isLoadingMessages ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2 className="size-4 animate-spin" />
						Loading chat history...
					</div>
				) : messages.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						Ask AI to create or modify this workflow.
					</p>
				) : (
					messages.map((message) => (
						<div
							className={`max-w-[90%] rounded-lg border px-3 py-2 text-sm ${
								message.role === "user"
									? "ml-auto bg-secondary text-secondary-foreground"
									: "bg-background"
							}`}
							key={message.id}
						>
							<div className="mb-1 text-muted-foreground text-xs">
								{message.role === "user" ? "You" : "AI"} ·{" "}
								{formatTimestamp(message.createdAt)}
							</div>
							<p className="whitespace-pre-wrap">{message.content}</p>
						</div>
					))
				)}
			</div>

			<div className="shrink-0 border-t p-3">
				<PromptInput
					className="w-full"
					onSubmit={async (message) => {
						await handleSubmit(message.text ?? "");
					}}
				>
					<PromptInputBody>
						<PromptInputTextarea
							disabled={isGenerating}
							placeholder="Describe how to build or update this workflow..."
						/>
					</PromptInputBody>
					<PromptInputFooter>
						<div className="text-muted-foreground text-xs">
							{isGenerating ? "Generating workflow..." : "Enter to send"}
						</div>
						<PromptInputSubmit
							disabled={isGenerating}
							status={isGenerating ? "submitted" : "ready"}
						/>
					</PromptInputFooter>
				</PromptInput>
			</div>
		</div>
	);
}
