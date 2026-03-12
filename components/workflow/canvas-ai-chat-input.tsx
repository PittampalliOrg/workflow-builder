"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { useWorkflowAiChat } from "@/hooks/use-workflow-ai-chat";
import { api } from "@/lib/api-client";
import {
	currentWorkflowIdAtom,
	isGeneratingAtom,
	isTransitioningFromHomepageAtom,
} from "@/lib/workflow-store";

type CanvasAiChatInputProps = {
	workflowId?: string;
};

type CanvasAiChatInputShellProps = {
	isGenerating: boolean;
	onSubmit: (message: string) => Promise<void>;
	placeholder: string;
	submitHint: string;
};

function CanvasAiChatInputShell({
	isGenerating,
	onSubmit,
	placeholder,
	submitHint,
}: CanvasAiChatInputShellProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [inputValue, setInputValue] = useState("");
	const [isFocused, setIsFocused] = useState(false);
	const isExpanded = useMemo(
		() => isFocused || inputValue.trim().length > 0 || isGenerating,
		[isFocused, inputValue, isGenerating],
	);
	const containerWidth = isExpanded
		? "min(42rem, calc(100% - 2rem))"
		: "min(20rem, calc(100% - 2rem))";

	const focusPromptInput = useCallback(() => {
		const input = containerRef.current?.querySelector<HTMLTextAreaElement>(
			"textarea[name='message']",
		);
		input?.focus();
	}, []);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				focusPromptInput();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [focusPromptInput]);

	return (
		<div
			className="pointer-events-auto absolute inset-x-0 bottom-4 z-10 mx-auto px-4"
			data-testid="workflow-canvas-ai-input"
			onBlurCapture={(event) => {
				const nextTarget = event.relatedTarget as Node | null;
				if (nextTarget && containerRef.current?.contains(nextTarget)) {
					return;
				}
				setIsFocused(false);
			}}
			onFocusCapture={() => {
				setIsFocused(true);
			}}
			ref={containerRef}
			style={{
				width: containerWidth,
				transition: "width 150ms ease-out",
			}}
		>
			<PromptInput
				className="w-full rounded-lg border bg-background/95 shadow-md backdrop-blur supports-[backdrop-filter]:bg-background/80"
				onClick={focusPromptInput}
				onSubmit={async (message) => {
					await onSubmit(message.text ?? "");
					setInputValue("");
				}}
			>
				<PromptInputBody>
					<PromptInputTextarea
						className="h-9 min-h-9 max-h-9 overflow-hidden py-2 text-sm leading-5"
						disabled={isGenerating}
						placeholder={placeholder}
						onChange={(event) => {
							setInputValue(event.target.value.replace(/[\r\n]+/g, " "));
						}}
						rows={1}
						value={inputValue}
					/>
				</PromptInputBody>
				{isExpanded && (
					<PromptInputFooter>
						<div className="text-muted-foreground text-xs">
							{isGenerating ? submitHint : "Enter to send"}
						</div>
						<PromptInputSubmit
							disabled={isGenerating || !inputValue.trim()}
							status={isGenerating ? "submitted" : "ready"}
						/>
					</PromptInputFooter>
				)}
			</PromptInput>
		</div>
	);
}

function ExistingWorkflowCanvasAiChatInput({
	workflowId,
}: {
	workflowId: string;
}) {
	const { isGenerating, submit } = useWorkflowAiChat(workflowId);
	return (
		<CanvasAiChatInputShell
			isGenerating={isGenerating}
			onSubmit={async (message) => {
				await submit(message);
			}}
			placeholder="Ask AI to edit this workflow..."
			submitHint="Editing workflow..."
		/>
	);
}

function NewWorkflowCanvasAiChatInput() {
	const router = useRouter();
	const isGenerating = useAtomValue(isGeneratingAtom);
	const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
	const setIsGenerating = useSetAtom(isGeneratingAtom);
	const setIsTransitioningFromHomepage = useSetAtom(
		isTransitioningFromHomepageAtom,
	);

	const handleSubmit = useCallback(
		async (message: string) => {
			const trimmed = message.trim();
			if (!trimmed || isGenerating || currentWorkflowId) {
				return;
			}

			setIsGenerating(true);
			try {
				const created = await api.workflow.createFromPrompt({
					prompt: trimmed,
				});
				sessionStorage.setItem("animate-sidebar", "true");
				setIsTransitioningFromHomepage(true);
				router.replace(`/workflows/${created.workflow.id}`);
			} catch (error) {
				console.error("Failed to create workflow from prompt:", error);
				toast.error("Failed to create workflow from prompt");
			} finally {
				setIsGenerating(false);
			}
		},
		[
			currentWorkflowId,
			isGenerating,
			router,
			setIsGenerating,
			setIsTransitioningFromHomepage,
		],
	);

	return (
		<CanvasAiChatInputShell
			isGenerating={isGenerating}
			onSubmit={handleSubmit}
			placeholder="Describe a workflow to create..."
			submitHint="Creating workflow from prompt..."
		/>
	);
}

export function CanvasAiChatInput({ workflowId }: CanvasAiChatInputProps) {
	if (workflowId) {
		return <ExistingWorkflowCanvasAiChatInput workflowId={workflowId} />;
	}

	return <NewWorkflowCanvasAiChatInput />;
}
