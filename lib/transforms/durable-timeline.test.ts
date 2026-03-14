import { describe, expect, it } from "vitest";
import type { GenericWorkflowHistoryEvent } from "@/lib/dapr-client";
import { deriveDurableAgentRuns } from "./durable-timeline";

describe("deriveDurableAgentRuns", () => {
	it("derives a child run from orchestrator completion events", () => {
		const history: GenericWorkflowHistoryEvent[] = [
			{
				eventType: "TaskScheduled",
				timestamp: "2026-02-22T18:14:43.313Z",
				name: "call_durable_agent_run",
			},
			{
				eventType: "EventRaised",
				timestamp: "2026-02-22T18:14:53.067Z",
				name: "agent_completed_durable-run-abc123",
				input: {
					success: true,
					result: { text: "done" },
				},
			},
		];

		const runs = deriveDurableAgentRuns({
			executionId: "exec-db-1",
			parentExecutionId: "inst-1",
			logs: [],
			orchestratorHistory: history,
		});

		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			id: "durable-run-abc123",
			mode: "run",
			status: "completed",
			parentExecutionId: "inst-1",
			createdAt: "2026-02-22T18:14:43.313Z",
			completedAt: "2026-02-22T18:14:53.067Z",
		});
	});

	it("derives run identifiers from durable action logs", () => {
		const runs = deriveDurableAgentRuns({
			executionId: "exec-db-2",
			parentExecutionId: "inst-2",
			logs: [
				{
					id: "log-1",
					nodeId: "du-node",
					nodeName: "Durable Node",
					activityName: "durable/run",
					status: "error",
					input: null,
					output: {
						agentWorkflowId: "durable-run-log-1",
						daprInstanceId: "inst-log-1",
					},
					error: "failed",
					startedAt: "2026-02-22T10:00:00.000Z",
					completedAt: "2026-02-22T10:00:05.000Z",
					timestamp: "2026-02-22T10:00:05.000Z",
					duration: "5000",
				},
			],
			orchestratorHistory: [],
		});

		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			id: "durable-run-log-1",
			agentWorkflowId: "durable-run-log-1",
			daprInstanceId: "inst-log-1",
			mode: "run",
			status: "failed",
			error: "failed",
		});
	});

	it("derives run identifiers from ms-agent action logs", () => {
		const runs = deriveDurableAgentRuns({
			executionId: "exec-db-3",
			parentExecutionId: "inst-3",
			logs: [
				{
					id: "log-2",
					nodeId: "ms-node",
					nodeName: "Microsoft Agent Node",
					activityName: "ms-agent/run",
					status: "success",
					input: null,
					output: {
						result: {
							agentWorkflowId: "ms-agent-run-log-1",
							daprInstanceId: "ms-inst-log-1",
						},
					},
					error: null,
					startedAt: "2026-02-22T11:00:00.000Z",
					completedAt: "2026-02-22T11:00:05.000Z",
					timestamp: "2026-02-22T11:00:05.000Z",
					duration: "5000",
				},
			],
			orchestratorHistory: [],
		});

		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			id: "ms-agent-run-log-1",
			agentWorkflowId: "ms-agent-run-log-1",
			daprInstanceId: "ms-inst-log-1",
			mode: "run",
			status: "completed",
			error: null,
		});
	});
});
