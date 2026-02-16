import { useState, useCallback } from "react";

type LogEntry = {
	id: string;
	nodeId: string;
	nodeName: string;
	nodeType: string;
	actionType: string | null;
	status: string;
	input: unknown;
	output: unknown;
	error: string | null;
	startedAt: string;
	completedAt: string | null;
	duration: string | null;
};

type ExecutionData = {
	id: string;
	workflowId: string;
	status: string;
	phase: string | null;
	error: string | null;
	startedAt: string;
	completedAt: string | null;
	duration: string | null;
};

interface Props {
	results: { execution: ExecutionData; logs: LogEntry[] };
	onClose: () => void;
}

function isAgentNode(actionType: string | null): boolean {
	if (!actionType) return false;
	return actionType.startsWith("agent/") || actionType.startsWith("mastra/");
}

function formatDuration(ms: string | null): string {
	if (!ms) return "";
	const n = Number(ms);
	if (Number.isNaN(n)) return ms;
	if (n < 1000) return `${n}ms`;
	return `${(n / 1000).toFixed(1)}s`;
}

function statusIcon(status: string): string {
	switch (status) {
		case "success":
		case "completed":
			return "\u2713";
		case "error":
		case "failed":
			return "\u2717";
		case "running":
			return "\u25cb";
		default:
			return "\u2022";
	}
}

function statusClass(status: string): string {
	switch (status) {
		case "success":
		case "completed":
			return "rp-status-success";
		case "error":
		case "failed":
			return "rp-status-error";
		case "running":
			return "rp-status-running";
		default:
			return "rp-status-pending";
	}
}

/** Extract structured agent output for rich rendering */
function parseAgentOutput(output: unknown): {
	response: string | null;
	fileChanges: Array<{ path: string; op: string }>;
	patch: string | null;
	plan: unknown;
	toolCalls: unknown[];
	raw: unknown;
} {
	const result = {
		response: null as string | null,
		fileChanges: [] as Array<{ path: string; op: string }>,
		patch: null as string | null,
		plan: null as unknown,
		toolCalls: [] as unknown[],
		raw: output,
	};

	if (!output || typeof output !== "object") return result;

	const o = output as Record<string, unknown>;

	// Extract text response
	if (typeof o.response === "string") result.response = o.response;
	else if (typeof o.text === "string") result.response = o.text;
	else if (typeof o.result === "string") result.response = o.result;
	else if (typeof o.message === "string") result.response = o.message;
	// Check nested output
	else if (o.output && typeof o.output === "object") {
		const inner = o.output as Record<string, unknown>;
		if (typeof inner.response === "string") result.response = inner.response;
		else if (typeof inner.text === "string") result.response = inner.text;
		else if (typeof inner.result === "string") result.response = inner.result;
	}

	// Extract file changes
	if (Array.isArray(o.fileChanges)) {
		result.fileChanges = o.fileChanges as Array<{ path: string; op: string }>;
	} else if (Array.isArray(o.files)) {
		result.fileChanges = o.files as Array<{ path: string; op: string }>;
	}

	// Extract patch/diff
	if (typeof o.patch === "string") result.patch = o.patch;
	else if (typeof o.diff === "string") result.patch = o.diff;

	// Extract plan
	if (o.plan) result.plan = o.plan;

	// Extract tool calls
	if (Array.isArray(o.toolCalls)) result.toolCalls = o.toolCalls;
	else if (Array.isArray(o.tool_calls)) result.toolCalls = o.tool_calls;

	return result;
}

function DiffBlock({ patch }: { patch: string }) {
	const lines = patch.split("\n");
	return (
		<pre className="rp-diff-block">
			{lines.map((line, i) => {
				let cls = "diff-ctx";
				if (line.startsWith("+")) cls = "diff-add";
				else if (line.startsWith("-")) cls = "diff-del";
				else if (line.startsWith("@@")) cls = "diff-hdr";
				return (
					<div key={i} className={cls}>
						{line}
					</div>
				);
			})}
		</pre>
	);
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const handleCopy = useCallback(() => {
		navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}, [text]);
	return (
		<button className="rp-copy-btn" onClick={handleCopy} title="Copy">
			{copied ? "\u2713" : "\u2398"}
		</button>
	);
}

function CollapsibleSection({
	title,
	count,
	defaultOpen = false,
	children,
}: {
	title: string;
	count?: number;
	defaultOpen?: boolean;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="rp-section">
			<button className="rp-section-header" onClick={() => setOpen(!open)}>
				<span className="rp-section-arrow">{open ? "\u25be" : "\u25b8"}</span>
				<span className="rp-section-title">{title}</span>
				{count !== undefined && (
					<span className="rp-section-count">({count})</span>
				)}
			</button>
			{open && <div className="rp-section-body">{children}</div>}
		</div>
	);
}

