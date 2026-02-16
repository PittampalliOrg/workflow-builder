import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App as McpApp } from "@modelcontextprotocol/ext-apps";
import {
	RemoteFragmentRenderer,
	RemoteReceiver,
	RemoteRootRenderer,
	createRemoteComponentRenderer,
} from "@remote-dom/react/host";
import {
	Background,
	Controls,
	MarkerType,
	ReactFlow,
	type Connection,
	type Edge,
	type Node,
	useEdgesState,
	useNodesState,
} from "@xyflow/react";
import { SimpleNode } from "./components/SimpleNode";

type WorkflowSummary = {
	id: string;
	name: string;
	description: string | null;
	node_count: number;
	edge_count: number;
};

type NodeData = {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: {
		label: string;
		description?: string;
		type: string;
		config?: Record<string, unknown>;
		status?: string;
		enabled?: boolean;
	};
};

type EdgeData = {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string;
	targetHandle?: string;
};

type WorkflowRow = {
	id: string;
	name: string;
	description: string | null;
	nodes: NodeData[];
	edges: EdgeData[];
	visibility: string;
	created_at?: string;
	updated_at?: string;
};

type UiToast = { id: string; message: string; type: "success" | "error" };

type UiExecution = {
	instanceId: string | null;
	status: any | null;
	results: any | null;
	showResults: boolean;
	loadingResults: boolean;
};

type UiModel = {
	workflows: WorkflowSummary[];
	selectedWorkflowId: string | null;
	workflow: WorkflowRow | null;
	selectedNodeId: string | null;
	selectedNode: NodeData | null;
	nodeStatuses: Record<string, "running" | "completed" | "error">;
	execution: UiExecution;
	toasts: UiToast[];
	nodeTypes: Array<{ value: string; label: string }>;
};

type UiEvent =
	| { type: "workflow.select"; workflowId: string }
	| { type: "workflow.create"; name: string; description?: string }
	| { type: "workflow.rename"; workflowId: string; name: string }
	| {
			type: "workflow.update_description";
			workflowId: string;
			description: string | null;
	  }
	| { type: "workflow.duplicate"; workflowId: string }
	| { type: "workflow.delete"; workflowId: string }
	| { type: "workflow.refresh" }
	| { type: "node.select"; nodeId: string | null }
	| {
			type: "node.add";
			workflowId: string;
			nodeType: string;
			x: number;
			y: number;
			label?: string;
	  }
	| {
			type: "node.move";
			workflowId: string;
			nodeId: string;
			x: number;
			y: number;
	  }
	| {
			type: "node.update";
			workflowId: string;
			nodeId: string;
			updates: {
				label?: string;
				description?: string;
				enabled?: boolean;
				config?: Record<string, unknown>;
			};
	  }
	| { type: "node.delete"; workflowId: string; nodeId: string }
	| {
			type: "edge.connect";
			workflowId: string;
			sourceId: string;
			targetId: string;
			sourceHandle?: string;
			targetHandle?: string;
	  }
	| { type: "edge.disconnect"; workflowId: string; edgeId: string }
	| {
			type: "execution.run";
			workflowId: string;
			triggerData?: Record<string, unknown>;
	  }
	| {
			type: "execution.approve";
			instanceId: string;
			eventName: string;
			approved: boolean;
			reason?: string;
	  }
	| { type: "execution.show_results"; instanceId: string }
	| { type: "execution.hide_results" }
	| { type: "toast.dismiss"; id: string };

type UiWire = {
	seq: number;
	mutations: any[];
	reset?: boolean;
};

function parseToolJson(result: {
	content?: Array<{ type: string; text?: string }>;
}): any {
	const text = result.content?.find((c) => c.type === "text")?.text;
	if (!text) return null;
	return JSON.parse(text);
}

function useSerialQueue() {
	const chain = useRef(Promise.resolve());
	return useCallback(<T,>(fn: () => Promise<T>) => {
		const next = chain.current.then(fn, fn);
		chain.current = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}, []);
}

