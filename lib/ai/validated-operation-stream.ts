import { compileWorkflowSpecToGraph } from "@/lib/workflow-spec/compile";
import { loadInstalledWorkflowSpecCatalog } from "@/lib/workflow-spec/catalog-server";
import { decompileGraphToWorkflowSpec } from "@/lib/workflow-spec/decompile";
import { lintWorkflowSpec, type LintIssue } from "@/lib/workflow-spec/lint";
import { generateWorkflowSpecWithRepairs } from "@/lib/ai/workflow-spec-generation";
import { buildRelevantActionListPrompt } from "@/lib/ai/action-list-prompt";

export type Operation = {
	op:
		| "setName"
		| "setDescription"
		| "addNode"
		| "addEdge"
		| "removeNode"
		| "removeEdge"
		| "updateNode";
	name?: string;
	description?: string;
	node?: any;
	edge?: any;
	nodeId?: string;
	edgeId?: string;
	updates?: {
		position?: { x: number; y: number };
		data?: any;
	};
};

type StreamMessage =
	| { type: "operation"; operation: Operation }
	| { type: "complete" }
	| { type: "error"; error: string };

type WorkflowState = {
	name?: string;
	description?: string;
	nodes: any[];
	edges: any[];
};

function encodeNdjson(encoder: TextEncoder, message: object): Uint8Array {
	return encoder.encode(`${JSON.stringify(message)}\n`);
}

function applyOperationToState(op: Operation, state: WorkflowState): void {
	switch (op.op) {
		case "setName":
			if (typeof op.name === "string" && op.name.trim()) state.name = op.name;
			return;
		case "setDescription":
			if (typeof op.description === "string")
				state.description = op.description;
			return;
		case "addNode":
			if (op.node) state.nodes = [...state.nodes, op.node];
			return;
		case "addEdge":
			if (op.edge) state.edges = [...state.edges, op.edge];
			return;
		case "removeNode":
			if (!op.nodeId) return;
			state.nodes = state.nodes.filter((n) => n?.id !== op.nodeId);
			state.edges = state.edges.filter(
				(e) => e?.source !== op.nodeId && e?.target !== op.nodeId,
			);
			return;
		case "removeEdge":
			if (!op.edgeId) return;
			state.edges = state.edges.filter((e) => e?.id !== op.edgeId);
			return;
		case "updateNode":
			if (!op.nodeId || !op.updates) return;
			state.nodes = state.nodes.map((n) => {
				if (n?.id !== op.nodeId) return n;
				return {
					...n,
					...(op.updates?.position ? { position: op.updates.position } : {}),
					...(op.updates?.data
						? { data: { ...(n.data || {}), ...op.updates.data } }
						: {}),
				};
			});
			return;
		default:
			return;
	}
}

function parseStreamLine(line: string): StreamMessage | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed) as StreamMessage;
	} catch {
		return null;
	}
}

function nodeKind(node: any): string {
	return String(node?.data?.type || node?.type || "");
}

function getNodeConfig(node: any): Record<string, unknown> {
	const cfg = node?.data?.config;
	return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
}

function isGraphRepresentableByWorkflowSpec(state: WorkflowState): boolean {
	// If the workflow has legacy/unknown node kinds that WorkflowSpec can't represent,
	// we skip validation/repair to avoid destroying semantic nodes on replacement.
	const supportedKinds = new Set([
		"trigger",
		"action",
		"approval-gate",
		"timer",
		"if-else",
		"loop-until",
		"set-state",
		"transform",
		"publish-event",
		"note",
	]);

	for (const n of state.nodes) {
		const kind = nodeKind(n);
		if (!supportedKinds.has(kind)) {
			return false;
		}
	}

	return true;
}

function collectHardGraphErrors(state: WorkflowState): LintIssue[] {
	const errors: LintIssue[] = [];

	// Must have exactly one trigger node.
	const triggers = state.nodes.filter((n) => nodeKind(n) === "trigger");
	if (triggers.length !== 1) {
		errors.push({
			code: "INVALID_TRIGGER_COUNT",
			message: `Expected exactly 1 trigger node, found ${triggers.length}.`,
			path: "/nodes",
		});
	}

	// Basic completeness checks for trigger/action nodes (hard errors).
	for (const n of state.nodes) {
		const kind = nodeKind(n);
		const cfg = getNodeConfig(n);
		if (kind === "trigger") {
			if (!cfg.triggerType) {
				errors.push({
					code: "INCOMPLETE_TRIGGER",
					message: `Trigger node is missing config.triggerType.`,
					path: `/nodes/${String(n?.id || "")}/config/triggerType`,
				});
			}
		}
		if (kind === "action") {
			const actionType =
				typeof cfg.actionType === "string" ? cfg.actionType.trim() : "";
			if (!actionType) {
				errors.push({
					code: "INCOMPLETE_ACTION",
					message: `Action node is missing config.actionType.`,
					path: `/nodes/${String(n?.id || "")}/config/actionType`,
				});
			}
		}
	}

	return errors;
}

