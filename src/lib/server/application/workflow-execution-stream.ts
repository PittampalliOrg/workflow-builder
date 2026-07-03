import type {
	WorkflowDataService,
	WorkflowExecutionAgentEventRecord,
	WorkflowExecutionReadModelPort,
} from "$lib/server/application/ports";
import type {
	ExecutionReadModel,
	ExecutionTimelineEvent,
} from "$lib/types/execution-stream";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 10_000;

type WorkflowExecutionStreamDependencies = {
	workflowData: Pick<
		WorkflowDataService,
		| "listExecutionSessionIds"
		| "listExecutionAgentEventsAfter"
		| "listenSessionEventNotifications"
	>;
	executionReadModels: WorkflowExecutionReadModelPort;
	heartbeatIntervalMs?: number;
	snapshotIntervalMs?: number;
};

export class ApplicationWorkflowExecutionStreamService {
	constructor(private readonly deps: WorkflowExecutionStreamDependencies) {}

	createEventStream(input: { executionId: string }): ReadableStream<Uint8Array> {
		const executionId = input.executionId;
		const heartbeatIntervalMs =
			this.deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
		const snapshotIntervalMs =
			this.deps.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
		const workflowData = this.deps.workflowData;
		const executionReadModels = this.deps.executionReadModels;
		let cancelled = false;

		return new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
				let lastSnapshotHash = "";

				function send(event: string, data: unknown, id?: string | number) {
					if (cancelled) return;
					const payload = typeof data === "string" ? data : JSON.stringify(data);
					const lines: string[] = [];
					if (id != null) lines.push(`id: ${id}`);
					lines.push(`event: ${event}`);
					lines.push(`data: ${payload}`);
					lines.push("", "");
					try {
						controller.enqueue(encoder.encode(lines.join("\n")));
					} catch {
						cancelled = true;
					}
				}

				function sendComment(text: string) {
					if (cancelled) return;
					try {
						controller.enqueue(encoder.encode(`: ${text}\n\n`));
					} catch {
						cancelled = true;
					}
				}

				try {
					sendComment(" ".repeat(2048));

					const model = (await executionReadModels.loadExecutionReadModel({
						executionId,
						refreshRuntime: true,
						includeAgentEvents: true,
					})) as ExecutionReadModel | null;

					if (!model) {
						send("error", { error: "Execution not found" });
						controller.close();
						return;
					}

					const serialized = executionReadModels.serializeExecutionReadModel(
						model,
						{
							compact: model.status === "running",
							includeAgentEvents: true,
						},
					);
					send("snapshot", serialized);

					if (isTerminalStatus(model.status)) {
						send("terminal", {
							executionId,
							status: model.status,
							completedAt: model.completedAt,
							error: model.error,
						});
						controller.close();
						return;
					}

					const executionSessions = new Set<string>();
					async function refreshSessions(): Promise<void> {
						try {
							const sessionIds =
								await workflowData.listExecutionSessionIds(executionId);
							for (const sessionId of sessionIds) executionSessions.add(sessionId);
						} catch {
							/* transient event-store hiccup - keep whatever we had */
						}
					}
					await refreshSessions();

					const seqBySession = new Map<string, number>();
					for (const ev of model.agentEvents ?? []) {
						const sid = ev.workflowAgentRunId ?? ev.daprInstanceId;
						if (!sid || typeof ev.id !== "number") continue;
						const cur = seqBySession.get(sid) ?? 0;
						if (ev.id > cur) seqBySession.set(sid, ev.id);
					}

					async function drainSession(sessionId: string): Promise<void> {
						if (cancelled) return;
						const after = seqBySession.get(sessionId) ?? 0;
						let records: WorkflowExecutionAgentEventRecord[];
						try {
							records = await workflowData.listExecutionAgentEventsAfter({
								executionId,
								afterEventId: after,
							});
						} catch {
							return;
						}
						for (const record of records) {
							if (record.sessionId !== sessionId) continue;
							const ev = mapAgentEvent(record);
							send("agent_event", ev, ev.id as number);
							if (record.id > (seqBySession.get(sessionId) ?? 0)) {
								seqBySession.set(sessionId, record.id);
							}
						}
					}

					let unlisten: (() => Promise<void>) | null = null;
					const pendingDrains = new Set<string>();
					let draining = false;
					async function drainLoop(sessionId: string): Promise<void> {
						pendingDrains.add(sessionId);
						if (draining) return;
						draining = true;
						try {
							while (pendingDrains.size > 0 && !cancelled) {
								const next = pendingDrains.values().next().value;
								if (!next) break;
								pendingDrains.delete(next);
								await drainSession(next);
							}
						} finally {
							draining = false;
						}
					}

					try {
						const subscription =
							await workflowData.listenSessionEventNotifications(
								({ sessionId: sid }) => {
									if (cancelled) return;
									if (!sid) return;
									if (executionSessions.has(sid)) {
										void drainLoop(sid);
									} else {
										void (async () => {
											await refreshSessions();
											if (executionSessions.has(sid)) void drainLoop(sid);
										})();
									}
								},
							);
						unlisten = () => subscription.unlisten();
						for (const sid of executionSessions) void drainLoop(sid);
					} catch (err) {
						send("stream_unavailable", {
							error: "Event stream subscription failed",
							fallback: true,
							message:
								err instanceof Error ? err.message : "Connection failed",
						});
						controller.close();
						return;
					}

					heartbeatTimer = setInterval(() => {
						send("heartbeat", {
							type: "heartbeat",
							timestamp: new Date().toISOString(),
						});
					}, heartbeatIntervalMs);

					try {
						while (!cancelled) {
							await new Promise((r) => setTimeout(r, snapshotIntervalMs));
							if (cancelled) break;
							try {
								const updated =
									(await executionReadModels.loadExecutionReadModel({
										executionId,
										refreshRuntime: true,
										includeAgentEvents: false,
									})) as ExecutionReadModel | null;
								if (!updated) continue;
								if (isTerminalStatus(updated.status)) {
									for (const sid of executionSessions) await drainSession(sid);
									const finalSerialized =
										executionReadModels.serializeExecutionReadModel(updated, {
											compact: false,
											includeAgentEvents: false,
										});
									send("snapshot", finalSerialized);
									send("terminal", {
										executionId,
										status: updated.status,
										completedAt: updated.completedAt,
										error: updated.error,
									});
									break;
								}

								await refreshSessions();
								const snapHash = JSON.stringify({
									status: updated.status,
									phase: updated.phase,
									progress: updated.progress,
									nodeStatuses: updated.nodeStatuses,
								});
								if (snapHash !== lastSnapshotHash) {
									lastSnapshotHash = snapHash;
									const snap =
										executionReadModels.serializeExecutionReadModel(updated, {
											compact: true,
											includeAgentEvents: false,
										});
									send("snapshot", snap);
								}
							} catch {
								/* transient read-model issue - keep the stream open */
							}
						}
					} finally {
						if (unlisten) {
							const u = unlisten;
							unlisten = null;
							void u().catch(() => {
								/* ignore */
							});
						}
					}
				} catch (err) {
					if (!cancelled) {
						send("stream_unavailable", {
							error: err instanceof Error ? err.message : "Stream error",
						});
					}
				} finally {
					if (heartbeatTimer) clearInterval(heartbeatTimer);
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				}
			},
			cancel() {
				cancelled = true;
			},
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mapAgentEvent(
	row: WorkflowExecutionAgentEventRecord,
): ExecutionTimelineEvent {
	const data = isRecord(row.data) ? { ...row.data } : {};
	const toolName =
		typeof data.tool_name === "string"
			? data.tool_name
			: typeof data.toolName === "string"
				? data.toolName
				: typeof data.name === "string"
					? data.name
					: null;
	const phase = typeof data.phase === "string" ? data.phase : null;
	return {
		id: row.id,
		type: row.type,
		data,
		timestamp: row.createdAt.toISOString(),
		workflowAgentRunId: row.sessionId,
		daprInstanceId: row.sessionId,
		sourceEventId: row.sourceEventId,
		phase,
		toolName,
	};
}

function isTerminalStatus(status: ExecutionReadModel["status"]) {
	return status === "success" || status === "error" || status === "cancelled";
}
