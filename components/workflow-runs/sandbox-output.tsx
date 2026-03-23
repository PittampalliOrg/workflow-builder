"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentStreamEvent } from "@/lib/types/agent-stream-events";
import { cn } from "@/lib/utils";

type SandboxOutputProps = {
	outputs: AgentStreamEvent[];
	activeSandboxLines?: string[];
	activeSandboxCommand?: string | null;
	className?: string;
};

export function SandboxOutput({
	outputs,
	activeSandboxLines = [],
	activeSandboxCommand = null,
	className,
}: SandboxOutputProps) {
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
	const liveOutputRef = useRef<HTMLPreElement>(null);

	// Auto-scroll live output to bottom
	useEffect(() => {
		if (liveOutputRef.current) {
			liveOutputRef.current.scrollTop = liveOutputRef.current.scrollHeight;
		}
	}, [activeSandboxLines]);

	if (outputs.length === 0 && !activeSandboxCommand) {
		return null;
	}

	return (
		<div
			className={cn("rounded-md border bg-zinc-950 text-zinc-100", className)}
		>
			<div className="border-b border-zinc-800 px-3 py-1.5">
				<span className="text-xs font-medium text-zinc-400">
					Sandbox Terminal ({outputs.length} command
					{outputs.length !== 1 ? "s" : ""})
				</span>
			</div>
			<div className="max-h-[300px] overflow-auto">
				{outputs.map((event, index) => {
					const isExpanded = expandedIndex === index;
					const outputText = event.output || "";
					const isLong = outputText.length > 200;
					const exitOk = (event.exitCode ?? 0) === 0;

					return (
						<div
							key={event.id || index}
							className="border-b border-zinc-800/50 last:border-0"
						>
							<button
								type="button"
								className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-900/50"
								onClick={() => setExpandedIndex(isExpanded ? null : index)}
							>
								<span
									className={cn(
										"text-xs",
										exitOk ? "text-green-400" : "text-red-400",
									)}
								>
									{exitOk ? "$" : "!"}
								</span>
								<span className="flex-1 truncate font-mono text-xs text-zinc-300">
									{event.command || "command"}
								</span>
								{event.exitCode != null && event.exitCode !== 0 && (
									<span className="text-xs text-red-400">
										exit {event.exitCode}
									</span>
								)}
								<span className="text-xs text-zinc-500">
									{isExpanded ? "\u25B2" : "\u25BC"}
								</span>
							</button>
							{(isExpanded || !isLong) && outputText && (
								<pre className="overflow-x-auto bg-zinc-900/30 px-3 py-2 font-mono text-xs text-zinc-400 leading-relaxed">
									{outputText}
								</pre>
							)}
						</div>
					);
				})}

				{activeSandboxCommand && (
					<div className="border-b border-zinc-800/50 last:border-0">
						<div className="flex items-center gap-2 px-3 py-1.5">
							<span className="text-xs text-green-400 animate-pulse">$</span>
							<span className="flex-1 truncate font-mono text-xs text-zinc-300">
								{activeSandboxCommand}
							</span>
							<span className="text-xs text-zinc-500 animate-pulse">
								running
							</span>
						</div>
						{activeSandboxLines.length > 0 && (
							<pre
								ref={liveOutputRef}
								className="max-h-[200px] overflow-auto bg-zinc-900/30 px-3 py-2 font-mono text-xs text-zinc-400 leading-relaxed"
							>
								{activeSandboxLines.join("\n")}
							</pre>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
