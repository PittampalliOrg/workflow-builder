"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { useWorkflowAiChat } from "@/hooks/use-workflow-ai-chat";

type CanvasAiChatInputProps = {
	workflowId: string;
};

export function CanvasAiChatInput({ workflowId }: CanvasAiChatInputProps) {
	const { isGenerating, submit } = useWorkflowAiChat(workflowId);
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
					await submit(message.text ?? "");
					setInputValue("");
				}}
			>
				<PromptInputBody>
					<PromptInputTextarea
						className="h-9 min-h-9 max-h-9 overflow-hidden py-2 text-sm leading-5"
						disabled={isGenerating}
						placeholder="Ask AI to build or modify this workflow..."
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
							{isGenerating ? "Generating workflow..." : "Enter to send"}
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
