import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));
vi.mock("$env/dynamic/public", () => ({ env: process.env }));

const dbMock = vi.hoisted(() => {
	let workflowRow: Record<string, unknown> | null = {
		id: "workflow_1",
		name: "Demo",
		projectId: "project_1",
		mlflowExperimentId: null,
		mlflowExperimentName: null,
	};
	const selectLimit = vi.fn(async () => (workflowRow ? [workflowRow] : []));
	const selectWhere = vi.fn(() => ({ limit: selectLimit }));
	const selectFrom = vi.fn(() => ({ where: selectWhere }));
	const select = vi.fn(() => ({ from: selectFrom }));
	const updateWhere = vi.fn();
	const updateSet = vi.fn(() => ({ where: updateWhere }));
	const update = vi.fn(() => ({ set: updateSet }));
	const deleteWhere = vi.fn();
	const deleteFn = vi.fn(() => ({ where: deleteWhere }));
	const conflictUpdate = vi.fn();
	const insertValues = vi.fn(() => ({ onConflictDoUpdate: conflictUpdate }));
	const insert = vi.fn(() => ({ values: insertValues }));
	const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
		fn({ update, insert, delete: deleteFn }),
	);
	return {
		setWorkflowRow: (row: Record<string, unknown> | null) => {
			workflowRow = row;
		},
		selectLimit,
		selectWhere,
		selectFrom,
		select,
		updateWhere,
		updateSet,
		update,
		deleteWhere,
		deleteFn,
		conflictUpdate,
		insertValues,
		insert,
		transaction,
	};
});

vi.mock("$lib/server/db", () => ({
	db: {
		transaction: dbMock.transaction,
		select: dbMock.select,
		update: dbMock.update,
		insert: dbMock.insert,
		delete: dbMock.deleteFn,
	},
}));

import {
	createWorkflowAgentMlflowRun,
	createInteractiveSessionMlflowRun,
	createWorkflowExecutionMlflowRun,
	mlflowArtifactLocationForLifecycleExperiment,
	patchInteractiveSessionMlflowTraces,
	patchMlflowTracesForSession,
	precreateMlflowTrace,
	registerAgentVersionInMlflow,
} from "./mlflow-lifecycle";

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	dbMock.updateWhere.mockClear();
	dbMock.selectLimit.mockClear();
	dbMock.selectWhere.mockClear();
	dbMock.selectFrom.mockClear();
	dbMock.select.mockClear();
	dbMock.updateSet.mockClear();
	dbMock.update.mockClear();
	dbMock.deleteWhere.mockClear();
	dbMock.deleteFn.mockClear();
	dbMock.conflictUpdate.mockClear();
	dbMock.insertValues.mockClear();
		dbMock.insert.mockClear();
		dbMock.transaction.mockClear();
		vi.stubEnv("MLFLOW_ENABLED", "true");
		vi.stubEnv("WORKFLOW_BUILDER_LEGACY_MLFLOW_ENABLED", "true");
		vi.stubEnv("MLFLOW_TRACKING_URI", "http://mlflow.test");
	vi.stubEnv("PUBLIC_MLFLOW_URL", "https://mlflow.example");
	vi.stubEnv("WORKFLOW_BUILDER_ENV", "ryzen");
	dbMock.setWorkflowRow({
		id: "workflow_1",
		name: "Demo",
		projectId: "project_1",
		mlflowExperimentId: null,
		mlflowExperimentName: null,
	});
});

