import { nanoid } from "nanoid";
import type { RemoteConnection, RemoteMutationRecord } from "@remote-dom/core";
import { ROOT_ID } from "@remote-dom/core";
import {
	connectRemoteNode,
	disconnectRemoteNode,
	setRemoteId,
	serializeRemoteNode,
} from "@remote-dom/core/elements";
import * as db from "../db.js";
import { initRemoteDomEnv } from "./remote-dom-env.js";
import type { UiEvent, UiModel, UiToast } from "./types.js";

const ORCHESTRATOR_URL =
	process.env.WORKFLOW_ORCHESTRATOR_URL ?? "http://workflow-orchestrator:8080";

const MAX_BATCHES = 200;

type MutationBatch = { seq: number; records: readonly RemoteMutationRecord[] };

function isTerminalRuntimeStatus(status: unknown): boolean {
	const s = String(
		(status as any)?.runtimeStatus ?? (status as any)?.status ?? "",
	)
		.toUpperCase()
		.trim();
	return s === "COMPLETED" || s === "FAILED" || s === "TERMINATED";
}

function toNodeStatuses(
	prev: Record<string, "running" | "completed" | "error">,
	status: any,
): Record<string, "running" | "completed" | "error"> {
	if (!status) return {};

	const runtimeStatus = String(status?.runtimeStatus ?? status?.status ?? "")
		.toUpperCase()
		.trim();

	if (runtimeStatus === "COMPLETED" || runtimeStatus === "TERMINATED") {
		const next = { ...prev };
		for (const id of Object.keys(next)) {
			if (next[id] === "running") next[id] = "completed";
		}
		return next;
	}

	if (runtimeStatus === "FAILED") {
		const next = { ...prev };
		for (const id of Object.keys(next)) {
			if (next[id] === "running") next[id] = "error";
		}
		return next;
	}

	const currentNodeId = status?.currentNodeId ?? null;
	if (!currentNodeId) return prev;

	const next = { ...prev };
	for (const id of Object.keys(next)) {
		if (next[id] === "running") next[id] = "completed";
	}
	next[currentNodeId] = "running";
	return next;
}

export class UiSession {
	private readonly userId: string | undefined;

	private seq = 0;
	private generation = 0;
	private readonly batches: MutationBatch[] = [];
	private readonly root: HTMLElement;
	private appEl: any | null = null;

	private selectedWorkflowId: string | null = null;
	private selectedNodeId: string | null = null;

	private dirty = true;
	private lastDbRefreshAt = 0;
	private cachedWorkflows: db.WorkflowSummary[] = [];
	private cachedWorkflow: db.WorkflowRow | null = null;
	private cachedWorkflowId: string | null = null;

	private execution: {
		instanceId: string | null;
		status: any | null;
		results: any | null;
		showResults: boolean;
		loadingResults: boolean;
		lastStatusPollAt: number;
	} = {
		instanceId: null,
		status: null,
		results: null,
		showResults: false,
		loadingResults: false,
		lastStatusPollAt: 0,
	};

	private nodeStatuses: Record<string, "running" | "completed" | "error"> = {};
	private toasts: UiToast[] = [];
	private lastModelJson: string | null = null;

	// Remote DOM connection — the polyfill hooks call connection.mutate() directly
	// when DOM operations occur (appendChild, removeChild, setText, setAttribute).
	// No MutationObserver needed; the @remote-dom/core/polyfill hooks handle it.
	readonly connection: RemoteConnection = {
		mutate: (records: readonly RemoteMutationRecord[]) => {
			this.pushBatch(records);
		},
		call: async () => {
			throw new Error("Remote method calls are not supported");
		},
	};

	constructor(userId?: string) {
		this.userId = userId;

		initRemoteDomEnv();

		// One polyfilled `document` for the process; roots are per-session.
		this.root = document.createElement("div");

		// Wire the root to our connection so the polyfill hooks emit mutations.
		setRemoteId(this.root, ROOT_ID);
		connectRemoteNode(this.root, this.connection);
	}

	dispose(): void {
		try {
			disconnectRemoteNode(this.root);
		} catch {
			// ignore
		}
	}

