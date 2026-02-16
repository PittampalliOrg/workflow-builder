"use client";

import {
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	FileEdit,
	FilePlus2,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Button } from "@/components/ui/button";
import type { ResultComponentProps } from "@/plugins/registry";

type FileChange = {
	path: string;
	operation: string;
	content?: string;
};

type PlanStep = {
	step: number;
	action: string;
	tool?: string;
};

type ToolCall = {
	name: string;
	args: unknown;
	result: unknown;
};

type AgentOutput = {
	text?: string;
	fileChanges?: FileChange[];
	patch?: string;
	plan?: { goal?: string; steps?: PlanStep[] };
	toolCalls?: ToolCall[];
	usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};

function isAgentOutput(value: unknown): value is AgentOutput {
	return typeof value === "object" && value !== null && "text" in value;
}

function Section({
	title,
	badge,
	defaultExpanded = false,
	actions,
	children,
}: {
	title: string;
	badge?: React.ReactNode;
	defaultExpanded?: boolean;
	actions?: React.ReactNode;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(defaultExpanded);

	return (
		<div>
			<div className="flex items-center justify-between">
				<button
					className="flex items-center gap-1.5"
					onClick={() => setOpen(!open)}
					type="button"
				>
					{open ? (
						<ChevronDown className="h-3 w-3 text-muted-foreground" />
					) : (
						<ChevronRight className="h-3 w-3 text-muted-foreground" />
					)}
					<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						{title}
					</span>
					{badge}
				</button>
				{open && actions}
			</div>
			{open && <div className="mt-2">{children}</div>}
		</div>
	);
}

function CopyBtn({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);

	return (
		<Button
			className="h-7 px-2"
			onClick={async (e) => {
				e.stopPropagation();
				await navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
			size="sm"
			type="button"
			variant="ghost"
		>
			{copied ? (
				<Check className="h-3 w-3 text-green-600" />
			) : (
				<Copy className="h-3 w-3" />
			)}
		</Button>
	);
}

const OP_CONFIG: Record<string, { icon: typeof FilePlus2; color: string; label: string }> = {
	created: { icon: FilePlus2, color: "bg-green-600/15 text-green-500 border-green-600/30", label: "created" },
	modified: { icon: FileEdit, color: "bg-yellow-600/15 text-yellow-500 border-yellow-600/30", label: "modified" },
	deleted: { icon: Trash2, color: "bg-red-600/15 text-red-500 border-red-600/30", label: "deleted" },
};

function FileChangeRow({ change }: { change: FileChange }) {
	const [showContent, setShowContent] = useState(false);
	const config = OP_CONFIG[change.operation] ?? OP_CONFIG.modified;
	const Icon = config.icon;
	const hasContent = change.operation === "created" && change.content;

	return (
		<div>
			<div className="flex items-center gap-2 py-1">
				<span
					className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${config.color}`}
				>
					<Icon className="h-3 w-3" />
					{config.label}
				</span>
				<button
					className="min-w-0 flex-1 truncate text-left font-mono text-xs text-foreground hover:underline disabled:no-underline disabled:cursor-default"
					disabled={!hasContent}
					onClick={() => hasContent && setShowContent(!showContent)}
					type="button"
				>
					{change.path}
				</button>
			</div>
			{showContent && hasContent && change.content && (
				<pre className="ml-6 max-h-40 overflow-auto rounded border bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">
					{change.content.length > 2000
						? `${change.content.slice(0, 2000)}\n... (truncated)`
						: change.content}
				</pre>
			)}
		</div>
	);
}

export function MastraAgentResult({ output }: ResultComponentProps) {
	if (!isAgentOutput(output)) {
		return null;
	}

	const { text, fileChanges, patch, plan, toolCalls, usage } = output;
	const hasFileChanges = fileChanges && fileChanges.length > 0;
	const hasPatch = patch && patch.length > 0;
	const hasPlan = plan && (plan.goal || (plan.steps && plan.steps.length > 0));
	const hasToolCalls = toolCalls && toolCalls.length > 0;

	return (
		<div className="space-y-4">
			{/* Response text */}
			{text && (
				<Section defaultExpanded title="Response" actions={<CopyBtn text={text} />}>
					<div className="whitespace-pre-wrap rounded border bg-muted/30 p-3 text-sm leading-relaxed">
						{text}
					</div>
				</Section>
			)}

			{/* File changes */}
			{hasFileChanges && (
				<Section
					badge={
						<span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
							{fileChanges.length}
						</span>
					}
					defaultExpanded
					title="File Changes"
				>
					<div className="space-y-0.5 rounded border bg-muted/30 p-2">
						{fileChanges.map((fc) => (
							<FileChangeRow change={fc} key={fc.path} />
						))}
					</div>
				</Section>
			)}

			{/* Patch / diff */}
			{hasPatch && (
				<Section
					actions={<CopyBtn text={patch} />}
					defaultExpanded
					title="Patch"
				>
					<div className="max-h-80 overflow-auto rounded border bg-[#282c34]">
						<SyntaxHighlighter
							className="!m-0 !bg-transparent !p-3"
							codeTagProps={{ className: "font-mono", style: { fontSize: "0.7rem" } }}
							customStyle={{
								margin: 0,
								padding: "0.75rem",
								fontSize: "0.7rem",
								background: "transparent",
							}}
							language="diff"
							style={oneDark}
						>
							{patch}
						</SyntaxHighlighter>
					</div>
				</Section>
			)}

			{/* Plan */}
			{hasPlan && (
				<Section title="Plan">
					<div className="space-y-2 rounded border bg-muted/30 p-3">
						{plan.goal && (
							<div className="font-medium text-sm">{plan.goal}</div>
						)}
						{plan.steps && plan.steps.length > 0 && (
							<ol className="list-inside list-decimal space-y-1 text-xs text-muted-foreground">
								{plan.steps.map((s) => (
									<li key={s.step}>
										{s.action}
										{s.tool && (
											<span className="ml-1 font-mono text-[10px] text-muted-foreground/70">
												({s.tool})
											</span>
										)}
									</li>
								))}
							</ol>
						)}
					</div>
				</Section>
			)}

			{/* Tool calls */}
			{hasToolCalls && (
				<Section
					badge={
						<span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
							{toolCalls.length}
						</span>
					}
					title="Tool Calls"
				>
					<div className="space-y-1">
						{toolCalls.map((tc, i) => (
							<ToolCallEntry key={`${tc.name}-${i}`} tc={tc} />
						))}
					</div>
				</Section>
			)}

			{/* Usage */}
			{usage && (
				<div className="flex gap-3 text-[10px] text-muted-foreground">
					<span>Prompt: {usage.promptTokens?.toLocaleString()}</span>
					<span>Completion: {usage.completionTokens?.toLocaleString()}</span>
					<span>Total: {usage.totalTokens?.toLocaleString()}</span>
				</div>
			)}
		</div>
	);
}

function ToolCallEntry({ tc }: { tc: ToolCall }) {
	const [open, setOpen] = useState(false);

	return (
		<div className="rounded border bg-muted/20">
			<button
				className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40"
				onClick={() => setOpen(!open)}
				type="button"
			>
				{open ? (
					<ChevronDown className="h-3 w-3 text-muted-foreground" />
				) : (
					<ChevronRight className="h-3 w-3 text-muted-foreground" />
				)}
				<span className="font-mono font-medium">{tc.name}</span>
			</button>
			{open && (
				<div className="space-y-2 border-t px-2 py-2">
					{tc.args !== undefined && (
						<div>
							<div className="mb-1 text-[10px] text-muted-foreground uppercase">Args</div>
							<pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px]">
								{JSON.stringify(tc.args, null, 2)}
							</pre>
						</div>
					)}
					{tc.result !== undefined && (
						<div>
							<div className="mb-1 text-[10px] text-muted-foreground uppercase">Result</div>
							<pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px]">
								{typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result, null, 2)}
							</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
