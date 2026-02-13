import type { WorkflowContext as WorkflowContextData } from "~/lib/types";

export function WorkflowContext({
	context,
}: {
	context: WorkflowContextData | null;
}) {
	if (!context) return null;

	const hasContext =
		context.workflowId || context.nodeId || context.receivedEvents > 0;

	if (!hasContext) {
		return (
			<div style={{ padding: "32px 16px", color: "#999", textAlign: "center", fontSize: 13, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
				<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
					<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
					<polyline points="13 2 13 9 20 9" />
				</svg>
				<span>Not part of a workflow</span>
				<span style={{ fontSize: 11 }}>
					Dapr workflow context will appear here when the agent runs inside a workflow
				</span>
			</div>
		);
	}

	return (
		<div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
			<Field label="Workflow ID" value={context.workflowId ?? "\u2014"} />
			<Field label="Node ID" value={context.nodeId ?? "\u2014"} />
			<Field
				label="Step Index"
				value={context.stepIndex !== null ? String(context.stepIndex) : "\u2014"}
			/>
			<Field label="Received Events" value={String(context.receivedEvents)} />
		</div>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
			<span style={{ fontSize: 11, fontWeight: 500, color: "#666" }}>{label}</span>
			<code
				style={{
					fontFamily: "monospace",
					fontSize: 12,
					background: "#f5f5f5",
					border: "1px solid #e5e5e5",
					borderRadius: 4,
					padding: "6px 10px",
					wordBreak: "break-all",
				}}
			>
				{value}
			</code>
		</div>
	);
}