	private pushBatch(records: readonly RemoteMutationRecord[]) {
		this.seq += 1;
		this.batches.push({ seq: this.seq, records });
		if (this.batches.length > MAX_BATCHES)
			this.batches.splice(0, this.batches.length - MAX_BATCHES);
	}

	private pruneToasts(now = Date.now()): void {
		this.toasts = this.toasts.filter((t) => t.expiresAt > now);
	}

	private ensureDom(): void {
		if (this.appEl) return;
		while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
		this.appEl = document.createElement("wf-app");
		this.root.appendChild(this.appEl);
	}

	private toast(message: string, type: "success" | "error" = "success"): void {
		const now = Date.now();
		this.toasts.push({
			id: nanoid(),
			message,
			type,
			expiresAt: now + 4_000,
		});
		this.pruneToasts(now);
	}

	private drain(since: number): {
		seq: number;
		mutations: RemoteMutationRecord[];
		reset?: boolean;
	} {
		const latestSeq = this.seq;
		if (this.batches.length === 0) return { seq: latestSeq, mutations: [] };

		const oldestSeq = this.batches[0]?.seq ?? latestSeq;
		// If the client's seq predates the oldest batch (e.g. after a bootstrap
		// reset cleared old batches), return all current mutations with reset flag
		// so the client creates a fresh RemoteReceiver.
		if (since < oldestSeq) {
			const all = this.batches.flatMap((b) => [...b.records]);
			return { seq: latestSeq, mutations: all, reset: true };
		}

		const out: RemoteMutationRecord[] = [];
		for (const batch of this.batches) {
			if (batch.seq > since) out.push(...batch.records);
		}
		return { seq: latestSeq, mutations: out };
	}

	private async pollExecutionIfNeeded(): Promise<void> {
		if (!this.execution.instanceId) return;
		if (isTerminalRuntimeStatus(this.execution.status)) return;

		const now = Date.now();
		if (now - this.execution.lastStatusPollAt < 1_000) return;
		this.execution.lastStatusPollAt = now;

		try {
			const resp = await fetch(
				`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(this.execution.instanceId)}/status`,
			);
			if (!resp.ok) return;
			const status = await resp.json();
			this.execution.status = status;
			this.nodeStatuses = toNodeStatuses(this.nodeStatuses, status);
		} catch {
			// transient
		}
	}

	private async buildModel(): Promise<UiModel> {
		this.pruneToasts();

		const now = Date.now();
		const shouldRefreshDb = this.dirty || now - this.lastDbRefreshAt > 2_000;

		if (shouldRefreshDb) {
			this.cachedWorkflows = await db.listWorkflows(this.userId);
			this.lastDbRefreshAt = now;
		}

		let workflow: db.WorkflowRow | null = null;
		let selectedNode: db.NodeData | null = null;

		if (this.selectedWorkflowId) {
			if (
				shouldRefreshDb ||
				this.cachedWorkflowId !== this.selectedWorkflowId ||
				!this.cachedWorkflow
			) {
				this.cachedWorkflow = await db.getWorkflow(this.selectedWorkflowId);
				this.cachedWorkflowId = this.selectedWorkflowId;
			}
			workflow = this.cachedWorkflow;
			if (!workflow) {
				this.selectedWorkflowId = null;
				this.selectedNodeId = null;
				this.nodeStatuses = {};
				this.cachedWorkflow = null;
				this.cachedWorkflowId = null;
			}
		} else {
			this.cachedWorkflow = null;
			this.cachedWorkflowId = null;
		}

		if (workflow && this.selectedNodeId) {
			selectedNode =
				workflow.nodes.find((n) => n.id === this.selectedNodeId) ?? null;
			if (!selectedNode) this.selectedNodeId = null;
		}

		if (shouldRefreshDb) this.dirty = false;

		return {
			workflows: this.cachedWorkflows,
			selectedWorkflowId: this.selectedWorkflowId,
			workflow,
			selectedNodeId: this.selectedNodeId,
			selectedNode,
			nodeStatuses: this.nodeStatuses,
			execution: {
				instanceId: this.execution.instanceId,
				status: this.execution.status,
				results: this.execution.results,
				showResults: this.execution.showResults,
				loadingResults: this.execution.loadingResults,
			},
			toasts: this.toasts,
			nodeTypes: [
				{ value: "action", label: "Action" },
				{ value: "approval-gate", label: "Approval Gate" },
				{ value: "timer", label: "Timer" },
				{ value: "if-else", label: "If/Else" },
				{ value: "loop-until", label: "Loop Until" },
				{ value: "set-state", label: "Set State" },
				{ value: "transform", label: "Transform" },
				{ value: "publish-event", label: "Publish Event" },
				{ value: "note", label: "Note" },
			],
		};
	}

