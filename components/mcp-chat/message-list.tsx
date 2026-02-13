"use client";

import { useEffect, useRef } from "react";
import type { UIMessage } from "ai";
import { ToolWidget } from "./tool-widget";
import { cn } from "@/lib/utils";
import { User, Bot, Loader2 } from "lucide-react";

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
		// Headings (### h3, ## h2, # h1)
		.replace(/^### (.+)$/gm, "<h3>$1</h3>")
		.replace(/^## (.+)$/gm, "<h2>$1</h2>")
		.replace(/^# (.+)$/gm, "<h1>$1</h1>")
		// Unordered lists
		.replace(/^[-*] (.+)$/gm, "<li>$1</li>")
		// Paragraphs (double newline)
		.replace(/\n\n/g, "</p><p>")
		// Single newlines to <br>
		.replace(/\n/g, "<br>");

	// Wrap consecutive <li> in <ul>
	html = html.replace(
		/(<li>[\s\S]*?<\/li>)(?=\s*(?:<li>|$))/g,
		(match) => match,
	);
	html = html.replace(/((?:<li>[\s\S]*?<\/li>\s*)+)/g, "<ul>$1</ul>");

	return `<p>${html}</p>`
		.replace(/<p><\/p>/g, "")
		.replace(/<p>(<h[1-3]>)/g, "$1")
		.replace(/(<\/h[1-3]>)<\/p>/g, "$1")
		.replace(/<p>(<pre>)/g, "$1")
		.replace(/(<\/pre>)<\/p>/g, "$1")
		.replace(/<p>(<ul>)/g, "$1")
		.replace(/(<\/ul>)<\/p>/g, "$1");
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
						"flex gap-3",
						message.role === "user" ? "justify-end" : "justify-start",
					)}
				>
					{message.role === "assistant" && (
						<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
							<Bot className="h-4 w-4" />
						</div>
					)}

					<div
						className={cn(
							"max-w-[80%] space-y-3",
							message.role === "user" ? "order-first" : "",
						)}
					>
						{message.role === "user" ? (
							<div className="rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
								{message.parts
									?.filter(
										(p): p is { type: "text"; text: string } =>
											p.type === "text",
									)
									.map((p, i) => (
										<span key={i}>{p.text}</span>
									))}
							</div>
						) : (
							<>
								{message.parts?.map((part, i) => {
									if (part.type === "text" && part.text) {
										return (
											<div
												key={i}
												className="prose prose-sm dark:prose-invert max-w-none rounded-2xl rounded-tl-sm bg-muted px-4 py-2.5"
												dangerouslySetInnerHTML={{
													__html: renderMarkdown(part.text),
												}}
											/>
										);
									}

									// Handle tool invocation parts
									if (
										part.type.startsWith("tool-") ||
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
											(toolPart.type.startsWith("tool-")
												? toolPart.type.slice(5)
												: "unknown");

										// Strip namespace prefix for external MCP tools (e.g. "Demo__weather_dashboard" → "weather_dashboard")
										const partToolName = rawToolName.includes("__")
											? rawToolName.split("__").pop()!
											: rawToolName;

										// Show loading state while tool is executing
										if (toolPart.state !== "output-available") {
											return (
												<div
													key={toolPart.toolCallId}
													className="flex items-center gap-2 rounded-lg border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
												>
													<Loader2 className="h-4 w-4 animate-spin" />
													<span>
														Running {partToolName.replace(/_/g, " ")}...
													</span>
												</div>
											);
										}

										const result = toolPart.output as {
											text?: string;
											uiHtml?: string | null;
											toolName?: string;
										} | null;

										if (result?.uiHtml) {
											return (
												<ToolWidget
													key={toolPart.toolCallId}
													toolName={result.toolName ?? partToolName}
													toolArgs={
														(toolPart.input as Record<string, unknown>) ?? {}
													}
													toolResult={{ text: result.text ?? "" }}
													uiHtml={result.uiHtml}
													onSendMessage={onSendMessage}
												/>
											);
										}

										// Tool result without UI - show as text
										if (result?.text) {
											return (
												<div
													key={toolPart.toolCallId}
													className="rounded-lg border bg-muted/50 px-4 py-3 text-sm"
												>
													{result.text}
												</div>
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

			{isLoading && messages[messages.length - 1]?.role !== "assistant" && (
				<div className="flex gap-3">
					<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
						<Bot className="h-4 w-4" />
					</div>
					<div className="flex items-center gap-1 rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
						<div className="flex gap-1">
							<span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:-0.3s]" />
							<span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:-0.15s]" />
							<span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40" />
						</div>
					</div>
				</div>
			)}

			<div ref={bottomRef} />
		</div>
	);
}
