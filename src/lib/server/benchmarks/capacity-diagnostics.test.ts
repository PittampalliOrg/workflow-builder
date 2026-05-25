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
					deterministicConcurrency: 56,
					pressureAdjustedConcurrency: 56,
					effectiveConcurrency: 56,
					runtimeClass: "coding",
					runtimeAppId: "agent-runtime-pool-coding",
					runtimeReplicas: 7,
					slotsPerReplica: 8,
					runtimeSlots: 56,
					maxActiveSessions: 56,
					daprWorkflowLimitPerSidecar: 8,
					daprWorkflowEffectiveCapacity: 56,
					parentWorkflowRuntime: {
						parentAppId: "workflow-orchestrator",
						error: null,
					},
					parentWorkflowReplicas: 2,
					parentWorkflowReadyReplicas: 2,
					parentWorkflowConnectedWorkers: 2,
					parentWorkflowConnectedWorkerPods: 2,
					parentWorkflowLimitPerSidecar: 128,
					parentActivityLimitPerSidecar: 192,
					parentConfigurationWorkflowLimitPerSidecar: 128,
					parentConfigurationActivityLimitPerSidecar: 512,
					parentWorkerWorkflowLimitPerSidecar: 128,
					parentWorkerActivityLimitPerSidecar: 192,
					parentWorkflowEffectiveCapacity: 256,
					parentActivityEffectiveCapacity: 384,
					daprRuntimeVersion: "1.17.7",
					daprSchedulerPods: 3,
					daprSchedulerReadyPods: 3,
					daprRecentActorErrorCount: 0,
					daprRecentReminderErrorCount: 0,
					daprRecentStaleWorkflowEventCount: 0,
					daprRecentStartPendingTimeoutCount: 0,
					daprRuntimePressure: false,
					agentWorkflowMaxActiveTurns: 56,
					configuredMaxActiveSandboxes: 60,
					maxActiveSandboxes: 60,
					schedulableSandboxCapacity: 60,
					sandboxCapacity: {
						availableSandboxSlots: 4,
						activeSwebenchPods: 56,
						pendingSwebenchPods: 0,
						ephemeralStorageLimitedCapacity: 7,
						diskPressureNodeCount: 1,
					},
					modelMaxActiveRequests: 64,
					requestedEvaluationConcurrency: 24,
					effectiveEvaluationConcurrency: 6,
					evaluationConcurrencyReason: "kueue_eval_capacity",
					clusterPressure: {
						available: true,
						pressure: false,
						hardBlock: false,
						reductionFactor: 1,
						reasons: [],
					},
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
			deterministicConcurrency: 56,
			pressureAdjustedConcurrency: 56,
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
			parentWorkflow: {
				appId: "workflow-orchestrator",
				replicas: 2,
				readyReplicas: 2,
				connectedWorkers: 2,
				connectedWorkerPods: 2,
				workflowLimitPerSidecar: 128,
				activityLimitPerSidecar: 192,
				configurationWorkflowLimitPerSidecar: 128,
				configurationActivityLimitPerSidecar: 512,
				workerWorkflowLimitPerSidecar: 128,
				workerActivityLimitPerSidecar: 192,
				effectiveWorkflowCapacity: 256,
				effectiveActivityCapacity: 384,
				daprRuntimeVersion: "1.17.7",
				schedulerPods: 3,
				schedulerReadyPods: 3,
				recentActorErrorCount: 0,
				recentReminderErrorCount: 0,
				recentStaleWorkflowEventCount: 0,
				recentStartPendingTimeoutCount: 0,
				daprRuntimePressure: false,
			},
			sandbox: {
				configuredMaxActiveSandboxes: 60,
				maxActiveSandboxes: 60,
				schedulableSandboxCapacity: 60,
				availableSandboxSlots: 4,
				activeSwebenchPods: 56,
				pendingSwebenchPods: 0,
				ephemeralStorageLimitedCapacity: 7,
				diskPressureNodeCount: 1,
			},
			modelCaps: {
				modelMaxActiveRequests: 64,
			},
			evaluator: {
				requestedEvaluationConcurrency: 24,
				effectiveEvaluationConcurrency: 6,
				reason: "kueue_eval_capacity",
			},
			clusterPressure: {
				available: true,
				pressure: false,
			},
			workflowLifecycle: {
				issue: "dapr_component_diagnostics_unavailable",
				error: "not_computed",
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
		expect(
			__benchmarkCapacityDiagnosticsForTest.instanceCount(["a", "b"]),
		).toBe(2);
		expect(__benchmarkCapacityDiagnosticsForTest.instanceCount([])).toBe(1);
		expect(__benchmarkCapacityDiagnosticsForTest.instanceCount("12")).toBe(12);
		expect(__benchmarkCapacityDiagnosticsForTest.instanceCount("many")).toBe(1);
	});

	it("flags multi-app workflow actor state-store mismatches", () => {
		const diagnostics =
			__benchmarkCapacityDiagnosticsForTest.buildWorkflowLifecycleDiagnostics({
				childAppId: "agent-runtime-pool-coding",
				components: [
					{
						metadata: { name: "workflowstatestore" },
						scopes: ["workflow-orchestrator"],
						spec: {
							type: "state.postgresql",
							metadata: [
								{ name: "actorStateStore", value: "true" },
								{ name: "tablePrefix", value: "wfstate_" },
								{ name: "maxConns", value: "16" },
								{
									name: "connectionString",
									secretKeyRef: {
										name: "workflow-builder-secrets",
										key: "DATABASE_URL",
									},
								},
							],
						},
					},
					{
						metadata: { name: "dapr-agent-py-statestore" },
						scopes: ["agent-runtime-pool-coding"],
						spec: {
							type: "state.postgresql",
							metadata: [
								{ name: "actorStateStore", value: "true" },
								{ name: "tablePrefix", value: "agent_py_" },
								{
									name: "connectionString",
									secretKeyRef: {
										name: "dapr-agent-py-secrets",
										key: "DAPR_POSTGRES_CONNECTION_STRING",
									},
								},
							],
						},
					},
				],
			});

		expect(diagnostics).toMatchObject({
			parentAppId: "workflow-orchestrator",
			childAppId: "agent-runtime-pool-coding",
			sharedActorStateStore: false,
			issue: "dapr_actor_state_store_mismatch",
			parentActorStateStore: {
				componentName: "workflowstatestore",
				tablePrefix: "wfstate_",
				maxConns: 16,
			},
			childActorStateStore: {
				componentName: "dapr-agent-py-statestore",
				tablePrefix: "agent_py_",
			},
		});
	});

	it("accepts differently named components when they share the same backing actor store", () => {
		const diagnostics =
			__benchmarkCapacityDiagnosticsForTest.buildWorkflowLifecycleDiagnostics({
				childAppId: "agent-runtime-pool-coding",
				components: [
					{
						metadata: { name: "parent-store" },
						scopes: ["workflow-orchestrator"],
						spec: {
							type: "state.postgresql",
							metadata: [
								{ name: "actorStateStore", value: "true" },
								{ name: "tablePrefix", value: "wfstate_" },
								{
									name: "connectionString",
									secretKeyRef: { name: "shared", key: "DATABASE_URL" },
								},
							],
						},
					},
					{
						metadata: { name: "child-store" },
						scopes: ["agent-runtime-pool-coding"],
						spec: {
							type: "state.postgresql",
							metadata: [
								{ name: "actorStateStore", value: "true" },
								{ name: "tablePrefix", value: "wfstate_" },
								{
									name: "connectionString",
									secretKeyRef: { name: "shared", key: "DATABASE_URL" },
								},
							],
						},
					},
				],
			});

		expect(diagnostics).toMatchObject({
			sharedActorStateStore: true,
			issue: null,
		});
	});
});
