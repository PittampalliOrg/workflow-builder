import { afterEach, describe, expect, it, vi } from "vitest";
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
	afterEach(() => {
		vi.unstubAllEnvs();
	});

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

	it("caps Dapr workflow admission with the active agent workflow env guard", () => {
		vi.stubEnv("BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS", "6");

		expect(
			__benchmarkResourceLeasesForTest.resourceCapacity(
				run,
				"dapr_workflow_slot",
			),
		).toMatchObject({
			capacityKey: "agent-runtime-pool-coding",
			limit: 6,
		});
	});

	it("defaults model admission to the global inference cap across concurrent runs", () => {
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "80");

		expect(
			__benchmarkResourceLeasesForTest.resourceCapacity(run, "model_slot"),
		).toMatchObject({
			capacityKey: "claude-opus-4-7",
			limit: 80,
		});
	});

	it("allows an explicit model cap to override the global inference cap", () => {
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "80");
		vi.stubEnv("BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS", "32");

		expect(
			__benchmarkResourceLeasesForTest.resourceCapacity(run, "model_slot"),
		).toMatchObject({
			capacityKey: "claude-opus-4-7",
			limit: 32,
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
