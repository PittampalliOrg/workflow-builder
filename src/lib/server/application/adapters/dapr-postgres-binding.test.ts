import { beforeEach, describe, expect, it, vi } from "vitest";

const daprFetchMock = vi.hoisted(() => vi.fn());

vi.mock("$env/dynamic/private", () => ({ env: { DAPR_HTTP_PORT: "3500" } }));
vi.mock("$lib/server/dapr-client", () => ({
	getDaprSidecarUrl: () => "http://localhost:3500",
	daprFetch: (...args: unknown[]) => daprFetchMock(...args),
}));

import {
	DaprPostgresBindingClient,
	redactDbParamsForSpan,
} from "$lib/server/application/adapters/dapr-postgres-binding";

beforeEach(() => {
	daprFetchMock.mockReset();
});

describe("redactDbParamsForSpan", () => {
	it("redacts named positional secrets before SQL params are traced", () => {
		expect(
			redactDbParamsForSpan(
				["exec-1", "Bearer secret", { nestedToken: "abc", visible: "ok" }],
				["workflow_execution_id", "authorization", "result"],
			),
		).toEqual([
			"exec-1",
			"[REDACTED]",
			{ nestedToken: "[REDACTED]", visible: "ok" },
		]);
	});
});

describe("DaprPostgresBindingClient", () => {
	it("invokes the Dapr PostgreSQL binding with raw params but traces redacted params", async () => {
		daprFetchMock.mockResolvedValueOnce(
			Response.json({
				metadata: {
					operation: "query",
					duration: "1ms",
					sql: "SELECT * FROM workflow_script_calls WHERE workflow_execution_id = $1",
				},
				data: JSON.stringify([["call-1", 1]]),
			}),
		);

		const client = new DaprPostgresBindingClient({
			bindingName: "workflow-data-postgres",
		});
		await expect(
			client.query({
				summary: "workflow_script_calls.select_by_execution",
				collection: "workflow_script_calls",
				sql: "SELECT * FROM workflow_script_calls WHERE workflow_execution_id = $1 AND token = $2",
				params: ["exec-1", "raw-secret"],
				paramNames: ["workflow_execution_id", "api_token"],
			}),
		).resolves.toMatchObject({
			rows: [["call-1", 1]],
			rowsAffected: null,
		});

		expect(daprFetchMock).toHaveBeenCalledWith(
			"http://localhost:3500/v1.0/bindings/workflow-data-postgres",
			expect.objectContaining({
				method: "POST",
				captureResponseBodyForSpan: false,
				body: JSON.stringify({
					operation: "query",
					metadata: {
						sql: "SELECT * FROM workflow_script_calls WHERE workflow_execution_id = $1 AND token = $2",
						params: JSON.stringify(["exec-1", "raw-secret"]),
					},
				}),
				spanInput: expect.objectContaining({
					body: {
						operation: "query",
						metadata: {
							sql: "SELECT * FROM workflow_script_calls WHERE workflow_execution_id = $1 AND token = $2",
							params: ["exec-1", "[REDACTED]"],
						},
					},
				}),
			}),
		);
	});

	it("parses bare row arrays returned by the live Dapr PostgreSQL query binding", async () => {
		daprFetchMock.mockResolvedValueOnce(Response.json([["call-1", 1, "done"]]));

		const client = new DaprPostgresBindingClient({
			bindingName: "workflow-data-postgres",
		});

		await expect(
			client.query({
				summary: "workflow_script_calls.select_by_pk",
				collection: "workflow_script_calls",
				sql: "SELECT call_id, seq, status FROM workflow_script_calls WHERE workflow_execution_id = $1",
				params: ["exec-1"],
				paramNames: ["workflow_execution_id"],
			}),
		).resolves.toMatchObject({
			rows: [["call-1", 1, "done"]],
			rowsAffected: null,
		});
	});
});