function buildReplaceOps(input: {
	current: WorkflowState;
	next: { name: string; description?: string; nodes: any[]; edges: any[] };
}): Operation[] {
	const ops: Operation[] = [];

	// Remove edges first.
	const edgeIds = input.current.edges
		.map((e) => String(e?.id || ""))
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
	for (const id of edgeIds) {
		ops.push({ op: "removeEdge", edgeId: id });
	}

	// Remove nodes.
	const nodeIds = input.current.nodes
		.map((n) => String(n?.id || ""))
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
	for (const id of nodeIds) {
		ops.push({ op: "removeNode", nodeId: id });
	}

	ops.push({ op: "setName", name: input.next.name });
	if (typeof input.next.description === "string") {
		ops.push({ op: "setDescription", description: input.next.description });
	}

	for (const n of input.next.nodes) ops.push({ op: "addNode", node: n });
	for (const e of input.next.edges) ops.push({ op: "addEdge", edge: e });

	return ops;
}

export async function createValidatedOperationStream(input: {
	baseStream: ReadableStream<Uint8Array>;
	prompt: string;
	existingWorkflow?: {
		name?: string;
		description?: string;
		nodes?: any[];
		edges?: any[];
	};
	mode: "validated" | "classic";
	onOperation?: (op: Operation) => void;
	onError?: (message: string) => void;
}): Promise<ReadableStream<Uint8Array>> {
	const encoder = new TextEncoder();

	const state: WorkflowState = {
		name: input.existingWorkflow?.name,
		description: input.existingWorkflow?.description,
		nodes: input.existingWorkflow?.nodes
			? [...input.existingWorkflow.nodes]
			: [],
		edges: input.existingWorkflow?.edges
			? [...input.existingWorkflow.edges]
			: [],
	};

	return new ReadableStream({
		async start(controller) {
			const reader = input.baseStream.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let seenError: string | null = null;

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					// Forward raw bytes immediately for real-time UX.
					if (value) controller.enqueue(value);

					// Parse operations to keep an in-memory view.
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						const msg = parseStreamLine(line);
						if (!msg) continue;
						if (msg.type === "operation") {
							applyOperationToState(msg.operation, state);
							input.onOperation?.(msg.operation);
						} else if (msg.type === "error") {
							seenError =
								typeof msg.error === "string" ? msg.error : "Unknown error";
							input.onError?.(seenError);
						}
					}
				}

				// Drain last buffered line (best effort).
				const last = parseStreamLine(buffer);
				if (last?.type === "operation") {
					applyOperationToState(last.operation, state);
					input.onOperation?.(last.operation);
				} else if (last?.type === "error") {
					seenError =
						typeof last.error === "string" ? last.error : "Unknown error";
					input.onError?.(seenError);
				}

				// If the base stream failed, don't attempt validation/repair.
				if (seenError) {
					return;
				}

				if (input.mode === "classic") {
					return;
				}

				// Skip destructive replacement if the graph includes node kinds we can't round-trip via WorkflowSpec.
				if (!isGraphRepresentableByWorkflowSpec(state)) {
					return;
				}

				const hardErrors = collectHardGraphErrors(state);

				const name = state.name || "Untitled Workflow";
				const spec = decompileGraphToWorkflowSpec({
					name,
					description: state.description,
					nodes: state.nodes as any,
					edges: state.edges as any,
				});

				const catalog = await loadInstalledWorkflowSpecCatalog();
				const linted = lintWorkflowSpec(spec, {
					catalog,
					unknownActionType: "error",
				});

				if (
					linted.result.errors.length === 0 &&
					hardErrors.length === 0 &&
					linted.spec
				) {
					return;
				}

				const combinedErrors = [...hardErrors, ...linted.result.errors];
				const actionListPrompt = buildRelevantActionListPrompt({
					catalog,
					prompt: `${input.prompt}\n${combinedErrors.map((e) => `${e.code} ${e.message}`).join("\n")}`,
					limit: 60,
				});

				const repairPrompt = `You are fixing a workflow to be valid.

User request:
${input.prompt}

Current workflow spec JSON:
${JSON.stringify(spec, null, 2)}

Validation errors:
${combinedErrors.map((e) => `- ${e.path}: ${e.message} (${e.code})`).join("\n")}

Return a complete corrected workflow spec JSON object. Preserve step ids where possible.`;

				const repaired = await generateWorkflowSpecWithRepairs({
					prompt: repairPrompt,
					actionListPrompt,
					maxAttempts: 3,
				});

				const compiled = compileWorkflowSpecToGraph(repaired.spec);
				const replaceOps = buildReplaceOps({
					current: state,
					next: {
						name: repaired.spec.name,
						description: repaired.spec.description,
						nodes: compiled.nodes,
						edges: compiled.edges,
					},
				});

				for (const op of replaceOps) {
					applyOperationToState(op, state);
					input.onOperation?.(op);
					controller.enqueue(
						encodeNdjson(encoder, { type: "operation", operation: op }),
					);
				}

				controller.enqueue(encodeNdjson(encoder, { type: "complete" }));
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Validation failed";
				input.onError?.(message);
				controller.enqueue(
					encodeNdjson(encoder, {
						type: "error",
						error: message,
					}),
				);
			} finally {
				reader.releaseLock();
				controller.close();
			}
		},
	});
}