function AgentNodeContent({ output }: { output: unknown }) {
	const parsed = parseAgentOutput(output);
	const hasRichContent =
		parsed.response ||
		parsed.fileChanges.length > 0 ||
		parsed.patch ||
		parsed.plan ||
		parsed.toolCalls.length > 0;

	if (!hasRichContent) {
		return <JsonBlock data={output} />;
	}

	return (
		<div className="rp-agent-content">
			{parsed.response && (
				<div className="rp-agent-section">
					<div className="rp-agent-section-header">
						<span className="rp-agent-section-label">RESPONSE</span>
						<CopyButton text={parsed.response} />
					</div>
					<div className="rp-agent-response">{parsed.response}</div>
				</div>
			)}

			{parsed.fileChanges.length > 0 && (
				<div className="rp-agent-section">
					<div className="rp-agent-section-header">
						<span className="rp-agent-section-label">
							FILE CHANGES ({parsed.fileChanges.length})
						</span>
					</div>
					<div className="rp-file-changes">
						{parsed.fileChanges.map((f, i) => {
							const op = (f.op || "modified").toLowerCase();
							let cls = "file-op-modified";
							let symbol = "~";
							if (
								op === "created" ||
								op === "create" ||
								op === "added" ||
								op === "add"
							) {
								cls = "file-op-created";
								symbol = "+";
							} else if (
								op === "deleted" ||
								op === "delete" ||
								op === "removed" ||
								op === "remove"
							) {
								cls = "file-op-deleted";
								symbol = "-";
							}
							return (
								<div key={i} className="rp-file-entry">
									<span className={`rp-file-badge ${cls}`}>
										{symbol} {op}
									</span>
									<span className="rp-file-path">{f.path}</span>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{parsed.patch && (
				<div className="rp-agent-section">
					<div className="rp-agent-section-header">
						<span className="rp-agent-section-label">PATCH</span>
						<CopyButton text={parsed.patch} />
					</div>
					<DiffBlock patch={parsed.patch} />
				</div>
			)}

			{parsed.plan && (
				<CollapsibleSection title="PLAN">
					<JsonBlock data={parsed.plan} />
				</CollapsibleSection>
			)}

			{parsed.toolCalls.length > 0 && (
				<CollapsibleSection title="TOOL CALLS" count={parsed.toolCalls.length}>
					<JsonBlock data={parsed.toolCalls} />
				</CollapsibleSection>
			)}
		</div>
	);
}

function JsonBlock({ data }: { data: unknown }) {
	if (data === null || data === undefined) {
		return <div className="rp-empty-output">No output</div>;
	}
	const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
	return <pre className="rp-json-block">{text}</pre>;
}

function NodeResultEntry({ log }: { log: LogEntry }) {
	const agent = isAgentNode(log.actionType);
	const [open, setOpen] = useState(agent);

	return (
		<div className={`rp-node-entry ${statusClass(log.status)}`}>
			<button className="rp-node-header" onClick={() => setOpen(!open)}>
				<span className="rp-node-arrow">{open ? "\u25be" : "\u25b8"}</span>
				<span className="rp-node-name">{log.nodeName}</span>
				<span className="rp-node-meta">
					<span className={`rp-node-status ${statusClass(log.status)}`}>
						{statusIcon(log.status)}
					</span>
					<span className="rp-node-duration">
						{formatDuration(log.duration)}
					</span>
				</span>
			</button>
			{open && (
				<div className="rp-node-body">
					{log.actionType && (
						<div className="rp-node-action-type">{log.actionType}</div>
					)}
					{log.error && <div className="rp-node-error">{log.error}</div>}
					{agent ? (
						<AgentNodeContent output={log.output} />
					) : (
						<CollapsibleSection title="OUTPUT" defaultOpen={log.output != null}>
							<JsonBlock data={log.output} />
						</CollapsibleSection>
					)}
				</div>
			)}
		</div>
	);
}

export function ResultsPanel({ results, onClose }: Props) {
	const { execution, logs } = results;
	const totalDuration = formatDuration(execution.duration);

	return (
		<div className="results-panel">
			<div className="rp-header">
				<button className="rp-close-btn" onClick={onClose} title="Close">
					\u2715
				</button>
				<span className="rp-header-title">Execution Results</span>
				<span className="rp-header-meta">
					{logs.length} step{logs.length !== 1 ? "s" : ""}
					{totalDuration && ` \u00b7 ${totalDuration}`}
				</span>
				<span className={`rp-header-status ${statusClass(execution.status)}`}>
					{execution.status}
				</span>
			</div>
			<div className="rp-body">
				{execution.error && (
					<div className="rp-execution-error">
						<strong>Error:</strong> {execution.error}
					</div>
				)}
				{logs.length === 0 ? (
					<div className="rp-empty">No execution logs available</div>
				) : (
					logs.map((log) => <NodeResultEntry key={log.id} log={log} />)
				)}
			</div>
		</div>
	);
}
