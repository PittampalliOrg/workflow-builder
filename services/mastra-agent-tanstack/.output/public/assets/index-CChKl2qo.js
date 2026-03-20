import { j as e, r, g as w, a as z, b as T, R as I } from "./main-C-KGYsma.js";
function R(t) {
	const n = Date.now() - new Date(t).getTime(),
		i = Math.floor(n / 1e3);
	if (i < 60) return `${i}s ago`;
	const o = Math.floor(i / 60);
	return o < 60 ? `${o}m ago` : `${Math.floor(o / 60)}h ago`;
}
function C({ state: t }) {
	if (!t)
		return e.jsx("div", {
			style: { padding: 12, color: "#999" },
			children: "Loading...",
		});
	const n =
		t.status === "running"
			? "#f59e0b"
			: t.status === "error"
				? "#ef4444"
				: "#10b981";
	return e.jsxs("div", {
		style: { display: "flex", flexDirection: "column", gap: 6 },
		children: [
			e.jsxs("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					fontSize: 15,
					fontWeight: 600,
				},
				children: [
					e.jsx("span", {
						style: {
							width: 10,
							height: 10,
							borderRadius: "50%",
							background: n,
							display: "inline-block",
							flexShrink: 0,
						},
					}),
					e.jsx("span", {
						style: { textTransform: "capitalize" },
						children: t.status,
					}),
				],
			}),
			t.currentActivity &&
				e.jsx("div", {
					style: { fontSize: 12, color: "#666", paddingLeft: 18 },
					children: t.currentActivity,
				}),
			t.runId &&
				e.jsxs("div", {
					style: { fontSize: 11, color: "#999", paddingLeft: 18 },
					children: [
						"Run: ",
						e.jsx("code", {
							style: {
								fontFamily: "monospace",
								background: "#eee",
								padding: "1px 4px",
								borderRadius: 3,
								fontSize: 10,
							},
							children: t.runId.slice(0, 8),
						}),
						t.startedAt &&
							e.jsxs("span", { children: [" · started ", R(t.startedAt)] }),
					],
				}),
		],
	});
}
function E({ state: t }) {
	return t
		? e.jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 12 },
				children: [
					e.jsxs("div", {
						style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
						children: [
							e.jsxs("div", {
								style: u,
								children: [
									e.jsx("div", { style: g, children: t.totalRuns }),
									e.jsx("div", { style: h, children: "Total Runs" }),
								],
							}),
							e.jsxs("div", {
								style: u,
								children: [
									e.jsx("div", {
										style: g,
										children:
											t.totalTokens > 1e3
												? `${(t.totalTokens / 1e3).toFixed(1)}k`
												: t.totalTokens,
									}),
									e.jsx("div", { style: h, children: "Total Tokens" }),
								],
							}),
						],
					}),
					e.jsxs("div", {
						children: [
							e.jsx("div", { style: y, children: "Available Tools" }),
							e.jsx("div", {
								style: {
									display: "flex",
									flexWrap: "wrap",
									gap: 4,
									marginTop: 4,
								},
								children:
									t.toolNames.length > 0
										? t.toolNames.map((n) =>
												e.jsx("span", { style: D, children: n }, n),
											)
										: e.jsx("span", {
												style: { fontSize: 11, color: "#999" },
												children: "No tools",
											}),
							}),
						],
					}),
					t.lastError &&
						e.jsxs("div", {
							children: [
								e.jsx("div", { style: y, children: "Last Error" }),
								e.jsx("div", {
									style: {
										background: "#fef2f2",
										border: "1px solid #fecaca",
										borderRadius: 4,
										padding: 8,
										fontSize: 11,
										color: "#dc2626",
										fontFamily: "monospace",
										wordBreak: "break-word",
										marginTop: 4,
									},
									children: t.lastError,
								}),
							],
						}),
				],
			})
		: null;
}
const u = {
		background: "#f9f9f9",
		border: "1px solid #e5e5e5",
		borderRadius: 8,
		padding: 12,
		textAlign: "center",
	},
	g = { fontSize: 22, fontWeight: 700, color: "#0078d4" },
	h = { fontSize: 11, color: "#666", marginTop: 2 },
	y = { fontSize: 11, fontWeight: 500, color: "#666" },
	D = {
		fontSize: 11,
		background: "#eee",
		padding: "2px 8px",
		borderRadius: 10,
		fontFamily: "monospace",
	},
	W = {
		agent_started: "#8b5cf6",
		agent_completed: "#8b5cf6",
		tool_call: "#10b981",
		tool_result: "#10b981",
		llm_start: "#3b82f6",
		llm_end: "#3b82f6",
		dapr_event: "#6b7280",
	};
