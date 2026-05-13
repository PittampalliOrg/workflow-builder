import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));
vi.mock("$env/dynamic/public", () => ({ env: process.env }));

const dbMock = vi.hoisted(() => {
	const updateWhere = vi.fn();
	const updateSet = vi.fn(() => ({ where: updateWhere }));
	const update = vi.fn(() => ({ set: updateSet }));
	const conflictUpdate = vi.fn();
	const insertValues = vi.fn(() => ({ onConflictDoUpdate: conflictUpdate }));
	const insert = vi.fn(() => ({ values: insertValues }));
	const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
		fn({ update, insert }),
	);
	return {
		updateWhere,
		updateSet,
		update,
		conflictUpdate,
		insertValues,
		insert,
		transaction,
	};
});

vi.mock("$lib/server/db", () => ({
	db: { transaction: dbMock.transaction },
}));

import {
	createWorkflowAgentMlflowRun,
	createWorkflowExecutionMlflowRun,
	mlflowArtifactLocationForLifecycleExperiment,
	registerAgentVersionInMlflow,
} from "./mlflow-lifecycle";

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	dbMock.updateWhere.mockClear();
	dbMock.updateSet.mockClear();
	dbMock.update.mockClear();
	dbMock.conflictUpdate.mockClear();
	dbMock.insertValues.mockClear();
	dbMock.insert.mockClear();
	dbMock.transaction.mockClear();
	vi.stubEnv("MLFLOW_ENABLED", "true");
	vi.stubEnv("MLFLOW_TRACKING_URI", "http://mlflow.test");
	vi.stubEnv("PUBLIC_MLFLOW_URL", "https://mlflow.example");
	vi.stubEnv("WORKFLOW_BUILDER_ENV", "ryzen");
});

describe("mlflow lifecycle helpers", () => {
	it("uses mlflow-artifacts for lifecycle experiments", () => {
		expect(
			mlflowArtifactLocationForLifecycleExperiment(
				"workflow-builder/ryzen/agents",
			),
		).toBe("mlflow-artifacts:/workflow-builder/ryzen/agents");
	});

	it("creates and finalizes an agent LoggedModel, then records lineage", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ experiment: { experiment_id: "9" } }), {
					status: 200,
				}),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						model: {
							info: {
								model_id: "m-agent-v1",
								experiment_id: "9",
								name: "agent-v1",
								artifact_uri: "mlflow-artifacts:/workflow-builder/ryzen/agents/m-agent-v1",
								status: "LOGGED_MODEL_PENDING",
							},
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						model: { info: { model_id: "m-agent-v1", status: "LOGGED_MODEL_READY" } },
					}),
					{ status: 200 },
				),
			);
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
		expect(dbMock.updateSet).toHaveBeenCalledWith({
			mlflowUri: "models:/m-agent-v1",
			mlflowModelName: "agent-v1",
			mlflowModelVersion: "m-agent-v1",
		});
		expect(dbMock.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceKey: "agent_version:agent_version_1:logged_model:m-agent-v1",
				entityType: "agent_version",
				entityId: "agent_version_1",
				projectId: "project_1",
				mlflowEntityType: "logged_model",
				mlflowExperimentId: "9",
				mlflowLoggedModelUri: "models:/m-agent-v1",
				mlflowPublicUrl:
					"https://mlflow.example/#/experiments/9/models/m-agent-v1",
			}),
		);
	});

	it("creates parent workflow and child agent MLflow runs with lineage", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ experiment: { experiment_id: "11" } }), {
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ run: { info: { run_id: "workflow_run_1" } } }),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ run: { info: { run_id: "agent_run_1" } } }),
					{ status: 200 },
				),
			);
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
		expect(child?.runId).toBe("agent_run_1");
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"http://mlflow.test/api/2.0/mlflow/runs/create",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"workflow_builder.kind","value":"workflow_execution"'),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			3,
			"http://mlflow.test/api/2.0/mlflow/runs/create",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"mlflow.parentRunId","value":"workflow_run_1"'),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			3,
			"http://mlflow.test/api/2.0/mlflow/runs/create",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"mlflow.modelId","value":"m-agent-v1"'),
			}),
		);
		expect(dbMock.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceKey: "workflow_execution:exec_1:run:workflow_run_1",
				entityType: "workflow_execution",
				mlflowRunId: "workflow_run_1",
			}),
		);
		expect(dbMock.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceKey: "session:session_1:run:agent_run_1",
				entityType: "session",
				mlflowRunId: "agent_run_1",
				mlflowLoggedModelId: "m-agent-v1",
				mlflowLoggedModelName: "agent-v1",
				mlflowLoggedModelUri: "models:/m-agent-v1",
			}),
		);
	});
});
