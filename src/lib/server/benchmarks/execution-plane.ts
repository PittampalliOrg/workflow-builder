import { env } from "$env/dynamic/private";

export type BenchmarkExecutionBackend = "dapr-kueue" | "legacy-dapr" | "host";
export type BenchmarkExecutionClass = string;

export type HostExecutionPlaneSubmitInput = {
	runId: string;
	instanceId: string;
	workflowId: string;
	workflowExecutionId: string;
	executionClass: BenchmarkExecutionClass;
	timeoutSeconds: number;
	workflow: unknown;
	triggerData: Record<string, unknown>;
	inferenceEnvironment: Record<string, unknown>;
	mlflowContext?: Record<string, unknown> | null;
	traceContext?: Record<string, string | undefined> | null;
};

export type HostExecutionPlaneSubmitResult = {
	hostExecutionId: string;
	jobName: string | null;
	status: string | null;
	raw: Record<string, unknown>;
};

function configValue(name: string): string | undefined {
	return env[name] ?? process.env[name];
}

function normalizedConfigValue(name: string): string {
	return configValue(name)?.trim() ?? "";
}

export function benchmarkExecutionBackend(): BenchmarkExecutionBackend {
	return normalizeBenchmarkExecutionBackend(
		normalizedConfigValue("BENCHMARK_EXECUTION_BACKEND"),
	);
}

export function normalizeBenchmarkExecutionBackend(
	value: unknown,
): BenchmarkExecutionBackend {
	const raw = normalizedConfigValue("BENCHMARK_EXECUTION_BACKEND")
		.toLowerCase()
		.replace(/_/g, "-");
	if (typeof value === "string" && value.trim()) {
		const requested = value.trim().toLowerCase().replace(/_/g, "-");
		if (
			requested === "host" ||
			requested === "host-execution" ||
			requested === "host-execution-plane"
		) {
			return "host";
		}
		if (
			requested === "dapr-kueue" ||
			requested === "kueue-dapr" ||
			requested === "kueue-agent-hosts" ||
			requested === "agent-host-kueue"
		) {
			return "dapr-kueue";
		}
		if (requested === "legacy" || requested === "legacy-dapr") return "legacy-dapr";
		return "dapr-kueue";
	}
	if (raw === "legacy" || raw === "legacy-dapr") return "legacy-dapr";
	if (raw === "host" || raw === "host-execution" || raw === "host-execution-plane") {
		return "host";
	}
	return "dapr-kueue";
}

export function benchmarkExecutionClass(): BenchmarkExecutionClass {
	return normalizeBenchmarkExecutionClass(
		normalizedConfigValue("BENCHMARK_EXECUTION_CLASS"),
	);
}

export function normalizeBenchmarkExecutionClass(
	value: unknown,
): BenchmarkExecutionClass {
	if (typeof value !== "string" || !value.trim()) return "benchmark-fast";
	const raw = value
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
	return /^[a-z0-9][a-z0-9-]{0,62}$/.test(raw) ? raw : "benchmark-fast";
}

export function hostExecutionPlaneUrl(): string | null {
	const url =
		normalizedConfigValue("SANDBOX_EXECUTION_API_URL") ||
		normalizedConfigValue("HOST_EXECUTION_API_URL");
	return url ? url.replace(/\/+$/, "") : null;
}

function hostExecutionPlaneToken(): string | null {
	return (
		normalizedConfigValue("SANDBOX_EXECUTION_API_TOKEN") ||
		normalizedConfigValue("HOST_EXECUTION_API_TOKEN") ||
		normalizedConfigValue("INTERNAL_API_TOKEN") ||
		null
	);
}

export function isHostExecutionIr(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const dispatch = (value as Record<string, unknown>).dispatch;
	return (
		!!dispatch &&
		typeof dispatch === "object" &&
		!Array.isArray(dispatch) &&
		(dispatch as Record<string, unknown>).backend === "host"
	);
}

export async function submitBenchmarkInstanceToHostExecutionPlane(
	input: HostExecutionPlaneSubmitInput,
): Promise<HostExecutionPlaneSubmitResult> {
	const baseUrl = hostExecutionPlaneUrl();
	if (!baseUrl) {
		throw new Error(
			"SANDBOX_EXECUTION_API_URL or HOST_EXECUTION_API_URL is required when BENCHMARK_EXECUTION_BACKEND=host",
		);
	}
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		for (const key of ["traceparent", "tracestate", "baggage"] as const) {
			const value = input.traceContext?.[key]?.trim();
			if (value) headers[key] = value;
		}
	const token = hostExecutionPlaneToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`${baseUrl}/api/v1/executions`, {
		method: "POST",
		headers,
			body: JSON.stringify({
			kind: "swebench-instance",
			runId: input.runId,
			instanceId: input.instanceId,
			workflowId: input.workflowId,
			workflowExecutionId: input.workflowExecutionId,
			executionClass: input.executionClass,
			timeoutSeconds: input.timeoutSeconds,
			workflow: input.workflow,
				triggerData: input.triggerData,
				mlflowContext: input.mlflowContext ?? null,
				traceContext: input.traceContext ?? null,
				inferenceEnvironment: input.inferenceEnvironment,
			callback: {
				path: `/api/internal/benchmarks/runs/${encodeURIComponent(input.runId)}/instances/${encodeURIComponent(input.instanceId)}/execution`,
			},
		}),
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(
			typeof body.error === "string"
				? body.error
				: typeof body.detail === "string"
					? body.detail
					: `host execution plane returned ${res.status}`,
		);
	}
	const hostExecutionId =
		typeof body.executionId === "string" && body.executionId.trim()
			? body.executionId.trim()
			: typeof body.id === "string" && body.id.trim()
				? body.id.trim()
				: input.workflowExecutionId;
	return {
		hostExecutionId,
		jobName:
			typeof body.jobName === "string" && body.jobName.trim()
				? body.jobName.trim()
				: null,
		status:
			typeof body.status === "string" && body.status.trim()
				? body.status.trim()
				: null,
		raw: body,
	};
}