function A(t) {
	return new Date(t).toLocaleTimeString("en-US", {
		hour12: !1,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}
function F({ event: t }) {
	const [n, i] = r.useState(!1),
		o = W[t.type] ?? "#6b7280";
	return e.jsxs("div", {
		onClick: () => i(!n),
		style: {
			padding: "8px 14px",
			borderBottom: "1px solid #e5e5e5",
			cursor: "pointer",
		},
		children: [
			e.jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: 6 },
				children: [
					e.jsx("span", {
						style: {
							fontSize: 10,
							fontFamily: "monospace",
							color: "#999",
							flexShrink: 0,
						},
						children: A(t.timestamp),
					}),
					e.jsx("span", {
						style: {
							fontSize: 9,
							fontWeight: 600,
							color: "#fff",
							padding: "1px 6px",
							borderRadius: 3,
							textTransform: "uppercase",
							letterSpacing: 0.3,
							whiteSpace: "nowrap",
							background: o,
						},
						children: t.type.replace(/_/g, " "),
					}),
					t.callId &&
						e.jsx("span", {
							style: {
								fontSize: 9,
								fontFamily: "monospace",
								color: "#999",
								background: "#eee",
								padding: "1px 4px",
								borderRadius: 3,
							},
							children: t.callId,
						}),
					e.jsx("span", {
						style: { marginLeft: "auto", fontSize: 9, color: "#999" },
						children: n ? "▼" : "▶",
					}),
				],
			}),
			n &&
				e.jsx("pre", {
					style: {
						marginTop: 6,
						fontSize: 10,
						fontFamily: "monospace",
						background: "#f5f5f5",
						border: "1px solid #e5e5e5",
						borderRadius: 4,
						padding: 8,
						overflowX: "auto",
						whiteSpace: "pre-wrap",
						wordBreak: "break-all",
						maxHeight: 200,
						overflowY: "auto",
					},
					children: JSON.stringify(t.data, null, 2),
				}),
		],
	});
}
function L({ events: t }) {
	return !t || t.length === 0
		? e.jsxs("div", {
				style: {
					padding: "32px 16px",
					color: "#999",
					textAlign: "center",
					fontSize: 13,
				},
				children: [
					e.jsx("div", { children: "No events yet" }),
					e.jsx("div", {
						style: { fontSize: 11, marginTop: 4 },
						children: "Run the agent to see events appear here",
					}),
				],
			})
		: e.jsx("div", { children: t.map((n) => e.jsx(F, { event: n }, n.id)) });
}
function B({ context: t }) {
	return t
		? t.workflowId || t.nodeId || t.receivedEvents > 0
			? e.jsxs("div", {
					style: {
						padding: 14,
						display: "flex",
						flexDirection: "column",
						gap: 12,
					},
					children: [
						e.jsx(l, { label: "Workflow ID", value: t.workflowId ?? "—" }),
						e.jsx(l, { label: "Node ID", value: t.nodeId ?? "—" }),
						e.jsx(l, {
							label: "Step Index",
							value: t.stepIndex !== null ? String(t.stepIndex) : "—",
						}),
						e.jsx(l, {
							label: "Received Events",
							value: String(t.receivedEvents),
						}),
					],
				})
			: e.jsxs("div", {
					style: {
						padding: "32px 16px",
						color: "#999",
						textAlign: "center",
						fontSize: 13,
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: 8,
					},
					children: [
						e.jsxs("svg", {
							width: "32",
							height: "32",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "1.5",
							children: [
								e.jsx("path", {
									d: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z",
								}),
								e.jsx("polyline", { points: "13 2 13 9 20 9" }),
							],
						}),
						e.jsx("span", { children: "Not part of a workflow" }),
						e.jsx("span", {
							style: { fontSize: 11 },
							children:
								"Dapr workflow context will appear here when the agent runs inside a workflow",
						}),
					],
				})
		: null;
}
function l({ label: t, value: n }) {
	return e.jsxs("div", {
		style: { display: "flex", flexDirection: "column", gap: 2 },
		children: [
			e.jsx("span", {
				style: { fontSize: 11, fontWeight: 500, color: "#666" },
				children: t,
			}),
			e.jsx("code", {
				style: {
					fontFamily: "monospace",
					fontSize: 12,
					background: "#f5f5f5",
					border: "1px solid #e5e5e5",
					borderRadius: 4,
					padding: "6px 10px",
					wordBreak: "break-all",
				},
				children: n,
			}),
		],
	});
}
function _({ initialState: t, initialEvents: n, initialWorkflow: i }) {
	const [o, s] = r.useState("status"),
		[f, m] = r.useState(t),
		[a, v] = r.useState(n),
		[j, b] = r.useState(i),
		p = r.useCallback(async () => {
			try {
				const [d, S, k] = await Promise.all([w(), z(), T()]);
				m(d), v(S), b(k);
			} catch {}
		}, []);
	r.useEffect(() => {
		const d = setInterval(p, 2e3);
		return () => clearInterval(d);
	}, [p]);
	const x = Array.isArray(a) ? a.length : 0;
	return e.jsxs("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			height: "100vh",
			fontFamily:
				"-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
			fontSize: 13,
		},
		children: [
			e.jsxs("div", {
				style: {
					display: "flex",
					borderBottom: "1px solid #e5e5e5",
					background: "#f9f9f9",
					flexShrink: 0,
				},
				children: [
					e.jsx(c, {
						active: o === "status",
						onClick: () => s("status"),
						children: "Status",
					}),
					e.jsxs(c, {
						active: o === "events",
						onClick: () => s("events"),
						children: [
							"Events",
							x > 0 &&
								e.jsx("span", {
									style: {
										fontSize: 10,
										background: "#0078d4",
										color: "#fff",
										padding: "0 5px",
										borderRadius: 8,
										minWidth: 18,
										textAlign: "center",
										lineHeight: "16px",
										marginLeft: 4,
									},
									children: x,
								}),
						],
					}),
					e.jsx(c, {
						active: o === "workflow",
						onClick: () => s("workflow"),
						children: "Workflow",
					}),
				],
			}),
			e.jsxs("div", {
				style: { flex: 1, overflowY: "auto" },
				children: [
					o === "status" &&
						e.jsxs("div", {
							style: {
								padding: 14,
								display: "flex",
								flexDirection: "column",
								gap: 16,
							},
							children: [e.jsx(C, { state: f }), e.jsx(E, { state: f })],
						}),
					o === "events" && e.jsx(L, { events: a }),
					o === "workflow" && e.jsx(B, { context: j }),
				],
			}),
		],
	});
}
function c({ active: t, onClick: n, children: i }) {
	return e.jsx("button", {
		onClick: n,
		style: {
			flex: 1,
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			gap: 5,
			padding: "8px 4px",
			border: "none",
			borderBottom: `2px solid ${t ? "#0078d4" : "transparent"}`,
			background: "transparent",
			color: t ? "#0078d4" : "#666",
			fontSize: 12,
			fontWeight: 500,
			cursor: "pointer",
			whiteSpace: "nowrap",
			fontFamily: "inherit",
		},
		children: i,
	});
}
function M() {
	const { state: t, events: n, workflow: i } = I.useLoaderData();
	return e.jsx(_, { initialState: t, initialEvents: n, initialWorkflow: i });
}
export { M as component };
