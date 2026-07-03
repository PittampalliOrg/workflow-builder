import type {
	getBenchmarkLaunchCapacityDiagnostics,
	getBenchmarkRunCapacityDiagnostics,
} from "$lib/server/benchmarks/capacity-diagnostics";

export type BenchmarkCapacityDiagnostics = Awaited<
	ReturnType<typeof getBenchmarkLaunchCapacityDiagnostics>
>;

export type BenchmarkRunCapacityDiagnostics = NonNullable<
	Awaited<ReturnType<typeof getBenchmarkRunCapacityDiagnostics>>
>;

export type BenchmarkLaunchCapacityInput = {
	projectId: string;
	agentId: string;
	agentVersion?: number;
	instanceIds?: unknown;
	instanceCount?: unknown;
	requestedConcurrency?: unknown;
	evaluationConcurrency?: unknown;
	modelNameOrPath?: string | null;
	modelConfigLabel?: string | null;
	executionBackend?: string | null;
};

export type BenchmarkCapacityDiagnosticsPort = {
	inspectLaunchCapacity(
		input: BenchmarkLaunchCapacityInput,
	): Promise<
		| { status: "ok"; diagnostics: BenchmarkCapacityDiagnostics }
		| { status: "validation_error"; message: string }
	>;
	getRunCapacity(
		projectId: string,
		runId: string,
	): Promise<BenchmarkRunCapacityDiagnostics | null>;
};

export type BenchmarkCapacityRouteResult =
	| { status: "ok"; body: { diagnostics: BenchmarkCapacityDiagnostics } }
	| { status: "error"; httpStatus: 400 | 404; message?: string; body?: Record<string, unknown> };

export class ApplicationBenchmarkCapacityDiagnosticsService {
	constructor(private readonly capacity: BenchmarkCapacityDiagnosticsPort) {}

	async inspectLaunchCapacity(input: {
		projectId?: string | null;
		body: unknown;
	}): Promise<BenchmarkCapacityRouteResult> {
		if (!input.projectId) {
			return {
				status: "error",
				httpStatus: 400,
				message: "No active workspace — cannot inspect benchmark capacity",
			};
		}

		const body = asRecord(input.body);
		const result = await this.capacity.inspectLaunchCapacity({
			projectId: input.projectId,
			agentId: String(body.agentId ?? ""),
			agentVersion: parseOptionalInteger(body.agentVersion),
			instanceIds: body.instanceIds,
			instanceCount: body.instanceCount,
			requestedConcurrency:
				parseOptionalInteger(body.requestedConcurrency) ?? body.concurrency,
			evaluationConcurrency: parseOptionalInteger(body.evaluationConcurrency),
			modelNameOrPath:
				typeof body.modelNameOrPath === "string" ? body.modelNameOrPath : null,
			modelConfigLabel:
				typeof body.modelConfigLabel === "string" ? body.modelConfigLabel : null,
			executionBackend:
				typeof body.executionBackend === "string" ? body.executionBackend : null,
		});

		if (result.status === "validation_error") {
			return {
				status: "error",
				httpStatus: 400,
				body: { message: result.message },
			};
		}

		return { status: "ok", body: { diagnostics: result.diagnostics } };
	}

	async getRunCapacity(input: {
		projectId?: string | null;
		runId: string;
	}): Promise<BenchmarkCapacityRouteResult> {
		if (!input.projectId) return benchmarkRunNotFound();

		const diagnostics = await this.capacity.getRunCapacity(
			input.projectId,
			input.runId,
		);
		if (!diagnostics) return benchmarkRunNotFound();

		return { status: "ok", body: { diagnostics } };
	}
}

function benchmarkRunNotFound(): BenchmarkCapacityRouteResult {
	return {
		status: "error",
		httpStatus: 404,
		message: "Benchmark run not found",
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function parseOptionalInteger(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) ? parsed : undefined;
}
