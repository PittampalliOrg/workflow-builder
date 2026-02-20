"use client";

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
	CodeBlock,
	CodeBlockHeader,
	CodeBlockContent,
	CodeBlockCopyButton,
	CodeBlockContainer,
	CodeBlockTitle,
	CodeBlockActions,
} from "@/components/ai-elements/code-block";
import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Wrench,
	ChevronDown,
	ChevronRight,
	Copy,
	Check,
	AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";

function CopyTextButton({ text, className }: { text: string; className?: string }) {
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef<number>(0);

	const handleCopy = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			try {
				await navigator.clipboard.writeText(text);
				setCopied(true);
				timeoutRef.current = window.setTimeout(
					() => setCopied(false),
					2000,
				);
			} catch {
				// clipboard not available
			}
		},
		[text],
	);

	useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

	return (
		<Button
			variant="ghost"
			size="icon"
			className={cn("h-6 w-6 shrink-0", className)}
			onClick={handleCopy}
		>
			{copied ? (
				<Check className="h-3 w-3 text-green-600" />
			) : (
				<Copy className="h-3 w-3" />
			)}
		</Button>
	);
}

export { CopyTextButton };

type ContentType = "json" | "code" | "text";

function detectContentType(text: string): ContentType {
	const trimmed = text.trim();
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		try {
			JSON.parse(trimmed);
			return "json";
		} catch {
			// not valid JSON
		}
	}
	if (
		trimmed.includes("```") ||
		trimmed.startsWith("def ") ||
		trimmed.startsWith("function ") ||
		trimmed.startsWith("class ")
	) {
		return "code";
	}
	return "text";
}

function isErrorResult(text: string, contentType: ContentType): boolean {
	if (contentType === "json") {
		try {
			const parsed = JSON.parse(text.trim());
			if (parsed && typeof parsed === "object") {
				const keys = Object.keys(parsed);
				return keys.some(
					(k) => k.toLowerCase() === "error" || k.toLowerCase() === "errormessage",
				);
			}
		} catch {
			// ignore
		}
	}
	return /\berror\b/i.test(text.slice(0, 200));
}

/** Linkify URLs inside a string for display in pre blocks */
function linkifyText(text: string): React.ReactNode[] {
	const urlRegex = /(https?:\/\/[^\s"',}>)\]]+)/g;
	const parts: React.ReactNode[] = [];
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = urlRegex.exec(text)) !== null) {
		if (match.index > lastIndex) {
			parts.push(text.slice(lastIndex, match.index));
		}
		const url = match[1];
		parts.push(
			<a
				key={match.index}
				href={url}
				target="_blank"
				rel="noopener noreferrer"
				className="text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-300"
			>
				{url}
			</a>,
		);
		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}

	return parts;
}

const COLLAPSE_CHAR_THRESHOLD = 500;
const COLLAPSE_LINE_THRESHOLD = 15;

type ToolResultDisplayProps = {
	toolName: string;
	text: string;
	toolArgs: Record<string, unknown>;
};

export function ToolResultDisplay({
	toolName,
	text,
	toolArgs,
}: ToolResultDisplayProps) {
	const contentType = useMemo(() => detectContentType(text), [text]);
	const hasError = useMemo(
		() => isErrorResult(text, contentType),
		[text, contentType],
	);
	const formattedText = useMemo(() => {
		if (contentType === "json") {
			try {
				return JSON.stringify(JSON.parse(text.trim()), null, 2);
			} catch {
				return text;
			}
		}
		return text;
	}, [text, contentType]);

	const isLong =
		formattedText.length > COLLAPSE_CHAR_THRESHOLD ||
		formattedText.split("\n").length > COLLAPSE_LINE_THRESHOLD;

	const [contentOpen, setContentOpen] = useState(!isLong);
	const [inputOpen, setInputOpen] = useState(false);

	const label = toolName.replace(/_/g, " ");
	const hasArgs = Object.keys(toolArgs).length > 0;

	return (
		<div
			className={cn(
				"rounded-lg border overflow-hidden",
				hasError
					? "border-destructive/50 bg-destructive/5"
					: "border-border bg-muted/30",
			)}
		>
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
				<div className="flex items-center gap-2 min-w-0">
					{hasError ? (
						<AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
					) : (
						<Wrench className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
					)}
					<Badge
						variant="outline"
						className="text-xs font-mono truncate"
					>
						{label}
					</Badge>
				</div>
				<CopyTextButton text={text} />
			</div>

			{/* Result content */}
			<div className="text-sm">
				{isLong ? (
					<Collapsible open={contentOpen} onOpenChange={setContentOpen}>
						<div className="max-h-[300px] overflow-auto">
							{contentOpen ? (
								<CollapsibleContent forceMount>
									<ResultContent
										text={formattedText}
										contentType={contentType}
									/>
								</CollapsibleContent>
							) : (
								<ResultContent
									text={formattedText.slice(0, 300) + "..."}
									contentType={contentType}
								/>
							)}
						</div>
						<CollapsibleTrigger asChild>
							<button
								type="button"
								className="flex w-full items-center justify-center gap-1 border-t border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
							>
								{contentOpen ? (
									<>
										<ChevronDown className="h-3 w-3" />
										Show less
									</>
								) : (
									<>
										<ChevronRight className="h-3 w-3" />
										Show more
									</>
								)}
							</button>
						</CollapsibleTrigger>
					</Collapsible>
				) : (
					<ResultContent text={formattedText} contentType={contentType} />
				)}
			</div>

			{/* Tool input inspector */}
			{hasArgs && (
				<Collapsible open={inputOpen} onOpenChange={setInputOpen}>
					<CollapsibleTrigger asChild>
						<button
							type="button"
							className="flex w-full items-center gap-1 border-t border-border/50 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
						>
							{inputOpen ? (
								<ChevronDown className="h-3 w-3" />
							) : (
								<ChevronRight className="h-3 w-3" />
							)}
							Show input
						</button>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="border-t border-border/50">
							<CodeBlock
								code={JSON.stringify(toolArgs, null, 2)}
								language="json"
								className="border-0 rounded-none"
							>
								<CodeBlockContent
									code={JSON.stringify(toolArgs, null, 2)}
									language="json"
								/>
							</CodeBlock>
						</div>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

function ResultContent({
	text,
	contentType,
}: {
	text: string;
	contentType: ContentType;
}) {
	if (contentType === "json") {
		return (
			<CodeBlock code={text} language="json" className="border-0 rounded-none">
				<CodeBlockContent code={text} language="json" />
			</CodeBlock>
		);
	}

	if (contentType === "code") {
		return (
			<CodeBlock code={text} language="text" className="border-0 rounded-none">
				<CodeBlockContent code={text} language="text" />
			</CodeBlock>
		);
	}

	// Plain text with linkified URLs
	return (
		<pre className="whitespace-pre-wrap break-words p-3 text-sm font-mono leading-relaxed">
			{linkifyText(text)}
		</pre>
	);
}