	private async render(): Promise<void> {
		this.ensureDom();
		const model = await this.buildModel();
		const json = JSON.stringify(model);
		if (this.lastModelJson === json) return;
		this.lastModelJson = json;
		this.appEl!.model = model;
		// connectRemoteNode wraps our connection in a BatchingRemoteConnection
		// that defers flushing via MessageChannel or setTimeout(0). We must yield
		// the event loop so the batch flushes and our pushBatch() captures the
		// mutations before drain() is called by the caller.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	async bootstrap(): Promise<{
		seq: number;
		mutations: RemoteMutationRecord[];
	}> {
		// Bump generation so stale clients get reset: true from drain().
		this.generation += 1;

		// Clear mutation history and produce a full initial render.
		// Keep seq monotonically increasing so stale drain() calls detect the gap.
		this.batches.length = 0;
		this.lastModelJson = null;
		this.appEl = null;
		this.dirty = true;

		// Clear and reconnect the root so the polyfill hooks are wired fresh.
		disconnectRemoteNode(this.root);
		while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
		setRemoteId(this.root, ROOT_ID);
		connectRemoteNode(this.root, this.connection);

		// Clear any stale batches from the teardown above but keep seq advancing.
		this.batches.length = 0;

		await this.render();
		const beforeSeq = this.seq - this.batches.length;
		const drained = this.drain(beforeSeq);
		return { seq: drained.seq, mutations: drained.mutations };
	}

	async updates(since: number): Promise<{
		seq: number;
		mutations: RemoteMutationRecord[];
		reset?: boolean;
	}> {
		await this.pollExecutionIfNeeded();
		// Execution polling can change UI without explicit events.
		await this.render();
		return this.drain(since);
	}

