"use client";

import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { ToolWidget } from "./tool-widget";
import { ToolResultDisplay, CopyTextButton } from "./tool-result-display";
import { cn } from "@/lib/utils";
import {
	User,
	Bot,
	Loader2,
	ChevronDown,
	ChevronRight,
	Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

/** Threshold: text blocks shorter than this render inline without collapse chrome. */
const COLLAPSE_THRESHOLD = 200;

/** Lightweight markdown-to-HTML for chat messages (no external deps). */
function renderMarkdown(text: string): string {
	let html = text
		// Escape HTML
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		// Code blocks (```lang\n...\n```)
		.replace(
			/```(\w*)\n([\s\S]*?)```/g,
			(_, lang, code) =>
				`<pre><code class="language-${lang || "text"}">${code.trim()}</code></pre>`,
		)
		// Inline code
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		// Bold
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		// Italic
		.replace(/\*(.+?)\*/g, "<em>$1</em>")
		// Links
		.replace(
			/\[([^\]]+)\]\(([^)]+)\)/g,
			'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
		)
		// Horizontal rules
		.replace(/^---+$/gm, "<hr>")
		// Headings (### h3, ## h2, # h1)
		.replace(/^### (.+)$/gm, "<h3>$1</h3>")
		.replace(/^## (.+)$/gm, "<h2>$1</h2>")
		.replace(/^# (.+)$/gm, "<h1>$1</h1>")
		// Ordered lists
		.replace(/^\d+\. (.+)$/gm, '<li data-ol="1">$1</li>')
		// Unordered lists
		.replace(/^[-*] (.+)$/gm, "<li>$1</li>")
		// Paragraphs (double newline)
		.replace(/\n\n/g, "</p><p>")
		// Single newlines to <br>
		.replace(/\n/g, "<br>");

	// Wrap consecutive ordered <li data-ol> in <ol>, others in <ul>
	html = html.replace(
		/((?:<li data-ol="1">[\s\S]*?<\/li>(?:<br>)?)+)/g,
		(match) => `<ol>${match.replace(/ data-ol="1"/g, "").replace(/<br>/g, "")}</ol>`,
	);
	html = html.replace(
		/((?:<li>[\s\S]*?<\/li>(?:<br>)?)+)/g,
		(match) => `<ul>${match.replace(/<br>/g, "")}</ul>`,
	);

	return `<p>${html}</p>`
		.replace(/<p><\/p>/g, "")
		.replace(/<p>(<h[1-3]>)/g, "$1")
		.replace(/(<\/h[1-3]>)<\/p>/g, "$1")
		.replace(/<p>(<pre>)/g, "$1")
		.replace(/(<\/pre>)<\/p>/g, "$1")
		.replace(/<p>(<ul>)/g, "$1")
		.replace(/(<\/ul>)<\/p>/g, "$1")
		.replace(/<p>(<ol>)/g, "$1")
		.replace(/(<\/ol>)<\/p>/g, "$1")
		.replace(/<p>(<hr>)/g, "$1")
		.replace(/(<hr>)<\/p>/g, "$1");
}

const markdownStyles = cn(
	"max-w-none text-sm leading-relaxed break-words",
	// Headings
	"[&_h1]:text-lg [&_h1]:font-bold [&_h1]:mt-3 [&_h1]:mb-1.5",
	"[&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5",
	"[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1",
	// Bold & italic
	"[&_strong]:font-semibold [&_em]:italic",
	// Code
	"[&_code]:rounded [&_code]:bg-primary/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_code]:font-mono",
	"[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-primary/5 [&_pre]:p-3 [&_pre]:my-2",
	"[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[11px]",
	// Links
	"[&_a]:text-blue-600 dark:[&_a]:text-blue-400 [&_a]:underline [&_a]:underline-offset-2",
	// Lists
	"[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1.5 [&_li]:my-0.5",
	"[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1.5",
	// Paragraphs
	"[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
	// Horizontal rule
	"[&_hr]:border-border [&_hr]:my-3",
);

/**
 * Renders assistant text. Short messages render inline; long messages
 * get a collapsible toggle + copy button header.
 */
function AssistantTextBlock({
	html,
	rawText,
}: {
	html: string;
	rawText: string;
}) {
	const isShort = rawText.length < COLLAPSE_THRESHOLD;
	const [collapsed, setCollapsed] = useState(false);

	if (isShort) {
		// Short: render inline bubble, copy on hover
		return (
			<div className="group/msg rounded-2xl rounded-tl-sm bg-muted relative">
				<div className="absolute right-2 top-2 opacity-0 group-hover/msg:opacity-100 transition-opacity">
					<CopyTextButton text={rawText} />
				</div>
				<div
					className={cn(markdownStyles, "px-4 py-2.5")}
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			</div>
		);
	}

	// Long: collapsible with header
	return (
		<div className="rounded-2xl rounded-tl-sm bg-muted">
			<div className="flex w-full items-center justify-between px-3 py-2">
				<button
					type="button"
					onClick={() => setCollapsed((c) => !c)}
					className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
				>
					{collapsed ? (
						<ChevronRight className="h-3 w-3 shrink-0" />
					) : (
						<ChevronDown className="h-3 w-3 shrink-0" />
					)}
					<span>
						{collapsed ? "Show message" : "Hide message"}
					</span>
				</button>
				<CopyTextButton text={rawText} />
			</div>
			{!collapsed && (
				<div
					className={cn(markdownStyles, "px-4 pb-3")}
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			)}
		</div>
	);
}

type MessageListProps = {
	messages: UIMessage[];
	isLoading: boolean;
	onSendMessage?: (text: string) => void;
};

export function MessageList({
	messages,
	isLoading,
	onSendMessage,
}: MessageListProps) {
	const bottomRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages, isLoading]);

	if (messages.length === 0) return null;

	return (
		<div className="space-y-6 pb-4">
			{messages.map((message) => (
				<div
					key={message.id}
					className={cn(
						"flex gap-3 animate-in fade-in-0 slide-in-from-bottom-2 duration-300",
						message.role === "user"
							? "justify-end"
							: "justify-start",
					)}
				>
					{message.role === "assistant" && (
						<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
							<Bot className="h-4 w-4" />
						</div>
					)}

					<div
						className={cn(
							"min-w-0 space-y-3",
							message.role === "user"
								? "order-first max-w-[80%]"
								: "flex-1",
						)}
					>
						{message.role === "user" ? (
							<div className="rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
								{message.parts
									?.filter(
										(
											p,
										): p is {
											type: "text";
											text: string;
										} => p.type === "text",
									)
									.map((p, i) => (
										<span key={i}>{p.text}</span>
									))}
							</div>
						) : (
							<>
								{message.parts?.map((part, i) => {
									if (
										part.type === "text" &&
										part.text
									) {
										return (
											<AssistantTextBlock
												key={i}
												html={renderMarkdown(
													part.text,
												)}
												rawText={part.text}
											/>
										);
									}

									// Handle tool invocation parts
									if (
										part.type.startsWith(
											"tool-",
										) ||
										part.type === "dynamic-tool"
									) {
										const toolPart = part as {
											type: string;
											toolName?: string;
											toolCallId: string;
											state: string;
											input: unknown;
											output: unknown;
										};

										const rawToolName =
											toolPart.toolName ??
											(toolPart.type.startsWith(
												"tool-",
											)
												? toolPart.type.slice(
														5,
													)
												: "unknown");

										// Strip namespace prefix for external MCP tools (e.g. "Demo__weather_dashboard" → "weather_dashboard")
										const partToolName =
											rawToolName.includes("__")
												? rawToolName
														.split("__")
														.pop()!
												: rawToolName;

										// Show loading state while tool is executing
										if (
											toolPart.state !==
											"output-available"
										) {
											return (
												<div
													key={
														toolPart.toolCallId
													}
													className="rounded-lg border bg-muted/50 p-3 space-y-2"
												>
													<div className="flex items-center gap-2">
														<Wrench className="h-3.5 w-3.5 text-muted-foreground" />
														<Badge
															variant="outline"
															className="text-xs font-mono"
														>
															{partToolName.replace(
																/_/g,
																" ",
															)}
														</Badge>
														<Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
														<span className="text-xs text-muted-foreground">
															Running...
														</span>
													</div>
													<Skeleton className="h-4 w-3/4" />
													<Skeleton className="h-4 w-1/2" />
												</div>
											);
										}

										const result =
											toolPart.output as {
												text?: string;
												uiHtml?:
													| string
													| null;
												toolName?: string;
												serverUrl?: string;
											} | null;

										if (result?.uiHtml) {
											return (
												<ToolWidget
													key={
														toolPart.toolCallId
													}
													toolName={
														result.toolName ??
														partToolName
													}
													toolArgs={
														(toolPart.input as Record<
															string,
															unknown
														>) ?? {}
													}
													toolResult={{
														text:
															result.text ??
															"",
													}}
													uiHtml={
														result.uiHtml
													}
													serverUrl={
														result.serverUrl
													}
													onSendMessage={
														onSendMessage
													}
												/>
											);
										}

										// Tool result without UI - show structured display
										if (result?.text) {
											return (
												<ToolResultDisplay
													key={
														toolPart.toolCallId
													}
													toolName={
														partToolName
													}
													text={result.text}
													toolArgs={
														(toolPart.input as Record<
															string,
															unknown
														>) ?? {}
													}
												/>
											);
										}

										return null;
									}

									return null;
								})}
							</>
						)}
					</div>

					{message.role === "user" && (
						<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
							<User className="h-4 w-4" />
						</div>
					)}
				</div>
			))}

			{isLoading &&
				messages[messages.length - 1]?.role !== "assistant" && (
					<div className="flex gap-3 animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
						<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
							<Bot className="h-4 w-4" />
						</div>
						<div className="flex items-center gap-2 rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
							<div className="flex gap-1">
								<span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:-0.3s]" />
								<span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:-0.15s]" />
								<span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40" />
							</div>
							<span className="text-xs text-muted-foreground">
								Thinking...
							</span>
						</div>
					</div>
				)}

			<div ref={bottomRef} />
		</div>
	);
}
