"use client";

import { useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ArrowUp } from "lucide-react";

type ChatInputProps = {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	isDisabled?: boolean;
	placeholder?: string;
};

export function ChatInput({
	value,
	onChange,
	onSubmit,
	isDisabled,
	placeholder = "Type a message...",
}: ChatInputProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const adjustHeight = useCallback(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
	}, []);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!isDisabled && value.trim()) {
				onSubmit();
				// Reset height after submit
				setTimeout(() => {
					if (textareaRef.current) {
						textareaRef.current.style.height = "auto";
					}
				}, 0);
			}
		}
	};

	return (
		<div className="flex items-end gap-2 rounded-xl border bg-background p-2 shadow-sm">
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
				className="h-8 w-8 shrink-0 rounded-lg"
				onClick={onSubmit}
				disabled={isDisabled || !value.trim()}
			>
				<ArrowUp className="h-4 w-4" />
			</Button>
		</div>
	);
}