	async handleEvent(
		event: UiEvent,
	): Promise<{ seq: number; mutations: RemoteMutationRecord[] }> {
		const before = this.seq;
		try {
			switch (event.type) {
				case "workflow.select": {
					this.selectedWorkflowId = event.workflowId;
					this.selectedNodeId = null;
					this.nodeStatuses = {};
					this.dirty = true;
					this.execution = {
						instanceId: null,
						status: null,
						results: null,
						showResults: false,
						loadingResults: false,
						lastStatusPollAt: 0,
					};
					break;
				}
				case "workflow.create": {
					const wf = await db.createWorkflow(
						event.name,
						event.description,
						this.userId,
					);
					this.selectedWorkflowId = wf.id;
					this.selectedNodeId = null;
					this.dirty = true;
					this.toast("Workflow created");
					break;
				}
				case "workflow.rename": {
					await db.updateWorkflow(event.workflowId, { name: event.name });
					this.dirty = true;
					this.toast("Renamed");
					break;
				}
				case "workflow.update_description": {
					await db.updateWorkflow(event.workflowId, {
						description: event.description ?? undefined,
					});
					this.dirty = true;
					this.toast("Updated");
					break;
				}
				case "workflow.duplicate": {
					const wf = await db.duplicateWorkflow(event.workflowId, this.userId);
					if (wf) {
						this.selectedWorkflowId = wf.id;
						this.selectedNodeId = null;
						this.dirty = true;
						this.toast("Duplicated");
					} else {
						this.toast("Failed to duplicate", "error");
					}
					break;
				}
				case "workflow.delete": {
					const ok = await db.deleteWorkflow(event.workflowId);
					if (ok) {
						if (this.selectedWorkflowId === event.workflowId) {
							this.selectedWorkflowId = null;
							this.selectedNodeId = null;
							this.nodeStatuses = {};
						}
						this.dirty = true;
						this.toast("Workflow deleted");
					} else {
						this.toast("Workflow not found", "error");
					}
					break;
				}
				case "workflow.refresh": {
					this.dirty = true;
					break;
				}
				case "node.select": {
					this.selectedNodeId = event.nodeId;
					break;
				}
				case "node.add": {
					const node: db.NodeData = {
						id: nanoid(),
						type: event.nodeType,
						position: { x: event.x, y: event.y },
						data: {
							label:
								event.label ??
								event.nodeType.charAt(0).toUpperCase() +
									event.nodeType.slice(1).replace(/-/g, " "),
							type: event.nodeType,
							status: "idle",
							enabled: true,
						},
					};
					const wf = await db.addNode(event.workflowId, node);
					if (!wf) this.toast("Workflow not found", "error");
					this.dirty = true;
					break;
				}
				case "node.move": {
					await db.updateNode(event.workflowId, event.nodeId, {
						position: { x: event.x, y: event.y },
					});
					this.dirty = true;
					break;
				}
				case "node.update": {
					await db.updateNode(event.workflowId, event.nodeId, {
						...event.updates,
					});
					this.dirty = true;
					this.toast("Node updated");
					break;
				}
				case "node.delete": {
					await db.deleteNode(event.workflowId, event.nodeId);
					if (this.selectedNodeId === event.nodeId) this.selectedNodeId = null;
					this.dirty = true;
					this.toast("Node deleted");
					break;
				}
				case "edge.connect": {
					const edge: db.EdgeData = {
						id: nanoid(),
						source: event.sourceId,
						target: event.targetId,
						sourceHandle: event.sourceHandle,
						targetHandle: event.targetHandle,
					};
					await db.connectNodes(event.workflowId, edge);
					this.dirty = true;
					break;
				}
				case "edge.disconnect": {
					await db.disconnectNodes(event.workflowId, event.edgeId);
					this.dirty = true;
					break;
				}
				case "execution.run": {
					const resp = await fetch(
						`${ORCHESTRATOR_URL}/api/v2/workflows/execute-by-id`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								workflowId: event.workflowId,
								triggerData: event.triggerData ?? {},
							}),
						},
					);
					if (!resp.ok) {
						const text = await resp.text();
						this.toast(`Execute failed: ${resp.status} ${text}`, "error");
						break;
					}
					const result = await resp.json();
					const instanceId = result?.instanceId ?? result?.instance_id ?? null;
					this.execution.instanceId = instanceId;
					this.execution.status = null;
					this.execution.results = null;
					this.execution.showResults = false;
					this.execution.loadingResults = false;
					this.execution.lastStatusPollAt = 0;
					this.nodeStatuses = {};
					this.toast("Workflow started");
					break;
				}
				case "execution.approve": {
					const resp = await fetch(
						`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(event.instanceId)}/events`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								eventName: event.eventName,
								eventData: { approved: event.approved, reason: event.reason },
							}),
						},
					);
					if (!resp.ok) {
						const text = await resp.text();
						this.toast(`Approval failed: ${resp.status} ${text}`, "error");
					} else {
						this.toast(event.approved ? "Approved" : "Rejected");
					}
					break;
				}
				case "execution.show_results": {
					this.execution.showResults = true;
					this.execution.loadingResults = true;
					this.execution.results = null;
					await this.render();
					try {
						const execution = await db.getExecutionByInstanceId(
							event.instanceId,
						);
						if (!execution) {
							this.toast("Execution not found", "error");
							break;
						}
						const logs = await db.getExecutionLogs(execution.id);
						this.execution.results = { execution, logs };
					} finally {
						this.execution.loadingResults = false;
					}
					break;
				}
				case "execution.hide_results": {
					this.execution.showResults = false;
					break;
				}
				case "toast.dismiss": {
					this.toasts = this.toasts.filter((t) => t.id !== event.id);
					break;
				}
				default: {
					const _exhaustive: never = event;
					return _exhaustive;
				}
			}
		} catch (err) {
			this.toast(`UI action failed: ${String(err)}`, "error");
		}

		await this.render();
		const drained = this.drain(before);
		return { seq: drained.seq, mutations: drained.mutations };
	}

	async externalRefresh(): Promise<void> {
		this.dirty = true;
		await this.render();
	}
}
