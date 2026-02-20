"use client";

import { useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

type ChatInputProps = {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	isDisabled?: boolean;
	placeholder?: string;
	onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	prefix?: React.ReactNode;
	canSubmitEmpty?: boolean;
};

export function ChatInput({
	value,
	onChange,
	onSubmit,
	isDisabled,
	placeholder = "Type a message...",
	onKeyDown: externalKeyDown,
	prefix,
	canSubmitEmpty,
}: ChatInputProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const adjustHeight = useCallback(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
	}, []);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		externalKeyDown?.(e);
		if (e.defaultPrevented) return;

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!isDisabled && (value.trim() || canSubmitEmpty)) {
				onSubmit();
				setTimeout(() => {
					if (textareaRef.current) {
						textareaRef.current.style.height = "auto";
					}
				}, 0);
			}
		}
	};

	const hasContent = value.trim().length > 0 || canSubmitEmpty;

	return (
		<div className="flex flex-col rounded-xl border bg-background p-2 shadow-sm transition-all focus-within:ring-2 focus-within:ring-ring/20 focus-within:border-foreground/20">
			{prefix}
			<div className="flex items-end gap-2">
				<textarea
					ref={textareaRef}
					value={value}
					onChange={(e) => {
						onChange(e.target.value);
						adjustHeight();
					}}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					disabled={isDisabled}
					rows={1}
					className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
				/>
				<Button
					size="icon"
					className={cn(
						"h-8 w-8 shrink-0 rounded-lg transition-colors",
						hasContent
							? "bg-primary text-primary-foreground hover:bg-primary/90"
							: "bg-muted text-muted-foreground",
					)}
					onClick={onSubmit}
					disabled={isDisabled || (!value.trim() && !canSubmitEmpty)}
				>
					<ArrowUp className="h-4 w-4" />
				</Button>
			</div>
			{!value && (
				<div className="flex items-center gap-2 px-2 pb-0.5 pt-1 text-[10px] text-muted-foreground/50">
					<kbd className="rounded border border-border/30 px-1 py-0.5 font-mono">
						/
					</kbd>
					<span>scope tools</span>
					<span className="text-muted-foreground/30">·</span>
					<kbd className="rounded border border-border/30 px-1 py-0.5 font-mono">
						Enter
					</kbd>
					<span>send</span>
					<span className="text-muted-foreground/30">·</span>
					<kbd className="rounded border border-border/30 px-1 py-0.5 font-mono">
						Shift+Enter
					</kbd>
					<span>newline</span>
				</div>
			)}
		</div>
	);
}
