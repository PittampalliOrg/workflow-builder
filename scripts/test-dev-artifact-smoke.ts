type WorkflowNode = {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: {
		label: string;
		description: string;
		type: string;
		config: Record<string, string>;
		status: string;
	};
};

type WorkflowEdge = {
	id: string;
	source: string;
	target: string;
	type: string;
};

type SignInResponse = {
	accessToken: string;
};

type WorkflowCreateResponse = {
	id: string;
};

type ExecutionStartResponse = {
	executionId: string;
};

type WorkflowStatusResponse = {
	executionId: string;
	daprInstanceId: string | null;
	status: string;
	daprStatus?: string | null;
	workflowVersion?: string | null;
	workflowNameVersioned?: string | null;
	phase?: string | null;
	progress?: number | null;
	message?: string | null;
	currentNodeName?: string | null;
	output?: unknown;
	error?: string | null;
};

type ExecutionChangeFile = {
	path: string;
	status: string;
};

type ExecutionChangesResponse = {
	success: boolean;
	executionId: string;
	count: number;
	changes: Array<{
		changeSetId: string;
		storageRef: string;
		files: ExecutionChangeFile[];
	}>;
};

type ExecutionPatchResponse = {
	success: boolean;
	executionId: string;
	patch: string;
};

function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 8);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function json<T>(response: Response): Promise<T> {
	const text = await response.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(
			`Expected JSON from ${response.url} (${response.status}): ${text.slice(0, 800)}`,
		);
	}
}

async function apiJson<T>(
	url: string,
	init?: RequestInit,
): Promise<{ response: Response; data: T }> {
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${await response.text()}`);
	}
	return { response, data: await json<T>(response) };
}

function buildWorkflow(suffix: string): {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
} {
	const triggerId = `trigger_${suffix}`;
	const profileId = `profile_${suffix}`;
	const commandId = `command_${suffix}`;

	return {
		nodes: [
			{
				id: triggerId,
				type: "trigger",
				position: { x: 0, y: 0 },
				data: {
					label: "Manual Trigger",
					description: "",
					type: "trigger",
					config: { triggerType: "Manual" },
					status: "idle",
				},
			},
			{
				id: profileId,
				type: "action",
				position: { x: 260, y: 0 },
				data: {
					label: "Workspace Profile",
					description: "Create a sandboxed workspace for this execution",
					type: "action",
					config: {
						actionType: "workspace/profile",
						name: `artifact-smoke-${suffix}`,
						enabledTools:
							'["read_file","write_file","edit_file","list_files","delete_file","mkdir","file_stat","execute_command"]',
						requireReadBeforeWrite: "false",
						commandTimeoutMs: "120000",
					},
					status: "idle",
				},
			},
			{
				id: commandId,
				type: "action",
				position: { x: 520, y: 0 },
				data: {
					label: "Create Files",
					description: "Write files so change artifacts are generated",
					type: "action",
					config: {
						actionType: "workspace/command",
						workspaceRef: `{{@${profileId}:Workspace Profile.workspaceRef}}`,
						timeoutMs: "120000",
						command: [
							"set -euo pipefail",
							"mkdir -p artifacts",
							"printf '# Artifact Smoke\\n' > artifacts/generated.md",
							`printf '{"ok":true,"source":"dev-smoke","suffix":"${suffix}"}\\n' > artifacts/result.json`,
							"find artifacts -maxdepth 1 -type f | sort",
						].join(" && "),
					},
					status: "idle",
				},
			},
		],
		edges: [
			{
				id: `edge_profile_${suffix}`,
				source: triggerId,
				target: profileId,
				type: "default",
			},
			{
				id: `edge_command_${suffix}`,
				source: profileId,
				target: commandId,
				type: "default",
			},
		],
	};
}

async function main(): Promise<void> {
	const baseUrl = process.env.WB_BASE_URL || "http://127.0.0.1:18000";
	const email = process.env.WB_EMAIL || "admin@example.com";
	const password = process.env.WB_PASSWORD || "developer";
	const suffix = randomSuffix();
	const { nodes, edges } = buildWorkflow(suffix);

	console.log(`[artifact-smoke] baseUrl=${baseUrl}`);

	const signIn = await apiJson<SignInResponse>(
		`${baseUrl}/api/v1/auth/sign-in`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password }),
		},
	);
	const authz = `Bearer ${signIn.data.accessToken}`;
	console.log("[artifact-smoke] signed in");

	const created = await apiJson<WorkflowCreateResponse>(
		`${baseUrl}/api/workflows/create`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: authz,
			},
			body: JSON.stringify({
				name: `Artifact Smoke ${new Date().toISOString()}`,
				description:
					"Minimal workflow that writes files and emits change artifacts",
				nodes,
				edges,
			}),
		},
	);
	const workflowId = created.data.id;
	console.log(`[artifact-smoke] workflowId=${workflowId}`);

	const execution = await apiJson<ExecutionStartResponse>(
		`${baseUrl}/api/workflow/${workflowId}/execute`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: authz,
			},
			body: JSON.stringify({ input: {} }),
		},
	);
	const executionId = execution.data.executionId;
	console.log(`[artifact-smoke] executionId=${executionId}`);

	let finalStatus: WorkflowStatusResponse | null = null;
	for (let attempt = 1; attempt <= 90; attempt += 1) {
		const status = await apiJson<WorkflowStatusResponse>(
			`${baseUrl}/api/dapr/workflows/${executionId}/status`,
			{
				headers: { authorization: authz },
			},
		);
		finalStatus = status.data;
		console.log(
			`[artifact-smoke] poll=${attempt} status=${finalStatus.status} current=${finalStatus.currentNodeName || ""}`,
		);
		if (finalStatus.status === "success" || finalStatus.status === "error") {
			break;
		}
		await sleep(2000);
	}

	if (!finalStatus) {
		throw new Error("No final workflow status received");
	}

	console.log("[artifact-smoke] final status");
	console.log(JSON.stringify(finalStatus, null, 2));

	if (finalStatus.status !== "success") {
		throw new Error(
			`Workflow did not succeed: status=${finalStatus.status} error=${finalStatus.error || "unknown"}`,
		);
	}

	const changes = await apiJson<ExecutionChangesResponse>(
		`${baseUrl}/api/workflows/executions/${executionId}/changes`,
		{
			headers: { authorization: authz },
		},
	);
	console.log("[artifact-smoke] changes");
	console.log(JSON.stringify(changes.data, null, 2));

	const patch = await apiJson<ExecutionPatchResponse>(
		`${baseUrl}/api/workflows/executions/${executionId}/patch`,
		{
			headers: { authorization: authz },
		},
	);
	console.log("[artifact-smoke] patch");
	console.log(JSON.stringify(patch.data, null, 2));

	if (changes.data.count < 1) {
		throw new Error(
			`Expected at least one change set, got ${changes.data.count}`,
		);
	}

	if (
		!patch.data.patch.includes("artifacts/generated.md") ||
		!patch.data.patch.includes("artifacts/result.json")
	) {
		throw new Error("Expected patch to include generated artifact files");
	}

	console.log(
		`[artifact-smoke] runUi=${baseUrl}/workflows/${workflowId}/runs/${executionId}?tab=changes`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
