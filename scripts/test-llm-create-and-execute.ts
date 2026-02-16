/**
 * End-to-end smoke test:
 * - Sign in
 * - Create a blank workflow
 * - Use AI chat stream (validated mode) to generate nodes/edges
 * - Persist the workflow
 * - Execute it and poll status
 */

type Operation =
	| { type: "operation"; operation: any }
	| { type: "error"; error: string }
	| { type: "complete" };

type WorkflowData = {
	name?: string;
	description?: string;
	nodes: any[];
	edges: any[];
};

function applyOperation(op: any, state: WorkflowData): void {
	switch (op?.op) {
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

async function json<T>(res: Response): Promise<T> {
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`Expected JSON but got: ${text.slice(0, 300)}`);
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

async function main() {
	const baseUrl = process.env.WB_BASE_URL || "http://127.0.0.1:18000";
	const email = process.env.WB_EMAIL || "admin@example.com";
	const password = process.env.WB_PASSWORD || "developer";
	const prompt =
		process.argv.slice(2).join(" ").trim() ||
		[
			"Create a workflow that:",
			"- starts with a manual trigger",
			"- makes an HTTP GET request to http://workflow-orchestrator.workflow-builder.svc.cluster.local:8080/healthz",
			"- then sets state key health_status to the HTTP status code (reference {{@health_check:Health Check GET.status}})",
		].join("\n");

	// eslint-disable-next-line no-console
	console.log(`[smoke] baseUrl=${baseUrl}`);

	// 1) Sign in
	// eslint-disable-next-line no-console
	console.log("[smoke] signing in...");
	const signInRes = await fetch(`${baseUrl}/api/v1/auth/sign-in`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	if (!signInRes.ok) {
		throw new Error(`Sign-in failed: HTTP ${signInRes.status}`);
	}
	const signIn = await json<{ accessToken: string }>(signInRes);
	const authz = `Bearer ${signIn.accessToken}`;

	// 2) Create blank workflow
	// eslint-disable-next-line no-console
	console.log("[smoke] creating workflow...");
	const createRes = await fetch(`${baseUrl}/api/workflows/create`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: authz,
		},
		body: JSON.stringify({
			name: `LLM Smoke Test ${new Date().toISOString()}`,
			description: "Created by scripts/test-llm-create-and-execute.ts",
			nodes: [],
			edges: [],
		}),
	});
	if (!createRes.ok) {
		const payload = await createRes.text().catch(() => "");
		throw new Error(
			`Workflow create failed: HTTP ${createRes.status} ${payload.slice(0, 300)}`,
		);
	}
	const created = await json<{ id: string }>(createRes);
	const workflowId = created.id;
	// eslint-disable-next-line no-console
	console.log(`[smoke] workflowId=${workflowId}`);

	// 3) Generate via AI chat stream (do NOT pass existingWorkflow so blank workflows use WorkflowSpec path)
	// eslint-disable-next-line no-console
	console.log("[smoke] generating via AI stream (validated)...");
	const streamRes = await fetch(
		`${baseUrl}/api/workflows/${workflowId}/ai-chat/stream`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: authz,
			},
			body: JSON.stringify({ message: prompt, mode: "validated" }),
		},
	);
	if (!streamRes.ok || !streamRes.body) {
		const payload = await streamRes.text().catch(() => "");
		throw new Error(
			`AI stream failed: HTTP ${streamRes.status} ${payload.slice(0, 300)}`,
		);
	}

	const state: WorkflowData = { nodes: [], edges: [] };
	const reader = streamRes.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() || "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const msg = JSON.parse(trimmed) as Operation;
			if (msg.type === "error") {
				throw new Error(msg.error || "AI stream error");
			}
			if (msg.type === "operation") {
				applyOperation((msg as any).operation, state);
			}
		}
	}
	reader.releaseLock();
	// eslint-disable-next-line no-console
	console.log(
		`[smoke] generated nodes=${state.nodes.length} edges=${state.edges.length}`,
	);

	// 4) Persist workflow
	// eslint-disable-next-line no-console
	console.log("[smoke] persisting workflow...");
	const updateRes = await fetch(`${baseUrl}/api/workflows/${workflowId}`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Authorization: authz,
		},
		body: JSON.stringify({
			name: state.name,
			description: state.description,
			nodes: state.nodes,
			edges: state.edges,
		}),
	});
	if (!updateRes.ok) {
		const payload = await updateRes.text().catch(() => "");
		throw new Error(
			`Workflow update failed: HTTP ${updateRes.status} ${payload.slice(0, 300)}`,
		);
	}

	// 5) Execute
	// eslint-disable-next-line no-console
	console.log("[smoke] executing workflow...");
	const execRes = await fetch(`${baseUrl}/api/workflow/${workflowId}/execute`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: authz,
		},
		body: JSON.stringify({ input: {} }),
	});
	if (!execRes.ok) {
		const payload = await execRes.text().catch(() => "");
		throw new Error(
			`Execute failed: HTTP ${execRes.status} ${payload.slice(0, 300)}`,
		);
	}
	const exec = await json<{ executionId: string }>(execRes);
	// eslint-disable-next-line no-console
	console.log(`[smoke] executionId=${exec.executionId}`);

	// 6) Poll status
	let last: any = null;
	for (let i = 0; i < 60; i += 1) {
		// Prefer Dapr runtime status endpoint. The legacy execution status route only
		// reads DB state and may remain "running" until Dapr status is polled.
		const statusRes = await fetch(
			`${baseUrl}/api/dapr/workflows/${exec.executionId}/status`,
			{ headers: { Authorization: authz } },
		);
		if (!statusRes.ok) {
			throw new Error(`Status failed: HTTP ${statusRes.status}`);
		}
		last = await json<any>(statusRes);
		const status = String(last?.status || "");
		// eslint-disable-next-line no-console
		console.log(`[smoke] status=${status}`);
		if (status === "success" || status === "error") break;
		await sleep(1000);
	}

	if (String(last?.status) !== "success") {
		// Try to pull logs for a better failure message.
		const logsRes = await fetch(
			`${baseUrl}/api/workflows/executions/${exec.executionId}/logs`,
			{ headers: { Authorization: authz } },
		);
		const logsText = await logsRes.text().catch(() => "");
		throw new Error(
			`Execution did not succeed. Status=${String(last?.status)}. Logs: ${logsText.slice(0, 1200)}`,
		);
	}

	// eslint-disable-next-line no-console
	console.log(
		JSON.stringify(
			{ ok: true, workflowId, executionId: exec.executionId, status: last },
			null,
			2,
		),
	);
}

main().catch((err) => {
	// eslint-disable-next-line no-console
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
