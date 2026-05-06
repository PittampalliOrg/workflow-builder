import { describe, expect, it } from "vitest";
import { __benchmarkCapacityDiagnosticsForTest } from "./capacity-diagnostics";

describe("benchmark capacity diagnostics", () => {
	it("summarizes stored capacity and blocked resource diagnostics", () => {
		const diagnostics =
			__benchmarkCapacityDiagnosticsForTest.diagnosticsFromCapacity({
				run: {
					id: "run_1",
					concurrency: 56,
					selectedInstanceIds: ["a", "b", "c"],
				} as never,
				selectedInstanceCount: 3,
				capacity: {
					requestedConcurrency: 72,
					effectiveConcurrency: 56,
					runtimeClass: "coding",
					runtimeAppId: "agent-runtime-pool-coding",
					runtimeReplicas: 7,
					slotsPerReplica: 8,
					runtimeSlots: 56,
					maxActiveSessions: 56,
					daprWorkflowLimitPerSidecar: 8,
					daprWorkflowEffectiveCapacity: 56,
					agentWorkflowMaxActiveTurns: 56,
					configuredMaxActiveSandboxes: 60,
					maxActiveSandboxes: 60,
					schedulableSandboxCapacity: 60,
					sandboxCapacity: {
						availableSandboxSlots: 4,
						activeSwebenchPods: 56,
						pendingSwebenchPods: 0,
					},
					modelMaxActiveRequests: 64,
					capReason: "global_max",
				},
				resources: [
					{
						resourceType: "inference_slot",
						capacityKey: "workflow-builder",
						active: 56,
						staleActive: 0,
						limit: 56,
						headroom: 0,
						blocked: true,
					},
					{
						resourceType: "openshell_sandbox",
						capacityKey: "openshell",
						active: 56,
						staleActive: 2,
						limit: 60,
						headroom: 4,
						blocked: false,
					},
				],
			});

		expect(diagnostics).toMatchObject({
			requestedConcurrency: 72,
			storedEffectiveConcurrency: 56,
			selectedInstanceCount: 3,
			blockedBy: ["inference_slot"],
			runtime: {
				class: "coding",
				appId: "agent-runtime-pool-coding",
				replicas: 7,
				slotsPerReplica: 8,
				slots: 56,
				maxActiveSessions: 56,
			},
			daprWorkflow: {
				perSidecarLimit: 8,
				effectiveCapacity: 56,
				agentWorkflowMaxActiveTurns: 56,
			},
			sandbox: {
				configuredMaxActiveSandboxes: 60,
				maxActiveSandboxes: 60,
				schedulableSandboxCapacity: 60,
				availableSandboxSlots: 4,
				activeSwebenchPods: 56,
				pendingSwebenchPods: 0,
			},
			modelCaps: {
				modelMaxActiveRequests: 64,
			},
			capReason: "global_max",
		});
		expect(diagnostics.computedAt).toEqual(expect.any(String));
		expect(diagnostics.resources[1]).toMatchObject({
			resourceType: "openshell_sandbox",
			staleActive: 2,
			headroom: 4,
		});
	});

	it("counts explicit selected instances and falls back to one", () => {
		expect(__benchmarkCapacityDiagnosticsForTest.instanceCount(["a", "b"])).toBe(2);
		expect(__benchmarkCapacityDiagnosticsForTest.instanceCount([])).toBe(1);
		expect(__benchmarkCapacityDiagnosticsForTest.instanceCount("12")).toBe(12);
		expect(__benchmarkCapacityDiagnosticsForTest.instanceCount("many")).toBe(1);
	});
});
