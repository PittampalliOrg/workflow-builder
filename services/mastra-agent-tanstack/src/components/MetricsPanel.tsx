import type { AgentState } from "~/lib/types";

export function MetricsPanel({ state }: { state: AgentState | null }) {
	if (!state) return null;

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
				<div style={cardStyle}>
					<div style={valueStyle}>{state.totalRuns}</div>
					<div style={labelStyle}>Total Runs</div>
				</div>
				<div style={cardStyle}>
					<div style={valueStyle}>
						{state.totalTokens > 1000
							? `${(state.totalTokens / 1000).toFixed(1)}k`
							: state.totalTokens}
					</div>
					<div style={labelStyle}>Total Tokens</div>
				</div>
			</div>

			<div>
				<div style={sectionLabelStyle}>Available Tools</div>
				<div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
					{state.toolNames.length > 0 ? (
						state.toolNames.map((name) => (
							<span key={name} style={chipStyle}>{name}</span>
						))
					) : (
						<span style={{ fontSize: 11, color: "#999" }}>No tools</span>
					)}
				</div>
			</div>

			{state.lastError && (
				<div>
					<div style={sectionLabelStyle}>Last Error</div>
					<div style={{
						background: "#fef2f2",
						border: "1px solid #fecaca",
						borderRadius: 4,
						padding: 8,
						fontSize: 11,
						color: "#dc2626",
						fontFamily: "monospace",
						wordBreak: "break-word",
						marginTop: 4,
					}}>
						{state.lastError}
					</div>
				</div>
			)}
		</div>
	);
}

const cardStyle: React.CSSProperties = {
	background: "#f9f9f9",
	border: "1px solid #e5e5e5",
	borderRadius: 8,
	padding: 12,
	textAlign: "center",
};

const valueStyle: React.CSSProperties = {
	fontSize: 22,
	fontWeight: 700,
	color: "#0078d4",
};

const labelStyle: React.CSSProperties = {
	fontSize: 11,
	color: "#666",
	marginTop: 2,
};

const sectionLabelStyle: React.CSSProperties = {
	fontSize: 11,
	fontWeight: 500,
	color: "#666",
};

const chipStyle: React.CSSProperties = {
	fontSize: 11,
	background: "#eee",
	padding: "2px 8px",
	borderRadius: 10,
	fontFamily: "monospace",
};
