import { describe, expect, it } from "vitest";
import {
	extractSwebenchParentInstanceIdsFromStateKeys,
	selectSwebenchDaprStateKeysForRepair,
	swebenchDaprRepairDecision,
} from "./dapr-state-repair";

describe("benchmark-scoped Dapr state repair", () => {
	it("skips young SWE-bench parent candidates before the minimum age", () => {
		expect(
			swebenchDaprRepairDecision({
				instanceId: "sw-swebench-instance-exec-c7",
				ageHours: 0.1,
				activeRunCount: 0,
				activeLeaseCount: 0,
				minAgeHours: 6,
			}),
		).toMatchObject({
			repair: false,
			reason: "too_young",
			effectiveMinAgeHours: 6,
			benchmarkOwned: true,
		});
	});

	it("repairs old SWE-bench parent candidates when no active run or lease exists", () => {
		expect(
			swebenchDaprRepairDecision({
				instanceId: "sw-swebench-instance-exec-c7",
				ageHours: 6.1,
				activeRunCount: 0,
				activeLeaseCount: 0,
				minAgeHours: 6,
			}),
		).toMatchObject({
			repair: true,
			reason: "benchmark_scoped_repair",
			effectiveMinAgeHours: 6,
			benchmarkOwned: true,
		});
	});

	it("skips benchmark candidates while active runs or leases exist", () => {
		expect(
			swebenchDaprRepairDecision({
				instanceId: "sw-swebench-instance-exec-c7",
				ageHours: 10,
				activeRunCount: 1,
				activeLeaseCount: 0,
			}).reason,
		).toBe("active_benchmark_resources");
		expect(
			swebenchDaprRepairDecision({
				instanceId: "sw-swebench-instance-exec-c7",
				ageHours: 10,
				activeRunCount: 0,
				activeLeaseCount: 1,
			}).reason,
		).toBe("active_benchmark_resources");
	});

	it("skips non-SWE-bench workflow instance ids", () => {
		expect(
			swebenchDaprRepairDecision({
				instanceId: "manual-workflow-1",
				ageHours: 100,
				activeRunCount: 0,
				activeLeaseCount: 0,
			}),
		).toMatchObject({
			repair: false,
			reason: "non_swebench_instance",
			benchmarkOwned: false,
		});
	});

	it("extracts SWE-bench parent ids from parent and deterministic child wfstate keys", () => {
		expect(
			extractSwebenchParentInstanceIdsFromStateKeys([
				"workflow-orchestrator||dapr.internal.workflow-builder.workflow-orchestrator.workflow||sw-swebench-instance-exec-c7||metadata",
				"agent-session-host||dapr.internal.workflow-builder.agent-session-host.workflow||sw-swebench-instance-exec-c7__durable__solve__run__0||history-000001",
				"agent-session-host||dapr.internal.workflow-builder.agent-session-host.workflow||sw-swebench-instance-exec-c10__durable__solve__run__0__tool__1||metadata",
				"workflow-orchestrator||dapr.internal.workflow-builder.workflow-orchestrator.workflow||manual-workflow-1||metadata",
			]),
		).toEqual(["sw-swebench-instance-exec-c10", "sw-swebench-instance-exec-c7"]);
	});

	it("selects only parent and deterministic child/session wfstate keys", () => {
		const parent = "sw-swebench-instance-exec-c7";
		const keys = [
			"workflow-orchestrator||sw-swebench-instance-exec-c7||metadata",
			"agent-session-host||sw-swebench-instance-exec-c7__durable__solve__run__0||history",
			"agent-session-host||session-explicit-1||metadata",
			"workflow-orchestrator||manual-workflow-1||metadata",
			"workflow-orchestrator||sw-swebench-instance-exec-c10||metadata",
		];

		expect(
			selectSwebenchDaprStateKeysForRepair({
				keys,
				parentInstanceId: parent,
				childInstanceIds: ["session-explicit-1"],
			}),
		).toEqual(keys.slice(0, 3));
	});
});
