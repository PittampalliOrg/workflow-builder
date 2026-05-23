import { describe, expect, it } from "vitest";
import {
	selectSwebenchDaprStateKeysForRepair,
	swebenchDaprRepairDecision,
} from "./dapr-state-repair";

describe("benchmark-scoped Dapr state repair", () => {
	it("repairs young SWE-bench parent candidates when no active run or lease exists", () => {
		expect(
			swebenchDaprRepairDecision({
				instanceId: "sw-swebench-instance-exec-c7",
				ageHours: 0.1,
				activeRunCount: 0,
				activeLeaseCount: 0,
				minAgeHours: 6,
			}),
		).toMatchObject({
			repair: true,
			reason: "benchmark_scoped_repair",
			effectiveMinAgeHours: 0,
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
