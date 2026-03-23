"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

type AgentLlmStreamProps = {
	/** Accumulated LLM token buffer */
	tokenBuffer: string;
	/** Whether the LLM is currently generating */
	isStreaming: boolean;
	/** Current turn/iteration number */
	turn?: number;
	className?: string;
};

export function AgentLlmStream({
	tokenBuffer,
	isStreaming,
	turn,
	className,
}: AgentLlmStreamProps) {
	const containerRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to bottom when new tokens arrive
	useEffect(() => {
		if (containerRef.current) {
			containerRef.current.scrollTop = containerRef.current.scrollHeight;
		}
	}, [tokenBuffer]);

	if (!tokenBuffer && !isStreaming) {
		return null;
	}

	return (
		<div className={cn("rounded-md border bg-muted/30", className)}>
			<div className="flex items-center gap-2 border-b px-3 py-1.5">
				<span className="text-muted-foreground text-xs font-medium">
					{turn ? `Turn ${turn} — ` : ""}LLM Output
				</span>
				{isStreaming && (
					<span className="flex items-center gap-1 text-xs text-blue-500">
						<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
						Generating...
					</span>
				)}
			</div>
			<div
				ref={containerRef}
				className="max-h-[200px] overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed"
			>
				{tokenBuffer || (
					<span className="text-muted-foreground italic">Thinking...</span>
				)}
				{isStreaming && (
					<span className="inline-block h-3 w-0.5 animate-pulse bg-foreground/60" />
				)}
			</div>
		</div>
	);
}