type UiClient = {
	sendEvent: (event: UiEvent) => Promise<void>;
};

const UiClientContext = createContext<UiClient | null>(null);

function useUiClient(): UiClient {
	const ctx = useContext(UiClientContext);
	if (!ctx) throw new Error("UiClientContext missing");
	return ctx;
}

const WfAppHost = createRemoteComponentRenderer(function WfAppHost({
	model,
}: {
	model: UiModel;
}) {
	const { sendEvent } = useUiClient();

	const wf = model.workflow;
	const exec = model.execution;

	return (
		<div className="wf-shell">
			<div className="wf-sidebar">
				<Sidebar
					workflows={model.workflows}
					selectedId={model.selectedWorkflowId}
					onSelect={(id) =>
						void sendEvent({ type: "workflow.select", workflowId: id })
					}
					onCreate={(name) => void sendEvent({ type: "workflow.create", name })}
				/>
			</div>

			<div className="wf-main">
				<TopBar
					workflow={wf}
					onRename={(name) =>
						wf
							? void sendEvent({
									type: "workflow.rename",
									workflowId: wf.id,
									name,
								})
							: undefined
					}
					onDuplicate={() =>
						wf
							? void sendEvent({
									type: "workflow.duplicate",
									workflowId: wf.id,
								})
							: undefined
					}
					onDelete={() =>
						wf
							? void sendEvent({ type: "workflow.delete", workflowId: wf.id })
							: undefined
					}
					onRefresh={() => void sendEvent({ type: "workflow.refresh" })}
				/>

				<div className="wf-canvas">
					{wf ? (
						<GraphHost
							workflow={wf}
							selectedNodeId={model.selectedNodeId}
							nodeStatuses={model.nodeStatuses}
							onSelectNode={(id) =>
								void sendEvent({ type: "node.select", nodeId: id })
							}
							onMoveNode={(id, x, y) =>
								void sendEvent({
									type: "node.move",
									workflowId: wf.id,
									nodeId: id,
									x,
									y,
								})
							}
							onConnect={(c) =>
								void sendEvent({
									type: "edge.connect",
									workflowId: wf.id,
									sourceId: c.sourceId,
									targetId: c.targetId,
									sourceHandle: c.sourceHandle,
									targetHandle: c.targetHandle,
								})
							}
							onAddNode={(nodeType, x, y) =>
								void sendEvent({
									type: "node.add",
									workflowId: wf.id,
									nodeType,
									x,
									y,
								})
							}
							nodeTypes={model.nodeTypes}
						/>
					) : (
						<EmptyState />
					)}
				</div>
			</div>

			<div className="wf-inspector">
				<Inspector
					workflow={wf}
					selectedNode={model.selectedNode}
					onSave={(nodeId, updates) =>
						wf
							? void sendEvent({
									type: "node.update",
									workflowId: wf.id,
									nodeId,
									updates,
								})
							: undefined
					}
					onDelete={(nodeId) =>
						wf
							? void sendEvent({
									type: "node.delete",
									workflowId: wf.id,
									nodeId,
								})
							: undefined
					}
				/>
			</div>

			<div className="wf-bottom">
				<ExecutionBar
					workflow={wf}
					execution={exec}
					onRun={() =>
						wf
							? void sendEvent({ type: "execution.run", workflowId: wf.id })
							: undefined
					}
					onShowResults={() =>
						exec.instanceId
							? void sendEvent({
									type: "execution.show_results",
									instanceId: exec.instanceId,
								})
							: undefined
					}
					onHideResults={() =>
						void sendEvent({ type: "execution.hide_results" })
					}
					onApprove={(approved) =>
						exec.instanceId && exec.status?.approvalEventName
							? void sendEvent({
									type: "execution.approve",
									instanceId: exec.instanceId,
									eventName: exec.status.approvalEventName,
									approved,
								})
							: undefined
					}
				/>

				{exec.showResults && (
					<div className="wf-results">
						{exec.loadingResults && (
							<div className="wf-results-loading">
								<div className="spinner" />
							</div>
						)}
						{exec.results && (
							<ResultsView
								results={exec.results}
								onClose={() =>
									void sendEvent({ type: "execution.hide_results" })
								}
							/>
						)}
					</div>
				)}
			</div>

			<ToastStack
				toasts={model.toasts}
				onDismiss={(id) => void sendEvent({ type: "toast.dismiss", id })}
			/>
		</div>
	);
});