describe("mlflow lifecycle helpers", () => {
	it("keeps the legacy observability module free of direct DB imports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "mlflow-lifecycle.ts"),
			"utf8",
		);

		expect(source).toContain("$lib/server/application/adapters/mlflow-lifecycle");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("mlflowLineageLinks");
	});

	it("uses mlflow-artifacts for lifecycle experiments", () => {
		expect(
			mlflowArtifactLocationForLifecycleExperiment(
				"workflow-builder/ryzen/traces",
			),
		).toBe("mlflow-artifacts:/workflow-builder/ryzen/traces");
	});

	it("creates and finalizes an agent LoggedModel, then records lineage", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes("/experiments/get-by-name")) {
				expect(url).toContain("workflow-builder%2Fryzen%2Ftraces");
				return new Response(JSON.stringify({ experiment: { experiment_id: "6" } }), {
					status: 200,
				});
			}
			if (url.includes("/experiments/set-experiment-tag")) {
				return new Response(JSON.stringify({}), { status: 200 });
			}
			if (url.endsWith("/api/2.0/mlflow/logged-models/search")) {
				return new Response(JSON.stringify({ models: [] }), { status: 200 });
			}
			if (url.endsWith("/api/2.0/mlflow/logged-models")) {
				return new Response(
					JSON.stringify({
						model: {
							info: {
								model_id: "m-agent-v1",
								experiment_id: "6",
								name: "agent-v1",
								artifact_uri: "mlflow-artifacts:/workflow-builder/ryzen/traces/m-agent-v1",
								status: "LOGGED_MODEL_PENDING",
							},
						},
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/mlflow-artifacts/artifacts/")) {
				return new Response(JSON.stringify({}), { status: 200 });
			}
			if (url.includes("/api/2.0/mlflow/logged-models/m-agent-v1")) {
				expect(init?.method).toBe("PATCH");
				return new Response(
					JSON.stringify({
						model: { info: { model_id: "m-agent-v1", status: "LOGGED_MODEL_READY" } },
					}),
					{ status: 200 },
				);
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await registerAgentVersionInMlflow({
			agent: {
				id: "agent_1",
				slug: "agent",
				name: "Agent",
				projectId: "project_1",
			} as any,
			version: {
				id: "agent_version_1",
				agentId: "agent_1",
				version: 1,
				configHash: "hash_1",
				config: {
					builtinTools: ["read_file"],
					mcpConnectionMode: "explicit",
					mcpServers: [],
					skills: [],
					runtime: "dapr-agent-py",
					runtimeOverridePolicy: {},
					modelSpec: "openai/gpt-5.1",
				},
				applicationStateDigest: null,
				mlflowUri: null,
				mlflowModelName: null,
				mlflowModelVersion: null,
			} as any,
		});

		expect(result).toEqual({
			modelId: "m-agent-v1",
			modelName: "agent-v1",
			modelUri: "models:/m-agent-v1",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"http://mlflow.test/api/2.0/mlflow/logged-models/m-agent-v1",
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({
					model_id: "m-agent-v1",
					status: "LOGGED_MODEL_READY",
				}),
			}),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://mlflow.test/api/2.0/mlflow-artifacts/artifacts/workflow-builder/ryzen/traces/m-agent-v1/application-state.json",
			expect.objectContaining({
				method: "PUT",
				body: expect.stringContaining(
					'"schemaVersion": "workflow-builder.agent-application-state.v1"',
				),
			}),
		);
		expect(dbMock.updateSet).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
				mlflowUri: "models:/m-agent-v1",
				mlflowModelName: "agent-v1",
				mlflowModelVersion: "m-agent-v1",
			}),
		);
		expect(dbMock.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceKey: "agent_version:agent_version_1:logged_model:m-agent-v1",
				entityType: "agent_version",
				entityId: "agent_version_1",
				projectId: "project_1",
				mlflowEntityType: "logged_model",
				mlflowExperimentId: "6",
				mlflowLoggedModelUri: "models:/m-agent-v1",
				mlflowPublicUrl:
					"https://mlflow.example/#/experiments/6/models/m-agent-v1",
			}),
		);
	});

	it("creates parent workflow and child agent MLflow runs with lineage", async () => {
		let runCreateCount = 0;
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/experiments/get-by-name")) {
				return new Response(JSON.stringify({ experiment: { experiment_id: "11" } }), {
					status: 200,
				});
			}
			if (url.includes("/experiments/set-experiment-tag")) {
				return new Response(JSON.stringify({}), { status: 200 });
			}
			if (url.includes("/runs/create")) {
				runCreateCount += 1;
				return new Response(
					JSON.stringify({
						run: {
							info: {
								run_id: runCreateCount === 1 ? "workflow_run_1" : "agent_run_1",
							},
						},
					}),
					{ status: 200 },
				);
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const parent = await createWorkflowExecutionMlflowRun({
			executionId: "exec_1",
			workflowId: "workflow_1",
			workflowName: "Demo",
			projectId: "project_1",
			userId: "user_1",
		});
		const child = await createWorkflowAgentMlflowRun({
			sessionId: "session_1",
			parentRunId: parent?.runId ?? "",
			experimentId: parent?.experimentId,
			workflowExecutionId: "exec_1",
			workflowId: "workflow_1",
			nodeId: "solve",
			agentId: "agent_1",
			agentVersion: 1,
			agentSlug: "agent",
			activeModelId: "m-agent-v1",
			activeModelName: "agent-v1",
			activeModelUri: "models:/m-agent-v1",
			projectId: "project_1",
			userId: "user_1",
		});

		expect(parent?.runId).toBe("workflow_run_1");
		expect(parent?.experimentId).toBe("11");
		expect(parent?.traceExperimentId).toBe("11");
		expect(parent?.experimentName).toBe("workflow-builder/ryzen/traces");
		expect(child?.runId).toBe("agent_run_1");
		const runCreateCalls = fetchMock.mock.calls.filter(([url]) =>
			String(url).includes("/runs/create"),
		);
		expect(runCreateCalls[0]).toEqual([
			"http://mlflow.test/api/2.0/mlflow/runs/create",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"workflow_builder.kind","value":"workflow_execution"'),
			}),
		]);
		expect(runCreateCalls[1]).toEqual([
			"http://mlflow.test/api/2.0/mlflow/runs/create",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"mlflow.parentRunId","value":"workflow_run_1"'),
			}),
		]);
		expect(runCreateCalls[1]).toEqual([
			"http://mlflow.test/api/2.0/mlflow/runs/create",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"mlflow.modelId","value":"m-agent-v1"'),
			}),
		]);
		expect(runCreateCalls[1]).toEqual([
			"http://mlflow.test/api/2.0/mlflow/runs/create",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"workflow_builder.mlflow_session_id","value":"session_1"'),
			}),
		]);
		expect(dbMock.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceKey: "workflow_execution:exec_1:run:workflow_run_1",
				entityType: "workflow_execution",
				mlflowExperimentId: "11",
				mlflowRunId: "workflow_run_1",
			}),
		);
		expect(dbMock.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceKey: "session:session_1:run:agent_run_1",
				entityType: "session",
				mlflowRunId: "agent_run_1",
				mlflowSessionId: "session_1",
				mlflowLoggedModelId: "m-agent-v1",
				mlflowLoggedModelName: "agent-v1",
				mlflowLoggedModelUri: "models:/m-agent-v1",
			}),
		);
	});

	it("creates an interactive session parent run and records MLflow session lineage", async () => {
		vi.stubEnv("MLFLOW_TRACE_EXPERIMENT_ID", "6");
		vi.stubEnv("MLFLOW_TRACE_EXPERIMENT_NAME", "workflow-builder/ryzen/traces");
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/experiments/get-by-name")) {
				return new Response(JSON.stringify({ experiment: { experiment_id: "9" } }), {
					status: 200,
				});
			}
			if (url.includes("/experiments/set-experiment-tag")) {
				return new Response(JSON.stringify({}), { status: 200 });
			}
			if (url.includes("/runs/create")) {
				return new Response(
					JSON.stringify({ run: { info: { run_id: "session_run_1" } } }),
					{ status: 200 },
				);
			}
			if (url.includes("/runs/get")) {
				return new Response(
					JSON.stringify({
						run: {
							info: {
								artifact_uri:
									"mlflow-artifacts:/workflow-builder/ryzen/traces/session_run_1",
							},
						},
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/mlflow-artifacts/artifacts/")) {
				return new Response(JSON.stringify({}), { status: 200 });
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const run = await createInteractiveSessionMlflowRun({
			sessionId: "session_123",
			title: "Interactive Kimi",
			projectId: "project_1",
			userId: "user_1",
			agentId: "agent_1",
			agentName: "Kimi",
			agentSlug: "kimi",
			agentVersion: 7,
			agentAppId: "agent-runtime-kimi",
			activeModelName: "kimi-state",
			activeModelUri: "models:/m-kimi",
		});

		expect(run?.runId).toBe("session_run_1");
		expect(run?.experimentId).toBe("6");
		expect(run?.traceExperimentId).toBe("6");
		expect(run?.activeModelId).toBe("m-kimi");
		const createCall = fetchMock.mock.calls.find(([url]) =>
			String(url).includes("/runs/create"),
		);
		expect(createCall).toEqual([
			"http://mlflow.test/api/2.0/mlflow/runs/create",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"experiment_id":"6"'),
			}),
		]);
		expect(createCall).toEqual([
			"http://mlflow.test/api/2.0/mlflow/runs/create",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"workflow_builder.kind","value":"interactive_session"'),
			}),
		]);
		expect(dbMock.updateSet).toHaveBeenCalledWith(
			expect.objectContaining({
				mlflowExperimentId: "6",
				mlflowRunId: "session_run_1",
				mlflowParentRunId: null,
				mlflowSessionId: "session_123",
			}),
		);
		expect(dbMock.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceKey: "session:session_123:mlflow_session:session_123",
				entityType: "session",
				mlflowEntityType: "session",
				mlflowSessionId: "session_123",
				mlflowRunId: "session_run_1",
				mlflowLoggedModelId: "m-kimi",
			}),
		);
		const artifactCall = fetchMock.mock.calls.find(([url]) =>
			String(url).includes("/session-manifest.json"),
		);
		expect(artifactCall).toEqual([
			"http://mlflow.test/api/2.0/mlflow-artifacts/artifacts/workflow-builder/ryzen/traces/session_run_1/session-manifest.json",
			expect.objectContaining({
				method: "PUT",
				body: expect.stringContaining('"kind": "interactive_session"'),
			}),
		]);
	});

	it("pre-creates traces with MLflow model metadata in the target experiment", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			precreateMlflowTrace({
				traceId: "abcdefabcdefabcdefabcdefabcdefab",
				experimentId: "13",
				name: "swebench/demo",
				metadata: {
					"mlflow.modelId": "m-agent-v1",
					"mlflow.sourceRun": "run_1",
				},
				tags: {
					"workflow_builder.kind": "swebench_instance",
				},
			}),
		).resolves.toBe("tr-abcdefabcdefabcdefabcdefabcdefab");

		expect(fetchMock).toHaveBeenCalledWith(
			"http://mlflow.test/api/3.0/mlflow/traces",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"traceId":"tr-abcdefabcdefabcdefabcdefabcdefab"'),
			}),
		);
		const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		expect(body.trace.traceInfo.traceLocation.mlflowExperiment.experimentId).toBe("13");
		expect(body.trace.traceInfo.traceMetadata["mlflow.modelId"]).toBe("m-agent-v1");
		expect(body.trace.traceInfo.tags["mlflow.traceName"]).toBe("swebench/demo");
	});

	it("patches interactive session traces with exact session, run, and model metadata", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/api/3.0/mlflow/traces/search")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				const filter = String(body.filter ?? "");
				if (filter.includes("f06g-h1avdhy4noigex8s")) {
					return new Response(
						JSON.stringify({
							traces: [
								{
									info: {
										trace_id: "tr-22222222222222222222222222222222",
										state: "OK",
										timestamp_ms: 1000,
										execution_time_ms: 25,
									},
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (filter.includes("f06g_h1")) {
					return new Response(
						JSON.stringify({
							traces: [
								{
									info: {
										trace_id: "tr-11111111111111111111111111111111",
										state: "IN_PROGRESS",
										timestamp_ms: 500,
									},
								},
							],
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ traces: [] }), { status: 200 });
			}
			if (url.includes("/api/2.0/mlflow/traces/")) {
				return new Response(JSON.stringify({}), { status: 200 });
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			patchMlflowTracesForSession({
				sessionId: "f06g_h1AvdHY4noIgEx8S",
				experimentId: "3",
				runId: "run_1",
				modelId: "m-agent-v1",
				status: "OK",
				endTime: 12345,
			}),
		).resolves.toBe(2);

		const patchBodies = fetchMock.mock.calls
			.filter(([url]) => String(url).includes("/api/2.0/mlflow/traces/"))
			.map(([, init]) => JSON.parse(String(init?.body ?? "{}")));
		expect(patchBodies).toHaveLength(2);
		for (const body of patchBodies) {
			expect(body.status).toBe("OK");
			expect(body.timestamp_ms).toBe(12345);
			expect(body.request_metadata).toEqual(
				expect.arrayContaining([
					{ key: "mlflow.trace.session", value: "f06g_h1AvdHY4noIgEx8S" },
					{ key: "mlflow.sourceRun", value: "run_1" },
					{ key: "mlflow.modelId", value: "m-agent-v1" },
				]),
			);
		}
	});

	it("patches interactive session traces discovered from session events and records lineage", async () => {
		const eventTraceId = "33333333333333333333333333333333";
		dbMock.select
			.mockImplementationOnce(() => ({
				from: () => ({
					where: () => ({
						limit: async () => [
							{
								mlflowExperimentId: "3",
								mlflowRunId: "run_1",
								mlflowSessionId: "mlflow-session-1",
								projectId: "project_1",
							},
						],
					}),
				}),
			}) as any)
			.mockImplementationOnce(() => ({
				from: () => ({
					where: async () => [
						{
							mlflowLoggedModelId: "m-agent-v1",
							mlflowModelVersion: null,
						},
					],
				}),
			}) as any)
			.mockImplementationOnce(() => ({
				from: () => ({
					where: async () => [
						{
							data: {
								traceId: eventTraceId,
								nested: { mlflow_trace_id: `tr-${eventTraceId}` },
							},
						},
					],
				}),
			}) as any);
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
			if (url.endsWith("/api/3.0/mlflow/traces/search")) {
				return new Response(JSON.stringify({ traces: [] }), { status: 200 });
			}
			if (url.includes(`/api/2.0/mlflow/traces/tr-${eventTraceId}`)) {
				return new Response(JSON.stringify({}), { status: 200 });
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			patchInteractiveSessionMlflowTraces({
				sessionId: "session_1",
				status: "OK",
				endTime: 12345,
			}),
		).resolves.toBe(1);

		const patchCall = fetchMock.mock.calls.find(([url]) =>
			String(url).includes(`/api/2.0/mlflow/traces/tr-${eventTraceId}`),
		);
		const patchBody = JSON.parse(String(patchCall?.[1]?.body ?? "{}"));
		expect(patchBody.request_metadata).toEqual(
			expect.arrayContaining([
				{ key: "mlflow.trace.session", value: "mlflow-session-1" },
				{ key: "mlflow.sourceRun", value: "run_1" },
				{ key: "mlflow.modelId", value: "m-agent-v1" },
			]),
		);
		expect(dbMock.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceKey: `session:session_1:trace:tr-${eventTraceId}`,
				entityType: "session",
				entityId: "session_1",
				projectId: "project_1",
				mlflowEntityType: "trace",
				mlflowExperimentId: "3",
				mlflowRunId: "run_1",
				mlflowSessionId: "mlflow-session-1",
				mlflowTraceId: `tr-${eventTraceId}`,
				mlflowLoggedModelId: "m-agent-v1",
				mlflowPublicUrl:
					`https://mlflow.example/#/experiments/3/traces?selectedEvaluationId=tr-${eventTraceId}`,
			}),
		);
	});
});
