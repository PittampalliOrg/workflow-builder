import { describe, expect, it } from "vitest";
import { __benchmarkResourceLeasesForTest } from "./resource-leases";

const run = {
	id: "run_1",
	concurrency: 10,
	agentRuntimeAppId: "agent-runtime-pool-coding",
	modelNameOrPath: "claude-opus-4-7",
	modelConfigLabel: null,
	evaluationConcurrency: 1,
	timeoutSeconds: 7200,
	status: "inferencing",
	summary: {
		capacity: {
			effectiveConcurrency: 0,
			runtimeSlots: 10,
			daprWorkflowEffectiveCapacity: 10,
			maxActiveSessions: 10,
			maxActiveSandboxes: 0,
			sandboxCapacity: {
				totalSchedulableSandboxCapacity: 0,
			},
		},
	},
} as never;

describe("benchmark resource lease capacity", () => {
	it("blocks openshell_sandbox before child workflow launch when scheduler capacity is exhausted", () => {
		expect(
			__benchmarkResourceLeasesForTest.resourceCapacity(
				run,
				"agent_runtime_slot",
			),
		).toMatchObject({
			capacityKey: "agent-runtime-pool-coding",
			limit: 10,
		});
		expect(
			__benchmarkResourceLeasesForTest.resourceCapacity(
				run,
				"dapr_workflow_slot",
			),
		).toMatchObject({
			capacityKey: "agent-runtime-pool-coding",
			limit: 10,
		});
		expect(
			__benchmarkResourceLeasesForTest.resourceCapacity(
				run,
				"openshell_sandbox",
				{
					totalSchedulableSandboxCapacity: 0,
					schedulableSandboxCapacity: 0,
					availableSandboxSlots: 0,
					activeSwebenchPods: 0,
					pendingSwebenchPods: 0,
				} as never,
			),
		).toMatchObject({
			capacityKey: "openshell",
			limit: 0,
		});
	});

	it("uses live scheduler headroom as additional openshell admission capacity", () => {
		expect(
			__benchmarkResourceLeasesForTest.admissionLimit({
				resourceType: "openshell_sandbox",
				limit: 10,
				active: 5,
				liveSandboxCapacity: {
					availableSandboxSlots: 5,
					activeSwebenchPods: 5,
					pendingSwebenchPods: 0,
				} as never,
			}),
		).toBe(10);
		expect(
			__benchmarkResourceLeasesForTest.admissionLimit({
				resourceType: "openshell_sandbox",
				limit: 10,
				active: 0,
				liveSandboxCapacity: {
					availableSandboxSlots: 5,
					activeSwebenchPods: 5,
					pendingSwebenchPods: 0,
				} as never,
			}),
		).toBe(5);
		expect(
			__benchmarkResourceLeasesForTest.admissionLimit({
				resourceType: "openshell_sandbox",
				limit: 10,
				active: 5,
				liveSandboxCapacity: {
					availableSandboxSlots: 10,
					activeSwebenchPods: 0,
					pendingSwebenchPods: 0,
				} as never,
			}),
		).toBe(10);
	});
});
