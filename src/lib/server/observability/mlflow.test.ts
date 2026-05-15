import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.doUnmock("$env/dynamic/public");
	vi.doUnmock("$env/dynamic/private");
	vi.resetModules();
});

describe("publicMlflowTraceSearchUrl", () => {
	it("links traces by MLflow request id in the trace experiment", async () => {
		vi.doMock("$env/dynamic/public", () => ({
			env: { PUBLIC_MLFLOW_URL: "https://mlflow.example/" },
		}));
		vi.doMock("$env/dynamic/private", () => ({ env: {} }));
		const { publicMlflowTraceSearchUrl } = await import("./mlflow");

		expect(publicMlflowTraceSearchUrl("3", { traceId: "abc123" })).toBe(
			"https://mlflow.example/#/experiments/3/traces?selectedEvaluationId=tr-abc123",
		);
	});

	it("does not double-prefix existing MLflow trace request ids", async () => {
		vi.doMock("$env/dynamic/public", () => ({
			env: { PUBLIC_MLFLOW_URL: "https://mlflow.example" },
		}));
		vi.doMock("$env/dynamic/private", () => ({ env: {} }));
		const { publicMlflowTraceSearchUrl } = await import("./mlflow");

		expect(publicMlflowTraceSearchUrl("3", { traceId: "tr-abc123" })).toBe(
			"https://mlflow.example/#/experiments/3/traces?selectedEvaluationId=tr-abc123",
		);
	});

	it("links MLflow runs in the same public UI shape as sessions and traces", async () => {
		vi.doMock("$env/dynamic/public", () => ({
			env: { PUBLIC_MLFLOW_URL: "https://mlflow.example/" },
		}));
		vi.doMock("$env/dynamic/private", () => ({ env: {} }));
		const { publicMlflowRunUrl } = await import("./mlflow");

		expect(publicMlflowRunUrl("3", "run_1")).toBe(
			"https://mlflow.example/#/experiments/3/runs/run_1",
		);
	});

	it("resolves execution trace links from the execution MLflow experiment before the legacy trace env", async () => {
		const chain = {
			from: vi.fn().mockReturnThis(),
			where: vi.fn().mockReturnThis(),
			limit: vi.fn().mockResolvedValue([
				{
					primaryTraceId: "abc123",
					mlflowExperimentId: "workflow-exp-11",
				},
			]),
		};
		vi.doMock("$env/dynamic/public", () => ({
			env: { PUBLIC_MLFLOW_URL: "https://mlflow.example" },
		}));
		vi.doMock("$env/dynamic/private", () => ({
			env: { MLFLOW_TRACE_EXPERIMENT_ID: "legacy-traces" },
		}));
		vi.doMock("$lib/server/db", () => ({ db: { select: () => chain } }));
		vi.doMock("$lib/server/db/schema", () => ({
			workflowExecutions: {
				id: "id",
				primaryTraceId: "primary_trace_id",
				mlflowExperimentId: "mlflow_experiment_id",
			},
		}));
		vi.doMock("drizzle-orm", () => ({ eq: vi.fn() }));
		const { resolveMlflowTraceUrlForExecution } = await import("./mlflow");

		await expect(resolveMlflowTraceUrlForExecution("exec_1")).resolves.toBe(
			"https://mlflow.example/#/experiments/workflow-exp-11/traces?selectedEvaluationId=tr-abc123",
		);
	});

	it("resolves session groups using the persisted MLflow session id", async () => {
		const sessionLimit = vi.fn().mockResolvedValue([
			{
				id: "session_1",
				workflowExecutionId: null,
				mlflowExperimentId: "9",
				mlflowRunId: "run_1",
				mlflowParentRunId: null,
				mlflowSessionId: "mlflow-session-1",
			},
		]);
		const sessionWhere = vi.fn().mockReturnValue({ limit: sessionLimit });
		const linksOrderBy = vi.fn().mockResolvedValue([
			{
				mlflowEntityType: "trace",
				mlflowExperimentId: "9",
				mlflowTraceId: "tr-abc123",
				mlflowPublicUrl: null,
				tags: { source: "agent_trace" },
				metadata: {},
			},
		]);
		const linksWhere = vi.fn().mockReturnValue({ orderBy: linksOrderBy });
		const select = vi
			.fn()
			.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: sessionWhere }) })
			.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: linksWhere }) });
		vi.doMock("$env/dynamic/public", () => ({
			env: { PUBLIC_MLFLOW_URL: "https://mlflow.example" },
		}));
		vi.doMock("$env/dynamic/private", () => ({ env: {} }));
		vi.doMock("$lib/server/db", () => ({ db: { select } }));
		vi.doMock("$lib/server/db/schema", () => ({
			sessions: {
				id: "id",
				workflowExecutionId: "workflow_execution_id",
				mlflowExperimentId: "mlflow_experiment_id",
				mlflowRunId: "mlflow_run_id",
				mlflowParentRunId: "mlflow_parent_run_id",
				mlflowSessionId: "mlflow_session_id",
			},
			mlflowLineageLinks: {
				entityType: "entity_type",
				entityId: "entity_id",
				updatedAt: "updated_at",
			},
		}));
		vi.doMock("drizzle-orm", () => ({
			and: vi.fn(),
			desc: vi.fn(),
			eq: vi.fn(),
		}));
		const { getMlflowTraceGroupForSession } = await import("./mlflow");

		await expect(getMlflowTraceGroupForSession("session_1")).resolves.toMatchObject({
			experimentId: "9",
			mlflowSessionId: "mlflow-session-1",
			sessionUrl: "https://mlflow.example/#/experiments/9/chat-sessions/mlflow-session-1",
			runUrl: "https://mlflow.example/#/experiments/9/runs/run_1",
			traceSearchUrl: "https://mlflow.example/#/experiments/9/traces",
			links: [
				{
					source: "agent_trace",
					mlflowPublicUrl:
						"https://mlflow.example/#/experiments/9/traces?selectedEvaluationId=tr-abc123",
				},
			],
		});
	});
});