function ResultsView({
	results,
	onClose,
}: {
	results: unknown;
	onClose: () => void;
}) {
	return (
		<div className="wf-results-inner">
			<div className="wf-results-header">
				<div className="wf-results-title">Execution Results</div>
				<button className="wf-btn" onClick={onClose}>
					Close
				</button>
			</div>
			<pre className="wf-results-json">{JSON.stringify(results, null, 2)}</pre>
		</div>
	);
}

function EmptyState() {
	return (
		<div className="wf-empty">
			<div className="wf-empty-title">Pick a workflow</div>
			<div className="wf-empty-sub">
				Select a workflow on the left, or create a new one.
			</div>
		</div>
	);
}

function Sidebar({
	workflows,
	selectedId,
	onSelect,
	onCreate,
}: {
	workflows: WorkflowSummary[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onCreate: (name: string) => void;
}) {
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");

	return (
		<div className="wf-sidebar-inner">
			<div className="wf-sidebar-header">
				<div className="wf-sidebar-title">Workflows</div>
				<button
					className="wf-btn wf-btn-primary"
					onClick={() => {
						setCreating((v) => !v);
						setName("");
					}}
				>
					New
				</button>
			</div>

			{creating && (
				<div className="wf-create">
					<input
						className="wf-input"
						placeholder="Workflow name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && name.trim()) {
								onCreate(name.trim());
								setCreating(false);
								setName("");
							}
							if (e.key === "Escape") {
								setCreating(false);
								setName("");
							}
						}}
						autoFocus
					/>
					<div className="wf-create-actions">
						<button
							className="wf-btn wf-btn-primary"
							disabled={!name.trim()}
							onClick={() => {
								if (!name.trim()) return;
								onCreate(name.trim());
								setCreating(false);
								setName("");
							}}
						>
							Create
						</button>
						<button
							className="wf-btn"
							onClick={() => {
								setCreating(false);
								setName("");
							}}
						>
							Cancel
						</button>
					</div>
				</div>
			)}

			<div className="wf-list">
				{workflows.map((wf) => (
					<button
						key={wf.id}
						className={`wf-list-item ${wf.id === selectedId ? "active" : ""}`}
						onClick={() => onSelect(wf.id)}
					>
						<div className="wf-list-name">{wf.name}</div>
						<div className="wf-list-meta">
							{wf.node_count} nodes, {wf.edge_count} edges
						</div>
					</button>
				))}
				{workflows.length === 0 && (
					<div className="wf-list-empty">No workflows yet</div>
				)}
			</div>
		</div>
	);
}

