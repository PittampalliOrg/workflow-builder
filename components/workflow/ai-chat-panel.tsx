"use client";

import { useState, useEffect, useRef } from "react";
import {
	Loader2,
	CheckCircle2,
	Eye,
	EyeOff,
	AlertTriangle,
	CheckCircle,
	XCircle,
	Clock,
	Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiChatComposer } from "@/components/workflow/ai-chat-composer";
import { useWorkflowAiToolsChat } from "@/hooks/use-workflow-ai-tools-chat";
import type { CanvasToolResult } from "@/lib/ai/canvas-tools";
import type { WorkflowNode } from "@/lib/workflow-store";

type ContextSnapshot = {
	selectedNodeId: string | null;
	selectedNodeIds?: string[];
	engineType: string;
	hasUnsavedChanges: boolean;
	isExecuting: boolean;
	currentRunningNodeId: string | null;
	executionLogs?: Array<{
		nodeId: string;
		nodeName: string;
		status: string;
		actionType?: string | null;
		outputPreview?: string;
	}>;
	daprPhase?: string | null;
	daprMessage?: string | null;
	approvalEventName?: string | null;
	approvalExecutionId?: string | null;
};

function AiContextDebug({
	snapshot,
	nodes,
}: {
	snapshot: ContextSnapshot;
	nodes: WorkflowNode[];
}) {
	const selectedNode = snapshot.selectedNodeId
		? nodes.find((n) => n.id === snapshot.selectedNodeId)
		: null;

	return (
		<div className="rounded border border-dashed border-muted-foreground/30 bg-muted/30 p-2.5 text-xs space-y-1.5">
			<div className="flex items-center gap-2 flex-wrap">
				<span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
					Engine: {snapshot.engineType || "default"}
				</span>
				{snapshot.hasUnsavedChanges && (
					<span className="flex items-center gap-1 rounded bg-yellow-500/10 px-1.5 py-0.5 text-yellow-600 dark:text-yellow-400">
						<AlertTriangle className="h-3 w-3" />
						Unsaved changes
					</span>
				)}
				{snapshot.isExecuting && (
					<span className="flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-600 dark:text-blue-400">
						<Play className="h-3 w-3" />
						Executing...
					</span>
				)}
			</div>

			{snapshot.selectedNodeIds && snapshot.selectedNodeIds.length > 1 ? (
				<div className="text-muted-foreground">
					Selected ({snapshot.selectedNodeIds.length}):{" "}
					{snapshot.selectedNodeIds.map((id) => {
						const n = nodes.find((node) => node.id === id);
						return (
							<span key={id} className="font-medium text-foreground">
								&quot;{n?.data.label || id}&quot;{" "}
							</span>
						);
					})}
				</div>
			) : selectedNode ? (
				<div className="text-muted-foreground">
					Selected:{" "}
					<span className="font-medium text-foreground">
						&quot;{selectedNode.data.label}&quot;
					</span>{" "}
					<span className="opacity-70">({selectedNode.data.type})</span>
				</div>
			) : null}

			{snapshot.isExecuting && snapshot.currentRunningNodeId && (
				<div className="text-muted-foreground">
					Running node:{" "}
					<span className="font-medium text-foreground">
						{nodes.find((n) => n.id === snapshot.currentRunningNodeId)?.data
							.label || snapshot.currentRunningNodeId}
					</span>
				</div>
			)}

			{snapshot.daprPhase && (
				<div className="text-muted-foreground">
					Dapr phase:{" "}
					<span className="font-medium text-foreground">
						{snapshot.daprPhase}
					</span>
					{snapshot.daprMessage && (
						<span className="opacity-70"> - {snapshot.daprMessage}</span>
					)}
				</div>
			)}

			{snapshot.approvalEventName && (
				<div className="flex items-center gap-1 text-muted-foreground">
					<Clock className="h-3 w-3" />
					Waiting for approval:{" "}
					<span className="font-medium text-foreground">
						{snapshot.approvalEventName}
					</span>
				</div>
			)}

			{snapshot.executionLogs && snapshot.executionLogs.length > 0 && (
				<div className="space-y-0.5 border-t border-muted-foreground/20 pt-1.5 mt-1">
					<div className="font-medium text-muted-foreground mb-1">Last Run</div>
					{snapshot.executionLogs.map((log) => (
						<div key={log.nodeId} className="flex items-start gap-1.5">
							{log.status === "success" && (
								<CheckCircle className="h-3 w-3 mt-0.5 text-green-600 shrink-0" />
							)}
							{log.status === "error" && (
								<XCircle className="h-3 w-3 mt-0.5 text-red-500 shrink-0" />
							)}
							{log.status === "running" && (
								<Loader2 className="h-3 w-3 mt-0.5 text-blue-500 animate-spin shrink-0" />
							)}
							{log.status === "pending" && (
								<Clock className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
							)}
							<div className="min-w-0">
								<span className="font-medium">{log.nodeName}</span>
								<span className="text-muted-foreground"> - {log.status}</span>
								{log.status === "error" && log.outputPreview && (
									<div className="text-red-500/80 truncate mt-0.5">
										{log.outputPreview.slice(0, 120)}
									</div>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

type AiChatPanelProps = {
	workflowId: string;
};

export function AiChatPanel({ workflowId }: AiChatPanelProps) {
	const {
		isGenerating,
		isLoadingMessages,
		messages,
		sendMessage,
		error,
		clearConversation,
		contextSnapshot,
		nodes,
	} = useWorkflowAiToolsChat(workflowId);
	const bottomRef = useRef<HTMLDivElement>(null);
	const [showContext, setShowContext] = useState(false);
	const isDev = process.env.NODE_ENV !== "production";

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages, isGenerating]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex-1 space-y-3 overflow-y-auto p-4">
				{isDev && (
					<div className="space-y-2">
						<button
							type="button"
							onClick={() => setShowContext((s) => !s)}
							className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
						>
							{showContext ? (
								<EyeOff className="h-3.5 w-3.5" />
							) : (
								<Eye className="h-3.5 w-3.5" />
							)}
							AI Context
						</button>
						{showContext && (
							<AiContextDebug snapshot={contextSnapshot} nodes={nodes} />
						)}
					</div>
				)}

				{isLoadingMessages ? (
					<div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
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
								{message.role === "user" ? "You" : "AI"}
							</div>
							<div className="space-y-2">
								{message.parts?.map((part, i) => {
									if (part.type === "text" && "text" in part) {
										return (
											<p key={i} className="whitespace-pre-wrap">
												{part.text as string}
											</p>
										);
									}

									if (
										part.type.startsWith("tool-") ||
										part.type === "dynamic-tool"
									) {
										const toolPart = part as {
											type: string;
											toolCallId: string;
											state: string;
											output: unknown;
										};

										if (toolPart.state !== "output-available") {
											return (
												<div
													key={toolPart.toolCallId}
													className="flex items-center gap-2 rounded border bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground"
												>
													<Loader2 className="h-3 w-3 animate-spin" />
													<span>Working...</span>
												</div>
											);
										}

										const result = toolPart.output as CanvasToolResult | null;

										// Render present_options as clickable chips
										if (result?.op === "presentOptions") {
											const { question, options } = result.payload as {
												question: string;
												options: Array<{
													label: string;
													value: string;
													description?: string;
												}>;
											};

											// Check if user already picked an option
											const msgIdx = messages.indexOf(message);
											const nextMsg =
												msgIdx >= 0 ? messages[msgIdx + 1] : undefined;
											const picked =
												nextMsg?.role === "user" &&
												nextMsg.parts?.some(
													(p) =>
														p.type === "text" &&
														"text" in p &&
														options.some(
															(o) => o.value === (p as { text: string }).text,
														),
												);

											return (
												<div key={toolPart.toolCallId} className="space-y-2">
													<p className="text-sm">{question}</p>
													<div
														className={`flex flex-wrap gap-2 ${picked ? "pointer-events-none opacity-50" : ""}`}
													>
														{options.map((opt) => (
															<Button
																key={opt.value}
																variant="outline"
																size="sm"
																className="h-auto py-1.5 px-3"
																onClick={() =>
																	sendMessage({
																		text: opt.value,
																	})
																}
															>
																<div className="text-left">
																	<div>{opt.label}</div>
																	{opt.description && (
																		<div className="text-muted-foreground text-xs font-normal">
																			{opt.description}
																		</div>
																	)}
																</div>
															</Button>
														))}
													</div>
												</div>
											);
										}

										if (result?.summary) {
											return (
												<div
													key={toolPart.toolCallId}
													className="flex items-center gap-2 rounded border bg-muted/50 px-2 py-1.5 text-xs"
												>
													<CheckCircle2 className="h-3 w-3 text-green-600 shrink-0" />
													<span>{result.summary}</span>
												</div>
											);
										}

										return null;
									}

									return null;
								})}
							</div>
						</div>
					))
				)}

				{isGenerating &&
					messages[messages.length - 1]?.role !== "assistant" && (
						<div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" />
							Thinking...
						</div>
					)}

				{error && (
					<div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
						{error}
					</div>
				)}

				<div ref={bottomRef} />
			</div>

			<div className="shrink-0 border-t p-3">
				<AiChatComposer
					workflowId={workflowId}
					nodes={nodes}
					isDisabled={isGenerating}
					onSubmit={async ({ text, mentionRefs }) => {
						await sendMessage({ text, mentionRefs });
					}}
					onClear={async () => {
						await clearConversation();
					}}
				/>
			</div>
		</div>
	);
}
