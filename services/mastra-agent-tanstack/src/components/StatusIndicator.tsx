import type { AgentState } from "~/lib/types";

function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const secs = Math.floor(diff / 1000);
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	return `${hrs}h ago`;
}

export function StatusIndicator({ state }: { state: AgentState | null }) {
	if (!state) {
		return <div style={{ padding: 12, color: "#999" }}>Loading...</div>;
	}

	const dotColor =
		state.status === "running"
			? "#f59e0b"
			: state.status === "error"
				? "#ef4444"
				: "#10b981";

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 600 }}>
				<span
					style={{
						width: 10,
						height: 10,
						borderRadius: "50%",
						background: dotColor,
						display: "inline-block",
						flexShrink: 0,
					}}
				/>
				<span style={{ textTransform: "capitalize" }}>{state.status}</span>
			</div>
			{state.currentActivity && (
				<div style={{ fontSize: 12, color: "#666", paddingLeft: 18 }}>
					{state.currentActivity}
				</div>
			)}
			{state.runId && (
				<div style={{ fontSize: 11, color: "#999", paddingLeft: 18 }}>
					Run: <code style={{ fontFamily: "monospace", background: "#eee", padding: "1px 4px", borderRadius: 3, fontSize: 10 }}>
						{state.runId.slice(0, 8)}
					</code>
					{state.startedAt && (
						<span> &middot; started {relativeTime(state.startedAt)}</span>
					)}
				</div>
			)}
		</div>
	);
}
