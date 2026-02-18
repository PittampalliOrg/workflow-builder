"use client";

import { Loader2 } from "lucide-react";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { useWorkflowAiChat } from "@/hooks/use-workflow-ai-chat";

type AiChatPanelProps = {
	workflowId: string;
};

function formatTimestamp(iso: string): string {
	return new Date(iso).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

export function AiChatPanel({ workflowId }: AiChatPanelProps) {
	const { isGenerating, isLoadingMessages, messages, submit } =
		useWorkflowAiChat(workflowId);

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
						await submit(message.text ?? "");
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