function TopBar({
	workflow,
	onRename,
	onDuplicate,
	onDelete,
	onRefresh,
}: {
	workflow: WorkflowRow | null;
	onRename: (name: string) => void;
	onDuplicate: () => void;
	onDelete: () => void;
	onRefresh: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState("");

	useEffect(() => {
		setEditing(false);
		setName(workflow?.name ?? "");
	}, [workflow?.id]);

	return (
		<div className="wf-topbar">
			<div className="wf-topbar-left">
				{workflow ? (
					<div className="wf-title">
						{editing ? (
							<input
								className="wf-input wf-title-input"
								value={name}
								onChange={(e) => setName(e.target.value)}
								onBlur={() => {
									setEditing(false);
									if (!workflow) return;
									const next = name.trim();
									if (!next || next === workflow.name) return;
									onRename(next);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") (e.target as HTMLInputElement).blur();
									if (e.key === "Escape") {
										setEditing(false);
										setName(workflow.name);
									}
								}}
								autoFocus
							/>
						) : (
							<button
								className="wf-title-btn"
								onClick={() => {
									setName(workflow.name);
									setEditing(true);
								}}
							>
								{workflow.name}
							</button>
						)}
					</div>
				) : (
					<div className="wf-title wf-title-muted">Workflow Builder</div>
				)}
			</div>

			<div className="wf-topbar-right">
				<button className="wf-btn" onClick={onRefresh}>
					Refresh
				</button>
				<button className="wf-btn" disabled={!workflow} onClick={onDuplicate}>
					Duplicate
				</button>
				<button
					className="wf-btn wf-btn-danger"
					disabled={!workflow}
					onClick={onDelete}
				>
					Delete
				</button>
			</div>
		</div>
	);
}

function ExecutionBar({
	workflow,
	execution,
	onRun,
	onShowResults,
	onHideResults,
	onApprove,
}: {
	workflow: WorkflowRow | null;
	execution: UiExecution;
	onRun: () => void;
	onShowResults: () => void;
	onHideResults: () => void;
	onApprove: (approved: boolean) => void;
}) {
	const runtimeStatus = String(
		execution.status?.runtimeStatus ?? execution.status?.status ?? "",
	);
	const isTerminal =
		runtimeStatus.toUpperCase() === "COMPLETED" ||
		runtimeStatus.toUpperCase() === "FAILED" ||
		runtimeStatus.toUpperCase() === "TERMINATED";
	const approvalEventName = execution.status?.approvalEventName ?? null;
	const awaitingApproval = !!approvalEventName && !isTerminal;

	return (
		<div className="wf-execbar">
			<div className="wf-execbar-left">
				<div className="wf-exec-pill">
					<span className="wf-exec-label">Status</span>
					<span className="wf-exec-value">
						{execution.instanceId ? runtimeStatus || "RUNNING" : "IDLE"}
					</span>
				</div>
				{execution.instanceId && (
					<div className="wf-exec-pill">
						<span className="wf-exec-label">Instance</span>
						<span className="wf-exec-mono">{execution.instanceId}</span>
					</div>
				)}
			</div>

			<div className="wf-execbar-right">
				{awaitingApproval ? (
					<>
						<button
							className="wf-btn wf-btn-primary"
							onClick={() => onApprove(true)}
						>
							Approve
						</button>
						<button
							className="wf-btn wf-btn-danger"
							onClick={() => onApprove(false)}
						>
							Reject
						</button>
					</>
				) : (
					<button
						className="wf-btn wf-btn-primary"
						disabled={!workflow}
						onClick={onRun}
					>
						Run
					</button>
				)}
				{execution.instanceId && (
					<button
						className="wf-btn"
						onClick={execution.showResults ? onHideResults : onShowResults}
					>
						{execution.showResults ? "Hide Results" : "Show Results"}
					</button>
				)}
			</div>
		</div>
	);
}

function Inspector({
	workflow,
	selectedNode,
	onSave,
	onDelete,
}: {
	workflow: WorkflowRow | null;
	selectedNode: NodeData | null;
	onSave: (
		nodeId: string,
		updates: {
			label?: string;
			description?: string;
			enabled?: boolean;
			config?: Record<string, unknown>;
		},
	) => void;
	onDelete: (nodeId: string) => void;
}) {
	const [label, setLabel] = useState("");
	const [description, setDescription] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [configText, setConfigText] = useState("");
	const [configError, setConfigError] = useState<string | null>(null);

	useEffect(() => {
		if (!selectedNode) return;
		setLabel(selectedNode.data.label ?? "");
		setDescription(selectedNode.data.description ?? "");
		setEnabled(selectedNode.data.enabled ?? true);
		setConfigText(
			selectedNode.data.config
				? JSON.stringify(selectedNode.data.config, null, 2)
				: "{}",
		);
		setConfigError(null);
	}, [selectedNode?.id]);

	if (!workflow) {
		return (
			<div className="wf-inspector-inner">
				<div className="wf-inspector-title">Inspector</div>
				<div className="wf-inspector-muted">Select a workflow first.</div>
			</div>
		);
	}

	if (!selectedNode) {
		return (
			<div className="wf-inspector-inner">
				<div className="wf-inspector-title">Inspector</div>
				<div className="wf-inspector-muted">Select a node to edit.</div>
			</div>
		);
	}

	return (
		<div className="wf-inspector-inner">
			<div className="wf-inspector-title">{selectedNode.data.label}</div>
			<div className="wf-inspector-sub">{selectedNode.type}</div>

			<label className="wf-field">
				<div className="wf-field-label">Label</div>
				<input
					className="wf-input"
					value={label}
					onChange={(e) => setLabel(e.target.value)}
				/>
			</label>

			<label className="wf-field">
				<div className="wf-field-label">Description</div>
				<textarea
					className="wf-textarea"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					rows={3}
				/>
			</label>

			<label className="wf-field wf-field-row">
				<input
					type="checkbox"
					checked={enabled}
					onChange={(e) => setEnabled(e.target.checked)}
				/>
				<div className="wf-field-label">Enabled</div>
			</label>

			<label className="wf-field">
				<div className="wf-field-label">Config (JSON)</div>
				<textarea
					className="wf-textarea wf-textarea-code"
					value={configText}
					onChange={(e) => {
						setConfigText(e.target.value);
						setConfigError(null);
					}}
					rows={10}
				/>
				{configError && <div className="wf-field-error">{configError}</div>}
			</label>

			<div className="wf-inspector-actions">
				<button
					className="wf-btn wf-btn-primary"
					onClick={() => {
						let parsed: Record<string, unknown> | undefined;
						try {
							parsed = JSON.parse(configText || "{}") as Record<
								string,
								unknown
							>;
						} catch (err) {
							setConfigError(`Invalid JSON: ${String(err)}`);
							return;
						}
						onSave(selectedNode.id, {
							label: label.trim() || selectedNode.data.label,
							description: description.trim(),
							enabled,
							config: parsed,
						});
					}}
				>
					Save
				</button>
				<button
					className="wf-btn wf-btn-danger"
					onClick={() => onDelete(selectedNode.id)}
				>
					Delete Node
				</button>
			</div>
		</div>
	);
}

function GraphHost({
	workflow,
	selectedNodeId,
	nodeStatuses,
	onSelectNode,
	onMoveNode,
	onConnect,
	onAddNode,
	nodeTypes,
}: {
	workflow: WorkflowRow;
	selectedNodeId: string | null;
	nodeStatuses: Record<string, string>;
	onSelectNode: (id: string | null) => void;
	onMoveNode: (id: string, x: number, y: number) => void;
	onConnect: (connection: {
		sourceId: string;
		targetId: string;
		sourceHandle?: string;
		targetHandle?: string;
	}) => void;
	onAddNode: (nodeType: string, x: number, y: number) => void;
	nodeTypes: Array<{ value: string; label: string }>;
}) {
	const version = workflow.updated_at ?? workflow.id;
	const [nodes, setNodes, onNodesChange] = useNodesState([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState([]);

	useEffect(() => {
		setNodes(
			workflow.nodes.map((n) => ({
				id: n.id,
				type: "default",
				position: n.position,
				data: {
					...n.data,
					executionStatus: nodeStatuses[n.id],
				},
				selected: n.id === selectedNodeId,
			})) as Node[],
		);
		setEdges(
			workflow.edges.map((e) => ({
				id: e.id,
				source: e.source,
				target: e.target,
				sourceHandle: e.sourceHandle,
				targetHandle: e.targetHandle,
				type: "smoothstep",
				animated: true,
				markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
				style: { strokeWidth: 2 },
			})) as Edge[],
		);
	}, [version]);

	useEffect(() => {
		setNodes((prev) =>
			prev.map((n) => ({
				...n,
				selected: n.id === selectedNodeId,
				data: { ...n.data, executionStatus: nodeStatuses[n.id] },
			})),
		);
	}, [nodeStatuses, selectedNodeId, setNodes]);

	const onNodeClick = useCallback(
		(_: unknown, node: Node) => {
			onSelectNode(node.id);
		},
		[onSelectNode],
	);

	const onPaneClick = useCallback(() => onSelectNode(null), [onSelectNode]);

	const onNodeDragStop = useCallback(
		(_: unknown, node: Node) => {
			setNodes((prev) =>
				prev.map((n) =>
					n.id === node.id ? { ...n, position: node.position } : n,
				),
			);
			onMoveNode(node.id, node.position.x, node.position.y);
		},
		[onMoveNode, setNodes],
	);

	const onConnectFlow = useCallback(
		(connection: Connection) => {
			if (!connection.source || !connection.target) return;
			const id = `e:${connection.source}:${connection.target}:${Date.now()}`;
			setEdges((prev) => [
				...prev,
				{
					id,
					source: connection.source!,
					target: connection.target!,
					sourceHandle: connection.sourceHandle ?? undefined,
					targetHandle: connection.targetHandle ?? undefined,
					type: "smoothstep",
					animated: true,
					markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
					style: { strokeWidth: 2 },
				},
			]);
			onConnect({
				sourceId: connection.source,
				targetId: connection.target,
				sourceHandle: connection.sourceHandle ?? undefined,
				targetHandle: connection.targetHandle ?? undefined,
			});
		},
		[onConnect, setEdges],
	);

	const maxY = useMemo(
		() => workflow.nodes.reduce((m, n) => Math.max(m, n.position.y), 0),
		[workflow.nodes],
	);

	return (
		<div className="wf-graph">
			<div className="wf-graph-toolbar">
				<div className="wf-graph-toolbar-title">Graph</div>
				<div className="wf-graph-toolbar-actions">
					<select
						className="wf-select"
						defaultValue=""
						onChange={(e) => {
							const type = e.target.value;
							if (!type) return;
							onAddNode(type, 240, maxY + 120);
							e.currentTarget.value = "";
						}}
					>
						<option value="" disabled>
							Add node...
						</option>
						{nodeTypes.map((t) => (
							<option key={t.value} value={t.value}>
								{t.label}
							</option>
						))}
					</select>
				</div>
			</div>
			<div className="wf-graph-canvas">
				<ReactFlow
					nodes={nodes}
					edges={edges}
					nodeTypes={{ default: SimpleNode }}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onNodeClick={onNodeClick}
					onNodeDragStop={onNodeDragStop}
					onConnect={onConnectFlow}
					onPaneClick={onPaneClick}
					fitView
					proOptions={{ hideAttribution: true }}
				>
					<Background />
					<Controls showInteractive={false} />
				</ReactFlow>
			</div>
		</div>
	);
}

function ToastStack({
	toasts,
	onDismiss,
}: {
	toasts: UiToast[];
	onDismiss: (id: string) => void;
}) {
	return (
		<div className="wf-toasts">
			{toasts.map((t) => (
				<button
					key={t.id}
					className={`wf-toast wf-toast-${t.type}`}
					onClick={() => onDismiss(t.id)}
				>
					{t.message}
				</button>
			))}
		</div>
	);
}

export default function App() {
	const { app } = useApp({
		appInfo: { name: "Workflow Builder", version: "2.0.0" },
		onAppCreated: (newApp: McpApp) => {
			newApp.ontoolinput = () => {};
		},
	});
	useHostStyles(app);

	const enqueue = useSerialQueue();

	// ── Refs for mutable state that must NOT trigger effect restarts ──
	// Using refs prevents the dependency cascade that caused infinite
	// bootstrap loops: applyWire→bootstrap→effect→bootstrap→…
	const receiverRef = useRef<RemoteReceiver | null>(null);
	if (!receiverRef.current) receiverRef.current = new RemoteReceiver();
	const seqRef = useRef(0);

	// Bump this counter to force a re-render when the receiver ref changes
	const [, forceRender] = useReducer((c: number) => c + 1, 0);

	const [connected, setConnected] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Keep a ref to the latest callTool so effects don't depend on `app`.
	const callToolRef = useRef<(name: string, args?: unknown) => Promise<any>>(
		null!,
	);
	callToolRef.current = useCallback(
		async (name: string, args: unknown = {}) => {
			if (!app) throw new Error("App not connected");
			const result = await app.callServerTool({
				name,
				arguments: args as Record<string, unknown>,
			});
			return parseToolJson(result);
		},
		[app],
	);

	// ── applyWire: stable (no deps) — reads from refs ──
	const applyWire = useCallback((wire: UiWire) => {
		if (wire.reset) {
			const next = new RemoteReceiver();
			receiverRef.current = next;
			try {
				next.connection.mutate(wire.mutations);
			} catch {
				// Mutation application can fail if IDs are stale; receiver is fresh so safe to ignore
			}
			seqRef.current = wire.seq;
			forceRender(); // new receiver → RemoteRootRenderer needs re-render
		} else {
			try {
				receiverRef.current!.connection.mutate(wire.mutations);
			} catch {
				// Stale element IDs from a session reset — force a reset on next poll
				// by setting seq to 0 so the server returns all mutations with reset: true
				seqRef.current = 0;
				return;
			}
			seqRef.current = wire.seq;
			// No forceRender needed — receiver subscriptions handle re-renders
		}
	}, []);

	// ── Bootstrap: runs once when app connects ──
	useEffect(() => {
		if (!app) return;
		let cancelled = false;
		enqueue(async () => {
			if (cancelled) return;
			try {
				const data = (await callToolRef.current("ui_bootstrap")) as UiWire;
				applyWire({
					seq: data.seq,
					mutations: data.mutations ?? [],
					reset: true,
				});
				setConnected(true);
				setError(null);
			} catch (err) {
				setError(String(err));
			}
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- enqueue & applyWire are stable
	}, [app]);

	// ── Poll for updates — stable interval, no restarts ──
	useEffect(() => {
		if (!app || !connected) return;
		let cancelled = false;

		const tick = () =>
			enqueue(async () => {
				if (cancelled) return;
				try {
					const data = (await callToolRef.current("ui_updates", {
						since: seqRef.current,
					})) as UiWire;
					if (data?.mutations?.length || data?.reset) applyWire(data);
					setError(null);
				} catch (err) {
					setError(String(err));
				}
			});

		const id = setInterval(tick, 500);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- enqueue & applyWire are stable
	}, [app, connected]);

	// ── sendEvent: stable (deps are all stable refs/callbacks) ──
	const sendEvent = useCallback(
		async (event: UiEvent) => {
			await enqueue(async () => {
				try {
					const result = await callToolRef.current("ui_event", event as any);
					if (!result) return;
					if (result.ok === false) {
						// Session may have been reset by another widget; force re-sync
						seqRef.current = 0;
						return;
					}
					applyWire({
						seq: result.seq,
						mutations: result.mutations ?? [],
					});
				} catch {
					// Force re-sync on next poll
					seqRef.current = 0;
				}
			});
		},
		[enqueue, applyWire],
	);

	const uiClient = useMemo(() => ({ sendEvent }), [sendEvent]);

	const components = useMemo(
		() =>
			new Map<string, any>([
				["wf-app", WfAppHost],
				["remote-fragment", RemoteFragmentRenderer],
			]),
		[],
	);

	const receiver = receiverRef.current!;

	if (!app) {
		return (
			<div className="wf-boot">
				<div className="wf-boot-title">Connecting...</div>
			</div>
		);
	}

	return (
		<UiClientContext.Provider value={uiClient}>
			<div className="wf-root">
				{error && <div className="wf-banner wf-banner-error">{error}</div>}
				<RemoteRootRenderer receiver={receiver} components={components} />
			</div>
		</UiClientContext.Provider>
	);
}
